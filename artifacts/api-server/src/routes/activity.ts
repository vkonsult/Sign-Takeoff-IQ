import { Router, type IRouter } from "express";
import { db, activityLogsTable, organizationsTable } from "@workspace/db";
import { desc, eq, and, gte, lte, inArray } from "drizzle-orm";
import { z } from "zod/v4";

const router: IRouter = Router();

const ActivityQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  userId: z.string().optional(),
  eventType: z.string().optional(),
  jobId: z.string().uuid().optional(),
  orgId: z.string().uuid().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

// GET /activity — returns activity log rows scoped to the caller's role
router.get("/activity", async (req, res) => {
  const user = req.authUser!;

  const parsed = ActivityQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query params", details: parsed.error.issues });
    return;
  }

  const { limit, offset, userId, eventType, jobId, orgId, from, to } = parsed.data;

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
    if (eventType) {
      const validTypes = ["job_opened", "scan_run", "sign_updated", "pdf_exported", "xlsx_exported"] as const;
      type ValidType = typeof validTypes[number];
      if ((validTypes as readonly string[]).includes(eventType)) {
        conditions.push(eq(activityLogsTable.eventType, eventType as ValidType));
      }
    }
    if (from) {
      const dt = new Date(from);
      if (!isNaN(dt.getTime())) conditions.push(gte(activityLogsTable.createdAt, dt));
    }
    if (to) {
      const dt = new Date(to);
      if (!isNaN(dt.getTime())) conditions.push(lte(activityLogsTable.createdAt, dt));
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const rows = await db
      .select()
      .from(activityLogsTable)
      .where(whereClause)
      .orderBy(desc(activityLogsTable.createdAt))
      .limit(limit)
      .offset(offset);

    // For super admin, enrich with org name
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

export default router;
