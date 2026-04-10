import { useState, useRef, useEffect, useMemo } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import { usePdfBlob } from "@/hooks/use-pdf-blob";
import { apiFetch } from "@/lib/apiClient";
import {
  ChevronLeft,
  ChevronRight,
  MapPin,
  Plus,
  Loader2,
  AlertTriangle,
} from "lucide-react";

pdfjs.GlobalWorkerOptions.workerSrc = `${import.meta.env.BASE_URL}pdf.worker.min.mjs`;

// ── Sign type color palette ──────────────────────────────────────────────────
const SIGN_TYPE_COLORS: Record<string, string> = {
  wayfinding: "#3B82F6",
  directional: "#10B981",
  informational: "#06B6D4",
  regulatory: "#EF4444",
  safety: "#F97316",
  exit: "#DC2626",
  ada: "#8B5CF6",
  accessibility: "#8B5CF6",
  "room id": "#F59E0B",
  "building id": "#6366F1",
  monument: "#78716C",
  pylon: "#78716C",
  parking: "#EC4899",
  restroom: "#EC4899",
  "channel letter": "#84CC16",
  cabinet: "#14B8A6",
  "dimensional letter": "#A78BFA",
  "building sign": "#6366F1",
};

function getSignColor(signType: string | null | undefined): string {
  if (!signType) return "#6B7280";
  const key = signType.toLowerCase();
  for (const [k, v] of Object.entries(SIGN_TYPE_COLORS)) {
    if (key.includes(k)) return v;
  }
  return "#6B7280";
}

// ── Public types (kept compatible so JobDetails.tsx needs no changes) ────────
export interface SignMarker {
  id: string;
  jobFileId?: string | null;
  pageNumber?: number | null;
  xPos?: number | null;
  yPos?: number | null;
  signType?: string | null;
  signIdentifier?: string | null;
  location?: string | null;
  placementSource?: string | null;
  manuallyAdded?: boolean | null;
  userVerified?: boolean | null;
}

export interface FileInfo {
  id: string;
  originalName: string;
  pageCount?: number | null;
  pageStats?: {
    floorPlanPages: number[];
    signSchedulePages: number[];
    bothPages?: number[];
    otherPages: number[];
  } | null;
}

interface FloorPlanViewerProps {
  jobId: string;
  files: FileInfo[];
  signs: SignMarker[];
  onSignAdded: (sign: unknown) => void;
  onSignUpdated: (signId: string, xPos: number, yPos: number) => void;
  onEditSign: (sign: SignMarker) => void;
}

// ── Words API types ──────────────────────────────────────────────────────────
interface PdfPhrase {
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface FloorPlanBbox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface WordsResponse {
  phrases: PdfPhrase[];
  floorPlanBbox: FloorPlanBbox | null;
  pageType?: "floor_plan" | "sign_schedule" | "both" | "other";
}

// ── Client-side location matcher (mirrors server logic) ──────────────────────
function normId(s: string): string {
  return s.toLowerCase().replace(/[\s\-_]/g, "");
}

function exactBoundaryMatch(haystack: string, needle: string): boolean {
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    const before = idx > 0 ? haystack[idx - 1] : null;
    const after = idx + needle.length < haystack.length ? haystack[idx + needle.length] : null;
    if ((before == null || !/[a-z0-9]/.test(before)) && (after == null || !/[a-z0-9]/.test(after)))
      return true;
    idx = haystack.indexOf(needle, idx + 1);
  }
  return false;
}

function tokenize(text: string): string[] {
  return [...new Set(text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((t) => t.length >= 2))];
}

function levenshtein(s: string, t: string): number {
  const m = s.length, n = t.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      curr[j] = s[i - 1] === t[j - 1] ? prev[j - 1]! : 1 + Math.min(prev[j]!, curr[j - 1]!, prev[j - 1]!);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n]!;
}

function levenshteinSim(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
}

function phraseMatchScore(phraseText: string, query: string): number {
  const pn = phraseText.toLowerCase().replace(/[^a-z0-9]/g, " ").replace(/\s+/g, " ").trim();
  const qn = query.toLowerCase().replace(/[^a-z0-9]/g, " ").replace(/\s+/g, " ").trim();
  if (!pn || !qn) return 0;
  const pt = tokenize(pn);
  const qt = tokenize(qn);
  if (!pt.length || !qt.length) return 0;
  let total = 0;
  for (const qtok of qt) {
    let best = 0;
    for (const ptok of pt) {
      if (qtok === ptok) { best = 1; break; }
      const [shorter, longer] = qtok.length <= ptok.length ? [qtok, ptok] : [ptok, qtok];
      if (longer.startsWith(shorter)) best = Math.max(best, shorter.length / longer.length);
      best = Math.max(best, levenshteinSim(qtok, ptok));
    }
    total += best;
  }
  return total / qt.length;
}

