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
 * Canonical building types supported by the vocabulary system.
 */
export type CanonicalBuildingType =
  | "school"
  | "hotel"
  | "apartment"
  | "office"
  | "church"
  | "lab"
  | "library"
  | "sports";

/**
 * Known 3-character room abbreviations that should be kept during floor plan
 * text candidate filtering (even though most 3-char tokens are dropped as noise).
 */
// All entries are stored lowercase so token lookups using `.toLowerCase()` always hit.
export const KNOWN_ROOM_ABBREVIATIONS: Set<string> = new Set(
  [
    // Restroom codes
    "wrr", "mrr", "unr",
    // IT / telecom
    "idf", "mdf",
    // Spa / recreation
    "spa",
    // Common service
    "wc", "rr",
    // Vertical circulation
    "dn", "up",
    // Mechanical / electrical
    "ahu", "vav",
    // Storage / service
    "sto", "utl", "jan",
    // Other common 3-char codes found on plans
    "phr", "med", "adm", "art", "gym", "lab", "lib",
  ].map((s) => s.toLowerCase())
);

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

/**
 * Per-building-type room label vocabulary.
 * Keys are lower-cased tokens that appear on floor plans for that building type.
 * Values are the sign type string to assign.
 *
 * These maps are merged with the generic ROOM_LABEL_MAP by getRoomLabelMap().
 */
