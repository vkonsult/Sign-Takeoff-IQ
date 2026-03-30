import fs from "fs/promises";
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import { z } from "zod";
import { logger } from "./logger";

export interface ExtractedSignRow {
  sheet_number: string | null;
  detail_reference: string | null;
  sign_type: string | null;
  sign_identifier: string | null;
  quantity: number | null;
  location: string | null;
  dimensions: string | null;
  mounting_type: string | null;
  finish_color: string | null;
  illumination: string | null;
  materials: string | null;
  message_content: string | null;
  notes: string | null;
  page_number: number | null;
  confidence_score: number;
  review_flag: boolean;
}

// ─── PROMPTS ────────────────────────────────────────────────────────────────

const SIGN_SCHEDULE_PROMPT = `You are an expert sign industry estimator and takeoff specialist. Your task is to extract all sign-related information from architectural or sign plan documents.

The text below is extracted from a PDF, with each page delimited by "--- PAGE N ---". Use these page markers to determine which PDF page each sign appears on.

For each unique sign or sign entry identified, extract the following fields. Use null if a field is not available:

- sheet_number: The plan sheet number where this sign appears (e.g. "A-101", "S-1", "E-101")
- detail_reference: Any detail or callout reference number/letter (e.g. "1/A-5", "SN-01", "TYPE A")
- sign_type: The type or category of sign (e.g. "Building ID", "Wayfinding", "Regulatory", "Exit", "Room ID", "Parking", "Monument", "Pylon", "Cabinet", "Channel Letter", "Dimensional Letter", "ADA", "Informational", "Directional")
- sign_identifier: The sign code, number, or label that uniquely identifies it in the schedule (e.g. "S-01", "EX-1", "P1", "Sign Type A")
- quantity: Number of signs of this type (integer). Default to 1 if a specific sign is referenced but no quantity given.
- location: Where the sign is placed (e.g. "Main Entrance", "North Facade", "Lobby", "Suite 100 Door", "Parking Level 1")
- dimensions: Physical size of the sign (e.g. '24" x 36"', "4'0\" x 8'0\"", "18 x 24 inches")
- mounting_type: How the sign is attached (e.g. "Wall Mounted", "Post Mounted", "Suspended", "Floor Standing", "Flush Mount", "Projecting", "Cabinet Mount", "Direct Applied")
- finish_color: Surface finish, paint color, or material finish (e.g. "Brushed Aluminum", "Matte Black", "PMS 485 Red", "White with Blue Copy", "Clear Anodized")
- illumination: Lighting information (e.g. "Non-Illuminated", "Internally Illuminated", "Externally Illuminated", "LED Backlit", "Halo Lit", "Face Lit", "Neon", "LED Module")
- materials: Construction materials (e.g. "Aluminum", "Acrylic", "HDU", "Aluminum with Acrylic Face", "Vinyl on Aluminum", "PVC", "Stainless Steel", "Bronze", "Powder Coated Steel")
- message_content: The actual text, copy, or content of the sign (e.g. "ENTRANCE", "EXIT", "RESTROOMS", "Suite 100 - Company Name", "NO PARKING")
- notes: Any special instructions, specifications, or notes relevant to this sign (e.g. "ADA compliant", "UL Listed", "Landlord approval required", "Match existing signage")
- page_number: The PDF page number (integer, 1-indexed) where this sign callout, schedule row, or reference appears. Use the "--- PAGE N ---" markers to determine this.

After extracting all fields, compute:
- confidence_score: A number from 0.0 to 1.0 indicating how confident you are in the extraction.
  * 1.0 = All key fields present (sign_type, sign_identifier, quantity, location, dimensions)
  * 0.8 = Most key fields present, minor details missing
  * 0.6 = Some key fields missing (e.g. no dimensions or mounting type)
  * 0.4 = Only basic info available (sign type and location but little else)
  * 0.2 = Very little data, mostly inferred
- review_flag: true if confidence_score < 0.6 OR if sign_type is null OR if location is null, otherwise false

IMPORTANT RULES:
- Include every sign mentioned, even if partially described
- If you find a sign schedule table, extract each row as a separate entry
- Do NOT merge different sign types into one entry
- If quantity appears in a schedule, use that exact number
- Return ONLY a valid JSON array. No markdown, no code blocks, no explanation.
- Each array element must have all the fields listed above (including page_number).
- If the document contains NO sign-related information, return an empty JSON array: []
- NEVER explain why there are no signs. ONLY output the JSON array (even if it is empty).

SIGN SCHEDULE / SPECIFICATION PAGES:
---
`;

