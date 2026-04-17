/**
 * Sheet Manifest — Phase 2 of the SignTakeoff IQ pipeline.
 *
 * Replaces the legacy 3-bucket spatial pre-pass (floor_plan / sign_schedule / other)
 * with a 10-bucket cascade that correctly identifies every sheet type needed for
 * a complete sign takeoff.
 *
 * Cascade order:
 *   A. PDF bookmarks (primary — most reliable)
 *   B.0 Drawing index table scan (pages 1–5): if a printed sheet index is found,
 *       classifies all sheets in one pass and fills gaps per-page scraping misses.
 *   B. Title block scrape: 3-pass zone widening per page
 *       Pass 1 — narrow title strip (cy > 0.90)
 *       Pass 2 — full title-block corner zone
 *       Pass 3 — full-page scan (excerpt safeguard, ≤10 pages only)
 */

import { logger } from "./logger";
import {
  extractPdfMetadata,
  extractPagePhrases,
  getPdfPageCount,
  type PdfPhrase,
} from "./pdf-words";
import {
  FLOOR_PLAN_INCLUSION_PHRASES,
  FLOOR_PLAN_EXCLUSION_PHRASES,
} from "./sign-vocabulary";
import { SIGN_SCHEDULE_PHRASES } from "./extraction-classification";

// ── Types ─────────────────────────────────────────────────────────────────────

export type SheetBucket =
  | "signage_schedule"
  | "life_safety"
  | "key_plan"
  | "floor_plan"
  | "general_notes"
  | "accessibility"
  | "millwork_interiors"
  | "specifications"
  | "ignore"
  | "other";

export interface SheetManifestEntry {
  sheetNumber: string | null;
  sheetTitle: string;
  pdfPage: number;
  bucket: SheetBucket;
  level: string | null;
  levelRaw: string | null;
  area: string | null;
  building: string | null;
  source: "bookmark" | "index_page" | "title_block" | "full_page_fallback" | "excerpt_fallback";
}

export interface SheetManifest {
  entries: SheetManifestEntry[];
  isExcerpt: boolean;
  warnings: string[];
  totalPages: number;
}

// ── Classification (P2.3) ─────────────────────────────────────────────────────

/**
 * Signage schedule phrases — superset of SIGN_SCHEDULE_PHRASES from extraction-classification.ts
 * with additional aliases used in architectural drawings.
 */
const SCHEDULE_PHRASES = [
  ...SIGN_SCHEDULE_PHRASES,
  // Additional aliases not in SIGN_SCHEDULE_PHRASES
  "plaque",
  "sign types",
];

const LIFE_SAFETY_PHRASES = [
  "life safety",
  "egress",
  "code plan",
  "code compliance",
  "exiting",
  "occupant load",
];

const KEY_PLAN_PHRASES = ["key plan", "overall key"];

/**
 * Ignore bucket — MEP, structural, and other non-architectural discipline sheets.
 * Derived from FLOOR_PLAN_EXCLUSION_PHRASES (the canonical token list) plus
 * explicit multi-word full-phrase forms that are safe to match anywhere on a
 * page. Spreading the canonical list here means any new exclusion term added
 * to FLOOR_PLAN_EXCLUSION_PHRASES is automatically picked up without a
 * separate manual edit.
 *
 * Entries that belong to downstream buckets (general_notes at P6) are filtered
 * out of the spread so those sheets are not swallowed by the ignore check at P4.
 */
const IGNORE_PHRASES = [
  ...FLOOR_PLAN_EXCLUSION_PHRASES.filter(
    // "general notes" and "abbreviation" belong to the general_notes bucket (P6)
    // and must not be caught here at P4.
    (p) => p !== "general notes" && p !== "abbreviation"
  ),
  // Multi-word full-phrase forms (more targeted than the single-token base)
  "reflected ceiling",
  "roof plan",
  "demolition plan",
  "site plan",
  "framing plan",
  "structural plan",
  "mechanical plan",
  "electrical plan",
  "plumbing plan",
  "fire protection plan",
  "lighting plan",
  "power plan",
  "sprinkler plan",
  "photometric plan",
  "furniture plan",
  "finish plan",
];

