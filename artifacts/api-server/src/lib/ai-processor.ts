/**
 * AI Processor — all Gemini AI calls exposed as independently callable functions.
 * None of these functions are called during normal PDF processing (processJob).
 * They are invoked on-demand via the /api/jobs/:jobId/ai-scan endpoint.
 */

import fs from "fs/promises";
import { ai } from "@workspace/integrations-gemini-ai";
import {
  extractProjectInfo,
  extractFloorPlanOnly,
  extractSignCalloutsPng,
  type ProjectInfo,
  type ExtractedSignRow,
  type ScanResult,
} from "./extraction";
import { logger } from "./logger";
import { getFilePageImagesDir, PAGES_DIR } from "./storage";
import { renderFloorPlanPages } from "./pdf-render";
import { extractPagePhrases, classifyPageFromPhrases, CANONICAL_LEVEL_NAMES } from "./pdf-words";
import path from "path";
import { db } from "@workspace/db";
import { eq } from "drizzle-orm";
import { signTypeSpecsTable, jobFilesTable } from "@workspace/db";
import { enrichWithGemini } from "./signage-schedule-parser";

// ── AI Call Type ──────────────────────────────────────────────────────────────

export type AiCallType =
  | "sign_schedule_enrich"
  | "project_info"
  | "floor_plan_text"
  | "vision_fallback"
  | "bbox_detection"
  | "title_block_vision";

// ── AI Call Registry ──────────────────────────────────────────────────────────

export interface AiCallDescriptor {
  type: AiCallType;
  name: string;
  description: string;
  prompt: string;
}

export const AI_CALL_REGISTRY: AiCallDescriptor[] = [
  {
    type: "sign_schedule_enrich",
    name: "Sign Schedule Diagram Enrichment",
    description: "Scans sign type diagram regions extracted from sign schedule pages. Sends each cropped diagram image to Gemini Vision to extract material specs, finish notes, mounting details, and any other written annotations not captured by the text parser. Results are saved to the sign type spec records.",
    prompt: `You are examining a cropped diagram from an architectural sign schedule. This image shows the design, dimensions, and specification notes for a single sign type.

Extract as much detail as possible:
- Material composition (substrate, face, backer)
- Finish and color specifications
- Mounting method and hardware
- Illumination or electrical requirements
- Any ADA or code compliance notes
- Fabrication or installation notes

Return a JSON object with keys: material, finish, mounting, illumination, ada_notes, fabrication_notes, other_notes.
Use null for any field you cannot determine from the image.`,
  },
  {
    type: "project_info",
    name: "Project Info Extraction",
    description: "Reads title blocks, cover sheets, and drawing indexes to extract the project name, address, city, state, zip, occupancy type, and AHJ. Results are saved to the job record.",
    prompt: `You are reviewing architectural plans. Look through all pages below for any title block, cover sheet, drawing index, or project header that contains project identification information.

Extract the following details:
- project_name: The building or project name
- address: The full street address of the project site
- city: The city name
- state: The 2-letter US state abbreviation
- zip: Zip / postal code if visible
- occupancy_type: The primary building occupancy/use
- ahj: Authority Having Jurisdiction if mentioned

Return ONLY a single JSON object (not an array).
If no project information is found: {"project_name":null,"address":null,"city":null,"state":null,"zip":null,"occupancy_type":null,"ahj":null}`,
  },
  {
    type: "floor_plan_text",
    name: "Floor Plan ADA & Code Sign Extraction",
    description: "Analyzes floor plan text layers with Gemini to identify all required signage per ADA, IBC, NFPA, and OSHA codes. Generates sign entries for every identified room and code-required location.",
    prompt: `You are an expert sign contractor, ADA compliance specialist, and fire/life-safety code consultant performing a comprehensive sign takeoff from architectural floor plans.

Identify ALL spaces and rooms visible in these plans and determine the COMPLETE REQUIRED SIGNAGE for each space based on:
1. ADA Standards for Accessible Design (Section 703 — Signs)
2. IBC egress and life-safety signage
3. NFPA 101 Life Safety Code
4. NFPA 10, 13, 14, 72, 80, 96, and 170 fire protection sign requirements
5. OSHA 1910.145 safety signage

For every identifiable space, output one JSON object per required sign type.
Return ONLY a valid JSON array. If you cannot read the floor plan, return [].`,
  },
  {
    type: "vision_fallback",
    name: "Vision Fallback (Image-Based Sign Detection)",
    description: "Uses Gemini Vision to scan floor plan PNG images for sign callout bubbles, symbols, and labels that may not appear in the text layer. Supplements text-based extraction.",
    prompt: `You are analyzing a floor plan image. Identify all sign callout bubbles, sign symbols, and labeled sign locations visible in the image.

For each sign callout or symbol found, extract:
- sign_type: the type of sign indicated
- sign_identifier: the callout label or number (e.g. "S-01", "EX-1")
- location: the room or area label nearest to the callout
- page_number: the page number shown in this image
- confidence: 0.0–1.0 (how certain you are this is a real sign callout)
- bbox_x, bbox_y, bbox_w, bbox_h: normalized 0.0–1.0 bounding box of the callout

Return ONLY a valid JSON array.`,
  },
  {
    type: "bbox_detection",
    name: "Visual Bbox Detection (Sign Callout Scan)",
    description: "Sends pre-rendered floor plan PNG images to Gemini for visual detection of sign callout symbols. Returns normalized bounding boxes used to place markers on the floor plan and spatially verify text-extracted signs.",
    prompt: `You are analyzing a floor plan drawing image for sign callout detection.

Identify every visible sign callout bubble, sign symbol circle/diamond, and sign location marker on this floor plan. For each:
- label_text: the text inside or next to the callout (sign ID, number, or type code)
- sign_type: inferred sign type from label or context
- page_number: which page this is
- bbox_x, bbox_y, bbox_w, bbox_h: normalized 0.0–1.0 bounding box coordinates
- confidence: 0.0–1.0

Return ONLY a valid JSON array. If no sign callouts are visible, return [].`,
  },
  {
    type: "title_block_vision",
    name: "Title Block Vision (Floor Level Detection)",
    description: "Uses Gemini Vision to read drawing title blocks on floor plan pages and identify which floor level each page represents (lower level, main level, upper level, attic). Used to route sign locations to the correct floor plan page.",
    prompt: `You are reading the title block of an architectural floor plan drawing.
Identify which floor level or zone this plan represents.
Return ONLY the level name as a single lowercase phrase from this list if it matches:
- "lower level"
- "main level"
- "upper level"
- "attic"
If none match, return "none".
Do not include any other text or explanation.`,
  },
];

