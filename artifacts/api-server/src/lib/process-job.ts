import path from "path";
import fs from "fs/promises";
import { eq, and, ne, desc } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  jobsTable,
  jobFilesTable,
  extractedSignsTable,
  type InsertExtractedSign,
  type ProcessingStep,
} from "@workspace/db";

import { ai } from "@workspace/integrations-gemini-ai";
import { extractSignsFromPdf, extractSignCalloutsPng, extractProjectInfo, extractTextFromPdf, isSpecFile, buildSpecContextString, type ProjectInfo, type VerifiedSignSummary, type GeminiCallout, type ScanResult, type ExtractedSignRow } from "./extraction";
import { saveParsedResult, getFilePageImagesDir, PAGES_DIR } from "./storage";
import { renderFloorPlanPages, detectPageRegions, type PageRegions } from "./pdf-render";
import { logger } from "./logger";
import { extractPagePhrases, detectFloorPlanBbox, matchLocationToCoords, classifyPageFromPhrases, extractFloorLevelName, detectLevelInLocation, CANONICAL_LEVEL_NAMES, type PdfPhrase, type FloorPlanBbox, type SpatialPageType } from "./pdf-words";


/**
 * Deduplicates sign rows before DB insertion.
 * Key: location + signType (normalized, lowercased). Only applied when both are non-null —
 * rows missing either field are kept as-is to avoid accidental merging of unrelated signs.
 * When a duplicate pair is found, the entry with a detailReference wins; if both/neither have
 * one, the higher confidenceScore is kept.
 */
export function deduplicateSignRows(rows: InsertExtractedSign[]): InsertExtractedSign[] {
  const seenKeys = new Map<string, number>(); // composite key → index in `out`
  const out: InsertExtractedSign[] = [];

  for (const row of rows) {
    if (!row.location || !row.signType) {
      out.push(row);
      continue;
    }
    const key = `${row.location.toLowerCase().trim()}||${row.signType.toLowerCase().trim()}`;
    const existingIdx = seenKeys.get(key);
    if (existingIdx === undefined) {
      seenKeys.set(key, out.length);
      out.push(row);
    } else {
      const existing = out[existingIdx]!;
      const preferNew =
        (row.detailReference && !existing.detailReference) ||
        (!!row.detailReference === !!existing.detailReference &&
          (row.confidenceScore ?? 0) > (existing.confidenceScore ?? 0));
      if (preferNew) {
        out[existingIdx] = row;
      }
      // else: discard `row` — existing is better
    }
  }
  return out;
}

