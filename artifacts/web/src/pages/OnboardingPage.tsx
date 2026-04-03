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

  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [companyInfo, setCompanyInfo] = useState({
    name: "",
    email: "",
    phone: "",
    address: "",
    website: "",
  });
  const [logoUrl, setLogoUrl] = useState("");
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const [logoUploading, setLogoUploading] = useState(false);
  const [logoError, setLogoError] = useState<string | null>(null);
  const [savingInfo, setSavingInfo] = useState(false);
  const [savingLogo, setSavingLogo] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleLogoFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setLogoError(null);
    setLogoUploading(true);
    try {
      const url = await uploadLogoFile(file);
      setLogoUrl(url);
      setLogoPreview(url);
    } catch (err) {
      setLogoError((err as Error).message);
    } finally {
      setLogoUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  // Step 1 → Step 2: Save company info (not complete yet)
  const handleSaveInfo = async () => {
    if (!companyInfo.name.trim()) return;
    setSavingInfo(true);
    setError(null);
    try {
      const res = await apiFetch("/api/admin/org", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: companyInfo.name,
          email: companyInfo.email || null,
          phone: companyInfo.phone || null,
          address: companyInfo.address || null,
          website: companyInfo.website || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to save company info");
        return;
      }
      setStep(2);
    } catch {
      setError("Network error");
    } finally {
      setSavingInfo(false);
    }
  };

  // Step 2 → Done: Save logo + mark onboarding complete
  const handleFinish = async (skipLogo = false) => {
    setSavingLogo(true);
    setError(null);
    try {
      const res = await apiFetch("/api/admin/org", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          logoUrl: skipLogo ? null : (logoUrl || null),
          onboardingComplete: true,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to complete setup");
        return;
      }
      // Auto-redirect to the dashboard on completion
      navigate("/jobs");
    } catch {
      setError("Network error");
    } finally {
      setSavingLogo(false);
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

        {/* ── Step 1: Company Info ── */}
        {step === 1 && (
          <div className="bg-card border border-border rounded-2xl shadow-lg overflow-hidden">
            <div className="px-8 pt-8 pb-5 border-b border-border">
              <div className="flex items-center gap-3 mb-1">
                <div className="w-8 h-8 rounded bg-primary flex items-center justify-center flex-shrink-0">
                  <svg viewBox="0 0 24 24" fill="none" className="w-4 h-4 stroke-white" strokeWidth="2">
                    <path d="M4 22L20 2" strokeLinecap="round" />
                    <path d="M4 12L12 4" strokeLinecap="round" />
                    <path d="M12 20L20 12" strokeLinecap="round" />
                  </svg>
                </div>
                <div>
                  <h1 className="text-lg font-display font-bold text-foreground">Company Info</h1>
                  <p className="text-xs text-muted-foreground">Step 1 of 2 — Tell us about your company</p>
                </div>
              </div>
            </div>

            <div className="p-8 space-y-4">
              <div className="space-y-1">
                <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Company Name *</label>
                <input required value={companyInfo.name}
                  onChange={(e) => setCompanyInfo((p) => ({ ...p, name: e.target.value }))}
                  className="w-full px-3 py-2.5 rounded-lg bg-secondary border border-border text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                  placeholder="Acme Sign & Display" />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Email</label>
                  <input type="email" value={companyInfo.email}
                    onChange={(e) => setCompanyInfo((p) => ({ ...p, email: e.target.value }))}
                    className="w-full px-3 py-2.5 rounded-lg bg-secondary border border-border text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                    placeholder="contact@co.com" />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Phone</label>
                  <input value={companyInfo.phone}
                    onChange={(e) => setCompanyInfo((p) => ({ ...p, phone: e.target.value }))}
                    className="w-full px-3 py-2.5 rounded-lg bg-secondary border border-border text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                    placeholder="+1 555-000-0000" />
                </div>
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Address</label>
                <input value={companyInfo.address}
                  onChange={(e) => setCompanyInfo((p) => ({ ...p, address: e.target.value }))}
                  className="w-full px-3 py-2.5 rounded-lg bg-secondary border border-border text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                  placeholder="123 Main St, City, ST 00000" />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Website</label>
                <input value={companyInfo.website}
                  onChange={(e) => setCompanyInfo((p) => ({ ...p, website: e.target.value }))}
                  className="w-full px-3 py-2.5 rounded-lg bg-secondary border border-border text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                  placeholder="https://company.com" />
              </div>

              {error && (
                <p className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-lg px-3 py-2">
                  {error}
                </p>
              )}

              <button
                onClick={handleSaveInfo}
                disabled={savingInfo || !companyInfo.name.trim()}
                className="w-full flex items-center justify-center gap-2 py-3 bg-primary text-primary-foreground rounded-xl text-sm font-semibold hover:bg-primary/90 transition-colors disabled:opacity-50 mt-2"
              >
                {savingInfo ? "Saving…" : "Continue"}
                {!savingInfo && <ArrowRight className="w-4 h-4" />}
              </button>
            </div>
          </div>
        )}

        {/* ── Step 2: Logo Upload ── */}
        {step === 2 && (
          <div className="bg-card border border-border rounded-2xl shadow-lg overflow-hidden">
            <div className="px-8 pt-8 pb-5 border-b border-border">
              <div className="flex items-center gap-3 mb-1">
                <div className="w-8 h-8 rounded bg-primary flex items-center justify-center flex-shrink-0">
                  <Upload className="w-4 h-4 text-white" />
                </div>
                <div>
                  <h1 className="text-lg font-display font-bold text-foreground">Company Logo</h1>
                  <p className="text-xs text-muted-foreground">Step 2 of 2 — Upload your logo (optional)</p>
                </div>
              </div>
            </div>

            <div className="p-8 space-y-5">
              {/* Logo preview */}
              <div className="flex flex-col items-center gap-4">
                <div className="w-24 h-24 rounded-2xl border-2 border-dashed border-border bg-secondary flex items-center justify-center overflow-hidden">
                  {logoPreview ? (
                    <img src={logoPreview} alt="Logo preview" className="w-full h-full object-contain p-2" />
                  ) : (
                    <div className="text-center">
                      <Upload className="w-6 h-6 text-muted-foreground mx-auto mb-1" />
                      <p className="text-[10px] text-muted-foreground">No logo</p>
                    </div>
                  )}
                </div>

                <div className="space-y-3 w-full">
                  <div className="flex items-center justify-center gap-2">
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={logoUploading}
                      className="flex items-center gap-1.5 px-4 py-2 rounded-lg border border-border text-sm font-medium text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors disabled:opacity-50"
                    >
                      <Upload className="w-3.5 h-3.5" />
                      {logoUploading ? "Uploading…" : "Choose File"}
                    </button>
                    {logoPreview && (
                      <button type="button"
                        onClick={() => { setLogoUrl(""); setLogoPreview(null); }}
                        className="flex items-center gap-1 px-2 py-2 text-muted-foreground hover:text-destructive text-sm transition-colors">
                        <X className="w-3.5 h-3.5" /> Remove
                      </button>
                    )}
                    <input ref={fileInputRef} type="file" accept="image/*" onChange={handleLogoFileChange} className="hidden" />
                  </div>

                  <div className="space-y-1">
                    <p className="text-xs text-muted-foreground text-center">or paste a URL</p>
                    <input
                      value={logoUrl}
                      onChange={(e) => { setLogoUrl(e.target.value); setLogoPreview(e.target.value || null); }}
                      className="w-full px-3 py-2 rounded-lg bg-secondary border border-border text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                      placeholder="https://…/logo.png"
                    />
                  </div>

                  {logoError && <p className="text-xs text-destructive text-center">{logoError}</p>}
                </div>
              </div>

              <p className="text-xs text-muted-foreground text-center">
                Supported formats: PNG, JPG, WebP, GIF · Max 5 MB
              </p>

              {error && (
                <p className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-lg px-3 py-2 text-center">
                  {error}
                </p>
              )}

              <div className="flex gap-3">
                <button
                  onClick={() => handleFinish(true)}
                  disabled={savingLogo || logoUploading}
                  className="flex-1 px-4 py-3 border border-border rounded-xl text-sm font-medium text-muted-foreground hover:bg-secondary transition-colors disabled:opacity-50"
                >
                  Skip
                </button>
                <button
                  onClick={() => handleFinish(false)}
                  disabled={savingLogo || logoUploading}
                  className="flex-1 flex items-center justify-center gap-2 py-3 bg-primary text-primary-foreground rounded-xl text-sm font-semibold hover:bg-primary/90 transition-colors disabled:opacity-50"
                >
                  {savingLogo ? "Finishing…" : "Finish Setup"}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── Done ── */}
        {step === 3 && (
          <div className="bg-card border border-border rounded-2xl shadow-lg p-8 text-center space-y-5">
            <div className="w-14 h-14 rounded-full bg-green-900/30 flex items-center justify-center mx-auto">
              <CheckCircle2 className="w-7 h-7 text-green-400" />
            </div>
            <div>
              <h2 className="text-xl font-display font-bold text-foreground mb-1">You're all set!</h2>
              <p className="text-sm text-muted-foreground">
                {companyInfo.name || "Your company"} is ready to start processing sign takeoffs.
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
