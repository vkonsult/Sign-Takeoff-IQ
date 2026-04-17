/**
 * Phase 4 — Room Inventory
 *
 * Extracts every room label from floor plan pages, cross-references the occupant
 * loads table, and derives the boolean flags (isRestroom, isStair, …) consumed by
 * the Phase 5 rule engine.
 *
 * SignTakeoff System Prompt v1.1 — Phase 4
 */

import { extractPagePhrases, extractRawPageItems } from "./pdf-words";
import { logger } from "./logger";
import { renderFloorPlanPages } from "./pdf-render";
import { getFilePageImagesDir } from "./storage";
import { ai } from "@workspace/integrations-gemini-ai";
import fs from "fs/promises";
import { OFFICE_TOKENS, SUITE_TOKENS } from "./room-classification-tokens";

// ── Public types ──────────────────────────────────────────────────────────────

export interface RoomRecord {
  roomNumber: string | null;
  roomName: string;
  level: string;
  pdfPage: number;
  occupantLoad: number | null;
  occupancyGroup: string | null;

  isRestroom: boolean;
  isStair: boolean;
  isElevator: boolean;
  isVestibule: boolean;
  isCorridorOrHall: boolean;
  isVehicleBay: boolean;
  isMepUnoccupied: boolean;
  isVariableUse: boolean;
  isPublicFacing: boolean;
  isStaffOnly: boolean;
  isAssembly: boolean;
  /** True when the room name identifies it as a private office (R5 applies). */
  isOffice: boolean;
  /** True when the room name identifies it as a suite (R6 applies). */
  isSuite: boolean;

  boundingBox: { x: number; y: number; w: number; h: number } | null;
  extractionConfidence: number;
  aiEnriched?: boolean;

  /** Number of entry doors extracted from adjacent text tokens, if found.
   *  Used by R2/R3/R5/R11 to set correct sign quantities.
   *  Null when no door-count hint was found in the drawing text. */
  doorCount?: number | null;

  /** Zone qualifier inherited from a large-font zone label (e.g. "AREA A")
   *  that spatially overlaps this room.  Used as a location anchor in sign
   *  schedules when the room has no explicit number. */
  zoneQualifier?: string | null;
}

