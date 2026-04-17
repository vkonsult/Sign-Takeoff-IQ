/**
 * sign-schedule-extractor.ts — Phase 3
 *
 * Replaces the text-parser-only sign schedule extraction with a Gemini
 * visual read of rasterized signage schedule pages, producing a structured
 * plaque table that Phase 5 (rule engine) uses to assign sign types.
 *
 * Falls back to the legacy extractSignageData() text parser when Gemini fails
 * or returns 0 plaque types.
 */

import fs from "fs/promises";
import path from "path";
import { eq, and } from "drizzle-orm";
import { db } from "@workspace/db";
import { signTypeSpecsTable } from "@workspace/db";
import type { PlaqueTypeRow } from "@workspace/db";
import { ai } from "@workspace/integrations-gemini-ai";
import { renderFloorPlanPages } from "./pdf-render";
import { getFilePageImagesDir, PAGES_DIR } from "./storage";
import { extractRawPageItems } from "./pdf-words";
import { extractSignageData } from "./signage-schedule-parser";
import { logger as rootLogger } from "./logger";

const logger = rootLogger.child({ module: "sign-schedule-extractor" });

export type { PlaqueTypeRow };

export interface SignScheduleResult {
  plaqueTypes: PlaqueTypeRow[];
  generalNotes: string[];
  sourcePages: number[];
  extractionMethod: "visual" | "text_fallback";
  warnings: string[];
}

const GEMINI_MODEL = "gemini-2.5-flash";

const SCHEDULE_EXTRACTION_PROMPT = `You are reading an architectural sign schedule (also called a plaque schedule or signage schedule). Extract every sign type listed.

For each sign type, return:
- typeCode: the identifier (e.g. "A", "B", "1", "P-1")
- displayName: the human-readable name (e.g. "Room ID", "Restroom - Women")
- letterHeight: letter/character height if stated (e.g. '1/2"', '1"')
- hasBraille: true if braille is required/noted
- hasInsert: true if it uses an insert (changeable panel)
- triggerCondition: what rule triggers this sign type if stated
- dimensions: overall sign size if stated (e.g. '6" x 8"')
- material: substrate/material if stated
- mountingNote: mounting method or height if stated
- adaNote: any ADA/accessibility note
- rawNote: any other note not captured above

Also extract:
- generalNotes: any general signage notes that apply to all types

Return ONLY a JSON object:
{
  "plaqueTypes": [...],
  "generalNotes": [...]
}`;

// ── Gemini vision call ────────────────────────────────────────────────────────

interface GeminiResponse {
  plaqueTypes: PlaqueTypeRow[];
  generalNotes: string[];
}

async function callGeminiVision(pngPaths: Map<number, string>): Promise<GeminiResponse | null> {
  if (pngPaths.size === 0) return null;

  type InlineData = { inlineData: { mimeType: string; data: string } };
  type TextPart = { text: string };
  type Part = InlineData | TextPart;

  const parts: Part[] = [];

  for (const [pageNum, absPath] of pngPaths) {
    try {
      const pngBuffer = await fs.readFile(absPath);
      const base64 = pngBuffer.toString("base64");
      parts.push({ inlineData: { mimeType: "image/png", data: base64 } });
      parts.push({ text: `(Page ${pageNum})` });
    } catch (err) {
      logger.warn({ err, pageNum, absPath }, "sign-schedule-extractor: could not read PNG for page — skipping");
    }
  }

  if (parts.length === 0) return null;

  parts.push({ text: SCHEDULE_EXTRACTION_PROMPT });

  const response = await (ai as {
    models: {
      generateContent: (opts: {
        model: string;
        contents: { role: string; parts: Part[] }[];
        config?: { maxOutputTokens?: number; temperature?: number; responseMimeType?: string };
      }) => Promise<{ text: string | undefined }>;
    };
  }).models.generateContent({
    model: GEMINI_MODEL,
    contents: [{ role: "user", parts }],
    config: {
      maxOutputTokens: 8192,
      temperature: 0.0,
      responseMimeType: "application/json",
    },
  });

  const raw = (response.text ?? "").trim();
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<GeminiResponse>;
    const plaqueTypes = Array.isArray(parsed.plaqueTypes) ? parsed.plaqueTypes : [];
    const generalNotes = Array.isArray(parsed.generalNotes) ? parsed.generalNotes : [];
    return { plaqueTypes, generalNotes };
  } catch {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]) as Partial<GeminiResponse>;
        const plaqueTypes = Array.isArray(parsed.plaqueTypes) ? parsed.plaqueTypes : [];
        const generalNotes = Array.isArray(parsed.generalNotes) ? parsed.generalNotes : [];
        return { plaqueTypes, generalNotes };
      } catch {
        return null;
      }
    }
    return null;
  }
}