export async function processJob(jobId: string): Promise<void> {
  // ── Per-job timing log ────────────────────────────────────────────────────
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

  // ── Preserve verified + manually-added signs before clearing AI output ───
  const existingSigns = await db
    .select()
    .from(extractedSignsTable)
    .where(eq(extractedSignsTable.jobId, jobId));

  const preservedSigns = existingSigns.filter((s) => s.userVerified || s.manuallyAdded);

  // Build per-file verified context maps for prompt injection
  const verifiedByFile: Record<string, VerifiedSignSummary[]> = {};
  const verifiedGlobal: VerifiedSignSummary[] = [];
  for (const s of preservedSigns) {
    const summary: VerifiedSignSummary = {
      signIdentifier: s.signIdentifier,
      signType: s.signType,
      location: s.location,
      pageNumber: s.pageNumber,
      sheetNumber: s.sheetNumber,
      messageContent: s.messageContent,
    };
    verifiedGlobal.push(summary);
    if (s.jobFileId) {
      if (!verifiedByFile[s.jobFileId]) verifiedByFile[s.jobFileId] = [];
      verifiedByFile[s.jobFileId]!.push(summary);
    }
  }

  logger.info({ jobId, preservedCount: preservedSigns.length }, "Preserved verified/manually-added signs");

  // ── Cross-job training context: verified signs from OTHER jobs ──────────────
  const crossJobVerified = await db
    .select({
      signIdentifier: extractedSignsTable.signIdentifier,
      signType: extractedSignsTable.signType,
      location: extractedSignsTable.location,
      pageNumber: extractedSignsTable.pageNumber,
      sheetNumber: extractedSignsTable.sheetNumber,
      messageContent: extractedSignsTable.messageContent,
    })
    .from(extractedSignsTable)
    .where(
      and(
        eq(extractedSignsTable.userVerified, true),
        ne(extractedSignsTable.jobId, jobId)
      )
    )
    .orderBy(desc(extractedSignsTable.createdAt))
    .limit(400);

  logger.info({ jobId, trainingCount: crossJobVerified.length }, "Loaded cross-job training context");

  // Delete only AI-extracted, non-verified signs — keep corrections intact
  await db
    .delete(extractedSignsTable)
    .where(
      and(
        eq(extractedSignsTable.jobId, jobId),
        eq(extractedSignsTable.userVerified, false),
        eq(extractedSignsTable.manuallyAdded, false)
      )
    );

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

  const allTextRows: InsertExtractedSign[] = [];
  const allImageRows: InsertExtractedSign[] = [];
  const parsedResults: Record<string, unknown>[] = [];
  // Per-file PNG image paths and relevant page sets — populated during per-file loop,
  // consumed later by the post-word-match Gemini bbox scan.
  const filePageImagePaths = new Map<string, Record<string, string>>();
  const fileRelevantPages = new Map<string, Set<number>>();
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalImageInputTokens = 0;
  let totalImageOutputTokens = 0;

  // ── PASS 0: Extract project info from first file ──────────────────────────
  let projectContext: ProjectInfo | undefined;
  const firstFile = files[0]!;

  try {
    logger.info({ jobId, file: firstFile.originalName }, "Extracting project info");
    const t_proj = Date.now();
    const { info, inputTokens: piIn, outputTokens: piOut } = await extractProjectInfo(firstFile.storedPath, firstFile.id, ai);
    projectContext = info;
    totalInputTokens += piIn;
    totalOutputTokens += piOut;
    recordStep("project_info", "Project info extraction", t_proj, { inputTokens: piIn, outputTokens: piOut });

    if (info.address || info.city || info.state) {
      await db
        .update(jobsTable)
        .set({
          projectAddress: info.address,
          projectCity: info.city,
          projectState: info.state,
          updatedAt: new Date(),
        })
        .where(eq(jobsTable.id, jobId));
      logger.info({ jobId, address: info.address, city: info.city, state: info.state }, "Project location saved");
    }
  } catch (err) {
    logger.warn({ err, jobId }, "Project info extraction failed — continuing without location context");
  }

  // ── Spec vs data file routing ─────────────────────────────────────────────
  // When a job includes both a CSI specification document AND drawing files
  // (floor plans / signage schedules), the spec is read as instructional context
  // that enriches how the drawing files are extracted — it does NOT generate
  // standalone sign rows of its own.
  const specFiles = files.filter((f) => isSpecFile(f.originalName));
  const dataFiles = files.filter((f) => !isSpecFile(f.originalName));
  const hasDataFiles = dataFiles.length > 0;

  let specTypeContext: string | undefined;
  if (specFiles.length > 0 && hasDataFiles) {
    logger.info({ jobId, specFiles: specFiles.map((f) => f.originalName) }, "Spec files detected — extracting type catalog for context injection");
    const t_spec = Date.now();
    const specTexts: string[] = [];
    for (const specFile of specFiles) {
      try {
        const { pages } = await extractTextFromPdf(specFile.storedPath, specFile.id);
        const raw = pages.map((p) => p.text).join("\n");
        specTexts.push(raw);
        // Still record page count / text for the spec file in the DB
        await db
          .update(jobFilesTable)
          .set({ pageCount: pages.length, extractedText: raw.slice(0, 10000) })
          .where(eq(jobFilesTable.id, specFile.id));
        logger.info({ fileName: specFile.originalName, pages: pages.length }, "Spec file text extracted for context");
      } catch (err) {
        logger.warn({ err, fileName: specFile.originalName }, "Failed to extract spec file text for context");
      }
    }
    if (specTexts.length > 0) {
      specTypeContext = buildSpecContextString(specTexts.join("\n\n--- SPEC FILE SEPARATOR ---\n\n"));
      logger.info({ chars: specTypeContext.length }, "Spec type context built — will inject into drawing file prompts");
    }
    recordStep("spec_processing", "Spec file processing", t_spec, { specFileCount: specFiles.length });
  }

  // Files to actually run sign extraction on: data files when they exist;
  // fall back to all files (treating them as data) when only specs were uploaded.
  const filesToProcess = hasDataFiles ? dataFiles : files;

  // ── PASSES 1–3: Text + visual extraction — all files in parallel ─────────────
  // Within each file: text extraction runs first, then visual verification uses
  // its results.  Across files: all pipelines run concurrently so a 4-file job
  // takes no longer than a 1-file job.
  type FileResult =
    | {
        ok: true;
        file: typeof files[number];
        textResult: Awaited<ReturnType<typeof extractSignsFromPdf>>;
        textDurationMs: number;
        spatialData?: {
          pages: number;
          classified: number;
          floorPlan: number;
          signSchedule: number;
          both: number;
          unknown: number;
          excluded: number;
        };
        /** pageNum → normalized level name for floor-plan pages (from spatial pre-pass) */
        spatialFloorLevelNames?: Map<number, string>;
      }
    | { ok: false; file: typeof files[number]; error: string };

  // Collects Gemini AI-detected page regions (floor plan bbox + sign schedule bbox)
  // for pages classified as "both".  Keyed by "fileId:pageNum".
  // Written during the per-file loop; read by word-match and bbox persistence.
  const allAiRegions = new Map<string, PageRegions>();

  const t_extraction = Date.now();
  const fileResults: FileResult[] = await Promise.all(
    filesToProcess.map(async (file): Promise<FileResult> => {
      try {
        logger.info({ jobId, file: file.originalName }, "Extracting signs from file");
        const fileVerified = verifiedByFile[file.id] ?? [];
        const otherVerified = verifiedGlobal.filter((v) => !fileVerified.includes(v));
        const allVerifiedForFile = [...fileVerified, ...otherVerified];

        // ── Spatial pre-pass: classify pages from their title-block region ────
        // This runs before the AI extraction so the result can override the
        // text-heuristic classification.  extractPagePhrases is cached so
        // subsequent calls (coord assignment) are free.
        let spatialPageTypes: Map<number, SpatialPageType> | undefined;
        // Maps 1-based pageNum → normalized level name for floor-plan pages.
        let spatialFloorLevelNames: Map<number, string> | undefined;
        let fileSpatialData: { pages: number; classified: number; floorPlan: number; signSchedule: number; both: number; unknown: number; excluded: number } | undefined;
        const t_spatial = Date.now();
        try {
          const { getPdfPageCount } = await import("./pdf-words");
          const numPages = await getPdfPageCount(file.storedPath);
          spatialPageTypes = new Map<number, SpatialPageType>();
          spatialFloorLevelNames = new Map<number, string>();
          await Promise.all(
            Array.from({ length: numPages }, (_, i) => i + 1).map(async (pageNum) => {
              try {
                const pageWords = await extractPagePhrases(file.storedPath, file.id, pageNum);
                const spatialType = classifyPageFromPhrases(pageWords.phrases);
                // Store ALL page types including "unknown" — extraction.ts uses the
                // "unknown" sentinel to hard-exclude pages from Gemini extraction passes.
                spatialPageTypes!.set(pageNum, spatialType);
                // For floor-plan pages, extract the level name from the title block.
                if (spatialType === "floor_plan" || spatialType === "both") {
                  const levelName = extractFloorLevelName(pageWords.phrases);
                  if (levelName) spatialFloorLevelNames!.set(pageNum, levelName);
                }
              } catch {
                // individual page failures are non-fatal: page remains unset in the map
              }
            })
          );
          const floorPlanCount = [...spatialPageTypes.values()].filter((t) => t === "floor_plan").length;
          const signScheduleCount = [...spatialPageTypes.values()].filter((t) => t === "sign_schedule").length;
          const bothCount = [...spatialPageTypes.values()].filter((t) => t === "both").length;
          const unknownCount = [...spatialPageTypes.values()].filter((t) => t === "unknown").length;
          // Pages that failed spatial classification entirely (not set in the map)
          const unclassifiedCount = numPages - spatialPageTypes.size;
          // Only pages explicitly classified as "unknown" are hard-excluded from extraction.
          // Pages that failed spatial classification (unclassifiedCount) still go through
          // heuristic classification inside extractSignsFromPdf, so they are NOT excluded.
          const totalExcluded = unknownCount;
          logger.info(
            {
              jobId,
              file: file.originalName,
              pages: numPages,
              floorPlan: floorPlanCount,
              signSchedule: signScheduleCount,
              both: bothCount,
              unknown: unknownCount,
              unclassified: unclassifiedCount,
              excluded: totalExcluded,
            },
            "Spatial page classification complete"
          );
          fileSpatialData = {
            pages: numPages,
            classified: floorPlanCount + signScheduleCount + bothCount,
            floorPlan: floorPlanCount,
            signSchedule: signScheduleCount,
            unknown: unknownCount,
            both: bothCount,
            excluded: totalExcluded,
          };
          pipelineSteps.push({
            step: `spatial_prepass_${file.id}`,
            label: filesToProcess.length > 1
              ? `Spatial pre-pass — ${file.originalName}`
              : "Spatial pre-pass",
            durationMs: Date.now() - t_spatial,
            startedAt: new Date(t_spatial).toISOString(),
            details: {
              pages: numPages,
              classified: floorPlanCount + signScheduleCount + bothCount,
              excludedPages: totalExcluded,
              // Nested classifiedPages for schema consistency with text/visual/extraction steps
              classifiedPages: {
                floor_plan: floorPlanCount,
                sign_schedule: signScheduleCount,
                both: bothCount,
                unknown: unknownCount,
                excluded: totalExcluded,
              },
            },
          });
        } catch (err) {
          logger.warn({ err, file: file.originalName }, "Spatial pre-pass failed — falling back to text heuristics");
          spatialPageTypes = undefined;
        }

        const t_text = Date.now();
        const textResult = await extractSignsFromPdf(
          file.storedPath,
          file.id,
          ai,
          projectContext,
          allVerifiedForFile.length > 0 ? allVerifiedForFile : undefined,
          crossJobVerified.length > 0 ? crossJobVerified : undefined,
          specTypeContext,
          spatialPageTypes
        );
        const textDurationMs = Date.now() - t_text;

        // Floor plan + sign_schedule pages are relevant for the bbox scan
        const relevantPageNums = new Set([
          ...textResult.pageStats.floorPlanPages,
          ...textResult.pageStats.signSchedulePages,
        ]);

        // ── PNG pre-render: rasterize floor_plan and "both" pages only ─────────
        // Sign schedule pages don't need PNGs — they're not rendered in the
        // viewer and coordinate matching only needs floor plan imagery.
        // Failures are non-fatal.
        const pngPageNumsSet = new Set([
          ...textResult.pageStats.floorPlanPages,
          ...(textResult.pageStats.bothPages ?? []),
        ]);
        const pngPageNums = Array.from(pngPageNumsSet).sort((a, b) => a - b);
        // pageImagePathsRelative: stored in DB (relative paths, no filesystem disclosure)
        // pageImagePathsAbsolute: passed to Gemini (must be absolute for fs.readFile)
        let pageImagePathsRelative: Record<string, string> | null = null;
        let pageImagePathsAbsolute: Record<string, string> | null = null;
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
                // Relative path stored in DB; absolute path used for Gemini
                pageImagePathsRelative[String(pageNum)] = path.relative(pagesParent, absPath);
                pageImagePathsAbsolute[String(pageNum)] = absPath;
              }
            }
            logger.info(
              { fileId: file.id, pagesRendered: rendered.size, durationMs: Date.now() - t_render },
              "PNG pre-render complete",
            );
          } catch (err) {
            logger.warn({ err, fileId: file.id }, "PNG pre-render failed — non-fatal, viewer will use PDF fallback");
          }
        }

        // ── Gemini visual region detection for "both" pages ─────────────────
        // For pages that contain both a floor plan drawing and a sign schedule
        // table, ask Gemini to locate each region with a normalized bbox.
        // Results are stored in allAiRegions and later:
        //   1. Used in word-match to restrict coord placement to the floor plan area
        //   2. Persisted to pageStats.aiRegionBboxes for the viewer overlay
        const bothPageNums = textResult.pageStats.bothPages ?? [];
        if (bothPageNums.length > 0 && pageImagePathsAbsolute) {
          const t_region = Date.now();
          try {
            await Promise.all(
              bothPageNums.map(async (pageNum) => {
                const pngPath = pageImagePathsAbsolute![String(pageNum)];
                if (!pngPath) return;
                const regions = await detectPageRegions(pngPath, ai, pageNum);
                if (regions.floorPlan || regions.signSchedule) {
                  allAiRegions.set(`${file.id}:${pageNum}`, regions);
                }
              })
            );
            const detected = bothPageNums.filter((p) => allAiRegions.has(`${file.id}:${p}`)).length;
            logger.info(
              { fileId: file.id, bothPages: bothPageNums.length, detected, durationMs: Date.now() - t_region },
              "AI region detection complete"
            );
          } catch (err) {
            logger.warn({ err, fileId: file.id }, "AI region detection failed — non-fatal, word-match will use heuristic bbox");
          }
        }

        // ── Gemini Vision fallback: floor level name extraction ──────────────
        // For floor-plan pages whose title-block text layer yielded no level name,
        // send the pre-rendered PNG to Gemini and ask it to read the drawing title.
        // This runs after PNG rendering so images are available.
        if (spatialFloorLevelNames && pageImagePathsAbsolute) {
          const fpAndBothPages = [
            ...textResult.pageStats.floorPlanPages,
            ...(textResult.pageStats.bothPages ?? []),
          ];
          const unmappedFpPages = fpAndBothPages.filter(
            (p) => !spatialFloorLevelNames!.has(p) && pageImagePathsAbsolute![String(p)]
          );
          if (unmappedFpPages.length > 0) {
            const LEVEL_VISION_PROMPT = `You are reading the title block of an architectural floor plan drawing.
Identify which floor level or zone this plan represents.
Return ONLY the level name as a single lowercase phrase from this list if it matches:
- "lower level"
- "main level"
- "upper level"
- "attic"
If none match, return "none".
Do not include any other text or explanation.`;
            await Promise.all(
              unmappedFpPages.map(async (pageNum) => {
                const pngPath = pageImagePathsAbsolute![String(pageNum)];
                try {
                  const pngBuffer = await fs.readFile(pngPath);
                  const base64 = pngBuffer.toString("base64");
                  const response = await (ai as {
                    models: {
                      generateContent: (opts: {
                        model: string;
                        contents: {
                          role: string;
                          parts: ({ text: string } | { inlineData: { mimeType: string; data: string } })[];
                        }[];
                        config?: { maxOutputTokens?: number; temperature?: number; thinkingConfig?: { thinkingBudget: number } };
                      }) => Promise<{ text: string | undefined }>;
                    };
                  }).models.generateContent({
                    model: "gemini-2.5-flash",
                    contents: [
                      {
                        role: "user",
                        parts: [
                          { inlineData: { mimeType: "image/png", data: base64 } },
                          { text: LEVEL_VISION_PROMPT },
                        ],
                      },
                    ],
                    config: { maxOutputTokens: 32, temperature: 0.0, thinkingConfig: { thinkingBudget: 0 } },
                  });
                  const raw = (response.text ?? "").trim().toLowerCase();
                  const matched = CANONICAL_LEVEL_NAMES.find((l) => raw.includes(l));
                  if (matched) {
                    spatialFloorLevelNames!.set(pageNum, matched);
                    logger.info(
                      { fileId: file.id, pageNum, levelName: matched },
                      "Gemini Vision floor level name extracted (fallback)"
                    );
                  }
                } catch (err) {
                  logger.debug({ err, fileId: file.id, pageNum }, "Gemini Vision floor level fallback failed for page — non-fatal");
                }
              })
            );
          }
        }

        // Store per-file image paths and relevant pages for post-word-match Gemini bbox scan
        if (pageImagePathsAbsolute && Object.keys(pageImagePathsAbsolute).length > 0) {
          filePageImagePaths.set(file.id, pageImagePathsAbsolute);
        }
        fileRelevantPages.set(file.id, relevantPageNums);

        // Merge relative pageImagePaths and floorPageLevels into pageStats before persisting
        const floorPageLevelsRecord: Record<number, string> | undefined =
          spatialFloorLevelNames && spatialFloorLevelNames.size > 0
            ? Object.fromEntries(spatialFloorLevelNames)
            : undefined;
        const finalPageStats = {
          ...textResult.pageStats,
          ...(pageImagePathsRelative ? { pageImagePaths: pageImagePathsRelative } : {}),
          ...(floorPageLevelsRecord ? { floorPageLevels: floorPageLevelsRecord } : {}),
        };

        // Per-file DB update is safe to do inside the parallel map
        await db
          .update(jobFilesTable)
          .set({ pageCount: textResult.pageCount, extractedText: textResult.rawText.slice(0, 10000), pageStats: finalPageStats })
          .where(eq(jobFilesTable.id, file.id));

        return { ok: true, file, textResult, textDurationMs, spatialData: fileSpatialData, spatialFloorLevelNames };
      } catch (err) {
        logger.error({ err, fileId: file.id, fileName: file.originalName }, "File extraction failed");
        return { ok: false, file, error: String(err) };
      }
    })
  );

  // Record overall extraction wall-clock time (files ran in parallel)
  const extractionFileSummaries = fileResults
    .filter((r): r is Extract<typeof r, { ok: true }> => r.ok)
    .map((r) => ({
      fileId: r.file.id,
      fileName: r.file.originalName,
      pages: r.spatialData?.pages ?? r.textResult.pageCount,
      // excludedPages = only spatially "unknown" pages (hard-excluded from Gemini passes)
      excludedPages: r.spatialData?.unknown ?? 0,
      classifiedPages: {
        floor_plan: r.spatialData?.floorPlan ?? 0,
        sign_schedule: r.spatialData?.signSchedule ?? 0,
        both: r.spatialData?.both ?? 0,
        unknown: r.spatialData?.unknown ?? 0,
        excluded: r.spatialData?.unknown ?? 0,
      },
      textDurationMs: r.textDurationMs,
    }));
  recordStep("extraction", "Sign extraction (all files)", t_extraction, {
    fileCount: filesToProcess.length,
    succeeded: fileResults.filter((r) => r.ok).length,
    failed: fileResults.filter((r) => !r.ok).length,
    files: extractionFileSummaries,
  });

  // ── Merge parallel results into accumulator arrays ────────────────────────
  for (const result of fileResults) {
    if (!result.ok) {
      parsedResults.push({ fileId: result.file.id, fileName: result.file.originalName, error: result.error });
      continue;
    }

    const { file, textResult, textDurationMs, spatialData } = result;
    const fileExcludedPages = spatialData?.unknown ?? 0;
    const fileClassifiedPages = spatialData
      ? {
          floor_plan: spatialData.floorPlan,
          sign_schedule: spatialData.signSchedule,
          both: spatialData.both,
          unknown: spatialData.unknown,
          excluded: spatialData.unknown,
        }
      : undefined;

    // Record individual file steps so users can see per-file breakdown
    pipelineSteps.push({
      step: `text_extraction_${file.id}`,
      label: filesToProcess.length > 1
        ? `Text extraction — ${file.originalName}`
        : "Text extraction",
      durationMs: textDurationMs,
      startedAt: new Date(Date.now() - textDurationMs).toISOString(),
      details: {
        rows: textResult.rows.length,
        pages: textResult.pageCount,
        excludedPages: fileExcludedPages,
        inputTokens: textResult.inputTokens,
        outputTokens: textResult.outputTokens,
        ...(fileClassifiedPages ? { classifiedPages: fileClassifiedPages } : {}),
      },
    });

    totalInputTokens += textResult.inputTokens;
    totalOutputTokens += textResult.outputTokens;

    parsedResults.push({
      fileId: file.id,
      fileName: file.originalName,
      pageCount: textResult.pageCount,
      rowCount: textResult.rows.length,
      rows: textResult.rows,
    });

    for (const row of textResult.rows) {
      allTextRows.push({
        jobId,
        jobFileId: file.id,
        sheetNumber: row.sheet_number,
        detailReference: row.detail_reference,
        signType: row.sign_type,
        signIdentifier: row.sign_identifier,
        quantity: row.quantity,
        location: row.location,
        dimensions: row.dimensions,
        mountingType: row.mounting_type,
        finishColor: row.finish_color,
        illumination: row.illumination,
        materials: row.materials,
        messageContent: row.message_content,
        notes: row.notes,
        pageNumber: row.page_number,
        confidenceScore: row.confidence_score,
        reviewFlag: row.review_flag ?? false,
        extractionMethod: "text",
        rawJson: row as unknown as Record<string, unknown>,
      });
    }
  }

  // ── Word-match coordinate assignment ──────────────────────────────────────
  // For each sign that has a pageNumber and jobFileId, extract page words and
  // run the location match.  Results are cached per (fileId, pageNum) by
  // extractPagePhrases so this is efficient even across many signs on same page.
  //
  // We build a cache of (fileId:pageNum) → { phrases, bbox } to avoid repeated
  // PDF parses within this job run (extractPagePhrases has its own process-level
  // cache, but we also cache the bbox derivation here).
  type PageCache = { phrases: PdfPhrase[]; bbox: FloorPlanBbox | null };
  const pageCache = new Map<string, PageCache>();

  async function getPageData(fileStoredPath: string, fileId: string, page: number): Promise<PageCache> {
    const key = `${fileId}:${page}`;
    const cached = pageCache.get(key);
    if (cached) return cached;
    try {
      const pageWords = await extractPagePhrases(fileStoredPath, fileId, page);
      const heuristicBbox = detectFloorPlanBbox(pageWords.phrases);
      // For "both" pages: prefer the AI-detected floor plan region because the
      // heuristic often includes the sign schedule table area, causing markers
      // to appear on the table.
      const aiRegions = allAiRegions.get(key);
      const bbox = aiRegions?.floorPlan ?? heuristicBbox;
      const entry: PageCache = { phrases: pageWords.phrases, bbox };
      pageCache.set(key, entry);
      return entry;
    } catch {
      const entry: PageCache = { phrases: [], bbox: null };
      pageCache.set(key, entry);
      return entry;
    }
  }

  // Build a quick lookup for file storedPath by fileId
  const filePathById = new Map<string, string>(
    filesToProcess.map((f) => [f.id, f.storedPath])
  );

  // Build a lookup: fileId → Set<pageNum> of pages classified as floor_plan or both.
  // Used to gate coordinate assignment — sign-schedule-only pages must not get markers.
  const floorPlanPagesByFileId = new Map<string, Set<number>>();
  for (const result of fileResults) {
    if (result.ok) {
      const fpSet = new Set<number>([
        ...result.textResult.pageStats.floorPlanPages,
        ...(result.textResult.pageStats.bothPages ?? []),
      ]);
      floorPlanPagesByFileId.set(result.file.id, fpSet);
    }
  }

  // Build a lookup: fileId → Map<levelName, pageNum> for level-based routing.
  // Populated from the spatial pre-pass floor level name extraction.
  // Fallback: if some floor plan pages lack a level name but distinct levels appear
  // across sign locations, map them by ascending page-number order using the
  // canonical ordering (lower → main → upper → attic).
  const floorLevelPageByFileId = new Map<string, Map<string, number>>();
  for (const result of fileResults) {
    if (!result.ok || !result.spatialFloorLevelNames || result.spatialFloorLevelNames.size === 0) continue;
    const levelMap = new Map<string, number>();
    for (const [pageNum, levelName] of result.spatialFloorLevelNames) {
      levelMap.set(levelName, pageNum);
    }
    floorLevelPageByFileId.set(result.file.id, levelMap);
  }

  // Fallback (Task 4): for files where some (or all) floor-plan pages have no
  // level name, attempt to fill in the gaps using canonical ordering.
  // Strategy: find floor plan pages that are unmapped, find level names that
  // appear in sign locations but aren't already assigned to any page, and if
  // counts match, assign them in ascending page-number / canonical level order.
  for (const result of fileResults) {
    if (!result.ok) continue;
    const fileId = result.file.id;
    const fpPages = floorPlanPagesByFileId.get(fileId);
    if (!fpPages || fpPages.size === 0) continue;

    // Get current (possibly partial) level map, creating it if absent.
    const existingMap = floorLevelPageByFileId.get(fileId) ?? new Map<string, number>();

    // Pages that still have no level name assigned.
    const assignedPages = new Set(existingMap.values());
    const unmappedPages = Array.from(fpPages)
      .filter((p) => !assignedPages.has(p))
      .sort((a, b) => a - b);

    if (unmappedPages.length === 0) continue; // all pages already have a level

    // Level names appearing in sign locations for this file.
    const locationLevels = new Set<string>();
    for (const row of result.textResult.rows) {
      const loc = detectLevelInLocation(row.location);
      if (loc) locationLevels.add(loc);
    }

    // Remove levels already assigned in the existing map.
    for (const assignedLevel of existingMap.keys()) {
      locationLevels.delete(assignedLevel);
    }

    if (locationLevels.size === 0 || locationLevels.size !== unmappedPages.length) continue;

    // Order unassigned levels by canonical order.
    const orderedLevels = CANONICAL_LEVEL_NAMES.filter((l) => locationLevels.has(l));
    if (orderedLevels.length !== unmappedPages.length) continue;

    const fallbackMap = new Map<string, number>(existingMap);
    for (let i = 0; i < orderedLevels.length; i++) {
      fallbackMap.set(orderedLevels[i]!, unmappedPages[i]!);
    }
    floorLevelPageByFileId.set(fileId, fallbackMap);
    logger.warn(
      { jobId, fileId, unmappedPages, orderedLevels, mapping: Object.fromEntries(fallbackMap) },
      "Floor level routing: fallback page-order heuristic used for unmapped pages — verify manually"
    );
  }

  async function assignCoords(rows: InsertExtractedSign[]): Promise<InsertExtractedSign[]> {
    // Per-page exclusion sets: keyed by "fileId:pageNum".
    // Seeded with already-placed coordinates so re-processing never reassigns them.
    const usedCoordsPerPage = new Map<string, Set<string>>();
    function getExcludeSet(fileId: string, pageNum: number): Set<string> {
      const k = `${fileId}:${pageNum}`;
      if (!usedCoordsPerPage.has(k)) usedCoordsPerPage.set(k, new Set());
      return usedCoordsPerPage.get(k)!;
    }

    // Pass 1: Seed exclusion sets from rows that already have coordinates
    // (manually placed or assigned in a prior run) so they are never displaced.
    for (const row of rows) {
      if (row.xPos != null && row.yPos != null && row.jobFileId && row.pageNumber) {
        getExcludeSet(row.jobFileId, row.pageNumber).add(
          `${row.xPos.toFixed(4)},${row.yPos.toFixed(4)}`
        );
      }
    }

    // Separate already-coordinated rows (pass-through) from those that need matching.
    const result: InsertExtractedSign[] = [];
    const needsCoords: InsertExtractedSign[] = [];
    for (const row of rows) {
      if (row.xPos != null && row.yPos != null) {
        result.push(row);
      } else {
        needsCoords.push(row);
      }
    }

    // Group rows needing coords by (jobFileId, resolvedPageNumber).
    // If a sign's location contains a level indicator (e.g. "Lower Level"), look up
    // which floor-plan page carries that level and override pageNumber before grouping.
    // Signs without a level indicator use their original page assignment (existing behaviour).
    type PageGroupValue = { fileId: string; pageNum: number; rows: InsertExtractedSign[] };
    const pageGroups = new Map<string, PageGroupValue>();
    for (const row of needsCoords) {
      if (!row.jobFileId || !row.pageNumber) {
        result.push(row);
        continue;
      }

      let resolvedPageNum = row.pageNumber;
      const locationLevel = detectLevelInLocation(row.location);
      if (locationLevel) {
        const levelMap = floorLevelPageByFileId.get(row.jobFileId);
        const targetPage = levelMap?.get(locationLevel);
        if (targetPage && targetPage !== resolvedPageNum) {
          logger.debug(
            { signId: row.signIdentifier, location: row.location, locationLevel, originalPage: resolvedPageNum, targetPage },
            "Level routing: sign rerouted to matching floor-plan page"
          );
          resolvedPageNum = targetPage;
        }
      }

      const k = `${row.jobFileId}:${resolvedPageNum}`;
      if (!pageGroups.has(k)) {
        pageGroups.set(k, { fileId: row.jobFileId, pageNum: resolvedPageNum, rows: [] });
      }
      pageGroups.get(k)!.rows.push({ ...row, pageNumber: resolvedPageNum });
    }

    // Pass 2: Process each page group sequentially so each sign claims
    // a unique phrase coordinate before the next sign on the same page runs.
    for (const { fileId, pageNum, rows: groupRows } of pageGroups.values()) {
      const storedPath = filePathById.get(fileId);
      if (!storedPath) {
        result.push(...groupRows);
        continue;
      }

      // Do not place markers for signs on sign-schedule-only pages.
      const fpPages = floorPlanPagesByFileId.get(fileId);
      if (fpPages !== undefined && !fpPages.has(pageNum)) {
        result.push(...groupRows);
        continue;
      }

      const excl = getExcludeSet(fileId, pageNum);
      let pageData: { phrases: PdfPhrase[]; bbox: FloorPlanBbox | null } | null = null;
      try {
        pageData = await getPageData(storedPath, fileId, pageNum);
      } catch (err) {
        logger.debug({ err, fileId, pageNum }, "getPageData failed — skipping coordinate assignment for page");
        result.push(...groupRows);
        continue;
      }

      for (const row of groupRows) {
        try {
          const match = matchLocationToCoords(
            pageData.phrases,
            pageData.bbox,
            row.location,
            row.signIdentifier,
            excl,
          );
          if (match) {
            excl.add(`${match.xPos.toFixed(4)},${match.yPos.toFixed(4)}`);
            result.push({ ...row, xPos: match.xPos, yPos: match.yPos, placementSource: "word_match" });
          } else {
            result.push(row);
          }
        } catch (err) {
          logger.debug({ err, signId: row.signIdentifier, location: row.location }, "Word-match failed for sign");
          result.push(row);
        }
      }
    }

    return result;
  }

  // Deduplicate text rows — key on location + signType only (no signIdentifier)
  // so that same-room same-type duplicates from different text passes are collapsed.
  const t_dedup = Date.now();
  const dedupedTextRows = deduplicateSignRows(allTextRows);

  logger.info(
    {
      jobId,
      textBefore: allTextRows.length,
      textAfter: dedupedTextRows.length,
    },
    "Sign deduplication complete",
  );
  recordStep("deduplication", "Sign deduplication", t_dedup, {
    textBefore: allTextRows.length,
    textAfter: dedupedTextRows.length,
  });

  // ── Word-match coordinate assignment (runs BEFORE Gemini bbox scan) ─────────
  // Text signs must have (x,y) coordinates before spatial matching can occur.
  const t_wordmatch = Date.now();
  const coordedTextRows = await assignCoords(dedupedTextRows);

  const matchedText = coordedTextRows.filter((r) => r.placementSource === "word_match").length;
  logger.info({ jobId, textRows: coordedTextRows.length, matchedText }, "Word-match coordinate assignment complete");
  recordStep("word_match", "Coordinate matching (word-match)", t_wordmatch, {
    totalSigns: coordedTextRows.length,
    matched: matchedText,
  });

  // ── Gemini bbox scan + spatial deduplication ─────────────────────────────────
  // For each file, send the pre-rendered PNGs to Gemini for a pure visual scan
  // that returns bounding boxes for all visible sign callouts. Then spatially
  // match text signs to callouts to dedup and boost confidence.
  const t_scan = Date.now();

  /**
   * Spatial match and dedup:
   * - Tolerance = 0.03 normalized units around each Gemini bbox.
   * - 2+ text signs match same bbox → keep best (highest confidence, prefer detailReference).
   * - 1 text sign matches → update xPos/yPos to bbox center, set aiBbox*, boost confidence.
   * - 0 text signs match (confidence ≥ 0.80) → create discovery row (extractionMethod = "image").
   * - Text sign with no matching callout → keep as-is but set reviewFlag if unconfirmed.
   */
  function spatialMatchAndDedup(
    textRows: InsertExtractedSign[],
    calloutsByPage: Map<number, GeminiCallout[]>,
    fileId: string,
  ): { finalRows: InsertExtractedSign[]; discoveryRows: InsertExtractedSign[] } {
    const SPATIAL_TOLERANCE = 0.03;

    function calloutCenter(c: GeminiCallout): { cx: number; cy: number } {
      return { cx: c.bbox_x + c.bbox_w / 2, cy: c.bbox_y + c.bbox_h / 2 };
    }

    function isInsideBbox(x: number, y: number, c: GeminiCallout): boolean {
      return (
        x >= c.bbox_x - SPATIAL_TOLERANCE &&
        x <= c.bbox_x + c.bbox_w + SPATIAL_TOLERANCE &&
        y >= c.bbox_y - SPATIAL_TOLERANCE &&
        y <= c.bbox_y + c.bbox_h + SPATIAL_TOLERANCE
      );
    }

    // Map: callout identity → matched text rows
    const calloutMatches = new Map<GeminiCallout, InsertExtractedSign[]>();
    for (const [, callouts] of calloutsByPage) {
      for (const c of callouts) {
        calloutMatches.set(c, []);
      }
    }

    // Track which text rows matched at least one callout
    const matchedRowSet = new Set<InsertExtractedSign>();

    // Enforce one-callout-per-text-row: each row is assigned only to its closest
    // matching callout (by distance from row center to callout center), preventing
    // a single row from suppressing discovery rows for multiple overlapping callouts.
    for (const row of textRows) {
      if (row.jobFileId !== fileId) continue;
      if (row.xPos == null || row.yPos == null) continue;
      const pageCallouts = calloutsByPage.get(row.pageNumber ?? 1) ?? [];
      let bestCallout: GeminiCallout | null = null;
      let bestDist = Infinity;
      for (const c of pageCallouts) {
        if (isInsideBbox(row.xPos, row.yPos, c)) {
          const { cx, cy } = calloutCenter(c);
          const dist = Math.hypot(row.xPos - cx, row.yPos - cy);
          if (dist < bestDist) {
            bestDist = dist;
            bestCallout = c;
          }
        }
      }
      if (bestCallout) {
        calloutMatches.get(bestCallout)!.push(row);
        matchedRowSet.add(row);
      }
    }

    // ── Null-coord fallback pass ────────────────────────────────────────────────
    // Text rows with no word-match coordinates (xPos/yPos == null) are skipped by
    // the spatial match above. Give them a second chance: match by sign-type
    // affinity against unmatched callouts on the same page, or fall back to a
    // greedy assignment when there is exactly one unmatched callout on the page.
    function coarseSignTypeGroup(signType: string | null | undefined): string {
      if (!signType) return "";
      const t = signType.toLowerCase();
      if (t.includes("room id")) return "room_id";
      if (t.includes("exit")) return "exit";
      if (t.includes("restroom") || t.includes("accessibility") || t.includes("accessible parking")) return "accessible";
      if (t.includes("stair")) return "stair";
      if (t.includes("elevator")) return "elevator";
      if (t.includes("fire") || t.includes("standpipe")) return "fire_safety";
      if (t.includes("wayfinding") || t.includes("directional")) return "wayfinding";
      return "";
    }

    for (const row of textRows) {
      if (row.jobFileId !== fileId) continue;
      if (matchedRowSet.has(row)) continue;
      if (row.xPos != null && row.yPos != null) continue;

      const pageCallouts = calloutsByPage.get(row.pageNumber ?? 1) ?? [];
      const unmatchedCallouts = pageCallouts.filter((c) => calloutMatches.get(c)!.length === 0);
      if (unmatchedCallouts.length === 0) continue;

      const rowGroup = coarseSignTypeGroup(row.signType);

      let bestCallout: GeminiCallout | null = null;
      let bestScore = -1;
      for (const c of unmatchedCallouts) {
        const cGroup = coarseSignTypeGroup(c.sign_type);
        const score = rowGroup && cGroup && rowGroup === cGroup ? 2 : 0;
        if (score > bestScore || (score === bestScore && bestCallout && c.confidence > bestCallout.confidence)) {
          bestScore = score;
          bestCallout = c;
        }
      }

      if (bestScore <= 0 && unmatchedCallouts.length === 1) {
        bestCallout = unmatchedCallouts[0]!;
      } else if (bestScore <= 0) {
        bestCallout = null;
      }

      if (!bestCallout) continue;

      const { cx, cy } = calloutCenter(bestCallout);
      const newConf = Math.min(1.0, (row.confidenceScore ?? 0) + 0.08);
      const updatedRow: InsertExtractedSign = {
        ...row,
        xPos: cx,
        yPos: cy,
        aiBboxX: bestCallout.bbox_x,
        aiBboxY: bestCallout.bbox_y,
        aiBboxW: bestCallout.bbox_w,
        aiBboxH: bestCallout.bbox_h,
        confidenceScore: newConf,
        reviewFlag: newConf < 0.75 ? true : false,
      };
      const rowIdx = textRows.indexOf(row);
      if (rowIdx !== -1) textRows[rowIdx] = updatedRow;
      calloutMatches.get(bestCallout)!.push(row);
      matchedRowSet.add(row);
    }

    // Build the final set of text rows (may discard duplicates)
    const keptRows = new Set<InsertExtractedSign>();
    const discardedRows = new Set<InsertExtractedSign>();

    for (const [callout, matches] of calloutMatches) {
      const { cx, cy } = calloutCenter(callout);

      if (matches.length === 0) continue;

      if (matches.length === 1) {
        // Single match: update position to bbox center, boost confidence
        const row = matches[0]!;
        const newConf = Math.min(1.0, (row.confidenceScore ?? 0) + 0.10);
        const updatedRow: InsertExtractedSign = {
          ...row,
          xPos: cx,
          yPos: cy,
          aiBboxX: callout.bbox_x,
          aiBboxY: callout.bbox_y,
          aiBboxW: callout.bbox_w,
          aiBboxH: callout.bbox_h,
          confidenceScore: newConf,
          reviewFlag: newConf < 0.75 ? true : false,
        };
        const rowIdx = textRows.indexOf(row);
        if (rowIdx !== -1) textRows[rowIdx] = updatedRow;
        keptRows.add(updatedRow);
      } else {
        // Multiple matches for same bbox → keep best, discard rest
        const sorted = [...matches].sort((a, b) => {
          const aHasRef = a.detailReference ? 1 : 0;
          const bHasRef = b.detailReference ? 1 : 0;
          if (bHasRef !== aHasRef) return bHasRef - aHasRef;
          return (b.confidenceScore ?? 0) - (a.confidenceScore ?? 0);
        });
        const best = sorted[0]!;
        const newConf = Math.min(1.0, (best.confidenceScore ?? 0) + 0.10);
        const updatedBest: InsertExtractedSign = {
          ...best,
          xPos: cx,
          yPos: cy,
          aiBboxX: callout.bbox_x,
          aiBboxY: callout.bbox_y,
          aiBboxW: callout.bbox_w,
          aiBboxH: callout.bbox_h,
          confidenceScore: newConf,
          reviewFlag: newConf < 0.75 ? true : false,
        };
        const bestIdx = textRows.indexOf(best);
        if (bestIdx !== -1) textRows[bestIdx] = updatedBest;
        keptRows.add(updatedBest);
        for (const dup of sorted.slice(1)) {
          discardedRows.add(dup);
        }
      }
    }

    // Rows from this file that had no matching callout → keep but always set reviewFlag.
    // In the new pipeline there is no prior confirmation signal, so any text sign
    // that Gemini did not find a callout for is considered unconfirmed.
    const finalRows: InsertExtractedSign[] = [];
    for (const row of textRows) {
      if (row.jobFileId !== fileId) {
        finalRows.push(row);
        continue;
      }
      if (discardedRows.has(row)) continue; // discard spatial duplicates
      if (!matchedRowSet.has(row) && !keptRows.has(row)) {
        // Unmatched: always flag for review (no Gemini bbox found for this sign)
        finalRows.push({ ...row, reviewFlag: true });
      } else {
        finalRows.push(row);
      }
    }

    // Discovery rows for Gemini callouts with no matching text sign (confidence ≥ 0.80)
    const discoveryRows: InsertExtractedSign[] = [];
    for (const [callout, matches] of calloutMatches) {
      if (matches.length > 0) continue;
      if (callout.confidence < 0.80) continue;
      const { cx, cy } = calloutCenter(callout);
      discoveryRows.push({
        jobId,
        jobFileId: fileId,
        signType: callout.sign_type,
        signIdentifier: callout.label_text,
        location: callout.label_text,
        pageNumber: callout.page_number,
        xPos: cx,
        yPos: cy,
        aiBboxX: callout.bbox_x,
        aiBboxY: callout.bbox_y,
        aiBboxW: callout.bbox_w,
        aiBboxH: callout.bbox_h,
        confidenceScore: Math.min(0.85, callout.confidence),
        reviewFlag: true,
        extractionMethod: "image",
        notes: "Discovered by visual bbox scan",
        placementSource: "ai_bbox",
      });
    }

    return { finalRows, discoveryRows };
  }

  let finalTextRows = coordedTextRows;
  let totalScanCallouts = 0;
  let totalScanInputTokens = 0;
  let totalScanOutputTokens = 0;

  for (const result of fileResults) {
    if (!result.ok) continue;
    const file = result.file;
    const imagePaths = filePageImagePaths.get(file.id);
    const relevantPages = fileRelevantPages.get(file.id);

    if (!imagePaths || !relevantPages || relevantPages.size === 0) {
      logger.info({ fileId: file.id }, "Bbox scan skipped — no PNG images available");
      continue;
    }

    let scanResult: ScanResult;
    const t_fileScan = Date.now();
    try {
      scanResult = await extractSignCalloutsPng(
        file.originalName,
        ai,
        imagePaths,
        relevantPages,
      );
    } catch (err) {
      logger.warn({ err, fileId: file.id }, "Bbox scan threw unexpectedly — skipping for file");
      continue;
    }
    const fileScanDurationMs = Date.now() - t_fileScan;

    if (scanResult.skipped) {
      logger.info({ fileId: file.id, reason: scanResult.skipReason }, "Bbox scan skipped for file");
      continue;
    }

    totalScanInputTokens += scanResult.inputTokens;
    totalScanOutputTokens += scanResult.outputTokens;
    totalScanCallouts += scanResult.callouts.length;

    // Group callouts by page number for efficient lookup
    const calloutsByPage = new Map<number, GeminiCallout[]>();
    for (const c of scanResult.callouts) {
      const pg = c.page_number;
      if (!calloutsByPage.has(pg)) calloutsByPage.set(pg, []);
      calloutsByPage.get(pg)!.push(c);
    }

    const { finalRows, discoveryRows } = spatialMatchAndDedup(finalTextRows, calloutsByPage, file.id);
    finalTextRows = finalRows;
    allImageRows.push(...discoveryRows);

    pipelineSteps.push({
      step: `visual_scan_${file.id}`,
      label: filesToProcess.length > 1
        ? `Visual bbox scan — ${file.originalName}`
        : "Visual bbox scan",
      durationMs: fileScanDurationMs,
      startedAt: new Date(t_fileScan).toISOString(),
      details: {
        callouts: scanResult.callouts.length,
        discoveries: discoveryRows.length,
        inputTokens: scanResult.inputTokens,
        outputTokens: scanResult.outputTokens,
      },
    });

    logger.info({
      jobId,
      fileId: file.id,
      callouts: scanResult.callouts.length,
      discoveries: discoveryRows.length,
    }, "Spatial match and dedup complete for file");
  }

  totalImageInputTokens += totalScanInputTokens;
  totalImageOutputTokens += totalScanOutputTokens;

  recordStep("visual_scan", "Visual bbox scan + spatial dedup", t_scan, {
    totalCallouts: totalScanCallouts,
    totalDiscoveries: allImageRows.length,
    inputTokens: totalScanInputTokens,
    outputTokens: totalScanOutputTokens,
  });

  // ── Persist floor plan bboxes + AI region bboxes to DB ──────────────────────
  // For each file, collect all bboxes computed during word-match for pages
  // classified as floor_plan or both.  Store them in pageStats.floorPlanBboxes
  // so the viewer can read the authoritative bbox without recomputing.
  // Also persist AI-detected region bboxes (aiRegionBboxes) for the viewer overlay.
  {
    const t_bbox = Date.now();

    // Build a map of fileId → pageStats from successful extraction results
    const filePageStats = new Map<string, { floorPlanPages: number[]; bothPages?: number[] }>();
    for (const result of fileResults) {
      if (result.ok) {
        filePageStats.set(result.file.id, result.textResult.pageStats);
      }
    }

    // Group pageCache entries by fileId, collecting only floor_plan / both pages
    const bboxesByFile = new Map<string, Record<string, { x0: number; y0: number; x1: number; y1: number }>>();
    for (const [key, entry] of pageCache.entries()) {
      if (!entry.bbox) continue;
      const colonIdx = key.indexOf(":");
      if (colonIdx === -1) continue;
      const fileId = key.slice(0, colonIdx);
      const pageNum = parseInt(key.slice(colonIdx + 1), 10);
      const ps = filePageStats.get(fileId);
      if (!ps) continue;
      const isFloorPlan = ps.floorPlanPages.includes(pageNum);
      const isBoth = (ps.bothPages ?? []).includes(pageNum);
      if (!isFloorPlan && !isBoth) continue;
      if (!bboxesByFile.has(fileId)) bboxesByFile.set(fileId, {});
      bboxesByFile.get(fileId)![String(pageNum)] = entry.bbox;
    }

    // Group AI region bboxes by fileId
    type AiRegionBbox = {
      floorPlan: { x0: number; y0: number; x1: number; y1: number } | null;
      signSchedule: { x0: number; y0: number; x1: number; y1: number } | null;
    };
    const aiRegionBboxesByFile = new Map<string, Record<string, AiRegionBbox>>();
    for (const [key, regions] of allAiRegions.entries()) {
      const colonIdx = key.indexOf(":");
      if (colonIdx === -1) continue;
      const fileId = key.slice(0, colonIdx);
      const pageNum = key.slice(colonIdx + 1);
      if (!aiRegionBboxesByFile.has(fileId)) aiRegionBboxesByFile.set(fileId, {});
      aiRegionBboxesByFile.get(fileId)![pageNum] = {
        floorPlan: regions.floorPlan,
        signSchedule: regions.signSchedule,
      };
    }

    // Collect all fileIds that have either set of bboxes
    const allFileIds = new Set([...bboxesByFile.keys(), ...aiRegionBboxesByFile.keys()]);

    // Write bboxes to the DB for each file that has them, merging into existing pageStats
    await Promise.all(
      Array.from(allFileIds).map(async (fileId) => {
        const floorPlanBboxes = bboxesByFile.get(fileId);
        const aiRegionBboxes = aiRegionBboxesByFile.get(fileId);
        if (!floorPlanBboxes && !aiRegionBboxes) return;
        try {
          const [existing] = await db.select({ pageStats: jobFilesTable.pageStats }).from(jobFilesTable).where(eq(jobFilesTable.id, fileId));
          if (!existing) return;
          const updatedPageStats = {
            ...existing.pageStats,
            ...(floorPlanBboxes ? { floorPlanBboxes } : {}),
            ...(aiRegionBboxes ? { aiRegionBboxes } : {}),
          } as NonNullable<typeof existing.pageStats>;
          await db.update(jobFilesTable).set({ pageStats: updatedPageStats }).where(eq(jobFilesTable.id, fileId));
          logger.debug(
            { fileId, fpPages: Object.keys(floorPlanBboxes ?? {}).length, aiPages: Object.keys(aiRegionBboxes ?? {}).length },
            "Persisted floor plan bboxes + AI region bboxes"
          );
        } catch (err) {
          logger.warn({ err, fileId }, "Failed to persist floor plan bboxes — non-fatal");
        }
      })
    );

    const pagesWithBbox = Array.from(bboxesByFile.values()).reduce((sum, m) => sum + Object.keys(m).length, 0);
    recordStep("bbox_persist", "Floor plan bbox persistence", t_bbox, {
      filesWithBboxes: bboxesByFile.size,
      pagesWithBboxes: pagesWithBbox,
    });
  }

  const t_insert = Date.now();
  if (finalTextRows.length > 0) {
    await db.insert(extractedSignsTable).values(finalTextRows);
  }
  if (allImageRows.length > 0) {
    await db.insert(extractedSignsTable).values(allImageRows);
  }
  recordStep("db_insert", "Database insertion", t_insert, {
    textRows: finalTextRows.length,
    imageRows: allImageRows.length,
  });

  await saveParsedResult(jobId, parsedResults);

  const failedCount = parsedResults.filter((r) => "error" in r).length;
  const allFailed = failedCount === files.length;

  // Add total wall-clock step at the very end
  recordStep("total", "Total pipeline", jobStart, {
    totalInputTokens,
    totalOutputTokens,
    totalImageInputTokens,
    totalImageOutputTokens,
    signsExtracted: finalTextRows.length + allImageRows.length,
  });

  if (allFailed) {
    const errorSummary = parsedResults
      .filter((r): r is { fileId: string; fileName: string; error: string } => "error" in r)
      .map((r) => `${r.fileName}: ${r.error}`)
      .join("; ");
    await db
      .update(jobsTable)
      .set({ status: "failed", error: `All files failed extraction: ${errorSummary}`, processingLog: pipelineSteps, updatedAt: new Date() })
      .where(eq(jobsTable.id, jobId));
    logger.warn({ jobId, failedCount }, "All files failed — marking job as failed");
    return;
  }

  await db
    .update(jobsTable)
    .set({
      status: "completed",
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      imageInputTokens: totalImageInputTokens,
      imageOutputTokens: totalImageOutputTokens,
      processingLog: pipelineSteps,
      updatedAt: new Date(),
    })
    .where(eq(jobsTable.id, jobId));

  logger.info(
    {
      jobId,
      textCount: finalTextRows.length,
      imageCount: allImageRows.length,
      failedCount,
      totalInputTokens,
      totalOutputTokens,
      totalImageInputTokens,
      totalImageOutputTokens,
    },
    "Job processing complete"
  );
}
