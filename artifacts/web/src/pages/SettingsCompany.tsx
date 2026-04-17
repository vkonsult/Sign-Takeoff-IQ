import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AdminShell } from "@/components/layout/AdminShell";
import { apiFetch } from "@/lib/apiClient";
import { Save, AlertCircle, CheckCircle2, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";

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

async function uploadLogoFile(file: File): Promise<string> {
  const formData = new FormData();
  formData.append("logo", file);
  const res = await apiFetch("/api/admin/logo", { method: "POST", body: formData });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "Logo upload failed");
  return data.url as string;
}

export default function SettingsCompany() {
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

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
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const [logoUploading, setLogoUploading] = useState(false);
  const [logoError, setLogoError] = useState<string | null>(null);
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
      setLogoPreview(org.logoUrl ?? null);
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

  const handleLogoFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setLogoError(null);
    setLogoUploading(true);
    try {
      const url = await uploadLogoFile(file);
      setForm((p) => ({ ...p, logoUrl: url }));
      setLogoPreview(url);
    } catch (err) {
      setLogoError((err as Error).message);
    } finally {
      setLogoUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setSaveStatus("saving");
    setSaveError(null);
    saveMutation.mutate();
  };

  const org = orgQuery.data?.organization;

  return (
    <AdminShell section="tenant">
      <div className="flex-1 p-8 max-w-2xl">
        <header className="mb-6">
          <h1 className="text-xl font-display font-bold text-foreground">Company Profile</h1>
          <p className="text-sm text-muted-foreground">
            Manage your organization's information and branding
          </p>
        </header>

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
          <div className="space-y-5">
            {/* Logo section */}
            <div className="bg-card border border-border rounded-xl p-5">
              <h2 className="text-sm font-semibold text-foreground mb-4">Company Logo</h2>
              <div className="flex items-center gap-4">
                <div className="w-16 h-16 rounded-xl border border-border bg-secondary flex items-center justify-center flex-shrink-0 overflow-hidden">
                  {logoPreview ? (
                    <img src={logoPreview} alt="Logo" className="w-full h-full object-contain p-1" />
                  ) : (
                    <span className="text-2xl font-display font-bold text-muted-foreground">
                      {(form.name || org?.name || "?")[0]?.toUpperCase()}
                    </span>
                  )}
                </div>
                <div className="flex-1 space-y-2">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={logoUploading}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border text-xs font-medium text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors disabled:opacity-50"
                    >
                      <Upload className="w-3.5 h-3.5" />
                      {logoUploading ? "Uploading…" : "Upload Image"}
                    </button>
                    {form.logoUrl && (
                      <button
                        type="button"
                        onClick={() => {
                          setForm((p) => ({ ...p, logoUrl: "" }));
                          setLogoPreview(null);
                        }}
                        className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs text-muted-foreground hover:text-destructive transition-colors"
                      >
                        <X className="w-3 h-3" /> Remove
                      </button>
                    )}
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/*"
                      aria-label="Upload company logo image"
                      onChange={handleLogoFileChange}
                      className="hidden"
                    />
                  </div>
                  <div className="space-y-1">
                    <label htmlFor="logo-url" className="text-[10px] text-muted-foreground">Or paste a URL:</label>
                    <input
                      id="logo-url"
                      value={form.logoUrl}
                      onChange={(e) => {
                        setForm((p) => ({ ...p, logoUrl: e.target.value }));
                        setLogoPreview(e.target.value || null);
                      }}
                      className="w-full px-2 py-1.5 rounded-lg bg-secondary border border-border text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
                      placeholder="https://…/logo.png"
                    />
                  </div>
                  {logoError && <p className="text-xs text-destructive">{logoError}</p>}
                </div>
              </div>
            </div>

            {/* Main form */}
            <form onSubmit={handleSubmit} className="bg-card border border-border rounded-xl p-5 space-y-4">
              <h2 className="text-sm font-semibold text-foreground border-b border-border pb-3">
                Organization Information
              </h2>
              <div className="space-y-1">
                <label htmlFor="company-name" className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Company Name *
                </label>
                <input
                  id="company-name"
                  required
                  value={form.name}
                  onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                  className="w-full px-3 py-2.5 rounded-lg bg-secondary border border-border text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label htmlFor="company-email" className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    Contact Email
                  </label>
                  <input id="company-email" type="email" value={form.email}
                    onChange={(e) => setForm((p) => ({ ...p, email: e.target.value }))}
                    className="w-full px-3 py-2.5 rounded-lg bg-secondary border border-border text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                    placeholder="contact@company.com" />
                </div>
                <div className="space-y-1">
                  <label htmlFor="company-phone" className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Phone</label>
                  <input id="company-phone" value={form.phone}
                    onChange={(e) => setForm((p) => ({ ...p, phone: e.target.value }))}
                    className="w-full px-3 py-2.5 rounded-lg bg-secondary border border-border text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                    placeholder="+1 555 000 0000" />
                </div>
              </div>
              <div className="space-y-1">
                <label htmlFor="company-address" className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Address</label>
                <input id="company-address" value={form.address}
                  onChange={(e) => setForm((p) => ({ ...p, address: e.target.value }))}
                  className="w-full px-3 py-2.5 rounded-lg bg-secondary border border-border text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                  placeholder="123 Main St, City, ST 00000" />
              </div>
              <div className="space-y-1">
                <label htmlFor="company-website" className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Website</label>
                <input id="company-website" value={form.website}
                  onChange={(e) => setForm((p) => ({ ...p, website: e.target.value }))}
                  className="w-full px-3 py-2.5 rounded-lg bg-secondary border border-border text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                  placeholder="https://company.com" />
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
                  Changes saved
                </div>
              )}
              <div className="flex justify-end">
                <Button type="submit" disabled={saveMutation.isPending} size="sm">
                  <Save className="w-3.5 h-3.5" />
                  {saveMutation.isPending ? "Saving…" : "Save Changes"}
                </Button>
              </div>
            </form>

            {/* Metadata */}
            <div className="bg-card border border-border rounded-xl p-4">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Organization Details</h3>
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div>
                  <p className="text-muted-foreground">Slug</p>
                  <p className="font-mono text-foreground">{org?.slug}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">Created</p>
                  <p className="text-foreground">{org?.createdAt ? new Date(org.createdAt).toLocaleDateString() : "—"}</p>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </AdminShell>
  );
}