export const BUILDING_TYPE_VOCABULARY: Record<CanonicalBuildingType, Record<string, string>> = {

  school: {
    // Academic spaces
    classroom:      "CLASSROOM SIGN",
    "art":          "CLASSROOM SIGN",
    "art room":     "CLASSROOM SIGN",
    music:          "CLASSROOM SIGN",
    band:           "CLASSROOM SIGN",
    choir:          "CLASSROOM SIGN",
    music:          "CLASSROOM SIGN",
    drama:          "CLASSROOM SIGN",
    science:        "CLASSROOM SIGN",
    lab:            "CLASSROOM SIGN",
    laboratory:     "CLASSROOM SIGN",
    "science lab":  "CLASSROOM SIGN",
    "computer lab": "CLASSROOM SIGN",
    makerspace:     "CLASSROOM SIGN",
    "pre-k":        "CLASSROOM SIGN",
    prek:           "CLASSROOM SIGN",
    kindergarten:   "CLASSROOM SIGN",
    "seminar":      "CLASSROOM SIGN",
    "lecture hall": "CLASSROOM SIGN",
    // Administration
    principal:      "OFFICE SIGN",
    counselor:      "OFFICE SIGN",
    "nurse":        "OFFICE SIGN",
    "nurse's":      "OFFICE SIGN",
    administration: "OFFICE SIGN",
    admin:          "OFFICE SIGN",
    faculty:        "OFFICE SIGN",
    "staff lounge": "BREAK ROOM SIGN",
    // Library / media
    library:        "LIBRARY SIGN",
    "media center": "LIBRARY SIGN",
    "media room":   "LIBRARY SIGN",
    // Dining / assembly
    cafeteria:      "CAFETERIA SIGN",
    cafetorium:     "CAFETERIA SIGN",
    "dining":       "CAFETERIA SIGN",
    auditorium:     "AUDITORIUM SIGN",
    gymnasium:      "GYMNASIUM SIGN",
    gym:            "GYMNASIUM SIGN",
    // PE / athletics
    locker:         "LOCKER ROOM SIGN",
    "weight room":  "GYMNASIUM SIGN",
    // Support
    "textbook":     "STORAGE SIGN",
  },

  hotel: {
    // Guest rooms
    "guest room":   "GUEST ROOM SIGN",
    guestroom:      "GUEST ROOM SIGN",
    suite:          "SUITE SIGN",
    penthouse:      "SUITE SIGN",
    // Events
    ballroom:       "BALLROOM SIGN",
    banquet:        "BANQUET ROOM SIGN",
    "event room":   "BANQUET ROOM SIGN",
    // Fitness / recreation
    fitness:        "FITNESS ROOM SIGN",
    spa:            "SPA SIGN",
    pool:           "POOL SIGN",
    natatorium:     "POOL SIGN",
    // Guest services
    concierge:      "LOBBY SIGN",
    "front desk":   "LOBBY SIGN",
    "check-in":     "LOBBY SIGN",
    valet:          "LOBBY SIGN",
    // Back-of-house
    housekeeping:   "JANITOR ROOM SIGN",
    linen:          "STORAGE SIGN",
    laundry:        "STORAGE SIGN",
    "business center": "OFFICE SIGN",
    // Food & beverage
    restaurant:     "BREAK ROOM SIGN",
    bar:            "BREAK ROOM SIGN",
    "lounge":       "BREAK ROOM SIGN",
  },

  apartment: {
    // Residential units
    unit:           "ROOM ID SIGN",
    studio:         "ROOM ID SIGN",
    // Leasing / management
    leasing:        "OFFICE SIGN",
    "leasing office": "OFFICE SIGN",
    management:     "OFFICE SIGN",
    // Amenity spaces
    amenity:        "MULTIPURPOSE ROOM SIGN",
    clubhouse:      "MULTIPURPOSE ROOM SIGN",
    "fitness room": "FITNESS ROOM SIGN",
    fitness:        "FITNESS ROOM SIGN",
    rooftop:        "MULTIPURPOSE ROOM SIGN",
    "dog wash":     "MULTIPURPOSE ROOM SIGN",
    // Service rooms
    "mail room":    "ROOM ID SIGN",
    mailroom:       "ROOM ID SIGN",
    "package room": "ROOM ID SIGN",
    packageroom:    "ROOM ID SIGN",
    "trash room":   "STORAGE SIGN",
    trashroom:      "STORAGE SIGN",
    "bike room":    "STORAGE SIGN",
    bikeroom:       "STORAGE SIGN",
    "laundry":      "STORAGE SIGN",
    parking:        "ROOM ID SIGN",
    garage:         "ROOM ID SIGN",
  },

  office: {
    // Open / private work
    "open office":    "OFFICE SIGN",
    "private office": "OFFICE SIGN",
    workroom:         "OFFICE SIGN",
    // Meeting / collaboration
    boardroom:        "CONFERENCE ROOM SIGN",
    "war room":       "CONFERENCE ROOM SIGN",
    "focus room":     "CONFERENCE ROOM SIGN",
    "phone room":     "OFFICE SIGN",
    // Wellness
    "wellness room":  "OFFICE SIGN",
    "mother's room":  "OFFICE SIGN",
    "mothers room":   "OFFICE SIGN",
    lactation:        "OFFICE SIGN",
    // Support
    "copy room":      "ROOM ID SIGN",
    "print room":     "ROOM ID SIGN",
    "supply room":    "STORAGE SIGN",
    supply:           "STORAGE SIGN",
    reception:        "LOBBY SIGN",
    // Food
    pantry:           "BREAK ROOM SIGN",
    "coffee bar":     "BREAK ROOM SIGN",
  },

  church: {
    // Worship
    sanctuary:        "SANCTUARY SIGN",
    chapel:           "SANCTUARY SIGN",
    worship:          "SANCTUARY SIGN",
    auditorium:       "AUDITORIUM SIGN",
    "cry room":       "ROOM ID SIGN",
    "nursing room":   "ROOM ID SIGN",
    "prayer room":    "ROOM ID SIGN",
    prayer:           "ROOM ID SIGN",
    "baptistry":      "ROOM ID SIGN",
    baptistery:       "ROOM ID SIGN",
    "choir loft":     "ROOM ID SIGN",
    "choir room":     "CLASSROOM SIGN",
    // Entry / circulation
    narthex:          "LOBBY SIGN",
    vestibule:        "LOBBY SIGN",
    atrium:           "LOBBY SIGN",
    foyer:            "LOBBY SIGN",
    // Fellowship / education
    fellowship:       "MULTIPURPOSE ROOM SIGN",
    "fellowship hall": "MULTIPURPOSE ROOM SIGN",
    "sunday school":  "CLASSROOM SIGN",
    "children's church": "CLASSROOM SIGN",
    nursery:          "ROOM ID SIGN",
    // Clergy / admin
    sacristy:         "CLERGY ROOM SIGN",
    vestry:           "CLERGY ROOM SIGN",
    clergy:           "CLERGY ROOM SIGN",
    "pastor's office": "OFFICE SIGN",
    "pastor":         "OFFICE SIGN",
    "minister":       "OFFICE SIGN",
  },

  lab: {
    // Lab spaces
    "wet lab":        "ROOM ID SIGN",
    "dry lab":        "ROOM ID SIGN",
    "clean room":     "ROOM ID SIGN",
    cleanroom:        "ROOM ID SIGN",
    vivarium:         "ROOM ID SIGN",
    autoclave:        "ROOM ID SIGN",
    "cold room":      "ROOM ID SIGN",
    darkroom:         "ROOM ID SIGN",
    specimen:         "STORAGE SIGN",
    "instrument room": "ROOM ID SIGN",
    "instrument":     "ROOM ID SIGN",
    // Safety
    "fume hood":      "ROOM ID SIGN",
    "safety shower":  "ROOM ID SIGN",
    "eyewash":        "ROOM ID SIGN",
    "chemical storage": "STORAGE SIGN",
    // Support
    "write-up":       "OFFICE SIGN",
    "write up":       "OFFICE SIGN",
    conference:       "CONFERENCE ROOM SIGN",
    // Shared
    lab:              "CLASSROOM SIGN",
    laboratory:       "CLASSROOM SIGN",
  },

  library: {
    // Collections
    stacks:           "ROOM ID SIGN",
    "reading room":   "ROOM ID SIGN",
    reference:        "ROOM ID SIGN",
    periodicals:      "ROOM ID SIGN",
    archive:          "STORAGE SIGN",
    microfilm:        "ROOM ID SIGN",
    // Programs & services
    circulation:      "LOBBY SIGN",
    "children's room": "CLASSROOM SIGN",
    "young adult":    "CLASSROOM SIGN",
    "quiet study":    "ROOM ID SIGN",
    "group study":    "CONFERENCE ROOM SIGN",
    "program room":   "MULTIPURPOSE ROOM SIGN",
    "community room": "MULTIPURPOSE ROOM SIGN",
    // Staff
    "staff workroom": "OFFICE SIGN",
    workroom:         "OFFICE SIGN",
  },

  sports: {
    // Arenas & courts
    arena:            "ROOM ID SIGN",
    natatorium:       "POOL SIGN",
    pool:             "POOL SIGN",
    court:            "GYMNASIUM SIGN",
    gymnasium:        "GYMNASIUM SIGN",
    gym:              "GYMNASIUM SIGN",
    "field house":    "GYMNASIUM SIGN",
    fieldhouse:       "GYMNASIUM SIGN",
    "dance studio":   "CLASSROOM SIGN",
    "yoga":           "CLASSROOM SIGN",
    "spin room":      "FITNESS ROOM SIGN",
    "cycling":        "FITNESS ROOM SIGN",
    // Athletics support
    "weight room":    "GYMNASIUM SIGN",
    "training room":  "ROOM ID SIGN",
    "athletic trainer": "ROOM ID SIGN",
    "equipment room": "STORAGE SIGN",
    equipment:        "STORAGE SIGN",
    "locker room":    "LOCKER ROOM SIGN",
    locker:           "LOCKER ROOM SIGN",
    // Spectator / operations
    concession:       "ROOM ID SIGN",
    "press box":      "ROOM ID SIGN",
    "ticket":         "LOBBY SIGN",
    "broadcast":      "ROOM ID SIGN",
  },
};