function matchLocationToCoords(
  phrases: PdfPhrase[],
  floorPlanBbox: FloorPlanBbox,
  location: string | null | undefined,
  signIdentifier: string | null | undefined,
): { xPos: number; yPos: number } | null {
  const query = [location, signIdentifier].filter(Boolean).join(" ").trim();
  if (!query) return null;

  const BBOX_TOLERANCE = 0.02;
  const drawingPhrases = phrases.filter((p) => {
    const cx = (p.x0 + p.x1) / 2;
    const cy = (p.y0 + p.y1) / 2;
    return (
      cx >= floorPlanBbox.x0 - BBOX_TOLERANCE &&
      cx <= floorPlanBbox.x1 + BBOX_TOLERANCE &&
      cy >= floorPlanBbox.y0 - BBOX_TOLERANCE &&
      cy <= floorPlanBbox.y1 + BBOX_TOLERANCE
    );
  });

  if (!drawingPhrases.length) return null;

  const ROOM_NUM_RE = /\b(?:[A-Za-z]{1,2}\d{2,4}[A-Za-z]?|\d{2,4}[A-Za-z]{1,2})\b/g;
  const roomTokens = (query.match(ROOM_NUM_RE) ?? []).map((t) => normId(t));

  let best: { score: number; cx: number; cy: number } | null = null;
  for (const p of drawingPhrases) {
    const cx = (p.x0 + p.x1) / 2;
    const cy = (p.y0 + p.y1) / 2;
    const pn = normId(p.text);
    let score = phraseMatchScore(p.text, query);
    if (roomTokens.length > 0 && roomTokens.some((rt) => exactBoundaryMatch(pn, rt))) {
      score = Math.max(score, 0.85);
    }
    if (!best || score > best.score) best = { score, cx, cy };
  }

  if (!best || best.score < 0.5) return null;
  return { xPos: best.cx, yPos: best.cy };
}

// ── Drag state ──────────────────────────────────────────────────────────────
interface DragState {
  signId: string;
  startClientX: number;
  startClientY: number;
  currentX: number;
  currentY: number;
  moved: boolean;
}

// ── Tooltip state ────────────────────────────────────────────────────────────
interface TooltipState {
  x: number;
  y: number;
  sign: SignMarker;
}

// ── Resolved marker (has coordinates) ───────────────────────────────────────
interface ResolvedMarker extends SignMarker {
  resolvedX: number;
  resolvedY: number;
}