/**
 * Discipline modifiers that veto floor_plan even when an inclusion phrase matches.
 * Keeps "MECHANICAL FLOOR PLAN" → other, not floor_plan.
 */
const FLOOR_PLAN_DISCIPLINE_VETO = FLOOR_PLAN_EXCLUSION_PHRASES;

const GENERAL_NOTES_PHRASES = [
  "general notes",
  "abbreviations",
  "symbols",
  "mounting heights",
  "typical details",
];

const ACCESSIBILITY_PHRASES = [
  "accessibility",
  "ada",
  "maab",
  "cbc 11b",
  "barrier-free",
];

const MILLWORK_PHRASES = [
  "millwork",
  "casework",
  "interior elevations",
  "interior details",
];

const SPEC_PHRASES = ["specifications", "specs"];

// Sheet number patterns — P2.3 sheet-number fallbacks
// Floor plan: A-1XX, A-2XX, A-3XX (dash or dot separator) plus A3.2-style
const FLOOR_PLAN_SHEET_RE = /^A(?:[-.]?[123]\d{2}|[123]\.\d+)$/i;
// General notes: A-000, A-001, or any G-series sheet
const GENERAL_NOTES_SHEET_RE = /^(?:A[-.]?00[01]|G[-.]?\d+)$/i;
// Millwork / interiors: A-7XX or A-8XX
const MILLWORK_SHEET_RE = /^A[-.]?[78]\d{2}$/i;

const LEVEL_PLAN_RE = /\b\w+ level plan\b/;

/**
 * Classify a sheet title + optional sheet number into one of 10 buckets.
 * Priority order is fixed — first match wins.
 */
export function classifyTitle(text: string, sheetNumber?: string | null): SheetBucket {
  const t = text.toLowerCase().trim();

  if (!t) return "other";

  // P1 — signage_schedule
  if (SCHEDULE_PHRASES.some((p) => t.includes(p.toLowerCase()))) return "signage_schedule";

  // P2 — life_safety
  if (LIFE_SAFETY_PHRASES.some((p) => t.includes(p.toLowerCase()))) return "life_safety";

  // P3 — key_plan
  if (KEY_PLAN_PHRASES.some((p) => t.includes(p.toLowerCase()))) return "key_plan";

  // P4 — ignore (must be before floor_plan so discipline sheets never promote)
  if (IGNORE_PHRASES.some((p) => t.includes(p.toLowerCase()))) return "ignore";

  // P5 — floor_plan
  // Must match an inclusion phrase AND pass the discipline modifier veto.
  const hasFpInclusion =
    FLOOR_PLAN_INCLUSION_PHRASES.some((p) => t.includes(p.toLowerCase())) ||
    LEVEL_PLAN_RE.test(t);
  const hasDisciplineVeto = FLOOR_PLAN_DISCIPLINE_VETO.some((p) =>
    t.includes(p.toLowerCase())
  );
  if (hasFpInclusion && !hasDisciplineVeto) return "floor_plan";

  // Sheet number fallback for floor plans (A-1XX, A-2XX, A-3XX)
  if (sheetNumber && FLOOR_PLAN_SHEET_RE.test(sheetNumber.trim())) return "floor_plan";

  // P6 — general_notes (phrase OR sheet-number A-000 / A-001 / G-series)
  if (GENERAL_NOTES_PHRASES.some((p) => t.includes(p.toLowerCase()))) return "general_notes";
  if (sheetNumber && GENERAL_NOTES_SHEET_RE.test(sheetNumber.trim())) return "general_notes";

  // P7 — accessibility
  if (ACCESSIBILITY_PHRASES.some((p) => t.includes(p.toLowerCase()))) return "accessibility";

  // P8 — millwork_interiors (phrase OR sheet-number A-7XX / A-8XX)
  if (MILLWORK_PHRASES.some((p) => t.includes(p.toLowerCase()))) return "millwork_interiors";
  if (sheetNumber && MILLWORK_SHEET_RE.test(sheetNumber.trim())) return "millwork_interiors";

  // P9 — specifications
  if (SPEC_PHRASES.some((p) => t.includes(p.toLowerCase()))) return "specifications";

  // P10 — other (fallback)
  return "other";
}

