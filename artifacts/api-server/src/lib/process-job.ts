import { eq, and, or } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  jobsTable,
  jobFilesTable,
  extractedSignsTable,
  type InsertExtractedSign,
} from "@workspace/db";

import { ai } from "@workspace/integrations-gemini-ai";
import { extractSignsFromPdf, extractProjectInfo, type ProjectInfo, type VerifiedSignSummary } from "./extraction";
import { saveParsedResult } from "./storage";
import { logger } from "./logger";

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

  const allRows: InsertExtractedSign[] = [];
  const parsedResults: Record<string, unknown>[] = [];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  // ── PASS 0: Extract project info from first file ──────────────────────────
  let projectContext: ProjectInfo | undefined;
  const firstFile = files[0]!;

  try {
    logger.info({ jobId, file: firstFile.originalName }, "Extracting project info");
    const { info, inputTokens: piIn, outputTokens: piOut } = await extractProjectInfo(firstFile.storedPath, ai);
    projectContext = info;
    totalInputTokens += piIn;
    totalOutputTokens += piOut;

    // Persist address/state to job record immediately so UI can show it
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

  // ── PASSES 1–3: Sign extraction for each file ─────────────────────────────
  for (const file of files) {
    try {
      logger.info({ jobId, file: file.originalName }, "Extracting signs from file");
      // Combine file-specific verified signs + global verified signs (de-duped)
      const fileVerified = verifiedByFile[file.id] ?? [];
      const otherVerified = verifiedGlobal.filter((v) => !fileVerified.includes(v));
      const allVerifiedForFile = [...fileVerified, ...otherVerified];

      const { rows, pageCount, rawText, inputTokens, outputTokens, pageStats } = await extractSignsFromPdf(
        file.storedPath,
        ai,
        projectContext,
        allVerifiedForFile.length > 0 ? allVerifiedForFile : undefined
      );

      totalInputTokens += inputTokens;
      totalOutputTokens += outputTokens;

      await db
        .update(jobFilesTable)
        .set({ pageCount, extractedText: rawText.slice(0, 10000), pageStats })
        .where(eq(jobFilesTable.id, file.id));

      parsedResults.push({
        fileId: file.id,
        fileName: file.originalName,
        pageCount,
        rowCount: rows.length,
        rows,
      });

      for (const row of rows) {
        allRows.push({
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
          rawJson: row as unknown as Record<string, unknown>,
        });
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

  if (allRows.length > 0) {
    await db.insert(extractedSignsTable).values(allRows);
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
      updatedAt: new Date(),
    })
    .where(eq(jobsTable.id, jobId));

  logger.info(
    { jobId, extractedCount: allRows.length, failedCount, totalInputTokens, totalOutputTokens },
    "Job processing complete"
  );
}
