import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { FileText, ChevronLeft, ChevronRight, ZoomIn, ZoomOut, Loader2, AlertTriangle, Table2, Image } from "lucide-react";
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

interface ScheduleEntry {
  id: string;
  pageNumber: number | null;
  sourceTableName: string | null;
  roomNumber: string | null;
  roomName: string | null;
  signTypeCode: string | null;
  quantity: number | null;
  signageText: string | null;
  glassBacker: boolean | null;
  rawComments: string | null;
  expandedComments: string | null;
  dimensions: string | null;
  material: string | null;
  features: string[] | null;
  specDimensions: string | null;
  specMaterial: string | null;
  specFeatures: string[] | null;
  specKeynoteMap: Record<string, string> | null;
  specHasDrawing: boolean | null;
  specCropImageUrl: string | null;
  specGeminiEnriched: boolean | null;
  specGeminiNotes: Record<string, unknown> | null;
}

interface SignTypeSpec {
  id: string;
  typeCode: string;
  dimensions: string | null;
  material: string | null;
  features: string[] | null;
  keynoteMap: Record<string, string> | null;
  hasDrawing: boolean;
  cropImageUrl: string | null;
  geminiEnriched: boolean;
  geminiNotes: Record<string, unknown> | null;
}

type ViewMode = "table" | "image";

