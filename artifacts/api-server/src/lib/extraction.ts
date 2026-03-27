import fs from "fs/promises";
import pdfParse from "pdf-parse/lib/pdf-parse.js";
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
  confidence_score: number;
  review_flag: boolean;
}

const SIGN_EXTRACTION_PROMPT = `You are an expert sign industry estimator and takeoff specialist. Your task is to extract all sign-related information from architectural or sign plan documents.

Analyze the following text extracted from sign/architectural plan documents. Identify every sign, sign type, or sign callout mentioned.

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
- Parse dimension strings carefully: feet and inches, metric, etc.
- Return ONLY a valid JSON array. No markdown, no code blocks, no explanation.
- Each array element must have all the fields listed above.

TEXT FROM PLAN DOCUMENTS:
---
`;

async function extractTextFromPdf(filePath: string): Promise<{ text: string; numPages: number }> {
  try {
    const dataBuffer = await fs.readFile(filePath);
    const result = await pdfParse(dataBuffer);
    return { text: result.text, numPages: result.numpages };
  } catch (err) {
    logger.error({ err, filePath }, "Error extracting text from PDF");
    return { text: "", numPages: 0 };
  }
}

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

function parseGeminiResponse(raw: string): ExtractedSignRow[] {
  let text = raw.trim();

  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
  }

  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1) {
    throw new Error("No JSON array found in Gemini response");
  }

  const jsonStr = text.slice(start, end + 1);
  const parsed: unknown = JSON.parse(jsonStr);

  if (!Array.isArray(parsed)) {
    throw new Error("Gemini response is not a JSON array");
  }

  return (parsed as Record<string, unknown>[]).map((item) => {
    const score =
      typeof item.confidence_score === "number"
        ? Math.min(1, Math.max(0, item.confidence_score))
        : computeConfidence(item);

    return {
      sheet_number: typeof item.sheet_number === "string" ? item.sheet_number : null,
      detail_reference: typeof item.detail_reference === "string" ? item.detail_reference : null,
      sign_type: typeof item.sign_type === "string" ? item.sign_type : null,
      sign_identifier: typeof item.sign_identifier === "string" ? item.sign_identifier : null,
      quantity:
        typeof item.quantity === "number" ? Math.max(1, Math.round(item.quantity)) : null,
      location: typeof item.location === "string" ? item.location : null,
      dimensions: typeof item.dimensions === "string" ? item.dimensions : null,
      mounting_type: typeof item.mounting_type === "string" ? item.mounting_type : null,
      finish_color: typeof item.finish_color === "string" ? item.finish_color : null,
      illumination: typeof item.illumination === "string" ? item.illumination : null,
      materials: typeof item.materials === "string" ? item.materials : null,
      message_content: typeof item.message_content === "string" ? item.message_content : null,
      notes: typeof item.notes === "string" ? item.notes : null,
      confidence_score: score,
      review_flag: computeReviewFlag(item, score),
    };
  });
}

export interface GeminiAI {
  models: {
    generateContent: (opts: {
      model: string;
      contents: { role: string; parts: { text: string }[] }[];
      config?: { maxOutputTokens?: number; temperature?: number };
    }) => Promise<{ text: string | undefined }>;
  };
}

export async function extractSignsFromPdf(
  filePath: string,
  ai: GeminiAI
): Promise<{ rows: ExtractedSignRow[]; pageCount: number; rawText: string }> {
  const { text: rawText, numPages } = await extractTextFromPdf(filePath);

  if (!rawText || rawText.trim().length < 50) {
    logger.warn({ filePath }, "PDF yielded little or no extractable text");
    return { rows: [], pageCount: numPages, rawText };
  }

  const MAX_TEXT = 30000;
  const truncatedText = rawText.length > MAX_TEXT ? rawText.slice(0, MAX_TEXT) + "\n[...text truncated...]" : rawText;
  const prompt = SIGN_EXTRACTION_PROMPT + truncatedText;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: { maxOutputTokens: 8192, temperature: 0.1 },
    });

    const responseText = response.text ?? "";
    logger.info({ filePath, responseLength: responseText.length }, "Gemini extraction complete");

    const rows = parseGeminiResponse(responseText);
    return { rows, pageCount: numPages, rawText };
  } catch (err) {
    logger.error({ err, filePath }, "Gemini extraction failed");
    throw err;
  }
}
