import { useState, useEffect } from "react";
import { AppShell } from "@/components/layout/Shell";
import { useJobsList, downloadExport } from "@/hooks/use-takeoff";
import { apiFetch, openPdfInNewTab } from "@/lib/apiClient";
import { useQueryClient } from "@tanstack/react-query";
import { getListJobsQueryKey } from "@workspace/api-client-react";
import { format, formatDistanceToNow } from "date-fns";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import {
  FolderOpen, Eye, FileText, CheckCircle2, Cpu,
  AlertTriangle, Trash2, X, Square, CheckSquare, MinusSquare,
  Archive, EyeOff, Table2, FileDown, FileSpreadsheet, Loader2,
} from "lucide-react";
import { Link, useLocation } from "wouter";
import { exportMarkedupPdf, type MarkerSign } from "@/lib/exportMarkedupPdf";


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
  const [showArchived, setShowArchived] = useState(false);
  const { data, isLoading } = useJobsList(showArchived);
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [deletingSingle, setDeletingSingle] = useState<string | null>(null);
  const [bulkConfirming, setBulkConfirming] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [exportingPdf, setExportingPdf] = useState<Set<string>>(new Set());
  const [exportingXlsx, setExportingXlsx] = useState<Set<string>>(new Set());
  const { toast } = useToast();

  const handleMarkedPdf = async (jobId: string, jobName: string | null | undefined, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (exportingPdf.has(jobId)) return;
    setExportingPdf((prev) => new Set(prev).add(jobId));
    try {
      const res = await apiFetch(`/api/jobs/${jobId}`);
      if (!res.ok) throw new Error("Failed to fetch job details");
      const jobData = await res.json() as {
        extractedSigns?: MarkerSign[];
        files?: { id: string; originalName: string }[];
      };
      const signs = (jobData.extractedSigns ?? []).filter((s) => s.pageNumber != null);
      await exportMarkedupPdf(
        jobId,
        jobName ?? `Job-${jobId.split("-")[0]}`,
        jobData.files ?? [],
        signs
      );
      apiFetch(`/api/jobs/${jobId}/log-pdf-export`, { method: "POST" }).catch(() => {});
      toast({ title: "Marked PDF downloaded" });
    } catch (err) {
      console.error("Marked PDF export failed:", err);
      toast({ title: "PDF export failed", description: "Please try again", variant: "destructive" });
    } finally {
      setExportingPdf((prev) => { const n = new Set(prev); n.delete(jobId); return n; });
    }
  };
  const handleXlsxExport = async (jobId: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (exportingXlsx.has(jobId)) return;
    setExportingXlsx((prev) => new Set(prev).add(jobId));
    try {
      await downloadExport(jobId);
      toast({ title: "XLSX downloaded" });
    } catch (err) {
      console.error("XLSX export failed:", err);
      toast({ title: "XLSX export failed", description: "Please try again", variant: "destructive" });
    } finally {
      setExportingXlsx((prev) => { const n = new Set(prev); n.delete(jobId); return n; });
    }
  };

  const jobs = (data?.jobs ?? []) as Array<{
    id: string;
    name?: string | null;
    status: string;
    fileCount: number;
    createdAt: string;
    updatedAt?: string | null;
    currentStep?: string | null;
    recentUsers?: RecentUser[];
    files?: { id: string; originalName: string }[];
    failedFileCount?: number;
    skippedFileCount?: number;
  }>;
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
          <div className="flex items-center gap-3">
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
            <div className="grid grid-cols-[36px_1fr_120px_40px_160px_160px_48px] gap-3 px-4 py-3 border-b border-border bg-secondary/50 text-xs font-display font-semibold uppercase tracking-wider text-muted-foreground items-center">
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
              <div className="text-center">Status</div>
              <div className="text-center" title="Last active user">User</div>
              <div className="text-right">Created</div>
              <div className="text-right pr-8">Updated</div>
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
                  files?: { id: string; originalName: string }[];
                };
                const recentUsers: RecentUser[] = jobAny.recentUsers ?? [];
                const jobFiles: { id: string; originalName: string }[] = jobAny.files ?? [];

                const isProcessing = job.status === "processing";
                const currentStep = isProcessing ? (jobAny as typeof job & { currentStep?: string | null }).currentStep : null;
                const failedFileCount = job.failedFileCount ?? 0;
                const skippedFileCount = job.skippedFileCount ?? 0;
                const hasExtractionIssues = failedFileCount > 0 || skippedFileCount > 0;

                return (
                  <div key={job.id} className="flex flex-col">
                    {/* Main row */}
                    <div
                      className={`relative group grid grid-cols-[36px_1fr_120px_40px_160px_160px_48px] gap-3 items-center transition-colors
                        ${isChecked ? "bg-primary/5 border-l-2 border-l-primary" : "hover:bg-secondary/40"}`}
                    >
                    {isProcessing && <IndeterminateBar />}

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
                          <div className="text-xs font-mono text-muted-foreground/60 truncate mt-0.5">
                            {job.id.split("-")[0]}
                            {isProcessing && currentStep && (
                              <span className="ml-2 text-primary/60 font-sans normal-case tracking-normal font-normal not-italic">
                                · {currentStep}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>

                      <div className="flex flex-col items-center justify-center gap-1 py-4">
                        <StatusIcon status={job.status} />
                        {isProcessing && (
                          <span className="text-[10px] font-mono text-primary/70 tabular-nums">
                            <ElapsedTimer createdAt={job.createdAt} />
                          </span>
                        )}
                        {hasExtractionIssues && !isProcessing && (
                          <button
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              navigate(`/jobs/${job.id}?tab=timeline`);
                            }}
                            title="Some files had extraction issues — click to see the timeline"
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-display font-bold uppercase tracking-wider bg-amber-500/15 text-amber-400 border border-amber-500/30 hover:bg-amber-500/25 transition-colors cursor-pointer"
                          >
                            <AlertTriangle className="w-2.5 h-2.5 flex-shrink-0" />
                            {failedFileCount > 0 && skippedFileCount > 0
                              ? `${failedFileCount} failed · ${skippedFileCount} skipped`
                              : failedFileCount > 0
                              ? `${failedFileCount} file${failedFileCount > 1 ? "s" : ""} failed`
                              : `${skippedFileCount} skipped`}
                          </button>
                        )}
                      </div>

                      <div className="flex justify-center py-4">
                        <StackedUserBadges users={recentUsers} />
                      </div>

                      <div className="text-right text-sm text-muted-foreground py-4">
                        {format(new Date(job.createdAt), "MMM d, yyyy HH:mm")}
                      </div>

                      <div className="text-right text-sm text-muted-foreground py-4 pr-8">
                        {job.updatedAt
                          ? format(new Date(job.updatedAt), "MMM d, yyyy HH:mm")
                          : <span className="text-muted-foreground/30">—</span>}
                      </div>

                      <div className="flex justify-end items-center pr-2 py-4 text-muted-foreground group-hover:text-primary transition-colors">
                        <Eye className="w-5 h-5" />
                      </div>
                    </Link>

                    {/* Quick-action buttons for completed jobs */}
                    {!isChecked && job.status === "completed" && (
                      <div className="absolute right-[88px] top-1/2 -translate-y-1/2 flex items-center gap-1 z-10 opacity-0 group-hover:opacity-100 transition-opacity">
                        <Link
                          href={`/jobs/${job.id}?tab=signs`}
                          onClick={(e: React.MouseEvent) => e.stopPropagation()}
                          title="View sign table results"
                          className="flex items-center gap-1 px-2 py-1 rounded text-[11px] font-display font-semibold text-primary bg-primary/10 border border-primary/30 hover:bg-primary/20 transition-all"
                        >
                          <Table2 className="w-3.5 h-3.5" />
                          Results
                        </Link>
                        <button
                          onClick={(e) => handleMarkedPdf(job.id, job.name, e)}
                          disabled={exportingPdf.has(job.id)}
                          title="Download marked-up PDF"
                          className="flex items-center gap-1 px-2 py-1 rounded text-[11px] font-display font-semibold text-foreground/70 bg-secondary border border-border hover:text-foreground hover:bg-secondary/80 transition-all disabled:opacity-50"
                        >
                          {exportingPdf.has(job.id)
                            ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            : <FileDown className="w-3.5 h-3.5" />}
                          PDF
                        </button>
                        <button
                          onClick={(e) => handleXlsxExport(job.id, e)}
                          disabled={exportingXlsx.has(job.id)}
                          title="Download XLSX export"
                          className="flex items-center gap-1 px-2 py-1 rounded text-[11px] font-display font-semibold text-foreground/70 bg-secondary border border-border hover:text-foreground hover:bg-secondary/80 transition-all disabled:opacity-50"
                        >
                          {exportingXlsx.has(job.id)
                            ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            : <FileSpreadsheet className="w-3.5 h-3.5" />}
                          XLSX
                        </button>
                      </div>
                    )}

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

function ElapsedTimer({ createdAt }: { createdAt: string }) {
  const [elapsed, setElapsed] = useState(() => Math.floor((Date.now() - new Date(createdAt).getTime()) / 1000));

  useEffect(() => {
    const id = setInterval(() => {
      setElapsed(Math.floor((Date.now() - new Date(createdAt).getTime()) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [createdAt]);

  const m = Math.floor(elapsed / 60);
  const s = elapsed % 60;
  return <span>{m > 0 ? `${m}m ` : ""}{s}s</span>;
}

function IndeterminateBar() {
  return (
    <div className="absolute bottom-0 left-0 right-0 h-0.5 overflow-hidden bg-primary/10">
      <div
        className="h-full bg-primary/60 rounded"
        style={{
          width: "40%",
          animation: "indeterminate-slide 1.4s infinite ease-in-out",
        }}
      />
      <style>{`
        @keyframes indeterminate-slide {
          0% { transform: translateX(-100%) scaleX(0.5); }
          50% { transform: translateX(150%) scaleX(1.2); }
          100% { transform: translateX(350%) scaleX(0.5); }
        }
      `}</style>
    </div>
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