// ── Level extraction (P2.5 / P2.6) ───────────────────────────────────────────

interface LevelInfo {
  level: string | null;
  levelRaw: string | null;
  area: string | null;
  building: string | null;
}

const LEVEL_MAP: Array<{ phrases: string[]; normalized: string }> = [
  { phrases: ["lower level", "basement", "sub-grade", "below grade", "b1"], normalized: "B1" },
  { phrases: ["first floor", "level 1", "main level", "ground floor", "grade level", "l1"], normalized: "L1" },
  { phrases: ["second floor", "level 2", "upper level", "l2"], normalized: "L2" },
  { phrases: ["third floor", "level 3", "l3"], normalized: "L3" },
  { phrases: ["fourth floor", "level 4", "l4"], normalized: "L4" },
  { phrases: ["fifth floor", "level 5", "l5"], normalized: "L5" },
  { phrases: ["sixth floor", "level 6", "l6"], normalized: "L6" },
  { phrases: ["seventh floor", "level 7", "l7"], normalized: "L7" },
  { phrases: ["mezzanine", "mezz"], normalized: "MEZZ" },
  { phrases: ["penthouse", "roof level"], normalized: "ROOF" },
  { phrases: ["attic"], normalized: "ATTIC" },
];

export function extractLevelFromTitle(title: string): LevelInfo {
  const t = title.toLowerCase();
  let level: string | null = null;
  let levelRaw: string | null = null;

  for (const entry of LEVEL_MAP) {
    for (const phrase of entry.phrases) {
      if (t.includes(phrase)) {
        level = entry.normalized;
        // Find the raw phrase as it appeared in the original title (case-preserved)
        const idx = t.indexOf(phrase);
        levelRaw = title.slice(idx, idx + phrase.length);
        break;
      }
    }
    if (level) break;
  }

  // Area extraction: "AREA A", "AREA B", etc.
  const areaMatch = title.match(/\barea\s+([A-D])\b/i);
  const area = areaMatch ? `AREA ${areaMatch[1].toUpperCase()}` : null;

  // Building extraction: "BUILDING A", "BLDG A", etc.
  const buildingMatch = title.match(/\b(?:building|bldg)\s+([A-Z])\b/i);
  const building = buildingMatch ? `BUILDING ${buildingMatch[1].toUpperCase()}` : null;

  return { level, levelRaw, area, building };
}

// ── Title block zone helpers ──────────────────────────────────────────────────

/** Narrow title strip — cy > 0.90: where most sheet titles live */
function isInTitleStrip(p: PdfPhrase): boolean {
  const cy = (p.y0 + p.y1) / 2;
  return cy > 0.90;
}

/** Full title-block corner zone (same as existing isInTitleBlockZone) */
function isInTitleBlockZone(p: PdfPhrase): boolean {
  const cx = (p.x0 + p.x1) / 2;
  const cy = (p.y0 + p.y1) / 2;
  return (cx > 0.60 && cy > 0.60) || cy > 0.80 || cx > 0.75;
}

function phrasesToText(phrases: PdfPhrase[]): string {
  return phrases.map((p) => p.text).join(" ");
}

/**
 * Extract sheet number from phrases — looks for patterns like "A-101", "A3.1", "A-001"
 * in the title block zone.
 */
function extractSheetNumber(phrases: PdfPhrase[]): string | null {
  const SHEET_NUM_RE = /\b([A-Z]+[-.]?\d{1,3}(?:\.\d)?)\b/;
  for (const p of phrases) {
    const m = p.text.match(SHEET_NUM_RE);
    if (m) return m[1];
  }
  return null;
}