/** A large-font zone label (20–36 pt) captured as a spatial anchor. */
export interface ZoneAnchor {
  text: string;
  pdfPage: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RoomInventory {
  rooms: RoomRecord[];
  occupantLoadTableFound: boolean;
  occupantLoadSource: "gemini" | "text" | "none";
  occupantLoadRoomsMatched: number;
  warnings: string[];
  sourcePages: number[];
  aiEnrichedCount?: number;
  /** Zone labels captured from large-font (20–36pt) text on floor plan pages.
   *  These are stored as spatial anchors for downstream use; they are NOT
   *  included in the room list and do NOT trigger sign assignments. */
  zoneAnchors?: ZoneAnchor[];
}

// ── Internal types ────────────────────────────────────────────────────────────

interface OccupantLoadEntry {
  roomNumber: string;
  occupantLoad: number;
  occupancyGroup: string | null;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const RESTROOM_KEYWORDS = ["TOILET", "BATH", "SHOWER", "WC", "RESTROOM", "LAVATORY", "WASHROOM"];
const STAIR_PREFIXES = ["STAIR"];
const ELEVATOR_KEYWORDS = ["ELEV", "ELEVATOR", "LIFT"];
const VESTIBULE_KEYWORDS = ["VEST", "VESTIBULE"];
const CORRIDOR_KEYWORDS = ["HALL", "CORR", "CORRIDOR", "LOBBY", "FOYER"];
const VEHICLE_BAY_KEYWORDS = ["APPARATUS", "VEHICLE BAY", "SALLY PORT", "GARAGE", "BAY"];
// MEP_KEYWORDS — true mechanical/electrical/plumbing service rooms only.
// "STORAGE" and "CLOSET" are intentionally excluded: a plain storage room is an
// occupied use and must receive signage. Rooms like "ELECTRICAL CLOSET" or
// "MECHANICAL STORAGE" are caught because "ELECTRICAL"/"MECHANICAL" appear here.
// Adding storage terms to this list would conflate MEP rooms with storage rooms
// (the R15 hardening objective) and cause storage rooms to be silently zero-signed.
const MEP_KEYWORDS = [
  "MECHANICAL", "ELECTRICAL", "ELEC", "DATA", "IT ROOM", "SERVER",
  "FIRE SPRINKLER", "TELECOM", "TELEPHONE", "COMM", "MDF", "IDF", "SPRINKLER",
  "RISER", "JANITOR", "JAN",
];
const VARIABLE_USE_KEYWORDS = [
  "TRAINING", "COMMUNITY", "EOC", "MULTIPURPOSE", "MULTI-PURPOSE",
  "CONFERENCE", "MEETING", "BREAKOUT", "CLASSROOM", "ASSEMBLY ROOM",
  "COLLABORATION", "COLLAB", "COLLABORATIVE", "CO-WORKING", "COWORKING",
  "IDEATION", "WORKSHOP", "HUDDLE", "FLEX", "FLEXIBLE",
];
// Storage qualifier words: presence in a room name suppresses isVariableUse so
// that "WORKSHOP STORAGE" or "BREAKOUT CLOSET" are not classified as variable-use
// rooms.  These are NOT in MEP_KEYWORDS (storage is occupied use, not MEP).
const STORAGE_QUALIFIER_KEYWORDS = ["STORAGE", "CLOSET", "STOREROOM"];
const PUBLIC_FACING_KEYWORDS = ["LOBBY", "RECEPTION", "WAITING", "ENTRY", "ENTRANCE", "VISITOR", "ATRIUM", "CONCOURSE", "FOYER"];
const STAFF_KEYWORDS = ["STAFF", "EMPLOYEE", "CREW", "PERSONNEL"];

// OFFICE_TOKENS and SUITE_TOKENS are imported from room-classification-tokens.ts

// Dimension / scale text patterns — these are NOT room labels
const DIMENSION_RE = /[\d]+'|[\d]+"|\d+\s*[-x]\s*\d|1\s*\/\s*\d{1,3}\s*=|^\d+[\s.]*$/;

// Room number pattern: "120", "B-201", "A103", "101A", "B201"
// Handles optional letter prefix and optional trailing letter.
const ROOM_NUMBER_RE = /^(?:[A-Za-z]{1,3}[-_]?\d{2,4}[A-Za-z]?|\d{2,4}[A-Za-z]?)$/;

// Occupant loads table signal phrases
const OCCUPANT_LOAD_SIGNALS = ["OCCUPANT LOAD", "OCCUPANCY LOAD", "OCC LOAD", "OCCUPANCY GROUP", "TABLE OF OCCUPANCY"];

// Title-block exclusion zone: bottom-right corner of page (typical location)
const TITLE_BLOCK_X_THRESHOLD = 0.72;
const TITLE_BLOCK_Y_THRESHOLD = 0.82;

// ── Flag derivation ───────────────────────────────────────────────────────────

/**
 * Returns true if `keyword` appears as a complete word (or phrase) within `text`.
 * Uses regex word-boundary anchors so "WORKSHOP" in "WORKSHOP STORAGE" matches
 * but "WORKSHOP" in "WORKSHOPPING" does not.
 * Handles hyphenated keywords (e.g. "CO-WORKING") correctly because hyphens are
 * non-word characters and \b anchors naturally at the hyphen boundary.
 */
function includesWholeWord(text: string, keyword: string): boolean {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(text);
}

export function deriveFlags(
  roomName: string,
  occupantLoad: number | null,
  occupancyGroup: string | null,
): Omit<RoomRecord, "roomNumber" | "roomName" | "level" | "pdfPage" | "occupantLoad" | "occupancyGroup" | "boundingBox" | "extractionConfidence"> {
  const u = roomName.toUpperCase();

  const isRestroom = RESTROOM_KEYWORDS.some((k) => u.includes(k));
  const isStair = STAIR_PREFIXES.some((k) => u.startsWith(k));
  const isElevator = ELEVATOR_KEYWORDS.some((k) => u.includes(k));
  const isVestibule = VESTIBULE_KEYWORDS.some((k) => u.includes(k));
  const isCorridorOrHall = CORRIDOR_KEYWORDS.some((k) => u.includes(k));
  const isVehicleBay = VEHICLE_BAY_KEYWORDS.some((k) => u.includes(k));
  const isMepUnoccupied =
    MEP_KEYWORDS.some((k) => u.includes(k)) &&
    (occupantLoad === null || occupantLoad === 0);
  const hasStorageQualifier = STORAGE_QUALIFIER_KEYWORDS.some((k) => u.includes(k));
  const isVariableUse =
    VARIABLE_USE_KEYWORDS.some((k) => includesWholeWord(u, k)) &&
    !isMepUnoccupied &&
    !hasStorageQualifier;
  const isPublicFacing = PUBLIC_FACING_KEYWORDS.some((k) => u.includes(k));
  const isStaffOnly = STAFF_KEYWORDS.some((k) => u.includes(k));
  const isAssembly =
    (occupancyGroup != null && /^A[-\s]?[0-9]/.test(occupancyGroup)) ||
    (occupantLoad != null && occupantLoad >= 50);

  const isOffice = [...OFFICE_TOKENS].some((tok) => u.includes(tok.toUpperCase()));
  const isSuite = [...SUITE_TOKENS].some((tok) => u.includes(tok.toUpperCase()));

  return {
    isRestroom,
    isStair,
    isElevator,
    isVestibule,
    isCorridorOrHall,
    isVehicleBay,
    isMepUnoccupied,
    isVariableUse,
    isPublicFacing,
    isStaffOnly,
    isAssembly,
    isOffice,
    isSuite,
  };
}

// ── Gemini occupant loads extraction ─────────────────────────────────────────

const OCCUPANT_LOADS_DPI = 200;
const OCCUPANT_LOADS_SCALE = OCCUPANT_LOADS_DPI / 72; // ≈ 2.78 — rasterize at 200 DPI

const OCCUPANT_LOADS_GEMINI_PROMPT = `You are examining a life safety / egress plan sheet from a set of architectural drawings.
This page typically contains an occupant loads table listing each room with its design occupant load and occupancy classification.

Extract every row from the occupant loads table and return a JSON array where each element has exactly these four fields:
- room_num: the room number (string, e.g. "101", "A-202") — use null if not shown
- room_name: the room or space name (string)
- occupant_load: the numeric occupant load (integer) — use null if not shown
- occupancy_group: the IBC occupancy group code (string, e.g. "A-2", "B", "E") — use null if not shown

Return ONLY a valid JSON array with no markdown, no explanation, and no surrounding text.
If no occupant loads table is visible on this page, return an empty array: []`;

interface GeminiOccupantLoadRow {
  room_num: string | null;
  room_name: string;
  occupant_load: number | null;
  occupancy_group: string | null;
}

/**
 * Rasterizes the given life safety page at 200 DPI and sends it to Gemini to
 * extract the occupant loads table. Returns parsed rows or [] on failure.
 */
async function extractOccupantLoadsViaGemini(
  pdfPath: string,
  pageNum: number,
  fileId: string,
  jobId: string,
): Promise<{ entries: OccupantLoadEntry[]; found: boolean }> {
  try {
    // Use a dedicated subdirectory so the 200 DPI render never collides with
    // the default-scale (1.5×) images cached under the main pages directory.
    const outputDir = `${getFilePageImagesDir(fileId)}/200dpi`;
    const rendered = await renderFloorPlanPages(pdfPath, [pageNum], outputDir, OCCUPANT_LOADS_SCALE);
    const imagePath = rendered.get(pageNum);
    if (!imagePath) {
      logger.warn({ fileId, pageNum, jobId }, "[RoomInventory] Gemini: page render returned no path");
      return { entries: [], found: false };
    }

    const pngBuffer = await fs.readFile(imagePath);
    const base64 = pngBuffer.toString("base64");

    const geminiClient = ai as {
      models: {
        generateContent: (opts: {
          model: string;
          contents: { role: string; parts: ({ text: string } | { inlineData: { mimeType: string; data: string } })[] }[];
          config?: { maxOutputTokens?: number; temperature?: number; thinkingConfig?: { thinkingBudget: number } };
        }) => Promise<{ text: string | undefined }>;
      };
    };

    const response = await geminiClient.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType: "image/png", data: base64 } },
            { text: OCCUPANT_LOADS_GEMINI_PROMPT },
          ],
        },
      ],
      config: { maxOutputTokens: 4096, temperature: 0.0, thinkingConfig: { thinkingBudget: 0 } },
    });

    const raw = (response.text ?? "").trim();
    if (!raw) return { entries: [], found: false };

    // Strip optional markdown code fence
    const jsonText = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
    let rows: GeminiOccupantLoadRow[];
    try {
      rows = JSON.parse(jsonText) as GeminiOccupantLoadRow[];
    } catch {
      logger.warn({ fileId, pageNum, jobId, raw: raw.slice(0, 200) }, "[RoomInventory] Gemini: JSON parse failed");
      return { entries: [], found: false };
    }

    if (!Array.isArray(rows) || rows.length === 0) {
      return { entries: [], found: false };
    }

    const entries: OccupantLoadEntry[] = [];
    for (const row of rows) {
      if (!row.room_num && !row.room_name) continue;
      if (row.occupant_load == null || isNaN(Number(row.occupant_load))) continue;
      const load = Number(row.occupant_load);
      if (load < 0 || load >= 10000) continue;
      const roomNum = (row.room_num ?? row.room_name ?? "").toString().trim().toUpperCase();
      if (!roomNum) continue;
      entries.push({
        roomNumber: roomNum,
        occupantLoad: load,
        occupancyGroup: row.occupancy_group ? row.occupancy_group.trim().toUpperCase() : null,
      });
    }

    logger.info({ fileId, pageNum, jobId, count: entries.length }, "[RoomInventory] Gemini occupant loads extracted");
    return { entries, found: entries.length > 0 };
  } catch (err) {
    logger.warn({ err, fileId, pageNum, jobId }, "[RoomInventory] Gemini occupant loads call failed — will fall back to text");
    return { entries: [], found: false };
  }
}

// ── Occupant loads table parser ───────────────────────────────────────────────

/**
 * Scans all pages of the PDF for an occupant loads table.
 * Uses raw text items to preserve column boundaries.
 * Returns a map: roomNumber → { occupantLoad, occupancyGroup }
 */
