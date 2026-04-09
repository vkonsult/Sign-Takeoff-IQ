import fs from "fs/promises";

export interface PdfPhrase {
  text: string;
  x0: number; // 0–1 normalized left edge
  y0: number; // 0–1 normalized top edge   (top-down: 0 = top of page)
  x1: number; // 0–1 normalized right edge
  y1: number; // 0–1 normalized bottom edge (top-down: 1 = bottom of page)
}

export interface PageWords {
  pageWidth: number;  // visual page width  in viewport pts (rotation-adjusted)
  pageHeight: number; // visual page height in viewport pts (rotation-adjusted)
  phrases: PdfPhrase[];
}

// ── Typed interfaces for pdfjs-dist objects we interact with ─────────────
// We define our own narrow interfaces rather than relying on the full
// pdfjs-dist type package, which has a different shape for the legacy build.

interface PdfjsTextItem {
  str: string;
  transform: [number, number, number, number, number, number];
  width: number;
  height: number;
}

interface PdfjsTextContent {
  items: Array<PdfjsTextItem | Record<string, unknown>>;
}

interface PdfjsViewport {
  width: number;
  height: number;
  /**
   * Converts a point from PDF user space to viewport (screen) space.
   * Handles page rotation so the returned [vx, vy] is always in the
   * visually-correct coordinate system: vx increases rightward,
   * vy increases downward from the top-left of the rendered page.
   */
  convertToViewportPoint(x: number, y: number): [number, number];
}

interface PdfjsPage {
  getViewport(opts: { scale: number }): PdfjsViewport;
  getTextContent(): Promise<PdfjsTextContent>;
}

interface PdfjsDocument {
  numPages: number;
  getPage(num: number): Promise<PdfjsPage>;
  destroy(): void;
}

interface PdfjsGetDocumentTask {
  promise: Promise<PdfjsDocument>;
}

interface PdfjsGetDocumentOpts {
  data: Uint8Array;
  disableAutoFetch: boolean;
  disableStream: boolean;
}

interface PdfjsLib {
  getDocument(opts: PdfjsGetDocumentOpts): PdfjsGetDocumentTask;
  GlobalWorkerOptions: { workerSrc: string };
}

// ── In-memory phrase cache keyed by `fileId:pageNum` ─────────────────────
// This is a process-level (module-singleton) cache, not a per-request cache.
// Phrases are stable for a given PDF page, so caching across requests is safe
// and avoids re-parsing on every navigation page-turn in the UI.
const phraseCache = new Map<string, PageWords>();

// ── pdfjs-dist lazy loader ────────────────────────────────────────────────
// Must use the "legacy" build in Node.js — the standard build references
// browser-only APIs (DOMMatrix, CanvasRenderingContext2D, …) at module
// load time.  The legacy build ships Node.js-compatible polyfills.
let pdfjsLib: PdfjsLib | null = null;

async function getPdfjs(): Promise<PdfjsLib> {
  if (pdfjsLib) return pdfjsLib;

  // Dynamic import resolved at runtime — the legacy build is a sibling of the
  // main pdfjs-dist package entry and is guaranteed present for pdfjs-dist ≥ 4.
  const imported = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const lib = imported as unknown as PdfjsLib;

  // Configure worker for Node.js once.
  // We use the globalThis.require injected by the esbuild banner to resolve
  // the worker path inside node_modules — this avoids hard-coding any path.
  try {
    // The esbuild build banner injects: globalThis.require = createRequire(import.meta.url)
    const req = (globalThis as Record<string, unknown>)["require"] as (NodeRequire & { resolve: (id: string) => string }) | undefined;
    if (req?.resolve) {
      const workerPath = req.resolve("pdfjs-dist/legacy/build/pdf.worker.min.mjs");
      lib.GlobalWorkerOptions.workerSrc = `file://${workerPath}`;
    }
  } catch {
    // Fallback: empty string → pdfjs uses synchronous in-process mode
    lib.GlobalWorkerOptions.workerSrc = "";
  }

  pdfjsLib = lib;
  return lib;
}

