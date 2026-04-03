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