async function parseOccupantLoadsTable(
  pdfPath: string,
  allPageNumbers: number[],
): Promise<{ entries: OccupantLoadEntry[]; found: boolean }> {
  for (const pageNum of allPageNumbers) {
    try {
      const { items } = await extractRawPageItems(pdfPath, pageNum);
      const pageText = items.map((i) => i.text).join(" ").toUpperCase();

      const hasSignal = OCCUPANT_LOAD_SIGNALS.some((s) => pageText.includes(s));
      if (!hasSignal) continue;

      // Sort items top-to-bottom, left-to-right to reconstruct rows
      const sorted = [...items].sort((a, b) => {
        if (Math.abs(a.y - b.y) > 4) return a.y - b.y;
        return a.x - b.x;
      });

      // Group into rows by Y proximity
      const rows: Array<Array<{ text: string; x: number; y: number }>> = [];
      let currentRow: Array<{ text: string; x: number; y: number }> = [];
      let lastY = -999;

      for (const item of sorted) {
        if (Math.abs(item.y - lastY) > 8 && currentRow.length > 0) {
          rows.push(currentRow);
          currentRow = [];
        }
        currentRow.push(item);
        lastY = item.y;
      }
      if (currentRow.length > 0) rows.push(currentRow);

      const entries: OccupantLoadEntry[] = [];

      for (const row of rows) {
        const rowText = row.map((c) => c.text).join(" ");
        // Room number formats: 120, A103, B-201, B201A, etc.
        // Occupant load is a 1-4 digit number
        // Optional occupancy group: A-2, B, E, etc.
        const match = rowText.match(
          /([A-Za-z]{0,3}[-_]?\d{2,4}[A-Za-z]?)\s+.*?(\d{1,4})\s*(?:OCC|OCCUPANT|LOAD)?(?:\s+([A-E][-\s]?\d?))?/i
        );
        if (match) {
          const roomNum = match[1]!.trim().toUpperCase();
          const load = parseInt(match[2]!, 10);
          const group = match[3] ? match[3].trim().toUpperCase() : null;
          if (!isNaN(load) && load >= 0 && load < 10000) {
            entries.push({ roomNumber: roomNum, occupantLoad: load, occupancyGroup: group });
          }
        }
      }

      if (entries.length > 0) {
        return { entries, found: true };
      }
    } catch {
      // non-fatal per-page
    }
  }
  return { entries: [], found: false };
}

// ── Room label extraction ─────────────────────────────────────────────────────

interface RawRoomLabel {
  name: string;
  number: string | null;
  pdfPage: number;
  x: number;
  y: number;
  w: number;
  h: number;
  confidence: number;
  doorCount?: number | null;
}

/**
 * Parses a "NAME / NUMBER" or "NAME/NUMBER" single-phrase label.
 * Returns { name, number } on success, or null if the text does not match.
 * Exported for unit testing.
 */
export function parseSlashLabel(text: string): { name: string; number: string } | null {
  const t = text.trim();
  const m = t.match(/^(.+?)\s*\/\s*([A-Za-z0-9\-]+)\s*$/);
  if (!m) return null;
  const name = m[1]!.trim();
  const number = m[2]!.trim();
  if (name.length < 2 || DIMENSION_RE.test(name)) return null;
  return { name: name.toUpperCase(), number: number.toUpperCase() };
}

/**
 * Checks whether a text phrase looks like a room *name* (not a number or dimension).
 */
export function isLikelyRoomName(text: string, heightPts: number): boolean {
  const t = text.trim();
  if (t.length < 2 || t.length > 40) return false;

  // Skip dimension/scale text
  if (DIMENSION_RE.test(t)) return false;

  // Skip items that are purely numeric
  if (/^\d+$/.test(t)) return false;

  // Skip drawing-number patterns like "A-101" or "S-301"
  if (/^[A-Z]{1,2}[-/]\d{2,4}$/.test(t.toUpperCase())) return false;

  // Skip if it looks like a pure room number (reserved for the number candidate set)
  if (ROOM_NUMBER_RE.test(t)) return false;

  // Must contain at least one alphabetic character
  if (!/[A-Za-z]/.test(t)) return false;

  // Font height filter: room labels are typically small (4–20 pts)
  if (heightPts < 4 || heightPts > 20) return false;

  // Skip very long phrases (titles, keynote descriptions)
  if (t.split(" ").length > 6) return false;

  return true;
}

/**
 * Returns true if a phrase looks like a room *number* (e.g. "120", "B-201").
 */
export function isLikelyRoomNumber(text: string): boolean {
  return ROOM_NUMBER_RE.test(text.trim());
}

// Door-keyword patterns for door-count heuristic extraction.
// We look for digit tokens adjacent to these keywords within the room zone.
const DOOR_KEYWORDS = new Set(["door", "doors", "entry", "entries", "egress", "exit", "exits"]);

/**
 * Extracts raw room labels from a single floor plan page.
 *
 * Maintains three candidate sets:
 *   - nameCandidates: phrases that pass isLikelyRoomName() (4–20 pt)
 *   - numberCandidates: phrases that pass isLikelyRoomNumber() (4–20 pt)
 *   - zoneLabelCandidates: large-font (20–36 pt) phrases — stored as spatial
 *     anchors but NOT added to the room candidate list.
 *
 * Adjacency thresholds are computed adaptively from the median inter-room
 * spacing on the page rather than using the fixed 6% / 12% hardcoded values,
 * so the algorithm self-calibrates to dense or sparse drawings.
 *
 * Returns both room labels AND zone anchors via a two-element tuple.
 */
