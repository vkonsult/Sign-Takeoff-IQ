import { Router, type IRouter } from "express";
import { db, organizationsTable, organizationMembershipsTable } from "@workspace/db";
import { desc, eq } from "drizzle-orm";
import { requireRole } from "../middlewares/authMiddleware";

const router: IRouter = Router();

router.get(
  "/admin/organizations",
  requireRole("SUPER_ADMIN"),
  async (req, res) => {
    try {
      const orgs = await db
        .select()
        .from(organizationsTable)
        .orderBy(desc(organizationsTable.createdAt));
      res.json({ organizations: orgs });
    } catch (err) {
      req.log.error({ err }, "Failed to list organizations");
      res.status(500).json({ error: "Failed to list organizations" });
    }
  },
);

router.get(
  "/admin/organizations/:orgId/members",
  requireRole("SUPER_ADMIN"),
  async (req, res) => {
    const { orgId } = req.params;
    try {
      const members = await db
        .select()
        .from(organizationMembershipsTable)
        .where(eq(organizationMembershipsTable.organizationId, orgId))
        .orderBy(desc(organizationMembershipsTable.createdAt));
      res.json({ members });
    } catch (err) {
      req.log.error({ err, orgId }, "Failed to list org members");
      res.status(500).json({ error: "Failed to list members" });
    }
  },
);

export default router;
