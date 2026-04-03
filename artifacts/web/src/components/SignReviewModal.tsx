import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import { apiFetch } from "@/lib/apiClient";
import { usePdfBlob } from "@/hooks/use-pdf-blob";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
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
} from "lucide-react";

pdfjs.GlobalWorkerOptions.workerSrc = `${import.meta.env.BASE_URL}pdf.worker.min.mjs`;

interface ExtractedSign {
  id: string;
  jobId?: string;
  jobFileId?: string | null;
  sheetNumber?: string | null;
  detailReference?: string | null;
  signType?: string | null;
  signIdentifier?: string | null;
  quantity?: number | null;
  location?: string | null;
  dimensions?: string | null;
  mountingType?: string | null;
  finishColor?: string | null;
  illumination?: string | null;
  materials?: string | null;
  messageContent?: string | null;
  notes?: string | null;
  pageNumber?: number | null;
  xPos?: number | null;
  yPos?: number | null;
  manuallyAdded?: boolean;
  userVerified?: boolean;
  confidenceScore: number;
  reviewFlag: boolean;
}

interface PageStats {
  floorPlanPages: number[];
  signSchedulePages: number[];
  otherPages: number[];
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

// ─── Text-item type from pdfjs ─────────────────────────────────────────────

interface PdfTextItem {
  str: string;
  transform: [number, number, number, number, number, number];
  width: number;
  height: number;
}

interface TextMarker {
  x: number; // 0–1 fraction of page width
  y: number; // 0–1 fraction of page height (top-down)
  signId: string;
  color: string;
  label: string;
  isCurrent: boolean;
}

/** Tokenize a string into searchable words (len ≥ 2, deduplicated) */
function tokenize(text: string | null | undefined): string[] {
  if (!text) return [];
  return [...new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 2)
  )];
}

/**
 * Build a spatial text index from PDF text items.
 * CAD PDFs (Revit/AutoCAD) often fragment words into individual characters.
 * This groups items into "runs" on the same baseline, concatenates them,
 * and returns a searchable structure with a representative item for position.
 */
interface TextRun {
  text: string;         // concatenated text of the run
  item: PdfTextItem;    // first item in run (for coordinates)
  midX: number;         // average X of all items in run
  midY: number;         // average Y of all items in run
}

function buildTextRuns(items: PdfTextItem[]): TextRun[] {
  if (items.length === 0) return [];

  // Sort by Y descending (top of page first), then X ascending
  const sorted = [...items]
    .filter((it) => it.str.trim())
    .sort((a, b) => {
      const ay = a.transform[5]!;
      const by_ = b.transform[5]!;
      if (Math.abs(ay - by_) > 4) return by_ - ay;       // different lines
      return a.transform[4]! - b.transform[4]!;           // same line → left to right
    });

  const runs: TextRun[] = [];
  let current: { text: string; items: PdfTextItem[] } | null = null;

  for (const item of sorted) {
    if (!current) {
      current = { text: item.str, items: [item] };
      continue;
    }

    const prevY = current.items[current.items.length - 1]!.transform[5]!;
    const prevX = current.items[current.items.length - 1]!.transform[4]!;
    const prevW = current.items[current.items.length - 1]!.width ?? 8;
    const currY = item.transform[5]!;
    const currX = item.transform[4]!;

    // Same baseline (within 3 pts) and horizontally adjacent (gap < 3× prev char width)
    const sameLine = Math.abs(currY - prevY) <= 3;
    const adjacent = currX - (prevX + prevW) < prevW * 3;

    if (sameLine && adjacent) {
      current.text += item.str;
      current.items.push(item);
    } else {
      // Flush current run
      const xs = current.items.map((i) => i.transform[4]!);
      const ys = current.items.map((i) => i.transform[5]!);
      runs.push({
        text: current.text,
        item: current.items[0]!,
        midX: xs.reduce((a, b) => a + b, 0) / xs.length,
        midY: ys.reduce((a, b) => a + b, 0) / ys.length,
      });
      current = { text: item.str, items: [item] };
    }
  }

  if (current) {
    const xs = current.items.map((i) => i.transform[4]!);
    const ys = current.items.map((i) => i.transform[5]!);
    runs.push({
      text: current.text,
      item: current.items[0]!,
      midX: xs.reduce((a, b) => a + b, 0) / xs.length,
      midY: ys.reduce((a, b) => a + b, 0) / ys.length,
    });
  }

  return runs;
}

