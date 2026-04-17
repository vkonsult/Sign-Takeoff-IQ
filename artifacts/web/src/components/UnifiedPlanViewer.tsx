import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { apiFetch } from "@/lib/apiClient";
import { AddMarkerForm } from "./AddMarkerForm";
import {
  X,
  ChevronLeft,
  ChevronRight,
  ZoomIn,
  ZoomOut,
  Save,
  Loader2,
  FileText,
  AlertTriangle,
  MapPin,
  Eye,
  EyeOff,
  PenLine,
  MousePointer,
  Trash2,
  Plus,
  CheckCircle,
  Sparkles,
  RotateCcw,
  Undo2,
  Redo2,
} from "lucide-react";

import type { ExtractedSign } from "@/types/sign";
export type { ExtractedSign };

import {
  type PdfPhrase,
  findSignLocationFromPhrases,
  parseLocationParts,
  isResidentialUnitLocation,
  findPairedClusterMatch,
} from "@/lib/signMatcher";


// ── Public Types ─────────────────────────────────────────────────────────────

export interface FileInfo {
  id: string;
  originalName: string;
  pageCount?: number | null;
  pageStats?: {
    floorPlanPages: number[];
    signSchedulePages: number[];
    bothPages?: number[];
    otherPages: number[];
    pageLabels?: (string | null)[];
    pageImagePaths?: Record<string, string> | null;
    outlineSections?: Array<{
      title: string;
      pageStart: number;
      pageEnd: number;
      type: "floor_plan" | "sign_schedule" | "other" | null;
    }>;
  } | null;
}

export interface UnifiedPlanViewerProps {
  mode: "tab" | "modal";
  jobId: string;
  files: FileInfo[];
  signs?: ExtractedSign[];
  allSigns?: ExtractedSign[];
  initialSignId?: string;
  /** Jump straight to this PDF page number on mount (tab mode). */
  initialPage?: number;
  /** Pre-select this file by ID on mount (tab mode). */
  initialFileId?: string;
  showAiHighlight?: boolean;
  showMarkers?: boolean;
  pageType?: "floor_plan" | "sign_schedule";
  onClose?: () => void;
  onSaved?: (updated: ExtractedSign) => void;
  onSignAdded?: (sign: ExtractedSign) => void;
  onSignUpdated?: (signId: string, xPos: number, yPos: number) => void;
  onSignDeleted?: (signId: string) => void;
  onEditSign?: (sign: ExtractedSign) => void;
}

// ── Internal Types ────────────────────────────────────────────────────────────

type FormState = {
  sheetNumber: string;
  detailReference: string;
  signType: string;
  signIdentifier: string;
  quantity: string;
  location: string;
  dimensions: string;
  mountingType: string;
  finishColor: string;
  illumination: string;
  materials: string;
  messageContent: string;
  notes: string;
  reviewFlag: boolean;
};

interface VisualCandidate {
  x: number;
  y: number;
  description: string;
  confidence: number;
}

interface TextMarker {
  x: number;
  y: number;
  phraseCenter?: { x: number; y: number };
  signId: string;
  color: string;
  label: string;
  isCurrent: boolean;
  placementScore: number;
  isGhost?: boolean;
  matchedPhrase?: PdfPhrase;
  rejectedCandidates?: PdfPhrase[];
}

// ── Color palette ─────────────────────────────────────────────────────────────

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

// ── computeMarkerOffset ───────────────────────────────────────────────────────
// Always place the marker below the matched text so the room label remains
// fully readable above the pin. A fixed downward nudge (~3% of page height)
// is used so the dot clears a typical text label.

function computeMarkerOffset(
  _phraseCenter: { x: number; y: number },
  nudgeDist = 0.03,
): { dx: number; dy: number } {
  return { dx: 0, dy: nudgeDist };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function signToForm(sign: ExtractedSign): FormState {
  return {
    sheetNumber: sign.sheetNumber ?? "",
    detailReference: sign.detailReference ?? "",
    signType: sign.signType ?? "",
    signIdentifier: sign.signIdentifier ?? "",
    quantity: sign.quantity != null ? String(sign.quantity) : "",
    location: sign.location ?? "",
    dimensions: sign.dimensions ?? "",
    mountingType: sign.mountingType ?? "",
    finishColor: sign.finishColor ?? "",
    illumination: sign.illumination ?? "",
    materials: sign.materials ?? "",
    messageContent: sign.messageContent ?? "",
    notes: sign.notes ?? "",
    reviewFlag: sign.reviewFlag,
  };
}

// ── Field sub-component ───────────────────────────────────────────────────────

function Field({
  label,
  value,
  onChange,
  placeholder,
  multiline = false,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  multiline?: boolean;
  type?: string;
}) {
  const baseClass =
    "w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary transition-colors font-mono";
  return (
    <div>
      <label className="block text-[10px] font-display font-bold uppercase tracking-wider text-muted-foreground mb-1.5">
        {label}
      </label>
      {multiline ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          rows={3}
          className={`${baseClass} resize-none`}
        />
      ) : (
        <input
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className={baseClass}
        />
      )}
    </div>
  );
}

// ── Edit Panel ─────────────────────────────────────────────────────────────────

interface EditPanelProps {
  activeSign: ExtractedSign;
  textSearchStatus: "idle" | "found" | "not-found";
  onClose?: () => void;
  onSaved?: (updated: ExtractedSign) => void;
  onSignDeleted?: (signId: string) => void;
  onDeleteCommit?: (signId: string) => void;
  setLocalSigns: React.Dispatch<React.SetStateAction<ExtractedSign[]>>;
  setActiveSign: (s: ExtractedSign | null) => void;
  localSigns: ExtractedSign[];
  showCloseButton?: boolean;
}