// ── Drawing index table scanner (Step B.0) ────────────────────────────────────

/**
 * Regex for a sheet number as it appears in a drawing index table.
 * Matches patterns like: A-101, A.101, A101, G-001, S-2.1, M-01, A-101A.
 * Must appear as an isolated token (word boundary on right side).
 */
const INDEX_SHEET_NUM_RE = /^([A-Z]{1,3}[-.]?\d{1,4}(?:[-.]\d{1,2})?[A-Z]?)\b/i;

/**
 * Minimum number of sheet-number rows found on a page before it is treated
 * as a drawing index (rather than a regular sheet that happens to list a few
 * numbers in a notes table).
 */
const MIN_INDEX_ROWS = 3;

/**
 * Maximum allowed spread (standard deviation) of sheet-number column x-positions,
 * in normalised page-width units.  Sheet numbers in a real drawing index always
 * form a vertical column; scattered x-positions indicate coincidental matches
 * in a notes/general-text page rather than a true index table.
 */
const INDEX_COLUMN_MAX_SPREAD = 0.12;

/**
 * Normalise a sheet number for comparison: uppercase and strip all whitespace,
 * dashes, and dots so that "A-101", "A.101", and "A101" all map to the same
 * canonical key ("A101").
 *
 * Exported for unit testing.
 */
export function normalizeSheetNum(s: string): string {
  return s.toUpperCase().replace(/[\s\-.]/g, "");
}

/**
 * Group an array of PdfPhrase values by their visual row (shared Y centre
 * within ROW_TOLERANCE).  Returns groups in top-to-bottom order.
 */
function groupPhrasesByRow(phrases: PdfPhrase[]): PdfPhrase[][] {
  const ROW_TOLERANCE = 0.012; // ~1.2 % of page height
  const rows: Array<{ cy: number; phrases: PdfPhrase[] }> = [];

  for (const phrase of phrases) {
    const cy = (phrase.y0 + phrase.y1) / 2;
    const existing = rows.find((r) => Math.abs(r.cy - cy) <= ROW_TOLERANCE);
    if (existing) {
      existing.phrases.push(phrase);
    } else {
      rows.push({ cy, phrases: [phrase] });
    }
  }

  rows.sort((a, b) => a.cy - b.cy);
  return rows.map((r) => r.phrases);
}

/**
 * Extract one index row from a list of phrases that share the same visual row.
 * The first phrase (left-most) that matches INDEX_SHEET_NUM_RE is the sheet
 * number; everything to its right is joined as the title.
 *
 * Also returns `sheetNumX0` — the normalised left-edge x-position of the
 * sheet-number phrase — used by the caller to check that all sheet numbers on
 * the page form a vertical column (i.e. a real index table, not scattered text).
 *
 * Returns null when the row does not contain a recognisable sheet number with
 * an accompanying title.
 */
function extractIndexRow(
  rowPhrases: PdfPhrase[],
): { sheetNumber: string; title: string; sheetNumX0: number } | null {
  const sorted = [...rowPhrases].sort((a, b) => a.x0 - b.x0);

  for (let i = 0; i < sorted.length; i++) {
    const phrase = sorted[i]!;
    const m = phrase.text.trim().match(INDEX_SHEET_NUM_RE);
    if (!m) continue;

    const sheetNumber = m[1]!;
    const titlePhrases = sorted.slice(i + 1);
    const title = titlePhrases.map((p) => p.text).join(" ").trim();

    // Require at least some title text — rows with only a sheet number are
    // usually continuation rows or headers, not real index entries.
    if (title.length === 0) return null;

    return { sheetNumber, title, sheetNumX0: phrase.x0 };
  }

  return null;
}

interface IndexEntry {
  sheetNumber: string;
  title: string;
}