const FLOOR_PLAN_ADA_PROMPT = `You are an expert sign contractor and ADA compliance specialist performing a comprehensive sign takeoff from architectural floor plans.

The text below contains text extracted from floor plan sheets of a building. Your task is to identify ALL spaces and rooms visible in these plans and determine the COMPLETE REQUIRED SIGNAGE for each space based on:
1. ADA Standards for Accessible Design (Section 703 — Signs)
2. IBC / NFPA life-safety exit and egress signage requirements
3. Standard building sign practice for each space type

REQUIRED SIGN RULES — apply all that apply to each space:

ROOM IDENTIFICATION (ADA 703.1):
- EVERY room or space with a permanent designation (offices, conference rooms, suites, corridors, storage, locker rooms, break rooms, etc.) requires a tactile room ID sign mounted on the latch side of the door at 60" AFF.
- sign_type = "Room ID", dimensions = '6" x 8"' typical, materials = "ADA Tactile with Grade 2 Braille", mounting_type = "Wall Mounted — latch side of door @ 60\" AFF"

RESTROOM SIGNS (ADA 703.1):
- Every men's, women's, gender-neutral, or accessible restroom needs an ADA restroom sign with raised text and Braille.
- sign_type = "Restroom Sign", materials = "ADA Tactile with Grade 2 Braille", mounting_type = "Wall Mounted — latch side @ 60\" AFF"

EXIT / EGRESS SIGNS (IBC 1013 / NFPA 101):
- Every exit door, exit access door, and exit discharge leading to a means of egress requires an illuminated exit sign.
- sign_type = "Exit Sign", illumination = "LED Internally Illuminated", mounting_type = "Wall or Ceiling Mounted", dimensions = '10" x 14"' typical

STAIRWELL IDENTIFICATION (IBC 1023.9):
- At each floor level landing inside every stairwell, a floor-level identification sign is required showing the floor number, upper and lower terminus, and whether roof access is available.
- sign_type = "Stairwell Floor Level ID", materials = "ADA Tactile with Grade 2 Braille", mounting_type = "Wall Mounted — 5' AFF"

ELEVATOR / FLOOR LEVEL (ADA 703.1):
- At every elevator lobby, a tactile floor number sign is required at each landing.
- sign_type = "Elevator Floor Level", materials = "ADA Tactile with Grade 2 Braille", mounting_type = "Elevator Jamb"

FIRE / LIFE SAFETY:
- Fire extinguisher cabinets: "FIRE EXTINGUISHER" sign above each cabinet.
- Fire pull stations: identification sign/placard.
- Fire-rated door assemblies: "FIRE DOOR — KEEP CLOSED" signs where required.
- sign_type = "Fire Safety"

MECHANICAL / ELECTRICAL / UTILITY ROOMS:
- Every mechanical, electrical, boiler, utility, telecom, janitor / custodial closet, and IT/data room requires a room ID sign.
- sign_type = "Room ID — Utility/Mechanical"

PARKING / ACCESSIBLE SPACES:
- Each ADA-accessible parking space requires an accessible parking sign (van-accessible where applicable).
- sign_type = "Accessible Parking", dimensions = '12" x 18"' minimum

WAYFINDING / DIRECTIONAL:
- Major corridor intersections, building entrances, elevator lobbies, and areas requiring navigation assistance need directional signs.
- sign_type = "Directional / Wayfinding"

OUTPUT INSTRUCTIONS:
For every identifiable space or required sign location, output one JSON object per required sign type with these fields:
- sheet_number: plan sheet number (e.g. "A-101") — read from the page header or margin
- detail_reference: room number or space ID if visible (e.g. "101", "UNIT 4B")
- sign_type: the required sign type per the rules above
- sign_identifier: generate a code (e.g. "RI-01" for room ID, "EX-01" for exit, "RS-01" for restroom, "ST-01" for stair)
- quantity: 1 per location unless otherwise noted
- location: the specific room name or space (e.g. "Room 101 - Office", "Stair 1 — Level 2", "Women's Restroom — North Wing")
- dimensions: standard ADA or IBC dimensions as noted above
- mounting_type: as specified above for each sign type
- finish_color: null (to be specified by sign contractor)
- illumination: "Non-Illuminated" for ADA tactile signs; "LED Internally Illuminated" for exit signs
- materials: as specified above for each sign type
- message_content: what the sign says (e.g. room name/number, "EXIT", "MEN", "WOMEN", floor number)
- notes: "ADA Required — 703.1" or "IBC Required — 1013" as applicable; flag any uncertainty
- page_number: the PDF page number where you found this space (use "--- PAGE N ---" markers)
- confidence_score: 0.8 if the space is clearly identified; 0.5 if inferred from context; 0.3 if uncertain
- review_flag: true if confidence_score < 0.7

CRITICAL RULES:
- Every identifiable room or space MUST generate at least one sign entry
- Do NOT skip spaces because they are small or seem unimportant — custodial closets, utility rooms, data closets all need room ID signs
- Do NOT group multiple locations into one entry — each room/door/stair landing gets its own entry
- If a floor plan shows 12 offices, output 12 separate Room ID sign entries (one per room)
- Return ONLY a valid JSON array. No markdown, no code blocks, no explanation.
- If you cannot read the floor plan, return []

FLOOR PLAN PAGES (with page markers):
---
`;

