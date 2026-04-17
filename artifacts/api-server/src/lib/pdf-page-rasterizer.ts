import fs from "fs/promises";
import path from "path";
import { logger as rootLogger } from "./logger";

const logger = rootLogger.child({ module: "pdf-page-rasterizer" });

interface PdfjsCanvasContext {
  canvas: unknown;
}

interface PdfjsRenderTask {
  promise: Promise<void>;
}

interface PdfjsViewport {
  width: number;
  height: number;
}

interface PdfjsPage {
  getViewport(opts: { scale: number }): PdfjsViewport;
  render(opts: { canvasContext: PdfjsCanvasContext; viewport: PdfjsViewport }): PdfjsRenderTask;
}

interface PdfjsDocument {
  numPages: number;
  getPage(num: number): Promise<PdfjsPage>;
  destroy(): void;
}

interface PdfjsLib {
  getDocument(opts: { data: Uint8Array; disableAutoFetch: boolean; disableStream: boolean }): {
    promise: Promise<PdfjsDocument>;
  };
  GlobalWorkerOptions: { workerSrc: string };
}

let pdfjsLib: PdfjsLib | null = null;

async function getPdfjs(): Promise<PdfjsLib> {
  if (pdfjsLib) return pdfjsLib;
  const imported = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const lib = imported as unknown as PdfjsLib;
  try {
    const req = (globalThis as Record<string, unknown>)["require"] as (
      NodeRequire & { resolve: (id: string) => string }
    ) | undefined;
    if (req?.resolve) {
      const workerPath = req.resolve("pdfjs-dist/legacy/build/pdf.worker.min.mjs");
      lib.GlobalWorkerOptions.workerSrc = `file://${workerPath}`;
    }
  } catch {
    lib.GlobalWorkerOptions.workerSrc = "";
  }
  pdfjsLib = lib;
  return lib;
}

export interface RasterizeOptions {
  /** Maximum total pixel count (width × height). Default: 8_000_000 (8 MP). */
  maxPixels?: number;
  /** PNG zlib compression level 0–9. 0 = no compression, 1 = fastest. Default: 1. */
  compressionLevel?: number;
}

/**
 * Rasterize a single PDF page to a PNG file.
 *
 * @param pdfPath         Absolute path to the source PDF.
 * @param pageNum         1-indexed page number to render.
 * @param outputDir       Directory where the PNG will be written (created if needed).
 * @param options         Optional rendering options (maxPixels, compressionLevel).
 * @returns               Absolute path to the written PNG file (`page-{n}.png`).
 */
export async function rasterizePage(
  pdfPath: string,
  pageNum: number,
  outputDir: string,
  options?: RasterizeOptions,
): Promise<string> {
  const maxPixels = options?.maxPixels ?? 8_000_000;
  const compressionLevel = options?.compressionLevel ?? 1;

  await fs.mkdir(outputDir, { recursive: true });

  const fileName = `page-${pageNum}.png`;
  const filePath = path.resolve(outputDir, fileName);

  // Cache check — skip re-rendering if the file already exists.
  try {
    await fs.access(filePath);
    logger.debug({ pageNum, filePath }, "rasterizePage: cache hit — returning existing PNG");
    return filePath;
  } catch {
    // File does not exist; proceed to render.
  }

  const t0 = Date.now();

  const lib = await getPdfjs();
  const { createCanvas } = await import("@napi-rs/canvas");

  const rawBuffer = await fs.readFile(pdfPath);
  const data = new Uint8Array(rawBuffer);
  const doc = await lib.getDocument({ data, disableAutoFetch: true, disableStream: true }).promise;

  try {
    if (pageNum < 1 || pageNum > doc.numPages) {
      throw new Error(
        `rasterizePage: pageNum ${pageNum} is out of range (document has ${doc.numPages} pages)`,
      );
    }

    const page = await doc.getPage(pageNum);

    // Compute scale so that (width * scale) * (height * scale) <= maxPixels.
    const baseViewport = page.getViewport({ scale: 1 });
    const basePixels = baseViewport.width * baseViewport.height;
    const scale = basePixels > maxPixels ? Math.sqrt(maxPixels / basePixels) : 1;

    const viewport = page.getViewport({ scale });
    const canvasWidth = Math.ceil(viewport.width);
    const canvasHeight = Math.ceil(viewport.height);

    logger.info(
      {
        pageNum,
        canvasWidth,
        canvasHeight,
        scale,
        compressionLevel,
        maxPixels,
      },
      "rasterizePage: starting render",
    );

    const canvasEl = createCanvas(canvasWidth, canvasHeight);
    const ctx = canvasEl.getContext("2d");

    await page.render({
      canvasContext: ctx as unknown as PdfjsCanvasContext,
      viewport,
    }).promise;

    // Encode as PNG. @napi-rs/canvas accepts compression level (0–9) as the
    // second argument to encode() when format is "png".
    const pngBuffer = await canvasEl.encode("png", compressionLevel);
    await fs.writeFile(filePath, pngBuffer);

    const durationMs = Date.now() - t0;
    logger.info(
      {
        pageNum,
        canvasWidth,
        canvasHeight,
        scale,
        compressionLevel,
        durationMs,
        filePath,
      },
      `rasterizePage: rendered page ${pageNum} in ${durationMs}ms`,
    );

    return filePath;
  } finally {
    doc.destroy();
  }
}