/**
 * Keyword lists used to detect building type from a project name or title block text.
 * Each array entry is a lowercase keyword substring.
 */
const BUILDING_TYPE_KEYWORDS: Record<CanonicalBuildingType, string[]> = {
  school: [
    "school", "elementary", "middle school", "high school", "college",
    "university", "academy", "institute", "campus", "learning center",
    "stem center", "educational",
  ],
  hotel: [
    "hotel", "inn", "suites", "resort", "motel", "lodge",
    "hospitality", "marriott", "hilton", "hyatt", "sheraton", "westin",
  ],
  apartment: [
    "apartment", "apartments", "flats", "residences", "residential",
    "multifamily", "multi-family", "condominiums", "condos", "lofts",
    "townhomes", "housing",
  ],
  office: [
    "tower", "plaza", "center", "office", "headquarters", "hq",
    "corporate", "commercial", "business park", "tech park",
  ],
  church: [
    "church", "chapel", "worship", "cathedral", "mosque", "synagogue",
    "temple", "parish", "congregation", "ministry", "faith",
    "baptist", "methodist", "lutheran", "presbyterian", "catholic",
  ],
  lab: [
    "laboratory", "labs", "research", "sciences", "biotech",
    "pharmaceutical", "clinical", "medical research",
  ],
  library: [
    "library", "libraries", "archives", "reading",
  ],
  sports: [
    "arena", "stadium", "gymnasium", "athletic", "recreation center",
    "sports", "aquatic", "natatorium", "field house", "fitness center",
  ],
};

/**
 * Detect a canonical building type from a free-text string (project name,
 * title block content, etc.) using pure keyword matching.
 *
 * Returns the first matching canonical type, or null when no match is found.
 * Matching is case-insensitive and uses substring search.
 */
export function detectBuildingType(text: string): CanonicalBuildingType | null {
  if (!text) return null;
  const lower = text.toLowerCase();
  for (const [type, keywords] of Object.entries(BUILDING_TYPE_KEYWORDS) as [CanonicalBuildingType, string[]][]) {
    for (const kw of keywords) {
      if (lower.includes(kw)) return type;
    }
  }
  return null;
}

/**
 * Return a merged room-label map that combines the generic ROOM_LABEL_MAP with
 * the vocabulary specific to the given building type (if any).
 *
 * The building-type-specific entries take precedence over generic entries when
 * there is a key collision, allowing type-specific sign types to win.
 *
 * When buildingType is null/undefined the generic map is returned as-is.
 */
export function getRoomLabelMap(buildingType?: CanonicalBuildingType | string | null): Record<string, string> {
  if (!buildingType) return ROOM_LABEL_MAP;
  const typeVocab = BUILDING_TYPE_VOCABULARY[buildingType as CanonicalBuildingType];
  if (!typeVocab) return ROOM_LABEL_MAP;
  return { ...ROOM_LABEL_MAP, ...typeVocab };
}
