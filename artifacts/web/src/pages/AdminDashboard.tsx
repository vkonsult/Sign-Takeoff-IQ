import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { AdminShell } from "@/components/layout/AdminShell";
import { apiFetch } from "@/lib/apiClient";
import { Link } from "wouter";
import {
  Building2, Users, FolderOpen, ArrowRight, TrendingUp, RefreshCw,
  CheckCircle2, XCircle, ChevronUp, ChevronDown, ChevronsUpDown,
} from "lucide-react";

type Stats = { organizations: number; users: number; jobs: number };
type RescanResult = {
  message: string;
  total: number;
  succeeded: number;
  failed: number;
  results: Array<{ jobId: string; name: string; status: "succeeded" | "failed"; error?: string }>;
};

type ExtractionReportRow = {
  jobId: string;
  jobName: string;
  floorPlanPageCount: number;
  signSchedulePageCount: number;
  bothPageCount: number;
  totalSigns: number;
  totalMarkers: number;
  flaggedCount: number;
};

type SortKey = keyof ExtractionReportRow;
type SortDir = "asc" | "desc";

function SortIcon({ col, sortKey, sortDir }: { col: SortKey; sortKey: SortKey; sortDir: SortDir }) {
  if (col !== sortKey) return <ChevronsUpDown className="w-3 h-3 opacity-40" />;
  return sortDir === "asc"
    ? <ChevronUp className="w-3 h-3" />
    : <ChevronDown className="w-3 h-3" />;
}

