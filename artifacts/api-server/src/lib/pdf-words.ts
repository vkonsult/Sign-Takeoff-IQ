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

interface PdfjsOutlineItem {
  title: string;
  dest: string | unknown[] | null;
  items: PdfjsOutlineItem[];
}

interface ExtendedPdfjsDocument extends PdfjsDocument {
  getOutline(): Promise<PdfjsOutlineItem[] | null>;
  getPageLabels(): Promise<(string | null)[] | null>;
  getDestination(name: string): Promise<unknown[] | null>;
  getPageIndex(ref: unknown): Promise<number>;
}

export interface PdfOutlineSection {
  title: string;
  pageStart: number;
  pageEnd: number;
  type: "floor_plan" | "sign_schedule" | "other" | null;
}

export interface PdfDocumentMetadata {
  pageLabels: (string | null)[];
  outlineSections: PdfOutlineSection[];
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

// ── In-memory pdfjs document cache keyed by absolute file path ────────────
// getDocument() is expensive (reads + parses the entire PDF) — caching avoids
// re-opening the same file once per page during the spatial pre-pass.
// Each entry is a Promise so concurrent first-touch calls to the same path
// share a single in-flight getDocument() rather than racing to open duplicates.
// Capped at PDFJS_DOC_CACHE_MAX entries; oldest is evicted (and destroyed) when full.
const PDFJS_DOC_CACHE_MAX = 20;
const pdfjsDocCache = new Map<string, Promise<PdfjsDocument>>();

async function getOrOpenPdfjsDoc(pdfPath: string): Promise<PdfjsDocument> {
  const existing = pdfjsDocCache.get(pdfPath);
  if (existing) return existing;

  const docPromise = (async (): Promise<PdfjsDocument> => {
    const lib = await getPdfjs();
    const rawBuffer = await fs.readFile(pdfPath);
    const data = new Uint8Array(rawBuffer);
    return lib.getDocument({ data, disableAutoFetch: true, disableStream: true }).promise;
  })();

  // Evict oldest entry when at capacity
  if (pdfjsDocCache.size >= PDFJS_DOC_CACHE_MAX) {
    const oldestKey = pdfjsDocCache.keys().next().value as string | undefined;
    if (oldestKey) {
      const old = pdfjsDocCache.get(oldestKey);
      pdfjsDocCache.delete(oldestKey);
      // Destroy asynchronously; ignore errors
      old?.then((d) => { try { d.destroy(); } catch { /* ignore */ } }).catch(() => { /* ignore */ });
    }
  }

  pdfjsDocCache.set(pdfPath, docPromise);

  // Remove cache entry on failure so callers can retry without a stale rejected promise
  docPromise.catch(() => {
    if (pdfjsDocCache.get(pdfPath) === docPromise) {
      pdfjsDocCache.delete(pdfPath);
    }
  });

  return docPromise;
}

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

  const doc = await getOrOpenPdfjsDoc(pdfPath);

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

/**
 * Static map of common architectural room abbreviations to their expanded
 * forms.  Each entry maps an abbreviation (upper-case, no spaces) to one or
 * more canonical expanded phrases (lower-case, space-separated tokens).
 * Used bidirectionally: if the query contains the abbreviation, all expanded
 * forms are also tested against the candidate phrase, and vice-versa.
 */
const ROOM_ABBREV_MAP: Record<string, string[]> = {
  MRR:  ["mens restroom", "men restroom", "mens rest room", "men rest room", "mens room", "men room"],
  WRR:  ["womens restroom", "women restroom", "womens rest room", "women rest room", "womens room", "women room"],
  MR:   ["mens restroom", "men restroom", "mens room", "men room"],
  WR:   ["womens restroom", "women restroom", "womens room", "women room"],
  RR:   ["restroom", "rest room"],
  WC:   ["water closet", "restroom", "toilet"],
  JAN:  ["janitor", "janitorial", "custodial"],
  ELEC: ["electrical", "electric"],
  MECH: ["mechanical"],
  IT:   ["information technology", "it room", "server room"],
  IDF:  ["intermediate distribution frame", "telecom room"],
  MDF:  ["main distribution frame", "telecom room"],
  AHU:  ["air handling unit"],
  RTU:  ["rooftop unit"],
  FEC:  ["fire extinguisher cabinet"],
  FE:   ["fire extinguisher"],
  EV:   ["electrical vehicle", "ev charging"],
};

/**
 * Given a string (already lower-cased, alphanumeric+spaces only), returns an
 * array of alternative strings to try when scoring — the original plus any
 * expansions or contractions found in ROOM_ABBREV_MAP.
 */
function _expandAbbreviations(text: string): string[] {
  const variants = new Set<string>([text]);

  // Forward: abbreviation found in text → add expanded forms
  for (const [abbr, expansions] of Object.entries(ROOM_ABBREV_MAP)) {
    const abbrLower = abbr.toLowerCase();
    // Check if the abbreviation appears as a whole word in the text
    const re = new RegExp(`(?:^|\\s)${abbrLower}(?:\\s|$)`);
    if (re.test(text)) {
      for (const exp of expansions) {
        variants.add(text.replace(new RegExp(`\\b${abbrLower}\\b`, "g"), exp));
        variants.add(exp);
      }
    }
    // Reverse: expanded form found in text → add abbreviation
    for (const exp of expansions) {
      if (text.includes(exp)) {
        variants.add(text.replace(exp, abbrLower));
        variants.add(abbrLower);
      }
    }
  }

  return Array.from(variants);
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
 * Normalise a raw phrase string for abbreviation expansion: lower-case,
 * replace non-alphanumeric with spaces, collapse spaces.
 */
function _normaliseForExpansion(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, " ").replace(/\s+/g, " ").trim();
}

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