// ─── PAGE SCORING ────────────────────────────────────────────────────────────

const FLOOR_PLAN_KEYWORDS = [
  "floor plan", "level", "plan view", "partition", "floor level",
  "unit", "suite", "office", "conference", "corridor", "hallway",
  "stair", "elevator", "lobby", "restroom", "bathroom", "lavatory",
  "mechanical", "electrical", "utility", "storage", "kitchen",
  "break room", "janitor", "closet", "entry", "reception", "bedroom",
  "living", "dining", "laundry", "lounge", "mail room", "amenity",
  "parking", "garage", "common area", "accessible", "ada",
  "mech", "elec", "vest", "rm ", "r.", "rm.", "b.", "br.",
  "stair 1", "stair 2", "elev.", "elev 1", "up", "dn",
  "f.e.", "fire exit", "fire extinguisher", "pull station",
];

const SIGN_SCHEDULE_KEYWORDS = [
  "sign schedule", "sign type", "signage schedule", "sign legend",
  "sign list", "sign index", "sign matrix", "sign catalog",
  "interior sign", "exterior sign", "room identification",
  "sign number", "sign id", "s-01", "s-1.", "s1.", "sign qty",
  "sign quantity", "sign detail", "sign location",
];

function scoreForFloorPlan(text: string): number {
  const lower = text.toLowerCase();
  return FLOOR_PLAN_KEYWORDS.reduce((score, kw) => {
    const count = (lower.match(new RegExp(kw.replace(/\./g, "\\."), "g")) || []).length;
    return score + count;
  }, 0);
}

function scoreForSignSchedule(text: string): number {
  const lower = text.toLowerCase();
  return SIGN_SCHEDULE_KEYWORDS.reduce((score, kw) => {
    const count = (lower.match(new RegExp(kw, "g")) || []).length;
    return score + count;
  }, 0);
}

type PageType = "floor_plan" | "sign_schedule" | "other";

interface ScoredPage {
  pageNum: number;
  text: string;
  floorPlanScore: number;
  signScheduleScore: number;
  type: PageType;
}