export default function AdminDashboard() {
  const statsQuery = useQuery({
    queryKey: ["admin-stats"],
    queryFn: async () => {
      const res = await apiFetch("/api/admin/stats");
      if (!res.ok) throw new Error("Failed to load stats");
      return res.json() as Promise<Stats>;
    },
  });

  const [reportKey, setReportKey] = useState(0);
  const reportQuery = useQuery({
    queryKey: ["admin-extraction-report", reportKey],
    queryFn: async () => {
      const res = await apiFetch("/api/admin/extraction-report");
      if (!res.ok) throw new Error("Failed to load extraction report");
      const data = await res.json() as { report: ExtractionReportRow[] };
      return data.report;
    },
  });

  const stats = statsQuery.data;

  const [rescanState, setRescanState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [rescanResult, setRescanResult] = useState<RescanResult | null>(null);
  const [rescanError, setRescanError] = useState<string | null>(null);

  async function handleRescanAll() {
    if (rescanState === "running") return;
    setRescanState("running");
    setRescanResult(null);
    setRescanError(null);
    try {
      const res = await apiFetch("/api/admin/rescan-all", { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as RescanResult;
      setRescanResult(data);
      setRescanState("done");
      statsQuery.refetch();
      setReportKey((k) => k + 1);
    } catch (err) {
      setRescanError(err instanceof Error ? err.message : String(err));
      setRescanState("error");
    }
  }

  const [sortKey, setSortKey] = useState<SortKey>("jobName");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  function handleSort(col: SortKey) {
    if (sortKey === col) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(col);
      setSortDir("asc");
    }
  }

  const sortedReport = useMemo(() => {
    if (!reportQuery.data) return [];
    return [...reportQuery.data].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (typeof av === "number" && typeof bv === "number") {
        return sortDir === "asc" ? av - bv : bv - av;
      }
      const as = String(av).toLowerCase();
      const bs = String(bv).toLowerCase();
      if (as < bs) return sortDir === "asc" ? -1 : 1;
      if (as > bs) return sortDir === "asc" ? 1 : -1;
      return 0;
    });
  }, [reportQuery.data, sortKey, sortDir]);

  const cards = [
    {
      label: "Organizations",
      value: stats?.organizations ?? "—",
      icon: Building2,
      href: "/admin/organizations",
      color: "text-blue-400",
      bg: "bg-blue-900/20",
      description: "Active tenants on the platform",
    },
    {
      label: "Total Users",
      value: stats?.users ?? "—",
      icon: Users,
      href: "/admin/users",
      color: "text-purple-400",
      bg: "bg-purple-900/20",
      description: "All users across all organizations",
    },
    {
      label: "Total Jobs",
      value: stats?.jobs ?? "—",
      icon: FolderOpen,
      href: null,
      color: "text-green-400",
      bg: "bg-green-900/20",
      description: "Sign takeoff jobs processed",
    },
  ];

  const reportCols: Array<{ key: SortKey; label: string; numeric?: boolean }> = [
    { key: "jobName", label: "Job Name" },
    { key: "floorPlanPageCount", label: "Floor Plan Pages", numeric: true },
    { key: "signSchedulePageCount", label: "Sign Schedule Pages", numeric: true },
    { key: "bothPageCount", label: "Both Pages", numeric: true },
    { key: "totalMarkers", label: "Total Markers", numeric: true },
    { key: "flaggedCount", label: "Flagged", numeric: true },
    { key: "totalSigns", label: "Total Signs", numeric: true },
  ];

  return (
    <AdminShell section="super">
      <div className="flex-1 p-8">
        <header className="mb-8">
          <div className="flex items-center gap-3 mb-1">
            <TrendingUp className="w-5 h-5 text-primary" />
            <h1 className="text-xl font-display font-bold text-foreground">Platform Dashboard</h1>
          </div>
          <p className="text-sm text-muted-foreground">Overview of all tenants, users, and activity</p>
        </header>

        {/* Stats */}
        <div className="grid grid-cols-3 gap-5 mb-8">
          {cards.map((card) => (
            <div
              key={card.label}
              className="bg-card border border-border rounded-xl p-5 flex flex-col gap-3"
            >
              <div className="flex items-center justify-between">
                <div className={`w-9 h-9 rounded-lg ${card.bg} flex items-center justify-center`}>
                  <card.icon className={`w-4.5 h-4.5 ${card.color}`} />
                </div>
                {card.href && (
                  <Link href={card.href} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors">
                    View <ArrowRight className="w-3 h-3" />
                  </Link>
                )}
              </div>
              <div>
                <p className="text-3xl font-display font-bold text-foreground">
                  {statsQuery.isLoading ? (
                    <span className="animate-pulse bg-secondary rounded inline-block w-8 h-7" />
                  ) : (
                    stats ? card.value : "—"
                  )}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">{card.label}</p>
              </div>
              <p className="text-xs text-muted-foreground border-t border-border pt-2">{card.description}</p>
            </div>
          ))}
        </div>

        {/* Quick links */}
        <div className="bg-card border border-border rounded-xl p-5 mb-5">
          <h2 className="text-sm font-semibold text-foreground mb-4">Quick Actions</h2>
          <div className="grid grid-cols-2 gap-3">
            <Link href="/admin/organizations"
              className="flex items-center gap-3 px-4 py-3 rounded-lg border border-border bg-secondary/30 hover:bg-secondary transition-colors group">
              <Building2 className="w-4 h-4 text-muted-foreground group-hover:text-primary transition-colors" />
              <div>
                <p className="text-sm font-medium text-foreground">Manage Organizations</p>
                <p className="text-xs text-muted-foreground">Create & view tenants</p>
              </div>
              <ArrowRight className="w-3.5 h-3.5 text-muted-foreground ml-auto opacity-0 group-hover:opacity-100 transition-opacity" />
            </Link>
            <Link href="/admin/users"
              className="flex items-center gap-3 px-4 py-3 rounded-lg border border-border bg-secondary/30 hover:bg-secondary transition-colors group">
              <Users className="w-4 h-4 text-muted-foreground group-hover:text-primary transition-colors" />
              <div>
                <p className="text-sm font-medium text-foreground">View All Users</p>
                <p className="text-xs text-muted-foreground">Cross-organization user list</p>
              </div>
              <ArrowRight className="w-3.5 h-3.5 text-muted-foreground ml-auto opacity-0 group-hover:opacity-100 transition-opacity" />
            </Link>
          </div>
        </div>

        {/* Rescan All Jobs */}
        <div className="bg-card border border-border rounded-xl p-5 mb-5">
          <h2 className="text-sm font-semibold text-foreground mb-1">Data Operations</h2>
          <p className="text-xs text-muted-foreground mb-4">
            Re-run the PDF extraction pipeline across all jobs. Auto-extracted signs and page metadata are reset; user-verified and manually added signs are preserved. PNGs on disk are reused.
          </p>

          <div className="flex items-center gap-3 flex-wrap">
            <button
              onClick={handleRescanAll}
              disabled={rescanState === "running"}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
            >
              <RefreshCw className={`w-4 h-4 ${rescanState === "running" ? "animate-spin" : ""}`} />
              {rescanState === "running" ? "Rescanning…" : "Rescan All Jobs"}
            </button>

            {rescanState === "done" && rescanResult && (
              <div className="flex items-center gap-2 text-sm">
                <CheckCircle2 className="w-4 h-4 text-green-400 shrink-0" />
                <span className="text-foreground">{rescanResult.message}</span>
              </div>
            )}

            {rescanState === "error" && rescanError && (
              <div className="flex items-center gap-2 text-sm">
                <XCircle className="w-4 h-4 text-red-400 shrink-0" />
                <span className="text-red-400">{rescanError}</span>
              </div>
            )}
          </div>

          {rescanState === "done" && rescanResult && rescanResult.failed > 0 && (
            <div className="mt-4 rounded-lg border border-border bg-secondary/30 p-3">
              <p className="text-xs font-medium text-foreground mb-2">Failed jobs:</p>
              <ul className="space-y-1">
                {rescanResult.results
                  .filter((r) => r.status === "failed")
                  .map((r) => (
                    <li key={r.jobId} className="text-xs text-muted-foreground">
                      <span className="text-red-400 font-medium">{r.name}</span>
                      {r.error && <span className="ml-2 opacity-70">— {r.error}</span>}
                    </li>
                  ))}
              </ul>
            </div>
          )}
        </div>

        {/* Extraction Report */}
        <div className="bg-card border border-border rounded-xl p-5">
          <div className="flex items-center justify-between mb-1">
            <h2 className="text-sm font-semibold text-foreground">Extraction Report</h2>
            <button
              onClick={() => setReportKey((k) => k + 1)}
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <RefreshCw className={`w-3 h-3 ${reportQuery.isFetching ? "animate-spin" : ""}`} />
              Refresh
            </button>
          </div>
          <p className="text-xs text-muted-foreground mb-4">
            Live data from the database — page classification and sign counts per job.
          </p>

          {reportQuery.isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="h-8 rounded bg-secondary/40 animate-pulse" />
              ))}
            </div>
          ) : reportQuery.isError ? (
            <p className="text-xs text-red-400">Failed to load extraction report.</p>
          ) : sortedReport.length === 0 ? (
            <p className="text-xs text-muted-foreground">No jobs found.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border">
                    {reportCols.map((col) => (
                      <th
                        key={col.key}
                        onClick={() => handleSort(col.key)}
                        className={`py-2 pr-4 text-left font-medium text-muted-foreground cursor-pointer hover:text-foreground select-none whitespace-nowrap ${col.numeric ? "text-right pr-3 pl-0" : ""}`}
                      >
                        <span className="inline-flex items-center gap-1">
                          {col.label}
                          <SortIcon col={col.key} sortKey={sortKey} sortDir={sortDir} />
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sortedReport.map((row) => (
                    <tr key={row.jobId} className="border-b border-border/50 hover:bg-secondary/20 transition-colors">
                      <td className="py-2 pr-4 text-foreground font-medium max-w-[200px] truncate" title={row.jobName}>
                        {row.jobName}
                      </td>
                      <td className="py-2 pr-3 text-right text-muted-foreground tabular-nums">
                        {row.floorPlanPageCount > 0 ? (
                          <span className="text-blue-400">{row.floorPlanPageCount}</span>
                        ) : "—"}
                      </td>
                      <td className="py-2 pr-3 text-right text-muted-foreground tabular-nums">
                        {row.signSchedulePageCount > 0 ? (
                          <span className="text-amber-400">{row.signSchedulePageCount}</span>
                        ) : "—"}
                      </td>
                      <td className="py-2 pr-3 text-right text-muted-foreground tabular-nums">
                        {row.bothPageCount > 0 ? (
                          <span className="text-purple-400">{row.bothPageCount}</span>
                        ) : "—"}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {row.totalMarkers > 0 ? (
                          <span className="text-green-400 font-medium">{row.totalMarkers}</span>
                        ) : <span className="text-muted-foreground">0</span>}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {row.flaggedCount > 0 ? (
                          <span className="text-red-400">{row.flaggedCount}</span>
                        ) : <span className="text-muted-foreground">0</span>}
                      </td>
                      <td className="py-2 pr-3 text-right text-muted-foreground tabular-nums">
                        {row.totalSigns}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </AdminShell>
  );
}
