/**
 * PDF Processor — all non-AI processing logic.
 * This module handles page classification, spatial analysis, PNG rendering,
 * raw text extraction, and coordinate matching without any Gemini AI calls.
 * processJob calls this module exclusively; AI calls are on-demand only.
 */

import path from "path";
import { eq, and } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  jobsTable,
  jobFilesTable,
  extractedSignsTable,
  type ProcessingStep,
} from "@workspace/db";

import { extractTextFromPdf, isSpecFile } from "./extraction";
import { extractSignsHeuristic } from "./extraction-heuristic";
import { FLOOR_PLAN_EXCLUSION_PHRASES, isCodeOnlyLocation } from "./sign-vocabulary";
import { saveParsedResult, getFilePageImagesDir, PAGES_DIR } from "./storage";
import { renderFloorPlanPages } from "./pdf-render";
import { logger } from "./logger";
import {
  extractPagePhrases,
  matchLocationToCoords,
  classifyPageFromPhrases,
  extractFloorLevelName,
  extractTitleBlockBuildingType,
  extractPdfMetadata,
  type PdfPhrase,
  type SpatialPageType,
} from "./pdf-words";

export async function runPdfProcessor(jobId: string): Promise<void> {
  const pipelineSteps: ProcessingStep[] = [];
  const jobStart = Date.now();

  function recordStep(
    step: string,
    label: string,
    stepStart: number,
    details?: Record<string, unknown>,
  ): void {
    pipelineSteps.push({
      step,
      label,
      durationMs: Date.now() - stepStart,
      startedAt: new Date(stepStart).toISOString(),
      details,
    });
  }

  // ── Preserve verified + manually-added signs ──────────────────────────────
  const existingSigns = await db
    .select()
    .from(extractedSignsTable)
    .where(eq(extractedSignsTable.jobId, jobId));

  const preservedSigns = existingSigns.filter((s) => s.userVerified || s.manuallyAdded);

  logger.info({ jobId, preservedCount: preservedSigns.length }, "[PDF Processor] Preserved verified/manually-added signs");

  // Delete all auto-extracted signs (both pdf and ai), keep only user-verified / manually-added
  await db
    .delete(extractedSignsTable)
    .where(
      and(
        eq(extractedSignsTable.jobId, jobId),
        eq(extractedSignsTable.userVerified, false),
        eq(extractedSignsTable.manuallyAdded, false)
      )
    );

  // Reset page classification so the UI shows a clean state while re-processing
  await db
    .update(jobFilesTable)
    .set({ pageStats: null, pageCount: null })
    .where(eq(jobFilesTable.jobId, jobId));

  await db
    .update(jobsTable)
    .set({ status: "processing", updatedAt: new Date() })
    .where(eq(jobsTable.id, jobId));

  const files = await db
    .select()
    .from(jobFilesTable)
    .where(eq(jobFilesTable.jobId, jobId));

  if (files.length === 0) {
    await db
      .update(jobsTable)
      .set({ status: "failed", error: "No files found for this job", updatedAt: new Date() })
      .where(eq(jobsTable.id, jobId));
    return;
  }

  // ── Spec vs data file routing ─────────────────────────────────────────────
  const specFiles = files.filter((f) => isSpecFile(f.originalName));
  const dataFiles = files.filter((f) => !isSpecFile(f.originalName));
  const hasDataFiles = dataFiles.length > 0;

  // Extract raw text from spec files for metadata (no AI)
  if (specFiles.length > 0 && hasDataFiles) {
    const t_spec = Date.now();
    for (const specFile of specFiles) {
      try {
        const { pages } = await extractTextFromPdf(specFile.storedPath, specFile.id);
        const raw = pages.map((p) => p.text).join("\n");
        await db
          .update(jobFilesTable)
          .set({ pageCount: pages.length, extractedText: raw.slice(0, 10000) })
          .where(eq(jobFilesTable.id, specFile.id));
      } catch (err) {
        logger.warn({ err, fileName: specFile.originalName }, "[PDF Processor] Failed to extract spec file text");
      }
    }
    recordStep("spec_processing", "Spec file processing (text-only)", t_spec, { specFileCount: specFiles.length });
  }

  const filesToProcess = hasDataFiles ? dataFiles : files;

  // ── Per-file processing ───────────────────────────────────────────────────
  const parsedResults: Record<string, unknown>[] = [];
  const allPageImagePaths = new Map<string, Record<string, string>>();
  const allSpatialPageTypes = new Map<string, Map<number, SpatialPageType>>();
  const allSpatialFloorLevelNames = new Map<string, Map<number, string>>();
  const fileFloorPlanPages = new Map<string, Set<number>>();

  // Building type is detected from the title block of the first/cover page
  // and shared across all files in this job.  Set once; never overwritten.
  let detectedBuildingType: string | null = null;

  const t_extraction = Date.now();

  await Promise.all(
    filesToProcess.map(async (file) => {
      try {
        logger.info({ jobId, file: file.originalName }, "[PDF Processor] Processing file");

        // ── Spatial pre-pass ──────────────────────────────────────────────
        let spatialPageTypes: Map<number, SpatialPageType> | undefined;
        let spatialFloorLevelNames: Map<number, string> | undefined;
        let bookmarkTitles: Record<number, string> | undefined;
        let outlineSections: Array<{ title: string; pageStart: number; pageEnd: number; type: "floor_plan" | "sign_schedule" | "other" | null }> | undefined;
        // Hoisted so the bookmark-title veto (applied after text extraction) can access it.
        const bookmarkPageMap = new Map<number, { title: string; type: "floor_plan" | "sign_schedule" | "other" | null }>();
        const t_spatial = Date.now();
        try {
          const { getPdfPageCount } = await import("./pdf-words");
          const numPages = await getPdfPageCount(file.storedPath);
          spatialPageTypes = new Map<number, SpatialPageType>();
          spatialFloorLevelNames = new Map<number, string>();

          // ── Bookmark extraction ────────────────────────────────────────
          // Load PDF outline to build a pageNum→bookmark map (title + classified type).
          // Bookmark classification is the primary signal; phrase-based
          // classification is the fallback when no bookmark covers a page.
          try {
            const pdfMeta = await extractPdfMetadata(file.storedPath);
            if (pdfMeta.outlineSections.length > 0) {
              outlineSections = pdfMeta.outlineSections.map((s) => ({
                title: s.title,
                pageStart: s.pageStart,
                pageEnd: s.pageEnd,
                type: (s.type === "both" ? "floor_plan" : s.type) as "floor_plan" | "sign_schedule" | "other" | null,
              }));
            }
            for (const section of pdfMeta.outlineSections) {
              for (let p = section.pageStart; p <= section.pageEnd; p++) {
                if (!bookmarkPageMap.has(p)) {
                  bookmarkPageMap.set(p, { title: section.title, type: section.type });
                }
              }
            }
          } catch (err) {
            logger.warn({ err, file: file.originalName }, "[PDF Processor] Bookmark extraction failed — falling back to phrase classification");
          }

          await Promise.all(
            Array.from({ length: numPages }, (_, i) => i + 1).map(async (pageNum) => {
              try {
                const pageWords = await extractPagePhrases(file.storedPath, file.id, pageNum);

                let spatialType: SpatialPageType;
                const bookmark = bookmarkPageMap.get(pageNum);

                if (bookmark) {
                  // Primary signal: bookmark covers this page — use its classification directly.
                  // "floor_plan" and "sign_schedule" map directly to SpatialPageType.
                  // "other" and null map to "unknown" (page is excluded, not re-promoted).
                  if (bookmark.type === "floor_plan" || bookmark.type === "sign_schedule") {
                    spatialType = bookmark.type as SpatialPageType;
                  } else {
                    spatialType = "unknown";
                  }
                } else {
                  // No bookmark covers this page — fall back to phrase-based classification.
                  spatialType = classifyPageFromPhrases(pageWords.phrases).type;
                }

                spatialPageTypes!.set(pageNum, spatialType);
                if (spatialType === "floor_plan" || spatialType === "both") {
                  const levelName = extractFloorLevelName(pageWords.phrases);
                  if (levelName) spatialFloorLevelNames!.set(pageNum, levelName);
                }
              } catch {
                // individual page failures are non-fatal
              }
            })
          );

          // Build bookmarkTitles record for pageStats
          if (bookmarkPageMap.size > 0) {
            bookmarkTitles = {};
            for (const [pageNum, bm] of bookmarkPageMap) {
              bookmarkTitles[pageNum] = bm.title;
            }
          }

          const floorPlanCount = [...spatialPageTypes.values()].filter((t) => t === "floor_plan").length;
          const bothCount = [...spatialPageTypes.values()].filter((t) => t === "both").length;
          const fpSet = new Set<number>();
          for (const [pageNum, type] of spatialPageTypes) {
            if (type === "floor_plan" || type === "both") fpSet.add(pageNum);
          }
          fileFloorPlanPages.set(file.id, fpSet);
          allSpatialPageTypes.set(file.id, spatialPageTypes);
          allSpatialFloorLevelNames.set(file.id, spatialFloorLevelNames);

          // ── Building-type detection from title block (PDF text only) ──────
          // Scan the first page's title-block region for project name keywords
          // and map them to a canonical building type.  The phrase cache is
          // already warm from the spatial pre-pass loop above so this is cheap.
          try {
            const firstPagePhrases = await extractPagePhrases(file.storedPath, file.id, 1);
            const detected = extractTitleBlockBuildingType(firstPagePhrases.phrases);
            if (detected && !detectedBuildingType) {
              detectedBuildingType = detected;
              logger.info({ jobId, fileId: file.id, buildingType: detected }, "[PDF Processor] Building type detected from title block");
            }
          } catch {
            // non-fatal
          }

          pipelineSteps.push({
            step: `spatial_prepass_${file.id}`,
            label: filesToProcess.length > 1 ? `Spatial pre-pass — ${file.originalName}` : "Spatial pre-pass",
            durationMs: Date.now() - t_spatial,
            startedAt: new Date(t_spatial).toISOString(),
            details: { pages: numPages, floorPlan: floorPlanCount, both: bothCount, bookmarks: bookmarkPageMap.size },
          });
        } catch (err) {
          logger.warn({ err, file: file.originalName }, "[PDF Processor] Spatial pre-pass failed");
        }

        // ── Raw text extraction (no AI) ───────────────────────────────────
        const t_text = Date.now();
        const { pages, numPages } = await extractTextFromPdf(file.storedPath, file.id);
        const rawText = pages.map((p) => p.text).join("\n");

        // Identify page types from raw classification
        const floorPlanPages: number[] = [];
        const signSchedulePages: number[] = [];
        const bothPages: number[] = [];
        const otherPages: number[] = [];
        for (const page of pages) {
          if (page.type === "floor_plan") floorPlanPages.push(page.pageNum);
          else if (page.type === "sign_schedule") signSchedulePages.push(page.pageNum);
          else if (page.type === "both") { bothPages.push(page.pageNum); }
          else otherPages.push(page.pageNum);
        }

        // Override with spatial classification where available
        const spatialFp: number[] = [];
        const spatialSs: number[] = [];
        const spatialBoth: number[] = [];
        if (spatialPageTypes) {
          for (const [pageNum, type] of spatialPageTypes) {
            if (type === "floor_plan") spatialFp.push(pageNum);
            else if (type === "sign_schedule") spatialSs.push(pageNum);
            else if (type === "both") spatialBoth.push(pageNum);
          }
        }

        const finalFloorPlanPages = spatialFp.length > 0 ? spatialFp : floorPlanPages;

        // Merge spatial and text-extraction sign-schedule results, then apply vetoes:
        //  1. Bookmark-title veto: bookmark containing exclusion keywords → not a sign schedule.
        //  2. Text-phrase veto (unbookmarked spatial pages only): if spatial detection flagged
        //     a page that text extraction DID NOT flag, and the page text contains exclusion
        //     phrases but zero sign-schedule phrases, reject it (likely a grid/table layout
        //     like an electrical panel schedule that mimics a sign schedule visually).
        const rawSs = spatialSs.length > 0 ? spatialSs : signSchedulePages;
        const signSchedulePageSet = new Set(signSchedulePages);
        const finalSignSchedulePages = (await Promise.all(
          rawSs.map(async (pg) => {
            // Veto 1: bookmark title contains exclusion keyword
            const bm = bookmarkPageMap.get(pg);
            if (bm) {
              const t = bm.title.toLowerCase();
              if (FLOOR_PLAN_EXCLUSION_PHRASES.some((p) => t.includes(p))) return null;
            }

            // Veto 2: unbookmarked page that spatial detected but text extraction missed
            if (!bm && spatialSs.length > 0 && !signSchedulePageSet.has(pg)) {
              try {
                const { extractPagePhrases } = await import("./pdf-words");
                const { phrases } = await extractPagePhrases(file.storedPath, file.id, pg);
                const pageText = phrases.map((p) => p.text).join(" ").toLowerCase();
                const hasSsPhrases = SIGN_SCHEDULE_PHRASES.some((p) => pageText.includes(p));
                const hasExclusion = FLOOR_PLAN_EXCLUSION_PHRASES.some((p) => pageText.includes(p));
                if (!hasSsPhrases && hasExclusion) return null;
              } catch {
                // phrase extraction failed — keep the spatial result
              }
            }

            return pg;
          })
        )).filter((pg): pg is number => pg !== null);

        const finalBothPages = spatialBoth.length > 0 ? spatialBoth : bothPages;

        recordStep(`text_extraction_${file.id}`,
          filesToProcess.length > 1 ? `Text extraction — ${file.originalName}` : "Text extraction",
          t_text,
          { pages: numPages }
        );

        // ── PNG pre-render for floor plan pages ───────────────────────────
        let pageImagePathsRelative: Record<string, string> | null = null;
        let pageImagePathsAbsolute: Record<string, string> | null = null;
        const pngPageNums = Array.from(new Set([...finalFloorPlanPages, ...finalBothPages])).sort((a, b) => a - b);
        if (pngPageNums.length > 0) {
          try {
            const t_render = Date.now();
            const outputDir = getFilePageImagesDir(file.id);
            const rendered = await renderFloorPlanPages(file.storedPath, pngPageNums, outputDir);
            if (rendered.size > 0) {
              pageImagePathsRelative = {};
              pageImagePathsAbsolute = {};
              const pagesParent = path.dirname(PAGES_DIR);
              for (const [pageNum, absPath] of rendered) {
                pageImagePathsRelative[String(pageNum)] = path.relative(pagesParent, absPath);
                pageImagePathsAbsolute[String(pageNum)] = absPath;
              }
              allPageImagePaths.set(file.id, pageImagePathsRelative);
            }
            logger.info({ fileId: file.id, pagesRendered: rendered.size, durationMs: Date.now() - t_render }, "[PDF Processor] PNG pre-render complete");
          } catch (err) {
            logger.warn({ err, fileId: file.id }, "[PDF Processor] PNG pre-render failed — non-fatal");
          }
        }

        // ── Heuristic sign extraction (no AI) ────────────────────────────
        // Extract sign rows using the regex/spatial algorithm, then insert into DB.
        // These become the initial sign data for the job (dataSource: "pdf").
        try {
          const t_heuristic = Date.now();
          const fpPagesForHeuristic = fileFloorPlanPages.get(file.id);
          const { rows: heuristicRows } = await extractSignsHeuristic(file.storedPath, file.id, fpPagesForHeuristic, detectedBuildingType);
          if (heuristicRows.length > 0) {
            const insertRows = heuristicRows.map((row) => ({
              ...row,
              jobId,
              jobFileId: file.id,
              dataSource: "pdf" as const,
              userVerified: false,
              manuallyAdded: false,
            }));
            const CHUNK = 200;
            for (let i = 0; i < insertRows.length; i += CHUNK) {
              await db.insert(extractedSignsTable).values(insertRows.slice(i, i + CHUNK));
            }
            logger.info({ jobId, fileId: file.id, inserted: heuristicRows.length, durationMs: Date.now() - t_heuristic }, "[PDF Processor] Heuristic sign extraction complete");
          }
        } catch (err) {
          logger.warn({ err, fileId: file.id }, "[PDF Processor] Heuristic extraction failed — non-fatal");
        }

        // ── Persist file metadata ─────────────────────────────────────────
        const floorPageLevels = spatialFloorLevelNames && spatialFloorLevelNames.size > 0
          ? Object.fromEntries(spatialFloorLevelNames)
          : undefined;

        const pageStats = {
          floorPlanPages: finalFloorPlanPages,
          signSchedulePages: finalSignSchedulePages,
          bothPages: finalBothPages,
          otherPages,
          ...(pageImagePathsRelative ? { pageImagePaths: pageImagePathsRelative } : {}),
          ...(floorPageLevels ? { floorPageLevels } : {}),
          ...(bookmarkTitles ? { bookmarkTitles } : {}),
          ...(outlineSections ? { outlineSections } : {}),
        };

        await db
          .update(jobFilesTable)
          .set({ pageCount: numPages, extractedText: rawText.slice(0, 10000), pageStats })
          .where(eq(jobFilesTable.id, file.id));

        parsedResults.push({ fileId: file.id, fileName: file.originalName, pageCount: numPages });
      } catch (err) {
        logger.error({ err, fileId: file.id, fileName: file.originalName }, "[PDF Processor] File processing failed");
        parsedResults.push({ fileId: file.id, fileName: file.originalName, error: String(err) });
      }
    })
  );

  recordStep("extraction", "PDF processing (all files)", t_extraction, {
    fileCount: filesToProcess.length,
    succeeded: parsedResults.filter((r) => !("error" in r)).length,
    failed: parsedResults.filter((r) => "error" in r).length,
  });

  // ── Word-match coordinate assignment for preserved signs ──────────────────
  // Re-run coordinate matching for preserved signs that may have lost their positions.
  if (preservedSigns.length > 0) {
    const t_wordmatch = Date.now();
    const filePathById = new Map<string, string>(filesToProcess.map((f) => [f.id, f.storedPath]));

    type PageCache = { phrases: PdfPhrase[] };
    const pageCache = new Map<string, PageCache>();

    async function getPageData(fileStoredPath: string, fileId: string, page: number): Promise<PageCache> {
      const key = `${fileId}:${page}`;
      const cached = pageCache.get(key);
      if (cached) return cached;
      try {
        const pageWords = await extractPagePhrases(fileStoredPath, fileId, page);
        const entry: PageCache = { phrases: pageWords.phrases };
        pageCache.set(key, entry);
        return entry;
      } catch {
        const entry: PageCache = { phrases: [] };
        pageCache.set(key, entry);
        return entry;
      }
    }

    // For each preserved sign without coordinates, attempt word-match
    const updatedSigns: Array<{ id: string; xPos: number; yPos: number; placementSource: string }> = [];
    for (const sign of preservedSigns) {
      if (sign.xPos != null && sign.yPos != null) continue; // already placed
      if (!sign.jobFileId || !sign.pageNumber) continue;
      // Skip code-only locations — they have no real room label to match on the floor plan
      if (sign.location && isCodeOnlyLocation(sign.location)) continue;
      const storedPath = filePathById.get(sign.jobFileId);
      if (!storedPath) continue;

      const fpPages = fileFloorPlanPages.get(sign.jobFileId);
      if (fpPages !== undefined && !fpPages.has(sign.pageNumber)) continue;

      try {
        const pageData = await getPageData(storedPath, sign.jobFileId, sign.pageNumber);
        const excl = new Set<string>();
        const match = matchLocationToCoords(pageData.phrases, sign.location, sign.signIdentifier, excl);
        if (match) {
          updatedSigns.push({ id: sign.id, xPos: match.xPos, yPos: match.yPos, placementSource: "word_match" });
        }
      } catch {
        // non-fatal
      }
    }

    // Batch update coordinates for matched preserved signs
    for (const update of updatedSigns) {
      await db
        .update(extractedSignsTable)
        .set({ xPos: update.xPos, yPos: update.yPos, placementSource: update.placementSource })
        .where(eq(extractedSignsTable.id, update.id));
    }

    recordStep("word_match", "Coordinate matching (preserved signs)", t_wordmatch, {
      totalPreserved: preservedSigns.length,
      matched: updatedSigns.length,
    });
  }

  // ── Finalize ──────────────────────────────────────────────────────────────
  await saveParsedResult(jobId, parsedResults);

  const failedCount = parsedResults.filter((r) => "error" in r).length;
  const allFailed = failedCount === files.length;

  recordStep("total", "Total pipeline", jobStart);

  if (allFailed) {
    const errorSummary = parsedResults
      .filter((r): r is { fileId: string; fileName: string; error: string } => "error" in r)
      .map((r) => `${r.fileName}: ${r.error}`)
      .join("; ");
    await db
      .update(jobsTable)
      .set({ status: "failed", error: `All files failed processing: ${errorSummary}`, processingLog: pipelineSteps, updatedAt: new Date() })
      .where(eq(jobsTable.id, jobId));
    return;
  }

  await db
    .update(jobsTable)
    .set({
      status: "completed",
      processingLog: pipelineSteps,
      updatedAt: new Date(),
      ...(detectedBuildingType ? { buildingType: detectedBuildingType } : {}),
    })
    .where(eq(jobsTable.id, jobId));

  logger.info(
    { jobId, preservedSigns: preservedSigns.length, failed: failedCount, buildingType: detectedBuildingType },
    "[PDF Processor] Processing complete"
  );
}