// ── Type guard: distinguishes real TextItem from TextMarkedContent ────────
function isTextItem(item: PdfjsTextItem | Record<string, unknown>): item is PdfjsTextItem {
  return (
    typeof (item as PdfjsTextItem).str === "string" &&
    Array.isArray((item as PdfjsTextItem).transform) &&
    typeof (item as PdfjsTextItem).width === "number"
  );
}

// ── Core extractor ────────────────────────────────────────────────────────

/**
 * Extract text phrases with bounding boxes from a single PDF page.
 * Items on the same baseline that are horizontally adjacent are merged
 * into a single phrase so that fragmented CAD text ("U","N","I","T") is
 * reassembled into one searchable unit.
 *
 * All coordinates are normalised to [0, 1] with origin at the TOP-LEFT of
 * the page (y increases downward), matching the SVG coordinate system used
 * by the marker overlay in the front-end.
 *
 * Rotation-aware: each text item's PDF user-space coordinates are converted
 * to viewport space via `viewport.convertToViewportPoint` before normalising,
 * so pages with /Rotate = 0, 90, 180, or 270 all produce correct results.
 */
export async function extractPagePhrases(
  pdfPath: string,
  fileId: string,
  pageNum: number,
): Promise<PageWords> {
  const cacheKey = `${fileId}:${pageNum}`;
  const cached = phraseCache.get(cacheKey);
  if (cached) return cached;

  const lib = await getPdfjs();

  const rawBuffer = await fs.readFile(pdfPath);
  const data = new Uint8Array(rawBuffer);

  const doc = await lib.getDocument({ data, disableAutoFetch: true, disableStream: true }).promise;

  const page = await doc.getPage(pageNum);
  // getViewport({ scale: 1.0 }) without an explicit rotation argument uses the
  // page's own /Rotate attribute, so viewport.width/height are the visual
  // (rotation-adjusted) dimensions.
  const viewport = page.getViewport({ scale: 1.0 });
  const pageW = viewport.width;
  const pageH = viewport.height;

  const content = await page.getTextContent();

  // Filter to real text items (TextItem, not TextMarkedContent) with visible text
  const rawItems = content.items
    .filter(isTextItem)
    .filter((it) => it.str.trim().length > 0);

  // ── Convert every item's bounding box to viewport (screen) space ────────
  // PDF text item origin (transform[4], transform[5]) is in PDF user space
  // (origin bottom-left, y increases upward).  `convertToViewportPoint` maps
  // this to viewport space (origin top-left, y increases downward) and also
  // applies the page rotation matrix, so the result is always visually correct
  // regardless of /Rotate.
  //
  // We convert all four corners of the glyph's bounding box and take min/max,
  // which handles 90° / 270° pages where the x and y axes are swapped.
  type VpItem = {
    item: PdfjsTextItem;
    vx0: number; // left edge in viewport space
    vx1: number; // right edge in viewport space
    vy0: number; // top edge in viewport space (y-down)
    vy1: number; // bottom edge in viewport space (y-down)
    vyC: number; // vertical centre (for same-line detection)
  };

  function toViewportItem(item: PdfjsTextItem): VpItem {
    const [a, b, c, d, tx, ty] = item.transform;
    const w = item.width || 8;
    const h = Math.abs(item.height) || 8;
    // Use the text transform matrix to find the correct advance and height
    // directions in PDF user space.  Naively adding ±w to tx and ±h to ty
    // only works for axis-aligned text (transform is a scale matrix).  For
    // rotated pages (e.g. /Rotate = 90) the text is stored with a matching
    // rotation in the CTM, so its advance direction is (a,b) in user space,
    // NOT the +x axis.
    //
    //   advance unit vector : (ux, uy) = (a, b) / |(a, b)|
    //   height  unit vector : (vx, vy) = (c, d) / |(c, d)|
    //
    // The four corners of the glyph's bounding parallelogram in user space:
    //   baseline start  : (tx,        ty       )
    //   baseline end    : (tx+ux*w,   ty+uy*w  )
    //   ascender start  : (tx+vx*h,   ty+vy*h  )
    //   ascender end    : (tx+ux*w+vx*h, ty+uy*w+vy*h)
    const scaleX = Math.sqrt(a * a + b * b) || 1;
    const scaleY = Math.sqrt(c * c + d * d) || 1;
    const ux = a / scaleX;  // advance direction x
    const uy = b / scaleX;  // advance direction y
    const vx = c / scaleY;  // height  direction x
    const vy = d / scaleY;  // height  direction y
    const corners: [number, number][] = [
      viewport.convertToViewportPoint(tx,                   ty                  ),
      viewport.convertToViewportPoint(tx + ux * w,          ty + uy * w         ),
      viewport.convertToViewportPoint(tx + vx * h,          ty + vy * h         ),
      viewport.convertToViewportPoint(tx + ux * w + vx * h, ty + uy * w + vy * h),
    ];
    const vx0 = Math.min(...corners.map((pt) => pt[0]));
    const vx1 = Math.max(...corners.map((pt) => pt[0]));
    const vy0 = Math.min(...corners.map((pt) => pt[1]));
    const vy1 = Math.max(...corners.map((pt) => pt[1]));
    return { item, vx0, vx1, vy0, vy1, vyC: (vy0 + vy1) / 2 };
  }

  const vpItems: VpItem[] = rawItems.map(toViewportItem);

  // Sort top-to-bottom, left-to-right in viewport space.
  // Using viewport-space coordinates ensures correct ordering for all rotation values.
  const sorted = [...vpItems].sort((a, b) => {
    if (Math.abs(a.vyC - b.vyC) > 3) return a.vyC - b.vyC; // different lines (top-down)
    return a.vx0 - b.vx0;                                   // same line → left to right
  });

  // Each group entry stores the viewport-space item plus the visual gap (viewport pts)
  // before it.  We use the gap to decide whether to insert a word-boundary space.
  type GroupEntry = { vp: VpItem; gapPts: number };

  const phrases: PdfPhrase[] = [];
  let group: GroupEntry[] | null = null;

  function flushGroup(): void {
    if (!group || group.length === 0) return;

    // Union of all items' viewport bounding boxes
    const vxMin = Math.min(...group.map((e) => e.vp.vx0));
    const vxMax = Math.max(...group.map((e) => e.vp.vx1));
    const vyMin = Math.min(...group.map((e) => e.vp.vy0));
    const vyMax = Math.max(...group.map((e) => e.vp.vy1));

    // Reconstruct text: insert a space whenever the visual gap before an item
    // exceeds 30 % of the previous item's visual width — this preserves word
    // boundaries lost because pdfjs discards whitespace-only items.
    let text = group[0]!.vp.item.str;
    for (let gi = 1; gi < group.length; gi++) {
      const entry = group[gi]!;
      const prevVpW = group[gi - 1]!.vp.vx1 - group[gi - 1]!.vp.vx0 || 8;
      if (entry.gapPts > prevVpW * 0.3) text += " ";
      text += entry.vp.item.str;
    }
    text = text.trim().replace(/  +/g, " ");

    // Normalise to [0, 1] — viewport space is already top-down so no y-flip needed
    phrases.push({
      text,
      x0: Math.min(1, Math.max(0, vxMin / pageW)),
      x1: Math.min(1, Math.max(0, vxMax / pageW)),
      y0: Math.min(1, Math.max(0, vyMin / pageH)),
      y1: Math.min(1, Math.max(0, vyMax / pageH)),
    });
    group = null;
  }

  for (const vp of sorted) {
    if (!group) {
      group = [{ vp, gapPts: 0 }];
      continue;
    }

    const prev = group[group.length - 1]!.vp;
    // Gap in viewport-x between right edge of previous item and left edge of this one
    const gap = vp.vx0 - prev.vx1;
    // Items are on the same visual line when their centres differ by ≤ 3 viewport pts.
    // The threshold matches the original 3 pt PDF-space threshold; scale 1.0 means
    // viewport pts == PDF pts for 0°/180° pages and the rotation swap is handled by
    // the coordinate conversion for 90°/270°.
    const sameLine = Math.abs(vp.vyC - prev.vyC) <= 3;
    // Adjacent: gap less than 120 % of the previous item's visual width
    const prevVpW = prev.vx1 - prev.vx0 || 8;
    const adjacent = gap < prevVpW * 1.2;

    if (sameLine && adjacent) {
      group.push({ vp, gapPts: Math.max(0, gap) });
    } else {
      flushGroup();
      group = [{ vp, gapPts: 0 }];
    }
  }
  flushGroup();

  doc.destroy();

  const result: PageWords = { pageWidth: pageW, pageHeight: pageH, phrases };

  // Cap cache to ~200 pages to avoid unbounded memory growth on long-running servers
  if (phraseCache.size >= 200) {
    const firstKey = phraseCache.keys().next().value as string | undefined;
    if (firstKey) phraseCache.delete(firstKey);
  }
  phraseCache.set(cacheKey, result);

  return result;
}