// ── FilePdfViewer ────────────────────────────────────────────────────────────
function FilePdfViewer({
  jobId,
  file,
  signs,
  onSignAdded,
  onSignUpdated,
  onEditSign,
}: {
  jobId: string;
  file: FileInfo;
  signs: SignMarker[];
  onSignAdded: (sign: unknown) => void;
  onSignUpdated: (signId: string, xPos: number, yPos: number) => void;
  onEditSign: (sign: SignMarker) => void;
}) {
  // Merge floor_plan and both pages into a single navigable page list (sorted, deduped).
  const floorPlanPages = useMemo(() => {
    const fp = file.pageStats?.floorPlanPages ?? [];
    const bp = file.pageStats?.bothPages ?? [];
    return [...new Set([...fp, ...bp])].sort((a, b) => a - b);
  }, [file.pageStats]);

  const [pageIdx, setPageIdx] = useState(0);
  const pageNumber = floorPlanPages[pageIdx] ?? 1;

  const { pdfBuffer, blobError } = usePdfBlob(`/api/jobs/${jobId}/files/${file.id}/pdf`);
  const pdfFile = useMemo(
    () => (pdfBuffer ? { data: new Uint8Array(pdfBuffer.slice(0)) } : null),
    [pdfBuffer]
  );

  const [pdfError, setPdfError] = useState<string | null>(null);
  const [scale, setScale] = useState(1.0);
  const containerRef = useRef<HTMLDivElement>(null);
  const pageWrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  // Guard: react-pdf v10 fires onLoadSuccess inside useEffect([page, scale]),
  // meaning it re-fires every time scale changes. This ref ensures we only
  // call setScale ONCE per page/file, preventing the infinite loop.
  const hasSetScaleRef = useRef(false);
  useEffect(() => {
    hasSetScaleRef.current = false;
  }, [pageNumber, file.id]);

  // Words data from the API
  const [wordsData, setWordsData] = useState<WordsResponse | null>(null);
  const wordsDataRef = useRef<WordsResponse | null>(null);
  useEffect(() => {
    wordsDataRef.current = wordsData;
  }, [wordsData]);

  useEffect(() => {
    setWordsData(null);
    apiFetch(`/api/jobs/${jobId}/files/${file.id}/pages/${pageNumber}/words`)
      .then((r) => r.json() as Promise<WordsResponse>)
      .then((data) => setWordsData(data))
      .catch(() => setWordsData(null));
  }, [jobId, file.id, pageNumber]);

  // Add marker mode
  const [addMarkerMode, setAddMarkerMode] = useState(false);
  const addMarkerModeRef = useRef(false);
  useEffect(() => {
    addMarkerModeRef.current = addMarkerMode;
  }, [addMarkerMode]);

  // Drag state
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);

  // Tooltip state
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);

  // Resolve markers: use DB coords if placementSource === "word_match" or xPos/yPos already set,
  // otherwise fall back to client-side match using words data.
  const pageMarkersRaw = useMemo(
    () =>
      signs.filter(
        (s) =>
          s.jobFileId === file.id &&
          (s.pageNumber ?? 1) === pageNumber
      ),
    [signs, file.id, pageNumber]
  );

  const resolvedMarkers = useMemo<ResolvedMarker[]>(() => {
    // Without words data we can't resolve positions reliably — wait for it.
    // Without a floor plan bbox on the page, we have no valid drawing region.
    if (!wordsData) return [];

    // Hard-filter: sign_schedule pages never have floor plan drawings.
    if (wordsData.pageType === "sign_schedule") return [];

    const bbox = wordsData.floorPlanBbox;
    if (!bbox) return []; // schedule/title-block page: no drawing region

    // Tight tolerance — stored bbox is authoritative; well-placed coords should
    // be well inside it. Client-side fallback re-match corrects any outliers.
    const TOLERANCE = 0.01;

    const result: ResolvedMarker[] = [];
    for (const m of pageMarkersRaw) {
      const src = m.placementSource ?? "";
      const isWordMatch = src === "word_match";
      const isManual = src === "manual";

      if ((isWordMatch || isManual) && m.xPos != null && m.yPos != null) {
        // Trust server-assigned or manually-placed coordinates.
        // Verify they fall inside the floor plan bbox (with tolerance).
        const inside =
          m.xPos >= bbox.x0 - TOLERANCE &&
          m.xPos <= bbox.x1 + TOLERANCE &&
          m.yPos >= bbox.y0 - TOLERANCE &&
          m.yPos <= bbox.y1 + TOLERANCE;
        if (inside) {
          result.push({ ...m, resolvedX: m.xPos, resolvedY: m.yPos });
        } else if (!isManual) {
          // Server coords are outside the current bbox (stale from a previous
          // bbox algorithm or a table-area mismatch). Fall back to client-side
          // re-match so the marker still lands in the floor plan drawing area.
          const match = matchLocationToCoords(
            wordsData.phrases,
            bbox,
            m.location,
            m.signIdentifier
          );
          if (match) {
            result.push({ ...m, resolvedX: match.xPos, resolvedY: match.yPos });
          }
        }
      } else {
        // No trusted DB coords: run client-side word-match inside the bbox.
        const match = matchLocationToCoords(
          wordsData.phrases,
          bbox,
          m.location,
          m.signIdentifier
        );
        if (match) {
          result.push({ ...m, resolvedX: match.xPos, resolvedY: match.yPos });
        }
      }
    }
    return result;
  }, [pageMarkersRaw, wordsData]);

  // ── Pointer helpers ──────────────────────────────────────────────────────────
  const getPageCoords = (e: React.PointerEvent | MouseEvent): { x: number; y: number } | null => {
    const svg = svgRef.current;
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return {
      x: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)),
    };
  };

  const findHitMarker = (x: number, y: number): ResolvedMarker | null => {
    const svg = svgRef.current;
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    const HIT_PX = Math.max(16, Math.min(rect.width, rect.height) * 0.025);
    for (const m of resolvedMarkers) {
      const dx = (m.resolvedX - x) * rect.width;
      const dy = (m.resolvedY - y) * rect.height;
      if (Math.hypot(dx, dy) <= HIT_PX) return m;
    }
    return null;
  };

  const handleSvgPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    const coords = getPageCoords(e);
    if (!coords) return;
    const hit = findHitMarker(coords.x, coords.y);
    if (hit) {
      e.currentTarget.setPointerCapture(e.pointerId);
      const ds: DragState = {
        signId: hit.id,
        startClientX: e.clientX,
        startClientY: e.clientY,
        currentX: hit.resolvedX,
        currentY: hit.resolvedY,
        moved: false,
      };
      dragRef.current = ds;
      setDrag({ ...ds });
    }
  };

  const handleSvgPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const coords = getPageCoords(e);
    if (!coords) return;

    const ds = dragRef.current;
    if (ds) {
      const dx = e.clientX - ds.startClientX;
      const dy = e.clientY - ds.startClientY;
      const moved = Math.hypot(dx, dy) > 5;
      const updated: DragState = { ...ds, currentX: coords.x, currentY: coords.y, moved };
      dragRef.current = updated;
      setDrag({ ...updated });
      return;
    }

    // Tooltip: show on hover
    const hit = findHitMarker(coords.x, coords.y);
    if (hit) {
      const svg = svgRef.current;
      if (svg) {
        const rect = svg.getBoundingClientRect();
        setTooltip({
          x: e.clientX - rect.left,
          y: e.clientY - rect.top - 12,
          sign: hit,
        });
      }
    } else {
      setTooltip(null);
    }
  };

  const handleSvgPointerUp = async (e: React.PointerEvent<SVGSVGElement>) => {
    const ds = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    setTooltip(null);

    if (ds) {
      if (ds.moved) {
        try {
          const res = await apiFetch(`/api/extracted-signs/${ds.signId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ xPos: ds.currentX, yPos: ds.currentY, placementSource: "manual" }),
          });
          if (res.ok) {
            onSignUpdated(ds.signId, ds.currentX, ds.currentY);
          }
        } catch (err) {
          console.error("Failed to update marker position", err);
        }
      } else {
        const sign = resolvedMarkers.find((m) => m.id === ds.signId);
        if (sign) onEditSign(sign);
      }
      return;
    }

    if (!addMarkerModeRef.current) return;
    const coords = getPageCoords(e);
    if (!coords) return;
    if (findHitMarker(coords.x, coords.y)) return;

    // Require a valid floor plan bbox — block placement on schedule/title-block pages.
    const bbox = wordsDataRef.current?.floorPlanBbox ?? null;
    if (!bbox) return; // no detected drawing region on this page

    const TOL = 0.05;
    if (
      coords.x < bbox.x0 - TOL || coords.x > bbox.x1 + TOL ||
      coords.y < bbox.y0 - TOL || coords.y > bbox.y1 + TOL
    ) return; // outside the floor plan area

    try {
      const res = await apiFetch("/api/extracted-signs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId, jobFileId: file.id, pageNumber, xPos: coords.x, yPos: coords.y }),
      });
      if (res.ok) {
        const data = (await res.json()) as { sign: unknown };
        onSignAdded(data.sign);
        setAddMarkerMode(false);
      }
    } catch (err) {
      console.error("Failed to add marker", err);
    }
  };

  const pageMarkerCount = resolvedMarkers.length;

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Controls bar */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-border bg-secondary/30 flex-shrink-0 flex-wrap">
        {floorPlanPages.length > 1 && (
          <div className="flex items-center gap-1">
            <button
              onClick={() => setPageIdx((i) => Math.max(0, i - 1))}
              disabled={pageIdx === 0}
              className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-secondary disabled:opacity-30 transition-colors"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="text-xs font-mono text-muted-foreground min-w-[110px] text-center">
              Floor plan {pageIdx + 1} / {floorPlanPages.length}{" "}
              <span className="text-muted-foreground/50">(pg {pageNumber})</span>
            </span>
            <button
              onClick={() => setPageIdx((i) => Math.min(floorPlanPages.length - 1, i + 1))}
              disabled={pageIdx === floorPlanPages.length - 1}
              className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-secondary disabled:opacity-30 transition-colors"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        )}
        {floorPlanPages.length === 1 && (
          <span className="text-xs font-mono text-muted-foreground">
            Page {pageNumber}
          </span>
        )}

        <div className="flex-1" />

        <span className="text-xs text-muted-foreground font-mono">
          {pageMarkerCount} marker{pageMarkerCount !== 1 ? "s" : ""}
        </span>

        <button
          onClick={() => setAddMarkerMode((m) => !m)}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] font-display font-semibold uppercase tracking-wide border transition-all ${
            addMarkerMode
              ? "bg-primary text-primary-foreground border-primary shadow-[0_0_12px_rgba(255,170,0,0.25)]"
              : "bg-secondary text-muted-foreground border-border hover:text-primary hover:border-primary/50"
          }`}
        >
          <Plus className="w-3.5 h-3.5" />
          {addMarkerMode ? "Click to Place…" : "Add Marker"}
        </button>
      </div>

      {/* PDF area */}
      <div
        ref={containerRef}
        className="flex-1 overflow-auto p-4 flex justify-center items-start"
      >
        {blobError && (
          <div className="flex flex-col items-center justify-center h-40 text-destructive gap-2">
            <AlertTriangle className="w-6 h-6" />
            <p className="text-sm">Failed to load PDF</p>
          </div>
        )}
        {!pdfFile && !blobError && (
          <div className="flex items-center justify-center h-40">
            <Loader2 className="w-6 h-6 text-primary animate-spin" />
          </div>
        )}
        {pdfFile && (
          <Document
            file={pdfFile}
            onLoadSuccess={({ numPages: n }) => {
              setPdfError(null);
              void n;
            }}
            onLoadError={(err) => setPdfError(err.message)}
            loading={
              <div className="flex items-center justify-center h-40">
                <Loader2 className="w-6 h-6 text-primary animate-spin" />
              </div>
            }
            error={
              <div className="flex flex-col items-center justify-center h-40 text-destructive gap-2">
                <AlertTriangle className="w-6 h-6" />
                <p className="text-sm">{pdfError ?? "Failed to load PDF"}</p>
              </div>
            }
          >
            <div
              ref={pageWrapRef}
              className="relative shadow-2xl inline-block"
              style={{ cursor: addMarkerMode ? "crosshair" : "default" }}
            >
              <Page
                key={`${file.id}-${pageNumber}`}
                pageNumber={pageNumber}
                scale={scale}
                renderTextLayer={false}
                renderAnnotationLayer={false}
                onLoadSuccess={({ width }) => {
                  // Guard: react-pdf v10 fires this on EVERY scale change (useEffect([page, scale])).
                  // Only set scale once per page — ref is reset by useEffect when pageNumber/file.id changes.
                  if (hasSetScaleRef.current) return;
                  if (containerRef.current) {
                    const cw = containerRef.current.clientWidth - 32;
                    if (cw > 0 && width > 0) {
                      hasSetScaleRef.current = true;
                      setScale(Math.min(1.5, Math.max(0.25, cw / width)));
                    }
                  }
                }}
              />

              {/* SVG overlay — fills the page div, renders markers at percentage coords */}
              <svg
                ref={svgRef}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  height: "100%",
                  overflow: "visible",
                  pointerEvents: addMarkerMode || resolvedMarkers.length > 0 ? "all" : "none",
                  cursor: addMarkerMode ? "crosshair" : drag ? "grabbing" : "default",
                  zIndex: 5,
                }}
                onPointerDown={handleSvgPointerDown}
                onPointerMove={handleSvgPointerMove}
                onPointerUp={handleSvgPointerUp}
                onPointerLeave={() => setTooltip(null)}
              >
                {/* Clip markers to the detected floor plan bbox so they never
                    render on schedule tables or title blocks */}
                {wordsData?.floorPlanBbox && (
                  <defs>
                    <clipPath id={`fp-clip-${pageNumber}-${file.id.replace(/[^a-zA-Z0-9]/g, "_")}`}>
                      <rect
                        x={`${wordsData.floorPlanBbox.x0 * 100}%`}
                        y={`${wordsData.floorPlanBbox.y0 * 100}%`}
                        width={`${(wordsData.floorPlanBbox.x1 - wordsData.floorPlanBbox.x0) * 100}%`}
                        height={`${(wordsData.floorPlanBbox.y1 - wordsData.floorPlanBbox.y0) * 100}%`}
                      />
                    </clipPath>
                  </defs>
                )}
                <g clipPath={wordsData?.floorPlanBbox ? `url(#fp-clip-${pageNumber}-${file.id.replace(/[^a-zA-Z0-9]/g, "_")})` : undefined}>
                  {resolvedMarkers.map((m) => {
                    const isDragging = drag?.signId === m.id;
                    const cx = `${(isDragging ? drag!.currentX : m.resolvedX) * 100}%`;
                    const cy = `${(isDragging ? drag!.currentY : m.resolvedY) * 100}%`;
                    const color = getSignColor(m.signType);
                    return (
                      <g key={m.id}>
                        {isDragging && (
                          <circle
                            cx={cx}
                            cy={cy}
                            r={12}
                            fill="none"
                            stroke={color}
                            strokeWidth={1.2}
                            strokeDasharray="4 3"
                            opacity={0.6}
                          />
                        )}
                        <circle cx={cx} cy={cy} r={5} fill={color} />
                      </g>
                    );
                  })}
                </g>
              </svg>

              {/* Floating tooltip */}
              {tooltip && (
                <div
                  style={{
                    position: "absolute",
                    left: tooltip.x + 10,
                    top: Math.max(tooltip.y - 36, 4),
                    zIndex: 20,
                    pointerEvents: "none",
                  }}
                  className="px-2 py-1 rounded-md bg-background/95 border border-border shadow-lg text-[11px] font-mono whitespace-nowrap max-w-[200px] truncate"
                >
                  <span
                    className="inline-block w-2 h-2 rounded-full mr-1.5 align-middle"
                    style={{ background: getSignColor(tooltip.sign.signType) }}
                  />
                  {tooltip.sign.signType ?? "unknown"}
                  {tooltip.sign.signIdentifier ? ` · ${tooltip.sign.signIdentifier}` : ""}
                </div>
              )}

              {/* Add-marker hint overlay */}
              {addMarkerMode && (
                <div
                  style={{
                    position: "absolute",
                    top: 8,
                    left: "50%",
                    transform: "translateX(-50%)",
                    zIndex: 10,
                    pointerEvents: "none",
                  }}
                  className="px-3 py-1.5 rounded-full bg-primary/90 text-primary-foreground text-[10px] font-bold uppercase tracking-wider shadow-lg whitespace-nowrap"
                >
                  Click on floor plan to place a marker · Press again to cancel
                </div>
              )}
            </div>
          </Document>
        )}
      </div>
    </div>
  );
}

