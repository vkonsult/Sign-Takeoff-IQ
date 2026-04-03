import fs from "fs/promises";
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import { z } from "zod";
import { logger } from "./logger";

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
- location: For the location field, use only the room identifier exactly as it appears printed on the plan — for example UNIT 2A 406B or ELEC A404. Do not add descriptive phrases, door positions, or narrative text. The location value must match the printed label verbatim so it can be found in the plan's text layer.
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

DEDUPLICATION RULES:
- Each physical door or room produces exactly ONE entry per sign type. Do NOT output the same room + sign type combination twice, even if the room label appears in both a schedule table and as a callout on a floor plan page.
- Do NOT add signs based on building code requirements alone. Only output signs that have a visible sign symbol, callout bubble, schedule row, or label present on the plan itself.
- A single location (e.g., "Electrical Room 101A") may correctly have MULTIPLE entries with DIFFERENT sign types (Room ID + Electrical Hazard + Evacuation Map). These are valid distinct entries and must all be kept — do NOT collapse them.
- If the same room label appears in both a structured schedule pass and a visual scan of the floor plan, output it ONCE. Prefer the entry with the most complete data (detail_reference, dimensions, mounting_type populated).
- Do NOT output a sign entry solely because it is code-required for that occupancy type if no actual sign symbol or annotation is visible in the document.

SIGN SCHEDULE / SPECIFICATION PAGES:
---
`;

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

function buildFloorPlanADAPrompt(projectContext?: ProjectInfo, signScheduleContext?: string, verifiedSigns?: VerifiedSignSummary[], trainingContext?: VerifiedSignSummary[]): string {
  const locationLine = projectContext?.address || projectContext?.city || projectContext?.state
    ? `\nPROJECT LOCATION: ${[projectContext.address, projectContext.city, projectContext.state, projectContext.zip].filter(Boolean).join(", ")}`
    : "";
  const occupancyLine = projectContext?.occupancy_type
    ? `\nBUILDING OCCUPANCY: ${projectContext.occupancy_type}`
    : "";
  const stateRules = getStateSpecificRules(projectContext?.state ?? null);
  const scheduleCtx = signScheduleContext
    ? `\n\nSIGN SCHEDULE / SPECIFICATION CONTEXT (for reference only — do NOT re-list these as output rows; use them to understand sign types, identifiers, and specs defined for this project):\n---\n${signScheduleContext.slice(0, 10000)}\n---\n`
    : "";
  const verifiedCtx = verifiedSigns && verifiedSigns.length > 0 ? buildVerifiedContext(verifiedSigns) : "";
  const trainingCtx = trainingContext && trainingContext.length > 0 ? buildTrainingContext(trainingContext) : "";

  return `You are an expert sign contractor, ADA compliance specialist, and fire/life-safety code consultant performing a comprehensive sign takeoff from architectural floor plans.

