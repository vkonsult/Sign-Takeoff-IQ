import { type Request, type Response, type NextFunction } from "express";
import { getAuth } from "@clerk/express";
import { logger } from "../lib/logger";

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
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      authUser?: AuthUser;
    }
  }
}

const SUPER_ADMIN_GUEST_TOKEN = process.env.SUPER_ADMIN_GUEST_TOKEN;

function extractRoleFromAuth(req: Request): UserRole {
  const auth = getAuth(req);
  const claims = auth?.sessionClaims as Record<string, unknown> | undefined;
  if (!claims) return "SALES";
  const meta = (claims.publicMetadata ?? claims.metadata ?? {}) as Record<string, unknown>;
  const role = meta.role as string | undefined;
  if (role && ["SUPER_ADMIN", "ADMIN", "SALES", "ESTIMATOR", "PROJECT_MANAGER"].includes(role)) {
    return role as UserRole;
  }
  return "SALES";
}

function extractOrgIdFromAuth(req: Request): string | null {
  const auth = getAuth(req);
  const claims = auth?.sessionClaims as Record<string, unknown> | undefined;
  if (!claims) return null;
  const meta = (claims.publicMetadata ?? claims.metadata ?? {}) as Record<string, unknown>;
  return (meta.organizationId as string) ?? null;
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (SUPER_ADMIN_GUEST_TOKEN) {
    const authHeader = req.headers.authorization ?? "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (token && token === SUPER_ADMIN_GUEST_TOKEN) {
      req.authUser = {
        userId: "guest-super-admin",
        role: "SUPER_ADMIN",
        organizationId: null,
      };
      next();
      return;
    }
  }

  const auth = getAuth(req);
  const userId = auth?.userId;

  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  req.authUser = {
    userId,
    role: extractRoleFromAuth(req),
    organizationId: extractOrgIdFromAuth(req),
  };

  next();
}

export function requireRole(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.authUser) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (!roles.includes(req.authUser.role)) {
      res.status(403).json({ error: "Forbidden — insufficient role" });
      return;
    }
    next();
  };
}
