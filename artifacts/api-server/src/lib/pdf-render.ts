import fs from "fs/promises";
import path from "path";
import { logger as rootLogger } from "./logger";

const logger = rootLogger.child({ module: "pdf-render" });

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

/**
 * Rasterize specific pages of a PDF to PNG files using @napi-rs/canvas.
 *
 * @param pdfPath   Absolute path to the source PDF
 * @param pageNums  1-indexed page numbers to render (floor_plan + both pages)
 * @param outputDir Directory where PNG files will be written (created if needed)
 * @param scale     Render scale (default 1.5 ≈ 108 dpi for a standard arch sheet)
 * @returns         Map of pageNum → absolute file path
 */
export async function renderFloorPlanPages(
  pdfPath: string,
  pageNums: number[],
  outputDir: string,
  scale = 1.5,
): Promise<Map<number, string>> {
  const result = new Map<number, string>();
  if (pageNums.length === 0) return result;

  const lib = await getPdfjs();
  // @napi-rs/canvas provides a Node Canvas-compatible API
  const { createCanvas } = await import("@napi-rs/canvas");

  await fs.mkdir(outputDir, { recursive: true });

  const rawBuffer = await fs.readFile(pdfPath);
  const data = new Uint8Array(rawBuffer);
  const doc = await lib.getDocument({ data, disableAutoFetch: true, disableStream: true }).promise;

  try {
    for (const pageNum of pageNums) {
      if (pageNum < 1 || pageNum > doc.numPages) continue;
      try {
        const page = await doc.getPage(pageNum);
        const viewport = page.getViewport({ scale });

        const canvasWidth = Math.ceil(viewport.width);
        const canvasHeight = Math.ceil(viewport.height);

        const canvasEl = createCanvas(canvasWidth, canvasHeight);
        const ctx = canvasEl.getContext("2d");

        await page.render({
          canvasContext: ctx as unknown as PdfjsCanvasContext,
          viewport,
        }).promise;

        const pngBuffer = await canvasEl.encode("png");
        const fileName = `page-${pageNum}.png`;
        const filePath = path.join(outputDir, fileName);
        await fs.writeFile(filePath, pngBuffer);
        result.set(pageNum, filePath);
        logger.debug({ pageNum, filePath }, "Rendered page to PNG");
      } catch (err) {
        logger.warn({ err, pageNum, pdfPath }, "renderFloorPlanPages: failed to render page — skipping");
      }
    }
  } finally {
    doc.destroy();
  }

  return result;
}
