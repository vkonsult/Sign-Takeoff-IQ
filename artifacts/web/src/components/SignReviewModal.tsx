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
} from "lucide-react";

import type { ExtractedSign } from "@/types/sign";
export type { ExtractedSign };

import {
  type PdfPhrase,
  findSignLocationFromPhrases,
  phraseMatchScore,
  parseLocationParts,
  findPairedClusterMatch,
  isResidentialUnitLocation,
} from "@/lib/signMatcher";

interface PageStats {
  floorPlanPages: number[];
  signSchedulePages: number[];
  bothPages?: number[];
  otherPages: number[];
  pageImagePaths?: Record<string, string> | null;
}

interface FileInfo {
  id: string;
  originalName: string;
  pageCount?: number | null;
  pageStats?: PageStats | null;
}

interface SignReviewModalProps {
  sign: ExtractedSign;
  jobId: string;
  files: FileInfo[];
  allSigns: ExtractedSign[];
  onClose: () => void;
  onSaved: (updated: Record<string, unknown>) => void;
  onSignAdded?: (sign: ExtractedSign) => void;
  onSignDeleted?: (signId: string) => void;
}

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
  "restroom": "#EC4899",
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

// ─── Types ─────────────────────────────────────────────────────────────────

/** A candidate door/entrance position returned by the Gemini visual-locate pass. */
interface VisualCandidate {
  x: number;
  y: number;
  description: string;
  confidence: number;
}

interface TextMarker {
  x: number;               // 0–1 final marker position (page width)  — may be offset from text
  y: number;               // 0–1 final marker position (page height, top-down)
  phraseCenter?: { x: number; y: number }; // 0–1 original phrase bbox centre (debug overlay)
  signId: string;
  color: string;
  label: string;
  isCurrent: boolean;
  placementScore: number;  // 0–1 match confidence; 1.0 = exact ID or manual; 0 = ghost
  isGhost?: boolean;       // true when all matching failed — rendered at low opacity
  matchedPhrase?: PdfPhrase; // the phrase whose centre was used (for debug overlay)
  rejectedCandidates?: PdfPhrase[]; // runner-up candidate phrases (for debug overlay)
}


/**
 * Given a matched phrase and all phrases on the page, compute the best marker
 * position by offsetting away from the text toward open (low-density) space.
 *
 * Tries 4 directions (right, left, down, up) and picks the one with the
 * least surrounding text density. Anti-stacking nudges the result if it
 * lands too close to an already-placed marker.
 */
function computeMarkerOffset(
  phrase: PdfPhrase,
  allPhrases: PdfPhrase[],
  placedMarkers: Array<{ x: number; y: number }>,
): { x: number; y: number } {
  const cx = (phrase.x0 + phrase.x1) / 2;
  const cy = (phrase.y0 + phrase.y1) / 2;

  // Offset magnitude: scale with phrase size, but enforce a minimum so there's
  // always visible clearance. 0.07 normalized ≈ ~55–70 px at typical scale.
  const phraseW = phrase.x1 - phrase.x0;
  const phraseH = phrase.y1 - phrase.y0;
  const dx = Math.max(phraseW * 2.5, 0.06);
  const dy = Math.max(phraseH * 3.0, 0.05);

  const candidates = [
    { x: cx + dx, y: cy },   // right
    { x: cx - dx, y: cy },   // left
    { x: cx,      y: cy + dy }, // down
    { x: cx,      y: cy - dy }, // up
  ].filter((d) => d.x >= 0.01 && d.x <= 0.99 && d.y >= 0.01 && d.y <= 0.99);

  if (candidates.length === 0) return { x: cx, y: cy }; // nowhere to go, use center

  // Score each candidate by text density in a radius around it.
  // Lower score = less text = better (more open space).
  const DENSITY_RADIUS = Math.max(dx, dy) * 0.9;
  function textDensity(nx: number, ny: number): number {
    let score = 0;
    for (const p of allPhrases) {
      if (p === phrase) continue;
      const pcx = (p.x0 + p.x1) / 2;
      const pcy = (p.y0 + p.y1) / 2;
      const dist = Math.hypot(nx - pcx, ny - pcy);
      if (dist < DENSITY_RADIUS) score += 1 - dist / DENSITY_RADIUS;
    }
    return score;
  }

  const scored = candidates
    .map((d) => ({ ...d, density: textDensity(d.x, d.y) }))
    .sort((a, b) => a.density - b.density);

  let { x, y } = scored[0]!;

  // Anti-stacking: if an already-placed marker is too close, nudge further
  // in the same offset direction from the phrase center.
  const STACK_RADIUS = 0.04;
  for (const m of placedMarkers) {
    if (Math.hypot(x - m.x, y - m.y) < STACK_RADIUS) {
      x = x + (x - cx) * 0.5;
      y = y + (y - cy) * 0.5;
    }
  }

  return { x, y };
}

