import { useRoute } from "wouter";
import { AppShell } from "@/components/layout/Shell";
import { useJobDetails, useStartExtraction, downloadExport } from "@/hooks/use-takeoff";
import { 
  FileText, 
  Cpu, 
  CheckCircle2, 
  AlertTriangle, 
  Download, 
  Play, 
  Loader2,
  ListFilter
} from "lucide-react";
import { format } from "date-fns";
import { motion } from "framer-motion";

export default function JobDetails() {
  const [, params] = useRoute("/jobs/:jobId");
  const jobId = params?.jobId || "";
  
  const { data, isLoading, isError, error } = useJobDetails(jobId);
  const extractMutation = useStartExtraction();

  const handleStartExtraction = () => {
    if (jobId) {
      extractMutation.mutate({ jobId });
    }
  };

  const handleExport = () => {
    if (jobId) {
      downloadExport(jobId);
    }
  };

  if (isLoading && !data) {
    return (
      <AppShell>
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="w-8 h-8 text-primary animate-spin" />
        </div>
      </AppShell>
    );
  }

  if (isError || !data) {
    return (
      <AppShell>
        <div className="p-8 text-destructive">
          Error loading job: {error?.message || "Unknown error"}
        </div>
      </AppShell>
    );
  }

  const { job, files, extractedSigns, totalSigns, flaggedCount, highConfidenceCount } = data;
  const isProcessing = job.status === "processing" || extractMutation.isPending;
  const isCompleted = job.status === "completed";
  const isPending = job.status === "pending";
  const isFailed = job.status === "failed";

  return (
    <AppShell>
      <div className="flex flex-col h-screen overflow-hidden">
        {/* Header Area */}
        <header className="flex-none p-6 border-b border-border bg-background">
          <div className="flex items-start justify-between max-w-7xl mx-auto w-full gap-4">
            <div>
              <div className="flex items-center gap-3 mb-2">
                <h1 className="text-2xl font-display text-foreground leading-none">
                  Job <span className="text-primary">{job.id.split('-')[0]}</span>
                </h1>
                <StatusBadge status={job.status} />
              </div>
              <p className="text-sm text-muted-foreground font-mono">
                Created {format(new Date(job.createdAt), "PP pp")} • {files.length} file(s)
              </p>
              
              {isFailed && job.error && (
                <div className="mt-3 text-sm text-destructive bg-destructive/10 px-3 py-2 rounded border border-destructive/20 inline-block">
                  <span className="font-semibold">Error:</span> {job.error}
                </div>
              )}
            </div>

            <div className="flex items-center gap-3">
              {isPending && (
                <button
                  onClick={handleStartExtraction}
                  disabled={extractMutation.isPending}
                  className="flex items-center gap-2 px-5 py-2.5 bg-primary text-primary-foreground font-display font-semibold uppercase tracking-wide text-sm rounded-lg hover:bg-primary/90 transition-all shadow-[0_0_15px_rgba(255,170,0,0.1)] active:scale-95 disabled:opacity-50"
                >
                  {extractMutation.isPending ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Play className="w-4 h-4 fill-current" />
                  )}
                  Start Extraction
                </button>
              )}

              {isCompleted && (
                <button
                  onClick={handleExport}
                  className="flex items-center gap-2 px-5 py-2.5 bg-accent text-accent-foreground font-display font-semibold uppercase tracking-wide text-sm rounded-lg hover:bg-accent/90 transition-all shadow-[0_0_15px_rgba(0,240,255,0.15)] active:scale-95"
                >
                  <Download className="w-4 h-4" />
                  Export XLSX
                </button>
              )}
            </div>
          </div>
        </header>

        {/* Content Area */}
        <div className="flex-1 overflow-hidden flex flex-col bg-background">
          {isProcessing ? (
            <div className="flex-1 flex flex-col items-center justify-center p-8 text-center max-w-lg mx-auto">
              <div className="relative w-24 h-24 mb-8">
                <div className="absolute inset-0 border-4 border-secondary rounded-full"></div>
                <div className="absolute inset-0 border-4 border-primary rounded-full border-t-transparent animate-spin"></div>
                <Cpu className="absolute inset-0 m-auto w-8 h-8 text-primary animate-pulse" />
              </div>
              <h2 className="text-xl font-display text-foreground mb-2">Analyzing Plan Documents...</h2>
              <p className="text-muted-foreground font-mono text-sm max-w-md mx-auto leading-relaxed">
                Gemini AI is reading plan text, identifying sign schedules, and structuring the takeoff data. This may take a minute depending on document size.
              </p>
              
              <div className="mt-8 w-full bg-secondary rounded-full h-1.5 overflow-hidden">
                <div className="h-full bg-primary w-1/2 animate-[progress_2s_ease-in-out_infinite_alternate]" style={{ transformOrigin: 'left' }}></div>
              </div>
            </div>
          ) : isCompleted ? (
            <div className="flex flex-col h-full">
              <div className="flex-none p-4 max-w-7xl mx-auto w-full grid grid-cols-1 md:grid-cols-3 gap-4">
                <SummaryCard 
                  title="Total Signs Extracted" 
                  value={totalSigns} 
                  icon={<ListFilter className="w-5 h-5 text-muted-foreground" />} 
                />
                <SummaryCard 
                  title="High Confidence" 
                  value={highConfidenceCount} 
                  icon={<CheckCircle2 className="w-5 h-5 text-accent" />} 
                  accent="accent"
                />
                <SummaryCard 
                  title="Needs Review" 
                  value={flaggedCount} 
                  icon={<AlertTriangle className="w-5 h-5 text-primary" />} 
                  accent="primary"
                />
              </div>
              
              {/* Data Table Container */}
              <div className="flex-1 overflow-auto bg-card border-t border-border mt-2">
                <div className="min-w-[max-content] inline-block align-top">
                  <table className="w-full text-left border-collapse border-spacing-0">
                    <thead>
                      <tr>
                        <th className="data-header sticky left-0 z-20 shadow-[2px_0_5px_-2px_rgba(0,0,0,0.3)]">Sheet / ID</th>
                        <th className="data-header">Sign Type</th>
                        <th className="data-header w-16 text-center">Qty</th>
                        <th className="data-header">Location</th>
                        <th className="data-header">Dimensions</th>
                        <th className="data-header">Mounting</th>
                        <th className="data-header">Finish / Color</th>
                        <th className="data-header">Message</th>
                        <th className="data-header text-center">Confidence</th>
                        <th className="data-header text-center">Status</th>
                      </tr>
                    </thead>
                    <tbody className="bg-background">
                      {extractedSigns.map((sign, idx) => (
                        <tr 
                          key={sign.id} 
                          className={`
                            hover:bg-secondary/40 transition-colors
                            ${sign.reviewFlag ? 'bg-primary/5' : ''}
                            ${idx % 2 === 0 ? '' : 'bg-card/30'}
                          `}
                        >
                          <td className="data-cell sticky left-0 z-10 bg-inherit shadow-[2px_0_5px_-2px_rgba(0,0,0,0.3)]">
                            <div className="font-mono text-xs text-muted-foreground mb-1">{sign.sheetNumber || '—'}</div>
                            <div className="font-medium text-foreground">{sign.signIdentifier || sign.detailReference || 'Unknown'}</div>
                          </td>
                          <td className="data-cell text-foreground">{sign.signType || '—'}</td>
                          <td className="data-cell text-center font-mono font-medium">{sign.quantity || 1}</td>
                          <td className="data-cell truncate max-w-[200px]" title={sign.location || ''}>{sign.location || '—'}</td>
                          <td className="data-cell font-mono text-xs">{sign.dimensions || '—'}</td>
                          <td className="data-cell">{sign.mountingType || '—'}</td>
                          <td className="data-cell text-xs">{sign.finishColor || '—'}</td>
                          <td className="data-cell truncate max-w-[250px]" title={sign.messageContent || ''}>{sign.messageContent || '—'}</td>
                          <td className="data-cell text-center">
                            <ConfidenceBadge score={sign.confidenceScore} />
                          </td>
                          <td className="data-cell text-center">
                            {sign.reviewFlag && (
                              <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-primary/20 text-primary border border-primary/30">
                                Review
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                      {extractedSigns.length === 0 && (
                        <tr>
                          <td colSpan={10} className="p-8 text-center text-muted-foreground">
                            No signs were extracted from these documents.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex-1 p-8 max-w-3xl mx-auto w-full">
              <h3 className="font-display font-medium text-lg mb-4 text-foreground">Uploaded Files</h3>
              <div className="grid gap-3">
                {files.map(f => (
                  <div key={f.id} className="flex items-center p-4 bg-card border border-border rounded-lg">
                    <FileText className="w-5 h-5 text-muted-foreground mr-4" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-foreground truncate">{f.originalName}</p>
                    </div>
                  </div>
                ))}
              </div>
              
              <div className="mt-8 p-6 bg-secondary rounded-lg border border-border">
                <h4 className="font-medium text-foreground mb-2 flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-primary" /> Ready for processing
                </h4>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  Click the "Start Extraction" button above to send these files to the AI engine. 
                  The system will read the text, locate sign schedules, and extract structured data.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </AppShell>
  );
}

function StatusBadge({ status }: { status: string }) {
  type StatusConfig = { color: string; icon: typeof FileText; label: string };
  const statusMap: Record<string, StatusConfig> = {
    pending: { color: "bg-muted text-muted-foreground border-border", icon: FileText, label: "PENDING" },
    processing: { color: "bg-primary/20 text-primary border-primary/30", icon: Cpu, label: "PROCESSING" },
    completed: { color: "bg-accent/20 text-accent border-accent/30", icon: CheckCircle2, label: "COMPLETED" },
    failed: { color: "bg-destructive/20 text-destructive border-destructive/30", icon: AlertTriangle, label: "FAILED" },
  };
  const config = statusMap[status] ?? statusMap["pending"]!;

  const Icon = config.icon;

  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[10px] font-display font-bold tracking-widest border ${config.color}`}>
      <Icon className="w-3 h-3" />
      {config.label}
    </span>
  );
}

function ConfidenceBadge({ score }: { score: number }) {
  let color = "text-destructive bg-destructive/10 border-destructive/20";
  if (score >= 0.8) color = "text-accent bg-accent/10 border-accent/20";
  else if (score >= 0.6) color = "text-primary bg-primary/10 border-primary/20";

  return (
    <span className={`inline-flex px-2 py-0.5 rounded text-[11px] font-mono font-medium border ${color}`}>
      {Math.round(score * 100)}%
    </span>
  );
}

function SummaryCard({ title, value, icon, accent }: { title: string, value: number, icon: React.ReactNode, accent?: 'primary' | 'accent' }) {
  return (
    <div className="bg-card border border-border p-4 rounded-xl relative overflow-hidden group hover:border-border/80 transition-colors">
      <div className="flex justify-between items-start relative z-10">
        <div>
          <p className="text-xs font-display font-medium text-muted-foreground uppercase tracking-wider mb-1">{title}</p>
          <p className={`text-2xl font-mono font-bold ${accent === 'primary' ? 'text-primary' : accent === 'accent' ? 'text-accent' : 'text-foreground'}`}>
            {value}
          </p>
        </div>
        <div className="p-2 bg-secondary rounded-lg">
          {icon}
        </div>
      </div>
      {accent === 'primary' && <div className="absolute -bottom-4 -right-4 w-24 h-24 bg-primary/5 rounded-full blur-2xl group-hover:bg-primary/10 transition-colors"></div>}
      {accent === 'accent' && <div className="absolute -bottom-4 -right-4 w-24 h-24 bg-accent/5 rounded-full blur-2xl group-hover:bg-accent/10 transition-colors"></div>}
    </div>
  );
}
