import { useState } from "react";
import { useLocation } from "wouter";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/apiClient";
import { CheckCircle2, ChevronRight, Building2, Phone, Globe, MapPin, Mail } from "lucide-react";

type Step = "welcome" | "company" | "done";

function StepIndicator({ current }: { current: Step }) {
  const steps: Step[] = ["welcome", "company", "done"];
  const idx = steps.indexOf(current);
  return (
    <div className="flex items-center gap-2 mb-8">
      {steps.map((s, i) => (
        <div key={s} className="flex items-center gap-2">
          <div
            className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-all ${
              i < idx
                ? "bg-primary text-primary-foreground"
                : i === idx
                  ? "bg-primary text-primary-foreground ring-2 ring-primary/30"
                  : "bg-secondary text-muted-foreground"
            }`}
          >
            {i < idx ? <CheckCircle2 className="w-4 h-4" /> : i + 1}
          </div>
          {i < steps.length - 1 && (
            <div className={`h-px w-8 ${i < idx ? "bg-primary" : "bg-border"}`} />
          )}
        </div>
      ))}
    </div>
  );
}

export default function OnboardingPage() {
  const [step, setStep] = useState<Step>("welcome");
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();

  const [form, setForm] = useState({
    name: "",
    email: "",
    phone: "",
    address: "",
    website: "",
    logoUrl: "",
  });
  const [error, setError] = useState<string | null>(null);

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
          onboardingComplete: true,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to save");
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-org"] });
      setStep("done");
    },
    onError: (e: Error) => {
      setError(e.message);
    },
  });

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-6">
      <div className="w-full max-w-lg">
        {/* Logo */}
        <div className="flex items-center gap-3 mb-10">
          <div className="w-9 h-9 rounded-lg bg-primary flex items-center justify-center">
            <svg viewBox="0 0 24 24" fill="none" className="w-5 h-5 text-primary-foreground stroke-current" strokeWidth="2">
              <path d="M4 22L20 2" strokeLinecap="round" />
              <path d="M4 12L12 4" strokeLinecap="round" />
              <path d="M12 20L20 12" strokeLinecap="round" />
            </svg>
          </div>
          <div>
            <h1 className="font-display font-bold text-sm leading-tight text-foreground">SIGN TAKEOFF IQ</h1>
            <p className="text-[10px] text-primary tracking-widest font-mono uppercase">Setup Wizard</p>
          </div>
        </div>

        <StepIndicator current={step} />

        {/* Step: Welcome */}
        {step === "welcome" && (
          <div className="bg-card border border-border rounded-2xl p-8">
            <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center mb-5">
              <Building2 className="w-6 h-6 text-primary" />
            </div>
            <h2 className="text-xl font-display font-bold text-foreground mb-3">
              Welcome to Sign Takeoff IQ
            </h2>
            <p className="text-sm text-muted-foreground mb-6 leading-relaxed">
              Let's set up your company profile. This takes about 2 minutes and helps your team
              hit the ground running with AI-powered sign extraction.
            </p>
            <ul className="space-y-2 mb-8">
              {[
                "Company information and branding",
                "AI-powered plan extraction ready to go",
                "Your team can start uploading plans immediately",
              ].map((item) => (
                <li key={item} className="flex items-start gap-2 text-sm text-muted-foreground">
                  <CheckCircle2 className="w-4 h-4 text-primary mt-0.5 flex-shrink-0" />
                  {item}
                </li>
              ))}
            </ul>
            <button
              onClick={() => setStep("company")}
              className="w-full flex items-center justify-center gap-2 px-6 py-3 bg-primary text-primary-foreground rounded-xl font-medium hover:bg-primary/90 transition-colors"
            >
              Get Started
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Step: Company */}
        {step === "company" && (
          <div className="bg-card border border-border rounded-2xl p-8">
            <h2 className="text-xl font-display font-bold text-foreground mb-1">Company Profile</h2>
            <p className="text-sm text-muted-foreground mb-6">
              Fill in your company details. All fields except name are optional.
            </p>
            {error && (
              <div className="mb-4 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-lg px-3 py-2">
                {error}
              </div>
            )}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                setError(null);
                saveMutation.mutate();
              }}
              className="space-y-4"
            >
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                  <Building2 className="w-3.5 h-3.5" /> Company Name *
                </label>
                <input
                  required
                  value={form.name}
                  onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                  className="w-full px-3 py-2.5 rounded-lg bg-secondary border border-border text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                  placeholder="Acme Sign Co."
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                    <Mail className="w-3.5 h-3.5" /> Email
                  </label>
                  <input
                    type="email"
                    value={form.email}
                    onChange={(e) => setForm((p) => ({ ...p, email: e.target.value }))}
                    className="w-full px-3 py-2.5 rounded-lg bg-secondary border border-border text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                    placeholder="info@company.com"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                    <Phone className="w-3.5 h-3.5" /> Phone
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
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                  <MapPin className="w-3.5 h-3.5" /> Address
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
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                    <Globe className="w-3.5 h-3.5" /> Website
                  </label>
                  <input
                    value={form.website}
                    onChange={(e) => setForm((p) => ({ ...p, website: e.target.value }))}
                    className="w-full px-3 py-2.5 rounded-lg bg-secondary border border-border text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                    placeholder="https://company.com"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Logo URL</label>
                  <input
                    value={form.logoUrl}
                    onChange={(e) => setForm((p) => ({ ...p, logoUrl: e.target.value }))}
                    className="w-full px-3 py-2.5 rounded-lg bg-secondary border border-border text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                    placeholder="https://…/logo.png"
                  />
                </div>
              </div>
              <div className="flex gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setStep("welcome")}
                  className="px-4 py-2.5 rounded-xl border border-border text-sm font-medium text-muted-foreground hover:bg-secondary transition-colors"
                >
                  Back
                </button>
                <button
                  type="submit"
                  disabled={saveMutation.isPending}
                  className="flex-1 flex items-center justify-center gap-2 px-6 py-2.5 bg-primary text-primary-foreground rounded-xl font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
                >
                  {saveMutation.isPending ? "Saving…" : "Complete Setup"}
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </form>
          </div>
        )}

        {/* Step: Done */}
        {step === "done" && (
          <div className="bg-card border border-border rounded-2xl p-8 text-center">
            <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-5">
              <CheckCircle2 className="w-8 h-8 text-primary" />
            </div>
            <h2 className="text-xl font-display font-bold text-foreground mb-3">You're all set!</h2>
            <p className="text-sm text-muted-foreground mb-8 leading-relaxed">
              Your company profile has been configured. You can now start uploading architectural
              plans and extracting sign data with AI.
            </p>
            <button
              onClick={() => setLocation("/jobs")}
              className="w-full flex items-center justify-center gap-2 px-6 py-3 bg-primary text-primary-foreground rounded-xl font-medium hover:bg-primary/90 transition-colors"
            >
              Go to Dashboard
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