  // Build expanded query variants (abbreviation ↔ expansion, bidirectional).
  const queryNorm = _normaliseForExpansion(query);
  const queryVariants = _expandAbbreviations(queryNorm);

  // Room-number tokens from every query variant.
  // Extended regex also captures standalone 3–4 digit numbers (e.g. "130")
  // which are common room numbers even without an alpha prefix.
  const ROOM_NUM_RE =
    /\b(?:[A-Za-z]{1,2}-\d{2,4}|[A-Za-z]{1,2}\d{2,4}[A-Za-z]?|\d{2,4}[A-Za-z]{1,2}|\d{3,4})\b/g;
  const roomTokenSet = new Set<string>();
  for (const qv of queryVariants) {
    for (const t of (qv.match(ROOM_NUM_RE) ?? [])) {
      roomTokenSet.add(_normId(t));
    }
  }
  const roomTokens = Array.from(roomTokenSet);

  let best: { score: number; cx: number; cy: number } | null = null;

  for (const p of drawingPhrases) {
    const cx = (p.x0 + p.x1) / 2;
    const cy = (p.y0 + p.y1) / 2;
    const pn = _normId(p.text);

    // Build expanded phrase variants for bidirectional abbreviation matching.
    const phraseNorm = _normaliseForExpansion(p.text);
    const phraseVariants = _expandAbbreviations(phraseNorm);

    // Best score across all (queryVariant × phraseVariant) combinations.
    let score = 0;
    for (const qv of queryVariants) {
      for (const pv of phraseVariants) {
        score = Math.max(score, _phraseMatchScore(pv, qv));
      }
      // Also score against the raw phrase text (original behaviour).
      score = Math.max(score, _phraseMatchScore(p.text, qv));
    }

    // Room-number exact match gets a high bonus.
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
 * vertical strips — x-bands whose phrases have dense, uniformly-spaced rows.
 * These strips correspond to sign-schedule columns or title blocks.  The floor
 * plan bbox is the page region that excludes those strips and any dense text zones.
 *
 * Uses two complementary strategies and merges their results:
 *   A) Fixed narrow-band analysis: divide page into 50 x-bands (0.02 wide each)
 *      and flag each as "table-like" based on phrase density + y-gap uniformity.
 *   B) Sliding-window clustering: groups cx values into wider strips (≤ 0.12 wide)
 *      and flags strips with dense uniform row spacing.
 *
 * Returns null when the heuristic cannot find a clear drawing region
 * (e.g. the page is entirely schedule tables).
 */
