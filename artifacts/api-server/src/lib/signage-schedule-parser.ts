/**
 * signage-schedule-parser.ts
 *
 * Deterministic spatial parser for sign schedule pages.
 * Reads raw pdfjs text items from pages classified as `sign_schedule`,
 * groups them spatially into lines and blocks, then parses structured data:
 *   - Schedule table headers / section names
 *   - Room headings and sign rows
 *   - Sign type legend (code → dimensions, material, features)
 *   - Keynotes legend (letter → description)
 *   - Sign type diagram regions (for optional Gemini enrichment)
 */

import path from "path";
import fs from "fs/promises";
import { logger as rootLogger } from "./logger";

const logger = rootLogger.child({ module: "signage-schedule-parser" });

// ── Types ─────────────────────────────────────────────────────────────────────

/** A single text item in viewport pt coordinates (top-down, origin top-left). */
export interface RawTextItem {
  text: string;
  x: number;   // left edge (viewport pts)
  y: number;   // top edge  (viewport pts)
  w: number;   // width     (viewport pts)
  h: number;   // height    (viewport pts)
}

/** A line of text items sharing approximately the same y-center. */
type TextLine = RawTextItem[];

/** A block of consecutive lines separated by ≤15pt gaps. */
type TextBlock = TextLine[];

export interface SignTypeSpec {
  typeCode: string;
  dimensions: string | null;
  material: string | null;
  features: string[];
  keynoteMap: Record<string, string>;
  cropBox: { x: number; y: number; w: number; h: number; pageNum: number } | null;
  hasDrawing: boolean;
}

export interface ScheduleEntry {
  sourceTableName: string;
  pageNumber: number;
  roomNumber: string | null;
  roomName: string | null;
  signTypeCode: string;
  quantity: number | null;
  signageText: string | null;
  glassBacker: boolean | null;
  rawComments: string | null;
  expandedComments: string | null;
  dimensions: string | null;
  material: string | null;
  features: string[];
}

export interface ParseResult {
  specs: SignTypeSpec[];
  entries: ScheduleEntry[];
}

// ── Regex patterns ─────────────────────────────────────────────────────────────

/** Sign type code: 1–2 digits followed by 0–2 letters, e.g. "1A", "2B", "3", "10A" */
const SIGN_TYPE_CODE_RE = /^(\d{1,2}[A-Za-z]{0,2})$/;

/** Room number: pure digits, or letter+digits, or digit+letter, e.g. "101", "A-101", "101A" */
const ROOM_NUMBER_RE = /^([A-Za-z]{0,2}-?\d{2,4}[A-Za-z]?|[A-Za-z]\d{2,3}[A-Za-z]?)$/;

/** Integer quantity */
const QUANTITY_RE = /^(\d{1,3})$/;

