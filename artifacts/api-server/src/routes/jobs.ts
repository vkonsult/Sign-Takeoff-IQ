import { Router, type IRouter, type Request, type Response } from "express";
import { eq, desc, inArray, and, or, ne, isNull, isNotNull, not, SQL, sql, getTableColumns } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  jobsTable,
  jobFilesTable,
  extractedSignsTable,
  activityLogsTable,
} from "@workspace/db";
import { buildExcelExport } from "../lib/export";
import { getJobExportPath } from "../lib/storage";
import { extractPagePhrases } from "../lib/pdf-words";
import { processJob } from "../lib/process-job";
import { extractSignsFromPdfImage, extractSignsFromPdf, visualLocateDoors } from "../lib/extraction";
import { ai } from "@workspace/integrations-gemini-ai";
import fs from "fs/promises";
import fsSync from "fs";
import { z } from "zod/v4";
import { requireRole } from "../middlewares/authMiddleware";
import { recordActivity } from "../lib/record-activity";

const router: IRouter = Router();

function orgFilter(req: Request): SQL | undefined | "FORBIDDEN" {
  const user = req.authUser;
  if (!user || user.isSuperAdmin) return undefined;
  if (user.organizationId) return eq(jobsTable.organizationId, user.organizationId);
  return "FORBIDDEN";
}

async function getJobWithOrgCheck(req: Request, res: Response, jobId: string) {
  const user = req.authUser;
  if (user && !user.isSuperAdmin && !user.organizationId) {
    res.status(403).json({ error: "No organization context" });
    return null;
  }
  const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, jobId));
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return null;
  }
  if (user && !user.isSuperAdmin) {
    if (job.organizationId !== user.organizationId) {
      res.status(403).json({ error: "Access denied" });
      return null;
    }
  }
  return job;
}

router.get("/jobs", async (req, res) => {
  try {
    const filter = orgFilter(req);
    if (filter === "FORBIDDEN") {
      res.status(403).json({ error: "No organization context" });
      return;
    }
    const jobs = await db
      .select({
        ...getTableColumns(jobsTable),
        lastActivityAt: sql<string | null>`(SELECT created_at FROM activity_logs WHERE job_id = ${jobsTable.id} ORDER BY created_at DESC LIMIT 1)`.as("last_activity_at"),
        lastActivityUser: sql<string | null>`(SELECT user_name FROM activity_logs WHERE job_id = ${jobsTable.id} ORDER BY created_at DESC LIMIT 1)`.as("last_activity_user"),
        lastActivityInitials: sql<string | null>`(SELECT user_initials FROM activity_logs WHERE job_id = ${jobsTable.id} ORDER BY created_at DESC LIMIT 1)`.as("last_activity_initials"),
        lastActivityType: sql<string | null>`(SELECT event_type FROM activity_logs WHERE job_id = ${jobsTable.id} ORDER BY created_at DESC LIMIT 1)`.as("last_activity_type"),
      })
      .from(jobsTable)
      .where(filter)
      .orderBy(desc(jobsTable.createdAt));

    const jobIds = jobs.map((j) => j.id);

    // DISTINCT ON (job_id, user_id) gets the most recent event per user per job in one query.
    // JS then takes the top 2 per job (already deduplicated).
    const recentUsersByJob = new Map<string, { userName: string; userInitials: string; at: Date; eventType: string }[]>();
    if (jobIds.length > 0) {
      const perUserRows = await db
        .selectDistinctOn([activityLogsTable.jobId, activityLogsTable.userId], {
          jobId: activityLogsTable.jobId,
          userId: activityLogsTable.userId,
          userName: activityLogsTable.userName,
          userInitials: activityLogsTable.userInitials,
          at: activityLogsTable.createdAt,
          eventType: activityLogsTable.eventType,
        })
        .from(activityLogsTable)
        .where(inArray(activityLogsTable.jobId, jobIds))
        .orderBy(activityLogsTable.jobId, activityLogsTable.userId, desc(activityLogsTable.createdAt));

      // Sort by most-recently-active across all users, then pick top 2 per job
      perUserRows.sort((a, b) => b.at.getTime() - a.at.getTime());
      for (const row of perUserRows) {
        if (!row.jobId) continue;
        const list = recentUsersByJob.get(row.jobId) ?? [];
        if (list.length < 2) {
          list.push({ userName: row.userName, userInitials: row.userInitials, at: row.at, eventType: row.eventType });
          recentUsersByJob.set(row.jobId, list);
        }
      }
    }

    const enriched = jobs.map((j) => {
      const users = recentUsersByJob.get(j.id) ?? [];
      return {
        ...j,
        recentUsers: users.map((u) => ({ userName: u.userName, userInitials: u.userInitials, at: u.at, eventType: u.eventType })),
      };
    });

    res.json({ jobs: enriched });
  } catch (err) {
    req.log.error({ err }, "Failed to list jobs");
    res.status(500).json({ error: "Failed to list jobs" });
  }
});