function EditPanel({
  activeSign,
  textSearchStatus,
  onClose,
  onSaved,
  onSignDeleted,
  onDeleteCommit,
  setLocalSigns,
  setActiveSign,
  localSigns,
  showCloseButton = false,
}: EditPanelProps) {
  const [form, setForm] = useState<FormState>(() => signToForm(activeSign));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    setForm(signToForm(activeSign));
    setDirty(false);
    setSaveError(null);
  }, [activeSign.id]);

  const handleField = useCallback((field: keyof FormState, value: string | boolean) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    setDirty(true);
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const body: Record<string, unknown> = {
        sheetNumber: form.sheetNumber || null,
        detailReference: form.detailReference || null,
        signType: form.signType || null,
        signIdentifier: form.signIdentifier || null,
        quantity: form.quantity ? parseInt(form.quantity, 10) : null,
        location: form.location || null,
        dimensions: form.dimensions || null,
        mountingType: form.mountingType || null,
        finishColor: form.finishColor || null,
        illumination: form.illumination || null,
        materials: form.materials ?? null,
        messageContent: form.messageContent || null,
        notes: form.notes || null,
        reviewFlag: form.reviewFlag,
      };
      const res = await apiFetch(`/api/extracted-signs/${activeSign.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Unknown error" }));
        throw new Error((err as { error?: string }).error ?? "Save failed");
      }
      const data = await res.json() as { sign: ExtractedSign };
      setDirty(false);
      // Optimistically update local state
      setLocalSigns((prev) => prev.map((s) => s.id === activeSign.id ? data.sign : s));
      setActiveSign(data.sign);
      onSaved?.(data.sign);
    } catch (err) {
      setSaveError(String(err instanceof Error ? err.message : err));
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteSign = async (signId: string) => {
    if (onDeleteCommit) {
      onDeleteCommit(signId);
      return;
    }
    try {
      const res = await apiFetch(`/api/extracted-signs/${signId}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete sign");
      setLocalSigns((prev) => prev.filter((s) => s.id !== signId));
      const next = localSigns.find((s) => s.id !== signId);
      setActiveSign(next ?? null);
      onSignDeleted?.(signId);
      if (!next) onClose?.();
    } catch (err) {
      console.error("Delete sign failed:", err);
    }
  };

  return (
    <div className="w-[380px] flex-shrink-0 flex flex-col bg-background overflow-hidden border-l border-border">
      <div className="flex-none px-5 py-3 border-b border-border bg-card flex items-center justify-between">
        <div>
          <h2 className="text-sm font-display font-bold uppercase tracking-wider text-foreground">
            Edit Sign Data
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">Correct any fields extracted by AI</p>
        </div>
        {showCloseButton && onClose && (
          <button onClick={onClose} className="p-1.5 rounded hover:bg-secondary text-muted-foreground transition-colors">
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
        {textSearchStatus === "not-found" && (
          <div className="flex items-start gap-2 text-xs bg-destructive/10 border border-destructive/20 rounded-lg px-3 py-2.5 text-destructive">
            <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
            <div>
              <span className="font-semibold">Location not found on this page.</span>
              <br />
              The text &ldquo;{activeSign.location ?? activeSign.messageContent ?? "?"}&rdquo; was not found
              in this page&rsquo;s text layer. This sign may have been attributed to the wrong page by the AI.
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Field label="Sheet Number" value={form.sheetNumber} onChange={(v) => handleField("sheetNumber", v)} placeholder="A-101" />
          <Field label="Sign ID / Ref" value={form.signIdentifier} onChange={(v) => handleField("signIdentifier", v)} placeholder="S-01" />
        </div>
        <Field label="Sign Type" value={form.signType} onChange={(v) => handleField("signType", v)} placeholder="e.g. Illuminated Cabinet Sign" />
        <div className="grid grid-cols-2 gap-3">
          <Field label="Quantity" value={form.quantity} onChange={(v) => handleField("quantity", v)} placeholder="1" type="number" />
          <Field label="Detail Reference" value={form.detailReference} onChange={(v) => handleField("detailReference", v)} placeholder="D-01" />
        </div>
        <Field label="Location" value={form.location} onChange={(v) => handleField("location", v)} placeholder="e.g. North elevation, above main entrance" multiline />
        <Field label="Dimensions" value={form.dimensions} onChange={(v) => handleField("dimensions", v)} placeholder='e.g. 48" × 24"' />
        <div className="grid grid-cols-2 gap-3">
          <Field label="Mounting Type" value={form.mountingType} onChange={(v) => handleField("mountingType", v)} placeholder="e.g. Wall mounted" />
          <Field label="Illumination" value={form.illumination} onChange={(v) => handleField("illumination", v)} placeholder="e.g. LED backlit" />
        </div>
        <Field label="Finish / Color" value={form.finishColor} onChange={(v) => handleField("finishColor", v)} placeholder="e.g. Matte black" />
        <Field label="Materials" value={form.materials} onChange={(v) => handleField("materials", v)} placeholder="e.g. Aluminum, acrylic face" />
        <Field label="Message / Copy" value={form.messageContent} onChange={(v) => handleField("messageContent", v)} placeholder="Text displayed on the sign" multiline />
        <Field label="Notes" value={form.notes} onChange={(v) => handleField("notes", v)} placeholder="Any additional notes or clarifications" multiline />

        <label className="flex items-center gap-3 cursor-pointer group">
          <div className="relative">
            <input type="checkbox" checked={form.reviewFlag} onChange={(e) => handleField("reviewFlag", e.target.checked)} className="sr-only peer" />
            <div className="w-9 h-5 bg-secondary rounded-full peer-checked:bg-primary transition-colors" />
            <div className="absolute top-0.5 left-0.5 w-4 h-4 bg-background rounded-full shadow transition-transform peer-checked:translate-x-4" />
          </div>
          <span className="text-sm text-muted-foreground group-hover:text-foreground transition-colors">Flag for review</span>
        </label>
      </div>

      <div className="flex-none px-5 py-4 border-t border-border bg-card space-y-2">
        {saveError && (
          <div className="text-xs text-destructive bg-destructive/10 border border-destructive/20 rounded px-3 py-2">{saveError}</div>
        )}
        <div className="flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 px-4 py-2 text-sm font-display font-semibold uppercase tracking-wide rounded-lg bg-secondary text-muted-foreground hover:text-foreground hover:bg-secondary/80 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !dirty}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2 text-sm font-display font-semibold uppercase tracking-wide rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-all shadow-[0_0_15px_rgba(255,170,0,0.15)] disabled:opacity-40 active:scale-95"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            Save Changes
          </button>
        </div>
        <button
          onClick={() => handleDeleteSign(activeSign.id)}
          className="w-full flex items-center justify-center gap-2 px-4 py-2 text-xs font-display font-semibold uppercase tracking-wide rounded-lg text-destructive border border-destructive/20 hover:bg-destructive/10 transition-colors"
        >
          <Trash2 className="w-3.5 h-3.5" />
          Delete This Sign Entry
        </button>
      </div>
    </div>
  );
}

// ── PageViewer: PNG image + SVG overlays + interactions for one file/page ─────

interface PageViewerProps {
  mode: "tab" | "modal";
  jobId: string;
  file: FileInfo;
  localSigns: ExtractedSign[];
  setLocalSigns: React.Dispatch<React.SetStateAction<ExtractedSign[]>>;
  activeSignId: string | null;
  onActiveSignChange: (sign: ExtractedSign | null) => void;
  onSignAdded?: (sign: ExtractedSign) => void;
  onSignUpdated?: (signId: string, xPos: number, yPos: number) => void;
  onSignDeleted?: (signId: string) => void;
  onDragCommit?: (signId: string, nx: number, ny: number) => void;
  onEditSign?: (sign: ExtractedSign) => void;
  navigablePages: number[];
  pageNumber: number;
  setPageNumber: (p: number) => void;
  onTextSearchStatusChange: (status: "idle" | "found" | "not-found") => void;
  onRegisterResetAiPlacement?: (fn: (signId: string) => void) => void;
  showAiHighlight?: boolean;
  showMarkers?: boolean;
  pagePrefix?: string;
  // Undo / Redo / Save — modal toolbar only
  canUndo?: boolean;
  canRedo?: boolean;
  onUndo?: () => void;
  onRedo?: () => void;
  onSave?: () => void;
  hasPendingChanges?: boolean;
  batchSaving?: boolean;
  pendingCount?: number;
}

function PageViewer({
  mode,
  jobId,
  file,
  localSigns,
  setLocalSigns,
  activeSignId,
  onActiveSignChange,
  onSignAdded,
  onSignUpdated,
  onSignDeleted,
  onDragCommit,
  onEditSign,
  navigablePages,
  pageNumber,
  setPageNumber,
  onTextSearchStatusChange,
  onRegisterResetAiPlacement,
  showAiHighlight,
  showMarkers = true,
  pagePrefix = "Floor plan",
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onSave,
  hasPendingChanges,
  batchSaving,
  pendingCount,
}: PageViewerProps) {
  // ── Image loading ──────────────────────────────────────────────────────────
  const pageImagePaths = file.pageStats?.pageImagePaths ?? null;
  const hasPrerenderedImage = !!(pageImagePaths?.[String(pageNumber)]);

  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [imageLoading, setImageLoading] = useState(false);
  const [imageError, setImageError] = useState(false);
  const prevImageUrlRef = useRef<string | null>(null);

  useEffect(() => {
    if (prevImageUrlRef.current) {
      URL.revokeObjectURL(prevImageUrlRef.current);
      prevImageUrlRef.current = null;
    }
    setImageUrl(null);
    setImageError(false);

    if (!hasPrerenderedImage) {
      return;
    }

    setImageLoading(true);
    let cancelled = false;
    apiFetch(`/api/jobs/${jobId}/files/${file.id}/pages/${pageNumber}/image`)
      .then((res) => {
        if (!res.ok) throw new Error(`Server returned ${res.status}`);
        return res.blob();
      })
      .then((blob) => {
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        prevImageUrlRef.current = url;
        setImageUrl(url);
      })
      .catch(() => {
        if (!cancelled) setImageError(true);
      })
      .finally(() => {
        if (!cancelled) setImageLoading(false);
      });

    return () => { cancelled = true; };
  }, [jobId, file.id, pageNumber, hasPrerenderedImage]);

  useEffect(() => {
    return () => {
      if (prevImageUrlRef.current) URL.revokeObjectURL(prevImageUrlRef.current);
    };
  }, []);

  // ── Scale / fit ────────────────────────────────────────────────────────────
  const [scale, setScale] = useState(1.0);
  const [fitScale, setFitScale] = useState(1.0);
  const [nativeSize, setNativeSize] = useState<{ w: number; h: number } | null>(null);
  const pdfContainerRef = useRef<HTMLDivElement>(null);
  const pageWrapRef = useRef<HTMLDivElement>(null);
  const hasSetScaleRef = useRef(false);

  useEffect(() => {
    const el = pdfContainerRef.current;
    if (!el) return;
    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      const step = 0.15;
      setScale((s) => Math.min(3, Math.max(0.3, s + (e.deltaY < 0 ? step : -step))));
    };
    el.addEventListener("wheel", handleWheel, { passive: false });
    return () => el.removeEventListener("wheel", handleWheel);
  }, []);

  useEffect(() => {
    hasSetScaleRef.current = false;
    setNativeSize(null);
  }, [pageNumber, file.id]);

  // Measured rendered size (from ResizeObserver)
  const [measuredPageSize, setMeasuredPageSize] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    const el = pageWrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const img = el.querySelector("img");
      if (img) setMeasuredPageSize({ w: img.offsetWidth, h: img.offsetHeight });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => { setMeasuredPageSize(null); }, [pageNumber, file.id]);

  const renderedW = nativeSize ? nativeSize.w * scale : (measuredPageSize?.w ?? null);
  const renderedH = nativeSize ? nativeSize.h * scale : (measuredPageSize?.h ?? null);

  // ── Phrases ────────────────────────────────────────────────────────────────
  type ServerPhraseData = {
    pageWidth: number;
    pageHeight: number;
    phrases: PdfPhrase[];
    pageType?: string | null;
  };
  const [serverPhrases, setServerPhrases] = useState<ServerPhraseData | null>(null);
  const [phrasesFetchFailed, setPhrasesFetchFailed] = useState(false);

  useEffect(() => {
    setServerPhrases(null);
    setPhrasesFetchFailed(false);
    let cancelled = false;
    apiFetch(`/api/jobs/${jobId}/files/${file.id}/pages/${pageNumber}/words`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("non-ok"))))
      .then((data: ServerPhraseData) => { if (!cancelled) setServerPhrases(data); })
      .catch(() => { if (!cancelled) setPhrasesFetchFailed(true); });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.id, pageNumber, jobId]);

  // ── Page classification ────────────────────────────────────────────────────
  const isSignSchedulePage = file.pageStats?.signSchedulePages?.includes(pageNumber) ?? false;

  // ── Signs on current page ──────────────────────────────────────────────────
  const signsOnCurrentPage = useMemo(
    () => {
      const schedulePages = file.pageStats?.signSchedulePages ?? [];
      return localSigns.filter((s) => {
        if (s.jobFileId !== file.id) return false;
        if ((s.pageNumber ?? 1) === pageNumber) return true;
        // Include unplaced signs whose pageNumber is a sign-schedule page — they haven't been
        // placed on a floor plan page yet and should participate in text-matching on this page.
        if (s.xPos == null && s.pageNumber != null && schedulePages.includes(s.pageNumber)) return true;
        return false;
      });
    },
    [localSigns, file.id, file.pageStats, pageNumber]
  );

  // ── Duplicate-room occurrence index ───────────────────────────────────────
  // For rooms with duplicate names (no room number), signs share the same
  // signIdentifier + location. Cluster by xPos/yPos to identify distinct
  // physical rooms, then assign a 1-based occurrence index so canvas markers
  // can show "Room Name (2/5)" disambiguating labels.
  const signOccurrenceMap = useMemo(() => {
    const map = new Map<string, { index: number; total: number }>();

    const groups = new Map<string, typeof signsOnCurrentPage>();
    for (const s of signsOnCurrentPage) {
      const key = `${(s.signIdentifier ?? "").toLowerCase().trim()}||${(s.location ?? "").toLowerCase().trim()}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(s);
    }

    for (const [, groupSigns] of groups) {
      const posGroups = new Map<string, string[]>();
      for (const s of groupSigns) {
        const posKey =
          s.xPos != null && s.yPos != null
            ? `${s.xPos.toFixed(4)},${s.yPos.toFixed(4)}`
            : "unplaced";
        if (!posGroups.has(posKey)) posGroups.set(posKey, []);
        posGroups.get(posKey)!.push(s.id);
      }

      const total = posGroups.size;
      if (total <= 1) continue;

      const orderedPosGroups = [...posGroups.entries()].sort((a, b) => {
        const aIdx = signsOnCurrentPage.findIndex((s) => a[1].includes(s.id));
        const bIdx = signsOnCurrentPage.findIndex((s) => b[1].includes(s.id));
        return aIdx - bIdx;
      });

      orderedPosGroups.forEach(([, signIds], idx) => {
        for (const signId of signIds) {
          map.set(signId, { index: idx + 1, total });
        }
      });
    }

    return map;
  }, [signsOnCurrentPage]);

  // ── Modes ──────────────────────────────────────────────────────────────────
  const [showOverlay, setShowOverlay] = useState(true);
  const [debugMode, setDebugMode] = useState(false);
  const [drawMode, setDrawMode] = useState(false);
  const [addMode, setAddMode] = useState(false);
  const [pendingNewMarker, setPendingNewMarker] = useState<{ nx: number; ny: number } | null>(null);
  const [hoveredMarkerId, setHoveredMarkerId] = useState<string | null>(null);
  const [addingSign, setAddingSign] = useState(false);

  // ── Drag-to-reposition state ───────────────────────────────────────────────
  const DRAG_THRESHOLD = 0.008; // normalized units — about 5px at typical zoom
  type DragState = {
    signId: string;
    startX: number; startY: number; // normalized start (pointer down)
    currentX: number; currentY: number; // normalized current (during drag)
    isDragging: boolean; // true once past threshold
  };
  const [dragState, setDragState] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);

  // ── Pan-by-drag state ──────────────────────────────────────────────────────
  type PanState = {
    startScrollLeft: number;
    startScrollTop: number;
    startClientX: number;
    startClientY: number;
    moved: boolean;
  };
  const panRef = useRef<PanState | null>(null);
  const [isPanning, setIsPanning] = useState(false);
  const suppressNextClickRef = useRef(false);

  // ── Visual-locate state ────────────────────────────────────────────────────
  const [visualCandidates, setVisualCandidates] = useState<Map<string, VisualCandidate[]>>(new Map());
  const [visualLocateFailed, setVisualLocateFailed] = useState<Set<string>>(new Set());
  const [visualLocating, setVisualLocating] = useState(false);
  const visualLocateQueriedRef = useRef<Set<string>>(new Set());
  const visualLocateSubmittedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    setVisualCandidates(new Map());
    setVisualLocateFailed(new Set());
    visualLocateSubmittedRef.current = new Set();
  }, [file.id, pageNumber]);

  // ── Write-back ref (tab mode: auto-persist client-resolved coords) ─────────
  const writtenBackRef = useRef<Set<string>>(new Set());

  // ── Text markers ───────────────────────────────────────────────────────────
  const [textMarkers, setTextMarkers] = useState<TextMarker[]>([]);
  const [textSearchStatus, setTextSearchStatus] = useState<"idle" | "found" | "not-found">("idle");

  useEffect(() => {
    onTextSearchStatusChange(textSearchStatus);
  }, [textSearchStatus, onTextSearchStatusChange]);

  const signPlacementKey = signsOnCurrentPage
    .map((s) => `${s.id}:${s.xPos?.toFixed(4) ?? ""}:${s.yPos?.toFixed(4) ?? ""}:${s.placementSource ?? ""}`)
    .join("|");

  useEffect(() => {
    if (!serverPhrases && !phrasesFetchFailed) return;
    if (serverPhrases) setNativeSize({ w: serverPhrases.pageWidth, h: serverPhrases.pageHeight });
    if (signsOnCurrentPage.length === 0) {
      setTextMarkers([]);
      setTextSearchStatus("idle");
      return;
    }

    const markers: TextMarker[] = [];
    let currentSignFound = false;
    const phrases = serverPhrases?.phrases ?? [];

    const buildLabel = (s: (typeof signsOnCurrentPage)[number]): string => {
      const base = s.signIdentifier ?? s.signType?.slice(0, 6) ?? "SIGN";
      const occ = signOccurrenceMap.get(s.id);
      return occ ? `${base} (${occ.index}/${occ.total})` : base;
    };

    for (const s of signsOnCurrentPage) {
      const isCurrent = s.id === activeSignId;
      const color = isCurrent ? "#22c55e" : (s.manuallyAdded ? "#a855f7" : "#eab308");

      if (s.xPos != null && s.yPos != null && (s.manuallyAdded || s.placementSource != null || s.dataSource === "pdf")) {
        markers.push({
          x: s.xPos, y: s.yPos,
          signId: s.id, color,
          label: buildLabel(s),
          isCurrent, placementScore: 1.0,
        });
        if (isCurrent) currentSignFound = true;
        continue;
      }
      if (visualLocateFailed.has(s.id)) continue;
      if (visualCandidates.has(s.id)) continue;
      if (visualLocateSubmittedRef.current.has(s.id)) continue;

      const loc = findSignLocationFromPhrases(phrases, s);
      if (loc) {
        const phraseCenter = { x: loc.x, y: loc.y };
        const { dx, dy } = computeMarkerOffset(phraseCenter);
        const mx = Math.min(0.98, Math.max(0.02, loc.x + dx));
        const my = Math.min(0.98, Math.max(0.02, loc.y + dy));
        markers.push({
          x: mx, y: my,
          phraseCenter,
          signId: s.id, color,
          label: buildLabel(s),
          isCurrent, placementScore: loc.score,
          matchedPhrase: loc.phrase,
          rejectedCandidates: loc.rejectedCandidates,
        });
        if (isCurrent) currentSignFound = true;
      } else {
        markers.push({
          x: 0.5, y: 0.5,
          signId: s.id, color,
          label: buildLabel(s),
          isCurrent, placementScore: 0, isGhost: true,
        });
        if (isCurrent) currentSignFound = true;
      }
    }

    // Collision nudge
    const COLLISION_THRESHOLD = 0.012;
    for (let i = 0; i < markers.length; i++) {
      const mi = markers[i]!;
      if (mi.placementScore === 1.0 || mi.isGhost) continue;
      for (let j = 0; j < i; j++) {
        const mj = markers[j]!;
        if (mj.isGhost) continue;
        const dist = Math.hypot(mi.x - mj.x, mi.y - mj.y);
        if (dist < COLLISION_THRESHOLD) {
          if (dist > 0.001) {
            const nx = (mi.x - mj.x) / dist;
            const ny = (mi.y - mj.y) / dist;
            const nudge = Math.min(COLLISION_THRESHOLD, COLLISION_THRESHOLD - dist);
            mi.x = Math.min(0.98, Math.max(0.02, mi.x + nx * nudge));
            mi.y = Math.min(0.98, Math.max(0.02, mi.y + ny * nudge));
          }
          break;
        }
      }
    }

    setTextMarkers(markers);
    if (signsOnCurrentPage.some((s) => s.id === activeSignId)) {
      setTextSearchStatus(currentSignFound ? "found" : "not-found");
    } else {
      setTextSearchStatus("idle");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverPhrases, phrasesFetchFailed, pageNumber, signPlacementKey, activeSignId, visualLocateFailed, visualCandidates, signOccurrenceMap]);

  // Write-back for tab mode
  useEffect(() => {
    if (mode !== "tab") return;
    for (const m of textMarkers) {
      if (m.isGhost || m.placementScore < 0.5) continue;
      const sign = localSigns.find((s) => s.id === m.signId);
      if (!sign || sign.xPos != null || sign.yPos != null) continue;
      if (writtenBackRef.current.has(m.signId)) continue;
      writtenBackRef.current.add(m.signId);
      apiFetch(`/api/extracted-signs/${m.signId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ xPos: m.x, yPos: m.y, pageNumber, placementSource: "word_match" }),
      })
        .then((res) => {
          if (!res.ok) throw new Error(`PATCH failed: ${res.status}`);
          setLocalSigns((prev) => prev.map((s) =>
            s.id === m.signId ? { ...s, xPos: m.x, yPos: m.y, pageNumber } : s
          ));
          onSignUpdated?.(m.signId, m.x, m.y);
        })
        .catch(() => { writtenBackRef.current.delete(m.signId); });
    }
  }, [textMarkers, mode, localSigns, onSignUpdated, pageNumber, setLocalSigns]);

  // ── Auto visual-locate ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!serverPhrases) return;
    const pageKey = `${file.id}:${pageNumber}`;
    if (visualLocateQueriedRef.current.has(pageKey)) return;

    const markerMap = new Map(textMarkers.map((m) => [m.signId, { x: m.x, y: m.y }]));
    const targetSigns = signsOnCurrentPage.filter((s) => {
      if (s.placementSource != null || (s.xPos != null && s.yPos != null)) return false;
      if (!isResidentialUnitLocation(s.location ?? "")) return false;
      const { typeToken, numberToken } = parseLocationParts(s.location ?? "");
      if (!typeToken || !numberToken) return false;
      const clusterResult = findPairedClusterMatch(serverPhrases.phrases, typeToken, numberToken, s.id);
      // Exclude null (no match) and "ambiguous" — only confirmed unambiguous matches pass
      return clusterResult !== null && clusterResult !== "ambiguous";
    }).slice(0, 20);

    if (targetSigns.length === 0) return;

    visualLocateQueriedRef.current.add(pageKey);
    targetSigns.forEach((s) => visualLocateSubmittedRef.current.add(s.id));
    setVisualLocating(true);

    apiFetch(`/api/jobs/${jobId}/visual-locate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fileId: file.id,
        pageNumber,
        signs: targetSigns.map((s) => {
          const marker = markerMap.get(s.id);
          const { typeToken, numberToken } = parseLocationParts(s.location ?? "");
          return {
            signId: s.id, signType: s.signType, location: s.location,
            signIdentifier: s.signIdentifier, roomNumber: numberToken, typeToken,
            anchorX: marker?.x ?? null, anchorY: marker?.y ?? null,
          };
        }),
      }),
    })
      .then((r) => r.ok ? r.json() : Promise.reject(new Error("non-ok")))
      .then((data: { results: { signId: string; candidates: VisualCandidate[] }[] }) => {
        const toAutoApply: Array<{ signId: string; candidate: VisualCandidate }> = [];
        const newCandidates = new Map<string, VisualCandidate[]>();
        const newFailed = new Set<string>();

        for (const r of data.results) {
          if (r.candidates.length === 0) newFailed.add(r.signId);
          else if (r.candidates.length === 1) toAutoApply.push({ signId: r.signId, candidate: r.candidates[0]! });
          else newCandidates.set(r.signId, r.candidates.slice(0, 3));
        }

        setVisualLocateFailed((prev) => { const next = new Set(prev); newFailed.forEach((id) => next.add(id)); return next; });
        setVisualCandidates((prev) => { const next = new Map(prev); newCandidates.forEach((v, k) => next.set(k, v)); return next; });

        for (const { signId, candidate } of toAutoApply) {
          apiFetch(`/api/extracted-signs/${signId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ xPos: candidate.x, yPos: candidate.y, placementSource: "gemini_vision" }),
          })
            .then((r) => r.ok ? r.json() : Promise.reject(new Error("non-ok")))
            .then((d: { sign: ExtractedSign }) => {
              setLocalSigns((prev) => prev.map((s) => s.id === signId ? d.sign : s));
              if (signId === activeSignId) onActiveSignChange(d.sign);
            })
            .catch((err) => console.error(`[visual-locate] auto-apply failed for ${signId}:`, err));
        }
      })
      .catch((err) => {
        console.error("[visual-locate] request failed:", err);
        visualLocateQueriedRef.current.delete(pageKey);
        targetSigns.forEach((s) => visualLocateSubmittedRef.current.delete(s.id));
      })
      .finally(() => setVisualLocating(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverPhrases, textMarkers, file.id, pageNumber]);

  // ── Confirm visual placement ───────────────────────────────────────────────
  const confirmVisualPlacement = async (signId: string, candidate: VisualCandidate) => {
    try {
      const res = await apiFetch(`/api/extracted-signs/${signId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ xPos: candidate.x, yPos: candidate.y, placementSource: "user_confirmed" }),
      });
      if (!res.ok) throw new Error("Failed");
      const data = await res.json() as { sign: ExtractedSign };
      setLocalSigns((prev) => prev.map((s) => s.id === signId ? data.sign : s));
      setVisualCandidates((prev) => { const n = new Map(prev); n.delete(signId); return n; });
      if (signId === activeSignId) onActiveSignChange(data.sign);
    } catch (err) { console.error("[visual-locate] confirm failed:", err); }
  };

  // ── Reset AI placement ─────────────────────────────────────────────────────
  const resetAiPlacement = async (signId: string) => {
    try {
      const r = await apiFetch(`/api/extracted-signs/${signId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ xPos: null, yPos: null, placementSource: null }),
      });
      if (!r.ok) return;
      const d = await r.json() as { sign: ExtractedSign };
      setLocalSigns((prev) => prev.map((s) => s.id === signId ? d.sign : s));
      if (signId === activeSignId) onActiveSignChange(d.sign);
      visualLocateQueriedRef.current.delete(`${file.id}:${pageNumber}`);
      visualLocateSubmittedRef.current.delete(signId);
      setVisualLocateFailed((prev) => { const n = new Set(prev); n.delete(signId); return n; });
      setVisualCandidates((prev) => { const n = new Map(prev); n.delete(signId); return n; });
    } catch (err) { console.error("[visual-locate] reset failed:", err); }
  };

  // Register resetAiPlacement with the outer component so the modal top-bar can call
  // the same function (with full dedupe-ref cleanup) instead of a separate inline handler.
  useEffect(() => {
    onRegisterResetAiPlacement?.(resetAiPlacement);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onRegisterResetAiPlacement]);

  // ── Delete sign ────────────────────────────────────────────────────────────
  const handleDeleteSign = async (signId: string) => {
    try {
      const res = await apiFetch(`/api/extracted-signs/${signId}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete sign");
      setLocalSigns((prev) => prev.filter((s) => s.id !== signId));
      setHoveredMarkerId(null);
      if (signId === activeSignId) {
        const next = localSigns.find((s) => s.id !== signId);
        onActiveSignChange(next ?? null);
      }
      onSignDeleted?.(signId);
    } catch (err) { console.error("Delete sign failed:", err); }
  };

  // ── Page navigation ────────────────────────────────────────────────────────
  const pageIdx = navigablePages.indexOf(pageNumber);
  // Derive total page count robustly: file.pageCount → image-paths count → null
  const totalPages = mode === "modal"
    ? (file.pageCount ?? (pageImagePaths ? Object.keys(pageImagePaths).length : null) ?? null)
    : navigablePages.length;

  const canPrevPage = mode === "modal" ? pageNumber > 1 : pageIdx > 0;
  const canNextPage = mode === "modal"
    ? (totalPages != null ? pageNumber < totalPages : pageNumber < (pageImagePaths ? Object.keys(pageImagePaths).length : 1))
    : pageIdx >= 0 && pageIdx < navigablePages.length - 1;

  const goPrevPage = () => {
    if (mode === "modal") setPageNumber(Math.max(1, pageNumber - 1));
    else if (pageIdx > 0) setPageNumber(navigablePages[pageIdx - 1]!);
  };
  const goNextPage = () => {
    if (mode === "modal") {
      const max = totalPages ?? (pageImagePaths ? Object.keys(pageImagePaths).length : 1);
      setPageNumber(Math.min(max, pageNumber + 1));
    } else if (pageIdx >= 0 && pageIdx < navigablePages.length - 1) {
      setPageNumber(navigablePages[pageIdx + 1]!);
    }
  };

  const pageLabel = file.pageStats?.pageLabels?.[pageNumber - 1] ?? null;
  const imageReady = !!imageUrl;
  // pageReady: true when either the PNG or the PDF fallback is available for interaction
  const pageReady = imageReady;
  const realMarkers = textMarkers.filter((m) => !m.isGhost);
  const ghostCount = textMarkers.filter((m) => m.isGhost).length;

  // Active sign for display purposes
  const activeSign = activeSignId ? localSigns.find((s) => s.id === activeSignId) ?? null : null;

  const handleSelectSign = (s: ExtractedSign) => {
    onActiveSignChange(s);
  };

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-secondary/30">
      {/* Toolbar */}
      <div className="flex-none flex items-center gap-2 px-4 py-2 bg-card border-b border-border overflow-x-auto min-w-0">
        {/* Page nav */}
        <button aria-label="Previous page" disabled={!canPrevPage} onClick={goPrevPage} className="p-1.5 rounded hover:bg-secondary disabled:opacity-30 transition-colors">
          <ChevronLeft className="w-4 h-4" />
        </button>
        <span className="text-xs font-mono text-muted-foreground min-w-[90px] text-center">
          {mode === "tab" && pageLabel ? (
            <>
              <span className="text-foreground/80 font-medium">{pageLabel}</span>{" "}
              {pageIdx >= 0 && <span className="text-muted-foreground/50">({pageIdx + 1}/{navigablePages.length})</span>}
            </>
          ) : mode === "tab" ? (
            <>{pagePrefix} {pageIdx >= 0 ? pageIdx + 1 : "–"} / {navigablePages.length} <span className="text-muted-foreground/50">(pg {pageNumber})</span></>
          ) : (
            totalPages ? `${pageNumber} / ${totalPages}` : `Page ${pageNumber}`
          )}
        </span>
        <button aria-label="Next page" disabled={!canNextPage} onClick={goNextPage} className="p-1.5 rounded hover:bg-secondary disabled:opacity-30 transition-colors">
          <ChevronRight className="w-4 h-4" />
        </button>
        <div className="w-px h-4 bg-border mx-0.5" />

        {/* Zoom */}
        <button onClick={() => setScale((s) => Math.max(0.3, s - 0.15))} disabled={scale <= 0.3} className="p-1.5 rounded hover:bg-secondary disabled:opacity-30 transition-colors" title="Zoom out">
          <ZoomOut className="w-3.5 h-3.5" />
        </button>
        <span className="text-[11px] font-mono text-muted-foreground w-10 text-center">{Math.round(scale * 100)}%</span>
        <button
          onClick={() => {
            if (nativeSize && pdfContainerRef.current) {
              const cw = pdfContainerRef.current.clientWidth - 32;
              const ch = pdfContainerRef.current.clientHeight - 32;
              const fitW = cw / nativeSize.w;
              const fitH = ch > 0 ? ch / nativeSize.h : Infinity;
              const fit = Math.min(1.5, Math.max(0.3, Math.min(fitW, fitH)));
              setFitScale(fit);
              setScale(fit);
            } else {
              setScale(fitScale);
            }
          }}
          title="Fit to page"
          className="text-[10px] font-display font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground hover:border-foreground/40 transition-colors"
        >
          Fit
        </button>
        <button onClick={() => setScale((s) => Math.min(3, s + 0.15))} disabled={scale >= 3} className="p-1.5 rounded hover:bg-secondary disabled:opacity-30 transition-colors" title="Zoom in">
          <ZoomIn className="w-3.5 h-3.5" />
        </button>
        <div className="w-px h-4 bg-border mx-0.5" />

        {/* Go to page — modal only */}
        {mode === "modal" && activeSign?.pageNumber && (
          <button onClick={() => setPageNumber(activeSign.pageNumber!)} className="text-xs font-mono px-2 py-0.5 rounded transition-colors" style={{ backgroundColor: "#22c55e22", color: "#22c55e", border: "1px solid #22c55e55" }} title="Jump to sign page">
            ● Go to pg {activeSign.pageNumber}
          </button>
        )}

        {/* Visual-locate status — modal only */}
        {mode === "modal" && visualLocating && (
          <span className="flex items-center gap-1 text-[10px] font-display font-semibold uppercase tracking-wide px-2 py-1 rounded" style={{ color: "#06b6d4", background: "#06b6d410", border: "1px solid #06b6d455" }}>
            <Loader2 className="w-3 h-3 animate-spin" />
            AI locating…
          </span>
        )}
        {mode === "modal" && !visualLocating && visualCandidates.size > 0 && (
          <span className="flex items-center gap-1 text-[10px] font-display font-semibold uppercase tracking-wide px-2 py-1 rounded" style={{ color: "#06b6d4", background: "#06b6d410", border: "1px solid #06b6d455" }}>
            <Sparkles className="w-3 h-3" />
            AI found {visualCandidates.size > 1 ? `${visualCandidates.size} signs` : "a sign"} — pick a numbered dot to confirm
          </span>
        )}

        <div className="ml-auto flex items-center gap-2">
          {/* Debug — modal only */}
          {mode === "modal" && serverPhrases && (
            <button
              onClick={() => setDebugMode((v) => !v)}
              className="flex items-center gap-1 text-[10px] font-display font-semibold uppercase tracking-wide px-2 py-1 rounded transition-colors border"
              style={debugMode ? { background: "#f59e0b20", color: "#f59e0b", borderColor: "#f59e0b55" } : { background: "transparent", color: "var(--muted-foreground)", borderColor: "var(--border)" }}
              title="Toggle debug overlay"
            >
              ⬡ debug
            </button>
          )}

          {/* Undo / Redo / Save — modal only, grouped with debug */}
          {mode === "modal" && (onUndo || onRedo || onSave) && (
            <>
              <div className="w-px h-4 bg-border" />
              <button
                disabled={!canUndo}
                onClick={onUndo}
                title="Undo (Ctrl+Z)"
                className="p-1.5 rounded hover:bg-secondary disabled:opacity-25 transition-colors text-muted-foreground hover:text-foreground"
              >
                <Undo2 className="w-4 h-4" />
              </button>
              <button
                disabled={!canRedo}
                onClick={onRedo}
                title="Redo (Ctrl+Y)"
                className="p-1.5 rounded hover:bg-secondary disabled:opacity-25 transition-colors text-muted-foreground hover:text-foreground"
              >
                <Redo2 className="w-4 h-4" />
              </button>
              <button
                onClick={onSave}
                disabled={!hasPendingChanges || batchSaving}
                title={hasPendingChanges ? `Save ${pendingCount} pending change${pendingCount !== 1 ? "s" : ""}` : "No unsaved changes"}
                className={`relative flex items-center gap-1.5 px-3 py-1.5 text-xs font-display font-bold uppercase tracking-wide rounded-lg transition-all ${
                  hasPendingChanges
                    ? "bg-primary text-primary-foreground hover:bg-primary/90 shadow-[0_0_12px_rgba(255,170,0,0.2)]"
                    : "bg-secondary text-muted-foreground opacity-40 cursor-not-allowed"
                }`}
              >
                {batchSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                Save
                {hasPendingChanges && (pendingCount ?? 0) > 0 && (
                  <span className="absolute -top-1.5 -right-1.5 flex items-center justify-center w-4 h-4 rounded-full bg-destructive text-[9px] font-bold text-destructive-foreground leading-none">
                    {(pendingCount ?? 0) > 9 ? "9+" : pendingCount}
                  </span>
                )}
              </button>
            </>
          )}

          {/* Show/hide markers — both modes */}
          {showMarkers && textMarkers.length > 0 && (
            <>
              <button
                onClick={() => setShowOverlay((v) => !v)}
                className="flex items-center gap-1.5 text-[10px] font-display font-semibold uppercase tracking-wide px-2 py-1 rounded transition-colors border"
                style={showOverlay ? { background: "#22c55e20", color: "#22c55e", borderColor: "#22c55e55" } : { background: "transparent", color: "var(--muted-foreground)", borderColor: "var(--border)" }}
                title={showOverlay ? "Hide markers" : "Show markers"}
              >
                {showOverlay ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
                {realMarkers.length} marker{realMarkers.length !== 1 ? "s" : ""}
              </button>
              {ghostCount > 0 && (
                <span className="flex items-center gap-1 text-[10px] font-display font-semibold uppercase tracking-wide px-2 py-1 rounded border" style={{ background: "#ef444415", color: "#ef4444", borderColor: "#ef444440" }} title="Signs that could not be matched">
                  Unlocated: {ghostCount}
                </span>
              )}
            </>
          )}

          {/* Add Marker — modal only */}
          {mode === "modal" && pageReady && (
            <button
              onClick={() => { setAddMode((v) => { const next = !v; if (next) setDrawMode(false); return next; }); setPendingNewMarker(null); }}
              className="flex items-center gap-1.5 text-[10px] font-display font-semibold uppercase tracking-wide px-2 py-1 rounded transition-colors border"
              style={addMode ? { background: "#22c55e28", color: "#22c55e", borderColor: "#22c55e88", boxShadow: "0 0 0 1px #22c55e44" } : { background: "#22c55e14", color: "#22c55e", borderColor: "#22c55e55" }}
              title={addMode ? "Cancel" : "Add a new sign marker"}
            >
              <Plus className="w-3 h-3" />
              {addMode ? "Click to place…" : "Add Marker"}
            </button>
          )}

          {/* Edit Markers — modal only */}
          {mode === "modal" && pageReady && (
            <button
              onClick={() => { setDrawMode((v) => { const next = !v; if (next) setAddMode(false); return next; }); setPendingNewMarker(null); }}
              className="flex items-center gap-1.5 text-[10px] font-display font-semibold uppercase tracking-wide px-2 py-1 rounded transition-colors border"
              style={drawMode ? { background: "#a855f720", color: "#a855f7", borderColor: "#a855f755" } : { background: "transparent", color: "var(--muted-foreground)", borderColor: "var(--border)" }}
              title={drawMode ? "Exit edit mode" : "Edit Markers"}
            >
              {drawMode ? <PenLine className="w-3 h-3" /> : <MousePointer className="w-3 h-3" />}
              Edit Markers
            </button>
          )}
        </div>

      </div>

      {/* Signs-on-page chips strip — modal only */}
      {mode === "modal" && signsOnCurrentPage.length > 0 && (
        <div className="flex-none flex items-center gap-1.5 px-4 py-1.5 bg-card border-b border-border overflow-x-auto">
          {signsOnCurrentPage.map((s) => {
            const isActive = s.id === activeSignId;
            const isLocated = textMarkers.some((m) => m.signId === s.id && !m.isGhost);
            return (
              <button
                key={s.id}
                title={`${s.signType ?? "Sign"} — ${s.location ?? ""}\nClick to edit`}
                onClick={() => handleSelectSign(s)}
                className="flex-shrink-0 flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded whitespace-nowrap transition-all"
                style={{
                  backgroundColor: isActive ? "#22c55e" : "#22c55e18", color: isActive ? "#fff" : "#22c55e",
                  border: `1px solid ${isActive ? "#22c55e" : "#22c55e55"}`, fontWeight: isActive ? 700 : 500,
                  boxShadow: isActive ? "0 0 8px #22c55e55" : "none", cursor: "pointer",
                }}
              >
                {isActive && <span className="inline-block w-1.5 h-1.5 rounded-full bg-white flex-shrink-0" />}
                {s.signIdentifier ?? s.signType?.slice(0, 8) ?? "SIGN"}
                {!isLocated && (
                  <span style={{ fontSize: 8, fontWeight: 700, letterSpacing: "0.05em", background: "#ef444420", color: "#ef4444", border: "1px solid #ef444455", borderRadius: 3, padding: "0 3px" }}>
                    UNLOCATED
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* Canvas */}
      <div ref={pdfContainerRef} className="flex-1 overflow-auto p-4">
        <div style={{ minWidth: "max-content", display: "flex", justifyContent: "center", alignItems: "flex-start" }}>
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
          {!hasPrerenderedImage && !imageLoading && !imageError && (
            <div className="flex flex-col items-center justify-center h-64 text-muted-foreground gap-2">
              <p className="text-sm">No preview available for this page</p>
            </div>
          )}

          {/* Unified page container: renders PNG + all shared overlays */}
          {imageUrl && (
            <div ref={pageWrapRef} className="relative shadow-2xl inline-block">

              {/* PNG path */}
              <img
                key={`${file.id}-${pageNumber}-img`}
                src={imageUrl}
                alt={`Page ${pageNumber}`}
                style={{ display: "block", width: nativeSize ? `${nativeSize.w * scale}px` : undefined, height: nativeSize ? `${nativeSize.h * scale}px` : "auto", maxWidth: "none" }}
                onLoad={(e) => {
                  const img = e.currentTarget;
                  const nw = img.naturalWidth;
                  const nh = img.naturalHeight;
                  if (nw > 0 && nh > 0) {
                    setNativeSize({ w: nw, h: nh });
                    setMeasuredPageSize({ w: img.offsetWidth, h: img.offsetHeight });
                    if (!hasSetScaleRef.current && pdfContainerRef.current) {
                      const cw = pdfContainerRef.current.clientWidth - 32;
                      const ch = pdfContainerRef.current.clientHeight - 32;
                      if (cw > 0) {
                        hasSetScaleRef.current = true;
                        const fitW = cw / nw;
                        const fitH = ch > 0 ? ch / nh : Infinity;
                        const fit = Math.min(1.5, Math.max(0.3, Math.min(fitW, fitH)));
                        setFitScale(fit);
                        setScale(fit);
                      }
                    }
                  }
                }}
              />

              {/* ── Shared overlays (identical for both PNG and PDF paths) ── */}

              {/* Sign schedule notice — modal only */}
              {mode === "modal" && isSignSchedulePage && textMarkers.filter((m) => !m.isGhost).length === 0 && (
                <div style={{ position: "absolute", top: 8, left: "50%", transform: "translateX(-50%)", zIndex: 10, pointerEvents: "none" }}
                  className="px-3 py-1.5 rounded-full bg-accent/90 text-background text-[10px] font-bold uppercase tracking-wider shadow-lg whitespace-nowrap">
                  Sign Schedule Page — use Edit Markers to place manually
                </div>
              )}

              {/* SVG marker overlay */}
              {showMarkers && showOverlay && renderedW && renderedH && (textMarkers.length > 0 || (debugMode && serverPhrases)) && (
                <svg style={{ position: "absolute", top: 0, left: 0, width: renderedW, height: renderedH, overflow: "visible", pointerEvents: "none", zIndex: 5 }} viewBox={`0 0 ${renderedW} ${renderedH}`}>

                  {debugMode && serverPhrases && serverPhrases.phrases.map((p, i) => {
                    const px0 = p.x0 * renderedW; const py0 = p.y0 * renderedH;
                    const pw = (p.x1 - p.x0) * renderedW; const ph = (p.y1 - p.y0) * renderedH;
                    const pcx = (p.x0 + p.x1) / 2 * renderedW; const pcy = (p.y0 + p.y1) / 2 * renderedH;
                    const matchedMarker = textMarkers.find((m) => m.matchedPhrase === p);
                    const isMatched = !!matchedMarker;
                    const mfx = matchedMarker ? matchedMarker.x * renderedW : null;
                    const mfy = matchedMarker ? matchedMarker.y * renderedH : null;
                    return (
                      <g key={`dbg-${i}`}>
                        <rect x={px0} y={py0} width={pw} height={Math.max(ph, 2)} fill={isMatched ? "#22c55e18" : "#3b82f608"} stroke={isMatched ? "#22c55e" : "#3b82f6"} strokeWidth={isMatched ? 1.5 : 0.5} opacity={0.8} />
                        {isMatched ? (
                          <>
                            {mfx != null && mfy != null && <circle cx={mfx} cy={mfy} r={4} fill="#ef4444" opacity={0.85} />}
                            <circle cx={pcx} cy={pcy} r={3} fill="#3b82f6" opacity={0.9} />
                            <text x={pcx} y={py0 - 2} textAnchor="middle" fill="#22c55e" fontSize={7} fontFamily="monospace" style={{ userSelect: "none" }}>{p.text.slice(0, 16)}-LOCK</text>
                          </>
                        ) : <circle cx={pcx} cy={pcy} r={1.5} fill="#3b82f6" opacity={0.4} />}
                      </g>
                    );
                  })}

                  {debugMode && textMarkers.flatMap((m) =>
                    (m.rejectedCandidates ?? []).map((p, ri) => {
                      const px0 = p.x0 * renderedW; const py0 = p.y0 * renderedH;
                      const pw = (p.x1 - p.x0) * renderedW; const ph = (p.y1 - p.y0) * renderedH;
                      const pcx = (p.x0 + p.x1) / 2 * renderedW;
                      return (
                        <g key={`rej-${m.signId}-${ri}`}>
                          <rect x={px0} y={py0} width={pw} height={Math.max(ph, 2)} fill="#eab30812" stroke="#eab308" strokeWidth={1} strokeDasharray="3 2" opacity={0.9} />
                          <text x={pcx} y={py0 - 2} textAnchor="middle" fill="#eab308" fontSize={6} fontFamily="monospace" style={{ userSelect: "none" }}>{p.text.slice(0, 14)}-REJ</text>
                        </g>
                      );
                    })
                  )}

                  <g>
                    {textMarkers.map((m) => {
                      const isDraggingThis = dragState?.isDragging && dragState.signId === m.signId;
                      const cx = isDraggingThis ? dragState!.currentX * renderedW : m.x * renderedW;
                      const cy = isDraggingThis ? dragState!.currentY * renderedH : m.y * renderedH;
                      const isHovered = m.signId === hoveredMarkerId;
                      const isGhost = m.isGhost === true;
                      const dotR = m.isCurrent ? 7 : 5;
                      const sign = signsOnCurrentPage.find((s) => s.id === m.signId);
                      const hasBbox = sign && sign.aiBboxX != null && sign.aiBboxY != null && sign.aiBboxW != null && sign.aiBboxH != null;
                      const isAiSign = showAiHighlight && ((sign as Record<string, unknown> | undefined)?.dataSource === "ai" || (sign as Record<string, unknown> | undefined)?.aiBbox === true);
                      return (
                        <g key={m.signId} opacity={isGhost ? 0.15 : 1}>
                          {hasBbox && (
                            <rect
                              x={sign.aiBboxX! * renderedW}
                              y={sign.aiBboxY! * renderedH}
                              width={sign.aiBboxW! * renderedW}
                              height={sign.aiBboxH! * renderedH}
                              fill={isAiSign ? "#8b5cf6" : m.color}
                              fillOpacity={0.12}
                              stroke={isAiSign ? "#8b5cf6" : m.color}
                              strokeWidth={isAiSign ? 1.5 : 1}
                              strokeOpacity={0.7}
                              rx={2}
                            />
                          )}
                          {isAiSign && !isGhost && (
                            <circle cx={cx} cy={cy} r={dotR + 7} fill="none" stroke="#8b5cf6" strokeWidth={2} strokeDasharray="3 2" opacity={0.9} />
                          )}
                          {m.isCurrent && !isGhost && <circle cx={cx} cy={cy} r={dotR + 5} fill="none" stroke={isAiSign ? "#8b5cf6" : m.color} strokeWidth={1.5} opacity={0.8} />}
                          {isHovered && !m.isCurrent && !isGhost && <circle cx={cx} cy={cy} r={dotR + 4} fill="none" stroke={m.color} strokeWidth={1} opacity={0.5} />}
                          {isDraggingThis && <circle cx={cx} cy={cy} r={dotR + 10} fill="none" stroke={m.color} strokeWidth={2} strokeDasharray="4 3" opacity={0.7} />}
                          <circle cx={cx} cy={cy} r={dotR} fill={isAiSign ? "#8b5cf6" : m.color} />
                          {m.isCurrent && !isGhost && (
                            <text x={cx} y={cy - dotR - 7} textAnchor="middle" fill={isAiSign ? "#8b5cf6" : m.color} fontSize={9} fontWeight="bold" fontFamily="monospace" style={{ userSelect: "none" }}>
                              {debugMode && m.phraseCenter ? `${m.label}-LOCK` : m.label}
                            </text>
                          )}
                        </g>
                      );
                    })}
                  </g>
                </svg>
              )}

              {/* Ghost pin — modal only */}
              {mode === "modal" && pendingNewMarker && renderedW && renderedH && (
                <svg style={{ position: "absolute", top: 0, left: 0, width: renderedW, height: renderedH, overflow: "visible", pointerEvents: "none", zIndex: 7 }} viewBox={`0 0 ${renderedW} ${renderedH}`}>
                  <g>
                    <circle cx={pendingNewMarker.nx * renderedW} cy={pendingNewMarker.ny * renderedH} r={14} fill="none" stroke="#22c55e" strokeWidth={2.5} strokeDasharray="5 3" opacity={0.95} />
                    <circle cx={pendingNewMarker.nx * renderedW} cy={pendingNewMarker.ny * renderedH} r={5} fill="#22c55e" opacity={0.9} />
                  </g>
                </svg>
              )}

              {/* Hover tooltip: sign type + identifier */}
              {showMarkers && hoveredMarkerId && renderedW && renderedH && !drawMode && !addMode && (() => {
                const m = textMarkers.find((tm) => tm.signId === hoveredMarkerId);
                const s = signsOnCurrentPage.find((sg) => sg.id === hoveredMarkerId);
                if (!m || !s) return null;
                const cx = m.x * renderedW;
                const cy = m.y * renderedH;
                const tipLeft = Math.min(cx + 12, renderedW - 140);
                const tipTop = cy - 38;
                const occ = signOccurrenceMap.get(s.id);
                return (
                  <div
                    key={`tooltip-${hoveredMarkerId}`}
                    style={{ position: "absolute", left: tipLeft, top: tipTop, zIndex: 25, pointerEvents: "none", maxWidth: 160 }}
                    className="bg-card border border-border rounded-md px-2.5 py-1.5 shadow-xl text-[10px] font-mono text-foreground leading-snug"
                  >
                    <div className="font-bold truncate">{s.signIdentifier ?? s.signType ?? "Sign"}</div>
                    {s.signType && s.signIdentifier && (
                      <div className="text-muted-foreground truncate">{s.signType}</div>
                    )}
                    {s.location && (
                      <div className="text-muted-foreground/70 truncate">
                        {s.location}{occ ? ` (${occ.index} of ${occ.total})` : ""}
                      </div>
                    )}
                    {mode === "tab" && onEditSign && (
                      <div className="text-muted-foreground/50 truncate mt-0.5" style={{ fontSize: 9 }}>Double-click to edit</div>
                    )}
                  </div>
                );
              })()}

              {/* Add mode hint — modal only */}
              {mode === "modal" && addMode && !pendingNewMarker && renderedW && renderedH && (
                <div style={{ position: "absolute", bottom: 8, left: "50%", transform: "translateX(-50%)", zIndex: 10, pointerEvents: "none", background: "#22c55e20", color: "#22c55e", border: "1px solid #22c55e55" }}
                  className="px-3 py-1.5 rounded-full text-[10px] font-bold uppercase tracking-wider shadow-lg whitespace-nowrap flex items-center gap-1">
                  <Plus className="w-3 h-3" />
                  Click anywhere on the floor plan to place a new sign
                </div>
              )}

              {/* Draw mode hint — modal only */}
              {mode === "modal" && drawMode && !hoveredMarkerId && renderedW && renderedH && (
                <div style={{ position: "absolute", bottom: 8, left: "50%", transform: "translateX(-50%)", zIndex: 10, pointerEvents: "none", background: "#a855f720", color: "#a855f7", border: "1px solid #a855f755" }}
                  className="px-3 py-1.5 rounded-full text-[10px] font-bold uppercase tracking-wider shadow-lg whitespace-nowrap flex items-center gap-1">
                  <Plus className="w-3 h-3" />
                  Click to add a sign marker · hover to delete
                </div>
              )}

              {/* Delete X in draw mode — modal only */}
              {mode === "modal" && drawMode && showOverlay && renderedW && renderedH && textMarkers.map((m) => {
                if (m.signId !== hoveredMarkerId) return null;
                const cx = m.x * renderedW!; const cy = m.y * renderedH!; const r = m.isCurrent ? 18 : 12;
                return (
                  <button key={`del-${m.signId}`} title="Delete this marker" onClick={(e) => { e.stopPropagation(); handleDeleteSign(m.signId); }}
                    style={{ position: "absolute", left: cx + r - 2, top: cy - r - 2, zIndex: 20, width: 18, height: 18, borderRadius: "50%", background: "#ef4444", color: "#fff", border: "2px solid #fff", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", padding: 0, pointerEvents: "all" }}>
                    <Trash2 style={{ width: 9, height: 9 }} />
                  </button>
                );
              })}

              {/* Per-marker spinner — modal only */}
              {mode === "modal" && showOverlay && visualLocating && renderedW && renderedH && textMarkers.map((m) => {
                if (!visualLocateSubmittedRef.current.has(m.signId)) return null;
                const cx = m.x * renderedW!; const cy = m.y * renderedH!; const r = m.isCurrent ? 18 : 12;
                return (
                  <span key={`vl-spin-${m.signId}`} style={{ position: "absolute", left: cx - 8, top: cy + r + 2, zIndex: 20, width: 16, height: 16, pointerEvents: "none", color: "#06b6d4", display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <Loader2 style={{ width: 12, height: 12, animation: "spin 1s linear infinite" }} />
                  </span>
                );
              })}

              {/* AI-placed badges — modal only */}
              {mode === "modal" && showOverlay && !drawMode && renderedW && renderedH && textMarkers.map((m) => {
                const markerSign = signsOnCurrentPage.find((s) => s.id === m.signId);
                if (markerSign?.placementSource !== "gemini_vision" && markerSign?.placementSource !== "user_confirmed") return null;
                const cx = m.x * renderedW!; const cy = m.y * renderedH!; const r = m.isCurrent ? 18 : 12;
                return m.isCurrent ? (
                  <button key={`ai-badge-${m.signId}`} title="AI placed — click to reset" onClick={(e) => { e.stopPropagation(); resetAiPlacement(markerSign.id); }}
                    style={{ position: "absolute", left: cx - 28, top: cy + r + 4, zIndex: 20, height: 18, paddingInline: 6, borderRadius: 4, background: "#06b6d4", color: "#fff", border: "none", display: "flex", alignItems: "center", justifyContent: "center", gap: 3, cursor: "pointer", fontSize: 9, fontWeight: "bold", fontFamily: "monospace", letterSpacing: "0.05em", pointerEvents: "all", whiteSpace: "nowrap" }}>
                    ✦ AI · Reset
                  </button>
                ) : (
                  <button key={`ai-badge-${m.signId}`} title="AI placed — click to reset" onClick={(e) => { e.stopPropagation(); resetAiPlacement(markerSign.id); }}
                    style={{ position: "absolute", left: cx + r - 2, top: cy - r - 2, zIndex: 20, width: 14, height: 14, borderRadius: "50%", background: "#06b6d4", color: "#fff", border: "none", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", padding: 0, fontSize: 8, fontWeight: "bold", pointerEvents: "all" }}>
                    ✦
                  </button>
                );
              })}

              {/* Visual candidate dots — modal only */}
              {mode === "modal" && showOverlay && !drawMode && renderedW && renderedH && (
                Array.from(visualCandidates.entries()).flatMap(([signId, allCandidates]) =>
                  allCandidates.map((c, idx) => {
                    const cx = c.x * renderedW; const cy = c.y * renderedH;
                    return (
                      <button key={`vc-${signId}-${idx}`} title={`AI suggestion ${idx + 1}: ${c.description ?? ""}\nClick to confirm`} onClick={() => confirmVisualPlacement(signId, c)}
                        style={{ position: "absolute", left: cx - 16, top: cy - 16, width: 32, height: 32, zIndex: 15, cursor: "pointer", borderRadius: "50%", border: `2px solid #06b6d4`, background: "#06b6d422", color: "#06b6d4", fontFamily: "monospace", fontWeight: "bold", fontSize: 11, display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "all" }}>
                        {idx + 1}
                      </button>
                    );
                  })
                )
              )}

              {/* Adding sign spinner */}
              {addingSign && (
                <div style={{ position: "absolute", inset: 0, zIndex: 15, display: "flex", alignItems: "center", justifyContent: "center", background: "#00000033" }}>
                  <Loader2 className="w-8 h-8 text-white animate-spin" />
                </div>
              )}

              {/* Click-capture / drag overlay */}
              {renderedW && renderedH && (
                <div
                  style={{
                    position: "absolute", top: 0, left: 0, width: renderedW, height: renderedH, zIndex: 6,
                    cursor: dragState?.isDragging ? "grabbing"
                      : isPanning ? "grabbing"
                      : addMode ? (pendingNewMarker ? "default" : "crosshair")
                      : drawMode ? (hoveredMarkerId ? "pointer" : "crosshair")
                      : hoveredMarkerId ? "pointer"
                      : "grab",
                  }}
                  onPointerDown={(e) => {
                    if (addMode || drawMode) return;
                    const rect = e.currentTarget.getBoundingClientRect();
                    const nx = (e.clientX - rect.left) / renderedW;
                    const ny = (e.clientY - rect.top) / renderedH;
                    let best: TextMarker | null = null; let bestDist = Infinity;
                    if (showMarkers) {
                      for (const m of textMarkers) {
                        if (m.isGhost) continue;
                        const d = Math.hypot(m.x - nx, m.y - ny);
                        if (d < bestDist) { bestDist = d; best = m; }
                      }
                    }
                    if (showMarkers && mode === "modal" && best && bestDist < 0.06) {
                      e.currentTarget.setPointerCapture(e.pointerId);
                      const ds: DragState = { signId: best.signId, startX: nx, startY: ny, currentX: nx, currentY: ny, isDragging: false };
                      dragRef.current = ds;
                      setDragState(ds);
                    } else {
                      e.currentTarget.setPointerCapture(e.pointerId);
                      panRef.current = {
                        startScrollLeft: pdfContainerRef.current?.scrollLeft ?? 0,
                        startScrollTop: pdfContainerRef.current?.scrollTop ?? 0,
                        startClientX: e.clientX,
                        startClientY: e.clientY,
                        moved: false,
                      };
                      setIsPanning(true);
                    }
                  }}
                  onPointerMove={(e) => {
                    if (panRef.current) {
                      const dx = e.clientX - panRef.current.startClientX;
                      const dy = e.clientY - panRef.current.startClientY;
                      if (pdfContainerRef.current) {
                        pdfContainerRef.current.scrollLeft = panRef.current.startScrollLeft - dx;
                        pdfContainerRef.current.scrollTop = panRef.current.startScrollTop - dy;
                      }
                      if (!panRef.current.moved && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
                        panRef.current.moved = true;
                      }
                      return;
                    }
                    const rect = e.currentTarget.getBoundingClientRect();
                    const nx = (e.clientX - rect.left) / renderedW;
                    const ny = (e.clientY - rect.top) / renderedH;
                    if (dragRef.current) {
                      const moved = Math.hypot(nx - dragRef.current.startX, ny - dragRef.current.startY);
                      const updated: DragState = { ...dragRef.current, currentX: nx, currentY: ny, isDragging: moved > DRAG_THRESHOLD };
                      dragRef.current = updated;
                      setDragState({ ...updated });
                      return;
                    }
                    if (showMarkers && !addMode && !drawMode) {
                      let best: TextMarker | null = null; let bestDist = Infinity;
                      for (const m of textMarkers) { const d = Math.hypot(m.x - nx, m.y - ny); if (d < bestDist) { bestDist = d; best = m; } }
                      setHoveredMarkerId(best && bestDist < 0.06 ? best.signId : null);
                    }
                  }}
                  onPointerUp={(e) => {
                    if (panRef.current) {
                      if (panRef.current.moved) suppressNextClickRef.current = true;
                      panRef.current = null;
                      setIsPanning(false);
                      e.currentTarget.releasePointerCapture(e.pointerId);
                      return;
                    }
                    const ds = dragRef.current;
                    dragRef.current = null;
                    if (!ds) return;
                    if (ds.isDragging) {
                      const nx = Math.min(0.98, Math.max(0.02, ds.currentX));
                      const ny = Math.min(0.98, Math.max(0.02, ds.currentY));
                      if (onDragCommit) {
                        onDragCommit(ds.signId, nx, ny);
                      } else {
                        // Optimistic update — move the marker instantly so it doesn't snap back
                        setLocalSigns((prev) => prev.map((s) =>
                          s.id === ds.signId ? { ...s, xPos: nx, yPos: ny, placementSource: "user_drag" } : s
                        ));
                        const optimisticSign = localSigns.find((s) => s.id === ds.signId);
                        if (optimisticSign && ds.signId === activeSignId) {
                          onActiveSignChange({ ...optimisticSign, xPos: nx, yPos: ny, placementSource: "user_drag" });
                        }
                        apiFetch(`/api/extracted-signs/${ds.signId}`, {
                          method: "PATCH",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ xPos: nx, yPos: ny, placementSource: "user_drag" }),
                        })
                          .then((r) => r.ok ? r.json() : Promise.reject(new Error("non-ok")))
                          .then((d: { sign: ExtractedSign }) => {
                            setLocalSigns((prev) => prev.map((s) => s.id === ds.signId ? d.sign : s));
                            if (ds.signId === activeSignId) onActiveSignChange(d.sign);
                            onSignUpdated?.(ds.signId, nx, ny);
                          })
                          .catch((err) => console.error("[drag] PATCH failed:", err));
                      }
                    } else {
                      const found = localSigns.find((s) => s.id === ds.signId);
                      if (found) handleSelectSign(found);
                    }
                    setDragState(null);
                    e.currentTarget.releasePointerCapture(e.pointerId);
                  }}
                  onPointerCancel={() => { dragRef.current = null; setDragState(null); panRef.current = null; setIsPanning(false); }}
                  onMouseLeave={() => { if (!dragRef.current && !panRef.current) setHoveredMarkerId(null); }}
                  onClick={(e) => {
                    if (suppressNextClickRef.current) { suppressNextClickRef.current = false; return; }
                    if (dragState?.isDragging) return;
                    const rect = e.currentTarget.getBoundingClientRect();
                    const nx = (e.clientX - rect.left) / renderedW!;
                    const ny = (e.clientY - rect.top) / renderedH!;

                    if (addMode) { if (!pendingNewMarker) setPendingNewMarker({ nx, ny }); return; }
                    if (drawMode) {
                      if (hoveredMarkerId) {
                        const found = localSigns.find((s) => s.id === hoveredMarkerId);
                        if (found) handleSelectSign(found);
                      } else { setPendingNewMarker({ nx, ny }); setAddMode(true); setDrawMode(false); }
                      return;
                    }
                    if (!showMarkers || textMarkers.length === 0) return;
                    let best: TextMarker | null = null; let bestDist = Infinity;
                    for (const m of textMarkers) { const d = Math.hypot(m.x - nx, m.y - ny); if (d < bestDist) { bestDist = d; best = m; } }
                    if (best && bestDist < 0.05) {
                      const found = localSigns.find((s) => s.id === best!.signId);
                      if (found) handleSelectSign(found);
                    }
                  }}
                  onDoubleClick={(e) => {
                    if (!showMarkers || mode !== "tab" || !onEditSign) return;
                    const rect = e.currentTarget.getBoundingClientRect();
                    const nx = (e.clientX - rect.left) / renderedW!;
                    const ny = (e.clientY - rect.top) / renderedH!;
                    let best: TextMarker | null = null; let bestDist = Infinity;
                    for (const m of textMarkers) {
                      if (m.isGhost) continue;
                      const d = Math.hypot(m.x - nx, m.y - ny);
                      if (d < bestDist) { bestDist = d; best = m; }
                    }
                    if (best && bestDist < 0.12) {
                      const found = localSigns.find((s) => s.id === best!.signId);
                      if (found) onEditSign(found);
                    }
                  }}
                />
              )}
            </div>
          )}
        </div>
      </div>

      {/* Add-marker form */}
      {pendingNewMarker && (
        <AddMarkerForm
          pending={{ xPos: pendingNewMarker.nx, yPos: pendingNewMarker.ny, pageNumber, jobFileId: file.id, jobId }}
          onSaving={(isSaving) => setAddingSign(isSaving)}
          onSave={(sign) => {
            setAddingSign(false);
            setLocalSigns((prev) => [...prev, sign]);
            onActiveSignChange(sign);
            onSignAdded?.(sign);
            setPendingNewMarker(null);
            setAddMode(false);
          }}
          onCancel={() => { setAddingSign(false); setPendingNewMarker(null); }}
        />
      )}
    </div>
  );
}

