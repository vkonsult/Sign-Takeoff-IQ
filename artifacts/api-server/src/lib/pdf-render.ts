import fs from "fs/promises";
import path from "path";
import { logger as rootLogger } from "./logger";
import { rasterizePage } from "./pdf-page-rasterizer";

const logger = rootLogger.child({ module: "pdf-render" });

/**
 * Rasterize specific pages of a PDF to PNG files.
 *
 * Delegates per-page rendering to `rasterizePage` (pdf-page-rasterizer.ts)
 * which handles caching, scale computation, and fast PNG encoding.
 *
 * @param pdfPath   Absolute path to the source PDF
 * @param pageNums  1-indexed page numbers to render
 * @param outputDir Directory where PNG files will be written (created if needed)
 * @param scale     Ignored — scale is now computed per-page from `maxPixels` in rasterizePage
 * @returns         Map of pageNum → absolute file path
 */
export async function renderFloorPlanPages(
  pdfPath: string,
  pageNums: number[],
  outputDir: string,
  _scale = 1.5,
): Promise<Map<number, string>> {
  const result = new Map<number, string>();
  if (pageNums.length === 0) return result;

  await fs.mkdir(outputDir, { recursive: true });

  logger.info({ pageNums: pageNums.length }, "renderFloorPlanPages: delegating to rasterizePage");

  await Promise.all(
    pageNums.map(async (pageNum) => {
      try {
        const filePath = await rasterizePage(pdfPath, pageNum, outputDir);
        result.set(pageNum, path.resolve(filePath));
      } catch (err) {
        logger.warn(
          { err, pageNum, pdfPath },
          "renderFloorPlanPages: failed to render page — skipping",
        );
      }
    }),
  );

  return result;
}
