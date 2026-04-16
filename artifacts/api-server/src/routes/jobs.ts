import path from "path";
import { Router, type IRouter, type Request, type Response } from "express";
import { eq, desc, inArray, and, or, ne, isNull, isNotNull, not, SQL, sql, getTableColumns } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  jobsTable,
  jobFilesTable,
  extractedSignsTable,
  activityLogsTable,
  signTypeSpecsTable,
  signageScheduleEntriesTable,
  complianceEntriesTable,
  plaqueSchedulesTable,
  occupantLoadsTable,
} from "@workspace/db";
import {
  applyRules,
  applyStairRules,
  applyElevatorRules,
  applyEvacMapRules,
  buildRoomInventory,
} from "../lib/rules-engine";
import { buildExcelExport } from "../lib/export";
import { buildRoomInventoryFromExtractedSigns, mergeOccupantLoads } from "../lib/room-inventory";
import { getJobExportPath, PAGES_DIR } from "../lib/storage";
import { processJob, deduplicateSignRows } from "../lib/process-job";
import { extractSignsFromPdfImage, extractSignsFromPdf, visualLocateDoors } from "../lib/extraction";
import { ai } from "@workspace/integrations-gemini-ai";
import { AI_CALL_REGISTRY, type AiCallType, runProjectInfoExtraction, runFloorPlanTextExtraction, runBboxDetection, runVisionFallback, runTitleBlockVision, runSignScheduleEnrich, runPlaqueScheduleExtraction, persistPlaqueSchedule, runOccupantLoadsExtraction, persistOccupantLoads, fetchOccupantLoadsForJob } from "../lib/ai-processor";
import { extractPagePhrases, matchLocationToCoords, type SpatialPageType } from "../lib/pdf-words";
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
    const includeArchived = req.query.includeArchived === "true";
    const archivedFilter = includeArchived ? undefined : ne(jobsTable.status, "archived");
    const whereClause = filter
      ? archivedFilter ? and(filter, archivedFilter) : filter
      : archivedFilter;
    const jobs = await db
      .select({
        ...getTableColumns(jobsTable),
        lastActivityAt: sql<string | null>`(SELECT created_at FROM activity_logs WHERE job_id = ${jobsTable.id} ORDER BY created_at DESC LIMIT 1)`.as("last_activity_at"),
        lastActivityUser: sql<string | null>`(SELECT user_name FROM activity_logs WHERE job_id = ${jobsTable.id} ORDER BY created_at DESC LIMIT 1)`.as("last_activity_user"),
        lastActivityInitials: sql<string | null>`(SELECT user_initials FROM activity_logs WHERE job_id = ${jobsTable.id} ORDER BY created_at DESC LIMIT 1)`.as("last_activity_initials"),
        lastActivityType: sql<string | null>`(SELECT event_type FROM activity_logs WHERE job_id = ${jobsTable.id} ORDER BY created_at DESC LIMIT 1)`.as("last_activity_type"),
        plaqueCount: sql<number>`(SELECT COUNT(*) FROM plaque_schedules WHERE job_id = ${jobsTable.id})`.as("plaque_count"),
        occupantLoadCount: sql<number>`(SELECT COUNT(*) FROM occupant_loads WHERE job_id = ${jobsTable.id})`.as("occupant_load_count"),
      })
      .from(jobsTable)
      .where(whereClause)
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

    // Fetch file IDs + names for all jobs in one query so the UI can build PDF links.
    const filesByJob = new Map<string, { id: string; originalName: string }[]>();
    if (jobIds.length > 0) {
      const fileRows = await db
        .select({ jobId: jobFilesTable.jobId, id: jobFilesTable.id, originalName: jobFilesTable.originalName })
        .from(jobFilesTable)
        .where(inArray(jobFilesTable.jobId, jobIds));
      for (const f of fileRows) {
        if (!f.jobId) continue;
        const list = filesByJob.get(f.jobId) ?? [];
        list.push({ id: f.id, originalName: f.originalName });
        filesByJob.set(f.jobId, list);
      }
    }

    const enriched = jobs.map((j) => {
      const users = recentUsersByJob.get(j.id) ?? [];
      return {
        ...j,
        files: filesByJob.get(j.id) ?? [],
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

    const [plaqueRows, occupantLoadRows] = await Promise.all([
      db.select({ id: plaqueSchedulesTable.id }).from(plaqueSchedulesTable).where(eq(plaqueSchedulesTable.jobId, jobId)),
      db.select({ id: occupantLoadsTable.id }).from(occupantLoadsTable).where(eq(occupantLoadsTable.jobId, jobId)),
    ]);
    const plaqueCount = plaqueRows.length;
    const occupantLoadCount = occupantLoadRows.length;

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
      plaqueCount,
      occupantLoadCount,
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

    function buildRawTextRow(row: Awaited<ReturnType<typeof extractSignsFromPdf>>["rawTextRows"][number], file: typeof files[number]) {
      return {
        jobId,
        jobFileId: file.id,
        sheetNumber: null as string | null,
        detailReference: null as string | null,
        signType: null as string | null,
        signIdentifier: row.sign_identifier,
        quantity: null as number | null,
        location: row.location,
        dimensions: null as string | null,
        mountingType: null as string | null,
        finishColor: null as string | null,
        illumination: null as string | null,
        materials: null as string | null,
        messageContent: null as string | null,
        notes: null as string | null,
        pageNumber: row.page_number,
        xPos: row.x_pos ?? null,
        yPos: row.y_pos ?? null,
        confidenceScore: row.confidence_score,
        reviewFlag: row.review_flag,
        extractionMethod: "raw_text" as const,
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
            const result = await extractSignsFromPdf(file.storedPath, file.id, ai);
            return { file, ...result };
          } catch (err) {
            req.log.error({ err, fileId: file.id }, "Text extraction failed for file in compare pass");
            return { file, rows: [], inputTokens: 0, outputTokens: 0, pageCount: 0, rawText: "", pageStats: { floorPlanPages: [], signSchedulePages: [], bothPages: [], otherPages: [] } };
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

    const rawTextRows = textResults.flatMap((r) => r.rows.map((row) => buildTextRow(row, r.file)));
    const rawImageRows = imageResults.flatMap((r) => r.rows.map((row) => buildImageRow(row, r.file)));
    // Code-proximity rows: deterministic label+code pairs from the PDF text layer.
    const rawCodeProximityRows = textResults.flatMap((r) => (r.rawTextRows ?? []).map((row) => buildRawTextRow(row, r.file)));

    const textRows = deduplicateSignRows(rawTextRows);
    const textSeenKeys = new Set(
      textRows
        .filter((r) => r.location && r.signType)
        .map((r) => `${r.location!.toLowerCase().trim()}||${r.signType!.toLowerCase().trim()}`),
    );
    const imageRows = deduplicateSignRows(
      rawImageRows.filter((r) => {
        if (!r.location || !r.signType) return true;
        return !textSeenKeys.has(`${r.location.toLowerCase().trim()}||${r.signType.toLowerCase().trim()}`);
      }),
    );
    // Deduplicate code-proximity rows by code+location+pageNumber to avoid duplicates on re-scan.
    const codeProximitySeenKeys = new Set<string>();
    const codeProximityRows = rawCodeProximityRows.filter((r) => {
      const key = `${(r.signIdentifier ?? "").toUpperCase()}||${(r.location ?? "").toUpperCase()}||${r.pageNumber ?? ""}`;
      if (codeProximitySeenKeys.has(key)) return false;
      codeProximitySeenKeys.add(key);
      return true;
    });

    if (textRows.length > 0) {
      await db.insert(extractedSignsTable).values(textRows);
    }
    if (imageRows.length > 0) {
      await db.insert(extractedSignsTable).values(imageRows);
    }
    if (codeProximityRows.length > 0) {
      await db.insert(extractedSignsTable).values(codeProximityRows);
      req.log.info({ count: codeProximityRows.length }, "Inserted code-proximity (raw_text) sign rows");
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

// ── Pre-rendered page image (PNG) serving ─────────────────────────────────
// Returns the pre-rendered PNG for a floor plan page.  Returns 404 when no
// pre-rendered image exists (viewer falls back to react-pdf for those pages).
router.get("/jobs/:jobId/files/:fileId/pages/:pageNum/image", async (req, res) => {
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

    const storedPath = file.pageStats?.pageImagePaths?.[String(pageNumInt)];
    if (!storedPath) {
      res.status(404).json({ error: "No pre-rendered image for this page" });
      return;
    }

    // Resolve relative path (stored as pages/<fileId>/page-N.png) to absolute.
    // Older records may still have absolute paths — path.isAbsolute handles both.
    const pagesParent = path.dirname(PAGES_DIR);
    const imagePath = path.isAbsolute(storedPath)
      ? storedPath
      : path.join(pagesParent, storedPath);

    // Prevent directory traversal — constrain to PAGES_DIR (not just its parent).
    const resolvedPath = path.resolve(imagePath);
    if (!resolvedPath.startsWith(path.resolve(PAGES_DIR) + path.sep)) {
      res.status(403).json({ error: "Access denied" });
      return;
    }

    try {
      await fs.access(resolvedPath);
    } catch {
      res.status(404).json({ error: "Image file not found on disk" });
      return;
    }

    const stat = await fs.stat(resolvedPath);
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Content-Length", stat.size);
    res.setHeader("Cache-Control", "private, max-age=86400");

    const stream = fsSync.createReadStream(resolvedPath);
    stream.pipe(res);
  } catch (err) {
    req.log.error({ err, fileId, pageNum }, "Failed to serve page image");
    res.status(500).json({ error: "Failed to serve page image" });
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

    // Derive pageType from stored pageStats
    const ps = file.pageStats;
    let pageType: "floor_plan" | "sign_schedule" | "both" | "other" = "other";
    if (ps) {
      const pageNumStr = String(pageNumInt);
      if (ps.pageTypes?.[pageNumStr]) {
        pageType = ps.pageTypes[pageNumStr];
      } else if ((ps.bothPages ?? []).includes(pageNumInt)) {
        pageType = "both";
      } else if (ps.floorPlanPages.includes(pageNumInt)) {
        pageType = "floor_plan";
      } else if (ps.signSchedulePages.includes(pageNumInt)) {
        pageType = "sign_schedule";
      }
    }

    res.setHeader("Cache-Control", "private, max-age=300");
    res.json({ ...result, pageType });
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
  quantity: z.number().int().min(1).default(1),
  adaRequired: z.boolean().optional(),
  messageContent: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  placementSource: z.string().nullable().optional(),
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
        dataSource: "manual",
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
  manuallyEdited: z.boolean().optional(),
  xPos: z.number().min(0).max(1).nullable().optional(),
  yPos: z.number().min(0).max(1).nullable().optional(),
  placementSource: z.enum(["word_match", "text_match", "gemini_vision", "user_confirmed", "manual", "user_drag"]).nullable().optional(),
  pageNumber: z.number().int().positive().nullable().optional(),
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
    const explicitManuallyEdited = parsed.data.manuallyEdited !== undefined;
    const updatePayload = hasContentEdit
      ? { ...parsed.data, userVerified: true, ...(explicitManuallyEdited ? {} : { manuallyEdited: true }) }
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
    xPos: z.number().min(0).max(1).nullable().optional(),
    yPos: z.number().min(0).max(1).nullable().optional(),
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

    const allSigns = parsed.data.signs;

    // Signs that already have coordinates skip the Gemini call entirely.
    const signsWithCoords = allSigns.filter(
      (s) => s.xPos != null && s.yPos != null,
    );
    const signsNeedingLocate = allSigns.filter(
      (s) => s.xPos == null || s.yPos == null,
    );

    // Return pre-existing coordinates as a single high-confidence candidate.
    const preLocatedResults = signsWithCoords.map((s) => ({
      signId: s.signId,
      candidates: [{ x: s.xPos!, y: s.yPos!, description: "existing coordinates", confidence: 1 }],
    }));

    let geminiResults: Awaited<ReturnType<typeof visualLocateDoors>> = [];
    if (signsNeedingLocate.length > 0) {
      geminiResults = await visualLocateDoors(
        file.storedPath,
        parsed.data.pageNumber,
        signsNeedingLocate,
        ai,
      );
    }

    const results = [...preLocatedResults, ...geminiResults];

    req.log.info({ jobId, pageNumber: parsed.data.pageNumber, signCount: allSigns.length, skipped: signsWithCoords.length, located: signsNeedingLocate.length }, "visual-locate complete");
    res.json({ results });
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

    const [signs, plaques, occupantLoads] = await Promise.all([
      db
        .select()
        .from(extractedSignsTable)
        .where(
          and(
            eq(extractedSignsTable.jobId, jobId),
            not(extractedSignsTable.hidden)
          )
        ),
      db
        .select()
        .from(plaqueSchedulesTable)
        .where(eq(plaqueSchedulesTable.jobId, jobId)),
      db
        .select()
        .from(occupantLoadsTable)
        .where(eq(occupantLoadsTable.jobId, jobId)),
    ]);

    if (signs.length === 0 && plaques.length === 0 && occupantLoads.length === 0) {
      res.status(404).json({ error: "No data found for this job" });
      return;
    }

    const exportPath = getJobExportPath(jobId);
    await buildExcelExport(signs, jobId, exportPath, plaques, occupantLoads);

    const fileName = `sign-takeoff-${jobId.slice(0, 8)}.xlsx`;
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.setHeader("X-Sign-Count", String(signs.length));

    const fileBuffer = await fs.readFile(exportPath);
    res.send(fileBuffer);

    recordActivity(req, "xlsx_exported", jobId);
    req.log.info({ jobId, signCount: signs.length, fileName }, "Export served");
  } catch (err) {
    req.log.error({ err, jobId }, "Export failed");
    res.status(500).json({ error: "Export failed", details: String(err) });
  }
});

// ── AI Calls Registry ──────────────────────────────────────────────────────────
router.get("/jobs/:jobId/ai-calls", async (req, res) => {
  const jobId = req.params.jobId;
  if (!jobId) { res.status(400).json({ error: "Job ID required" }); return; }
  try {
    const job = await getJobWithOrgCheck(req, res, jobId);
    if (!job) return;
    res.json({ callTypes: AI_CALL_REGISTRY, completedCallTypes: job.completedCallTypes ?? [] });
  } catch (err) {
    req.log.error({ err, jobId }, "ai-calls registry error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── AI Scan Endpoint ─────────────────────────────────────────────────────────
const aiScanSchema = z.object({
  callTypes: z.array(z.enum(["sign_schedule_enrich", "project_info", "floor_plan_text", "vision_fallback", "bbox_detection", "title_block_vision", "plaque_schedule", "occupant_loads"])),
});

router.post("/jobs/:jobId/ai-scan", async (req, res) => {
  const jobId = req.params.jobId;
  if (!jobId) { res.status(400).json({ error: "Job ID required" }); return; }

  const parsed = aiScanSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body", details: parsed.error.message });
    return;
  }
  const { callTypes } = parsed.data;

  try {
    const job = await getJobWithOrgCheck(req, res, jobId);
    if (!job) return;
    if (job.status === "processing") {
      res.status(409).json({ error: "Job is currently being processed — try again shortly" });
      return;
    }

    const files = await db.select().from(jobFilesTable).where(eq(jobFilesTable.jobId, jobId));
    if (files.length === 0) {
      res.status(404).json({ error: "No files found for this job" });
      return;
    }

    const results: Record<string, unknown> = {};
    let totalNewSigns = 0;
    let totalUpdatedSigns = 0;

    // Load existing signs for deduplication
    const existingSigns = await db.select().from(extractedSignsTable).where(eq(extractedSignsTable.jobId, jobId));
    const existingSignKeys = new Set(existingSigns.map((s) => `${s.jobFileId ?? ""}||${s.pageNumber ?? ""}||${(s.location ?? "").toLowerCase().trim()}||${(s.signType ?? "").toLowerCase().trim()}`));

    // Build project context from job record
    const projectContext = (job.projectAddress || job.projectCity || job.projectState) ? {
      address: job.projectAddress ?? undefined,
      city: job.projectCity ?? undefined,
      state: job.projectState ?? undefined,
    } : undefined;

    // Process each file
    for (const file of files) {
      const pageStats = file.pageStats as {
        floorPlanPages?: number[];
        signSchedulePages?: number[];
        bothPages?: number[];
        pageImagePaths?: Record<string, string> | null;
        floorPageLevels?: Record<string, string>;
      } | null;

      // Build spatial page type maps from stored pageStats
      function buildSpatialMap(filter: "sign_schedule" | "floor_plan"): Map<number, SpatialPageType> {
        const m = new Map<number, SpatialPageType>();
        if (!pageStats) return m;
        const ssPages = new Set([...(pageStats.signSchedulePages ?? []), ...(pageStats.bothPages ?? [])]);
        const fpPages = new Set([...(pageStats.floorPlanPages ?? []), ...(pageStats.bothPages ?? [])]);
        if (filter === "sign_schedule") {
          for (const p of ssPages) m.set(p, "sign_schedule");
        } else {
          for (const p of fpPages) m.set(p, "floor_plan");
        }
        return m;
      }

      let pageImagePaths = (pageStats?.pageImagePaths ?? {}) as Record<string, string>;

      for (const callType of callTypes as AiCallType[]) {
        try {
          if (callType === "project_info") {
            const { info, inputTokens, outputTokens } = await runProjectInfoExtraction(file);
            // Update job record with extracted project location info (only if not already set)
            const jobUpdate: Partial<typeof jobsTable.$inferInsert> = {};
            if (info.address && !job.projectAddress) jobUpdate.projectAddress = info.address;
            if (info.city && !job.projectCity) jobUpdate.projectCity = info.city;
            if (info.state && !job.projectState) jobUpdate.projectState = info.state;
            if (Object.keys(jobUpdate).length > 0) {
              jobUpdate.updatedAt = new Date();
              await db.update(jobsTable).set(jobUpdate).where(eq(jobsTable.id, jobId));
            }
            results[`${callType}_${file.id}`] = { info, inputTokens, outputTokens, updatedFields: Object.keys(jobUpdate) };

          } else if (callType === "floor_plan_text") {
            const spatialMap = buildSpatialMap("floor_plan");
            const { rows, inputTokens, outputTokens } = await runFloorPlanTextExtraction(file, projectContext, spatialMap.size > 0 ? spatialMap : undefined);
            const { newCount, updateCount } = await mergeAiSignRows(rows, jobId, file.id, existingSignKeys, existingSigns, files);
            totalNewSigns += newCount;
            totalUpdatedSigns += updateCount;
            results[`${callType}_${file.id}`] = { rowsExtracted: rows.length, newSigns: newCount, updatedSigns: updateCount, inputTokens, outputTokens };

          } else if (callType === "bbox_detection") {
            const { scanResult, pageImagePaths: updatedPaths } = await runBboxDetection(file, pageImagePaths);
            if (!scanResult.skipped && scanResult.callouts.length > 0) {
              const bboxCount = await applyBboxCallouts(scanResult.callouts, jobId, file.id, existingSigns);
              totalUpdatedSigns += bboxCount;
            }
            // Update file pageStats with any newly rendered image paths, and sync in-memory
            if (updatedPaths && Object.keys(updatedPaths).length > 0) {
              pageImagePaths = { ...pageImagePaths, ...updatedPaths }; // in-memory update for same-run calls
              const updatedStats = { ...(pageStats ?? {}), pageImagePaths };
              await db.update(jobFilesTable).set({ pageStats: updatedStats }).where(eq(jobFilesTable.id, file.id));
            }
            results[`${callType}_${file.id}`] = { callouts: scanResult.callouts?.length ?? 0, skipped: scanResult.skipped, skipReason: scanResult.skipReason, inputTokens: scanResult.inputTokens, outputTokens: scanResult.outputTokens };

          } else if (callType === "vision_fallback") {
            const { scanResult } = await runVisionFallback(file, pageImagePaths);
            if (!scanResult.skipped && scanResult.callouts.length > 0) {
              const bboxCount = await applyBboxCallouts(scanResult.callouts, jobId, file.id, existingSigns);
              totalUpdatedSigns += bboxCount;
            }
            results[`${callType}_${file.id}`] = { callouts: scanResult.callouts?.length ?? 0, skipped: scanResult.skipped, inputTokens: scanResult.inputTokens, outputTokens: scanResult.outputTokens };

          } else if (callType === "title_block_vision") {
            const { levelMap } = await runTitleBlockVision(file, pageImagePaths);
            if (levelMap.size > 0) {
              const floorPageLevels: Record<string, string> = {};
              for (const [pageNum, level] of levelMap) {
                floorPageLevels[String(pageNum)] = level;
              }
              const updatedStats = { ...(pageStats ?? {}), floorPageLevels };
              await db.update(jobFilesTable).set({ pageStats: updatedStats }).where(eq(jobFilesTable.id, file.id));
            }
            results[`${callType}_${file.id}`] = { levelsFound: levelMap.size, levels: Object.fromEntries(levelMap) };
          } else if (callType === "sign_schedule_enrich") {
            // Job-level operation — only run once (skip subsequent files in this job)
            if (file === files[0]) {
              const enrichResult = await runSignScheduleEnrich(jobId);
              results[`${callType}_job`] = {
                enrichedCount: enrichResult.enrichedCount,
                skippedCount: enrichResult.skippedCount,
                specs: enrichResult.specResults,
              };
            }
          } else if (callType === "plaque_schedule") {
            // Job-level operation: only run on the first file that has sign schedule pages.
            // Persistence (delete+insert) is deferred to after the file loop via a flag.
            if (!(results as Record<string, unknown>)["plaque_schedule_done"]) {
              const filePageStats = file.pageStats as {
                signSchedulePages?: number[];
                bothPages?: number[];
                otherPages?: number[];
              } | null;
              const plaqueResult = await runPlaqueScheduleExtraction(jobId, {
                id: file.id,
                storedPath: file.storedPath,
                pageStats: filePageStats,
              });
              results[`${callType}_${file.id}`] = {
                plaqueCount: plaqueResult.plaques.length,
                sourcePage: plaqueResult.sourcePage,
                skipped: plaqueResult.skipped ?? false,
                skipReason: plaqueResult.skipReason ?? null,
                inputTokens: plaqueResult.inputTokens,
                outputTokens: plaqueResult.outputTokens,
              };
              if (plaqueResult.plaques.length > 0) {
                await persistPlaqueSchedule(jobId, plaqueResult.plaques, plaqueResult.generalNotes, plaqueResult.sourcePage);
                (results as Record<string, unknown>)["plaque_schedule_done"] = true;
              }
            }
          } else if (callType === "occupant_loads") {
            // Accumulated across all files; persistence happens after the file loop.
            const filePageStats = file.pageStats as { otherPages?: number[] } | null;
            const occupantResult = await runOccupantLoadsExtraction(jobId, {
              id: file.id,
              storedPath: file.storedPath,
              pageStats: filePageStats,
            });
            const priorRooms = ((results as Record<string, unknown>)["_occupant_rooms_all"] as typeof occupantResult.rooms | undefined) ?? [];
            (results as Record<string, unknown>)["_occupant_rooms_all"] = [...priorRooms, ...occupantResult.rooms];
            const priorPage = ((results as Record<string, unknown>)["_occupant_first_page"] as number | null | undefined) ?? null;
            if (priorPage === null && occupantResult.sourcePages.length > 0) {
              (results as Record<string, unknown>)["_occupant_first_page"] = occupantResult.sourcePages[0];
            }
            results[`${callType}_${file.id}`] = {
              roomCount: occupantResult.rooms.length,
              sourcePages: occupantResult.sourcePages,
              skipped: occupantResult.skipped ?? false,
              skipReason: occupantResult.skipReason ?? null,
              inputTokens: occupantResult.inputTokens,
              outputTokens: occupantResult.outputTokens,
            };
          }
        } catch (callErr) {
          req.log.error({ callErr, callType, fileId: file.id }, "AI scan call failed");
          results[`${callType}_${file.id}_error`] = String(callErr);
        }
      }
    }

    // If occupant_loads was one of the call types, persist all collected rooms now
    // (rooms were accumulated across all files in results["_occupant_rooms_all"]).
    if (callTypes.includes("occupant_loads")) {
      const allRooms = ((results as Record<string, unknown>)["_occupant_rooms_all"] as import("../lib/ai-processor").OccupantLoadRoom[] | undefined) ?? [];
      const firstPage = ((results as Record<string, unknown>)["_occupant_first_page"] as number | null | undefined) ?? null;
      await persistOccupantLoads(jobId, allRooms, firstPage);
      delete (results as Record<string, unknown>)["_occupant_rooms_all"];
      delete (results as Record<string, unknown>)["_occupant_first_page"];
    }
    if (callTypes.includes("plaque_schedule")) {
      delete (results as Record<string, unknown>)["plaque_schedule_done"];
    }

    // After AI sign insertion, run coordinate matching for any signs missing coordinates
    await assignMissingCoordinates(jobId, files);

    // Persist which call types have now been completed so the frontend can warn
    // before overwriting on subsequent re-runs. Only mark a call type completed
    // if it produced at least one successful result key (i.e. a results entry
    // without an "_error" suffix), so failed-only calls don't trigger prompts.
    const resultKeys = Object.keys(results);
    const successfullyCompleted = callTypes.filter((ct) =>
      resultKeys.some((k) => k.startsWith(`${ct}_`) && !k.endsWith("_error"))
    );
    if (successfullyCompleted.length > 0) {
      const existingCompleted = job.completedCallTypes ?? [];
      const merged = Array.from(new Set([...existingCompleted, ...successfullyCompleted]));
      await db.update(jobsTable).set({ completedCallTypes: merged, updatedAt: new Date() }).where(eq(jobsTable.id, jobId));
    }

    res.json({
      success: true,
      jobId,
      callTypes,
      successfulCallTypes: successfullyCompleted,
      newSignsCreated: totalNewSigns,
      signsUpdated: totalUpdatedSigns,
      details: results,
    });

    recordActivity(req, "ai_scan_run", jobId);
  } catch (err) {
    req.log.error({ err, jobId }, "ai-scan failed");
    res.status(500).json({ error: "AI scan failed", details: String(err) });
  }
});

// ── AI Scan Helpers ───────────────────────────────────────────────────────────

type DbSign = typeof extractedSignsTable.$inferSelect;
type DbFile = typeof jobFilesTable.$inferSelect;

async function mergeAiSignRows(
  rows: import("../lib/extraction").ExtractedSignRow[],
  jobId: string,
  fileId: string,
  existingSignKeys: Set<string>,
  existingSigns: DbSign[],
  _files: DbFile[],
): Promise<{ newCount: number; updateCount: number }> {
  let newCount = 0;
  let updateCount = 0;

  for (const row of rows) {
    const key = `${fileId}||${row.page_number ?? ""}||${(row.location ?? "").toLowerCase().trim()}||${(row.sign_type ?? "").toLowerCase().trim()}`;

    if (existingSignKeys.has(key)) {
      // Key exists — perform additive update on non-protected rows only
      const existingSign = existingSigns.find((s) =>
        `${s.jobFileId ?? ""}||${s.pageNumber ?? ""}||${(s.location ?? "").toLowerCase().trim()}||${(s.signType ?? "").toLowerCase().trim()}` === key
      );
      // Never touch userVerified or manuallyAdded rows
      if (existingSign && !existingSign.userVerified && !existingSign.manuallyAdded) {
        // Build partial update: only fill in fields that are currently null/missing, and mark AI provenance
        const update: Partial<typeof extractedSignsTable.$inferInsert> = {
          dataSource: "ai", // AI has now contributed to this row
        };
        if (!existingSign.dimensions && row.dimensions) update.dimensions = row.dimensions;
        if (!existingSign.mountingType && row.mounting_type) update.mountingType = row.mounting_type;
        if (!existingSign.finishColor && row.finish_color) update.finishColor = row.finish_color;
        if (!existingSign.illumination && row.illumination) update.illumination = row.illumination;
        if (!existingSign.materials && row.materials) update.materials = row.materials;
        if (!existingSign.messageContent && row.message_content) update.messageContent = row.message_content;
        if (!existingSign.notes && row.notes) update.notes = row.notes;
        if (!existingSign.signIdentifier && row.sign_identifier) update.signIdentifier = row.sign_identifier;
        try {
          await db.update(extractedSignsTable).set(update).where(eq(extractedSignsTable.id, existingSign.id));
          updateCount++;
        } catch {
          // non-fatal
        }
      }
      continue;
    }

    // New AI-sourced sign — map snake_case ExtractedSignRow → camelCase Drizzle insert schema
    const insertRow = {
      jobId,
      jobFileId: fileId,
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
      extractionMethod: "text" as const,
      dataSource: "ai" as const,
      userVerified: false,
      manuallyAdded: false,
    };

    try {
      await db.insert(extractedSignsTable).values(insertRow);
      existingSignKeys.add(key);
      newCount++;
    } catch {
      // non-fatal: skip duplicate
    }
  }
  return { newCount, updateCount };
}

async function applyBboxCallouts(
  callouts: import("../lib/extraction").GeminiCallout[],
  jobId: string,
  fileId: string,
  _existingSigns: DbSign[], // kept for signature compat; fresh signs are loaded from DB
): Promise<number> {
  // Always reload from DB to include signs inserted earlier in the same scan run
  const freshSigns = await db
    .select()
    .from(extractedSignsTable)
    .where(and(eq(extractedSignsTable.jobId, jobId), eq(extractedSignsTable.jobFileId, fileId)));

  let updatedCount = 0;
  for (const callout of callouts) {
    if (!callout.label_text && !callout.sign_type) continue;
    // Try to find a matching sign by label or sign type + page
    const match = freshSigns.find((s) =>
      (callout.label_text && s.signIdentifier === callout.label_text) ||
      (callout.sign_type && s.signType?.toLowerCase() === callout.sign_type?.toLowerCase() &&
        callout.page_number === s.pageNumber)
    );
    // Never overwrite userVerified or manuallyAdded rows
    if (match && !match.userVerified && !match.manuallyAdded) {
      await db.update(extractedSignsTable)
        .set({
          aiBboxX: callout.bbox_x ?? null,
          aiBboxY: callout.bbox_y ?? null,
          aiBboxW: callout.bbox_w ?? null,
          aiBboxH: callout.bbox_h ?? null,
          aiBbox: true, // mark row-level AI bbox provenance flag
        })
        .where(eq(extractedSignsTable.id, match.id));
      updatedCount++;
    }
  }
  return updatedCount;
}

async function assignMissingCoordinates(jobId: string, files: DbFile[]): Promise<void> {
  const signsWithoutCoords = await db
    .select()
    .from(extractedSignsTable)
    .where(and(
      eq(extractedSignsTable.jobId, jobId),
      isNull(extractedSignsTable.xPos),
    ));

  if (signsWithoutCoords.length === 0) return;

  const filePathById = new Map<string, string>(files.map((f) => [f.id, f.storedPath]));

  type PageCache = { phrases: import("../lib/pdf-words").PdfPhrase[] };
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

  for (const sign of signsWithoutCoords) {
    if (!sign.jobFileId || !sign.pageNumber || !sign.location) continue;
    const storedPath = filePathById.get(sign.jobFileId);
    if (!storedPath) continue;
    try {
      const pageData = await getPageData(storedPath, sign.jobFileId, sign.pageNumber);
      const excl = new Set<string>();
      const match = matchLocationToCoords(pageData.phrases, sign.location, sign.signIdentifier, excl);
      if (match) {
        await db.update(extractedSignsTable)
          .set({ xPos: match.xPos, yPos: match.yPos, placementSource: "word_match" })
          .where(eq(extractedSignsTable.id, sign.id));
      }
    } catch {
      // non-fatal
    }
  }
}

// ── GET /jobs/:jobId/schedule-entries ─────────────────────────────────────────
// Returns schedule entries with joined sign type spec data for the given job.
router.get("/jobs/:jobId/schedule-entries", async (req: Request, res: Response) => {
  const { jobId } = req.params;

  try {
    const job = await getJobWithOrgCheck(req, res, jobId);
    if (!job) return;

    const entries = await db
      .select({
        id: signageScheduleEntriesTable.id,
        jobId: signageScheduleEntriesTable.jobId,
        signTypeSpecId: signageScheduleEntriesTable.signTypeSpecId,
        pairedSignId: signageScheduleEntriesTable.pairedSignId,
        sourceTableName: signageScheduleEntriesTable.sourceTableName,
        pageNumber: signageScheduleEntriesTable.pageNumber,
        roomNumber: signageScheduleEntriesTable.roomNumber,
        roomName: signageScheduleEntriesTable.roomName,
        signTypeCode: signageScheduleEntriesTable.signTypeCode,
        quantity: signageScheduleEntriesTable.quantity,
        signageText: signageScheduleEntriesTable.signageText,
        glassBacker: signageScheduleEntriesTable.glassBacker,
        rawComments: signageScheduleEntriesTable.rawComments,
        expandedComments: signageScheduleEntriesTable.expandedComments,
        dimensions: signageScheduleEntriesTable.dimensions,
        material: signageScheduleEntriesTable.material,
        features: signageScheduleEntriesTable.features,
        specDimensions: signTypeSpecsTable.dimensions,
        specMaterial: signTypeSpecsTable.material,
        specFeatures: signTypeSpecsTable.features,
        specKeynoteMap: signTypeSpecsTable.keynoteMap,
        specHasDrawing: signTypeSpecsTable.hasDrawing,
        specCropImageUrl: signTypeSpecsTable.cropImageUrl,
        specGeminiEnriched: signTypeSpecsTable.geminiEnriched,
        specGeminiNotes: signTypeSpecsTable.geminiNotes,
      })
      .from(signageScheduleEntriesTable)
      .leftJoin(signTypeSpecsTable, eq(signageScheduleEntriesTable.signTypeSpecId, signTypeSpecsTable.id))
      .where(eq(signageScheduleEntriesTable.jobId, jobId))
      .orderBy(signageScheduleEntriesTable.pageNumber, signageScheduleEntriesTable.roomNumber);

    const specs = await db
      .select()
      .from(signTypeSpecsTable)
      .where(eq(signTypeSpecsTable.jobId, jobId))
      .orderBy(signTypeSpecsTable.typeCode);

    res.json({ entries, specs });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch schedule entries" });
  }
});

// ── GET /jobs/:jobId/schedule-crops/:fileId/:fileName ─────────────────────────
// Serves pre-rendered crop PNG images for sign type diagrams.
router.get("/jobs/:jobId/schedule-crops/:fileId/:fileName", async (req: Request, res: Response) => {
  const { jobId, fileId, fileName } = req.params;
  const job = await getJobWithOrgCheck(req, res, jobId);
  if (!job) return;

  // Verify fileId belongs to this job (prevents IDOR across jobs)
  const [fileRow] = await db
    .select({ id: jobFilesTable.id })
    .from(jobFilesTable)
    .where(and(eq(jobFilesTable.id, fileId), eq(jobFilesTable.jobId, jobId)))
    .limit(1);
  if (!fileRow) { res.status(404).json({ error: "File not found for this job" }); return; }

  const safeName = path.basename(fileName);
  const filePath = path.join(PAGES_DIR, fileId, "crops", safeName);

  try {
    const { createReadStream } = await import("fs");
    const stream = createReadStream(filePath);
    stream.on("error", () => res.status(404).json({ error: "Crop image not found" }));
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=86400");
    stream.pipe(res);
  } catch {
    res.status(404).json({ error: "Crop image not found" });
  }
});

// ── PATCH /jobs/:jobId/files/:fileId/rejected-pages ───────────────────────────
// Toggles a page number in the file's rejectedPageNumbers list (stored in pageStats).
const ToggleRejectedPageSchema = z.object({
  pageNo: z.number().int().positive(),
});

router.patch("/jobs/:jobId/files/:fileId/rejected-pages", async (req: Request, res: Response) => {
  const { jobId, fileId } = req.params;
  if (!jobId || !fileId) {
    res.status(400).json({ error: "Job ID and file ID required" });
    return;
  }

  const parsed = ToggleRejectedPageSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
    return;
  }

  try {
    const _job = await getJobWithOrgCheck(req, res, jobId);
    if (!_job) return;

    const [file] = await db
      .select()
      .from(jobFilesTable)
      .where(and(eq(jobFilesTable.id, fileId), eq(jobFilesTable.jobId, jobId)))
      .limit(1);

    if (!file) {
      res.status(404).json({ error: "File not found" });
      return;
    }

    const currentStats = file.pageStats ?? {
      floorPlanPages: [],
      signSchedulePages: [],
      otherPages: [],
    };

    const { pageNo } = parsed.data;
    const existing = currentStats.rejectedPageNumbers ?? [];
    const isCurrentlyRejected = existing.includes(pageNo);

    // Rejection is one-way: add to rejected list; un-reject just removes from the list
    // (signs are permanently deleted and must be restored by reprocessing).
    const updatedRejectedPageNumbers = isCurrentlyRejected
      ? existing.filter((p) => p !== pageNo)
      : [...existing, pageNo];

    const updatedStats = { ...currentStats, rejectedPageNumbers: updatedRejectedPageNumbers };

    // When newly rejecting: permanently delete all extracted signs for this page.
    if (!isCurrentlyRejected) {
      await db
        .delete(extractedSignsTable)
        .where(
          and(
            eq(extractedSignsTable.jobId, jobId),
            eq(extractedSignsTable.jobFileId, fileId),
            eq(extractedSignsTable.pageNumber, pageNo),
          ),
        );
    }

    await db
      .update(jobFilesTable)
      .set({ pageStats: updatedStats })
      .where(eq(jobFilesTable.id, fileId));

    res.json({ pageStats: updatedStats, rejected: !isCurrentlyRejected });
  } catch (err) {
    req.log.error({ err, jobId, fileId }, "Failed to toggle rejected page");
    res.status(500).json({ error: "Failed to toggle rejected page" });
  }
});

// ── Compliance scan (R1–R15 rules engine) ─────────────────────────────────────

// GET last persisted scan results for a job
router.get("/jobs/:jobId/compliance-scan", async (req, res) => {
  const { jobId } = req.params;
  if (!jobId) {
    res.status(400).json({ error: "Job ID required" });
    return;
  }
  try {
    const job = await getJobWithOrgCheck(req, res, jobId);
    if (!job) return;

    const rows = await db
      .select()
      .from(complianceEntriesTable)
      .where(eq(complianceEntriesTable.jobId, jobId))
      .orderBy(complianceEntriesTable.ruleRef);

    if (rows.length === 0) {
      res.json({ entries: null, summary: null, generatedAt: null });
      return;
    }

    const entries = rows.map((r) => ({
      signType: r.signType,
      qty: r.qty,
      ruleRef: r.ruleRef,
      color: r.color,
      plaqueTypeId: r.plaqueTypeId ?? undefined,
      roomNumber: r.roomNumber,
      roomName: r.roomName,
      level: r.level,
      pageNumber: r.pageNumber,
      coords: r.coordsJson ?? undefined,
    }));

    const byRule: Record<string, number> = {};
    const byLevel: Record<string, number> = {};
    for (const e of entries) {
      byRule[e.ruleRef] = (byRule[e.ruleRef] ?? 0) + e.qty;
      byLevel[e.level] = (byLevel[e.level] ?? 0) + e.qty;
    }
    const totalSigns = entries.reduce((sum, e) => sum + e.qty, 0);
    const generatedAt = rows[0].createdAt.toISOString();

    res.json({
      entries,
      summary: { totalSigns, byRule, byLevel },
      generatedAt,
    });
  } catch (err) {
    req.log.error({ err, jobId }, "Failed to load compliance scan results");
    res.status(500).json({ error: "Failed to load compliance scan results" });
  }
});

router.post("/jobs/:jobId/compliance-scan", async (req, res) => {
  const { jobId } = req.params;
  if (!jobId) {
    res.status(400).json({ error: "Job ID required" });
    return;
  }

  try {
    const job = await getJobWithOrgCheck(req, res, jobId);
    if (!job) return;

    // 1. Load extracted signs for this job (all rows — not filtered by hidden)
    const rows = await db
      .select({
        location: extractedSignsTable.location,
        signType: extractedSignsTable.signType,
        signIdentifier: extractedSignsTable.signIdentifier,
        pageNumber: extractedSignsTable.pageNumber,
        xPos: extractedSignsTable.xPos,
        yPos: extractedSignsTable.yPos,
        sheetNumber: extractedSignsTable.sheetNumber,
        messageContent: extractedSignsTable.messageContent,
        notes: extractedSignsTable.notes,
        quantity: extractedSignsTable.quantity,
      })
      .from(extractedSignsTable)
      .where(eq(extractedSignsTable.jobId, jobId));

    if (rows.length === 0) {
      res.status(422).json({
        error: "No extracted signs found for this job. Run a scan first.",
      });
      return;
    }

    // 2. Convert rows → RoomInventory[]
    const inventory = buildRoomInventory(rows);

    // 3. Separate special room types
    const stairs = inventory.filter((r) => r.isStairwell);
    const elevators = inventory.filter((r) => r.isElevator);
    const regularRooms = inventory.filter(
      (r) => !r.isStairwell && !r.isElevator
    );
    const uniqueLevels = [...new Set(inventory.map((r) => r.level))].sort();

    // buildRoomInventory groups by (location, level), so `stairs` contains one
    // entry per stairwell per floor. applyStairRules expects unique stairwell
    // identities × levels (cross-product). Deduplicate to unique room numbers
    // before calling it; applyEvacMapRules receives the full per-level list so
    // its own level-dedup logic works correctly.
    const uniqueStairsByNumber = new Map<string, (typeof stairs)[number]>();
    for (const stair of stairs) {
      if (!uniqueStairsByNumber.has(stair.roomNumber)) {
        uniqueStairsByNumber.set(stair.roomNumber, stair);
      }
    }
    const uniqueStairs = [...uniqueStairsByNumber.values()];

    // 4. Apply rules
    const allEntries = [
      ...regularRooms.flatMap((room) => applyRules(room)),
      ...applyStairRules(uniqueStairs, uniqueLevels),
      ...applyElevatorRules(elevators),
      ...applyEvacMapRules(stairs),
    ];

    // 5. Build coverage index from extracted signs
    // roomNumber in compliance entries == extracted_signs.location.toUpperCase()
    // signType matching is case-insensitive
    const coverageKeys = new Set<string>();
    for (const row of rows) {
      if (row.location && row.signType) {
        coverageKeys.add(
          `${row.location.toUpperCase().trim()}||${row.signType.toLowerCase().trim()}`
        );
      }
    }

    function isCovered(roomNumber: string, signType: string): boolean {
      return coverageKeys.has(
        `${roomNumber.toUpperCase().trim()}||${signType.toLowerCase().trim()}`
      );
    }

    // 6. Build summary
    const byRule: Record<string, number> = {};
    const byLevel: Record<string, number> = {};
    for (const e of allEntries) {
      byRule[e.ruleRef] = (byRule[e.ruleRef] ?? 0) + e.qty;
      byLevel[e.level] = (byLevel[e.level] ?? 0) + e.qty;
    }
    const totalSigns = allEntries.reduce((sum, e) => sum + e.qty, 0);
    const coveredCount = allEntries.reduce((sum, e) => isCovered(e.roomNumber, e.signType) ? sum + e.qty : sum, 0);
    const missingCount = totalSigns - coveredCount;

    // 7. Persist to compliance_entries (replace previous scan for this job)
    await db
      .delete(complianceEntriesTable)
      .where(eq(complianceEntriesTable.jobId, jobId));

    if (allEntries.length > 0) {
      await db.insert(complianceEntriesTable).values(
        allEntries.map((e) => ({
          jobId,
          ruleRef: e.ruleRef,
          signType: e.signType,
          qty: e.qty,
          roomNumber: e.roomNumber,
          roomName: e.roomName,
          level: e.level,
          pageNumber: e.pageNumber,
          coordsJson: e.coords ?? null,
          color: e.color,
          plaqueTypeId: e.plaqueTypeId ?? null,
        }))
      );
    }

    recordActivity(req, "scan_run", jobId);

    req.log.info(
      { jobId, totalSigns, ruleCount: Object.keys(byRule).length },
      "Compliance scan complete"
    );

    res.json({
      entries: allEntries.map((e) => ({
        ...e,
        covered: isCovered(e.roomNumber, e.signType),
      })),
      summary: { totalSigns, byRule, byLevel, coveredCount, missingCount },
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    req.log.error({ err, jobId }, "Compliance scan failed");
    res.status(500).json({ error: "Compliance scan failed", details: String(err) });
  }
});

// ── Extract Plaque Schedule ───────────────────────────────────────────────────

router.post("/jobs/:jobId/extract-plaque-schedule", async (req, res) => {
  const jobId = req.params.jobId;
  if (!jobId) { res.status(400).json({ error: "Job ID required" }); return; }

  const overwrite = req.body?.overwrite === true;

  try {
    const job = await getJobWithOrgCheck(req, res, jobId);
    if (!job) return;

    const files = await db.select().from(jobFilesTable).where(eq(jobFilesTable.jobId, jobId));
    if (files.length === 0) {
      res.status(404).json({ error: "No files found for this job" });
      return;
    }

    const results: Record<string, unknown> = {};
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let finalPlaques: import("../lib/ai-processor").PlaqueType[] = [];
    let finalGeneralNotes: Record<string, unknown> | null = null;
    let finalSourcePage: number | null = null;

    // Process files until we find plaque schedule data; stop at first success
    for (const file of files) {
      const pageStats = file.pageStats as {
        signSchedulePages?: number[];
        bothPages?: number[];
        otherPages?: number[];
      } | null;

      const result = await runPlaqueScheduleExtraction(jobId, {
        id: file.id,
        storedPath: file.storedPath,
        pageStats,
      });

      totalInputTokens += result.inputTokens;
      totalOutputTokens += result.outputTokens;
      results[file.id] = {
        plaqueCount: result.plaques.length,
        sourcePage: result.sourcePage,
        skipped: result.skipped ?? false,
        skipReason: result.skipReason ?? null,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      };

      // Stop at first file that yields plaques; persist once for the whole job
      if (result.plaques.length > 0) {
        finalPlaques = result.plaques;
        finalGeneralNotes = result.generalNotes;
        finalSourcePage = result.sourcePage;
        break;
      }
    }

    await persistPlaqueSchedule(jobId, finalPlaques, finalGeneralNotes, finalSourcePage, overwrite);

    recordActivity(req, "ai_scan_run", jobId);

    res.json({
      success: true,
      jobId,
      totalPlaques: finalPlaques.length,
      totalInputTokens,
      totalOutputTokens,
      details: results,
    });
  } catch (err) {
    req.log.error({ err, jobId }, "extract-plaque-schedule failed");
    res.status(500).json({ error: "Plaque schedule extraction failed", details: String(err) });
  }
});

// ── Extract Occupant Loads ────────────────────────────────────────────────────

router.post("/jobs/:jobId/extract-occupant-loads", async (req, res) => {
  const jobId = req.params.jobId;
  if (!jobId) { res.status(400).json({ error: "Job ID required" }); return; }

  const overwrite = req.body?.overwrite === true;

  try {
    const job = await getJobWithOrgCheck(req, res, jobId);
    if (!job) return;

    const files = await db.select().from(jobFilesTable).where(eq(jobFilesTable.jobId, jobId));
    if (files.length === 0) {
      res.status(404).json({ error: "No files found for this job" });
      return;
    }

    const results: Record<string, unknown> = {};
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    // Collect rooms from ALL files before persisting (fixes multi-file overwrite)
    const allCollectedRooms: import("../lib/ai-processor").OccupantLoadRoom[] = [];
    let firstSourcePage: number | null = null;

    for (const file of files) {
      const pageStats = file.pageStats as { otherPages?: number[] } | null;

      const result = await runOccupantLoadsExtraction(jobId, {
        id: file.id,
        storedPath: file.storedPath,
        pageStats,
      });

      totalInputTokens += result.inputTokens;
      totalOutputTokens += result.outputTokens;
      allCollectedRooms.push(...result.rooms);
      if (firstSourcePage === null && result.sourcePages.length > 0) {
        firstSourcePage = result.sourcePages[0];
      }
      results[file.id] = {
        roomCount: result.rooms.length,
        sourcePages: result.sourcePages,
        skipped: result.skipped ?? false,
        skipReason: result.skipReason ?? null,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      };
    }

    await persistOccupantLoads(jobId, allCollectedRooms, firstSourcePage, overwrite);

    // ── Wire occupant loads into RoomInventory (compliance-scan integration) ───
    // Fetch stored occupant loads and merge into a room inventory built from the
    // job's extracted signs.  This is the same pipeline the compliance-scan
    // endpoint (Task 2) uses to evaluate R9/R10 assembly rules.
    const storedLoads = await fetchOccupantLoadsForJob(jobId);
    const extractedSigns = await db
      .select({
        signIdentifier: extractedSignsTable.signIdentifier,
        location: extractedSignsTable.location,
        pageNumber: extractedSignsTable.pageNumber,
        xPos: extractedSignsTable.xPos,
        yPos: extractedSignsTable.yPos,
      })
      .from(extractedSignsTable)
      .where(eq(extractedSignsTable.jobId, jobId));

    const roomInventory = buildRoomInventoryFromExtractedSigns(extractedSigns);
    const enrichedInventory = mergeOccupantLoads(roomInventory, storedLoads);
    const assemblyRooms = enrichedInventory
      .filter((r) => r.flags.isAssembly)
      .map((r) => ({
        roomNumber: r.roomNumber,
        roomName: r.roomName,
        occupantLoad: r.occupantLoad,
        occupancyGroup: r.occupancyGroup,
        isAssembly: true,
      }));

    recordActivity(req, "ai_scan_run", jobId);

    res.json({
      success: true,
      jobId,
      totalRooms: allCollectedRooms.length,
      totalInputTokens,
      totalOutputTokens,
      assemblyRoomCount: assemblyRooms.length,
      assemblyRooms,
      details: results,
    });
  } catch (err) {
    req.log.error({ err, jobId }, "extract-occupant-loads failed");
    res.status(500).json({ error: "Occupant loads extraction failed", details: String(err) });
  }
});

// ── Occupant Loads Query ──────────────────────────────────────────────────────

router.get("/jobs/:jobId/occupant-loads", async (req, res) => {
  const jobId = req.params.jobId;
  if (!jobId) { res.status(400).json({ error: "Job ID required" }); return; }

  try {
    const job = await getJobWithOrgCheck(req, res, jobId);
    if (!job) return;

    const loads = await db
      .select()
      .from(occupantLoadsTable)
      .where(eq(occupantLoadsTable.jobId, jobId));

    const assemblyRooms = loads
      .filter((r) => typeof r.occupantLoad === "number" && r.occupantLoad >= 50)
      .map((r) => ({
        roomNumber: r.roomNum,
        roomName: r.roomName,
        occupantLoad: r.occupantLoad,
        occupancyGroup: r.occupancyGroup,
        isAssembly: true,
      }));

    res.json({ jobId, loads, assemblyRooms });
  } catch (err) {
    req.log.error({ err, jobId }, "occupant-loads fetch failed");
    res.status(500).json({ error: "Failed to fetch occupant loads" });
  }
});

// ── Occupant Load Create ──────────────────────────────────────────────────────

const OccupantLoadCreateSchema = z.object({
  roomNum: z.string().min(1),
  roomName: z.string().nullable().optional(),
  occupantLoad: z.number().nonnegative().nullable().optional(),
  occupancyGroup: z.string().nullable().optional(),
});

router.post("/jobs/:jobId/occupant-loads", async (req, res) => {
  const jobId = req.params.jobId;
  if (!jobId) { res.status(400).json({ error: "Job ID required" }); return; }

  const parsed = OccupantLoadCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
    return;
  }

  try {
    const job = await getJobWithOrgCheck(req, res, jobId);
    if (!job) return;

    const [created] = await db
      .insert(occupantLoadsTable)
      .values({
        jobId,
        roomNum: parsed.data.roomNum,
        roomName: parsed.data.roomName ?? null,
        occupantLoad: parsed.data.occupantLoad ?? null,
        occupancyGroup: parsed.data.occupancyGroup ?? null,
        manuallyEdited: true,
      })
      .returning();

    res.status(201).json({ load: created });
  } catch (err) {
    req.log.error({ err, jobId }, "occupant-load create failed");
    res.status(500).json({ error: "Failed to create occupant load" });
  }
});

// ── Occupant Load Update ──────────────────────────────────────────────────────

const OccupantLoadUpdateSchema = z.object({
  roomNum: z.string().min(1).optional(),
  roomName: z.string().nullable().optional(),
  occupantLoad: z.number().nonnegative().nullable().optional(),
  occupancyGroup: z.string().nullable().optional(),
  manuallyEdited: z.boolean().optional(),
});

router.put("/jobs/:jobId/occupant-loads/:id", async (req, res) => {
  const { jobId, id } = req.params;
  if (!jobId || !id) { res.status(400).json({ error: "Job ID and load ID required" }); return; }

  const parsed = OccupantLoadUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
    return;
  }

  try {
    const job = await getJobWithOrgCheck(req, res, jobId);
    if (!job) return;

    const updateData: Record<string, unknown> = {
      manuallyEdited: parsed.data.manuallyEdited !== undefined ? parsed.data.manuallyEdited : true,
    };
    if (parsed.data.roomNum !== undefined) updateData.roomNum = parsed.data.roomNum;
    if (parsed.data.roomName !== undefined) updateData.roomName = parsed.data.roomName;
    if (parsed.data.occupantLoad !== undefined) updateData.occupantLoad = parsed.data.occupantLoad;
    if (parsed.data.occupancyGroup !== undefined) updateData.occupancyGroup = parsed.data.occupancyGroup;

    const hasDataFields = parsed.data.roomNum !== undefined || parsed.data.roomName !== undefined ||
      parsed.data.occupantLoad !== undefined || parsed.data.occupancyGroup !== undefined ||
      parsed.data.manuallyEdited !== undefined;
    if (!hasDataFields) {
      res.status(400).json({ error: "No fields provided to update" });
      return;
    }

    const [updated] = await db
      .update(occupantLoadsTable)
      .set(updateData)
      .where(and(eq(occupantLoadsTable.id, id), eq(occupantLoadsTable.jobId, jobId)))
      .returning();

    if (!updated) {
      res.status(404).json({ error: "Occupant load not found" });
      return;
    }

    res.json({ load: updated });
  } catch (err) {
    req.log.error({ err, jobId, id }, "occupant-load update failed");
    res.status(500).json({ error: "Failed to update occupant load" });
  }
});

// ── Occupant Load Delete ──────────────────────────────────────────────────────

router.delete("/jobs/:jobId/occupant-loads/:id", async (req, res) => {
  const { jobId, id } = req.params;
  if (!jobId || !id) { res.status(400).json({ error: "Job ID and load ID required" }); return; }

  try {
    const job = await getJobWithOrgCheck(req, res, jobId);
    if (!job) return;

    const [deleted] = await db
      .delete(occupantLoadsTable)
      .where(and(eq(occupantLoadsTable.id, id), eq(occupantLoadsTable.jobId, jobId)))
      .returning();

    if (!deleted) {
      res.status(404).json({ error: "Occupant load not found" });
      return;
    }

    res.json({ success: true });
  } catch (err) {
    req.log.error({ err, jobId, id }, "occupant-load delete failed");
    res.status(500).json({ error: "Failed to delete occupant load" });
  }
});

// ── Plaque Schedule Delete ────────────────────────────────────────────────────

router.delete("/jobs/:jobId/plaque-schedule/:id", async (req, res) => {
  const { jobId, id } = req.params;
  if (!jobId || !id) { res.status(400).json({ error: "Job ID and plaque ID required" }); return; }

  try {
    const job = await getJobWithOrgCheck(req, res, jobId);
    if (!job) return;

    const [deleted] = await db
      .delete(plaqueSchedulesTable)
      .where(and(eq(plaqueSchedulesTable.id, id), eq(plaqueSchedulesTable.jobId, jobId)))
      .returning();

    if (!deleted) {
      res.status(404).json({ error: "Plaque schedule row not found" });
      return;
    }

    res.json({ success: true });
  } catch (err) {
    req.log.error({ err, jobId, id }, "plaque-schedule delete failed");
    res.status(500).json({ error: "Failed to delete plaque schedule row" });
  }
});

// ── Plaque Schedule Query ─────────────────────────────────────────────────────

router.get("/jobs/:jobId/plaque-schedule", async (req, res) => {
  const jobId = req.params.jobId;
  if (!jobId) { res.status(400).json({ error: "Job ID required" }); return; }

  try {
    const job = await getJobWithOrgCheck(req, res, jobId);
    if (!job) return;

    const plaques = await db
      .select()
      .from(plaqueSchedulesTable)
      .where(eq(plaqueSchedulesTable.jobId, jobId));

    res.json({ jobId, plaques });
  } catch (err) {
    req.log.error({ err, jobId }, "plaque-schedule fetch failed");
    res.status(500).json({ error: "Failed to fetch plaque schedule" });
  }
});

// ── Plaque Schedule Create ────────────────────────────────────────────────────

const PlaqueScheduleCreateSchema = z.object({
  typeId: z.string().min(1),
  name: z.string().nullable().optional(),
  braille: z.boolean().nullable().optional(),
  letterHeight: z.string().nullable().optional(),
  trigger: z.string().nullable().optional(),
});

router.post("/jobs/:jobId/plaque-schedule", async (req, res) => {
  const jobId = req.params.jobId;
  if (!jobId) { res.status(400).json({ error: "Job ID required" }); return; }

  const parsed = PlaqueScheduleCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
    return;
  }

  try {
    const job = await getJobWithOrgCheck(req, res, jobId);
    if (!job) return;

    const [created] = await db
      .insert(plaqueSchedulesTable)
      .values({
        jobId,
        typeId: parsed.data.typeId,
        name: parsed.data.name ?? null,
        braille: parsed.data.braille ?? null,
        letterHeight: parsed.data.letterHeight ?? null,
        trigger: parsed.data.trigger ?? null,
        manuallyEdited: true,
      })
      .returning();

    res.status(201).json({ plaque: created });
  } catch (err) {
    req.log.error({ err, jobId }, "plaque-schedule create failed");
    res.status(500).json({ error: "Failed to create plaque schedule row" });
  }
});

// ── Plaque Schedule Update ────────────────────────────────────────────────────

const PlaqueScheduleUpdateSchema = z.object({
  typeId: z.string().min(1).optional(),
  name: z.string().nullable().optional(),
  braille: z.boolean().nullable().optional(),
  letterHeight: z.string().nullable().optional(),
  trigger: z.string().nullable().optional(),
  manuallyEdited: z.boolean().optional(),
});

router.put("/jobs/:jobId/plaque-schedule/:id", async (req, res) => {
  const { jobId, id } = req.params;
  if (!jobId || !id) { res.status(400).json({ error: "Job ID and row ID required" }); return; }

  const parsed = PlaqueScheduleUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
    return;
  }

  try {
    const job = await getJobWithOrgCheck(req, res, jobId);
    if (!job) return;

    const updateData: Record<string, unknown> = {
      manuallyEdited: parsed.data.manuallyEdited !== undefined ? parsed.data.manuallyEdited : true,
    };
    if (parsed.data.typeId !== undefined) updateData.typeId = parsed.data.typeId;
    if (parsed.data.name !== undefined) updateData.name = parsed.data.name;
    if (parsed.data.braille !== undefined) updateData.braille = parsed.data.braille;
    if (parsed.data.letterHeight !== undefined) updateData.letterHeight = parsed.data.letterHeight;
    if (parsed.data.trigger !== undefined) updateData.trigger = parsed.data.trigger;

    const hasDataFields = parsed.data.typeId !== undefined || parsed.data.name !== undefined ||
      parsed.data.braille !== undefined || parsed.data.letterHeight !== undefined ||
      parsed.data.trigger !== undefined || parsed.data.manuallyEdited !== undefined;
    if (!hasDataFields) {
      res.status(400).json({ error: "No fields provided to update" });
      return;
    }

    const [updated] = await db
      .update(plaqueSchedulesTable)
      .set(updateData)
      .where(and(eq(plaqueSchedulesTable.id, id), eq(plaqueSchedulesTable.jobId, jobId)))
      .returning();

    if (!updated) {
      res.status(404).json({ error: "Plaque schedule row not found" });
      return;
    }

    res.json({ plaque: updated });
  } catch (err) {
    req.log.error({ err, jobId, id }, "plaque-schedule update failed");
    res.status(500).json({ error: "Failed to update plaque schedule row" });
  }
});

// ── Plaque Schedule Delete ────────────────────────────────────────────────────

router.delete("/jobs/:jobId/plaque-schedule/:id", async (req, res) => {
  const { jobId, id } = req.params;
  if (!jobId || !id) { res.status(400).json({ error: "Job ID and row ID required" }); return; }

  try {
    const job = await getJobWithOrgCheck(req, res, jobId);
    if (!job) return;

    const [deleted] = await db
      .delete(plaqueSchedulesTable)
      .where(and(eq(plaqueSchedulesTable.id, id), eq(plaqueSchedulesTable.jobId, jobId)))
      .returning();

    if (!deleted) {
      res.status(404).json({ error: "Plaque schedule row not found" });
      return;
    }

    res.json({ success: true });
  } catch (err) {
    req.log.error({ err, jobId, id }, "plaque-schedule delete failed");
    res.status(500).json({ error: "Failed to delete plaque schedule row" });
  }
});

// ── Plaque Schedule Batch Unlock ──────────────────────────────────────────────

const BatchUnlockSchema = z.object({
  ids: z.array(z.string()).optional(),
});

// ── Signs Batch Unlock ────────────────────────────────────────────────────────

router.post("/jobs/:jobId/signs/unlock-all", async (req, res) => {
  const { jobId } = req.params;
  if (!jobId) { res.status(400).json({ error: "Job ID required" }); return; }

  const parsed = BatchUnlockSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
    return;
  }

  try {
    const job = await getJobWithOrgCheck(req, res, jobId);
    if (!job) return;

    const whereClause = parsed.data.ids && parsed.data.ids.length > 0
      ? and(eq(extractedSignsTable.jobId, jobId), inArray(extractedSignsTable.id, parsed.data.ids))
      : eq(extractedSignsTable.jobId, jobId);

    const updated = await db
      .update(extractedSignsTable)
      .set({ manuallyEdited: false })
      .where(whereClause)
      .returning();

    res.json({ unlockedCount: updated.length, signs: updated });
  } catch (err) {
    req.log.error({ err, jobId }, "signs unlock-all failed");
    res.status(500).json({ error: "Failed to unlock sign rows" });
  }
});

router.post("/jobs/:jobId/plaque-schedule/unlock-all", async (req, res) => {
  const { jobId } = req.params;
  if (!jobId) { res.status(400).json({ error: "Job ID required" }); return; }

  const parsed = BatchUnlockSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
    return;
  }

  try {
    const job = await getJobWithOrgCheck(req, res, jobId);
    if (!job) return;

    const whereClause = parsed.data.ids && parsed.data.ids.length > 0
      ? and(eq(plaqueSchedulesTable.jobId, jobId), inArray(plaqueSchedulesTable.id, parsed.data.ids))
      : eq(plaqueSchedulesTable.jobId, jobId);

    const updated = await db
      .update(plaqueSchedulesTable)
      .set({ manuallyEdited: false })
      .where(whereClause)
      .returning();

    res.json({ unlockedCount: updated.length, rows: updated });
  } catch (err) {
    req.log.error({ err, jobId }, "plaque-schedule unlock-all failed");
    res.status(500).json({ error: "Failed to unlock plaque schedule rows" });
  }
});

// ── Occupant Loads Batch Unlock ───────────────────────────────────────────────

router.post("/jobs/:jobId/occupant-loads/unlock-all", async (req, res) => {
  const { jobId } = req.params;
  if (!jobId) { res.status(400).json({ error: "Job ID required" }); return; }

  const parsed = BatchUnlockSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
    return;
  }

  try {
    const job = await getJobWithOrgCheck(req, res, jobId);
    if (!job) return;

    const whereClause = parsed.data.ids && parsed.data.ids.length > 0
      ? and(eq(occupantLoadsTable.jobId, jobId), inArray(occupantLoadsTable.id, parsed.data.ids))
      : eq(occupantLoadsTable.jobId, jobId);

    const updated = await db
      .update(occupantLoadsTable)
      .set({ manuallyEdited: false })
      .where(whereClause)
      .returning();

    res.json({ unlockedCount: updated.length, loads: updated });
  } catch (err) {
    req.log.error({ err, jobId }, "occupant-loads unlock-all failed");
    res.status(500).json({ error: "Failed to unlock occupant load rows" });
  }
});

export default router;

