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

function buildFloorPlanADAPrompt(projectContext?: ProjectInfo): string {
  const locationLine = projectContext?.address || projectContext?.city || projectContext?.state
    ? `\nPROJECT LOCATION: ${[projectContext.address, projectContext.city, projectContext.state, projectContext.zip].filter(Boolean).join(", ")}`
    : "";
  const occupancyLine = projectContext?.occupancy_type
    ? `\nBUILDING OCCUPANCY: ${projectContext.occupancy_type}`
    : "";
  const stateRules = getStateSpecificRules(projectContext?.state ?? null);

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
- location: specific room name or space (e.g. "Room 101 - Office", "Stair 1 — Level 2", "Women's Restroom — North Wing", "Mechanical Room B — Level 1")
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

FLOOR PLAN PAGES (with page markers):
---
`;
}

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

export async function extractSignsFromPdf(
  filePath: string,
  ai: GeminiAI,
  projectContext?: ProjectInfo
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

      const { text: fpText, inputTokens: fi, outputTokens: fo } = await callGemini(buildFloorPlanADAPrompt(projectContext) + block, ai, label);
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
