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
import { eq, and } from "drizzle-orm";
import { signTypeSpecsTable, jobFilesTable, plaqueSchedulesTable, occupantLoadsTable } from "@workspace/db";
import { enrichWithGemini } from "./signage-schedule-parser";
import { getPdfPageCount } from "./pdf-words";
import type { StoredOccupantLoad } from "./room-inventory.js";

// ── AI Call Type ──────────────────────────────────────────────────────────────

export type AiCallType =
  | "sign_schedule_enrich"
  | "project_info"
  | "floor_plan_text"
  | "vision_fallback"
  | "bbox_detection"
  | "title_block_vision"
  | "plaque_schedule"
  | "occupant_loads";

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
  {
    type: "plaque_schedule",
    name: "Plaque Schedule Extraction (Step 3)",
    description: "Reads the first sign schedule or 'both' page at 200 DPI and extracts every plaque type defined in the architectural plaque/signage schedule. Results (type_id, name, braille, letter height, trigger, etc.) are stored in the plaque_schedules table and used to map sign callouts to physical plaque specifications.",
    prompt: `You are reading an architectural signage/plaque schedule sheet.
Extract every plaque type shown. Return ONLY valid JSON:
{
  "plaques": [{
    "type_id": "A",
    "name": "Room Name Sign",
    "braille": true,
    "insert": false,
    "insert_size": null,
    "letter_height": "5/8\\" cap",
    "trigger": "Default room ID for occupied rooms",
    "maps_to_column": "Room ID"
  }],
  "general_notes": {
    "code_citation": "521 CMR 41 MAAB",
    "mounting_height_sheet": "A-000",
    "fallback_mounting": "nearest adjacent wall"
  }
}`,
  },
  {
    type: "occupant_loads",
    name: "Occupant Loads Extraction (Step 4b)",
    description: "Scans pages classified as 'other' that contain egress/life-safety keywords at 200 DPI, then extracts occupant load and occupancy group for every room listed in the egress drawing's Occupant Loads table. Results are stored in the occupant_loads table and used to recompute isAssembly flags for rooms with occupantLoad >= 50.",
    prompt: `You are reading an architectural egress drawing with an Occupant Loads table.
Extract the occupant load and occupancy group for every room listed.
Return ONLY valid JSON:
{
  "rooms": [
    { "room_num": "138", "room_name": "TRAINING/COMMUNITY", "occupant_load": 240, "occupancy_group": "A-2" }
  ]
}`,
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
          geminiNotes: (result.notes as unknown) as Record<string, unknown>,
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

// ── Gemini Vision Helper ───────────────────────────────────────────────────────

type GeminiAi = typeof ai;

async function callGeminiWithImage(
  aiClient: GeminiAi,
  imagePath: string,
  prompt: string,
  maxOutputTokens = 2048,
): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  const pngBuffer = await fs.readFile(imagePath);
  const base64 = pngBuffer.toString("base64");

  const response = await (aiClient as {
    models: {
      generateContent: (opts: {
        model: string;
        contents: { role: string; parts: ({ text: string } | { inlineData: { mimeType: string; data: string } })[] }[];
        config?: { maxOutputTokens?: number; temperature?: number; thinkingConfig?: { thinkingBudget: number } };
      }) => Promise<{ text: string | undefined; usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } }>;
    };
  }).models.generateContent({
    model: "gemini-2.5-flash",
    contents: [
      {
        role: "user",
        parts: [
          { inlineData: { mimeType: "image/png", data: base64 } },
          { text: prompt },
        ],
      },
    ],
    config: { maxOutputTokens, temperature: 0.1, thinkingConfig: { thinkingBudget: 0 } },
  });

  const inputTokens = response.usageMetadata?.promptTokenCount ?? 0;
  const outputTokens = response.usageMetadata?.candidatesTokenCount ?? 0;
  return { text: response.text ?? "", inputTokens, outputTokens };
}

function extractJsonFromText(text: string): unknown {
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const jsonStr = fenceMatch ? fenceMatch[1].trim() : text.trim();
  return JSON.parse(jsonStr);
}

