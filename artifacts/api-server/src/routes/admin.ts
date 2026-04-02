import { Router, type IRouter } from "express";
import {
  db,
  organizationsTable,
  organizationMembershipsTable,
  jobsTable,
} from "@workspace/db";
import { desc, eq, and, count, max } from "drizzle-orm";
import { requireRole } from "../middlewares/authMiddleware";
import { createClerkClient } from "@clerk/express";
import { z } from "zod/v4";
import crypto from "crypto";
import multer from "multer";
import path from "path";
import { LOGOS_DIR } from "../lib/storage";

const router: IRouter = Router();

const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });

// ── Logo upload multer ────────────────────────────────────────────────────────
const logoStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, LOGOS_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || ".png";
    cb(null, `logo-${Date.now()}-${crypto.randomBytes(4).toString("hex")}${ext}`);
  },
});

const uploadLogo = multer({
  storage: logoStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (_req, file, cb) => {
    // SVG excluded — it may embed scripts (XSS risk when served publicly)
    const allowed = ["image/png", "image/jpeg", "image/webp", "image/gif"];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Only PNG, JPEG, WebP, or GIF images are allowed for logos"));
    }
  },
});

// ── Logo upload endpoint (ADMIN+) ─────────────────────────────────────────────
router.post("/admin/logo", requireRole("ADMIN"), uploadLogo.single("logo"), (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "No logo file provided" });
    return;
  }
  const url = `/api/logos/${req.file.filename}`;
  res.json({ url });
});

// ── SUPER ADMIN: List all organizations (with job count + last activity) ──────
router.get("/admin/organizations", requireRole("SUPER_ADMIN"), async (req, res) => {
  try {
    const orgs = await db
      .select({
        id: organizationsTable.id,
        name: organizationsTable.name,
        slug: organizationsTable.slug,
        email: organizationsTable.email,
        phone: organizationsTable.phone,
        address: organizationsTable.address,
        website: organizationsTable.website,
        logoUrl: organizationsTable.logoUrl,
        onboardingComplete: organizationsTable.onboardingComplete,
        createdAt: organizationsTable.createdAt,
        updatedAt: organizationsTable.updatedAt,
        jobCount: count(jobsTable.id),
        lastActivity: max(jobsTable.createdAt),
      })
      .from(organizationsTable)
      .leftJoin(jobsTable, eq(jobsTable.organizationId, organizationsTable.id))
      .groupBy(organizationsTable.id)
      .orderBy(desc(organizationsTable.createdAt));
    res.json({ organizations: orgs });
  } catch (err) {
    req.log.error({ err }, "Failed to list organizations");
    res.status(500).json({ error: "Failed to list organizations" });
  }
});

// ── SUPER ADMIN: Create organization (with optional owner invitation) ─────────
const CreateOrgSchema = z.object({
  name: z.string().min(1).max(200),
  slug: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/, "Slug: lowercase letters, numbers, hyphens only"),
  email: z.string().email().optional().nullable(),
  phone: z.string().max(50).optional().nullable(),
  address: z.string().max(500).optional().nullable(),
  website: z.string().max(500).optional().nullable(),
  logoUrl: z.string().max(1000).optional().nullable(),
  ownerFirstName: z.string().min(1).max(100).optional(),
  ownerLastName: z.string().min(1).max(100).optional(),
  ownerEmail: z.string().email().optional(),
});

