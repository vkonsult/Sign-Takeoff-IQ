import { Router, type IRouter } from "express";
import { db, activityLogsTable, organizationsTable, aiCallLogsTable, jobsTable } from "@workspace/db";
import { desc, eq, and, gte, lte, inArray, like, ilike, sql } from "drizzle-orm";
import { z } from "zod/v4";

const router: IRouter = Router();

const VALID_EVENT_TYPES = ["job_opened", "scan_run", "sign_updated", "pdf_exported", "xlsx_exported"] as const;
type ValidEventType = typeof VALID_EVENT_TYPES[number];

function parseEventTypes(raw: unknown): ValidEventType[] {
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.filter((v): v is ValidEventType =>
    typeof v === "string" && (VALID_EVENT_TYPES as readonly string[]).includes(v)
  );
}

const ActivityQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  userId: z.string().optional(),
  jobId: z.string().uuid().optional(),
  orgId: z.string().uuid().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  userName: z.string().optional(),
  jobName: z.string().optional(),
});

// GET /activity — returns activity log rows scoped to the caller's role
router.get("/activity", async (req, res) => {
  const user = req.authUser!;

  const parsed = ActivityQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query params", details: parsed.error.issues });
    return;
  }

  const { limit, offset, userId, jobId, orgId, from, to, userName, jobName } = parsed.data;
  const eventTypes = parseEventTypes(req.query.eventType);

  try {
    const conditions = [];

    if (user.isSuperAdmin) {
      if (orgId) conditions.push(eq(activityLogsTable.organizationId, orgId));
    } else if (user.organizationId) {
      conditions.push(eq(activityLogsTable.organizationId, user.organizationId));
      const isStandardUser = !["ADMIN", "SUPER_ADMIN"].includes(user.role);
      if (isStandardUser) {
        conditions.push(eq(activityLogsTable.userId, user.userId));
      } else if (userId) {
        conditions.push(eq(activityLogsTable.userId, userId));
      }
    } else {
      res.status(403).json({ error: "No organization context" });
      return;
    }

    if (jobId) conditions.push(eq(activityLogsTable.jobId, jobId));
    if (eventTypes.length > 0) {
      conditions.push(inArray(activityLogsTable.eventType, eventTypes));
    }
    if (from) {
      const dt = new Date(from);
      if (!isNaN(dt.getTime())) conditions.push(gte(activityLogsTable.createdAt, dt));
    }
    if (to) {
      const dt = new Date(to);
      dt.setDate(dt.getDate() + 1);
      if (!isNaN(dt.getTime())) conditions.push(lte(activityLogsTable.createdAt, dt));
    }
    if (userName) {
      conditions.push(like(activityLogsTable.userName, `%${userName}%`));
    }
    if (jobName) {
      conditions.push(like(activityLogsTable.jobName, `%${jobName}%`));
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const rows = await db
      .select()
      .from(activityLogsTable)
      .where(whereClause)
      .orderBy(desc(activityLogsTable.createdAt))
      .limit(limit)
      .offset(offset);

    let orgNames: Map<string, string> = new Map();
    if (user.isSuperAdmin) {
      const orgIds = [...new Set(rows.map((r) => r.organizationId).filter(Boolean))] as string[];
      if (orgIds.length > 0) {
        const orgs = await db
          .select({ id: organizationsTable.id, name: organizationsTable.name })
          .from(organizationsTable)
          .where(inArray(organizationsTable.id, orgIds));
        orgNames = new Map(orgs.map((o) => [o.id, o.name]));
      }
    }

    const enriched = rows.map((r) => ({
      ...r,
      orgName: r.organizationId ? (orgNames.get(r.organizationId) ?? null) : null,
    }));

    res.json({ activities: enriched, limit, offset });
  } catch (err) {
    req.log.error({ err }, "Failed to fetch activity log");
    res.status(500).json({ error: "Failed to fetch activity log" });
  }
});

const VALID_CALL_TYPES = [
  "project_info",
  "floor_plan_text",
  "vision_fallback",
  "bbox_detection",
  "title_block_vision",
  "sign_schedule_enrich",
] as const;