The text below contains text extracted from floor plan sheets of a building. Your task is to identify ALL spaces and rooms visible in these plans and determine the COMPLETE REQUIRED SIGNAGE for each space based on:
1. ADA Standards for Accessible Design (Section 703 — Signs)
2. IBC (International Building Code) egress and life-safety signage
3. NFPA 101 Life Safety Code signage requirements
4. NFPA 10, 13, 14, 72, 80, 96, and 170 fire protection sign requirements
5. OSHA 1910.145 and 1910.303 safety signage requirements
6. Standard building sign practice for each space type
${locationLine}${occupancyLine}${stateRules}

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
${scheduleCtx}${trainingCtx}${verifiedCtx}---
`;
}

// ─── PAGE SCORING ────────────────────────────────────────────────────────────

// Keywords that strongly indicate a page is a legend/symbol-key page.
// These pages define symbols but do NOT represent actual sign locations.
// A match overrides floor-plan classification so the page is skipped.
const LEGEND_PAGE_KEYWORDS = [
  "life safety legend",
  "signage legend",
  "symbol legend",
  "symbol key",
  "drawing legend",
  "legend:",
  "symbols and abbreviations",
  "general notes legend",
  "fire protection legend",
  "door hardware legend",
  "room finish legend",
  "abbreviation legend",
];

function scoreForLegendPage(text: string): number {
  const lower = text.toLowerCase();
  return LEGEND_PAGE_KEYWORDS.reduce((score, kw) => {
    const hits = (lower.match(new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length;
    // Weight each keyword more heavily so a single match is sufficient to override
    return score + hits * 3;
  }, 0);
}

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
  // Standard sign schedule terminology
  "sign schedule", "sign type", "signage schedule", "sign legend",
  "sign list", "sign index", "sign matrix", "sign catalog",
  "interior sign", "exterior sign", "room identification",
  "sign number", "sign id", "s-01", "s-1.", "s1.", "sign qty",
  "sign quantity", "sign detail", "sign location",
  // Architect sign specification / sign program patterns
  "sign spec", "signage spec", "sign specification", "signage specification",
  "sign program", "signage program", "signage criteria", "sign criteria",
  "sign standards", "signage standards",
  "procure for",          // "PROCURE FOR CS2026" — procurement-tagged schedules
  "permanent sign",       // "ALL SIGNAGE ON THIS SCHEDULE IS PERMANENT"
  "all signage",
  "verify code",          // "VERIFY CODE REQUIREMENTS" — architect spec note
  "sign no.", "sign no ", // "Sign No." column header in architect schedules
  "ada sign",             // ADA sign callouts in specs
  "room sign", "door sign",
  "building sign", "tenant sign",
  "directional sign", "wayfinding sign",
  "sign drawing", "sign detail",
  "signage drawing",
  // Sign type code patterns used by architects (SP-1, SN-01, SI-A, etc.)
  " sp-", " sn-", " si-", " se-", " sd-",
  "type a ", "type b ", "type c ", "type d ", // "Sign Type A", "Type B sign"
  // Additional sign schedule column headers
  "message", "copy", "substrate", "face material",
  "sign program", "exterior signage", "interior signage",
  "tenant identification", "suite number",
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

// Keywords in a filename that strongly suggest this is a floor plan PDF.
const FLOOR_PLAN_FILENAME_SIGNALS = [
  "floor plan", "floor-plan", "floorplan",
  "construction plan", "construction-plan",
  "reflected ceiling", "rcp",
  "floor level", "ground floor", "first floor", "second floor", "third floor",
  "mezzanine", "basement", "level ", "level-",
  " plan ", "-plan-", "_plan_",
  "architectural plan", "arch plan",
  "site plan", "roof plan",
];

const SIGN_SCHEDULE_FILENAME_SIGNALS = [
  "sign schedule", "sign-schedule", "signage schedule",
  "signage-schedule", "sign list", "sign index",
  "sign program", "signage program",
];

function filenameClassificationBoost(filename: string): { floorPlan: number; signSchedule: number } {
  const lower = filename.toLowerCase();
  const fpMatch = FLOOR_PLAN_FILENAME_SIGNALS.some((sig) => lower.includes(sig));
  const ssMatch = SIGN_SCHEDULE_FILENAME_SIGNALS.some((sig) => lower.includes(sig));
  return {
    floorPlan: fpMatch ? 10 : 0,
    signSchedule: ssMatch ? 10 : 0,
  };
}

function classifyPage(pageNum: number, text: string, filenameBoost?: { floorPlan: number; signSchedule: number }): ScoredPage {
  const textFloorPlanScore = scoreForFloorPlan(text);
  const textSignScheduleScore = scoreForSignSchedule(text);

  const boost = filenameBoost ?? { floorPlan: 0, signSchedule: 0 };
  const floorPlanScore = textFloorPlanScore + boost.floorPlan;
  const signScheduleScore = textSignScheduleScore + boost.signSchedule;

  // Legend/symbol-key pages are classified as "other" and excluded from
  // sign extraction. A single strong legend keyword (score ≥ 3) overrides
  // floor-plan classification unless the floor-plan text score is very high
  // (≥ 10), which would indicate that the page contains substantial real
  // room content alongside a small legend box.
  const legendScore = scoreForLegendPage(text);
  if (legendScore >= 3 && textFloorPlanScore < 10) {
    return { pageNum, text, floorPlanScore: textFloorPlanScore, signScheduleScore: textSignScheduleScore, type: "other" };
  }

  let type: PageType = "other";

  // When a filename strongly implies a type (boost ≥ 8), that classification
  // locks in unless the opposing TEXT score exceeds the boosted score by an
  // additional half-boost margin.  This prevents high floor-plan text scores
  // (from dimensions / room labels common to all architectural sheets) from
  // overriding a clear sign-schedule filename.
  const STRONG_BOOST = 8;
  if (boost.signSchedule >= STRONG_BOOST) {
    // Filename says "sign schedule" — floor plan must be much higher to override
    if (floorPlanScore >= 4 && floorPlanScore > signScheduleScore + boost.signSchedule * 0.5) {
      type = "floor_plan";
    } else {
      type = "sign_schedule";
    }
  } else if (boost.floorPlan >= STRONG_BOOST) {
    // Filename says "floor plan" — sign schedule must be much higher to override
    if (signScheduleScore >= 4 && signScheduleScore > floorPlanScore + boost.floorPlan * 0.5) {
      type = "sign_schedule";
    } else {
      type = "floor_plan";
    }
  } else {
    // No strong filename signal — use text scores with standard thresholds.
    // Sign schedule needs a higher absolute threshold (4) to avoid false
    // positives from floor plans that contain incidental sign words.
    if (floorPlanScore >= 4 && floorPlanScore >= signScheduleScore) {
      type = "floor_plan";
    } else if (signScheduleScore >= 4 && signScheduleScore > floorPlanScore) {
      type = "sign_schedule";
    } else if (floorPlanScore >= 4) {
      type = "floor_plan";
    } else if (signScheduleScore >= 4) {
      type = "sign_schedule";
    }
  }

  return { pageNum, text, floorPlanScore: textFloorPlanScore, signScheduleScore: textSignScheduleScore, type };
}

// ─── PDF TEXT EXTRACTION ──────────────────────────────────────────────────────

async function extractTextFromPdf(filePath: string): Promise<{
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

    // Derive a classification boost from the filename (e.g. "FIRST-FLOOR-CONSTRUCTION-PLAN" → +10 floor plan)
    const basename = filePath.split("/").pop() ?? "";
    const boost = filenameClassificationBoost(basename);

    const pages = rawPages.map((text, i) => classifyPage(i + 1, text, boost));

    const fpCount = pages.filter((p) => p.type === "floor_plan").length;
    const ssCount = pages.filter((p) => p.type === "sign_schedule").length;

    logger.info(
      {
        filePath: basename,
        totalPages: pages.length,
        floorPlanPages: fpCount,
        signSchedulePages: ssCount,
        otherPages: pages.length - fpCount - ssCount,
        filenameBoost: boost.floorPlan > 0 ? "floor_plan" : boost.signSchedule > 0 ? "sign_schedule" : "none",
      },
      "PDF pages classified"
    );

    const value = { pages, numPages: result.numpages };
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

// ─── MULTIMODAL GEMINI CALL (IMAGE / PDF) ─────────────────────────────────────

async function callGeminiMultimodal(
  prompt: string,
  pdfBase64: string,
  ai: GeminiAI,
  label: string
): Promise<GeminiCallResult> {
  const MAX_RETRIES = 4;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: [
          {
            role: "user",
            parts: [
              { inlineData: { mimeType: "application/pdf", data: pdfBase64 } },
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
      logger.info({ label, responseLength: text.length, inputTokens, outputTokens }, "Gemini multimodal call complete");
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

      logger.error({ err, label }, "Gemini multimodal call failed");
      throw err;
    }
  }

  throw new Error(`Gemini multimodal call exhausted all retries for: ${label}`);
}

// ─── IMAGE EXTRACTION PROMPT ──────────────────────────────────────────────────

const IMAGE_EXTRACTION_PROMPT = `You are an expert sign contractor performing a VISUAL CROSS-VERIFICATION sign takeoff from architectural plan documents.

