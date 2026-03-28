import { eq } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  jobsTable,
  jobFilesTable,
  extractedSignsTable,
  type InsertExtractedSign,
} from "@workspace/db";

import { ai } from "@workspace/integrations-gemini-ai";
import { extractSignsFromPdf } from "./extraction";
import { saveParsedResult } from "./storage";
import { logger } from "./logger";

export async function processJob(jobId: string): Promise<void> {
  await db.delete(extractedSignsTable).where(eq(extractedSignsTable.jobId, jobId));

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

  for (const file of files) {
    try {
      logger.info({ jobId, file: file.originalName }, "Extracting signs from file");
      const { rows, pageCount, rawText } = await extractSignsFromPdf(file.storedPath, ai);

      await db
        .update(jobFilesTable)
        .set({ pageCount, extractedText: rawText.slice(0, 10000) })
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
    .set({ status: "completed", updatedAt: new Date() })
    .where(eq(jobsTable.id, jobId));

  logger.info({ jobId, extractedCount: allRows.length, failedCount }, "Job processing complete");
}
