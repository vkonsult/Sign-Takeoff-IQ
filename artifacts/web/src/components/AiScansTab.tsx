import { useState, useCallback, useEffect } from "react";
import { apiFetch } from "@/lib/apiClient";
import { useUserRole } from "@/hooks/use-user-role";
import { Brain, Play, Loader2, CheckCircle2, AlertTriangle, Info, Cpu, Eye, EyeOff, ChevronDown, ChevronRight, BarChart2 } from "lucide-react";

export interface AiCallDescriptor {
  type: string;
  name: string;
  description: string;
  prompt: string;
}

interface AiScanResult {
  success: boolean;
  newSignsCreated: number;
  signsUpdated: number;
  details: Record<string, unknown>;
  error?: string;
}

interface CallState {
  status: "idle" | "running" | "success" | "error";
  result?: AiScanResult;
}

const CALL_TYPE_ICONS: Record<string, React.ReactNode> = {
  sign_schedule_enrich: <Eye className="w-4 h-4 text-emerald-400" />,
  project_info: <Info className="w-4 h-4 text-blue-400" />,
  floor_plan_text: <Cpu className="w-4 h-4 text-violet-400" />,
  vision_fallback: <Eye className="w-4 h-4 text-orange-400" />,
  bbox_detection: <Eye className="w-4 h-4 text-orange-400" />,
  title_block_vision: <Eye className="w-4 h-4 text-amber-400" />,
};

