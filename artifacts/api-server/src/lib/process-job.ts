import path from "path";
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
import { extractSignsFromPdf, extractSignsFromPdfImageVerify, extractProjectInfo, extractTextFromPdf, isSpecFile, buildSpecContextString, type ProjectInfo, type VerifiedSignSummary, type TextContextSign, type VerificationItem, type ExtractedSignRow } from "./extraction";
import { saveParsedResult, getFilePageImagesDir, PAGES_DIR } from "./storage";
import { renderFloorPlanPages, detectPageRegions, type PageRegions } from "./pdf-render";
import { logger } from "./logger";
import { extractPagePhrases, detectFloorPlanBbox, matchLocationToCoords, classifyPageFromPhrases, type PdfPhrase, type FloorPlanBbox, type SpatialPageType } from "./pdf-words";


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
  const allVerifications: (VerificationItem & { fileId: string })[] = [];
  const parsedResults: Record<string, unknown>[] = [];
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
    const { info, inputTokens: piIn, outputTokens: piOut } = await extractProjectInfo(firstFile.storedPath, ai);
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
        const { pages } = await extractTextFromPdf(specFile.storedPath);
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
        imageResult: Awaited<ReturnType<typeof extractSignsFromPdfImageVerify>>;
        textDurationMs: number;
        imageDurationMs: number;
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
        const t_spatial = Date.now();
        try {
          const { getPdfPageCount } = await import("./pdf-words");
          const numPages = await getPdfPageCount(file.storedPath);
          spatialPageTypes = new Map<number, SpatialPageType>();
          await Promise.all(
            Array.from({ length: numPages }, (_, i) => i + 1).map(async (pageNum) => {
              try {
                const pageWords = await extractPagePhrases(file.storedPath, file.id, pageNum);
                const spatialType = classifyPageFromPhrases(pageWords.phrases);
                if (spatialType !== "unknown") {
                  spatialPageTypes!.set(pageNum, spatialType);
                }
              } catch {
                // individual page failures are non-fatal
              }
            })
          );
          const floorPlanCount = [...spatialPageTypes.values()].filter((t) => t === "floor_plan" || t === "both").length;
          const signScheduleCount = [...spatialPageTypes.values()].filter((t) => t === "sign_schedule" || t === "both").length;
          logger.info(
            {
              jobId,
              file: file.originalName,
              spatialClassified: spatialPageTypes.size,
              floorPlan: floorPlanCount,
              signSchedule: signScheduleCount,
            },
            "Spatial page classification complete"
          );
          pipelineSteps.push({
            step: `spatial_prepass_${file.id}`,
            label: filesToProcess.length > 1
              ? `Spatial pre-pass — ${file.originalName}`
              : "Spatial pre-pass",
            durationMs: Date.now() - t_spatial,
            startedAt: new Date(t_spatial).toISOString(),
            details: {
              pages: numPages,
              classified: spatialPageTypes.size,
              floorPlan: floorPlanCount,
              signSchedule: signScheduleCount,
            },
          });
        } catch (err) {
          logger.warn({ err, file: file.originalName }, "Spatial pre-pass failed — falling back to text heuristics");
          spatialPageTypes = undefined;
        }

        const t_text = Date.now();
        const textResult = await extractSignsFromPdf(
          file.storedPath,
          ai,
          projectContext,
          allVerifiedForFile.length > 0 ? allVerifiedForFile : undefined,
          crossJobVerified.length > 0 ? crossJobVerified : undefined,
          specTypeContext,
          spatialPageTypes
        );
        const textDurationMs = Date.now() - t_text;

        // Build page → text-sign context map for the visual verification prompt
        const textSignsByPage = new Map<number, TextContextSign[]>();
        for (const row of textResult.rows) {
          const pg = row.page_number ?? 1;
          if (!textSignsByPage.has(pg)) textSignsByPage.set(pg, []);
          textSignsByPage.get(pg)!.push({
            sign_identifier: row.sign_identifier,
            location: row.location,
            sign_type: row.sign_type,
            sheet_number: row.sheet_number,
            page_number: row.page_number,
          });
        }

        // Gate: skip visual verification if text extraction is already high-confidence
        const HIGH_CONF_THRESHOLD = 0.80;   // per-sign minimum
        const HIGH_CONF_RATIO     = 0.80;   // fraction of signs that must meet it
        const MIN_SIGNS_TO_GATE   = 3;      // don't gate on tiny extractions

        const highConfCount = textResult.rows.filter(
          (r) => (r.confidence_score ?? 0) >= HIGH_CONF_THRESHOLD
        ).length;
        const highConfRatio = textResult.rows.length > 0
          ? highConfCount / textResult.rows.length
          : 0;

        const skipVerification =
          textResult.rows.length >= MIN_SIGNS_TO_GATE &&
          highConfRatio >= HIGH_CONF_RATIO;

        if (skipVerification) {
          logger.info(
            { jobId, fileId: file.id, signs: textResult.rows.length, highConfRatio: Math.round(highConfRatio * 100) },
            "Visual verification skipped — text extraction confidence is high"
          );
        }

        const relevantPageNums = new Set([
          ...textResult.pageStats.floorPlanPages,
          ...textResult.pageStats.signSchedulePages,
        ]);

        // ── PNG pre-render: rasterize ALL relevant pages ──────────────────────
        // Includes floor_plan, both, AND sign_schedule pages so the Gemini
        // PNG fast-path can always use images for every relevant page.
        // Run BEFORE verification.  Failures are non-fatal.
        const pngPageNumsSet = new Set([
          ...textResult.pageStats.floorPlanPages,
          ...(textResult.pageStats.bothPages ?? []),
          ...textResult.pageStats.signSchedulePages,
        ]);
        const pngPageNums = Array.from(pngPageNumsSet).sort((a, b) => a - b);
        // pageImagePathsRelative: stored in DB (relative paths, no filesystem disclosure)
        // pageImagePathsAbsolute: passed to extraction / Gemini (must be absolute for fs.readFile)
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

        const t_image = skipVerification ? 0 : Date.now();
        const imageResult = skipVerification
          ? {
              verifications: [] as VerificationItem[],
              discoveries: [],
              inputTokens: 0,
              outputTokens: 0,
              skipped: true as const,
              skipReason: `High-confidence skip (${Math.round(highConfRatio * 100)}% of ${textResult.rows.length} signs ≥ ${HIGH_CONF_THRESHOLD} confidence)`,
            }
          : await extractSignsFromPdfImageVerify(
              file.storedPath,
              ai,
              textSignsByPage,
              relevantPageNums,
              pageImagePathsAbsolute ?? undefined,
            ).catch((err) => {
              logger.warn({ err, fileId: file.id }, "Visual verification threw unexpectedly — skipping");
              return { verifications: [] as VerificationItem[], discoveries: [], inputTokens: 0, outputTokens: 0, skipped: true as const, skipReason: "Internal error" };
            });
        const imageDurationMs = skipVerification ? 0 : Date.now() - t_image;

        // Merge relative pageImagePaths into pageStats before persisting
        const finalPageStats = pageImagePathsRelative
          ? { ...textResult.pageStats, pageImagePaths: pageImagePathsRelative }
          : textResult.pageStats;

        // Per-file DB update is safe to do inside the parallel map
        await db
          .update(jobFilesTable)
          .set({ pageCount: textResult.pageCount, extractedText: textResult.rawText.slice(0, 10000), pageStats: finalPageStats })
          .where(eq(jobFilesTable.id, file.id));

        return { ok: true, file, textResult, imageResult, textDurationMs, imageDurationMs };
      } catch (err) {
        logger.error({ err, fileId: file.id, fileName: file.originalName }, "File extraction failed");
        return { ok: false, file, error: String(err) };
      }
    })
  );

  // Record overall extraction wall-clock time (files ran in parallel)
  recordStep("extraction", "Sign extraction (all files)", t_extraction, {
    fileCount: filesToProcess.length,
    succeeded: fileResults.filter((r) => r.ok).length,
    failed: fileResults.filter((r) => !r.ok).length,
  });

  // ── Merge parallel results into accumulator arrays ────────────────────────
  for (const result of fileResults) {
    if (!result.ok) {
      parsedResults.push({ fileId: result.file.id, fileName: result.file.originalName, error: result.error });
      continue;
    }

    const { file, textResult, imageResult, textDurationMs, imageDurationMs } = result;

    // Record individual file steps so users can see per-file breakdown
    pipelineSteps.push({
      step: `text_extraction_${file.id}`,
      label: filesToProcess.length > 1
        ? `Text extraction — ${file.originalName}`
        : "Text extraction",
      durationMs: textDurationMs,
      startedAt: new Date(Date.now() - textDurationMs - imageDurationMs).toISOString(),
      details: { rows: textResult.rows.length, pages: textResult.pageCount, inputTokens: textResult.inputTokens, outputTokens: textResult.outputTokens },
    });
    pipelineSteps.push({
      step: `visual_verification_${file.id}`,
      label: filesToProcess.length > 1
        ? `Visual verification — ${file.originalName}`
        : "Visual verification",
      durationMs: imageDurationMs,
      startedAt: new Date(Date.now() - imageDurationMs).toISOString(),
      details: {
        verified: imageResult.verifications?.length ?? 0,
        discoveries: imageResult.discoveries?.length ?? 0,
        skipped: imageResult.skipped ?? false,
        ...(imageResult.skipReason ? { skipReason: imageResult.skipReason } : {}),
      },
    });

    totalInputTokens += textResult.inputTokens;
    totalOutputTokens += textResult.outputTokens;
    totalImageInputTokens += imageResult.inputTokens;
    totalImageOutputTokens += imageResult.outputTokens;

    parsedResults.push({
      fileId: file.id,
      fileName: file.originalName,
      pageCount: textResult.pageCount,
      rowCount: textResult.rows.length,
      imageRowCount: imageResult.discoveries.length,
      imageSkipped: imageResult.skipped ?? false,
      rows: textResult.rows,
    });

    // Apply visual-verification boosts / flags to text rows in-memory
    const findVerification = (row: ExtractedSignRow): VerificationItem | undefined => {
      if (imageResult.skipped) return undefined;
      if (row.sign_identifier) {
        const m = imageResult.verifications.find(
          (v) => v.sign_identifier?.toLowerCase() === row.sign_identifier!.toLowerCase()
        );
        if (m) return m;
      }
      if (row.location) {
        const rLoc = row.location.toLowerCase();
        const m = imageResult.verifications.find(
          (v) => v.location != null && (v.location.toLowerCase().includes(rLoc) || rLoc.includes(v.location.toLowerCase()))
        );
        if (m) return m;
      }
      return undefined;
    };

    for (const row of textResult.rows) {
      const verif = findVerification(row);
      let conf = row.confidence_score;
      let flag = row.review_flag;

      if (verif) {
        if (verif.status === "CONFIRMED") {
          conf = Math.min(1.0, conf + 0.15);
          flag = conf < 0.75;
        } else if (verif.status === "NOT_FOUND") {
          flag = true;
        }
      }

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
        confidenceScore: conf,
        reviewFlag: flag,
        extractionMethod: "text",
        rawJson: row as unknown as Record<string, unknown>,
      });
    }

    for (const row of imageResult.discoveries) {
      allImageRows.push({
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
        xPos: null,
        yPos: null,
        confidenceScore: row.confidence_score,
        reviewFlag: true,
        extractionMethod: "image",
        rawJson: row as unknown as Record<string, unknown>,
      });
    }

    allVerifications.push(...imageResult.verifications.map(v => ({ ...v, fileId: file.id })));

    if (imageResult.skipped) {
      logger.info({ jobId, file: file.originalName, reason: imageResult.skipReason }, "Visual verification skipped for file");
    } else {
      logger.info({
        jobId,
        file: file.originalName,
        verifications: imageResult.verifications.length,
        confirmed: imageResult.verifications.filter(v => v.status === "CONFIRMED").length,
        notFound: imageResult.verifications.filter(v => v.status === "NOT_FOUND").length,
        discoveries: imageResult.discoveries.length,
      }, "Visual verification complete for file");
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

  async function assignCoords(rows: InsertExtractedSign[]): Promise<InsertExtractedSign[]> {
    return Promise.all(
      rows.map(async (row) => {
        // Skip rows that already have a manually placed position
        if (row.xPos != null && row.yPos != null) return row;
        if (!row.jobFileId || !row.pageNumber) return row;
        const storedPath = filePathById.get(row.jobFileId);
        if (!storedPath) return row;

        // Do not place markers for signs on sign-schedule-only pages.
        // These rows appear in the review table but should have no floor plan marker.
        // We check whether we have floor plan page info for this file: if we do,
        // any page not in the floor-plan set (including when the set is empty, which
        // means the file has NO floor plan pages at all) must not receive coordinates.
        const fpPages = floorPlanPagesByFileId.get(row.jobFileId);
        if (fpPages !== undefined && !fpPages.has(row.pageNumber)) {
          return row; // skip coordinate assignment — not a floor plan page
        }

        try {
          const { phrases, bbox } = await getPageData(storedPath, row.jobFileId, row.pageNumber);
          const match = matchLocationToCoords(phrases, bbox, row.location, row.signIdentifier);
          if (match) {
            return { ...row, xPos: match.xPos, yPos: match.yPos, placementSource: "word_match" };
          }
        } catch (err) {
          logger.debug({ err, signId: row.signIdentifier, location: row.location }, "Word-match failed for sign");
        }
        return row;
      })
    );
  }

  // Deduplicate within each pass, then remove cross-pass duplicates from image rows
  const t_dedup = Date.now();
  const dedupedTextRows = deduplicateSignRows(allTextRows);
  const textSeenKeys = new Set(
    dedupedTextRows
      .filter((r) => r.location && r.signType)
      .map((r) => `${r.location!.toLowerCase().trim()}||${r.signType!.toLowerCase().trim()}`),
  );
  const dedupedImageRows = deduplicateSignRows(
    allImageRows.filter((r) => {
      if (!r.location || !r.signType) return true;
      return !textSeenKeys.has(`${r.location.toLowerCase().trim()}||${r.signType.toLowerCase().trim()}`);
    }),
  );

  logger.info(
    {
      jobId,
      textBefore: allTextRows.length,
      textAfter: dedupedTextRows.length,
      imageBefore: allImageRows.length,
      imageAfter: dedupedImageRows.length,
    },
    "Sign deduplication complete",
  );
  recordStep("deduplication", "Sign deduplication", t_dedup, {
    textBefore: allTextRows.length,
    textAfter: dedupedTextRows.length,
    imageBefore: allImageRows.length,
    imageAfter: dedupedImageRows.length,
  });

  // Run word-match coordinate assignment on both sets of rows
  const t_wordmatch = Date.now();
  const coordedTextRows = await assignCoords(dedupedTextRows);
  const coordedImageRows = await assignCoords(dedupedImageRows);

  const matchedText = coordedTextRows.filter((r) => r.placementSource === "word_match").length;
  const matchedImage = coordedImageRows.filter((r) => r.placementSource === "word_match").length;
  logger.info({ jobId, textRows: coordedTextRows.length, matchedText, imageRows: coordedImageRows.length, matchedImage }, "Word-match coordinate assignment complete");
  recordStep("word_match", "Coordinate matching (word-match)", t_wordmatch, {
    totalSigns: coordedTextRows.length + coordedImageRows.length,
    matched: matchedText + matchedImage,
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
  if (coordedTextRows.length > 0) {
    await db.insert(extractedSignsTable).values(coordedTextRows);
  }
  if (coordedImageRows.length > 0) {
    await db.insert(extractedSignsTable).values(coordedImageRows);
  }
  recordStep("db_insert", "Database insertion", t_insert, {
    textRows: coordedTextRows.length,
    imageRows: coordedImageRows.length,
  });

  // Log overall verification stats (actual boosts applied in-memory per-file above)
  if (allVerifications.length > 0) {
    const confirmed = allVerifications.filter(v => v.status === "CONFIRMED").length;
    const notFound = allVerifications.filter(v => v.status === "NOT_FOUND").length;
    logger.info(
      {
        jobId,
        totalVerifications: allVerifications.length,
        confirmed,
        notFound,
        uncertain: allVerifications.length - confirmed - notFound,
        discoveries: allImageRows.length,
      },
      "Verification complete"
    );
  }

  await saveParsedResult(jobId, parsedResults);

  const failedCount = parsedResults.filter((r) => "error" in r).length;
  const allFailed = failedCount === files.length;

  // Add total wall-clock step at the very end
  recordStep("total", "Total pipeline", jobStart, {
    totalInputTokens,
    totalOutputTokens,
    totalImageInputTokens,
    totalImageOutputTokens,
    signsExtracted: coordedTextRows.length + coordedImageRows.length,
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
      textCount: allTextRows.length,
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
