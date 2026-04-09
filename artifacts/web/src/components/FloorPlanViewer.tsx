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

export interface SignMarker {
  id: string;
  jobFileId?: string | null;
  pageNumber?: number | null;
  xPos?: number | null;
  yPos?: number | null;
  signType?: string | null;
  signIdentifier?: string | null;
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

type DragState = {
  signId: string;
  startClientX: number;
  startClientY: number;
  currentX: number;
  currentY: number;
  moved: boolean;
};

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
  const rawFloorPlanPages = file.pageStats?.floorPlanPages ?? [];
  const floorPlanPages =
    rawFloorPlanPages.length > 0
      ? rawFloorPlanPages
      : Array.from({ length: file.pageCount ?? 1 }, (_, i) => i + 1);

  const [pageIdx, setPageIdx] = useState(0);
  const pageNumber = floorPlanPages[pageIdx] ?? 1;

  const { pdfBuffer, blobError } = usePdfBlob(
    `/api/jobs/${jobId}/files/${file.id}/pdf`
  );
  const pdfFile = useMemo(
    () =>
      pdfBuffer ? { data: new Uint8Array(pdfBuffer.slice(0)) } : null,
    [pdfBuffer]
  );

  const [pdfError, setPdfError] = useState<string | null>(null);
  const [scale, setScale] = useState(1.0);
  const containerRef = useRef<HTMLDivElement>(null);
  const pageWrapRef = useRef<HTMLDivElement>(null);

  const [pageSize, setPageSize] = useState<{ w: number; h: number } | null>(
    null
  );
  const pageSizeRef = useRef<{ w: number; h: number } | null>(null);
  useEffect(() => {
    pageSizeRef.current = pageSize;
  }, [pageSize]);