/**
 * Scan pages 1–5 of the PDF for a printed drawing index table.
 *
 * Detection criteria:
 *  1. The page has ≥ MIN_INDEX_ROWS rows each starting with a sheet-number
 *     pattern followed by a title.
 *  2. The sheet-number phrases form a vertical column: their left-edge
 *     x-positions have a standard deviation ≤ INDEX_COLUMN_MAX_SPREAD.
 *     Scattered x-positions indicate coincidental matches on a notes page.
 *
 * All discovered entries are stored in the Map with NORMALISED sheet-number
 * keys (uppercase, punctuation stripped) so that "A-101", "A.101", and "A101"
 * all resolve to the same entry at lookup time.
 *
 * Returns an empty Map when no index table is detected.
 */
async function scanForDrawingIndex(
  pdfPath: string,
  fileId: string,
  numPages: number,
): Promise<Map<string, IndexEntry>> {
  const SCAN_PAGES = Math.min(5, numPages);
  const result = new Map<string, IndexEntry>();

  for (let pageNum = 1; pageNum <= SCAN_PAGES; pageNum++) {
    let phrases: PdfPhrase[];
    try {
      const pageWords = await extractPagePhrases(pdfPath, fileId, pageNum);
      phrases = pageWords.phrases;
    } catch {
      continue;
    }

    if (phrases.length === 0) continue;

    const rows = groupPhrasesByRow(phrases);
    const rawRows: Array<{ sheetNumber: string; title: string; sheetNumX0: number }> = [];

    for (const rowPhrases of rows) {
      const entry = extractIndexRow(rowPhrases);
      if (entry) rawRows.push(entry);
    }

    if (rawRows.length < MIN_INDEX_ROWS) continue;

    // Column-clustering guard: reject the page if the sheet-number phrases are
    // horizontally scattered.  A real drawing index has all sheet numbers in a
    // single left-aligned column.
    const xs = rawRows.map((r) => r.sheetNumX0);
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length;
    const stdDev = Math.sqrt(variance);
    if (stdDev > INDEX_COLUMN_MAX_SPREAD) {
      logger.debug(
        { fileId, pageNum, rowCount: rawRows.length, stdDev: stdDev.toFixed(3) },
        "[Sheet Manifest] Skipping candidate index page — sheet-number column too spread out",
      );
      continue;
    }

    logger.debug(
      { fileId, pageNum, rowCount: rawRows.length, stdDev: stdDev.toFixed(3) },
      "[Sheet Manifest] Drawing index table detected",
    );

    for (const entry of rawRows) {
      const key = normalizeSheetNum(entry.sheetNumber);
      if (!result.has(key)) {
        result.set(key, { sheetNumber: entry.sheetNumber, title: entry.title });
      }
    }
  }

  return result;
}

// ── Per-page title-block helpers ──────────────────────────────────────────────

/**
 * 3-pass classification of a single page using phrase lists.
 *
 * Returns the classified bucket, title, sheet number, and source.
 * When all three passes resolve to "other" the function still returns a result
 * so the caller can attempt a drawing-index lookup using the sheet number —
 * returning null only when no phrases could be extracted at all.
 */