export function AiScansTab({
  jobId,
  showAiHighlight,
  onToggleAiHighlight,
  onScansComplete,
}: {
  jobId: string;
  showAiHighlight: boolean;
  onToggleAiHighlight: () => void;
  onScansComplete: () => void;
}) {
  const { isAdmin, isSuperAdmin } = useUserRole();
  const canViewPageCost = isAdmin || isSuperAdmin;

  const [callRegistry, setCallRegistry] = useState<AiCallDescriptor[]>([]);
  const [registryLoading, setRegistryLoading] = useState(true);
  const [registryError, setRegistryError] = useState<string | null>(null);

  const [callStates, setCallStates] = useState<Record<string, CallState>>({});
  const [runAllState, setRunAllState] = useState<"idle" | "running" | "done">("idle");
  const [selectedTypes, setSelectedTypes] = useState<Set<string>>(new Set());
  const [expandedPrompts, setExpandedPrompts] = useState<Set<string>>(new Set());

  interface PageTokenRow {
    pageNumber: number | null;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    callCount: number;
  }
  const [pageSummary, setPageSummary] = useState<PageTokenRow[]>([]);
  const [pageSummaryLoading, setPageSummaryLoading] = useState(true);
  const [pageBreakdownOpen, setPageBreakdownOpen] = useState(false);

  useEffect(() => {
    if (!canViewPageCost) {
      setPageSummaryLoading(false);
      return;
    }
    setPageSummaryLoading(true);
    apiFetch(`/api/activity/ai-calls/page-summary?jobId=${jobId}`)
      .then((res) => res.json())
      .then((data: { pages: PageTokenRow[] }) => {
        setPageSummary(data.pages ?? []);
      })
      .catch(() => {
        setPageSummary([]);
      })
      .finally(() => setPageSummaryLoading(false));
  }, [jobId, canViewPageCost]);

  useEffect(() => {
    setRegistryLoading(true);
    apiFetch(`/api/jobs/${jobId}/ai-calls`)
      .then((res) => res.json())
      .then((data: { callTypes: AiCallDescriptor[] }) => {
        const registry = data.callTypes ?? [];
        setCallRegistry(registry);
        setRegistryError(null);
        // Sync default selection from live registry (all enabled by default)
        setSelectedTypes((prev) =>
          prev.size === 0 ? new Set(registry.map((c: AiCallDescriptor) => c.type)) : prev
        );
      })
      .catch((err) => {
        setRegistryError(String(err));
      })
      .finally(() => setRegistryLoading(false));
  }, [jobId]);

  const isRunning = (type: string) => callStates[type]?.status === "running";
  const anyRunning = Object.values(callStates).some((s) => s.status === "running") || runAllState === "running";

  const runScan = useCallback(async (callTypes: string[]) => {
    const setStatus = (type: string, status: CallState["status"], result?: AiScanResult) => {
      setCallStates((prev) => ({
        ...prev,
        [type]: { status, result },
      }));
    };

    callTypes.forEach((type) => setStatus(type, "running"));

    try {
      const res = await apiFetch(`/api/jobs/${jobId}/ai-scan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callTypes }),
      });
      const data: AiScanResult = await res.json();
      if (res.ok && data.success) {
        callTypes.forEach((type) => setStatus(type, "success", data));
        onScansComplete();
      } else {
        callTypes.forEach((type) => setStatus(type, "error", { ...data, error: data.error ?? "Scan failed" }));
      }
    } catch (err) {
      const errResult: AiScanResult = { success: false, newSignsCreated: 0, signsUpdated: 0, details: {}, error: String(err) };
      callTypes.forEach((type) => setStatus(type, "error", errResult));
    }
  }, [jobId, onScansComplete]);

  const handleRunOne = async (type: string) => {
    await runScan([type]);
  };

  const handleRunSelected = async () => {
    if (selectedTypes.size === 0) return;
    setRunAllState("running");
    await runScan(Array.from(selectedTypes));
    setRunAllState("done");
  };

  const handleRunAll = async () => {
    setRunAllState("running");
    await runScan(callRegistry.map((d) => d.type));
    setRunAllState("done");
  };

  const toggleSelect = (type: string) => {
    setSelectedTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  const togglePromptExpand = (type: string) => {
    setExpandedPrompts((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  const lastRunResult = Object.values(callStates).find((s) => s.status === "success")?.result;
  const anySuccess = Object.values(callStates).some((s) => s.status === "success");

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Brain className="w-5 h-5 text-violet-400" />
            <h2 className="text-sm font-display font-bold text-foreground uppercase tracking-wide">AI Scans</h2>
          </div>
          <p className="text-xs text-muted-foreground max-w-lg">
            AI scan calls are separate from PDF processing. Run them on-demand below.
            Signs created by AI scans are highlighted in <span className="text-violet-400 font-semibold">violet</span> throughout the app.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            onClick={onToggleAiHighlight}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-[11px] font-medium border transition-all ${
              showAiHighlight
                ? "bg-violet-500/15 text-violet-400 border-violet-500/30 hover:bg-violet-500/25"
                : "bg-secondary text-muted-foreground border-border hover:text-foreground"
            }`}
          >
            {showAiHighlight ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
            AI Highlights {showAiHighlight ? "On" : "Off"}
          </button>
          <button
            onClick={handleRunSelected}
            disabled={anyRunning || selectedTypes.size === 0}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded text-[11px] font-medium bg-violet-600 text-white hover:bg-violet-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {runAllState === "running" ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Play className="w-3.5 h-3.5" />
            )}
            Run Selected ({selectedTypes.size})
          </button>
          <button
            onClick={handleRunAll}
            disabled={anyRunning}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded text-[11px] font-medium bg-secondary text-muted-foreground border border-border hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {runAllState === "running" ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Brain className="w-3.5 h-3.5" />
            )}
            Run All
          </button>
        </div>
      </div>

      {/* Summary of last scan */}
      {anySuccess && lastRunResult && (
        <div className="flex items-center gap-3 px-3 py-2 rounded-lg bg-violet-500/10 border border-violet-500/20 text-xs text-violet-300">
          <CheckCircle2 className="w-3.5 h-3.5 flex-shrink-0 text-violet-400" />
          <span>
            Last scan created <strong>{lastRunResult.newSignsCreated}</strong> new signs
            and updated <strong>{lastRunResult.signsUpdated}</strong> existing signs.
            {lastRunResult.newSignsCreated > 0 && " Reload the Sign Table to see them."}
          </span>
        </div>
      )}

      {/* Registry loading / error states */}
      {registryLoading && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground py-4">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading AI call types…
        </div>
      )}
      {registryError && (
        <div className="flex items-center gap-2 text-xs text-destructive py-2">
          <AlertTriangle className="w-3.5 h-3.5" /> Failed to load call types: {registryError}
        </div>
      )}

      {/* AI Call Cards */}
      {!registryLoading && (
        <div className="grid gap-3">
          {callRegistry.map((call) => {
            const state = callStates[call.type];
            const selected = selectedTypes.has(call.type);
            const promptExpanded = expandedPrompts.has(call.type);
            return (
              <div
                key={call.type}
                className={`rounded-lg border transition-all ${
                  selected
                    ? "bg-violet-500/5 border-violet-500/20"
                    : "bg-card border-border"
                }`}
              >
                <div className="flex items-start gap-3 p-3">
                  {/* Checkbox */}
                  <input
                    type="checkbox"
                    checked={selected}
                    onChange={() => toggleSelect(call.type)}
                    className="mt-1 accent-violet-500 cursor-pointer"
                  />

                  {/* Icon */}
                  <div className="flex-shrink-0 mt-0.5">
                    {CALL_TYPE_ICONS[call.type] ?? <Cpu className="w-4 h-4 text-muted-foreground" />}
                  </div>

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-xs font-medium text-foreground">{call.name}</span>
                      <span className="text-[10px] font-mono text-muted-foreground/60 bg-secondary px-1.5 py-0.5 rounded">
                        {call.type}
                      </span>
                    </div>
                    <p className="text-[11px] text-muted-foreground leading-relaxed">
                      {call.description}
                    </p>

                    {/* Expandable prompt */}
                    {call.prompt && (
                      <button
                        onClick={() => togglePromptExpand(call.type)}
                        className="flex items-center gap-1 mt-1.5 text-[10px] text-muted-foreground/60 hover:text-muted-foreground transition-colors"
                      >
                        {promptExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                        {promptExpanded ? "Hide prompt" : "Show prompt"}
                      </button>
                    )}
                    {promptExpanded && call.prompt && (
                      <pre className="mt-2 p-2 rounded bg-secondary/50 text-[10px] font-mono text-muted-foreground whitespace-pre-wrap break-words leading-relaxed max-h-48 overflow-y-auto border border-border/50">
                        {call.prompt}
                      </pre>
                    )}

                    {/* Result */}
                    {state?.status === "success" && state.result && (
                      <div className="mt-2 flex items-center gap-2 text-[10px] text-violet-400">
                        <CheckCircle2 className="w-3 h-3" />
                        <span>
                          +{state.result.newSignsCreated} new signs · {state.result.signsUpdated} updated
                        </span>
                      </div>
                    )}
                    {state?.status === "error" && (
                      <div className="mt-2 flex items-center gap-2 text-[10px] text-destructive">
                        <AlertTriangle className="w-3 h-3" />
                        <span>{state.result?.error ?? "Scan failed"}</span>
                      </div>
                    )}
                  </div>

                  {/* Run button */}
                  <button
                    onClick={() => handleRunOne(call.type)}
                    disabled={anyRunning}
                    className={`flex-shrink-0 flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium border transition-all disabled:opacity-50 disabled:cursor-not-allowed ${
                      state?.status === "success"
                        ? "bg-violet-500/10 text-violet-400 border-violet-500/20 hover:bg-violet-500/20"
                        : state?.status === "error"
                        ? "bg-destructive/10 text-destructive border-destructive/20 hover:bg-destructive/20"
                        : "bg-secondary text-muted-foreground border-border hover:text-foreground hover:border-border/80"
                    }`}
                  >
                    {isRunning(call.type) ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : state?.status === "success" ? (
                      <CheckCircle2 className="w-3 h-3" />
                    ) : state?.status === "error" ? (
                      <AlertTriangle className="w-3 h-3" />
                    ) : (
                      <Play className="w-3 h-3" />
                    )}
                    {isRunning(call.type)
                      ? "Running…"
                      : state?.status === "success"
                      ? "Re-run"
                      : state?.status === "error"
                      ? "Retry"
                      : "Run"}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Page Token Breakdown */}
      {!pageSummaryLoading && pageSummary.length > 0 && (() => {
        const maxTokens = pageSummary[0]?.totalTokens ?? 1;
        return (
          <div className="rounded-lg border border-border bg-card">
            <button
              onClick={() => setPageBreakdownOpen((v) => !v)}
              className="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-secondary/30 transition-colors rounded-lg"
            >
              {pageBreakdownOpen ? (
                <ChevronDown className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
              ) : (
                <ChevronRight className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
              )}
              <BarChart2 className="w-3.5 h-3.5 text-violet-400 flex-shrink-0" />
              <span className="text-xs font-medium text-foreground">
                Token Cost by Page
              </span>
              <span className="ml-auto text-[10px] text-muted-foreground">
                {pageSummary.length} page{pageSummary.length !== 1 ? "s" : ""} · floor_plan_text + bbox_detection
              </span>
            </button>
            {pageBreakdownOpen && (
              <div className="px-4 pb-4 space-y-1.5 border-t border-border pt-3">
                <div className="grid grid-cols-[auto_1fr_auto_auto_auto] gap-x-3 text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-2 px-1">
                  <span>Page</span>
                  <span>Usage</span>
                  <span className="text-right">In</span>
                  <span className="text-right">Out</span>
                  <span className="text-right">Total</span>
                </div>
                {pageSummary.map((row, i) => {
                  const pct = maxTokens > 0 ? Math.max(2, Math.round((row.totalTokens / maxTokens) * 100)) : 2;
                  const isTop = i === 0;
                  return (
                    <div
                      key={row.pageNumber ?? "unknown"}
                      className={`grid grid-cols-[auto_1fr_auto_auto_auto] items-center gap-x-3 px-1 py-1 rounded text-[11px] ${
                        isTop ? "bg-violet-500/8" : ""
                      }`}
                    >
                      <span className={`font-mono text-[10px] w-8 text-right flex-shrink-0 ${isTop ? "text-violet-400 font-semibold" : "text-muted-foreground"}`}>
                        p{row.pageNumber ?? "?"}
                      </span>
                      <div className="flex items-center min-w-0">
                        <div className="w-full h-1.5 rounded-full bg-secondary overflow-hidden">
                          <div
                            className={`h-full rounded-full ${isTop ? "bg-violet-500" : "bg-violet-500/40"}`}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </div>
                      <span className="text-right text-muted-foreground font-mono text-[10px]">
                        {row.inputTokens.toLocaleString()}
                      </span>
                      <span className="text-right text-muted-foreground font-mono text-[10px]">
                        {row.outputTokens.toLocaleString()}
                      </span>
                      <span className={`text-right font-mono text-[10px] font-medium ${isTop ? "text-violet-400" : "text-foreground"}`}>
                        {row.totalTokens.toLocaleString()}
                      </span>
                    </div>
                  );
                })}
                <p className="mt-2 text-[10px] text-muted-foreground/60 px-1">
                  Sorted by total tokens (input + output). Only floor_plan_text and bbox_detection calls with a page number are counted.
                </p>
              </div>
            )}
          </div>
        );
      })()}

      {/* Legend */}
      <div className="space-y-2">
        {/* Color swatch row */}
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <span className="inline-block w-3 h-3 rounded-sm bg-violet-500/70 border border-violet-500/30 flex-shrink-0" />
            <span>AI-sourced sign row</span>
          </div>
          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <span className="inline-block w-3 h-3 rounded-sm bg-violet-500/20 border border-violet-500/40 flex-shrink-0" />
            <span>AI-contributed bbox cell</span>
          </div>
          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <span className="inline-block w-3 h-3 rounded-full border-2 border-violet-500 border-dashed flex-shrink-0" />
            <span>AI-sourced floor plan marker</span>
          </div>
        </div>
        {/* Call type legend */}
        <div className="flex items-start gap-3 p-3 rounded-lg bg-secondary/30 border border-border">
          <Info className="w-3.5 h-3.5 flex-shrink-0 text-muted-foreground mt-0.5" />
          <div className="text-[11px] text-muted-foreground space-y-1">
            <p><strong className="text-violet-400">Sign Schedule Text</strong> + <strong className="text-violet-400">Floor Plan Text</strong> — primary sign extraction calls. Run these to populate the sign table.</p>
            <p><strong className="text-orange-400">Vision Fallback</strong> + <strong className="text-orange-400">Bbox Detection</strong> — visual scans of floor plan images. Useful for callouts not in the text layer.</p>
            <p><strong className="text-blue-400">Project Info</strong> — reads title blocks to fill project location fields. Run once per job.</p>
            <p><strong className="text-amber-400">Title Block Vision</strong> — uses AI vision to detect floor level names from each page's title block.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
