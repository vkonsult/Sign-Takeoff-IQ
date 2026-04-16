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
  signTypeSpecsTable,
  signageScheduleEntriesTable,
  type ProcessingStep,
} from "@workspace/db";

import { extractTextFromPdf, isSpecFile } from "./extraction";
import { extractSignsHeuristic } from "./extraction-heuristic";
import { FLOOR_PLAN_EXCLUSION_PHRASES, SIGN_SCHEDULE_PHRASES, isCodeOnlyLocation } from "./sign-vocabulary";
import { saveParsedResult, getFilePageImagesDir, PAGES_DIR } from "./storage";
import { renderFloorPlanPages } from "./pdf-render";
import { logger } from "./logger";
import {
  extractPagePhrases,
  extractRawPageItems,
  matchLocationToCoords,
  classifyPageFromPhrases,
  extractFloorLevelName,
  extractTitleBlockBuildingType,
  extractPdfMetadata,
  extractCodeProximityPairs,
  type PdfPhrase,
  type SpatialPageType,
} from "./pdf-words";
import {
  extractSignageData,
  type SignTypeSpec,
  type ScheduleEntry,
} from "./signage-schedule-parser";

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

  // ── Preserve verified + manually-added signs ─────────────────────────────
  // All auto-extracted signs (heuristic and AI) are wiped on rescan and re-derived
  // from the PDF. Only user-verified and manually-added signs survive.
  const existingSigns = await db
    .select()
    .from(extractedSignsTable)
    .where(eq(extractedSignsTable.jobId, jobId));

  const preservedSigns = existingSigns.filter(
    (s) => s.userVerified || s.manuallyAdded
  );

  logger.info({ jobId, preservedCount: preservedSigns.length }, "[PDF Processor] Preserved verified/manually-added signs");

  // Delete all auto-extracted signs (heuristic and AI); keep only user-verified and manually-added
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

  // Accumulate schedule parser results across all files for batch DB insertion
  const allScheduleSpecs: Array<SignTypeSpec & { fileId: string; fileStoredPath: string }> = [];
  const allScheduleEntries: Array<ScheduleEntry & { fileId: string }> = [];

  // Building type is detected from the title block of the first/cover page
  // and shared across all files in this job.  Set once; never overwritten.
  let detectedBuildingType: string | null = null;

  const t_extraction = Date.now();

  await Promise.all(
    filesToProcess.map(async (file) => {
      try {
        logger.info({ jobId, file: file.originalName }, "[PDF Processor] Processing file");

        // Read any previously rejected page numbers so they are preserved across re-runs.
        const existingRejectedPages: number[] = (file.pageStats as { rejectedPageNumbers?: number[] } | null)?.rejectedPageNumbers ?? [];

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
                  bookmarkPageMap.set(p, { title: section.title, type: (section.type === "both" ? "floor_plan" : section.type) as "floor_plan" | "sign_schedule" | "other" | null });
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
                  // For floor-plan candidates, additionally require that a valid floor level
                  // name can be extracted. Without a level name, an incidental "floor plan"
                  // reference in a legend or callout is too ambiguous to classify the page
                  // as a floor plan — downgrade to unknown.
                  const phraseResult = classifyPageFromPhrases(pageWords.phrases);
                  if (phraseResult.type === "floor_plan" || phraseResult.type === "both") {
                    const levelName = extractFloorLevelName(pageWords.phrases);
                    if (levelName) {
                      spatialType = phraseResult.type;
                    } else if (phraseResult.type === "both") {
                      // Floor plan evidence is unconfirmed (no level extractable) but
                      // sign-schedule evidence is still valid — keep sign_schedule.
                      spatialType = "sign_schedule";
                    } else {
                      // Pure floor-plan candidate with no level: downgrade to unknown.
                      spatialType = "unknown";
                    }
                  } else {
                    spatialType = phraseResult.type;
                  }
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

        // Re-sync fileFloorPlanPages with the fallback-aware final sets so that
        // heuristic and code-proximity extraction run on all correctly-identified
        // floor plan pages (spatial pre-pass alone may return empty if the page
        // title block doesn't match floor-plan keywords, while text extraction
        // classifies those same pages correctly).
        fileFloorPlanPages.set(file.id, new Set([...finalFloorPlanPages, ...finalBothPages]));

        recordStep(`text_extraction_${file.id}`,
          filesToProcess.length > 1 ? `Text extraction — ${file.originalName}` : "Text extraction",
          t_text,
          { pages: numPages }
        );

        // ── PNG pre-render for floor plan pages ───────────────────────────
        let pageImagePathsRelative: Record<string, string> | null = null;
        let pageImagePathsAbsolute: Record<string, string> | null = null;
        const pngPageNums = Array.from(new Set([...finalFloorPlanPages, ...finalSignSchedulePages, ...finalBothPages])).sort((a, b) => a - b);
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

        // ── Code-proximity extraction (raw_text rows) ─────────────────────
        // Scan every floor-plan page for callout codes (e.g. A-101) spatially
        // adjacent to room/area text labels (WORSHIP, STAGE, LOBBY, etc.) and
        // store them as extraction_method="raw_text" rows.  These rows surface in
        // the Sign Table and Coordinates Tab as "Code + TEXT" candidates.
        try {
          const t_cp = Date.now();
          const fpPages = Array.from(fileFloorPlanPages.get(file.id) ?? []).sort((a, b) => a - b);
          if (fpPages.length > 0) {
            const allCpPairs = (
              await Promise.all(
                fpPages.map(async (pageNum) => {
                  try {
                    const pw = await extractPagePhrases(file.storedPath, file.id, pageNum);
                    return extractCodeProximityPairs(pw, pageNum);
                  } catch {
                    return [];
                  }
                })
              )
            ).flat();

            if (allCpPairs.length > 0) {
              // Deduplicate by code+location+page
              const seen = new Set<string>();
              const cpInsertRows = allCpPairs
                .filter((pair) => {
                  const key = `${pair.code.toUpperCase()}||${pair.label.toUpperCase()}||${pair.page}`;
                  if (seen.has(key)) return false;
                  seen.add(key);
                  return true;
                })
                .map((pair) => ({
                  jobId,
                  jobFileId: file.id,
                  signIdentifier: pair.code,
                  location: pair.label,
                  pageNumber: pair.page,
                  xPos: pair.x,
                  yPos: pair.y,
                  confidenceScore: 0.7,
                  extractionMethod: "raw_text" as const,
                  dataSource: "pdf" as const,
                  userVerified: false,
                  manuallyAdded: false,
                  reviewFlag: false,
                }));
              const CHUNK = 200;
              for (let i = 0; i < cpInsertRows.length; i += CHUNK) {
                await db.insert(extractedSignsTable).values(cpInsertRows.slice(i, i + CHUNK));
              }
              logger.info({ jobId, fileId: file.id, inserted: cpInsertRows.length, durationMs: Date.now() - t_cp }, "[PDF Processor] Code-proximity (raw_text) extraction complete");
            }
          }
        } catch (err) {
          logger.warn({ err, fileId: file.id }, "[PDF Processor] Code-proximity extraction failed — non-fatal");
        }

        // ── Signage schedule spatial parsing (no AI) ──────────────────────
        // Parse pages classified as sign_schedule using the deterministic spatial parser.
        {
          const schedulePageNums = [...new Set([...finalSignSchedulePages, ...finalBothPages])].sort((a, b) => a - b);
          if (schedulePageNums.length > 0) {
            try {
              const t_schedule = Date.now();
              const mergedSpecs = new Map<string, SignTypeSpec & { fileId: string; fileStoredPath: string }>();
              const fileEntries: Array<ScheduleEntry & { fileId: string }> = [];

              for (const pageNum of schedulePageNums) {
                try {
                  // Use raw (unmerged) pdfjs text items for the spatial schedule parser
                  // to preserve individual table-cell boundaries (phrase merging collapses cells)
                  const { items: rawItems, pageWidth, pageHeight } = await extractRawPageItems(file.storedPath, pageNum);
                  const result = extractSignageData(rawItems, pageNum, pageWidth, pageHeight);

                  // Merge specs: same typeCode → same spec (later pages override if same code appears)
                  for (const spec of result.specs) {
                    const key = spec.typeCode.toUpperCase();
                    const existing = mergedSpecs.get(key);
                    if (!existing) {
                      mergedSpecs.set(key, { ...spec, fileId: file.id, fileStoredPath: file.storedPath });
                    } else {
                      // Merge: update dimensions/material from new spec if available
                      if (spec.dimensions && !existing.dimensions) existing.dimensions = spec.dimensions;
                      if (spec.material && !existing.material) existing.material = spec.material;
                      if (spec.features.length > 0 && existing.features.length === 0) existing.features = spec.features;
                      if (spec.hasDrawing) { existing.hasDrawing = true; existing.cropBox = spec.cropBox; }
                      if (Object.keys(spec.keynoteMap).length > 0) existing.keynoteMap = { ...existing.keynoteMap, ...spec.keynoteMap };
                    }
                  }

                  for (const entry of result.entries) {
                    fileEntries.push({ ...entry, fileId: file.id });
                  }
                } catch (pageErr) {
                  logger.warn({ pageErr, fileId: file.id, pageNum }, "[PDF Processor] Schedule parse failed for page — non-fatal");
                }
              }

              if (fileEntries.length > 0 || mergedSpecs.size > 0) {
                allScheduleSpecs.push(...mergedSpecs.values());
                allScheduleEntries.push(...fileEntries);
                logger.info(
                  { jobId, fileId: file.id, specs: mergedSpecs.size, entries: fileEntries.length, durationMs: Date.now() - t_schedule },
                  "[PDF Processor] Schedule spatial parse complete"
                );
              }
            } catch (err) {
              logger.warn({ err, fileId: file.id }, "[PDF Processor] Schedule parsing failed — non-fatal");
            }
          }
        }

        // ── Persist file metadata ─────────────────────────────────────────
        const floorPageLevels = spatialFloorLevelNames && spatialFloorLevelNames.size > 0
          ? Object.fromEntries(spatialFloorLevelNames)
          : undefined;

        // Exclude any previously-rejected pages from all classification lists so they
        // are never sent for AI extraction or heuristic sign detection on re-runs.
        const rejectedSet = new Set(existingRejectedPages);
        const filterRejected = (pages: number[]) => pages.filter((p) => !rejectedSet.has(p));

        // Build the classified-page sets so otherPages can exclude any page that is
        // already accounted for in a specific classification bucket.  Using the raw
        // text-extraction otherPages directly would include pages that the spatial
        // pre-pass reclassified as floor_plan / sign_schedule / both, causing a page
        // to appear in two contradictory buckets simultaneously.
        const classifiedPageSet = new Set([
          ...finalFloorPlanPages,
          ...finalSignSchedulePages,
          ...finalBothPages,
        ]);
        const dedupedOtherPages = otherPages.filter((p) => !classifiedPageSet.has(p));

        const pageStats = {
          floorPlanPages: filterRejected(finalFloorPlanPages),
          signSchedulePages: filterRejected(finalSignSchedulePages),
          bothPages: filterRejected(finalBothPages),
          otherPages: filterRejected(dedupedOtherPages),
          ...(existingRejectedPages.length > 0 ? { rejectedPageNumbers: existingRejectedPages } : {}),
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

  // ── Persist schedule parser results (sign_type_specs + signage_schedule_entries) ──
  // Always clear previous schedule rows first (re-run support, prevents stale data
  // if no schedule pages are found in a subsequent run).
  await db.delete(signageScheduleEntriesTable).where(eq(signageScheduleEntriesTable.jobId, jobId));
  await db.delete(signTypeSpecsTable).where(eq(signTypeSpecsTable.jobId, jobId));

  if (allScheduleSpecs.length > 0 || allScheduleEntries.length > 0) {
    try {
      const t_schedule_persist = Date.now();

      // Deduplicate specs job-wide by typeCode (last-file wins for conflicts)
      const deduplicatedSpecsMap = new Map<string, typeof allScheduleSpecs[0]>();
      for (const spec of allScheduleSpecs) {
        const key = spec.typeCode.toUpperCase();
        const existing = deduplicatedSpecsMap.get(key);
        if (!existing) {
          deduplicatedSpecsMap.set(key, spec);
        } else {
          // Merge: enrich existing with any new information
          if (spec.dimensions && !existing.dimensions) existing.dimensions = spec.dimensions;
          if (spec.material && !existing.material) existing.material = spec.material;
          if (spec.features.length > 0 && existing.features.length === 0) existing.features = spec.features;
          if (spec.hasDrawing) { existing.hasDrawing = true; existing.cropBox = spec.cropBox; existing.fileStoredPath = spec.fileStoredPath; }
          if (Object.keys(spec.keynoteMap).length > 0) existing.keynoteMap = { ...existing.keynoteMap, ...spec.keynoteMap };
        }
      }
      const deduplicatedSpecs = [...deduplicatedSpecsMap.values()];

      // Insert sign type specs
      const specIdMap = new Map<string, string>(); // typeCode → DB id
      if (deduplicatedSpecs.length > 0) {
        const specRows = deduplicatedSpecs.map((spec) => ({
          jobId,
          sourceFileId: spec.fileId,
          typeCode: spec.typeCode,
          dimensions: spec.dimensions ?? null,
          material: spec.material ?? null,
          features: spec.features.length > 0 ? spec.features : null,
          keynoteMap: Object.keys(spec.keynoteMap).length > 0 ? spec.keynoteMap : null,
          cropBox: spec.cropBox ?? null,
          hasDrawing: spec.hasDrawing,
          geminiEnriched: false,
        }));
        const inserted = await db.insert(signTypeSpecsTable).values(specRows).returning({ id: signTypeSpecsTable.id, typeCode: signTypeSpecsTable.typeCode });
        for (const row of inserted) {
          specIdMap.set(row.typeCode, row.id);
        }
      }

      // Build pairedSignId lookup: job + sign type code → extracted_signs row id
      // Match by signIdentifier (the sign type code column) across this job.
      const extractedSignsForJob = await db
        .select({ id: extractedSignsTable.id, signIdentifier: extractedSignsTable.signIdentifier })
        .from(extractedSignsTable)
        .where(eq(extractedSignsTable.jobId, jobId));
      const pairedSignMap = new Map<string, string>(); // signIdentifier.upper → extractedSign.id
      for (const sign of extractedSignsForJob) {
        if (sign.signIdentifier) {
          pairedSignMap.set(sign.signIdentifier.toUpperCase().trim(), sign.id);
        }
      }

      // Insert schedule entries
      if (allScheduleEntries.length > 0) {
        const entryRows = allScheduleEntries.map((entry) => ({
          jobId,
          signTypeSpecId: specIdMap.get(entry.signTypeCode) ?? specIdMap.get(entry.signTypeCode.toUpperCase()) ?? null,
          pairedSignId: pairedSignMap.get(entry.signTypeCode.toUpperCase().trim()) ?? null,
          sourceTableName: entry.sourceTableName || null,
          pageNumber: entry.pageNumber,
          roomNumber: entry.roomNumber ?? null,
          roomName: entry.roomName ?? null,
          signTypeCode: entry.signTypeCode,
          quantity: entry.quantity ?? null,
          signageText: entry.signageText ?? null,
          glassBacker: entry.glassBacker ?? null,
          rawComments: entry.rawComments ?? null,
          expandedComments: entry.expandedComments ?? null,
          dimensions: entry.dimensions ?? null,
          material: entry.material ?? null,
          features: entry.features.length > 0 ? entry.features : null,
        }));
        const CHUNK = 200;
        for (let i = 0; i < entryRows.length; i += CHUNK) {
          await db.insert(signageScheduleEntriesTable).values(entryRows.slice(i, i + CHUNK));
        }
      }

      logger.info(
        { jobId, specs: allScheduleSpecs.length, entries: allScheduleEntries.length, durationMs: Date.now() - t_schedule_persist },
        "[PDF Processor] Schedule data persisted"
      );

    } catch (err) {
      logger.warn({ err, jobId }, "[PDF Processor] Schedule data persistence failed — non-fatal");
    }
  }

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
