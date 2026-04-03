/**
 * Heuristic sign extraction — TypeScript port of the Python `sign_takeoff_annotator.py`
 * ───────────────────────────────────────────────────────────────────────────────────────
 * No AI calls.  Uses pdfjs text extraction + regex pattern matching + spatial proximity
 * to identify rooms and map them to sign types — the same algorithm as the reference
 * Python implementation.
 *
 * Coordinate system note (pdfjs vs pdfplumber):
 *   pdfjs-dist returns coordinates in VIEWPORT space (after applying /Rotate), with
 *   y measured from the BOTTOM (y increases upward).  `extractPagePhrases` in
 *   pdf-words.ts converts these to DISPLAY space (y from TOP, y increases downward),
 *   normalised to [0, 1] — matching pdfplumber's display-space output.  So the
 *   spatial proximity thresholds from the Python code (in pts) apply here directly
 *   when we scale by pageWidth/pageHeight.
 */

import { extractPagePhrases, getPdfPageCount } from "./pdf-words";
import { logger } from "./logger";

// ── Regex patterns (ported from Python) ──────────────────────────────────────
// Residential room numbers: 423A, 400B, etc.
const ROOM_NUM_RE = /^[0-9]{3}[AB]$/;
// Unit type labels: 1A, 1B, 2A, 2B, 3A, 3B
const UNIT_TYPE_RE = /^[123][AB]$/;
// Service room IDs: A401–A409, B401–B409, AE-4, BE-4, AS1-4, BS2-4, etc.
const SERVICE_ID_RE = /^(A|B)[0-9]{3}$|^(A|B)E-[0-9]$|^(A|B)S[12]-[0-9]$/;

// ── Service room label lookup (ported from Python SERVICE_LABEL_MAP) ──────────
const SERVICE_LABEL_MAP: Record<string, string> = {
  A401: "LOBBY",       B401: "LOBBY",
  A402: "CORR",        B402: "CORR",
  A403: "ELEC",        B403: "ELEC",
  A404: "ELEC",        B404: "ELEC",
  A405: "MECH",        B405: "MECH",
  A406: "ELEC",        B406: "ELEC",
  A407: "MECH",        B407: "MECH",
  A408: "ELEV EQUIP",  B408: "ELEV EQUIP",
  A409: "TENANT STOR", B409: "TENANT STOR",
  "AE-4": "ELEV",      "BE-4": "ELEV",
  "AS1-4": "STAIR",    "AS2-4": "STAIR",
  "BS1-4": "STAIR",    "BS2-4": "STAIR",
};

// ── Sign type classifier (ported from Python classify_sign) ──────────────────
interface SignClassification {
  signType: string;
  notes: string;
}

function classifySign(roomId: string, roomType: string): SignClassification {
  const rt = roomType.toUpperCase();
  const rid = roomId.toUpperCase();

  if (rt.includes("UNIT")) {
    const ut = rt.replace("UNIT ", "").trim();
    const beds: Record<string, string> = {
      "1A": "1-BED", "1B": "1-BED",
      "2A": "2-BED", "2B": "2-BED",
      "3A": "3-BED", "3B": "3-BED",
    };
    const bedsLabel = beds[ut] ?? "";
    return { signType: `${bedsLabel} UNIT SIGN`.trim(), notes: "Suite ID Sign" };
  }
  if (rt.includes("LOBBY"))       return { signType: "LOBBY SIGN",            notes: "Directory / Lobby ID Sign" };
  if (rt.includes("MECH"))        return { signType: "MECHANICAL ROOM SIGN",  notes: "Hazard / ID Sign" };
  if (rt.includes("ELEC"))        return { signType: "ELECTRICAL ROOM SIGN",  notes: "Hazard / ID Sign" };
  if (rt.includes("STAIR") || /^[AB]S/.test(rid))
                                   return { signType: "STAIRWELL SIGN",        notes: "Egress Sign" };
  if (rt.includes("ELEV EQUIP"))  return { signType: "ELEV EQUIPMENT SIGN",   notes: "Elevator ID Sign" };
  if (rt.includes("ELEV"))        return { signType: "ELEVATOR SIGN",         notes: "Elevator ID Sign" };
  if (rt.includes("TENANT STOR")) return { signType: "TENANT STORAGE SIGN",   notes: "Room ID Sign" };
  if (rt.includes("CORR"))        return { signType: "CORRIDOR SIGN",         notes: "Wayfinding Sign" };
  return { signType: "ROOM ID SIGN", notes: "Room ID Sign" };
}

