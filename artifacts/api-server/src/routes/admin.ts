import { Router, type IRouter } from "express";
import { db, organizationsTable, organizationMembershipsTable } from "@workspace/db";
import { desc, eq, and } from "drizzle-orm";
import { requireRole } from "../middlewares/authMiddleware";
import { createClerkClient } from "@clerk/express";
import { z } from "zod/v4";
import crypto from "crypto";

const router: IRouter = Router();

const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });

// ── SUPER ADMIN: List all organizations ─────────────────────────────────────
router.get("/admin/organizations", requireRole("SUPER_ADMIN"), async (req, res) => {
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
});

// ── SUPER ADMIN: Create organization ────────────────────────────────────────
const CreateOrgSchema = z.object({
  name: z.string().min(1).max(200),
  slug: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/, "Slug must be lowercase letters, numbers, and hyphens only"),
  email: z.string().email().optional().nullable(),
  phone: z.string().max(50).optional().nullable(),
  address: z.string().max(500).optional().nullable(),
  website: z.string().max(500).optional().nullable(),
  logoUrl: z.string().max(1000).optional().nullable(),
});

router.post("/admin/organizations", requireRole("SUPER_ADMIN"), async (req, res) => {
  const parsed = CreateOrgSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
    return;
  }
  try {
    const [org] = await db
      .insert(organizationsTable)
      .values(parsed.data)
      .returning();
    res.status(201).json({ organization: org });
  } catch (err: unknown) {
    const msg = String((err as { message?: string })?.message ?? "");
    if (msg.includes("unique") || msg.includes("duplicate")) {
      res.status(409).json({ error: "Slug is already in use" });
      return;
    }
    req.log.error({ err }, "Failed to create organization");
    res.status(500).json({ error: "Failed to create organization" });
  }
});

// ── SUPER ADMIN: Get specific org members ────────────────────────────────────
router.get("/admin/organizations/:orgId/members", requireRole("SUPER_ADMIN"), async (req, res) => {
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
});

// ── SUPER ADMIN: List all users across all orgs ───────────────────────────────
router.get("/admin/users", requireRole("SUPER_ADMIN"), async (req, res) => {
  try {
    const users = await db
      .select({
        id: organizationMembershipsTable.id,
        clerkUserId: organizationMembershipsTable.clerkUserId,
        fullName: organizationMembershipsTable.fullName,
        email: organizationMembershipsTable.email,
        role: organizationMembershipsTable.role,
        organizationId: organizationMembershipsTable.organizationId,
        orgName: organizationsTable.name,
        orgSlug: organizationsTable.slug,
        createdAt: organizationMembershipsTable.createdAt,
      })
      .from(organizationMembershipsTable)
      .leftJoin(organizationsTable, eq(organizationMembershipsTable.organizationId, organizationsTable.id))
      .orderBy(desc(organizationMembershipsTable.createdAt));
    res.json({ users });
  } catch (err) {
    req.log.error({ err }, "Failed to list users");
    res.status(500).json({ error: "Failed to list users" });
  }
});

// ── SUPER ADMIN: Update any org ───────────────────────────────────────────────
const SuperUpdateOrgSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  email: z.string().email().optional().nullable(),
  phone: z.string().max(50).optional().nullable(),
  address: z.string().max(500).optional().nullable(),
  website: z.string().max(500).optional().nullable(),
  logoUrl: z.string().max(1000).optional().nullable(),
  onboardingComplete: z.boolean().optional(),
});

router.patch("/admin/organizations/:orgId", requireRole("SUPER_ADMIN"), async (req, res) => {
  const { orgId } = req.params;
  const parsed = SuperUpdateOrgSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
    return;
  }
  try {
    const [updated] = await db
      .update(organizationsTable)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(eq(organizationsTable.id, orgId))
      .returning();
    if (!updated) {
      res.status(404).json({ error: "Organization not found" });
      return;
    }
    res.json({ organization: updated });
  } catch (err) {
    req.log.error({ err, orgId }, "Failed to update organization");
    res.status(500).json({ error: "Failed to update organization" });
  }
});

// ── TENANT ADMIN: Get own org ────────────────────────────────────────────────
router.get("/admin/org", requireRole("ADMIN"), async (req, res) => {
  const { organizationId } = req.authUser!;
  if (!organizationId) {
    res.status(400).json({ error: "No organization context" });
    return;
  }
  try {
    const [org] = await db
      .select()
      .from(organizationsTable)
      .where(eq(organizationsTable.id, organizationId));
    if (!org) {
      res.status(404).json({ error: "Organization not found" });
      return;
    }
    res.json({ organization: org });
  } catch (err) {
    req.log.error({ err, organizationId }, "Failed to get org");
    res.status(500).json({ error: "Failed to get organization" });
  }
});

// ── TENANT ADMIN: Update own org ─────────────────────────────────────────────
const UpdateOrgSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  email: z.string().email().optional().nullable(),
  phone: z.string().max(50).optional().nullable(),
  address: z.string().max(500).optional().nullable(),
  website: z.string().max(500).optional().nullable(),
  logoUrl: z.string().max(1000).optional().nullable(),
  onboardingComplete: z.boolean().optional(),
});

