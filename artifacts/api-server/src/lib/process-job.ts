import { eq, and, ne, desc, inArray } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  jobsTable,
  jobFilesTable,
  extractedSignsTable,
  type InsertExtractedSign,
} from "@workspace/db";

import { ai } from "@workspace/integrations-gemini-ai";
import { extractSignsFromPdf, extractSignsFromPdfImageVerify, extractProjectInfo, type ProjectInfo, type VerifiedSignSummary, type TextContextSign, type VerificationItem } from "./extraction";
import { saveParsedResult } from "./storage";
import { logger } from "./logger";

// ── Sign matching helpers ─────────────────────────────────────────────────────
// Match text signs against image signs using significant-word overlap scoring.
// Requires BOTH type AND location overlap to reduce false-positive matches.

type DbSign = typeof extractedSignsTable.$inferSelect;

function normalize(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

function significantWords(s: string | null | undefined): Set<string> {
  return new Set(normalize(s).split(" ").filter((w) => w.length >= 4));
}

function wordOverlapScore(a: string | null | undefined, b: string | null | undefined): number {
  const wa = significantWords(a);
  const wb = significantWords(b);
  if (wa.size === 0 || wb.size === 0) return 0;
  let shared = 0;
  for (const w of wa) { if (wb.has(w)) shared++; }
  return shared / Math.max(wa.size, wb.size);
}

function positionProximity(imgSign: DbSign, txtSign: DbSign): number {
  if (imgSign.xPos == null || imgSign.yPos == null || txtSign.xPos == null || txtSign.yPos == null) return 0;
  const dx = imgSign.xPos - txtSign.xPos;
  const dy = imgSign.yPos - txtSign.yPos;
  const dist = Math.sqrt(dx * dx + dy * dy);
  return dist < 0.1 ? 1 : dist < 0.25 ? 0.5 : 0;
}

function isMatch(imgSign: DbSign, txtSign: DbSign): boolean {
  const typeScore = wordOverlapScore(imgSign.signType, txtSign.signType);
  const locScore = wordOverlapScore(imgSign.location, txtSign.location);
  const posFactor = positionProximity(imgSign, txtSign);
  if (typeScore >= 0.5 && locScore >= 0.5) return true;
  if (typeScore >= 0.8 && locScore >= 0.2) return true;
  if (locScore >= 0.8 && typeScore >= 0.2) return true;
  if (posFactor > 0 && (typeScore >= 0.5 || locScore >= 0.5)) return true;
  return false;
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

  // ── PASSES 1–3: Text + visual extraction for each file (parallel per file) ──
  for (const file of files) {
    try {
      logger.info({ jobId, file: file.originalName }, "Extracting signs from file (text + visual in parallel)");
      const fileVerified = verifiedByFile[file.id] ?? [];
      const otherVerified = verifiedGlobal.filter((v) => !fileVerified.includes(v));
      const allVerifiedForFile = [...fileVerified, ...otherVerified];

      // Run text extraction FIRST, then use those results to drive the
      // visual verification pass (text signs → context → verify/discover).
      const textResult = await extractSignsFromPdf(
        file.storedPath,
        ai,
        projectContext,
        allVerifiedForFile.length > 0 ? allVerifiedForFile : undefined,
        crossJobVerified.length > 0 ? crossJobVerified : undefined
      );

      // Build page → text-sign context map for the verification prompt
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

      totalInputTokens += textResult.inputTokens;
      totalOutputTokens += textResult.outputTokens;
      totalImageInputTokens += imageResult.inputTokens;
      totalImageOutputTokens += imageResult.outputTokens;

      await db
        .update(jobFilesTable)
        .set({ pageCount: textResult.pageCount, extractedText: textResult.rawText.slice(0, 10000), pageStats: textResult.pageStats })
        .where(eq(jobFilesTable.id, file.id));

      parsedResults.push({
        fileId: file.id,
        fileName: file.originalName,
        pageCount: textResult.pageCount,
        rowCount: textResult.rows.length,
        imageRowCount: imageResult.discoveries.length,
        imageSkipped: imageResult.skipped ?? false,
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
          reviewFlag: row.review_flag,
          extractionMethod: "text",
          rawJson: row as unknown as Record<string, unknown>,
        });
      }

      // Visual-verification discoveries: signs the visual pass found that the
      // text pass missed. Store as supplementary with reviewFlag=true.
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

      // Store verifications so the matching pass can apply confidence/flag updates
      for (const v of imageResult.verifications) {
        allVerifications.push({ ...v, fileId: file.id });
      }

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
    } catch (err) {
      logger.error({ err, fileId: file.id, fileName: file.originalName }, "File extraction failed");
      parsedResults.push({
        fileId: file.id,
        fileName: file.originalName,
        error: String(err),
      });
    }
  }

  // Insert text rows first, then image rows
  if (allTextRows.length > 0) {
    await db.insert(extractedSignsTable).values(allTextRows);
  }
  if (allImageRows.length > 0) {
    await db.insert(extractedSignsTable).values(allImageRows);
  }

  // ── Verification pass: apply Gemini's confirm/not-found signals to text signs ─
  // Unlike the old fuzzy image-vs-text matching, we now have explicit CONFIRMED /
  // UNCERTAIN / NOT_FOUND labels for each text sign from the verification prompt.
  if (allVerifications.length > 0) {
    const allInserted = await db
      .select()
      .from(extractedSignsTable)
      .where(eq(extractedSignsTable.jobId, jobId));

    const textSigns = allInserted.filter((s) => s.extractionMethod === "text" && !s.manuallyAdded && !s.userVerified);
    const confirmedIds = new Set<string>();
    const notFoundIds = new Set<string>();

    for (const v of allVerifications) {
      // Find best matching text sign: prefer exact signIdentifier match on same page,
      // fall back to location overlap.
      let best: DbSign | null = null;

      // Pass 1: exact sign_identifier + page
      if (v.sign_identifier) {
        best = textSigns.find(
          (s) => s.signIdentifier?.toLowerCase() === v.sign_identifier!.toLowerCase() &&
                 (v.page_number == null || s.pageNumber === v.page_number)
        ) ?? null;
      }

      // Pass 2: location word overlap + page
      if (!best && v.location) {
        const vLoc = v.location.toLowerCase();
        best = textSigns.find(
          (s) => s.location?.toLowerCase().includes(vLoc) &&
                 (v.page_number == null || s.pageNumber === v.page_number)
        ) ?? null;
      }

      if (!best) continue; // verification item couldn't be matched to a DB sign

      if (v.status === "CONFIRMED") {
        confirmedIds.add(best.id);
      } else if (v.status === "NOT_FOUND") {
        notFoundIds.add(best.id);
      }
      // UNCERTAIN: leave sign unchanged (text pass confidence/flag already set)
    }

    // Boost confirmed text signs
    if (confirmedIds.size > 0) {
      for (const id of confirmedIds) {
        const sign = textSigns.find((s) => s.id === id)!;
        const boosted = Math.min(1.0, (sign.confidenceScore ?? 0) + 0.15);
        await db
          .update(extractedSignsTable)
          .set({ confidenceScore: boosted, reviewFlag: boosted < 0.75 })
          .where(eq(extractedSignsTable.id, id));
      }
    }

    // Flag NOT_FOUND text signs for human review
    const notFoundOnly = [...notFoundIds].filter((id) => !confirmedIds.has(id));
    if (notFoundOnly.length > 0) {
      await db
        .update(extractedSignsTable)
        .set({ reviewFlag: true })
        .where(inArray(extractedSignsTable.id, notFoundOnly));
    }

    logger.info(
      {
        jobId,
        textSigns: textSigns.length,
        verifications: allVerifications.length,
        confirmed: confirmedIds.size,
        notFound: notFoundOnly.length,
        discoveries: allImageRows.length,
      },
      "Verification matching complete"
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