/** Dimension pattern: numbers with inches/feet marks */
const DIMENSION_TOKEN_RE = /[\d\/][\d\s\/]*["'′″]/;

/** Keynote letter codes (single uppercase letters or short strings) */
const KEYNOTE_CODE_RE = /^[A-Z]$/;

// ── Spatial grouping ──────────────────────────────────────────────────────────

/**
 * Sort items top-to-bottom, left-to-right.
 * Items within 3pt y-distance are considered the same line.
 */
function sortItems(items: RawTextItem[]): RawTextItem[] {
  return [...items].sort((a, b) => {
    const ay = a.y + a.h / 2;
    const by_ = b.y + b.h / 2;
    const dy = ay - by_;
    if (Math.abs(dy) > 3) return dy;
    return a.x - b.x;
  });
}

/**
 * Group sorted items into lines.
 * Items with center-y within 3pt of the current line's average y are in the same line.
 */
function groupIntoLines(items: RawTextItem[]): TextLine[] {
  if (items.length === 0) return [];
  const lines: TextLine[] = [];
  let current: RawTextItem[] = [items[0]!];
  let lineY = items[0]!.y + items[0]!.h / 2;

  for (let i = 1; i < items.length; i++) {
    const item = items[i]!;
    const itemY = item.y + item.h / 2;
    if (Math.abs(itemY - lineY) <= 3) {
      current.push(item);
    } else {
      lines.push(current.sort((a, b) => a.x - b.x));
      current = [item];
      lineY = itemY;
    }
  }
  if (current.length > 0) {
    lines.push(current.sort((a, b) => a.x - b.x));
  }
  return lines;
}

/**
 * Group lines into blocks.
 * A gap >15pt between consecutive lines starts a new block.
 */
function groupLinesIntoBlocks(lines: TextLine[]): TextBlock[] {
  if (lines.length === 0) return [];
  const blocks: TextBlock[] = [];
  let current: TextBlock = [lines[0]!];

  for (let i = 1; i < lines.length; i++) {
    const prevLine = current[current.length - 1]!;
    const thisLine = lines[i]!;
    const prevBottom = Math.max(...prevLine.map((it) => it.y + it.h));
    const thisTop = Math.min(...thisLine.map((it) => it.y));
    const gap = thisTop - prevBottom;
    if (gap > 15) {
      blocks.push(current);
      current = [thisLine];
    } else {
      current.push(thisLine);
    }
  }
  if (current.length > 0) blocks.push(current);
  return blocks;
}

/** Combine all text in a line (left-to-right, space-separated). */
function lineText(line: TextLine): string {
  return line.map((it) => it.text.trim()).filter(Boolean).join(" ");
}

// ── Pattern detectors ─────────────────────────────────────────────────────────

/** Returns true if the text looks like a schedule header. */
function isScheduleHeader(text: string): boolean {
  const lower = text.toLowerCase();
  return lower.includes("signage schedule") || lower.includes("sign schedule");
}

/** Returns true if the text looks like the sign type legend header. */
function isSignTypeLegendHeader(text: string): boolean {
  const upper = text.toUpperCase();
  return upper.includes("SIGN TYPE LEGEND") || upper === "SIGN TYPES";
}

/** Returns true if the text looks like the keynote legend header. */
function isKeynoteLegendHeader(text: string): boolean {
  const upper = text.toUpperCase();
  return upper.includes("KEYNOTE") || upper.includes("SIGN KEYNOTES");
}

/** Returns true if a line is just a room heading (room number alone or room number + name). */
function parseRoomHeading(line: TextLine): { roomNumber: string; roomName: string } | null {
  const items = line.filter((it) => it.text.trim().length > 0);
  if (items.length === 0) return null;
  const first = items[0]!.text.trim();

  // Must start with a room number pattern
  if (!ROOM_NUMBER_RE.test(first) && !/^\d{1,4}$/.test(first)) return null;

  // If the line only has a few tokens and the rest looks like a room name, it's a heading
  const restText = items.slice(1).map((it) => it.text.trim()).join(" ").trim();

  // Reject if the second token looks like a sign type code followed by a quantity
  // (that would be a sign row, not a room heading)
  if (items.length >= 3) {
    const second = items[1]?.text.trim() ?? "";
    const third = items[2]?.text.trim() ?? "";
    if (SIGN_TYPE_CODE_RE.test(second) && QUANTITY_RE.test(third)) {
      return null;
    }
  }

  return { roomNumber: first, roomName: restText || "" };
}

/** Parse a sign row from a line. Returns null if the line doesn't look like a sign row. */
function parseSignRow(line: TextLine): {
  signTypeCode: string;
  quantity: number | null;
  signageText: string | null;
  glassBacker: boolean | null;
  rawComments: string | null;
} | null {
  const items = line.filter((it) => it.text.trim().length > 0);
  if (items.length < 2) return null;

  const first = items[0]!.text.trim();
  if (!SIGN_TYPE_CODE_RE.test(first)) return null;

  const signTypeCode = first;
  let quantity: number | null = null;
  let signageText: string | null = null;
  let glassBacker: boolean | null = null;
  let rawComments: string | null = null;

  // Second token: check if it's a quantity
  let idx = 1;
  if (idx < items.length) {
    const second = items[idx]!.text.trim();
    if (QUANTITY_RE.test(second)) {
      quantity = parseInt(second, 10);
      idx++;
    }
  }

  // Gather remaining tokens
  const rest = items.slice(idx).map((it) => it.text.trim()).filter(Boolean);

  // Look for "Yes" / "No" glass backer token (case-insensitive)
  const glassIdx = rest.findIndex((t) => /^(yes|no)$/i.test(t));
  if (glassIdx !== -1) {
    glassBacker = /^yes$/i.test(rest[glassIdx]!);
    // Signage text is everything before glass backer
    const textParts = rest.slice(0, glassIdx);
    signageText = textParts.join(" ").trim() || null;
    // Comments are everything after glass backer
    const commentParts = rest.slice(glassIdx + 1);
    rawComments = commentParts.join(" ").trim() || null;
  } else {
    // No glass backer token — try to detect comment codes at end
    // Comment codes are single uppercase letters or comma-separated letter lists
    const lastToken = rest[rest.length - 1] ?? "";
    const commentPattern = /^[A-Z](,[A-Z])*$/;
    if (rest.length > 0 && commentPattern.test(lastToken)) {
      rawComments = lastToken;
      signageText = rest.slice(0, -1).join(" ").trim() || null;
    } else {
      signageText = rest.join(" ").trim() || null;
    }
  }

  return { signTypeCode, quantity, signageText, glassBacker, rawComments };
}

/** Parse a sign type legend row. Format: [code] [dimensions] [material] [...features] */
function parseLegendRow(line: TextLine): {
  typeCode: string;
  dimensions: string | null;
  material: string | null;
  features: string[];
} | null {
  const items = line.filter((it) => it.text.trim().length > 0);
  if (items.length < 2) return null;

  const first = items[0]!.text.trim();
  if (!SIGN_TYPE_CODE_RE.test(first)) return null;

  const typeCode = first;
  let dimensions: string | null = null;
  let material: string | null = null;
  const features: string[] = [];

  // Find dimension tokens (contain " x " or inch/foot marks or fractions)
  // Dimensions are typically the first meaningful content after the type code
  const rest = items.slice(1).map((it) => it.text.trim()).filter(Boolean);

  // Look for dimension pattern: token(s) containing × or x with numbers and inch marks
  let dimEnd = -1;
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i]!;
    // Combine up to 3 tokens to find a "W x H" dimension
    const combined3 = rest.slice(i, i + 3).join(" ");
    if (/\d[\d\s\/]*[x×]\s*\d/.test(combined3) || DIMENSION_TOKEN_RE.test(combined3)) {
      // Find where this dimension ends
      // A typical dimension is like `6 1/2" x 8 1/4"` which is 5 tokens
      // Greedily consume tokens that look like dimension parts
      let end = i;
      while (end < rest.length) {
        const tok = rest[end]!;
        if (/^[\dx×\s\/\-"'′″½¼¾]+$/.test(tok) || /[x×]/.test(tok) || /\d/.test(tok)) {
          end++;
        } else {
          break;
        }
      }
      dimensions = rest.slice(i, end).join(" ").trim();
      dimEnd = end;
      break;
    }
  }

  if (dimEnd >= 0) {
    const afterDim = rest.slice(dimEnd);
    if (afterDim.length > 0) {
      material = afterDim[0]!;
      features.push(...afterDim.slice(1));
    }
  } else {
    // No dimension found — first token might be material
    if (rest.length > 0) {
      material = rest[0]!;
      features.push(...rest.slice(1));
    }
  }

  return { typeCode, dimensions, material, features };
}