router.delete("/jobs/:jobId", async (req, res) => {
  const { jobId } = req.params;
  if (!jobId) {
    res.status(400).json({ error: "Job ID required" });
    return;
  }

  try {
    const job = await getJobWithOrgCheck(req, res, jobId);
    if (!job) return;

    const files = await db
      .select({ storedPath: jobFilesTable.storedPath })
      .from(jobFilesTable)
      .where(eq(jobFilesTable.jobId, jobId));

    const [deleted] = await db
      .delete(jobsTable)
      .where(eq(jobsTable.id, jobId))
      .returning();

    if (!deleted) {
      res.status(404).json({ error: "Job not found" });
      return;
    }

    for (const f of files) {
      try {
        await fs.unlink(f.storedPath);
      } catch {
        // ignore if already gone
      }
    }

    req.log.info({ jobId }, "Job deleted");
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err, jobId }, "Failed to delete job");
    res.status(500).json({ error: "Failed to delete job" });
  }
});

// ── Batch delete multiple jobs ─────────────────────────────────────────────
router.delete("/jobs", async (req, res) => {
  const { jobIds } = req.body as { jobIds?: unknown };

  if (!Array.isArray(jobIds) || jobIds.length === 0 || !jobIds.every((id) => typeof id === "string")) {
    res.status(400).json({ error: "jobIds must be a non-empty array of strings" });
    return;
  }

  const ids = jobIds as string[];

  const user = req.authUser;
  if (user && !user.isSuperAdmin && !user.organizationId) {
    res.status(403).json({ error: "No organization context" });
    return;
  }

  try {
    const orgCondition = user && !user.isSuperAdmin
      ? eq(jobsTable.organizationId, user.organizationId)
      : undefined;

    // Collect file paths BEFORE deleting so ON DELETE CASCADE doesn't wipe them first.
    const filesToDelete = await db
      .select({ storedPath: jobFilesTable.storedPath, jobId: jobFilesTable.jobId })
      .from(jobFilesTable)
      .innerJoin(jobsTable, eq(jobFilesTable.jobId, jobsTable.id))
      .where(and(inArray(jobsTable.id, ids), orgCondition));

    // Delete jobs — org-scoped; only authorized rows are removed.
    const deleted = await db
      .delete(jobsTable)
      .where(and(inArray(jobsTable.id, ids), orgCondition))
      .returning({ id: jobsTable.id });

    const deletedIds = new Set(deleted.map((r) => r.id));

    // Only unlink disk files for jobs that were actually deleted.
    for (const f of filesToDelete) {
      if (!deletedIds.has(f.jobId)) continue;
      try {
        await fs.unlink(f.storedPath);
      } catch {
        // ignore if already gone
      }
    }

    req.log.info({ count: deleted.length, ids }, "Batch jobs deleted");
    res.json({ success: true, deletedCount: deleted.length });
  } catch (err) {
    req.log.error({ err }, "Batch job delete failed");
    res.status(500).json({ error: "Failed to delete jobs" });
  }
});

