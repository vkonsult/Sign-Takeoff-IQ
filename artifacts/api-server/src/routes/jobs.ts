import { Router, type IRouter } from "express";
import { eq, desc } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  jobsTable,
  jobFilesTable,
  extractedSignsTable,
} from "@workspace/db";
import { buildExcelExport } from "../lib/export";
import { getJobExportPath } from "../lib/storage";
import { processJob } from "../lib/process-job";
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

    req.log.info({ jobId }, "Starting extraction via manual trigger");
    await processJob(jobId);

    const [updated] = await db.select().from(jobsTable).where(eq(jobsTable.id, jobId));
    const extractedCount = (await db.select().from(extractedSignsTable).where(eq(extractedSignsTable.jobId, jobId))).length;
    res.json({
      success: true,
      status: updated?.status,
      message: updated?.status === "completed"
        ? `Extraction complete. Found ${extractedCount} sign entries.`
        : `Job ended with status: ${updated?.status}`,
      extractedCount,
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