/** Parse a keynote row. Format: [letter] [description...] */
function parseKeynoteRow(line: TextLine): { letter: string; description: string } | null {
  const items = line.filter((it) => it.text.trim().length > 0);
  if (items.length < 2) return null;

  const first = items[0]!.text.trim();
  if (!KEYNOTE_CODE_RE.test(first)) return null;

  const description = items.slice(1).map((it) => it.text.trim()).join(" ").trim();
  if (!description) return null;

  return { letter: first, description };
}

/** Check if a line looks like a sign type diagram label (e.g., "SIGN TYPE 1A"). */
function isDiagramLabel(text: string): { typeCode: string } | null {
  const m = text.trim().match(/^(?:SIGN\s+TYPE\s+)(\d{1,2}[A-Za-z]{1,2})$/i);
  if (m) return { typeCode: m[1]!.toUpperCase() };
  return null;
}

// ── Column segmentation ───────────────────────────────────────────────────────

/**
 * Detect major horizontal gaps between items and split them into independent
 * x-bounded column groups.  On multi-column schedule sheets (e.g., two level
 * tables side-by-side), items from the same row but different columns would
 * otherwise be grouped onto the same line and parsed incorrectly.
 *
 * A gap ≥ 8% of page width between consecutive x-sorted item clusters is
 * treated as a column boundary.
 */
