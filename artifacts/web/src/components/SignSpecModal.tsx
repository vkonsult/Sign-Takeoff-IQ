import { useState, useEffect, useMemo, useRef, useCallback } from "react";
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
  PanelRightOpen,
  PanelRightClose,
  CheckCircle2,
  AlertCircle,
  ArrowUpRight,
  ImageOff,
  RefreshCw,
} from "lucide-react";
pdfjs.GlobalWorkerOptions.workerSrc = `${import.meta.env.BASE_URL}pdf.worker.min.mjs`;

function CropThumbnail({ src, alt, onClick }: { src: string; alt: string; onClick?: () => void }) {
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const [retryCount, setRetryCount] = useState(0);

  const imgSrc = retryCount === 0 ? src : `${src}${src.includes("?") ? "&" : "?"}_r=${retryCount}`;

  const handleRetry = () => {
    setLoaded(false);
    setError(false);
    setRetryCount((c) => c + 1);
  };

  if (error) {
    return (
      <div className="mb-2 flex flex-col items-center justify-center gap-1.5 rounded border border-dashed border-border/50 bg-secondary/20 py-2.5">
        <div className="flex items-center gap-1.5">
          <ImageOff className="w-3.5 h-3.5 text-muted-foreground/40" />
          <span className="text-[10px] font-mono text-muted-foreground/40">Image unavailable</span>
        </div>
        <button
          onClick={handleRetry}
          className="flex items-center gap-1 text-[10px] font-mono text-muted-foreground/60 hover:text-muted-foreground transition-colors"
        >
          <RefreshCw className="w-3 h-3" />
          Retry
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      title={onClick ? "Click to enlarge" : undefined}
      className={`mb-2 w-full rounded overflow-hidden border border-border/60 bg-white relative h-24 block ${onClick ? "cursor-zoom-in hover:border-accent/50" : "cursor-default"} transition-colors`}
    >
      {!loaded && (
        <div className="absolute inset-0 bg-secondary/40 animate-pulse" />
      )}
      <img
        src={imgSrc}
        alt={alt}
        loading="lazy"
        onLoad={() => setLoaded(true)}
        onError={() => setError(true)}
        className={`w-full h-full object-contain transition-opacity duration-300 ${loaded ? "opacity-100" : "opacity-0"}`}
      />
    </button>
  );
}

export interface PlaqueTableData {
  plaqueTypes: {
    typeCode: string;
    displayName: string;
    letterHeight: string | null;
    hasBraille: boolean;
    hasInsert: boolean;
    triggerCondition: string | null;
    dimensions: string | null;
    material: string | null;
    mountingNote: string | null;
    adaNote: string | null;
    rawNote: string | null;
  }[];
  generalNotes: string[];
  sourcePages: number[];
  extractionMethod: "visual" | "text_fallback";
  warnings: string[];
}

interface SignTypeSpec {
  id: string;
  typeCode: string;
  dimensions: string | null;
  material: string | null;
  features: string[] | null;
  geminiNotes: Record<string, unknown> | null;
  geminiEnriched: boolean;
  hasDrawing: boolean;
  cropBox: { x: number; y: number; w: number; h: number; pageNum: number } | null;
  cropImageUrl: string | null;
}

interface GeminiNotesFields {
  displayName?: string;
  letterHeight?: string | null;
  hasBraille?: boolean;
  hasInsert?: boolean;
  triggerCondition?: string | null;
  mountingNote?: string | null;
  adaNote?: string | null;
}

interface SignSpecModalProps {
  jobId: string;
  fileId: string;
  fileName: string;
  specPages: number[];
  plaqueTable?: PlaqueTableData | null;
  onClose: () => void;
}

export function SignSpecModal({ jobId, fileId, fileName, specPages, plaqueTable, onClose }: SignSpecModalProps) {
  const [specIdx, setSpecIdx] = useState(0);
  const [scale, setScale] = useState(1.2);
  const [fitScale, setFitScale] = useState(1.2);
  const [error, setError] = useState<string | null>(null);
  const [isPanning, setIsPanning] = useState(false);
  const [showPanel, setShowPanel] = useState(true);
  const [specs, setSpecs] = useState<SignTypeSpec[]>([]);
  const [specsLoading, setSpecsLoading] = useState(false);
  const [activeSpecId, setActiveSpecId] = useState<string | null>(null);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);

  const lightboxUrlRef = useRef<string | null>(null);
  useEffect(() => { lightboxUrlRef.current = lightboxUrl; }, [lightboxUrl]);

  const activeSpecRowRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const viewerRef = useRef<HTMLDivElement>(null);
  const pdfContentRef = useRef<HTMLDivElement>(null);
  const panRef = useRef<{
    startScrollLeft: number;
    startScrollTop: number;
    startClientX: number;
    startClientY: number;
  } | null>(null);

  const { pdfBuffer, blobError } = usePdfBlob(`/api/jobs/${jobId}/files/${fileId}/pdf`);

  useEffect(() => {
    if (blobError) setError(blobError);
  }, [blobError]);

  useEffect(() => {
    let cancelled = false;
    setSpecsLoading(true);
    fetch(`${import.meta.env.BASE_URL}api/jobs/${jobId}/schedule-entries`, { credentials: "include" })
      .then((r) => r.ok ? r.json() : Promise.reject(r.statusText))
      .then((data: { specs: SignTypeSpec[] }) => {
        if (!cancelled) setSpecs(data.specs ?? []);
      })
      .catch(() => {
        if (!cancelled) setSpecs([]);
      })
      .finally(() => {
        if (!cancelled) setSpecsLoading(false);
      });
    return () => { cancelled = true; };
  }, [jobId]);

  const currentPage = specPages[specIdx] ?? 1;
  const totalSpec = specPages.length;

  const pdfFile = useMemo(
    () => (pdfBuffer ? { data: new Uint8Array(pdfBuffer.slice(0)) } : null),
    [pdfBuffer]
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (lightboxUrlRef.current) {
          setLightboxUrl(null);
        } else {
          onClose();
        }
      }
      if (e.key === "ArrowLeft") setSpecIdx((i) => Math.max(0, i - 1));
      if (e.key === "ArrowRight") setSpecIdx((i) => Math.min(totalSpec - 1, i + 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, totalSpec]);

  useEffect(() => {
    const el = viewerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setScale((s) => Math.min(3, Math.max(0.3, s + (e.deltaY < 0 ? 0.15 : -0.15))));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    panRef.current = {
      startScrollLeft: viewerRef.current?.scrollLeft ?? 0,
      startScrollTop: viewerRef.current?.scrollTop ?? 0,
      startClientX: e.clientX,
      startClientY: e.clientY,
    };
    setIsPanning(true);
  }, []);

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!panRef.current || !viewerRef.current) return;
    const dx = e.clientX - panRef.current.startClientX;
    const dy = e.clientY - panRef.current.startClientY;
    viewerRef.current.scrollLeft = panRef.current.startScrollLeft - dx;
    viewerRef.current.scrollTop = panRef.current.startScrollTop - dy;
  }, []);

  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    panRef.current = null;
    setIsPanning(false);
    e.currentTarget.releasePointerCapture(e.pointerId);
  }, []);

  const jumpToSpec = useCallback((spec: SignTypeSpec) => {
    setActiveSpecId(spec.id);
    const targetPage = spec.cropBox?.pageNum ?? null;
    if (targetPage === null) return;
    const idx = specPages.indexOf(targetPage);
    if (idx !== -1) {
      setSpecIdx(idx);
    }
  }, [specPages]);

  useEffect(() => {
    if (!activeSpecId) return;
    const el = activeSpecRowRefs.current.get(activeSpecId);
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activeSpecId]);

  const computeFitScale = useCallback(() => {
    if (!viewerRef.current || !pdfContentRef.current) return null;
    const vw = viewerRef.current.clientWidth - 48;
    const vh = viewerRef.current.clientHeight - 48;
    const cw = pdfContentRef.current.offsetWidth;
    const ch = pdfContentRef.current.offsetHeight;
    if (cw > 0 && ch > 0) {
      const naturalW = cw / scale;
      const naturalH = ch / scale;
      return Math.min(3, Math.max(0.3, Math.min(vw / naturalW, vh > 0 ? vh / naturalH : Infinity)));
    }
    return null;
  }, [scale]);

  const generalNotes = plaqueTable?.generalNotes ?? [];
  const extractionMethod = plaqueTable?.extractionMethod ?? null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch"
      style={{ background: "rgba(0,0,0,0.85)" }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="relative flex flex-col w-full h-full max-w-6xl mx-auto">
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
            {extractionMethod && (
              <span className={`px-2 py-0.5 rounded border text-[10px] font-bold uppercase tracking-wider flex-shrink-0 ${
                extractionMethod === "visual"
                  ? "bg-emerald-500/15 border-emerald-500/30 text-emerald-400"
                  : "bg-amber-500/15 border-amber-500/30 text-amber-400"
              }`}>
                {extractionMethod === "visual" ? "Visual Extraction" : "Text Fallback"}
              </span>
            )}
          </div>

          <div className="flex items-center gap-2 flex-shrink-0">
            {/* Zoom */}
            <button
              onClick={() => setScale((s) => Math.max(0.3, s - 0.15))}
              disabled={scale <= 0.3}
              className="w-7 h-7 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary disabled:opacity-30 transition-colors"
              title="Zoom out"
            >
              <ZoomOut className="w-4 h-4" />
            </button>
            <span className="text-[11px] font-mono text-muted-foreground w-10 text-center select-none">
              {Math.round(scale * 100)}%
            </span>
            <button
              onClick={() => {
                const fit = computeFitScale();
                if (fit !== null) { setFitScale(fit); setScale(fit); }
              }}
              title="Fit to page"
              className="text-[10px] font-display font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground hover:border-foreground/40 transition-colors"
            >
              Fit
            </button>
            <button
              onClick={() => setScale((s) => Math.min(3, s + 0.15))}
              disabled={scale >= 3}
              className="w-7 h-7 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary disabled:opacity-30 transition-colors"
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
            <span className="text-[11px] font-mono text-muted-foreground text-center select-none">
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

            {/* Toggle sign types panel */}
            <button
              onClick={() => setShowPanel((v) => !v)}
              title={showPanel ? "Hide sign types panel" : "Show sign types panel"}
              className={`w-7 h-7 rounded flex items-center justify-center transition-colors ${
                showPanel
                  ? "text-accent bg-accent/15 hover:bg-accent/25"
                  : "text-muted-foreground hover:text-foreground hover:bg-secondary"
              }`}
            >
              {showPanel ? <PanelRightClose className="w-4 h-4" /> : <PanelRightOpen className="w-4 h-4" />}
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

        {/* Main content: PDF viewer + optional side panel */}
        <div className="flex-1 flex min-h-0 overflow-hidden">
          {/* PDF Viewer */}
          <div
            ref={viewerRef}
            className="flex-1 overflow-auto flex items-start justify-center p-6 bg-zinc-900 select-none min-w-0"
            style={{ cursor: isPanning ? "grabbing" : "grab" }}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={() => { panRef.current = null; setIsPanning(false); }}
          >
            {!pdfBuffer && !error && (
              <div className="flex flex-col items-center gap-3 text-muted-foreground pt-20">
                <Loader2 className="w-8 h-8 animate-spin" />
                <p className="text-sm">Loading sign spec...</p>
              </div>
            )}
            {!pdfBuffer && error && (
              <div className="flex flex-col items-center gap-2 text-destructive pt-20">
                <FileText className="w-8 h-8" />
                <p className="text-sm">Failed to load PDF</p>
                <p className="text-xs opacity-70">{error}</p>
              </div>
            )}
            <Document
              file={pdfFile}
              onLoadError={(err) => setError(err.message)}
              loading={null}
              error={null}
            >
              <div ref={pdfContentRef} className="shadow-2xl" style={{ pointerEvents: "none" }}>
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

          {/* Sign Types Side Panel */}
          {showPanel && (
            <div className="w-72 flex-none flex flex-col border-l border-border bg-background overflow-hidden">
              <div className="flex-none px-3 py-2 border-b border-border bg-card flex items-center justify-between">
                <p className="text-[10px] font-display font-semibold uppercase tracking-wider text-foreground">Sign Type Details</p>
                {specs.length > 0 && (
                  <span className="text-[10px] font-mono text-muted-foreground">{specs.length} types</span>
                )}
              </div>

              <div className="flex-1 overflow-y-auto">
                {specsLoading && (
                  <div className="flex items-center justify-center gap-2 py-8 text-muted-foreground">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span className="text-xs">Loading...</span>
                  </div>
                )}

                {!specsLoading && specs.length === 0 && (
                  <div className="px-3 py-6 text-center">
                    <p className="text-xs text-muted-foreground">No sign type specs found for this job.</p>
                  </div>
                )}

                {/* General notes section */}
                {!specsLoading && generalNotes.length > 0 && (
                  <div className="px-3 py-2 border-b border-border/60">
                    <p className="text-[10px] font-display font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">General Notes</p>
                    <ul className="space-y-1">
                      {generalNotes.map((note, i) => (
                        <li key={i} className="flex items-start gap-1.5">
                          <span className="mt-0.5 w-1 h-1 rounded-full bg-accent/60 flex-shrink-0" />
                          <span className="text-[11px] font-mono text-muted-foreground leading-relaxed">{note}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Sign type rows */}
                {!specsLoading && specs.map((spec) => {
                  const notes = (spec.geminiNotes ?? {}) as GeminiNotesFields;
                  const features = spec.features ?? [];
                  // Prefer explicit boolean fields from geminiNotes; fall back to features array
                  const hasBraille = notes.hasBraille ?? features.some((f) => /braille/i.test(f));
                  const hasInsert = notes.hasInsert ?? features.some((f) => /insert/i.test(f));
                  // Use Phase 3 schedule extraction method from plaqueTable (not geminiEnriched,
                  // which tracks a separate diagram-enrichment step)
                  const rowIsVisual = extractionMethod === "visual";
                  const isActive = activeSpecId === spec.id;
                  const hasPage = spec.cropBox?.pageNum != null;

                  return (
                    <div
                      key={spec.id}
                      ref={(el) => {
                        if (el) activeSpecRowRefs.current.set(spec.id, el);
                        else activeSpecRowRefs.current.delete(spec.id);
                      }}
                      onClick={() => jumpToSpec(spec)}
                      className={`px-3 py-2.5 border-b border-border/40 transition-colors ${
                        hasPage ? "cursor-pointer" : ""
                      } ${
                        isActive
                          ? "bg-accent/10 border-l-2 border-l-accent"
                          : "hover:bg-secondary/30"
                      }`}
                    >
                      {/* Type code + jump button + extraction badge */}
                      <div className="flex items-center justify-between gap-2 mb-1.5">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="text-xs font-display font-bold text-foreground">{spec.typeCode}</span>
                          {hasPage && (
                            <button
                              onClick={() => jumpToSpec(spec)}
                              title={`Jump to PDF page ${spec.cropBox!.pageNum}`}
                              className={`flex items-center gap-0.5 px-1 py-0.5 rounded text-[9px] font-mono transition-colors flex-shrink-0 ${
                                isActive
                                  ? "bg-accent text-background"
                                  : "bg-accent/15 text-accent border border-accent/30 hover:bg-accent/30"
                              }`}
                            >
                              <ArrowUpRight className="w-2.5 h-2.5" />
                              pg {spec.cropBox!.pageNum}
                            </button>
                          )}
                        </div>
                        <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider flex-shrink-0 ${
                          rowIsVisual
                            ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/30"
                            : "bg-amber-500/15 text-amber-400 border border-amber-500/30"
                        }`}>
                          {rowIsVisual ? "Visual" : "Text Fallback"}
                        </span>
                      </div>

                      {/* Crop image thumbnail */}
                      {spec.hasDrawing && spec.cropImageUrl ? (
                        <div onClick={(e) => e.stopPropagation()}>
                          <CropThumbnail
                            src={`${import.meta.env.BASE_URL}${spec.cropImageUrl.replace(/^\//, "")}`}
                            alt={`Drawing for ${spec.typeCode}`}
                            onClick={() => setLightboxUrl(`${import.meta.env.BASE_URL}${spec.cropImageUrl!.replace(/^\//, "")}`)}
                          />
                        </div>
                      ) : (
                        <div className="mb-2 flex items-center justify-center gap-1.5 rounded border border-dashed border-border/50 bg-secondary/20 py-2.5">
                          <ImageOff className="w-3.5 h-3.5 text-muted-foreground/40" />
                          <span className="text-[10px] font-mono text-muted-foreground/40">No drawing</span>
                        </div>
                      )}

                      {/* Display name */}
                      {notes.displayName && notes.displayName !== spec.typeCode && (
                        <p className="text-[11px] text-foreground/80 font-medium mb-1.5 leading-tight">{notes.displayName}</p>
                      )}

                      {/* Flags row */}
                      <div className="flex flex-wrap gap-1 mb-1.5">
                        {notes.letterHeight && (
                          <span className="px-1.5 py-0.5 rounded bg-secondary text-[10px] font-mono text-foreground/70">
                            {notes.letterHeight} letter ht.
                          </span>
                        )}
                        {hasBraille && (
                          <span className="flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-blue-500/15 border border-blue-500/20 text-[10px] font-mono text-blue-400">
                            <CheckCircle2 className="w-2.5 h-2.5" />
                            Braille
                          </span>
                        )}
                        {hasInsert && (
                          <span className="flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-purple-500/15 border border-purple-500/20 text-[10px] font-mono text-purple-400">
                            <CheckCircle2 className="w-2.5 h-2.5" />
                            Insert
                          </span>
                        )}
                      </div>

                      {/* Detail lines */}
                      {notes.triggerCondition && (
                        <SpecDetailRow label="Trigger" value={notes.triggerCondition} />
                      )}
                      {notes.mountingNote && (
                        <SpecDetailRow label="Mounting" value={notes.mountingNote} />
                      )}
                      {notes.adaNote && (
                        <SpecDetailRow label="ADA" value={notes.adaNote} icon={<AlertCircle className="w-2.5 h-2.5 text-orange-400 flex-shrink-0 mt-0.5" />} />
                      )}
                      {(spec.dimensions || spec.material) && !notes.triggerCondition && !notes.mountingNote && !notes.adaNote && (
                        <>
                          {spec.dimensions && <SpecDetailRow label="Dims" value={spec.dimensions} />}
                          {spec.material && <SpecDetailRow label="Material" value={spec.material} />}
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Footer note */}
        <div className="flex-none px-4 py-2 bg-background border-t border-border">
          <p className="text-[10px] font-mono text-muted-foreground/60 text-center">
            Sign schedules and specs are shown here for reference only. All sign quantities are derived from floor plan analysis.
          </p>
        </div>

        {/* Lightbox overlay */}
        {lightboxUrl && (
          <div
            className="absolute inset-0 z-50 flex items-center justify-center bg-black/80"
            onClick={() => setLightboxUrl(null)}
          >
            <button
              type="button"
              onClick={() => setLightboxUrl(null)}
              className="absolute top-3 right-3 p-1.5 rounded-full bg-background/20 text-white hover:bg-background/40 transition-colors"
              aria-label="Close"
            >
              <X className="w-5 h-5" />
            </button>
            <img
              src={lightboxUrl}
              alt="Full drawing"
              className="max-w-[90%] max-h-[85%] object-contain rounded shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function SpecDetailRow({
  label,
  value,
  icon,
}: {
  label: string;
  value: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-1.5 mb-0.5">
      <span className="text-[9px] font-display font-semibold uppercase tracking-wider text-muted-foreground/60 flex-shrink-0 mt-0.5 w-12">{label}</span>
      <div className="flex items-start gap-0.5 min-w-0">
        {icon}
        <span className="text-[10px] font-mono text-muted-foreground leading-relaxed break-words">{value}</span>
      </div>
    </div>
  );
}