router.get("/jobs/:jobId", async (req, res) => {
  const { jobId } = req.params;
  if (!jobId) {
    res.status(400).json({ error: "Job ID required" });
    return;
  }

  try {
    const job = await getJobWithOrgCheck(req, res, jobId);
    if (!job) return;

    const files = await db
      .select()
      .from(jobFilesTable)
      .where(eq(jobFilesTable.jobId, jobId));

    // Unified display filter:
    // - Show text/manual signs PLUS image-only signs (those with no pair).
    // - Exclude paired image signs (already merged into the text row with "Both" badge).
    // - Exclude hidden signs (soft-deleted); they are returned separately as hiddenSigns.
    const visibleFilter = and(
      eq(extractedSignsTable.jobId, jobId),
      not(extractedSignsTable.hidden),
      or(
        isNull(extractedSignsTable.extractionMethod),
        ne(extractedSignsTable.extractionMethod, "image"),
        isNull(extractedSignsTable.pairedSignId)
      )
    );

    const extractedSigns = await db
      .select()
      .from(extractedSignsTable)
      .where(visibleFilter);

    // Hidden signs — returned separately so the UI can offer a "Show hidden" panel.
    const hiddenSigns = await db
      .select()
      .from(extractedSignsTable)
      .where(
        and(
          eq(extractedSignsTable.jobId, jobId),
          extractedSignsTable.hidden
        )
      );

    // markerSigns includes image-pass signs with xPos/yPos so they are available
    // for floor-plan marker overlays and the "Export Marked PDF" workflow.
    const markerSigns = await db
      .select()
      .from(extractedSignsTable)
      .where(
        and(
          eq(extractedSignsTable.jobId, jobId),
          isNotNull(extractedSignsTable.xPos),
          isNotNull(extractedSignsTable.yPos)
        )
      );

    const totalSigns = extractedSigns.length;
    const flaggedCount = extractedSigns.filter((s) => s.reviewFlag).length;
    const highConfidenceCount = extractedSigns.filter((s) => s.confidenceScore >= 0.8).length;

    // Unified processing cost: combines text-pass tokens + visual-scan tokens
    const COST_INPUT = 0.15 / 1_000_000;
    const COST_OUTPUT = 0.60 / 1_000_000;
    const combinedInputTokens = (job.inputTokens ?? 0) + (job.imageInputTokens ?? 0);
    const combinedOutputTokens = (job.outputTokens ?? 0) + (job.imageOutputTokens ?? 0);
    const combinedCost = combinedInputTokens * COST_INPUT + combinedOutputTokens * COST_OUTPUT;

    const [lastScanRow] = await db
      .select({
        at: activityLogsTable.createdAt,
        userName: activityLogsTable.userName,
        userInitials: activityLogsTable.userInitials,
      })
      .from(activityLogsTable)
      .where(and(eq(activityLogsTable.jobId, jobId), eq(activityLogsTable.eventType, "scan_run")))
      .orderBy(desc(activityLogsTable.createdAt))
      .limit(1);

    const [lastEditRow] = await db
      .select({
        at: activityLogsTable.createdAt,
        userName: activityLogsTable.userName,
        userInitials: activityLogsTable.userInitials,
      })
      .from(activityLogsTable)
      .where(and(eq(activityLogsTable.jobId, jobId), eq(activityLogsTable.eventType, "sign_updated")))
      .orderBy(desc(activityLogsTable.createdAt))
      .limit(1);

    recordActivity(req, "job_opened", jobId);

    res.json({
      job,
      lastScan: lastScanRow ?? null,
      lastEdit: lastEditRow ?? null,
      files: files.map((f) => ({
        id: f.id,
        originalName: f.originalName,
        pageCount: f.pageCount,
        pageStats: f.pageStats ?? null,
        createdAt: f.createdAt,
      })),
      extractedSigns,
      hiddenSigns,
      totalSigns,
      flaggedCount,
      highConfidenceCount,
      processingCost: {
        inputTokens: combinedInputTokens,
        outputTokens: combinedOutputTokens,
        totalCost: combinedCost,
      },
      markerSigns,
    });
  } catch (err) {
    req.log.error({ err, jobId }, "Failed to get job");
    res.status(500).json({ error: "Failed to get job" });
  }
});