function splitIntoColumns(items: RawTextItem[], pageWidth: number): RawTextItem[][] {
  if (items.length === 0) return [];

  // Project each item to its x-centre for gap detection
  const byX = [...items].sort((a, b) => (a.x + a.w / 2) - (b.x + b.w / 2));

  const GAP_THRESHOLD = pageWidth * 0.08; // 8% of page width

  const columns: RawTextItem[][] = [];
  let current: RawTextItem[] = [byX[0]!];

  for (let i = 1; i < byX.length; i++) {
    const prev = byX[i - 1]!;
    const curr = byX[i]!;
    const gap = curr.x - (prev.x + prev.w);
    if (gap >= GAP_THRESHOLD) {
      columns.push(current);
      current = [curr];
    } else {
      current.push(curr);
    }
  }
  if (current.length > 0) columns.push(current);

  // If only 1 column detected, return as-is (no split needed)
  return columns;
}

// ── Main parser ───────────────────────────────────────────────────────────────

/**
 * Parse signage data from raw text items on a single page.
 * Handles multi-column schedule sheets by segmenting items into independent
 * x-bounded column groups before parsing each with its own parser state.
 *
 * @param items     Raw pdfjs text items in viewport pt coordinates.
 * @param pageNum   1-indexed page number (used for cropBox).
 * @param pageWidth  Viewport width in pts.
 * @param pageHeight Viewport height in pts.
 */
export function extractSignageData(
  items: RawTextItem[],
  pageNum: number,
  pageWidth: number,
  pageHeight: number,
): ParseResult {
  // Split items into independent column groups to handle multi-column layouts
  const columns = splitIntoColumns(items, pageWidth);
  if (columns.length > 1) {
    // Parse each column independently, then merge results
    const merged: ParseResult = { specs: [], entries: [] };
    const specMap = new Map<string, SignTypeSpec>();
    for (const colItems of columns) {
      const result = parseColumnItems(colItems, pageNum, pageWidth, pageHeight);
      for (const spec of result.specs) {
        const existing = specMap.get(spec.typeCode.toUpperCase());
        if (!existing) {
          specMap.set(spec.typeCode.toUpperCase(), spec);
        } else {
          if (spec.dimensions && !existing.dimensions) existing.dimensions = spec.dimensions;
          if (spec.material && !existing.material) existing.material = spec.material;
          if (spec.features.length > 0 && existing.features.length === 0) existing.features = spec.features;
          if (spec.hasDrawing) { existing.hasDrawing = true; existing.cropBox = spec.cropBox; }
        }
      }
      merged.entries.push(...result.entries);
    }
    merged.specs = [...specMap.values()];
    return merged;
  }

  return parseColumnItems(items, pageNum, pageWidth, pageHeight);
}