async function classifyPagePhrases(
  pdfPath: string,
  fileId: string,
  pageNum: number,
  isExcerptCandidate: boolean,
): Promise<{ bucket: SheetBucket; sheetTitle: string; sheetNumber: string | null; source: "title_block" | "full_page_fallback" } | null> {
  let phrases: PdfPhrase[];
  try {
    const result = await extractPagePhrases(pdfPath, fileId, pageNum);
    phrases = result.phrases;
  } catch {
    return null;
  }

  if (phrases.length === 0) return null;

  // Track the best sheet number found across all passes so we can return it
  // even when no pass yields a non-"other" bucket (enables index lookup).
  let bestSheetNumber: string | null = null;

  // Pass 1 — narrow title strip
  const stripPhrases = phrases.filter(isInTitleStrip);
  if (stripPhrases.length > 0) {
    const text = phrasesToText(stripPhrases);
    const sheetNumber = extractSheetNumber(stripPhrases);
    if (sheetNumber && !bestSheetNumber) bestSheetNumber = sheetNumber;
    const bucket = classifyTitle(text, sheetNumber);
    if (bucket !== "other") {
      return { bucket, sheetTitle: text.trim().slice(0, 120), sheetNumber, source: "title_block" };
    }
  }

  // Pass 2 — full title-block zone
  const zonePhrases = phrases.filter(isInTitleBlockZone);
  if (zonePhrases.length > 0) {
    const text = phrasesToText(zonePhrases);
    const sheetNumber = extractSheetNumber(zonePhrases);
    if (sheetNumber && !bestSheetNumber) bestSheetNumber = sheetNumber;
    const bucket = classifyTitle(text, sheetNumber);
    if (bucket !== "other") {
      return { bucket, sheetTitle: text.trim().slice(0, 120), sheetNumber, source: "title_block" };
    }
  }

  // Pass 3 — full page scan (excerpt safeguard — only when numPages ≤ 10)
  if (isExcerptCandidate) {
    const text = phrasesToText(phrases);
    const sheetNumber = extractSheetNumber(phrases);
    if (sheetNumber && !bestSheetNumber) bestSheetNumber = sheetNumber;
    const bucket = classifyTitle(text, sheetNumber);
    if (bucket !== "other") {
      return { bucket, sheetTitle: text.trim().slice(0, 120), sheetNumber, source: "full_page_fallback" };
    }
  }

  // All passes returned "other".  Return the best sheet number we found so the
  // caller can still do a drawing-index lookup — this is the key path that lets
  // the index scanner fill gaps that per-page title-block scraping misses.
  return { bucket: "other", sheetTitle: "", sheetNumber: bestSheetNumber, source: "title_block" };
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function buildSheetManifest(
  pdfPath: string,
  fileId: string,
): Promise<SheetManifest> {
  const warnings: string[] = [];
  const entries: SheetManifestEntry[] = [];

  // ── Step A: PDF bookmarks (primary) ────────────────────────────────────────
  let numPages = 0;
  let usedBookmarks = false;

  try {
    numPages = await getPdfPageCount(pdfPath);
  } catch (err) {
    logger.warn({ err, fileId }, "[Sheet Manifest] Failed to get page count");
    return { entries: [], isExcerpt: false, warnings: ["Could not read PDF"], totalPages: 0 };
  }

  try {
    const meta = await extractPdfMetadata(pdfPath);
    if (meta.outlineSections.length > 0) {
      usedBookmarks = true;
      for (const section of meta.outlineSections) {
        const bucket = classifyTitle(section.title);
        const levelInfo = extractLevelFromTitle(section.title);
        for (let page = section.pageStart; page <= Math.min(section.pageEnd, numPages); page++) {
          // Don't overwrite an existing entry for this page (first bookmark wins)
          if (!entries.find((e) => e.pdfPage === page)) {
            entries.push({
              sheetNumber: null,
              sheetTitle: section.title,
              pdfPage: page,
              bucket,
              level: levelInfo.level,
              levelRaw: levelInfo.levelRaw,
              area: levelInfo.area,
              building: levelInfo.building,
              source: "bookmark",
            });
          }
        }
      }
    }
  } catch (err) {
    logger.warn({ err, fileId }, "[Sheet Manifest] Bookmark extraction failed — falling back to title block scrape");
  }

  // ── Step B.0: Drawing index table scan (pages 1–5) ────────────────────────
  // Scan the first 5 pages for a printed drawing index before doing per-page
  // title-block scraping.  A successful scan populates sheetNumber→title pairs
  // for every sheet in the set so that later per-page work can match against
  // authoritative titles rather than fragmented title-block text.
  let drawingIndex = new Map<string, IndexEntry>();
  try {
    drawingIndex = await scanForDrawingIndex(pdfPath, fileId, numPages);
    if (drawingIndex.size > 0) {
      logger.info(
        { fileId, indexSize: drawingIndex.size },
        "[Sheet Manifest] Drawing index found — will resolve sheet titles from index",
      );
    }
  } catch (err) {
    logger.warn({ err, fileId }, "[Sheet Manifest] Drawing index scan failed — continuing without it");
  }

  // ── Step B: Title block scrape (fallback for pages not covered by bookmarks) ─
  const isExcerptCandidate = numPages <= 10 && !usedBookmarks;
  const coveredPages = new Set(entries.map((e) => e.pdfPage));
  const uncoveredPages: number[] = [];
  for (let p = 1; p <= numPages; p++) {
    if (!coveredPages.has(p)) uncoveredPages.push(p);
  }

  if (uncoveredPages.length > 0) {
    await Promise.all(
      uncoveredPages.map(async (pageNum) => {
        // Always extract the sheet number from the title block first so we can
        // look it up in the drawing index (Step B.0).
        const result = await classifyPagePhrases(pdfPath, fileId, pageNum, isExcerptCandidate);
        const extractedSheetNumber = result?.sheetNumber ?? null;

        // If this page's sheet number appears in the drawing index, prefer the
        // authoritative index title over whatever the title block returned.
        // Normalise the extracted number so "A-101" matches a key stored as
        // "A101" (or any other punctuation variant).
        const indexMatch =
          extractedSheetNumber !== null
            ? drawingIndex.get(normalizeSheetNum(extractedSheetNumber)) ?? null
            : null;

        let bucket: SheetBucket;
        let sheetTitle: string;
        let sheetNumber: string | null;
        let source: SheetManifestEntry["source"];

        if (indexMatch) {
          bucket = classifyTitle(indexMatch.title, indexMatch.sheetNumber);
          sheetTitle = indexMatch.title;
          sheetNumber = indexMatch.sheetNumber;
          source = "index_page";
        } else {
          bucket = result?.bucket ?? "other";
          sheetTitle = result?.sheetTitle ?? "";
          sheetNumber = extractedSheetNumber;
          source = result?.source ?? "title_block";
        }

        const levelInfo = extractLevelFromTitle(sheetTitle);
        entries.push({
          sheetNumber,
          sheetTitle,
          pdfPage: pageNum,
          bucket,
          level: levelInfo.level,
          levelRaw: levelInfo.levelRaw,
          area: levelInfo.area,
          building: levelInfo.building,
          source,
        });
      })
    );
  }

  // Sort entries by page number
  entries.sort((a, b) => a.pdfPage - b.pdfPage);

  // ── Step C: Excerpt flag ────────────────────────────────────────────────────
  const isExcerpt = isExcerptCandidate;

  // ── Hard-stop warnings (P2.9) — non-blocking ───────────────────────────────
  const hasFloorPlan = entries.some((e) => e.bucket === "floor_plan");
  const hasSignageSchedule = entries.some((e) => e.bucket === "signage_schedule");

  if (!hasFloorPlan) {
    warnings.push(
      "No floor plan sheets identified — extraction will produce 0 signs"
    );
  }
  if (!hasSignageSchedule) {
    warnings.push(
      "No signage schedule found; sign types inferred from floor plan only"
    );
  }
  if (isExcerpt) {
    warnings.push(
      "Upload is a plan excerpt (≤10 pages, no bookmarks); key reference sheets may be missing"
    );
  }

  logger.info(
    {
      fileId,
      totalPages: numPages,
      floorPlan: entries.filter((e) => e.bucket === "floor_plan").length,
      signSchedule: entries.filter((e) => e.bucket === "signage_schedule").length,
      lifeSafety: entries.filter((e) => e.bucket === "life_safety").length,
      ignore: entries.filter((e) => e.bucket === "ignore").length,
      other: entries.filter((e) => e.bucket === "other").length,
      fromBookmarks: entries.filter((e) => e.source === "bookmark").length,
      fromIndex: entries.filter((e) => e.source === "index_page").length,
      fromTitleBlock: entries.filter((e) => e.source === "title_block" || e.source === "full_page_fallback").length,
      drawingIndexSize: drawingIndex.size,
      usedBookmarks,
      isExcerpt,
    },
    "[Sheet Manifest] Complete"
  );

  return { entries, isExcerpt, warnings, totalPages: numPages };
}
