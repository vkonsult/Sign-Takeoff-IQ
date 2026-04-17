import fs from "fs/promises";
import { AsyncLocalStorage } from "async_hooks";
import { z } from "zod";
import { logger } from "./logger";
import {
  extractPdfMetadata,
  buildPageTextsFromPhraseCache,
  getPdfPageCount,
  extractPagePhrases,
  extractFloorPlanTextCandidates,
  type RoomCandidate,
} from "./pdf-words";
import { extractTitleBlockBuildingType } from "./phase-1-intake";
import type { PdfOutlineSection } from "./pdf-words";
import { CANONICAL_LEVEL_NAMES } from "./sign-vocabulary";
import { classifyPage, type PageType, type TitleBlockType, type ScoredPage } from "./extraction-classification";

// ── Shared vocabulary–derived prompt fragments ────────────────────────────────
// Built once at module load from the canonical level names list so prompts
// automatically reflect any future vocabulary changes.
const LEVEL_NAMES_PIPE = CANONICAL_LEVEL_NAMES
  .map((n) => n.replace(/\b\w/g, (c) => c.toUpperCase()))
  .join(" | ");
const LEVEL_NAMES_CONJUNCTION = CANONICAL_LEVEL_NAMES
  .map((n) => n.replace(/\b\w/g, (c) => c.toUpperCase()))
  .join(", ");

// ── Per-job Gemini call logger (AsyncLocalStorage-based) ─────────────────────
// AsyncLocalStorage ensures each concurrent job has its own logger context.
// No shared mutable state — concurrent scans cannot interfere with each other.
export interface GeminiCallEntry {
  prompt: string;
  rawResponse: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  label: string;
  pageNumber?: number;
  error?: string;
}

type GeminiCallLogger = (entry: GeminiCallEntry) => void;
const _geminiLoggerStorage = new AsyncLocalStorage<GeminiCallLogger>();

/**
 * Run `fn` with `logFn` as the job-scoped Gemini call logger.
 * Any callGemini / callGeminiMultimodal invocations within `fn` (including
 * async continuations) will fire `logFn` for audit logging.
 */
export function runWithGeminiCallLogger<T>(fn: () => Promise<T>, logFn: GeminiCallLogger): Promise<T> {
  return _geminiLoggerStorage.run(logFn, fn);
}

// ── Module-level cache for PDF text extraction ────────────────────────────────
// PDF files are immutable once uploaded, so caching by path is safe.
// Caps at 30 entries; oldest entry is evicted when full.
const PDF_TEXT_CACHE_MAX = 30;
const pdfTextCache = new Map<string, { pages: ScoredPage[]; numPages: number }>();

function pdfTextCacheSet(key: string, value: { pages: ScoredPage[]; numPages: number }): void {
  if (pdfTextCache.size >= PDF_TEXT_CACHE_MAX) {
    // Evict the oldest (first-inserted) entry
    const oldestKey = pdfTextCache.keys().next().value;
    if (oldestKey !== undefined) pdfTextCache.delete(oldestKey);
  }
  pdfTextCache.set(key, value);
}

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
  x_pos?: number | null;
  y_pos?: number | null;
  confidence_score: number;
  review_flag: boolean;
  extraction_method?: string | null;
}

// ─── PROMPTS ────────────────────────────────────────────────────────────────
// Note: SIGN_SCHEDULE_PROMPT was removed. Sign schedule pages are now processed
// by the deterministic spatial parser in signage-schedule-parser.ts.


// ─── PROJECT INFO PROMPT ──────────────────────────────────────────────────────

const PROJECT_INFO_PROMPT = `You are reviewing architectural plans. Look through all pages below for any title block, cover sheet, drawing index, or project header that contains project identification information.

Extract the following details:
- project_name: The building or project name (e.g. "Baker Street Office Tower", "225 Main Street Mixed-Use")
- address: The full street address of the project site (e.g. "294 Baker Street")
- city: The city name (e.g. "San Francisco", "Austin", "Miami")
- state: The 2-letter US state abbreviation where this project is located (e.g. "CA", "TX", "FL", "NY", "WA")
- zip: Zip / postal code if visible
- occupancy_type: The primary building occupancy/use (e.g. "Office", "Residential", "Mixed-Use Retail/Office", "Medical", "Industrial", "Hotel", "School")
- ahj: Authority Having Jurisdiction if mentioned (e.g. "City of Los Angeles", "Harris County", "NYC DOB")

Return ONLY a single JSON object (not an array):
{
  "project_name": "string or null",
  "address": "street address only or null",
  "city": "city name or null",
  "state": "2-letter state code or null",
  "zip": "zip code or null",
  "occupancy_type": "string or null",
  "ahj": "string or null"
}

Return ONLY the JSON object. No markdown, no code blocks, no explanation.
If no project information is found: {"project_name":null,"address":null,"city":null,"state":null,"zip":null,"occupancy_type":null,"ahj":null}

PLAN PAGES:
---
`;

export interface ProjectInfo {
  project_name: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  occupancy_type: string | null;
  ahj: string | null;
}

const ProjectInfoSchema = z.object({
  project_name: z.string().nullable().optional().default(null),
  address: z.string().nullable().optional().default(null),
  city: z.string().nullable().optional().default(null),
  state: z.string().nullable().optional().default(null),
  zip: z.string().nullable().optional().default(null),
  occupancy_type: z.string().nullable().optional().default(null),
  ahj: z.string().nullable().optional().default(null),
});

// ─── STATE-SPECIFIC SIGN REQUIREMENTS ─────────────────────────────────────────

function getStateSpecificRules(state: string | null): string {
  if (!state) return "";
  const s = state.toUpperCase().trim();

  const rules: Record<string, string> = {
    CA: `
CALIFORNIA-SPECIFIC REQUIREMENTS (California Building Code — CBC / Title 24):
- Apply CBC (California Building Code) which adopts IBC with extensive California amendments.
- All ADA signs must also comply with CBC 11B-703 (California Title 24 Part 2, Chapter 11B). California has stricter pictogram and spacing requirements than federal ADA.
- "Injury and Illness Prevention Program (IIPP)" posting required in all workplaces (Cal/OSHA 3203).
- Proposition 65 (Safe Drinking Water and Toxic Enforcement Act) warning signs required in facilities where chemical exposure above safe harbor levels may occur.
- Bilingual (English / Spanish) signage required in certain industries and occupancies per Cal/OSHA orders.
- High-rise buildings (over 75 ft): Photoluminescent egress path markings required per CBC 1025.
- Seismic safety: "Non-structural Hazard" advisory signs in high-occupancy areas of Seismic Zone 4.
- Cal Fire Chapter 9: Sprinkler, standpipe, and fire extinguisher signage follows CBC Chapter 9 / NFPA 13/14/10.
- note: Add "CBC 11B-703 / Title 24 Required" to all ADA and accessibility sign notes.`,

    TX: `
TEXAS-SPECIFIC REQUIREMENTS (Texas Accessibility Standards — TAS):
- All ADA/accessibility signs must comply with TAS (Texas Accessibility Standards) administered by TDLR (Texas Department of Licensing and Regulation), IN ADDITION to federal ADA.
- A Registered Accessibility Specialist (RAS) must inspect for accessibility compliance.
- TAS has some stricter requirements than federal ADA regarding mounting heights and sign placement.
- Texas Health & Safety Code: "No Smoking" signage required at building entrances and common areas.
- High-rise buildings in Texas: Follow IBC + Texas state fire marshal amendments.
- note: Add "TAS Required — TDLR" to all ADA/accessibility sign notes.`,

    NY: `
NEW YORK-SPECIFIC REQUIREMENTS (NYC Building Code / New York State Building Code):
- Apply NYC Building Code (for NYC projects) or NYS Building Code (for outside NYC), both based on IBC with extensive local amendments.
- High-rise buildings over 75 ft or 7+ stories: Floor Warden signs required at each floor (NYC Local Law 26 of 2004).
- "Certificate of Occupancy" must be posted conspicuously at building entrance (NYC Admin Code 28-118.17).
- NYC Admin Code 17-503: "No Smoking" signs required at all building entrances, elevators, and interior common areas.
- Buildings with 10+ dwelling units: Occupancy signs required in English and Spanish.
- NYC Fire Code (FDNY): Emergency action plan signs in all Class E buildings (office occupancies).
- NYC Local Law 55: Indoor allergen disclosure in multi-unit residential buildings.
- "Construction Site" warning signs per NYC DOB requirements during construction.
- note: Add "NYC Building Code / Local Law Required" to relevant sign notes.`,

    FL: `
FLORIDA-SPECIFIC REQUIREMENTS (Florida Building Code — FBC):
- Apply Florida Building Code (FBC) 7th Edition, which adopts IBC with Florida-specific amendments.
- Coastal construction: Hurricane shelter signs required in FEMA Zone V and coastal high hazard areas.
- "Flood Zone" identification signs required in buildings located within FEMA-designated Special Flood Hazard Areas (SFHA).
- Florida Statute 553.504: All ADA signs must comply with FBC Accessibility requirements.
- FBC Chapter 9: Fire protection signage follows FBC Chapter 9 with Florida-specific fire safety requirements.
- "This area protected by an automatic fire sprinkler system" sign required per NFPA 13 as adopted in Florida.
- note: Add "FBC Required" to relevant sign notes.`,

    IL: `
ILLINOIS-SPECIFIC REQUIREMENTS (Illinois Accessibility Code — IAC / Chicago Building Code):
- Apply Illinois Accessibility Code (IAC) in addition to federal ADA for all state-funded or state-licensed facilities.
- Chicago city limits: Apply Chicago Building Code (CBC — not to be confused with California) with Chicago-specific amendments.
- Chicago Municipal Code 13-196: Emergency egress and exit sign requirements.
- Illinois Fire Prevention Code: Follows NFPA 101 with Illinois State Fire Marshal amendments.
- note: Add "IAC Required" to all accessibility sign notes.`,

    WA: `
WASHINGTON STATE-SPECIFIC REQUIREMENTS (Washington Administrative Code — WAC):
- Apply Washington State Building Code (WAC 51-50) which adopts IBC with Washington amendments.
- WAC 51-50-1013: Exit sign requirements follow IBC 1013 as adopted in Washington.
- Washington Industrial Safety and Health Act (WISHA): Safety signage requirements per WAC 296-800.
- Seattle (if applicable): Apply Seattle Building Code with additional local requirements.
- note: Add "WAC Required" to relevant sign notes.`,

    CO: `
COLORADO-SPECIFIC REQUIREMENTS (Colorado Building Code):
- Apply Colorado Building Code which is based on IBC.
- Colorado Fire Code: Follows IFC with Colorado Division of Fire Prevention and Control amendments.
- High altitude considerations: Some occupancy calculations differ for high-altitude locations.
- note: Add "Colorado Building Code Required" to relevant sign notes.`,

    AZ: `
ARIZONA-SPECIFIC REQUIREMENTS (Arizona Building Code):
- Apply Arizona Building Code which adopts IBC with Arizona state amendments.
- Arizona Fire Code follows IFC as adopted by the State Fire Marshal.
- note: Add "Arizona Building Code Required" to relevant sign notes.`,

    GA: `
GEORGIA-SPECIFIC REQUIREMENTS (Georgia State Minimum Standard Codes):
- Apply Georgia State Minimum Standard Building Code (based on IBC) with Georgia state amendments.
- Georgia Safety Fire Law: Fire protection and egress signage per Georgia State Fire Marshal requirements.
- note: Add "Georgia State Code Required" to relevant sign notes.`,

    NC: `
NORTH CAROLINA-SPECIFIC REQUIREMENTS (NC Building Code):
- Apply North Carolina Building Code (NCBC) which adopts IBC with North Carolina amendments.
- NC Fire Prevention Code: Based on IFC with NC state amendments.
- NC Accessibility Code: Adopts ADA with North Carolina-specific provisions.
- note: Add "NCBC Required" to relevant sign notes.`,

    VA: `
VIRGINIA-SPECIFIC REQUIREMENTS (Virginia Uniform Statewide Building Code — USBC):
- Apply Virginia USBC which is based on IBC with Virginia amendments.
- Virginia Statewide Fire Prevention Code: Based on IFC.
- DPOR (Department of Professional and Occupational Regulation) oversees accessibility compliance.
- note: Add "Virginia USBC Required" to relevant sign notes.`,
  };

  return rules[s]
    ? rules[s]
    : `\nSTATE REQUIREMENTS (${s}): Apply all applicable ${s} state building code and fire code requirements in addition to federal IBC, ADA, and NFPA standards. Consult the state building official for jurisdiction-specific sign requirements.`;
}

// ─── FLOOR PLAN ADA + FIRE CODE PROMPT ────────────────────────────────────────

export interface VerifiedSignSummary {
  signIdentifier: string | null;
  signType: string | null;
  location: string | null;
  pageNumber: number | null;
  sheetNumber: string | null;
  messageContent: string | null;
}

function buildVerifiedContext(verifiedSigns: VerifiedSignSummary[]): string {
  if (verifiedSigns.length === 0) return "";
  const lines = verifiedSigns.map((s) =>
    [
      s.signIdentifier ? `ID: ${s.signIdentifier}` : null,
      s.signType ? `Type: ${s.signType}` : null,
      s.location ? `Location: ${s.location}` : null,
      s.pageNumber ? `Page: ${s.pageNumber}` : null,
      s.sheetNumber ? `Sheet: ${s.sheetNumber}` : null,
      s.messageContent ? `Copy: "${s.messageContent}"` : null,
    ].filter(Boolean).join(" | ")
  );
  return `\n\nUSER-VERIFIED SIGNS FOR THIS JOB (already confirmed — DO NOT re-output these in your JSON; use them to understand this project's sign conventions and skip exact duplicates):\n---\n${lines.join("\n")}\n---\n`;
}