async function extractRoomLabelsFromPage(
  pdfPath: string,
  fileId: string,
  pageNum: number,
): Promise<{ labels: RawRoomLabel[]; zoneAnchors: ZoneAnchor[] }> {
  const { phrases, pageHeight } = await extractPagePhrases(pdfPath, fileId, pageNum);

  // Separate interior phrases into candidate sets
  const nameCandidates: typeof phrases = [];
  const numberCandidates: typeof phrases = [];
  const zoneLabelCandidates: ZoneAnchor[] = [];

  for (const p of phrases) {
    // Exclude title block area (bottom-right corner of page)
    if (p.x0 > TITLE_BLOCK_X_THRESHOLD && p.y0 > TITLE_BLOCK_Y_THRESHOLD) continue;

    const heightPts = (p.y1 - p.y0) * pageHeight;
    const t = p.text.trim();

    if (isLikelyRoomNumber(t)) {
      if (heightPts >= 4 && heightPts <= 20) numberCandidates.push(p);
    } else if (isLikelyRoomName(t, heightPts)) {
      nameCandidates.push(p);
    } else if (heightPts > 20 && heightPts <= 36 && /[A-Za-z]/.test(t) && t.length >= 3 && t.length <= 30) {
      // Large-font zone label (e.g. "AREA A", "WING B") — capture as spatial anchor
      zoneLabelCandidates.push({
        text: t.toUpperCase(),
        pdfPage: pageNum,
        x: p.x0,
        y: p.y0,
        w: p.x1 - p.x0,
        h: p.y1 - p.y0,
      });
    }
  }

  // ── Adaptive adjacency thresholds ────────────────────────────────────────
  // Compute the median vertical gap between adjacent name candidates (sorted
  // by Y-center). Use 1.5× that median as the vertical threshold and 2.5× as
  // the horizontal threshold. Clamp to the original fixed values as fallback.
  let vertThreshold = 0.06;  // fallback: 6% of page height
  let horizThreshold = 0.12; // fallback: 12% of page width

  if (nameCandidates.length >= 3) {
    const yCenters = nameCandidates
      .map((p) => (p.y0 + p.y1) / 2)
      .sort((a, b) => a - b);
    const gaps: number[] = [];
    for (let i = 1; i < yCenters.length; i++) {
      const gap = yCenters[i]! - yCenters[i - 1]!;
      if (gap > 0) gaps.push(gap);
    }
    if (gaps.length > 0) {
      gaps.sort((a, b) => a - b);
      const medianGap = gaps[Math.floor(gaps.length / 2)]!;
      // Use 1.5× median as vertical, 2.5× as horizontal; clamp to [0.03, 0.15]
      vertThreshold = Math.max(0.03, Math.min(0.15, medianGap * 1.5));
      horizThreshold = Math.max(0.06, Math.min(0.25, medianGap * 2.5));
    }
  }

  // ── Door count heuristic extraction ─────────────────────────────────────
  // Scan all phrases for digit tokens adjacent to door-keyword tokens.
  // Results are stored as positioned records (not a page-global Y-bucket)
  // so each room can look for door hints within its own spatial window.
  interface DoorHint { x: number; y: number; count: number }
  const doorHintList: DoorHint[] = [];
  const allPhrasesSorted = [...phrases].sort((a, b) => (a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2);

  for (let i = 0; i < allPhrasesSorted.length; i++) {
    const p = allPhrasesSorted[i]!;
    const lower = p.text.trim().toLowerCase();
    if (!DOOR_KEYWORDS.has(lower)) continue;

    // Look for adjacent digit tokens within ±2 positions and same Y-band
    for (let j = Math.max(0, i - 2); j <= Math.min(allPhrasesSorted.length - 1, i + 2); j++) {
      if (j === i) continue;
      const neighbor = allPhrasesSorted[j]!;
      const vertDist = Math.abs((p.y0 + p.y1) / 2 - (neighbor.y0 + neighbor.y1) / 2);
      if (vertDist > vertThreshold) continue;
      const num = parseInt(neighbor.text.trim(), 10);
      if (!isNaN(num) && num >= 1 && num <= 20) {
        // Store hint at the centroid of the door-keyword phrase
        doorHintList.push({
          x: (p.x0 + p.x1) / 2,
          y: (p.y0 + p.y1) / 2,
          count: num,
        });
        break;
      }
    }
  }

  const results: RawRoomLabel[] = [];
  const usedNumberIndices = new Set<number>();

  for (const phrase of nameCandidates) {
    const text = phrase.text.trim();

    // Case 1: "NAME / NUMBER" or "NAME/NUMBER" in a single phrase
    const slashParsed = parseSlashLabel(text);
    if (slashParsed) {
      results.push({
        name: slashParsed.name,
        number: slashParsed.number,
        pdfPage: pageNum,
        x: phrase.x0,
        y: phrase.y0,
        w: phrase.x1 - phrase.x0,
        h: phrase.y1 - phrase.y0,
        confidence: 0.85,
      });
      continue;
    }

    // Case 2: Look for an adjacent room number in the numberCandidates set.
    // "Adjacent" uses the adaptively computed thresholds.
    let adjacentNumber: string | null = null;
    let bestIdx = -1;
    let bestDist = Infinity;

    for (let j = 0; j < numberCandidates.length; j++) {
      if (usedNumberIndices.has(j)) continue;
      const numPhrase = numberCandidates[j]!;

      const vertDist = Math.abs(
        (phrase.y0 + phrase.y1) / 2 - (numPhrase.y0 + numPhrase.y1) / 2
      );
      const horizDist = Math.abs(
        (phrase.x0 + phrase.x1) / 2 - (numPhrase.x0 + numPhrase.x1) / 2
      );

      if (vertDist < vertThreshold && horizDist < horizThreshold) {
        const dist = Math.sqrt(vertDist ** 2 + horizDist ** 2);
        if (dist < bestDist) {
          bestDist = dist;
          bestIdx = j;
          adjacentNumber = numPhrase.text.trim().toUpperCase();
        }
      }
    }

    if (bestIdx !== -1) {
      usedNumberIndices.add(bestIdx);
    }

    // Case 3: Check for a door-count hint within this phrase's local spatial
    // window.  Uses the same adaptive thresholds as room-number adjacency so
    // hints from neighbouring rooms on the same Y-band are NOT misattributed.
    const roomCx = (phrase.x0 + phrase.x1) / 2;
    const roomCy = (phrase.y0 + phrase.y1) / 2;
    let doorCount: number | null = null;
    for (const hint of doorHintList) {
      if (
        Math.abs(hint.y - roomCy) < vertThreshold &&
        Math.abs(hint.x - roomCx) < horizThreshold
      ) {
        doorCount = hint.count;
        break;
      }
    }

    results.push({
      name: text.toUpperCase(),
      number: adjacentNumber,
      pdfPage: pageNum,
      x: phrase.x0,
      y: phrase.y0,
      w: phrase.x1 - phrase.x0,
      h: phrase.y1 - phrase.y0,
      confidence: adjacentNumber ? 0.75 : 0.6,
      doorCount,
    });
  }

  return { labels: results, zoneAnchors: zoneLabelCandidates };
}

// ── Deduplication ─────────────────────────────────────────────────────────────

/**
 * Removes spatial near-duplicates caused by CAD text fragmentation.
 *
 * Two labels are considered duplicates ONLY when they are on the SAME page AND
 * their bounding box centres are within SPATIAL_DUP_THRESHOLD normalized units.
 * This correctly handles repeated extraction of the same label text at the same
 * physical location without collapsing distinct rooms that happen to share a
 * name (e.g., multiple "CORRIDOR" areas on the same floor) or the same label
 * appearing on different pages / levels.
 */
const SPATIAL_DUP_THRESHOLD = 0.025; // ~2.5% of page width/height

function deduplicateRooms(labels: RawRoomLabel[]): RawRoomLabel[] {
  const kept: RawRoomLabel[] = [];

  for (const candidate of labels) {
    const cx = candidate.x + candidate.w / 2;
    const cy = candidate.y + candidate.h / 2;

    // Find any already-kept label on the same page whose centre is very close
    let nearDupIdx = -1;
    for (let i = 0; i < kept.length; i++) {
      const k = kept[i]!;
      if (k.pdfPage !== candidate.pdfPage) continue;
      const kx = k.x + k.w / 2;
      const ky = k.y + k.h / 2;
      const dist = Math.sqrt((cx - kx) ** 2 + (cy - ky) ** 2);
      if (dist < SPATIAL_DUP_THRESHOLD) {
        nearDupIdx = i;
        break;
      }
    }

    if (nearDupIdx === -1) {
      // No spatial near-duplicate found — this is a distinct room
      kept.push(candidate);
    } else {
      // Replace with higher-confidence extraction
      if (candidate.confidence > kept[nearDupIdx]!.confidence) {
        kept[nearDupIdx] = candidate;
      }
    }
  }

  return kept;
}

// ── AI enrichment for ambiguous rooms ────────────────────────────────────────

/**
 * Returns true if a room record could not be reliably classified by text
 * heuristics alone and should be sent to Gemini for classification.
 *
 * Criteria (any one is sufficient):
 *   1. Low extraction confidence (< 0.5)
 *   2. Very short room name (< 4 chars) — likely an abbreviation
 *   3. No boolean flags were derived — the label matched no known keyword
 */
function isAmbiguousRoom(room: RoomRecord): boolean {
  if (room.extractionConfidence < 0.5) return true;
  if (room.roomName.replace(/\s+/g, "").length < 4) return true;

  const hasAnyFlag =
    room.isRestroom ||
    room.isStair ||
    room.isElevator ||
    room.isVestibule ||
    room.isCorridorOrHall ||
    room.isVehicleBay ||
    room.isMepUnoccupied ||
    room.isVariableUse ||
    room.isPublicFacing ||
    room.isStaffOnly ||
    room.isAssembly;

  return !hasAnyFlag;
}

interface GeminiRoomClassification {
  index: number;
  roomName: string;
  roomType:
    | "RESTROOM"
    | "STAIR"
    | "ELEVATOR"
    | "VESTIBULE"
    | "CORRIDOR"
    | "VEHICLE_BAY"
    | "MEP_UNOCCUPIED"
    | "VARIABLE_USE"
    | "PUBLIC_FACING"
    | "STAFF_ONLY"
    | "ASSEMBLY"
    | "OFFICE"
    | "STORAGE"
    | "OTHER";
  confidence: number;
}

// ── Visual crop helper ────────────────────────────────────────────────────────

const CROP_RENDER_SCALE = 1.5;
const CROP_PADDING_FACTOR = 3.0;
const CROP_MIN_PX = 64;

/**
 * Maximum number of inline room-image crops sent in a single Gemini request.
 * Large drawings can have dozens of ambiguous rooms; exceeding Gemini's
 * per-request input limits causes the entire call to fail.
 *
 * When the total number of ambiguous rooms exceeds this limit, candidates are
 * split into sequential batches of this size. Each batch is sent as a separate
 * Gemini call so every room receives a visual crop rather than having
 * lower-priority rooms fall back to text-only context.
 */
const MAX_VISUAL_CROPS = 20;
/**
 * If the fraction of batches that return no parseable JSON array exceeds this
 * threshold within a single job, a structured error is logged so operators are
 * alerted to a potential Gemini regression (e.g. the model has started returning
 * prose instead of JSON for a majority of requests).
 */
const NO_JSON_ARRAY_FAILURE_RATE_THRESHOLD = 0.5;

/**
 * Crops the bounding-box region from an already-rendered page PNG.
 * Returns null on any failure so callers can fall back to text-only.
 *
 * Expects an absolute path to the rendered PNG file.
 */
export async function cropRoomRegion(
  imagePath: string,
  bbox: { x: number; y: number; w: number; h: number },
): Promise<string | null> {
  try {
    const { loadImage, createCanvas } = await import("@napi-rs/canvas");
    const img = await loadImage(imagePath);
    const imgW = img.width as number;
    const imgH = img.height as number;

    // Convert normalised bbox to pixel coordinates
    const bx = bbox.x * imgW;
    const by = bbox.y * imgH;
    const bw = bbox.w * imgW;
    const bh = bbox.h * imgH;

    // Add generous padding so Gemini can see surrounding context
    const padX = Math.max(bw * CROP_PADDING_FACTOR, CROP_MIN_PX);
    const padY = Math.max(bh * CROP_PADDING_FACTOR, CROP_MIN_PX);

    const cx = Math.max(0, Math.round(bx - padX));
    const cy = Math.max(0, Math.round(by - padY));
    const cw = Math.min(imgW - cx, Math.round(bw + padX * 2));
    const ch = Math.min(imgH - cy, Math.round(bh + padY * 2));

    if (cw < 4 || ch < 4) return null;

    const canvas = createCanvas(cw, ch);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, cx, cy, cw, ch, 0, 0, cw, ch);

    const pngBuffer = await canvas.encode("png");
    return pngBuffer.toString("base64");
  } catch (err) {
    logger.debug({ err, imagePath }, "[RoomInventory] cropRoomRegion failed — text-only fallback");
    return null;
  }
}

