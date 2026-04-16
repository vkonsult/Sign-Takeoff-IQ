import { useState, useCallback } from "react";
import { apiFetch } from "@/lib/apiClient";
import {
  ShieldCheck,
  Play,
  Loader2,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";

interface ComplianceEntry {
  signType: string;
  qty: number;
  ruleRef: string;
  color: string;
  roomNumber: string;
  roomName: string;
  level: string;
  pageNumber: number;
  covered: boolean;
}

interface ComplianceSummary {
  totalSigns: number;
  coveredCount: number;
  missingCount: number;
  byRule: Record<string, number>;
  byLevel: Record<string, number>;
}

interface ComplianceScanResult {
  entries: ComplianceEntry[];
  summary: ComplianceSummary;
  generatedAt: string;
}

export function ComplianceTab({ jobId }: { jobId: string }) {
  const [scanResult, setScanResult] = useState<ComplianceScanResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [collapsedLevels, setCollapsedLevels] = useState<Set<string>>(new Set());
  const [filterMissing, setFilterMissing] = useState(false);

  const runScan = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<ComplianceScanResult>(
        `/api/jobs/${jobId}/compliance-scan`,
        { method: "POST" }
      );
      setScanResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Compliance scan failed");
    } finally {
      setLoading(false);
    }
  }, [jobId]);

  const toggleLevel = (level: string) => {
    setCollapsedLevels((prev) => {
      const next = new Set(prev);
      if (next.has(level)) next.delete(level);
      else next.add(level);
      return next;
    });
  };

  const entries = scanResult?.entries ?? [];
  const filteredEntries = filterMissing ? entries.filter((e) => !e.covered) : entries;

  const byLevel = filteredEntries.reduce<Record<string, ComplianceEntry[]>>((acc, e) => {
    const lvl = e.level || "Unknown Level";
    (acc[lvl] ??= []).push(e);
    return acc;
  }, {});

  const levels = Object.keys(byLevel).sort();

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      {/* Header */}
      <div className="flex-none px-6 py-4 border-b border-border bg-card">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-primary" />
            <span className="text-sm font-display font-semibold text-foreground">
              Code Compliance Gap Analysis
            </span>
            <span className="text-xs text-muted-foreground">
              Rules R1–R15 · ADA &amp; Life Safety
            </span>
          </div>
          <Button
            size="sm"
            onClick={runScan}
            disabled={loading}
            className="gap-1.5"
          >
            {loading ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Play className="w-3.5 h-3.5" />
            )}
            {loading ? "Running scan…" : scanResult ? "Re-run Scan" : "Run Compliance Scan"}
          </Button>
        </div>

        {/* Summary row */}
        {scanResult?.summary && (
          <div className="mt-3 flex items-center gap-4 flex-wrap">
            <div className="flex items-center gap-1.5 text-xs">
              <span className="text-muted-foreground">Required:</span>
              <span className="font-semibold text-foreground">{scanResult.summary.totalSigns ?? 0}</span>
            </div>
            <div className="flex items-center gap-1.5 text-xs">
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
              <span className="text-muted-foreground">Covered:</span>
              <span className="font-semibold text-emerald-600">{scanResult.summary.coveredCount ?? 0}</span>
            </div>
            <div className="flex items-center gap-1.5 text-xs">
              <XCircle className="w-3.5 h-3.5 text-red-500" />
              <span className="text-muted-foreground">Missing:</span>
              <span className="font-semibold text-red-500">{scanResult.summary.missingCount ?? 0}</span>
            </div>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              Scanned {new Date(scanResult.generatedAt).toLocaleTimeString()}
            </div>
            {(scanResult.summary.missingCount ?? 0) > 0 && (
              <button
                onClick={() => setFilterMissing((v) => !v)}
                className={`ml-auto flex items-center gap-1.5 px-3 py-1 rounded-md text-[11px] font-display font-semibold uppercase tracking-wide border transition-all ${
                  filterMissing
                    ? "bg-red-500/15 text-red-500 border-red-500/40"
                    : "bg-secondary text-muted-foreground border-border hover:text-red-500 hover:border-red-500/40"
                }`}
              >
                <AlertTriangle className="w-3 h-3" />
                {filterMissing ? "Show all" : `Show missing only (${scanResult.summary.missingCount})`}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-auto bg-card">
        {error && (
          <div className="m-6 p-4 rounded-lg bg-destructive/10 border border-destructive/30 text-sm text-destructive flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
            {error}
          </div>
        )}

        {!scanResult && !loading && !error && (
          <div className="flex flex-col items-center justify-center h-64 text-center gap-3">
            <ShieldCheck className="w-10 h-10 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">
              Run a compliance scan to see which code-required signs are present or missing in this takeoff.
            </p>
          </div>
        )}

        {loading && (
          <div className="flex flex-col items-center justify-center h-64 gap-3">
            <Loader2 className="w-8 h-8 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">Evaluating rules R1–R15…</p>
          </div>
        )}

        {scanResult && !loading && filteredEntries.length === 0 && (
          <div className="flex flex-col items-center justify-center h-64 gap-2">
            <CheckCircle2 className="w-10 h-10 text-emerald-500" />
            <p className="text-sm text-muted-foreground">
              {filterMissing ? "No missing signs — all required signs are covered!" : "No compliance entries found."}
            </p>
          </div>
        )}

        {scanResult && !loading && levels.length > 0 && (
          <div className="divide-y divide-border">
            {levels.map((level) => {
              const levelEntries = byLevel[level] ?? [];
              const levelMissing = levelEntries.filter((e) => !e.covered).length;
              const isCollapsed = collapsedLevels.has(level);

              return (
                <div key={level}>
                  {/* Level header */}
                  <button
                    onClick={() => toggleLevel(level)}
                    className="w-full flex items-center gap-2 px-6 py-2.5 bg-secondary/40 hover:bg-secondary/60 transition-colors text-left"
                  >
                    {isCollapsed ? (
                      <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                    ) : (
                      <ChevronDown className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                    )}
                    <span className="text-[11px] font-display font-semibold uppercase tracking-wider text-foreground">
                      {level}
                    </span>
                    <span className="text-[11px] text-muted-foreground">
                      {levelEntries.length} required
                    </span>
                    {levelMissing > 0 && (
                      <span className="ml-auto flex items-center gap-1 text-[11px] text-red-500 font-semibold">
                        <XCircle className="w-3 h-3" />
                        {levelMissing} missing
                      </span>
                    )}
                    {levelMissing === 0 && (
                      <span className="ml-auto flex items-center gap-1 text-[11px] text-emerald-500 font-semibold">
                        <CheckCircle2 className="w-3 h-3" />
                        All covered
                      </span>
                    )}
                  </button>

                  {/* Entries */}
                  {!isCollapsed && (
                    <div>
                      {levelEntries.map((entry, i) => (
                        <div
                          key={i}
                          className={`flex items-center gap-3 px-6 py-2.5 border-b border-border/50 last:border-b-0 hover:bg-secondary/20 transition-colors ${
                            !entry.covered ? "bg-red-500/5" : ""
                          }`}
                        >
                          {/* Rule color dot */}
                          <div
                            className="w-2 h-2 rounded-full shrink-0"
                            style={{ backgroundColor: entry.color }}
                          />

                          {/* Sign info */}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-xs font-semibold text-foreground truncate">
                                {entry.signType}
                              </span>
                              <span className="text-[10px] text-muted-foreground font-mono">
                                {entry.ruleRef}
                              </span>
                            </div>
                            <div className="text-[11px] text-muted-foreground truncate">
                              {entry.roomName} — {entry.roomNumber}
                              {entry.qty > 1 && (
                                <span className="ml-1 text-muted-foreground/70">× {entry.qty}</span>
                              )}
                            </div>
                          </div>

                          {/* Coverage badge */}
                          {entry.covered ? (
                            <div className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-[10px] font-semibold text-emerald-600 shrink-0 whitespace-nowrap">
                              <CheckCircle2 className="w-3 h-3" />
                              Covered
                            </div>
                          ) : (
                            <div className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-500/10 border border-red-500/30 text-[10px] font-semibold text-red-500 shrink-0 whitespace-nowrap">
                              <XCircle className="w-3 h-3" />
                              Missing
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
