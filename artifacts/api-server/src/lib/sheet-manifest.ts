/**
 * Sheet Manifest — Phase 2 of the SignTakeoff IQ pipeline.
 *
 * Replaces the legacy 3-bucket spatial pre-pass (floor_plan / sign_schedule / other)
 * with a 10-bucket cascade that correctly identifies every sheet type needed for
 * a complete sign takeoff.
 *
 * Cascade order:
 *   A. PDF bookmarks (primary — most reliable)
 *   B. Title block scrape: 3-pass zone widening per page
 *       Pass 1 — narrow title strip (cy > 0.90)
 *       Pass 2 — full title-block corner zone
 *       Pass 3 — full-page scan (excerpt safeguard, ≤10 pages only)
 *
 * TODO: Index-page scan (P2.1 Step 2) — scanning pages 1-5 for a printed drawing
 * index table is deferred to a follow-up task.
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
  source: "bookmark" | "title_block" | "full_page_fallback" | "excerpt_fallback";
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
 * These use FLOOR_PLAN_EXCLUSION_PHRASES as a base plus explicit multi-word
 * identifiers that are safe to check anywhere on a page.
 */
const IGNORE_PHRASES = [
  "reflected ceiling",
  "roof plan",
  "foundation",
  "demolition plan",
  "site plan",
  "framing plan",
  "structural plan",
  "rcp",
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

/**
 * 3-pass classification of a single page using phrase lists.
 * Returns the bucket and source, or null if all passes return "other".
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

  // Pass 1 — narrow title strip
  const stripPhrases = phrases.filter(isInTitleStrip);
  if (stripPhrases.length > 0) {
    const text = phrasesToText(stripPhrases);
    const sheetNumber = extractSheetNumber(stripPhrases);
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
    const bucket = classifyTitle(text, sheetNumber);
    if (bucket !== "other") {
      return { bucket, sheetTitle: text.trim().slice(0, 120), sheetNumber, source: "title_block" };
    }
  }

  // Pass 3 — full page scan (excerpt safeguard — only when numPages ≤ 10)
  if (isExcerptCandidate) {
    const text = phrasesToText(phrases);
    const sheetNumber = extractSheetNumber(phrases);
    const bucket = classifyTitle(text, sheetNumber);
    if (bucket !== "other") {
      return { bucket, sheetTitle: text.trim().slice(0, 120), sheetNumber, source: "full_page_fallback" };
    }
  }

  return null;
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
        const result = await classifyPagePhrases(pdfPath, fileId, pageNum, isExcerptCandidate);
        const bucket = result?.bucket ?? "other";
        const sheetTitle = result?.sheetTitle ?? "";
        const sheetNumber = result?.sheetNumber ?? null;
        const source: SheetManifestEntry["source"] = result?.source ?? "title_block";
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
      usedBookmarks,
      isExcerpt,
    },
    "[Sheet Manifest] Complete"
  );

  return { entries, isExcerpt, warnings, totalPages: numPages };
}
