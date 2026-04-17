/**
 * phase-1-intake.ts — Phase 1 of the SignTakeoff pipeline.
 *
 * Responsibilities:
 *   - Classify each uploaded file as "spec" (CSI specification) or "data" (drawing set)
 *   - Detect the drawing index page (sheet list / sheet index)
 *   - Deterministically extract: project name, jurisdiction (AHJ), issue date
 *   - Detect building type from title-block text
 *   - Enumerate floor level names and a per-page level name map
 *
 * All extraction is deterministic (no AI calls).
 * Page metadata loops are sequential (not parallel) to guarantee "first page wins"
 * for fields like projectName and drawingIndexPageNum.
 *
 * Downstream phases consume the returned `IntakeResult` directly.
 * `extractFloorLevelName` is module-private (not exported) and may only be used
 * within this file.  `extractTitleBlockBuildingType` is exported from here and
 * may only be imported by `extraction.ts` (on-demand AI scan path); all default-
 * pipeline code must consume `IntakeResult.buildingType` instead.
 */

import {
  extractPagePhrases,
  isInTitleBlockZone,
  getPdfPageCount,
  CANONICAL_LEVEL_NAMES,
  type PdfPhrase,
} from "./pdf-words";
import { detectBuildingType, type CanonicalBuildingType } from "./sign-vocabulary";
import { logger } from "./logger";

// ── Public types ──────────────────────────────────────────────────────────────

export interface IntakeResult {
  /** "spec" = CSI specification document; "data" = drawing set */
  fileType: "spec" | "data";
  /** Project name extracted from title block, or null if not found */
  projectName: string | null;
  /** Authority Having Jurisdiction extracted from title block, or null */
  jurisdiction: string | null;
  /** Issue date string extracted from title block, or null */
  issueDate: string | null;
  /** Number of distinct floor levels detected across all pages */
  levelCount: number;
  /**
   * Unique floor level names sorted by canonical order
   * (lower level → main level → upper level → attic → lexical fallback).
   */
  levelNames: string[];
  /**
   * Per-page level name map: pageNum → level name string.
   * Only contains pages where a level name was detected.
   * Use this in place of calling `extractFloorLevelName` directly.
   */
  pageToLevelName: Record<number, string>;
  /** Canonical building type detected from the first page title block, or null */
  buildingType: CanonicalBuildingType | null;
  /** 1-based page number of the drawing index / sheet list, or null */
  drawingIndexPageNum: number | null;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const DRAWING_INDEX_PHRASES = [
  "drawing index",
  "sheet index",
  "sheet list",
  "index of drawings",
  "list of drawings",
  "drawing list",
];

const PROJECT_NAME_PATTERNS: RegExp[] = [
  /project\s+name\s*[:\-]\s*([^\n\r]{3,80})/i,
  /project\s*[:\-]\s*([^\n\r]{3,80})/i,
  /building\s+name\s*[:\-]\s*([^\n\r]{3,80})/i,
];

const JURISDICTION_PATTERNS: RegExp[] = [
  /(?:authority\s+having\s+jurisdiction|ahj)\s*[:\-]\s*([^\n\r]{3,80})/i,
  /jurisdiction\s*[:\-]\s*([^\n\r]{3,80})/i,
];

const ISSUE_DATE_PATTERNS: RegExp[] = [
  /issue\s*date\s*[:\-]?\s*(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4})/i,
  /issued\s*[:\-]\s*(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4})/i,
  /date\s+issued\s*[:\-]?\s*(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4})/i,
  /issue\s*date\s*[:\-]?\s*([A-Za-z]+\.?\s+\d{1,2},?\s+\d{4})/i,
  /issued\s*[:\-]\s*([A-Za-z]+\.?\s+\d{1,2},?\s+\d{4})/i,
];

// ── File-type classifier (filename-only, no I/O) ──────────────────────────────

/**
 * Classify an uploaded file as a CSI specification ("spec") or a drawing set
 * ("data") based solely on the filename.  This is the authoritative replacement
 * for the old `isSpecFile` helper in `extraction.ts`.
 */
export function classifyFileType(filename: string): "spec" | "data" {
  const lower = filename.toLowerCase().replace(/[^a-z0-9]/g, " ");
  // CSI section 10 14 XX patterns (e.g. "10-14-00", "10_14", "101400")
  if (/10\s*14/.test(lower)) return "spec";
  // Explicit "spec(s)" or "specification" near "sign" or "signage"
  if (
    (lower.includes("spec") || lower.includes("specification")) &&
    (lower.includes("sign") || lower.includes("signage"))
  )
    return "spec";
  return "data";
}

// ── Title-block helpers (owned exclusively by this module) ────────────────────

/**
 * Extract a normalized floor level name from a page's title-block phrases.
 * Returns the matched canonical level name string or null when no level
 * indicator is found.
 *
 * Exported for use by `rule-engine.ts` (per-sign floor-level attribution).
 * All other callers should prefer the pre-computed `IntakeResult.levelNames`.
 */
export function extractFloorLevelName(phrases: PdfPhrase[]): string | null {
  if (phrases.length === 0) return null;
  const titleBlockPhrases = phrases.filter(isInTitleBlockZone);
  const combined = (titleBlockPhrases.length > 0 ? titleBlockPhrases : phrases)
    .map((p) => p.text)
    .join(" ")
    .toLowerCase();
  for (const level of CANONICAL_LEVEL_NAMES) {
    if (combined.includes(level)) return level;
  }
  return null;
}