router.post("/admin/organizations", requireRole("SUPER_ADMIN"), async (req, res) => {
  const parsed = CreateOrgSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
    return;
  }
  const { ownerFirstName, ownerLastName, ownerEmail, ...orgFields } = parsed.data;
  try {
    const [org] = await db.insert(organizationsTable).values(orgFields).returning();

    let ownerInvitationSent = false;
    let ownerInvitationError: string | null = null;
    let ownerMembershipId: string | null = null;

    if (ownerEmail && ownerFirstName && ownerLastName) {
      try {
        // Create org membership placeholder (will be linked when invitation is accepted)
        const [mem] = await db.insert(organizationMembershipsTable).values({
          organizationId: org.id,
          clerkUserId: `pending-${crypto.randomBytes(8).toString("hex")}`,
          fullName: `${ownerFirstName} ${ownerLastName}`,
          email: ownerEmail,
          role: "ADMIN",
        }).returning();
        ownerMembershipId = mem.id;

        // Send Clerk invitation so owner sets their own password
        await clerk.invitations.createInvitation({
          emailAddress: ownerEmail,
          publicMetadata: { role: "ADMIN", organizationId: org.id } as Record<string, unknown>,
          redirectUrl: process.env.CLERK_INVITATION_REDIRECT_URL ?? undefined,
        });
        ownerInvitationSent = true;
      } catch (ownerErr: unknown) {
        req.log.warn({ ownerErr, orgId: org.id }, "Org created but owner invitation failed");
        ownerInvitationError = String((ownerErr as { message?: string })?.message ?? "Unknown error");
        // Clean up placeholder membership if invitation failed
        if (ownerMembershipId) {
          await db.delete(organizationMembershipsTable).where(eq(organizationMembershipsTable.id, ownerMembershipId)).catch(() => {});
          ownerMembershipId = null;
        }
      }
    }

    res.status(201).json({
      organization: org,
      ownerInvitationSent,
      ownerInvitationError,
      ownerEmail: ownerInvitationSent ? ownerEmail : null,
    });
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

// ── SUPER ADMIN: Get org members ──────────────────────────────────────────────
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
    const rows = await db
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

    // Fetch last-login from Clerk for real users (skip pending placeholders)
    const realUserIds = rows
      .map((r) => r.clerkUserId)
      .filter((id) => !id.startsWith("pending-"));

    const lastLoginMap = new Map<string, string | null>();
    if (realUserIds.length > 0) {
      try {
        const clerkUsers = await clerk.users.getUserList({ userId: realUserIds, limit: 500 });
        for (const cu of clerkUsers.data) {
          lastLoginMap.set(cu.id, cu.lastSignInAt ? new Date(cu.lastSignInAt).toISOString() : null);
        }
      } catch (clerkErr) {
        req.log.warn({ clerkErr }, "Could not fetch last-login from Clerk");
      }
    }

    const users = rows.map((r) => ({
      ...r,
      lastLoginAt: lastLoginMap.get(r.clerkUserId) ?? null,
    }));

    res.json({ users });
  } catch (err) {
    req.log.error({ err }, "Failed to list users");
    res.status(500).json({ error: "Failed to list users" });
  }
});

