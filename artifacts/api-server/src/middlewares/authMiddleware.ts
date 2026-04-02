import { type Request, type Response, type NextFunction } from "express";
import { getAuth } from "@clerk/express";
import { db, organizationMembershipsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger";
import crypto from "crypto";

const SUPER_ADMIN_GUEST_TOKEN = process.env.SUPER_ADMIN_GUEST_TOKEN ?? "";

function isValidGuestToken(token: string): boolean {
  if (!SUPER_ADMIN_GUEST_TOKEN || !token) return false;
  const expected = Buffer.from(SUPER_ADMIN_GUEST_TOKEN, "utf8");
  const provided = Buffer.from(token, "utf8");
  if (expected.length !== provided.length) return false;
  try {
    return crypto.timingSafeEqual(expected, provided);
  } catch {
    return false;
  }
}

export type UserRole =
  | "SUPER_ADMIN"
  | "ADMIN"
  | "SALES"
  | "ESTIMATOR"
  | "PROJECT_MANAGER"
  | "GUEST";

export interface AuthUser {
  userId: string;
  role: UserRole;
  organizationId: string | null;
  isSuperAdmin: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      authUser?: AuthUser;
    }
  }
}

async function resolveMembership(
  clerkUserId: string,
  jwtOrgId: string | null,
  jwtRole: UserRole,
): Promise<{ role: UserRole; organizationId: string | null }> {
  const [membership] = await db
    .select()
    .from(organizationMembershipsTable)
    .where(eq(organizationMembershipsTable.clerkUserId, clerkUserId))
    .limit(1);

  if (membership) {
    return {
      role: membership.role as UserRole,
      organizationId: membership.organizationId,
    };
  }

  return { role: jwtRole, organizationId: jwtOrgId };
}

function extractFromJwt(req: Request): { role: UserRole; orgId: string | null } {
  const auth = getAuth(req);
  const claims = auth?.sessionClaims as Record<string, unknown> | undefined;
  const meta = claims
    ? ((claims.publicMetadata ?? claims.metadata ?? {}) as Record<string, unknown>)
    : {};

  const role = meta.role as string | undefined;
  const validRole =
    role && ["SUPER_ADMIN", "ADMIN", "SALES", "ESTIMATOR", "PROJECT_MANAGER"].includes(role)
      ? (role as UserRole)
      : "SALES";

  const orgId = (meta.organizationId as string) ?? null;
  return { role: validRole, orgId };
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization ?? "";
  const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (bearerToken && isValidGuestToken(bearerToken)) {
    req.authUser = {
      userId: "guest-super-admin",
      role: "SUPER_ADMIN",
      organizationId: null,
      isSuperAdmin: true,
    };
    next();
    return;
  }

  const auth = getAuth(req);
  const userId = auth?.userId;

  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const { role: jwtRole, orgId: jwtOrgId } = extractFromJwt(req);

  resolveMembership(userId, jwtOrgId, jwtRole)
    .then(({ role, organizationId }) => {
      req.authUser = {
        userId,
        role,
        organizationId,
        isSuperAdmin: role === "SUPER_ADMIN",
      };
      next();
    })
    .catch((err) => {
      logger.warn({ err, userId }, "Failed to resolve membership — using JWT claims only");
      req.authUser = {
        userId,
        role: jwtRole,
        organizationId: jwtOrgId,
        isSuperAdmin: jwtRole === "SUPER_ADMIN",
      };
      next();
    });
}

const ROLE_RANK: Record<UserRole, number> = {
  GUEST: 0,
  SALES: 1,
  ESTIMATOR: 1,
  PROJECT_MANAGER: 1,
  ADMIN: 2,
  SUPER_ADMIN: 3,
};

function meetsRole(userRole: UserRole, required: UserRole): boolean {
  return ROLE_RANK[userRole] >= ROLE_RANK[required];
}

export function requireRole(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.authUser) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const userRole = req.authUser.role;
    const allowed = roles.some((r) => meetsRole(userRole, r));
    if (!allowed) {
      res.status(403).json({ error: "Forbidden — insufficient role" });
      return;
    }
    next();
  };
}
