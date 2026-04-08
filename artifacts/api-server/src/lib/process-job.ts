import { eq, and, ne, desc } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  jobsTable,
  jobFilesTable,
  extractedSignsTable,
  type InsertExtractedSign,
} from "@workspace/db";

import { ai } from "@workspace/integrations-gemini-ai";
import { extractSignsFromPdf, extractSignsFromPdfImageVerify, extractProjectInfo, extractTextFromPdf, isSpecFile, buildSpecContextString, type ProjectInfo, type VerifiedSignSummary, type TextContextSign, type VerificationItem, type ExtractedSignRow } from "./extraction";
import { saveParsedResult } from "./storage";
import { logger } from "./logger";


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
    const { info, inputTokens: piIn, outputTokens: piOut } = await extractProjectInfo(firstFile.storedPath, ai);
    projectContext = info;
    totalInputTokens += piIn;
    totalOutputTokens += piOut;

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
      }
    | { ok: false; file: typeof files[number]; error: string };

  const fileResults: FileResult[] = await Promise.all(
    filesToProcess.map(async (file): Promise<FileResult> => {
      try {
        logger.info({ jobId, file: file.originalName }, "Extracting signs from file");
        const fileVerified = verifiedByFile[file.id] ?? [];
        const otherVerified = verifiedGlobal.filter((v) => !fileVerified.includes(v));
        const allVerifiedForFile = [...fileVerified, ...otherVerified];

        const textResult = await extractSignsFromPdf(
          file.storedPath,
          ai,
          projectContext,
          allVerifiedForFile.length > 0 ? allVerifiedForFile : undefined,
          crossJobVerified.length > 0 ? crossJobVerified : undefined,
          specTypeContext
        );

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

        const imageResult = await extractSignsFromPdfImageVerify(file.storedPath, ai, textSignsByPage).catch((err) => {
          logger.warn({ err, fileId: file.id }, "Visual verification threw unexpectedly — skipping");
          return { verifications: [] as VerificationItem[], discoveries: [], inputTokens: 0, outputTokens: 0, skipped: true as const, skipReason: "Internal error" };
        });

        // Per-file DB update is safe to do inside the parallel map
        await db
          .update(jobFilesTable)
          .set({ pageCount: textResult.pageCount, extractedText: textResult.rawText.slice(0, 10000), pageStats: textResult.pageStats })
          .where(eq(jobFilesTable.id, file.id));

        return { ok: true, file, textResult, imageResult };
      } catch (err) {
        logger.error({ err, fileId: file.id, fileName: file.originalName }, "File extraction failed");
        return { ok: false, file, error: String(err) };
      }
    })
  );

  // ── Merge parallel results into accumulator arrays ────────────────────────
  for (const result of fileResults) {
    if (!result.ok) {
      parsedResults.push({ fileId: result.file.id, fileName: result.file.originalName, error: result.error });
      continue;
    }

    const { file, textResult, imageResult } = result;

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

  // Deduplicate within each pass, then remove cross-pass duplicates from image rows
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

  if (dedupedTextRows.length > 0) {
    await db.insert(extractedSignsTable).values(dedupedTextRows);
  }
  if (dedupedImageRows.length > 0) {
    await db.insert(extractedSignsTable).values(dedupedImageRows);
  }

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

  if (allFailed) {
    const errorSummary = parsedResults
      .filter((r): r is { fileId: string; fileName: string; error: string } => "error" in r)
      .map((r) => `${r.fileName}: ${r.error}`)
      .join("; ");
    await db
      .update(jobsTable)
      .set({ status: "failed", error: `All files failed extraction: ${errorSummary}`, updatedAt: new Date() })
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