export function getAiCallDescriptor(type: AiCallType): AiCallDescriptor | undefined {
  return AI_CALL_REGISTRY.find((d) => d.type === type);
}

// ── AI Callable Functions ─────────────────────────────────────────────────────

export interface AiCallContext {
  jobId: string;
  file: {
    id: string;
    storedPath: string;
    originalName: string;
    pageStats?: {
      floorPlanPages?: number[];
      signSchedulePages?: number[];
      bothPages?: number[];
      pageImagePaths?: Record<string, string> | null;
    } | null;
  };
  projectContext?: ProjectInfo;
  pageImagePaths?: Record<string, string>;
}

export interface ProjectInfoResult {
  info: ProjectInfo;
  inputTokens: number;
  outputTokens: number;
}

export async function runProjectInfoExtraction(
  file: { storedPath: string; id: string },
): Promise<ProjectInfoResult> {
  const { info, inputTokens, outputTokens } = await extractProjectInfo(file.storedPath, file.id, ai);
  return { info, inputTokens, outputTokens };
}

export interface SignExtractionResult {
  rows: ExtractedSignRow[];
  inputTokens: number;
  outputTokens: number;
  pageCount: number;
}

export async function runFloorPlanTextExtraction(
  file: { storedPath: string; id: string },
  projectContext?: ProjectInfo,
  spatialPageTypes?: Map<number, import("./pdf-words").SpatialPageType>,
): Promise<SignExtractionResult> {
  // Isolated: runs ONLY the floor plan ADA Gemini pass — no sign schedule pass, no fallback
  const result = await extractFloorPlanOnly(
    file.storedPath,
    file.id,
    ai,
    projectContext,
    spatialPageTypes,
  );
  return {
    rows: result.rows,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    pageCount: result.pageCount,
  };
}

export interface BboxDetectionResult {
  scanResult: ScanResult;
  pageImagePaths: Record<string, string>;
}