// ── Text fallback ─────────────────────────────────────────────────────────────

async function runTextFallback(
  pdfPath: string,
  schedulePages: number[],
): Promise<{ plaqueTypes: PlaqueTypeRow[]; warnings: string[] }> {
  const warnings: string[] = [];
  const mergedPlaqueTypes = new Map<string, PlaqueTypeRow>();

  for (const pageNum of schedulePages) {
    try {
      const { items, pageWidth, pageHeight } = await extractRawPageItems(pdfPath, pageNum);
      const result = extractSignageData(items, pageNum, pageWidth, pageHeight);

      for (const spec of result.specs) {
        const key = spec.typeCode.toUpperCase();
        if (!mergedPlaqueTypes.has(key)) {
          mergedPlaqueTypes.set(key, {
            typeCode: spec.typeCode,
            displayName: spec.typeCode,
            letterHeight: null,
            hasBraille: spec.features.some((f) => /braille/i.test(f)),
            hasInsert: spec.features.some((f) => /insert/i.test(f)),
            triggerCondition: null,
            dimensions: spec.dimensions ?? null,
            material: spec.material ?? null,
            mountingNote: null,
            adaNote: null,
            rawNote: spec.features.length > 0 ? spec.features.join("; ") : null,
          });
        }
      }
    } catch (err) {
      const msg = `Text fallback failed for page ${pageNum}: ${String(err)}`;
      warnings.push(msg);
      logger.warn({ err, pageNum }, "sign-schedule-extractor: text fallback page parse failed");
    }
  }

  return { plaqueTypes: [...mergedPlaqueTypes.values()], warnings };
}

// ── DB persistence ────────────────────────────────────────────────────────────

