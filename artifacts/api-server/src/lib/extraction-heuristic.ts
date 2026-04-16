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
 * Accepted forms (digit group must be 101–999):
 *   - 3 digits only:                   101, 202, 999
 *   - 1 letter + 3 digits:             A101, Z999
 *   - 2 letters + 3 digits:            AB123
 *   - 2 letters + dash/dot + 3 digits: BS-123, BS.123, AB-123
 */
// Numeric portion: exactly 101–999 (excludes 000–100)
const _D3 = '(?:1(?:0[1-9]|[1-9]\\d)|[2-9]\\d{2})';
const ROOM_CODE_RE = new RegExp(
  `^(?:${_D3}|[A-Za-z]${_D3}|[A-Za-z]{2}[-.]?${_D3})$`
);

function isRoomCode(text: string): boolean {
  return ROOM_CODE_RE.test(text.trim());
}

/**
 * Noise-filter: returns true if the phrase should be skipped for anchor/companion matching.
 * Only rejects definitively non-room content:
 *   - Strings shorter than 2 characters
 *   - Strings longer than 17 characters (no real room label exceeds "DIRECTOR'S OFFICE")
 *   - Strings containing a colon (key-value structured data, never a room label)
 *   - Dimension strings containing foot/inch marks (e.g. 6'-8", 4")
 *   - Fractional dimensions (digit/digit, e.g. 1/4, 3/8)
 *   - Strings with zero alphanumeric characters
 *   - Area measurement strings (e.g. 217.75 sq ft, 100 sqft, 50 sf)
 *   - Strings starting with '(' — IBC occupancy codes, annotations (e.g. (A-3), (INCHES))
 *   - Strings with more ')' than '(' — fragments like CMU), OF STAIRS)
 *   - Strings containing '(EXISTING)' — existing-element labels, never a sign location
 *
 * IMPORTANT: slash-separated room labels like "UTL/JAN/RISER" must NOT be
 * filtered here — they are legitimate compound room labels.  Only filter
 * slashes when they are part of a dimension-style fraction (digit/digit).
 */