// ── Plaque Schedule Extraction ────────────────────────────────────────────────

const PLAQUE_SCHEDULE_PROMPT = `You are reading an architectural signage/plaque schedule sheet.
Extract every plaque type shown. Return ONLY valid JSON:
{
  "plaques": [{
    "type_id": "A",
    "name": "Room Name Sign",
    "braille": true,
    "insert": false,
    "insert_size": null,
    "letter_height": "5/8\\" cap",
    "trigger": "Default room ID for occupied rooms",
    "maps_to_column": "Room ID"
  }],
  "general_notes": {
    "code_citation": "521 CMR 41 MAAB",
    "mounting_height_sheet": "A-000",
    "fallback_mounting": "nearest adjacent wall"
  }
}`;

export interface PlaqueType {
  type_id: string;
  name?: string | null;
  braille?: boolean | null;
  insert?: boolean | null;
  insert_size?: string | null;
  letter_height?: string | null;
  trigger?: string | null;
  maps_to_column?: string | null;
}

export interface PlaqueScheduleExtractionResult {
  plaques: PlaqueType[];
  generalNotes: Record<string, unknown> | null;
  sourcePage: number | null;
  inputTokens: number;
  outputTokens: number;
  skipped?: boolean;
  skipReason?: string;
}

/**
 * Runs plaque schedule extraction for a job file.
 * Finds the first page classified as sign_schedule or both, renders it at 200 DPI,
 * sends to Gemini, and stores the extracted plaque types in plaque_schedules table.
 */
export async function runPlaqueScheduleExtraction(
  jobId: string,
  file: { id: string; storedPath: string; pageStats?: { signSchedulePages?: number[]; bothPages?: number[] } | null },
): Promise<PlaqueScheduleExtractionResult> {
  const pageStats = file.pageStats;
  const signSchedulePages = [
    ...(pageStats?.signSchedulePages ?? []),
    ...(pageStats?.bothPages ?? []),
  ];

  // If no classified pages, dynamically scan to find sign schedule pages
  const targetPages = signSchedulePages;
  if (targetPages.length === 0) {
    const numPages = await getPdfPageCount(file.storedPath);
    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
      try {
        const pageWords = await extractPagePhrases(file.storedPath, file.id, pageNum);
        const { type } = classifyPageFromPhrases(pageWords.phrases);
        if (type === "sign_schedule" || type === "both") {
          targetPages.push(pageNum);
        }
      } catch {
        // skip pages that fail classification
      }
    }
  }

  if (targetPages.length === 0) {
    return {
      plaques: [],
      generalNotes: null,
      sourcePage: null,
      inputTokens: 0,
      outputTokens: 0,
      skipped: true,
      skipReason: "No sign schedule pages found",
    };
  }

  // Render the first sign schedule page at 200 DPI (scale = 200/72)
  const sourcePage = targetPages[0];
  const outputDir = getFilePageImagesDir(file.id);
  const DPI_200_SCALE = 200 / 72;
  const rendered = await renderFloorPlanPages(file.storedPath, [sourcePage], outputDir, DPI_200_SCALE);
  const imagePath = rendered.get(sourcePage);

  if (!imagePath) {
    return {
      plaques: [],
      generalNotes: null,
      sourcePage,
      inputTokens: 0,
      outputTokens: 0,
      skipped: true,
      skipReason: "Failed to render sign schedule page",
    };
  }

  const { text, inputTokens, outputTokens } = await callGeminiWithImage(ai, imagePath, PLAQUE_SCHEDULE_PROMPT, 1024);

  let plaques: PlaqueType[] = [];
  let generalNotes: Record<string, unknown> | null = null;

  try {
    const parsed = extractJsonFromText(text) as { plaques?: unknown; general_notes?: unknown };
    if (Array.isArray(parsed?.plaques)) {
      plaques = parsed.plaques as PlaqueType[];
    }
    if (parsed?.general_notes && typeof parsed.general_notes === "object") {
      generalNotes = parsed.general_notes as Record<string, unknown>;
    }
  } catch (err) {
    logger.warn({ err, jobId, fileId: file.id, rawText: text.slice(0, 500) }, "runPlaqueScheduleExtraction: failed to parse Gemini JSON");
  }

  logger.info({ jobId, fileId: file.id, plaqueCount: plaques.length, sourcePage, inputTokens, outputTokens }, "runPlaqueScheduleExtraction: complete");

  return { plaques, generalNotes, sourcePage, inputTokens, outputTokens };
}