/**
 * Analyses all cross-job verified signs and distils them into a compact
 * "contractor conventions" block.  This is building-type-agnostic: we care
 * only about *how* this shop formats identifiers, locations, and copy —
 * not *what kind* of building they came from.
 *
 * Output is intentionally small (~300-600 tokens) so it doesn't inflate the
 * prompt the way raw rows would.
 */
function buildTrainingContext(trainingSigns: VerifiedSignSummary[]): string {
  if (trainingSigns.length === 0) return "";

  const totalSigns = trainingSigns.length;

  // ── 1. Identifier prefix pattern ─────────────────────────────────────────
  // e.g. "RS-01" → prefix "RS", separator "-", width 2
  // Collect all identifiers that match [A-Z]{1,4}[-_ ]?\d{1,4}
  const idPattern = /^([A-Z]{1,4})([-_ ]?)(\d{1,4})$/;
  const prefixCounts: Record<string, number> = {};
  let separatorSample = "-";
  let numberWidthSample = 2;
  let identifiedCount = 0;
  for (const s of trainingSigns) {
    const id = (s.signIdentifier ?? "").trim().toUpperCase();
    const m = id.match(idPattern);
    if (m) {
      identifiedCount++;
      prefixCounts[m[1]] = (prefixCounts[m[1]] ?? 0) + 1;
      separatorSample = m[2] || "";
      numberWidthSample = m[3].length;
    }
  }
  const topPrefixes = Object.entries(prefixCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([p, n]) => `${p}${separatorSample}XX (×${n})`);

  const identifierBlock =
    identifiedCount > 0
      ? `Identifier format: [PREFIX]${separatorSample}[${numberWidthSample}-digit number], e.g. ${topPrefixes.slice(0, 4).join(", ")}\nKnown prefixes used: ${topPrefixes.join(", ")}`
      : null;

  // ── 2. Location description style ────────────────────────────────────────
  // Detect whether they use "—", "-", or "," as separator; capitalisation; etc.
  const locSamples = trainingSigns
    .map((s) => s.location ?? "")
    .filter((l) => l.length > 3);
  const emDashCount = locSamples.filter((l) => l.includes("—")).length;
  const hyphenCount = locSamples.filter((l) => l.includes(" - ")).length;
  const locSeparator =
    emDashCount > hyphenCount ? "em-dash (—)" : "hyphen ( - )";
  const locExamples = locSamples
    .filter((l) => l.length > 5 && l.length < 60)
    .slice(0, 5)
    .map((l) => `"${l}"`);
  const locationBlock =
    locExamples.length > 0
      ? `Location description style: uses ${locSeparator} as separator\nExample formats: ${locExamples.join(", ")}`
      : null;

  // ── 3. Copy / message conventions per sign type ───────────────────────────
  // For common sign types, collect the most-used message copy
  const copyByType: Record<string, Record<string, number>> = {};
  for (const s of trainingSigns) {
    const type = (s.signType ?? "Unknown").trim();
    const copy = (s.messageContent ?? "").trim();
    if (!copy || copy.length < 2) continue;
    if (!copyByType[type]) copyByType[type] = {};
    copyByType[type][copy] = (copyByType[type][copy] ?? 0) + 1;
  }
  const copyLines: string[] = [];
  for (const [type, copies] of Object.entries(copyByType)) {
    const topCopy = Object.entries(copies)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([c]) => `"${c}"`)
      .join(" / ");
    if (topCopy) copyLines.push(`  ${type}: ${topCopy}`);
  }
  const copyBlock =
    copyLines.length > 0
      ? `Preferred message copy by sign type:\n${copyLines.slice(0, 12).join("\n")}`
      : null;

  // ── 4. Sign type frequency (tells the AI which types this shop cares about) ─
  const typeCounts: Record<string, number> = {};
  for (const s of trainingSigns) {
    const t = (s.signType ?? "Unknown").trim();
    typeCounts[t] = (typeCounts[t] ?? 0) + 1;
  }
  const topTypes = Object.entries(typeCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([t, n]) => `${t} (${n})`)
    .join(", ");

  // ── Assemble ──────────────────────────────────────────────────────────────
  const blocks = [
    `CONTRACTOR CONVENTIONS (derived from ${totalSigns} verified signs across past projects):`,
    `These apply across all building types — use them for consistency on every new job.`,
    identifierBlock,
    locationBlock,
    `Most common sign types in this shop's work: ${topTypes}`,
    copyBlock,
    `IMPORTANT: Continue identifying ALL signs in the current document normally; these conventions only govern naming format and copy style.`,
  ].filter(Boolean);

  return `\n\n${blocks.join("\n\n")}\n`;
}

/**
 * Build a compact candidates context block from pre-filtered floor plan text tokens.
 * Each candidate is a `{ text, x, y, page }` object extracted deterministically
 * from the PDF text layer — no AI involvement.  Providing this list focuses the
 * AI on classification rather than room discovery, reducing hallucination.
 */
function buildCandidatesContext(candidates: Array<{ text: string; x: number; y: number; page: number }>): string {
  if (!candidates || candidates.length === 0) return "";
  // Group by page for readability
  const byPage = new Map<number, typeof candidates>();
  for (const c of candidates) {
    if (!byPage.has(c.page)) byPage.set(c.page, []);
    byPage.get(c.page)!.push(c);
  }
  const lines: string[] = [];
  for (const [page, items] of [...byPage.entries()].sort((a, b) => a[0] - b[0])) {
    lines.push(`Page ${page}:`);
    for (const item of items) {
      lines.push(`  "${item.text}" @ (${item.x.toFixed(3)}, ${item.y.toFixed(3)})`);
    }
  }
  return `\n\nPRE-IDENTIFIED ROOM LABEL CANDIDATES (extracted deterministically from the PDF text layer — no AI):
These are the actual text tokens found on the floor plan pages, filtered to remove noise.
For each candidate, confirm whether it is a real room label and assign the correct sign type.
You may also output signs for code-required locations (egress, ADA) not in this list.
---
${lines.join("\n")}
---
`;
}

