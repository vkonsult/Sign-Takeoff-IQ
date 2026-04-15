/**
 * extraction-classification.ts
 *
 * Page-type classification for architectural PDF pages.
 * Classifies each page as floor_plan | sign_schedule | both | other | unknown
 * using drawing-number patterns, title-block keywords, and text-scoring heuristics.
 *
 * Split from extraction.ts to keep individual modules focused.
 */

import {
  FLOOR_PLAN_INCLUSION_PHRASES,
  FLOOR_PLAN_EXCLUSION_PHRASES,
  SIGN_SCHEDULE_PHRASES,
} from "./sign-vocabulary";

// ─── TYPES ────────────────────────────────────────────────────────────────────

export type PageType = "floor_plan" | "sign_schedule" | "other" | "both";
export type TitleBlockType = "floor_plan" | "sign_schedule" | "other" | "unknown" | "both";

export interface ScoredPage {
  pageNum: number;
  text: string;
  floorPlanScore: number;
  signScheduleScore: number;
  type: PageType;
  titleBlockType: TitleBlockType;
}

// ─── PAGE SCORING ─────────────────────────────────────────────────────────────

const LEGEND_PAGE_KEYWORDS = [
  "life safety legend",
  "signage legend",
  "symbol legend",
  "symbol key",
  "drawing legend",
  "legend:",
  "symbols and abbreviations",
  "general notes legend",
  "fire protection legend",
  "door hardware legend",
  "room finish legend",
  "abbreviation legend",
];

