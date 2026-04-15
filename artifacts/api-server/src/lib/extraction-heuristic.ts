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

import { extractPagePhrases, getPdfPageCount, classifyPageFromPhrases, type PdfPhrase } from "./pdf-words";
import { getRoomLabelMap, isCodeOnlyLocation, type CanonicalBuildingType } from "./sign-vocabulary";
import { logger } from "./logger";

// Module-level effective map — updated at the start of each extraction run
// so that vocabulary-overrides.json changes are picked up without a server restart.

// ── Regex patterns (ported from Python) ──────────────────────────────────────
// Residential room numbers: 423A, 400B, etc.
const ROOM_NUM_RE = /^[0-9]{3}[AB]$/;
// Unit type labels: 1A, 1B, 2A, 2B, 3A, 3B
const UNIT_TYPE_RE = /^[123][AB]$/;

// ── Sign type classifier (ported from Python classify_sign) ──────────────────
interface SignClassification {
  signType: string;
  notes: string;
}

function classifySign(roomId: string, roomType: string, labelMap: Record<string, string>): SignClassification {
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

  // Stairwell: check roomId prefix pattern before label map lookup
  if (/^[AB]S/.test(rid)) {
    return { signType: "STAIRWELL SIGN", notes: "Egress Sign" };
  }

  // Use building-type-aware label map for all other sign type classification.
  // Check each token of the room type string against the map.
  const tokens = rt.toLowerCase().split(/\s+/);
  for (const token of tokens) {
    const signType = labelMap[token];
    if (signType) return { signType, notes: "Room ID Sign" };
  }

  // Multi-word label lookup (join consecutive token pairs to match e.g. "art room")
  for (let i = 0; i < tokens.length - 1; i++) {
    const pair = `${tokens[i]} ${tokens[i + 1]}`;
    const signType = labelMap[pair];
    if (signType) return { signType, notes: "Room ID Sign" };
  }

  // Legacy special cases not covered by label map tokens.
  if (rt.includes("ELEV EQUIP"))  return { signType: "ELEV EQUIPMENT SIGN",  notes: "Elevator ID Sign" };
  if (rt.includes("TENANT STOR")) return { signType: "TENANT STORAGE SIGN",  notes: "Room ID Sign" };

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
    let foundUnitWord: Word | null = null;
    let foundTypeWord: Word | null = null;

    // Look for a nearby "UNIT" label (within 40 pts horizontal, 30 pts vertical)
    for (const unitWord of words) {
      if (unitWord.text !== "UNIT") continue;
      if (Math.abs(unitWord.cx - rx) < 40 && Math.abs(unitWord.cy - ry) < 30) {
        foundUnitWord = unitWord;
        // Found "UNIT" — now find the type label (1A, 2B, …) near the "UNIT" word
        for (const typeWord of words) {
          if (!UNIT_TYPE_RE.test(typeWord.text)) continue;
          if (
            Math.abs(typeWord.cx - unitWord.cx) < 50 &&
            Math.abs(typeWord.cy - unitWord.cy) < 10
          ) {
            foundTypeWord = typeWord;
            break;
          }
        }
        break;
      }
    }

    const buildingId = roomWord.text.endsWith("A") ? "A" : "B";
    let roomType: string;
    if (foundUnitWord && foundTypeWord) {
      // Join in reading order: stacked (dy > dx) → top-to-bottom; side-by-side → left-to-right
      const udx = Math.abs(foundTypeWord.cx - foundUnitWord.cx);
      const udy = Math.abs(foundTypeWord.cy - foundUnitWord.cy);
      let first: Word;
      let second: Word;
      if (udy > udx) {
        [first, second] = foundUnitWord.cy <= foundTypeWord.cy
          ? [foundUnitWord, foundTypeWord]
          : [foundTypeWord, foundUnitWord];
      } else {
        [first, second] = foundUnitWord.cx <= foundTypeWord.cx
          ? [foundUnitWord, foundTypeWord]
          : [foundTypeWord, foundUnitWord];
      }
      roomType = `${first.text} ${second.text}`;
    } else {
      roomType = "UNIT";
    }

    // Guard: skip if the room-type label itself is code-only (defense-in-depth)
    if (isCodeOnlyLocation(roomType)) continue;

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

  return rooms;
}