export async function runBboxDetection(
  file: { storedPath: string; id: string; originalName: string },
  existingPageImagePaths?: Record<string, string>,
): Promise<BboxDetectionResult> {
  // Determine which pages to scan
  const numPages = await (await import("./pdf-words")).getPdfPageCount(file.storedPath);
  const relevantPages = new Set<number>();

  // Classify pages to find floor plan / sign schedule
  for (let pageNum = 1; pageNum <= numPages; pageNum++) {
    try {
      const pageWords = await extractPagePhrases(file.storedPath, file.id, pageNum);
      const { type: spatialType } = classifyPageFromPhrases(pageWords.phrases);
      if (spatialType === "floor_plan" || spatialType === "sign_schedule" || spatialType === "both") {
        relevantPages.add(pageNum);
      }
    } catch {
      // skip pages that fail classification
    }
  }

  if (relevantPages.size === 0) {
    return {
      scanResult: { skipped: true, skipReason: "no relevant pages found", callouts: [], inputTokens: 0, outputTokens: 0 },
      pageImagePaths: existingPageImagePaths ?? {},
    };
  }

  // Render PNGs if not already available
  let pageImagePaths: Record<string, string> = existingPageImagePaths ?? {};
  const missingPages = Array.from(relevantPages).filter((p) => !pageImagePaths[String(p)]);
  if (missingPages.length > 0) {
    const outputDir = getFilePageImagesDir(file.id);
    const rendered = await renderFloorPlanPages(file.storedPath, missingPages, outputDir);
    const pagesParent = path.dirname(PAGES_DIR);
    for (const [pageNum, absPath] of rendered) {
      const rel = path.relative(pagesParent, absPath);
      pageImagePaths = { ...pageImagePaths, [String(pageNum)]: rel };
    }
  }

  // Build absolute paths for Gemini
  const absImagePaths: Record<string, string> = {};
  const pagesParent = path.dirname(PAGES_DIR);
  for (const [k, rel] of Object.entries(pageImagePaths)) {
    absImagePaths[k] = path.resolve(pagesParent, rel);
  }

  const scanResult = await extractSignCalloutsPng(
    file.originalName,
    ai,
    absImagePaths,
    relevantPages,
  );

  return { scanResult, pageImagePaths };
}

export interface TitleBlockVisionResult {
  levelMap: Map<number, string>;
}

export async function runTitleBlockVision(
  file: { storedPath: string; id: string },
  pageImagePaths: Record<string, string>,
): Promise<TitleBlockVisionResult> {
  const levelMap = new Map<number, string>();
  const LEVEL_VISION_PROMPT = `You are reading the title block of an architectural floor plan drawing.
Identify which floor level or zone this plan represents.
Return ONLY the level name as a single lowercase phrase from this list if it matches:
- "lower level"
- "main level"
- "upper level"
- "attic"
If none match, return "none".
Do not include any other text or explanation.`;

  const pagesParent = path.dirname(PAGES_DIR);
  const pageNums = Object.keys(pageImagePaths).map(Number).filter((n) => !isNaN(n));

  await Promise.all(
    pageNums.map(async (pageNum) => {
      const relPath = pageImagePaths[String(pageNum)];
      if (!relPath) return;
      const absPath = path.resolve(pagesParent, relPath);
      try {
        const pngBuffer = await fs.readFile(absPath);
        const base64 = pngBuffer.toString("base64");
        const response = await (ai as {
          models: {
            generateContent: (opts: {
              model: string;
              contents: { role: string; parts: ({ text: string } | { inlineData: { mimeType: string; data: string } })[] }[];
              config?: { maxOutputTokens?: number; temperature?: number; thinkingConfig?: { thinkingBudget: number } };
            }) => Promise<{ text: string | undefined }>;
          };
        }).models.generateContent({
          model: "gemini-2.5-flash",
          contents: [
            {
              role: "user",
              parts: [
                { inlineData: { mimeType: "image/png", data: base64 } },
                { text: LEVEL_VISION_PROMPT },
              ],
            },
          ],
          config: { maxOutputTokens: 32, temperature: 0.0, thinkingConfig: { thinkingBudget: 0 } },
        });
        const raw = (response.text ?? "").trim().toLowerCase();
        const matched = CANONICAL_LEVEL_NAMES.find((l) => raw.includes(l));
        if (matched) {
          levelMap.set(pageNum, matched);
        }
      } catch (err) {
        logger.debug({ err, fileId: file.id, pageNum }, "title_block_vision failed for page — non-fatal");
      }
    })
  );

  return { levelMap };
}

export async function runVisionFallback(
  file: { storedPath: string; id: string; originalName: string },
  pageImagePaths: Record<string, string>,
): Promise<BboxDetectionResult> {
  const relevantPages = new Set(Object.keys(pageImagePaths).map(Number).filter((n) => !isNaN(n)));
  if (relevantPages.size === 0) {
    return {
      scanResult: { skipped: true, skipReason: "no images available", callouts: [], inputTokens: 0, outputTokens: 0 },
      pageImagePaths,
    };
  }
  const pagesParent = path.dirname(PAGES_DIR);
  const absImagePaths: Record<string, string> = {};
  for (const [k, rel] of Object.entries(pageImagePaths)) {
    absImagePaths[k] = path.resolve(pagesParent, rel);
  }
  const scanResult = await extractSignCalloutsPng(file.originalName, ai, absImagePaths, relevantPages);
  return { scanResult, pageImagePaths };
}

