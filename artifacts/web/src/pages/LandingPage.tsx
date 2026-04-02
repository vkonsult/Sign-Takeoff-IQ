import { Link, useLocation } from "wouter";
import { Zap, FileSearch, BarChart3, Download } from "lucide-react";
import { setGuestToken } from "@/lib/apiClient";
import { useEffect, useState } from "react";

export default function LandingPage() {
  const [, setLocation] = useLocation();
  const [guestAvailable, setGuestAvailable] = useState(false);
  const [guestLoading, setGuestLoading] = useState(false);

  useEffect(() => {
    fetch("/api/auth/guest-available")
      .then((r) => r.json())
      .then((d: { available?: boolean }) => setGuestAvailable(!!d.available))
      .catch(() => {});
  }, []);

  async function handleGuestAccess() {
    setGuestLoading(true);
    try {
      const res = await fetch("/api/auth/guest", { method: "POST" });
      if (!res.ok) return;
      const { token } = await res.json() as { token: string };
      setGuestToken(token);
      setLocation("/jobs");
    } catch {
      // ignore
    } finally {
      setGuestLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Header */}
      <header className="border-b border-border px-8 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded bg-primary flex items-center justify-center">
            <svg viewBox="0 0 24 24" fill="none" className="w-5 h-5 text-primary-foreground stroke-current" strokeWidth="2">
              <path d="M4 22L20 2" strokeLinecap="round"/>
              <path d="M4 12L12 4" strokeLinecap="round"/>
              <path d="M12 20L20 12" strokeLinecap="round"/>
            </svg>
          </div>
          <div>
            <h1 className="font-display font-bold text-sm leading-tight text-foreground">SIGN TAKEOFF IQ</h1>
            <p className="text-[10px] text-primary tracking-widest font-mono uppercase">Precision Portal</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {guestAvailable && (
            <button
              onClick={handleGuestAccess}
              disabled={guestLoading}
              className="px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
            >
              {guestLoading ? "Loading…" : "Continue as Guest"}
            </button>
          )}
          <Link
            href="/sign-in"
            className="px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
          >
            Sign In
          </Link>
          <Link
            href="/sign-up"
            className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors"
          >
            Get Started
          </Link>
        </div>
      </header>

      {/* Hero */}
      <main className="flex-1 flex flex-col items-center justify-center px-8 py-20 text-center max-w-4xl mx-auto w-full">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-primary/30 bg-primary/10 text-primary text-xs font-mono uppercase tracking-wider mb-6">
          <Zap className="w-3 h-3" />
          AI-Powered Sign Extraction
        </div>
        <h2 className="text-5xl font-display font-bold text-foreground mb-6 leading-tight">
          Extract sign data from<br />
          <span className="text-primary">architectural plans</span> in seconds
        </h2>
        <p className="text-lg text-muted-foreground mb-10 max-w-2xl">
          Upload PDF drawings and let AI automatically identify every sign, 
          extract specifications, and generate a complete takeoff ready for estimating.
        </p>
        <div className="flex gap-4">
          <Link
            href="/sign-up"
            className="px-6 py-3 rounded-lg bg-primary text-primary-foreground font-display font-semibold uppercase tracking-wider text-sm hover:bg-primary/90 transition-all shadow-[0_0_20px_rgba(255,170,0,0.15)] hover:shadow-[0_0_25px_rgba(255,170,0,0.25)]"
          >
            Start Free Trial
          </Link>
          <Link
            href="/sign-in"
            className="px-6 py-3 rounded-lg border border-border text-foreground font-display font-semibold uppercase tracking-wider text-sm hover:bg-secondary/50 transition-all"
          >
            Sign In
          </Link>
          {guestAvailable && (
            <button
              onClick={handleGuestAccess}
              disabled={guestLoading}
              className="px-6 py-3 rounded-lg border border-border text-muted-foreground font-display font-semibold uppercase tracking-wider text-sm hover:bg-secondary/50 transition-all disabled:opacity-50"
            >
              {guestLoading ? "Loading…" : "Continue as Guest"}
            </button>
          )}
        </div>
      </main>

      {/* Features */}
      <section className="border-t border-border px-8 py-16">
        <div className="max-w-4xl mx-auto grid grid-cols-1 md:grid-cols-3 gap-8">
          {[
            {
              icon: FileSearch,
              title: "Dual AI Scan",
              desc: "Text + visual extraction catches every sign — even those buried in floor plan callouts.",
            },
            {
              icon: BarChart3,
              title: "Review & Verify",
              desc: "Confidence scores and source badges let you quickly validate extracted data.",
            },
            {
              icon: Download,
              title: "Export Ready",
              desc: "Download a structured Excel takeoff with By-Sign-Type and By-Sheet breakdowns.",
            },
          ].map(({ icon: Icon, title, desc }) => (
            <div key={title} className="flex flex-col gap-3">
              <div className="w-10 h-10 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
                <Icon className="w-5 h-5" />
              </div>
              <h3 className="font-display font-semibold text-foreground">{title}</h3>
              <p className="text-sm text-muted-foreground">{desc}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