CRITICAL MISSION: This is a second-pass visual scan whose primary purpose is to cross-verify a text-extraction pass that has already run. Your job is to visually CONFIRM signs found by the text pass AND independently find any signs the text pass may have missed. A large architectural floor plan will have dozens to hundreds of sign callouts — returning fewer than 10 results for a multi-room floor plan is almost certainly wrong. Scan aggressively.

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

IMPORTANT — DO NOT MISS SMALL CALLOUTS:
ADA floor plans often have very small (6–8pt font) circular or triangular callout symbols scattered throughout the floor plan. These are easy to overlook. Zoom in mentally on every doorway and room entry. Every room with a door almost certainly has a Room ID sign callout.

For each sign callout you visually identify, extract these fields (use null if not visible):

- sheet_number: Plan sheet number from title block (e.g. "A-101", "S-1")
- detail_reference: The callout code visible in the bubble or triangle (e.g. "1", "A", "RI-01", "EX")
- sign_type: Type of sign (e.g. "Room ID", "Exit", "ADA Restroom", "Wayfinding", "Fire Extinguisher", "Stairwell")
- sign_identifier: The unique sign code if visible (e.g. "S-01", "EX-1", "TYPE A"). Use detail_reference if no separate identifier.
- quantity: Integer count of this sign at this location. Default 1.
- location: Room name, space name, or positional description visible near the callout (e.g. "Room 101 - Storage", "Main Lobby", "North Exit")
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

