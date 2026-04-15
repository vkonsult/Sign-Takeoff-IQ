import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { FileText, ChevronLeft, ChevronRight, ZoomIn, ZoomOut, Loader2, AlertTriangle } from "lucide-react";
import { apiFetch } from "@/lib/apiClient";
import type { ExtractedSign } from "@/types/sign";
import type { FileInfo } from "@/components/UnifiedPlanViewer";

interface SignSpecsTabProps {
  signs: ExtractedSign[];
  files: FileInfo[];
  jobId: string;
}

interface PageEntry {
  fileId: string;
  fileName: string;
  pageNumber: number;
}

export function SignSpecsTab({ files, jobId }: SignSpecsTabProps) {
  const pageEntries = useMemo<PageEntry[]>(() => {
    const entries: PageEntry[] = [];
    for (const f of files) {
      const schedPages = f.pageStats?.signSchedulePages ?? [];
      for (const pg of schedPages) {
        entries.push({ fileId: f.id, fileName: f.originalName, pageNumber: pg });
      }
    }
    return entries;
  }, [files]);

  const [pageIdx, setPageIdx] = useState(0);
  const [scale, setScale] = useState(1.0);
  const [fitScale, setFitScale] = useState(1.0);
  const [nativeSize, setNativeSize] = useState<{ w: number; h: number } | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [imageLoading, setImageLoading] = useState(false);
  const [imageError, setImageError] = useState(false);
  const [isPanning, setIsPanning] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const prevBlobUrlRef = useRef<string | null>(null);
  const hasSetScaleRef = useRef(false);
  const panRef = useRef<{
    startScrollLeft: number;
    startScrollTop: number;
    startClientX: number;
    startClientY: number;
  } | null>(null);

  const currentEntry = pageEntries[pageIdx] ?? null;

  useEffect(() => {
    if (prevBlobUrlRef.current) {
      URL.revokeObjectURL(prevBlobUrlRef.current);
      prevBlobUrlRef.current = null;
    }
    setImageUrl(null);
    setImageError(false);
    setNativeSize(null);
    if (!currentEntry) return;
    setImageLoading(true);
    let cancelled = false;
    apiFetch(`/api/jobs/${jobId}/files/${currentEntry.fileId}/pages/${currentEntry.pageNumber}/image`)
      .then((res) => {
        if (!res.ok) throw new Error(`${res.status}`);
        return res.blob();
      })
      .then((blob) => {
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        prevBlobUrlRef.current = url;
        setImageUrl(url);
      })
      .catch(() => { if (!cancelled) setImageError(true); })
      .finally(() => { if (!cancelled) setImageLoading(false); });
    return () => { cancelled = true; };
  }, [currentEntry, jobId]);

  useEffect(() => {
    return () => {
      if (prevBlobUrlRef.current) URL.revokeObjectURL(prevBlobUrlRef.current);
    };
  }, []);

  useEffect(() => {
    hasSetScaleRef.current = false;
    setNativeSize(null);
  }, [pageIdx]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setScale((s) => Math.min(3, Math.max(0.3, s + (e.deltaY < 0 ? 0.15 : -0.15))));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const handleImageLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    const nw = img.naturalWidth;
    const nh = img.naturalHeight;
    if (nw > 0 && nh > 0) {
      setNativeSize({ w: nw, h: nh });
      if (!hasSetScaleRef.current && containerRef.current) {
        hasSetScaleRef.current = true;
        const cw = containerRef.current.clientWidth - 32;
        const ch = containerRef.current.clientHeight - 32;
        const fit = Math.min(2, Math.max(0.3, Math.min(cw / nw, ch / nh)));
        setFitScale(fit);
        setScale(fit);
      }
    }
  }, []);

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    panRef.current = {
      startScrollLeft: containerRef.current?.scrollLeft ?? 0,
      startScrollTop: containerRef.current?.scrollTop ?? 0,
      startClientX: e.clientX,
      startClientY: e.clientY,
    };
    setIsPanning(true);
  }, []);

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!panRef.current || !containerRef.current) return;
    const dx = e.clientX - panRef.current.startClientX;
    const dy = e.clientY - panRef.current.startClientY;
    containerRef.current.scrollLeft = panRef.current.startScrollLeft - dx;
    containerRef.current.scrollTop = panRef.current.startScrollTop - dy;
  }, []);

  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    panRef.current = null;
    setIsPanning(false);
    e.currentTarget.releasePointerCapture(e.pointerId);
  }, []);

  const canPrev = pageIdx > 0;
  const canNext = pageIdx < pageEntries.length - 1;

  if (pageEntries.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4 text-center p-12">
        <div className="w-16 h-16 rounded-full bg-secondary/60 flex items-center justify-center">
          <FileText className="w-8 h-8 text-muted-foreground/50" />
        </div>
        <div>
          <p className="text-base font-display font-semibold text-foreground/70">No sign schedule pages available</p>
          <p className="text-sm text-muted-foreground mt-1">
            Run an extraction first, or check that this job has sign schedule pages.
          </p>
        </div>
      </div>
    );
  }

  const imgW = nativeSize ? nativeSize.w * scale : undefined;
  const imgH = nativeSize ? nativeSize.h * scale : undefined;

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-secondary/30">
      {/* Toolbar — always visible, never scrolls away */}
      <div className="flex-none flex items-center gap-2 px-4 py-2 bg-card border-b border-border overflow-x-auto min-w-0">
        {/* Page navigation */}
        <button
          aria-label="Previous page"
          disabled={!canPrev}
          onClick={() => setPageIdx((i) => Math.max(0, i - 1))}
          className="p-1.5 rounded hover:bg-secondary disabled:opacity-30 transition-colors"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        <span className="text-xs font-mono text-muted-foreground min-w-[110px] text-center select-none">
          Schedule {pageIdx + 1} / {pageEntries.length}
          {currentEntry && (
            <span className="text-muted-foreground/50 ml-1">(pg {currentEntry.pageNumber})</span>
          )}
        </span>
        <button
          aria-label="Next page"
          disabled={!canNext}
          onClick={() => setPageIdx((i) => Math.min(pageEntries.length - 1, i + 1))}
          className="p-1.5 rounded hover:bg-secondary disabled:opacity-30 transition-colors"
        >
          <ChevronRight className="w-4 h-4" />
        </button>

        <div className="w-px h-4 bg-border mx-0.5" />

        {/* Zoom controls */}
        <button
          onClick={() => setScale((s) => Math.max(0.3, s - 0.15))}
          disabled={scale <= 0.3}
          className="p-1.5 rounded hover:bg-secondary disabled:opacity-30 transition-colors"
          title="Zoom out"
        >
          <ZoomOut className="w-3.5 h-3.5" />
        </button>
        <span className="text-[11px] font-mono text-muted-foreground w-10 text-center select-none">
          {Math.round(scale * 100)}%
        </span>
        <button
          onClick={() => setScale(fitScale)}
          title="Fit to page"
          className="text-[10px] font-display font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground hover:border-foreground/40 transition-colors"
        >
          Fit
        </button>
        <button
          onClick={() => setScale((s) => Math.min(3, s + 0.15))}
          disabled={scale >= 3}
          className="p-1.5 rounded hover:bg-secondary disabled:opacity-30 transition-colors"
          title="Zoom in"
        >
          <ZoomIn className="w-3.5 h-3.5" />
        </button>

        {/* File name */}
        {currentEntry && (
          <>
            <div className="w-px h-4 bg-border mx-0.5" />
            <span className="text-[11px] font-mono text-muted-foreground/60 truncate max-w-[200px]" title={currentEntry.fileName}>
              {currentEntry.fileName}
            </span>
          </>
        )}
      </div>

      {/* Page chips strip */}
      {pageEntries.length > 1 && (
        <div className="flex-none flex items-center gap-1.5 px-4 py-1.5 bg-secondary/30 border-b border-border overflow-x-auto">
          <span className="text-[10px] font-mono text-muted-foreground/60 flex-shrink-0 mr-1">Jump:</span>
          {pageEntries.map((entry, idx) => (
            <button
              key={`${entry.fileId}-${entry.pageNumber}`}
              onClick={() => setPageIdx(idx)}
              className={`px-2 py-0.5 rounded text-[10px] font-mono flex-shrink-0 transition-colors ${
                idx === pageIdx
                  ? "bg-primary text-primary-foreground font-bold"
                  : "bg-secondary text-muted-foreground border border-border hover:bg-secondary/80"
              }`}
            >
              pg {entry.pageNumber}
            </button>
          ))}
        </div>
      )}

      {/* Canvas — scrollable area with pointer-drag pan */}
      <div
        ref={containerRef}
        className="flex-1 overflow-auto bg-zinc-900 select-none"
        style={{ cursor: isPanning ? "grabbing" : "grab" }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={() => { panRef.current = null; setIsPanning(false); }}
      >
        <div
          style={{
            minWidth: "max-content",
            minHeight: "max-content",
            display: "flex",
            justifyContent: "center",
            alignItems: "flex-start",
            padding: 16,
          }}
        >
          {imageLoading && !imageUrl && (
            <div className="flex items-center justify-center h-64">
              <Loader2 className="w-8 h-8 text-primary animate-spin" />
            </div>
          )}
          {imageError && !imageUrl && (
            <div className="flex flex-col items-center justify-center h-64 text-destructive gap-2">
              <AlertTriangle className="w-8 h-8" />
              <p className="text-sm">Failed to load page image</p>
            </div>
          )}
          {imageUrl && (
            <img
              src={imageUrl}
              alt={`Sign schedule page ${currentEntry?.pageNumber}`}
              onLoad={handleImageLoad}
              draggable={false}
              style={{
                display: "block",
                width: imgW,
                height: imgH,
                maxWidth: "none",
                boxShadow: "0 4px 32px rgba(0,0,0,0.5)",
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