async function persistSignTypeSpecs(
  jobId: string,
  fileId: string,
  plaqueTypes: PlaqueTypeRow[],
): Promise<void> {
  await db
    .delete(signTypeSpecsTable)
    .where(
      and(
        eq(signTypeSpecsTable.jobId, jobId),
        eq(signTypeSpecsTable.sourceFileId, fileId),
      )
    );

  if (plaqueTypes.length === 0) return;

  const rows = plaqueTypes.map((row) => ({
    jobId,
    sourceFileId: fileId,
    typeCode: row.typeCode,
    dimensions: row.dimensions ?? null,
    material: row.material ?? null,
    features: [
      ...(row.hasBraille ? ["braille"] : []),
      ...(row.hasInsert ? ["insert"] : []),
    ] as string[],
    keynoteMap: null as Record<string, string> | null,
    cropBox: null as { x: number; y: number; w: number; h: number; pageNum: number } | null,
    hasDrawing: false,
    geminiEnriched: false,
    geminiNotes: {
      displayName: row.displayName,
      letterHeight: row.letterHeight,
      triggerCondition: row.triggerCondition,
      mountingNote: row.mountingNote,
      adaNote: row.adaNote,
      rawNote: row.rawNote,
    } as Record<string, unknown>,
  }));

  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await db.insert(signTypeSpecsTable).values(rows.slice(i, i + CHUNK));
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Extract the signage schedule for a specific file using Gemini visual read.
 *
 * @param pdfPath       Absolute path to the source PDF
 * @param fileId        Job file ID (used to track source and clear old specs)
 * @param schedulePages 1-indexed page numbers classified as signage_schedule or both
 * @param jobId         Parent job ID
 */
export async function extractSignSchedule(
  pdfPath: string,
  fileId: string,
  schedulePages: number[],
  jobId: string,
): Promise<SignScheduleResult> {
  if (schedulePages.length === 0) {
    return {
      plaqueTypes: [],
      generalNotes: [],
      sourcePages: [],
      extractionMethod: "visual",
      warnings: [],
    };
  }

  const warnings: string[] = [];

  // ── Step 1: Rasterize schedule pages ────────────────────────────────────
  let pngMap = new Map<number, string>();
  try {
    const outputDir = getFilePageImagesDir(fileId);
    const rendered = await renderFloorPlanPages(pdfPath, schedulePages, outputDir);
    pngMap = rendered;
    logger.info(
      { fileId, pagesRequested: schedulePages.length, pagesRendered: rendered.size },
      "sign-schedule-extractor: pages rasterized"
    );
  } catch (err) {
    const msg = `PNG rasterization failed: ${String(err)}`;
    warnings.push(msg);
    logger.warn({ err, fileId }, "sign-schedule-extractor: rasterization failed — will attempt text fallback");
  }

  // Build absolute PNG paths for Gemini (renderFloorPlanPages returns absolute paths already)
  const absPngMap = new Map<number, string>();
  if (pngMap.size > 0) {
    const pagesParent = path.dirname(PAGES_DIR);
    for (const [pageNum, p] of pngMap) {
      if (path.isAbsolute(p)) {
        absPngMap.set(pageNum, p);
      } else {
        absPngMap.set(pageNum, path.resolve(pagesParent, p));
      }
    }
  }

  // ── Step 2: Gemini visual read ───────────────────────────────────────────
  let geminiResult: GeminiResponse | null = null;
  if (absPngMap.size > 0) {
    try {
      geminiResult = await callGeminiVision(absPngMap);
      logger.info(
        {
          fileId,
          plaqueTypes: geminiResult?.plaqueTypes.length ?? 0,
          generalNotes: geminiResult?.generalNotes.length ?? 0,
        },
        "sign-schedule-extractor: Gemini visual read complete"
      );
    } catch (err) {
      const msg = `Gemini call failed: ${String(err)}`;
      warnings.push(msg);
      logger.warn({ err, fileId }, "sign-schedule-extractor: Gemini call failed — will use text fallback");
    }
  } else {
    warnings.push("No PNG pages available for Gemini visual read — using text fallback");
  }

  // ── Step 3: Text fallback if needed ──────────────────────────────────────
  let extractionMethod: "visual" | "text_fallback";
  let plaqueTypes: PlaqueTypeRow[];
  let generalNotes: string[];

  if (geminiResult && geminiResult.plaqueTypes.length > 0) {
    extractionMethod = "visual";
    plaqueTypes = geminiResult.plaqueTypes.map((row) => normalizeGeminiRow(row));
    generalNotes = geminiResult.generalNotes;
  } else {
    if (geminiResult && geminiResult.plaqueTypes.length === 0) {
      warnings.push("Gemini returned 0 plaque types — using text fallback");
    }
    extractionMethod = "text_fallback";
    const fallback = await runTextFallback(pdfPath, schedulePages);
    plaqueTypes = fallback.plaqueTypes;
    generalNotes = [];
    warnings.push(...fallback.warnings);
    logger.info(
      { fileId, plaqueTypes: plaqueTypes.length },
      "sign-schedule-extractor: text fallback complete"
    );
  }

  const result: SignScheduleResult = {
    plaqueTypes,
    generalNotes,
    sourcePages: schedulePages,
    extractionMethod,
    warnings,
  };

  // ── Step 4: Persist sign_type_specs ─────────────────────────────────────
  // Clears existing specs for this file and re-inserts from visual read results.
  // Note: job-level plaqueTable aggregation is handled by the caller (pdf-processor.ts)
  // to ensure the result is deterministic and not accumulated across rescans.
  try {
    await persistSignTypeSpecs(jobId, fileId, plaqueTypes);
    logger.info(
      { fileId, specs: plaqueTypes.length },
      "sign-schedule-extractor: sign_type_specs persisted"
    );
  } catch (err) {
    const msg = `Failed to persist sign_type_specs: ${String(err)}`;
    warnings.push(msg);
    logger.warn({ err, fileId }, "sign-schedule-extractor: spec persistence failed — non-fatal");
  }

  return result;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalizeGeminiRow(raw: Partial<PlaqueTypeRow>): PlaqueTypeRow {
  return {
    typeCode: String(raw.typeCode ?? "").trim(),
    displayName: String(raw.displayName ?? raw.typeCode ?? "").trim(),
    letterHeight: raw.letterHeight ?? null,
    hasBraille: Boolean(raw.hasBraille),
    hasInsert: Boolean(raw.hasInsert),
    triggerCondition: raw.triggerCondition ?? null,
    dimensions: raw.dimensions ?? null,
    material: raw.material ?? null,
    mountingNote: raw.mountingNote ?? null,
    adaNote: raw.adaNote ?? null,
    rawNote: raw.rawNote ?? null,
  };
}