/**
 * Given the text items from a PDF page and a sign, find the best matching
 * location on the page. Returns normalized (0–1) coordinates or null.
 *
 * Handles two common CAD PDF formats:
 *  1. Word-per-item  — standard PDF text; matched via token search on each item
 *  2. Char-per-item  — Revit/AutoCAD fragmentation; matched by first grouping
 *                      adjacent glyphs into runs, then searching within runs
 */
function normId(s: string): string {
  return s.toLowerCase().replace(/[\s\-_]/g, "");
}

/** True when `needle` appears in `haystack` but is NOT part of a longer alphanumeric run */
function exactBoundaryMatch(haystack: string, needle: string): boolean {
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    const before = idx > 0 ? haystack[idx - 1] : null;
    const after = idx + needle.length < haystack.length ? haystack[idx + needle.length] : null;
    const validBefore = before == null || !/[a-z0-9]/.test(before);
    const validAfter = after == null || !/[a-z0-9]/.test(after);
    if (validBefore && validAfter) return true;
    idx = haystack.indexOf(needle, idx + 1);
  }
  return false;
}

function findSignLocation(
  items: PdfTextItem[],
  pageW: number,
  pageH: number,
  sign: ExtractedSign
): { x: number; y: number; matched: string } | null {

  const _debugSign = ["RI-56", "RI-57", "RI-01", "RI-07", "EL-01"].includes(sign.signIdentifier ?? "");

  // ── Pass 0: exact normalized identifier match ─────────────────────────────
  // Sign identifiers like "RI-56" or "EL-04" appear in TWO places on a plan:
  //   1. The callout bubble at the unit door (the CORRECT position)
  //   2. A sign schedule table listing all signs on the sheet (WRONG position)
  // We collect ALL occurrences first. If exactly ONE is found, it's the callout
  // → use it. If multiple are found, we can't reliably tell callout from schedule
  // → fall through to room-number matching instead.
  if (sign.signIdentifier && sign.signIdentifier.length >= 3) {
    const idNorm = normId(sign.signIdentifier);
    if (idNorm.length >= 3) {
      type IdHit = { x: number; y: number };
      const idHits: IdHit[] = [];

      // 0a: search individual items
      for (const item of items) {
        if (!item.str.trim()) continue;
        if (exactBoundaryMatch(normId(item.str), idNorm)) {
          const [, , , , tx, ty] = item.transform;
          idHits.push({
            x: Math.min(1, Math.max(0, tx / pageW)),
            y: Math.min(1, Math.max(0, 1 - ty / pageH)),
          });
        }
      }

      // 0b: search text runs if nothing found via items
      if (idHits.length === 0) {
        const runsEarly = buildTextRuns(items);
        for (const run of runsEarly) {
          if (exactBoundaryMatch(normId(run.text), idNorm)) {
            idHits.push({
              x: Math.min(1, Math.max(0, run.midX / pageW)),
              y: Math.min(1, Math.max(0, 1 - run.midY / pageH)),
            });
          }
        }
      }

      if (_debugSign) console.log(`[DBG] P0 ${sign.signIdentifier} idHits=${idHits.length}`, idHits.map(h => `(${h.x.toFixed(3)},${h.y.toFixed(3)})`));

      // Only trust the identifier if it appears exactly once — that's the callout.
      // Multiple occurrences mean schedule + callout; we can't tell them apart.
      if (idHits.length === 1) {
        return { x: idHits[0]!.x, y: idHits[0]!.y, matched: sign.signIdentifier };
      }
    }
  }

  // ── Pass 1: room/unit number search from location field ──────────────────
  // Room numbers like "A101", "B203", "101B" are specific labels visible on
  // each unit door on the floor plan. We extract these tokens from the location
  // field and search the text layer.
  //
  // Key subtleties handled here:
  //   - CAD PDFs often label units as "B101B" (building prefix + room) while
  //     Gemini extracts just "101B". We allow a SINGLE letter building prefix
  //     so "b101b" matches token "101b".
  //   - Dimension annotations like "134'-4"" give pure-numeric token "134".
  //     We REQUIRE at least one letter in the token to skip these.
  //   - Tokens appearing > 2 times are non-unique (e.g., a corridor type code
  //     that repeats), so we skip them → no marker rather than a wrong one.
  //   - When 2 hits exist (schedule + floor plan), we prefer the hit that is
  //     NOT in the top 15% of the page (title block / schedule area).

  // Returns true if itemNorm is an exact match or differs from tokenNorm by
  // exactly one leading letter (handles building-prefix labels like "b101b").
  function roomMatch(itemNorm: string, tokenNorm: string): boolean {
    if (exactBoundaryMatch(itemNorm, tokenNorm)) return true;
    // Allow one leading letter prefix (e.g. "b101b" matching "101b")
    if (
      itemNorm.length === tokenNorm.length + 1 &&
      /^[a-z]/.test(itemNorm) &&
      itemNorm.slice(1) === tokenNorm
    )
      return true;
    return false;
  }

  // Detect if a hit is inside a sign-schedule TABLE COLUMN rather than an
  // isolated floor-plan unit label.
  //
  // Key observation: schedule table rows are packed tight (~0.5–1.5% y-apart).
  // Floor-plan unit labels are spread out (each unit takes 3–7% of page height).
  //
  // Strategy: for the hit position (hx, hy), count how many OTHER room-number-
  // pattern text items are in the same NARROW x-band (±2%) AND within a CLOSE
  // y-range (0.5%–2%) — indicating adjacent schedule rows. If 2 or more such
  // tightly-packed neighbours exist → the hit is in a schedule column → skip.
  //
  // This is immune to stairwell labels (AS2-1, BS2-1) and other false triggers
  // because those labels don't cluster into tight columns of room numbers.
  const ROOM_NUM_RE = /^(?:[a-z]{1,2}\d{2,4}[a-z]?|\d{2,4}[a-z]{1,2})$/;
  function isInScheduleColumn(hx: number, hy: number, debug = false): boolean {
    const X_TOL = 0.025; // ±2.5% x = same column
    const Y_MIN = 0.004; // skip items at essentially the same y (same item)
    const Y_CLOSE = 0.025; // within 2.5% y = tightly-packed schedule row
    let closeCount = 0;
    for (const item of items) {
      if (!item.str.trim()) continue;
      const iNorm = normId(item.str);
      if (!ROOM_NUM_RE.test(iNorm)) continue;
      const [, , , , tx, ty] = item.transform;
      const ix = tx / pageW;
      const iy = 1 - ty / pageH;
      const dx = Math.abs(ix - hx);
      const dy = Math.abs(iy - hy);
      if (dx <= X_TOL && dy > Y_MIN && dy <= Y_CLOSE) {
        closeCount++;
        if (debug) console.log(`[DBG]   → close column neighbour: "${item.str}" norm="${iNorm}" @(${ix.toFixed(3)},${iy.toFixed(3)}) dy=${dy.toFixed(3)}`);
      }
    }
    return closeCount >= 2; // 2+ tightly-spaced room numbers → schedule table
  }

  const locationSource = [sign.location, sign.messageContent].filter(Boolean).join(" ");
  if (locationSource) {
    // Extract tokens that contain BOTH letters and digits — this filters out
    // pure-numeric dimension values (e.g. "134") while keeping "101B", "A105".
    const roomTokens = (
      locationSource.match(/\b(?:[A-Za-z]{1,2}\d{2,4}[A-Za-z]?|\d{2,4}[A-Za-z]{1,2})\b/g) ?? []
    )
      .filter((t) => t.length >= 3)
      .sort((a, b) => b.length - a.length); // longest (most specific) first

    const runsForRoom = buildTextRuns(items);

    if (_debugSign) console.log(`[DBG] P1 ${sign.signIdentifier} tokens=`, roomTokens, `loc="${locationSource}"`);

    for (const token of roomTokens) {
      const tokenNorm = normId(token);
      type RoomHit = { x: number; y: number; raw: string };
      const hits: RoomHit[] = [];

      // Search individual items
      for (const item of items) {
        if (!item.str.trim()) continue;
        const iNorm = normId(item.str);
        if (roomMatch(iNorm, tokenNorm)) {
          const [, , , , tx, ty] = item.transform;
          hits.push({
            x: Math.min(1, Math.max(0, tx / pageW)),
            y: Math.min(1, Math.max(0, 1 - ty / pageH)),
            raw: item.str,
          });
        }
      }

      // Search text runs (per-character CAD fragmentation)
      if (hits.length === 0) {
        for (const run of runsForRoom) {
          const rNorm = normId(run.text);
          if (roomMatch(rNorm, tokenNorm)) {
            hits.push({
              x: Math.min(1, Math.max(0, run.midX / pageW)),
              y: Math.min(1, Math.max(0, 1 - run.midY / pageH)),
              raw: run.text,
            });
          }
        }
      }

      if (hits.length === 0 || hits.length > 2) continue; // not found or too ambiguous

      // ── Schedule-table detection ───────────────────────────────────────────
      // Use the dense-column detector: if the hit has 2+ tightly-packed room
      // numbers in the same x-band → it's in a schedule column → skip.
      const floorPlanHits = hits.filter((h) => {
        const inSchedule = isInScheduleColumn(h.x, h.y, _debugSign);
        if (_debugSign) console.log(`[DBG]   token="${token}" hit"${h.raw}"@(${h.x.toFixed(3)},${h.y.toFixed(3)}) inSchedule=${inSchedule}`);
        return !inSchedule;
      });

      if (floorPlanHits.length === 0) continue; // all hits are in schedule rows → skip

      // Among floor-plan hits, if 2 exist prefer non-top-15%
      const preferred =
        floorPlanHits.length === 2
          ? (floorPlanHits.find((h) => h.y > 0.15) ?? floorPlanHits[0]!)
          : floorPlanHits[0]!;

      return { x: preferred.x, y: preferred.y, matched: token };
    }
  }

  // ── No reliable position found — return null (no marker) ─────────────────
  // Better to show no dot than a wrong one. The sign row will still appear
  // in the review table; the user can manually click to place it.
  return null;
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
  const rawPdfApiUrl = file ? `/api/jobs/${jobId}/files/${file.id}/pdf` : null;
  const { pdfBuffer, blobError: pdfLoadError } = usePdfBlob(rawPdfApiUrl);
  // Stable flag: true once data is ready, false while loading or if no file.
  const pdfReady = !!pdfBuffer;
  // Memoized react-pdf file object — creates a fresh copy from the stored ArrayBuffer
  // so react-pdf's internal postMessage transfer never detaches our state reference.
  const pdfFile = useMemo(
    () => (pdfBuffer ? { data: new Uint8Array(pdfBuffer.slice(0)) } : null),
    [pdfBuffer]
  );

  const [numPages, setNumPages] = useState<number | null>(null);
  const [pageNumber, setPageNumber] = useState(sign.pageNumber ?? 1);
  const [scale, setScale] = useState(1.0);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const pdfContainerRef = useRef<HTMLDivElement>(null);

  // activeSign tracks which sign is currently being edited — starts as the
  // prop but can change when the user clicks a marker on the PDF.
  const [activeSign, setActiveSign] = useState<ExtractedSign>(sign);

  const [form, setForm] = useState<FormState>(() => signToForm(sign));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  // ── Highlight / marker state ────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [pdfDoc, setPdfDoc] = useState<any | null>(null);
  const [textMarkers, setTextMarkers] = useState<TextMarker[]>([]);
  const [nativeSize, setNativeSize] = useState<{ w: number; h: number } | null>(null);

  // Auto-fit scale to container width when the page dimensions become known
  useEffect(() => {
    if (!nativeSize || !pdfContainerRef.current) return;
    const containerW = pdfContainerRef.current.clientWidth - 32; // subtract padding
    if (containerW > 0) {
      const fit = containerW / nativeSize.w;
      setScale(Math.min(1.2, Math.max(0.3, fit)));
    }
  // Only run when native width first becomes known or changes (new page/doc)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nativeSize?.w]);
  const [textSearchStatus, setTextSearchStatus] = useState<"idle" | "found" | "not-found">("idle");
  const [showOverlay, setShowOverlay] = useState(true);
  const [drawMode, setDrawMode] = useState(false);
  const [hoveredMarkerId, setHoveredMarkerId] = useState<string | null>(null);
  const [addingSign, setAddingSign] = useState(false);

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

  // Load PDF document for text extraction (separate from react-pdf rendering).
  // Uses state (not a ref) so that the text-extraction effect re-runs once the
  // async load completes. We pass a copy of pdfData so pdfjs can transfer the
  // underlying ArrayBuffer without affecting the copy used by react-pdf.
  useEffect(() => {
    if (!pdfBuffer) return;
    setPdfDoc(null);
    let destroyed = false;
    // Fresh Uint8Array copy — pdfjs transfers the underlying ArrayBuffer, so we
    // must never pass the same buffer reference that react-pdf already consumed.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const task = (pdfjs as any).getDocument({ data: new Uint8Array(pdfBuffer.slice(0)) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    task.promise.then((doc: any) => {
      if (!destroyed) setPdfDoc(doc);
    }).catch(() => { /* silently ignore extraction errors */ });
    return () => {
      destroyed = true;
      task.destroy?.();
    };
  }, [pdfBuffer]);

  // Extract text items for the current page and compute markers.
  // activeSign.id is in deps so re-runs when user clicks a marker, recomputing
  // colors (green for active, yellow for others) without ever clearing them first.
  useEffect(() => {
    if (!pdfDoc) {
      setTextMarkers([]);
      setTextSearchStatus("idle");
      return;
    }
    if (signsOnCurrentPage.length === 0) {
      setTextMarkers([]);
      setTextSearchStatus("idle");
      return;
    }

    let cancelled = false;

    pdfDoc.getPage(pageNumber).then((page: { getViewport: (o: { scale: number }) => { width: number; height: number }; getTextContent: () => Promise<{ items: PdfTextItem[] }> }) => {
      if (cancelled) return;
      const viewport = page.getViewport({ scale: 1.0 });
      const pageW = viewport.width;
      const pageH = viewport.height;

      setNativeSize({ w: pageW, h: pageH });

      page.getTextContent().then((content) => {
        if (cancelled) return;

        const markers: TextMarker[] = [];
        let currentSignFound = false;

        for (const s of signsOnCurrentPage) {
          const isCurrent = s.id === activeSign.id;
          const color = isCurrent ? "#22c55e" : (s.manuallyAdded ? "#a855f7" : "#eab308");

          // Only use stored coordinates for manually-placed markers.
          // AI-extracted signs run text search (stored coords from visual extraction
          // are unreliable Gemini guesses — text search is far more accurate).
          if (s.manuallyAdded && s.xPos != null && s.yPos != null) {
            markers.push({
              x: s.xPos,
              y: s.yPos,
              signId: s.id,
              color,
              label: s.signIdentifier ?? s.signType?.slice(0, 6) ?? "NEW",
              isCurrent,
            });
            if (isCurrent) currentSignFound = true;
            continue;
          }

          const loc = findSignLocation(content.items, pageW, pageH, s);
          if (loc) {
            markers.push({
              x: loc.x,
              y: loc.y,
              signId: s.id,
              color,
              label: s.signIdentifier ?? s.signType?.slice(0, 6) ?? "SIGN",
              isCurrent,
            });
            if (isCurrent) currentSignFound = true;
          }
        }

        // If the active sign is on this page but we couldn't locate it, add a
        // ghost marker at the top-center so the user still sees a green dot.
        if (!currentSignFound && signsOnCurrentPage.some((s) => s.id === activeSign.id)) {
          markers.push({
            x: 0.5,
            y: 0.08,
            signId: activeSign.id,
            color: "#22c55e",
            label: "?",
            isCurrent: true,
          });
        }

        // ── Cluster deduplication: spread markers that landed at the same
        // position into a small circle so they remain individually clickable.
        // This handles residual cases where text-search still finds the same
        // PDF text item for multiple signs (e.g., a legend row that appears
        // multiple times in the text layer at exactly the same coordinate).
        const CLUSTER_EPS = 0.015; // ~1.5% of page width/height
        const posGroups = new Map<string, number[]>();
        markers.forEach((m, i) => {
          const key = `${Math.round(m.x / CLUSTER_EPS)},${Math.round(m.y / CLUSTER_EPS)}`;
          if (!posGroups.has(key)) posGroups.set(key, []);
          posGroups.get(key)!.push(i);
        });
        for (const indices of posGroups.values()) {
          if (indices.length <= 1) continue;
          const cx = markers[indices[0]!]!.x;
          const cy = markers[indices[0]!]!.y;
          const radius = Math.min(0.04, 0.015 + 0.003 * (indices.length - 2)); // capped at 4% of page
          indices.forEach((idx, k) => {
            const angle = (2 * Math.PI * k) / indices.length - Math.PI / 2;
            markers[idx]!.x = Math.min(1, Math.max(0, cx + radius * Math.cos(angle)));
            markers[idx]!.y = Math.min(1, Math.max(0, cy + radius * Math.sin(angle)));
          });
        }

        setTextMarkers(markers);
        if (signsOnCurrentPage.some((s) => s.id === activeSign.id)) {
          setTextSearchStatus(currentSignFound ? "found" : "not-found");
        } else {
          setTextSearchStatus("idle");
        }
      });
    });

    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfDoc, pageNumber, sign.id, signsOnCurrentPage.length, activeSign.id]);

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

  const confidence = Math.round(activeSign.confidenceScore * 100);
  const confColor =
    confidence >= 80
      ? "text-accent"
      : confidence >= 60
      ? "text-primary"
      : "text-destructive";

  // Rendered page size = native size × scale
  const renderedW = nativeSize ? nativeSize.w * scale : null;
  const renderedH = nativeSize ? nativeSize.h * scale : null;

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
        {/* Left: PDF Viewer */}
        <div className="flex-1 flex flex-col bg-secondary/30 border-r border-border min-w-0">
          {/* PDF toolbar */}
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
              {numPages ? `${pageNumber} / ${numPages}` : "—"}
            </span>
            <button
              aria-label="Next page"
              disabled={numPages === null || pageNumber >= numPages}
              onClick={() => setPageNumber((p) => (numPages ? Math.min(numPages, p + 1) : p))}
              className="p-1.5 rounded hover:bg-secondary disabled:opacity-30 transition-colors"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
            <div className="w-px h-4 bg-border mx-1" />
            <button
              onClick={() => setScale((s) => Math.max(0.4, s - 0.15))}
              disabled={scale <= 0.4}
              className="p-1.5 rounded hover:bg-secondary disabled:opacity-30 transition-colors"
            >
              <ZoomOut className="w-4 h-4" />
            </button>
            <span className="text-xs font-mono text-muted-foreground w-12 text-center">
              {Math.round(scale * 100)}%
            </span>
            <button
              onClick={() => setScale((s) => Math.min(2.5, s + 0.15))}
              disabled={scale >= 2.5}
              className="p-1.5 rounded hover:bg-secondary disabled:opacity-30 transition-colors"
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

            {/* Overlay toggle + draw mode — pushed to right */}
            <div className="ml-auto flex items-center gap-2">
              {textMarkers.length > 0 && (
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
                  {textMarkers.length} marker{textMarkers.length !== 1 ? "s" : ""}
                </button>
              )}
              {/* Draw mode toggle */}
              {pdfReady && (
                <button
                  onClick={() => setDrawMode((v) => !v)}
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
                  title={drawMode ? "Exit draw mode" : "Enter draw mode: click to add markers, X to delete"}
                >
                  {drawMode ? <PenLine className="w-3 h-3" /> : <MousePointer className="w-3 h-3" />}
                  {drawMode ? "Draw" : "Edit Markers"}
                </button>
              )}
            </div>

            {/* Signs on current page chips — click to switch active sign */}
            {signsOnCurrentPage.length > 0 && (
              <div className="flex items-center gap-1.5 ml-2 overflow-x-auto max-w-[320px]">
                {signsOnCurrentPage.map((s) => {
                  const isActive = s.id === activeSign.id;
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
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* PDF canvas + overlay */}
          <div ref={pdfContainerRef} className="flex-1 overflow-auto p-4 flex justify-center items-start">
            {rawPdfApiUrl && !pdfReady && !pdfLoadError && (
              <div className="flex items-center justify-center h-64">
                <Loader2 className="w-8 h-8 text-primary animate-spin" />
              </div>
            )}
            {pdfLoadError && !pdfReady && (
              <div className="flex flex-col items-center justify-center h-64 text-destructive gap-2">
                <AlertTriangle className="w-8 h-8" />
                <p className="text-sm">Failed to load PDF</p>
                <p className="text-xs opacity-70">{pdfLoadError}</p>
              </div>
            )}
            {pdfReady ? (
              <Document
                file={pdfFile}
                onLoadSuccess={({ numPages }) => {
                  setNumPages(numPages);
                  setPdfError(null);
                }}
                onLoadError={(err) => setPdfError(err.message)}
                loading={
                  <div className="flex items-center justify-center h-64">
                    <Loader2 className="w-8 h-8 text-primary animate-spin" />
                  </div>
                }
                error={
                  <div className="flex flex-col items-center justify-center h-64 text-destructive gap-2">
                    <AlertTriangle className="w-8 h-8" />
                    <p className="text-sm">Failed to load PDF</p>
                    {pdfError && <p className="text-xs opacity-70">{pdfError}</p>}
                  </div>
                }
              >
                {/* Wrap page + overlay in a relative container */}
                <div className="relative shadow-2xl inline-block">
                  <Page
                    pageNumber={pageNumber}
                    scale={scale}
                    renderTextLayer={true}
                    renderAnnotationLayer={true}
                  />

                  {/* Sign schedule page notice — only show when no markers found AND page is classified as schedule */}
                  {isSignSchedulePage && textMarkers.length === 0 && (
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

                  {/* SVG marker overlay — visual only, above react-pdf text layer */}
                  {showOverlay && textMarkers.length > 0 && renderedW && renderedH && (
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
                      {textMarkers.map((m) => {
                        const cx = m.x * renderedW;
                        const cy = m.y * renderedH;
                        const r = m.isCurrent ? 18 : 12;
                        const isHovered = m.signId === hoveredMarkerId;
                        return (
                          <g key={m.signId}>
                            {/* Outer glow ring for active sign */}
                            {m.isCurrent && (
                              <circle
                                cx={cx} cy={cy} r={r + 6}
                                fill="none" stroke={m.color}
                                strokeWidth={1.5} strokeDasharray="4 3"
                                opacity={0.7}
                              />
                            )}
                            {/* Hover ring */}
                            {isHovered && !m.isCurrent && (
                              <circle
                                cx={cx} cy={cy} r={r + 5}
                                fill="none" stroke={m.color}
                                strokeWidth={1} opacity={0.5}
                              />
                            )}
                            {/* Filled circle */}
                            <circle
                              cx={cx} cy={cy} r={r}
                              fill={`${m.color}33`} stroke={m.color}
                              strokeWidth={m.isCurrent ? 2.5 : 1.5}
                            />
                            {/* Pin dot */}
                            <circle cx={cx} cy={cy} r={3} fill={m.color} />
                            {/* Label */}
                            <text
                              x={cx} y={cy - r - 5}
                              textAnchor="middle" fill={m.color}
                              fontSize={m.isCurrent ? 10 : 8}
                              fontWeight="bold" fontFamily="monospace"
                              style={{ userSelect: "none" }}
                            >
                              {m.label}
                            </text>
                          </g>
                        );
                      })}
                    </svg>
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
                        cursor: drawMode
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

                        if (drawMode) {
                          if (hoveredMarkerId) {
                            // Select the hovered marker (don't create a new one)
                            const found = allSigns.find((s) => s.id === hoveredMarkerId);
                            if (found) setActiveSign(found);
                          } else {
                            // Create new sign at click position
                            handleCreateSign(nx, ny);
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
              </Document>
            ) : (
              <div className="flex flex-col items-center justify-center h-64 text-muted-foreground gap-3">
                <FileText className="w-12 h-12 opacity-30" />
                <p className="text-sm">No source file linked to this sign entry</p>
              </div>
            )}
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
