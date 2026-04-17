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

  boundingBox: { x: number; y: number; w: number; h: number } | null;
  extractionConfidence: number;
}

export interface RoomInventory {
  rooms: RoomRecord[];
  occupantLoadTableFound: boolean;
  warnings: string[];
  sourcePages: number[];
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
const MEP_KEYWORDS = [
  "MECHANICAL", "ELECTRICAL", "ELEC", "DATA", "IT ROOM", "SERVER",
  "FIRE SPRINKLER", "TELECOM", "TELEPHONE", "COMM", "MDF", "IDF", "SPRINKLER",
  "RISER", "JANITOR", "JAN", "STORAGE", "CLOSET",
];
const VARIABLE_USE_KEYWORDS = [
  "TRAINING", "COMMUNITY", "EOC", "MULTIPURPOSE", "MULTI-PURPOSE",
  "CONFERENCE", "MEETING", "BREAKOUT", "CLASSROOM", "ASSEMBLY ROOM",
];
const PUBLIC_FACING_KEYWORDS = ["LOBBY", "RECEPTION", "WAITING", "ENTRY", "ENTRANCE", "VISITOR", "ATRIUM", "CONCOURSE", "FOYER"];
const STAFF_KEYWORDS = ["STAFF", "EMPLOYEE", "CREW", "PERSONNEL"];

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

function deriveFlags(
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
  const isVariableUse = VARIABLE_USE_KEYWORDS.some((k) => u.includes(k));
  const isPublicFacing = PUBLIC_FACING_KEYWORDS.some((k) => u.includes(k));
  const isStaffOnly = STAFF_KEYWORDS.some((k) => u.includes(k));
  const isAssembly =
    (occupancyGroup != null && /^A[-\s]?[0-9]/.test(occupancyGroup)) ||
    (occupantLoad != null && occupantLoad >= 50);

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
  };
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
}

/**
 * Checks whether a text phrase looks like a room *name* (not a number or dimension).
 */
function isLikelyRoomName(text: string, heightPts: number): boolean {
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
function isLikelyRoomNumber(text: string): boolean {
  return ROOM_NUMBER_RE.test(text.trim());
}

/**
 * Extracts raw room labels from a single floor plan page.
 *
 * Maintains two candidate sets:
 *   - nameCandidates: phrases that pass isLikelyRoomName()
 *   - numberCandidates: phrases that pass isLikelyRoomNumber()
 *
 * This separation prevents numeric tokens from being blocked by isLikelyRoomName()
 * and then failing adjacency matching (the critical bug fixed in this revision).
 */
async function extractRoomLabelsFromPage(
  pdfPath: string,
  fileId: string,
  pageNum: number,
): Promise<RawRoomLabel[]> {
  const { phrases, pageHeight } = await extractPagePhrases(pdfPath, fileId, pageNum);

  // Separate interior phrases into two candidate sets
  const nameCandidates: typeof phrases = [];
  const numberCandidates: typeof phrases = [];

  for (const p of phrases) {
    // Exclude title block area (bottom-right corner of page)
    if (p.x0 > TITLE_BLOCK_X_THRESHOLD && p.y0 > TITLE_BLOCK_Y_THRESHOLD) continue;

    const heightPts = (p.y1 - p.y0) * pageHeight;
    const t = p.text.trim();

    if (isLikelyRoomNumber(t)) {
      // Only accept number tokens within reasonable font size range
      if (heightPts >= 4 && heightPts <= 20) {
        numberCandidates.push(p);
      }
    } else if (isLikelyRoomName(t, heightPts)) {
      nameCandidates.push(p);
    }
  }

  const results: RawRoomLabel[] = [];
  const usedNumberIndices = new Set<number>();

  for (const phrase of nameCandidates) {
    const text = phrase.text.trim();

    // Case 1: "NAME / NUMBER" or "NAME/NUMBER" in a single phrase
    const slashMatch = text.match(/^(.+?)\s*\/\s*([A-Za-z0-9\-]+)\s*$/);
    if (slashMatch) {
      const name = slashMatch[1]!.trim();
      const num = slashMatch[2]!.trim();
      if (name.length >= 2 && !DIMENSION_RE.test(name)) {
        results.push({
          name: name.toUpperCase(),
          number: num.toUpperCase(),
          pdfPage: pageNum,
          x: phrase.x0,
          y: phrase.y0,
          w: phrase.x1 - phrase.x0,
          h: phrase.y1 - phrase.y0,
          confidence: 0.85,
        });
        continue;
      }
    }

    // Case 2: Look for an adjacent room number in the numberCandidates set.
    // "Adjacent" means within ~6% of page height vertically and ~12% horizontally.
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

      if (vertDist < 0.06 && horizDist < 0.12) {
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

    results.push({
      name: text.toUpperCase(),
      number: adjacentNumber,
      pdfPage: pageNum,
      x: phrase.x0,
      y: phrase.y0,
      w: phrase.x1 - phrase.x0,
      h: phrase.y1 - phrase.y0,
      confidence: adjacentNumber ? 0.75 : 0.6,
    });
  }

  return results;
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

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Build a room inventory from all floor plan pages in a PDF file.
 *
 * @param pdfPath         Absolute path to the PDF on disk
 * @param fileId          UUID of the job_files row (phrase cache key)
 * @param floorPlanPages  Page numbers classified as floor plans (1-indexed)
 * @param level           Default level string (fallback when pageToLevel misses a page)
 * @param jobId           UUID of the parent job (for logging only)
 * @param pageToLevel     Optional per-page level map from the sheet manifest.
 *                        When provided, each RoomRecord gets its correct level
 *                        (e.g. "L1", "L2") rather than the single file-level default.
 */
export async function buildRoomInventory(
  pdfPath: string,
  fileId: string,
  floorPlanPages: number[],
  level: string,
  jobId: string,
  pageToLevel?: Map<number, string>,
): Promise<RoomInventory> {
  const warnings: string[] = [];

  if (floorPlanPages.length === 0) {
    return {
      rooms: [],
      occupantLoadTableFound: false,
      warnings: ["No floor plan pages provided"],
      sourcePages: [],
    };
  }

  // ── Step 1: Extract room labels from all floor plan pages ─────────────────
  const allRawLabels: RawRoomLabel[] = [];

  await Promise.all(
    floorPlanPages.map(async (pageNum) => {
      try {
        const labels = await extractRoomLabelsFromPage(pdfPath, fileId, pageNum);
        allRawLabels.push(...labels);
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

  // ── Step 2: Cross-reference occupant loads table ──────────────────────────
  // The occupant loads table is typically on a life_safety or cover sheet —
  // NOT on the floor plan pages themselves. We therefore scan ALL non-floor-plan
  // pages first (highest likelihood), then floor-plan pages as fallback.
  // No hard page-count cap: parseOccupantLoadsTable early-exits once found.
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

  const { entries: occupantEntries, found: occupantLoadTableFound } =
    await parseOccupantLoadsTable(pdfPath, scanOrder);

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
    };
  });

  // ── Validate cross-references ─────────────────────────────────────────────
  if (occupantLoadTableFound) {
    for (const room of rooms) {
      if (room.roomNumber && !occupantMap.has(room.roomNumber.toUpperCase())) {
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
    },
    "[RoomInventory] Room inventory built",
  );

  return {
    rooms,
    occupantLoadTableFound,
    warnings,
    sourcePages: floorPlanPages,
  };
}
