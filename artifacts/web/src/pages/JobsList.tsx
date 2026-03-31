import { useState } from "react";
import { AppShell } from "@/components/layout/Shell";
import { useJobsList } from "@/hooks/use-takeoff";
import { useQueryClient } from "@tanstack/react-query";
import { getListJobsQueryKey } from "@workspace/api-client-react";
import { format } from "date-fns";
import { FolderOpen, ChevronRight, FileText, CheckCircle2, Cpu, AlertTriangle, Trash2, X } from "lucide-react";
import { Link } from "wouter";

export default function JobsList() {
  const { data, isLoading } = useJobsList();
  const queryClient = useQueryClient();
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const handleDelete = async (jobId: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (confirmDelete !== jobId) {
      setConfirmDelete(jobId);
      return;
    }
    setDeleting(jobId);
    try {
      const res = await fetch(`/api/jobs/${jobId}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Delete failed");
      await queryClient.invalidateQueries({ queryKey: getJobsListQueryKey() });
    } catch (err) {
      console.error("Delete job failed:", err);
    } finally {
      setDeleting(null);
      setConfirmDelete(null);
    }
  };

  const cancelDelete = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setConfirmDelete(null);
  };

  return (
    <AppShell>
      <div className="flex-1 p-8 max-w-5xl mx-auto w-full">
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
            {[1,2,3].map(i => (
              <div key={i} className="h-20 bg-card rounded-xl border border-border animate-pulse"></div>
            ))}
          </div>
        ) : (
          <div className="bg-card rounded-xl border border-border overflow-hidden shadow-lg">
            <div className="grid grid-cols-[1fr_120px_120px_200px_44px] gap-4 p-4 border-b border-border bg-secondary/50 text-xs font-display font-semibold uppercase tracking-wider text-muted-foreground">
              <div>Job Name</div>
              <div className="text-center">Files</div>
              <div className="text-center">Status</div>
              <div className="text-right">Created</div>
              <div></div>
            </div>
            
            <div className="divide-y divide-border">
              {data?.jobs?.length === 0 && (
                <div className="p-8 text-center text-muted-foreground">No jobs found.</div>
              )}
              
              {data?.jobs?.map(job => (
                <div key={job.id} className="relative group">
                  <Link
                    href={`/jobs/${job.id}`}
                    className="grid grid-cols-[1fr_120px_120px_200px_44px] gap-4 p-4 items-center hover:bg-secondary/40 transition-colors cursor-pointer"
                  >
                    <div className="min-w-0 pr-4">
                      <div className="text-sm font-medium text-foreground truncate">
                        {job.name ?? "Untitled Job"}
                      </div>
                      <div className="text-xs font-mono text-muted-foreground/60 truncate mt-0.5">
                        {job.id.split('-')[0]}
                      </div>
                    </div>
                    
                    <div className="flex items-center justify-center gap-1.5 text-muted-foreground text-sm font-mono">
                      <FileText className="w-4 h-4" />
                      {job.fileCount}
                    </div>
                    
                    <div className="flex justify-center">
                      <StatusIcon status={job.status} />
                    </div>
                    
                    <div className="text-right text-sm text-muted-foreground">
                      {format(new Date(job.createdAt), "MMM d, yyyy HH:mm")}
                    </div>

                    <div className="flex justify-end text-muted-foreground group-hover:text-primary transition-colors">
                      <ChevronRight className="w-5 h-5" />
                    </div>
                  </Link>

                  {/* Delete button — sits on top of the Link row */}
                  <div className="absolute right-12 top-1/2 -translate-y-1/2 flex items-center gap-1">
                    {confirmDelete === job.id ? (
                      <>
                        <button
                          onClick={(e) => handleDelete(job.id, e)}
                          disabled={deleting === job.id}
                          className="flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-display font-bold uppercase tracking-wide text-destructive bg-destructive/10 border border-destructive/40 hover:bg-destructive hover:text-white transition-all disabled:opacity-50"
                        >
                          {deleting === job.id ? "Deleting…" : "Confirm"}
                        </button>
                        <button
                          onClick={cancelDelete}
                          className="p-1 rounded text-muted-foreground hover:text-foreground transition-colors"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </>
                    ) : (
                      <button
                        onClick={(e) => handleDelete(job.id, e)}
                        title="Delete this job"
                        className="p-1.5 rounded text-muted-foreground/30 hover:text-destructive hover:bg-destructive/10 transition-all opacity-0 group-hover:opacity-100"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </AppShell>
  );
}

function StatusIcon({ status }: { status: string }) {
  if (status === 'completed') return <div className="flex items-center gap-1.5 text-accent text-xs font-bold uppercase tracking-wider"><CheckCircle2 className="w-4 h-4" /> Done</div>;
  if (status === 'processing') return <div className="flex items-center gap-1.5 text-primary text-xs font-bold uppercase tracking-wider"><Cpu className="w-4 h-4 animate-pulse" /> Proc</div>;
  if (status === 'failed') return <div className="flex items-center gap-1.5 text-destructive text-xs font-bold uppercase tracking-wider"><AlertTriangle className="w-4 h-4" /> Fail</div>;
  return <div className="flex items-center gap-1.5 text-muted-foreground text-xs font-bold uppercase tracking-wider"><div className="w-2 h-2 rounded-full bg-current" /> Pend</div>;
}