export interface SignScheduleEnrichResult {
  enrichedCount: number;
  skippedCount: number;
  specResults: Array<{ typeCode: string; status: "enriched" | "skipped" | "error"; cropImageUrl?: string }>;
}

/**
 * Runs Gemini Vision enrichment on sign type diagram regions for a job.
 * Groups specs by source file (using sign_schedule page classifications stored
 * in jobFilesTable.pageStats) and runs enrichWithGemini per file group.
 */
export async function runSignScheduleEnrich(jobId: string): Promise<SignScheduleEnrichResult> {
  const specs = await db
    .select()
    .from(signTypeSpecsTable)
    .where(eq(signTypeSpecsTable.jobId, jobId));

  const specsWithDrawing = specs.filter((s) => s.hasDrawing && s.cropBox);
  if (specsWithDrawing.length === 0) {
    return { enrichedCount: 0, skippedCount: specs.length, specResults: [] };
  }

  const jobFiles = await db
    .select()
    .from(jobFilesTable)
    .where(eq(jobFilesTable.jobId, jobId));

  const fileById = new Map(jobFiles.map((f) => [f.id, f]));

  // Group specs by the source file they were parsed from (stored in sourceFileId)
  const specsByFile = new Map<string, typeof specsWithDrawing>();
  for (const spec of specsWithDrawing) {
    const file = spec.sourceFileId ? fileById.get(spec.sourceFileId) : undefined;
    const pdfPath = file?.storedPath ?? jobFiles[0]?.storedPath;
    if (!pdfPath) continue;
    const group = specsByFile.get(pdfPath) ?? [];
    group.push(spec);
    specsByFile.set(pdfPath, group);
  }

  const specResults: SignScheduleEnrichResult["specResults"] = [];
  let enrichedCount = 0;

  for (const [pdfPath, fileSpecs] of specsByFile) {
    const jobFile = jobFiles.find((f) => f.storedPath === pdfPath);
    const cropDir = jobFile ? path.join(PAGES_DIR, jobFile.id, "crops") : null;

    try {
      const parserSpecs = fileSpecs.map((s) => ({
        typeCode: s.typeCode,
        dimensions: s.dimensions,
        material: s.material,
        features: (s.features as string[] | null) ?? [],
        keynoteMap: (s.keynoteMap as Record<string, string> | null) ?? {},
        cropBox: s.cropBox as { x: number; y: number; w: number; h: number; pageNum: number } | null,
        hasDrawing: s.hasDrawing,
      }));

      const enriched = await enrichWithGemini(
        parserSpecs,
        pdfPath,
        ai,
        cropDir
          ? async (typeCode, pngBuffer) => {
              const fsMod = await import("fs/promises");
              await fsMod.mkdir(cropDir, { recursive: true });
              const fileName = `crop-${typeCode}.png`;
              await fsMod.writeFile(path.join(cropDir, fileName), pngBuffer);
              return `/api/jobs/${jobId}/schedule-crops/${jobFile!.id}/${fileName}`;
            }
          : undefined,
      );

      for (const [typeCode, result] of enriched) {
        const spec = fileSpecs.find((s) => s.typeCode === typeCode);
        if (!spec) continue;
        await db.update(signTypeSpecsTable).set({
          geminiNotes: result.notes as Record<string, unknown>,
          cropImageUrl: result.cropImageUrl ?? null,
          geminiEnriched: true,
        }).where(eq(signTypeSpecsTable.id, spec.id));
        specResults.push({ typeCode, status: "enriched", cropImageUrl: result.cropImageUrl ?? undefined });
        enrichedCount++;
      }

      // Mark non-enriched specs from this file as skipped
      for (const spec of fileSpecs) {
        if (!enriched.has(spec.typeCode)) {
          specResults.push({ typeCode: spec.typeCode, status: "skipped" });
        }
      }
    } catch (err) {
      logger.warn({ err, pdfPath, jobId }, "runSignScheduleEnrich: enrichment failed for file group");
      for (const spec of fileSpecs) {
        specResults.push({ typeCode: spec.typeCode, status: "error" });
      }
    }
  }

  return { enrichedCount, skippedCount: specs.length - enrichedCount, specResults };
}
