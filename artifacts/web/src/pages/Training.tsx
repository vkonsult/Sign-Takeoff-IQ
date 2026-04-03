import { useState, useCallback, useRef } from "react";
import { useLocation } from "wouter";
import { apiFetch } from "@/lib/apiClient";
import { AppShell } from "@/components/layout/Shell";
import {
  Upload,
  FileText,
  Table2,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  BookOpen,
  ArrowRight,
  X,
  Sparkles,
  ExternalLink,
  Download,
  MapPin,
  Search,
  CircleAlert,
} from "lucide-react";
import { exportVerificationPdf, type VerificationMarker } from "@/lib/exportVerificationPdf";

interface MissedSign {
  signIdentifier: string | null;
  signType: string | null;
  location: string | null;
}

interface VerificationResult {
  extractedCount: number;
  matchedCount: number;
  extraCount: number;
  missedCount: number;
  matchRate: number;
  markers: VerificationMarker[];
  missedSigns: MissedSign[];
}

interface UploadResult {
  jobId: string;
  fileId: string;
  jobName: string;
  signCount: number;
  detectedColumns: string[];
  message: string;
  verification: VerificationResult | null;
}

type FileSlot = "pdf" | "xlsx";

function DropZone({
  slot,
  file,
  onFile,
  onClear,
  accept,
  label,
  sublabel,
  icon: Icon,
  color,
}: {
  slot: FileSlot;
  file: File | null;
  onFile: (slot: FileSlot, f: File) => void;
  onClear: (slot: FileSlot) => void;
  accept: string;
  label: string;
  sublabel: string;
  icon: React.ElementType;
  color: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const dropped = e.dataTransfer.files[0];
      if (dropped) onFile(slot, dropped);
    },
    [slot, onFile]
  );

  return (
    <div
      className={`relative flex flex-col items-center justify-center border-2 rounded-xl p-8 transition-all cursor-pointer min-h-[220px]
        ${dragging ? `border-solid ${color === "primary" ? "border-primary bg-primary/10" : "border-accent bg-accent/10"}` : "border-dashed border-border hover:border-muted-foreground/40 hover:bg-secondary/20"}
        ${file ? `border-solid ${color === "primary" ? "border-primary/50 bg-primary/5" : "border-accent/50 bg-accent/5"}` : ""}
      `}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      onClick={() => !file && inputRef.current?.click()}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(slot, f);
          e.target.value = "";
        }}
      />

      {file ? (
        <div className="flex flex-col items-center gap-3 w-full">
          <div className={`w-12 h-12 rounded-full flex items-center justify-center ${color === "primary" ? "bg-primary/20" : "bg-accent/20"}`}>
            <Icon className={`w-6 h-6 ${color === "primary" ? "text-primary" : "text-accent"}`} />
          </div>
          <div className="text-center">
            <p className={`font-display font-semibold text-sm ${color === "primary" ? "text-primary" : "text-accent"}`}>
              {label}
            </p>
            <p className="text-foreground font-medium text-sm mt-1 truncate max-w-[200px]">{file.name}</p>
            <p className="text-muted-foreground text-xs mt-0.5">{(file.size / 1024).toFixed(0)} KB</p>
          </div>
          <button
            onClick={(e) => { e.stopPropagation(); onClear(slot); }}
            className="absolute top-3 right-3 w-6 h-6 rounded-full bg-secondary hover:bg-destructive/20 hover:text-destructive flex items-center justify-center text-muted-foreground transition-all"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="w-12 h-12 rounded-full bg-secondary flex items-center justify-center">
            <Icon className="w-6 h-6 text-muted-foreground" />
          </div>
          <div>
            <p className="font-display font-semibold text-sm text-foreground">{label}</p>
            <p className="text-muted-foreground text-xs mt-1">{sublabel}</p>
          </div>
          <span className="text-xs px-3 py-1 rounded-full bg-secondary text-muted-foreground border border-border">
            Click or drag & drop
          </span>
        </div>
      )}
    </div>
  );
}