const UpdateJobSchema = z.object({
  name: z.string().min(1).max(200),
});

router.patch("/jobs/:jobId", async (req, res) => {
  const { jobId } = req.params;
  if (!jobId) {
    res.status(400).json({ error: "Job ID required" });
    return;
  }

  const parsed = UpdateJobSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
    return;
  }

  try {
    const job = await getJobWithOrgCheck(req, res, jobId);
    if (!job) return;

    const [updated] = await db
      .update(jobsTable)
      .set({ name: parsed.data.name, updatedAt: new Date() })
      .where(eq(jobsTable.id, jobId))
      .returning();

    if (!updated) {
      res.status(404).json({ error: "Job not found" });
      return;
    }

    res.json({ job: updated });
    req.log.info({ jobId, name: parsed.data.name }, "Job name updated");
  } catch (err) {
    req.log.error({ err, jobId }, "Failed to update job");
    res.status(500).json({ error: "Failed to update job" });
  }
});

router.post("/jobs/:jobId/process", async (req, res) => {
  const { jobId } = req.params;
  if (!jobId) {
    res.status(400).json({ error: "Job ID required" });
    return;
  }

  try {
    const job = await getJobWithOrgCheck(req, res, jobId);
    if (!job) return;

    if (job.status === "processing") {
      res.status(409).json({ error: "Job is already processing" });
      return;
    }

    req.log.info({ jobId }, "Starting extraction via manual trigger");
    await processJob(jobId);

    const [updated] = await db.select().from(jobsTable).where(eq(jobsTable.id, jobId));
    const extractedCount = (await db.select().from(extractedSignsTable).where(eq(extractedSignsTable.jobId, jobId))).length;
    recordActivity(req, "scan_run", jobId);

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

// ── Compare: image vs text extraction ─────────────────────────────────────────
router.post("/jobs/:jobId/compare", async (req, res) => {
  const { jobId } = req.params;
  if (!jobId) {
    res.status(400).json({ error: "Job ID required" });
    return;
  }

  try {
    const job = await getJobWithOrgCheck(req, res, jobId);
    if (!job) return;

    if (job.status !== "completed") {
      res.status(422).json({ error: "Job must be completed before running comparison" });
      return;
    }

    const files = await db.select().from(jobFilesTable).where(eq(jobFilesTable.jobId, jobId));
    if (files.length === 0) {
      res.status(404).json({ error: "No files found for this job" });
      return;
    }

    // Clear all previous comparison signs (text + image, excluding manual/verified)
    await db
      .delete(extractedSignsTable)
      .where(
        and(
          eq(extractedSignsTable.jobId, jobId),
          eq(extractedSignsTable.manuallyAdded, false),
          eq(extractedSignsTable.userVerified, false)
        )
      );

    req.log.info({ jobId }, "Cleared previous non-manual signs for comparison re-run");

    // ── Run text and image extraction passes in parallel ──────────────────────
    function buildTextRow(row: Awaited<ReturnType<typeof extractSignsFromPdf>>["rows"][number], file: typeof files[number]) {
      return {
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
        xPos: null as number | null,
        yPos: null as number | null,
        confidenceScore: row.confidence_score,
        reviewFlag: row.review_flag,
        extractionMethod: "text",
      };
    }

    function buildImageRow(row: Awaited<ReturnType<typeof extractSignsFromPdfImage>>["rows"][number], file: typeof files[number]) {
      return {
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
        reviewFlag: row.review_flag,
        extractionMethod: "image",
      };
    }

    // Run both extraction passes in parallel across all files
    const [textResults, imageResults] = await Promise.all([
      Promise.all(
        files.map(async (file) => {
          try {
            const result = await extractSignsFromPdf(file.storedPath, ai);
            return { file, ...result };
          } catch (err) {
            req.log.error({ err, fileId: file.id }, "Text extraction failed for file in compare pass");
            return { file, rows: [], inputTokens: 0, outputTokens: 0, pageCount: 0, rawText: "", pageStats: { floorPlanPages: [], signSchedulePages: [], otherPages: [] } };
          }
        })
      ),
      Promise.all(
        files.map(async (file) => {
          try {
            const result = await extractSignsFromPdfImage(file.storedPath, ai);
            return { file, ...result };
          } catch (err) {
            req.log.error({ err, fileId: file.id }, "Image extraction failed for file in compare pass");
            return { file, rows: [], inputTokens: 0, outputTokens: 0, skipped: true, skipReason: "Internal error" };
          }
        })
      ),
    ]);

    const totalTextInputTokens = textResults.reduce((sum, r) => sum + r.inputTokens, 0);
    const totalTextOutputTokens = textResults.reduce((sum, r) => sum + r.outputTokens, 0);
    const totalImageInputTokens = imageResults.reduce((sum, r) => sum + r.inputTokens, 0);
    const totalImageOutputTokens = imageResults.reduce((sum, r) => sum + r.outputTokens, 0);
    // Determine if all image passes were skipped (e.g. all files failed or were too large)
    const imageSkipped = imageResults.every((r) => r.skipped === true);
    const imageSkipReasons = [...new Set(imageResults.flatMap((r) => r.skipReason ? [r.skipReason] : []))];
    const imageSkipReason = imageSkipReasons.length > 0 ? imageSkipReasons.join("; ") : null;

    const textRows = textResults.flatMap((r) => r.rows.map((row) => buildTextRow(row, r.file)));
    const imageRows = imageResults.flatMap((r) => r.rows.map((row) => buildImageRow(row, r.file)));

    if (textRows.length > 0) {
      await db.insert(extractedSignsTable).values(textRows);
    }
    if (imageRows.length > 0) {
      await db.insert(extractedSignsTable).values(imageRows);
    }

    // Persist token counts for both passes on the job
    await db
      .update(jobsTable)
      .set({
        imageInputTokens: totalImageInputTokens,
        imageOutputTokens: totalImageOutputTokens,
        compareTextInputTokens: totalTextInputTokens,
        compareTextOutputTokens: totalTextOutputTokens,
        updatedAt: new Date(),
      })
      .where(eq(jobsTable.id, jobId));

    // ── Matching pass ─────────────────────────────────────────────────────────
    // Match text signs against image signs using significant-word overlap scoring
    // (tokens ≥4 chars). This strategy is more robust than literal substring overlap
    // for sign data because: (a) sign types/locations often differ in minor phrasing
    // ("ROOM ID" vs "Room Identification"), and (b) very short labels like "103" would
    // produce empty significant-word sets and correctly fall through to positional
    // proximity as the tiebreaker. Requires BOTH type AND location overlap to
    // reduce false-positive matches between same-type signs at different locations.

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

    function positionProximity(imgSign: typeof extractedSignsTable.$inferSelect, txtSign: typeof extractedSignsTable.$inferSelect): number {
      if (imgSign.xPos == null || imgSign.yPos == null || txtSign.xPos == null || txtSign.yPos == null) return 0;
      const dx = imgSign.xPos - txtSign.xPos;
      const dy = imgSign.yPos - txtSign.yPos;
      const dist = Math.sqrt(dx * dx + dy * dy);
      return dist < 0.1 ? 1 : dist < 0.25 ? 0.5 : 0;
    }

    function isMatch(imgSign: typeof extractedSignsTable.$inferSelect, txtSign: typeof extractedSignsTable.$inferSelect): boolean {
      const typeScore = wordOverlapScore(imgSign.signType, txtSign.signType);
      const locScore = wordOverlapScore(imgSign.location, txtSign.location);
      const posFactor = positionProximity(imgSign, txtSign);

      // Primary: require meaningful overlap on both type AND location
      if (typeScore >= 0.5 && locScore >= 0.5) return true;
      // Secondary: very strong overlap on one field + some on the other
      if (typeScore >= 0.8 && locScore >= 0.2) return true;
      if (locScore >= 0.8 && typeScore >= 0.2) return true;
      // Tertiary: position is very close + one field overlaps
      if (posFactor > 0 && (typeScore >= 0.5 || locScore >= 0.5)) return true;
      return false;
    }

    // Re-fetch after inserts so we have real DB IDs
    const allSignsAfter = await db
      .select()
      .from(extractedSignsTable)
      .where(eq(extractedSignsTable.jobId, jobId));

    const textCompareSigns = allSignsAfter.filter((s) => s.extractionMethod === "text" && !s.manuallyAdded && !s.userVerified);
    const imageSigns = allSignsAfter.filter((s) => s.extractionMethod === "image");

    // Greedy best-match pairing
    const matchedTextIds = new Set<string>();
    const matchedImageIds = new Set<string>();
    const pairs: Array<{ textId: string; imageId: string }> = [];

    for (const imgSign of imageSigns) {
      let bestTextSign: typeof imageSigns[number] | null = null;
      let bestTypeScore = 0;

      for (const txtSign of textCompareSigns) {
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

    // Persist pairings and symmetrically boost confidence on both rows
    for (const { textId, imageId } of pairs) {
      const txtSign = textCompareSigns.find((s) => s.id === textId)!;
      const imgSign = imageSigns.find((s) => s.id === imageId)!;

      const txtBoosted = Math.min(1.0, (txtSign.confidenceScore ?? 0) + 0.15);
      const imgBoosted = Math.min(1.0, (imgSign.confidenceScore ?? 0) + 0.15);

      await db
        .update(extractedSignsTable)
        .set({ pairedSignId: imageId, confidenceScore: txtBoosted, reviewFlag: txtBoosted >= 0.6 ? false : true })
        .where(eq(extractedSignsTable.id, textId));

      await db
        .update(extractedSignsTable)
        .set({ pairedSignId: textId, confidenceScore: imgBoosted, reviewFlag: imgBoosted >= 0.6 ? false : true })
        .where(eq(extractedSignsTable.id, imageId));
    }

    // Re-fetch final state for response buckets
    const finalSigns = await db
      .select()
      .from(extractedSignsTable)
      .where(eq(extractedSignsTable.jobId, jobId));

    const finalTextSigns = finalSigns.filter((s) => s.extractionMethod === "text" && !s.manuallyAdded && !s.userVerified);
    const finalImage = finalSigns.filter((s) => s.extractionMethod === "image");

    const both = finalTextSigns.filter((s) => s.pairedSignId != null);
    const textOnly = finalTextSigns.filter((s) => s.pairedSignId == null);
    const imageOnly = finalImage.filter((s) => s.pairedSignId == null);

    const INPUT_RATE = 0.15;
    const OUTPUT_RATE = 0.60;
    const imageCost =
      ((totalImageInputTokens * INPUT_RATE) + (totalImageOutputTokens * OUTPUT_RATE)) / 1_000_000;
    const textCompareCost =
      ((totalTextInputTokens * INPUT_RATE) + (totalTextOutputTokens * OUTPUT_RATE)) / 1_000_000;

    req.log.info(
      {
        jobId,
        textFound: textRows.length,
        imageFound: imageRows.length,
        matched: pairs.length,
        textOnly: textOnly.length,
        imageOnly: imageOnly.length,
        totalImageInputTokens,
        totalImageOutputTokens,
      },
      "Comparison complete"
    );

    res.json({
      success: true,
      textOnly,
      both,
      imageOnly,
      imageInputTokens: totalImageInputTokens,
      imageOutputTokens: totalImageOutputTokens,
      textCompareInputTokens: totalTextInputTokens,
      textCompareOutputTokens: totalTextOutputTokens,
      imageCost,
      textCompareCost,
      totalCost: imageCost + textCompareCost,
      imageSkipped,
      imageSkipReason,
    });
  } catch (err) {
    req.log.error({ err, jobId }, "Comparison failed");
    res.status(500).json({ error: "Comparison failed", details: String(err) });
  }
});

router.get("/jobs/:jobId/files/:fileId/pdf", async (req, res) => {
  const { jobId, fileId } = req.params;
  if (!jobId || !fileId) {
    res.status(400).json({ error: "Job ID and file ID required" });
    return;
  }

  try {
    const _job = await getJobWithOrgCheck(req, res, jobId);
    if (!_job) return;

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

// ── Word / phrase extraction for marker placement ──────────────────────────
// Returns text phrases with full bounding boxes (normalised 0–1) for a single
// page of the uploaded PDF.  Results are cached in memory per (fileId, pageNum).
router.get("/jobs/:jobId/files/:fileId/pages/:pageNum/words", async (req, res) => {
  const { jobId, fileId, pageNum } = req.params;
  const pageNumInt = parseInt(pageNum ?? "", 10);

  if (!jobId || !fileId || isNaN(pageNumInt) || pageNumInt < 1) {
    res.status(400).json({ error: "Invalid parameters" });
    return;
  }

  try {
    const _job = await getJobWithOrgCheck(req, res, jobId);
    if (!_job) return;

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

    const result = await extractPagePhrases(file.storedPath, fileId, pageNumInt);

    res.setHeader("Cache-Control", "private, max-age=300");
    res.json(result);
  } catch (err) {
    req.log.error({ err, fileId, pageNum }, "Failed to extract page words");
    res.status(500).json({ error: "Failed to extract page words" });
  }
});

const CreateSignSchema = z.object({
  jobId: z.string().uuid(),
  jobFileId: z.string().uuid().nullable().optional(),
  pageNumber: z.number().int().positive().nullable().optional(),
  xPos: z.number().min(0).max(1).nullable().optional(),
  yPos: z.number().min(0).max(1).nullable().optional(),
  signType: z.string().nullable().optional(),
  signIdentifier: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
});

router.post("/extracted-signs", async (req, res) => {
  const parsed = CreateSignSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
    return;
  }

  try {
    const _job = await getJobWithOrgCheck(req, res, parsed.data.jobId);
    if (!_job) return;

    const [sign] = await db
      .insert(extractedSignsTable)
      .values({
        ...parsed.data,
        manuallyAdded: true,
        extractionMethod: "manual",
        confidenceScore: 1.0,
        reviewFlag: false,
      })
      .returning();

    res.status(201).json({ sign });
    req.log.info({ signId: sign?.id }, "Manually added sign created");
  } catch (err) {
    req.log.error({ err }, "Failed to create sign");
    res.status(500).json({ error: "Failed to create sign" });
  }
});

router.delete("/extracted-signs/:signId", async (req, res) => {
  const { signId } = req.params;
  if (!signId) {
    res.status(400).json({ error: "Sign ID required" });
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

    const _job = await getJobWithOrgCheck(req, res, existing.jobId);
    if (!_job) return;

    const [deleted] = await db
      .delete(extractedSignsTable)
      .where(eq(extractedSignsTable.id, signId))
      .returning();

    if (!deleted) {
      res.status(404).json({ error: "Sign not found" });
      return;
    }

    res.json({ success: true });
    req.log.info({ signId }, "Sign deleted");
  } catch (err) {
    req.log.error({ err, signId }, "Failed to delete sign");
    res.status(500).json({ error: "Failed to delete sign" });
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
  hidden: z.boolean().optional(),
  xPos: z.number().min(0).max(1).nullable().optional(),
  yPos: z.number().min(0).max(1).nullable().optional(),
  placementSource: z.enum(["text_match", "vector_match", "gemini_vision", "user_confirmed", "manual"]).nullable().optional(),
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

    const _job = await getJobWithOrgCheck(req, res, existing.jobId);
    if (!_job) return;

    // Only auto-verify when the user edits actual sign content fields.
    // Status-flag-only updates (hidden, reviewFlag) should not trigger verification.
    // AI/system placement updates (placementSource present) also skip auto-verify — position
    // confirmation by the AI is not the same as a human verifying the sign's content.
    const contentFields: (keyof typeof parsed.data)[] = [
      "sheetNumber", "detailReference", "signType", "signIdentifier", "quantity",
      "location", "dimensions", "mountingType", "finishColor", "illumination",
      "materials", "messageContent", "notes", "xPos", "yPos",
    ];
    const isPlacementUpdate = parsed.data.placementSource !== undefined;
    const hasContentEdit = !isPlacementUpdate && contentFields.some((f) => parsed.data[f] !== undefined);
    const updatePayload = hasContentEdit
      ? { ...parsed.data, userVerified: true }
      : { ...parsed.data };

    const [updated] = await db
      .update(extractedSignsTable)
      .set(updatePayload)
      .where(eq(extractedSignsTable.id, signId))
      .returning();

    recordActivity(req, "sign_updated", existing.jobId);

    res.json({ sign: updated });
    req.log.info({ signId, userVerified: hasContentEdit }, "Sign updated");
  } catch (err) {
    req.log.error({ err, signId }, "Failed to update sign");
    res.status(500).json({ error: "Failed to update sign" });
  }
});

const VisualLocateSchema = z.object({
  fileId: z.string().uuid(),
  pageNumber: z.number().int().positive(),
  signs: z.array(z.object({
    signId: z.string().uuid(),
    signType: z.string().nullable().optional(),
    location: z.string().nullable().optional(),
    signIdentifier: z.string().nullable().optional(),
    roomNumber: z.string().nullable().optional(),
    typeToken: z.string().nullable().optional(),
    anchorX: z.number().min(0).max(1).nullable().optional(),
    anchorY: z.number().min(0).max(1).nullable().optional(),
  })).min(1).max(20),
});

router.post("/jobs/:jobId/visual-locate", async (req, res) => {
  const { jobId } = req.params;
  if (!jobId) {
    res.status(400).json({ error: "Job ID required" });
    return;
  }

  const parsed = VisualLocateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
    return;
  }

  try {
    const job = await getJobWithOrgCheck(req, res, jobId);
    if (!job) return;

    const [file] = await db
      .select()
      .from(jobFilesTable)
      .where(eq(jobFilesTable.id, parsed.data.fileId));

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

    const { results, method } = await visualLocateDoors(
      file.storedPath,
      parsed.data.pageNumber,
      parsed.data.signs,
      ai,
      parsed.data.fileId,
    );

    req.log.info({ jobId, pageNumber: parsed.data.pageNumber, signCount: parsed.data.signs.length, method }, "visual-locate complete");
    res.json({ results, method });
  } catch (err) {
    req.log.error({ err, jobId }, "visual-locate failed");
    res.status(500).json({ error: "visual-locate failed", details: String(err) });
  }
});

router.post("/jobs/:jobId/log-pdf-export", async (req, res) => {
  const { jobId } = req.params;
  if (!jobId) {
    res.status(400).json({ error: "Job ID required" });
    return;
  }
  try {
    const job = await getJobWithOrgCheck(req, res, jobId);
    if (!job) return;
    recordActivity(req, "pdf_exported", jobId);
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err, jobId }, "Failed to log PDF export");
    res.status(500).json({ error: "Failed to log" });
  }
});

router.get("/jobs/:jobId/export", async (req, res) => {
  const { jobId } = req.params;
  if (!jobId) {
    res.status(400).json({ error: "Job ID required" });
    return;
  }

  try {
    const job = await getJobWithOrgCheck(req, res, jobId);
    if (!job) return;

    if (job.status !== "completed") {
      res.status(422).json({ error: "Job must be completed before exporting" });
      return;
    }

    const signs = await db
      .select()
      .from(extractedSignsTable)
      .where(
        and(
          eq(extractedSignsTable.jobId, jobId),
          not(extractedSignsTable.hidden)
        )
      );

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

    recordActivity(req, "xlsx_exported", jobId);
    req.log.info({ jobId, signCount: signs.length, fileName }, "Export served");
  } catch (err) {
    req.log.error({ err, jobId }, "Export failed");
    res.status(500).json({ error: "Export failed", details: String(err) });
  }
});

export default router;
