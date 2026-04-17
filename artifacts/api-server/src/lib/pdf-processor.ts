/**
 * PDF Processor — all non-AI processing logic.
 * This module handles page classification, spatial analysis, PNG rendering,
 * raw text extraction, and coordinate matching without any Gemini AI calls.
 * processJob calls this module exclusively; AI calls are on-demand only.
 */

import path from "path";
import { eq, and, inArray } from "drizzle-orm";
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

import { extractTextFromPdf } from "./extraction";
import { isCodeOnlyLocation } from "./sign-vocabulary";
import { saveParsedResult, getFilePageImagesDir, PAGES_DIR } from "./storage";
import { renderFloorPlanPages } from "./pdf-render";
import { logger } from "./logger";
import {
  extractPagePhrases,
  extractRawPageItems,
  matchLocationToCoords,
  type PdfPhrase,
} from "./pdf-words";
import { runPhase2Classification } from "./phase-2-classification";
import { runPhase1Intake, classifyFileType } from "./phase-1-intake";
import {
  extractSignageData,
  type SignTypeSpec,
  type ScheduleEntry,
} from "./signage-schedule-parser";
import { extractSignSchedule } from "./sign-schedule-extractor";
import { applySignRules, assignmentToRows, type PlaqueEntry, type RuleEngineResult as EngineRuleEngineResult, type SignAssignment } from "./rule-engine";
import { verifyRuleEngineResult } from "./verifier";
import { buildRoomInventory, enrichAmbiguousRoomsWithAI, type RoomInventory, type RoomRecord } from "./room-inventory";
import { occurrenceGroupKey } from "./occurrence-group-key";

/**
 * Clear all sign-type data that is re-derived on every rescan so a fresh run
 * never inherits type codes or schedule rows from a prior run.
 *
 * Called at the very start of `runPdfProcessor` before any file processing
 * begins.  Exported so unit tests can verify the reset behaviour in isolation.
 */
export async function resetScanData(jobId: string): Promise<void> {
  await db
    .update(jobsTable)
    .set({ plaqueTable: null })
    .where(eq(jobsTable.id, jobId));

  await db
    .delete(signTypeSpecsTable)
    .where(eq(signTypeSpecsTable.jobId, jobId));

  await db
    .delete(signageScheduleEntriesTable)
    .where(eq(signageScheduleEntriesTable.jobId, jobId));
}

export interface PdfProcessorOptions {
  /** When set, only this file is re-processed (all other files are left as-is). */
  targetFileId?: string;
}