function buildFloorPlanADAPrompt(
  projectContext?: ProjectInfo,
  signScheduleContext?: string,
  verifiedSigns?: VerifiedSignSummary[],
  trainingContext?: VerifiedSignSummary[],
  specTypeContext?: string,
  buildingType?: string | null,
  roomCandidates?: Array<{ text: string; x: number; y: number; page: number }>,
): string {
  const locationLine = projectContext?.address || projectContext?.city || projectContext?.state
    ? `\nPROJECT LOCATION: ${[projectContext.address, projectContext.city, projectContext.state, projectContext.zip].filter(Boolean).join(", ")}`
    : "";
  const occupancyLine = projectContext?.occupancy_type
    ? `\nBUILDING OCCUPANCY: ${projectContext.occupancy_type}`
    : "";
  const buildingTypeLine = buildingType
    ? `\nDETECTED BUILDING TYPE: ${buildingType.toUpperCase()} — apply vocabulary and sign types specific to this building category`
    : "";
  const stateRules = getStateSpecificRules(projectContext?.state ?? null);
  const scheduleCtx = signScheduleContext
    ? `\n\nSIGN SCHEDULE / SPECIFICATION CONTEXT (for reference only — do NOT re-list these as output rows; use them to understand sign types, identifiers, and specs defined for this project):\n---\n${signScheduleContext.slice(0, 10000)}\n---\n`
    : "";
  const specCtx = specTypeContext
    ? `\n\nPROJECT SIGN TYPE CATALOG FROM SPECIFICATION (for reference only — use these definitions to correctly identify and describe sign types; do NOT generate separate output rows for the spec definitions themselves):\n---\n${specTypeContext.slice(0, 12000)}\n---\n`
    : "";
  const candidatesCtx = roomCandidates && roomCandidates.length > 0
    ? buildCandidatesContext(roomCandidates)
    : "";
  const verifiedCtx = verifiedSigns && verifiedSigns.length > 0 ? buildVerifiedContext(verifiedSigns) : "";
  const trainingCtx = trainingContext && trainingContext.length > 0 ? buildTrainingContext(trainingContext) : "";

  const taskDescription = candidatesCtx
    ? `Your primary task is to CONFIRM, CLASSIFY, and ASSIGN SIGNS to the pre-identified room label candidates listed below (extracted deterministically from the PDF text layer). For each candidate, determine whether it is a real room label and assign the complete required signage. You may additionally output signs for code-required locations (egress exits, stairwells, electrical rooms, fire extinguishers, etc.) that are NOT in the candidate list, but do NOT invent arbitrary rooms beyond what the candidates and mandatory code locations together indicate.`
    : `Your task is to identify ALL spaces and rooms visible in these plans and determine the COMPLETE REQUIRED SIGNAGE for each space based on the rules below.`;

  return `You are an expert sign contractor, ADA compliance specialist, and fire/life-safety code consultant performing a comprehensive sign takeoff from architectural floor plans.

The text below contains text extracted from floor plan sheets of a building. ${taskDescription}

Signage requirements are based on:
1. ADA Standards for Accessible Design (Section 703 — Signs)
2. IBC (International Building Code) egress and life-safety signage
3. NFPA 101 Life Safety Code signage requirements
4. NFPA 10, 13, 14, 72, 80, 96, and 170 fire protection sign requirements
5. OSHA 1910.145 and 1910.303 safety signage requirements
6. Standard building sign practice for each space type
${locationLine}${occupancyLine}${buildingTypeLine}${stateRules}

REQUIRED SIGN RULES — apply ALL that apply to each identified space or location:

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ADA / ACCESSIBILITY SIGNS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

ROOM IDENTIFICATION (ADA 703.1 / IBC 1110):
- EVERY room or space with a permanent designation (offices, conference rooms, suites, corridors, storage, locker rooms, break rooms, server rooms, mail rooms, copy rooms, etc.) requires a tactile room ID sign mounted on the latch side of the door at 60" AFF.
- sign_type = "Room ID", dimensions = '6" x 8"' typical, materials = "ADA Tactile with Grade 2 Braille", mounting_type = "Wall Mounted — latch side of door @ 60\\" AFF"

RESTROOM SIGNS (ADA 703.1):
- Every men's, women's, gender-neutral, family, or accessible restroom needs an ADA restroom sign with raised text and Braille.
- sign_type = "Restroom Sign", materials = "ADA Tactile with Grade 2 Braille", mounting_type = "Wall Mounted — latch side @ 60\\" AFF"

STAIRWELL IDENTIFICATION (IBC 1023.9 / ADA 703.1):
- At EACH floor level landing inside EVERY stairwell, a floor-level identification sign is required showing the floor number, the upper and lower terminus floors, and whether roof access is available.
- sign_type = "Stairwell Floor Level ID", materials = "ADA Tactile with Grade 2 Braille", mounting_type = "Wall Mounted — 5' AFF at each stair landing"

ELEVATOR / FLOOR LEVEL (ADA 703.1):
- At every elevator landing (inside cab and at each floor lobby), a tactile floor number sign is required.
- sign_type = "Elevator Floor Level", materials = "ADA Tactile with Grade 2 Braille", mounting_type = "Elevator Jamb"

ACCESSIBLE PARKING (ADA 502.6 / ADAAG):
- Each ADA-accessible parking space requires an accessible parking sign (van-accessible where applicable), minimum 60" AFF to bottom of sign.
- sign_type = "Accessible Parking", dimensions = '12" x 18"' minimum, mounting_type = "Post Mounted — 60\\" AFF minimum"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EXIT / EGRESS SIGNS (IBC 1013 / NFPA 101 §7.10)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

EXIT SIGNS (IBC 1013.1):
- Every exit door, exit access door, and exit discharge leading to a required means of egress requires an illuminated exit sign visible from 100 ft.
- sign_type = "Exit Sign", illumination = "LED Internally Illuminated", mounting_type = "Wall or Ceiling Mounted", dimensions = '10" x 14"' typical, materials = "LED Exit Sign with Battery Backup"
- notes = "IBC 1013.1 / NFPA 101 §7.10 Required"

EMERGENCY EXIT ONLY — ALARM SIGNS (IBC 1010.2.13):
- Delayed-egress or alarmed-only exit doors that are not accessible from outside require warning signs.
- sign_type = "Emergency Exit Alarm", dimensions = '3" x 12"' typical, mounting_type = "Door Surface Mount"
- message_content = "EMERGENCY EXIT ONLY — ALARM WILL SOUND — DOOR OPENS IN 15 SECONDS"
- notes = "IBC 1010.2.13 Required — delayed egress doors"

PHOTOLUMINESCENT EGRESS PATH MARKERS (IBC 1025):
- In high-rise buildings (occupied floors above 75 ft), enclosed stairwells, and exit access corridors of large occupancies: photoluminescent markers at each floor landing, on door handles, at corridor corners, and at floor level.
- sign_type = "Photoluminescent Egress Marker", dimensions = '2" x 8"' strips typical, mounting_type = "Wall/Floor Mounted — 6\\" to 18\\" AFF"
- materials = "Photoluminescent — UL 924", notes = "IBC 1025 Required — enclosed stairwells and high-rise"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FIRE / LIFE SAFETY SIGNS — NFPA & IBC REQUIRED
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

FIRE EXTINGUISHER LOCATION (NFPA 10 §6.1):
- EVERY fire extinguisher cabinet, wall-mounted bracket, or portable extinguisher location MUST have an identification sign mounted above it so the extinguisher is visible from 50 ft. This is one of the most commonly missed signs in architectural plans.
- sign_type = "Fire Extinguisher Location", dimensions = '8" x 12"' typical, mounting_type = "Wall Mounted — above cabinet or bracket"
- illumination = "Non-Illuminated", materials = "Aluminum or Rigid Plastic"
- message_content = "FIRE EXTINGUISHER", notes = "NFPA 10 §6.1 Required — every fire extinguisher location"

FIRE ALARM PULL STATIONS (NFPA 72 §18.4):
- Each manual fire alarm pull station requires an identification placard or sign. Often the pull station housing has a small sign integrated, but a separate identification sign is required if the station is not in plain view.
- sign_type = "Fire Alarm Pull Station", dimensions = '2" x 4"' placard or '6" x 8"'
- message_content = "FIRE ALARM — PULL IN CASE OF FIRE", mounting_type = "Wall Mounted — at pull station"
- notes = "NFPA 72 Required — every pull station location"

FIRE ALARM CONTROL PANEL / FACP (NFPA 72):
- The fire alarm control panel room or location must be clearly identified.
- sign_type = "Fire Alarm Control Panel", dimensions = '6" x 8"', mounting_type = "Door or Wall Mounted"
- message_content = "FIRE ALARM CONTROL PANEL — DO NOT OBSTRUCT"
- notes = "NFPA 72 Required — FACP location"

FIRE SPRINKLER SYSTEM / RISER ROOM (NFPA 13 §3.3):
- Sprinkler riser rooms, main water supply shutoff areas, and FDC connections must be identified.
- Each zone control valve and main shutoff requires a sign indicating the area it serves.
- sign_type = "Fire Sprinkler System", dimensions = '8" x 10"', mounting_type = "Wall Mounted"
- message_content = "FIRE SPRINKLER RISER ROOM" or "SPRINKLER VALVE — ZONE [X] — DO NOT CLOSE WITHOUT AUTHORIZATION"
- notes = "NFPA 13 Required — riser room and all control valves"

FIRE DEPARTMENT CONNECTION / FDC (NFPA 13 §6.8 / NFPA 14):
- Every exterior fire department connection (Siamese connection) for sprinkler or standpipe systems requires a sign indicating the system type and floor/area served.
- sign_type = "Fire Department Connection", dimensions = '6" x 8"', mounting_type = "Wall Mounted — above FDC"
- message_content = "FIRE DEPT CONNECTION — AUTOMATIC SPRINKLER" or "FDC — STANDPIPE SYSTEM"
- notes = "NFPA 13 / NFPA 14 Required — exterior FDC location"

STANDPIPE / FIRE HOSE CABINETS (NFPA 14 §7.3):
- Every standpipe hose cabinet, standpipe outlet valve, and fire hose cabinet must be identified. These are commonly found in stairwells and corridor alcoves.
- sign_type = "Standpipe / Fire Hose Cabinet", dimensions = '6" x 8"', mounting_type = "Cabinet Door or Wall Above"
- message_content = "STANDPIPE" or "FIRE HOSE CABINET — FOR FIRE USE ONLY"
- notes = "NFPA 14 Required — all standpipe outlets and hose cabinets"

FIRE PUMP ROOM (NFPA 20):
- Fire pump rooms must be clearly identified with restricted access signage.
- sign_type = "Fire Pump Room", dimensions = '6" x 9"', mounting_type = "Door Mounted"
- message_content = "FIRE PUMP ROOM — AUTHORIZED PERSONNEL ONLY"
- notes = "NFPA 20 Required"

FIRE DOOR — KEEP CLOSED (NFPA 80 / IBC 716.5):
- EVERY fire-rated door assembly in a fire wall, fire barrier, fire partition, or smoke barrier wall MUST have a "FIRE DOOR — KEEP CLOSED" sign affixed to the door.
- Doors with hold-open devices require "FIRE DOOR — DO NOT BLOCK — WILL CLOSE AUTOMATICALLY".
- sign_type = "Fire Door", dimensions = '4" x 6"' typical, mounting_type = "Door Surface Mount — both sides"
- message_content = "FIRE DOOR — KEEP CLOSED" or "FIRE DOOR — DO NOT BLOCK"
- notes = "NFPA 80 / IBC 716.5 Required — all rated door assemblies"

KITCHEN SUPPRESSION SYSTEM (NFPA 96 §10.2):
- Commercial kitchen areas with cooking equipment under an exhaust hood must have a suppression system identification sign.
- sign_type = "Kitchen Suppression System", dimensions = '6" x 8"', mounting_type = "Wall Mounted — near hood"
- message_content = "FIRE SUPPRESSION SYSTEM — DO NOT OBSTRUCT NOZZLES — PULL PIN AND ACTIVATE MANUAL CONTROL IN EMERGENCY"
- notes = "NFPA 96 Required — commercial kitchen/cooking areas"

NO SMOKING — FIRE CODE (NFPA 1 §13.7 / State Law):
- Required at ALL building entrances, common areas, and mechanical/storage rooms per fire code and applicable state laws. Often required in parking garages as well.
- sign_type = "No Smoking", dimensions = '4" x 4"' to '6" x 6"', mounting_type = "Wall Mounted — at each entrance and common area"
- message_content = "NO SMOKING" or "THIS IS A SMOKE-FREE FACILITY — NO SMOKING WITHIN 25 FEET OF ENTRANCE"
- notes = "NFPA 1 / State Fire Code Required — all entrances and common areas"

EVACUATION ROUTE MAP (IBC 403.6.1 / OSHA 1910.38):
- Required in: high-rise buildings (4+ floors), hotels/motels, assembly occupancies, and all OSHA-regulated workplaces. Mounted at corridor T-intersections, elevator lobbies, and stairwell doors on each floor.
- sign_type = "Evacuation Route Map", dimensions = '11" x 17"' minimum, mounting_type = "Wall Mounted — elevator lobbies, corridor junctions, stairwell doors"
- message_content = "FLOOR EVACUATION PLAN — [FLOOR #] — YOU ARE HERE"
- notes = "IBC 403.6.1 / OSHA 1910.38 Required — high-rise and assembly occupancies"

EMERGENCY ASSEMBLY AREA (OSHA 1910.38 / IBC):
- Exterior signs directing occupants to the designated emergency assembly area, AND interior directional signs leading to the assembly area egress path.
- sign_type = "Emergency Assembly Area", mounting_type = "Post Mounted (exterior) or Wall Mounted (interior directional)"
- message_content = "EMERGENCY ASSEMBLY AREA — PROCEED HERE DURING EVACUATION"
- notes = "OSHA 1910.38 Required"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ELECTRICAL / MECHANICAL HAZARD SIGNS (NFPA 70 / OSHA)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

ELECTRICAL ROOM / PANEL (NFPA 70 Art. 110.27 / OSHA 1910.303):
- All electrical rooms, switchgear rooms, MCC rooms, and electrical panel locations require hazard identification signs. Panels must be labeled with circuit directory.
- sign_type = "Electrical Hazard", dimensions = '7" x 10"', mounting_type = "Door Mounted or Wall Mounted"
- message_content = "ELECTRICAL ROOM — AUTHORIZED PERSONNEL ONLY — DANGER: HIGH VOLTAGE"
- notes = "NFPA 70 / OSHA 1910.303 Required — all electrical rooms"

GAS SHUTOFF / METER (NFPA 54 / UFC):
- Rooms or areas with gas service, gas meters, or emergency gas shutoff valves require identification signs.
- sign_type = "Gas Shutoff", dimensions = '6" x 8"', mounting_type = "Wall Mounted — at valve"
- message_content = "EMERGENCY GAS SHUTOFF VALVE" or "GAS METER — SHUTOFF VALVE LOCATED INSIDE"
- notes = "NFPA 54 / UFC Required — all gas shutoff locations"

MAXIMUM OCCUPANCY LOAD (IBC 1004.3):
- Required in ALL assembly occupancies: conference rooms, meeting rooms, dining rooms, auditoriums, lobbies, fitness centers, and any room with an occupant load over 49 persons.
- sign_type = "Maximum Occupancy Load", dimensions = '8.5" x 11"' minimum, mounting_type = "Wall Mounted — near main entrance to space"
- message_content = "MAXIMUM OCCUPANCY: [NUMBER] PERSONS — [AUTHORITY] FIRE CODE"
- notes = "IBC 1004.3 Required — assembly occupancies / rooms over 49 persons"

NFPA 704 HAZARDOUS MATERIALS DIAMOND (NFPA 704):
- EVERY room or area used for chemical storage, flammable liquid storage, compressed gas cylinder storage, laboratory chemical storage, or any hazmat-related use REQUIRES an NFPA 704 fire diamond placard on the exterior of each door/opening.
- sign_type = "NFPA 704 Hazmat Placard", dimensions = '10" x 10"' minimum, mounting_type = "Door Mounted — exterior side"
- message_content = "HAZARDOUS MATERIALS — NFPA 704 (Health / Flammability / Instability / Special ratings per hazmat inventory)"
- notes = "NFPA 704 Required — chemical storage, lab areas, flammable material storage"

EMERGENCY EYEWASH / SAFETY SHOWER (ANSI Z358.1):
- Laboratory, chemical handling, manufacturing, or janitorial areas with emergency eyewash stations or safety showers require bright identification signs visible from 30 ft.
- sign_type = "Emergency Eyewash / Safety Shower", dimensions = '7" x 10"', mounting_type = "Wall Mounted — above unit"
- message_content = "EMERGENCY EYEWASH" or "EMERGENCY SAFETY SHOWER — FLUSH EYES/SKIN 15 MIN"
- notes = "ANSI Z358.1 Required — lab and chemical handling areas"

ELEVATOR FIRE SERVICE (ASME A17.1):
- Each elevator requires "Phase I Fire Service" signage at the recall key switch location in the lobby, and "Phase II Fire Service" labeling inside the cab.
- sign_type = "Elevator Fire Service", dimensions = '3" x 6"', mounting_type = "Wall Mounted — at elevator lobby key switch"
- message_content = "FIRE SERVICE PHASE I — KEY SWITCH"
- notes = "ASME A17.1 Required — all elevators"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
MECHANICAL / UTILITY / SUPPORT SPACES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

MECHANICAL / UTILITY ROOM ID:
- Every mechanical room, boiler room, air handling unit room, chiller room, pump room, utility room, IT/data room, telecom room (IDF/MDF), janitor/custodial closet, and server room requires a room ID sign (AND, if applicable, electrical or hazmat signage).
- sign_type = "Room ID — Utility/Mechanical", materials = "ADA Tactile with Grade 2 Braille" (if publicly accessible path) or "Aluminum" for non-public utility spaces

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
WAYFINDING / DIRECTIONAL
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

DIRECTIONAL / WAYFINDING:
- Major corridor intersections, building entrances, elevator lobbies, and any area requiring navigation assistance needs directional signs with location arrows.
- sign_type = "Directional / Wayfinding"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
OUTPUT INSTRUCTIONS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

For every identifiable space or required sign location, output one JSON object per required sign type with these exact fields:
- sheet_number: plan sheet number (e.g. "A-101") — read from page header or margin
- detail_reference: room number or space ID if visible (e.g. "101", "UNIT 4B", "STAIR 1")
- sign_type: the required sign type per the rules above
- sign_identifier: generate a short code (e.g. "RI-01" room ID, "EX-01" exit, "RS-01" restroom, "ST-01" stair, "FE-01" fire extinguisher, "FA-01" fire alarm, "FD-01" fire door, "EV-01" evacuation, "NS-01" no smoking, "EL-01" electrical, "HM-01" hazmat)
- quantity: 1 per location unless otherwise noted
- location: use only the room identifier exactly as it appears printed on the plan — for example UNIT 2A 406B or ELEC A404. Do not add descriptive phrases, door positions, or narrative text. The location value must match the printed label verbatim so it can be found in the plan's text layer.
- dimensions: standard dimensions per the code rules above
- mounting_type: as specified above for each sign type
- finish_color: null (to be specified by contractor)
- illumination: "Non-Illuminated" for ADA tactile/standard signs; "LED Internally Illuminated" for exit signs; "Photoluminescent" for egress markers
- materials: as specified above
- message_content: exact text the sign displays
- notes: cite the specific code reference (e.g. "NFPA 10 §6.1 Required", "IBC 1013.1 Required", "ADA 703.1 Required"); flag any uncertainty
- page_number: PDF page number where you found this space (use "--- PAGE N ---" markers)
- confidence_score: 0.9 = clearly visible space/location; 0.7 = likely present based on building type; 0.5 = inferred from context; 0.3 = uncertain
- review_flag: true if confidence_score < 0.7

CRITICAL RULES:
- Every identifiable room or space MUST generate at least one sign entry (Room ID at minimum)
- FIRE CODE SIGNS ARE MANDATORY — do not skip fire extinguisher, exit, fire alarm, or fire door signs even if not explicitly labeled in the plans; infer from room types and building use
- Do NOT skip any spaces — custodial closets, utility rooms, IT closets, server rooms all require room ID signs
- Do NOT group multiple locations into one entry — each room/door/stair landing gets its own sign entry
- If a floor plan shows 12 offices, output 12 separate Room ID sign entries (one per room)
- Return ONLY a valid JSON array. No markdown, no code blocks, no explanation.
- If you cannot read the floor plan, return []
- COMPACT JSON: Omit any field whose value is null or empty — do NOT include it in the object. Only include fields that have actual values. Every object must include at minimum: sign_type, location, page_number, confidence_score, review_flag.

LEGEND / SYMBOL KEY EXCLUSION (important):
- Architectural drawings often include a bordered "Life Safety Legend", "Signage Legend", "Symbol Key", or "Drawing Legend" box that defines what each symbol means. This may appear in the corner or margin of a floor plan page.
- IGNORE ALL CONTENT INSIDE THESE LEGEND BOXES. Do not extract sign entries for symbols that are simply being defined in a legend table. These are definitions, not real sign locations.
- Only extract sign entries from actual room labels, space designations, and code requirements applicable to the real spaces shown in the floor plan — not from the legend.

FLOOR PLAN PAGES (with page markers):
${scheduleCtx}${specCtx}${candidatesCtx}${trainingCtx}${verifiedCtx}---
`;
}