function classifyPage(pageNum: number, text: string): ScoredPage {
  const floorPlanScore = scoreForFloorPlan(text);
  const signScheduleScore = scoreForSignSchedule(text);

  let type: PageType = "other";
  if (signScheduleScore >= 2) {
    type = "sign_schedule";
  } else if (floorPlanScore >= 4) {
    type = "floor_plan";
  }

  return { pageNum, text, floorPlanScore, signScheduleScore, type };
}

// ─── PDF TEXT EXTRACTION ──────────────────────────────────────────────────────

async function extractTextFromPdf(filePath: string): Promise<{
  pages: ScoredPage[];
  numPages: number;
}> {
  try {
    const dataBuffer = await fs.readFile(filePath);
    const pageTexts: string[] = [];

    const options = {
      pagerender: (pageData: { getTextContent: () => Promise<{ items: Array<{ str: string }> }> }) => {
        return pageData.getTextContent().then((textContent) => {
          const pageText = textContent.items.map((item) => item.str).join(" ");
          pageTexts.push(pageText);
          return pageText;
        });
      },
    };

    const result = await pdfParse(dataBuffer, options as Parameters<typeof pdfParse>[1]);
    const rawPages = pageTexts.length > 0 ? pageTexts : [result.text];

    const pages = rawPages.map((text, i) => classifyPage(i + 1, text));

    const fpCount = pages.filter((p) => p.type === "floor_plan").length;
    const ssCount = pages.filter((p) => p.type === "sign_schedule").length;

    logger.info(
      {
        filePath: filePath.split("/").pop(),
        totalPages: pages.length,
        floorPlanPages: fpCount,
        signSchedulePages: ssCount,
        otherPages: pages.length - fpCount - ssCount,
      },
      "PDF pages classified"
    );

    return { pages, numPages: result.numpages };
  } catch (err) {
    logger.error({ err, filePath }, "Error extracting text from PDF");
    return { pages: [], numPages: 0 };
  }
}

// ─── BUILD TEXT BLOCK FOR GEMINI ──────────────────────────────────────────────

function buildPageBlock(
  pages: ScoredPage[],
  targetType: PageType,
  maxChars: number,
  maxPageChars: number
): string {
  const relevant = pages
    .filter((p) => p.type === targetType)
    .sort((a, b) => {
      if (targetType === "floor_plan") return b.floorPlanScore - a.floorPlanScore;
      return b.signScheduleScore - a.signScheduleScore;
    });

  const included: Array<{ pageNum: number; text: string }> = [];
  let totalChars = 0;

  for (const page of relevant) {
    const truncated = page.text.length > maxPageChars
      ? page.text.slice(0, maxPageChars) + " [...]"
      : page.text;
    const chunk = `--- PAGE ${page.pageNum} ---\n${truncated}`;
    if (totalChars + chunk.length > maxChars) break;
    included.push({ pageNum: page.pageNum, text: truncated });
    totalChars += chunk.length;
  }

  included.sort((a, b) => a.pageNum - b.pageNum);

  return included.map((p) => `--- PAGE ${p.pageNum} ---\n${p.text}`).join("\n\n");
}

// ─── SCHEMA & PARSING ─────────────────────────────────────────────────────────

function computeConfidence(item: Record<string, unknown>): number {
  const keyFields = ["sign_type", "sign_identifier", "quantity", "location", "dimensions"];
  const presentCount = keyFields.filter(
    (f) => item[f] != null && item[f] !== ""
  ).length;
  return Math.round((presentCount / keyFields.length) * 10) / 10;
}

function computeReviewFlag(item: Record<string, unknown>, score: number): boolean {
  return score < 0.6 || !item.sign_type || !item.location;
}

