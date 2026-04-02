import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AdminShell } from "@/components/layout/AdminShell";
import { apiFetch } from "@/lib/apiClient";
import { format } from "date-fns";
import {
  Users,
  Plus,
  Trash2,
  AlertCircle,
  X,
  CheckCircle2,
} from "lucide-react";
import { useUserRole } from "@/hooks/use-user-role";

type Member = {
  id: string;
  clerkUserId: string;
  fullName: string | null;
  email: string | null;
  role: string;
  organizationId: string;
  createdAt: string;
};

// Roles that a TENANT ADMIN can create/assign
const TENANT_ROLES = [
  { value: "SALES", label: "Sales" },
  { value: "ESTIMATOR", label: "Estimator" },
  { value: "PROJECT_MANAGER", label: "Project Manager" },
] as const;

// Additional role for super-admin level callers
const ALL_ROLES = [
  ...TENANT_ROLES,
  { value: "ADMIN", label: "Admin" },
] as const;

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

function NewUserModal({
  onClose,
  onCreated,
  isSuperAdmin,
}: {
  onClose: () => void;
  onCreated: (member: Member) => void;
  isSuperAdmin: boolean;
}) {
  const roleOptions = isSuperAdmin ? ALL_ROLES : TENANT_ROLES;
  const [form, setForm] = useState({
    firstName: "",
    lastName: "",
    email: "",
    phone: "",
    password: "",
    role: roleOptions[0].value as string,
  });
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await apiFetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          firstName: form.firstName,
          lastName: form.lastName,
          email: form.email,
          phone: form.phone || undefined,
          password: form.password,
          role: form.role,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to create user");
        return;
      }
      setSuccess(true);
      setTimeout(() => {
        onCreated(data.membership as Member);
      }, 1200);
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  };

  if (success) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
        <div className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-sm p-6 text-center space-y-3">
          <div className="w-12 h-12 rounded-full bg-green-900/30 flex items-center justify-center mx-auto">
            <CheckCircle2 className="w-6 h-6 text-green-400" />
          </div>
          <h2 className="font-display font-semibold text-foreground">User Created!</h2>
          <p className="text-sm text-muted-foreground">
            <strong className="text-foreground">{form.firstName} {form.lastName}</strong> has been added and can sign in with the password you set.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-md">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="font-display font-semibold text-foreground">Add Team Member</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {error && (
            <div className="flex items-center gap-2 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-lg px-3 py-2">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              {error}
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">First Name *</label>
              <input required value={form.firstName} onChange={(e) => setForm((p) => ({ ...p, firstName: e.target.value }))}
                className="w-full px-3 py-2 rounded-lg bg-secondary border border-border text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Last Name *</label>
              <input required value={form.lastName} onChange={(e) => setForm((p) => ({ ...p, lastName: e.target.value }))}
                className="w-full px-3 py-2 rounded-lg bg-secondary border border-border text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50" />
            </div>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Email Address *</label>
            <input required type="email" value={form.email} onChange={(e) => setForm((p) => ({ ...p, email: e.target.value }))}
              className="w-full px-3 py-2 rounded-lg bg-secondary border border-border text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
              placeholder="name@company.com" />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Phone <span className="font-normal normal-case">(optional)</span></label>
            <input type="tel" value={form.phone} onChange={(e) => setForm((p) => ({ ...p, phone: e.target.value }))}
              className="w-full px-3 py-2 rounded-lg bg-secondary border border-border text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
              placeholder="+1 555-000-0000" />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Password *</label>
            <div className="relative">
              <input required minLength={8} type={showPassword ? "text" : "password"} value={form.password}
                onChange={(e) => setForm((p) => ({ ...p, password: e.target.value }))}
                className="w-full px-3 py-2 pr-16 rounded-lg bg-secondary border border-border text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                placeholder="Min 8 characters" />
              <button type="button" onClick={() => setShowPassword((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground hover:text-foreground transition-colors px-1">
                {showPassword ? "Hide" : "Show"}
              </button>
            </div>
            <p className="text-[10px] text-muted-foreground">
              The user will sign in with this password. Share it with them securely.
            </p>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Role *</label>
            <select value={form.role} onChange={(e) => setForm((p) => ({ ...p, role: e.target.value }))}
              className="w-full px-3 py-2 rounded-lg bg-secondary border border-border text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50">
              {roleOptions.map((r) => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </select>
            {!isSuperAdmin && (
              <p className="text-[10px] text-muted-foreground">
                Contact a Super Admin to create Admin-level accounts.
              </p>
            )}
          </div>
          <div className="flex gap-3 pt-1">
            <button type="button" onClick={onClose}
              className="flex-1 px-4 py-2 rounded-lg border border-border text-sm font-medium text-muted-foreground hover:bg-secondary transition-colors">
              Cancel
            </button>
            <button type="submit" disabled={loading}
              className="flex-1 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50">
              {loading ? "Creating…" : "Create User"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function SettingsUsers() {
  const { isSuperAdmin } = useUserRole();
  const queryClient = useQueryClient();
  const [showNewUser, setShowNewUser] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [roleEditing, setRoleEditing] = useState<string | null>(null);
  const [roleValue, setRoleValue] = useState<string>("");

  const membersQuery = useQuery({
    queryKey: ["admin-org-members-settings"],
    queryFn: async () => {
      const res = await apiFetch("/api/admin/org/members");
      if (!res.ok) throw new Error("Failed to load members");
      return res.json() as Promise<{ members: Member[] }>;
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (membershipId: string) => {
      const res = await apiFetch(`/api/admin/users/${membershipId}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to remove user");
    },
    onSuccess: () => {
      setConfirmDelete(null);
      queryClient.invalidateQueries({ queryKey: ["admin-org-members-settings"] });
    },
  });

  const updateRoleMutation = useMutation({
    mutationFn: async ({ membershipId, role }: { membershipId: string; role: string }) => {
      const res = await apiFetch(`/api/admin/users/${membershipId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to update role");
    },
    onSuccess: () => {
      setRoleEditing(null);
      queryClient.invalidateQueries({ queryKey: ["admin-org-members-settings"] });
    },
  });

  const members = membersQuery.data?.members ?? [];

  const editRoleOptions = isSuperAdmin ? ALL_ROLES : TENANT_ROLES;

  return (
    <AdminShell section="tenant">
      <div className="flex-1 p-8">
        <header className="mb-6">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-xl font-display font-bold text-foreground">Team Members</h1>
              <p className="text-sm text-muted-foreground">
                {members.length} {members.length === 1 ? "member" : "members"}
              </p>
            </div>
            <button
              onClick={() => setShowNewUser(true)}
              className="flex items-center gap-1.5 px-3 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              Add Member
            </button>
          </div>
        </header>

        {membersQuery.isLoading ? (
          <div className="bg-card border border-border rounded-xl p-8">
            <div className="animate-pulse space-y-3">
              <div className="h-12 bg-secondary rounded" />
              <div className="h-12 bg-secondary rounded" />
            </div>
          </div>
        ) : membersQuery.isError ? (
          <div className="bg-card border border-border rounded-xl p-8 flex items-center gap-2 text-destructive">
            <AlertCircle className="w-4 h-4" />
            <span className="text-sm">Failed to load team members</span>
          </div>
        ) : members.length === 0 ? (
          <div className="bg-card border border-border rounded-xl p-12 text-center">
            <Users className="w-8 h-8 text-muted-foreground mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">No team members yet.</p>
          </div>
        ) : (
          <div className="bg-card border border-border rounded-xl overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border bg-secondary/30">
                  <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Member</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Role</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Joined</th>
                  <th className="px-4 py-3 text-right text-xs font-semibold text-muted-foreground uppercase tracking-wider">Actions</th>
                </tr>
              </thead>
              <tbody>
                {members.map((m) => {
                  const isProtected =
                    m.role === "SUPER_ADMIN" ||
                    (!isSuperAdmin && m.role === "ADMIN");
                  const isEditing = roleEditing === m.id;
                  return (
                    <tr key={m.id} className="border-b border-border last:border-0 hover:bg-secondary/20 transition-colors">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 rounded-full bg-primary/20 text-primary text-xs font-bold flex items-center justify-center flex-shrink-0">
                            {(m.fullName ?? m.email ?? "?")[0]?.toUpperCase()}
                          </div>
                          <div>
                            <p className="text-sm font-medium text-foreground">{m.fullName ?? "—"}</p>
                            <p className="text-xs text-muted-foreground">{m.email ?? "—"}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        {isEditing ? (
                          <div className="flex items-center gap-2">
                            <select value={roleValue} onChange={(e) => setRoleValue(e.target.value)}
                              className="px-2 py-1 rounded bg-secondary border border-border text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50">
                              {editRoleOptions.map((r) => (
                                <option key={r.value} value={r.value}>{r.label}</option>
                              ))}
                            </select>
                            <button
                              onClick={() => updateRoleMutation.mutate({ membershipId: m.id, role: roleValue })}
                              disabled={updateRoleMutation.isPending}
                              className="text-xs text-primary hover:underline disabled:opacity-50"
                            >Save</button>
                            <button onClick={() => setRoleEditing(null)} className="text-xs text-muted-foreground hover:text-foreground">
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <div className="flex items-center gap-2">
                            <RoleBadge role={m.role} />
                            {!isProtected && (
                              <button
                                onClick={() => { setRoleEditing(m.id); setRoleValue(m.role); }}
                                className="text-[10px] text-muted-foreground hover:text-foreground underline"
                              >change</button>
                            )}
                          </div>
                        )}
                        {updateRoleMutation.isError && roleEditing === m.id && (
                          <p className="text-[10px] text-destructive mt-1">
                            {(updateRoleMutation.error as Error).message}
                          </p>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">
                        {format(new Date(m.createdAt), "MMM d, yyyy")}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {!isProtected && (
                          confirmDelete === m.id ? (
                            <div className="flex items-center justify-end gap-2">
                              <span className="text-xs text-muted-foreground">Remove?</span>
                              <button
                                onClick={() => deleteMutation.mutate(m.id)}
                                disabled={deleteMutation.isPending}
                                className="text-xs text-destructive hover:underline disabled:opacity-50"
                              >Yes</button>
                              <button onClick={() => setConfirmDelete(null)} className="text-xs text-muted-foreground">No</button>
                            </div>
                          ) : (
                            <button
                              onClick={() => setConfirmDelete(m.id)}
                              className="p-1.5 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {deleteMutation.isError && !confirmDelete && (
          <p className="mt-2 text-sm text-destructive flex items-center gap-1">
            <AlertCircle className="w-3.5 h-3.5" />
            {(deleteMutation.error as Error).message}
          </p>
        )}
      </div>

      {showNewUser && (
        <NewUserModal
          isSuperAdmin={isSuperAdmin}
          onClose={() => setShowNewUser(false)}
          onCreated={(_member) => {
            setShowNewUser(false);
            queryClient.invalidateQueries({ queryKey: ["admin-org-members-settings"] });
          }}
        />
      )}
    </AdminShell>
  );
}
