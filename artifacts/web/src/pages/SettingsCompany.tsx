import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AppShell } from "@/components/layout/Shell";
import { apiFetch } from "@/lib/apiClient";
import { Building2, Save, AlertCircle, CheckCircle2, Users } from "lucide-react";
import { Link } from "wouter";

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
  updatedAt: string;
};

export default function SettingsCompany() {
  const queryClient = useQueryClient();

  const orgQuery = useQuery({
    queryKey: ["admin-org"],
    queryFn: async () => {
      const res = await apiFetch("/api/admin/org");
      if (!res.ok) throw new Error("Failed to load organization");
      return res.json() as Promise<{ organization: Organization }>;
    },
  });

  const [form, setForm] = useState({
    name: "",
    email: "",
    phone: "",
    address: "",
    website: "",
    logoUrl: "",
  });
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    const org = orgQuery.data?.organization;
    if (org) {
      setForm({
        name: org.name ?? "",
        email: org.email ?? "",
        phone: org.phone ?? "",
        address: org.address ?? "",
        website: org.website ?? "",
        logoUrl: org.logoUrl ?? "",
      });
    }
  }, [orgQuery.data]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const res = await apiFetch("/api/admin/org", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name || undefined,
          email: form.email || null,
          phone: form.phone || null,
          address: form.address || null,
          website: form.website || null,
          logoUrl: form.logoUrl || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to save");
      return data;
    },
    onSuccess: () => {
      setSaveStatus("saved");
      setSaveError(null);
      queryClient.invalidateQueries({ queryKey: ["admin-org"] });
      setTimeout(() => setSaveStatus("idle"), 3000);
    },
    onError: (e: Error) => {
      setSaveStatus("error");
      setSaveError(e.message);
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setSaveStatus("saving");
    setSaveError(null);
    saveMutation.mutate();
  };

  const org = orgQuery.data?.organization;

  return (
    <AppShell>
      <div className="flex-1 p-8 max-w-3xl mx-auto w-full">
        <header className="mb-8">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-8 h-8 rounded-lg bg-secondary border border-border flex items-center justify-center">
              <Building2 className="w-4 h-4 text-muted-foreground" />
            </div>
            <h1 className="text-2xl font-display font-bold text-foreground">Company Settings</h1>
          </div>
          <p className="text-sm text-muted-foreground ml-11">
            Manage your organization's profile and contact information
          </p>
        </header>

        {/* Settings nav */}
        <div className="flex gap-1 mb-8 border-b border-border">
          <Link
            href="/settings"
            className="px-4 py-2 text-sm font-medium border-b-2 border-primary text-foreground -mb-px"
          >
            Company
          </Link>
          <Link
            href="/settings/users"
            className="px-4 py-2 text-sm font-medium border-b-2 border-transparent text-muted-foreground hover:text-foreground transition-colors -mb-px"
          >
            <span className="flex items-center gap-1.5">
              <Users className="w-3.5 h-3.5" />
              Users
            </span>
          </Link>
        </div>

        {orgQuery.isLoading ? (
          <div className="bg-card border border-border rounded-xl p-8">
            <div className="animate-pulse space-y-4">
              <div className="h-4 bg-secondary rounded w-48" />
              <div className="h-10 bg-secondary rounded" />
              <div className="h-10 bg-secondary rounded" />
            </div>
          </div>
        ) : orgQuery.isError ? (
          <div className="bg-card border border-border rounded-xl p-8 flex items-center gap-2 text-destructive">
            <AlertCircle className="w-4 h-4" />
            <span className="text-sm">Failed to load organization settings</span>
          </div>
        ) : (
          <div className="space-y-6">
            {/* Logo preview */}
            {org?.logoUrl && (
              <div className="bg-card border border-border rounded-xl p-4 flex items-center gap-4">
                <img
                  src={org.logoUrl}
                  alt="Company logo"
                  className="h-12 w-auto object-contain rounded"
                />
                <div>
                  <p className="text-sm font-medium text-foreground">{org.name}</p>
                  <p className="text-xs font-mono text-muted-foreground">{org.slug}</p>
                </div>
              </div>
            )}

            <form onSubmit={handleSubmit} className="bg-card border border-border rounded-xl p-6 space-y-5">
              <h2 className="text-sm font-semibold text-foreground border-b border-border pb-3">
                Organization Information
              </h2>

              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Company Name *
                </label>
                <input
                  required
                  value={form.name}
                  onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                  className="w-full px-3 py-2.5 rounded-lg bg-secondary border border-border text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    Contact Email
                  </label>
                  <input
                    type="email"
                    value={form.email}
                    onChange={(e) => setForm((p) => ({ ...p, email: e.target.value }))}
                    className="w-full px-3 py-2.5 rounded-lg bg-secondary border border-border text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                    placeholder="contact@company.com"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    Phone
                  </label>
                  <input
                    value={form.phone}
                    onChange={(e) => setForm((p) => ({ ...p, phone: e.target.value }))}
                    className="w-full px-3 py-2.5 rounded-lg bg-secondary border border-border text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                    placeholder="+1 555 000 0000"
                  />
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Address
                </label>
                <input
                  value={form.address}
                  onChange={(e) => setForm((p) => ({ ...p, address: e.target.value }))}
                  className="w-full px-3 py-2.5 rounded-lg bg-secondary border border-border text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                  placeholder="123 Main St, City, ST 00000"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    Website
                  </label>
                  <input
                    value={form.website}
                    onChange={(e) => setForm((p) => ({ ...p, website: e.target.value }))}
                    className="w-full px-3 py-2.5 rounded-lg bg-secondary border border-border text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                    placeholder="https://company.com"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    Logo URL
                  </label>
                  <input
                    value={form.logoUrl}
                    onChange={(e) => setForm((p) => ({ ...p, logoUrl: e.target.value }))}
                    className="w-full px-3 py-2.5 rounded-lg bg-secondary border border-border text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                    placeholder="https://…/logo.png"
                  />
                </div>
              </div>

              {saveError && (
                <div className="flex items-center gap-2 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-lg px-3 py-2">
                  <AlertCircle className="w-4 h-4 flex-shrink-0" />
                  {saveError}
                </div>
              )}
              {saveStatus === "saved" && (
                <div className="flex items-center gap-2 text-sm text-green-400 bg-green-900/10 border border-green-700/20 rounded-lg px-3 py-2">
                  <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
                  Changes saved successfully
                </div>
              )}

              <div className="flex justify-end pt-2">
                <button
                  type="submit"
                  disabled={saveMutation.isPending}
                  className="flex items-center gap-2 px-5 py-2.5 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
                >
                  <Save className="w-3.5 h-3.5" />
                  {saveMutation.isPending ? "Saving…" : "Save Changes"}
                </button>
              </div>
            </form>

            {/* Org metadata */}
            <div className="bg-card border border-border rounded-xl p-4 space-y-2">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Organization Details
              </h3>
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div>
                  <p className="text-muted-foreground">Slug</p>
                  <p className="font-mono text-foreground">{org?.slug}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">Created</p>
                  <p className="text-foreground">
                    {org?.createdAt
                      ? new Date(org.createdAt).toLocaleDateString()
                      : "—"}
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </AppShell>
  );
}