export function SignSpecsTab({ files, jobId }: SignSpecsTabProps) {
  const [viewMode, setViewMode] = useState<ViewMode>("table");
  const [entries, setEntries] = useState<ScheduleEntry[] | null>(null);
  const [specs, setSpecs] = useState<SignTypeSpec[]>([]);
  const [loadingEntries, setLoadingEntries] = useState(false);
  const [entriesError, setEntriesError] = useState<string | null>(null);
  const [filterCode, setFilterCode] = useState<string | null>(null);
  const [filterTable, setFilterTable] = useState<string | null>(null);

  const pageEntries = useMemo<PageEntry[]>(() => {
    const result: PageEntry[] = [];
    for (const f of files) {
      const schedPages = f.pageStats?.signSchedulePages ?? [];
      const bothPages: number[] = (f.pageStats as Record<string, unknown>)?.bothPages as number[] | undefined ?? [];
      const allPages = [...new Set([...schedPages, ...bothPages])].sort((a, b) => a - b);
      for (const pg of allPages) {
        result.push({ fileId: f.id, fileName: f.originalName, pageNumber: pg });
      }
    }
    return result;
  }, [files]);

  // Fetch schedule entries from API
  const fetchScheduleData = useCallback(() => {
    if (!jobId) return Promise.resolve();
    return apiFetch(`/api/jobs/${jobId}/schedule-entries`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data: { entries: ScheduleEntry[]; specs: SignTypeSpec[] }) => {
        setEntries(data.entries ?? []);
        setSpecs(data.specs ?? []);
      })
      .catch((err) => {
        setEntriesError(err.message ?? "Failed to load schedule data");
        setEntries([]);
      });
  }, [jobId]);

  useEffect(() => {
    if (!jobId) return;
    setLoadingEntries(true);
    setEntriesError(null);
    fetchScheduleData().finally(() => setLoadingEntries(false));
  }, [jobId, fetchScheduleData]);

  // Poll for enrichment completion when specs with drawings are not yet enriched
  useEffect(() => {
    const pendingEnrichment = specs.some((s) => s.hasDrawing && !s.geminiEnriched);
    if (!pendingEnrichment) return;
    const interval = setInterval(() => {
      fetchScheduleData();
    }, 5000);
    return () => clearInterval(interval);
  }, [specs, fetchScheduleData]);

  // ── Image viewer state ────────────────────────────────────────────────────
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
  const panRef = useRef<{ startScrollLeft: number; startScrollTop: number; startClientX: number; startClientY: number } | null>(null);

  const currentEntry = pageEntries[pageIdx] ?? null;

  useEffect(() => {
    if (viewMode !== "image") return;
    if (prevBlobUrlRef.current) { URL.revokeObjectURL(prevBlobUrlRef.current); prevBlobUrlRef.current = null; }
    setImageUrl(null);
    setImageError(false);
    setNativeSize(null);
    if (!currentEntry) return;
    setImageLoading(true);
    let cancelled = false;
    apiFetch(`/api/jobs/${jobId}/files/${currentEntry.fileId}/pages/${currentEntry.pageNumber}/image`)
      .then((res) => { if (!res.ok) throw new Error(`${res.status}`); return res.blob(); })
      .then((blob) => { if (cancelled) return; const url = URL.createObjectURL(blob); prevBlobUrlRef.current = url; setImageUrl(url); })
      .catch(() => { if (!cancelled) setImageError(true); })
      .finally(() => { if (!cancelled) setImageLoading(false); });
    return () => { cancelled = true; };
  }, [currentEntry, jobId, viewMode]);

  useEffect(() => { return () => { if (prevBlobUrlRef.current) URL.revokeObjectURL(prevBlobUrlRef.current); }; }, []);
  useEffect(() => { hasSetScaleRef.current = false; setNativeSize(null); }, [pageIdx]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => { e.preventDefault(); setScale((s) => Math.min(3, Math.max(0.3, s + (e.deltaY < 0 ? 0.15 : -0.15)))); };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const handleImageLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    const nw = img.naturalWidth; const nh = img.naturalHeight;
    if (nw > 0 && nh > 0) {
      setNativeSize({ w: nw, h: nh });
      if (!hasSetScaleRef.current && containerRef.current) {
        hasSetScaleRef.current = true;
        const cw = containerRef.current.clientWidth - 32; const ch = containerRef.current.clientHeight - 32;
        const fit = Math.min(2, Math.max(0.3, Math.min(cw / nw, ch / nh)));
        setFitScale(fit); setScale(fit);
      }
    }
  }, []);

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    panRef.current = { startScrollLeft: containerRef.current?.scrollLeft ?? 0, startScrollTop: containerRef.current?.scrollTop ?? 0, startClientX: e.clientX, startClientY: e.clientY };
    setIsPanning(true);
  }, []);
  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!panRef.current || !containerRef.current) return;
    containerRef.current.scrollLeft = panRef.current.startScrollLeft - (e.clientX - panRef.current.startClientX);
    containerRef.current.scrollTop = panRef.current.startScrollTop - (e.clientY - panRef.current.startClientY);
  }, []);
  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => { panRef.current = null; setIsPanning(false); e.currentTarget.releasePointerCapture(e.pointerId); }, []);

  const canPrev = pageIdx > 0;
  const canNext = pageIdx < pageEntries.length - 1;

  // ── Derived table data ────────────────────────────────────────────────────
  const typeCodes = useMemo(() => {
    const codes = new Set<string>();
    if (entries) for (const e of entries) if (e.signTypeCode) codes.add(e.signTypeCode);
    return [...codes].sort();
  }, [entries]);

  const tableCodes = useMemo(() => {
    const names = new Set<string>();
    if (entries) for (const e of entries) if (e.sourceTableName) names.add(e.sourceTableName);
    return [...names].sort();
  }, [entries]);

  const filteredEntries = useMemo(() => {
    if (!entries) return [];
    return entries.filter((e) => {
      if (filterCode && e.signTypeCode !== filterCode) return false;
      if (filterTable && (e.sourceTableName ?? "Schedule") !== filterTable) return false;
      return true;
    });
  }, [entries, filterCode, filterTable]);

  // Group filtered entries by sourceTableName for display
  const groupedEntries = useMemo(() => {
    const groups = new Map<string, ScheduleEntry[]>();
    for (const entry of filteredEntries) {
      const key = entry.sourceTableName ?? "Schedule";
      const group = groups.get(key) ?? [];
      group.push(entry);
      groups.set(key, group);
    }
    return groups;
  }, [filteredEntries]);

  const hasStructuredData = entries !== null && entries.length > 0;
  const hasSchedulePages = pageEntries.length > 0;

  const specByCode = useMemo(() => {
    const map = new Map<string, SignTypeSpec>();
    for (const s of specs) map.set(s.typeCode, s);
    return map;
  }, [specs]);

  // ── Empty state ───────────────────────────────────────────────────────────
  if (!hasStructuredData && !hasSchedulePages && !loadingEntries) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4 text-center p-12">
        <div className="w-16 h-16 rounded-full bg-secondary/60 flex items-center justify-center">
          <FileText className="w-8 h-8 text-muted-foreground/50" />
        </div>
        <div>
          <p className="text-base font-display font-semibold text-foreground/70">No sign schedule data available</p>
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
    <div className="flex flex-col flex-1 min-h-0">
      {/* Top toolbar */}
      <div className="flex-none flex items-center gap-2 px-4 py-2 bg-card border-b border-border">
        {/* View mode toggle */}
        <div className="flex items-center gap-1 bg-secondary rounded-md p-0.5">
          <button
            onClick={() => setViewMode("table")}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition-colors ${viewMode === "table" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
          >
            <Table2 className="w-3.5 h-3.5" />
            Table
          </button>
          <button
            onClick={() => setViewMode("image")}
            disabled={!hasSchedulePages}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition-colors ${viewMode === "image" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"} disabled:opacity-40 disabled:cursor-not-allowed`}
          >
            <Image className="w-3.5 h-3.5" />
            Image
          </button>
        </div>

        {viewMode === "table" && (
          <>
            <div className="w-px h-4 bg-border mx-0.5" />
            {/* Source table / level filter */}
            {tableCodes.length > 1 && (
              <div className="flex items-center gap-1 overflow-x-auto flex-shrink-0">
                <span className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wider flex-shrink-0">Level:</span>
                <button
                  onClick={() => setFilterTable(null)}
                  className={`flex-shrink-0 px-2 py-0.5 rounded text-[11px] transition-colors ${!filterTable ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground border border-border hover:bg-secondary/80"}`}
                >
                  All
                </button>
                {tableCodes.map((name) => (
                  <button
                    key={name}
                    onClick={() => setFilterTable(filterTable === name ? null : name)}
                    className={`flex-shrink-0 px-2 py-0.5 rounded text-[11px] transition-colors ${filterTable === name ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground border border-border hover:bg-secondary/80"}`}
                  >
                    {name}
                  </button>
                ))}
              </div>
            )}
            <div className="w-px h-4 bg-border mx-0.5" />
            {/* Type code filter chips */}
            <div className="flex items-center gap-1 overflow-x-auto">
              <button
                onClick={() => setFilterCode(null)}
                className={`flex-shrink-0 px-2 py-0.5 rounded text-[11px] font-mono transition-colors ${!filterCode ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground border border-border hover:bg-secondary/80"}`}
              >
                All
              </button>
              {typeCodes.map((code) => {
                const spec = specByCode.get(code);
                const isPending = spec?.hasDrawing && !spec.geminiEnriched;
                return (
                  <button
                    key={code}
                    onClick={() => setFilterCode(filterCode === code ? null : code)}
                    className={`flex-shrink-0 flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-mono transition-colors ${filterCode === code ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground border border-border hover:bg-secondary/80"}`}
                  >
                    {code}
                    {isPending && <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse flex-shrink-0" title="Enrichment pending" />}
                  </button>
                );
              })}
            </div>
          </>
        )}

        {viewMode === "image" && (
          <>
            <div className="w-px h-4 bg-border mx-0.5" />
            <button aria-label="Previous page" disabled={!canPrev} onClick={() => setPageIdx((i) => Math.max(0, i - 1))} className="p-1.5 rounded hover:bg-secondary disabled:opacity-30 transition-colors">
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="text-xs font-mono text-muted-foreground min-w-[110px] text-center select-none">
              Schedule {pageIdx + 1} / {pageEntries.length}
              {currentEntry && <span className="text-muted-foreground/50 ml-1">(pg {currentEntry.pageNumber})</span>}
            </span>
            <button aria-label="Next page" disabled={!canNext} onClick={() => setPageIdx((i) => Math.min(pageEntries.length - 1, i + 1))} className="p-1.5 rounded hover:bg-secondary disabled:opacity-30 transition-colors">
              <ChevronRight className="w-4 h-4" />
            </button>
            <div className="w-px h-4 bg-border mx-0.5" />
            <button onClick={() => setScale((s) => Math.max(0.3, s - 0.15))} disabled={scale <= 0.3} className="p-1.5 rounded hover:bg-secondary disabled:opacity-30 transition-colors" title="Zoom out">
              <ZoomOut className="w-3.5 h-3.5" />
            </button>
            <span className="text-[11px] font-mono text-muted-foreground w-10 text-center select-none">{Math.round(scale * 100)}%</span>
            <button onClick={() => setScale(fitScale)} title="Fit to page" className="text-[10px] font-display font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground hover:border-foreground/40 transition-colors">Fit</button>
            <button onClick={() => setScale((s) => Math.min(3, s + 0.15))} disabled={scale >= 3} className="p-1.5 rounded hover:bg-secondary disabled:opacity-30 transition-colors" title="Zoom in">
              <ZoomIn className="w-3.5 h-3.5" />
            </button>
          </>
        )}
      </div>

      {/* Main content */}
      {viewMode === "table" ? (
        <div className="flex flex-1 min-h-0 overflow-hidden">
          {/* Table */}
          <div className="flex-1 overflow-auto">
            {loadingEntries && (
              <div className="flex items-center justify-center h-32 gap-2 text-muted-foreground">
                <Loader2 className="w-5 h-5 animate-spin" />
                <span className="text-sm">Loading schedule data…</span>
              </div>
            )}
            {entriesError && (
              <div className="flex items-center gap-2 p-4 text-destructive text-sm">
                <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                {entriesError}
              </div>
            )}
            {!loadingEntries && entries !== null && entries.length === 0 && (
              <div className="flex flex-col items-center justify-center h-32 text-muted-foreground gap-2">
                <FileText className="w-6 h-6 opacity-40" />
                <p className="text-sm">No parsed schedule entries yet.</p>
                <p className="text-xs text-muted-foreground/60">Re-run extraction to populate structured data.</p>
              </div>
            )}
            {!loadingEntries && filteredEntries.length > 0 && (
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr className="sticky top-0 z-10 bg-card border-b border-border">
                    <th className="text-left px-3 py-2 font-semibold text-muted-foreground/80 whitespace-nowrap">Rm #</th>
                    <th className="text-left px-3 py-2 font-semibold text-muted-foreground/80">Room Name</th>
                    <th className="text-left px-3 py-2 font-semibold text-muted-foreground/80 whitespace-nowrap">Type</th>
                    <th className="text-left px-3 py-2 font-semibold text-muted-foreground/80 whitespace-nowrap">Qty</th>
                    <th className="text-left px-3 py-2 font-semibold text-muted-foreground/80">Signage Text</th>
                    <th className="text-left px-3 py-2 font-semibold text-muted-foreground/80 whitespace-nowrap">GB</th>
                    <th className="text-left px-3 py-2 font-semibold text-muted-foreground/80">Features</th>
                    <th className="text-left px-3 py-2 font-semibold text-muted-foreground/80">Comments</th>
                    <th className="text-left px-3 py-2 font-semibold text-muted-foreground/80 whitespace-nowrap">Dims</th>
                    <th className="text-left px-3 py-2 font-semibold text-muted-foreground/80">Material</th>
                  </tr>
                </thead>
                <tbody>
                  {[...groupedEntries.entries()].flatMap(([groupName, groupRows], gIdx) => [
                    /* Group header row */
                    groupedEntries.size > 1 ? (
                      <tr key={`group-${gIdx}`} className="bg-secondary/40 border-t-2 border-border">
                        <td colSpan={10} className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                          {groupName}
                          <span className="ml-1.5 text-muted-foreground/40 font-normal normal-case tracking-normal">{groupRows.length} rows</span>
                        </td>
                      </tr>
                    ) : null,
                    /* Data rows */
                    ...groupRows.map((entry, idx) => {
                      const isEven = idx % 2 === 0;
                      const spec = entry.signTypeCode ? specByCode.get(entry.signTypeCode) : undefined;
                      const dims = entry.dimensions ?? spec?.dimensions ?? entry.specDimensions ?? null;
                      const mat = entry.material ?? spec?.material ?? entry.specMaterial ?? null;
                      const features: string[] = (entry.features ?? entry.specFeatures ?? []) as string[];
                      return (
                        <tr
                          key={entry.id}
                          className={`border-b border-border/50 hover:bg-primary/5 transition-colors ${isEven ? "bg-transparent" : "bg-secondary/20"}`}
                        >
                          <td className="px-3 py-1.5 font-mono text-muted-foreground whitespace-nowrap">{entry.roomNumber ?? "—"}</td>
                          <td className="px-3 py-1.5 max-w-[180px] truncate" title={entry.roomName ?? undefined}>{entry.roomName ?? <span className="text-muted-foreground/40">—</span>}</td>
                          <td className="px-3 py-1.5 whitespace-nowrap">
                            {entry.signTypeCode ? (
                              <div className="relative group/type inline-block">
                                <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-mono font-semibold cursor-default ${filterCode === entry.signTypeCode ? "bg-primary text-primary-foreground" : "bg-secondary text-foreground border border-border"}`}>
                                  {entry.signTypeCode}
                                </span>
                                {spec?.cropImageUrl && (
                                  <div className="absolute left-0 top-full mt-1 z-50 hidden group-hover/type:block w-40 rounded border border-border bg-card shadow-lg p-1">
                                    <img src={spec.cropImageUrl} alt={`Type ${entry.signTypeCode}`} className="w-full rounded object-contain" />
                                  </div>
                                )}
                              </div>
                            ) : <span className="text-muted-foreground/40">—</span>}
                          </td>
                          <td className="px-3 py-1.5 font-mono text-center">{entry.quantity ?? <span className="text-muted-foreground/40">—</span>}</td>
                          <td className="px-3 py-1.5 max-w-[200px]">
                            {entry.signageText ? (
                              <span className="block truncate" title={entry.signageText}>{entry.signageText}</span>
                            ) : <span className="text-muted-foreground/40">—</span>}
                          </td>
                          <td className="px-3 py-1.5 text-center">
                            {entry.glassBacker === true ? <span className="text-primary font-semibold">✓</span> : <span className="text-muted-foreground/40">—</span>}
                          </td>
                          <td className="px-3 py-1.5 max-w-[160px]">
                            {features.length > 0 ? (
                              <div className="flex flex-wrap gap-0.5">
                                {features.map((f, fi) => (
                                  <span key={fi} className="inline-block px-1 py-0 bg-secondary border border-border rounded text-[10px] text-muted-foreground">{f}</span>
                                ))}
                              </div>
                            ) : <span className="text-muted-foreground/40">—</span>}
                          </td>
                          <td className="px-3 py-1.5 max-w-[200px]">
                            {entry.expandedComments ?? entry.rawComments ? (
                              <span className="block truncate text-muted-foreground" title={entry.expandedComments ?? entry.rawComments ?? undefined}>
                                {entry.expandedComments ?? entry.rawComments}
                              </span>
                            ) : <span className="text-muted-foreground/40">—</span>}
                          </td>
                          <td className="px-3 py-1.5 font-mono whitespace-nowrap text-muted-foreground">{dims ?? <span className="text-muted-foreground/40">—</span>}</td>
                          <td className="px-3 py-1.5 max-w-[120px] truncate text-muted-foreground" title={mat ?? undefined}>{mat ?? <span className="text-muted-foreground/40">—</span>}</td>
                        </tr>
                      );
                    }),
                  ])}
                </tbody>
              </table>
            )}
          </div>

          {/* Specs sidebar */}
          {specs.length > 0 && (
            <div className="w-56 flex-shrink-0 border-l border-border overflow-y-auto bg-secondary/10 p-3">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">Sign Types</p>
              <div className="flex flex-col gap-2">
                {specs.map((spec) => (
                  <button
                    key={spec.id}
                    onClick={() => setFilterCode(filterCode === spec.typeCode ? null : spec.typeCode)}
                    className={`w-full text-left rounded p-2 border transition-colors ${filterCode === spec.typeCode ? "border-primary bg-primary/10" : "border-border bg-card hover:bg-secondary/60"}`}
                  >
                    <div className="flex items-center justify-between mb-0.5">
                      <span className="text-xs font-mono font-bold">{spec.typeCode}</span>
                      {spec.geminiEnriched
                        ? <span className="text-[9px] text-primary/70 font-semibold">AI</span>
                        : spec.hasDrawing
                          ? <span className="text-[9px] text-amber-500 font-semibold animate-pulse">Enriching…</span>
                          : null}
                    </div>
                    {spec.dimensions && <div className="text-[10px] text-muted-foreground truncate">{spec.dimensions}</div>}
                    {spec.material && <div className="text-[10px] text-muted-foreground/70 truncate">{spec.material}</div>}
                    {spec.cropImageUrl && (
                      <img
                        src={spec.cropImageUrl}
                        alt={`Type ${spec.typeCode} diagram`}
                        className="mt-1.5 w-full rounded border border-border object-contain max-h-24"
                        onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
                      />
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : (
        /* Image viewer */
        <div className="flex flex-col flex-1 min-h-0 bg-secondary/30">
          {pageEntries.length > 1 && (
            <div className="flex-none flex items-center gap-1.5 px-4 py-1.5 bg-secondary/30 border-b border-border overflow-x-auto">
              <span className="text-[10px] font-mono text-muted-foreground/60 flex-shrink-0 mr-1">Jump:</span>
              {pageEntries.map((entry, idx) => (
                <button
                  key={`${entry.fileId}-${entry.pageNumber}`}
                  onClick={() => setPageIdx(idx)}
                  className={`px-2 py-0.5 rounded text-[10px] font-mono flex-shrink-0 transition-colors ${idx === pageIdx ? "bg-primary text-primary-foreground font-bold" : "bg-secondary text-muted-foreground border border-border hover:bg-secondary/80"}`}
                >
                  pg {entry.pageNumber}
                </button>
              ))}
            </div>
          )}
          <div
            ref={containerRef}
            className="flex-1 overflow-auto bg-zinc-900 select-none"
            style={{ cursor: isPanning ? "grabbing" : "grab" }}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={() => { panRef.current = null; setIsPanning(false); }}
          >
            <div style={{ minWidth: "max-content", minHeight: "max-content", display: "flex", justifyContent: "center", alignItems: "flex-start", padding: 16 }}>
              {imageLoading && !imageUrl && <div className="flex items-center justify-center h-64"><Loader2 className="w-8 h-8 text-primary animate-spin" /></div>}
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
                  style={{ display: "block", width: imgW, height: imgH, maxWidth: "none", boxShadow: "0 4px 32px rgba(0,0,0,0.5)" }}
                />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
