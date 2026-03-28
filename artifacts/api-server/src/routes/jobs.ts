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
import fsSync from "fs";
import { z } from "zod/v4";

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

router.get("/jobs/:jobId/files/:fileId/pdf", async (req, res) => {
  const { jobId, fileId } = req.params;
  if (!jobId || !fileId) {
    res.status(400).json({ error: "Job ID and file ID required" });
    return;
  }

  try {
    const [file] = await db
      .select()
      .from(jobFilesTable)
      .where(eq(jobFilesTable.id, fileId));

    if (!file || file.jobId !== jobId) {
      res.status(404).json({ error: "File not found" });
      return;
    }

    try {
      await fs.access(file.storedPath);
    } catch {
      res.status(404).json({ error: "PDF file not found on disk" });
      return;
    }

    const stat = await fs.stat(file.storedPath);
    const fileSize = stat.size;
    const rangeHeader = req.headers.range;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "private, max-age=300");
    res.setHeader("Content-Disposition", `inline; filename="${file.originalName}"`);

    if (rangeHeader) {
      const parts = rangeHeader.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0]!, 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;

      res.status(206);
      res.setHeader("Content-Range", `bytes ${start}-${end}/${fileSize}`);
      res.setHeader("Content-Length", chunkSize);

      const stream = fsSync.createReadStream(file.storedPath, { start, end });
      stream.pipe(res);
    } else {
      res.setHeader("Content-Length", fileSize);
      const stream = fsSync.createReadStream(file.storedPath);
      stream.pipe(res);
    }
  } catch (err) {
    req.log.error({ err, fileId }, "Failed to serve PDF");
    res.status(500).json({ error: "Failed to serve PDF" });
  }
});

const UpdateSignSchema = z.object({
  sheetNumber: z.string().nullable().optional(),
  detailReference: z.string().nullable().optional(),
  signType: z.string().nullable().optional(),
  signIdentifier: z.string().nullable().optional(),
  quantity: z.coerce.number().int().positive().nullable().optional(),
  location: z.string().nullable().optional(),
  dimensions: z.string().nullable().optional(),
  mountingType: z.string().nullable().optional(),
  finishColor: z.string().nullable().optional(),
  illumination: z.string().nullable().optional(),
  materials: z.string().nullable().optional(),
  messageContent: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  reviewFlag: z.boolean().optional(),
});

router.patch("/extracted-signs/:signId", async (req, res) => {
  const { signId } = req.params;
  if (!signId) {
    res.status(400).json({ error: "Sign ID required" });
    return;
  }

  const parsed = UpdateSignSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
    return;
  }

  try {
    const [existing] = await db
      .select()
      .from(extractedSignsTable)
      .where(eq(extractedSignsTable.id, signId));

    if (!existing) {
      res.status(404).json({ error: "Sign not found" });
      return;
    }

    const [updated] = await db
      .update(extractedSignsTable)
      .set(parsed.data)
      .where(eq(extractedSignsTable.id, signId))
      .returning();

    res.json({ sign: updated });
    req.log.info({ signId }, "Sign updated");
  } catch (err) {
    req.log.error({ err, signId }, "Failed to update sign");
    res.status(500).json({ error: "Failed to update sign" });
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
