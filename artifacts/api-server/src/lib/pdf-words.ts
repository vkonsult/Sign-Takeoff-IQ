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

// In-memory phrase cache keyed by `fileId:pageNum`
const phraseCache = new Map<string, PageWords>();

// ── pdfjs-dist lazy loader ────────────────────────────────────────────────
// Must use the "legacy" build in Node.js — the standard build references
// browser-only APIs (DOMMatrix, CanvasRenderingContext2D, …) at module
// load time.  The legacy build ships Node.js-compatible polyfills.
let pdfjsModule: { getDocument: (opts: unknown) => { promise: Promise<unknown> } } | null = null;

async function getPdfjs() {
  if (pdfjsModule) return pdfjsModule;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lib = await import("pdfjs-dist/legacy/build/pdf.mjs") as any;

  // Configure worker for Node.js once.
  // We use the globalThis.require injected by the esbuild banner to resolve
  // the worker path inside node_modules — this avoids hard-coding any path.
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const req = (globalThis as any).require as NodeRequire | undefined;
    if (req?.resolve) {
      const workerPath = req.resolve("pdfjs-dist/legacy/build/pdf.worker.min.mjs");
      lib.GlobalWorkerOptions.workerSrc = `file://${workerPath}`;
    }
  } catch {
    // Fallback: empty string → pdfjs falls back to synchronous in-process mode
    lib.GlobalWorkerOptions.workerSrc = "";
  }

  pdfjsModule = { getDocument: lib.getDocument };
  return pdfjsModule;
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

  const { getDocument } = await getPdfjs();

  const rawBuffer = await fs.readFile(pdfPath);
  const data = new Uint8Array(rawBuffer);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const doc = await (getDocument({ data, disableAutoFetch: true, disableStream: true }) as any).promise;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const page = await doc.getPage(pageNum) as any;
  const viewport = page.getViewport({ scale: 1.0 });
  const pageW: number = viewport.width;
  const pageH: number = viewport.height;

  const content = await page.getTextContent();

  interface RawItem {
    str: string;
    transform: number[];
    width: number;
    height: number;
  }

  // Filter to real text items (ignore TextMarkedContent / whitespace-only)
  const items = (content.items as unknown as RawItem[]).filter(
    (it) => typeof it.str === "string" && it.str.trim().length > 0,
  );

  // Sort top-to-bottom (high Y first in PDF space), left-to-right on same line
  const sorted = [...items].sort((a, b) => {
    const ay = a.transform[5]!;
    const by_ = b.transform[5]!;
    if (Math.abs(ay - by_) > 3) return by_ - ay; // different lines
    return a.transform[4]! - b.transform[4]!;     // same line → left to right
  });

  const phrases: PdfPhrase[] = [];
  let group: RawItem[] | null = null;

  function flushGroup() {
    if (!group || group.length === 0) return;

    // Full bounding box across all items in the group
    const minX = Math.min(...group.map((i) => i.transform[4]!));
    const maxX = Math.max(...group.map((i) => i.transform[4]! + i.width));
    // In PDF space y increases upward; transform[5] = baseline (bottom of glyph)
    // Top of glyph = baseline + height
    const minBaseline = Math.min(...group.map((i) => i.transform[5]!));
    const maxBaseline = Math.max(...group.map((i) => i.transform[5]!));
    const maxH = Math.max(...group.map((i) => Math.abs(i.height)));

    const topPdf = maxBaseline + (maxH || 8);  // top edge (PDF space, y-up)
    const botPdf = minBaseline;                 // bottom edge

    // Convert to normalised top-down coordinates
    const x0 = Math.min(1, Math.max(0, minX / pageW));
    const x1 = Math.min(1, Math.max(0, maxX / pageW));
    const y0 = Math.min(1, Math.max(0, 1 - topPdf / pageH)); // top in top-down
    const y1 = Math.min(1, Math.max(0, 1 - botPdf / pageH)); // bottom in top-down

    phrases.push({
      text: group.map((i) => i.str).join(""),
      x0, y0, x1, y1,
    });
    group = null;
  }

  for (const item of sorted) {
    if (!group) {
      group = [item];
      continue;
    }

    const prev = group[group.length - 1]!;
    const prevY = prev.transform[5]!;
    const prevX = prev.transform[4]!;
    const prevW = prev.width || 8;
    const currY = item.transform[5]!;
    const currX = item.transform[4]!;

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
    const firstKey = phraseCache.keys().next().value;
    if (firstKey) phraseCache.delete(firstKey);
  }
  phraseCache.set(cacheKey, result);

  return result;
}
