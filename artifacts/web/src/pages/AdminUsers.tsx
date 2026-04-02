import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AdminShell } from "@/components/layout/AdminShell";
import { apiFetch } from "@/lib/apiClient";
import { format } from "date-fns";
import { AlertCircle, RefreshCw, ChevronLeft, ChevronRight } from "lucide-react";
import { useState } from "react";

type UserRow = {
  id: string;
  clerkUserId: string;
  fullName: string | null;
  email: string | null;
  role: string;
  organizationId: string | null;
  orgName: string | null;
  orgSlug: string | null;
  createdAt: string;
  lastLoginAt: string | null;
};

const ROLE_COLORS: Record<string, string> = {
  SUPER_ADMIN: "bg-purple-900/30 text-purple-300 border-purple-700/40",
  ADMIN: "bg-blue-900/30 text-blue-300 border-blue-700/40",
  SALES: "bg-green-900/30 text-green-300 border-green-700/40",
  ESTIMATOR: "bg-amber-900/30 text-amber-300 border-amber-700/40",
  PROJECT_MANAGER: "bg-cyan-900/30 text-cyan-300 border-cyan-700/40",
};

function RoleBadge({ role }: { role: string }) {
  const cls = ROLE_COLORS[role] ?? "bg-secondary text-muted-foreground border-border";
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-mono border ${cls}`}>
      {role.replace("_", " ")}
    </span>
  );
}

const PAGE_SIZE = 25;

export default function AdminUsers() {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);

  const usersQuery = useQuery({
    queryKey: ["admin-all-users"],
    queryFn: async () => {
      const res = await apiFetch("/api/admin/users");
      if (!res.ok) throw new Error("Failed to load users");
      return res.json() as Promise<{ users: UserRow[] }>;
    },
  });

  const allUsers = usersQuery.data?.users ?? [];
  const totalPages = Math.max(1, Math.ceil(allUsers.length / PAGE_SIZE));
  const users = allUsers.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <AdminShell section="super">
      <div className="flex-1 p-8">
        <header className="mb-6">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-xl font-display font-bold text-foreground">All Users</h1>
              <p className="text-sm text-muted-foreground">{allUsers.length} total across all organizations</p>
            </div>
            <button
              onClick={() => queryClient.invalidateQueries({ queryKey: ["admin-all-users"] })}
              className="p-2 rounded-lg text-muted-foreground hover:bg-secondary transition-colors"
              title="Refresh"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          </div>
        </header>

        <div className="bg-card border border-border rounded-xl overflow-hidden">
          {usersQuery.isLoading ? (
            <div className="p-8 text-center text-muted-foreground text-sm">Loading…</div>
          ) : usersQuery.isError ? (
            <div className="p-8 text-center text-destructive text-sm flex items-center justify-center gap-2">
              <AlertCircle className="w-4 h-4" /> Failed to load users
            </div>
          ) : (
            <>
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border bg-secondary/30">
                    <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Name</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Email</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Role</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Organization</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Last Login</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Joined</th>
                  </tr>
                </thead>
                <tbody>
                  {users.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-4 py-8 text-center text-sm text-muted-foreground italic">
                        No users found
                      </td>
                    </tr>
                  ) : (
                    users.map((u) => (
                      <tr key={u.id} className="border-b border-border last:border-0 hover:bg-secondary/20 transition-colors">
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <div className="w-7 h-7 rounded-full bg-primary/20 text-primary text-xs font-bold flex items-center justify-center flex-shrink-0">
                              {(u.fullName ?? u.email ?? "?")[0]?.toUpperCase()}
                            </div>
                            <span className="text-sm text-foreground">{u.fullName ?? "—"}</span>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-xs text-muted-foreground">{u.email ?? "—"}</td>
                        <td className="px-4 py-3"><RoleBadge role={u.role} /></td>
                        <td className="px-4 py-3">
                          <p className="text-xs text-foreground">{u.orgName ?? "—"}</p>
                          {u.orgSlug && <p className="text-[10px] font-mono text-muted-foreground">{u.orgSlug}</p>}
                        </td>
                        <td className="px-4 py-3 text-xs text-muted-foreground">
                          {u.lastLoginAt ? format(new Date(u.lastLoginAt), "MMM d, yyyy") : "—"}
                        </td>
                        <td className="px-4 py-3 text-xs text-muted-foreground">
                          {format(new Date(u.createdAt), "MMM d, yyyy")}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>

              {totalPages > 1 && (
                <div className="flex items-center justify-between px-4 py-3 border-t border-border">
                  <p className="text-xs text-muted-foreground">
                    Page {page} of {totalPages} &middot; {allUsers.length} users
                  </p>
                  <div className="flex items-center gap-1">
                    <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}
                      className="p-1.5 rounded text-muted-foreground hover:bg-secondary disabled:opacity-30 transition-colors">
                      <ChevronLeft className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page === totalPages}
                      className="p-1.5 rounded text-muted-foreground hover:bg-secondary disabled:opacity-30 transition-colors">
                      <ChevronRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </AdminShell>
  );
}