// ─── PDF TEXT EXTRACTION ──────────────────────────────────────────────────────

export async function extractTextFromPdf(filePath: string, fileId: string): Promise<{
  pages: ScoredPage[];
  numPages: number;
}> {
  // Return cached result if available (files are immutable once uploaded)
  const cached = pdfTextCache.get(filePath);
  if (cached) {
    logger.debug({ filePath: filePath.split("/").pop() }, "PDF text cache hit");
    return cached;
  }

  try {
    const numPages = await getPdfPageCount(filePath);
    const rawPages = await buildPageTextsFromPhraseCache(filePath, fileId, numPages);

    const basename = filePath.split("/").pop() ?? "";
    const pages = rawPages.map((text, i) => classifyPage(i + 1, text));

    const fpCount = pages.filter((p) => p.type === "floor_plan").length;
    const ssCount = pages.filter((p) => p.type === "sign_schedule").length;
    const bothCount = pages.filter((p) => p.type === "both").length;
    const titleBlockCount = pages.filter((p) => p.titleBlockType !== "unknown").length;

    logger.info(
      {
        filePath: basename,
        totalPages: pages.length,
        floorPlanPages: fpCount,
        signSchedulePages: ssCount,
        bothPages: bothCount,
        otherPages: pages.length - fpCount - ssCount - bothCount,
        titleBlockClassified: titleBlockCount,
      },
      "PDF pages classified"
    );

    const value = { pages, numPages };
    pdfTextCacheSet(filePath, value);
    return value;
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
    // Pages classified as "both" are included in BOTH the sign-schedule pass
    // and the floor-plan pass so their content is fully extracted.
    .filter((p) => p.type === targetType || p.type === "both")
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
    .union([
      z.number(),
      z.string().transform((s) => {
        const n = parseInt(s, 10);
        return isNaN(n) ? null : n;
      }),
      z.null(),
    ])
    .optional()
    .default(null)
    .transform((v) => (v !== null && v !== undefined && typeof v === "number" ? Math.round(v) : (v as number | null))),
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

type GeminiPart = { text: string } | { inlineData: { mimeType: string; data: string } };

export interface GeminiAI {
  models: {
    generateContent: (opts: {
      model: string;
      contents: { role: string; parts: GeminiPart[] }[];
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
  label: string,
  pageNumber?: number
): Promise<GeminiCallResult> {
  const MAX_RETRIES = 4;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const callStart = Date.now();
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
      const durationMs = Date.now() - callStart;
      logger.info({ label, responseLength: text.length, inputTokens, outputTokens }, "Gemini call complete");
      _geminiLoggerStorage.getStore()?.({ prompt, rawResponse: text, inputTokens, outputTokens, durationMs, label, pageNumber });
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

      const durationMs = Date.now() - callStart;
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error({ err, label }, "Gemini call failed");
      _geminiLoggerStorage.getStore()?.({ prompt, rawResponse: "", inputTokens: 0, outputTokens: 0, durationMs, label, pageNumber, error: errMsg });
      throw err;
    }
  }

  throw new Error(`Gemini call exhausted all retries for: ${label}`);
}

// ─── MULTIMODAL GEMINI CALL (IMAGE / PDF) ─────────────────────────────────────

type GeminiInlinePart = { inlineData: { mimeType: string; data: string } };

/**
 * Call Gemini with multimodal content.
 *
 * Overload 1: single PDF base64 string (original behaviour)
 * Overload 2: array of pre-built inline parts (PNG images)
 */
async function callGeminiMultimodal(
  prompt: string,
  pdfOrParts: string | GeminiInlinePart[],
  ai: GeminiAI,
  label: string,
  pageNumber?: number
): Promise<GeminiCallResult> {
  const MAX_RETRIES = 4;

  const dataParts: GeminiInlinePart[] = typeof pdfOrParts === "string"
    ? [{ inlineData: { mimeType: "application/pdf", data: pdfOrParts } }]
    : pdfOrParts;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const callStart = Date.now();
    try {
      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: [
          {
            role: "user",
            parts: [
              ...dataParts,
              { text: prompt },
            ],
          },
        ],
        config: {
          maxOutputTokens: 65536,
          temperature: 0.1,
          thinkingConfig: { thinkingBudget: 0 },
        },
      });

      const text = response.text ?? "";
      const inputTokens = response.usageMetadata?.promptTokenCount ?? 0;
      const outputTokens = response.usageMetadata?.candidatesTokenCount ?? 0;
      const durationMs = Date.now() - callStart;
      logger.info({ label, responseLength: text.length, inputTokens, outputTokens }, "Gemini multimodal call complete");
      _geminiLoggerStorage.getStore()?.({ prompt, rawResponse: text, inputTokens, outputTokens, durationMs, label, pageNumber });
      return { text, inputTokens, outputTokens };
    } catch (err: unknown) {
      const isRateLimit =
        err instanceof Error &&
        (err.message.includes("RATELIMIT_EXCEEDED") ||
          err.message.includes("429") ||
          (err as { status?: number }).status === 429);

      if (isRateLimit && attempt < MAX_RETRIES) {
        const delayMs = Math.min(60000, 8000 * Math.pow(2, attempt));
        logger.warn({ attempt, delayMs, label }, "Gemini rate limit (multimodal) — retrying after delay");
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }

      const durationMs = Date.now() - callStart;
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error({ err, label }, "Gemini multimodal call failed");
      _geminiLoggerStorage.getStore()?.({ prompt, rawResponse: "", inputTokens: 0, outputTokens: 0, durationMs, label, pageNumber, error: errMsg });
      throw err;
    }
  }

  throw new Error(`Gemini multimodal call exhausted all retries for: ${label}`);
}

// ─── IMAGE EXTRACTION PROMPT ──────────────────────────────────────────────────

const IMAGE_EXTRACTION_PROMPT = `You are an expert sign contractor performing a VISUAL CROSS-VERIFICATION sign takeoff from architectural plan documents.

CRITICAL MISSION: This is a second-pass visual scan whose primary purpose is to cross-verify a text-extraction pass that has already run. Your job is to visually CONFIRM signs found by the text pass AND independently find any signs the text pass may have missed. A large architectural floor plan will have dozens to hundreds of sign callouts — returning fewer than 10 results for a multi-room floor plan is almost certainly wrong. Scan aggressively. NOTE: This prompt also applies when the PDF is a signage schedule sheet or a CSI specification section — see the special instructions at the bottom.

You are viewing the actual PDF pages as images. Scan every square inch of each page systematically. Look for:
- Small circled or triangled numbers/letters at room entries and doorways (these are ADA/Room ID callouts)
- Triangular "flag" symbols with a reference code pointing to a wall location
- Diamond, hexagonal, or other shaped callout bubbles with sign type codes
- Leader lines connecting a code to a physical location
- Room name labels next to doors (these often indicate a Room ID sign)
- "EXIT" text or exit sign symbols above doors or at stair entries
- Fire extinguisher, AED, or safety sign symbols
- Wayfinding arrows or directory indicators
- Any alphanumeric code like "RI-101", "S-1", "A", "EX", "1A" placed near a door, room corner, or corridor
- Sign schedule tables listing sign types, quantities, and locations
- Keynote callouts referencing sign types in the keynote legend

EDUCATIONAL FACILITY ROOM NAMES — DO NOT MISS:
In school and educational facility floor plans, any space name near a door represents a Room ID sign location and must be extracted — even uncommon single-word labels that have no room number. Examples include: MUSIC, ART, ART ROOM, PRE-K, STORAGE, LIBRARY, CAFETERIA, GYM, GYMNASIUM, CLASSROOM, SCIENCE LAB, ADMINISTRATION, OFFICE, NURSE, COUNSELOR, MEDIA CENTER, COMPUTER LAB, TECHNOLOGY, AUDITORIUM, and similar. These single-word labels are complete, valid room identifiers and must not be skipped because they lack a numeric suffix.

IMPORTANT — DO NOT MISS SMALL CALLOUTS:
ADA floor plans often have very small (6–8pt font) circular or triangular callout symbols scattered throughout the floor plan. These are easy to overlook. Zoom in mentally on every doorway and room entry. Every room with a door almost certainly has a Room ID sign callout.

For each sign callout you visually identify, extract these fields (use null if not visible):

- sheet_number: Plan sheet number from title block (e.g. "A-101", "S-1")
- detail_reference: The callout code visible in the bubble or triangle (e.g. "1", "A", "RI-01", "EX")
- sign_type: Type of sign (e.g. "Room ID", "Exit", "ADA Restroom", "Wayfinding", "Fire Extinguisher", "Stairwell")
- sign_identifier: The unique sign code if visible (e.g. "S-01", "EX-1", "TYPE A"). Use detail_reference if no separate identifier.
- quantity: Integer count of this sign at this location. Default 1.
- location: Room name, space name, or positional description visible near the callout (e.g. "Room 101 - Storage", "Main Lobby", "North Exit", "MUSIC", "CAFETERIA", "PRE-K")
- dimensions: Physical size if shown in legend or schedule (e.g. '6" x 8"')
- mounting_type: How it is mounted if visible (e.g. "Wall Mounted", "Post Mounted", "Overhead")
- finish_color: Finish or color if visible
- illumination: Lighting type if specified
- materials: Materials if specified
- message_content: The text message of the sign if visible (e.g. "EXIT", "RESTROOMS", "STAIR A")
- notes: Any special notes in callouts or legends
- page_number: 1-indexed page number where you see this callout
- x_position: Normalized horizontal position 0.0–1.0 of the callout bubble/symbol on its page
- y_position: Normalized vertical position 0.0–1.0 of the callout bubble/symbol on its page
- confidence_score: 0.9 = clearly visible; 0.75 = small but readable; 0.6 = partially obscured or inferred; 0.5 = best guess
- review_flag: true if confidence_score < 0.75

READ NUMBERS WITH EXTREME CARE:
- Room numbers and reference codes are highly precise. "SHOP 113" ≠ "SHOP 118". "RI-105" ≠ "RI-106".
- Zoom in mentally on each digit. Visually similar: 1 vs I vs l, 3 vs 8, 0 vs 6 vs 8, 5 vs 6, 7 vs 1.
- If you cannot confidently read a digit, set confidence_score ≤ 0.6, review_flag = true, and record what you can see.

MARKER PLACEMENT:
- x_position / y_position must point to the callout bubble or triangle symbol, NOT the room centroid or room name.
- For a leader-line callout, place the coordinate at the arrowhead or bubble end.

LEGEND EXCLUSION — READ CAREFULLY:
- Architectural plans have a legend/symbol key box (usually in a corner) listing what each symbol means. These entries are DEFINITIONS, not actual sign locations. DO NOT extract them.
- Only extract callouts that are placed at a real physical location on the floor plan (attached to a room, corridor, or door via a leader line or proximity).
- Exception: sign SCHEDULE tables (rows listing sign IDs with quantities and locations) ARE valid — extract every row.

MULTI-COLUMN SIGNAGE SCHEDULE SHEETS:
If the page is a wide drawing sheet with parallel floor-level columns (e.g. ${CANONICAL_LEVEL_NAMES.map((n) => `"Signage Schedule - ${n.replace(/\b\w/g, (c) => c.toUpperCase())}"`).join(", ")} side by side), read each column independently:
- Room section headings (larger/bolder text with a room number and name, e.g. "101 PORCH", "201 STAIR / ELEVATOR LOBBY") define the location for all sign rows beneath them in that column until the next room heading.
- Sign rows follow the pattern: [Type Code] [Qty] [Signage Text] [Glass Backer Yes/No] [Comment codes].
- Use the room number and name exactly as they appear in the heading (e.g. "101 PORCH", "201 STAIR / ELEVATOR LOBBY"). Do not add floor level or other descriptive text to the location field.
- A "TYPICAL SIGN TYPES" diagram on the right shows dimension callouts (e.g. "6 1/2\"", "8 1/4\"", "11\"") per type code — read these and populate the dimensions field for matching type codes.
- "Glass Backer: Yes" → add "glass backer" to materials. Comment codes (A, B, G) → add to notes.
- Set x_position and y_position to null for schedule rows.

CSI SPECIFICATION SECTION PAGES:
If the page is a CSI-format spec section defining sign types (e.g. "Section 10 14 00 SIGNAGE", "PART 1 — GENERAL" with sign type definitions like "Types 1A and 1B Interior Room Signage"):
- sign_identifier = type code (e.g. "1A", "2A", "3A"). sign_type = category name. materials = substrate (Photopolymer, Aluminum). mounting_type = AFF rule. notes = compliance (AAB-compliant, ADA, CMR code).
- Set location = null, quantity = 1, x_position = null, y_position = null, confidence_score = 0.7, review_flag = true.
- Skip administrative content (submittals, warranty, quality assurance, delivery).

PRECISION RULE: Quality matters far more than quantity. Only report sign callouts you can actually see and confidently identify in the image. A page with few or no actual sign callouts is perfectly valid — do not invent or infer entries. Set confidence_score ≥ 0.70 for all reported items; if you cannot reach 0.70 confidence, omit that entry entirely. Hallucinated or guessed entries cause serious harm to the workflow.

Return ONLY a valid JSON array. No markdown fences, no explanation, no commentary.`;