const FIELD_LABELS: Record<string, string> = {
  sheetNumber: "Sheet #",
  detailReference: "Detail Ref",
  signIdentifier: "Sign ID",
  signType: "Sign Type",
  quantity: "Qty",
  location: "Location",
  dimensions: "Dimensions",
  mountingType: "Mounting",
  finishColor: "Finish / Color",
  illumination: "Illumination",
  materials: "Materials",
  messageContent: "Message",
  notes: "Notes",
  pageNumber: "Page #",
};

export default function Training() {
  const [, navigate] = useLocation();
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [xlsxFile, setXlsxFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadStage, setUploadStage] = useState<"importing" | "verifying">("importing");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<UploadResult | null>(null);
  const [exportingPdf, setExportingPdf] = useState(false);

  const handleFile = useCallback((slot: FileSlot, file: File) => {
    if (slot === "pdf") setPdfFile(file);
    else setXlsxFile(file);
    setError(null);
    setResult(null);
  }, []);

  const handleClear = useCallback((slot: FileSlot) => {
    if (slot === "pdf") setPdfFile(null);
    else setXlsxFile(null);
  }, []);

  const handleImport = async () => {
    if (!pdfFile || !xlsxFile) return;
    setUploading(true);
    setUploadStage("importing");
    setError(null);
    setResult(null);

    const form = new FormData();
    form.append("pdf", pdfFile);
    form.append("xlsx", xlsxFile);

    try {
      // Fake stage transition: after ~3s move to "verifying" label
      const stageTimer = setTimeout(() => setUploadStage("verifying"), 3000);
      const res = await apiFetch("/api/training", {
        method: "POST",
        body: form,
      });
      clearTimeout(stageTimer);
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? "Import failed");
        return;
      }
      setResult(json as UploadResult);
      setPdfFile(null);
      setXlsxFile(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setUploading(false);
      setUploadStage("importing");
    }
  };

  const handleDownloadVerificationPdf = async () => {
    if (!result?.verification) return;
    setExportingPdf(true);
    try {
      await exportVerificationPdf(
        result.jobId,
        result.fileId,
        result.jobName,
        result.verification.markers
      );
    } catch (err) {
      setError(`Could not generate verification PDF: ${String(err)}`);
    } finally {
      setExportingPdf(false);
    }
  };

  const canImport = !!pdfFile && !!xlsxFile && !uploading;

  return (
    <AppShell>
      <div className="flex-1 overflow-auto">
        <div className="max-w-3xl mx-auto px-6 py-10">
          {/* Header */}
          <div className="mb-10">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 rounded-lg bg-primary/20 flex items-center justify-center">
                <BookOpen className="w-5 h-5 text-primary" />
              </div>
              <h1 className="text-3xl font-display font-bold text-foreground tracking-tight">
                Training Data Import
              </h1>
            </div>
            <p className="text-muted-foreground text-sm leading-relaxed max-w-2xl">
              Upload a PDF plan together with your existing, hand-verified sign schedule spreadsheet. 
              The system imports all sign rows as ground-truth verified data — this builds a library of 
              confirmed examples that guide every future AI extraction.
            </p>
          </div>

          {/* How it helps */}
          <div className="mb-8 grid grid-cols-3 gap-4">
            {[
              {
                icon: Sparkles,
                title: "Smarter extractions",
                desc: "Verified signs from training data are injected as ground truth context during future AI runs.",
              },
              {
                icon: CheckCircle2,
                title: "Instant verification",
                desc: "All imported signs are marked Verified ✓ immediately — no manual review needed.",
              },
              {
                icon: Table2,
                title: "Flexible formats",
                desc: "Works with any Excel or CSV column layout. Headers are auto-detected by keyword matching.",
              },
            ].map((item) => (
              <div key={item.title} className="p-4 rounded-lg bg-card border border-border">
                <item.icon className="w-5 h-5 text-primary mb-2" />
                <p className="text-xs font-display font-semibold text-foreground mb-1">{item.title}</p>
                <p className="text-[11px] text-muted-foreground leading-relaxed">{item.desc}</p>
              </div>
            ))}
          </div>

          {/* Success result */}
          {result && (
            <div className="mb-8 space-y-4">
              {/* Import summary */}
              <div className="p-5 rounded-xl bg-accent/10 border border-accent/30">
                <div className="flex items-start gap-3">
                  <CheckCircle2 className="w-5 h-5 text-accent mt-0.5 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="font-display font-semibold text-accent text-sm mb-1">
                      {result.signCount} signs imported as verified training data
                    </p>
                    <p className="text-muted-foreground text-xs mb-3">
                      <span className="font-medium text-foreground">{result.jobName}</span>
                    </p>
                    <div className="flex flex-wrap gap-1.5 mb-3">
                      {result.detectedColumns.map((col) => (
                        <span key={col} className="px-2 py-0.5 rounded-full text-[10px] bg-accent/20 text-accent font-mono border border-accent/30">
                          {FIELD_LABELS[col] ?? col}
                        </span>
                      ))}
                    </div>
                    <button
                      onClick={() => navigate(`/jobs/${result.jobId}`)}
                      className="inline-flex items-center gap-1.5 text-xs text-accent hover:underline font-medium"
                    >
                      View imported job <ExternalLink className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              </div>

              {/* Verification results */}
              {result.verification && (
                <div className="rounded-xl border border-border bg-card overflow-hidden">
                  <div className="px-5 py-4 border-b border-border flex items-center gap-2">
                    <Search className="w-4 h-4 text-primary" />
                    <h3 className="font-display font-semibold text-sm text-foreground">
                      AI Verification Results
                    </h3>
                    <span className="ml-auto text-xs text-muted-foreground">
                      How accurately the AI reads your plans
                    </span>
                  </div>

                  {/* Match rate bar */}
                  <div className="px-5 py-4 border-b border-border">
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-xs font-medium text-foreground">Schedule match rate</span>
                      <span className="text-xs font-bold text-foreground">
                        {Math.round(result.verification.matchRate * 100)}%
                      </span>
                    </div>
                    <div className="h-2 rounded-full bg-secondary overflow-hidden">
                      <div
                        className="h-full rounded-full transition-all"
                        style={{
                          width: `${Math.round(result.verification.matchRate * 100)}%`,
                          background: result.verification.matchRate >= 0.8
                            ? "rgb(34,197,94)"
                            : result.verification.matchRate >= 0.6
                            ? "rgb(234,179,8)"
                            : "rgb(239,68,68)",
                        }}
                      />
                    </div>
                  </div>

                  {/* Stats grid */}
                  <div className="grid grid-cols-4 divide-x divide-border border-b border-border">
                    {[
                      {
                        icon: MapPin,
                        label: "Schedule signs",
                        value: result.signCount,
                        color: "text-foreground",
                      },
                      {
                        icon: CheckCircle2,
                        label: "AI matched",
                        value: result.verification.matchedCount,
                        color: "text-green-500",
                      },
                      {
                        icon: CircleAlert,
                        label: "AI missed",
                        value: result.verification.missedCount,
                        color: "text-destructive",
                      },
                      {
                        icon: Sparkles,
                        label: "AI extras",
                        value: result.verification.extraCount,
                        color: "text-yellow-500",
                      },
                    ].map((stat) => (
                      <div key={stat.label} className="px-4 py-3 text-center">
                        <stat.icon className={`w-4 h-4 mx-auto mb-1 ${stat.color}`} />
                        <p className={`text-lg font-bold font-display ${stat.color}`}>{stat.value}</p>
                        <p className="text-[10px] text-muted-foreground">{stat.label}</p>
                      </div>
                    ))}
                  </div>

                  {/* Download button */}
                  <div className="px-5 py-4 flex items-center gap-3">
                    <button
                      onClick={handleDownloadVerificationPdf}
                      disabled={exportingPdf}
                      className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-display font-semibold bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                    >
                      {exportingPdf ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Download className="w-3.5 h-3.5" />
                      )}
                      Download Verification PDF
                    </button>
                    <p className="text-[11px] text-muted-foreground">
                      Green markers = AI found schedule sign here · Yellow = extra sign not in schedule
                    </p>
                  </div>

                  {/* Missed signs list */}
                  {result.verification.missedSigns.length > 0 && (
                    <div className="border-t border-border px-5 py-4">
                      <p className="text-xs font-semibold text-destructive mb-2 flex items-center gap-1.5">
                        <CircleAlert className="w-3.5 h-3.5" />
                        Signs in schedule the AI did not find ({result.verification.missedCount})
                      </p>
                      <div className="space-y-1 max-h-40 overflow-y-auto pr-1">
                        {result.verification.missedSigns.map((s, i) => (
                          <div key={i} className="flex items-start gap-2 text-[11px] text-muted-foreground">
                            <span className="font-mono text-foreground/60 shrink-0 w-14 truncate">
                              {s.signIdentifier ?? "—"}
                            </span>
                            <span className="text-foreground/80 shrink-0">{s.signType ?? "—"}</span>
                            <span className="truncate">{s.location ?? "—"}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="mb-6 p-4 rounded-lg bg-destructive/10 border border-destructive/30 flex items-start gap-3">
              <AlertTriangle className="w-4 h-4 text-destructive mt-0.5 flex-shrink-0" />
              <p className="text-sm text-destructive">{error}</p>
            </div>
          )}

          {/* Drop zones */}
          <div className="grid grid-cols-2 gap-4 mb-6">
            <DropZone
              slot="pdf"
              file={pdfFile}
              onFile={handleFile}
              onClear={handleClear}
              accept=".pdf"
              label="PDF Plan"
              sublabel=".pdf architectural plan"
              icon={FileText}
              color="primary"
            />
            <DropZone
              slot="xlsx"
              file={xlsxFile}
              onFile={handleFile}
              onClear={handleClear}
              accept=".xlsx,.xls,.csv"
              label="Sign Schedule"
              sublabel=".xlsx / .xls / .csv"
              icon={Table2}
              color="accent"
            />
          </div>

          {/* Column hint */}
          <div className="mb-6 px-4 py-3 rounded-lg bg-secondary/50 border border-border">
            <p className="text-xs text-muted-foreground">
              <span className="font-semibold text-foreground">Tip:</span> The spreadsheet can use any column names — the system recognizes keywords like{" "}
              <span className="font-mono text-foreground">Sign ID</span>,{" "}
              <span className="font-mono text-foreground">Sign Type</span>,{" "}
              <span className="font-mono text-foreground">Location</span>,{" "}
              <span className="font-mono text-foreground">Dimensions</span>,{" "}
              <span className="font-mono text-foreground">Mounting</span>,{" "}
              <span className="font-mono text-foreground">Finish</span>,{" "}
              <span className="font-mono text-foreground">Message</span>, and more.
              Rows with all-empty sign ID + type + location are skipped.
            </p>
          </div>

          {/* Import button */}
          <button
            onClick={handleImport}
            disabled={!canImport}
            className="w-full flex items-center justify-center gap-3 py-4 rounded-xl font-display font-bold uppercase tracking-widest text-sm transition-all
              bg-primary text-primary-foreground hover:bg-primary/90 shadow-[0_0_25px_rgba(255,170,0,0.15)]
              disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-none
              active:scale-[0.99]"
          >
            {uploading ? (
              <>
                <Loader2 className="w-5 h-5 animate-spin" />
                {uploadStage === "importing"
                  ? "Importing Training Data…"
                  : "Running AI Verification on Plans…"}
              </>
            ) : (
              <>
                <Upload className="w-5 h-5" />
                Import as Verified Training Data
                <ArrowRight className="w-4 h-4" />
              </>
            )}
          </button>

          {/* Batch note */}
          <p className="mt-4 text-center text-xs text-muted-foreground">
            Import one plan at a time. Repeat for each of your existing projects to build the training library.
          </p>
        </div>
      </div>
    </AppShell>
  );
}
