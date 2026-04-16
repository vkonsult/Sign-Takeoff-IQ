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
// (Residential unit detection removed — residential floor plan text flows through the
//  general institutional extraction path like any other building type.)


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
 * Returns true if the phrase looks like a floor-plan room code.
 * Accepts any compact alphanumeric identifier (up to ~20 chars) that:
 *   - Contains at least one digit
 *   - Contains only letters, digits, hyphens, dots, or spaces
 *   - Is not a dimension string (no foot/inch marks)
 *   - Is not a pure fraction (digit/digit)
 *
 * Covers: 101, A101, C300, A306, BS2-3, AS1-3, 1.2A, B-101, S2-3, etc.
 */
function isRoomCode(text: string): boolean {
  const t = text.trim();
  if (t.length === 0 || t.length > 20) return false;
  // Must contain at least one digit
  if (!/[0-9]/.test(t)) return false;
  // Must only contain letters, digits, hyphens, dots, or spaces
  if (!/^[A-Za-z0-9\-.\s]+$/.test(t)) return false;
  // Reject dimension strings (foot/inch marks after digits)
  if (/[0-9]['"]/.test(t)) return false;
  // Reject pure fractions (digit/digit)
  if (/[0-9]\/[0-9]/.test(t)) return false;
  return true;
}

/**
 * Noise-filter: returns true if the phrase should be skipped for anchor/companion matching.
 * Only rejects definitively non-room content:
 *   - Strings shorter than 2 characters
 *   - Strings longer than 50 characters (annotations, legends, data fields)
 *   - Strings containing a colon (key-value structured data, never a room label)
 *   - Dimension strings containing foot/inch marks (e.g. 6'-8", 4")
 *   - Fractional dimensions (digit/digit, e.g. 1/4, 3/8)
 *   - Strings with zero alphanumeric characters
 *   - Area measurement strings (e.g. 217.75 sq ft, 100 sqft, 50 sf)
 *
 * IMPORTANT: slash-separated room labels like "UTL/JAN/RISER" must NOT be
 * filtered here — they are legitimate compound room labels.  Only filter
 * slashes when they are part of a dimension-style fraction (digit/digit).
 */
function isNoisyPhrase(text: string): boolean {
  const t = text.trim();
  if (t.length < 2) return true;
  // Long strings are never room labels — always annotations, legends, or data fields
  if (t.length > 50) return true;
  // Colon indicates key-value structured data, never a room label
  if (t.includes(':')) return true;
  // Dimension strings: foot/inch marks after digits (e.g. 6'-8", 4")
  if (/[0-9]['"]/.test(t)) return true;
  // Fractional dimension: digit/digit (e.g. 1/4, 3/8, 1/2)
  if (/[0-9]\/[0-9]/.test(t)) return true;
  // Strings with zero alphanumeric characters (pure symbols like "#@!")
  if (!/[A-Za-z0-9]/.test(t)) return true;
  // Area measurement strings (e.g. 217.75 sq ft, 100 sqft, 50 sf, 200 square feet)
  if (/[0-9]\s*(?:sq\.?\s*ft\.?|sqft|sf|square\s+f(?:eet|oot))/i.test(t)) return true;
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
 * but contains at least one alphabetic character or is a room code identifier).
 * Threshold is ≥1 alpha so that two-letter prefix codes like BS2-3 and AS1-3 qualify.
 */
function isValidCompanion(text: string): boolean {
  const alphaCount = (text.match(/[a-zA-Z]/g) || []).length;
  return alphaCount >= 1 || isRoomCode(text);
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
   * proximity window (≤80 pts horizontal, ≤90 pts vertical).
   * Returns the code string or null if none found nearby.
   */
  function findNearbyRoomCode(anchor: PhraseRecord): string | null {
    let best: { code: string; dist: number } | null = null;
    for (const rc of roomCodePhrases) {
      const dx = Math.abs(rc.cx_pts - anchor.cx_pts);
      const dy = Math.abs(rc.cy_pts - anchor.cy_pts);
      if (dx > 80 || dy > 90) continue;
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

    const dedupeKey = `${anchor.text.toLowerCase().trim()}:${Math.round(anchor.cx_pts / 10)}:${Math.round(anchor.cy_pts / 10)}`;
    if (usedKeys.has(dedupeKey)) continue;

    // Step A: check if this phrase is an anchor (matches label map).
    const anchorSignType = lookupRoomLabelMap(anchor.text, labelMap);

    if (!anchorSignType) {
      // Stage 6 exception: phrase is not in vocabulary but passed noise filter.
      // Capture it with reviewFlag so nothing is silently dropped.
      // Require at least 1 alphabetic character — only zero-alpha tokens (pure symbols
      // like "#5", "@2") are hard-dropped here; everything else becomes an exception row.
      const alphaCount = (anchor.text.match(/[a-zA-Z]/g) || []).length;
      if (alphaCount < 1) continue;

      // Suppress architectural drawing callout codes (e.g. A302, A503, A413) and other
      // code-only tokens.  These are cross-reference identifiers on section/elevation
      // callout bubbles, not room labels, and should never become sign markers.
      // isCodeOnlyLocation returns true when every token in the string is a code pattern
      // (pure digits, letter+digit combos, or short all-caps without vowels) and no
      // token qualifies as a real room-name word (length ≥ 3 with at least one vowel).
      if (isCodeOnlyLocation(anchor.text)) continue;

      const nearbyCode = findNearbyRoomCode(anchor);
      const signIdentifier = nearbyCode ?? anchor.text.toUpperCase().replace(/\s+/g, "_").slice(0, 40);
      usedKeys.add(dedupeKey);
      rows.push({
        sheetNumber: null,
        detailReference: null,
        signType: "ROOM ID SIGN",
        signIdentifier,
        quantity: 1,
        location: anchor.text,
        dimensions: null,
        mountingType: null,
        finishColor: null,
        illumination: null,
        materials: null,
        messageContent: null,
        notes: "Exception: not in vocabulary",
        pageNumber: pageNum,
        xPos: anchor.nx,
        yPos: anchor.ny,
        placementSource: "heuristic",
        confidenceScore: 0.3,
        reviewFlag: true,
        exceptionReason: "not in vocabulary",
        extractionMethod: "heuristic",
        rawJson: { anchorText: anchor.text, companionText: null, exception: true },
      });
      continue;
    }

    // Step B: companion scan — search for a nearby phrase.
    let bestCompanion: PhraseRecord | null = null;
    let bestCompanionSignType: string | null = null;

    for (let j = 0; j < usable.length; j++) {
      if (i === j) continue;
      const candidate = usable[j]!;
      const dx = Math.abs(candidate.cx_pts - anchor.cx_pts);
      const dy = Math.abs(candidate.cy_pts - anchor.cy_pts);

      // Proximity window: stacked vertically (widened) or side by side (widened tolerance)
      const isStacked = dy < 65 && dx < 120;
      const isSideBySide = dy < 25 && dx < 200;
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

    // Stage 8 exception: location label has no qualifying real-word token.
    // Instead of discarding, emit with reviewFlag so the entry is reviewable.
    if (isCodeOnlyLocation(locationLabel)) {
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
        notes: "Exception: no qualifying word in location",
        pageNumber: pageNum,
        xPos: anchor.nx,
        yPos: anchor.ny,
        placementSource: "heuristic",
        confidenceScore: 0.3,
        reviewFlag: true,
        exceptionReason: "no qualifying word",
        extractionMethod: "heuristic",
        rawJson: { anchorText: anchor.text, companionText: bestCompanion?.text ?? null, exception: true },
      });
      continue;
    }

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
  exceptionReason?: string | null;
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

        let instRows: HeuristicSignInsert[] = [];
        if (floorPlanPages && floorPlanPages.has(pageNum)) {
          const { titlePhrases } = classifyPageFromPhrases(pw.phrases);
          instRows = extractInstitutionalRoomsFromPhrases(pw, pageNum, titlePhrases, labelMap);
        }

        logger.debug(
          { filePath: filePath.split("/").pop(), pageNum, institutionalFound: instRows.length },
          "Heuristic page scan complete"
        );
        return instRows;
      } catch (err) {
        logger.warn({ err, filePath: filePath.split("/").pop(), pageNum }, "Heuristic: page extraction failed, skipping");
        return [] as HeuristicSignInsert[];
      }
    })
  );

  const allRows: HeuristicSignInsert[] = pageResults.flat();

  logger.info(
    { filePath: filePath.split("/").pop(), pageCount, rowsFound: allRows.length },
    "Heuristic extraction complete"
  );

  return { rows: allRows, pageCount };
}