  useEffect(() => {
    const el = pageWrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const canvas = el.querySelector("canvas");
      if (canvas) {
        const s = { w: canvas.offsetWidth, h: canvas.offsetHeight };
        setPageSize(s);
        pageSizeRef.current = s;
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const [addMarkerMode, setAddMarkerMode] = useState(false);
  const addMarkerModeRef = useRef(false);
  useEffect(() => {
    addMarkerModeRef.current = addMarkerMode;
  }, [addMarkerMode]);

  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);

  const pageMarkersRef = useRef<SignMarker[]>([]);

  const pageMarkers = useMemo(
    () =>
      signs.filter(
        (s) =>
          s.jobFileId === file.id &&
          s.xPos != null &&
          s.yPos != null &&
          (s.pageNumber ?? 1) === pageNumber
      ),
    [signs, file.id, pageNumber]
  );
  useEffect(() => {
    pageMarkersRef.current = pageMarkers;
  }, [pageMarkers]);

  const getPageCoords = (e: React.PointerEvent): { x: number; y: number } | null => {
    const wrap = pageWrapRef.current;
    if (!wrap) return null;
    const canvas = wrap.querySelector("canvas");
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)),
    };
  };

  const findHitMarker = (x: number, y: number): SignMarker | null => {
    const ps = pageSizeRef.current;
    if (!ps) return null;
    const hitPx = Math.max(16, Math.min(ps.w, ps.h) * 0.05);
    for (const m of pageMarkersRef.current) {
      const dx = (m.xPos! - x) * ps.w;
      const dy = (m.yPos! - y) * ps.h;
      if (Math.hypot(dx, dy) <= hitPx) return m;
    }
    return null;
  };

  const handlePointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    const coords = getPageCoords(e);
    if (!coords) return;
    const hit = findHitMarker(coords.x, coords.y);
    if (hit) {
      e.currentTarget.setPointerCapture(e.pointerId);
      e.stopPropagation();
      const ds: DragState = {
        signId: hit.id,
        startClientX: e.clientX,
        startClientY: e.clientY,
        currentX: hit.xPos!,
        currentY: hit.yPos!,
        moved: false,
      };
      dragRef.current = ds;
      setDrag({ ...ds });
    }
  };

  const handlePointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const ds = dragRef.current;
    if (!ds) return;
    const coords = getPageCoords(e);
    if (!coords) return;
    const dx = e.clientX - ds.startClientX;
    const dy = e.clientY - ds.startClientY;
    const moved = Math.hypot(dx, dy) > 5;
    const updated: DragState = {
      ...ds,
      currentX: coords.x,
      currentY: coords.y,
      moved,
    };
    dragRef.current = updated;
    setDrag({ ...updated });
  };

  const handlePointerUp = async (e: React.PointerEvent<SVGSVGElement>) => {
    const ds = dragRef.current;
    dragRef.current = null;
    setDrag(null);

    if (ds) {
      if (ds.moved) {
        try {
          const res = await apiFetch(`/api/extracted-signs/${ds.signId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              xPos: ds.currentX,
              yPos: ds.currentY,
              placementSource: "manual",
            }),
          });
          if (res.ok) {
            onSignUpdated(ds.signId, ds.currentX, ds.currentY);
          }
        } catch (err) {
          console.error("Failed to update marker position", err);
        }
      } else {
        const sign = pageMarkersRef.current.find((m) => m.id === ds.signId);
        if (sign) onEditSign(sign);
      }
      return;
    }

    if (!addMarkerModeRef.current) return;
    const coords = getPageCoords(e);
    if (!coords) return;
    if (findHitMarker(coords.x, coords.y)) return;

    try {
      const res = await apiFetch("/api/extracted-signs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jobId,
          jobFileId: file.id,
          pageNumber,
          xPos: coords.x,
          yPos: coords.y,
        }),
      });
      if (res.ok) {
        const data = (await res.json()) as { sign: unknown };
        onSignAdded(data.sign);
      }
    } catch (err) {
      console.error("Failed to add marker", err);
    }
  };

  const dotR = pageSize ? Math.max(10, Math.min(pageSize.w, pageSize.h) * 0.022) : 12;

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
              onClick={() =>
                setPageIdx((i) => Math.min(floorPlanPages.length - 1, i + 1))
              }
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
          {pageMarkers.length} marker{pageMarkers.length !== 1 ? "s" : ""}
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
              if (!scale || scale === 1.0) {
                if (containerRef.current) {
                  const cw = containerRef.current.clientWidth - 32;
                  if (cw > 200) setScale(Math.min(1.5, cw / 850));
                }
              }
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
                  if (containerRef.current) {
                    const cw = containerRef.current.clientWidth - 32;
                    if (cw > 0 && width > 0) {
                      setScale(Math.min(1.5, Math.max(0.25, cw / width)));
                    }
                  }
                }}
              />

              {/* SVG overlay — pointer events captured here for add + drag */}
              {pageSize && (
                <svg
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: pageSize.w,
                    height: pageSize.h,
                    overflow: "visible",
                    pointerEvents:
                      addMarkerMode || pageMarkers.length > 0 ? "all" : "none",
                    cursor: addMarkerMode ? "crosshair" : "default",
                    zIndex: 5,
                  }}
                  viewBox={`0 0 ${pageSize.w} ${pageSize.h}`}
                  onPointerDown={handlePointerDown}
                  onPointerMove={handlePointerMove}
                  onPointerUp={handlePointerUp}
                >
                  {pageMarkers.map((m) => {
                    const isDragging = drag?.signId === m.id;
                    const cx = isDragging
                      ? drag.currentX * pageSize.w
                      : m.xPos! * pageSize.w;
                    const cy = isDragging
                      ? drag.currentY * pageSize.h
                      : m.yPos! * pageSize.h;
                    const color = getSignColor(m.signType);
                    const r = dotR;
                    const label =
                      (m.signIdentifier || m.signType || "?").slice(0, 10);

                    return (
                      <g
                        key={m.id}
                        style={{
                          cursor: isDragging ? "grabbing" : "grab",
                        }}
                      >
                        {/* Outer glow ring when dragging */}
                        {isDragging && (
                          <circle
                            cx={cx}
                            cy={cy}
                            r={r * 2.2}
                            fill="none"
                            stroke={color}
                            strokeWidth={1}
                            strokeDasharray="4 3"
                            opacity={0.5}
                          />
                        )}
                        {/* Main filled circle */}
                        <circle
                          cx={cx}
                          cy={cy}
                          r={r * 1.4}
                          fill={`${color}2a`}
                          stroke={color}
                          strokeWidth={isDragging ? 2.5 : 1.5}
                        />
                        {/* Center dot */}
                        <circle cx={cx} cy={cy} r={r * 0.3} fill={color} />
                        {/* Label above */}
                        <text
                          x={cx}
                          y={cy - r * 1.4 - 4}
                          textAnchor="middle"
                          fill={color}
                          fontSize={Math.max(8, r * 0.85)}
                          fontWeight="bold"
                          fontFamily="monospace"
                          style={{ userSelect: "none", pointerEvents: "none" }}
                        >
                          {label}
                        </text>
                      </g>
                    );
                  })}
                </svg>
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
                  Click anywhere to place a marker · Press again to cancel
                </div>
              )}
            </div>
          </Document>
        )}
      </div>
    </div>
  );
}

export function FloorPlanViewer({
  jobId,
  files,
  signs,
  onSignAdded,
  onSignUpdated,
  onEditSign,
}: FloorPlanViewerProps) {
  const floorPlanFiles = files.filter(
    (f) => (f.pageStats?.floorPlanPages?.length ?? 0) > 0 || (f.pageCount ?? 0) > 0
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