IMPORTANT — DO NOT MISS SMALL CALLOUTS:
ADA floor plans often have very small (6–8pt font) circular or triangular callout symbols scattered throughout the floor plan. These are easy to overlook. Zoom in mentally on every doorway and room entry. Every room with a door almost certainly has a Room ID sign callout.

For each sign callout you visually identify, extract these fields (use null if not visible):

- sheet_number: Plan sheet number from title block (e.g. "A-101", "S-1")
- detail_reference: The callout code visible in the bubble or triangle (e.g. "1", "A", "RI-01", "EX")
- sign_type: Type of sign (e.g. "Room ID", "Exit", "ADA Restroom", "Wayfinding", "Fire Extinguisher", "Stairwell")
- sign_identifier: The unique sign code if visible (e.g. "S-01", "EX-1", "TYPE A"). Use detail_reference if no separate identifier.
- quantity: Integer count of this sign at this location. Default 1.
- location: Room name, space name, or positional description visible near the callout (e.g. "Room 101 - Storage", "Main Lobby", "North Exit")
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

function buildVerificationPrompt(textSignsByPage: Map<number, TextContextSign[]>): string {
  const pages = Array.from(textSignsByPage.entries()).sort(([a], [b]) => a - b);
  const signListLines: string[] = [];

  for (const [pageNum, signs] of pages) {
    if (signs.length === 0) continue;
    signListLines.push(`\n--- PAGE ${pageNum} ---`);
    for (const s of signs) {
      const parts: string[] = [];
      if (s.sign_identifier) parts.push(`ID: "${s.sign_identifier}"`);
      if (s.sign_type) parts.push(`Type: ${s.sign_type}`);
      if (s.location) parts.push(`Location: "${s.location}"`);
      signListLines.push(`  • ${parts.join(" | ")}`);
    }
  }

  const totalSigns = Array.from(textSignsByPage.values()).reduce((n, v) => n + v.length, 0);

  return `You are verifying architectural floor plan signs found by a text-extraction pass.

TEXT EXTRACTION FOUND ${totalSigns} SIGN(S) ACROSS ${pages.length} PAGE(S):
${signListLines.join("\n")}

TASK 1 — VERIFY (required for every sign listed above):
For each sign, look at the corresponding page image and determine:
• CONFIRMED  — You can clearly see a sign callout, identifier, or room label at/near this location
• UNCERTAIN  — Something is probably there but you cannot read it clearly
• NOT_FOUND  — You genuinely cannot see any evidence of this sign on the image

TASK 2 — DISCOVER (optional, high-confidence only):
Are there any clearly visible sign callouts in the images that are NOT in the list above?
Only include discoveries where you are ≥ 0.80 confident it is a real, placed sign callout (not a legend definition or symbol key entry). If uncertain, omit it. False positives are worse than missed signs.

Return ONLY valid JSON in exactly this format — no markdown fences, no extra text:
{
  "verifications": [
    {"sign_identifier": "B101", "location": "LOBBY", "page_number": 1, "status": "CONFIRMED", "confidence": 0.95},
    {"sign_identifier": "B102", "location": "TENANT STOR", "page_number": 1, "status": "CONFIRMED", "confidence": 0.90}
  ],
  "discoveries": [
    {"sheet_number": "A1", "sign_identifier": "EX-1", "sign_type": "Exit", "location": "Stair A", "page_number": 1, "confidence": 0.85}
  ]
}`;
}

