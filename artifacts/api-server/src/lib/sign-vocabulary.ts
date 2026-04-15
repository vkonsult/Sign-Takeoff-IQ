/**
 * sign-vocabulary.ts — Single source of truth for all sign-related vocabulary.
 *
 * All phrase lists and room-label mappings used for PDF classification,
 * AI classification, and heuristic extraction are defined here and imported
 * everywhere else. Changing a phrase or mapping here automatically propagates
 * to all classifiers and extractors.
 */

/**
 * Phrases that positively identify a floor plan page.
 * Matching uses substring/includes so "FIRST FLOOR PLAN - OVERALL" triggers on "first floor".
 */
export const FLOOR_PLAN_INCLUSION_PHRASES: string[] = [
  "floor plan",
  "level plan",
  "first floor",
  "second floor",
  "third floor",
  "fourth floor",
  "fifth floor",
  "ground floor",
  "mezzanine",
  "basement",
  "main level",
  "lower level",
  "upper level",
  "attic floor plan",
];

/**
 * Phrases that veto floor plan classification even when inclusion phrases also match.
 * Applied as a first-check before the inclusion list.
 *
 * Rule: Only plans showing a specific building floor level (main, upper, lower,
 * first, second, third … any numbered floor, basement, ground, mezzanine) are
 * valid floor plans for sign extraction. All construction/engineering/specialty
 * plan types are excluded regardless of whether the word "plan" appears in the title.
 *
 * NOTE: "attic plan" is intentionally kept as two words — removing "plan" would
 * veto "ATTIC FLOOR PLAN" (a valid floor level) since exclusions run before inclusions.
 */
export const FLOOR_PLAN_EXCLUSION_PHRASES: string[] = [
  // Ceiling / overhead
  "ceiling",
  "reflected ceiling",
  "rcp",

  // Roof / attic structural (keep "attic plan" two words — see note above)
  "roof",
  "attic plan",

  // Construction & structural systems
  "framing",
  "structural",
  "foundation",
  "demolition",

  // MEP / building systems
  "electrical",
  "power",
  "mechanical",
  "plumbing",
  "sanitary",
  "water",
  "fire",
  "safety",
  "protection",
  "lighting",

  // Site & civil
  "site",

  // Interior / finish
  "furniture",
  "finish",
  "f&e",
  "dimensional",

  // Restroom / accessibility details (not a plan of a full floor)
  "restroom",
  "public restroom",

  // Notes / legends
  "general notes",
  "abbreviation",

  // Cover / index pages — drawing indexes, title sheets, cover sheets
  "cover sheet",
  "cover page",
  "sheet index",
  "title sheet",

  // Life-safety / code-compliance drawings (used primarily as bookmark-title veto;
  // "occupancy" is intentionally excluded — "occupancy load" appears in floor plan
  // title blocks and must not veto valid floor plans)
  "egress",

  // Specialty engineering drawings
  "photometric",
  "sprinkler",
];

/**
 * Phrases identifying a sign schedule page.
 */
export const SIGN_SCHEDULE_PHRASES: string[] = [
  "sign schedule",
  "signage schedule",
  "sign spec",
  "sign specification",
  "sign legend",
  "sign program",
  "sign list",
  "sign detail",
  "signage plan",
  // NOTE: "signs" removed — too broad as a substring match; catches cover sheets,
  // drawing indexes, and any page with the word "signs" anywhere in the title block.
  // "signage" is specific enough: it rarely appears in non-sign-related drawing titles.
  "signage",
  "signage criteria",
  "sign criteria",
];

/**
 * Canonical floor-level names in heuristic ascending order.
 * (lower → main → upper → attic)
 * Used for level detection and fallback ordering.
 */
export const CANONICAL_LEVEL_NAMES = [
  "lower level",
  "main level",
  "upper level",
  "attic",
] as const;

/**
 * Maps lower-cased room label tokens to sign type strings.
 * Every token that could appear on a floor plan as either the room code
 * or the room name must be listed.
 * Default (no match) → "ROOM ID SIGN" applied in calling code.
 */
export const ROOM_LABEL_MAP: Record<string, string> = {
  wrr: "WOMEN'S RESTROOM SIGN",
  womens: "WOMEN'S RESTROOM SIGN",
  "women's": "WOMEN'S RESTROOM SIGN",
  women: "WOMEN'S RESTROOM SIGN",
  girls: "WOMEN'S RESTROOM SIGN",

  mrr: "MEN'S RESTROOM SIGN",
  mens: "MEN'S RESTROOM SIGN",
  "men's": "MEN'S RESTROOM SIGN",
  men: "MEN'S RESTROOM SIGN",
  boys: "MEN'S RESTROOM SIGN",

  corridor: "CORRIDOR SIGN",
  corr: "CORRIDOR SIGN",
  hallway: "CORRIDOR SIGN",
  hall: "CORRIDOR SIGN",

  lobby: "LOBBY SIGN",
  reception: "LOBBY SIGN",
  foyer: "LOBBY SIGN",
  entry: "LOBBY SIGN",
  entrance: "LOBBY SIGN",
  vestibule: "LOBBY SIGN",
  narthex: "LOBBY SIGN",

  mech: "MECHANICAL ROOM SIGN",
  mechanical: "MECHANICAL ROOM SIGN",

  elec: "ELECTRICAL ROOM SIGN",
  electrical: "ELECTRICAL ROOM SIGN",

  stair: "STAIRWELL SIGN",
  stairwell: "STAIRWELL SIGN",
  stairs: "STAIRWELL SIGN",

  elev: "ELEVATOR SIGN",
  elevator: "ELEVATOR SIGN",
  lift: "ELEVATOR SIGN",

  restroom: "RESTROOM SIGN",
  toilet: "RESTROOM SIGN",
  wc: "RESTROOM SIGN",
  lavatory: "RESTROOM SIGN",
  bathroom: "RESTROOM SIGN",

  office: "OFFICE SIGN",

  conference: "CONFERENCE ROOM SIGN",
  collab: "CONFERENCE ROOM SIGN",
  collaboration: "CONFERENCE ROOM SIGN",
  meeting: "CONFERENCE ROOM SIGN",

  classroom: "CLASSROOM SIGN",
  training: "CLASSROOM SIGN",

  storage: "STORAGE SIGN",
  stor: "STORAGE SIGN",
  closet: "STORAGE SIGN",

  sanctuary: "SANCTUARY SIGN",
  chapel: "SANCTUARY SIGN",
  worship: "SANCTUARY SIGN",

  fellowship: "MULTIPURPOSE ROOM SIGN",
  commons: "MULTIPURPOSE ROOM SIGN",
  community: "MULTIPURPOSE ROOM SIGN",
  multipurpose: "MULTIPURPOSE ROOM SIGN",

  sacristy: "CLERGY ROOM SIGN",
  vestry: "CLERGY ROOM SIGN",
  clergy: "CLERGY ROOM SIGN",

  console: "CONSOLE SIGN",

  server: "IT ROOM SIGN",
  data: "IT ROOM SIGN",
  telecom: "IT ROOM SIGN",
  idf: "IT ROOM SIGN",
  mdf: "IT ROOM SIGN",

  janitor: "JANITOR ROOM SIGN",
  custodial: "JANITOR ROOM SIGN",
  housekeeping: "JANITOR ROOM SIGN",

  break: "BREAK ROOM SIGN",
  lounge: "BREAK ROOM SIGN",
  kitchen: "BREAK ROOM SIGN",
  "café": "BREAK ROOM SIGN",
  cafe: "BREAK ROOM SIGN",
  breakroom: "BREAK ROOM SIGN",
};