/**
 * Merges plaque schedule data for a job into existing rows instead of replacing them.
 *
 * Strategy:
 * - Existing rows matched by typeId that were NOT manually edited are updated with AI values.
 * - Existing rows that WERE manually edited are left untouched — UNLESS overwrite=true, in
 *   which case all rows are updated and the manuallyEdited flag is reset to false.
 * - New AI rows with no existing match are inserted.
 * - Existing rows not found by AI are left in place (not deleted).
 *
 * @param overwrite - When true, manually-edited rows are also updated and their flag is cleared.
 */
export async function persistPlaqueSchedule(
  jobId: string,
  plaques: PlaqueType[],
  generalNotes: Record<string, unknown> | null,
  sourcePage: number | null,
  overwrite = false,
): Promise<void> {
  const existingRows = await db
    .select()
    .from(plaqueSchedulesTable)
    .where(eq(plaqueSchedulesTable.jobId, jobId));

  const existingByTypeId = new Map(existingRows.map((r) => [r.typeId.toLowerCase(), r]));

  const toInsert: PlaqueType[] = [];
  let updatedCount = 0;
  let skippedCount = 0;

  for (const p of plaques) {
    const typeId = String(p.type_id ?? "");
    if (!typeId) continue;
    const existing = existingByTypeId.get(typeId.toLowerCase());

    if (!existing) {
      toInsert.push(p);
    } else if (!existing.manuallyEdited || overwrite) {
      await db
        .update(plaqueSchedulesTable)
        .set({
          name: p.name ?? null,
          braille: p.braille ?? null,
          insert: p.insert ?? null,
          insertSize: p.insert_size ?? null,
          letterHeight: p.letter_height ?? null,
          trigger: p.trigger ?? null,
          mapsToColumn: p.maps_to_column ?? null,
          generalNotes,
          rawJson: p as unknown as Record<string, unknown>,
          sourcePage,
          manuallyEdited: false,
        })
        .where(and(eq(plaqueSchedulesTable.id, existing.id), eq(plaqueSchedulesTable.jobId, jobId)));
      updatedCount++;
    } else {
      skippedCount++;
    }
  }

  if (toInsert.length > 0) {
    await db.insert(plaqueSchedulesTable).values(
      toInsert.map((p) => ({
        jobId,
        typeId: String(p.type_id ?? ""),
        name: p.name ?? null,
        braille: p.braille ?? null,
        insert: p.insert ?? null,
        insertSize: p.insert_size ?? null,
        letterHeight: p.letter_height ?? null,
        trigger: p.trigger ?? null,
        mapsToColumn: p.maps_to_column ?? null,
        generalNotes,
        rawJson: p as unknown as Record<string, unknown>,
        sourcePage,
      })),
    );
  }

  logger.info(
    { jobId, aiCount: plaques.length, inserted: toInsert.length, updated: updatedCount, skipped: skippedCount, overwrite },
    "persistPlaqueSchedule: merged",
  );
}

// ── Occupant Loads Extraction ─────────────────────────────────────────────────

const OCCUPANT_LOADS_PROMPT = `You are reading an architectural egress drawing with an Occupant Loads table.
Extract the occupant load and occupancy group for every room listed.
Return ONLY valid JSON:
{
  "rooms": [
    { "room_num": "138", "room_name": "TRAINING/COMMUNITY", "occupant_load": 240, "occupancy_group": "A-2" }
  ]
}`;

const EGRESS_KEYWORDS = ["egress", "occupant load", "life safety", "occupancy group"];