function parseVerificationResponse(raw: string, label: string): { verifications: VerificationItem[]; discoveries: ExtractedSignRow[] } {
  let cleaned = raw.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\n?([\s\S]*?)```/);
  if (fenceMatch) cleaned = fenceMatch[1]!.trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    logger.warn({ label, raw: cleaned.slice(0, 500) }, "Verification response not valid JSON — trying to extract JSON object");
    const objMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!objMatch) {
      logger.error({ label }, "Could not extract JSON from verification response");
      return { verifications: [], discoveries: [] };
    }
    try {
      parsed = JSON.parse(objMatch[0]);
    } catch {
      logger.error({ label }, "Failed to parse extracted JSON from verification response");
      return { verifications: [], discoveries: [] };
    }
  }

  const result = VerificationResponseSchema.safeParse(parsed);
  if (!result.success) {
    logger.warn({ label, errors: result.error.flatten() }, "Verification schema validation failed — using defaults");
    return { verifications: [], discoveries: [] };
  }

  const verifications: VerificationItem[] = result.data.verifications.map((v) => ({
    sign_identifier: v.sign_identifier,
    location: v.location,
    page_number: v.page_number as number | null,
    status: v.status,
    confidence: v.confidence,
  }));

  const discoveries: ExtractedSignRow[] = result.data.discoveries
    .filter((d) => (d.confidence ?? 0) >= 0.80)
    .map((d) => ({
      sheet_number: d.sheet_number ?? null,
      detail_reference: d.detail_reference ?? null,
      sign_type: d.sign_type ?? null,
      sign_identifier: d.sign_identifier ?? null,
      quantity: null,
      location: d.location ?? null,
      dimensions: null,
      mounting_type: null,
      finish_color: null,
      illumination: null,
      materials: null,
      message_content: d.message_content ?? null,
      notes: "Discovered by visual verification pass",
      page_number: d.page_number as number | null,
      x_pos: null,
      y_pos: null,
      confidence_score: Math.min(0.85, d.confidence ?? 0.80),
      review_flag: true, // visual-only discoveries always need review
    }));

  logger.info({ label, verifications: verifications.length, confirmed: verifications.filter(v => v.status === "CONFIRMED").length, discoveries: discoveries.length }, "Verification response parsed");
  return { verifications, discoveries };
}

export async function extractSignsFromPdfImageVerify(
  filePath: string,
  ai: GeminiAI,
  textSignsByPage: Map<number, TextContextSign[]>
): Promise<VerifyResult> {
  if (textSignsByPage.size === 0) {
    return { verifications: [], discoveries: [], inputTokens: 0, outputTokens: 0, skipped: true, skipReason: "No text signs to verify" };
  }

  let fileBuffer: Buffer;
  try {
    fileBuffer = await fs.readFile(filePath);
  } catch (err) {
    logger.error({ err, filePath }, "Verification: could not read PDF file");
    return { verifications: [], discoveries: [], inputTokens: 0, outputTokens: 0, skipped: true, skipReason: "Could not read PDF file" };
  }

  const fileName = filePath.split("/").pop() ?? "file.pdf";
  const prompt = buildVerificationPrompt(textSignsByPage);

  if (fileBuffer.length <= MAX_INLINE_PDF_BYTES) {
    const pdfBase64 = fileBuffer.toString("base64");
    const label = `verify-${fileName}`;
    logger.info({ fileName, sizeBytes: fileBuffer.length, totalSigns: Array.from(textSignsByPage.values()).reduce((n, v) => n + v.length, 0) }, "Visual verification: single-pass");
    try {
      const { text, inputTokens, outputTokens } = await callGeminiMultimodal(prompt, pdfBase64, ai, label);
      const { verifications, discoveries } = parseVerificationResponse(text, label);
      logger.info({ verifications: verifications.length, discoveries: discoveries.length, inputTokens, outputTokens }, "Visual verification complete (single-pass)");
      return { verifications, discoveries, inputTokens, outputTokens, skipped: false };
    } catch (err) {
      logger.error({ err, fileName }, "Visual verification call failed");
      return { verifications: [], discoveries: [], inputTokens: 0, outputTokens: 0, skipped: true, skipReason: "Gemini call failed" };
    }
  }

  // Large PDF: batch by pages, filter text signs for each batch
  logger.info({ fileName, sizeBytes: fileBuffer.length }, "Visual verification: PDF too large — splitting into batches");
  let { PDFDocument } = await import("pdf-lib");
  let srcDoc: import("pdf-lib").PDFDocument;
  try {
    srcDoc = await PDFDocument.load(fileBuffer, { ignoreEncryption: true });
  } catch (err) {
    logger.error({ err, fileName }, "Verification: pdf-lib failed to load PDF");
    return { verifications: [], discoveries: [], inputTokens: 0, outputTokens: 0, skipped: true, skipReason: "PDF could not be parsed" };
  }

  const totalPages = srcDoc.getPageCount();
  const allVerifications: VerificationItem[] = [];
  const allDiscoveries: ExtractedSignRow[] = [];
  let totalIn = 0;
  let totalOut = 0;

  for (let startPage = 0; startPage < totalPages; startPage += IMAGE_BATCH_PAGES) {
    const endPage = Math.min(startPage + IMAGE_BATCH_PAGES, totalPages);
    const pageIndices = Array.from({ length: endPage - startPage }, (_, i) => startPage + i);

    // Build a sub-map containing only signs for these pages (1-indexed)
    const batchMap = new Map<number, TextContextSign[]>();
    for (let p = startPage + 1; p <= endPage; p++) {
      const signs = textSignsByPage.get(p);
      if (signs && signs.length > 0) batchMap.set(p, signs);
    }
    if (batchMap.size === 0) continue; // no signs on these pages — skip visual call

    let batchPdfBytes: Uint8Array;
    try {
      const batchDoc = await PDFDocument.create();
      const copiedPages = await batchDoc.copyPages(srcDoc, pageIndices);
      for (const page of copiedPages) batchDoc.addPage(page);
      batchPdfBytes = await batchDoc.save();
    } catch (err) {
      logger.warn({ err, startPage, endPage }, "Verification: failed to create batch PDF — skipping batch");
      continue;
    }

    if (batchPdfBytes.length > MAX_INLINE_PDF_BYTES) {
      logger.warn({ startPage, endPage }, "Verification: batch too large — skipping");
      continue;
    }

    const batchPrompt = buildVerificationPrompt(batchMap);
    const pdfBase64 = Buffer.from(batchPdfBytes).toString("base64");
    const label = `verify-${fileName}-p${startPage + 1}-${endPage}`;

    try {
      const { text, inputTokens, outputTokens } = await callGeminiMultimodal(batchPrompt, pdfBase64, ai, label);
      const { verifications, discoveries } = parseVerificationResponse(text, label);
      // Offset page numbers for discoveries back to full-doc coordinates
      for (const d of discoveries) {
        if (d.page_number != null) d.page_number = d.page_number + startPage;
      }
      allVerifications.push(...verifications);
      allDiscoveries.push(...discoveries);
      totalIn += inputTokens;
      totalOut += outputTokens;
    } catch (err) {
      logger.warn({ err, label }, "Verification batch call failed — skipping batch");
    }
  }

  return { verifications: allVerifications, discoveries: allDiscoveries, inputTokens: totalIn, outputTokens: totalOut, skipped: false };
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
  ai: GeminiAI
): Promise<{ info: ProjectInfo; inputTokens: number; outputTokens: number }> {
  const { pages } = await extractTextFromPdf(filePath);

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

// ─── MAIN EXPORT ──────────────────────────────────────────────────────────────

export interface PageStats {
  floorPlanPages: number[];
  signSchedulePages: number[];
  otherPages: number[];
}

export async function extractSignsFromPdf(
  filePath: string,
  ai: GeminiAI,
  projectContext?: ProjectInfo,
  verifiedSigns?: VerifiedSignSummary[],
  trainingContext?: VerifiedSignSummary[]
): Promise<{ rows: ExtractedSignRow[]; pageCount: number; rawText: string; inputTokens: number; outputTokens: number; pageStats: PageStats }> {
  const { pages, numPages } = await extractTextFromPdf(filePath);

  if (pages.length === 0) {
    logger.warn({ filePath }, "PDF yielded no pages");
    return { rows: [], pageCount: numPages, rawText: "", inputTokens: 0, outputTokens: 0, pageStats: { floorPlanPages: [], signSchedulePages: [], otherPages: [] } };
  }

  const allRows: ExtractedSignRow[] = [];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  // ── PASS 1: Sign Schedule / Specification Pages ───────────────────────────
  // Extract all signs explicitly listed in sign schedules / specs.  These are
  // the architect's definitive list of sign types, quantities, and locations.
  // Pass 2 (floor plans) handles code-required signs not in the schedule.
  const signScheduleBlock = buildPageBlock(pages, "sign_schedule", 300000, 8000);
  let signScheduleContext: string | undefined;

  if (signScheduleBlock.trim().length > 50) {
    signScheduleContext = signScheduleBlock; // also passed as reference context to Pass 2
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

    // Pre-build the prompt once (it's the same for all batches) then fire all
    // batches concurrently.  For a 5-page PDF with 5 batches this cuts latency
    // from 5 × T to T (limited by the slowest batch, not the sum).
    const floorPlanPromptPrefix = buildFloorPlanADAPrompt(projectContext, signScheduleContext, verifiedSigns, trainingContext);

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
    floorPlanPages:    pages.filter((p) => p.type === "floor_plan").map((p) => p.pageNum).sort((a, b) => a - b),
    signSchedulePages: pages.filter((p) => p.type === "sign_schedule").map((p) => p.pageNum).sort((a, b) => a - b),
    otherPages:        pages.filter((p) => p.type === "other").map((p) => p.pageNum).sort((a, b) => a - b),
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
        other: pageStats.otherPages.length,
      },
    },
    "Extraction complete"
  );

  return { rows: dedupedRows, pageCount: numPages, rawText, inputTokens: totalInputTokens, outputTokens: totalOutputTokens, pageStats };
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
