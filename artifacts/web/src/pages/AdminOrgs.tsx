import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AdminShell } from "@/components/layout/AdminShell";
import { apiFetch } from "@/lib/apiClient";
import { format } from "date-fns";
import {
  Building2,
  Plus,
  ChevronDown,
  ChevronUp,
  X,
  Check,
  AlertCircle,
  RefreshCw,
  Users,
  Copy,
  CheckCircle2,
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
  jobCount: number;
  createdAt: string;
};

type Member = {
  id: string;
  clerkUserId: string;
  fullName: string | null;
  email: string | null;
  role: string;
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

type NewOrgResult = {
  organization: Organization;
  ownerMembership: Member | null;
  ownerTempPassword: string | null;
};

function TempPasswordModal({ result, onClose }: { result: NewOrgResult; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = (text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-sm">
        <div className="p-6 space-y-4">
          <div className="w-12 h-12 rounded-full bg-green-900/30 flex items-center justify-center mx-auto">
            <CheckCircle2 className="w-6 h-6 text-green-400" />
          </div>
          <h2 className="font-display font-semibold text-foreground text-center">
            Organization Created!
          </h2>
          <p className="text-sm text-muted-foreground text-center">
            <strong className="text-foreground">{result.organization.name}</strong> is ready.
          </p>
          {result.ownerTempPassword && result.ownerMembership && (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                Owner <strong className="text-foreground">{result.ownerMembership.email}</strong> was provisioned.
                Share this temporary password:
              </p>
              <div className="flex items-center gap-2 bg-secondary rounded-lg px-3 py-2">
                <code className="flex-1 text-sm font-mono text-foreground break-all">
                  {result.ownerTempPassword}
                </code>
                <button onClick={() => copy(result.ownerTempPassword!)} className="text-muted-foreground hover:text-foreground flex-shrink-0">
                  {copied ? <CheckCircle2 className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
                </button>
              </div>
              <p className="text-xs text-amber-400">This password will not be shown again.</p>
            </div>
          )}
          <button
            onClick={onClose}
            className="w-full px-4 py-2.5 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

function NewOrgModal({ onClose, onCreated }: { onClose: () => void; onCreated: (result: NewOrgResult) => void }) {
  const [form, setForm] = useState({
    name: "",
    slug: "",
    email: "",
    phone: "",
    address: "",
    website: "",
    logoUrl: "",
    ownerFirstName: "",
    ownerLastName: "",
    ownerEmail: "",
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
      const body: Record<string, string | null> = {
        name: form.name,
        slug: form.slug,
        email: form.email || null,
        phone: form.phone || null,
        address: form.address || null,
        website: form.website || null,
        logoUrl: form.logoUrl || null,
      };
      if (form.ownerEmail) {
        body.ownerFirstName = form.ownerFirstName || null;
        body.ownerLastName = form.ownerLastName || null;
        body.ownerEmail = form.ownerEmail || null;
      }
      const res = await apiFetch("/api/admin/organizations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to create organization");
        return;
      }
      onCreated(data as NewOrgResult);
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border sticky top-0 bg-card">
          <h2 className="font-display font-semibold text-foreground">New Organization</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="p-6 space-y-5">
          {error && (
            <div className="flex items-center gap-2 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-lg px-3 py-2">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              {error}
            </div>
          )}

          <div>
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
              Organization Info
            </h3>
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2 space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Company Name *</label>
                <input required value={form.name} onChange={(e) => handleNameChange(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-secondary border border-border text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                  placeholder="Acme Sign Co." />
              </div>
              <div className="col-span-2 space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Slug *</label>
                <input required pattern="^[a-z0-9-]+$" value={form.slug} onChange={(e) => setForm((p) => ({ ...p, slug: e.target.value }))}
                  className="w-full px-3 py-2 rounded-lg bg-secondary border border-border text-sm font-mono text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                  placeholder="acme-sign-co" />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Email</label>
                <input type="email" value={form.email} onChange={(e) => setForm((p) => ({ ...p, email: e.target.value }))}
                  className="w-full px-3 py-2 rounded-lg bg-secondary border border-border text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                  placeholder="admin@acme.com" />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Phone</label>
                <input value={form.phone} onChange={(e) => setForm((p) => ({ ...p, phone: e.target.value }))}
                  className="w-full px-3 py-2 rounded-lg bg-secondary border border-border text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                  placeholder="+1 555 000 0000" />
              </div>
              <div className="col-span-2 space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Logo URL</label>
                <input value={form.logoUrl} onChange={(e) => setForm((p) => ({ ...p, logoUrl: e.target.value }))}
                  className="w-full px-3 py-2 rounded-lg bg-secondary border border-border text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                  placeholder="https://…/logo.png" />
              </div>
            </div>
          </div>

          <div className="border-t border-border pt-4">
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
              Owner Account <span className="font-normal normal-case">(optional)</span>
            </h3>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">First Name</label>
                <input value={form.ownerFirstName} onChange={(e) => setForm((p) => ({ ...p, ownerFirstName: e.target.value }))}
                  className="w-full px-3 py-2 rounded-lg bg-secondary border border-border text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                  placeholder="Jane" />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Last Name</label>
                <input value={form.ownerLastName} onChange={(e) => setForm((p) => ({ ...p, ownerLastName: e.target.value }))}
                  className="w-full px-3 py-2 rounded-lg bg-secondary border border-border text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                  placeholder="Smith" />
              </div>
              <div className="col-span-2 space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Owner Email</label>
                <input type="email" value={form.ownerEmail} onChange={(e) => setForm((p) => ({ ...p, ownerEmail: e.target.value }))}
                  className="w-full px-3 py-2 rounded-lg bg-secondary border border-border text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                  placeholder="owner@acme.com" />
                <p className="text-[10px] text-muted-foreground">
                  If provided, a Clerk account will be created with ADMIN role and a temporary password returned.
                </p>
              </div>
            </div>
          </div>

          <div className="flex gap-3 pt-1">
            <button type="button" onClick={onClose}
              className="flex-1 px-4 py-2 rounded-lg border border-border text-sm font-medium text-muted-foreground hover:bg-secondary transition-colors">
              Cancel
            </button>
            <button type="submit" disabled={loading}
              className="flex-1 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50">
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
        <td className="px-4 py-3 text-xs text-muted-foreground font-mono">{org.jobCount ?? 0}</td>
        <td className="px-4 py-3">
          {org.onboardingComplete ? (
            <span className="inline-flex items-center gap-1 text-xs text-green-400">
              <Check className="w-3 h-3" /> Done
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
            {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          </button>
        </td>
      </tr>
      {expanded && (
        <tr className="border-b border-border bg-secondary/10">
          <td colSpan={6} className="px-8 py-3">
            {membersQuery.isLoading ? (
              <p className="text-xs text-muted-foreground">Loading…</p>
            ) : membersQuery.isError ? (
              <p className="text-xs text-destructive">Failed to load members</p>
            ) : membersQuery.data?.members.length === 0 ? (
              <p className="text-xs text-muted-foreground italic">No members</p>
            ) : (
              <div className="space-y-1.5">
                {membersQuery.data?.members.map((m) => (
                  <div key={m.id} className="flex items-center gap-3 text-xs">
                    <div className="w-5 h-5 rounded-full bg-primary/20 text-primary text-[10px] font-bold flex items-center justify-center flex-shrink-0">
                      {(m.fullName ?? m.email ?? "?")[0]?.toUpperCase()}
                    </div>
                    <span className="text-foreground w-32 truncate">{m.fullName ?? "—"}</span>
                    <span className="text-muted-foreground w-40 truncate">{m.email ?? "—"}</span>
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

export default function AdminOrgs() {
  const [showNewOrg, setShowNewOrg] = useState(false);
  const [newOrgResult, setNewOrgResult] = useState<NewOrgResult | null>(null);
  const queryClient = useQueryClient();

  const orgsQuery = useQuery({
    queryKey: ["admin-organizations"],
    queryFn: async () => {
      const res = await apiFetch("/api/admin/organizations");
      if (!res.ok) throw new Error("Failed to load organizations");
      return res.json() as Promise<{ organizations: Organization[] }>;
    },
  });

  const orgs = orgsQuery.data?.organizations ?? [];

  return (
    <AdminShell section="super">
      <div className="flex-1 p-8">
        <header className="mb-6">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-xl font-display font-bold text-foreground">Organizations</h1>
              <p className="text-sm text-muted-foreground">{orgs.length} tenant{orgs.length !== 1 ? "s" : ""}</p>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => queryClient.invalidateQueries({ queryKey: ["admin-organizations"] })}
                className="p-2 rounded-lg text-muted-foreground hover:bg-secondary transition-colors"
                title="Refresh"
              >
                <RefreshCw className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => setShowNewOrg(true)}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
              >
                <Plus className="w-3.5 h-3.5" />
                New Organization
              </button>
            </div>
          </div>
        </header>

        {/* Stats row */}
        <div className="grid grid-cols-3 gap-4 mb-6">
          <div className="bg-card border border-border rounded-xl p-4">
            <p className="text-xs text-muted-foreground mb-1">Total Tenants</p>
            <p className="text-2xl font-display font-bold text-foreground">{orgs.length}</p>
          </div>
          <div className="bg-card border border-border rounded-xl p-4">
            <p className="text-xs text-muted-foreground mb-1">Onboarded</p>
            <p className="text-2xl font-display font-bold text-foreground">
              {orgs.filter((o) => o.onboardingComplete).length}
            </p>
          </div>
          <div className="bg-card border border-border rounded-xl p-4">
            <p className="text-xs text-muted-foreground mb-1">Total Jobs</p>
            <p className="text-2xl font-display font-bold text-foreground">
              {orgs.reduce((s, o) => s + (o.jobCount ?? 0), 0)}
            </p>
          </div>
        </div>

        <div className="bg-card border border-border rounded-xl overflow-hidden">
          {orgsQuery.isLoading ? (
            <div className="p-8 text-center text-muted-foreground text-sm">Loading…</div>
          ) : orgsQuery.isError ? (
            <div className="p-8 text-center text-destructive text-sm flex items-center justify-center gap-2">
              <AlertCircle className="w-4 h-4" /> Failed to load organizations
            </div>
          ) : (
            <table className="w-full">
              <thead>
                <tr className="border-b border-border bg-secondary/30">
                  <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Organization</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Email</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Jobs</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Onboarding</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Created</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Members</th>
                </tr>
              </thead>
              <tbody>
                {orgs.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-sm text-muted-foreground italic">
                      No organizations yet. Create the first one above.
                    </td>
                  </tr>
                ) : (
                  orgs.map((org) => <OrgRow key={org.id} org={org} />)
                )}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {showNewOrg && (
        <NewOrgModal
          onClose={() => setShowNewOrg(false)}
          onCreated={(result) => {
            setShowNewOrg(false);
            setNewOrgResult(result);
            queryClient.invalidateQueries({ queryKey: ["admin-organizations"] });
          }}
        />
      )}
      {newOrgResult && (
        <TempPasswordModal result={newOrgResult} onClose={() => setNewOrgResult(null)} />
      )}
    </AdminShell>
  );
}