// ── Institutional/church floor plan room-pair extraction ──────────────────────

/**
 * Phrase record with position in pts for spatial proximity checks.
 */
interface PhraseRecord {
  text: string;
  cx_pts: number;   // center x in pts
  cy_pts: number;   // center y in pts
  nx: number;       // normalized x
  ny: number;       // normalized y
}

/**
 * Returns true if the phrase looks like a floor-plan room code:
 * 2–4 consecutive digits (e.g. "101", "1042", "23").
 * These are NOT noise — they are sign identifiers that sit beneath room labels.
 */
function isRoomCode(text: string): boolean {
  return /^\d{2,4}$/.test(text.trim());
}

/**
 * Noise-filter: returns true if the phrase should be skipped for anchor/companion matching.
 * Skips: purely numeric (handled separately as room codes), drawing-reference codes like A123,
 * dimension strings, or phrases shorter than 2 characters.
 *
 * IMPORTANT: slash-separated room labels like "UTL/JAN/RISER" must NOT be
 * filtered here — they are legitimate compound room labels.  Only filter
 * slashes when they are part of a dimension-style fraction (digit/digit).
 */
function isNoisyPhrase(text: string): boolean {
  const t = text.trim();
  if (t.length < 2) return true;
  // Purely numeric — skip here; room codes are handled via isRoomCode() separately
  if (/^[0-9]+$/.test(t)) return true;
  // Drawing reference code: single uppercase letter + 2-3 digits (e.g. A123)
  if (/^[A-Z][0-9]{2,3}$/.test(t)) return true;
  // Dimension strings: foot/inch marks after digits (e.g. 6'-8", 4")
  if (/[0-9]['"]/.test(t)) return true;
  // Fractional dimension: digit/digit (e.g. 1/4, 3/8, 1/2)
  if (/[0-9]\/[0-9]/.test(t)) return true;
  // Bare number with optional units (e.g. "12.5 sf", "100")
  if (/^[0-9]+(\.?[0-9]*)?(\s*[a-z]{0,3})?$/i.test(t) && /[0-9]/.test(t)) return true;
  return false;
}

/**
 * Look up sign type from the provided label map by checking each token in the phrase.
 * Splits on both whitespace AND slash so that compound room labels like
 * "UTL/JAN/RISER" or "STOR/MECH" are decomposed and each part is looked up.
 * Also checks consecutive whitespace-token pairs for multi-word labels ("art room").
 * Returns the first matching sign type string, or null if no token matches.
 */
function lookupRoomLabelMap(text: string, labelMap: Record<string, string>): string | null {
  // Split on whitespace AND slash to handle compound labels like "UTL/JAN/RISER"
  const tokens = text.toLowerCase().trim().split(/[\s/]+/);

  // Single-token lookup (handles both whitespace-split and slash-split tokens)
  for (const token of tokens) {
    const clean = token.replace(/[^a-z']/g, "");
    if (clean && labelMap[clean]) return labelMap[clean]!;
    if (token && labelMap[token]) return labelMap[token]!;
  }

  // Multi-word (two-token) lookup — only for whitespace-adjacent tokens
  const wsTokens = text.toLowerCase().trim().split(/\s+/);
  for (let i = 0; i < wsTokens.length - 1; i++) {
    const pair = `${wsTokens[i]!.replace(/[^a-z']/g, "")} ${wsTokens[i + 1]!.replace(/[^a-z']/g, "")}`;
    if (labelMap[pair]) return labelMap[pair]!;
  }
  return null;
}

/**
 * Return true if the phrase is a useful companion (not a match in ROOM_LABEL_MAP itself
 * but contains enough alphabetic characters to be a room name label).
 */
function isValidCompanion(text: string): boolean {
  const alphaCount = (text.match(/[a-zA-Z]/g) || []).length;
  return alphaCount >= 3;
}

/**
 * Proximity threshold (normalised page units) for title-word exclusion.
 * A hit whose centroid is within this radius of any detected title-phrase
 * centroid is excluded as being part of the title block.
 * ~9 % of page dimensions is roughly 65 pts on a typical A1 sheet.
 */
const TITLE_PROXIMITY_THRESHOLD = 0.09;

/**
 * Extract institutional/church room sign pairs from floor plan pages using
 * spatial proximity matching.
 *
 * Strategy:
 * 1. Work at the phrase level (not individual words) to preserve multi-word labels.
 * 2. Apply drawing-area filter: exclude hits that are spatially close to the
 *    detected floor plan title words (titlePhrases).  Falls back to a blanket
 *    zone exclusion when no title phrase coordinates are available.
 * 3. For each phrase whose token(s) match the label map (anchor), search for a
 *    companion phrase within the proximity window.
 * 4. Combine anchor + companion into one sign row, or emit anchor alone.
 *
 * @param titlePhrases  Phrases from the title-block zone that matched during
 *                      classification.  When provided (non-empty), exclusion is
 *                      proximity-based: only hits within TITLE_PROXIMITY_THRESHOLD
 *                      of a title phrase are dropped.  When empty, falls back to
 *                      the legacy blanket zone exclusion.
 * @param labelMap      Building-type-aware room label map from getRoomLabelMap().
 */
function extractInstitutionalRoomsFromPhrases(
  pw: { pageWidth: number; pageHeight: number; phrases: Array<{ text: string; x0: number; y0: number; x1: number; y1: number }> },
  pageNum: number,
  titlePhrases?: PdfPhrase[],
  labelMap: Record<string, string> = getRoomLabelMap(),
): HeuristicSignInsert[] {
  const { pageWidth, pageHeight, phrases } = pw;

  // Build phrase records with pts coordinates.
  const records: PhraseRecord[] = phrases.map((p) => ({
    text: p.text.trim(),
    cx_pts: ((p.x0 + p.x1) / 2) * pageWidth,
    cy_pts: ((p.y0 + p.y1) / 2) * pageHeight,
    nx: (p.x0 + p.x1) / 2,
    ny: (p.y0 + p.y1) / 2,
  }));

  // Pre-compute title-word centroids (normalised) for proximity checks.
  const titleCentroids: Array<{ nx: number; ny: number }> =
    (titlePhrases ?? []).map((p) => ({
      nx: (p.x0 + p.x1) / 2,
      ny: (p.y0 + p.y1) / 2,
    }));

  /**
   * Returns true if a record should be excluded from the drawing area.
   *
   * When title centroid coordinates are available: exclude only if the record's
   * centroid is within TITLE_PROXIMITY_THRESHOLD of any title centroid.
   *
   * Fallback (no title centroids): apply the legacy blanket zone filter —
   * exclude the bottom strip (ny >= 0.85) OR the bottom-right quadrant
   * (nx > 0.65 AND ny > 0.65).  This is identical to the original filter
   * (cy_norm < 0.85 AND NOT (cx_norm > 0.65 AND cy_norm > 0.65)) and
   * does NOT add any right-strip blanket exclusion.
   */
  function isInTitleZone(r: PhraseRecord): boolean {
    if (titleCentroids.length > 0) {
      return titleCentroids.some(
        (tc) =>
          Math.sqrt((r.nx - tc.nx) ** 2 + (r.ny - tc.ny) ** 2) <
          TITLE_PROXIMITY_THRESHOLD,
      );
    }
    // Fallback: exact legacy blanket zone — bottom strip (ny >= 0.85) OR
    // bottom-right quadrant (nx > 0.65 AND ny > 0.65).
    // Matches the original filter: cy_norm < 0.85 AND NOT (cx_norm > 0.65 AND cy_norm > 0.65).
    return r.ny >= 0.85 || (r.nx > 0.65 && r.ny > 0.65);
  }

  const drawingArea = records.filter((r) => !isInTitleZone(r));

  // Collect numeric room-code phrases separately (2–4 digits).
  // These are filtered from `usable` by isNoisyPhrase but are valid sign identifiers.
  const roomCodePhrases = drawingArea.filter((r) => isRoomCode(r.text));

  // Apply noise filter for anchor/companion matching.
  const usable = drawingArea.filter((r) => !isNoisyPhrase(r.text));

  /**
   * For a given anchor, find the closest numeric room code within the
   * proximity window (≤80 pts horizontal, ≤60 pts vertical).
   * Returns the code string or null if none found nearby.
   */
  function findNearbyRoomCode(anchor: PhraseRecord): string | null {
    let best: { code: string; dist: number } | null = null;
    for (const rc of roomCodePhrases) {
      const dx = Math.abs(rc.cx_pts - anchor.cx_pts);
      const dy = Math.abs(rc.cy_pts - anchor.cy_pts);
      if (dx > 80 || dy > 60) continue;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (best === null || dist < best.dist) {
        best = { code: rc.text, dist };
      }
    }
    return best?.code ?? null;
  }

  const rows: HeuristicSignInsert[] = [];
  const usedKeys = new Set<string>(); // deduplicate by normalized text + grid-rounded position

  for (let i = 0; i < usable.length; i++) {
    const anchor = usable[i]!;

    // Step A: check if this phrase is an anchor (matches label map).
    const anchorSignType = lookupRoomLabelMap(anchor.text, labelMap);
    if (!anchorSignType) continue;

    const dedupeKey = `${anchor.text.toLowerCase().trim()}:${Math.round(anchor.cx_pts / 10)}:${Math.round(anchor.cy_pts / 10)}`;
    if (usedKeys.has(dedupeKey)) continue;

    // Step B: companion scan — search for a nearby phrase.
    let bestCompanion: PhraseRecord | null = null;
    let bestCompanionSignType: string | null = null;

    for (let j = 0; j < usable.length; j++) {
      if (i === j) continue;
      const candidate = usable[j]!;
      const dx = Math.abs(candidate.cx_pts - anchor.cx_pts);
      const dy = Math.abs(candidate.cy_pts - anchor.cy_pts);

      // Proximity window: stacked vertically or side by side
      const isStacked = dy < 40 && dx < 80;
      const isSideBySide = dy < 15 && dx < 200;
      if (!isStacked && !isSideBySide) continue;

      // Check companion quality
      const companionSignType = lookupRoomLabelMap(candidate.text, labelMap);
      if (companionSignType || isValidCompanion(candidate.text)) {
        bestCompanion = candidate;
        bestCompanionSignType = companionSignType;
        break;
      }
    }

    // Step C: pair or standalone
    let finalSignType: string;
    let locationLabel: string;

    if (bestCompanion) {
      finalSignType = bestCompanionSignType ?? anchorSignType;
      // Join in reading order: stacked (dy > dx) → top-to-bottom; side-by-side → left-to-right
      const jdx = Math.abs(bestCompanion.cx_pts - anchor.cx_pts);
      const jdy = Math.abs(bestCompanion.cy_pts - anchor.cy_pts);
      let first: PhraseRecord;
      let second: PhraseRecord;
      if (jdy > jdx) {
        // Stacked: order by cy_pts (top first — smaller cy = higher on page)
        [first, second] = anchor.cy_pts <= bestCompanion.cy_pts
          ? [anchor, bestCompanion]
          : [bestCompanion, anchor];
      } else {
        // Side by side: order by cx_pts (left first)
        [first, second] = anchor.cx_pts <= bestCompanion.cx_pts
          ? [anchor, bestCompanion]
          : [bestCompanion, anchor];
      }
      locationLabel = `${first.text} ${second.text}`;

      // Mark companion as used too
      const companionKey = `${bestCompanion.text.toLowerCase().trim()}:${Math.round(bestCompanion.cx_pts / 10)}:${Math.round(bestCompanion.cy_pts / 10)}`;
      usedKeys.add(companionKey);
    } else {
      finalSignType = anchorSignType;
      locationLabel = anchor.text;
    }

    // Guard: discard entries whose location label contains no real room-name word.
    // This prevents bare drawing-reference codes like "A103" from becoming sign entries.
    if (isCodeOnlyLocation(locationLabel)) continue;

    // Step D: find the numeric room code sitting near this anchor (e.g. "101" under "OFFICE").
    // If found, use it as the sign identifier; fall back to a cleaned slug of the label.
    const nearbyCode = findNearbyRoomCode(anchor);
    const signIdentifier = nearbyCode ?? anchor.text.toUpperCase().replace(/\s+/g, "_").slice(0, 40);

    usedKeys.add(dedupeKey);

    rows.push({
      sheetNumber: null,
      detailReference: null,
      signType: finalSignType,
      signIdentifier,
      quantity: 1,
      location: locationLabel,
      dimensions: null,
      mountingType: null,
      finishColor: null,
      illumination: null,
      materials: null,
      messageContent: null,
      notes: "Institutional room label (spatial proximity)",
      pageNumber: pageNum,
      xPos: anchor.nx,
      yPos: anchor.ny,
      placementSource: "heuristic",
      confidenceScore: 0.6,
      reviewFlag: true,
      extractionMethod: "heuristic",
      rawJson: { anchorText: anchor.text, companionText: bestCompanion?.text ?? null },
    });
  }

  return rows;
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
 * @param filePath         Absolute path to the PDF
 * @param fileId           Opaque string used as the pdfjs phrase-cache key (use job-file DB UUID)
 * @param floorPlanPages   Optional set of page numbers classified as floor plans;
 *                         when provided, institutional room-pair extraction is run on those pages.
 * @param buildingType     Optional canonical building type for building-type-aware vocabulary.
 *                         When provided, `getRoomLabelMap(buildingType)` is used instead of the
 *                         generic map, improving classification for institutional / hospitality /
 *                         educational buildings.
 */
export async function extractSignsHeuristic(
  filePath: string,
  fileId: string,
  floorPlanPages?: Set<number>,
  buildingType?: CanonicalBuildingType | string | null,
): Promise<{ rows: HeuristicSignInsert[]; pageCount: number }> {

  const pageCount = await getPdfPageCount(filePath);

  // Build the label map once for the entire extraction run.
  const labelMap = getRoomLabelMap(buildingType);

  const pageResults = await Promise.all(
    Array.from({ length: pageCount }, (_, i) => i + 1).map(async (pageNum) => {
      try {
        const pw = await extractPagePhrases(filePath, fileId, pageNum);
        const words = phrasesToWords(pw);
        const rooms = extractRoomsFromWords(words, pageNum);

        let instRows: HeuristicSignInsert[] = [];
        if (floorPlanPages && floorPlanPages.has(pageNum)) {
          const { titlePhrases } = classifyPageFromPhrases(pw.phrases);
          instRows = extractInstitutionalRoomsFromPhrases(pw, pageNum, titlePhrases, labelMap);
        }

        logger.debug(
          { filePath: filePath.split("/").pop(), pageNum, wordsFound: words.length, roomsFound: rooms.length, institutionalFound: instRows.length },
          "Heuristic page scan complete"
        );
        return { rooms, instRows };
      } catch (err) {
        logger.warn({ err, filePath: filePath.split("/").pop(), pageNum }, "Heuristic: page extraction failed, skipping");
        return { rooms: [] as ExtractedRoom[], instRows: [] as HeuristicSignInsert[] };
      }
    })
  );

  const allRooms: ExtractedRoom[] = pageResults.flatMap((r) => r.rooms);
  const institutionalRows: HeuristicSignInsert[] = pageResults.flatMap((r) => r.instRows);

  // Sort: building A before B, then by room ID
  allRooms.sort((a, b) =>
    a.buildingId !== b.buildingId
      ? a.buildingId.localeCompare(b.buildingId)
      : a.roomId.localeCompare(b.roomId)
  );

  const rows: HeuristicSignInsert[] = allRooms.map((room) => {
    const { signType, notes } = classifySign(room.roomId, room.roomType, labelMap);
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

  // Combine residential + institutional rows
  const allRows = [...rows, ...institutionalRows];

  logger.info(
    { filePath: filePath.split("/").pop(), pageCount, roomsFound: allRooms.length, institutionalFound: institutionalRows.length },
    "Heuristic extraction complete"
  );

  return { rows: allRows, pageCount };
}
