import { useState } from "react";
import { AppShell } from "@/components/layout/Shell";
import { useJobsList } from "@/hooks/use-takeoff";
import { apiFetch, openPdfInNewTab } from "@/lib/apiClient";
import { useQueryClient } from "@tanstack/react-query";
import { getListJobsQueryKey } from "@workspace/api-client-react";
import { format, formatDistanceToNow } from "date-fns";
import { Button } from "@/components/ui/button";
import {
  FolderOpen, ChevronRight, FileText, CheckCircle2, Cpu,
  AlertTriangle, Trash2, X, Square, CheckSquare, MinusSquare,
  Clock, ChevronDown, ExternalLink,
} from "lucide-react";
import { Link } from "wouter";

interface ProcessingStep {
  step: string;
  label: string;
  durationMs: number;
  startedAt: string;
  details?: Record<string, unknown>;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return `${m}m ${s}s`;
}

function ProcessingLog({ steps }: { steps: ProcessingStep[] }) {
  const filtered = steps.filter((s) => s.step !== "total");
  const total = steps.find((s) => s.step === "total");
  const maxMs = Math.max(...filtered.map((s) => s.durationMs), 1);

  const STEP_COLORS: Record<string, string> = {
    project_info: "bg-blue-500",
    spec_processing: "bg-purple-500",
    extraction: "bg-amber-500",
    deduplication: "bg-teal-500",
    word_match: "bg-green-500",
    db_insert: "bg-gray-400",
    bbox_persist: "bg-cyan-500",
  };

  function getBarColor(step: string): string {
    if (step.startsWith("text_extraction_")) return "bg-amber-400";
    if (step.startsWith("visual_verification_")) return "bg-orange-400";
    if (step.startsWith("spatial_prepass_")) return "bg-indigo-400";
    return STEP_COLORS[step] ?? "bg-muted-foreground";
  }

  function formatDetails(details: Record<string, unknown> | undefined): string | null {
    if (!details) return null;
    const parts: string[] = [];
    const d = details as Record<string, number | string | boolean | undefined>;
    const { rows, pages, inputTokens, outputTokens, verified, discoveries, matched, totalSigns, textAfter, imageAfter, textRows, imageRows, signsExtracted, specFileCount, succeeded, failed, textBefore, imageBefore, classified, floorPlan, signSchedule, filesWithBboxes, pagesWithBboxes } = d;
    const { skipReason, skipped } = details as Record<string, string | boolean | undefined>;
    if (specFileCount != null) parts.push(`${specFileCount} spec file${Number(specFileCount) !== 1 ? "s" : ""}`);
    if (rows != null) parts.push(`${rows} rows`);
    if (pages != null) parts.push(`${pages} pages`);
    if (classified != null) parts.push(`${classified} classified`);
    if (floorPlan != null) parts.push(`${floorPlan} floor plan`);
    if (signSchedule != null) parts.push(`${signSchedule} sign sched`);
    if (filesWithBboxes != null) parts.push(`${filesWithBboxes} file${Number(filesWithBboxes) !== 1 ? "s" : ""}`);
    if (pagesWithBboxes != null) parts.push(`${pagesWithBboxes} page${Number(pagesWithBboxes) !== 1 ? "s" : ""}`);
    if (inputTokens != null) parts.push(`${Number(inputTokens).toLocaleString()} in-tok`);
    if (outputTokens != null) parts.push(`${Number(outputTokens).toLocaleString()} out-tok`);
    if (succeeded != null) parts.push(`${succeeded} ok`);
    if (failed != null && Number(failed) > 0) parts.push(`${failed} failed`);
    if (verified != null) parts.push(`${verified} verified`);
    if (discoveries != null) parts.push(`${discoveries} discoveries`);
    if (totalSigns != null && matched != null) parts.push(`${matched}/${totalSigns} matched`);
    if (textBefore != null && textAfter != null) parts.push(`${textAfter}/${textBefore} text`);
    else if (textAfter != null) parts.push(`${textAfter} text`);
    if (imageBefore != null && imageAfter != null) parts.push(`${imageAfter}/${imageBefore} image`);
    else if (imageAfter != null) parts.push(`${imageAfter} image`);
    if (textRows != null) parts.push(`${textRows} text rows`);
    if (imageRows != null) parts.push(`${imageRows} image rows`);
    if (signsExtracted != null) parts.push(`${signsExtracted} signs`);
    if (skipped && skipReason) parts.push(`skipped: ${skipReason}`);
    else if (skipped) parts.push("skipped");
    return parts.length > 0 ? parts.join(" · ") : null;
  }

  return (
    <div className="px-4 pb-4 pt-2 bg-secondary/30 border-t border-border">
      <div className="text-[11px] font-display font-semibold uppercase tracking-wider text-muted-foreground mb-3">
        Processing Timeline
      </div>
      <div className="space-y-1.5">
        {filtered.map((step) => {
          const widthPct = Math.max(2, (step.durationMs / maxMs) * 100);
          const detailStr = formatDetails(step.details);
          return (
            <div key={step.step} className="flex items-center gap-3" title={detailStr ?? undefined}>
              <div className="w-52 shrink-0 text-xs text-foreground/80 truncate leading-tight">
                {step.label}
              </div>
              <div className="flex-1 h-4 bg-muted/40 rounded-sm overflow-hidden">
                <div
                  className={`h-full rounded-sm ${getBarColor(step.step)}`}
                  style={{ width: `${widthPct}%`, opacity: 0.75 }}
                />
              </div>
              <div className="w-14 shrink-0 text-right text-xs font-mono text-foreground/70">
                {formatDuration(step.durationMs)}
              </div>
              {detailStr && (
                <div className="w-48 shrink-0 text-[10px] text-muted-foreground truncate">
                  {detailStr}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {total && (
        <div className="mt-3 pt-2 border-t border-border/60 flex items-center justify-between">
          <span className="text-xs text-muted-foreground font-display">Total</span>
          <span className="text-xs font-bold font-mono text-foreground">{formatDuration(total.durationMs)}</span>
        </div>
      )}
    </div>
  );
}

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
  const { data, isLoading } = useJobsList();
  const queryClient = useQueryClient();

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [deletingSingle, setDeletingSingle] = useState<string | null>(null);
  const [bulkConfirming, setBulkConfirming] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [expandedLog, setExpandedLog] = useState<string | null>(null);

  const jobs = data?.jobs ?? [];
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
    // Exit single-delete confirmation if user starts multi-selecting
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
      await queryClient.invalidateQueries({ queryKey: getListJobsQueryKey() });
      setSelected((prev) => { const n = new Set(prev); n.delete(jobId); return n; });
    } catch (err) {
      console.error("Delete failed:", err);
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
      await queryClient.invalidateQueries({ queryKey: getListJobsQueryKey() });
      setSelected(new Set());
      setBulkConfirming(false);
    } catch (err) {
      console.error("Bulk delete failed:", err);
    } finally {
      setBulkDeleting(false);
    }
  };

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
          <Link
            href="/"
            className="px-4 py-2 bg-secondary text-foreground hover:text-primary border border-border rounded-lg text-sm font-medium transition-colors"
          >
            + New Upload
          </Link>
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
            <div className="grid grid-cols-[36px_1fr_100px_120px_40px_180px_48px] gap-3 px-4 py-3 border-b border-border bg-secondary/50 text-xs font-display font-semibold uppercase tracking-wider text-muted-foreground items-center">
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
              <div>Job Name</div>
              <div className="text-center">Files</div>
              <div className="text-center">Status</div>
              <div className="text-center" title="Last active user">User</div>
              <div className="text-right">Created</div>
              <div />
            </div>

            <div className="divide-y divide-border">
              {jobs.length === 0 && (
                <div className="p-8 text-center text-muted-foreground">No jobs found.</div>
              )}

              {jobs.map((job) => {
                const isChecked = selected.has(job.id);
                const jobAny = job as typeof job & {
                  recentUsers?: RecentUser[];
                  lastActivityAt?: string | null;
                  lastActivityType?: string | null;
                  processingLog?: ProcessingStep[] | null;
                  files?: { id: string; originalName: string }[];
                };
                const recentUsers: RecentUser[] = jobAny.recentUsers ?? [];
                const processingLog: ProcessingStep[] | null = jobAny.processingLog ?? null;
                const jobFiles: { id: string; originalName: string }[] = jobAny.files ?? [];
                const isLogExpanded = expandedLog === job.id;

                return (
                  <div key={job.id} className="flex flex-col">
                    {/* Main row */}
                    <div
                      className={`relative group grid grid-cols-[36px_1fr_100px_120px_40px_180px_48px] gap-3 items-center transition-colors
                        ${isChecked ? "bg-primary/5 border-l-2 border-l-primary" : isLogExpanded ? "bg-secondary/40" : "hover:bg-secondary/40"}`}
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
                    <Link href={`/jobs/${job.id}`} className="contents outline-none">
                      <div className="min-w-0 py-4 flex items-center gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-medium text-foreground truncate">
                            {job.name ?? "Untitled Job"}
                          </div>
                          <div className="text-xs font-mono text-muted-foreground/60 truncate mt-0.5">
                            {job.id.split("-")[0]}
                          </div>
                        </div>
                        {processingLog && processingLog.length > 0 && (
                          <button
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              setExpandedLog(isLogExpanded ? null : job.id);
                            }}
                            title={isLogExpanded ? "Hide processing log" : "View processing log"}
                            className={`flex-none flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono transition-all border
                              ${isLogExpanded
                                ? "text-primary bg-primary/10 border-primary/30"
                                : "text-muted-foreground/40 border-border/40 hover:text-primary hover:bg-primary/10 hover:border-primary/30"
                              }`}
                          >
                            <Clock className="w-3 h-3" />
                            <ChevronDown className={`w-3 h-3 transition-transform ${isLogExpanded ? "rotate-180" : ""}`} />
                          </button>
                        )}
                      </div>

                      <div className="flex flex-col items-center justify-center gap-1 py-4">
                        {jobFiles.length > 0 ? jobFiles.map((f) => (
                          <button
                            key={f.id}
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              openPdfInNewTab(job.id, f.id, f.originalName).catch(() => {});
                            }}
                            title={`Open ${f.originalName} in new tab`}
                            className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium text-muted-foreground border border-border hover:text-primary hover:border-primary/50 transition-colors max-w-[88px]"
                          >
                            <ExternalLink className="w-3 h-3 flex-shrink-0" />
                            <span className="truncate">{f.originalName.replace(/\.pdf$/i, "")}</span>
                          </button>
                        )) : (
                          <span className="flex items-center gap-1.5 text-muted-foreground text-sm font-mono">
                            <FileText className="w-4 h-4" />
                            {job.fileCount}
                          </span>
                        )}
                      </div>

                      <div className="flex justify-center py-4">
                        <StatusIcon status={job.status} />
                      </div>

                      <div className="flex justify-center py-4">
                        <StackedUserBadges users={recentUsers} />
                      </div>

                      <div className="text-right text-sm text-muted-foreground py-4">
                        {format(new Date(job.createdAt), "MMM d, yyyy HH:mm")}
                      </div>

                      <div className="flex justify-end items-center pr-2 py-4 text-muted-foreground group-hover:text-primary transition-colors">
                        <ChevronRight className="w-5 h-5" />
                      </div>
                    </Link>

                    {/* Single-row delete — overlaps the chevron area on hover */}
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
                            className="p-1.5 rounded text-muted-foreground/30 hover:text-destructive hover:bg-destructive/10 transition-all opacity-0 group-hover:opacity-100"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    )}
                    </div>

                    {isLogExpanded && processingLog && processingLog.length > 0 && (
                      <ProcessingLog steps={processingLog} />
                    )}
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
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-display font-bold uppercase tracking-wider bg-muted text-muted-foreground border border-border">
      <div className="w-1.5 h-1.5 rounded-full bg-current" /> Pending
    </span>
  );
}