// ── Word: individual token with its position in pts ──────────────────────────
interface Word {
  text: string;
  cx: number;   // center x in viewport pts  (x increases rightward)
  cy: number;   // center y in viewport pts  (y increases downward from top)
  nx: number;   // normalized x in [0, 1]
  ny: number;   // normalized y in [0, 1]
}

/**
 * Expand phrased output back into individual word tokens with
 * interpolated center positions.  Multi-word phrases (e.g. "UNIT 1A")
 * are split and each word gets its own proportional x position so
 * that downstream spatial proximity checks work correctly.
 */
function phrasesToWords(pw: { pageWidth: number; pageHeight: number; phrases: Array<{ text: string; x0: number; y0: number; x1: number; y1: number }> }): Word[] {
  const words: Word[] = [];
  for (const ph of pw.phrases) {
    const tokens = ph.text.trim().split(/\s+/).filter((t) => t.length > 0);
    if (tokens.length === 0) continue;

    const phX0 = ph.x0 * pw.pageWidth;
    const phX1 = ph.x1 * pw.pageWidth;
    const phCy = (ph.y0 + ph.y1) / 2 * pw.pageHeight;

    if (tokens.length === 1) {
      const nx = (ph.x0 + ph.x1) / 2;
      words.push({
        text: tokens[0]!,
        cx: (phX0 + phX1) / 2,
        cy: phCy,
        nx,
        ny: (ph.y0 + ph.y1) / 2,
      });
    } else {
      // Distribute tokens evenly across the phrase's x span
      const stepX = (phX1 - phX0) / tokens.length;
      for (let i = 0; i < tokens.length; i++) {
        const cx = phX0 + (i + 0.5) * stepX;
        words.push({
          text: tokens[i]!,
          cx,
          cy: phCy,
          nx: cx / pw.pageWidth,
          ny: (ph.y0 + ph.y1) / 2,
        });
      }
    }
  }
  return words;
}

// ── Extracted room record (intermediate) ─────────────────────────────────────
interface ExtractedRoom {
  roomId: string;
  roomType: string;
  buildingId: string;
  nx: number;
  ny: number;
  pageNumber: number;
}

/**
 * Process one page: find all rooms via regex + spatial proximity matching.
 * Returns an array of room records (before sign classification).
 */
function extractRoomsFromWords(words: Word[], pageNum: number): ExtractedRoom[] {
  const rooms: ExtractedRoom[] = [];
  const usedIds = new Set<string>(); // prevent duplicates

  // ── Residential units ─────────────────────────────────────────────────────
  for (const roomWord of words) {
    if (!ROOM_NUM_RE.test(roomWord.text)) continue;
    const key = `${pageNum}:${roomWord.text}:${Math.round(roomWord.cx)}:${Math.round(roomWord.cy)}`;
    if (usedIds.has(key)) continue;

    const rx = roomWord.cx;
    const ry = roomWord.cy;
    let unitLabel: string | null = null;

    // Look for a nearby "UNIT" label (within 40 pts horizontal, 30 pts vertical)
    for (const unitWord of words) {
      if (unitWord.text !== "UNIT") continue;
      if (Math.abs(unitWord.cx - rx) < 40 && Math.abs(unitWord.cy - ry) < 30) {
        // Found "UNIT" — now find the type label (1A, 2B, …) near the "UNIT" word
        for (const typeWord of words) {
          if (!UNIT_TYPE_RE.test(typeWord.text)) continue;
          if (
            Math.abs(typeWord.cx - unitWord.cx) < 50 &&
            Math.abs(typeWord.cy - unitWord.cy) < 10
          ) {
            unitLabel = typeWord.text;
            break;
          }
        }
        break;
      }
    }

    const buildingId = roomWord.text.endsWith("A") ? "A" : "B";
    const roomType = unitLabel ? `UNIT ${unitLabel}` : "UNIT";

    usedIds.add(key);
    rooms.push({
      roomId: roomWord.text,
      roomType,
      buildingId,
      nx: roomWord.nx,
      ny: roomWord.ny,
      pageNumber: pageNum,
    });
  }

  // ── Service / support spaces ──────────────────────────────────────────────
  for (const svcWord of words) {
    if (!SERVICE_ID_RE.test(svcWord.text)) continue;
    const key = `${pageNum}:${svcWord.text}:${Math.round(svcWord.cx)}:${Math.round(svcWord.cy)}`;
    if (usedIds.has(key)) continue;

    const buildingId = svcWord.text.startsWith("A") ? "A" : "B";
    const roomType = SERVICE_LABEL_MAP[svcWord.text] ?? "SERVICE";

    usedIds.add(key);
    rooms.push({
      roomId: svcWord.text,
      roomType,
      buildingId,
      nx: svcWord.nx,
      ny: svcWord.ny,
      pageNumber: pageNum,
    });
  }

  return rooms;
}