export async function runPdfProcessor(jobId: string, opts: PdfProcessorOptions = {}): Promise<void> {
  const { targetFileId } = opts;
  const isFileRetry = !!targetFileId;
  const pipelineSteps: ProcessingStep[] = [];
  const jobStart = Date.now();

  // ── currentStep batching ──────────────────────────────────────────────────
  // setCurrentStep buffers the label and absorbs it into the next
  // persistStepsNow write so the two fields are always updated in a single
  // round-trip.  A short deferred standalone write fires as a fallback for
  // phases where persistStepsNow does not follow within ~150 ms (e.g. the
  // long parallel floor-plan extraction block).
  let _pendingCurrentStep: string | null | undefined = undefined; // undefined = nothing pending
  let _currentStepTimer: ReturnType<typeof setTimeout> | null = null;
  let _processorDone = false; // set in finally; gates the deferred timer callback

  function cancelCurrentStepTimer(): void {
    _processorDone = true;
    _pendingCurrentStep = undefined;
    if (_currentStepTimer !== null) {
      clearTimeout(_currentStepTimer);
      _currentStepTimer = null;
    }
  }

  function setCurrentStep(label: string | null): void {
    _pendingCurrentStep = label;
    if (_currentStepTimer !== null) {
      clearTimeout(_currentStepTimer);
    }
    _currentStepTimer = setTimeout(() => {
      _currentStepTimer = null;
      if (_processorDone) return; // processor already finished; don't overwrite terminal state
      if (_pendingCurrentStep === undefined) return; // already flushed by persistStepsNow
      const toWrite = _pendingCurrentStep;
      _pendingCurrentStep = undefined;
      db.update(jobsTable)
        .set({ currentStep: toWrite })
        .where(eq(jobsTable.id, jobId))
        .catch(() => {});
    }, 150);
  }

  // ── Live-progress persistence ─────────────────────────────────────────────
  // Only active during full runs (not file-retry), so the retry merge logic can
  // still read the original pre-retry log from the DB at finalization time.
  // Uses a single-in-flight pattern to prevent out-of-order stale writes:
  // while a write is in flight any new snapshot is staged and flushed once the
  // current write settles.
  // Each flush also absorbs any pending currentStep label so both fields are
  // written in one SET, eliminating a separate round-trip per phase boundary.
  let _persistInFlight = false;
  let _pendingSnapshot: ProcessingStep[] | null = null;

  function flushNow(log: ProcessingStep[]): void {
    // Absorb any pending currentStep into this write and cancel its deferred timer.
    const stepToWrite = _pendingCurrentStep;
    if (stepToWrite !== undefined) {
      _pendingCurrentStep = undefined;
      if (_currentStepTimer !== null) {
        clearTimeout(_currentStepTimer);
        _currentStepTimer = null;
      }
    }

    _persistInFlight = true;
    const setFields = stepToWrite !== undefined
      ? { processingLog: log, currentStep: stepToWrite }
      : { processingLog: log };

    db.update(jobsTable)
      .set(setFields)
      .where(eq(jobsTable.id, jobId))
      .then(() => {
        _persistInFlight = false;
        if (_pendingSnapshot !== null && _pendingSnapshot.length > log.length) {
          const toFlush = _pendingSnapshot;
          _pendingSnapshot = null;
          flushNow(toFlush); // also absorbs any currentStep staged while the write was in flight
        } else {
          _pendingSnapshot = null;
        }
      })
      .catch(() => {
        _persistInFlight = false;
        _pendingSnapshot = null;
      });
  }

  function persistStepsNow(): void {
    if (isFileRetry) return; // Retry finalization merges from DB; skip live writes
    if (_persistInFlight) {
      _pendingSnapshot = [...pipelineSteps]; // stage latest for after current write
      return;
    }
    flushNow([...pipelineSteps]);
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
    persistStepsNow();
  }

  // ── Processing body ───────────────────────────────────────────────────────
  // Wrapped in try/finally so cancelCurrentStepTimer() always runs on exit,
  // preventing any deferred setCurrentStep write from firing after the
  // terminal DB update (status: failed/completed, currentStep: null).
  try {

  // ── Preserve verified + manually-added signs ─────────────────────────────
  // All auto-extracted signs (heuristic and AI) are wiped on rescan and re-derived
  // from the PDF. Only user-verified and manually-added signs survive.
  // For a per-file retry, only signs from that specific file are deleted.
  const existingSignsQuery = isFileRetry
    ? db.select().from(extractedSignsTable).where(
        and(
          eq(extractedSignsTable.jobId, jobId),
          eq(extractedSignsTable.jobFileId, targetFileId!),
        )
      )
    : db.select().from(extractedSignsTable).where(eq(extractedSignsTable.jobId, jobId));

  const existingSigns = await existingSignsQuery;

  const preservedSigns = existingSigns.filter(
    (s) => s.userVerified || s.manuallyAdded
  );

  logger.info({ jobId, targetFileId, preservedCount: preservedSigns.length, isFileRetry }, "[PDF Processor] Preserved verified/manually-added signs");

  // Delete auto-extracted signs; keep only user-verified and manually-added.
  // For a per-file retry, scope the delete to only the target file.
  if (isFileRetry) {
    await db
      .delete(extractedSignsTable)
      .where(
        and(
          eq(extractedSignsTable.jobId, jobId),
          eq(extractedSignsTable.jobFileId, targetFileId!),
          eq(extractedSignsTable.userVerified, false),
          eq(extractedSignsTable.manuallyAdded, false)
        )
      );
  } else {
    await db
      .delete(extractedSignsTable)
      .where(
        and(
          eq(extractedSignsTable.jobId, jobId),
          eq(extractedSignsTable.userVerified, false),
          eq(extractedSignsTable.manuallyAdded, false)
        )
      );
  }

  // Reset page classification and room inventory so re-runs start clean.
  // roomInventory is not re-emitted when a file has no floor-plan pages, so clearing
  // here prevents stale data from a prior run persisting after a re-scan.
  // For a per-file retry, scope the reset to only the target file.
  if (isFileRetry) {
    await db
      .update(jobFilesTable)
      .set({ pageStats: null, pageCount: null, roomInventory: null })
      .where(eq(jobFilesTable.id, targetFileId!));
  } else {
    await db
      .update(jobFilesTable)
      .set({ pageStats: null, pageCount: null, roomInventory: null })
      .where(eq(jobFilesTable.jobId, jobId));
  }

  // plaqueTable, signTypeSpecs, and signageScheduleEntries must all be cleared
  // before processing begins so a rescan never inherits stale type codes from a
  // prior run.  For a per-file retry, only file-scoped schedule data is cleared
  // (handled below at the sign-insertion stage via sourceFileId).
  if (!isFileRetry) {
    await resetScanData(jobId);
  }

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
      .set({ status: "failed", error: "No files found for this job", currentStep: null, updatedAt: new Date() })
      .where(eq(jobsTable.id, jobId));
    return;
  }

  // ── Spec vs data file routing ─────────────────────────────────────────────
  // `classifyFileType` is filename-only (no I/O) and intentionally runs before
  // the Phase 1 prepass so we know which files to run the full Phase 1 intake
  // on (data files only).  This is not a duplicate classification — it is the
  // lightweight routing gate that determines the Phase 1 scope.
  //
  // For a per-file retry, only the target file is processed; spec files are
  // skipped (their text was already extracted in the original run).
  const allSpecFiles = files.filter((f) => classifyFileType(f.originalName) === "spec");
  const allDataFiles = files.filter((f) => classifyFileType(f.originalName) === "data");

  // When retrying a single file, scope spec/data routing to only that file.
  const specFiles = isFileRetry
    ? allSpecFiles.filter((f) => f.id === targetFileId)
    : allSpecFiles;
  const dataFiles = isFileRetry
    ? allDataFiles.filter((f) => f.id === targetFileId)
    : allDataFiles;
  const hasDataFiles = isFileRetry
    ? allDataFiles.length > 0  // preserve original routing intent
    : dataFiles.length > 0;

  // Extract raw text from spec files for metadata (no AI)
  if (specFiles.length > 0 && hasDataFiles) {
    setCurrentStep("Processing spec files…");
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

  // For a per-file retry, filesToProcess is scoped to just the target file.
  // The original routing intent (data files vs. all files) still applies.
  const filesToProcess = isFileRetry
    ? files.filter((f) => f.id === targetFileId)
    : (hasDataFiles ? dataFiles : files);

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

  // Accumulate Phase 4 (room inventory) and Phase 5 (rule engine) results for Phase 6 wiring.
  const allEngineRuleResults: EngineRuleEngineResult[] = [];
  const allFileRoomInventories: RoomInventory[] = [];

  // ── Phase 1 Intake pre-pass (filesToProcess, parallel) ──────────────────────
  // Run Phase 1 for every file in `filesToProcess` (data files when data files
  // are present; all files otherwise).  Spec files are excluded when data files
  // exist because they go through a separate text-only extraction path above.
  // Running in parallel is fine because each file's intake is independent; the
  // phrase cache is warmed here so all subsequent spatial pre-pass calls are
  // cheap.  Building-type assignment is done AFTER this pass to ensure "first
  // file in list order wins" determinism.
  const intakeResultsMap = new Map<string, import("./phase-1-intake").IntakeResult>();
  await Promise.all(
    filesToProcess.map(async (file) => {
      const t_intake = Date.now();
      const intakeResult = await runPhase1Intake(file.storedPath, file.originalName, file.id);
      intakeResultsMap.set(file.id, intakeResult);
      pipelineSteps.push({
        step: "phase-1-intake",
        label: filesToProcess.length > 1 ? `Phase 1 intake — ${file.originalName}` : "Phase 1 intake",
        durationMs: Date.now() - t_intake,
        startedAt: new Date(t_intake).toISOString(),
        details: {
          file: file.originalName,
          fileType: intakeResult.fileType,
          projectName: intakeResult.projectName,
          jurisdiction: intakeResult.jurisdiction,
          issueDate: intakeResult.issueDate,
          buildingType: intakeResult.buildingType,
          levelCount: intakeResult.levelCount,
          levelNames: intakeResult.levelNames,
          drawingIndexPageNum: intakeResult.drawingIndexPageNum,
        },
      });
    })
  );

  // Deterministically pick building type and project metadata from the first data file
  // in list order that has a result.  This is stable across re-runs as long as the
  // file list order is stable.
  //
  // buildingType: first file in list order that detected one (legacy behaviour).
  // Phase 1 metadata (projectName, jurisdiction, issueDate, drawingIndexPageNum):
  // sourced exclusively from the primary data file — the first file in filesToProcess
  // that produced an intake result — so all four values come from the same file.
  let detectedBuildingType: string | null = null;
  let primaryIntake: import("./phase-1-intake").IntakeResult | null = null;

  for (const file of filesToProcess) {
    const intake = intakeResultsMap.get(file.id);
    if (!intake) continue;
    if (!detectedBuildingType && intake.buildingType) {
      detectedBuildingType = intake.buildingType;
      logger.info({ jobId, fileId: file.id, buildingType: detectedBuildingType }, "[PDF Processor] Building type set from Phase 1 intake");
    }
    if (!primaryIntake) {
      primaryIntake = intake;
      logger.info({ jobId, fileId: file.id }, "[PDF Processor] Primary data file intake result selected for project metadata");
    }
  }

  const detectedProjectName = primaryIntake?.projectName ?? null;
  const detectedJurisdiction = primaryIntake?.jurisdiction ?? null;
  const detectedIssueDate = primaryIntake?.issueDate ?? null;
  const detectedDrawingIndexPageNum = primaryIntake?.drawingIndexPageNum ?? null;

  setCurrentStep("Extracting floor plans…");
  const t_extraction = Date.now();

  await Promise.all(
    filesToProcess.map(async (file) => {
      try {
        logger.info({ jobId, file: file.originalName }, "[PDF Processor] Processing file");

        // Use pre-computed Phase 1 intake result (phrase cache is already warm).
        const intakeResult = intakeResultsMap.get(file.id)!;

        // Read any previously rejected page numbers so they are preserved across re-runs.
        const existingRejectedPages: number[] = (file.pageStats as { rejectedPageNumbers?: number[] } | null)?.rejectedPageNumbers ?? [];

        // ── Phase 2: Page Classification ──────────────────────────────────
        // Consolidates all page classification logic (bookmark overlay, title
        // block spatial pre-pass, full-page excerpt fallback) into a single
        // dedicated phase module.
        const t_classification = Date.now();
        const classification = await runPhase2Classification(
          file.storedPath,
          file.id,
          intakeResult,
        );

        const finalFloorPlanPages = classification.floorPlanPages;
        const finalSignSchedulePages = classification.signSchedulePages;
        const finalBothPages = classification.bothPages;
        const { manifest } = classification;

        const lifeSafetyPages = manifest.entries
          .filter((e) => e.bucket === "life_safety")
          .map((e) => e.pdfPage);

        const { spatialFloorLevelNames } = classification;

        const fpSet = new Set<number>(finalFloorPlanPages);
        fileFloorPlanPages.set(file.id, fpSet);
        allSpatialFloorLevelNames.set(file.id, spatialFloorLevelNames);

        recordStep(
          `phase-2-classification_${file.id}`,
          filesToProcess.length > 1 ? `Page classification — ${file.originalName}` : "Page classification",
          t_classification,
          {
            totalPages: manifest.totalPages,
            floorPlan: finalFloorPlanPages.length,
            signSchedule: finalSignSchedulePages.length,
            lifeSafety: lifeSafetyPages.length,
            other: classification.otherPages.length,
            isExcerpt: manifest.isExcerpt,
            source: manifest.entries[0]?.source ?? "none",
          },
          "phase-2-classification",
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
          { pages: numPages },
          "phase-3",
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
            recordStep(
              `png_render_${file.id}`,
              filesToProcess.length > 1 ? `PNG pre-render — ${file.originalName}` : "PNG pre-render",
              t_render,
              { pagesRendered: rendered.size, pagesRequested: pngPageNums.length },
              "phase-3",
            );
          } catch (err) {
            logger.warn({ err, fileId: file.id }, "[PDF Processor] PNG pre-render failed — non-fatal");
          }
        }

        // ── Signage schedule spatial parsing (no AI) ──────────────────────
        // Parse pages classified as sign_schedule using the deterministic spatial parser.
        // Must run before Phase 4 and Phase 5 so the plaque table is available to R7/R8.
        const fileScheduleEntries: Array<ScheduleEntry & { fileId: string }> = [];
        {
          const schedulePageNums = [...new Set([...finalSignSchedulePages, ...finalBothPages])].sort((a, b) => a - b);
          fileSchedulePages.set(file.id, schedulePageNums);
          if (schedulePageNums.length > 0) {
            try {
              const t_schedule = Date.now();
              const mergedSpecs = new Map<string, SignTypeSpec & { fileId: string; fileStoredPath: string }>();

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
                    fileScheduleEntries.push({ ...entry, fileId: file.id });
                  }
                } catch (pageErr) {
                  logger.warn({ pageErr, fileId: file.id, pageNum }, "[PDF Processor] Schedule parse failed for page — non-fatal");
                }
              }

              if (fileScheduleEntries.length > 0 || mergedSpecs.size > 0) {
                allScheduleSpecs.push(...mergedSpecs.values());
                allScheduleEntries.push(...fileScheduleEntries);
                logger.info(
                  { jobId, fileId: file.id, specs: mergedSpecs.size, entries: fileScheduleEntries.length, durationMs: Date.now() - t_schedule },
                  "[PDF Processor] Schedule spatial parse complete"
                );
              }
            } catch (err) {
              logger.warn({ err, fileId: file.id }, "[PDF Processor] Schedule parsing failed — non-fatal");
            }
          }
        }


        // ── Phase 4: Room Inventory ───────────────────────────────────────
        // Build a room inventory from floor plan pages identified above.
        // Must run before Phase 5 so the rule engine can consume the inventory.
        // Non-fatal: if this step fails the rest of the pipeline continues normally.
        //
        // Phase 4b: The first life safety / egress page from the sheet manifest
        // is passed to buildRoomInventory so Gemini can read the occupant loads
        // table from its rasterized image (Gemini-first; text extraction fallback).
        //
        // The occupant_loads_<fileId> step is ALWAYS emitted (done or skipped).
        let fileRoomInventory: RoomInventory | null = null;
        {
          const fpPagesForInventory = Array.from(fileFloorPlanPages.get(file.id) ?? []).sort((a, b) => a - b);
          const lifeSafetyPageNum = lifeSafetyPages[0] ?? undefined;
          const hasLifeSafetyPage = lifeSafetyPageNum != null;

          if (fpPagesForInventory.length > 0) {
            try {
              const t_ri = Date.now();

              // Derive a representative level label for this file.
              // Use the most common level from the spatial pre-pass, or "L1" as default.
              let level = "L1";
              if (spatialFloorLevelNames && spatialFloorLevelNames.size > 0) {
                const levelCounts = new Map<string, number>();
                for (const lv of spatialFloorLevelNames.values()) {
                  levelCounts.set(lv, (levelCounts.get(lv) ?? 0) + 1);
                }
                let maxCount = 0;
                for (const [lv, count] of levelCounts) {
                  if (count > maxCount) { maxCount = count; level = lv; }
                }
              }

              fileRoomInventory = await buildRoomInventory(
                file.storedPath,
                file.id,
                fpPagesForInventory,
                level,
                jobId,
                // Pass the per-page level map from the spatial pre-pass so each
                // RoomRecord gets the correct level (L1, L2, MEZZ…) rather than
                // a single file-wide default.
                spatialFloorLevelNames ?? undefined,
                // Phase 4b: life safety page for Gemini-first occupant loads extraction
                lifeSafetyPageNum,
              );

              recordStep(
                `room_inventory_${file.id}`,
                filesToProcess.length > 1
                  ? `Room Inventory — ${file.originalName}`
                  : "Room Inventory",
                t_ri,
                {
                  rooms: fileRoomInventory.rooms.length,
                  floorPlanPages: fpPagesForInventory.length,
                  occupantLoadFound: fileRoomInventory.occupantLoadTableFound,
                  warnings: fileRoomInventory.warnings.length,
                },
              );

              // ── Phase 4b: Occupant Loads step record (always emitted) ──────
              // Records whether Gemini or text extraction was used, and how many
              // rooms were matched. Displayed as a distinct card in the Processing
              // Timeline regardless of outcome.
              recordStep(
                `occupant_loads_${file.id}`,
                filesToProcess.length > 1
                  ? `Occupant Loads — ${file.originalName}`
                  : "Occupant Loads",
                t_ri,
                {
                  roomsMatched: fileRoomInventory.occupantLoadRoomsMatched,
                  occupantLoadSource: fileRoomInventory.occupantLoadSource,
                  lifeSafetyPage: lifeSafetyPageNum ?? null,
                  ...(hasLifeSafetyPage
                    ? {}
                    : { skipped: true, skipReason: "No egress/life safety sheet identified in manifest" }),
                },
                "phase-3",
              );

              // ── AI enrichment for ambiguous rooms ──────────────────────
              const t_ai = Date.now();
              const ambiguousCount = fileRoomInventory.rooms.filter((r) => {
                const c = r.extractionConfidence < 0.5;
                const s = r.roomName.replace(/\s+/g, "").length < 4;
                const f = !(r.isRestroom || r.isStair || r.isElevator || r.isVestibule ||
                  r.isCorridorOrHall || r.isVehicleBay || r.isMepUnoccupied ||
                  r.isVariableUse || r.isPublicFacing || r.isStaffOnly || r.isAssembly);
                return c || s || f;
              }).length;
              try {
                const { rooms: enrichedRooms, enrichedCount } = await enrichAmbiguousRoomsWithAI(
                  fileRoomInventory.rooms,
                  file.id,
                  jobId,
                  file.storedPath,
                );
                fileRoomInventory = {
                  ...fileRoomInventory,
                  rooms: enrichedRooms,
                  aiEnrichedCount: enrichedCount,
                };
                recordStep(
                  `room_inventory_ai_${file.id}`,
                  filesToProcess.length > 1
                    ? `Room AI Enrichment — ${file.originalName}`
                    : "Room AI Enrichment",
                  t_ai,
                  {
                    ambiguousSubmitted: ambiguousCount,
                    enrichedCount,
                    skipped: ambiguousCount === 0,
                  },
                );
              } catch (err) {
                logger.warn({ err, fileId: file.id, jobId }, "[PDF Processor] Room AI enrichment failed — non-fatal");
                recordStep(
                  `room_inventory_ai_${file.id}`,
                  filesToProcess.length > 1
                    ? `Room AI Enrichment — ${file.originalName}`
                    : "Room AI Enrichment",
                  t_ai,
                  {
                    ambiguousSubmitted: ambiguousCount,
                    enrichedCount: 0,
                    error: err instanceof Error ? err.message : String(err),
                  },
                );
              }
            } catch (err) {
              logger.warn({ err, fileId: file.id, jobId }, "[PDF Processor] Room inventory failed — non-fatal");
              // Still emit a step so the timeline always shows Phase 4b
              recordStep(
                `occupant_loads_${file.id}`,
                filesToProcess.length > 1
                  ? `Occupant Loads — ${file.originalName}`
                  : "Occupant Loads",
                Date.now(),
                { skipped: true, skipReason: "Room inventory error" },
                "phase-3",
              );
            }
          } else {
            // No floor plan pages — emit skipped step for the timeline
            recordStep(
              `occupant_loads_${file.id}`,
              filesToProcess.length > 1
                ? `Occupant Loads — ${file.originalName}`
                : "Occupant Loads",
              Date.now(),
              {
                skipped: true,
                skipReason: hasLifeSafetyPage
                  ? "No floor plan pages found"
                  : "No egress/life safety sheet identified in manifest",
              },
              "phase-3",
            );
          }
        }

        // ── Phase 5: Apply Rules R1–R15 ───────────────────────────────────
        // Consume the Phase 4 inventory and the per-file schedule entries to produce
        // deterministic sign assignments.  Runs after both Phase 4 and schedule parsing
        // so that restroom sub-type rules (R7/R8) have the full plaque table available.
        // Results are inserted into extractedSignsTable as extraction_method="rule_engine".
        if (fileRoomInventory !== null) {
          try {
            const t_rule = Date.now();

            // Build plaque table from schedule entries collected for this file above.
            const plaqueTableForFile: PlaqueEntry[] = fileScheduleEntries.map((e) => ({
              roomNumber: e.roomNumber ?? null,
              roomName: e.roomName ?? null,
              signTypeCode: e.signTypeCode,
              quantity: e.quantity ?? null,
            }));

            const ruleResult = applySignRules(fileRoomInventory, plaqueTableForFile, jobId);

            // Collect for Phase 6 verification wiring.
            // Push fileRoomInventory here (post-AI-enrichment) so the verifier
            // sees the same room flags that the rule engine acted on.  The earlier
            // push that happened before AI enrichment has been removed so both
            // arrays are always in sync.
            allFileRoomInventories.push(fileRoomInventory);
            allEngineRuleResults.push(ruleResult);

            // Convert SignAssignments → extractedSignsTable rows
            const rawSignRows = ruleResult.assignments.flatMap((assignment) =>
              assignmentToRows(assignment).map((row) => ({
                jobId,
                jobFileId: file.id,
                signType: row.signType,
                signIdentifier: row.signIdentifier,
                quantity: row.quantity,
                location: row.location,
                notes: row.notes,
                pageNumber: row.pageNumber,
                confidenceScore: row.confidenceScore,
                reviewFlag: row.reviewFlag,
                extractionMethod: row.extractionMethod,
                placementSource: row.placementSource,
                exceptionReason: row.exceptionReason,
                rawJson: row.rawJson,
                dataSource: "pdf" as const,
                userVerified: false,
                manuallyAdded: false,
              }))
            );

            // Assign stable occurrence indices before insertion.
            // Group by signType + signIdentifier + location + pageNumber.
            // Groups with >1 member get a 1-based occurrenceIndex so the
            // frontend can display "Room Name (2/5)" without relying on
            // xPos/yPos coordinates (which change when a sign is repositioned).
            //
            // Ordering source of truth: the position of each row in the
            // ruleResult.assignments.flatMap output, which reflects the order
            // rooms were encountered in the PDF room inventory. This is stable
            // across re-renders and persisted to the DB so it never reorders
            // when a user moves a marker.
            const occurrenceGroups = new Map<string, number[]>();
            rawSignRows.forEach((row, idx) => {
              const key = occurrenceGroupKey(row);
              if (!occurrenceGroups.has(key)) occurrenceGroups.set(key, []);
              occurrenceGroups.get(key)!.push(idx);
            });

            const allSignRows = rawSignRows.map((row, idx) => {
              const key = occurrenceGroupKey(row);
              const group = occurrenceGroups.get(key)!;
              if (group.length <= 1) return { ...row, occurrenceIndex: null, occurrenceTotal: null };
              const posInGroup = group.indexOf(idx) + 1;
              return { ...row, occurrenceIndex: posInGroup, occurrenceTotal: group.length };
            });

            if (allSignRows.length > 0) {
              const CHUNK = 200;
              for (let i = 0; i < allSignRows.length; i += CHUNK) {
                await db.insert(extractedSignsTable).values(allSignRows.slice(i, i + CHUNK));
              }
            }

            recordStep(
              `rule_application_${file.id}`,
              filesToProcess.length > 1
                ? `Sign extraction (rules) — ${file.originalName}`
                : "Sign extraction (rules)",
              t_rule,
              {
                fileName: file.originalName,
                roomCount: ruleResult.roomCount,
                assignmentCount: ruleResult.assignments.length,
                signRowsInserted: allSignRows.length,
                ambiguousCount: ruleResult.assignments.filter((a) => a.ambiguous).length,
                verificationErrors: ruleResult.verificationErrors,
                decisionsLog: ruleResult.decisionsLog,
                questionsForVerification: ruleResult.questionsForVerification,
                assignments: ruleResult.assignments,
                pageAudit: ruleResult.pageAudit,
              },
              "phase-3",
            );

            logger.info(
              {
                jobId,
                fileId: file.id,
                roomCount: ruleResult.roomCount,
                signRowsInserted: allSignRows.length,
                durationMs: Date.now() - t_rule,
              },
              "[PDF Processor] Rule engine (Phase 5) complete",
            );
          } catch (err) {
            logger.warn({ err, fileId: file.id }, "[PDF Processor] Rule engine extraction failed — non-fatal");
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
          ...(manifest.isExcerpt ? { isExcerpt: manifest.isExcerpt } : {}),
          ...(manifest.warnings.length > 0 ? { manifestWarnings: manifest.warnings } : {}),
        };

        await db
          .update(jobFilesTable)
          .set({
            pageCount: numPages,
            extractedText: rawText.slice(0, 10000),
            pageStats,
            ...(fileRoomInventory ? { roomInventory: fileRoomInventory } : {}),
          })
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
  }, "phase-3");

  // ── Aggregate occupant_loads step (Phase 4b summary) ─────────────────────
  // Collects per-file occupant_loads_<fileId> steps into a single job-level
  // summary step so the Processing Timeline always shows a visible Phase 4b
  // card. The per-file steps are UUID-suffixed and filtered from the timeline's
  // visible rows; this aggregate step (no UUID suffix) is always displayed.
  {
    const olSteps = pipelineSteps.filter((s) => s.step.startsWith("occupant_loads_"));
    if (olSteps.length > 0) {
      const executedSteps = olSteps.filter((s) => !s.details?.skipped);
      const totalRoomsMatched = executedSteps.reduce(
        (sum, s) => sum + ((s.details?.roomsMatched as number) ?? 0),
        0,
      );
      const sources = new Set(
        executedSteps
          .map((s) => s.details?.occupantLoadSource as string | undefined)
          .filter((src): src is string => !!src && src !== "none"),
      );
      const allSkipped = executedSteps.length === 0;
      pipelineSteps.push({
        step: "occupant_loads",
        label: "Occupant Loads (Phase 4b)",
        durationMs: olSteps.reduce((sum, s) => sum + s.durationMs, 0),
        startedAt: olSteps[0]!.startedAt,
        details: allSkipped
          ? {
              skipped: true,
              skipReason: (olSteps[0]?.details?.skipReason as string | undefined) ?? "No egress/life safety sheet identified in manifest",
            }
          : {
              roomsMatched: totalRoomsMatched,
              occupantLoadSource: sources.size === 1 ? [...sources][0] : sources.size > 1 ? "mixed" : "none",
              fileCount: executedSteps.length,
            },
      });
    }
  }

  // ── Aggregate rule_application step (Phase 5 summary) ────────────────────
  // Collects per-file rule_application_<fileId> steps into a single job-level
  // summary so the Timeline tab can show a Phase 5 card even for multi-file jobs.
  {
    const ruleSteps = pipelineSteps.filter((s) => s.step.startsWith("rule_application_"));
    if (ruleSteps.length > 0) {
      const totalRooms = ruleSteps.reduce((sum, s) => sum + ((s.details?.roomCount as number) ?? 0), 0);
      const totalSigns = ruleSteps.reduce((sum, s) => sum + ((s.details?.signRowsInserted as number) ?? 0), 0);
      const allDecisionsLog = ruleSteps.flatMap((s) => (s.details?.decisionsLog as string[]) ?? []);
      const allQuestions = ruleSteps.flatMap((s) => (s.details?.questionsForVerification as string[]) ?? []);
      const allErrors = ruleSteps.flatMap((s) => (s.details?.verificationErrors as string[]) ?? []);
      // Merge per-file pageAudit arrays, tagging each entry with its source file so
      // multi-file jobs with overlapping page numbers (e.g. two "page 1"s) remain
      // distinguishable in the UI.
      type RawPageAuditEntry = { page: number; rooms_found: number; signs_extracted: number; markers_placed: number; roomNames: string[] };
      const allPageAudit = ruleSteps.flatMap((s) => {
        const fileId = s.step.slice("rule_application_".length);
        const fileName = (s.details?.fileName as string | undefined) ?? null;
        return ((s.details?.pageAudit as RawPageAuditEntry[]) ?? []).map((entry) => ({
          ...entry,
          fileId,
          fileName,
        }));
      });
      pipelineSteps.push({
        step: "rule_application",
        label: "Apply Rules R1–R15 (all files)",
        durationMs: ruleSteps.reduce((sum, s) => sum + s.durationMs, 0),
        startedAt: ruleSteps[0]!.startedAt,
        details: {
          fileCount: ruleSteps.length,
          totalRooms,
          totalSignsAssigned: totalSigns,
          decisionsLog: allDecisionsLog,
          questionsForVerification: allQuestions,
          verificationErrors: allErrors,
          pageAudit: allPageAudit,
        },
      });
    }
  }

  // ── Phase 6: Verify & Output ───────────────────────────────────────────────
  // Aggregate all per-file rule engine results into job-wide totals and run
  // mandatory pre-output checks (V1–V4).  Uses Phase 4 Room Inventory for
  // accurate elevator/stair counts when available; falls back to rule-engine
  // heuristics otherwise.  The step is always recorded so the Timeline UI
  // shows Phase 6 as complete even when no floor plan pages exist.
  {
    const t_verify = Date.now();

    const allAssignments = allEngineRuleResults.flatMap((r) => r.assignments);
    const allRoomRecords = allFileRoomInventories.flatMap((ri) => ri.rooms);

    // Use pre-deduplication raw counts from the rule engine (most accurate for
    // V2/V4 checks — independent of what rules were finally applied).
    // rawStairCount ≈ distinct stairs × levels served (each floor-plan page
    // appearance before job-level dedup contributes 1).
    // rawElevatorCount similarly represents distinct elevator locations.
    // Fall back to Phase 4 Room Inventory spatial detection when raw counts
    // are absent (e.g., older rule engine result without raw count fields).
    const rawStairTotal = allEngineRuleResults.reduce((sum, r) => sum + (r.rawStairCount ?? 0), 0);
    const rawElevatorTotal = allEngineRuleResults.reduce((sum, r) => sum + (r.rawElevatorCount ?? 0), 0);
    const stairCount = rawStairTotal > 0
      ? rawStairTotal
      : allRoomRecords.filter((r) => r.isStair).length;
    const elevatorCount = rawElevatorTotal > 0
      ? rawElevatorTotal
      : allRoomRecords.filter((r) => r.isElevator).length;

    const levelNames = [
      ...new Set([
        ...allRoomRecords.map((r) => r.level),
        ...allAssignments.map((a) => a.level),
      ]),
    ];
    const byLevel: Record<string, SignAssignment[]> = {};
    for (const a of allAssignments) {
      if (!byLevel[a.level]) byLevel[a.level] = [];
      byLevel[a.level]!.push(a);
    }

    // Sum actual page counts from per-file results; fall back to file count
    // when page count data is absent (e.g., a file failed to process).
    const totalPageCount = parsedResults.reduce(
      (sum, r) => sum + (typeof r.pageCount === "number" ? r.pageCount : 1),
      0,
    );

    const report = verifyRuleEngineResult(
      { assignments: allAssignments, byLevel },
      { rooms: allRoomRecords, elevatorCount, stairCount, levelNames },
      { levels: levelNames, pageCount: totalPageCount },
    );

    recordStep("verification", "Phase 6 — Verify & Output", t_verify, {
      passed: report.passed,
      errors: report.errors.length,
      warnings: report.warnings.length,
      questions: report.questionsForVerification.length,
      totalSigns: report.summary.totalSigns,
      errorDetails: report.errors,
      warningDetails: report.warnings,
      questionDetails: report.questionsForVerification,
      checksPassed: report.checksPassed,
      roomsFromInventory: allRoomRecords.length,
      assignmentsFromEngine: allAssignments.length,
      ...report.summary.byType,
    });
  }

  // ── Persist schedule parser results (sign_type_specs + signage_schedule_entries) ──
  // For a full run: always clear previous schedule rows first (re-run support).
  // For a per-file retry: only clear the specs (and their linked entries) for the
  // target file so that other files' schedule data is preserved.
  if (isFileRetry) {
    const existingTargetSpecIds = (
      await db
        .select({ id: signTypeSpecsTable.id })
        .from(signTypeSpecsTable)
        .where(
          and(
            eq(signTypeSpecsTable.jobId, jobId),
            eq(signTypeSpecsTable.sourceFileId, targetFileId!)
          )
        )
    ).map((r) => r.id);
    if (existingTargetSpecIds.length > 0) {
      await db
        .delete(signageScheduleEntriesTable)
        .where(inArray(signageScheduleEntriesTable.signTypeSpecId, existingTargetSpecIds));
      await db
        .delete(signTypeSpecsTable)
        .where(inArray(signTypeSpecsTable.id, existingTargetSpecIds));
    }
  } else {
    await db.delete(signageScheduleEntriesTable).where(eq(signageScheduleEntriesTable.jobId, jobId));
    await db.delete(signTypeSpecsTable).where(eq(signTypeSpecsTable.jobId, jobId));
  }

  // Track insertion counts for output_db_insert step (always recorded below).
  const t_db_insert = Date.now();
  let dbInsertedSpecs = 0;
  let dbInsertedEntries = 0;

  if (allScheduleSpecs.length > 0 || allScheduleEntries.length > 0) {
    try {
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
        dbInsertedSpecs = deduplicatedSpecs.length;
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
        dbInsertedEntries = entryRows.length;
      }

      logger.info(
        { jobId, specs: dbInsertedSpecs, entries: dbInsertedEntries, durationMs: Date.now() - t_db_insert },
        "[PDF Processor] Schedule data persisted"
      );
      recordStep("schedule_persist", "Schedule data persistence", t_schedule_persist, {
        specs: allScheduleSpecs.length,
        entries: allScheduleEntries.length,
      }, "phase-3");


    } catch (err) {
      logger.warn({ err, jobId }, "[PDF Processor] Schedule data persistence failed — non-fatal");
    }
  }

  // Always record output_db_insert — represents the full verified-result write path
  // regardless of whether schedule data was present for this job.
  recordStep("output_db_insert", "Write verified results", t_db_insert, {
    rows: dbInsertedSpecs + dbInsertedEntries,
    specs: dbInsertedSpecs,
    entries: dbInsertedEntries,
  });

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
          phase: "phase-3",
          details: {
            pages: schedulePageNums.length,
            plaqueTypes: extractResult.plaqueTypes.length,
            method: extractResult.extractionMethod,
            warnings: extractResult.warnings,
          },
        });
        persistStepsNow();
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
          phase: "phase-3",
          details: { error: String(err), pages: schedulePageNums.length },
        });
        persistStepsNow();
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
    setCurrentStep("Matching coordinates…");
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
    }, "phase-4");
  }

  // ── Finalize ──────────────────────────────────────────────────────────────
  await saveParsedResult(jobId, parsedResults);

  const failedCount = parsedResults.filter((r) => "error" in r).length;
  // For a per-file retry, "allFailed" means the single retried file still failed.
  // For a full run, it means every file in the job failed.
  const allFailed = isFileRetry
    ? failedCount === filesToProcess.length
    : failedCount === files.length;

  recordStep("total", "Total pipeline", jobStart, undefined, "phase-4");

  // For a per-file retry, merge the new steps into the existing processingLog:
  // remove stale per-file steps for the target file and append the fresh steps.
  let finalPipelineSteps: ProcessingStep[] = pipelineSteps;
  if (isFileRetry) {
    const existingJob = await db
      .select({ processingLog: jobsTable.processingLog })
      .from(jobsTable)
      .where(eq(jobsTable.id, jobId))
      .then((rows) => rows[0]);

    const existingLog = (existingJob?.processingLog ?? []) as ProcessingStep[];

    // Strip all existing steps that reference the target file (UUID-suffixed step names)
    const stripped = existingLog.filter(
      (s) => !s.step.includes(targetFileId!)
    );
    // Append all new steps from this retry run
    finalPipelineSteps = [...stripped, ...pipelineSteps];
  }

  if (allFailed) {
    const errorSummary = parsedResults
      .filter((r): r is { fileId: string; fileName: string; error: string } => "error" in r)
      .map((r) => `${r.fileName}: ${r.error}`)
      .join("; ");
    cancelCurrentStepTimer();
    await db
      .update(jobsTable)
      .set({ status: "failed", error: `All files failed processing: ${errorSummary}`, processingLog: finalPipelineSteps, currentStep: null, updatedAt: new Date() })
      .where(eq(jobsTable.id, jobId));
    return;
  }

  cancelCurrentStepTimer();
  await db
    .update(jobsTable)
    .set({
      status: "completed",
      processingLog: finalPipelineSteps,
      currentStep: null,
      updatedAt: new Date(),
      // Always write metadata fields — including null — so re-runs never leave
      // stale values from a prior extraction if the current run found nothing.
      ...(detectedBuildingType ? { buildingType: detectedBuildingType } : {}),
      ...(isFileRetry ? {} : {
        projectName: detectedProjectName,
        jurisdiction: detectedJurisdiction,
        issueDate: detectedIssueDate,
        drawingIndexPageNum: detectedDrawingIndexPageNum,
      }),
    })
    .where(eq(jobsTable.id, jobId));

  logger.info(
    { jobId, preservedSigns: preservedSigns.length, failed: failedCount, buildingType: detectedBuildingType },
    "[PDF Processor] Processing complete"
  );

  } finally {
    // Always cancel the deferred currentStep timer so it cannot fire after the
    // terminal DB write (currentStep: null) on success, failure, or exception.
    cancelCurrentStepTimer();
  }
}