const GeminiSignRowSchema = z.object({
  sheet_number: z.string().nullable().optional().default(null),
  detail_reference: z.string().nullable().optional().default(null),
  sign_type: z.string().nullable().optional().default(null),
  sign_identifier: z.string().nullable().optional().default(null),
  quantity: z
    .union([z.number().int().positive(), z.null()])
    .optional()
    .default(null)
    .transform((v) => (v !== null && v !== undefined ? Math.max(1, Math.round(v)) : null)),
  location: z.string().nullable().optional().default(null),
  dimensions: z.string().nullable().optional().default(null),
  mounting_type: z.string().nullable().optional().default(null),
  finish_color: z.string().nullable().optional().default(null),
  illumination: z.string().nullable().optional().default(null),
  materials: z.string().nullable().optional().default(null),
  message_content: z.string().nullable().optional().default(null),
  notes: z.string().nullable().optional().default(null),
  page_number: z
    .union([z.number().int().positive(), z.null()])
    .optional()
    .default(null)
    .transform((v) => (v !== null && v !== undefined ? Math.round(v) : null)),
  confidence_score: z.number().min(0).max(1).optional(),
  review_flag: z.boolean().optional(),
});

const GeminiResponseSchema = z.array(GeminiSignRowSchema);

function repairTruncatedJson(text: string): unknown | null {
  const arrayStart = text.indexOf("[");
  if (arrayStart === -1) return null;

  const content = text.slice(arrayStart);

  // Find all complete top-level objects by bracket counting
  const objects: string[] = [];
  let depth = 0;
  let inString = false;
  let escape = false;
  let objStart = -1;

  for (let i = 0; i < content.length; i++) {
    const ch = content[i]!;

    if (escape) { escape = false; continue; }
    if (ch === "\\" && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;

    if (ch === "{") {
      if (depth === 1) objStart = i; // start of a top-level object
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 1 && objStart !== -1) {
        objects.push(content.slice(objStart, i + 1));
        objStart = -1;
      }
    } else if (ch === "[") {
      if (depth === 0) depth = 1; // the outer array
    } else if (ch === "]") {
      if (depth === 1) break; // normal end of array
      depth--;
    }
  }

  if (objects.length === 0) return null;

  try {
    return JSON.parse("[" + objects.join(",") + "]");
  } catch {
    return null;
  }
}

function parseGeminiResponse(raw: string, source: string): ExtractedSignRow[] {
  let text = raw.trim();

  // Strip markdown code fences (Gemini wraps JSON in ```json ... ```)
  if (text.startsWith("```")) {
    text = text.replace(/^```[a-z]*\n?/i, "").replace(/\n?```[\s\S]*$/, "").trim();
  }

  // Try straightforward JSON parse first (clean, non-truncated response)
  let parsed: unknown = null;

  // Try finding the outermost array
  const arrayStart = text.indexOf("[");
  const arrayEnd = text.lastIndexOf("]");

  if (arrayStart === -1) {
    logger.info({ source, responsePreview: text.slice(0, 200) }, "Gemini returned no JSON array");
    return [];
  }

  if (arrayEnd !== -1 && arrayEnd > arrayStart) {
    try {
      parsed = JSON.parse(text.slice(arrayStart, arrayEnd + 1));
    } catch {
      // Possibly truncated — fall through to repair
    }
  }

  // JSON repair: extract all complete objects even if the array was truncated
  if (parsed === null) {
    logger.warn({ source, textLen: text.length }, "JSON parse failed — attempting truncation repair");
    parsed = repairTruncatedJson(text);
    if (parsed === null) {
      logger.warn({ source, responsePreview: text.slice(0, 200) }, "JSON repair failed — returning empty");
      return [];
    }
    logger.info({ source, repairedCount: (parsed as unknown[]).length }, "JSON repair succeeded");
  }

  const result = GeminiResponseSchema.safeParse(parsed);
  if (!result.success) {
    logger.warn({ issues: result.error.issues, source }, "Gemini response failed schema validation");
    return [];
  }

  return result.data.map((item) => {
    const score =
      item.confidence_score !== undefined
        ? Math.min(1, Math.max(0, item.confidence_score))
        : computeConfidence(item as unknown as Record<string, unknown>);

    return {
      sheet_number: item.sheet_number ?? null,
      detail_reference: item.detail_reference ?? null,
      sign_type: item.sign_type ?? null,
      sign_identifier: item.sign_identifier ?? null,
      quantity: item.quantity ?? null,
      location: item.location ?? null,
      dimensions: item.dimensions ?? null,
      mounting_type: item.mounting_type ?? null,
      finish_color: item.finish_color ?? null,
      illumination: item.illumination ?? null,
      materials: item.materials ?? null,
      message_content: item.message_content ?? null,
      notes: item.notes ?? null,
      page_number: item.page_number ?? null,
      confidence_score: score,
      review_flag: item.review_flag ?? computeReviewFlag(item as unknown as Record<string, unknown>, score),
    };
  });
}