/**
 * Detect a canonical building type from a page's title-block phrases.
 *
 * Exported so that the on-demand AI scan path in
 * `extraction.ts::extractFloorPlanOnly` can call it without importing from
 * `pdf-words`.  All default-pipeline code must consume
 * `IntakeResult.buildingType` rather than calling this function directly.
 */
export function extractTitleBlockBuildingType(phrases: PdfPhrase[]): CanonicalBuildingType | null {
  if (phrases.length === 0) return null;
  const titleBlockPhrases = phrases.filter(isInTitleBlockZone);
  const searchText = (titleBlockPhrases.length > 0 ? titleBlockPhrases : phrases)
    .map((p) => p.text)
    .join(" ");
  return detectBuildingType(searchText);
}

// ── Private helpers ───────────────────────────────────────────────────────────

function extractFirst(text: string, patterns: RegExp[]): string | null {
  for (const pat of patterns) {
    const m = text.match(pat);
    if (m?.[1]) return m[1].trim();
  }
  return null;
}

/**
 * Sort level names by canonical order (lower → main → upper → attic),
 * then lexically for any names not in the canonical list.
 */
function sortLevelNames(names: Iterable<string>): string[] {
  const arr = Array.from(names);
  const canonical: readonly string[] = CANONICAL_LEVEL_NAMES;
  return arr.sort((a, b) => {
    const ai = canonical.indexOf(a);
    const bi = canonical.indexOf(b);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a.localeCompare(b);
  });
}

// ── Public Phase 1 runner ─────────────────────────────────────────────────────

/**
 * Run Phase 1 intake for a single PDF file.
 *
 * Processing is intentionally sequential for fields that are "first page wins"
 * (projectName, jurisdiction, issueDate, drawingIndexPageNum, buildingType).
 * Level name enumeration is also sequential to guarantee deterministic ordering.
 *
 * @param filePath   Absolute path to the PDF on disk.
 * @param filename   Original upload filename (used for spec/data classification).
 * @param fileId     Optional stable ID used as the phrase-cache key.  Pass the
 *                   database job-file ID when available so the phrase cache is
 *                   shared with the subsequent spatial pre-pass — making those
 *                   calls essentially free.
 */
export async function runPhase1Intake(
  filePath: string,
  filename: string,
  fileId?: string,
): Promise<IntakeResult> {
  const cacheKey = fileId ?? filePath;
  const fileType = classifyFileType(filename);

  let projectName: string | null = null;
  let jurisdiction: string | null = null;
  let issueDate: string | null = null;
  let buildingType: CanonicalBuildingType | null = null;
  let drawingIndexPageNum: number | null = null;
  const levelNameSet = new Set<string>();
  const pageToLevelName: Record<number, string> = {};

  try {
    const numPages = await getPdfPageCount(filePath);

    // ── Metadata pass: first 10 pages, sequential ─────────────────────────
    // Sequential so "first page that matches" wins deterministically.
    // Building type is read from the first page's title block only.
    // Project name, jurisdiction, and issue date fill forward until found.
    const metaPageCount = Math.min(10, numPages);
    for (let pageNum = 1; pageNum <= metaPageCount; pageNum++) {
      try {
        const pw = await extractPagePhrases(filePath, cacheKey, pageNum);
        const pageText = pw.phrases.map((p) => p.text).join("\n");

        // Building type — from the first page title block only.
        if (pageNum === 1) {
          buildingType = extractTitleBlockBuildingType(pw.phrases);
        }

        // Fill metadata gaps scanning forward through early pages.
        if (!projectName) projectName = extractFirst(pageText, PROJECT_NAME_PATTERNS);
        if (!jurisdiction) jurisdiction = extractFirst(pageText, JURISDICTION_PATTERNS);
        if (!issueDate) issueDate = extractFirst(pageText, ISSUE_DATE_PATTERNS);
      } catch {
        // non-fatal per-page failure — continue to next page
      }
    }

    // ── Full-document pass: all pages, sequential ────────────────────────
    // Collects level names + per-page level map.
    // Drawing-index detection also runs here (not limited to first N pages)
    // since atypical drawing sets may place the sheet index anywhere in the
    // document.  Sequential order ensures the lowest-numbered matching page
    // wins deterministically for drawingIndexPageNum.
    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
      try {
        const pw = await extractPagePhrases(filePath, cacheKey, pageNum);
        const pageTextLower = pw.phrases.map((p) => p.text).join("\n").toLowerCase();

        // Drawing index detection — first matching page wins.
        if (
          drawingIndexPageNum === null &&
          DRAWING_INDEX_PHRASES.some((phrase) => pageTextLower.includes(phrase))
        ) {
          drawingIndexPageNum = pageNum;
        }

        const levelName = extractFloorLevelName(pw.phrases);
        if (levelName) {
          levelNameSet.add(levelName);
          pageToLevelName[pageNum] = levelName;
        }
      } catch {
        // non-fatal per-page failure — continue to next page
      }
    }
  } catch (err) {
    logger.warn(
      { err, filePath, filename },
      "[Phase 1 Intake] PDF read failed — returning classification-only result",
    );
  }

  const levelNames = sortLevelNames(levelNameSet);

  logger.info(
    {
      filename,
      fileType,
      projectName,
      jurisdiction,
      issueDate,
      buildingType,
      drawingIndexPageNum,
      levelCount: levelNames.length,
      levelNames,
    },
    "[Phase 1 Intake] Complete",
  );

  return {
    fileType,
    projectName,
    jurisdiction,
    issueDate,
    levelCount: levelNames.length,
    levelNames,
    pageToLevelName,
    buildingType,
    drawingIndexPageNum,
  };
}