// ── Location-to-coordinates matcher ─────────────────────────────────────────
// Ports the token-overlap / room-number matching approach from SignReviewModal
// so that x_pos / y_pos can be populated at extraction time without a browser.

function _tokenize(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((t) => t.length >= 2)
    ),
  ];
}

function _normId(s: string): string {
  return s.toLowerCase().replace(/[\s\-_]/g, "");
}

function _exactBoundaryMatch(haystack: string, needle: string): boolean {
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    const before = idx > 0 ? haystack[idx - 1] : null;
    const after =
      idx + needle.length < haystack.length ? haystack[idx + needle.length] : null;
    const validBefore = before == null || !/[a-z0-9]/.test(before);
    const validAfter = after == null || !/[a-z0-9]/.test(after);
    if (validBefore && validAfter) return true;
    idx = haystack.indexOf(needle, idx + 1);
  }
  return false;
}

function _levenshtein(s: string, t: string): number {
  const m = s.length,
    n = t.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      curr[j] =
        s[i - 1] === t[j - 1]
          ? prev[j - 1]!
          : 1 + Math.min(prev[j]!, curr[j - 1]!, prev[j - 1]!);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n]!;
}

function _levenshteinSim(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  return 1 - _levenshtein(a, b) / Math.max(a.length, b.length);
}

