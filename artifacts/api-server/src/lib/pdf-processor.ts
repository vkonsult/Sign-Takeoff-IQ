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
  type PlaqueTableData,
} from "@workspace/db";

import { extractTextFromPdf, isSpecFile } from "./extraction";
import { extractSignsHeuristic } from "./extraction-heuristic";
import { isCodeOnlyLocation } from "./sign-vocabulary";
import { saveParsedResult, getFilePageImagesDir, PAGES_DIR } from "./storage";
import { renderFloorPlanPages } from "./pdf-render";
import { logger } from "./logger";
import {
  extractPagePhrases,
  extractRawPageItems,
  matchLocationToCoords,
  extractTitleBlockBuildingType,
  extractCodeProximityPairs,
  type PdfPhrase,
} from "./pdf-words";
import { buildSheetManifest } from "./sheet-manifest";
import {
  extractSignageData,
  type SignTypeSpec,
  type ScheduleEntry,
} from "./signage-schedule-parser";
import { extractSignSchedule } from "./sign-schedule-extractor";

export async function runPdfProcessor(jobId: string): Promise<void> {
  const pipelineSteps: ProcessingStep[] = [];
  const jobStart = Date.now();

  async function setCurrentStep(label: string | null): Promise<void> {
    try {
      await db
        .update(jobsTable)
        .set({ currentStep: label })
        .where(eq(jobsTable.id, jobId));
    } catch {
      // non-fatal
    }
  }

  function recordStep(
    step: string,
    label: string,
    stepStart: number,
    details?: Record<string, unknown>,
    phase?: string,
  ): void {
    pipelineSteps.push({
      step,
      label,
      durationMs: Date.now() - stepStart,
      startedAt: new Date(stepStart).toISOString(),
      ...(phase ? { phase } : {}),
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
    .set({ status: "processing", plaqueTable: null, updatedAt: new Date() })
    .where(eq(jobsTable.id, jobId));

  const files = await db
    .select()
    .from(jobFilesTable)
    .where(eq(jobFilesTable.jobId, jobId));

  if (files.length === 0) {
    await db
      .update(jobsTable)
      .set({ status: "failed", error: "No files found for this job", currentStep: null, updatedAt: new Date() })
      .where(eq(jobsTable.id, jobId));
    return;
  }

  // ── Spec vs data file routing ─────────────────────────────────────────────
  const specFiles = files.filter((f) => isSpecFile(f.originalName));
  const dataFiles = files.filter((f) => !isSpecFile(f.originalName));
  const hasDataFiles = dataFiles.length > 0;

  // Extract raw text from spec files for metadata (no AI)
  if (specFiles.length > 0 && hasDataFiles) {
    await setCurrentStep("Processing spec files…");
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
    recordStep("spec_processing", "Spec file processing (text-only)", t_spec, { specFileCount: specFiles.length }, "phase-1");
  }

  const filesToProcess = hasDataFiles ? dataFiles : files;

  // ── Per-file processing ───────────────────────────────────────────────────
  const parsedResults: Record<string, unknown>[] = [];
  const allPageImagePaths = new Map<string, Record<string, string>>();
  const allSpatialFloorLevelNames = new Map<string, Map<number, string>>();
  const fileFloorPlanPages = new Map<string, Set<number>>();

  // Accumulate schedule parser results across all files for batch DB insertion
  const allScheduleSpecs: Array<SignTypeSpec & { fileId: string; fileStoredPath: string }> = [];
  const allScheduleEntries: Array<ScheduleEntry & { fileId: string }> = [];

  // Track schedule pages per file so extractSignSchedule() can be called after the parallel loop
  const fileSchedulePages = new Map<string, number[]>();

  // Building type is detected from the title block of the first/cover page
  // and shared across all files in this job.  Set once; never overwritten.
  let detectedBuildingType: string | null = null;

  await setCurrentStep("Extracting floor plans…");
  const t_extraction = Date.now();

  await Promise.all(
    filesToProcess.map(async (file) => {
      try {
        logger.info({ jobId, file: file.originalName }, "[PDF Processor] Processing file");

        // Read any previously rejected page numbers so they are preserved across re-runs.
        const existingRejectedPages: number[] = (file.pageStats as { rejectedPageNumbers?: number[] } | null)?.rejectedPageNumbers ?? [];

        // ── Phase 2: Sheet Manifest ───────────────────────────────────────
        // Replaces the legacy spatial pre-pass. Classifies every page into
        // one of 10 buckets using a 3-pass cascade (bookmarks → title block
        // strips → full-page scan for excerpts).
        const t_manifest = Date.now();
        const manifest = await buildSheetManifest(file.storedPath, file.id);
        manifest.warnings.forEach((w) =>
          logger.warn({ jobId, fileId: file.id, warning: w }, "[PDF Processor] Sheet manifest warning")
        );

        const finalFloorPlanPages = manifest.entries
          .filter((e) => e.bucket === "floor_plan")
          .map((e) => e.pdfPage);
        const finalSignSchedulePages = manifest.entries
          .filter((e) => e.bucket === "signage_schedule")
          .map((e) => e.pdfPage);
        const finalBothPages: number[] = []; // "both" bucket removed in 10-bucket system
        const lifeSafetyPages = manifest.entries
          .filter((e) => e.bucket === "life_safety")
          .map((e) => e.pdfPage);

        // Level names from manifest (pdfPage → normalized level)
        const spatialFloorLevelNames = new Map<number, string>();
        for (const entry of manifest.entries) {
          if (entry.level) spatialFloorLevelNames.set(entry.pdfPage, entry.level);
        }

        const fpSet = new Set<number>(finalFloorPlanPages);
        fileFloorPlanPages.set(file.id, fpSet);
        allSpatialFloorLevelNames.set(file.id, spatialFloorLevelNames);

        // Building-type detection from first page title block (phrase cache warm from manifest)
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

        recordStep(
          `sheet_manifest_${file.id}`,
          filesToProcess.length > 1 ? `Sheet manifest — ${file.originalName}` : "Sheet manifest",
          t_manifest,
          {
            totalPages: manifest.totalPages,
            floorPlan: finalFloorPlanPages.length,
            signSchedule: finalSignSchedulePages.length,
            lifeSafety: lifeSafetyPages.length,
            isExcerpt: manifest.isExcerpt,
            source: manifest.entries[0]?.source ?? "none",
          }
        );

        // ── Raw text extraction (no AI) ───────────────────────────────────
        const t_text = Date.now();
        const { pages, numPages } = await extractTextFromPdf(file.storedPath, file.id);
        const rawText = pages.map((p) => p.text).join("\n");

        // Derive otherPages for pageStats — all pages not in a named bucket.
        const classifiedManifestSet = new Set([
          ...finalFloorPlanPages,
          ...finalSignSchedulePages,
          ...finalBothPages,
          ...lifeSafetyPages,
        ]);
        const otherPages: number[] = [];
        for (const page of pages) {
          if (!classifiedManifestSet.has(page.pageNum)) otherPages.push(page.pageNum);
        }

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
          fileSchedulePages.set(file.id, schedulePageNums);
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
        // Exclude any previously-rejected pages from all classification lists.
        const rejectedSet = new Set(existingRejectedPages);
        const filterRejected = (pages: number[]) => pages.filter((p) => !rejectedSet.has(p));

        const floorPageLevels = spatialFloorLevelNames.size > 0
          ? Object.fromEntries(spatialFloorLevelNames)
          : undefined;

        // Build bookmark titles + outline sections from manifest for downstream consumers.
        const bookmarkTitles: Record<number, string> = {};
        const outlineSections: Array<{ title: string; pageStart: number; pageEnd: number; bucket: string }> = [];
        for (const entry of manifest.entries) {
          if (entry.source === "bookmark") {
            bookmarkTitles[entry.pdfPage] = entry.sheetTitle;
          }
        }
        // Compact bookmark entries into contiguous ranges for the outline sections record.
        const bookmarkEntries = manifest.entries.filter((e) => e.source === "bookmark");
        if (bookmarkEntries.length > 0) {
          let curTitle = bookmarkEntries[0]!.sheetTitle;
          let curBucket = bookmarkEntries[0]!.bucket;
          let curStart = bookmarkEntries[0]!.pdfPage;
          let curEnd = bookmarkEntries[0]!.pdfPage;
          for (let i = 1; i < bookmarkEntries.length; i++) {
            const e = bookmarkEntries[i]!;
            if (e.sheetTitle === curTitle && e.pdfPage === curEnd + 1) {
              curEnd = e.pdfPage;
            } else {
              outlineSections.push({ title: curTitle, pageStart: curStart, pageEnd: curEnd, bucket: curBucket });
              curTitle = e.sheetTitle; curBucket = e.bucket; curStart = e.pdfPage; curEnd = e.pdfPage;
            }
          }
          outlineSections.push({ title: curTitle, pageStart: curStart, pageEnd: curEnd, bucket: curBucket });
        }

        const pageStats = {
          floorPlanPages: filterRejected(finalFloorPlanPages),
          signSchedulePages: filterRejected(finalSignSchedulePages),
          bothPages: filterRejected(finalBothPages),
          lifeSafetyPages: filterRejected(lifeSafetyPages),
          otherPages: filterRejected(otherPages),
          sheetManifest: manifest.entries.map((e) => ({
            pdfPage: e.pdfPage,
            bucket: e.bucket,
            sheetTitle: e.sheetTitle,
            sheetNumber: e.sheetNumber,
            level: e.level,
            area: e.area,
            building: e.building,
            source: e.source,
          })),
          ...(existingRejectedPages.length > 0 ? { rejectedPageNumbers: existingRejectedPages } : {}),
          ...(pageImagePathsRelative ? { pageImagePaths: pageImagePathsRelative } : {}),
          ...(floorPageLevels ? { floorPageLevels } : {}),
          ...(Object.keys(bookmarkTitles).length > 0 ? { bookmarkTitles } : {}),
          ...(outlineSections.length > 0 ? { outlineSections } : {}),
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

  // ── Phase 3: Sign Schedule Extraction (Gemini visual read) ───────────────
  // For every file that has signage schedule pages, run the Gemini visual read
  // to produce a structured plaque table (PlaqueTypeRow[]).  Falls back to the
  // text parser if Gemini fails or returns 0 rows.
  // Results are collected in-memory across all files, then aggregated into a
  // single authoritative job-level plaqueTable (no stale carryover from prior runs).
  {
    type FileResult = { plaqueTypes: import("@workspace/db").PlaqueTypeRow[]; generalNotes: string[]; sourcePages: number[]; extractionMethod: "visual" | "text_fallback"; warnings: string[] };
    const phase3Results: FileResult[] = [];

    for (const file of filesToProcess) {
      const schedulePageNums = fileSchedulePages.get(file.id) ?? [];
      if (schedulePageNums.length === 0) continue;

      const t_extract = Date.now();
      try {
        const extractResult = await extractSignSchedule(
          file.storedPath,
          file.id,
          schedulePageNums,
          jobId,
        );
        phase3Results.push(extractResult);
        pipelineSteps.push({
          step: `sign_schedule_extract_${file.id}`,
          label: filesToProcess.length > 1
            ? `Sign schedule extraction — ${file.originalName}`
            : "Sign schedule extraction",
          durationMs: Date.now() - t_extract,
          startedAt: new Date(t_extract).toISOString(),
          details: {
            pages: schedulePageNums.length,
            plaqueTypes: extractResult.plaqueTypes.length,
            method: extractResult.extractionMethod,
            warnings: extractResult.warnings,
          },
        });
        logger.info(
          {
            jobId,
            fileId: file.id,
            pages: schedulePageNums.length,
            plaqueTypes: extractResult.plaqueTypes.length,
            method: extractResult.extractionMethod,
            durationMs: Date.now() - t_extract,
          },
          "[PDF Processor] Phase 3 sign schedule extraction complete"
        );
      } catch (err) {
        logger.warn({ err, fileId: file.id }, "[PDF Processor] Phase 3 sign schedule extraction failed — non-fatal");
        pipelineSteps.push({
          step: `sign_schedule_extract_${file.id}`,
          label: filesToProcess.length > 1
            ? `Sign schedule extraction — ${file.originalName}`
            : "Sign schedule extraction",
          durationMs: Date.now() - t_extract,
          startedAt: new Date(t_extract).toISOString(),
          details: { error: String(err), pages: schedulePageNums.length },
        });
      }
    }

    // Aggregate all per-file results into a single authoritative job-level plaqueTable.
    // extractionMethod: "visual" only if ALL files used visual; otherwise "text_fallback".
    if (phase3Results.length > 0) {
      const allPlaqueTypes = new Map<string, import("@workspace/db").PlaqueTypeRow>();
      const allGeneralNotes: string[] = [];
      const allSourcePages: number[] = [];
      const allWarnings: string[] = [];
      let anyTextFallback = false;

      for (const r of phase3Results) {
        if (r.extractionMethod === "text_fallback") anyTextFallback = true;
        for (const pt of r.plaqueTypes) {
          const key = pt.typeCode.toUpperCase();
          if (!allPlaqueTypes.has(key)) allPlaqueTypes.set(key, pt);
        }
        for (const note of r.generalNotes) {
          if (!allGeneralNotes.includes(note)) allGeneralNotes.push(note);
        }
        allSourcePages.push(...r.sourcePages);
        allWarnings.push(...r.warnings);
      }

      const aggregatedPlaqueTable: PlaqueTableData = {
        plaqueTypes: [...allPlaqueTypes.values()],
        generalNotes: allGeneralNotes,
        sourcePages: [...new Set(allSourcePages)].sort((a, b) => a - b),
        extractionMethod: anyTextFallback ? "text_fallback" : "visual",
        warnings: allWarnings,
      };

      try {
        await db
          .update(jobsTable)
          .set({ plaqueTable: aggregatedPlaqueTable })
          .where(eq(jobsTable.id, jobId));
        logger.info(
          { jobId, plaqueTypes: aggregatedPlaqueTable.plaqueTypes.length, method: aggregatedPlaqueTable.extractionMethod },
          "[PDF Processor] Phase 3 plaqueTable persisted on job"
        );
      } catch (err) {
        logger.warn({ err, jobId }, "[PDF Processor] Phase 3 plaqueTable persistence failed — non-fatal");
      }
    }
  }

  // ── Word-match coordinate assignment for preserved signs ──────────────────
  // Re-run coordinate matching for preserved signs that may have lost their positions.
  if (preservedSigns.length > 0) {
    await setCurrentStep("Matching coordinates…");
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
      .set({ status: "failed", error: `All files failed processing: ${errorSummary}`, processingLog: pipelineSteps, currentStep: null, updatedAt: new Date() })
      .where(eq(jobsTable.id, jobId));
    return;
  }

  await db
    .update(jobsTable)
    .set({
      status: "completed",
      processingLog: pipelineSteps,
      currentStep: null,
      updatedAt: new Date(),
      ...(detectedBuildingType ? { buildingType: detectedBuildingType } : {}),
    })
    .where(eq(jobsTable.id, jobId));

  logger.info(
    { jobId, preservedSigns: preservedSigns.length, failed: failedCount, buildingType: detectedBuildingType },
    "[PDF Processor] Processing complete"
  );
}