// ── Gemini content part types ─────────────────────────────────────────────────

type GeminiTextPart = { text: string };
type GeminiInlineDataPart = { inlineData: { mimeType: string; data: string } };
type GeminiPart = GeminiTextPart | GeminiInlineDataPart;

// ── AI enrichment for ambiguous rooms (text + optional visual context) ────────

/**
 * Sends ambiguous room records to Gemini for classification.
 * Returns an updated copy of the rooms array with aiEnriched flags and
 * corrected roomName / flags for enriched records.
 *
 * When pdfPath is provided, each ambiguous room's bounding-box region is
 * cropped from the rasterised floor plan page and sent as an inline image
 * alongside the text label, improving accuracy for short/cryptic names.
 *
 * Non-fatal: if Gemini fails the original rooms are returned unchanged.
 */
export async function enrichAmbiguousRoomsWithAI(
  rooms: RoomRecord[],
  fileId: string,
  jobId: string,
  pdfPath?: string,
): Promise<{ rooms: RoomRecord[]; enrichedCount: number }> {
  const ambiguousIndices: number[] = [];
  for (let i = 0; i < rooms.length; i++) {
    if (isAmbiguousRoom(rooms[i]!)) ambiguousIndices.push(i);
  }

  if (ambiguousIndices.length === 0) {
    return { rooms, enrichedCount: 0 };
  }

  const candidates = ambiguousIndices.map((idx) => {
    const r = rooms[idx]!;
    return { index: idx, roomName: r.roomName, roomNumber: r.roomNumber ?? null, level: r.level };
  });

  // ── Attempt to build per-room visual crops ────────────────────────────────
  // Map: ambiguous array position → base64 PNG crop (null = not available)
  const crops = new Map<number, string | null>();
  let anyVisual = false;

  if (pdfPath) {
    // Collect the unique page numbers that have at least one ambiguous room with
    // a bounding box, then render all of them in one batch (the rasterizer
    // already caches PNGs on disk so subsequent calls are fast no-ops, but
    // batching here avoids redundant PDF decode work for busy drawings).
    const uniquePages = new Set<number>();
    for (const c of candidates) {
      const room = rooms[c.index]!;
      if (room.boundingBox) uniquePages.add(room.pdfPage);
    }

    let renderedPages = new Map<number, string>();
    if (uniquePages.size > 0) {
      try {
        const outputDir = getFilePageImagesDir(fileId);
        renderedPages = await renderFloorPlanPages(
          pdfPath,
          Array.from(uniquePages),
          outputDir,
          CROP_RENDER_SCALE,
        );
      } catch (err) {
        logger.warn({ err, fileId, jobId }, "[RoomInventory] Page render for visual crops failed — text-only fallback");
      }
    }

    await Promise.all(
      candidates.map(async (c, pos) => {
        const room = rooms[c.index]!;
        if (!room.boundingBox) {
          crops.set(pos, null);
          return;
        }
        const imagePath = renderedPages.get(room.pdfPage);
        if (!imagePath) {
          crops.set(pos, null);
          return;
        }
        const b64 = await cropRoomRegion(imagePath, room.boundingBox);
        crops.set(pos, b64);
      }),
    );

    // Determine whether any crops are available
    for (const [, b64] of crops) {
      if (b64) { anyVisual = true; break; }
    }
  }

  // ── Split candidates into batches of MAX_VISUAL_CROPS ─────────────────────
  // Each batch becomes a separate sequential Gemini call so every room gets a
  // visual crop instead of having low-priority rooms dropped when the total
  // exceeds MAX_VISUAL_CROPS.
  const batches: (typeof candidates)[] = [];
  for (let i = 0; i < candidates.length; i += MAX_VISUAL_CROPS) {
    batches.push(candidates.slice(i, i + MAX_VISUAL_CROPS));
  }

  const ROOM_TYPE_OPTIONS = `Room type options:
- RESTROOM: toilets, restrooms, bathrooms, showers, WC, lavatory
- STAIR: stairwells, stair towers
- ELEVATOR: elevators, lifts
- VESTIBULE: vestibules, airlocks, transition spaces
- CORRIDOR: hallways, corridors, passages, aisles, lobbies, foyers
- VEHICLE_BAY: apparatus bays, vehicle bays, garages, sally ports
- MEP_UNOCCUPIED: mechanical rooms, electrical rooms, data/IT rooms, janitor closets, storage closets, telecom rooms
- VARIABLE_USE: conference rooms, training rooms, multipurpose rooms, classrooms, meeting rooms
- PUBLIC_FACING: public lobbies, reception areas, waiting rooms, visitor areas
- STAFF_ONLY: staff rooms, employee areas, crew quarters
- ASSEMBLY: assembly areas, auditoriums, large gathering spaces
- OFFICE: offices, workstations, administrative areas
- STORAGE: storage areas, warehouses, stock rooms
- OTHER: anything that doesn't fit the above`;

  const JSON_RESPONSE_FOOTER =
    `\nRespond with ONLY a valid JSON array. Each element must have:\n` +
    `- "index": the original index number (integer)\n` +
    `- "roomName": the expanded/corrected room name in ALL CAPS (keep original if already clear)\n` +
    `- "roomType": one of the room type strings above\n` +
    `- "confidence": a number from 0.0 to 1.0 indicating your certainty`;

  logger.info(
    { fileId, jobId, ambiguous: ambiguousIndices.length, batches: batches.length, visual: anyVisual },
    "[RoomInventory] Sending ambiguous rooms to Gemini for classification",
  );

  const allClassifications: GeminiRoomClassification[] = [];

  try {
    const geminiClient = ai as {
      models: {
        generateContent: (opts: {
          model: string;
          contents: { role: string; parts: GeminiPart[] }[];
          config?: { temperature?: number };
        }) => Promise<{ text: string | undefined }>;
      };
    };

    let failedBatches = 0;

    for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
      const batch = batches[batchIdx]!;
      // candidateOffset maps batch-local positions back to the original crops Map
      const candidateOffset = batchIdx * MAX_VISUAL_CROPS;

      const batchHasVisual = batch.some((_, i) => (crops.get(candidateOffset + i) ?? null) !== null);

      const parts: GeminiPart[] = [];

      if (batchHasVisual) {
        // Multimodal prompt: interleave images with per-room text descriptions
        parts.push({
          text:
            `You are a building architecture expert analyzing floor plan room labels from a construction document set.\n\n` +
            `The following room labels were extracted from a PDF floor plan but could not be confidently classified by ` +
            `keyword heuristics because they are very short abbreviations, unusual names, or non-standard labels.\n\n` +
            `For each room you will see the text label and, where available, a cropped image from the floor plan showing ` +
            `the surrounding area. Use both sources of information to determine the room type and, if the label is an ` +
            `abbreviation, expand it to the full standard room name.\n\n` +
            ROOM_TYPE_OPTIONS,
        });

        for (let i = 0; i < batch.length; i++) {
          const c = batch[i]!;
          const crop = crops.get(candidateOffset + i) ?? null;
          parts.push({
            text: `\nRoom entry (index ${c.index}): "${c.roomName}"${c.roomNumber ? ` / room number ${c.roomNumber}` : ""}${c.level ? ` on level ${c.level}` : ""}`,
          });
          if (crop) {
            parts.push({ inlineData: { mimeType: "image/png", data: crop } });
          }
        }

        parts.push({ text: JSON_RESPONSE_FOOTER });
      } else {
        // Text-only prompt (no pdfPath, no bounding boxes, or all crops failed)
        const prompt =
          `You are a building architecture expert analyzing floor plan room labels from a construction document set.\n\n` +
          `The following room labels were extracted from a PDF floor plan but could not be confidently classified by ` +
          `keyword heuristics because they are very short abbreviations, unusual names, or non-standard labels.\n\n` +
          `For each room, determine the most likely room type from the list below, and if the label is an abbreviation, ` +
          `expand it to the full standard room name.\n\n` +
          ROOM_TYPE_OPTIONS +
          `\n\nRespond with ONLY a valid JSON array. Each element must have:\n` +
          `- "index": the original index number (integer)\n` +
          `- "roomName": the expanded/corrected room name in ALL CAPS (keep original if already clear)\n` +
          `- "roomType": one of the room type strings above\n` +
          `- "confidence": a number from 0.0 to 1.0 indicating your certainty\n\n` +
          `Rooms to classify:\n${JSON.stringify(batch, null, 2)}`;
        parts.push({ text: prompt });
      }

      if (batches.length > 1) {
        logger.info(
          { fileId, jobId, batch: batchIdx + 1, totalBatches: batches.length, batchSize: batch.length },
          "[RoomInventory] Processing AI enrichment batch",
        );
      }

      const response = await geminiClient.models.generateContent({
        model: "gemini-2.5-flash",
        contents: [{ role: "user", parts }],
        config: { temperature: 0.1 },
      });

      const text = response.text ?? "";
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        failedBatches++;
        logger.warn(
          { fileId, jobId, batch: batchIdx + 1, totalBatches: batches.length, reason: "no_json_array" },
          "[RoomInventory] Gemini returned no JSON array for AI enrichment batch — skipping batch",
        );
        continue;
      }

      const batchClassifications: GeminiRoomClassification[] = JSON.parse(jsonMatch[0]);
      allClassifications.push(...batchClassifications);
    }

    if (batches.length > 0 && failedBatches / batches.length > NO_JSON_ARRAY_FAILURE_RATE_THRESHOLD) {
      logger.error(
        {
          fileId,
          jobId,
          failedBatches,
          totalBatches: batches.length,
          failureRate: failedBatches / batches.length,
          threshold: NO_JSON_ARRAY_FAILURE_RATE_THRESHOLD,
          reason: "no_json_array_rate_exceeded",
        },
        "[RoomInventory] AI room classification failure rate exceeded threshold — Gemini may be returning unparseable responses",
      );
    }

    const updatedRooms = rooms.map((r) => ({ ...r }));
    let enrichedCount = 0;

    for (const c of allClassifications) {
      const roomIdx = c.index;
      if (roomIdx < 0 || roomIdx >= updatedRooms.length) continue;

      const room = updatedRooms[roomIdx]!;

      const expandedName = c.roomName && c.roomName.trim().length > 0
        ? c.roomName.trim().toUpperCase()
        : room.roomName;

      const newFlags = deriveFlags(expandedName, room.occupantLoad, room.occupancyGroup);

      // Also apply flags from the Gemini roomType in case the name alone won't trigger them
      const typeFlags = roomTypeToFlags(c.roomType);

      updatedRooms[roomIdx] = {
        ...room,
        roomName: expandedName,
        extractionConfidence: Math.max(room.extractionConfidence, c.confidence),
        aiEnriched: true,
        ...newFlags,
        // Override specific flags from Gemini's explicit type determination
        isRestroom: newFlags.isRestroom || typeFlags.isRestroom,
        isStair: newFlags.isStair || typeFlags.isStair,
        isElevator: newFlags.isElevator || typeFlags.isElevator,
        isVestibule: newFlags.isVestibule || typeFlags.isVestibule,
        isCorridorOrHall: newFlags.isCorridorOrHall || typeFlags.isCorridorOrHall,
        isVehicleBay: newFlags.isVehicleBay || typeFlags.isVehicleBay,
        isMepUnoccupied: newFlags.isMepUnoccupied || typeFlags.isMepUnoccupied,
        isVariableUse: newFlags.isVariableUse || typeFlags.isVariableUse,
        isPublicFacing: newFlags.isPublicFacing || typeFlags.isPublicFacing,
        isStaffOnly: newFlags.isStaffOnly || typeFlags.isStaffOnly,
        isAssembly: newFlags.isAssembly || typeFlags.isAssembly,
      };

      enrichedCount++;
    }

    logger.info(
      { fileId, jobId, ambiguous: ambiguousIndices.length, enriched: enrichedCount, batches: batches.length },
      "[RoomInventory] AI enrichment complete",
    );

    return { rooms: updatedRooms, enrichedCount };
  } catch (err) {
    logger.warn({ err, fileId, jobId }, "[RoomInventory] AI enrichment failed — non-fatal, using heuristic results");
    return { rooms, enrichedCount: 0 };
  }
}