const VISUAL_FALLBACK_EXTRACTION_PROMPT = `You are an expert sign contractor performing a FIRST-PASS visual sign takeoff from an architectural PDF document that contains little or no machine-readable text (it is likely a scanned or image-based file).

CRITICAL MISSION: This is the PRIMARY and ONLY extraction pass for this document. No text extraction has run. Your job is to scan every page of this PDF visually and find ALL sign callouts, sign schedules, and code-required signage indicators. A large architectural floor plan will have dozens to hundreds of sign callouts — returning fewer than 10 results for a multi-room floor plan is almost certainly wrong. Scan aggressively.

You are viewing the actual PDF pages as images. Scan every square inch of each page systematically. Look for:
- Small circled or triangled numbers/letters at room entries and doorways (these are ADA/Room ID callouts)
- Triangular "flag" symbols with a reference code pointing to a wall location
- Diamond, hexagonal, or other shaped callout bubbles with sign type codes
- Leader lines connecting a code to a physical location
- Room name labels next to doors (these often indicate a Room ID sign)
- "EXIT" text or exit sign symbols above doors or at stair entries
- Fire extinguisher, AED, or safety sign symbols
- Wayfinding arrows or directory indicators
- Any alphanumeric code like "RI-101", "S-1", "A", "EX", "1A" placed near a door, room corner, or corridor
- Sign schedule tables listing sign types, quantities, and locations
- Keynote callouts referencing sign types in the keynote legend

EDUCATIONAL FACILITY ROOM NAMES — DO NOT MISS:
In school and educational facility floor plans, any space name near a door represents a Room ID sign location and must be extracted — even uncommon single-word labels that have no room number. Examples include: MUSIC, ART, ART ROOM, PRE-K, STORAGE, LIBRARY, CAFETERIA, GYM, GYMNASIUM, CLASSROOM, SCIENCE LAB, ADMINISTRATION, OFFICE, NURSE, COUNSELOR, MEDIA CENTER, COMPUTER LAB, TECHNOLOGY, AUDITORIUM, and similar. These single-word labels are complete, valid room identifiers and must not be skipped because they lack a numeric suffix.

IMPORTANT — DO NOT MISS SMALL CALLOUTS:
ADA floor plans often have very small (6–8pt font) circular or triangular callout symbols scattered throughout the floor plan. These are easy to overlook. Zoom in mentally on every doorway and room entry. Every room with a door almost certainly has a Room ID sign callout.

For each sign callout you visually identify, extract these fields (use null if not visible):

- sheet_number: Plan sheet number from title block (e.g. "A-101", "S-1")
- detail_reference: The callout code visible in the bubble or triangle (e.g. "1", "A", "RI-01", "EX")
- sign_type: Type of sign (e.g. "Room ID", "Exit", "ADA Restroom", "Wayfinding", "Fire Extinguisher", "Stairwell")
- sign_identifier: The unique sign code if visible (e.g. "S-01", "EX-1", "TYPE A"). Use detail_reference if no separate identifier.
- quantity: Integer count of this sign at this location. Default 1.
- location: Room name, space name, or positional description visible near the callout (e.g. "Room 101 - Storage", "Main Lobby", "North Exit", "MUSIC", "CAFETERIA", "PRE-K")
- dimensions: Physical size if shown in legend or schedule (e.g. '6" x 8"')
- mounting_type: How it is mounted if visible (e.g. "Wall Mounted", "Post Mounted", "Overhead")
- finish_color: Finish or color if visible
- illumination: Lighting type if specified
- materials: Materials if specified
- message_content: The text message of the sign if visible (e.g. "EXIT", "RESTROOMS", "STAIR A")
- notes: Any special notes in callouts or legends
- page_number: 1-indexed page number where you see this callout
- x_position: Normalized horizontal position 0.0–1.0 of the callout bubble/symbol on its page
- y_position: Normalized vertical position 0.0–1.0 of the callout bubble/symbol on its page
- confidence_score: 0.9 = clearly visible; 0.75 = small but readable; 0.6 = partially obscured or inferred; 0.5 = best guess
- review_flag: true if confidence_score < 0.75

READ NUMBERS WITH EXTREME CARE:
- Room numbers and reference codes are highly precise. "SHOP 113" ≠ "SHOP 118". "RI-105" ≠ "RI-106".
- Zoom in mentally on each digit. Visually similar: 1 vs I vs l, 3 vs 8, 0 vs 6 vs 8, 5 vs 6, 7 vs 1.
- If you cannot confidently read a digit, set confidence_score ≤ 0.6, review_flag = true, and record what you can see.

MARKER PLACEMENT:
- x_position / y_position must point to the callout bubble or triangle symbol, NOT the room centroid or room name.
- For a leader-line callout, place the coordinate at the arrowhead or bubble end.

LEGEND EXCLUSION — READ CAREFULLY:
- Architectural plans have a legend/symbol key box (usually in a corner) listing what each symbol means. These entries are DEFINITIONS, not actual sign locations. DO NOT extract them.
- Only extract callouts that are placed at a real physical location on the floor plan (attached to a room, corridor, or door via a leader line or proximity).
- Exception: sign SCHEDULE tables (rows listing sign IDs with quantities and locations) ARE valid — extract every row.

PRECISION RULE: Quality matters far more than quantity. Only report sign callouts you can actually see and confidently identify in the image. A page with few or no actual sign callouts is perfectly valid — do not invent or infer entries. Set confidence_score ≥ 0.70 for all reported items; if you cannot reach 0.70 confidence, omit that entry entirely. Hallucinated or guessed entries cause serious harm to the workflow.

Return ONLY a valid JSON array. No markdown fences, no explanation, no commentary.`;

const ImageSignRowSchema = z.object({
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
    .union([z.number(), z.string().transform((s) => { const n = parseInt(s, 10); return isNaN(n) ? null : n; }), z.null()])
    .optional()
    .default(null)
    .transform((v) => (v !== null && v !== undefined && typeof v === "number" ? Math.round(v) : (v as number | null))),
  // Accept 0-1 (normalized) OR 0-100 (percentage) — normalize either to 0-1.
  // Clamp to [0, 1] so pixel-coord outliers don't break validation.
  x_position: z
    .number()
    .nullable()
    .optional()
    .default(null)
    .transform((v) => (v === null || v === undefined ? null : v > 1 && v <= 100 ? v / 100 : Math.min(1, Math.max(0, v)))),
  y_position: z
    .number()
    .nullable()
    .optional()
    .default(null)
    .transform((v) => (v === null || v === undefined ? null : v > 1 && v <= 100 ? v / 100 : Math.min(1, Math.max(0, v)))),
  confidence_score: z.number().min(0).max(1).optional(),
  review_flag: z.boolean().optional(),
});

const ImageResponseSchema = z.array(ImageSignRowSchema);

function parseImageExtractionResponse(raw: string, source: string): ExtractedSignRow[] {
  let text = raw.trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```[a-z]*\n?/i, "").replace(/\n?```[\s\S]*$/, "").trim();
  }

  const arrayStart = text.indexOf("[");
  const arrayEnd = text.lastIndexOf("]");

  if (arrayStart === -1) {
    logger.info({ source, responsePreview: text.slice(0, 200) }, "Image extraction: no JSON array returned");
    return [];
  }

  let parsed: unknown = null;
  if (arrayEnd !== -1 && arrayEnd > arrayStart) {
    try {
      parsed = JSON.parse(text.slice(arrayStart, arrayEnd + 1));
    } catch {
      parsed = repairTruncatedJson(text);
    }
  }

  if (parsed === null) {
    parsed = repairTruncatedJson(text);
  }

  if (parsed === null) {
    logger.warn({ source }, "Image extraction: JSON parse failed");
    return [];
  }

  const result = ImageResponseSchema.safeParse(parsed);
  if (!result.success) {
    logger.warn({ issues: result.error.issues, source }, "Image extraction response schema validation failed");
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
      x_pos: item.x_position ?? null,
      y_pos: item.y_position ?? null,
      confidence_score: score,
      review_flag: item.review_flag ?? computeReviewFlag(item as unknown as Record<string, unknown>, score),
    };
  });
}

// Max PDF size for a single inline base64 Gemini call (Gemini Flash limit)
const MAX_INLINE_PDF_BYTES = 19 * 1024 * 1024; // 19 MB — leaves headroom for base64 overhead
// Max pages per image-extraction batch (keeps each batch under 20 MB for most plans)
const IMAGE_BATCH_PAGES = 25;
// Max pages per bbox-scan batch — kept small so the JSON response stays under the
// 65536 output-token cap; a 4-page batch already hits the limit for dense plans.
const SCAN_BATCH_PAGES = 2;

// ─── VERIFICATION-MODE VISUAL PASS ────────────────────────────────────────────
// Instead of asking Gemini to independently discover all signs (hallucination-
// prone), we give it the text-pass results and ask:
//   TASK 1 — Verify: Can you see each of these signs in the image?
//   TASK 2 — Discover: Any high-confidence signs clearly not in the list?

export interface TextContextSign {
  sign_identifier: string | null;
  location: string | null;
  sign_type: string | null;
  sheet_number: string | null;
  page_number: number | null;
}

export interface VerificationItem {
  sign_identifier: string | null;
  location: string | null;
  page_number: number | null;
  status: "CONFIRMED" | "UNCERTAIN" | "NOT_FOUND";
  confidence: number;
}

export interface VerifyResult {
  verifications: VerificationItem[];
  discoveries: ExtractedSignRow[];
  inputTokens: number;
  outputTokens: number;
  skipped: boolean;
  skipReason?: string;
}

const VerificationItemSchema = z.object({
  sign_identifier: z.string().nullable().optional().default(null),
  location: z.string().nullable().optional().default(null),
  page_number: z
    .union([z.number(), z.string().transform((s) => { const n = parseInt(s, 10); return isNaN(n) ? null : n; }), z.null()])
    .optional()
    .default(null),
  status: z.enum(["CONFIRMED", "UNCERTAIN", "NOT_FOUND"]).default("UNCERTAIN"),
  confidence: z.number().min(0).max(1).optional().default(0.7),
});

const DiscoveryItemSchema = z.object({
  sheet_number: z.string().nullable().optional().default(null),
  sign_identifier: z.string().nullable().optional().default(null),
  sign_type: z.string().nullable().optional().default(null),
  location: z.string().nullable().optional().default(null),
  detail_reference: z.string().nullable().optional().default(null),
  message_content: z.string().nullable().optional().default(null),
  page_number: z
    .union([z.number(), z.string().transform((s) => { const n = parseInt(s, 10); return isNaN(n) ? null : n; }), z.null()])
    .optional()
    .default(null),
  confidence: z.number().min(0).max(1).optional().default(0.8),
});

const VerificationResponseSchema = z.object({
  verifications: z.array(VerificationItemSchema).default([]),
  discoveries: z.array(DiscoveryItemSchema).default([]),
});

// ── Gemini bbox scan (pure visual, no text-sign list) ──────────────────────

export interface GeminiCallout {
  page_number: number;
  bbox_x: number;
  bbox_y: number;
  bbox_w: number;
  bbox_h: number;
  label_text: string | null;
  sign_type: string | null;
  confidence: number;
}

export interface ScanResult {
  callouts: GeminiCallout[];
  inputTokens: number;
  outputTokens: number;
  skipped: boolean;
  skipReason?: string;
}

function buildScanPrompt(): string {
  return `You are scanning architectural floor plans to locate sign callouts.

Find EVERY sign callout visible in this floor plan image.
A "sign callout" is any symbol, tag, bubble, circle, dot, diamond, or annotation with a
letter/number code or label that marks where a specific sign will be installed.

Do NOT include:
- Room name labels that are just printed in the center of a room with no callout symbol
- Dimension strings, structural tags, door swing marks, or revision clouds
- Anything inside a legend box, symbol key, or drawing notes panel

COORDINATE SYSTEM:
  x, y, w, h are fractions 0.0–1.0 of the page image dimensions (origin = top-left).
  x increases rightward, y increases downward.

SIGN TYPE ENUM — use ONLY these exact strings:
  Room ID | Exit | Accessibility | Restroom | Stair | Elevator | Fire Safety | Wayfinding | Other

For each callout you can clearly see (confidence ≥ 0.75):
  Return its bounding box (tight around the callout symbol + label), any text you can read,
  the sign type from the enum above, and your confidence.

Return ONLY valid JSON — no markdown fences, no extra text:
{
  "callouts": [
    {
      "page_number": 1,
      "bbox_x": 0.42,
      "bbox_y": 0.31,
      "bbox_w": 0.05,
      "bbox_h": 0.03,
      "label_text": "101",
      "sign_type": "Room ID",
      "confidence": 0.90
    }
  ]
}

If no sign callouts are visible, return: {"callouts": []}`;
}

const GEMINI_SIGN_TYPE_ENUM = z.enum([
  "Room ID", "Exit", "Accessibility", "Restroom", "Stair", "Elevator",
  "Fire Safety", "Wayfinding", "Other",
]);

const GeminiCalloutSchema = z.object({
  page_number: z
    .union([z.number(), z.string().transform((s) => { const n = parseInt(s, 10); return isNaN(n) ? 1 : n; })])
    .default(1),
  bbox_x: z.number().min(0).max(1).default(0),
  bbox_y: z.number().min(0).max(1).default(0),
  bbox_w: z.number().min(0).max(1).default(0),
  bbox_h: z.number().min(0).max(1).default(0),
  label_text: z.string().nullable().optional().default(null),
  sign_type: GEMINI_SIGN_TYPE_ENUM.nullable().optional().default(null).catch(null),
  confidence: z.number().min(0).max(1).default(0.75),
});

const ScanResponseSchema = z.object({
  callouts: z.array(GeminiCalloutSchema).default([]),
});

/**
 * Recover individual callout objects from a truncated JSON string.
 * Used when Gemini hits the output token limit mid-response.
 */