// ── Public row type (compatible with InsertExtractedSign minus job IDs) ───────
export interface HeuristicSignInsert {
  sheetNumber: null;
  detailReference: null;
  signType: string;
  signIdentifier: string;
  quantity: number;
  location: string;
  dimensions: null;
  mountingType: null;
  finishColor: null;
  illumination: null;
  materials: null;
  messageContent: null;
  notes: string;
  pageNumber: number;
  xPos: number;
  yPos: number;
  placementSource: string;
  confidenceScore: number;
  reviewFlag: boolean;
  extractionMethod: string;
  rawJson: Record<string, unknown>;
}

// ── Main exported function ────────────────────────────────────────────────────

/**
 * Extract sign rows from a PDF using the heuristic algorithm.
 *
 * @param filePath  Absolute path to the PDF
 * @param fileId    Opaque string used as the pdfjs phrase-cache key (use job-file DB UUID)
 */
export async function extractSignsHeuristic(
  filePath: string,
  fileId: string,
): Promise<{ rows: HeuristicSignInsert[]; pageCount: number }> {
  const pageCount = await getPdfPageCount(filePath);

  const allRooms: ExtractedRoom[] = [];

  for (let pageNum = 1; pageNum <= pageCount; pageNum++) {
    try {
      const pw = await extractPagePhrases(filePath, fileId, pageNum);
      const words = phrasesToWords(pw);
      const rooms = extractRoomsFromWords(words, pageNum);
      allRooms.push(...rooms);
      logger.debug(
        { filePath: filePath.split("/").pop(), pageNum, wordsFound: words.length, roomsFound: rooms.length },
        "Heuristic page scan complete"
      );
    } catch (err) {
      logger.warn({ err, filePath: filePath.split("/").pop(), pageNum }, "Heuristic: page extraction failed, skipping");
    }
  }

  // Sort: building A before B, then by room ID
  allRooms.sort((a, b) =>
    a.buildingId !== b.buildingId
      ? a.buildingId.localeCompare(b.buildingId)
      : a.roomId.localeCompare(b.roomId)
  );

  const rows: HeuristicSignInsert[] = allRooms.map((room) => {
    const { signType, notes } = classifySign(room.roomId, room.roomType);
    return {
      sheetNumber: null,
      detailReference: null,
      signType,
      signIdentifier: room.roomId,
      quantity: 1,
      location: `${room.roomType} — Building ${room.buildingId}`,
      dimensions: null,
      mountingType: null,
      finishColor: null,
      illumination: null,
      materials: null,
      messageContent: null,
      notes,
      pageNumber: room.pageNumber,
      xPos: room.nx,
      yPos: room.ny,
      placementSource: "heuristic",
      confidenceScore: 0.9,
      reviewFlag: false,
      extractionMethod: "heuristic",
      rawJson: { roomId: room.roomId, roomType: room.roomType, buildingId: room.buildingId },
    };
  });

  logger.info(
    { filePath: filePath.split("/").pop(), pageCount, roomsFound: allRooms.length },
    "Heuristic extraction complete"
  );

  return { rows, pageCount };
}
