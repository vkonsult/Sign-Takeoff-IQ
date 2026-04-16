import { useState, useMemo } from "react";
import { useSearch, useLocation } from "wouter";
import { logger } from "@/lib/logger";
import { AppShell } from "@/components/layout/Shell";
import { useJobsList } from "@/hooks/use-takeoff";
import { apiFetch, openPdfInNewTab } from "@/lib/apiClient";
import { logger } from "@/lib/logger";
import { useQueryClient } from "@tanstack/react-query";
import { getListJobsQueryKey, type JobSummary } from "@workspace/api-client-react";
import { format, formatDistanceToNow } from "date-fns";
import { Button } from "@/components/ui/button";
import {
  FolderOpen, Eye, FileText, CheckCircle2, Cpu,
  AlertTriangle, Trash2, X, Square, CheckSquare, MinusSquare,
  Archive, EyeOff, Layers, Users, ChevronUp, ChevronDown, ChevronsUpDown,
  MapPinOff,
} from "lucide-react";
import { Link } from "wouter";

const VALID_JOB_TABS = new Set(["table", "sheets", "summary", "floorplans", "signpages", "specs", "timeline", "coords", "ai_scans", "compliance", "plaque_schedule", "occupant_loads"]);

interface RecentUser {
  userName: string;
  userInitials: string;
  at: string;
  eventType?: string;
}

const ACTION_LABELS: Record<string, string> = {
  job_opened: "opened",
  scan_run: "ran scan on",
  sign_updated: "edited signs in",
  xlsx_exported: "exported XLSX for",
  pdf_exported: "exported PDF for",
};

type SortBy = "name" | "status" | "createdAt" | "updatedAt" | "plaqueCount" | "occupantLoadCount" | "unplacedCount";
type SortDir = "asc" | "desc";

const VALID_SORT_COLS: SortBy[] = ["name", "status", "createdAt", "updatedAt", "plaqueCount", "occupantLoadCount", "unplacedCount"];
const DEFAULT_SORT_BY: SortBy = "createdAt";
const DEFAULT_SORT_DIR: SortDir = "desc";

const STATUS_ORDER: Record<string, number> = {
  processing: 0,
  completed: 1,
  failed: 2,
  archived: 3,
};


const SORT_STORAGE_KEY = "jobsList:sortPreference";

