import { useState, useRef } from "react";
import { useLocation } from "wouter";
import { apiFetch } from "@/lib/apiClient";
import { Upload, CheckCircle2, X, ArrowRight } from "lucide-react";

async function uploadLogoFile(file: File): Promise<string> {
  const formData = new FormData();
  formData.append("logo", file);
  const res = await apiFetch("/api/admin/logo", { method: "POST", body: formData });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "Logo upload failed");
  return data.url as string;
}

export default function OnboardingPage() {
  const [, navigate] = useLocation();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState<1 | 2>(1);
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
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
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
          onboardingComplete: true,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to save");
        setSaving(false);
        return;
      }
      setStep(2);
    } catch {
      setError("Network error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-6">
      <div className="w-full max-w-lg">
        {/* Step indicator */}
        <div className="flex items-center justify-center gap-3 mb-8">
          {[1, 2].map((s) => (
            <div key={s} className="flex items-center gap-2">
              <div
                className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold border-2 transition-colors ${
                  step > s
                    ? "bg-primary border-primary text-primary-foreground"
                    : step === s
                      ? "border-primary text-primary bg-transparent"
                      : "border-border text-muted-foreground"
                }`}
              >
                {step > s ? <CheckCircle2 className="w-3.5 h-3.5" /> : s}
              </div>
              {s < 2 && <div className={`w-12 h-px ${step > s ? "bg-primary" : "bg-border"}`} />}
            </div>
          ))}
        </div>

        {step === 1 && (
          <div className="bg-card border border-border rounded-2xl shadow-lg overflow-hidden">
            <div className="px-8 pt-8 pb-6 border-b border-border">
              <div className="flex items-center gap-3 mb-1">
                <div className="w-8 h-8 rounded bg-primary flex items-center justify-center flex-shrink-0">
                  <svg viewBox="0 0 24 24" fill="none" className="w-4 h-4 stroke-white" strokeWidth="2">
                    <path d="M4 22L20 2" strokeLinecap="round" />
                    <path d="M4 12L12 4" strokeLinecap="round" />
                    <path d="M12 20L20 12" strokeLinecap="round" />
                  </svg>
                </div>
                <div>
                  <h1 className="text-lg font-display font-bold text-foreground">Set Up Your Company</h1>
                  <p className="text-xs text-muted-foreground">Step 1 of 2 — Company profile</p>
                </div>
              </div>
            </div>

            <div className="p-8 space-y-5">
              {/* Logo */}
              <div>
                <label className="block text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
                  Company Logo
                </label>
                <div className="flex items-center gap-4">
                  <div className="w-14 h-14 rounded-xl border border-border bg-secondary flex items-center justify-center flex-shrink-0 overflow-hidden">
                    {logoPreview ? (
                      <img src={logoPreview} alt="Logo" className="w-full h-full object-contain p-1" />
                    ) : (
                      <span className="text-xl font-display font-bold text-muted-foreground">
                        {(form.name || "?")[0]?.toUpperCase()}
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
                        {logoUploading ? "Uploading…" : "Upload Logo"}
                      </button>
                      {form.logoUrl && (
                        <button type="button"
                          onClick={() => { setForm((p) => ({ ...p, logoUrl: "" })); setLogoPreview(null); }}
                          className="p-1 rounded text-muted-foreground hover:text-destructive transition-colors">
                          <X className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                    <input
                      value={form.logoUrl}
                      onChange={(e) => { setForm((p) => ({ ...p, logoUrl: e.target.value })); setLogoPreview(e.target.value || null); }}
                      className="w-full px-2 py-1.5 rounded-lg bg-secondary border border-border text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
                      placeholder="or paste a logo URL…"
                    />
                    {logoError && <p className="text-xs text-destructive">{logoError}</p>}
                    <input ref={fileInputRef} type="file" accept="image/*" onChange={handleLogoFileChange} className="hidden" />
                  </div>
                </div>
              </div>

              {/* Company name */}
              <div className="space-y-1">
                <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  Company Name *
                </label>
                <input required value={form.name}
                  onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                  className="w-full px-3 py-2.5 rounded-lg bg-secondary border border-border text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                  placeholder="Acme Sign & Display" />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Email</label>
                  <input type="email" value={form.email}
                    onChange={(e) => setForm((p) => ({ ...p, email: e.target.value }))}
                    className="w-full px-3 py-2.5 rounded-lg bg-secondary border border-border text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                    placeholder="contact@co.com" />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Phone</label>
                  <input value={form.phone}
                    onChange={(e) => setForm((p) => ({ ...p, phone: e.target.value }))}
                    className="w-full px-3 py-2.5 rounded-lg bg-secondary border border-border text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                    placeholder="+1 555-000-0000" />
                </div>
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Address</label>
                <input value={form.address}
                  onChange={(e) => setForm((p) => ({ ...p, address: e.target.value }))}
                  className="w-full px-3 py-2.5 rounded-lg bg-secondary border border-border text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                  placeholder="123 Main St, City, ST 00000" />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Website</label>
                <input value={form.website}
                  onChange={(e) => setForm((p) => ({ ...p, website: e.target.value }))}
                  className="w-full px-3 py-2.5 rounded-lg bg-secondary border border-border text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                  placeholder="https://company.com" />
              </div>

              {error && (
                <p className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-lg px-3 py-2">
                  {error}
                </p>
              )}

              <button
                onClick={handleSave}
                disabled={saving || !form.name.trim() || logoUploading}
                className="w-full flex items-center justify-center gap-2 py-3 bg-primary text-primary-foreground rounded-xl text-sm font-semibold hover:bg-primary/90 transition-colors disabled:opacity-50 mt-2"
              >
                {saving ? "Saving…" : "Continue"}
                {!saving && <ArrowRight className="w-4 h-4" />}
              </button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="bg-card border border-border rounded-2xl shadow-lg p-8 text-center space-y-5">
            <div className="w-14 h-14 rounded-full bg-green-900/30 flex items-center justify-center mx-auto">
              <CheckCircle2 className="w-7 h-7 text-green-400" />
            </div>
            <div>
              <h2 className="text-xl font-display font-bold text-foreground mb-1">You're all set!</h2>
              <p className="text-sm text-muted-foreground">
                {form.name || "Your company"} is ready to start processing sign takeoffs.
              </p>
            </div>
            <div className="bg-secondary/50 rounded-xl border border-border p-4 text-left space-y-2">
              <p className="text-sm font-medium text-foreground">What you can do now:</p>
              <ul className="space-y-1 text-xs text-muted-foreground">
                <li>• Upload architectural PDF plans to extract sign data</li>
                <li>• AI scans text and visuals to find every sign</li>
                <li>• Review results in the interactive table</li>
                <li>• Export to Excel for your estimating workflow</li>
              </ul>
            </div>
            <button
              onClick={() => navigate("/jobs")}
              className="w-full py-3 bg-primary text-primary-foreground rounded-xl text-sm font-semibold hover:bg-primary/90 transition-colors"
            >
              Go to Dashboard
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