export function isNoisyPhrase(text: string): boolean {
  const t = text.trim();
  if (t.length < 2) return true;
  // Long strings are never room labels — no legitimate label exceeds "DIRECTOR'S OFFICE" (17 chars)
  if (t.length > 17) return true;
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
  // Copyright notices — any string containing the © symbol
  if (t.includes('©')) {
    logger.debug({ phrase: t }, 'isNoisyPhrase: rejected — contains © symbol');
    return true;
  }
  // Firm-name suffixes — strings ending with Inc./LLC./Corp./Ltd./Co. (with optional punctuation)
  // are copyright/attribution lines, never room labels.
  const lastWord = t.replace(/[.,!?]+$/, '').split(/\s+/).pop()?.toLowerCase() ?? '';
  if (['inc', 'llc', 'corp', 'ltd', 'co'].includes(lastWord)) {
    logger.debug({ phrase: t, lastWord }, 'isNoisyPhrase: rejected — firm-name suffix');
    return true;
  }
  // Parenthetical IBC occupancy codes and annotations — strings starting with '('
  // are always noise: (A-3), (B), (S-1), (INCHES), (ABOVE CEILING), etc.
  if (t.startsWith('(')) {
    logger.debug({ phrase: t }, 'isNoisyPhrase: rejected — starts with (');
    return true;
  }
  // Mismatched parentheses — more closing ')' than opening '(' indicates a fragment
  // cut from a larger annotation, e.g. "CMU)", "OF STAIRS)", "THICK CMU)"
  const openCount = (t.match(/\(/g) ?? []).length;
  const closeCount = (t.match(/\)/g) ?? []).length;
  if (closeCount > openCount) {
    logger.debug({ phrase: t, openCount, closeCount }, 'isNoisyPhrase: rejected — mismatched parentheses');
    return true;
  }
  // Existing-element labels — never a sign location
  if (/\(EXISTING\)/i.test(t)) {
    logger.debug({ phrase: t }, 'isNoisyPhrase: rejected — contains (EXISTING)');
    return true;
  }
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
 * Proximity threshold (normalised page units) for title-word exclusion.
 * A hit whose centroid is within this radius of any detected title-phrase
 * centroid is excluded as being part of the title block.
 * ~9 % of page dimensions is roughly 65 pts on a typical A1 sheet.
 */
const TITLE_PROXIMITY_THRESHOLD = 0.09;

/**
 * Stable record key for deduplication / claimed-anchor tracking.
 */
function phraseKey(r: PhraseRecord): string {
  return `${r.text.toLowerCase().trim()}:${Math.round(r.cx_pts / 10)}:${Math.round(r.cy_pts / 10)}`;
}

/**
 * Extract institutional/church room sign pairs from floor plan pages using
 * code-first spatial proximity matching.
 *
 * Strategy (revised):
 * 1. Work at the phrase level (not individual words) to preserve multi-word labels.
 * 2. Apply drawing-area filter: exclude hits spatially close to the detected floor
 *    plan title words.  Falls back to a blanket zone exclusion when no title phrase
 *    coordinates are available.
 * 3. Pass 1 — code-first: for each room code phrase, search for the nearest
 *    non-code usable phrase (the anchor) within the proximity window (≤80 pts
 *    horizontal, ≤90 pts vertical).  If an anchor is found → emit the pair with
 *    the code as signIdentifier and the anchor text as location.  If no anchor is
 *    found nearby → discard the code entirely (it is a direction/wayfinding callout,
 *    not a room sign).
 * 4. Pass 2 — anchor fallback: for every non-code usable phrase NOT claimed as an
 *    anchor in Pass 1, apply the original vocabulary / exception logic and emit a
 *    row using the anchor text as the signIdentifier.  This preserves rooms labeled
 *    by name only (e.g. "OFFICE" with no number).
 * 5. Page-wide deduplication: collect all rows from both passes and deduplicate by
 *    signIdentifier, keeping the row with the higher confidenceScore.
 *
 * @param titlePhrases  Phrases from the title-block zone that matched during
 *                      classification.  When provided (non-empty), exclusion is
 *                      proximity-based.  When empty, falls back to the legacy
 *                      blanket zone exclusion.
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
   * (nx > 0.65 AND ny > 0.65).
   */
  function isInTitleZone(r: PhraseRecord): boolean {
    if (titleCentroids.length > 0) {
      return titleCentroids.some(
        (tc) =>
          Math.sqrt((r.nx - tc.nx) ** 2 + (r.ny - tc.ny) ** 2) <
          TITLE_PROXIMITY_THRESHOLD,
      );
    }
    return r.ny >= 0.85 || (r.nx > 0.65 && r.ny > 0.65);
  }

  const drawingArea = records.filter((r) => !isInTitleZone(r));

  // Room-code phrases: all drawing-area phrases that look like room codes.
  const roomCodePhrases = drawingArea.filter((r) => isRoomCode(r.text));

  // Usable phrases: drawing-area phrases that pass the noise filter.
  const usable = drawingArea.filter((r) => !isNoisyPhrase(r.text));

  // Anchor candidates: usable phrases that are NOT themselves room codes.
  // These are the only phrases that can serve as location anchors.
  const anchorCandidates = usable.filter((r) => !isRoomCode(r.text));

  /**
   * For a given room code, find the nearest anchor candidate within the
   * proximity window (≤80 pts horizontal, ≤90 pts vertical).
   * Returns the closest candidate or null if none found.
   */
  function findNearestAnchor(code: PhraseRecord): PhraseRecord | null {
    let best: { rec: PhraseRecord; dist: number } | null = null;
    for (const candidate of anchorCandidates) {
      const dx = Math.abs(candidate.cx_pts - code.cx_pts);
      const dy = Math.abs(candidate.cy_pts - code.cy_pts);
      if (dx > 80 || dy > 90) continue;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (best === null || dist < best.dist) {
        best = { rec: candidate, dist };
      }
    }
    return best?.rec ?? null;
  }

  const rows: HeuristicSignInsert[] = [];

  // Track which anchor candidates were claimed in Pass 1.
  const claimedAnchorKeys = new Set<string>();

  // ── Pass 1: code-first matching ─────────────────────────────────────────────
  // Primary key is the room code.  Each code must have a nearby anchor phrase to
  // be emitted.  Codes with no nearby anchor are silently discarded (they are
  // direction/wayfinding callouts, not room signs).
  for (const code of roomCodePhrases) {
    const anchor = findNearestAnchor(code);
    if (!anchor) {
      logger.debug(
        { pageNum, code: code.text },
        "Code-first: no nearby anchor found — discarding code",
      );
      continue;
    }

    // Mark anchor as claimed so Pass 2 skips it.
    claimedAnchorKeys.add(phraseKey(anchor));

    // Gate: anchor must have at least one alphabetic character.
    const alphaCount = (anchor.text.match(/[a-zA-Z]/g) || []).length;
    if (alphaCount < 1) continue;

    // Gate: anchor must not be a code-only string (e.g. architectural callout "A302").
    if (isCodeOnlyLocation(anchor.text)) continue;

    const anchorSignType = lookupRoomLabelMap(anchor.text, labelMap);

    if (anchorSignType) {
      rows.push({
        sheetNumber: null,
        detailReference: null,
        signType: anchorSignType,
        signIdentifier: code.text,
        quantity: 1,
        location: anchor.text,
        dimensions: null,
        mountingType: null,
        finishColor: null,
        illumination: null,
        materials: null,
        messageContent: null,
        notes: "Institutional room label (spatial proximity)",
        pageNumber: pageNum,
        xPos: code.nx,
        yPos: code.ny,
        placementSource: "heuristic",
        confidenceScore: 0.6,
        reviewFlag: true,
        extractionMethod: "heuristic",
        rawJson: { anchorText: anchor.text, codeText: code.text },
      });
    } else {
      // Non-vocabulary anchor near a valid code → flagged for review.
      rows.push({
        sheetNumber: null,
        detailReference: null,
        signType: "ROOM ID SIGN",
        signIdentifier: code.text,
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
        xPos: code.nx,
        yPos: code.ny,
        placementSource: "heuristic",
        confidenceScore: 0.3,
        reviewFlag: true,
        exceptionReason: "not in vocabulary",
        extractionMethod: "heuristic",
        rawJson: { anchorText: anchor.text, codeText: code.text, exception: true },
      });
    }
  }

  // ── Pass 2: anchor fallback for code-less rooms ─────────────────────────────
  // For every anchor candidate that was NOT claimed by a room code in Pass 1,
  // apply the vocabulary / exception logic.  The anchor text is used as the
  // signIdentifier (current fallback behavior for name-only rooms like "OFFICE").
  for (const anchor of anchorCandidates) {
    if (claimedAnchorKeys.has(phraseKey(anchor))) continue;

    // Gate: require at least one alphabetic character.
    const alphaCount = (anchor.text.match(/[a-zA-Z]/g) || []).length;
    if (alphaCount < 1) continue;

    // Gate: suppress code-only anchors (architectural callout codes).
    if (isCodeOnlyLocation(anchor.text)) continue;

    const anchorSignType = lookupRoomLabelMap(anchor.text, labelMap);
    const signIdentifier = anchor.text.toUpperCase().replace(/\s+/g, "_").slice(0, 40);

    if (anchorSignType) {
      rows.push({
        sheetNumber: null,
        detailReference: null,
        signType: anchorSignType,
        signIdentifier,
        quantity: 1,
        location: anchor.text,
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
        rawJson: { anchorText: anchor.text, codeText: null },
      });
    } else {
      // Exception path: not in vocabulary but passed all gates.
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
        rawJson: { anchorText: anchor.text, codeText: null, exception: true },
      });
    }
  }

  // ── Page-wide identifier deduplication ─────────────────────────────────────
  // When two rows share the same signIdentifier, keep the one with the higher
  // confidenceScore (vocabulary match at 0.6 beats exception at 0.3).
  const deduped = new Map<string, HeuristicSignInsert>();
  for (const row of rows) {
    const existing = deduped.get(row.signIdentifier);
    if (!existing) {
      deduped.set(row.signIdentifier, row);
    } else if (row.confidenceScore > existing.confidenceScore) {
      logger.debug(
        { pageNum, signIdentifier: row.signIdentifier, kept: row.confidenceScore, discarded: existing.confidenceScore },
        "Dedup: replaced lower-confidence duplicate identifier",
      );
      deduped.set(row.signIdentifier, row);
    } else {
      logger.debug(
        { pageNum, signIdentifier: row.signIdentifier },
        "Dedup: discarded duplicate identifier (lower or equal confidence)",
      );
    }
  }

  return Array.from(deduped.values());
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