// GET /activity/ai-calls — returns AI call log rows, scoped to the caller's org
const AiCallsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  jobId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).optional(),
  callType: z.enum(VALID_CALL_TYPES).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  prompt: z.string().optional(),
});

router.get("/activity/ai-calls", async (req, res) => {
  const user = req.authUser!;

  const parsed = AiCallsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query params", details: parsed.error.issues });
    return;
  }

  const { limit, offset, jobId, page, callType, from, to, prompt } = parsed.data;

  const isAdmin = ["ADMIN", "SUPER_ADMIN"].includes(user.role);
  if (!isAdmin && !user.isSuperAdmin) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }

  if (!user.isSuperAdmin && !user.organizationId) {
    res.status(403).json({ error: "No organization context" });
    return;
  }

  try {
    const conditions = [];

    if (jobId) {
      conditions.push(eq(aiCallLogsTable.jobId, jobId));
    }

    if (page != null) {
      conditions.push(eq(aiCallLogsTable.pageNumber, page));
    }

    if (callType) {
      conditions.push(eq(aiCallLogsTable.callType, callType));
    }

    if (from) {
      const dt = new Date(from);
      if (!isNaN(dt.getTime())) conditions.push(gte(aiCallLogsTable.createdAt, dt));
    }

    if (to) {
      const dt = new Date(to);
      dt.setDate(dt.getDate() + 1);
      if (!isNaN(dt.getTime())) conditions.push(lte(aiCallLogsTable.createdAt, dt));
    }

    if (prompt) {
      conditions.push(ilike(aiCallLogsTable.prompt, `%${prompt}%`));
    }

    if (!user.isSuperAdmin && user.organizationId) {
      const orgJobIds = await db
        .select({ id: jobsTable.id })
        .from(jobsTable)
        .where(eq(jobsTable.organizationId, user.organizationId));
      const orgJobIdSet = orgJobIds.map((j) => j.id);
      if (orgJobIdSet.length === 0) {
        res.json({ aiCalls: [], limit, offset, totals: null });
        return;
      }
      if (jobId) {
        if (!orgJobIdSet.includes(jobId)) {
          res.status(403).json({ error: "Job does not belong to your organization" });
          return;
        }
      } else {
        conditions.push(inArray(aiCallLogsTable.jobId, orgJobIdSet));
      }
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const rows = await db
      .select()
      .from(aiCallLogsTable)
      .where(whereClause)
      .orderBy(desc(aiCallLogsTable.createdAt))
      .limit(limit)
      .offset(offset);

    const jobIds = [...new Set(rows.map((r) => r.jobId).filter(Boolean))] as string[];
    let jobNames: Map<string, string> = new Map();
    if (jobIds.length > 0) {
      const jobs = await db
        .select({ id: jobsTable.id, name: jobsTable.name })
        .from(jobsTable)
        .where(inArray(jobsTable.id, jobIds));
      jobNames = new Map(jobs.map((j) => [j.id, j.name]));
    }

    const enriched = rows.map((r) => ({
      ...r,
      jobName: r.jobId ? (jobNames.get(r.jobId) ?? null) : null,
    }));

    const hasFilters = !!(jobId || page != null || callType || from || to);
    let totals: { inputTokens: number; outputTokens: number } | null = null;
    if (hasFilters) {
      const [agg] = await db
        .select({
          totalInputTokens: sql<number>`coalesce(sum(${aiCallLogsTable.inputTokens}), 0)`,
          totalOutputTokens: sql<number>`coalesce(sum(${aiCallLogsTable.outputTokens}), 0)`,
        })
        .from(aiCallLogsTable)
        .where(whereClause);
      if (agg) {
        totals = {
          inputTokens: Number(agg.totalInputTokens),
          outputTokens: Number(agg.totalOutputTokens),
        };
      }
    }

    res.json({ aiCalls: enriched, limit, offset, totals });
  } catch (err) {
    req.log.error({ err }, "Failed to fetch AI call logs");
    res.status(500).json({ error: "Failed to fetch AI call logs" });
  }
});

export default router;