function loadSortPreference(): { sortBy: SortBy; sortDir: SortDir } | null {
  try {
    const raw = localStorage.getItem(SORT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const sortBy = (VALID_SORT_COLS as string[]).includes(parsed.sortBy)
      ? (parsed.sortBy as SortBy)
      : null;
    const sortDir: SortDir | null =
      parsed.sortDir === "asc" || parsed.sortDir === "desc" ? parsed.sortDir : null;
    if (!sortBy || !sortDir) return null;
    return { sortBy, sortDir };
  } catch {
    return null;
  }
}

function saveSortPreference(sortBy: SortBy, sortDir: SortDir): void {
  try {
    localStorage.setItem(SORT_STORAGE_KEY, JSON.stringify({ sortBy, sortDir }));
  } catch {
  }
}

function parseSortParams(search: string): { sortBy: SortBy; sortDir: SortDir } {
  const params = new URLSearchParams(search);
  const rawBy = params.get("sortBy") ?? "";
  const rawDir = params.get("sortDir") ?? "";
  const hasUrlSort = rawBy !== "" || rawDir !== "";
  if (hasUrlSort) {
    const sortBy = (VALID_SORT_COLS as string[]).includes(rawBy)
      ? (rawBy as SortBy)
      : DEFAULT_SORT_BY;
    const sortDir: SortDir = rawDir === "asc" || rawDir === "desc" ? rawDir : DEFAULT_SORT_DIR;
    return { sortBy, sortDir };
  }
  const stored = loadSortPreference();
  if (stored) return stored;
  return { sortBy: DEFAULT_SORT_BY, sortDir: DEFAULT_SORT_DIR };
}

function SortIcon({ col, active, dir }: { col: string; active: string; dir: SortDir }) {
  if (col !== active) return <ChevronsUpDown className="w-3 h-3 opacity-40" />;
  return dir === "asc"
    ? <ChevronUp className="w-3 h-3" />
    : <ChevronDown className="w-3 h-3" />;
}

function StackedUserBadges({ users }: { users: RecentUser[] }) {
  if (users.length === 0) return <span className="text-muted-foreground/30 text-xs">—</span>;
  return (
    <div className="flex items-center justify-center">
      {users.map((u, i) => {
        const action = u.eventType ? (ACTION_LABELS[u.eventType] ?? "touched") : "last active in";
        const relTime = formatDistanceToNow(new Date(u.at), { addSuffix: true });
        return (
          <span
            key={u.userName + i}
            title={`${u.userName} ${action} this plan ${relTime}`}
            className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-primary/15 text-primary text-[11px] font-bold flex-shrink-0 ring-2 ring-card cursor-default"
            style={{ marginLeft: i > 0 ? "-8px" : undefined, zIndex: users.length - i }}
          >
            {u.userInitials}
          </span>
        );
      })}
    </div>
  );
}

export default function JobsList() {
  const search = useSearch();
  const [, setLocation] = useLocation();

  const { sortBy, sortDir } = parseSortParams(search);

  const setSort = (col: SortBy) => {
    const newDir: SortDir =
      col === sortBy
        ? (sortDir === "desc" ? "asc" : "desc")
        : col === "name" ? "asc" : DEFAULT_SORT_DIR;
    saveSortPreference(col, newDir);
    const params = new URLSearchParams(search);
    params.set("sortBy", col);
    params.set("sortDir", newDir);
    setLocation(`/jobs?${params.toString()}`, { replace: true });
  };

  const [showArchived, setShowArchived] = useState(false);
  const [showNeedsPlacement, setShowNeedsPlacement] = useState(false);
  const { data, isLoading } = useJobsList(showArchived);
  const queryClient = useQueryClient();

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [deletingSingle, setDeletingSingle] = useState<string | null>(null);
  const [bulkConfirming, setBulkConfirming] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);

  type JobSummaryListItem = JobSummary & {
    name?: string | null;
    updatedAt?: string | null;
    recentUsers?: RecentUser[];
    files?: { id: string; originalName: string }[];
    plaqueCount?: number | null;
    occupantLoadCount?: number | null;
    unplacedCount?: number;
  };

  const jobs = useMemo(() => {
    const rawJobs = (data?.jobs ?? []) as JobSummaryListItem[];
    let result = rawJobs;
    if (showNeedsPlacement) {
      result = result.filter((j) => Number(j.unplacedCount ?? 0) > 0);
    }
    return [...result].sort((a, b) => {
      if (sortBy === "name") {
        const aName = (a.name ?? "").toLowerCase();
        const bName = (b.name ?? "").toLowerCase();
        const cmp = aName.localeCompare(bName);
        return sortDir === "asc" ? cmp : -cmp;
      }
      let aVal: number;
      let bVal: number;
      if (sortBy === "plaqueCount") {
        aVal = Number(a.plaqueCount ?? 0);
        bVal = Number(b.plaqueCount ?? 0);
      } else if (sortBy === "occupantLoadCount") {
        aVal = Number(a.occupantLoadCount ?? 0);
        bVal = Number(b.occupantLoadCount ?? 0);
      } else if (sortBy === "unplacedCount") {
        aVal = Number(a.unplacedCount ?? 0);
        bVal = Number(b.unplacedCount ?? 0);
      } else if (sortBy === "updatedAt") {
        aVal = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
        bVal = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
      } else {
        aVal = new Date(a.createdAt).getTime();
        bVal = new Date(b.createdAt).getTime();
      }
      if (sortBy === "status") {
        const aOrd = STATUS_ORDER[a.status] ?? 99;
        const bOrd = STATUS_ORDER[b.status] ?? 99;
        return sortDir === "asc" ? aOrd - bOrd : bOrd - aOrd;
      }
      return sortDir === "asc" ? aVal - bVal : bVal - aVal;
    });
  }, [data?.jobs, sortBy, sortDir, showNeedsPlacement]);

  const allIds = jobs.map((j) => j.id);
  const allSelected = allIds.length > 0 && allIds.every((id) => selected.has(id));
  const someSelected = selected.size > 0 && !allSelected;
  const anySelected = selected.size > 0;

  const toggleSelect = (id: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setConfirmDelete(null);
  };

  const toggleAll = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(allIds));
    setBulkConfirming(false);
  };

  const clearSelection = () => {
    setSelected(new Set());
    setBulkConfirming(false);
  };

  const handleSingleDelete = async (jobId: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (confirmDelete !== jobId) {
      setConfirmDelete(jobId);
      return;
    }
    setDeletingSingle(jobId);
    try {
      const res = await apiFetch(`/api/jobs/${jobId}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Delete failed");
      localStorage.removeItem(`lastTab:${jobId}`);
      await queryClient.invalidateQueries({ queryKey: getListJobsQueryKey() });
      setSelected((prev) => { const n = new Set(prev); n.delete(jobId); return n; });
    } catch (err) {
      logger.error("Delete failed:", err);
    } finally {
      setDeletingSingle(null);
      setConfirmDelete(null);
    }
  };

  const cancelSingleDelete = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setConfirmDelete(null);
  };

  const handleBulkDelete = async () => {
    if (!bulkConfirming) {
      setBulkConfirming(true);
      return;
    }
    setBulkDeleting(true);
    try {
      const res = await apiFetch("/api/jobs", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobIds: Array.from(selected) }),
      });
      if (!res.ok) throw new Error("Batch delete failed");
      for (const jobId of selected) localStorage.removeItem(`lastTab:${jobId}`);
      await queryClient.invalidateQueries({ queryKey: getListJobsQueryKey() });
      setSelected(new Set());
      setBulkConfirming(false);
    } catch (err) {
      logger.error("Bulk delete failed:", err);
    } finally {
      setBulkDeleting(false);
    }
  };

  function SortHeader({
    col,
    label,
    className,
  }: {
    col: SortBy;
    label: string;
    className?: string;
  }) {
    return (
      <button
        onClick={() => setSort(col)}
        className={`flex items-center gap-1 font-display font-semibold uppercase tracking-wider text-xs transition-colors
          ${sortBy === col ? "text-primary" : "text-muted-foreground hover:text-foreground"}
          ${className ?? ""}`}
      >
        {label}
        <SortIcon col={col} active={sortBy} dir={sortDir} />
      </button>
    );
  }

  return (
    <AppShell>
      <div className="flex-1 p-8 max-w-5xl mx-auto w-full pb-32">
        <header className="mb-8 flex items-end justify-between">
          <div>
            <h1 className="text-3xl font-display text-foreground mb-2 flex items-center gap-3">
              <FolderOpen className="w-8 h-8 text-primary" />
              All Takeoff Jobs
            </h1>
            <p className="text-muted-foreground font-sans">
              History of all processed architectural plan extractions.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setShowNeedsPlacement((prev) => !prev)}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium border transition-colors
                ${showNeedsPlacement
                  ? "bg-orange-500/10 text-orange-400 border-orange-500/30 hover:bg-orange-500/20"
                  : "bg-secondary text-muted-foreground border-border hover:text-foreground"
                }`}
            >
              <MapPinOff className="w-4 h-4" />
              {showNeedsPlacement ? "Clear Filter" : "Needs Placement"}
            </button>
            <button
              onClick={() => {
                setShowArchived((prev) => !prev);
                setSelected(new Set());
              }}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium border transition-colors
                ${showArchived
                  ? "bg-amber-500/10 text-amber-500 border-amber-500/30 hover:bg-amber-500/20"
                  : "bg-secondary text-muted-foreground border-border hover:text-foreground"
                }`}
            >
              {showArchived ? (
                <><EyeOff className="w-4 h-4" /> Hide Archived</>
              ) : (
                <><Archive className="w-4 h-4" /> Show Archived</>
              )}
            </button>
            <Link
              href="/"
              className="px-4 py-2 bg-secondary text-foreground hover:text-primary border border-border rounded-lg text-sm font-medium transition-colors"
            >
              + New Upload
            </Link>
          </div>
        </header>

        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-20 bg-card rounded-xl border border-border animate-pulse" />
            ))}
          </div>
        ) : (
          <div className="bg-card rounded-xl border border-border overflow-hidden shadow-lg">
            {/* Header row */}
            <div className="grid grid-cols-[36px_1fr_120px_40px_160px_160px_48px] gap-3 px-4 py-3 border-b border-border bg-secondary/50 items-center">
              {/* Select-all checkbox */}
              <button
                onClick={toggleAll}
                className="flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
                title={allSelected ? "Deselect all" : "Select all"}
              >
                {allSelected
                  ? <CheckSquare className="w-4 h-4 text-primary" />
                  : someSelected
                    ? <MinusSquare className="w-4 h-4 text-primary" />
                    : <Square className="w-4 h-4" />}
              </button>
              <SortHeader col="name" label="Job Name" />
              <div className="flex justify-center">
                <SortHeader col="status" label="Status" />
              </div>
              <div className="text-center text-xs font-display font-semibold uppercase tracking-wider text-muted-foreground" title="Last active user">User</div>
              <div className="flex justify-end">
                <SortHeader col="createdAt" label="Created" />
              </div>
              <div className="flex justify-end pr-8">
                <SortHeader col="updatedAt" label="Updated" />
              </div>
              <div />
            </div>

            {/* Badge sort bar */}
            <div className="flex items-center gap-2 px-4 py-2 border-b border-border bg-secondary/20">
              <span className="text-[10px] font-display font-semibold uppercase tracking-wider text-muted-foreground/60 mr-1">Sort by:</span>
              <button
                onClick={() => setSort("plaqueCount")}
                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold border transition-colors
                  ${sortBy === "plaqueCount"
                    ? "bg-violet-500/20 text-violet-400 border-violet-500/40"
                    : "bg-violet-500/5 text-violet-400/60 border-violet-500/10 hover:bg-violet-500/15 hover:text-violet-400"}`}
              >
                <Layers className="w-2.5 h-2.5" />
                Plaque count
                <SortIcon col="plaqueCount" active={sortBy} dir={sortDir} />
              </button>
              <button
                onClick={() => setSort("occupantLoadCount")}
                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold border transition-colors
                  ${sortBy === "occupantLoadCount"
                    ? "bg-sky-500/20 text-sky-400 border-sky-500/40"
                    : "bg-sky-500/5 text-sky-400/60 border-sky-500/10 hover:bg-sky-500/15 hover:text-sky-400"}`}
              >
                <Users className="w-2.5 h-2.5" />
                Occ. load count
                <SortIcon col="occupantLoadCount" active={sortBy} dir={sortDir} />
              </button>
              <button
                onClick={() => setSort("unplacedCount")}
                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold border transition-colors
                  ${sortBy === "unplacedCount"
                    ? "bg-orange-500/20 text-orange-400 border-orange-500/40"
                    : "bg-orange-500/5 text-orange-400/60 border-orange-500/10 hover:bg-orange-500/15 hover:text-orange-400"}`}
              >
                <MapPinOff className="w-2.5 h-2.5" />
                Unplaced
                <SortIcon col="unplacedCount" active={sortBy} dir={sortDir} />
              </button>
            </div>

            <div className="divide-y divide-border">
              {jobs.length === 0 && (
                <div className="p-8 text-center text-muted-foreground">
                  {showNeedsPlacement
                    ? "No jobs with unplaced signs."
                    : "No jobs found."}
                </div>
              )}

              {jobs.map((job) => {
                const isChecked = selected.has(job.id);
                const recentUsers: RecentUser[] = job.recentUsers ?? [];
                const jobFiles: { id: string; originalName: string }[] = job.files ?? [];
                const plaqueCount = Number(job.plaqueCount ?? 0);
                const occupantLoadCount = Number(job.occupantLoadCount ?? 0);
                const unplacedCount = Number(job.unplacedCount ?? 0);
                const _storedTab = localStorage.getItem(`lastTab:${job.id}`);
                const _validStoredTab = _storedTab && VALID_JOB_TABS.has(_storedTab) ? _storedTab : null;
                const jobHref = _validStoredTab
                  ? `/jobs/${job.id}?tab=${_validStoredTab}`
                  : `/jobs/${job.id}`;

                return (
                  <div key={job.id} className="flex flex-col">
                    {/* Main row */}
                    <div
                      className={`relative group grid grid-cols-[36px_1fr_120px_40px_160px_160px_48px] gap-3 items-center transition-colors
                        ${isChecked ? "bg-primary/5 border-l-2 border-l-primary" : "hover:bg-secondary/40"}`}
                    >
                    {/* Checkbox */}
                    <button
                      onClick={(e) => toggleSelect(job.id, e)}
                      className={`flex items-center justify-center pl-3 py-4 transition-all
                        ${isChecked ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
                    >
                      {isChecked
                        ? <CheckSquare className="w-4 h-4 text-primary" />
                        : <Square className="w-4 h-4 text-muted-foreground" />}
                    </button>

                    {/* Clickable link area */}
                    <Link href={jobHref} className="contents outline-none">
                      {/* Job name cell — with inline PDF icon(s) */}
                      <div className="min-w-0 py-4 flex items-center gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-medium text-foreground truncate flex items-center gap-1.5">
                            <span className="truncate">{job.name ?? "Untitled Job"}</span>
                            {jobFiles.map((f) => (
                              <button
                                key={f.id}
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  openPdfInNewTab(job.id, f.id, f.originalName).catch(() => {});
                                }}
                                title={`Open ${f.originalName} in new tab`}
                                className="flex-shrink-0 p-0.5 rounded text-muted-foreground/50 hover:text-primary transition-colors"
                              >
                                <FileText className="w-3.5 h-3.5" />
                              </button>
                            ))}
                          </div>
                          <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                            <span className="text-xs font-mono text-muted-foreground/60">
                              {job.id.split("-")[0]}
                            </span>
                            {plaqueCount > 0 && (
                              <span
                                className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-semibold border
                                  ${sortBy === "plaqueCount"
                                    ? "bg-violet-500/20 text-violet-400 border-violet-500/40"
                                    : "bg-violet-500/10 text-violet-400 border-violet-500/20"}`}
                                title={`${plaqueCount} plaque type${plaqueCount !== 1 ? "s" : ""} extracted`}
                              >
                                <Layers className="w-2.5 h-2.5" />
                                {plaqueCount} plaque{plaqueCount !== 1 ? "s" : ""}
                              </span>
                            )}
                            {occupantLoadCount > 0 && (
                              <span
                                className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-semibold border
                                  ${sortBy === "occupantLoadCount"
                                    ? "bg-sky-500/20 text-sky-400 border-sky-500/40"
                                    : "bg-sky-500/10 text-sky-400 border-sky-500/20"}`}
                                title={`${occupantLoadCount} occupant load room${occupantLoadCount !== 1 ? "s" : ""} extracted`}
                              >
                                <Users className="w-2.5 h-2.5" />
                                {occupantLoadCount} occ. load{occupantLoadCount !== 1 ? "s" : ""}
                              </span>
                            )}
                            {unplacedCount > 0 && (
                              <button
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  setLocation(`/jobs/${job.id}?unplaced=1`);
                                }}
                                className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-orange-500/10 text-orange-400 border border-orange-500/20 hover:bg-orange-500/20 hover:border-orange-500/40 transition-colors cursor-pointer"
                                title={`${unplacedCount} sign${unplacedCount !== 1 ? "s" : ""} not yet placed on a floor plan — click to view`}
                              >
                                <MapPinOff className="w-2.5 h-2.5" />
                                {unplacedCount} unplaced
                              </button>
                            )}
                          </div>
                        </div>
                      </div>

                      <div className="flex justify-center py-4">
                        <StatusIcon status={job.status} />
                      </div>

                      <div className="flex justify-center py-4">
                        <StackedUserBadges users={recentUsers} />
                      </div>

                      <div className={`text-right text-sm py-4 ${sortBy === "createdAt" ? "text-foreground font-medium" : "text-muted-foreground"}`}>
                        {format(new Date(job.createdAt), "MMM d, yyyy HH:mm")}
                      </div>

                      <div className={`text-right text-sm py-4 pr-8 ${sortBy === "updatedAt" ? "text-foreground font-medium" : "text-muted-foreground"}`}>
                        {job.updatedAt
                          ? format(new Date(job.updatedAt), "MMM d, yyyy HH:mm")
                          : <span className="text-muted-foreground/30">—</span>}
                      </div>

                      <div className="flex justify-end items-center pr-2 py-4 text-muted-foreground group-hover:text-primary transition-colors">
                        <Eye className="w-5 h-5" />
                      </div>
                    </Link>

                    {/* Single-row delete — always visible, destructive red */}
                    {!isChecked && (
                      <div className="absolute right-10 top-1/2 -translate-y-1/2 flex items-center gap-1 z-10">
                        {confirmDelete === job.id ? (
                          <>
                            <button
                              onClick={(e) => handleSingleDelete(job.id, e)}
                              disabled={deletingSingle === job.id}
                              className="flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-display font-bold uppercase tracking-wide text-destructive bg-destructive/10 border border-destructive/40 hover:bg-destructive hover:text-white transition-all disabled:opacity-50"
                            >
                              {deletingSingle === job.id ? "Deleting…" : "Confirm"}
                            </button>
                            <button
                              onClick={cancelSingleDelete}
                              className="p-1 rounded text-muted-foreground hover:text-foreground transition-colors"
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </>
                        ) : (
                          <button
                            onClick={(e) => handleSingleDelete(job.id, e)}
                            title="Delete this job"
                            className="p-1.5 rounded text-destructive/60 hover:text-destructive hover:bg-destructive/10 transition-all"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* ── Bulk-delete toolbar — slides up from the bottom when rows selected ── */}
      <div
        className={`fixed bottom-0 left-0 right-0 z-50 transition-transform duration-300 ease-in-out
          ${anySelected ? "translate-y-0" : "translate-y-full"}`}
      >
        <div className="max-w-5xl mx-auto px-8 pb-6">
          <div className={`rounded-xl border shadow-2xl p-4 flex items-center gap-4
            ${bulkConfirming
              ? "bg-destructive/10 border-destructive/50"
              : "bg-card border-border"}`}
          >
            {/* Count pill */}
            <div className="flex items-center gap-2 flex-1 min-w-0">
              <span className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-primary text-primary-foreground text-xs font-bold font-mono">
                {selected.size}
              </span>
              <span className="text-sm font-medium text-foreground">
                {selected.size === 1 ? "plan selected" : "plans selected"}
              </span>
              {bulkConfirming && (
                <span className="text-sm text-destructive font-semibold ml-2">
                  — This will permanently delete {selected.size === 1 ? "this plan" : "these plans"} and all extracted sign data.
                </span>
              )}
            </div>

            {/* Actions */}
            <div className="flex items-center gap-2 shrink-0">
              {bulkConfirming ? (
                <>
                  <Button
                    onClick={() => setBulkConfirming(false)}
                    variant="outline"
                    size="sm"
                  >
                    Cancel
                  </Button>
                  <Button
                    onClick={handleBulkDelete}
                    disabled={bulkDeleting}
                    variant="destructive"
                    size="sm"
                    className="font-bold"
                  >
                    <Trash2 className="w-4 h-4" />
                    {bulkDeleting ? "Deleting…" : `Delete ${selected.size} plan${selected.size > 1 ? "s" : ""}`}
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    onClick={clearSelection}
                    variant="outline"
                    size="sm"
                  >
                    <X className="w-3.5 h-3.5" />
                    Clear
                  </Button>
                  <Button
                    onClick={handleBulkDelete}
                    variant="outline"
                    size="sm"
                    className="border-destructive/40 text-destructive hover:bg-destructive/10 font-bold"
                  >
                    <Trash2 className="w-4 h-4" />
                    Delete Selected
                  </Button>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </AppShell>
  );
}

function StatusIcon({ status }: { status: string }) {
  if (status === "completed") return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-display font-bold uppercase tracking-wider bg-green-900/30 text-green-400 border border-green-700/40">
      <CheckCircle2 className="w-3 h-3" /> Done
    </span>
  );
  if (status === "processing") return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-display font-bold uppercase tracking-wider bg-primary/20 text-primary border border-primary/30">
      <Cpu className="w-3 h-3 animate-pulse" /> Processing
    </span>
  );
  if (status === "failed") return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-display font-bold uppercase tracking-wider bg-destructive/20 text-destructive border border-destructive/30">
      <AlertTriangle className="w-3 h-3" /> Failed
    </span>
  );
  if (status === "archived") return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-display font-bold uppercase tracking-wider bg-amber-500/10 text-amber-500 border border-amber-500/30">
      <Archive className="w-3 h-3" /> Archived
    </span>
  );
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-display font-bold uppercase tracking-wider bg-muted text-muted-foreground border border-border">
      <div className="w-1.5 h-1.5 rounded-full bg-current" /> Pending
    </span>
  );
}