function extractPartialCallouts(text: string, label: string): GeminiCallout[] {
  const results: GeminiCallout[] = [];
  let searchFrom = 0;
  while (true) {
    const start = text.indexOf("{", searchFrom);
    if (start === -1) break;
    let depth = 0;
    let end = -1;
    for (let i = start; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end === -1) break; // Incomplete object — stop
    try {
      const obj = JSON.parse(text.slice(start, end + 1));
      const r = GeminiCalloutSchema.safeParse(obj);
      if (r.success && r.data.confidence >= 0.75) {
        results.push({ page_number: r.data.page_number as number, bbox_x: r.data.bbox_x, bbox_y: r.data.bbox_y, bbox_w: r.data.bbox_w, bbox_h: r.data.bbox_h, label_text: r.data.label_text ?? null, sign_type: r.data.sign_type ?? null, confidence: r.data.confidence });
      }
    } catch { /* skip malformed */ }
    searchFrom = end + 1;
  }
  if (results.length > 0) {
    logger.info({ label, callouts: results.length }, "Partial scan recovery: extracted callouts from truncated response");
  } else {
    logger.error({ label }, "Partial scan recovery: no complete callout objects found in truncated response");
  }
  return results;
}

function parseScanResponse(raw: string, label: string): GeminiCallout[] {
  let cleaned = raw.trim();
  // Handle both closed and unclosed code fences (unclosed = truncated by token limit)
  const fenceMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)(?:```|$)/);
  if (fenceMatch) cleaned = fenceMatch[1]!.trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Try extracting a complete JSON object (handles minor trailing garbage)
    const objMatch = cleaned.match(/\{[\s\S]*\}/);
    if (objMatch) {
      try {
        parsed = JSON.parse(objMatch[0]);
      } catch {
        // Response was truncated mid-JSON — recover whatever complete objects exist
        logger.warn({ label }, "Scan response truncated — attempting partial callout recovery");
        return extractPartialCallouts(cleaned, label);
      }
    } else {
      logger.error({ label }, "Could not extract JSON from scan response");
      return [];
    }
  }

  const result = ScanResponseSchema.safeParse(parsed);
  if (!result.success) {
    logger.warn({ label, errors: result.error.flatten() }, "Scan schema validation failed");
    return [];
  }

  const callouts: GeminiCallout[] = result.data.callouts
    .filter((c) => c.confidence >= 0.75)
    .map((c) => ({
      page_number: c.page_number as number,
      bbox_x: c.bbox_x,
      bbox_y: c.bbox_y,
      bbox_w: c.bbox_w,
      bbox_h: c.bbox_h,
      label_text: c.label_text ?? null,
      sign_type: c.sign_type ?? null,
      confidence: c.confidence,
    }));

  logger.info({ label, callouts: callouts.length }, "Scan response parsed");
  return callouts;
}

/**
 * Pure visual scan: sends page PNGs to Gemini and returns bounding boxes
 * for every sign callout visible on the page. No text sign list is sent.
 */
export async function extractSignCalloutsPng(
  fileName: string,
  ai: GeminiAI,
  pageImagePaths: Record<string, string>,
  relevantPages: Set<number>
): Promise<ScanResult> {
  if (relevantPages.size === 0) {
    return { callouts: [], inputTokens: 0, outputTokens: 0, skipped: true, skipReason: "No relevant pages" };
  }

  const relevantSorted = Array.from(relevantPages).sort((a, b) => a - b);
  const allCovered = relevantSorted.every((p) => pageImagePaths[String(p)]);
  if (!allCovered) {
    const missing = relevantSorted.filter((p) => !pageImagePaths[String(p)]);
    logger.warn({ fileName, missing }, "Bbox scan: missing PNG for some pages — scanning only available pages");
  }

  const availablePages = relevantSorted.filter((p) => pageImagePaths[String(p)]);
  if (availablePages.length === 0) {
    return { callouts: [], inputTokens: 0, outputTokens: 0, skipped: true, skipReason: "No PNG images available for relevant pages" };
  }

  const prompt = buildScanPrompt();
  const allCallouts: GeminiCallout[] = [];
  let totalIn = 0;
  let totalOut = 0;

  for (let batchStart = 0; batchStart < availablePages.length; batchStart += SCAN_BATCH_PAGES) {
    const batchPages = availablePages.slice(batchStart, batchStart + SCAN_BATCH_PAGES);
    const inlineParts: GeminiInlinePart[] = [];

    for (const pageNum of batchPages) {
      try {
        const buf = await fs.readFile(pageImagePaths[String(pageNum)]!);
        inlineParts.push({ inlineData: { mimeType: "image/png", data: buf.toString("base64") } });
      } catch (err) {
        logger.warn({ err, pageNum }, "Bbox scan: could not read page PNG — skipping page in batch");
      }
    }

    if (inlineParts.length === 0) continue;

    const firstPage = batchPages[0]!;
    const lastPage = batchPages[batchPages.length - 1]!;
    const label = `scan-${fileName}-p${firstPage}-${lastPage}-png`;

    try {
      const { text, inputTokens, outputTokens } = await callGeminiMultimodal(prompt, inlineParts, ai, label, firstPage);
      const batchCallouts = parseScanResponse(text, label);

      // When multiple pages are batched, Gemini sees them as page 1, 2, 3... in the batch.
      // Remap page_number from batch-relative (1-based) to original page number.
      for (const callout of batchCallouts) {
        const batchIdx = callout.page_number - 1; // 0-based index within this batch
        const originalPage = batchPages[batchIdx] ?? batchPages[0]!;
        allCallouts.push({ ...callout, page_number: originalPage });
      }

      totalIn += inputTokens;
      totalOut += outputTokens;
    } catch (err) {
      logger.warn({ err, label }, "Bbox scan batch call failed — skipping batch");
    }
  }

  logger.info({ fileName, callouts: allCallouts.length, inputTokens: totalIn, outputTokens: totalOut }, "Bbox scan complete");
  return { callouts: allCallouts, inputTokens: totalIn, outputTokens: totalOut, skipped: false };
}


export async function extractSignsFromPdfImage(
  filePath: string,
  ai: GeminiAI
): Promise<{ rows: ExtractedSignRow[]; inputTokens: number; outputTokens: number; skipped: boolean; skipReason?: string }> {
  let fileBuffer: Buffer;
  try {
    fileBuffer = await fs.readFile(filePath);
  } catch (err) {
    logger.error({ err, filePath }, "Image extraction: could not read PDF file");
    return { rows: [], inputTokens: 0, outputTokens: 0, skipped: true, skipReason: "Could not read PDF file" };
  }

  const fileName = filePath.split("/").pop() ?? "file.pdf";

  // If PDF fits in a single call, send it directly (fast path)
  if (fileBuffer.length <= MAX_INLINE_PDF_BYTES) {
    const pdfBase64 = fileBuffer.toString("base64");
    const label = `image-${fileName}`;
    logger.info({ fileName, sizeBytes: fileBuffer.length }, "Image extraction: single-pass");
    try {
      const { text, inputTokens, outputTokens } = await callGeminiMultimodal(IMAGE_EXTRACTION_PROMPT, pdfBase64, ai, label);
      const rows = parseImageExtractionResponse(text, label);
      logger.info({ rows: rows.length, inputTokens, outputTokens }, "Image extraction complete (single-pass)");
      return { rows, inputTokens, outputTokens, skipped: false };
    } catch (err) {
      logger.error({ err, fileName }, "Image extraction call failed");
      return { rows: [], inputTokens: 0, outputTokens: 0, skipped: true, skipReason: "Gemini call failed" };
    }
  }

  // Large PDF: split into page batches using pdf-lib, process each batch separately.
  logger.info({ fileName, sizeBytes: fileBuffer.length }, "Image extraction: PDF too large for single pass — splitting into page batches");
  let { PDFDocument } = await import("pdf-lib");
  let srcDoc: import("pdf-lib").PDFDocument;
  try {
    srcDoc = await PDFDocument.load(fileBuffer, { ignoreEncryption: true });
  } catch (err) {
    logger.error({ err, fileName }, "Image extraction: pdf-lib failed to load PDF");
    return { rows: [], inputTokens: 0, outputTokens: 0, skipped: true, skipReason: "PDF could not be parsed for image extraction" };
  }

  const totalPages = srcDoc.getPageCount();
  const allRows: ExtractedSignRow[] = [];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let batchCount = 0;

  for (let startPage = 0; startPage < totalPages; startPage += IMAGE_BATCH_PAGES) {
    const endPage = Math.min(startPage + IMAGE_BATCH_PAGES, totalPages);
    const pageIndices = Array.from({ length: endPage - startPage }, (_, i) => startPage + i);
    batchCount++;
    const label = `image-${fileName}-batch${batchCount}`;

    let batchPdfBytes: Uint8Array;
    try {
      const batchDoc = await PDFDocument.create();
      const copiedPages = await batchDoc.copyPages(srcDoc, pageIndices);
      for (const page of copiedPages) batchDoc.addPage(page);
      batchPdfBytes = await batchDoc.save();
    } catch (err) {
      logger.warn({ err, label, startPage, endPage }, "Image extraction: failed to create batch PDF — skipping batch");
      continue;
    }

    if (batchPdfBytes.length > MAX_INLINE_PDF_BYTES) {
      logger.warn({ label, batchSizeBytes: batchPdfBytes.length }, "Image extraction: batch still >19 MB after splitting — skipping batch");
      continue;
    }

    const pdfBase64 = Buffer.from(batchPdfBytes).toString("base64");
    logger.info({ label, pages: `${startPage + 1}-${endPage}`, batchSizeBytes: batchPdfBytes.length }, "Image extraction: processing batch");

    try {
      const { text, inputTokens, outputTokens } = await callGeminiMultimodal(IMAGE_EXTRACTION_PROMPT, pdfBase64, ai, label);
      const batchRows = parseImageExtractionResponse(text, label);
      // Adjust page_number to be relative to the full document (not the batch)
      for (const row of batchRows) {
        if (row.page_number != null) row.page_number = row.page_number + startPage;
      }
      allRows.push(...batchRows);
      totalInputTokens += inputTokens;
      totalOutputTokens += outputTokens;
      logger.info({ label, rows: batchRows.length, inputTokens, outputTokens }, "Image extraction batch complete");
    } catch (err) {
      logger.error({ err, label }, "Image extraction batch call failed — continuing with next batch");
    }
  }

  logger.info({ fileName, totalRows: allRows.length, batchCount, totalInputTokens, totalOutputTokens }, "Image extraction complete (batched)");
  return { rows: allRows, inputTokens: totalInputTokens, outputTokens: totalOutputTokens, skipped: false };
}

// ─── PROJECT INFO EXTRACTION ──────────────────────────────────────────────────

export async function extractProjectInfo(
  filePath: string,
  fileId: string,
  ai: GeminiAI
): Promise<{ info: ProjectInfo; inputTokens: number; outputTokens: number }> {
  const { pages } = await extractTextFromPdf(filePath, fileId);

  if (pages.length === 0) {
    return { info: { project_name: null, address: null, city: null, state: null, zip: null, occupancy_type: null, ahj: null }, inputTokens: 0, outputTokens: 0 };
  }

  // Use first 10 pages + any page with high keyword density for title block search
  const candidatePages = pages
    .slice(0, 10)
    .map((p) => `--- PAGE ${p.pageNum} ---\n${p.text.slice(0, 3000)}`);

  const block = candidatePages.join("\n\n");

  try {
    const { text, inputTokens, outputTokens } = await callGemini(
      PROJECT_INFO_PROMPT + block,
      ai,
      "project-info"
    );

    let cleaned = text.trim();
    if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```[a-z]*\n?/i, "").replace(/\n?```[\s\S]*$/, "").trim();
    }
    const objStart = cleaned.indexOf("{");
    const objEnd = cleaned.lastIndexOf("}");
    if (objStart !== -1 && objEnd !== -1) {
      try {
        const raw = JSON.parse(cleaned.slice(objStart, objEnd + 1));
        const result = ProjectInfoSchema.safeParse(raw);
        if (result.success) {
          logger.info({ info: result.data }, "Project info extracted");
          return {
            info: {
              project_name: result.data.project_name ?? null,
              address: result.data.address ?? null,
              city: result.data.city ?? null,
              state: result.data.state ?? null,
              zip: result.data.zip ?? null,
              occupancy_type: result.data.occupancy_type ?? null,
              ahj: result.data.ahj ?? null,
            },
            inputTokens,
            outputTokens,
          };
        }
      } catch {
        logger.warn({ text: cleaned.slice(0, 200) }, "Project info JSON parse failed");
      }
    }
  } catch (err) {
    logger.error({ err }, "extractProjectInfo call failed — continuing without project context");
  }

  return { info: { project_name: null, address: null, city: null, state: null, zip: null, occupancy_type: null, ahj: null }, inputTokens: 0, outputTokens: 0 };
}

// ─── SPEC FILE HELPERS ────────────────────────────────────────────────────────

/**
 * Formats raw spec PDF text into a context block that can be injected into
 * schedule / floor-plan prompts so Gemini knows the project's sign type
 * definitions (materials, mounting rules, compliance notes) before it reads
 * the actual data sheets.
 */
export function buildSpecContextString(rawText: string): string {
  if (!rawText || rawText.trim().length < 50) return "";
  const truncated = rawText.slice(0, 18000);
  return (
    "\n\nPROJECT SIGN TYPE CATALOG FROM SPECIFICATION:\n" +
    "The following sign type definitions come from the project's CSI Specification Section (SIGNAGE).\n" +
    "When you encounter sign type codes (e.g. 1A, 2A, 2D, 3A, 4A, 5B, 9A …) referenced in the\n" +
    "schedule or visible on floor plans, use these definitions to populate the materials,\n" +
    "mounting_type, and notes fields for those entries.  Do NOT generate separate rows for each\n" +
    "spec type definition — the definitions are context only.\n" +
    "---\n" +
    truncated +
    "\n---\n"
  );
}

// ─── MAIN EXPORT ──────────────────────────────────────────────────────────────

export interface PageStats {
  floorPlanPages: number[];
  signSchedulePages: number[];
  bothPages?: number[];
  otherPages: number[];
  titleBlockClassifiedPages?: number[];
  pageLabels?: (string | null)[];
  outlineSections?: PdfOutlineSection[];
  /** Normalized level name (e.g. "lower level", "main level") keyed by 1-based page number. */
  floorPageLevels?: Record<number, string>;
}

export async function extractSignsFromPdf(
  filePath: string,
  fileId: string,
  ai: GeminiAI,
  projectContext?: ProjectInfo,
  verifiedSigns?: VerifiedSignSummary[],
  trainingContext?: VerifiedSignSummary[],
  specTypeContext?: string,
  spatialPageTypes?: Map<number, import("./pdf-words").SpatialPageType>
): Promise<{ rows: ExtractedSignRow[]; rawTextRows: ExtractedSignRow[]; pageCount: number; rawText: string; inputTokens: number; outputTokens: number; pageStats: PageStats }> {
  const { pages: rawPages, numPages } = await extractTextFromPdf(filePath, fileId);

  // Fetch PDF metadata (outline sections + page labels).
  // This is supplementary — failures must never abort extraction.
  //
  // When the PDF has no bookmarks, a lightweight Gemini fallback is provided:
  // it receives the first ~3 lines of text from each page and returns the page
  // numbers that appear to be signage-related (sign schedule, sign plan, sign
  // details).  The fallback is only invoked when no outline exists.
  const NO_BOOKMARK_FALLBACK_PROMPT = `You are reviewing page titles from a PDF document.
For each page listed below, determine if it is a signage-related page — this includes sign schedules, sign plans, sign details, signage criteria, sign programs, or any page primarily about architectural signage.

Return ONLY a JSON array of page numbers (integers) that are signage-related. Do not include any explanation.
Example: [3, 7, 12]
If none are signage-related, return: []

Pages:
`;

  async function noBookmarkGeminiFallback(
    pageTexts: Array<{ pageNum: number; text: string }>
  ): Promise<number[]> {
    const pageList = pageTexts
      .map((p) => `Page ${p.pageNum}: ${p.text}`)
      .join("\n");
    const prompt = NO_BOOKMARK_FALLBACK_PROMPT + pageList;
    const { text } = await callGemini(prompt, ai, "no-bookmark-fallback");
    const cleaned = text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((n): n is number => typeof n === "number" && Number.isFinite(n));
  }

  let pdfMeta: Awaited<ReturnType<typeof extractPdfMetadata>> = { pageLabels: [], outlineSections: [] };
  try {
    pdfMeta = await extractPdfMetadata(filePath, noBookmarkGeminiFallback);
    if (pdfMeta.outlineSections.length > 0 || pdfMeta.pageLabels.length > 0) {
      logger.info(
        {
          filePath: filePath.split("/").pop(),
          sections: pdfMeta.outlineSections.length,
          hasPageLabels: pdfMeta.pageLabels.length > 0,
        },
        "PDF metadata extracted"
      );
    }
  } catch (err) {
    logger.warn({ err, filePath }, "PDF metadata extraction failed (non-fatal)");
  }

  // Apply spatial page type overrides when provided.
  // The spatial classifier reads the bottom-right title block quadrant of each
  // page and is the highest-priority signal for floor_plan / sign_schedule /
  // both classification.  "unknown" from spatial means the page is hard-excluded:
  // it is forced to "other" and never eligible for heuristic re-promotion or
  // outline-section boosts.
  //
  // After spatial overrides, outline-section boosts are applied as a lower-priority
  // signal: if a page is still classified as "other" but falls within an outline
  // section identified as a floor plan or sign schedule, its type is promoted.
  // This boost is explicitly suppressed for spatially-unknown pages.
  const pages: typeof rawPages = rawPages.map((p) => {
    let type = p.type;

    // 1. Spatial override (highest priority)
    const spatialType = spatialPageTypes?.get(p.pageNum);
    if (spatialPageTypes && spatialPageTypes.size > 0) {
      if (spatialType === "unknown") {
        // Hard-exclude: spatial pre-pass explicitly classified this page as unknown.
        // Force to "other" so it is excluded from all sign-schedule and floor-plan
        // Gemini extraction passes — no heuristic or outline fallback applies.
        type = "other";
        logger.debug({ pageNum: p.pageNum }, "Spatial hard-exclude: unknown page forced to other");
      } else if (spatialType) {
        logger.debug(
          { pageNum: p.pageNum, spatial: spatialType, heuristic: p.type },
          "Spatial override applied"
        );
        type = spatialType as PageType;
      }
    }

    // 2. Outline-section override (lower priority than spatial, higher than heuristic)
    // When a page falls within a classified outline section (floor_plan or sign_schedule)
    // the section title is high-confidence metadata — override the heuristic type
    // regardless of what the heuristic said (not just "other" pages).
    // Exception: preserve "both" pages since they are the most specific classification.
    // Skip if spatial already provided a definitive classification for this page —
    // spatial is higher priority and must not be overridden by outline sections.
    // Also skip if spatial explicitly classified the page as "unknown" — those pages
    // are hard-excluded and outline sections must not re-introduce them.
    const hasSpatialResult = spatialType != null && spatialType !== "unknown";
    const isSpatiallyUnknown = spatialType === "unknown";
    if (!hasSpatialResult && !isSpatiallyUnknown && pdfMeta.outlineSections.length > 0 && type !== "both") {
      const section = pdfMeta.outlineSections.find(
        (s) => p.pageNum >= s.pageStart && p.pageNum <= s.pageEnd
      );
      if (section?.type === "both") {
        logger.debug(
          { pageNum: p.pageNum, section: section.title, wasType: type },
          "Outline override: both"
        );
        type = "both";
      } else if (section?.type === "floor_plan" && type !== "floor_plan") {
        logger.debug(
          { pageNum: p.pageNum, section: section.title, wasType: type },
          "Outline override: floor_plan"
        );
        type = "floor_plan";
      } else if (section?.type === "sign_schedule" && type !== "sign_schedule") {
        logger.debug(
          { pageNum: p.pageNum, section: section.title, wasType: type },
          "Outline override: sign_schedule"
        );
        type = "sign_schedule";
      }
    }

    return type === p.type ? p : { ...p, type };
  });

  if (pages.length === 0) {
    logger.warn({ filePath }, "PDF yielded no pages");
    return { rows: [], rawTextRows: [], pageCount: numPages, rawText: "", inputTokens: 0, outputTokens: 0, pageStats: { floorPlanPages: [], signSchedulePages: [], otherPages: [] } };
  }

  const allRows: ExtractedSignRow[] = [];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  // ── PASS 1: Sign Schedule pages are now handled by the spatial parser ────────
  // The deterministic spatial parser (signage-schedule-parser.ts) processes all
  // sign_schedule pages during initial PDF processing.  No Gemini call is made
  // here — keeping signScheduleContext undefined so Pass 2 proceeds without it.
  const signScheduleContext: string | undefined = undefined;
  logger.info({ filePath: filePath.split("/").pop() }, "Pass 1 skipped — sign schedule pages handled by spatial parser");

  // ── PASS 2: Floor Plan Pages — ADA-Required Signs ──────────────────────────
  // Split floor plan pages into batches of ~240K chars to stay under rate limits
  const MAX_FP_CHARS = 240000;
  const MAX_FP_PAGE_CHARS = 5000;

  const floorPlanPages = pages
    .filter((p) => p.type === "floor_plan" || p.type === "both")
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

    // Pre-build the prompt once (it's the same for all batches) then fire all
    // batches concurrently.  For a 5-page PDF with 5 batches this cuts latency
    // from 5 × T to T (limited by the slowest batch, not the sum).

    // ── Building-type detection + pre-filtered room candidates ──────────────
    // Detect building type from the first page's title block (no AI) and
    // collect room label candidates from all floor plan pages.  The phrase cache
    // is warm from the text-extraction pass above, so these calls are cheap.
    // extractTitleBlockBuildingType is imported from phase-1-intake.ts (the single
    // authoritative owner) and used here as the sole approved call site outside
    // the default pipeline — this on-demand AI scan path is not in the default flow.
    let detectedBuildingType: string | null = null;
    const allRoomCandidates: RoomCandidate[] = [];
    try {
      const firstPagePhrases = await extractPagePhrases(filePath, fileId, 1);
      detectedBuildingType = extractTitleBlockBuildingType(firstPagePhrases.phrases);
    } catch { /* non-fatal */ }
    for (const fpPage of floorPlanPages.slice(0, 20)) { // cap at 20 pages to bound work
      try {
        const pw = await extractPagePhrases(filePath, fileId, fpPage.pageNum);
        const candidates = extractFloorPlanTextCandidates(pw, fpPage.pageNum);
        allRoomCandidates.push(...candidates);
      } catch { /* non-fatal */ }
    }

    const floorPlanPromptPrefix = buildFloorPlanADAPrompt(
      projectContext,
      signScheduleContext,
      verifiedSigns,
      trainingContext,
      specTypeContext,
      detectedBuildingType,
      allRoomCandidates.length > 0 ? allRoomCandidates : undefined,
    );

    const batchResults = await Promise.all(
      batches.map(async (batch, batchIdx) => {
        const sorted = [...batch].sort((a, b) => a.pageNum - b.pageNum);
        const block = sorted.map((p) => `--- PAGE ${p.pageNum} ---\n${p.text}`).join("\n\n");
        const label = `floor-plan-batch-${batchIdx + 1}-of-${batches.length}`;
        logger.info({ batchPages: batch.length, label }, "Running ADA floor plan pass");

        const { text: fpText, inputTokens: fi, outputTokens: fo } = await callGemini(
          floorPlanPromptPrefix + block,
          ai,
          label
        );
        const fpRows = parseGeminiResponse(fpText, label);
        logger.info({ count: fpRows.length, label }, "ADA floor plan pass complete");
        return { rows: fpRows, inputTokens: fi, outputTokens: fo };
      })
    );

    for (const { rows, inputTokens: fi, outputTokens: fo } of batchResults) {
      allRows.push(...rows);
      totalInputTokens += fi;
      totalOutputTokens += fo;
    }
  }

  // ── PASS 3: Fallback — if nothing found yet, run general extraction ─────────
  if (allRows.length === 0) {
    logger.info({ filePath: filePath.split("/").pop() }, "No results from targeted passes — running general extraction fallback");

    const generalBlock = buildPageBlock(
      pages.filter((p) => p.type === "floor_plan" || p.type === "both"),
      "floor_plan",
      300000,
      6000
    );

    if (generalBlock.trim().length > 50) {
      const { text: fallbackText, inputTokens: gi, outputTokens: go } = await callGemini(
        buildFloorPlanADAPrompt(projectContext) + generalBlock,
        ai,
        "general-fallback"
      );
      totalInputTokens += gi;
      totalOutputTokens += go;
      const fallbackRows = parseGeminiResponse(fallbackText, "general-fallback");
      allRows.push(...fallbackRows);
    }
  }

  // ── PASS 4: Visual extraction fallback — for image-based / scanned PDFs ─────
  // If all prior passes found nothing AND the total extracted text is too sparse
  // to be useful (< 50 usable characters), the PDF is likely scanned/image-based.
  // Send the PDF directly to the multimodal AI for visual sign extraction.
  if (allRows.length === 0) {
    const totalTextLength = pages.reduce((sum, p) => sum + p.text.trim().length, 0);
    if (totalTextLength < 50 && numPages > 0) {
      logger.info(
        { filePath: filePath.split("/").pop(), totalTextLength, numPages },
        "Sparse text detected — running visual extraction fallback (Pass 4)"
      );

      let fileBuffer: Buffer | null = null;
      try {
        fileBuffer = await fs.readFile(filePath);
      } catch (err) {
        logger.error({ err, filePath }, "Pass 4: could not read PDF file — skipping visual fallback");
      }

      if (fileBuffer) {
        const fileName = filePath.split("/").pop() ?? "file.pdf";

        if (fileBuffer.length <= MAX_INLINE_PDF_BYTES) {
          const pdfBase64 = fileBuffer.toString("base64");
          const label = `visual-fallback-${fileName}`;
          try {
            const { text: vfText, inputTokens: vi, outputTokens: vo } = await callGeminiMultimodal(VISUAL_FALLBACK_EXTRACTION_PROMPT, pdfBase64, ai, label);
            totalInputTokens += vi;
            totalOutputTokens += vo;
            const vfRows = parseImageExtractionResponse(vfText, label);
            logger.info({ rows: vfRows.length, inputTokens: vi, outputTokens: vo }, "Pass 4 visual fallback complete (single-pass)");
            allRows.push(...vfRows);
          } catch (err) {
            logger.error({ err, fileName }, "Pass 4 visual fallback call failed — no results");
          }
        } else {
          // Large PDF: split into page batches
          logger.info({ fileName, sizeBytes: fileBuffer.length }, "Pass 4 visual fallback: PDF too large — splitting into page batches");
          let { PDFDocument } = await import("pdf-lib");
          let srcDoc: import("pdf-lib").PDFDocument;
          try {
            srcDoc = await PDFDocument.load(fileBuffer, { ignoreEncryption: true });
            const totalPages = srcDoc.getPageCount();
            let batchCount = 0;

            for (let startPage = 0; startPage < totalPages; startPage += IMAGE_BATCH_PAGES) {
              const endPage = Math.min(startPage + IMAGE_BATCH_PAGES, totalPages);
              const pageIndices = Array.from({ length: endPage - startPage }, (_, i) => startPage + i);

              let batchPdfBytes: Uint8Array;
              try {
                const batchDoc = await PDFDocument.create();
                const copiedPages = await batchDoc.copyPages(srcDoc, pageIndices);
                for (const page of copiedPages) batchDoc.addPage(page);
                batchPdfBytes = await batchDoc.save();
              } catch (err) {
                logger.warn({ err, startPage, endPage }, "Pass 4: failed to create batch PDF — skipping batch");
                continue;
              }

              if (batchPdfBytes.length > MAX_INLINE_PDF_BYTES) {
                logger.warn({ startPage, endPage }, "Pass 4: batch too large — skipping");
                continue;
              }

              const pdfBase64 = Buffer.from(batchPdfBytes).toString("base64");
              const label = `visual-fallback-${fileName}-p${startPage + 1}-${endPage}`;
              batchCount++;

              try {
                const { text: vfText, inputTokens: vi, outputTokens: vo } = await callGeminiMultimodal(VISUAL_FALLBACK_EXTRACTION_PROMPT, pdfBase64, ai, label);
                totalInputTokens += vi;
                totalOutputTokens += vo;
                const batchRows = parseImageExtractionResponse(vfText, label);
                for (const r of batchRows) {
                  if (r.page_number != null) r.page_number = r.page_number + startPage;
                }
                allRows.push(...batchRows);
              } catch (err) {
                logger.warn({ err, label }, "Pass 4 visual fallback batch call failed — skipping batch");
              }
            }

            logger.info({ batches: batchCount, totalRows: allRows.length }, "Pass 4 visual fallback complete (batched)");
          } catch (err) {
            logger.error({ err, fileName }, "Pass 4: pdf-lib failed to load PDF for batching — skipping visual fallback");
          }
        }
      }
    }
  }

  const rawText = pages.map((p) => `--- PAGE ${p.pageNum} ---\n${p.text}`).slice(0, 10).join("\n\n");

  const pageStats: PageStats = {
    // "both" pages appear in BOTH floorPlanPages AND signSchedulePages so the
    // floor-plan viewer in the UI renders for them (with sign markers), and the
    // sign schedule count also reflects their content.
    floorPlanPages:    pages.filter((p) => p.type === "floor_plan" || p.type === "both").map((p) => p.pageNum).sort((a, b) => a - b),
    signSchedulePages: pages.filter((p) => p.type === "sign_schedule" || p.type === "both").map((p) => p.pageNum).sort((a, b) => a - b),
    bothPages:         pages.filter((p) => p.type === "both").map((p) => p.pageNum).sort((a, b) => a - b),
    otherPages:        pages.filter((p) => p.type === "other").map((p) => p.pageNum).sort((a, b) => a - b),
    titleBlockClassifiedPages: pages.filter((p) => p.titleBlockType !== "unknown").map((p) => p.pageNum).sort((a, b) => a - b),
    ...(pdfMeta.pageLabels.length > 0 ? { pageLabels: pdfMeta.pageLabels } : {}),
    ...(pdfMeta.outlineSections.length > 0 ? { outlineSections: pdfMeta.outlineSections } : {}),
  };

  // ── Source-level dedup ────────────────────────────────────────────────────
  // Group by composite key location.toUpperCase() + "||" + signType.toUpperCase().
  // Rows where either field is null get a unique fallback key and are never merged.
  // Winner rule (same as deduplicateSignRows in process-job.ts):
  //   1. Prefer the entry that has a non-null detail_reference.
  //   2. If both or neither have one, prefer the higher confidence_score.
  const rowsBeforeDedup = allRows.length;
  const groupMap = new Map<string, ExtractedSignRow>();
  let uniqueKeyCounter = 0;
  for (const row of allRows) {
    let key: string;
    if (row.location == null || row.sign_type == null) {
      key = `__unique_${uniqueKeyCounter++}`;
    } else {
      key = `${row.location.trim().toUpperCase()}||${row.sign_type.trim().toUpperCase()}`;
    }
    const existing = groupMap.get(key);
    if (!existing) {
      groupMap.set(key, row);
    } else {
      const existingScore = existing.confidence_score ?? 0;
      const newScore = row.confidence_score ?? 0;
      const preferNew =
        (row.detail_reference != null && existing.detail_reference == null) ||
        (!!row.detail_reference === !!existing.detail_reference && newScore > existingScore);
      if (preferNew) {
        groupMap.set(key, row);
      }
    }
  }
  const dedupedRows = Array.from(groupMap.values());
  const rowsAfterDedup = dedupedRows.length;

  logger.info(
    {
      filePath: filePath.split("/").pop(),
      totalSigns: rowsAfterDedup,
      rowsBeforeDedup,
      rowsRemovedByDedup: rowsBeforeDedup - rowsAfterDedup,
      totalInputTokens,
      totalOutputTokens,
      pageStats: {
        floorPlan: pageStats.floorPlanPages.length,
        signSchedule: pageStats.signSchedulePages.length,
        both: (pageStats.bothPages ?? []).length,
        other: pageStats.otherPages.length,
      },
    },
    "Extraction complete"
  );

  return { rows: dedupedRows, rawTextRows: [], pageCount: numPages, rawText, inputTokens: totalInputTokens, outputTokens: totalOutputTokens, pageStats };
}

// ─── VISUAL LOCATE ──────────────────────────────────────────────────────────

export interface VisualLocateCandidate {
  x: number;
  y: number;
  description: string;
  confidence: number;
}

export interface VisualLocateResult {
  signId: string;
  candidates: VisualLocateCandidate[];
}

const VISUAL_LOCATE_PROMPT = `You are looking at a single architectural floor plan page. Your task is to find the exact entrance or door opening location for each residential unit sign listed below.

The coordinates you return must be normalized values relative to the PAGE (not the paper):
  x = 0.0 means the left edge,  x = 1.0 means the right edge
  y = 0.0 means the top edge,   y = 1.0 means the bottom edge

Each sign entry includes:
- signId: unique identifier you MUST copy exactly into your response
- location: the full sign location string (e.g. "UNIT 1A 417B")
- typeToken: the unit type part (e.g. "UNIT 1A")
- roomNumber: the specific room/unit number (e.g. "417B")
- anchorHint: approximate (x,y) of the annotation-band label for that room — the ACTUAL door is physically nearby but at a different y-position; use this as a search anchor

Signs to locate:
SIGNS_PLACEHOLDER

Return a JSON array with exactly one object per sign:
[
  {
    "signId": "<exact signId from input — do not modify>",
    "candidates": [
      {"x": 0.45, "y": 0.32, "description": "Door gap at unit 417B in east corridor", "confidence": 0.85}
    ]
  }
]

Rules:
- Return exactly one object per signId, even if you return empty candidates.
- Provide up to 3 candidates per sign ordered by confidence (highest first).
- x and y MUST be normalized floats in [0.0, 1.0].
- Focus on the door threshold/opening, not the label position.
- If no door is visible for a sign, return an empty candidates array.
- Return ONLY valid JSON. No markdown, no code blocks, no explanation.`;

export interface VisualLocateSign {
  signId: string;
  signType?: string | null;
  location?: string | null;
  signIdentifier?: string | null;
  roomNumber?: string | null;
  typeToken?: string | null;
  anchorX?: number | null;
  anchorY?: number | null;
}

export async function visualLocateDoors(
  filePath: string,
  pageNum: number,
  signs: VisualLocateSign[],
  ai: GeminiAI,
): Promise<VisualLocateResult[]> {
  if (signs.length === 0) return [];

  const fileBuffer = await fs.readFile(filePath);
  const { PDFDocument } = await import("pdf-lib");
  let srcDoc: import("pdf-lib").PDFDocument;
  try {
    srcDoc = await PDFDocument.load(fileBuffer, { ignoreEncryption: true });
  } catch (err) {
    logger.error({ err, filePath }, "visualLocateDoors: pdf-lib failed to load");
    return signs.map((s) => ({ signId: s.signId, candidates: [] }));
  }

  const pageIdx = pageNum - 1;
  if (pageIdx < 0 || pageIdx >= srcDoc.getPageCount()) {
    logger.warn({ pageNum, total: srcDoc.getPageCount() }, "visualLocateDoors: page out of range");
    return signs.map((s) => ({ signId: s.signId, candidates: [] }));
  }

  const pageDoc = await PDFDocument.create();
  const [copiedPage] = await pageDoc.copyPages(srcDoc, [pageIdx]);
  pageDoc.addPage(copiedPage);
  const pageBytes = await pageDoc.save();
  const pdfBase64 = Buffer.from(pageBytes).toString("base64");

  const signsJson = JSON.stringify(signs.map((s) => ({
    signId: s.signId,
    location: s.location ?? "",
    typeToken: s.typeToken ?? "",
    roomNumber: s.roomNumber ?? "",
    anchorHint: s.anchorX != null && s.anchorY != null
      ? `annotation label near (${s.anchorX.toFixed(3)}, ${s.anchorY.toFixed(3)})`
      : "not available",
  })));
  const prompt = VISUAL_LOCATE_PROMPT.replace("SIGNS_PLACEHOLDER", signsJson);

  let raw = "";
  try {
    const { text } = await callGeminiMultimodal(prompt, pdfBase64, ai, `visual-locate-p${pageNum}`);
    raw = text;
  } catch (err) {
    logger.error({ err }, "visualLocateDoors: Gemini call failed");
    return signs.map((s) => ({ signId: s.signId, candidates: [] }));
  }

  try {
    const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    const parsed = JSON.parse(cleaned) as VisualLocateResult[];
    if (!Array.isArray(parsed)) throw new Error("Response is not an array");
    const resultMap = new Map(parsed.map((r) => [r.signId, r]));
    return signs.map((s) => {
      const entry = resultMap.get(s.signId);
      if (!entry) return { signId: s.signId, candidates: [] };
      const validCandidates = (entry.candidates ?? []).filter(
        (c) => typeof c.x === "number" && typeof c.y === "number" && c.x >= 0 && c.x <= 1 && c.y >= 0 && c.y <= 1
      ).slice(0, 3);
      return { signId: s.signId, candidates: validCandidates };
    });
  } catch (err) {
    logger.error({ err, raw: raw.slice(0, 300) }, "visualLocateDoors: JSON parse failed");
    return signs.map((s) => ({ signId: s.signId, candidates: [] }));
  }
}

// ── Isolated per-call-type extraction functions ────────────────────────────────
// These run exactly ONE bounded Gemini pass. They do NOT call extractSignsFromPdf
// and do NOT trigger any other AI pass, making them safe for on-demand /ai-scan use.
// Note: extractSignScheduleOnly was removed — sign schedule pages are now handled
// exclusively by the deterministic spatial parser in signage-schedule-parser.ts.

/**
 * Floor plan only — extracts ADA/code-required signs from floor plan pages.
 * Runs one Gemini call per batch of floor plan pages (no sign schedule pass, no fallback).
 */
export async function extractFloorPlanOnly(
  filePath: string,
  fileId: string,
  ai: GeminiAI,
  projectContext?: ProjectInfo,
  spatialPageTypes?: Map<number, import("./pdf-words").SpatialPageType>,
): Promise<{ rows: ExtractedSignRow[]; inputTokens: number; outputTokens: number; pageCount: number }> {
  const { pages: rawPages, numPages } = await extractTextFromPdf(filePath, fileId);

  // Apply spatial overrides (no Gemini for classification)
  const pages = rawPages.map((p) => {
    const spatialType = spatialPageTypes?.get(p.pageNum);
    if (!spatialType || spatialType === "unknown") {
      return spatialType === "unknown" ? { ...p, type: "other" as const } : p;
    }
    return { ...p, type: spatialType as PageType };
  });

  const MAX_FP_CHARS = 240000;
  const MAX_FP_PAGE_CHARS = 5000;

  const floorPlanPages = pages
    .filter((p) => p.type === "floor_plan" || p.type === "both")
    .sort((a, b) => b.floorPlanScore - a.floorPlanScore);

  if (floorPlanPages.length === 0) {
    logger.info({ filePath: filePath.split("/").pop() }, "extractFloorPlanOnly: no floor plan pages found");
    return { rows: [], inputTokens: 0, outputTokens: 0, pageCount: numPages };
  }

  // Batch floor plan pages by character count
  const batches: ScoredPage[][] = [];
  let currentBatch: ScoredPage[] = [];
  let currentChars = 0;
  for (const page of floorPlanPages) {
    const truncated = page.text.length > MAX_FP_PAGE_CHARS ? page.text.slice(0, MAX_FP_PAGE_CHARS) : page.text;
    const chunkLen = truncated.length + 20;
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
    "extractFloorPlanOnly: starting ADA floor plan passes"
  );

  const floorPlanPromptPrefix = buildFloorPlanADAPrompt(projectContext);

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  const allRows: ExtractedSignRow[] = [];

  const batchResults = await Promise.all(
    batches.map(async (batch, batchIdx) => {
      const sorted = [...batch].sort((a, b) => a.pageNum - b.pageNum);
      const block = sorted.map((p) => `--- PAGE ${p.pageNum} ---\n${p.text}`).join("\n\n");
      const firstPageNum = sorted[0]?.pageNum;
      const lastPageNum = sorted[sorted.length - 1]?.pageNum;
      const pageRange = firstPageNum !== undefined
        ? firstPageNum === lastPageNum
          ? `p${firstPageNum}`
          : `p${firstPageNum}-${lastPageNum}`
        : `batch${batchIdx + 1}`;
      const label = `floor-plan-text-${pageRange}-of-${batches.length}`;
      logger.info({ batchPages: batch.length, label }, "extractFloorPlanOnly: running pass");
      const { text, inputTokens, outputTokens } = await callGemini(floorPlanPromptPrefix + block, ai, label, firstPageNum);
      const rows = parseGeminiResponse(text, label);
      logger.info({ count: rows.length, label }, "extractFloorPlanOnly: pass complete");
      return { rows, inputTokens, outputTokens };
    })
  );

  for (const { rows, inputTokens: fi, outputTokens: fo } of batchResults) {
    allRows.push(...rows);
    totalInputTokens += fi;
    totalOutputTokens += fo;
  }

  return { rows: allRows, inputTokens: totalInputTokens, outputTokens: totalOutputTokens, pageCount: numPages };
}