export interface OccupantLoadRoom {
  room_num: string;
  room_name?: string | null;
  occupant_load?: number | null;
  occupancy_group?: string | null;
}

export interface OccupantLoadsExtractionResult {
  rooms: OccupantLoadRoom[];
  sourcePages: number[];
  inputTokens: number;
  outputTokens: number;
  skipped?: boolean;
  skipReason?: string;
}

/**
 * Normalises a room number for fuzzy matching:
 * strips leading zeros and lowercases (e.g. "001" → "1", "A-001" → "a-1").
 */
export function normaliseRoomNum(roomNum: string): string {
  return roomNum
    .toLowerCase()
    .replace(/\b0+(\d)/g, "$1");
}

/**
 * Runs occupant loads extraction for a job file.
 * Finds pages classified as "other" that contain egress-related keywords,
 * renders each at 200 DPI, sends to Gemini, and stores extracted occupant loads.
 */
export async function runOccupantLoadsExtraction(
  jobId: string,
  file: { id: string; storedPath: string; pageStats?: { otherPages?: number[] } | null },
): Promise<OccupantLoadsExtractionResult> {
  const pageStats = file.pageStats;
  const otherPages = pageStats?.otherPages ?? [];

  // Dynamically find egress pages among "other" pages
  const numPages = otherPages.length > 0 ? 0 : await getPdfPageCount(file.storedPath);
  const candidatePages = otherPages.length > 0 ? otherPages : Array.from({ length: numPages }, (_, i) => i + 1);

  const egressPages: number[] = [];
  for (const pageNum of candidatePages) {
    try {
      const pageWords = await extractPagePhrases(file.storedPath, file.id, pageNum);
      const pageText = pageWords.phrases.map((p) => p.text).join(" ").toLowerCase();
      const hasEgressKeyword = EGRESS_KEYWORDS.some((kw) => pageText.includes(kw));
      if (hasEgressKeyword) {
        egressPages.push(pageNum);
      }
    } catch {
      // skip pages that fail text extraction
    }
  }

  if (egressPages.length === 0) {
    return {
      rooms: [],
      sourcePages: [],
      inputTokens: 0,
      outputTokens: 0,
      skipped: true,
      skipReason: "No egress/occupant load pages found",
    };
  }

  const outputDir = getFilePageImagesDir(file.id);
  const DPI_200_SCALE = 200 / 72;
  const rendered = await renderFloorPlanPages(file.storedPath, egressPages, outputDir, DPI_200_SCALE);

  const allRooms: OccupantLoadRoom[] = [];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  const successPages: number[] = [];

  for (const pageNum of egressPages) {
    const imagePath = rendered.get(pageNum);
    if (!imagePath) continue;

    try {
      const { text, inputTokens, outputTokens } = await callGeminiWithImage(ai, imagePath, OCCUPANT_LOADS_PROMPT, 2048);
      totalInputTokens += inputTokens;
      totalOutputTokens += outputTokens;

      const parsed = extractJsonFromText(text) as { rooms?: unknown };
      if (Array.isArray(parsed?.rooms)) {
        allRooms.push(...(parsed.rooms as OccupantLoadRoom[]));
        successPages.push(pageNum);
      }
    } catch (err) {
      logger.warn({ err, jobId, fileId: file.id, pageNum }, "runOccupantLoadsExtraction: failed to parse Gemini JSON for page — skipping");
    }
  }

  // Deduplicate by room_num (keep first occurrence)
  const seen = new Set<string>();
  const dedupedRooms: OccupantLoadRoom[] = [];
  for (const room of allRooms) {
    const key = normaliseRoomNum(String(room.room_num ?? ""));
    if (!key || seen.has(key)) continue;
    seen.add(key);
    dedupedRooms.push(room);
  }

  logger.info({ jobId, fileId: file.id, roomCount: dedupedRooms.length, sourcePages: successPages, totalInputTokens, totalOutputTokens }, "runOccupantLoadsExtraction: complete");

  return {
    rooms: dedupedRooms,
    sourcePages: successPages,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
  };
}

