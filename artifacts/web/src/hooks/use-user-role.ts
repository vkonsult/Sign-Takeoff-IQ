import { useUser } from "@clerk/react";
import { isGuestMode } from "@/lib/apiClient";

export type AppRole =
  | "SUPER_ADMIN"
  | "ADMIN"
  | "SALES"
  | "ESTIMATOR"
  | "PROJECT_MANAGER"
  | "GUEST";

export function useUserRole(): {
  role: AppRole;
  organizationId: string | null;
  isLoaded: boolean;
  isSuperAdmin: boolean;
  isAdmin: boolean;
} {
  const { user, isLoaded } = useUser();

  if (isGuestMode()) {
    return {
      role: "SUPER_ADMIN",
      organizationId: null,
      isLoaded: true,
      isSuperAdmin: true,
      isAdmin: true,
    };
  }

  const meta = (user?.publicMetadata ?? {}) as {
    role?: string;
    organizationId?: string;
  };

  const rawRole = meta.role ?? "SALES";
  const validRoles: AppRole[] = [
    "SUPER_ADMIN",
    "ADMIN",
    "SALES",
    "ESTIMATOR",
    "PROJECT_MANAGER",
  ];
  const role: AppRole = validRoles.includes(rawRole as AppRole)
    ? (rawRole as AppRole)
    : "SALES";
  const organizationId = meta.organizationId ?? null;

  return {
    role,
    organizationId,
    isLoaded,
    isSuperAdmin: role === "SUPER_ADMIN",
    isAdmin: role === "ADMIN" || role === "SUPER_ADMIN",
  };
}
