import { useState, useCallback, useEffect } from "react";
import { apiFetch } from "@/lib/apiClient";
import {
  ShieldCheck,
  Play,
  Loader2,
  AlertTriangle,
  RefreshCw,
  ChevronUp,
  ChevronDown,
  ChevronsUpDown,
  Filter,
  X,
} from "lucide-react";

interface TakeoffEntry {
  signType: string;
  qty: number;
  ruleRef: string;
  color: string;
  plaqueTypeId?: string;
  roomNumber: string;
  roomName: string;
  level: string;
  pageNumber: number;
  coords?: { x: number; y: number };
}

interface ComplianceSummary {
  totalSigns: number;
  byRule: Record<string, number>;
  byLevel: Record<string, number>;
}

interface ScanResult {
  entries: TakeoffEntry[];
  summary: ComplianceSummary;
  generatedAt: string;
}

type SortField = "signType" | "ruleRef" | "qty" | "level" | "roomNumber" | "roomName";
type SortDir = "asc" | "desc";

export function ComplianceScanTab({ jobId }: { jobId: string }) {
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [status, setStatus] = useState<"idle" | "running" | "error" | "loading">("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setStatus("loading");
    apiFetch(`/api/jobs/${jobId}/compliance-scan`)
      .then((res) => res.json())
      .then((data: ScanResult & { entries: TakeoffEntry[] | null }) => {
        if (data.entries && data.entries.length > 0) {
          setScanResult(data as ScanResult);
        }
        setStatus("idle");
      })
      .catch(() => setStatus("idle"));
  }, [jobId]);

  const [sortField, setSortField] = useState<SortField>("ruleRef");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const [filterRule, setFilterRule] = useState<string>("");
  const [filterLevel, setFilterLevel] = useState<string>("");
  const [filterText, setFilterText] = useState<string>("");

  const runScan = useCallback(async () => {
    setStatus("running");
    setError(null);
    try {
      const res = await apiFetch(`/api/jobs/${jobId}/compliance-scan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      const data: ScanResult = await res.json();
      setScanResult(data);
      setStatus("idle");
    } catch (err) {
      setError(String(err));
      setStatus("error");
    }
  }, [jobId]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir("asc");
    }
  };

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) return <ChevronsUpDown className="w-3 h-3 opacity-40" />;
    return sortDir === "asc" ? (
      <ChevronUp className="w-3 h-3 text-primary" />
    ) : (
      <ChevronDown className="w-3 h-3 text-primary" />
    );
  };

  const entries = scanResult?.entries ?? [];
  const allRules = Array.from(new Set(entries.map((e) => e.ruleRef))).sort();
  const allLevels = Array.from(new Set(entries.map((e) => e.level))).sort();

  const filtered = entries
    .filter((e) => !filterRule || e.ruleRef === filterRule)
    .filter((e) => !filterLevel || e.level === filterLevel)
    .filter(
      (e) =>
        !filterText ||
        e.signType.toLowerCase().includes(filterText.toLowerCase()) ||
        e.roomName.toLowerCase().includes(filterText.toLowerCase()) ||
        e.roomNumber.toLowerCase().includes(filterText.toLowerCase())
    );

  const ruleNum = (ref: string) => parseInt(ref.replace(/\D/g, ""), 10) || 0;

  const sorted = [...filtered].sort((a, b) => {
    if (sortField === "ruleRef") {
      const cmp = ruleNum(a.ruleRef) - ruleNum(b.ruleRef);
      return sortDir === "asc" ? cmp : -cmp;
    }
    const va = a[sortField];
    const vb = b[sortField];
    if (typeof va === "string" && typeof vb === "string") {
      const cmp = va.localeCompare(vb);
      return sortDir === "asc" ? cmp : -cmp;
    }
    const na = Number(va);
    const nb = Number(vb);
    return sortDir === "asc" ? na - nb : nb - na;
  });

  const isRunning = status === "running";
  const isLoading = status === "loading";
  const hasResults = scanResult !== null;

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      {/* Header bar */}
      <div className="flex-none flex items-center justify-between px-6 py-4 border-b border-border bg-secondary/20">
        <div className="flex items-center gap-3">
          <ShieldCheck className="w-5 h-5 text-emerald-400" />
          <div>
            <div className="text-sm font-semibold text-foreground">Compliance Scan</div>
            {hasResults && scanResult && (
              <div className="text-xs text-muted-foreground font-mono">
                Generated {new Date(scanResult.generatedAt).toLocaleString()} ·{" "}
                {scanResult.summary.totalSigns} required sign{scanResult.summary.totalSigns !== 1 ? "s" : ""}
              </div>
            )}
          </div>
        </div>

        <button
          onClick={runScan}
          disabled={isRunning || isLoading}
          className={`flex items-center gap-2 px-4 py-2 rounded-md text-xs font-display font-semibold uppercase tracking-wide border transition-all ${
            isRunning || isLoading
              ? "bg-secondary text-muted-foreground border-border cursor-not-allowed"
              : hasResults
              ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/40 hover:bg-emerald-500/20"
              : "bg-emerald-600 text-white border-emerald-700 hover:bg-emerald-500"
          }`}
        >
          {isRunning ? (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Scanning…
            </>
          ) : hasResults ? (
            <>
              <RefreshCw className="w-3.5 h-3.5" />
              Re-run Scan
            </>
          ) : (
            <>
              <Play className="w-3.5 h-3.5" />
              Run Compliance Scan
            </>
          )}
        </button>
      </div>

      {/* Error state */}
      {status === "error" && error && (
        <div className="flex-none flex items-center gap-3 px-6 py-3 bg-red-500/10 border-b border-red-500/30 text-red-400 text-sm">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Loading spinner while fetching persisted results or running scan */}
      {(status === "loading" || (isRunning && !hasResults)) && (
        <div className="flex-1 flex flex-col items-center justify-center gap-4">
          <Loader2 className="w-8 h-8 text-emerald-400 animate-spin" />
          <div className="text-sm text-muted-foreground">
            {status === "loading" ? "Loading scan results…" : "Running compliance analysis…"}
          </div>
        </div>
      )}

      {/* Empty / waiting state */}
      {!hasResults && status === "idle" && (
        <div className="flex-1 flex flex-col items-center justify-center gap-4 text-center p-8">
          <ShieldCheck className="w-12 h-12 text-muted-foreground/30" />
          <div className="space-y-1">
            <div className="text-sm font-medium text-foreground/70">No scan results yet</div>
            <div className="text-xs text-muted-foreground max-w-xs">
              Run the compliance scan to check all extracted signs against ADA / IBC rules R1–R15.
            </div>
          </div>
        </div>
      )}

      {/* Results */}
      {hasResults && scanResult && (
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          {/* Summary stats */}
          <div className="flex-none grid grid-cols-3 gap-4 px-6 py-4 border-b border-border bg-secondary/10">
            {/* Total */}
            <div className="rounded-lg bg-card border border-border p-4">
              <div className="text-xs font-display font-semibold uppercase tracking-wider text-muted-foreground mb-1">
                Total Required Signs
              </div>
              <div className="text-3xl font-bold font-mono text-foreground tabular-nums">
                {scanResult.summary.totalSigns}
              </div>
            </div>

            {/* By Rule */}
            <div className="rounded-lg bg-card border border-border p-4">
              <div className="text-xs font-display font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                By Rule
              </div>
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(scanResult.summary.byRule)
                  .sort(([a], [b]) => {
                    const na = parseInt(a.replace("R", ""));
                    const nb = parseInt(b.replace("R", ""));
                    return na - nb;
                  })
                  .map(([rule, count]) => {
                    const entry = scanResult.entries.find((e) => e.ruleRef === rule);
                    const color = entry?.color ?? "#6B7280";
                    return (
                      <button
                        key={rule}
                        onClick={() => setFilterRule((r) => (r === rule ? "" : rule))}
                        className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono font-semibold border transition-all"
                        style={{
                          borderColor: filterRule === rule ? color : `${color}60`,
                          backgroundColor: filterRule === rule ? `${color}30` : `${color}15`,
                          color,
                          opacity: filterRule && filterRule !== rule ? 0.5 : 1,
                        }}
                        title={`Filter by ${rule}`}
                      >
                        {rule}
                        <span className="ml-0.5 font-bold">{count}</span>
                      </button>
                    );
                  })}
              </div>
            </div>

            {/* By Level */}
            <div className="rounded-lg bg-card border border-border p-4">
              <div className="text-xs font-display font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                By Level
              </div>
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(scanResult.summary.byLevel)
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([level, count]) => (
                    <button
                      key={level}
                      onClick={() => setFilterLevel((l) => (l === level ? "" : level))}
                      className={`flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono font-semibold border transition-all ${
                        filterLevel === level
                          ? "bg-primary/20 border-primary/60 text-primary"
                          : filterLevel
                          ? "bg-muted/40 border-muted text-muted-foreground opacity-50"
                          : "bg-muted/40 border-muted text-foreground hover:border-primary/40"
                      }`}
                    >
                      {level}
                      <span className="ml-0.5 font-bold">{count}</span>
                    </button>
                  ))}
              </div>
            </div>
          </div>

          {/* Filter bar */}
          <div className="flex-none flex items-center gap-3 px-6 py-2 border-b border-border bg-secondary/10">
            <Filter className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            <input
              type="text"
              placeholder="Filter by sign type, room name or number…"
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
              className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground/50 outline-none border-none"
            />
            {(filterText || filterRule || filterLevel) && (
              <button
                onClick={() => { setFilterText(""); setFilterRule(""); setFilterLevel(""); }}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                <X className="w-3 h-3" />
                Clear filters
              </button>
            )}
            <span className="text-xs text-muted-foreground shrink-0">
              {sorted.length} of {entries.length} rows
            </span>
          </div>

          {/* Table */}
          <div className="flex-1 overflow-auto">
            <table className="w-full text-left border-collapse">
              <thead className="sticky top-0 z-10 bg-secondary/80 backdrop-blur-sm border-b border-border">
                <tr>
                  <th className="px-4 py-2">
                    <button
                      onClick={() => handleSort("ruleRef")}
                      className="flex items-center gap-1 text-[10px] font-display font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground"
                    >
                      Rule <SortIcon field="ruleRef" />
                    </button>
                  </th>
                  <th className="px-4 py-2">
                    <button
                      onClick={() => handleSort("signType")}
                      className="flex items-center gap-1 text-[10px] font-display font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground"
                    >
                      Sign Type <SortIcon field="signType" />
                    </button>
                  </th>
                  <th className="px-4 py-2">
                    <button
                      onClick={() => handleSort("qty")}
                      className="flex items-center gap-1 text-[10px] font-display font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground"
                    >
                      Qty <SortIcon field="qty" />
                    </button>
                  </th>
                  <th className="px-4 py-2">
                    <button
                      onClick={() => handleSort("roomNumber")}
                      className="flex items-center gap-1 text-[10px] font-display font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground"
                    >
                      Room # <SortIcon field="roomNumber" />
                    </button>
                  </th>
                  <th className="px-4 py-2">
                    <button
                      onClick={() => handleSort("roomName")}
                      className="flex items-center gap-1 text-[10px] font-display font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground"
                    >
                      Room Name <SortIcon field="roomName" />
                    </button>
                  </th>
                  <th className="px-4 py-2">
                    <button
                      onClick={() => handleSort("level")}
                      className="flex items-center gap-1 text-[10px] font-display font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground"
                    >
                      Level <SortIcon field="level" />
                    </button>
                  </th>
                  <th className="px-4 py-2 text-[10px] font-display font-semibold uppercase tracking-wider text-muted-foreground">
                    Page
                  </th>
                  <th className="px-4 py-2 text-[10px] font-display font-semibold uppercase tracking-wider text-muted-foreground">
                    Plaque Type
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {sorted.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="px-4 py-12 text-center text-sm text-muted-foreground">
                      No entries match the current filters.
                    </td>
                  </tr>
                ) : (
                  sorted.map((entry, idx) => (
                    <tr
                      key={idx}
                      className="hover:bg-secondary/30 transition-colors"
                    >
                      <td className="px-4 py-2.5">
                        <span
                          className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-mono font-semibold border"
                          style={{
                            borderColor: `${entry.color}60`,
                            backgroundColor: `${entry.color}20`,
                            color: entry.color,
                          }}
                        >
                          {entry.ruleRef}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-sm text-foreground font-medium">
                        {entry.signType}
                      </td>
                      <td className="px-4 py-2.5 text-sm font-mono text-foreground tabular-nums">
                        {entry.qty}
                      </td>
                      <td className="px-4 py-2.5 text-sm font-mono text-foreground/80">
                        {entry.roomNumber || <span className="text-muted-foreground/40">—</span>}
                      </td>
                      <td className="px-4 py-2.5 text-sm text-foreground/80">
                        {entry.roomName || <span className="text-muted-foreground/40">—</span>}
                      </td>
                      <td className="px-4 py-2.5 text-sm text-foreground/70 font-mono">
                        {entry.level || <span className="text-muted-foreground/40">—</span>}
                      </td>
                      <td className="px-4 py-2.5 text-sm font-mono text-foreground/60 tabular-nums">
                        {entry.pageNumber}
                      </td>
                      <td className="px-4 py-2.5 text-xs text-muted-foreground font-mono">
                        {entry.plaqueTypeId || <span className="opacity-30">—</span>}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