/**
 * Maps a Gemini roomType string to the set of boolean flags it implies.
 */
function roomTypeToFlags(
  roomType: GeminiRoomClassification["roomType"],
): Pick<
  RoomRecord,
  | "isRestroom"
  | "isStair"
  | "isElevator"
  | "isVestibule"
  | "isCorridorOrHall"
  | "isVehicleBay"
  | "isMepUnoccupied"
  | "isVariableUse"
  | "isPublicFacing"
  | "isStaffOnly"
  | "isAssembly"
> {
  return {
    isRestroom: roomType === "RESTROOM",
    isStair: roomType === "STAIR",
    isElevator: roomType === "ELEVATOR",
    isVestibule: roomType === "VESTIBULE",
    isCorridorOrHall: roomType === "CORRIDOR",
    isVehicleBay: roomType === "VEHICLE_BAY",
    isMepUnoccupied: roomType === "MEP_UNOCCUPIED",
    isVariableUse: roomType === "VARIABLE_USE",
    isPublicFacing: roomType === "PUBLIC_FACING",
    isStaffOnly: roomType === "STAFF_ONLY",
    isAssembly: roomType === "ASSEMBLY",
  };
}

// ── Spatial helpers (exported for testability) ────────────────────────────────

/**
 * For each room with a boundingBox, finds the nearest ZoneAnchor on the same
 * PDF page and assigns its label as the room's zoneQualifier — if the room
 * centroid is within 2× the anchor's larger dimension.
 *
 * Mutates rooms in place.  No-op when anchors is empty.
 */