// ── Main FloorPlanViewer ─────────────────────────────────────────────────────
export function FloorPlanViewer({
  jobId,
  files,
  signs,
  onSignAdded,
  onSignUpdated,
  onEditSign,
}: FloorPlanViewerProps) {
  const floorPlanFiles = files.filter(
    (f) =>
      (f.pageStats?.floorPlanPages?.length ?? 0) > 0 ||
      (f.pageStats?.bothPages?.length ?? 0) > 0
  );

  const [selectedFileId, setSelectedFileId] = useState<string>(
    () => floorPlanFiles[0]?.id ?? ""
  );

  const selectedFile =
    floorPlanFiles.find((f) => f.id === selectedFileId) ?? floorPlanFiles[0];

  if (floorPlanFiles.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground p-8">
        <div className="text-center">
          <MapPin className="w-8 h-8 mx-auto mb-3 opacity-30" />
          <p className="text-sm font-medium">No floor plan pages detected</p>
          <p className="text-xs text-muted-foreground/60 mt-1">
            Upload plan PDFs and run extraction to classify pages.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* File tabs — only when multiple files */}
      {floorPlanFiles.length > 1 && (
        <div className="flex-none flex items-end gap-0 px-4 pt-2 border-b border-border bg-secondary/20 overflow-x-auto">
          {floorPlanFiles.map((f) => {
            const active = f.id === selectedFile?.id;
            return (
              <button
                key={f.id}
                onClick={() => setSelectedFileId(f.id)}
                className={`px-3 py-1.5 text-xs font-mono rounded-t-md border-b-2 whitespace-nowrap transition-all -mb-px ${
                  active
                    ? "border-primary text-primary bg-background border-x border-t border-border"
                    : "border-transparent text-muted-foreground hover:text-foreground hover:bg-secondary/40"
                }`}
              >
                {f.originalName.replace(/\.pdf$/i, "").slice(0, 30)}
              </button>
            );
          })}
        </div>
      )}

      {selectedFile && (
        <FilePdfViewer
          key={selectedFile.id}
          jobId={jobId}
          file={selectedFile}
          signs={signs}
          onSignAdded={onSignAdded}
          onSignUpdated={onSignUpdated}
          onEditSign={onEditSign}
        />
      )}
    </div>
  );
}
