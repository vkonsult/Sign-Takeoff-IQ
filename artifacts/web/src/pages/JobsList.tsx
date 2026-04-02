import { useState } from "react";
import { AppShell } from "@/components/layout/Shell";
import { useJobsList } from "@/hooks/use-takeoff";
import { apiFetch } from "@/lib/apiClient";
import { useQueryClient } from "@tanstack/react-query";
import { getListJobsQueryKey } from "@workspace/api-client-react";
import { format } from "date-fns";
import {
  FolderOpen, ChevronRight, FileText, CheckCircle2, Cpu,
  AlertTriangle, Trash2, X, Square, CheckSquare, MinusSquare,
} from "lucide-react";
import { Link } from "wouter";

export default function JobsList() {
  const { data, isLoading } = useJobsList();
  const queryClient = useQueryClient();

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [deletingSingle, setDeletingSingle] = useState<string | null>(null);
  const [bulkConfirming, setBulkConfirming] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);

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
            <div className="grid grid-cols-[36px_1fr_100px_120px_180px_48px] gap-3 px-4 py-3 border-b border-border bg-secondary/50 text-xs font-display font-semibold uppercase tracking-wider text-muted-foreground items-center">
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
              <div className="text-right">Created</div>
              <div />
            </div>

            <div className="divide-y divide-border">
              {jobs.length === 0 && (
                <div className="p-8 text-center text-muted-foreground">No jobs found.</div>
              )}

              {jobs.map((job) => {
                const isChecked = selected.has(job.id);
                return (
                  <div
                    key={job.id}
                    className={`relative group grid grid-cols-[36px_1fr_100px_120px_180px_48px] gap-3 items-center transition-colors
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
                    <Link href={`/jobs/${job.id}`} className="contents">
                      <div className="min-w-0 py-4">
                        <div className="text-sm font-medium text-foreground truncate">
                          {job.name ?? "Untitled Job"}
                        </div>
                        <div className="text-xs font-mono text-muted-foreground/60 truncate mt-0.5">
                          {job.id.split("-")[0]}
                        </div>
                      </div>

                      <div className="flex items-center justify-center gap-1.5 text-muted-foreground text-sm font-mono py-4">
                        <FileText className="w-4 h-4" />
                        {job.fileCount}
                      </div>

                      <div className="flex justify-center py-4">
                        <StatusIcon status={job.status} />
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
                  <button
                    onClick={() => setBulkConfirming(false)}
                    className="px-3 py-1.5 rounded-lg text-sm font-medium bg-secondary border border-border text-foreground hover:bg-secondary/80 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleBulkDelete}
                    disabled={bulkDeleting}
                    className="flex items-center gap-2 px-4 py-1.5 rounded-lg text-sm font-bold bg-destructive text-white hover:bg-destructive/90 transition-colors disabled:opacity-60"
                  >
                    <Trash2 className="w-4 h-4" />
                    {bulkDeleting ? "Deleting…" : `Delete ${selected.size} plan${selected.size > 1 ? "s" : ""}`}
                  </button>
                </>
              ) : (
                <>
                  <button
                    onClick={clearSelection}
                    className="px-3 py-1.5 rounded-lg text-sm font-medium bg-secondary border border-border text-muted-foreground hover:text-foreground transition-colors"
                  >
                    Clear
                  </button>
                  <button
                    onClick={handleBulkDelete}
                    className="flex items-center gap-2 px-4 py-1.5 rounded-lg text-sm font-bold bg-secondary border border-destructive/40 text-destructive hover:bg-destructive/10 transition-colors"
                  >
                    <Trash2 className="w-4 h-4" />
                    Delete Selected
                  </button>
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
  if (status === "completed") return <div className="flex items-center gap-1.5 text-accent text-xs font-bold uppercase tracking-wider"><CheckCircle2 className="w-4 h-4" /> Done</div>;
  if (status === "processing") return <div className="flex items-center gap-1.5 text-primary text-xs font-bold uppercase tracking-wider"><Cpu className="w-4 h-4 animate-pulse" /> Proc</div>;
  if (status === "failed") return <div className="flex items-center gap-1.5 text-destructive text-xs font-bold uppercase tracking-wider"><AlertTriangle className="w-4 h-4" /> Fail</div>;
  return <div className="flex items-center gap-1.5 text-muted-foreground text-xs font-bold uppercase tracking-wider"><div className="w-2 h-2 rounded-full bg-current" /> Pend</div>;
}
