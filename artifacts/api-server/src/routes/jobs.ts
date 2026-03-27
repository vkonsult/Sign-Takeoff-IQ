import { Router, type IRouter } from "express";
import { eq, desc } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  jobsTable,
  jobFilesTable,
  extractedSignsTable,
  type InsertExtractedSign,
} from "@workspace/db";
import { ai } from "@workspace/integrations-gemini-ai";
import { extractSignsFromPdf } from "../lib/extraction";
import { buildExcelExport } from "../lib/export";
import { getJobExportPath, saveParsedResult } from "../lib/storage";
import fs from "fs/promises";

const router: IRouter = Router();

router.get("/jobs", async (req, res) => {
  try {
    const jobs = await db
      .select()
      .from(jobsTable)
      .orderBy(desc(jobsTable.createdAt));

    res.json({ jobs });
  } catch (err) {
    req.log.error({ err }, "Failed to list jobs");
    res.status(500).json({ error: "Failed to list jobs" });
  }
});

router.get("/jobs/:jobId", async (req, res) => {
  const { jobId } = req.params;
  if (!jobId) {
    res.status(400).json({ error: "Job ID required" });
    return;
  }

  try {
    const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, jobId));
    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }

    const files = await db
      .select()
      .from(jobFilesTable)
      .where(eq(jobFilesTable.jobId, jobId));

    const extractedSigns = await db
      .select()
      .from(extractedSignsTable)
      .where(eq(extractedSignsTable.jobId, jobId));

    const totalSigns = extractedSigns.length;
    const flaggedCount = extractedSigns.filter((s) => s.reviewFlag).length;
    const highConfidenceCount = extractedSigns.filter((s) => s.confidenceScore >= 0.8).length;

    res.json({
      job,
      files: files.map((f) => ({
        id: f.id,
        originalName: f.originalName,
        pageCount: f.pageCount,
        createdAt: f.createdAt,
      })),
      extractedSigns,
      totalSigns,
      flaggedCount,
      highConfidenceCount,
    });
  } catch (err) {
    req.log.error({ err, jobId }, "Failed to get job");
    res.status(500).json({ error: "Failed to get job" });
  }
});

router.post("/jobs/:jobId/process", async (req, res) => {
  const { jobId } = req.params;
  if (!jobId) {
    res.status(400).json({ error: "Job ID required" });
    return;
  }

  try {
    const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, jobId));
    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }

    if (job.status === "processing") {
      res.status(409).json({ error: "Job is already processing" });
      return;
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
        .set({ status: "failed", error: "No files found for this job", updatedAt: new Date() })
        .where(eq(jobsTable.id, jobId));
      res.status(422).json({ error: "No files found for this job" });
      return;
    }

    req.log.info({ jobId, fileCount: files.length }, "Starting extraction");

    const allRows: InsertExtractedSign[] = [];
    const parsedResults: Record<string, unknown>[] = [];

    for (const file of files) {
      try {
        req.log.info({ jobId, file: file.originalName }, "Extracting signs from file");
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
            confidenceScore: row.confidence_score,
            reviewFlag: row.review_flag,
            rawJson: row as unknown as Record<string, unknown>,
          });
        }
      } catch (err) {
        req.log.error({ err, fileId: file.id, fileName: file.originalName }, "File extraction failed");
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
      req.log.warn({ jobId, failedCount }, "All files failed — marking job as failed");
      res.status(422).json({ error: "Extraction failed for all files", details: errorSummary });
      return;
    }

    await db
      .update(jobsTable)
      .set({ status: "completed", updatedAt: new Date() })
      .where(eq(jobsTable.id, jobId));

    req.log.info({ jobId, extractedCount: allRows.length, failedCount }, "Job processing complete");

    res.json({
      success: true,
      message: `Extraction complete. Found ${allRows.length} sign entries.${failedCount > 0 ? ` (${failedCount} file(s) failed)` : ""}`,
      extractedCount: allRows.length,
      failedFileCount: failedCount,
    });
  } catch (err) {
    req.log.error({ err, jobId }, "Job processing failed");
    await db
      .update(jobsTable)
      .set({ status: "failed", error: String(err), updatedAt: new Date() })
      .where(eq(jobsTable.id, jobId)).catch(() => {});
    res.status(500).json({ error: "Job processing failed", details: String(err) });
  }
});

router.get("/jobs/:jobId/export", async (req, res) => {
  const { jobId } = req.params;
  if (!jobId) {
    res.status(400).json({ error: "Job ID required" });
    return;
  }

  try {
    const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, jobId));
    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }

    if (job.status !== "completed") {
      res.status(422).json({ error: "Job must be completed before exporting" });
      return;
    }

    const signs = await db
      .select()
      .from(extractedSignsTable)
      .where(eq(extractedSignsTable.jobId, jobId));

    if (signs.length === 0) {
      res.status(404).json({ error: "No extracted signs found for this job" });
      return;
    }

    const exportPath = getJobExportPath(jobId);
    await buildExcelExport(signs, jobId, exportPath);

    const fileName = `sign-takeoff-${jobId.slice(0, 8)}.xlsx`;
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);

    const fileBuffer = await fs.readFile(exportPath);
    res.send(fileBuffer);

    req.log.info({ jobId, signCount: signs.length, fileName }, "Export served");
  } catch (err) {
    req.log.error({ err, jobId }, "Export failed");
    res.status(500).json({ error: "Export failed", details: String(err) });
  }
});

export default router;
