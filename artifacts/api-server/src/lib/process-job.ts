import { eq, and, ne, desc, inArray } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  jobsTable,
  jobFilesTable,
  extractedSignsTable,
  type InsertExtractedSign,
} from "@workspace/db";

import { ai } from "@workspace/integrations-gemini-ai";
import { extractSignsFromPdf, extractSignsFromPdfImage, extractProjectInfo, type ProjectInfo, type VerifiedSignSummary } from "./extraction";
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

      // Run text and image extraction in parallel
      const [textResult, imageResult] = await Promise.all([
        extractSignsFromPdf(
          file.storedPath,
          ai,
          projectContext,
          allVerifiedForFile.length > 0 ? allVerifiedForFile : undefined,
          crossJobVerified.length > 0 ? crossJobVerified : undefined
        ),
        extractSignsFromPdfImage(file.storedPath, ai).catch((err) => {
          logger.warn({ err, fileId: file.id }, "Image extraction threw unexpectedly — using empty result");
          return { rows: [], inputTokens: 0, outputTokens: 0, skipped: true as const, skipReason: "Internal error" };
        }),
      ]);

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
        imageRowCount: imageResult.rows.length,
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

      for (const row of imageResult.rows) {
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
          xPos: row.x_pos ?? null,
          yPos: row.y_pos ?? null,
          confidenceScore: row.confidence_score,
          reviewFlag: true,
          extractionMethod: "image",
          rawJson: row as unknown as Record<string, unknown>,
        });
      }

      if (imageResult.skipped) {
        logger.info({ jobId, file: file.originalName, reason: imageResult.skipReason }, "Visual scan skipped for file");
      } else {
        logger.info({ jobId, file: file.originalName, imageRows: imageResult.rows.length }, "Visual scan complete for file");
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

  // ── Matching pass: pair text signs with image signs ───────────────────────
  // Re-fetch all signs for this job to get real DB IDs, then run greedy matching.
  if (allImageRows.length > 0) {
    const allInserted = await db
      .select()
      .from(extractedSignsTable)
      .where(eq(extractedSignsTable.jobId, jobId));

    const textSigns = allInserted.filter((s) => s.extractionMethod === "text" && !s.manuallyAdded && !s.userVerified);
    const imageSigns = allInserted.filter((s) => s.extractionMethod === "image");

    const matchedTextIds = new Set<string>();
    const matchedImageIds = new Set<string>();
    const pairs: Array<{ textId: string; imageId: string }> = [];

    for (const imgSign of imageSigns) {
      let bestTextSign: DbSign | null = null;
      let bestTypeScore = 0;

      for (const txtSign of textSigns) {
        if (matchedTextIds.has(txtSign.id)) continue;
        if (!isMatch(imgSign, txtSign)) continue;
        const ts = wordOverlapScore(imgSign.signType, txtSign.signType);
        if (ts > bestTypeScore) {
          bestTypeScore = ts;
          bestTextSign = txtSign;
        }
      }

      if (bestTextSign) {
        matchedTextIds.add(bestTextSign.id);
        matchedImageIds.add(imgSign.id);
        pairs.push({ textId: bestTextSign.id, imageId: imgSign.id });
      }
    }

    // Persist pairings: boost confidence on confirmed pairs, flag unmatched text signs
    for (const { textId, imageId } of pairs) {
      const txtSign = textSigns.find((s) => s.id === textId)!;
      const imgSign = imageSigns.find((s) => s.id === imageId)!;

      // Both passes confirmed this sign → bigger confidence boost
      const txtBoosted = Math.min(1.0, (txtSign.confidenceScore ?? 0) + 0.15);
      const imgBoosted = Math.min(1.0, (imgSign.confidenceScore ?? 0) + 0.15);

      await db
        .update(extractedSignsTable)
        .set({ pairedSignId: imageId, confidenceScore: txtBoosted, reviewFlag: txtBoosted < 0.75 })
        .where(eq(extractedSignsTable.id, textId));

      await db
        .update(extractedSignsTable)
        .set({ pairedSignId: textId, confidenceScore: imgBoosted, reviewFlag: imgBoosted < 0.75 })
        .where(eq(extractedSignsTable.id, imageId));
    }

    // Flag unmatched text signs: visual pass did not confirm them → set review_flag
    const unmatchedTextIds = textSigns
      .filter((s) => !matchedTextIds.has(s.id))
      .map((s) => s.id);

    if (unmatchedTextIds.length > 0) {
      await db
        .update(extractedSignsTable)
        .set({ reviewFlag: true })
        .where(inArray(extractedSignsTable.id, unmatchedTextIds));
    }

    // Flag unmatched image signs: text pass did not confirm them → keep review_flag=true (already set)
    const unmatchedImageCount = imageSigns.filter((s) => !matchedImageIds.has(s.id)).length;

    logger.info(
      {
        jobId,
        textSigns: textSigns.length,
        imageSigns: imageSigns.length,
        pairs: pairs.length,
        unmatchedText: unmatchedTextIds.length,
        unmatchedImage: unmatchedImageCount,
      },
      "Sign matching complete"
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