/** Internal: parse a single column/slab of items with its own parser state. */
function parseColumnItems(
  items: RawTextItem[],
  pageNum: number,
  pageWidth: number,
  pageHeight: number,
): ParseResult {
  const sorted = sortItems(items);
  const lines = groupIntoLines(sorted);
  const _blocks = groupLinesIntoBlocks(lines);

  // ── State machines for parsing different sections ──────────────────────────
  const specs = new Map<string, SignTypeSpec>();  // typeCode → spec
  const keynotes = new Map<string, string>();       // letter → description
  const entries: ScheduleEntry[] = [];

  type Section = "schedule" | "type_legend" | "keynote_legend" | "diagram" | "other";
  let currentSection: Section = "other";
  let currentScheduleName = "";
  let currentRoomNumber: string | null = null;
  let currentRoomName: string | null = null;

  // For diagram region detection
  const diagramItems: RawTextItem[] = [];

  // ── Process lines sequentially ─────────────────────────────────────────────
  for (const line of lines) {
    const text = lineText(line);
    if (!text.trim()) continue;

    // ── Section header detection ──────────────────────────────────────────
    if (isScheduleHeader(text)) {
      currentSection = "schedule";
      currentScheduleName = text.trim();
      currentRoomNumber = null;
      currentRoomName = null;
      continue;
    }

    if (isSignTypeLegendHeader(text)) {
      currentSection = "type_legend";
      continue;
    }

    if (isKeynoteLegendHeader(text)) {
      currentSection = "keynote_legend";
      continue;
    }

    const diagramLabelMatch = isDiagramLabel(text);
    if (diagramLabelMatch) {
      currentSection = "diagram";
      diagramItems.push(...line);
      // Record diagram region for this type code
      const spec = specs.get(diagramLabelMatch.typeCode);
      if (!spec) {
        specs.set(diagramLabelMatch.typeCode, {
          typeCode: diagramLabelMatch.typeCode,
          dimensions: null,
          material: null,
          features: [],
          keynoteMap: {},
          cropBox: null,
          hasDrawing: true,
        });
      } else {
        spec.hasDrawing = true;
      }
      continue;
    }

    // ── Section-specific content parsing ──────────────────────────────────

    if (currentSection === "schedule") {
      // Room heading detection
      const roomHeading = parseRoomHeading(line);
      if (roomHeading) {
        currentRoomNumber = roomHeading.roomNumber;
        currentRoomName = roomHeading.roomName || null;
        continue;
      }

      // Sign row detection
      const signRow = parseSignRow(line);
      if (signRow) {
        // Expand comment codes via keynotes map (populated as we parse)
        let expandedComments: string | null = null;
        if (signRow.rawComments) {
          const codes = signRow.rawComments.split(/[,\s]+/).filter(Boolean);
          const expansions = codes
            .map((c) => keynotes.get(c.toUpperCase()))
            .filter(Boolean) as string[];
          if (expansions.length > 0) {
            expandedComments = expansions.join("; ");
          }
        }

        // Look up dimensions/material/features from type legend
        const spec = specs.get(signRow.signTypeCode.toUpperCase());
        const entry: ScheduleEntry = {
          sourceTableName: currentScheduleName,
          pageNumber: pageNum,
          roomNumber: currentRoomNumber,
          roomName: currentRoomName,
          signTypeCode: signRow.signTypeCode.toUpperCase(),
          quantity: signRow.quantity,
          signageText: signRow.signageText,
          glassBacker: signRow.glassBacker,
          rawComments: signRow.rawComments,
          expandedComments,
          dimensions: spec?.dimensions ?? null,
          material: spec?.material ?? null,
          features: spec?.features ?? [],
        };
        entries.push(entry);
        continue;
      }
    }

    if (currentSection === "type_legend") {
      const legendRow = parseLegendRow(line);
      if (legendRow) {
        const key = legendRow.typeCode.toUpperCase();
        const existing = specs.get(key);
        if (existing) {
          existing.dimensions = legendRow.dimensions;
          existing.material = legendRow.material;
          existing.features = legendRow.features;
        } else {
          specs.set(key, {
            typeCode: key,
            dimensions: legendRow.dimensions,
            material: legendRow.material,
            features: legendRow.features,
            keynoteMap: {},
            cropBox: null,
            hasDrawing: false,
          });
        }
        continue;
      }
    }

    if (currentSection === "keynote_legend") {
      const keynoteRow = parseKeynoteRow(line);
      if (keynoteRow) {
        keynotes.set(keynoteRow.letter.toUpperCase(), keynoteRow.description);
        continue;
      }
    }
  }

  // ── Post-processing: attach keynotes map to all specs ─────────────────────
  const keynoteRecord: Record<string, string> = Object.fromEntries(keynotes);
  for (const spec of specs.values()) {
    spec.keynoteMap = keynoteRecord;
  }

  // ── Re-expand comment codes now that keynotes are fully parsed ─────────────
  for (const entry of entries) {
    if (entry.rawComments && !entry.expandedComments && keynotes.size > 0) {
      const codes = entry.rawComments.split(/[,\s]+/).filter(Boolean);
      const expansions = codes
        .map((c) => keynotes.get(c.toUpperCase()))
        .filter(Boolean) as string[];
      if (expansions.length > 0) {
        entry.expandedComments = expansions.join("; ");
      }
    }

    // Also update dimensions/material/features for entries parsed before the legend
    const spec = specs.get(entry.signTypeCode);
    if (spec) {
      if (!entry.dimensions) entry.dimensions = spec.dimensions;
      if (!entry.material) entry.material = spec.material;
      if (entry.features.length === 0) entry.features = spec.features;
    }
  }

  // ── Compute cropBoxes for diagram regions ─────────────────────────────────
  // For each spec with hasDrawing=true, find the diagram label items and compute
  // a bounding region (120pt radius around the label center).
  for (const line of lines) {
    const text = lineText(line);
    const diagMatch = isDiagramLabel(text);
    if (!diagMatch) continue;
    const spec = specs.get(diagMatch.typeCode);
    if (!spec) continue;

    // Find center of the label
    const allX = line.flatMap((it) => [it.x, it.x + it.w]);
    const allY = line.flatMap((it) => [it.y, it.y + it.h]);
    const cx = (Math.min(...allX) + Math.max(...allX)) / 2;
    const cy = (Math.min(...allY) + Math.max(...allY)) / 2;
    const radius = 120;

    // Check how many items with dimension/measurement marks are near this region
    const nearbyItems = sorted.filter((it) => {
      const itX = it.x + it.w / 2;
      const itY = it.y + it.h / 2;
      return Math.abs(itX - cx) <= radius && Math.abs(itY - cy) <= radius;
    });
    const hasMeasurements = nearbyItems.filter((it) =>
      DIMENSION_TOKEN_RE.test(it.text) || /[\d]+[\s\/]*["'′″]/.test(it.text)
    ).length > 5;

    spec.hasDrawing = hasMeasurements;
    spec.cropBox = {
      x: Math.max(0, cx - radius),
      y: Math.max(0, cy - radius),
      w: Math.min(pageWidth, cx + radius) - Math.max(0, cx - radius),
      h: Math.min(pageHeight, cy + radius) - Math.max(0, cy - radius),
      pageNum,
    };
  }

  return {
    specs: Array.from(specs.values()),
    entries,
  };
}

// ── Gemini enrichment ─────────────────────────────────────────────────────────

export interface GeminiEnrichmentResult {
  sign_type: string;
  height: string | null;
  width: string | null;
  mounting_height: string | null;
  has_braille_note: boolean;
  has_pictogram: boolean;
  extra_notes: string | null;
  confidence: number;
}

/**
 * Enrich sign type specs that have diagram regions with Gemini vision analysis.
 *
 * @param specs       Array of sign type specs (only those with hasDrawing=true are processed).
 * @param pdfPath     Absolute path to the PDF file.
 * @param pageNums    Set of page numbers that contain sign schedule content.
 * @param ai          Gemini AI instance.
 * @param saveImageFn Optional callback to save crop PNG and return a URL.
 */
export async function enrichWithGemini(
  specs: SignTypeSpec[],
  pdfPath: string,
  ai: import("@workspace/integrations-gemini-ai").GeminiAI,
  saveImageFn?: (typeCode: string, pngBuffer: Buffer) => Promise<string>,
): Promise<Map<string, { notes: GeminiEnrichmentResult; cropImageUrl: string | null }>> {
  const results = new Map<string, { notes: GeminiEnrichmentResult; cropImageUrl: string | null }>();

  const toEnrich = specs.filter((s) => s.hasDrawing && s.cropBox);
  if (toEnrich.length === 0) return results;

  logger.info({ count: toEnrich.length }, "[signage-schedule-parser] Starting Gemini enrichment");

  // Import rendering dependencies
  const { createCanvas } = await import("@napi-rs/canvas");

  // Re-use the already-open pdfjs document from pdf-words (avoids re-reading the file)
  const { getOrOpenPdfjsDoc } = await import("./pdf-words");
  const doc = await getOrOpenPdfjsDoc(pdfPath);

  // Process max 3 at a time
  const CONCURRENCY = 3;

  async function processSpec(spec: SignTypeSpec): Promise<void> {
    const cropBox = spec.cropBox!;
    const SCALE = 2;

    try {
      const page = await doc.getPage(cropBox.pageNum);
      const viewport = page.getViewport({ scale: SCALE });

      // Render full page at 2× scale
      const canvasEl = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const ctx = canvasEl.getContext("2d");
      await page.render({ canvasContext: ctx, viewport }).promise;

      // Crop the diagram region (scaled by 2)
      const cx = Math.round(cropBox.x * SCALE);
      const cy = Math.round(cropBox.y * SCALE);
      const cw = Math.round(cropBox.w * SCALE);
      const ch = Math.round(cropBox.h * SCALE);

      const cropCanvas = createCanvas(cw, ch);
      const cropCtx = cropCanvas.getContext("2d");
      cropCtx.drawImage(
        canvasEl as unknown as Parameters<typeof cropCtx.drawImage>[0],
        cx, cy, cw, ch,
        0, 0, cw, ch,
      );

      const pngBuffer = await cropCanvas.encode("png");
      const base64 = pngBuffer.toString("base64");

      // Save crop image if callback provided
      let cropImageUrl: string | null = null;
      if (saveImageFn) {
        try {
          cropImageUrl = await saveImageFn(spec.typeCode, pngBuffer as Buffer);
        } catch (err) {
          logger.warn({ err, typeCode: spec.typeCode }, "[signage-schedule-parser] Failed to save crop image — non-fatal");
        }
      }

      // Call Gemini with the crop
      const prompt = `You are analyzing a sign diagram from an architectural signage schedule.
The image shows a technical drawing of sign type "${spec.typeCode}".

Extract the following details as JSON:
{
  "sign_type": "type code string",
  "height": "height dimension string or null",
  "width": "width dimension string or null",
  "mounting_height": "mounting height above finished floor or null",
  "has_braille_note": true/false,
  "has_pictogram": true/false,
  "extra_notes": "any other technical specs or null",
  "confidence": 0.0-1.0
}

Return ONLY the JSON object. No markdown, no explanation.`;

      const geminiApi = ai as {
        models: {
          generateContent(opts: {
            model: string;
            contents: { role: string; parts: ({ text: string } | { inlineData: { mimeType: string; data: string } })[] }[];
            config?: { maxOutputTokens?: number; temperature?: number };
          }): Promise<{ text: string | undefined }>;
        };
      };

      const response = await geminiApi.models.generateContent({
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
        config: { maxOutputTokens: 512, temperature: 0.0 },
      });

      const rawText = (response.text ?? "").trim();
      let notes: GeminiEnrichmentResult | null = null;
      try {
        const cleaned = rawText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
        notes = JSON.parse(cleaned) as GeminiEnrichmentResult;
      } catch {
        logger.warn({ typeCode: spec.typeCode, rawText }, "[signage-schedule-parser] Failed to parse Gemini response");
      }

      if (notes) {
        results.set(spec.typeCode, { notes, cropImageUrl });
      }
    } catch (err) {
      logger.warn({ err, typeCode: spec.typeCode }, "[signage-schedule-parser] Gemini enrichment failed for spec — non-fatal");
    }
  }

  // Process in batches of CONCURRENCY
  for (let i = 0; i < toEnrich.length; i += CONCURRENCY) {
    const batch = toEnrich.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(processSpec));
  }

  // Note: do NOT destroy doc here — it is shared/cached by getOrOpenPdfjsDoc in pdf-words.ts

  logger.info({ enriched: results.size }, "[signage-schedule-parser] Gemini enrichment complete");
  return results;
}

// ── Raw item extractor from pdfjs phrases ─────────────────────────────────────

/**
 * Convert PdfPhrase[] (normalized [0,1] coords) to RawTextItem[] in viewport pts.
 * This allows the parser to work in point-space for threshold comparisons.
 */
export function phrasesToRawItems(
  phrases: import("./pdf-words").PdfPhrase[],
  pageWidth: number,
  pageHeight: number,
): RawTextItem[] {
  return phrases.map((p) => ({
    text: p.text,
    x: p.x0 * pageWidth,
    y: p.y0 * pageHeight,
    w: (p.x1 - p.x0) * pageWidth,
    h: (p.y1 - p.y0) * pageHeight,
  }));
}