// ── Main: UnifiedPlanViewer ───────────────────────────────────────────────────

export function UnifiedPlanViewer({
  mode,
  jobId,
  files,
  signs,
  allSigns: allSignsProp,
  initialSignId,
  initialPage,
  initialFileId,
  showAiHighlight,
  showMarkers = true,
  pageType = "floor_plan",
  onClose,
  onSaved,
  onSignAdded,
  onSignUpdated,
  onSignDeleted,
  onEditSign,
}: UnifiedPlanViewerProps) {
  const sourceSigns = (allSignsProp ?? signs ?? []) as ExtractedSign[];
  const [localSigns, setLocalSigns] = useState<ExtractedSign[]>(sourceSigns);
  useEffect(() => {
    // In modal mode, protect staged draft from being overwritten by external prop updates
    if (mode === "modal" && hasPendingChangesRef.current) return;
    setLocalSigns(sourceSigns);
  // sourceSigns identity changes when parent updates; mode is stable
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceSigns]);

  // ── Draft state (modal deferred save) ─────────────────────────────────────
  const [savedSigns, setSavedSigns] = useState<ExtractedSign[]>(sourceSigns);
  useEffect(() => {
    if (mode === "modal" && hasPendingChangesRef.current) return;
    setSavedSigns(sourceSigns);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceSigns]);
  const [historyStack, setHistoryStack] = useState<ExtractedSign[][]>([]);
  const [redoStack, setRedoStack] = useState<ExtractedSign[][]>([]);
  const [batchSaving, setBatchSaving] = useState(false);
  const [batchSaveError, setBatchSaveError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const localSignsRef = useRef(localSigns);
  useEffect(() => { localSignsRef.current = localSigns; }, [localSigns]);

  // Track pending changes in a ref so the sourceSigns sync guards can read it
  // without capturing stale closures.
  const hasPendingChangesRef = useRef(false);

  const modalContainerRef = useRef<HTMLDivElement>(null);

  const hasPendingChanges = useMemo(() => {
    if (mode !== "modal") return false;
    const savedMap = new Map(savedSigns.map((s) => [s.id, s]));
    for (const s of localSigns) {
      const orig = savedMap.get(s.id);
      if (!orig) return true;
      if (orig.xPos !== s.xPos || orig.yPos !== s.yPos) return true;
    }
    for (const s of savedSigns) {
      if (!localSigns.find((ls) => ls.id === s.id)) return true;
    }
    return false;
  }, [mode, localSigns, savedSigns]);

  const pendingCount = useMemo(() => {
    if (mode !== "modal") return 0;
    let count = 0;
    const savedMap = new Map(savedSigns.map((s) => [s.id, s]));
    for (const s of localSigns) {
      const orig = savedMap.get(s.id);
      if (!orig || orig.xPos !== s.xPos || orig.yPos !== s.yPos) count++;
    }
    for (const s of savedSigns) {
      if (!localSigns.find((ls) => ls.id === s.id)) count++;
    }
    return count;
  }, [mode, localSigns, savedSigns]);

  // Keep ref in sync for use inside non-reactive guards (source sync effects)
  useEffect(() => { hasPendingChangesRef.current = hasPendingChanges; }, [hasPendingChanges]);

  const pushHistory = useCallback(() => {
    setHistoryStack((prev) => [...prev, localSignsRef.current]);
    setRedoStack([]);
  }, []);

  const handleDragCommit = useCallback((signId: string, nx: number, ny: number) => {
    pushHistory();
    setLocalSigns((prev) => prev.map((s) =>
      s.id === signId ? { ...s, xPos: nx, yPos: ny, placementSource: "user_drag" } : s
    ));
    setActiveSignState((prev) => {
      if (prev && prev.id === signId) return { ...prev, xPos: nx, yPos: ny, placementSource: "user_drag" };
      return prev;
    });
  }, [pushHistory]);

  const handleDeleteCommit = useCallback((signId: string) => {
    pushHistory();
    setLocalSigns((prev) => {
      const next = prev.filter((s) => s.id !== signId);
      setActiveSignState(next[0] ?? null);
      return next;
    });
  }, [pushHistory]);

  const handleBatchSave = useCallback(async () => {
    setBatchSaving(true);
    setBatchSaveError(null);
    const currentSigns = localSignsRef.current;
    const savedMap = new Map(savedSigns.map((s) => [s.id, s]));
    const currentMap = new Map(currentSigns.map((s) => [s.id, s]));
    const calls: Promise<void>[] = [];

    for (const s of currentSigns) {
      const orig = savedMap.get(s.id);
      // Only PATCH signs that were in the saved snapshot and have a changed position.
      // Skips any locally-introduced signs to avoid spurious requests.
      if (orig && (orig.xPos !== s.xPos || orig.yPos !== s.yPos)) {
        calls.push(
          apiFetch(`/api/extracted-signs/${s.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ xPos: s.xPos, yPos: s.yPos, placementSource: s.placementSource }),
          }).then((r) => {
            if (!r.ok) throw new Error(`PATCH ${s.id} failed`);
          })
        );
      }
    }

    for (const s of savedSigns) {
      if (!currentMap.has(s.id)) {
        calls.push(
          apiFetch(`/api/extracted-signs/${s.id}`, { method: "DELETE" }).then((r) => {
            if (!r.ok) throw new Error(`DELETE ${s.id} failed`);
          })
        );
      }
    }

    try {
      await Promise.all(calls);
      setSavedSigns(currentSigns);
      setHistoryStack([]);
      setRedoStack([]);
      onSignUpdated && currentSigns.forEach((s) => {
        const orig = savedMap.get(s.id);
        if (orig && (orig.xPos !== s.xPos || orig.yPos !== s.yPos)) {
          onSignUpdated(s.id, s.xPos ?? 0, s.yPos ?? 0);
        }
      });
      savedSigns.forEach((s) => {
        if (!currentMap.has(s.id)) onSignDeleted?.(s.id);
      });
    } catch (err) {
      setBatchSaveError(String(err instanceof Error ? err.message : err));
    } finally {
      setBatchSaving(false);
    }
  }, [savedSigns, onSignUpdated, onSignDeleted]);

  // Restore a drag/delete snapshot while preserving current form-field data.
  // For signs that still exist in current localSigns, only xPos/yPos/placementSource
  // are restored from the snapshot; all other fields (signType, location, etc.) keep
  // their latest values so that form-field edits are NOT rolled back by undo/redo.
  // For signs that were deleted (not in current state), the full snapshot entry is
  // used because there is no current version to fall back on.
  const restoreSnapshot = useCallback((snapshot: ExtractedSign[]) => {
    const currentMap = new Map(localSignsRef.current.map((s) => [s.id, s]));
    const merged = snapshot.map((snapSign) => {
      const current = currentMap.get(snapSign.id);
      if (current) {
        return { ...current, xPos: snapSign.xPos, yPos: snapSign.yPos, placementSource: snapSign.placementSource };
      }
      return snapSign;
    });
    setLocalSigns(merged);
    setActiveSignState((prev) => {
      if (!prev) return merged[0] ?? null;
      const inMerged = merged.find((s) => s.id === prev.id);
      return inMerged ?? merged[0] ?? null;
    });
  }, []);

  const handleUndo = useCallback(() => {
    setHistoryStack((prevStack) => {
      if (prevStack.length === 0) return prevStack;
      const snapshot = prevStack[prevStack.length - 1]!;
      const rest = prevStack.slice(0, -1);
      setRedoStack((prevRedo) => [...prevRedo, localSignsRef.current]);
      restoreSnapshot(snapshot);
      return rest;
    });
  }, [restoreSnapshot]);

  const handleRedo = useCallback(() => {
    setRedoStack((prevRedo) => {
      if (prevRedo.length === 0) return prevRedo;
      const snapshot = prevRedo[prevRedo.length - 1]!;
      const rest = prevRedo.slice(0, -1);
      setHistoryStack((prevStack) => [...prevStack, localSignsRef.current]);
      restoreSnapshot(snapshot);
      return rest;
    });
  }, [restoreSnapshot]);

  // ── Keyboard undo/redo (modal only) ───────────────────────────────────────
  // Attached as onKeyDown on the modal container div so it only receives
  // events that originate inside the modal (event bubbling).
  const handleModalKeyDown = useCallback((e: React.KeyboardEvent) => {
    const tag = (document.activeElement?.tagName ?? "").toUpperCase();
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    const key = e.key.toLowerCase();
    if (key === "z" && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
      e.preventDefault();
      handleUndo();
    } else if (
      (key === "y" && (e.ctrlKey || e.metaKey)) ||
      (key === "z" && (e.ctrlKey || e.metaKey) && e.shiftKey)
    ) {
      e.preventDefault();
      handleRedo();
    }
  }, [handleUndo, handleRedo]);

  // ── Active sign ────────────────────────────────────────────────────────────
  const findInitialSign = () => {
    if (initialSignId) return sourceSigns.find((s) => s.id === initialSignId) ?? sourceSigns[0] ?? null;
    return sourceSigns[0] ?? null;
  };
  const [activeSign, setActiveSignState] = useState<ExtractedSign | null>(findInitialSign);

  useEffect(() => {
    if (initialSignId) {
      const s = localSigns.find((s) => s.id === initialSignId);
      if (s) setActiveSignState(s);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSignId]);

  const setActiveSign = useCallback((s: ExtractedSign | null) => {
    setActiveSignState(s);
    if (s?.jobFileId) setSelectedFileId(s.jobFileId);
    if (s?.pageNumber) setPageNumber(s.pageNumber);
  }, []);

  // ── Text search status (used by modal edit panel) ─────────────────────────
  const [textSearchStatus, setTextSearchStatus] = useState<"idle" | "found" | "not-found">("idle");

  // ── resetAiPlacement bridge: PageViewer registers its function here so the
  //    modal top-bar button uses the same cleanup path (dedupe refs + state) ──
  const resetAiPlacementBridgeRef = useRef<((signId: string) => void) | null>(null);
  const handleRegisterResetAiPlacement = useCallback((fn: (signId: string) => void) => {
    resetAiPlacementBridgeRef.current = fn;
  }, []);

  // ── File selection ─────────────────────────────────────────────────────────
  const floorPlanFiles = useMemo(() => {
    if (pageType === "sign_schedule") {
      return files.filter(
        (f) => (f.pageStats?.signSchedulePages?.length ?? 0) > 0 || (f.pageStats?.bothPages?.length ?? 0) > 0
      );
    }
    return files.filter(
      (f) => (f.pageStats?.floorPlanPages?.length ?? 0) > 0 || (f.pageStats?.bothPages?.length ?? 0) > 0
    );
  }, [files, pageType]);

  const [selectedFileId, setSelectedFileId] = useState<string>(() => {
    if (initialFileId) return initialFileId;
    if (activeSign?.jobFileId) return activeSign.jobFileId;
    return floorPlanFiles[0]?.id ?? files[0]?.id ?? "";
  });

  const selectedFile = useMemo(() => {
    const pool = mode === "modal" ? files : floorPlanFiles;
    return pool.find((f) => f.id === selectedFileId) ?? pool[0] ?? null;
  }, [files, floorPlanFiles, selectedFileId, mode]);

  // ── Navigable pages ────────────────────────────────────────────────────────
  const navigablePages = useMemo(() => {
    if (!selectedFile) return [];
    if (mode === "modal") {
      const count = selectedFile.pageCount ?? 1;
      return Array.from({ length: count }, (_, i) => i + 1);
    }
    if (pageType === "sign_schedule") {
      const sp = selectedFile.pageStats?.signSchedulePages ?? [];
      const bp = selectedFile.pageStats?.bothPages ?? [];
      return [...new Set([...sp, ...bp])].sort((a, b) => a - b);
    }
    const fp = selectedFile.pageStats?.floorPlanPages ?? [];
    const bp = selectedFile.pageStats?.bothPages ?? [];
    return [...new Set([...fp, ...bp])].sort((a, b) => a - b);
  }, [selectedFile, mode, pageType]);

  // ── Page number ────────────────────────────────────────────────────────────
  const [pageNumber, setPageNumber] = useState<number>(() => {
    if (initialPage) return initialPage;
    if (activeSign?.pageNumber) return activeSign.pageNumber;
    return navigablePages[0] ?? 1;
  });

  // Reconcile pageNumber when the selected file changes (tab mode): clamp to
  // the first valid navigable page for the new file so pageIdx never stays -1.
  const prevNavigablePagesRef = useRef<number[]>(navigablePages);
  useEffect(() => {
    prevNavigablePagesRef.current = navigablePages;
    if (navigablePages.length === 0) return;
    // If the navigable set changed (file switch) and current pageNumber is no
    // longer valid, jump to the first available page.
    if (!navigablePages.includes(pageNumber)) {
      setPageNumber(navigablePages[0]!);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigablePages]);

  // ── Modal: prev/next navigation ────────────────────────────────────────────
  const currentIdx = activeSign ? localSigns.findIndex((s) => s.id === activeSign.id) : -1;
  const hasPrev = currentIdx > 0;
  const hasNext = currentIdx >= 0 && currentIdx < localSigns.length - 1;

  // ── Confidence ─────────────────────────────────────────────────────────────
  const confidence = activeSign ? Math.round(activeSign.confidenceScore * 100) : 0;
  const confColor = confidence >= 80 ? "text-accent" : confidence >= 60 ? "text-primary" : "text-destructive";

  // ── No files guard ─────────────────────────────────────────────────────────
  if (mode === "tab" && floorPlanFiles.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground p-8">
        <div className="text-center">
          <MapPin className="w-8 h-8 mx-auto mb-3 opacity-30" />
          {pageType === "sign_schedule" ? (
            <>
              <p className="text-sm font-medium">No signage schedule pages detected</p>
              <p className="text-xs text-muted-foreground/60 mt-1">Pages classified as sign schedule will appear here after extraction.</p>
            </>
          ) : (
            <>
              <p className="text-sm font-medium">No floor plan pages detected</p>
              <p className="text-xs text-muted-foreground/60 mt-1">Upload plan PDFs and run extraction to classify pages.</p>
            </>
          )}
        </div>
      </div>
    );
  }

  if (!selectedFile) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground p-8">
        <div className="text-center">
          <FileText className="w-8 h-8 mx-auto mb-3 opacity-30" />
          <p className="text-sm font-medium">No files available</p>
        </div>
      </div>
    );
  }

  const handleActiveSignChange = (s: ExtractedSign | null) => {
    setActiveSign(s);
  };

  const pageViewer = (
    <PageViewer
      key={selectedFile.id}
      mode={mode}
      jobId={jobId}
      file={selectedFile}
      localSigns={localSigns}
      setLocalSigns={setLocalSigns}
      activeSignId={activeSign?.id ?? null}
      onActiveSignChange={handleActiveSignChange}
      onSignAdded={onSignAdded}
      onSignUpdated={onSignUpdated}
      onSignDeleted={onSignDeleted}
      onDragCommit={mode === "modal" ? handleDragCommit : undefined}
      onEditSign={onEditSign}
      navigablePages={navigablePages}
      pageNumber={pageNumber}
      setPageNumber={setPageNumber}
      onTextSearchStatusChange={setTextSearchStatus}
      onRegisterResetAiPlacement={handleRegisterResetAiPlacement}
      showAiHighlight={showAiHighlight}
      showMarkers={showMarkers}
      pagePrefix={pageType === "sign_schedule" ? "Sign page" : "Floor plan"}
      canUndo={historyStack.length > 0}
      canRedo={redoStack.length > 0}
      onUndo={handleUndo}
      onRedo={handleRedo}
      onSave={handleBatchSave}
      hasPendingChanges={hasPendingChanges}
      batchSaving={batchSaving}
      pendingCount={pendingCount}
    />
  );

  // ── Tab mode ───────────────────────────────────────────────────────────────
  if (mode === "tab") {
    return (
      <div className="flex flex-col h-full min-h-0">
        {floorPlanFiles.length > 1 && (
          <div className="flex-none flex items-end gap-0 px-4 pt-2 border-b border-border bg-secondary/20 overflow-x-auto">
            {floorPlanFiles.map((f) => {
              const active = f.id === selectedFileId;
              return (
                <button key={f.id} onClick={() => setSelectedFileId(f.id)}
                  className={`px-3 py-1.5 text-xs font-mono rounded-t-md border-b-2 whitespace-nowrap transition-all -mb-px ${active ? "border-primary text-primary bg-background border-x border-t border-border" : "border-transparent text-muted-foreground hover:text-foreground hover:bg-secondary/40"}`}>
                  {f.originalName.replace(/\.pdf$/i, "").slice(0, 30)}
                </button>
              );
            })}
          </div>
        )}

        <div className="flex flex-1 min-h-0 overflow-hidden">
          {pageViewer}
        </div>
      </div>
    );
  }

  // Focus the modal container when it mounts so Ctrl+Z works without a click
  useEffect(() => {
    if (mode !== "modal") return;
    modalContainerRef.current?.focus();
  }, [mode]);

  // ── Modal mode ─────────────────────────────────────────────────────────────
  const handleCloseWithGuard = () => {
    if (hasPendingChanges) {
      setConfirmDiscard(true);
    } else {
      onClose?.();
    }
  };

  return (
    <div
      ref={modalContainerRef}
      tabIndex={-1}
      onKeyDown={handleModalKeyDown}
      className="fixed inset-0 z-50 flex flex-col bg-background/95 backdrop-blur-sm outline-none"
    >
      {/* Top bar */}
      <div className="flex-none bg-card border-b border-border shadow-lg">
        <div className="flex items-center justify-between px-4 py-3">
          <div className="flex items-center gap-1 flex-shrink-0">
            <button disabled={!hasPrev} onClick={() => { if (hasPrev) setActiveSign(localSigns[currentIdx - 1]!); }} title="Previous sign" className="p-1.5 rounded hover:bg-secondary disabled:opacity-25 transition-colors">
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="text-xs font-mono text-muted-foreground select-none min-w-[52px] text-center">
              {currentIdx >= 0 ? `${currentIdx + 1} / ${localSigns.length}` : "—"}
            </span>
            <button disabled={!hasNext} onClick={() => { if (hasNext) setActiveSign(localSigns[currentIdx + 1]!); }} title="Next sign" className="p-1.5 rounded hover:bg-secondary disabled:opacity-25 transition-colors">
              <ChevronRight className="w-4 h-4" />
            </button>
            <div className="w-px h-4 bg-border mx-1" />
          </div>

          <div className="flex items-center gap-3 min-w-0 flex-1">
            <FileText className="w-5 h-5 text-muted-foreground flex-shrink-0" />
            <div className="min-w-0">
              <p className="text-sm font-display font-semibold text-foreground leading-none truncate">{selectedFile.originalName}</p>
              {activeSign?.sheetNumber && (
                <p className="text-xs text-muted-foreground font-mono mt-0.5">Sheet {activeSign.sheetNumber}{activeSign.signIdentifier ? ` • ${activeSign.signIdentifier}` : ""}</p>
              )}
            </div>
            {activeSign && (
              <div className={`text-xs font-mono font-semibold px-2 py-0.5 rounded border ${confColor} bg-current/10 border-current/20`}>
                {confidence}% confidence
              </div>
            )}
            {activeSign?.manuallyAdded && (
              <span className="flex items-center gap-1 text-[10px] font-display font-bold uppercase tracking-wider border px-2 py-0.5 rounded" style={{ color: "#a855f7", borderColor: "#a855f755", background: "#a855f710" }}>
                <Plus className="w-3 h-3" />Manually Added
              </span>
            )}
            {activeSign?.userVerified && (
              <span className="flex items-center gap-1 text-[10px] font-display font-bold uppercase tracking-wider border px-2 py-0.5 rounded" style={{ color: "#22c55e", borderColor: "#22c55e55", background: "#22c55e10" }}>
                <CheckCircle className="w-3 h-3" />Verified
              </span>
            )}
            {activeSign && (activeSign.placementSource === "user_confirmed" || activeSign.placementSource === "gemini_vision") && (
              <button
                title="AI-placed marker — click to reset position"
                onClick={() => {
                  if (!activeSign) return;
                  const resetFn = resetAiPlacementBridgeRef.current;
                  if (resetFn) {
                    resetFn(activeSign.id);
                  }
                }}
                className="flex items-center gap-1 text-[10px] font-display font-bold uppercase tracking-wider border px-2 py-0.5 rounded transition-colors hover:bg-cyan-400/20"
                style={{ color: "#06b6d4", borderColor: "#06b6d455", background: "#06b6d410" }}
              >
                <Sparkles className="w-3 h-3" />AI Placed
                <RotateCcw className="w-2.5 h-2.5 ml-0.5 opacity-70" />
                <span className="opacity-70">Reset</span>
              </button>
            )}
            {activeSign?.reviewFlag && (
              <span className="flex items-center gap-1 text-[10px] font-display font-bold uppercase tracking-wider text-primary border border-primary/30 bg-primary/10 px-2 py-0.5 rounded">
                <AlertTriangle className="w-3 h-3" />Flagged
              </span>
            )}
            {textSearchStatus === "found" && (
              <span className="flex items-center gap-1 text-[10px] font-display font-bold uppercase tracking-wider text-accent border border-accent/30 bg-accent/10 px-2 py-0.5 rounded">
                <MapPin className="w-3 h-3" />Located on page
              </span>
            )}
            {textSearchStatus === "not-found" && (
              <span className="flex items-center gap-1 text-[10px] font-display font-bold uppercase tracking-wider text-destructive border border-destructive/30 bg-destructive/10 px-2 py-0.5 rounded">
                <AlertTriangle className="w-3 h-3" />Not found on this page
              </span>
            )}
          </div>

          {/* Close */}
          <div className="flex items-center gap-1 flex-shrink-0 ml-3">
            <button onClick={handleCloseWithGuard} className="p-2 rounded-lg hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Batch save error */}
        {batchSaveError && (
          <div className="px-4 py-2 text-xs text-destructive bg-destructive/10 border-t border-destructive/20 flex items-center gap-2">
            <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
            {batchSaveError}
            <button onClick={() => setBatchSaveError(null)} className="ml-auto text-destructive/60 hover:text-destructive"><X className="w-3 h-3" /></button>
          </div>
        )}

        {/* Confirm discard row */}
        {confirmDiscard && (
          <div className="px-4 py-2 bg-amber-500/10 border-t border-amber-500/20 flex items-center gap-3 text-xs">
            <AlertTriangle className="w-3.5 h-3.5 text-primary flex-shrink-0" />
            <span className="text-foreground font-medium">You have unsaved changes. Discard and close?</span>
            <button
              onClick={() => { setConfirmDiscard(false); onClose?.(); }}
              className="ml-auto px-3 py-1 rounded bg-destructive/80 text-destructive-foreground font-semibold hover:bg-destructive transition-colors"
            >
              Discard &amp; Close
            </button>
            <button
              onClick={() => setConfirmDiscard(false)}
              className="px-3 py-1 rounded bg-secondary text-muted-foreground font-semibold hover:text-foreground transition-colors"
            >
              Cancel
            </button>
          </div>
        )}
      </div>

      {/* Two-panel body */}
      <div className="flex-1 flex overflow-hidden">
        <div className="flex-1 flex flex-col min-w-0 border-r border-border">
          {pageViewer}
        </div>
        {activeSign && (
          <EditPanel
            activeSign={activeSign}
            textSearchStatus={textSearchStatus}
            onClose={handleCloseWithGuard}
            onSaved={onSaved}
            onSignDeleted={onSignDeleted}
            onDeleteCommit={handleDeleteCommit}
            setLocalSigns={setLocalSigns}
            setActiveSign={setActiveSign}
            localSigns={localSigns}
          />
        )}
      </div>
    </div>
  );
}