export function assignZoneQualifiersToRooms(
  rooms: RoomRecord[],
  anchors: ZoneAnchor[],
): void {
  if (anchors.length === 0) return;
  for (const room of rooms) {
    if (!room.boundingBox) continue;
    const rcx = room.boundingBox.x + room.boundingBox.w / 2;
    const rcy = room.boundingBox.y + room.boundingBox.h / 2;

    let nearest: ZoneAnchor | null = null;
    let nearestDist = Infinity;
    for (const anchor of anchors) {
      if (anchor.pdfPage !== room.pdfPage) continue;
      const acx = anchor.x + anchor.w / 2;
      const acy = anchor.y + anchor.h / 2;
      const dist = Math.hypot(rcx - acx, rcy - acy);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = anchor;
      }
    }
    if (nearest != null) {
      const radius = Math.max(nearest.w, nearest.h) * 2.0;
      if (nearestDist <= radius) {
        room.zoneQualifier = nearest.text;
      }
    }
  }
}

/**
 * Geometric staff-only restroom detection using K-nearest spatial neighbors.
 *
 * For each restroom that is not already staff-only, finds the K=5 nearest
 * non-restroom rooms on the same PDF page by boundingBox centroid distance.
 * If all K nearest rooms are explicit back-of-house types and none are
 * public-facing or assembly, the restroom is reclassified as staff-only.
 *
 * Mutates rooms in place.  Skips rooms without a boundingBox.
 *
 * @param jobId  Used for logging only.
 */