export function SignReviewModal({
  sign,
  jobId,
  files,
  allSigns: allSignsProp,
  onClose,
  onSaved,
  onSignAdded,
  onSignDeleted,
}: SignReviewModalProps) {
  const [localSigns, setLocalSigns] = useState<ExtractedSign[]>(allSignsProp);
  useEffect(() => { setLocalSigns(allSignsProp); }, [allSignsProp]);
  const allSigns = localSigns;
  const file = files.find((f) => f.id === sign.jobFileId) ?? null;

  // ── Page image (PNG) state ──────────────────────────────────────────────
  const [pageNumber, setPageNumber] = useState(sign.pageNumber ?? 1);
  const [scale, setScale] = useState(1.0);
  const pdfContainerRef = useRef<HTMLDivElement>(null);

  // Image paths for the current file
  const pageImagePaths = file?.pageStats?.pageImagePaths ?? null;
  // Total navigable pages: determined from the keys of pageImagePaths (or pageCount fallback)
  const totalPages = pageImagePaths
    ? Object.keys(pageImagePaths).length
    : (file?.pageCount ?? null);

  // Per-page PNG blob URL
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

    if (!file || !pageImagePaths?.[String(pageNumber)]) {
      setImageError(true);
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
  }, [jobId, file?.id, pageNumber, pageImagePaths]);

  // Cleanup blob URL on unmount
  useEffect(() => {
    return () => {
      if (prevImageUrlRef.current) URL.revokeObjectURL(prevImageUrlRef.current);
    };
  }, []);

  // Whether the image viewer is ready (image URL is available)
  const imageReady = !!imageUrl;

  // activeSign tracks which sign is currently being edited — starts as the
  // prop but can change when the user clicks a marker on the PDF.
  const [activeSign, setActiveSign] = useState<ExtractedSign>(sign);

  const [form, setForm] = useState<FormState>(() => signToForm(sign));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  // ── Highlight / marker state ────────────────────────────────────────────
  type ServerPhraseData = { pageWidth: number; pageHeight: number; phrases: PdfPhrase[] };
  const [serverPhrases, setServerPhrases] = useState<ServerPhraseData | null>(null);
  // Track whether the most recent phrase fetch failed so we can show ghost markers
  // even when phrases are unavailable (rather than clearing markers silently).
  const [phrasesFetchFailed, setPhrasesFetchFailed] = useState(false);
  const [textMarkers, setTextMarkers] = useState<TextMarker[]>([]);
  const [nativeSize, setNativeSize] = useState<{ w: number; h: number } | null>(null);

  // fitScale: the "fit to container width" scale — recomputed whenever native size is known.
  // Stored so the Fit button can reapply it at any time without re-reading the DOM.
  const [fitScale, setFitScale] = useState(1.0);

  // Auto-fit scale to container width when the page dimensions become known
  useEffect(() => {
    if (!nativeSize || !pdfContainerRef.current) return;
    const containerW = pdfContainerRef.current.clientWidth - 32; // subtract padding
    if (containerW > 0) {
      const fit = Math.min(1.2, Math.max(0.3, containerW / nativeSize.w));
      setFitScale(fit);
      setScale(fit);
    }
  // Only run when native width first becomes known or changes (new page/doc)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nativeSize?.w]);
  const [textSearchStatus, setTextSearchStatus] = useState<"idle" | "found" | "not-found">("idle");
  const [showOverlay, setShowOverlay] = useState(true);
  const [debugMode, setDebugMode] = useState(false);
  const [drawMode, setDrawMode] = useState(false);
  const [addMode, setAddMode] = useState(false);
  const [pendingNewMarker, setPendingNewMarker] = useState<{ nx: number; ny: number } | null>(null);
  const [hoveredMarkerId, setHoveredMarkerId] = useState<string | null>(null);
  const [addingSign, setAddingSign] = useState(false);

  // ── Visual-locate (Gemini door placement) ───────────────────────────────
  // visualCandidates: signId → alternative candidates (index 1+) to show as numbered dots
  const [visualCandidates, setVisualCandidates] = useState<Map<string, VisualCandidate[]>>(new Map());
  // visualLocateFailed: signs for which Gemini returned no candidates → suppress marker
  const [visualLocateFailed, setVisualLocateFailed] = useState<Set<string>>(new Set());
  const [visualLocating, setVisualLocating] = useState(false);
  // Page-level dedup ref: prevents re-firing the Gemini request for the same page
  const visualLocateQueriedRef = useRef<Set<string>>(new Set());
  // Per-sign ref: tracks exactly which sign IDs were submitted in the last request batch.
  // Used for per-sign marker suppression — only suppress signs actually sent to Gemini.
  const visualLocateSubmittedRef = useRef<Set<string>>(new Set());

  // Measure actual rendered image size by observing the img element's DOM dimensions.
  // This is more reliable than computing nativeSize.w * scale because it reads actual
  // CSS pixels from the DOM and is immune to any rounding or transform differences.
  const pageWrapRef = useRef<HTMLDivElement>(null);
  const [measuredPageSize, setMeasuredPageSize] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    const el = pageWrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const img = el.querySelector("img");
      if (img) {
        setMeasuredPageSize({ w: img.offsetWidth, h: img.offsetHeight });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Reset measuredPageSize when the page changes so stale dimensions don't persist
  useEffect(() => {
    setMeasuredPageSize(null);
  }, [pageNumber, file?.id]);

  // Suppress marker dots when viewing a sign schedule / spec page — those pages
  // are tabular data, not spatial floor plans, so dots on them are meaningless.
  const fileStats = file?.pageStats ?? null;
  const isSignSchedulePage = fileStats?.signSchedulePages?.includes(pageNumber) ?? false;

  // When the parent passes a new sign (user clicked a different row), reset activeSign.
  useEffect(() => {
    setActiveSign(sign);
  }, [sign.id]);

  // When activeSign changes (from parent switch or marker click), reset form + jump page.
  // Do NOT clear textMarkers here — the text-search effect will re-run (activeSign.id is
  // in its deps) and recompute colors. Clearing here caused all dots to disappear when
  // clicking a same-page marker, because the text-search effect wouldn't re-run.
  useEffect(() => {
    setForm(signToForm(activeSign));
    setDirty(false);
    setPageNumber((prev) => activeSign.pageNumber ?? prev);
    setTextSearchStatus("idle");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSign.id]);

  // Treat null pageNumber as page 1 — single-page PDFs often have null when
  // the AI didn't explicitly output the field.
  const signsOnCurrentPage = allSigns.filter(
    (s) => s.jobFileId === sign.jobFileId && (s.pageNumber ?? 1) === pageNumber
  );

  // Fetch server-extracted phrase list whenever the file or page changes.
  // The server groups adjacent pdfjs items into phrases and returns full bboxes
  // so the client can use bbox centres for marker placement.
  useEffect(() => {
    if (!file) {
      setServerPhrases(null);
      setPhrasesFetchFailed(false);
      return;
    }
    setServerPhrases(null);
    setPhrasesFetchFailed(false);
    let cancelled = false;
    apiFetch(`/api/jobs/${jobId}/files/${file.id}/pages/${pageNumber}/words`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("non-ok"))))
      .then((data: { pageWidth: number; pageHeight: number; phrases: PdfPhrase[] }) => {
        if (!cancelled) setServerPhrases(data);
      })
      .catch(() => {
        if (!cancelled) setPhrasesFetchFailed(true);
      });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file?.id, pageNumber, jobId]);

  // Compute text markers from server phrases.
  // A stable string that changes whenever any sign on the page has its xPos/yPos/placementSource
  // updated. Used as a dependency for the marker-building effect so it re-fires after AI
  // auto-applies placements without needing the full signsOnCurrentPage array reference.
  const signPlacementKey = signsOnCurrentPage
    .map((s) => `${s.id}:${s.xPos?.toFixed(4) ?? ""}:${s.yPos?.toFixed(4) ?? ""}:${s.placementSource ?? ""}`)
    .join("|");

  // When phrases are available, markers use bbox centres + fuzzy matching.
  // When the fetch is still in-flight (serverPhrases null, failed false), we
  // wait. When the fetch failed, we render ghost markers so the active sign
  // is always visually represented.
  // activeSign.id is a dep so colors re-compute when user clicks a marker.
  useEffect(() => {
    // Still loading — keep whatever markers were already showing
    if (!serverPhrases && !phrasesFetchFailed) return;

    // Set native page size from server data so the SVG overlay scales correctly.
    if (serverPhrases) setNativeSize({ w: serverPhrases.pageWidth, h: serverPhrases.pageHeight });

    if (signsOnCurrentPage.length === 0) {
      setTextMarkers([]);
      setTextSearchStatus("idle");
      return;
    }

    const markers: TextMarker[] = [];
    let currentSignFound = false;
    // Use server phrases if available; empty array on failure (ghost-only path)
    const phrases = serverPhrases?.phrases ?? [];

    for (const s of signsOnCurrentPage) {
      const isCurrent = s.id === activeSign.id;
      const color = isCurrent ? "#22c55e" : (s.manuallyAdded ? "#a855f7" : "#eab308");

      // Manually-placed or AI-confirmed markers: use stored coordinates directly.
      if (s.xPos != null && s.yPos != null && (s.manuallyAdded || s.placementSource != null)) {
        markers.push({
          x: s.xPos,
          y: s.yPos,
          signId: s.id,
          color,
          label: s.signIdentifier ?? s.signType?.slice(0, 6) ?? "SIGN",
          isCurrent,
          placementScore: 1.0,
        });
        if (isCurrent) currentSignFound = true;
        continue;
      }

      // Suppress annotation-band text markers for signs awaiting or having failed visual-locate.
      // Visual candidates (numbered dots) or AI-placed markers will appear instead.
      if (visualLocateFailed.has(s.id)) {
        // No marker at all — Gemini confirmed it couldn't find the door
        if (isCurrent) currentSignFound = false; // will get ghost marker below
        continue;
      }
      if (visualCandidates.has(s.id)) {
        // Alternatives exist for this sign (top candidate already auto-applied above)
        continue;
      }

      // Suppress annotation-band text marker for THIS sign if it was actually submitted to
      // visual-locate (per-sign suppression — not page-level). Signs not included in the
      // batch (failed cluster check, excluded by cap, non-residential) are NOT suppressed.
      if (visualLocateSubmittedRef.current.has(s.id)) continue;

      const loc = findSignLocationFromPhrases(phrases, s);
      if (loc) {
        markers.push({
          x: loc.x,
          y: loc.y,
          phraseCenter: { x: loc.x, y: loc.y },
          signId: s.id,
          color,
          label: s.signIdentifier ?? s.signType?.slice(0, 6) ?? "SIGN",
          isCurrent,
          placementScore: loc.score,
          matchedPhrase: loc.phrase,
          rejectedCandidates: loc.rejectedCandidates,
        });
        if (isCurrent) currentSignFound = true;
      } else {
        // Ghost marker — all matching passes failed.
        // Placed at page center (0.5, 0.5) as a visual placeholder.
        markers.push({
          x: 0.5,
          y: 0.5,
          signId: s.id,
          color,
          label: s.signIdentifier ?? s.signType?.slice(0, 6) ?? "SIGN",
          isCurrent,
          placementScore: 0,
          isGhost: true,
        });
        if (isCurrent) currentSignFound = true;
      }
    }

    // Minimal collision nudge: if two auto-matched markers would fully overlap,
    // nudge the later one slightly away from the earlier one.
    // - Direction: vector from mj → mi (away from the collision partner)
    // - Cap: max 0.012 normalized units — if still overlapping, leave them stacked
    // - At most one nudge per marker, no cascading
    // - Ghost markers are skipped entirely
    const COLLISION_THRESHOLD = 0.012;
    for (let i = 0; i < markers.length; i++) {
      const mi = markers[i]!;
      if (mi.placementScore === 1.0) continue; // skip manually-placed
      if (mi.isGhost) continue; // skip ghost markers
      for (let j = 0; j < i; j++) {
        const mj = markers[j]!;
        if (mj.isGhost) continue; // don't collide-nudge against ghosts
        const dist = Math.hypot(mi.x - mj.x, mi.y - mj.y);
        if (dist < COLLISION_THRESHOLD) {
          if (dist > 0.001) {
            // Nudge mi along the separation vector (mj → mi), capped at 0.012
            const nx = (mi.x - mj.x) / dist;
            const ny = (mi.y - mj.y) / dist;
            const nudge = Math.min(COLLISION_THRESHOLD, COLLISION_THRESHOLD - dist);
            mi.x = Math.min(0.98, Math.max(0.02, mi.x + nx * nudge));
            mi.y = Math.min(0.98, Math.max(0.02, mi.y + ny * nudge));
          }
          // else: identical positions — leave stacked (no reliable direction vector)
          break;
        }
      }
    }

    // Ghost markers serve as visual placeholders for unmatched signs.

    setTextMarkers(markers);
    if (signsOnCurrentPage.some((s) => s.id === activeSign.id)) {
      setTextSearchStatus(currentSignFound ? "found" : "not-found");
    } else {
      setTextSearchStatus("idle");
    }
  }, [serverPhrases, phrasesFetchFailed, pageNumber, sign.id, signPlacementKey, activeSign.id, visualLocateFailed, visualCandidates]);

  // Clear visual candidates, failed set, and per-sign submitted set when the page or file changes
  useEffect(() => {
    setVisualCandidates(new Map());
    setVisualLocateFailed(new Set());
    visualLocateSubmittedRef.current = new Set();
  }, [file?.id, pageNumber]);

  // Auto-fire Gemini visual-locate for residential-unit paired-cluster signs ONLY — i.e.
  // signs that (a) pass the isResidentialUnitLocation test, (b) do not already have a stored
  // placementSource, and (c) can actually produce a Pass 0.5 (paired-cluster) result on this
  // page. The phrases from serverPhrases are used to verify the cluster is present before
  // sending to Gemini — this prevents sending signs whose location text simply looks like a
  // residential unit but for which no matching cluster exists on the current page.
  //
  // Failure-safe: if the request fails the page key is cleared from the ref so annotation-band
  // text markers fall back normally (no permanent suppression).
  //
  // Batching: signs are capped to 20 per request (backend enforces this too).
  useEffect(() => {
    if (!file || !serverPhrases) return;

    const pageKey = `${file.id}:${pageNumber}`;
    if (visualLocateQueriedRef.current.has(pageKey)) return;

    // Build marker map for anchor hints (annotation-band text-matched positions)
    const markerMap = new Map(textMarkers.map((m) => [m.signId, m]));
    const phrases = serverPhrases.phrases;

    // Select residential-unit signs that (1) have no stored AI placement, (2) pass
    // isResidentialUnitLocation, AND (3) produce a non-null cluster result on this page.
    // This gates visual-locate to confirmed Pass-0.5 matches only.
    const targetSigns = signsOnCurrentPage.filter((s) => {
      if (s.placementSource != null) return false;
      if (!s.location) return false;
      if (!isResidentialUnitLocation(s.location)) return false;
      // Verify the paired cluster actually exists on this page before sending to Gemini
      const { typeToken, numberToken } = parseLocationParts(s.location);
      if (!typeToken || !numberToken) return false;
      const clusterResult = findPairedClusterMatch(phrases, typeToken, numberToken, s.signIdentifier ?? undefined);
      // Only send confirmed (non-null, non-ambiguous) Pass 0.5 matches to Gemini
      return clusterResult !== null && clusterResult !== "ambiguous";
    }).slice(0, 20); // cap to backend max

    if (targetSigns.length === 0) return;

    visualLocateQueriedRef.current.add(pageKey);
    // Track exactly which sign IDs are being submitted so we can suppress only those markers
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
            signId: s.id,
            signType: s.signType,
            location: s.location,
            signIdentifier: s.signIdentifier,
            roomNumber: numberToken,
            typeToken: typeToken,
            anchorX: marker?.x ?? null,
            anchorY: marker?.y ?? null,
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
          if (r.candidates.length === 0) {
            newFailed.add(r.signId);
          } else if (r.candidates.length === 1) {
            // Single unambiguous result — auto-apply immediately as gemini_vision.
            toAutoApply.push({ signId: r.signId, candidate: r.candidates[0]! });
          } else {
            // Multiple candidates (2–3): do NOT auto-persist — require explicit user selection.
            // All candidates are stored as numbered selectable dots (#1, #2, #3).
            // The marker stays suppressed until the user clicks a dot (confirmVisualPlacement).
            newCandidates.set(r.signId, r.candidates.slice(0, 3));
          }
        }

        setVisualLocateFailed((prev) => {
          const next = new Set(prev);
          newFailed.forEach((id) => next.add(id));
          return next;
        });
        setVisualCandidates((prev) => {
          const next = new Map(prev);
          newCandidates.forEach((v, k) => next.set(k, v));
          return next;
        });

        // Auto-PATCH top candidates as gemini_vision (fire-and-forget — UI updates via setLocalSigns)
        for (const { signId, candidate } of toAutoApply) {
          apiFetch(`/api/extracted-signs/${signId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              xPos: candidate.x,
              yPos: candidate.y,
              placementSource: "gemini_vision",
            }),
          })
            .then((r) => r.ok ? r.json() : Promise.reject(new Error("non-ok")))
            .then((d: { sign: ExtractedSign }) => {
              setLocalSigns((prev) => prev.map((s) => s.id === signId ? d.sign : s));
              if (signId === activeSign.id) setActiveSign(d.sign);
            })
            .catch((err) => console.error(`[visual-locate] auto-apply failed for ${signId}:`, err));
        }
      })
      .catch((err) => {
        console.error("[visual-locate] request failed:", err);
        // Failure-safe: clear the page key AND per-sign submitted IDs so annotation-band
        // markers fall back to normal text matching without permanent suppression.
        visualLocateQueriedRef.current.delete(pageKey);
        targetSigns.forEach((s) => visualLocateSubmittedRef.current.delete(s.id));
      })
      .finally(() => setVisualLocating(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverPhrases, textMarkers, file?.id, pageNumber]);

  const handleField = useCallback(
    (field: keyof FormState, value: string | boolean) => {
      setForm((prev) => ({ ...prev, [field]: value }));
      setDirty(true);
    },
    []
  );

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

      const data = await res.json() as { sign: Record<string, unknown> };
      setDirty(false);
      onSaved(data.sign);
    } catch (err) {
      setSaveError(String(err instanceof Error ? err.message : err));
    } finally {
      setSaving(false);
    }
  };

  const handleCreateSign = async (nx: number, ny: number) => {
    if (!file) return;
    setAddingSign(true);
    try {
      const res = await apiFetch("/api/extracted-signs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jobId,
          jobFileId: file.id,
          pageNumber,
          xPos: nx,
          yPos: ny,
          signType: "Unknown",
          signIdentifier: null,
          location: null,
          notes: "Manually added",
        }),
      });
      if (!res.ok) throw new Error("Failed to create sign");
      const data = await res.json() as { sign: ExtractedSign };
      const newSign = data.sign;
      setLocalSigns((prev) => [...prev, newSign]);
      setActiveSign(newSign);
      onSignAdded?.(newSign);
    } catch (err) {
      console.error("Create sign failed:", err);
    } finally {
      setAddingSign(false);
    }
  };

  const handleDeleteSign = async (signId: string) => {
    try {
      const res = await apiFetch(`/api/extracted-signs/${signId}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete sign");
      setLocalSigns((prev) => prev.filter((s) => s.id !== signId));
      setHoveredMarkerId(null);
      if (activeSign.id === signId) {
        const next = allSigns.find((s) => s.id !== signId);
        if (next) setActiveSign(next);
      }
      onSignDeleted?.(signId);
    } catch (err) {
      console.error("Delete sign failed:", err);
    }
  };

  const confirmVisualPlacement = async (signId: string, candidate: VisualCandidate) => {
    try {
      const res = await apiFetch(`/api/extracted-signs/${signId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          xPos: candidate.x,
          yPos: candidate.y,
          placementSource: "user_confirmed",
        }),
      });
      if (!res.ok) throw new Error("Failed to confirm placement");
      const data = await res.json() as { sign: ExtractedSign };
      setLocalSigns((prev) => prev.map((s) => s.id === signId ? data.sign : s));
      setVisualCandidates((prev) => {
        const next = new Map(prev);
        next.delete(signId);
        return next;
      });
      if (signId === activeSign.id) {
        setActiveSign(data.sign);
      }
    } catch (err) {
      console.error("[visual-locate] confirm placement failed:", err);
    }
  };

  const confidence = Math.round(activeSign.confidenceScore * 100);
  const confColor =
    confidence >= 80
      ? "text-accent"
      : confidence >= 60
      ? "text-primary"
      : "text-destructive";

  // Prefer the ResizeObserver-measured image size — it reads actual CSS pixels
  // from the DOM and is immune to any rounding or additional transforms.
  // Both axes use exactly the same measured img element — X and Y are always in
  // the same coordinate space and use the same zoom level.
  //
  // Coordinate transform note:
  //   pdf-words.ts stores phrase Y in TOP-DOWN space:  y0 = (pageH - pdfYTop) / pageH
  //   Here we map to pixels:                           cy  = y0 * renderedH
  //   Combined:  cy = (pageH - pdfYTop) / pageH × renderedH = (pageH - pdfYTop) × scale
  //   This is exactly: screenY = (pageHeightInPdfUnits − pdfY) × scale  ✓
  const renderedW = measuredPageSize?.w ?? (nativeSize ? nativeSize.w * scale : null);
  const renderedH = measuredPageSize?.h ?? (nativeSize ? nativeSize.h * scale : null);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background/95 backdrop-blur-sm">
      {/* Top bar */}
      {(() => {
        const allSignsSorted = allSigns;
        const currentIdx = allSignsSorted.findIndex((s) => s.id === activeSign.id);
        const hasPrev = currentIdx > 0;
        const hasNext = currentIdx >= 0 && currentIdx < allSignsSorted.length - 1;
        const goPrev = () => { if (hasPrev) setActiveSign(allSignsSorted[currentIdx - 1]); };
        const goNext = () => { if (hasNext) setActiveSign(allSignsSorted[currentIdx + 1]); };
        return (
      <div className="flex-none flex items-center justify-between px-4 py-3 bg-card border-b border-border shadow-lg">
        {/* Prev / Next sign navigation */}
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            disabled={!hasPrev}
            onClick={goPrev}
            title="Previous sign"
            className="p-1.5 rounded hover:bg-secondary disabled:opacity-25 transition-colors"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <span className="text-xs font-mono text-muted-foreground select-none min-w-[52px] text-center">
            {currentIdx >= 0 ? `${currentIdx + 1} / ${allSignsSorted.length}` : "—"}
          </span>
          <button
            disabled={!hasNext}
            onClick={goNext}
            title="Next sign"
            className="p-1.5 rounded hover:bg-secondary disabled:opacity-25 transition-colors"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
          <div className="w-px h-4 bg-border mx-1" />
        </div>
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <FileText className="w-5 h-5 text-muted-foreground flex-shrink-0" />
          <div className="min-w-0">
            <p className="text-sm font-display font-semibold text-foreground leading-none truncate">
              {file?.originalName ?? "Unknown file"}
            </p>
            {activeSign.sheetNumber && (
              <p className="text-xs text-muted-foreground font-mono mt-0.5">
                Sheet {activeSign.sheetNumber}
                {activeSign.signIdentifier ? ` • ${activeSign.signIdentifier}` : ""}
              </p>
            )}
          </div>
          <div className={`text-xs font-mono font-semibold px-2 py-0.5 rounded border ${confColor} bg-current/10 border-current/20`}>
            {confidence}% confidence
          </div>
          {activeSign.manuallyAdded && (
            <span className="flex items-center gap-1 text-[10px] font-display font-bold uppercase tracking-wider border px-2 py-0.5 rounded" style={{ color: "#a855f7", borderColor: "#a855f755", background: "#a855f710" }}>
              <Plus className="w-3 h-3" />
              Manually Added
            </span>
          )}
          {activeSign.userVerified && (
            <span className="flex items-center gap-1 text-[10px] font-display font-bold uppercase tracking-wider border px-2 py-0.5 rounded" style={{ color: "#22c55e", borderColor: "#22c55e55", background: "#22c55e10" }}>
              <CheckCircle className="w-3 h-3" />
              Verified
            </span>
          )}
          {(activeSign.placementSource === "user_confirmed" || activeSign.placementSource === "gemini_vision") && (
            <button
              title="Click to clear AI placement and re-run visual locate"
              onClick={async () => {
                try {
                  const r = await apiFetch(`/api/extracted-signs/${activeSign.id}`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ xPos: null, yPos: null, placementSource: null }),
                  });
                  if (!r.ok) return;
                  const d = await r.json() as { sign: ExtractedSign };
                  setLocalSigns((prev) => prev.map((s) => s.id === activeSign.id ? d.sign : s));
                  setActiveSign(d.sign);
                  // Allow visual-locate to re-run for this page
                  if (file) {
                    visualLocateQueriedRef.current.delete(`${file.id}:${pageNumber}`);
                  }
                  setVisualLocateFailed((prev) => { const n = new Set(prev); n.delete(activeSign.id); return n; });
                  setVisualCandidates((prev) => { const n = new Map(prev); n.delete(activeSign.id); return n; });
                } catch (err) {
                  console.error("[visual-locate] reset failed:", err);
                }
              }}
              className="flex items-center gap-1 text-[10px] font-display font-bold uppercase tracking-wider border px-2 py-0.5 rounded transition-opacity hover:opacity-70"
              style={{ color: "#06b6d4", borderColor: "#06b6d455", background: "#06b6d410" }}
            >
              <Sparkles className="w-3 h-3" />
              AI Placed · Reset
            </button>
          )}
          {activeSign.reviewFlag && (
            <span className="flex items-center gap-1 text-[10px] font-display font-bold uppercase tracking-wider text-primary border border-primary/30 bg-primary/10 px-2 py-0.5 rounded">
              <AlertTriangle className="w-3 h-3" />
              Flagged
            </span>
          )}
          {/* Location found/not-found pill */}
          {textSearchStatus === "found" && (
            <span className="flex items-center gap-1 text-[10px] font-display font-bold uppercase tracking-wider text-accent border border-accent/30 bg-accent/10 px-2 py-0.5 rounded">
              <MapPin className="w-3 h-3" />
              Located on page
            </span>
          )}
          {textSearchStatus === "not-found" && (
            <span className="flex items-center gap-1 text-[10px] font-display font-bold uppercase tracking-wider text-destructive border border-destructive/30 bg-destructive/10 px-2 py-0.5 rounded">
              <AlertTriangle className="w-3 h-3" />
              Not found on this page
            </span>
          )}
        </div>
        <button
          onClick={onClose}
          className="p-2 rounded-lg hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
        >
          <X className="w-5 h-5" />
        </button>
      </div>
        );
      })()}

      {/* Two-panel body */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left: Image Viewer */}
        <div className="flex-1 flex flex-col bg-secondary/30 border-r border-border min-w-0">
          {/* Toolbar */}
          <div className="flex-none flex items-center gap-3 px-4 py-2 bg-card border-b border-border">
            <button
              aria-label="Previous page"
              disabled={pageNumber <= 1}
              onClick={() => setPageNumber((p) => Math.max(1, p - 1))}
              className="p-1.5 rounded hover:bg-secondary disabled:opacity-30 transition-colors"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="text-xs font-mono text-muted-foreground min-w-[80px] text-center">
              {totalPages ? `${pageNumber} / ${totalPages}` : "—"}
            </span>
            <button
              aria-label="Next page"
              disabled={totalPages === null || pageNumber >= totalPages}
              onClick={() => setPageNumber((p) => (totalPages ? Math.min(totalPages, p + 1) : p))}
              className="p-1.5 rounded hover:bg-secondary disabled:opacity-30 transition-colors"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
            <div className="w-px h-4 bg-border mx-1" />
            <button
              onClick={() => setScale((s) => Math.max(0.4, s - 0.15))}
              disabled={scale <= 0.4}
              className="p-1.5 rounded hover:bg-secondary disabled:opacity-30 transition-colors"
              title="Zoom out"
            >
              <ZoomOut className="w-4 h-4" />
            </button>
            <span className="text-xs font-mono text-muted-foreground w-12 text-center">
              {Math.round(scale * 100)}%
            </span>
            <button
              onClick={() => setScale(fitScale)}
              title="Fit to page width"
              className="text-[10px] font-display font-semibold uppercase tracking-wide px-2 py-1 rounded border border-border text-muted-foreground hover:text-foreground hover:border-foreground/40 transition-colors"
            >
              Fit
            </button>
            <button
              onClick={() => setScale((s) => Math.min(2.5, s + 0.15))}
              disabled={scale >= 2.5}
              className="p-1.5 rounded hover:bg-secondary disabled:opacity-30 transition-colors"
              title="Zoom in"
            >
              <ZoomIn className="w-4 h-4" />
            </button>
            <div className="w-px h-4 bg-border mx-1" />
            {activeSign.pageNumber ? (
              <button
                onClick={() => setPageNumber(activeSign.pageNumber!)}
                className="text-xs font-mono px-2 py-0.5 rounded transition-colors"
                style={{
                  backgroundColor: "#22c55e22",
                  color: "#22c55e",
                  border: "1px solid #22c55e55",
                }}
                title="Jump to AI-detected sign page"
              >
                ● Go to pg {activeSign.pageNumber}
              </button>
            ) : activeSign.sheetNumber ? (
              <span className="text-xs text-muted-foreground">
                Sheet <span className="font-mono text-foreground">{activeSign.sheetNumber}</span>
              </span>
            ) : null}

            {/* Visual-locate loading indicator */}
            {visualLocating && (
              <span className="flex items-center gap-1 text-[10px] font-display font-semibold uppercase tracking-wide px-2 py-1 rounded" style={{ color: "#06b6d4", background: "#06b6d410", border: "1px solid #06b6d455" }}>
                <Loader2 className="w-3 h-3 animate-spin" />
                AI locating…
              </span>
            )}
            {!visualLocating && visualCandidates.size > 0 && (
              <span className="flex items-center gap-1 text-[10px] font-display font-semibold uppercase tracking-wide px-2 py-1 rounded" style={{ color: "#06b6d4", background: "#06b6d410", border: "1px solid #06b6d455" }}>
                <Sparkles className="w-3 h-3" />
                AI found {visualCandidates.size > 1 ? `${visualCandidates.size} signs` : "a sign"} — pick a numbered dot to confirm
              </span>
            )}

            {/* Overlay toggle + draw mode — pushed to right */}
            <div className="ml-auto flex items-center gap-2">
              {/* Debug overlay: shows all extracted phrase bboxes */}
              {serverPhrases && (
                <button
                  onClick={() => setDebugMode((v) => !v)}
                  className="flex items-center gap-1 text-[10px] font-display font-semibold uppercase tracking-wide px-2 py-1 rounded transition-colors border"
                  style={debugMode ? {
                    background: "#f59e0b20",
                    color: "#f59e0b",
                    borderColor: "#f59e0b55",
                  } : {
                    background: "transparent",
                    color: "var(--muted-foreground)",
                    borderColor: "var(--border)",
                  }}
                  title="Toggle debug overlay — shows all extracted text bounding boxes"
                >
                  ⬡ debug
                </button>
              )}
              {textMarkers.length > 0 && (() => {
                const realMarkers = textMarkers.filter((m) => !m.isGhost);
                const ghostCount = textMarkers.filter((m) => m.isGhost).length;
                return (
                  <>
                    <button
                      onClick={() => setShowOverlay((v) => !v)}
                      className="flex items-center gap-1.5 text-[10px] font-display font-semibold uppercase tracking-wide px-2 py-1 rounded transition-colors border"
                      style={showOverlay ? {
                        background: "#22c55e20",
                        color: "#22c55e",
                        borderColor: "#22c55e55",
                      } : {
                        background: "transparent",
                        color: "var(--muted-foreground)",
                        borderColor: "var(--border)",
                      }}
                      title={showOverlay ? "Hide markers" : "Show markers"}
                    >
                      {showOverlay ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
                      {realMarkers.length} marker{realMarkers.length !== 1 ? "s" : ""}
                    </button>
                    {ghostCount > 0 && (
                      <span
                        className="flex items-center gap-1 text-[10px] font-display font-semibold uppercase tracking-wide px-2 py-1 rounded border"
                        style={{
                          background: "#ef444415",
                          color: "#ef4444",
                          borderColor: "#ef444440",
                        }}
                        title="Signs that could not be matched to a location on this page"
                      >
                        Unlocated: {ghostCount}
                      </span>
                    )}
                  </>
                );
              })()}
              {/* Add Marker button */}
              {imageReady && (
                <button
                  onClick={() => {
                    setAddMode((v) => {
                      const next = !v;
                      if (next) setDrawMode(false);
                      return next;
                    });
                    setPendingNewMarker(null);
                  }}
                  className="flex items-center gap-1.5 text-[10px] font-display font-semibold uppercase tracking-wide px-2 py-1 rounded transition-colors border"
                  style={addMode ? {
                    background: "#22c55e28",
                    color: "#22c55e",
                    borderColor: "#22c55e88",
                    boxShadow: "0 0 0 1px #22c55e44",
                  } : {
                    background: "#22c55e14",
                    color: "#22c55e",
                    borderColor: "#22c55e55",
                  }}
                  title={addMode ? "Cancel — click again or press Esc" : "Add a new sign marker: click anywhere on the floor plan"}
                >
                  <Plus className="w-3 h-3" />
                  {addMode ? "Click to place…" : "Add Marker"}
                </button>
              )}
              {/* Edit Markers (draw) mode toggle */}
              {imageReady && (
                <button
                  onClick={() => {
                    setDrawMode((v) => {
                      const next = !v;
                      if (next) setAddMode(false);
                      return next;
                    });
                    setPendingNewMarker(null);
                  }}
                  className="flex items-center gap-1.5 text-[10px] font-display font-semibold uppercase tracking-wide px-2 py-1 rounded transition-colors border"
                  style={drawMode ? {
                    background: "#a855f720",
                    color: "#a855f7",
                    borderColor: "#a855f755",
                  } : {
                    background: "transparent",
                    color: "var(--muted-foreground)",
                    borderColor: "var(--border)",
                  }}
                  title={drawMode ? "Exit edit mode" : "Edit Markers: hover a marker to delete it"}
                >
                  {drawMode ? <PenLine className="w-3 h-3" /> : <MousePointer className="w-3 h-3" />}
                  Edit Markers
                </button>
              )}
            </div>

            {/* Signs on current page chips — click to switch active sign */}
            {signsOnCurrentPage.length > 0 && (
              <div className="flex items-center gap-1.5 ml-2 overflow-x-auto max-w-[320px]">
                {signsOnCurrentPage.map((s) => {
                  const isActive = s.id === activeSign.id;
                  // A sign is "located" if it has a dot in textMarkers (text-matched, AI-placed, or manual).
                  const isLocated = textMarkers.some((m) => m.signId === s.id);
                  return (
                    <button
                      key={s.id}
                      title={`${s.signType ?? "Sign"} — ${s.location ?? ""}\nClick to edit this sign`}
                      onClick={() => setActiveSign(s)}
                      className="flex-shrink-0 flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded whitespace-nowrap transition-all"
                      style={{
                        backgroundColor: isActive ? "#22c55e" : "#22c55e18",
                        color: isActive ? "#fff" : "#22c55e",
                        border: `1px solid ${isActive ? "#22c55e" : "#22c55e55"}`,
                        fontWeight: isActive ? 700 : 500,
                        boxShadow: isActive ? "0 0 8px #22c55e55" : "none",
                        cursor: "pointer",
                      }}
                    >
                      {isActive && (
                        <span className="inline-block w-1.5 h-1.5 rounded-full bg-white flex-shrink-0" />
                      )}
                      {s.signIdentifier ?? s.signType?.slice(0, 8) ?? "SIGN"}
                      {!isLocated && (
                        <span
                          style={{
                            fontSize: 8,
                            fontWeight: 700,
                            letterSpacing: "0.05em",
                            background: "#ef444420",
                            color: "#ef4444",
                            border: "1px solid #ef444455",
                            borderRadius: 3,
                            padding: "0 3px",
                          }}
                        >
                          UNLOCATED
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Image canvas + overlay */}
          {/* overflow-auto without flex justify-center avoids the CSS bug where
              flex centering clips the left overflow when zoomed in. Instead we
              use an inner wrapper with min-w-max + flex centering so the content
              centres when it fits and scrolls freely in all directions when it doesn't. */}
          <div ref={pdfContainerRef} className="flex-1 overflow-auto p-4">
            <div className="flex justify-center items-start" style={{ minWidth: "max-content" }}>
            {/* Loading state */}
            {imageLoading && !imageUrl && (
              <div className="flex items-center justify-center h-64">
                <Loader2 className="w-8 h-8 text-primary animate-spin" />
              </div>
            )}
            {/* Error state */}
            {imageError && !imageUrl && (
              <div className="flex flex-col items-center justify-center h-64 text-destructive gap-2">
                <AlertTriangle className="w-8 h-8" />
                <p className="text-sm">Failed to load page image</p>
              </div>
            )}
            {/* No file linked */}
            {!file && (
              <div className="flex flex-col items-center justify-center h-64 text-muted-foreground gap-3">
                <FileText className="w-12 h-12 opacity-30" />
                <p className="text-sm">No source file linked to this sign entry</p>
              </div>
            )}
            {imageUrl && (
              /* Wrap page + overlay in a relative container */
              <div ref={pageWrapRef} className="relative shadow-2xl inline-block">
                <img
                  key={`${file?.id ?? ""}-${pageNumber}-img`}
                  src={imageUrl}
                  alt={`Page ${pageNumber}`}
                  style={{
                    display: "block",
                    width: nativeSize ? `${nativeSize.w * scale}px` : undefined,
                    height: nativeSize ? `${nativeSize.h * scale}px` : "auto",
                    maxWidth: "none",
                  }}
                  onLoad={(e) => {
                    const img = e.currentTarget;
                    const nw = img.naturalWidth;
                    const nh = img.naturalHeight;
                    if (nw > 0 && nh > 0) {
                      setNativeSize({ w: nw, h: nh });
                      setMeasuredPageSize({ w: img.offsetWidth, h: img.offsetHeight });
                    }
                  }}
                />

                  {/* Sign schedule page notice — only show when no real (non-ghost) markers found AND page is classified as schedule */}
                  {isSignSchedulePage && textMarkers.filter((m) => !m.isGhost).length === 0 && (
                    <div
                      style={{
                        position: "absolute",
                        top: 8,
                        left: "50%",
                        transform: "translateX(-50%)",
                        zIndex: 10,
                        pointerEvents: "none",
                      }}
                      className="px-3 py-1.5 rounded-full bg-accent/90 text-background text-[10px] font-bold uppercase tracking-wider shadow-lg whitespace-nowrap"
                    >
                      Sign Schedule Page — use Edit Markers to place manually
                    </div>
                  )}

                  {/* SVG marker overlay — visual only, above image */}
                  {showOverlay && renderedW && renderedH && (textMarkers.length > 0 || (debugMode && serverPhrases)) && (
                    <svg
                      style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        width: renderedW,
                        height: renderedH,
                        overflow: "visible",
                        pointerEvents: "none",
                        zIndex: 5,
                      }}
                      viewBox={`0 0 ${renderedW} ${renderedH}`}
                    >
                      {/* Debug overlay (anchor-lock path):
                            - all phrases: faint blue rect
                            - matched phrase: green bbox + blue dot (anchor) + red dot (final, overlaps blue for locked markers)
                            - labels get -LOCK suffix to confirm anchor-lock path is active */}
                      {debugMode && serverPhrases && serverPhrases.phrases.map((p, i) => {
                        const px0 = p.x0 * renderedW;
                        const py0 = p.y0 * renderedH;
                        const pw  = (p.x1 - p.x0) * renderedW;
                        const ph  = (p.y1 - p.y0) * renderedH;
                        // Phrase bbox center = anchor position (blue dot)
                        const pcx = (p.x0 + p.x1) / 2 * renderedW;
                        const pcy = (p.y0 + p.y1) / 2 * renderedH;

                        const matchedMarker = textMarkers.find((m) => m.matchedPhrase === p);
                        const isMatched = !!matchedMarker;

                        // Final marker position (red dot) in px — overlaps blue for anchor-locked markers
                        const mfx = matchedMarker ? matchedMarker.x * renderedW : null;
                        const mfy = matchedMarker ? matchedMarker.y * renderedH : null;

                        return (
                          <g key={`dbg-${i}`}>
                            {/* Phrase bounding box */}
                            <rect
                              x={px0} y={py0} width={pw} height={Math.max(ph, 2)}
                              fill={isMatched ? "#22c55e18" : "#3b82f608"}
                              stroke={isMatched ? "#22c55e" : "#3b82f6"}
                              strokeWidth={isMatched ? 1.5 : 0.5}
                              opacity={0.8}
                            />
                            {isMatched ? (
                              <>
                                {/* Red dot = final marker position (drawn first so blue overlaps it for locked markers) */}
                                {mfx != null && mfy != null && (
                                  <circle cx={mfx} cy={mfy} r={4}
                                    fill="#ef4444" opacity={0.85} />
                                )}
                                {/* Blue dot = anchor (phrase center); overlaps red dot exactly for anchor-locked markers */}
                                <circle cx={pcx} cy={pcy} r={3}
                                  fill="#3b82f6" opacity={0.9} />
                                {/* Text label above phrase with -LOCK suffix */}
                                <text x={pcx} y={py0 - 2}
                                  textAnchor="middle" fill="#22c55e"
                                  fontSize={7} fontFamily="monospace"
                                  style={{ userSelect: "none" }}
                                >
                                  {p.text.slice(0, 16)}-LOCK
                                </text>
                              </>
                            ) : (
                              /* Faint center dot for unmatched phrases */
                              <circle cx={pcx} cy={pcy} r={1.5}
                                fill="#3b82f6" opacity={0.4} />
                            )}
                          </g>
                        );
                      })}
                      {/* Debug: rejected candidate phrases drawn as yellow boxes so you can
                            compare them against the chosen green box for each marker */}
                      {debugMode && textMarkers.flatMap((m) =>
                        (m.rejectedCandidates ?? []).map((p, ri) => {
                          const px0 = p.x0 * renderedW;
                          const py0 = p.y0 * renderedH;
                          const pw  = (p.x1 - p.x0) * renderedW;
                          const ph  = (p.y1 - p.y0) * renderedH;
                          const pcx = (p.x0 + p.x1) / 2 * renderedW;
                          return (
                            <g key={`rej-${m.signId}-${ri}`}>
                              <rect
                                x={px0} y={py0} width={pw} height={Math.max(ph, 2)}
                                fill="#eab30812" stroke="#eab308" strokeWidth={1}
                                strokeDasharray="3 2" opacity={0.9}
                              />
                              <text
                                x={pcx} y={py0 - 2}
                                textAnchor="middle" fill="#eab308"
                                fontSize={6} fontFamily="monospace"
                                style={{ userSelect: "none" }}
                              >
                                {p.text.slice(0, 14)}-REJ
                              </text>
                            </g>
                          );
                        })
                      )}

                      {textMarkers.map((m) => {
                        const cx = m.x * renderedW;
                        const cy = m.y * renderedH;
                        const isHovered = m.signId === hoveredMarkerId;
                        const isGhost = m.isGhost === true;
                        // Dot radius: active sign slightly larger
                        const dotR = m.isCurrent ? 7 : 5;
                        const markerOpacity = isGhost ? 0.15 : 1;
                        return (
                          <g key={m.signId} opacity={markerOpacity}>
                            {/* Clean ring for active sign only */}
                            {m.isCurrent && !isGhost && (
                              <circle
                                cx={cx} cy={cy} r={dotR + 5}
                                fill="none" stroke={m.color}
                                strokeWidth={1.5}
                                opacity={0.8}
                              />
                            )}
                            {/* Hover ring */}
                            {isHovered && !m.isCurrent && !isGhost && (
                              <circle
                                cx={cx} cy={cy} r={dotR + 4}
                                fill="none" stroke={m.color}
                                strokeWidth={1} opacity={0.5}
                              />
                            )}
                            {/* Solid dot */}
                            <circle cx={cx} cy={cy} r={dotR} fill={m.color} />
                            {/* Label — only for active sign */}
                            {m.isCurrent && !isGhost && (
                              <text
                                x={cx} y={cy - dotR - 7}
                                textAnchor="middle" fill={m.color}
                                fontSize={9}
                                fontWeight="bold" fontFamily="monospace"
                                style={{ userSelect: "none" }}
                              >
                                {debugMode && m.phraseCenter ? `${m.label}-LOCK` : m.label}
                              </text>
                            )}
                          </g>
                        );
                      })}
                    </svg>
                  )}

                  {/* Ghost pin SVG for pending new-marker placement — independent of showOverlay */}
                  {pendingNewMarker && renderedW && renderedH && (
                    <svg
                      style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        width: renderedW,
                        height: renderedH,
                        overflow: "visible",
                        pointerEvents: "none",
                        zIndex: 7,
                      }}
                      viewBox={`0 0 ${renderedW} ${renderedH}`}
                    >
                      {(() => {
                        const cx = pendingNewMarker.nx * renderedW;
                        const cy = pendingNewMarker.ny * renderedH;
                        return (
                          <g>
                            <circle cx={cx} cy={cy} r={14}
                              fill="none" stroke="#22c55e" strokeWidth={2.5}
                              strokeDasharray="5 3" opacity={0.95} />
                            <circle cx={cx} cy={cy} r={5}
                              fill="#22c55e" opacity={0.9} />
                          </g>
                        );
                      })()}
                    </svg>
                  )}

                  {/* addMode hint */}
                  {addMode && !pendingNewMarker && renderedW && renderedH && (
                    <div
                      style={{
                        position: "absolute",
                        bottom: 8,
                        left: "50%",
                        transform: "translateX(-50%)",
                        zIndex: 10,
                        pointerEvents: "none",
                        background: "#22c55e20",
                        color: "#22c55e",
                        border: "1px solid #22c55e55",
                      }}
                      className="px-3 py-1.5 rounded-full text-[10px] font-bold uppercase tracking-wider shadow-lg whitespace-nowrap flex items-center gap-1"
                    >
                      <Plus className="w-3 h-3" />
                      Click anywhere on the floor plan to place a new sign
                    </div>
                  )}

                  {/* Delete X buttons — shown in draw mode when hovering a marker */}
                  {drawMode && showOverlay && renderedW && renderedH && textMarkers.map((m) => {
                    if (m.signId !== hoveredMarkerId) return null;
                    const cx = m.x * renderedW!;
                    const cy = m.y * renderedH!;
                    const r = m.isCurrent ? 18 : 12;
                    return (
                      <button
                        key={`del-${m.signId}`}
                        title="Delete this marker"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteSign(m.signId);
                        }}
                        style={{
                          position: "absolute",
                          left: cx + r - 2,
                          top: cy - r - 2,
                          zIndex: 20,
                          width: 18,
                          height: 18,
                          borderRadius: "50%",
                          background: "#ef4444",
                          color: "#fff",
                          border: "2px solid #fff",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          cursor: "pointer",
                          padding: 0,
                          pointerEvents: "all",
                        }}
                      >
                        <Trash2 style={{ width: 9, height: 9 }} />
                      </button>
                    );
                  })}

                  {/* Per-marker spinner — shown for signs currently in-flight with visual-locate */}
                  {showOverlay && visualLocating && renderedW && renderedH && textMarkers.map((m) => {
                    if (!visualLocateSubmittedRef.current.has(m.signId)) return null;
                    const cx = m.x * renderedW!;
                    const cy = m.y * renderedH!;
                    const r = m.isCurrent ? 18 : 12;
                    return (
                      <span
                        key={`vl-spin-${m.signId}`}
                        style={{
                          position: "absolute",
                          left: cx - 8,
                          top: cy + r + 2,
                          zIndex: 20,
                          width: 16,
                          height: 16,
                          pointerEvents: "none",
                          color: "#06b6d4",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        <Loader2 style={{ width: 12, height: 12, animation: "spin 1s linear infinite" }} />
                      </span>
                    );
                  })}

                  {/* AI-placed badge ON each AI-placed marker — shown for all signs with a placementSource.
                      The active sign shows a full "✦ AI · Reset" clickable label; inactive signs show a
                      smaller "✦" dot. Clicking any badge clears placement and re-queues the page. */}
                  {showOverlay && !drawMode && renderedW && renderedH && textMarkers.map((m) => {
                    const markerSign = signsOnCurrentPage.find((s) => s.id === m.signId);
                    if (markerSign?.placementSource !== "gemini_vision" && markerSign?.placementSource !== "user_confirmed") return null;
                    const cx = m.x * renderedW!;
                    const cy = m.y * renderedH!;
                    const r = m.isCurrent ? 18 : 12;
                    const isCurrent = m.isCurrent;
                    const handleReset = async (e: React.MouseEvent) => {
                      e.stopPropagation();
                      try {
                        const resp = await apiFetch(`/api/extracted-signs/${markerSign.id}`, {
                          method: "PATCH",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ xPos: null, yPos: null, placementSource: null }),
                        });
                        if (!resp.ok) return;
                        const d = await resp.json() as { sign: ExtractedSign };
                        setLocalSigns((prev) => prev.map((s) => s.id === markerSign.id ? d.sign : s));
                        if (markerSign.id === activeSign.id) setActiveSign(d.sign);
                        if (file) visualLocateQueriedRef.current.delete(`${file.id}:${pageNumber}`);
                        visualLocateSubmittedRef.current.delete(markerSign.id);
                        setVisualLocateFailed((prev) => { const n = new Set(prev); n.delete(markerSign.id); return n; });
                        setVisualCandidates((prev) => { const n = new Map(prev); n.delete(markerSign.id); return n; });
                      } catch (err) {
                        console.error("[visual-locate] marker badge reset failed:", err);
                      }
                    };
                    return isCurrent ? (
                      <button
                        key={`ai-badge-${m.signId}`}
                        title={`AI placed (${markerSign.placementSource === "gemini_vision" ? "auto" : "user confirmed"}) — click to reset and re-run`}
                        onClick={handleReset}
                        style={{
                          position: "absolute",
                          left: cx - 28,
                          top: cy + r + 4,
                          zIndex: 20,
                          height: 18,
                          paddingInline: 6,
                          borderRadius: 4,
                          background: "#06b6d4",
                          color: "#fff",
                          border: "none",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          gap: 3,
                          cursor: "pointer",
                          fontSize: 9,
                          fontWeight: "bold",
                          fontFamily: "monospace",
                          letterSpacing: "0.05em",
                          pointerEvents: "all",
                          whiteSpace: "nowrap",
                        }}
                      >
                        ✦ AI · Reset
                      </button>
                    ) : (
                      <button
                        key={`ai-badge-${m.signId}`}
                        title={`AI placed (${markerSign.placementSource === "gemini_vision" ? "auto" : "user confirmed"}) — click to reset`}
                        onClick={handleReset}
                        style={{
                          position: "absolute",
                          left: cx + r - 2,
                          top: cy - r - 2,
                          zIndex: 20,
                          width: 14,
                          height: 14,
                          borderRadius: "50%",
                          background: "#06b6d4",
                          color: "#fff",
                          border: "none",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          cursor: "pointer",
                          padding: 0,
                          fontSize: 8,
                          fontWeight: "bold",
                          pointerEvents: "all",
                        }}
                      >
                        ✦
                      </button>
                    );
                  })}

                  {/* Visual candidate dots — shown when Gemini returns 2-3 candidates requiring user selection.
                      All candidates (including #1) are shown as numbered dots; none are auto-persisted.
                      User must click a dot to confirm and persist the selected position. */}
                  {showOverlay && !drawMode && renderedW && renderedH && (
                    Array.from(visualCandidates.entries()).flatMap(([signId, allCandidates]) =>
                      allCandidates.map((c, idx) => {
                        const cx = c.x * renderedW;
                        const cy = c.y * renderedH;
                        const dotNumber = idx + 1; // all candidates are shown: #1, #2, #3
                        return (
                          <button
                            key={`vc-${signId}-${idx}`}
                            title={`AI suggestion ${dotNumber}: ${c.description ?? ""}\nConfidence: ${Math.round((c.confidence ?? 0) * 100)}%\nClick to confirm this position`}
                            onClick={() => confirmVisualPlacement(signId, c)}
                            style={{
                              position: "absolute",
                              left: cx - 16,
                              top: cy - 16,
                              width: 32,
                              height: 32,
                              zIndex: 15,
                              cursor: "pointer",
                              borderRadius: "50%",
                              border: `2px solid #06b6d4`,
                              background: "#06b6d422",
                              color: "#06b6d4",
                              fontFamily: "monospace",
                              fontWeight: "bold",
                              fontSize: 11,
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              pointerEvents: "all",
                            }}
                          >
                            {dotNumber}
                          </button>
                        );
                      })
                    )
                  )}

                  {/* Draw mode hint when hovering empty space */}
                  {drawMode && !hoveredMarkerId && renderedW && renderedH && (
                    <div
                      style={{
                        position: "absolute",
                        bottom: 8,
                        left: "50%",
                        transform: "translateX(-50%)",
                        zIndex: 10,
                        pointerEvents: "none",
                        background: "#a855f720",
                        color: "#a855f7",
                        border: "1px solid #a855f755",
                      }}
                      className="px-3 py-1.5 rounded-full text-[10px] font-bold uppercase tracking-wider shadow-lg whitespace-nowrap flex items-center gap-1"
                    >
                      <Plus className="w-3 h-3" />
                      Click to add a sign marker · hover to delete
                    </div>
                  )}

                  {/* Adding sign spinner */}
                  {addingSign && (
                    <div style={{ position: "absolute", inset: 0, zIndex: 15, display: "flex", alignItems: "center", justifyContent: "center", background: "#00000033" }}>
                      <Loader2 className="w-8 h-8 text-white animate-spin" />
                    </div>
                  )}

                  {/* Transparent click-capture overlay — handles view mode (select) and
                      draw mode (create / select). Also tracks hover for delete X. */}
                  {renderedW && renderedH && (
                    <div
                      style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        width: renderedW,
                        height: renderedH,
                        zIndex: 6,
                        cursor: addMode
                          ? (pendingNewMarker ? "default" : "crosshair")
                          : drawMode
                            ? (hoveredMarkerId ? "pointer" : "crosshair")
                            : (textMarkers.length > 0 ? "pointer" : "default"),
                      }}
                      onMouseMove={(e) => {
                        if (!renderedW || !renderedH) return;
                        const rect = e.currentTarget.getBoundingClientRect();
                        const nx = (e.clientX - rect.left) / renderedW;
                        const ny = (e.clientY - rect.top) / renderedH;
                        let best: TextMarker | null = null;
                        let bestDist = Infinity;
                        for (const m of textMarkers) {
                          const d = Math.hypot(m.x - nx, m.y - ny);
                          if (d < bestDist) { bestDist = d; best = m; }
                        }
                        setHoveredMarkerId(best && bestDist < 0.06 ? best.signId : null);
                      }}
                      onMouseLeave={() => setHoveredMarkerId(null)}
                      onClick={(e) => {
                        const rect = e.currentTarget.getBoundingClientRect();
                        const nx = (e.clientX - rect.left) / renderedW!;
                        const ny = (e.clientY - rect.top) / renderedH!;

                        // Add mode: drop a ghost pin then open the detail form
                        if (addMode) {
                          if (!pendingNewMarker) {
                            setPendingNewMarker({ nx, ny });
                          }
                          return;
                        }

                        if (drawMode) {
                          if (hoveredMarkerId) {
                            // Select the hovered marker (don't create a new one)
                            const found = allSigns.find((s) => s.id === hoveredMarkerId);
                            if (found) setActiveSign(found);
                          } else {
                            // Create new sign at click position via guided form
                            setPendingNewMarker({ nx, ny });
                            setAddMode(true);
                            setDrawMode(false);
                          }
                          return;
                        }

                        // View mode: select nearest sign
                        if (textMarkers.length === 0) return;
                        let best: TextMarker | null = null;
                        let bestDist = Infinity;
                        for (const m of textMarkers) {
                          const d = Math.hypot(m.x - nx, m.y - ny);
                          if (d < bestDist) { bestDist = d; best = m; }
                        }
                        if (best && bestDist < 0.20) {
                          const found = allSigns.find((s) => s.id === best!.signId);
                          if (found) setActiveSign(found);
                        }
                      }}
                    />
                  )}
              </div>
            )}
            </div>{/* end centering wrapper */}
          </div>
        </div>

        {/* Right: Edit form */}
        <div className="w-[380px] flex-shrink-0 flex flex-col bg-background overflow-hidden">
          <div className="flex-none px-5 py-3 border-b border-border bg-card">
            <h2 className="text-sm font-display font-bold uppercase tracking-wider text-foreground">
              Edit Sign Data
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Correct any fields extracted by AI
            </p>
          </div>

          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
            {/* Location source status banner — inside scroll so it doesn't compress the form */}
            {textSearchStatus === "not-found" && (
              <div className="flex items-start gap-2 text-xs bg-destructive/10 border border-destructive/20 rounded-lg px-3 py-2.5 text-destructive">
                <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                <div>
                  <span className="font-semibold">Location not found on this page.</span>
                  <br />
                  The text &ldquo;{activeSign.location ?? activeSign.messageContent ?? "?"}&rdquo; was not found
                  in this page&rsquo;s text layer. This sign may have been attributed to the wrong
                  page by the AI. Verify the location and correct it if needed.
                </div>
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <Field
                label="Sheet Number"
                value={form.sheetNumber}
                onChange={(v) => handleField("sheetNumber", v)}
                placeholder="A-101"
              />
              <Field
                label="Sign ID / Ref"
                value={form.signIdentifier}
                onChange={(v) => handleField("signIdentifier", v)}
                placeholder="S-01"
              />
            </div>

            <Field
              label="Sign Type"
              value={form.signType}
              onChange={(v) => handleField("signType", v)}
              placeholder="e.g. Illuminated Cabinet Sign"
            />

            <div className="grid grid-cols-2 gap-3">
              <Field
                label="Quantity"
                value={form.quantity}
                onChange={(v) => handleField("quantity", v)}
                placeholder="1"
                type="number"
              />
              <Field
                label="Detail Reference"
                value={form.detailReference}
                onChange={(v) => handleField("detailReference", v)}
                placeholder="D-01"
              />
            </div>

            <Field
              label="Location"
              value={form.location}
              onChange={(v) => handleField("location", v)}
              placeholder="e.g. North elevation, above main entrance"
              multiline
            />

            <Field
              label="Dimensions"
              value={form.dimensions}
              onChange={(v) => handleField("dimensions", v)}
              placeholder='e.g. 48" × 24"'
            />

            <div className="grid grid-cols-2 gap-3">
              <Field
                label="Mounting Type"
                value={form.mountingType}
                onChange={(v) => handleField("mountingType", v)}
                placeholder="e.g. Wall mounted"
              />
              <Field
                label="Illumination"
                value={form.illumination}
                onChange={(v) => handleField("illumination", v)}
                placeholder="e.g. LED backlit"
              />
            </div>

            <Field
              label="Finish / Color"
              value={form.finishColor}
              onChange={(v) => handleField("finishColor", v)}
              placeholder="e.g. Matte black, white face"
            />

            <Field
              label="Materials"
              value={form.materials}
              onChange={(v) => handleField("materials", v)}
              placeholder="e.g. Aluminum, acrylic face"
            />

            <Field
              label="Message / Copy"
              value={form.messageContent}
              onChange={(v) => handleField("messageContent", v)}
              placeholder="Text displayed on the sign"
              multiline
            />

            <Field
              label="Notes"
              value={form.notes}
              onChange={(v) => handleField("notes", v)}
              placeholder="Any additional notes or clarifications"
              multiline
            />

            <label className="flex items-center gap-3 cursor-pointer group">
              <div className="relative">
                <input
                  type="checkbox"
                  checked={form.reviewFlag}
                  onChange={(e) => handleField("reviewFlag", e.target.checked)}
                  className="sr-only peer"
                />
                <div className="w-9 h-5 bg-secondary rounded-full peer-checked:bg-primary transition-colors"></div>
                <div className="absolute top-0.5 left-0.5 w-4 h-4 bg-background rounded-full shadow transition-transform peer-checked:translate-x-4"></div>
              </div>
              <span className="text-sm text-muted-foreground group-hover:text-foreground transition-colors">
                Flag for review
              </span>
            </label>
          </div>

          {/* Footer */}
          <div className="flex-none px-5 py-4 border-t border-border bg-card space-y-2">
            {saveError && (
              <div className="text-xs text-destructive bg-destructive/10 border border-destructive/20 rounded px-3 py-2">
                {saveError}
              </div>
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
                {saving ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Save className="w-4 h-4" />
                )}
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
      </div>

      {/* Add-marker detail form — opens after clicking to place a ghost pin */}
      {pendingNewMarker && file && (
        <AddMarkerForm
          pending={{
            xPos: pendingNewMarker.nx,
            yPos: pendingNewMarker.ny,
            pageNumber,
            jobFileId: file.id,
            jobId,
          }}
          onSave={(sign) => {
            setLocalSigns((prev) => [...prev, sign]);
            setActiveSign(sign);
            onSignAdded?.(sign);
            setPendingNewMarker(null);
            setAddMode(false);
          }}
          onCancel={() => {
            setPendingNewMarker(null);
            // Keep addMode active so user can try a different spot
          }}
        />
      )}
    </div>
  );
}

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
