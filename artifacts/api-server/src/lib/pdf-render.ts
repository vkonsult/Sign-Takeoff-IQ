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

  // Separate pages into those that need rendering vs already cached
  const toRender: number[] = [];
  for (const pageNum of pageNums) {
    const filePath = path.join(outputDir, `page-${pageNum}.png`);
    try {
      await fs.access(filePath);
      result.set(pageNum, filePath);
      logger.debug({ pageNum, filePath }, "Skipping already-rendered PNG");
    } catch {
      toRender.push(pageNum);
    }
  }

  if (toRender.length === 0) {
    logger.info({ cached: result.size }, "All PNG pages already cached — skipping render");
    return result;
  }

  logger.info({ toRender: toRender.length, cached: result.size }, "Rendering pages in parallel");
  const rawBuffer = await fs.readFile(pdfPath);
  const data = new Uint8Array(rawBuffer);
  const doc = await lib.getDocument({ data, disableAutoFetch: true, disableStream: true }).promise;

  try {
    // Render pages in parallel for speed
    await Promise.all(toRender.map(async (pageNum) => {
      if (pageNum < 1 || pageNum > doc.numPages) return;
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
    }));
  } finally {
    doc.destroy();
  }

  return result;
}

// ─── REGION DETECTION ────────────────────────────────────────────────────────

export interface PageRegionBbox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface PageRegions {
  floorPlan: PageRegionBbox | null;
  signSchedule: PageRegionBbox | null;
}

interface GeminiRegionAI {
  models: {
    generateContent: (opts: {
      model: string;
      contents: { role: string; parts: ({ text: string } | { inlineData: { mimeType: string; data: string } })[] }[];
      config?: { maxOutputTokens?: number; temperature?: number; thinkingConfig?: { thinkingBudget: number } };
    }) => Promise<{ text: string | undefined }>;
  };
}

const REGION_DETECT_PROMPT = `You are an architectural plan analyzer. This page contains BOTH a floor plan drawing area AND a sign schedule table on the same sheet.

Your task: identify the bounding box of each distinct region using normalized coordinates (0.0 = left/top edge, 1.0 = right/bottom edge of the full page image).

Rules:
- "floor_plan": the region containing the architectural floor plan drawing (rooms, walls, corridors, door openings, room name labels, sign callout bubbles/triangles/circles). Do NOT include the sign schedule table.
- "sign_schedule": the region containing the tabular sign schedule (columns like Sign ID, Type, Location, Quantity, Description). Do NOT include the floor plan drawing.
- If a region is not clearly present, return null for it.
- Coordinates must be strictly between 0.0 and 1.0.
- Be generous: extend the bbox slightly beyond the visible drawing content to avoid clipping sign callout markers near the edges.

Respond with ONLY valid JSON in this exact format (no markdown fences, no extra text):
{
  "floor_plan": { "x0": 0.0, "y0": 0.0, "x1": 1.0, "y1": 1.0 },
  "sign_schedule": { "x0": 0.0, "y0": 0.0, "x1": 1.0, "y1": 1.0 }
}

If a region is absent, use null:
{
  "floor_plan": null,
  "sign_schedule": null
}`;

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function parseBbox(raw: unknown): PageRegionBbox | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const x0 = typeof r.x0 === "number" ? r.x0 : null;
  const y0 = typeof r.y0 === "number" ? r.y0 : null;
  const x1 = typeof r.x1 === "number" ? r.x1 : null;
  const y1 = typeof r.y1 === "number" ? r.y1 : null;
  if (x0 === null || y0 === null || x1 === null || y1 === null) return null;
  const b: PageRegionBbox = {
    x0: clamp01(Math.min(x0, x1)),
    y0: clamp01(Math.min(y0, y1)),
    x1: clamp01(Math.max(x0, x1)),
    y1: clamp01(Math.max(y0, y1)),
  };
  // Reject degenerate boxes (width or height < 5% of page)
  if (b.x1 - b.x0 < 0.05 || b.y1 - b.y0 < 0.05) return null;
  return b;
}

/**
 * Use Gemini vision to detect floor plan drawing area and sign schedule table
 * bounding boxes on a pre-rendered PNG page.
 *
 * Only meaningful for pages classified as "both" (contain both a floor plan and
 * a sign schedule on the same sheet). For floor_plan-only pages, callers may
 * still use this to get a tighter drawing bbox than the heuristic.
 *
 * @param pngPath Absolute path to the pre-rendered PNG file
 * @param ai      Gemini AI client
 * @param pageNum Page number (for logging only)
 * @returns       Detected regions (floor_plan, sign_schedule) — either may be null
 */
export async function detectPageRegions(
  pngPath: string,
  ai: GeminiRegionAI,
  pageNum: number,
): Promise<PageRegions> {
  const fallback: PageRegions = { floorPlan: null, signSchedule: null };
  try {
    const pngBuffer = await fs.readFile(pngPath);
    const base64 = pngBuffer.toString("base64");

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType: "image/png", data: base64 } },
            { text: REGION_DETECT_PROMPT },
          ],
        },
      ],
      config: {
        maxOutputTokens: 512,
        temperature: 0.0,
        thinkingConfig: { thinkingBudget: 0 },
      },
    });

    const raw = (response.text ?? "").trim();
    // Strip any accidental markdown fences
    const json = raw.replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/i, "").trim();
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(json);
    } catch {
      logger.warn({ pageNum, raw }, "detectPageRegions: JSON parse failed");
      return fallback;
    }

    const floorPlan = parsed.floor_plan === null ? null : parseBbox(parsed.floor_plan);
    const signSchedule = parsed.sign_schedule === null ? null : parseBbox(parsed.sign_schedule);

    logger.info({ pageNum, floorPlan, signSchedule }, "detectPageRegions: regions detected");
    return { floorPlan, signSchedule };
  } catch (err) {
    logger.warn({ err, pageNum, pngPath }, "detectPageRegions: failed — non-fatal, falling back to heuristic");
    return fallback;
  }
}