function _phraseMatchScore(phraseText: string, query: string): number {
  const pn = phraseText
    .toLowerCase()
    .replace(/[^a-z0-9]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const qn = query
    .toLowerCase()
    .replace(/[^a-z0-9]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!pn || !qn) return 0;
  const pt = _tokenize(pn);
  const qt = _tokenize(qn);
  if (!pt.length || !qt.length) return 0;
  let total = 0;
  for (const qtok of qt) {
    let best = 0;
    for (const ptok of pt) {
      if (qtok === ptok) { best = 1; break; }
      const [shorter, longer] =
        qtok.length <= ptok.length ? [qtok, ptok] : [ptok, qtok];
      if (longer.startsWith(shorter)) {
        best = Math.max(best, shorter.length / longer.length);
      }
      best = Math.max(best, _levenshteinSim(qtok, ptok));
    }
    total += best;
  }
  return total / qt.length;
}

export interface MatchedCoords {
  xPos: number;
  yPos: number;
}

/**
 * Given the page's word phrases and the floor plan bbox, finds the phrase whose
 * text best matches the sign's location / signIdentifier using token-overlap and
 * room-number matching.  Returns the phrase centre normalised to [0, 1].
 *
 * Only considers phrases whose centre falls inside floorPlanBbox (with small tolerance).
 * Returns null when no confident match is found (score < 0.5).
 */
export function matchLocationToCoords(
  phrases: PdfPhrase[],
  floorPlanBbox: FloorPlanBbox | null,
  location: string | null | undefined,
  signIdentifier: string | null | undefined,
): MatchedCoords | null {
  const query = [location, signIdentifier].filter(Boolean).join(" ").trim();
  if (!query) return null;

  // Require a valid floor plan bbox — if the page has no detected drawing region,
  // return null so xPos/yPos stay null (no guessing on schedule/title-block pages).
  if (!floorPlanBbox) return null;

  // Filter phrases to those inside the floor plan area
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

  if (drawingPhrases.length === 0) return null;

  // Score each phrase
  const ROOM_NUM_RE =
    /\b(?:[A-Za-z]{1,2}\d{2,4}[A-Za-z]?|\d{2,4}[A-Za-z]{1,2})\b/g;
  const roomTokens = (query.match(ROOM_NUM_RE) ?? []).map((t) => _normId(t));

  let best: { score: number; cx: number; cy: number } | null = null;

  for (const p of drawingPhrases) {
    const cx = (p.x0 + p.x1) / 2;
    const cy = (p.y0 + p.y1) / 2;
    const pn = _normId(p.text);

    // Room-number exact match gets a high bonus
    let score = _phraseMatchScore(p.text, query);
    if (roomTokens.length > 0) {
      const hasRoomMatch = roomTokens.some((rt) => _exactBoundaryMatch(pn, rt));
      if (hasRoomMatch) score = Math.max(score, 0.85);
    }

    if (!best || score > best.score) {
      best = { score, cx, cy };
    }
  }

  if (!best || best.score < 0.5) return null;
  return { xPos: best.cx, yPos: best.cy };
}

export interface FloorPlanBbox {
  x0: number; // 0–1 normalised left edge
  y0: number; // 0–1 normalised top edge
  x1: number; // 0–1 normalised right edge
  y1: number; // 0–1 normalised bottom edge
}

/**
 * Detect the floor plan drawing region on a page by identifying "table-like"
 * vertical strips — narrow x-ranges with ≥ 8 items at roughly uniform y-spacing.
 * These strips correspond to sign-schedule columns or title blocks.  The floor
 * plan bbox is the page region that excludes those strips and any dense text zones.
 *
 * Returns null when the heuristic cannot find a clear drawing region
 * (e.g. the page is entirely schedule tables).
 */
export function detectFloorPlanBbox(phrases: PdfPhrase[]): FloorPlanBbox | null {
  if (phrases.length === 0) return null;

  // ── Step 1: identify schedule/table columns by clustering phrases into
  // narrow vertical strips (x-bands of width ≤ 0.15) that have ≥ 8 items
  // spaced at roughly uniform vertical intervals.
  const STRIP_WIDTH = 0.15;
  const MIN_ITEMS_IN_STRIP = 8;

  // Collect centre-x of each phrase
  const cxList = phrases.map((p) => (p.x0 + p.x1) / 2);

  // Identify table-column x-ranges: sort by cx, slide a window
  const sorted = [...cxList].sort((a, b) => a - b);
  const tableXRanges: Array<{ lo: number; hi: number }> = [];

  let winStart = 0;
  for (let i = 1; i <= sorted.length; i++) {
    const spanEnd = i < sorted.length ? sorted[i]! : sorted[sorted.length - 1]! + 1;
    const spanStart = sorted[winStart]!;
    if (spanEnd - spanStart > STRIP_WIDTH || i === sorted.length) {
      const count = i - winStart;
      if (count >= MIN_ITEMS_IN_STRIP) {
        // Check uniform y-spacing (std dev of cy gaps is small relative to mean gap)
        const stripPhrases = phrases.filter((p) => {
          const cx = (p.x0 + p.x1) / 2;
          return cx >= spanStart - 0.01 && cx <= spanStart + STRIP_WIDTH + 0.01;
        });
        const cys = stripPhrases.map((p) => (p.y0 + p.y1) / 2).sort((a, b) => a - b);
        if (cys.length >= MIN_ITEMS_IN_STRIP) {
          const gaps: number[] = [];
          for (let g = 1; g < cys.length; g++) gaps.push(cys[g]! - cys[g - 1]!);
          if (gaps.length > 0) {
            const meanGap = gaps.reduce((s, v) => s + v, 0) / gaps.length;
            const stdGap = Math.sqrt(
              gaps.reduce((s, v) => s + (v - meanGap) ** 2, 0) / gaps.length
            );
            // Uniform spacing: std < 50% of mean gap; only flag as table column
            // when the mean gap is small (≤ 0.08) indicating dense row spacing
            if (meanGap <= 0.08 && stdGap < meanGap * 0.5) {
              tableXRanges.push({
                lo: Math.min(...stripPhrases.map((p) => p.x0)),
                hi: Math.max(...stripPhrases.map((p) => p.x1)),
              });
            }
          }
        }
      }
      winStart = i;
    }
  }

  // ── Step 2: merge overlapping/adjacent table x-ranges into contiguous
  // "excluded" zones.  Then find the largest x-gap that is NOT excluded.
  const merged = tableXRanges
    .sort((a, b) => a.lo - b.lo)
    .reduce<Array<{ lo: number; hi: number }>>((acc, r) => {
      if (acc.length === 0) return [r];
      const last = acc[acc.length - 1]!;
      if (r.lo <= last.hi + 0.02) {
        last.hi = Math.max(last.hi, r.hi);
        return acc;
      }
      acc.push({ ...r });
      return acc;
    }, []);

  // The floor plan drawing region is the contiguous x-gap (between excluded zones)
  // that spans the largest horizontal extent.  Fall back to [0, 1] if no table zones.
  let drawX0 = 0;
  let drawX1 = 1;

  if (merged.length > 0) {
    // Candidate gaps: before first zone, between zones, after last zone
    const gaps: Array<{ lo: number; hi: number }> = [];
    gaps.push({ lo: 0, hi: merged[0]!.lo });
    for (let i = 1; i < merged.length; i++) {
      gaps.push({ lo: merged[i - 1]!.hi, hi: merged[i]!.lo });
    }
    gaps.push({ lo: merged[merged.length - 1]!.hi, hi: 1 });

    const largest = gaps.reduce((best, g) =>
      g.hi - g.lo > best.hi - best.lo ? g : best
    );
    // Only trust the gap when it is at least 0.2 wide (otherwise the whole page
    // is a schedule and there's no discernible drawing region)
    if (largest.hi - largest.lo >= 0.2) {
      drawX0 = largest.lo;
      drawX1 = largest.hi;
    }
    // If no usable gap, return null so the caller knows there's no floor plan bbox
    else {
      return null;
    }
  }

  // ── Step 3: determine y-extent.  Ignore phrases that are entirely inside
  // the excluded x-zones; the floor plan drawing area y-bounds come from the
  // remaining phrases.
  const drawPhrases = phrases.filter((p) => {
    const cx = (p.x0 + p.x1) / 2;
    return cx >= drawX0 && cx <= drawX1;
  });

  if (drawPhrases.length === 0) return null;

  const y0 = Math.min(...drawPhrases.map((p) => p.y0));
  const y1 = Math.max(...drawPhrases.map((p) => p.y1));

  return { x0: drawX0, y0, x1: drawX1, y1 };
}

/**
 * Return the number of pages in a PDF without extracting any text.
 * Used by the heuristic extractor to know how many pages to iterate.
 */
export async function getPdfPageCount(pdfPath: string): Promise<number> {
  const lib = await getPdfjs();
  const rawBuffer = await fs.readFile(pdfPath);
  const data = new Uint8Array(rawBuffer);
  const doc = await lib.getDocument({ data, disableAutoFetch: true, disableStream: true }).promise;
  const count = doc.numPages;
  doc.destroy();
  return count;
}