function scoreForLegendPage(text: string): number {
  const lower = text.toLowerCase();
  return LEGEND_PAGE_KEYWORDS.reduce((score, kw) => {
    const hits = (lower.match(new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length;
    return score + hits * 3;
  }, 0);
}

// Only terms that genuinely discriminate a floor plan drawing page.
// scoreForFloorPlan counts 1 per unique match (not per occurrence).
const FLOOR_PLAN_KEYWORDS = FLOOR_PLAN_INCLUSION_PHRASES;

function scoreForFloorPlan(text: string): number {
  const lower = text.toLowerCase();
  return FLOOR_PLAN_KEYWORDS.reduce((score, kw) => score + (lower.includes(kw) ? 1 : 0), 0);
}

function scoreForSignSchedule(text: string): number {
  const lower = text.toLowerCase();
  return SIGN_SCHEDULE_PHRASES.reduce((score, kw) => score + (lower.includes(kw) ? 1 : 0), 0);
}

// ─── TITLE BLOCK CLASSIFIER ───────────────────────────────────────────────────

// Drawing number prefix patterns that indicate a non-floor-plan, non-sign sheet.
const OTHER_DRAWING_NUMBER_PATTERNS: RegExp[] = [
  /\bG-\d{3}/i,         // General: cover sheets, notes, sheet index
  /\bS-\d{3}/i,         // Structural
  /\bM-\d{3}/i,         // Mechanical
  /\bP-\d{3}/i,         // Plumbing
  /\bE-\d{3}/i,         // Electrical
  /\bC-\d{3}/i,         // Civil
  /\bL-\d{3}/i,         // Landscape
  /\bFP-\d{3}/i,        // Fire Protection
  /\bFPL?-\d{3}/i,      // Fire Protection (alt)
  // Architectural A2.x–A9.x (excluding sign numbers A10-A12)
  /\bA[2-9]\.\d{1,3}\b/i,
];

// Drawing number patterns that indicate a floor plan sheet.
// Matches: A1.1, A0.2, A-111, A - 111, A111, A1-1
const FLOOR_PLAN_DRAWING_NUMBER_PATTERNS: RegExp[] = [
  /\bA\s*[-.]?\s*\d{1,4}(?:[-./]\d{1,4})?\b/i,
];

// Drawing number patterns that indicate a sign schedule / signage sheet.
const SIGN_SCHEDULE_DRAWING_NUMBER_PATTERNS: RegExp[] = [
  /\bA1[012]\.\d{1,3}\b/i,  // A10.x, A11.x, A12.x — signage sheets
  /\bSN-\d+/i,              // Signage numbering prefix
];

// High-confidence title phrases that unambiguously identify a non-floor-plan,
// non-sign-schedule sheet (trusted standalone, no drawing-number requirement).
const OTHER_TITLE_KEYWORDS_STANDALONE: string[] = [
  "cover sheet",
  "title sheet",
  "title page",
  "vicinity map",
  "area map",
  "exterior elevation",
  "interior elevation",
  "building elevation",
  "building section",
  "wall section",
  "stair section",
  "roof plan",
  "demolition plan",
  "framing plan",
  "foundation plan",
  "sheet index",
  "drawing index",
];

// Broader title phrases that indicate "other" — only trusted when a drawing
// number is also present (to anchor the match to the title block).
const OTHER_TITLE_KEYWORDS_NUMBER_REQUIRED: string[] = [
  "site plan",
  "reflected ceiling plan",
  "door schedule",
  "window schedule",
  "finish schedule",
  "room finish schedule",
  "general notes",
  "abbreviations",
  "landscape plan",
  "grading plan",
  "utility plan",
  "electrical plan",
  "mechanical plan",
  "plumbing plan",
  "fire protection plan",
  "structural plan",
  "civil plan",
  "detail sheet",
  "keynote legend",
];

// Single source of truth imported from sign-vocabulary.ts
const FLOOR_PLAN_TITLE_KEYWORDS = FLOOR_PLAN_INCLUSION_PHRASES;
const SIGN_SCHEDULE_TITLE_KEYWORDS = SIGN_SCHEDULE_PHRASES;

/**
 * Classify a page using drawing title-block signals.
 *
 * Classification rules (evaluated in order):
 *  0. Floor plan number + title + sign-schedule signal → "both"
 *  1. Sign schedule title keyword (standalone) → "sign_schedule"
 *  2. Sign schedule drawing number → "sign_schedule"
 *  3. Floor plan title keyword + floor plan drawing number → "floor_plan"
 *  4. High-confidence "other" title keyword (standalone) → "other"
 *  5. Any "other" drawing number → "other"
 *  6. Floor plan drawing number + number-required "other" title keyword → "other"
 *  7. Floor plan drawing number alone → "unknown"
 *  8. No recognisable signal → "unknown"
 */
function detectTitleBlock(text: string): TitleBlockType {
  const upper = text.toUpperCase();

  const hasFpNumber = FLOOR_PLAN_DRAWING_NUMBER_PATTERNS.some((p) => p.test(text));

  // Proximity-aware exclusion veto for floor-plan title classification.
  // Only veto when a plan-type modifier appears within ±40 chars of a fp title keyword.
  const PLAN_TYPE_MODIFIERS = [
    "ceiling", "reflected ceiling",
    "framing",
    "structural",
    "mechanical",
    "electrical",
    "plumbing",
    "foundation",
    "demolition",
    "sanitary",
  ] as const;
  const EXCLUSION_PROXIMITY = 40;
  const hasFpTitleAny = FLOOR_PLAN_TITLE_KEYWORDS.some((kw) => upper.includes(kw.toUpperCase()));

  // Sign-schedule qualifier phrases: when a fp title keyword appears immediately
  // AFTER one of these (within 60 chars), it is a section heading inside a sign
  // schedule — NOT an independent floor plan title.
  const SS_QUALIFIER_PROXIMITY = 60;
  const SS_QUALIFIERS = SIGN_SCHEDULE_PHRASES.map((s) => s.toUpperCase());

  function hasCleanOccurrence(titleKw: string): boolean {
    const kwU = titleKw.toUpperCase();
    let searchFrom = 0;
    while (true) {
      const pos = upper.indexOf(kwU, searchFrom);
      if (pos === -1) break;
      const win = upper.slice(Math.max(0, pos - EXCLUSION_PROXIMITY), pos + kwU.length + EXCLUSION_PROXIMITY);
      const hasPlanTypeMod = PLAN_TYPE_MODIFIERS.some((mod) => win.includes(mod.toUpperCase()));
      if (!hasPlanTypeMod) {
        const before = upper.slice(Math.max(0, pos - SS_QUALIFIER_PROXIMITY), pos);
        const isScheduleCtx = SS_QUALIFIERS.some((q) => before.includes(q));
        if (!isScheduleCtx) return true;
      }
      searchFrom = pos + 1;
    }
    return false;
  }

  const hasExclusionNearTitle = hasFpTitleAny &&
    !FLOOR_PLAN_TITLE_KEYWORDS.some((kw) => upper.includes(kw.toUpperCase()) && hasCleanOccurrence(kw));

  const hasExclusion = FLOOR_PLAN_EXCLUSION_PHRASES.some((kw) => upper.includes(kw.toUpperCase()));

  const hasFpTitle = hasFpTitleAny && !hasExclusionNearTitle;
  const hasOtherNumber = OTHER_DRAWING_NUMBER_PATTERNS.some((p) => p.test(text));
  const hasAnyNumber = hasFpNumber || hasOtherNumber;
  const hasSignScheduleTitle = SIGN_SCHEDULE_TITLE_KEYWORDS.some((kw) => upper.includes(kw.toUpperCase()));
  const hasSignScheduleNumber = !hasExclusion && SIGN_SCHEDULE_DRAWING_NUMBER_PATTERNS.some((p) => p.test(text));

  // 0. Both floor plan and sign schedule on the same page
  if (hasFpNumber && hasFpTitle && (hasSignScheduleTitle || hasSignScheduleNumber)) {
    return "both";
  }

  // 1. Sign schedule title keywords
  if (hasSignScheduleTitle) return "sign_schedule";

  // 2. Sign schedule drawing number
  if (hasSignScheduleNumber) return "sign_schedule";

  // 3. Floor plan: requires BOTH drawing number AND title
  if (hasFpNumber && hasFpTitle) return "floor_plan";

  // 4. High-confidence "other" title keywords (standalone)
  for (const kw of OTHER_TITLE_KEYWORDS_STANDALONE) {
    if (upper.includes(kw.toUpperCase())) return "other";
  }

  // 5. Any "other" drawing number (not overridden by a fp title)
  if (hasOtherNumber && !hasFpTitle) return "other";

  // 6. Floor plan drawing number + number-required "other" title keyword
  if (hasAnyNumber) {
    for (const kw of OTHER_TITLE_KEYWORDS_NUMBER_REQUIRED) {
      if (upper.includes(kw.toUpperCase())) return "other";
    }
  }

  // 7. Floor plan drawing number alone
  if (hasFpNumber) return "unknown";

  return "unknown";
}

/**
 * Classify a single PDF page by text content, returning a ScoredPage.
 */
export function classifyPage(pageNum: number, text: string): ScoredPage {
  const titleBlockType = detectTitleBlock(text);

  if (titleBlockType === "other") {
    return { pageNum, text, floorPlanScore: 0, signScheduleScore: 0, type: "other", titleBlockType };
  }
  if (titleBlockType === "both") {
    const legendScore = scoreForLegendPage(text);
    const textFloorPlanScore = scoreForFloorPlan(text);
    const textSignScheduleScore = scoreForSignSchedule(text);
    if (legendScore >= 3 && textFloorPlanScore < 10) {
      return { pageNum, text, floorPlanScore: textFloorPlanScore, signScheduleScore: textSignScheduleScore, type: "other", titleBlockType };
    }
    return { pageNum, text, floorPlanScore: textFloorPlanScore, signScheduleScore: textSignScheduleScore, type: "both", titleBlockType };
  }
  if (titleBlockType === "sign_schedule") {
    const legendScore = scoreForLegendPage(text);
    const textFloorPlanScore = scoreForFloorPlan(text);
    if (legendScore >= 3 && textFloorPlanScore < 10) {
      return { pageNum, text, floorPlanScore: textFloorPlanScore, signScheduleScore: 0, type: "other", titleBlockType };
    }
    return { pageNum, text, floorPlanScore: 0, signScheduleScore: 0, type: "sign_schedule", titleBlockType };
  }
  if (titleBlockType === "floor_plan") {
    const legendScore = scoreForLegendPage(text);
    const textFloorPlanScore = scoreForFloorPlan(text);
    if (legendScore >= 3 && textFloorPlanScore < 10) {
      return { pageNum, text, floorPlanScore: textFloorPlanScore, signScheduleScore: 0, type: "other", titleBlockType };
    }
    return { pageNum, text, floorPlanScore: 0, signScheduleScore: 0, type: "floor_plan", titleBlockType };
  }

  // titleBlockType === "unknown" — fall through to text-scoring heuristics
  const textFloorPlanScore = scoreForFloorPlan(text);
  const textSignScheduleScore = scoreForSignSchedule(text);

  const legendScore = scoreForLegendPage(text);
  if (legendScore >= 3 && textFloorPlanScore < 10) {
    return { pageNum, text, floorPlanScore: textFloorPlanScore, signScheduleScore: textSignScheduleScore, type: "other", titleBlockType };
  }

  // Heuristic "both" detection
  if (textFloorPlanScore >= 8 && textSignScheduleScore >= 8) {
    const ratio = textFloorPlanScore / textSignScheduleScore;
    if (ratio >= 0.35 && ratio <= 2.85) {
      return { pageNum, text, floorPlanScore: textFloorPlanScore, signScheduleScore: textSignScheduleScore, type: "both", titleBlockType };
    }
  }

  let type: PageType = "other";
  if (textFloorPlanScore >= 4 && textFloorPlanScore >= textSignScheduleScore) {
    type = "floor_plan";
  } else if (textSignScheduleScore >= 4 && textSignScheduleScore > textFloorPlanScore) {
    type = "sign_schedule";
  } else if (textFloorPlanScore >= 4) {
    type = "floor_plan";
  } else if (textSignScheduleScore >= 4) {
    type = "sign_schedule";
  }

  return { pageNum, text, floorPlanScore: textFloorPlanScore, signScheduleScore: textSignScheduleScore, type, titleBlockType };
}