/**
 * Merges occupant-load rows for a job into existing rows instead of replacing them.
 *
 * Strategy:
 * - Deduplicates incoming AI rooms by normalised roomNum (first wins).
 * - Existing rows matched by normalised roomNum that were NOT manually edited are updated.
 * - Existing rows that WERE manually edited are left untouched — UNLESS overwrite=true, in
 *   which case all rows are updated and the manuallyEdited flag is reset to false.
 * - New AI rooms with no existing match are inserted.
 * - Existing rows not found by AI are left in place (not deleted).
 *
 * @param overwrite - When true, manually-edited rows are also updated and their flag is cleared.
 */
export async function persistOccupantLoads(
  jobId: string,
  rooms: OccupantLoadRoom[],
  sourcePage: number | null = null,
  overwrite = false,
): Promise<void> {
  // Deduplicate incoming AI results by normalised room number (first wins)
  const seen = new Set<string>();
  const dedupedRooms: OccupantLoadRoom[] = [];
  for (const room of rooms) {
    const key = normaliseRoomNum(String(room.room_num ?? ""));
    if (!key || seen.has(key)) continue;
    seen.add(key);
    dedupedRooms.push(room);
  }

  const existingRows = await db
    .select()
    .from(occupantLoadsTable)
    .where(eq(occupantLoadsTable.jobId, jobId));

  const existingByNormKey = new Map(
    existingRows.map((r) => [normaliseRoomNum(r.roomNum), r]),
  );

  const toInsert: OccupantLoadRoom[] = [];
  let updatedCount = 0;
  let skippedCount = 0;

  for (const r of dedupedRooms) {
    const key = normaliseRoomNum(String(r.room_num ?? ""));
    const existing = existingByNormKey.get(key);

    if (!existing) {
      toInsert.push(r);
    } else if (!existing.manuallyEdited || overwrite) {
      await db
        .update(occupantLoadsTable)
        .set({
          roomName: r.room_name ?? null,
          occupantLoad: typeof r.occupant_load === "number" ? r.occupant_load : null,
          occupancyGroup: r.occupancy_group ?? null,
          sourcePage,
          manuallyEdited: false,
        })
        .where(and(eq(occupantLoadsTable.id, existing.id), eq(occupantLoadsTable.jobId, jobId)));
      updatedCount++;
    } else {
      skippedCount++;
    }
  }

  if (toInsert.length > 0) {
    await db.insert(occupantLoadsTable).values(
      toInsert.map((r) => ({
        jobId,
        roomNum: String(r.room_num ?? ""),
        roomName: r.room_name ?? null,
        occupantLoad: typeof r.occupant_load === "number" ? r.occupant_load : null,
        occupancyGroup: r.occupancy_group ?? null,
        sourcePage,
      })),
    );
  }

  logger.info(
    { jobId, aiCount: dedupedRooms.length, inserted: toInsert.length, updated: updatedCount, skipped: skippedCount, overwrite },
    "persistOccupantLoads: merged",
  );
}

// ── Compliance-scan DB helpers ────────────────────────────────────────────────

/**
 * Fetches stored occupant-load rows for a job from the `occupant_loads` table.
 *
 * Used by the compliance-scan endpoint (Task 2) to enrich RoomInventory objects
 * before evaluating R9/R10 assembly rules.  Returns an empty array (null fallback)
 * when no occupant-load extraction has been run for this job yet.
 *
 * @param jobId  The job UUID.
 * @returns      Array of StoredOccupantLoad rows (may be empty).
 */
export async function fetchOccupantLoadsForJob(jobId: string): Promise<StoredOccupantLoad[]> {
  const rows = await db
    .select()
    .from(occupantLoadsTable)
    .where(eq(occupantLoadsTable.jobId, jobId));

  return rows.map((r) => ({
    roomNum: r.roomNum,
    roomName: r.roomName ?? null,
    occupantLoad: r.occupantLoad ?? null,
    occupancyGroup: r.occupancyGroup ?? null,
  }));
}
