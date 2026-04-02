import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AppShell } from "@/components/layout/Shell";
import { apiFetch } from "@/lib/apiClient";
import { format } from "date-fns";
import {
  Building2,
  Users,
  Plus,
  ChevronDown,
  ChevronUp,
  X,
  Check,
  AlertCircle,
  RefreshCw,
} from "lucide-react";

type Organization = {
  id: string;
  name: string;
  slug: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  website: string | null;
  logoUrl: string | null;
  onboardingComplete: boolean;
  createdAt: string;
};

type Member = {
  id: string;
  clerkUserId: string;
  fullName: string | null;
  email: string | null;
  role: string;
  organizationId: string;
  orgName?: string | null;
  orgSlug?: string | null;
  createdAt: string;
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

function NewOrgModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState({
    name: "",
    slug: "",
    email: "",
    phone: "",
    address: "",
    website: "",
    logoUrl: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleNameChange = (name: string) => {
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .slice(0, 60);
    setForm((prev) => ({ ...prev, name, slug }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await apiFetch("/api/admin/organizations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name,
          slug: form.slug,
          email: form.email || null,
          phone: form.phone || null,
          address: form.address || null,
          website: form.website || null,
          logoUrl: form.logoUrl || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to create organization");
        return;
      }
      onCreated();
      onClose();
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-lg">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="font-display font-semibold text-foreground">New Organization</h2>
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
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2 space-y-1">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Company Name *</label>
              <input
                required
                value={form.name}
                onChange={(e) => handleNameChange(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-secondary border border-border text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                placeholder="Acme Sign Co."
              />
            </div>
            <div className="col-span-2 space-y-1">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Slug *</label>
              <input
                required
                pattern="^[a-z0-9-]+$"
                value={form.slug}
                onChange={(e) => setForm((p) => ({ ...p, slug: e.target.value }))}
                className="w-full px-3 py-2 rounded-lg bg-secondary border border-border text-sm text-foreground font-mono focus:outline-none focus:ring-2 focus:ring-primary/50"
                placeholder="acme-sign-co"
              />
              <p className="text-[10px] text-muted-foreground">Lowercase letters, numbers, hyphens only</p>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Email</label>
              <input
                type="email"
                value={form.email}
                onChange={(e) => setForm((p) => ({ ...p, email: e.target.value }))}
                className="w-full px-3 py-2 rounded-lg bg-secondary border border-border text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                placeholder="admin@acme.com"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Phone</label>
              <input
                value={form.phone}
                onChange={(e) => setForm((p) => ({ ...p, phone: e.target.value }))}
                className="w-full px-3 py-2 rounded-lg bg-secondary border border-border text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                placeholder="+1 555 000 0000"
              />
            </div>
            <div className="col-span-2 space-y-1">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Address</label>
              <input
                value={form.address}
                onChange={(e) => setForm((p) => ({ ...p, address: e.target.value }))}
                className="w-full px-3 py-2 rounded-lg bg-secondary border border-border text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                placeholder="123 Main St, City, ST 00000"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Website</label>
              <input
                value={form.website}
                onChange={(e) => setForm((p) => ({ ...p, website: e.target.value }))}
                className="w-full px-3 py-2 rounded-lg bg-secondary border border-border text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                placeholder="https://acme.com"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Logo URL</label>
              <input
                value={form.logoUrl}
                onChange={(e) => setForm((p) => ({ ...p, logoUrl: e.target.value }))}
                className="w-full px-3 py-2 rounded-lg bg-secondary border border-border text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                placeholder="https://…/logo.png"
              />
            </div>
          </div>
          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2 rounded-lg border border-border text-sm font-medium text-muted-foreground hover:bg-secondary transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="flex-1 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
            >
              {loading ? "Creating…" : "Create Organization"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function OrgRow({ org }: { org: Organization }) {
  const [expanded, setExpanded] = useState(false);

  const membersQuery = useQuery({
    queryKey: ["admin-org-members", org.id],
    queryFn: async () => {
      const res = await apiFetch(`/api/admin/organizations/${org.id}/members`);
      if (!res.ok) throw new Error("Failed to load members");
      return res.json() as Promise<{ members: Member[] }>;
    },
    enabled: expanded,
  });

  return (
    <>
      <tr className="border-b border-border hover:bg-secondary/20 transition-colors">
        <td className="px-4 py-3">
          <div className="flex items-center gap-3">
            {org.logoUrl ? (
              <img src={org.logoUrl} alt={org.name} className="w-7 h-7 rounded object-contain bg-secondary" />
            ) : (
              <div className="w-7 h-7 rounded bg-primary/10 flex items-center justify-center flex-shrink-0">
                <Building2 className="w-3.5 h-3.5 text-primary" />
              </div>
            )}
            <div>
              <p className="text-sm font-medium text-foreground">{org.name}</p>
              <p className="text-[10px] font-mono text-muted-foreground">{org.slug}</p>
            </div>
          </div>
        </td>
        <td className="px-4 py-3 text-xs text-muted-foreground">{org.email ?? "—"}</td>
        <td className="px-4 py-3">
          {org.onboardingComplete ? (
            <span className="inline-flex items-center gap-1 text-xs text-green-400">
              <Check className="w-3 h-3" /> Complete
            </span>
          ) : (
            <span className="text-xs text-amber-400">Pending</span>
          )}
        </td>
        <td className="px-4 py-3 text-xs text-muted-foreground">
          {format(new Date(org.createdAt), "MMM d, yyyy")}
        </td>
        <td className="px-4 py-3">
          <button
            onClick={() => setExpanded((v) => !v)}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <Users className="w-3.5 h-3.5" />
            Members
            {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          </button>
        </td>
      </tr>
      {expanded && (
        <tr className="border-b border-border bg-secondary/10">
          <td colSpan={5} className="px-8 py-3">
            {membersQuery.isLoading ? (
              <p className="text-xs text-muted-foreground">Loading members…</p>
            ) : membersQuery.isError ? (
              <p className="text-xs text-destructive">Failed to load members</p>
            ) : membersQuery.data?.members.length === 0 ? (
              <p className="text-xs text-muted-foreground italic">No members yet</p>
            ) : (
              <div className="space-y-1.5">
                {membersQuery.data?.members.map((m) => (
                  <div key={m.id} className="flex items-center gap-3 text-xs">
                    <div className="w-6 h-6 rounded-full bg-primary/20 text-primary text-[10px] font-bold flex items-center justify-center flex-shrink-0">
                      {(m.fullName ?? m.email ?? "?")[0]?.toUpperCase()}
                    </div>
                    <span className="text-foreground font-medium w-36 truncate">{m.fullName ?? "—"}</span>
                    <span className="text-muted-foreground w-44 truncate">{m.email ?? "—"}</span>
                    <RoleBadge role={m.role} />
                  </div>
                ))}
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

type Tab = "organizations" | "users";

export default function AdminPanel() {
  const [tab, setTab] = useState<Tab>("organizations");
  const [showNewOrg, setShowNewOrg] = useState(false);
  const queryClient = useQueryClient();

  const orgsQuery = useQuery({
    queryKey: ["admin-organizations"],
    queryFn: async () => {
      const res = await apiFetch("/api/admin/organizations");
      if (!res.ok) throw new Error("Failed to load organizations");
      return res.json() as Promise<{ organizations: Organization[] }>;
    },
  });

  const usersQuery = useQuery({
    queryKey: ["admin-all-users"],
    queryFn: async () => {
      const res = await apiFetch("/api/admin/users");
      if (!res.ok) throw new Error("Failed to load users");
      return res.json() as Promise<{ users: Member[] }>;
    },
    enabled: tab === "users",
  });

  return (
    <AppShell>
      <div className="flex-1 p-8 max-w-6xl mx-auto w-full">
        <header className="mb-8">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-8 h-8 rounded-lg bg-purple-900/30 border border-purple-700/40 flex items-center justify-center">
              <Building2 className="w-4 h-4 text-purple-400" />
            </div>
            <h1 className="text-2xl font-display font-bold text-foreground">Super Admin Panel</h1>
          </div>
          <p className="text-sm text-muted-foreground ml-11">
            Platform-wide organization and user management
          </p>
        </header>

        {/* Stats */}
        <div className="grid grid-cols-2 gap-4 mb-8">
          <div className="bg-card border border-border rounded-xl p-4">
            <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Organizations</p>
            <p className="text-2xl font-display font-bold text-foreground">
              {orgsQuery.data?.organizations.length ?? "—"}
            </p>
          </div>
          <div className="bg-card border border-border rounded-xl p-4">
            <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Total Users</p>
            <p className="text-2xl font-display font-bold text-foreground">
              {usersQuery.data?.users.length ?? "—"}
            </p>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-1 mb-6 border-b border-border">
          {(["organizations", "users"] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-2 text-sm font-medium capitalize transition-colors border-b-2 -mb-px ${
                tab === t
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {t}
            </button>
          ))}
          <div className="ml-auto flex items-center gap-2 pb-2">
            {tab === "organizations" && (
              <button
                onClick={() => setShowNewOrg(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors"
              >
                <Plus className="w-3.5 h-3.5" />
                New Organization
              </button>
            )}
            <button
              onClick={() => {
                queryClient.invalidateQueries({ queryKey: ["admin-organizations"] });
                queryClient.invalidateQueries({ queryKey: ["admin-all-users"] });
              }}
              className="p-1.5 rounded-lg text-muted-foreground hover:bg-secondary transition-colors"
              title="Refresh"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Organizations table */}
        {tab === "organizations" && (
          <div className="bg-card border border-border rounded-xl overflow-hidden">
            {orgsQuery.isLoading ? (
              <div className="p-8 text-center text-muted-foreground text-sm">Loading…</div>
            ) : orgsQuery.isError ? (
              <div className="p-8 text-center text-destructive text-sm flex items-center justify-center gap-2">
                <AlertCircle className="w-4 h-4" />
                Failed to load organizations
              </div>
            ) : (
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border bg-secondary/30">
                    <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Organization</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Email</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Onboarding</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Created</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider"></th>
                  </tr>
                </thead>
                <tbody>
                  {orgsQuery.data?.organizations.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-4 py-8 text-center text-sm text-muted-foreground italic">
                        No organizations yet
                      </td>
                    </tr>
                  ) : (
                    orgsQuery.data?.organizations.map((org) => (
                      <OrgRow key={org.id} org={org} />
                    ))
                  )}
                </tbody>
              </table>
            )}
          </div>
        )}

        {/* Users table */}
        {tab === "users" && (
          <div className="bg-card border border-border rounded-xl overflow-hidden">
            {usersQuery.isLoading ? (
              <div className="p-8 text-center text-muted-foreground text-sm">Loading…</div>
            ) : usersQuery.isError ? (
              <div className="p-8 text-center text-destructive text-sm flex items-center justify-center gap-2">
                <AlertCircle className="w-4 h-4" />
                Failed to load users
              </div>
            ) : (
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border bg-secondary/30">
                    <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Name</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Email</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Role</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Organization</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Joined</th>
                  </tr>
                </thead>
                <tbody>
                  {usersQuery.data?.users.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-4 py-8 text-center text-sm text-muted-foreground italic">
                        No users found
                      </td>
                    </tr>
                  ) : (
                    usersQuery.data?.users.map((u) => (
                      <tr key={u.id} className="border-b border-border hover:bg-secondary/20 transition-colors">
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <div className="w-6 h-6 rounded-full bg-primary/20 text-primary text-[10px] font-bold flex items-center justify-center flex-shrink-0">
                              {(u.fullName ?? u.email ?? "?")[0]?.toUpperCase()}
                            </div>
                            <span className="text-sm text-foreground">{u.fullName ?? "—"}</span>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-xs text-muted-foreground">{u.email ?? "—"}</td>
                        <td className="px-4 py-3"><RoleBadge role={u.role} /></td>
                        <td className="px-4 py-3">
                          <div>
                            <p className="text-xs text-foreground">{u.orgName ?? "—"}</p>
                            {u.orgSlug && <p className="text-[10px] font-mono text-muted-foreground">{u.orgSlug}</p>}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-xs text-muted-foreground">
                          {format(new Date(u.createdAt), "MMM d, yyyy")}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>

      {showNewOrg && (
        <NewOrgModal
          onClose={() => setShowNewOrg(false)}
          onCreated={() => queryClient.invalidateQueries({ queryKey: ["admin-organizations"] })}
        />
      )}
    </AppShell>
  );
}
