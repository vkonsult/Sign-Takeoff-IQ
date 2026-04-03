import fs from "fs/promises";

export interface PdfPhrase {
  text: string;
  x0: number; // 0–1 normalized left edge
  y0: number; // 0–1 normalized top edge   (top-down: 0 = top of page)
  x1: number; // 0–1 normalized right edge
  y1: number; // 0–1 normalized bottom edge (top-down: 1 = bottom of page)
}

export interface PageWords {
  pageWidth: number;  // native PDF width  (pts at scale 1.0)
  pageHeight: number; // native PDF height (pts at scale 1.0)
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
}

interface PdfjsPage {
  getViewport(opts: { scale: number }): PdfjsViewport;
  getTextContent(): Promise<PdfjsTextContent>;
}

interface PdfjsDocument {
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
  const viewport = page.getViewport({ scale: 1.0 });
  const pageW = viewport.width;
  const pageH = viewport.height;

  const content = await page.getTextContent();

  // Filter to real text items (TextItem, not TextMarkedContent) with visible text
  const items = content.items
    .filter(isTextItem)
    .filter((it) => it.str.trim().length > 0);

  // Sort top-to-bottom (high Y first in PDF space), left-to-right on same line
  const sorted = [...items].sort((a, b) => {
    const ay = a.transform[5];
    const by_ = b.transform[5];
    if (Math.abs(ay - by_) > 3) return by_ - ay; // different lines
    return a.transform[4] - b.transform[4];       // same line → left to right
  });

  const phrases: PdfPhrase[] = [];
  let group: PdfjsTextItem[] | null = null;

  function flushGroup(): void {
    if (!group || group.length === 0) return;

    const minX = Math.min(...group.map((i) => i.transform[4]));
    const maxX = Math.max(...group.map((i) => i.transform[4] + i.width));
    // In PDF space y increases upward; transform[5] = baseline (bottom of glyph)
    // Top of glyph = baseline + height
    const minBaseline = Math.min(...group.map((i) => i.transform[5]));
    const maxBaseline = Math.max(...group.map((i) => i.transform[5]));
    const maxH = Math.max(...group.map((i) => Math.abs(i.height)));

    const topPdf = maxBaseline + (maxH || 8); // top edge (PDF space, y-up)
    const botPdf = minBaseline;               // bottom edge

    // Convert to normalised top-down coordinates
    phrases.push({
      text: group.map((i) => i.str).join(""),
      x0: Math.min(1, Math.max(0, minX / pageW)),
      x1: Math.min(1, Math.max(0, maxX / pageW)),
      y0: Math.min(1, Math.max(0, 1 - topPdf / pageH)), // top in top-down
      y1: Math.min(1, Math.max(0, 1 - botPdf / pageH)), // bottom in top-down
    });
    group = null;
  }

  for (const item of sorted) {
    if (!group) {
      group = [item];
      continue;
    }

    const prev = group[group.length - 1]!;
    const prevY = prev.transform[5];
    const prevX = prev.transform[4];
    const prevW = prev.width || 8;
    const currY = item.transform[5];
    const currX = item.transform[4];

    const sameLine = Math.abs(currY - prevY) <= 3;
    const adjacent = currX - (prevX + prevW) < prevW * 3;

    if (sameLine && adjacent) {
      group.push(item);
    } else {
      flushGroup();
      group = [item];
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