// ─── GEMINI CALL WITH RETRY ───────────────────────────────────────────────────

export interface GeminiAI {
  models: {
    generateContent: (opts: {
      model: string;
      contents: { role: string; parts: { text: string }[] }[];
      config?: {
        maxOutputTokens?: number;
        temperature?: number;
        thinkingConfig?: { thinkingBudget: number };
      };
    }) => Promise<{
      text: string | undefined;
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        totalTokenCount?: number;
      };
    }>;
  };
}

interface GeminiCallResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

async function callGemini(
  prompt: string,
  ai: GeminiAI,
  label: string
): Promise<GeminiCallResult> {
  const MAX_RETRIES = 4;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        config: {
          maxOutputTokens: 65536,
          temperature: 0.1,
          thinkingConfig: { thinkingBudget: 0 },
        },
      });
      const text = response.text ?? "";
      const inputTokens = response.usageMetadata?.promptTokenCount ?? 0;
      const outputTokens = response.usageMetadata?.candidatesTokenCount ?? 0;
      logger.info({ label, responseLength: text.length, inputTokens, outputTokens }, "Gemini call complete");
      return { text, inputTokens, outputTokens };
    } catch (err: unknown) {
      const isRateLimit =
        err instanceof Error &&
        (err.message.includes("RATELIMIT_EXCEEDED") ||
          err.message.includes("429") ||
          (err as { status?: number }).status === 429);

      if (isRateLimit && attempt < MAX_RETRIES) {
        const delayMs = Math.min(60000, 8000 * Math.pow(2, attempt));
        logger.warn({ attempt, delayMs, label }, "Gemini rate limit — retrying after delay");
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }

      logger.error({ err, label }, "Gemini call failed");
      throw err;
    }
  }

  throw new Error(`Gemini call exhausted all retries for: ${label}`);
}

// ─── MAIN EXPORT ──────────────────────────────────────────────────────────────