export function detectFloorPlanBbox(phrases: PdfPhrase[]): FloorPlanBbox | null {
  if (phrases.length === 0) return null;

  const tableXRanges: Array<{ lo: number; hi: number }> = [];

  // ── Strategy A: fixed narrow bands (50 bands × 0.02 wide) ─────────────────
  // Uses tight thresholds to avoid flagging floor-plan room label columns:
  //   - count ≥ 8  → can't fire on 3-5 scattered room labels
  //   - meanGap ≤ 0.05 → schedule-table rows are 0.02-0.04 apart;
  //                       floor-plan room labels are 0.05-0.15 apart
  const N_BANDS = 50;
  const bandPhrases: PdfPhrase[][] = Array.from({ length: N_BANDS }, () => []);
  for (const p of phrases) {
    const cx = (p.x0 + p.x1) / 2;
    const bi = Math.min(N_BANDS - 1, Math.max(0, Math.floor(cx * N_BANDS)));
    bandPhrases[bi]!.push(p);
  }
  for (let bi = 0; bi < N_BANDS; bi++) {
    const bp = bandPhrases[bi]!;
    if (bp.length < 8) continue;           // require dense population
    const cys = bp.map((p) => (p.y0 + p.y1) / 2).sort((a, b) => a - b);
    const gaps: number[] = [];
    for (let g = 1; g < cys.length; g++) gaps.push(cys[g]! - cys[g - 1]!);
    if (!gaps.length) continue;
    const meanGap = gaps.reduce((s, v) => s + v, 0) / gaps.length;
    if (meanGap <= 0 || meanGap > 0.05) continue;  // must be densely packed rows
    const variance = gaps.reduce((s, v) => s + (v - meanGap) ** 2, 0) / gaps.length;
    if (Math.sqrt(variance) / meanGap < 0.55) {
      tableXRanges.push({ lo: bi / N_BANDS, hi: (bi + 1) / N_BANDS });
    }
  }

  // ── Strategy B: sliding-window clustering (width ≤ 0.12) ──────────────────
  const STRIP_WIDTH = 0.12;
  const MIN_ITEMS_IN_STRIP = 6;
  const sorted = [...phrases.map((p) => (p.x0 + p.x1) / 2)].sort((a, b) => a - b);

  let winStart = 0;
  for (let i = 1; i <= sorted.length; i++) {
    const spanEnd = i < sorted.length ? sorted[i]! : sorted[sorted.length - 1]! + 1;
    const spanStart = sorted[winStart]!;
    if (spanEnd - spanStart > STRIP_WIDTH || i === sorted.length) {
      const count = i - winStart;
      if (count >= MIN_ITEMS_IN_STRIP) {
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
            if (meanGap <= 0.10 && stdGap < meanGap * 0.55) {
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

  // ── Step 2: merge all detected table x-ranges (tolerance 0.03) ────────────
  const merged = tableXRanges
    .sort((a, b) => a.lo - b.lo)
    .reduce<Array<{ lo: number; hi: number }>>((acc, r) => {
      if (acc.length === 0) return [r];
      const last = acc[acc.length - 1]!;
      if (r.lo <= last.hi + 0.03) {
        last.hi = Math.max(last.hi, r.hi);
        return acc;
      }
      acc.push({ ...r });
      return acc;
    }, []);

  // ── Step 3: find the largest x-gap between excluded zones ─────────────────
  let drawX0 = 0;
  let drawX1 = 1;

  if (merged.length > 0) {
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
    } else {
      return null;
    }
  }

  // ── Step 4: determine y-extent from phrases in the floor plan x-range ──────
  const drawPhrases = phrases.filter((p) => {
    const cx = (p.x0 + p.x1) / 2;
    return cx >= drawX0 && cx <= drawX1;
  });

  if (drawPhrases.length === 0) return null;

  const y0 = Math.min(...drawPhrases.map((p) => p.y0));
  const y1 = Math.max(...drawPhrases.map((p) => p.y1));

  return { x0: drawX0, y0, x1: drawX1, y1 };
}

// ── Spatial page-type classification ─────────────────────────────────────────
// Title phrases that unambiguously identify a floor plan when found in the
// bottom-right title block region (x > 0.60 AND y > 0.60 in normalised coords).
// Matching uses substring/includes so "FIRST FLOOR PLAN - OVERALL" triggers on
// "first floor plan".
const SPATIAL_FLOOR_PLAN_TITLE_PHRASES: string[] = [
  "floor plan",
  "level plan",
  "first floor plan",
  "second floor plan",
  "third floor plan",
  "fourth floor plan",
  "fifth floor plan",
  "ground floor plan",
  "basement plan",
  "mezzanine plan",
  "penthouse plan",
  "parking plan",
  "sanctuary floor plan",
  "chapel floor plan",
  "classroom plan",
  "level 1 plan",
  "level 2 plan",
  "level 3 plan",
  "level 4 plan",
  "level 5 plan",
];

// Title phrases that unambiguously identify a sign schedule in the title block.
const SPATIAL_SIGN_SCHEDULE_TITLE_PHRASES: string[] = [
  "sign schedule",
  "signage schedule",
  "sign plan",
  "sign detail",
  "signage detail",
  "sign elevation",
  "sign criteria",
  "signage criteria",
  "sign program",
  "signage program",
];

export type SpatialPageType = "floor_plan" | "sign_schedule" | "both" | "unknown";

/**
 * Classify a PDF page using only the spatial content of the bottom-right
 * title-block quadrant.  Accepts the phrase list already extracted by
 * `extractPagePhrases`.
 *
 * Strategy:
 *   1. Filter to the bottom-right quadrant (x > 0.60 AND y > 0.60) — this is
 *      the standard title-block region in architectural drawings.
 *   2. Also include the bottom strip (y > 0.80) to catch wide title blocks that
 *      may start further left than 0.60.
 *   3. Concatenate the filtered phrase text into a single string (lowercased).
 *   4. Match against floor plan and sign schedule title phrase lists using
 *      substring matching (so "FIRST FLOOR PLAN - OVERALL" matches "floor plan").
 *
 * Because we read only the title block region, finding a floor plan or sign
 * schedule phrase there is treated as unambiguous — no drawing number required.
 *
 * Returns:
 *   "floor_plan"   — title block contains a floor plan phrase
 *   "sign_schedule"— title block contains a sign schedule phrase
 *   "both"         — title block contains both types of phrase
 *   "unknown"      — no recognisable phrase found in the title block region
 */
export function classifyPageFromPhrases(phrases: PdfPhrase[]): SpatialPageType {
  if (phrases.length === 0) return "unknown";

  // Gather phrases from the bottom-right quadrant AND from the bottom strip.
  const titleBlockPhrases = phrases.filter((p) => {
    const cx = (p.x0 + p.x1) / 2;
    const cy = (p.y0 + p.y1) / 2;
    const inQuadrant = cx > 0.60 && cy > 0.60;
    const inBottomStrip = cy > 0.80;
    return inQuadrant || inBottomStrip;
  });

  if (titleBlockPhrases.length === 0) return "unknown";

  const combined = titleBlockPhrases.map((p) => p.text).join(" ").toLowerCase();

  const hasFpPhrase = SPATIAL_FLOOR_PLAN_TITLE_PHRASES.some((phrase) =>
    combined.includes(phrase.toLowerCase())
  );
  const hasSsPhrase = SPATIAL_SIGN_SCHEDULE_TITLE_PHRASES.some((phrase) =>
    combined.includes(phrase.toLowerCase())
  );

  if (hasFpPhrase && hasSsPhrase) return "both";
  if (hasFpPhrase) return "floor_plan";
  if (hasSsPhrase) return "sign_schedule";
  return "unknown";
}

/**
 * Return the number of pages in a PDF without extracting any text.
 * Used by the heuristic extractor to know how many pages to iterate.
 */
export async function getPdfPageCount(pdfPath: string): Promise<number> {
  const doc = await getOrOpenPdfjsDoc(pdfPath);
  return doc.numPages;
}

/**
 * Build a plain-text string per page by draining the phrase cache that was
 * populated during the spatial pre-pass.  If a page was not cached yet,
 * `extractPagePhrases` is called (which will also populate the cache).
 *
 * Returns an array indexed 0..numPages-1 where each element is the
 * concatenated text of all phrases on that page separated by spaces.
 */
export async function buildPageTextsFromPhraseCache(
  pdfPath: string,
  fileId: string,
  numPages: number,
): Promise<string[]> {
  const pageTexts: string[] = [];
  for (let pageNum = 1; pageNum <= numPages; pageNum++) {
    const pageWords = await extractPagePhrases(pdfPath, fileId, pageNum);
    const text = pageWords.phrases.map((p) => p.text).join(" ");
    pageTexts.push(text);
  }
  return pageTexts;
}

// ── PDF metadata extraction (outline sections + page labels) ─────────────

const metadataCache = new Map<string, PdfDocumentMetadata>();

async function resolveDestToPage(
  dest: string | unknown[] | null,
  doc: ExtendedPdfjsDocument,
): Promise<number | null> {
  if (!dest) return null;
  try {
    let destArray: unknown[] | null = null;
    if (typeof dest === "string") {
      destArray = await doc.getDestination(dest);
    } else if (Array.isArray(dest)) {
      destArray = dest as unknown[];
    }
    if (!destArray || destArray.length === 0) return null;
    const pageIndex = await doc.getPageIndex(destArray[0]);
    return pageIndex + 1;
  } catch {
    return null;
  }
}

// ── Non-architectural discipline blocklist ────────────────────────────────
// Leaf bookmarks whose ancestor title contains any of these keywords (case-insensitive)
// are excluded from signage processing — they belong to MEP or civil disciplines.
const NON_ARCH_DISCIPLINE_KEYWORDS: string[] = [
  "civil",
  "electrical",
  "mechanical",
  "structural",
  "plumbing",
  "fire protection",
  "technology",
  "telecom",
  "telecommunications",
  "low voltage",
  "data/communications",
  "data / communications",
  "it drawings",
  "it plans",
  "hvac",
  "lighting",
  "power",
  "sprinkler",
];

/**
 * Returns true when the ancestor chain of a bookmark leaf contains a
 * non-architectural discipline keyword.  Only the direct parent (last element
 * of ancestors) and grandparent (second-to-last) are inspected, because
 * higher-level section headings (e.g. "Project Documents") are neutral.
 */
function hasNonArchAncestor(ancestors: string[]): boolean {
  const relevantAncestors = ancestors.slice(-2);
  return relevantAncestors.some((ancestor) => {
    const lower = ancestor.toLowerCase();
    return NON_ARCH_DISCIPLINE_KEYWORDS.some((kw) => lower.includes(kw));
  });
}

/**
 * Returns true when the leaf title contains "signs" or "signage" as a
 * case-insensitive substring.  This matches both exact titles ("Signs",
 * "Signage") and compound titles ("Main Floor Plan and Signs",
 * "Level 2 Signage Plan").
 */
function isSignageLeaf(title: string): boolean {
  const lower = title.toLowerCase();
  return lower.includes("signs") || lower.includes("signage");
}

function classifyOutlineSection(title: string): PdfOutlineSection["type"] {
  const t = title.toLowerCase();
  const SS_PATTERNS = [
    "sign schedule", "signage", "sign spec", "sign legend",
    "sign program", "sign list", "sign detail", "signage plan",
    "signs",
  ];
  const FP_PATTERNS = [
    "floor plan", "floor plans", "level", "first floor", "second floor",
    "third floor", "ground floor", "basement", "site plan", "overall plan",
    "roof plan", "mezzanine",
  ];
  if (SS_PATTERNS.some((p) => t.includes(p))) return "sign_schedule";
  if (FP_PATTERNS.some((p) => t.includes(p))) return "floor_plan";
  return "other";
}

/**
 * Extract PDF document metadata: PDF page labels (logical names like "A1.1")
 * and outline/bookmark sections with classified page ranges.
 *
 * The bookmark traversal:
 *   1. Traverses the FULL bookmark tree (no depth cap) carrying ancestor context.
 *   2. Collects ALL leaf nodes (floor plans, sign schedules, general sections).
 *   3. Excludes leaves whose parent or grandparent belongs to a known
 *      non-architectural discipline (civil, electrical, mechanical, etc.).
 *   Each leaf is classified as "floor_plan" | "sign_schedule" | "other" by
 *   classifyOutlineSection(), and stored for both:
 *     - The outline-section classification override in extraction.ts
 *       (only "floor_plan" / "sign_schedule" leaves affect page type).
 *     - The Bookmark column display in the Sheets Analysis table.
 *
 * When the PDF has no bookmarks at all, an AI fallback is triggered via the
 * optional `geminiCallFn` parameter so the caller can classify pages from
 * their visible text instead.
 *
 * Results are cached in memory per file path (PDFs are immutable once uploaded).
 * Failures are swallowed — metadata is supplementary and must never break extraction.
 */
export async function extractPdfMetadata(
  pdfPath: string,
  geminiCallFn?: (pageTexts: Array<{ pageNum: number; text: string }>) => Promise<number[]>,
): Promise<PdfDocumentMetadata> {
  const cached = metadataCache.get(pdfPath);
  if (cached) return cached;

  const lib = await getPdfjs();
  const rawBuffer = await fs.readFile(pdfPath);
  const data = new Uint8Array(rawBuffer);
  const doc = (await lib
    .getDocument({ data, disableAutoFetch: true, disableStream: true })
    .promise) as unknown as ExtendedPdfjsDocument;

  const numPages = doc.numPages;
  let pageLabels: (string | null)[] = [];
  let outlineSections: PdfOutlineSection[] = [];

  try {
    const labels = await doc.getPageLabels();
    if (labels && labels.length === numPages) {
      pageLabels = labels;
    }
  } catch {
    // ignore — not all PDFs have page labels
  }

  let hasBookmarks = false;

  try {
    const outline = await doc.getOutline();
    if (outline && outline.length > 0) {
      hasBookmarks = true;

      // Full-depth traversal: visit every node, track the full ancestor title path.
      // A node is a "leaf" when it has no children (or all children have no dest).
      // We collect all architectural leaf bookmarks (floor plans AND sign schedules
      // AND general), excluding leaves under known non-arch disciplines.
      interface LeafItem {
        title: string;
        pageNum: number;
        ancestors: string[];
      }
      const signageLeaves: LeafItem[] = [];

      async function collectLeaves(
        items: PdfjsOutlineItem[],
        ancestors: string[],
      ): Promise<void> {
        for (const item of items) {
          const title = item.title ?? "(untitled)";
          const hasChildren = item.items && item.items.length > 0;

          if (!hasChildren) {
            // Leaf node
            const pageNum = await resolveDestToPage(item.dest, doc);
            if (pageNum !== null && !hasNonArchAncestor(ancestors)) {
              signageLeaves.push({ title, pageNum, ancestors });
            }
          } else {
            // Internal node — recurse with updated ancestor path
            await collectLeaves(item.items, [...ancestors, title]);
          }
        }
      }

      await collectLeaves(outline, []);

      // Deduplicate by page number (keep first occurrence per page)
      const seenPages = new Set<number>();
      const uniqueLeaves = signageLeaves.filter((leaf) => {
        if (seenPages.has(leaf.pageNum)) return false;
        seenPages.add(leaf.pageNum);
        return true;
      });

      uniqueLeaves.sort((a, b) => a.pageNum - b.pageNum);

      for (const leaf of uniqueLeaves) {
        outlineSections.push({
          title: leaf.title,
          pageStart: leaf.pageNum,
          pageEnd: leaf.pageNum,
          type: classifyOutlineSection(leaf.title),
        });
      }
    }
  } catch {
    // ignore — outline is optional
  }

  // ── No-bookmark AI fallback ──────────────────────────────────────────────
  // When the PDF has no bookmarks at all and a Gemini callback is provided,
  // extract the first ~3 lines of text from each page and ask Gemini which
  // pages are signage-related.
  // Single-page PDFs with no bookmarks: leave outlineSections empty and let
  // the spatial pre-pass + text classifier determine the type. Hardcoding
  // sign_schedule here is wrong for floor plan sheets.
  if (!hasBookmarks && geminiCallFn && numPages > 1) {
    try {
      const pageTexts: Array<{ pageNum: number; text: string }> = [];
      for (let pageNum = 1; pageNum <= numPages; pageNum++) {
        try {
          const page = await doc.getPage(pageNum);
          const content = await page.getTextContent();
          const lines: string[] = [];
          for (const item of content.items) {
            if (
              typeof (item as { str?: string }).str === "string" &&
              (item as { str: string }).str.trim().length > 0
            ) {
              lines.push((item as { str: string }).str.trim());
              if (lines.length >= 3) break;
            }
          }
          if (lines.length > 0) {
            pageTexts.push({ pageNum, text: lines.join(" ") });
          }
        } catch {
          // skip page on error
        }
      }

      const signagePageNums = await geminiCallFn(pageTexts);
      const sortedPageNums = [...signagePageNums].sort((a, b) => a - b);

      for (let i = 0; i < sortedPageNums.length; i++) {
        const pageNum = sortedPageNums[i]!;
        outlineSections.push({
          title: `Signage Page ${pageNum}`,
          pageStart: pageNum,
          pageEnd: pageNum,
          type: "sign_schedule",
        });
      }
    } catch {
      // fallback failure is non-fatal
    }
  }

  doc.destroy();

  const result: PdfDocumentMetadata = { pageLabels, outlineSections };
  metadataCache.set(pdfPath, result);
  return result;
}
