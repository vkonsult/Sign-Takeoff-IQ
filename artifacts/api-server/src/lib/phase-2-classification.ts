/**
 * phase-2-classification.ts — Phase 2 of the SignTakeoff pipeline.
 *
 * Consolidates all page classification logic into a single dedicated module:
 *   - PDF bookmark overlay (primary source — most reliable)
 *   - Title block spatial pre-pass (3-pass cascade per page)
 *   - Full-page fallback for excerpt documents
 *
 * This replaces the inline `buildSheetManifest` call in `pdf-processor.ts` and
 * makes the Phase 2 boundary explicit in the pipeline step record.
 *
 * Downstream phases consume the returned `ClassificationResult` directly.
 */

import { buildSheetManifest, type SheetBucket, type SheetManifest } from "./sheet-manifest";
import { logger } from "./logger";
import type { IntakeResult } from "./phase-1-intake";

// ── Public types ───────────────────────────────────────────────────────────────

export interface ClassificationResult {
  /** 1-based page numbers classified as floor plan sheets. */
  floorPlanPages: number[];
  /** 1-based page numbers classified as sign schedule / signage schedule sheets. */
  signSchedulePages: number[];
  /**
   * 1-based page numbers where a floor plan and sign schedule share the same page.
   * Empty in the current 10-bucket system (the "both" bucket was removed), but
   * preserved for backward compatibility with downstream consumers.
   */
  bothPages: number[];
  /** 1-based page numbers not classified as floor plan or sign schedule. */
  otherPages: number[];
  /**
   * Map from pdfPage → sheetTitle for entries whose source is "bookmark".
   * Callers can use this to display the original PDF bookmark label for a page.
   */
  bookmarkPageMap: Map<number, string>;
  /**
   * Map from pdfPage → SheetBucket for every classified page.
   * Provides the full 10-bucket type for advanced consumers.
   */
  spatialPageTypes: Map<number, SheetBucket>;
  /** Map from pdfPage → normalized floor level name (e.g. "Level 2", "Main"). */
  spatialFloorLevelNames: Map<number, string>;
  /** Raw manifest for consumers that need low-level entry details. */
  manifest: SheetManifest;
}

// ── Main runner ────────────────────────────────────────────────────────────────

/**
 * Run Phase 2 — Page Classification.
 *
 * @param filePath   Absolute path to the uploaded PDF.
 * @param fileId     Database ID of the job file row (used for phrase caching).
 * @param intakeResult  The Phase 1 IntakeResult for this file (currently reserved
 *                   for future use — level hints and building type can refine
 *                   classification in a later iteration).
 */
export async function runPhase2Classification(
  filePath: string,
  fileId: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  intakeResult: IntakeResult,
): Promise<ClassificationResult> {
  logger.info({ fileId }, "[Phase 2] Starting page classification");

  const manifest = await buildSheetManifest(filePath, fileId);

  manifest.warnings.forEach((w) =>
    logger.warn({ fileId, warning: w }, "[Phase 2] Sheet manifest warning")
  );

  // ── Derive page lists from manifest entries ──────────────────────────────

  const floorPlanPages: number[] = [];
  const signSchedulePages: number[] = [];
  const bothPages: number[] = []; // kept for interface compat; 10-bucket system has no "both"
  const classifiedSet = new Set<number>();

  const bookmarkPageMap = new Map<number, string>();
  const spatialPageTypes = new Map<number, SheetBucket>();
  const spatialFloorLevelNames = new Map<number, string>();

  for (const entry of manifest.entries) {
    spatialPageTypes.set(entry.pdfPage, entry.bucket);

    if (entry.source === "bookmark") {
      bookmarkPageMap.set(entry.pdfPage, entry.sheetTitle);
    }

    if (entry.level) {
      spatialFloorLevelNames.set(entry.pdfPage, entry.level);
    }

    if (entry.bucket === "floor_plan") {
      floorPlanPages.push(entry.pdfPage);
      classifiedSet.add(entry.pdfPage);
    } else if (entry.bucket === "signage_schedule") {
      signSchedulePages.push(entry.pdfPage);
      classifiedSet.add(entry.pdfPage);
    }
  }

  // otherPages = all pages (1..totalPages) not in floorPlan or signSchedule.
  const otherPages: number[] = [];
  for (let p = 1; p <= manifest.totalPages; p++) {
    if (!classifiedSet.has(p)) otherPages.push(p);
  }

  // ── Per-page diagnostic log for floor_plan and signage_schedule pages ───────
  // Emitted at Phase 2 completion so future misclassifications can be diagnosed
  // without re-running in debug mode.  Includes the source (bookmark / index_page /
  // title_block / full_page_fallback) and the text / sheet number that triggered
  // the match.
  for (const entry of manifest.entries) {
    if (entry.bucket === "floor_plan" || entry.bucket === "signage_schedule") {
      logger.info(
        {
          fileId,
          page: entry.pdfPage,
          bucket: entry.bucket,
          source: entry.source,
          sheetTitle: entry.sheetTitle,
          sheetNumber: entry.sheetNumber,
        },
        "[Phase 2] Classified page",
      );
    }
  }

  logger.info(
    {
      fileId,
      totalPages: manifest.totalPages,
      floorPlan: floorPlanPages.length,
      signSchedule: signSchedulePages.length,
      other: otherPages.length,
      isExcerpt: manifest.isExcerpt,
    },
    "[Phase 2] Classification complete",
  );

  return {
    floorPlanPages,
    signSchedulePages,
    bothPages,
    otherPages,
    bookmarkPageMap,
    spatialPageTypes,
    spatialFloorLevelNames,
    manifest,
  };
}
