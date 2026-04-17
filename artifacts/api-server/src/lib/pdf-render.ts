import fs from "fs/promises";
import path from "path";
import { logger as rootLogger } from "./logger";
import { rasterizePages } from "./pdf-page-rasterizer";

const logger = rootLogger.child({ module: "pdf-render" });

/**
 * Rasterize specific pages of a PDF to PNG files.
 *
 * Delegates to `rasterizePages` (pdf-page-rasterizer.ts) which loads the PDF
 * once, skips already-cached pages, and renders all remaining pages from the
 * same parsed document — eliminating redundant I/O for multi-page batches.
 *
 * @param pdfPath   Absolute path to the source PDF
 * @param pageNums  1-indexed page numbers to render
 * @param outputDir Directory where PNG files will be written (created if needed)
 * @param scale     Ignored — scale is computed per-page from `maxPixels` in rasterizePages
 * @returns         Map of pageNum → absolute file path
 */
export async function renderFloorPlanPages(
  pdfPath: string,
  pageNums: number[],
  outputDir: string,
  _scale = 1.5,
): Promise<Map<number, string>> {
  if (pageNums.length === 0) return new Map();

  await fs.mkdir(outputDir, { recursive: true });

  logger.info(
    { pageNums: pageNums.length },
    "renderFloorPlanPages: delegating to rasterizePages (single PDF load)",
  );

  const rendered = await rasterizePages(pdfPath, pageNums, outputDir);

  const result = new Map<number, string>();
  for (const [pageNum, filePath] of rendered) {
    result.set(pageNum, path.resolve(filePath));
  }

  return result;
}