export async function extractSignsFromPdf(
  filePath: string,
  ai: GeminiAI
): Promise<{ rows: ExtractedSignRow[]; pageCount: number; rawText: string; inputTokens: number; outputTokens: number }> {
  const { pages, numPages } = await extractTextFromPdf(filePath);

  if (pages.length === 0) {
    logger.warn({ filePath }, "PDF yielded no pages");
    return { rows: [], pageCount: numPages, rawText: "", inputTokens: 0, outputTokens: 0 };
  }

  const allRows: ExtractedSignRow[] = [];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  // ── PASS 1: Sign Schedule / Specification Pages ───────────────────────────
  const signScheduleBlock = buildPageBlock(pages, "sign_schedule", 300000, 8000);

  if (signScheduleBlock.trim().length > 50) {
    logger.info({ filePath: filePath.split("/").pop() }, "Running sign schedule extraction pass");
    const { text: scheduleText, inputTokens: si, outputTokens: so } = await callGemini(
      SIGN_SCHEDULE_PROMPT + signScheduleBlock,
      ai,
      "sign-schedule"
    );
    totalInputTokens += si;
    totalOutputTokens += so;
    const scheduleRows = parseGeminiResponse(scheduleText, "sign-schedule");
    logger.info({ count: scheduleRows.length }, "Sign schedule pass complete");
    allRows.push(...scheduleRows);
  } else {
    logger.info({ filePath: filePath.split("/").pop() }, "No sign schedule pages found — skipping schedule pass");
  }

  // ── PASS 2: Floor Plan Pages — ADA-Required Signs ──────────────────────────
  // Split floor plan pages into batches of ~240K chars to stay under rate limits
  const MAX_FP_CHARS = 240000;
  const MAX_FP_PAGE_CHARS = 5000;

  const floorPlanPages = pages
    .filter((p) => p.type === "floor_plan")
    .sort((a, b) => b.floorPlanScore - a.floorPlanScore);

  if (floorPlanPages.length === 0) {
    logger.info({ filePath: filePath.split("/").pop() }, "No floor plan pages found — skipping ADA pass");
  } else {
    // Batch floor plan pages so each Gemini call is under MAX_FP_CHARS
    const batches: ScoredPage[][] = [];
    let currentBatch: ScoredPage[] = [];
    let currentChars = 0;

    for (const page of floorPlanPages) {
      const truncated = page.text.length > MAX_FP_PAGE_CHARS
        ? page.text.slice(0, MAX_FP_PAGE_CHARS)
        : page.text;
      const chunkLen = truncated.length + 20; // account for page header
      if (currentChars + chunkLen > MAX_FP_CHARS && currentBatch.length > 0) {
        batches.push(currentBatch);
        currentBatch = [];
        currentChars = 0;
      }
      currentBatch.push({ ...page, text: truncated });
      currentChars += chunkLen;
    }
    if (currentBatch.length > 0) batches.push(currentBatch);

    logger.info(
      { filePath: filePath.split("/").pop(), floorPlanPages: floorPlanPages.length, batches: batches.length },
      "Starting ADA floor plan extraction passes"
    );

    for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
      const batch = batches[batchIdx]!;
      // Sort back to page order for coherent reading
      batch.sort((a, b) => a.pageNum - b.pageNum);
      const block = batch.map((p) => `--- PAGE ${p.pageNum} ---\n${p.text}`).join("\n\n");

      const label = `floor-plan-batch-${batchIdx + 1}-of-${batches.length}`;
      logger.info({ batchPages: batch.length, label }, "Running ADA floor plan pass");

      const { text: fpText, inputTokens: fi, outputTokens: fo } = await callGemini(FLOOR_PLAN_ADA_PROMPT + block, ai, label);
      totalInputTokens += fi;
      totalOutputTokens += fo;
      const fpRows = parseGeminiResponse(fpText, label);
      logger.info({ count: fpRows.length, label }, "ADA floor plan pass complete");
      allRows.push(...fpRows);
    }
  }

  // ── PASS 3: Fallback — if nothing found yet, run general extraction ─────────
  if (allRows.length === 0) {
    logger.info({ filePath: filePath.split("/").pop() }, "No results from targeted passes — running general extraction fallback");

    const generalBlock = buildPageBlock(
      pages.map((p) => ({ ...p, type: "sign_schedule" as PageType })),
      "sign_schedule",
      300000,
      6000
    );

    if (generalBlock.trim().length > 50) {
      const { text: fallbackText, inputTokens: gi, outputTokens: go } = await callGemini(
        SIGN_SCHEDULE_PROMPT + generalBlock,
        ai,
        "general-fallback"
      );
      totalInputTokens += gi;
      totalOutputTokens += go;
      const fallbackRows = parseGeminiResponse(fallbackText, "general-fallback");
      allRows.push(...fallbackRows);
    }
  }

  const rawText = pages.map((p) => `--- PAGE ${p.pageNum} ---\n${p.text}`).slice(0, 10).join("\n\n");

  logger.info(
    {
      filePath: filePath.split("/").pop(),
      totalSigns: allRows.length,
      totalInputTokens,
      totalOutputTokens,
    },
    "Extraction complete"
  );

  return { rows: allRows, pageCount: numPages, rawText, inputTokens: totalInputTokens, outputTokens: totalOutputTokens };
}