router.patch("/admin/org", requireRole("ADMIN"), async (req, res) => {
  const { organizationId } = req.authUser!;
  if (!organizationId) {
    res.status(400).json({ error: "No organization context" });
    return;
  }
  const parsed = UpdateOrgSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
    return;
  }
  try {
    const [updated] = await db
      .update(organizationsTable)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(eq(organizationsTable.id, organizationId))
      .returning();
    if (!updated) {
      res.status(404).json({ error: "Organization not found" });
      return;
    }
    res.json({ organization: updated });
  } catch (err) {
    req.log.error({ err, organizationId }, "Failed to update org");
    res.status(500).json({ error: "Failed to update organization" });
  }
});

// ── TENANT ADMIN: List own org members ───────────────────────────────────────
router.get("/admin/org/members", requireRole("ADMIN"), async (req, res) => {
  const { organizationId } = req.authUser!;
  if (!organizationId) {
    res.status(400).json({ error: "No organization context" });
    return;
  }
  try {
    const members = await db
      .select()
      .from(organizationMembershipsTable)
      .where(eq(organizationMembershipsTable.organizationId, organizationId))
      .orderBy(desc(organizationMembershipsTable.createdAt));
    res.json({ members });
  } catch (err) {
    req.log.error({ err, organizationId }, "Failed to list org members");
    res.status(500).json({ error: "Failed to list members" });
  }
});

// ── TENANT ADMIN: Create user ─────────────────────────────────────────────────
const CreateUserSchema = z.object({
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  email: z.string().email(),
  role: z.enum(["SALES", "ESTIMATOR", "PROJECT_MANAGER", "ADMIN"]),
});

router.post("/admin/org/users", requireRole("ADMIN"), async (req, res) => {
  const { organizationId } = req.authUser!;
  if (!organizationId) {
    res.status(400).json({ error: "No organization context" });
    return;
  }
  const parsed = CreateUserSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
    return;
  }
  const { firstName, lastName, email, role } = parsed.data;
  try {
    const tempPassword = crypto.randomBytes(12).toString("base64url");
    const clerkUser = await clerk.users.createUser({
      emailAddress: [email],
      password: tempPassword,
      firstName,
      lastName,
      publicMetadata: { role, organizationId },
    });
    const [membership] = await db
      .insert(organizationMembershipsTable)
      .values({
        organizationId,
        clerkUserId: clerkUser.id,
        fullName: `${firstName} ${lastName}`,
        email,
        role,
      })
      .returning();
    res.status(201).json({ membership, tempPassword });
  } catch (err: unknown) {
    const errAny = err as { errors?: Array<{ code: string; message: string }> };
    if (errAny?.errors?.some((e) => e.code === "form_identifier_exists")) {
      res.status(409).json({ error: "A user with this email already exists in Clerk" });
      return;
    }
    req.log.error({ err }, "Failed to create user");
    res.status(500).json({ error: "Failed to create user" });
  }
});

// ── TENANT ADMIN: Update member role ─────────────────────────────────────────
const UpdateMemberSchema = z.object({
  role: z.enum(["SALES", "ESTIMATOR", "PROJECT_MANAGER", "ADMIN"]),
});

router.patch("/admin/org/users/:membershipId", requireRole("ADMIN"), async (req, res) => {
  const { organizationId } = req.authUser!;
  const { membershipId } = req.params;
  if (!organizationId) {
    res.status(400).json({ error: "No organization context" });
    return;
  }
  const parsed = UpdateMemberSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
    return;
  }
  try {
    const [membership] = await db
      .select()
      .from(organizationMembershipsTable)
      .where(
        and(
          eq(organizationMembershipsTable.id, membershipId),
          eq(organizationMembershipsTable.organizationId, organizationId),
        ),
      );
    if (!membership) {
      res.status(404).json({ error: "Member not found" });
      return;
    }
    if (membership.role === "SUPER_ADMIN") {
      res.status(403).json({ error: "Cannot modify a Super Admin" });
      return;
    }
    const [updated] = await db
      .update(organizationMembershipsTable)
      .set({ role: parsed.data.role, updatedAt: new Date() })
      .where(eq(organizationMembershipsTable.id, membershipId))
      .returning();
    await clerk.users.updateUserMetadata(membership.clerkUserId, {
      publicMetadata: { role: parsed.data.role, organizationId },
    });
    res.json({ membership: updated });
  } catch (err) {
    req.log.error({ err, membershipId }, "Failed to update member role");
    res.status(500).json({ error: "Failed to update member role" });
  }
});

// ── TENANT ADMIN: Remove member ───────────────────────────────────────────────
router.delete("/admin/org/users/:membershipId", requireRole("ADMIN"), async (req, res) => {
  const { organizationId, userId: callerUserId } = req.authUser!;
  const { membershipId } = req.params;
  if (!organizationId) {
    res.status(400).json({ error: "No organization context" });
    return;
  }
  try {
    const [membership] = await db
      .select()
      .from(organizationMembershipsTable)
      .where(
        and(
          eq(organizationMembershipsTable.id, membershipId),
          eq(organizationMembershipsTable.organizationId, organizationId),
        ),
      );
    if (!membership) {
      res.status(404).json({ error: "Member not found" });
      return;
    }
    if (membership.role === "SUPER_ADMIN") {
      res.status(403).json({ error: "Cannot remove a Super Admin" });
      return;
    }
    if (membership.clerkUserId === callerUserId) {
      res.status(400).json({ error: "Cannot remove yourself" });
      return;
    }
    await db
      .delete(organizationMembershipsTable)
      .where(eq(organizationMembershipsTable.id, membershipId));
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err, membershipId }, "Failed to remove member");
    res.status(500).json({ error: "Failed to remove member" });
  }
});

export default router;
