import { useState, useEffect } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import { usePdfBlob } from "@/hooks/use-pdf-blob";
import {
  X,
  ChevronLeft,
  ChevronRight,
  ZoomIn,
  ZoomOut,
  FileText,
  Loader2,
  Layers,
} from "lucide-react";

pdfjs.GlobalWorkerOptions.workerSrc = `${import.meta.env.BASE_URL}pdf.worker.min.mjs`;

interface SignSpecModalProps {
  jobId: string;
  fileId: string;
  fileName: string;
  specPages: number[];
  onClose: () => void;
}

export function SignSpecModal({ jobId, fileId, fileName, specPages, onClose }: SignSpecModalProps) {
  const [specIdx, setSpecIdx] = useState(0);
  const [scale, setScale] = useState(1.2);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const { blobUrl, blobError } = usePdfBlob(`/api/jobs/${jobId}/files/${fileId}/pdf`);
  const pdfUrl = blobUrl;

  useEffect(() => {
    if (blobError) setError(blobError);
  }, [blobError]);

  const currentPage = specPages[specIdx] ?? 1;
  const totalSpec = specPages.length;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft") setSpecIdx((i) => Math.max(0, i - 1));
      if (e.key === "ArrowRight") setSpecIdx((i) => Math.min(totalSpec - 1, i + 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, totalSpec]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch"
      style={{ background: "rgba(0,0,0,0.85)" }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="flex flex-col w-full h-full max-w-5xl mx-auto">
        {/* Header */}
        <div className="flex-none flex items-center justify-between px-4 py-3 bg-background border-b border-border">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-7 h-7 rounded bg-accent/20 flex items-center justify-center flex-shrink-0">
              <Layers className="w-4 h-4 text-accent" />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-display font-semibold text-foreground uppercase tracking-wider">Sign Spec / Schedule Viewer</p>
              <p className="text-[11px] font-mono text-muted-foreground truncate">{fileName}</p>
            </div>
            <span className="ml-2 px-2 py-0.5 rounded bg-accent/15 border border-accent/30 text-accent text-[10px] font-bold uppercase tracking-wider flex-shrink-0">
              {totalSpec} spec {totalSpec === 1 ? "page" : "pages"}
            </span>
          </div>

          {/* Controls */}
          <div className="flex items-center gap-2 flex-shrink-0">
            {/* Zoom */}
            <button
              onClick={() => setScale((s) => Math.max(0.5, s - 0.2))}
              className="w-7 h-7 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
              title="Zoom out"
            >
              <ZoomOut className="w-4 h-4" />
            </button>
            <span className="text-[11px] font-mono text-muted-foreground w-10 text-center">
              {Math.round(scale * 100)}%
            </span>
            <button
              onClick={() => setScale((s) => Math.min(3, s + 0.2))}
              className="w-7 h-7 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
              title="Zoom in"
            >
              <ZoomIn className="w-4 h-4" />
            </button>

            <div className="w-px h-5 bg-border mx-1" />

            {/* Page navigation */}
            <button
              onClick={() => setSpecIdx((i) => Math.max(0, i - 1))}
              disabled={specIdx === 0}
              className="w-7 h-7 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="text-[11px] font-mono text-muted-foreground text-center">
              <span className="text-foreground font-semibold">{specIdx + 1}</span> / {totalSpec}
              <span className="text-muted-foreground/60 ml-1">(PDF pg {currentPage})</span>
            </span>
            <button
              onClick={() => setSpecIdx((i) => Math.min(totalSpec - 1, i + 1))}
              disabled={specIdx === totalSpec - 1}
              className="w-7 h-7 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              <ChevronRight className="w-4 h-4" />
            </button>

            <div className="w-px h-5 bg-border mx-1" />

            <button
              onClick={onClose}
              className="w-7 h-7 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Page chips strip */}
        <div className="flex-none flex items-center gap-1.5 px-4 py-2 bg-card border-b border-border overflow-x-auto">
          <span className="text-[10px] font-mono text-muted-foreground/60 flex-shrink-0 mr-1">Jump to page:</span>
          {specPages.map((pg, idx) => (
            <button
              key={pg}
              onClick={() => setSpecIdx(idx)}
              className={`px-2 py-0.5 rounded text-[10px] font-mono flex-shrink-0 transition-colors ${
                idx === specIdx
                  ? "bg-accent text-background font-bold"
                  : "bg-accent/15 text-accent border border-accent/30 hover:bg-accent/25"
              }`}
            >
              pg {pg}
            </button>
          ))}
        </div>

        {/* PDF Viewer */}
        <div className="flex-1 overflow-auto flex items-start justify-center p-6 bg-zinc-900">
          {!pdfUrl && !error && (
            <div className="flex flex-col items-center gap-3 text-muted-foreground pt-20">
              <Loader2 className="w-8 h-8 animate-spin" />
              <p className="text-sm">Loading sign spec...</p>
            </div>
          )}
          {!pdfUrl && error && (
            <div className="flex flex-col items-center gap-2 text-destructive pt-20">
              <FileText className="w-8 h-8" />
              <p className="text-sm">Failed to load PDF</p>
              <p className="text-xs opacity-70">{error}</p>
            </div>
          )}
          <Document
            file={pdfUrl}
            onLoadSuccess={() => setLoading(false)}
            onLoadError={(err) => setError(err.message)}
            loading={null}
            error={null}
          >
            <div className="shadow-2xl">
              <Page
                key={currentPage}
                pageNumber={currentPage}
                scale={scale}
                renderTextLayer={true}
                renderAnnotationLayer={true}
              />
            </div>
          </Document>
        </div>

        {/* Footer note */}
        <div className="flex-none px-4 py-2 bg-background border-t border-border">
          <p className="text-[10px] font-mono text-muted-foreground/60 text-center">
            Sign schedules and specs are shown here for reference only. All sign quantities are derived from floor plan analysis.
          </p>
        </div>
      </div>
    </div>
  );
}