export function detectGeometricStaffOnlyRestrooms(
  rooms: RoomRecord[],
  jobId = "unknown",
): void {
  const K_NEAREST_STAFF = 5;
  for (const room of rooms) {
    if (!room.isRestroom || room.isStaffOnly || !room.boundingBox) continue;
    const rcx = room.boundingBox.x + room.boundingBox.w / 2;
    const rcy = room.boundingBox.y + room.boundingBox.h / 2;

    const candidates = rooms.filter(
      (r) => r !== room && !r.isRestroom && r.pdfPage === room.pdfPage && r.boundingBox != null,
    );
    if (candidates.length === 0) continue;

    const sorted = candidates
      .map((r) => {
        const cx = r.boundingBox!.x + r.boundingBox!.w / 2;
        const cy = r.boundingBox!.y + r.boundingBox!.h / 2;
        return { room: r, dist: Math.hypot(rcx - cx, rcy - cy) };
      })
      .sort((a, b) => a.dist - b.dist);

    const kNearest = sorted.slice(0, K_NEAREST_STAFF).map((s) => s.room);
    const hasPublicOrAssembly = kNearest.some((r) => r.isPublicFacing || r.isAssembly);
    const allBackOfHouse = kNearest.every(
      (r) =>
        r.isStaffOnly ||
        r.isMepUnoccupied ||
        r.isVehicleBay ||
        r.isCorridorOrHall ||
        r.isStair ||
        r.isElevator ||
        r.isOffice,
    );
    if (!hasPublicOrAssembly && allBackOfHouse) {
      room.isStaffOnly = true;
      room.isPublicFacing = false;
      logger.info(
        { roomName: room.roomName, level: room.level, jobId },
        "[RoomInventory] Staff-only restroom detected via geometric k-nearest (Phase 4)",
      );
    }
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Build a room inventory from all floor plan pages in a PDF file.
 *
 * @param pdfPath           Absolute path to the PDF on disk
 * @param fileId            UUID of the job_files row (phrase cache key)
 * @param floorPlanPages    Page numbers classified as floor plans (1-indexed)
 * @param level             Default level string (fallback when pageToLevel misses a page)
 * @param jobId             UUID of the parent job (for logging only)
 * @param pageToLevel       Optional per-page level map from the sheet manifest.
 *                          When provided, each RoomRecord gets its correct level
 *                          (e.g. "L1", "L2") rather than the single file-level default.
 * @param lifeSafetyPageNum Optional 1-indexed page number of the life safety / egress sheet.
 *                          When provided, Gemini image extraction is tried first for the
 *                          occupant loads table (Phase 4b). Text extraction is the fallback.
 */
export async function buildRoomInventory(
  pdfPath: string,
  fileId: string,
  floorPlanPages: number[],
  level: string,
  jobId: string,
  pageToLevel?: Map<number, string>,
  lifeSafetyPageNum?: number,
): Promise<RoomInventory> {
  const warnings: string[] = [];

  if (floorPlanPages.length === 0) {
    return {
      rooms: [],
      occupantLoadTableFound: false,
      occupantLoadSource: "none",
      occupantLoadRoomsMatched: 0,
      warnings: ["No floor plan pages provided"],
      sourcePages: [],
    };
  }

  // ── Step 1: Extract room labels from all floor plan pages ─────────────────
  const allRawLabels: RawRoomLabel[] = [];
  const allZoneAnchors: ZoneAnchor[] = [];

  await Promise.all(
    floorPlanPages.map(async (pageNum) => {
      try {
        const { labels, zoneAnchors: pageZoneAnchors } = await extractRoomLabelsFromPage(pdfPath, fileId, pageNum);
        allRawLabels.push(...labels);
        allZoneAnchors.push(...pageZoneAnchors);
        logger.info(
          {
            jobId,
            fileId,
            pageNum,
            labelsFound: labels.length,
            zoneAnchorsFound: pageZoneAnchors.length,
            roomNames: labels.map((l) => (l.number ? `${l.number} ${l.name}` : l.name)),
            zoneLabels: pageZoneAnchors.map((z) => z.text),
          },
          "[RoomInventory] Page labels extracted",
        );
      } catch (err) {
        logger.warn(
          { err, fileId, pageNum, jobId },
          "[RoomInventory] Failed to extract labels from page — non-fatal",
        );
        warnings.push(`Page ${pageNum}: extraction failed`);
      }
    })
  );

  // Deduplicate across pages
  const dedupedLabels = deduplicateRooms(allRawLabels);

  // ── Step 2: Cross-reference occupant loads table (Gemini-first, text fallback) ──
  // Phase 4b: When the sheet manifest identifies a life safety / egress page,
  // rasterize it at 200 DPI and send it to Gemini (primary path). Gemini handles
  // merged cells and multi-column tables that confuse text-based parsers.
  // If Gemini returns empty or errors, fall through to the text extraction path.
  let occupantEntries: OccupantLoadEntry[] = [];
  let occupantLoadTableFound = false;
  let occupantLoadSource: RoomInventory["occupantLoadSource"] = "none";

  if (lifeSafetyPageNum != null) {
    logger.info({ fileId, jobId, lifeSafetyPageNum }, "[RoomInventory] Phase 4b: trying Gemini for occupant loads");
    const geminiResult = await extractOccupantLoadsViaGemini(pdfPath, lifeSafetyPageNum, fileId, jobId);
    if (geminiResult.found && geminiResult.entries.length > 0) {
      occupantEntries = geminiResult.entries;
      occupantLoadTableFound = true;
      occupantLoadSource = "gemini";
      logger.info({ fileId, jobId, count: occupantEntries.length }, "[RoomInventory] Phase 4b: Gemini occupant loads OK");
    } else {
      logger.info({ fileId, jobId }, "[RoomInventory] Phase 4b: Gemini returned empty — falling back to text extraction");
    }
  }

  // Text-extraction fallback (also used when no life safety page was identified)
  if (!occupantLoadTableFound) {
    const { getPdfPageCount } = await import("./pdf-words");
    let totalPages = 1;
    try {
      totalPages = await getPdfPageCount(pdfPath);
    } catch {
      // ignore; fallback to single page
    }
    const floorPlanPageSet = new Set(floorPlanPages);
    const nonFloorPlanPages = Array.from({ length: totalPages }, (_, i) => i + 1)
      .filter((p) => !floorPlanPageSet.has(p));
    // Scan order: non-floor-plan pages first (most likely), then floor-plan pages.
    const scanOrder = [...nonFloorPlanPages, ...floorPlanPages];

    const textResult = await parseOccupantLoadsTable(pdfPath, scanOrder);
    if (textResult.found && textResult.entries.length > 0) {
      occupantEntries = textResult.entries;
      occupantLoadTableFound = true;
      occupantLoadSource = "text";
    }
  }

  const occupantMap = new Map<string, OccupantLoadEntry>();
  for (const entry of occupantEntries) {
    occupantMap.set(entry.roomNumber.toUpperCase(), entry);
  }

  // ── Step 3: Build final room records with per-page level + flags ──────────
  const rooms: RoomRecord[] = dedupedLabels.map((label) => {
    // Resolve level per page from manifest data; fall back to the file-wide default
    const pageLevel = pageToLevel?.get(label.pdfPage) ?? level;

    const occupantEntry = label.number ? occupantMap.get(label.number.toUpperCase()) : undefined;
    const occupantLoad = occupantEntry?.occupantLoad ?? null;
    const occupancyGroup = occupantEntry?.occupancyGroup ?? null;

    const flags = deriveFlags(label.name, occupantLoad, occupancyGroup);

    return {
      roomNumber: label.number,
      roomName: label.name,
      level: pageLevel,
      pdfPage: label.pdfPage,
      occupantLoad,
      occupancyGroup,
      ...flags,
      boundingBox: {
        x: label.x,
        y: label.y,
        w: label.w,
        h: label.h,
      },
      extractionConfidence: label.confidence,
      doorCount: label.doorCount ?? null,
    };
  });

  // ── Step 3.5: Zone qualifier assignment + geometric staff-only detection ──
  // Both are pure spatial operations exported as helpers for testability.
  assignZoneQualifiersToRooms(rooms, allZoneAnchors);
  if (allZoneAnchors.length > 0) {
    const zoneAssigned = rooms.filter((r) => r.zoneQualifier != null).length;
    if (zoneAssigned > 0) {
      logger.info(
        { jobId, fileId, zoneAssigned, anchors: allZoneAnchors.length },
        "[RoomInventory] Zone qualifiers assigned from spatial anchors",
      );
    }
  }
  detectGeometricStaffOnlyRestrooms(rooms, jobId);

  // ── Validate cross-references ─────────────────────────────────────────────
  let occupantLoadRoomsMatched = 0;
  if (occupantLoadTableFound) {
    for (const room of rooms) {
      if (room.roomNumber && occupantMap.has(room.roomNumber.toUpperCase())) {
        occupantLoadRoomsMatched++;
      } else if (room.roomNumber) {
        warnings.push(`Room ${room.roomNumber} not found in occupant loads table`);
      }
    }
  }

  logger.info(
    {
      jobId,
      fileId,
      level,
      floorPlanPages: floorPlanPages.length,
      rooms: rooms.length,
      occupantLoadTableFound,
      occupantLoadSource,
      occupantLoadRoomsMatched,
    },
    "[RoomInventory] Room inventory built",
  );

  if (allZoneAnchors.length > 0) {
    logger.info(
      { jobId, fileId, zoneAnchorCount: allZoneAnchors.length, zones: allZoneAnchors.map((z) => `${z.text} (p${z.pdfPage})`) },
      "[RoomInventory] Zone anchors captured from large-font labels",
    );
  }

  return {
    rooms,
    occupantLoadTableFound,
    occupantLoadSource,
    occupantLoadRoomsMatched,
    warnings,
    sourcePages: floorPlanPages,
    zoneAnchors: allZoneAnchors.length > 0 ? allZoneAnchors : undefined,
  };
}