// ── SUPER ADMIN: Platform stats for dashboard ─────────────────────────────────
router.get("/admin/stats", requireRole("SUPER_ADMIN"), async (req, res) => {
  try {
    const [orgCount] = await db.select({ count: count() }).from(organizationsTable);
    const [userCount] = await db.select({ count: count() }).from(organizationMembershipsTable);
    const [jobCount] = await db.select({ count: count() }).from(jobsTable);
    res.json({
      organizations: orgCount.count,
      users: userCount.count,
      jobs: jobCount.count,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to fetch stats");
    res.status(500).json({ error: "Failed to fetch stats" });
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
    const rows = await db
      .select()
      .from(organizationMembershipsTable)
      .where(eq(organizationMembershipsTable.organizationId, organizationId))
      .orderBy(desc(organizationMembershipsTable.createdAt));

    // Enrich with Clerk last-login for real users
    const realUserIds = rows
      .map((r) => r.clerkUserId)
      .filter((id) => !id.startsWith("pending-"));

    const lastLoginMap = new Map<string, string | null>();
    if (realUserIds.length > 0) {
      try {
        const clerkUsers = await clerk.users.getUserList({ userId: realUserIds, limit: 500 });
        for (const cu of clerkUsers.data) {
          lastLoginMap.set(cu.id, cu.lastSignInAt ? new Date(cu.lastSignInAt).toISOString() : null);
        }
      } catch (clerkErr) {
        req.log.warn({ clerkErr }, "Could not fetch last-login from Clerk for members");
      }
    }

    const members = rows.map((r) => ({
      ...r,
      lastLoginAt: lastLoginMap.get(r.clerkUserId) ?? null,
    }));

    res.json({ members });
  } catch (err) {
    req.log.error({ err, organizationId }, "Failed to list org members");
    res.status(500).json({ error: "Failed to list members" });
  }
});

// ── TENANT ADMIN: Create user in own org ──────────────────────────────────────
// Admin provides the initial password; ADMIN callers cannot create ADMIN-role users.
const CreateUserSchema = z.object({
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  email: z.string().email(),
  phone: z.string().max(50).optional(),
  password: z.string().min(8).max(200),
  role: z.enum(["SALES", "ESTIMATOR", "PROJECT_MANAGER", "ADMIN"]),
});

router.post("/admin/users", requireRole("ADMIN"), async (req, res) => {
  const { organizationId, role: callerRole } = req.authUser!;
  if (!organizationId) {
    res.status(400).json({ error: "No organization context" });
    return;
  }
  const parsed = CreateUserSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
    return;
  }
  const { firstName, lastName, email, phone, password, role } = parsed.data;

  // Tenant ADMINs may not create or assign the ADMIN role
  if (callerRole !== "SUPER_ADMIN" && role === "ADMIN") {
    res.status(403).json({ error: "Tenant admins cannot create Admin-level users" });
    return;
  }

  try {
    const clerkUser = await clerk.users.createUser({
      emailAddress: [email],
      password,
      firstName,
      lastName,
      ...(phone ? { phoneNumber: [phone] } : {}),
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
    res.status(201).json({ membership });
  } catch (err: unknown) {
    const errAny = err as { errors?: Array<{ code: string; message: string }> };
    if (errAny?.errors?.some((e) => e.code === "form_identifier_exists")) {
      res.status(409).json({ error: "A user with this email already exists" });
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

router.patch("/admin/users/:membershipId", requireRole("ADMIN"), async (req, res) => {
  const { organizationId, role: callerRole } = req.authUser!;
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
  // Tenant ADMINs may not promote to ADMIN
  if (callerRole !== "SUPER_ADMIN" && parsed.data.role === "ADMIN") {
    res.status(403).json({ error: "Tenant admins cannot promote users to the Admin role" });
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
    if (callerRole !== "SUPER_ADMIN" && membership.role === "ADMIN") {
      res.status(403).json({ error: "Tenant admins cannot modify other Admin accounts" });
      return;
    }
    const [updated] = await db
      .update(organizationMembershipsTable)
      .set({ role: parsed.data.role, updatedAt: new Date() })
      .where(eq(organizationMembershipsTable.id, membershipId))
      .returning();
    // Only sync Clerk metadata if clerkUserId is not a placeholder
    if (!membership.clerkUserId.startsWith("pending-")) {
      await clerk.users.updateUserMetadata(membership.clerkUserId, {
        publicMetadata: { role: parsed.data.role, organizationId },
      });
    }
    res.json({ membership: updated });
  } catch (err) {
    req.log.error({ err, membershipId }, "Failed to update member role");
    res.status(500).json({ error: "Failed to update member role" });
  }
});

// ── TENANT ADMIN: Remove member ───────────────────────────────────────────────
router.delete("/admin/users/:membershipId", requireRole("ADMIN"), async (req, res) => {
  const { organizationId, userId: callerUserId, role: callerRole } = req.authUser!;
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
    if (callerRole !== "SUPER_ADMIN" && membership.role === "ADMIN") {
      res.status(403).json({ error: "Tenant admins cannot remove other Admin accounts" });
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
