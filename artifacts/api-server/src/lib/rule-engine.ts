/**
 * rule-engine.ts — Phase 5: Apply Rules R1–R15
 *
 * Replaces the keyword/regex heuristic sign extractor (extraction-heuristic.ts)
 * with a deterministic rule engine that operates on:
 *   - Room inventory: Phase 4 RoomInventory (from room-inventory.ts)
 *   - Plaque table:   signageScheduleEntries for the job (Phase 3 output)
 *
 * The engine produces a RuleEngineResult containing:
 *   - SignAssignment[]        per-room sign assignments with rule traceability
 *   - decisionsLog            per-room decision trace for Timeline display
 *   - questionsForVerification ambiguous cases flagged for human review
 *   - verificationErrors      R15-equivalent checks (pre-output)
 */

import { logger } from "./logger";
import {
  type RoomInventory as Phase4RoomInventory,
  type RoomRecord as Phase4RoomRecord,
} from "./room-inventory";

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * A single room extracted from a floor plan page.
 * Built during the inline room inventory extraction phase.
 */
export interface RoomRecord {
  roomNumber: string | null;
  roomName: string;
  level: string;
  pdfPage: number;

  // Derived flags (set by classifyRoom)
  isOccupied: boolean;
  isCorridorOrHall: boolean;
  isVehicleBay: boolean;
  isMepUnoccupied: boolean;
  isVariableUse: boolean;
  isRestroom: boolean;
  isPublicFacing: boolean;
  isGenderedRestroom: boolean;
  isStaffOnlyRestroom: boolean;
  isUnisexRestroom: boolean;
  isAccessibleRestroom: boolean;
  isElevator: boolean;
  isStair: boolean;
  isMezzanine: boolean;
  isAssembly: boolean;

  sourceSheet: string | null;
}

/**
 * A plaque table entry from Phase 3 (signageScheduleEntries).
 * Used for R7/R8 restroom type lookup.
 */
export interface PlaqueEntry {
  roomNumber: string | null;
  roomName: string | null;
  signTypeCode: string;
  quantity: number | null;
}

/**
 * Per-room sign assignment produced by R1-R15.
 */
export interface SignAssignment {
  roomNumber: string | null;
  roomName: string;
  level: string;
  pdfPage: number;

  // R1/R2/R3 — Room ID signs
  roomId: number | null;
  roomIdWithInsert: number | null;

  // R4 — Excluded from Room ID
  // R5/R6 — Office/suite IDs (not implemented)

  // R7/R8 — Restroom plaques
  restroom: number | null;

  // R9 — Exit
  exit: number | null;

  // R10 — Max occupancy / capacity sign
  maxOccupancy: number | null;

  // R11 — Stair plaques
  stairCorridor: number | null;
  stairLanding: number | null;

  // R12 — In Case of Fire (elevator)
  inCaseOfFire: number | null;

  // R13 — Evacuation map
  evacuationMap: number | null;

  // R14 — Office directory
  officeDirectory: number | null;

  // Traceability
  appliedRules: string[];
  exclusionReasons: string[];
  sourceSheet: string | null;
  ambiguous: boolean;
  ambiguityNote: string | null;
}

export interface RuleEngineResult {
  assignments: SignAssignment[];
  verificationErrors: string[];
  decisionsLog: string[];
  questionsForVerification: string[];
  roomCount: number;
  /**
   * Number of stair room appearances across all pages BEFORE job-level
   * deduplication.  Each (stair, level) pair contributes 1, so this value
   * naturally approximates "distinct stairs × levels served" and is used by
   * the Phase 6 verifier to check stair landing sign totals.
   */
  rawStairCount: number;
  /**
   * Number of elevator room appearances across all pages BEFORE job-level
   * deduplication.  Used by the Phase 6 verifier to check that the correct
   * number of "In Case of Fire" signs were assigned.
   */
  rawElevatorCount: number;
}

// ── Bridge: Phase 4 → Phase 5 room record ─────────────────────────────────────

/**
 * Convert a Phase 4 RoomRecord (from room-inventory.ts) into a Phase 5 RoomRecord
 * by merging Phase 4 flags with additional sub-type flags derived via classifyRoom().
 *
 * Phase 4 provides: isRestroom, isStair, isElevator, isCorridorOrHall, isVehicleBay,
 *   isMepUnoccupied, isVariableUse, isPublicFacing, isStaffOnly, isAssembly.
 * Phase 5 adds: isGenderedRestroom, isUnisexRestroom, isAccessibleRestroom, isMezzanine,
 *   isOccupied, and higher-precision sub-type detection via the room name tokens.
 */
function bridgeInventoryRoom(p4: Phase4RoomRecord): RoomRecord {
  const flags = classifyRoom(p4.roomName, p4.level, p4.roomNumber);
  const isMepUnoccupied = flags.isMepUnoccupied || p4.isMepUnoccupied;
  const isVehicleBay = flags.isVehicleBay || p4.isVehicleBay;
  return {
    roomNumber: p4.roomNumber,
    roomName: p4.roomName,
    level: p4.level,
    pdfPage: p4.pdfPage,
    sourceSheet: null,
    isOccupied: !(isMepUnoccupied || isVehicleBay),
    isCorridorOrHall: flags.isCorridorOrHall || p4.isCorridorOrHall,
    isVehicleBay,
    isMepUnoccupied,
    isVariableUse: flags.isVariableUse || p4.isVariableUse,
    isRestroom: flags.isRestroom || p4.isRestroom,
    isPublicFacing: flags.isPublicFacing || p4.isPublicFacing,
    isGenderedRestroom: flags.isGenderedRestroom,
    isStaffOnlyRestroom: flags.isStaffOnlyRestroom || p4.isStaffOnly,
    isUnisexRestroom: flags.isUnisexRestroom,
    isAccessibleRestroom: flags.isAccessibleRestroom,
    isElevator: flags.isElevator || p4.isElevator,
    isStair: flags.isStair || p4.isStair,
    isMezzanine: flags.isMezzanine,
    isAssembly: flags.isAssembly || p4.isAssembly,
  };
}

// ── Room classification ────────────────────────────────────────────────────────

const CORRIDOR_HALL_TOKENS = new Set([
  "corridor", "corr", "hallway", "hall", "passage", "gallery", "circulation", "walkway",
]);
const VEHICLE_BAY_TOKENS = new Set([
  "parking", "garage", "vehicle", "bay", "loading dock", "loading", "auto", "car",
]);
const MEP_TOKENS = new Set([
  "mechanical", "mech", "electrical", "elec", "plumbing", "utility", "utl",
  "riser", "telecom", "data", "server", "idf", "mdf", "ahu", "vav", "fan",
  "boiler", "chiller", "generator", "switchgear", "transformer", "pump",
  "cooling", "hvac", "sprinkler", "fire", "ahu", "air", "handler",
]);
const VARIABLE_USE_TOKENS = new Set([
  "training", "multipurpose", "multi-purpose", "flex", "flexible",
  "adaptable", "convertible", "assembly", "conference", "seminar",
  "meeting", "classroom", "lecture",
  "collaboration", "collab", "collaborative", "breakout", "co-working",
  "coworking", "ideation", "workshop", "huddle",
]);
const RESTROOM_TOKENS = new Set([
  "restroom", "bathroom", "toilet", "wc", "lavatory", "washroom",
  "rr", "wrr", "mrr", "unr", "pw", "pw1", "pw2",
]);
const WOMEN_TOKENS = new Set([
  "women", "womens", "woman", "women's", "female", "girls", "girl",
  "ladies", "lady",
]);
const MEN_TOKENS = new Set([
  "men", "mens", "man", "men's", "male", "boys", "boy",
  "gentlemen", "gents",
]);
const UNISEX_TOKENS = new Set([
  "unisex", "gender neutral", "gender-neutral", "all gender",
  "family", "single", "single-user", "single user", "accessible",
  "companion care", "companion",
]);
const ELEVATOR_TOKENS = new Set([
  "elevator", "elev", "lift", "escalator", "ele",
]);
const STAIR_TOKENS = new Set([
  "stair", "stairs", "stairwell", "staircase", "stair tower",
]);
const PUBLIC_FACING_TOKENS = new Set([
  "lobby", "entry", "entrance", "foyer", "vestibule", "narthex",
  "atrium", "reception", "front desk", "welcome", "concourse",
  "main entry", "public", "grand",
]);
const ASSEMBLY_TOKENS = new Set([
  "worship", "sanctuary", "chapel", "auditorium", "fellowship",
  "cafeteria", "gymnasium", "gym", "ballroom", "banquet",
  "theater", "theatre", "amphitheater", "stage", "arena",
  "community", "multipurpose hall", "great hall", "grand hall",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .trim()
    .replace(/'/g, "") // strip apostrophes so "women's" → "womens", "men's" → "mens"
    .split(/[\s/\-_]+/)
    .filter((t) => t.length > 0);
}

/**
 * Classify a room by its name and level, setting boolean flags.
 * Exported for unit testing.
 */
export function classifyRoom(
  roomName: string,
  level: string,
  roomNumber: string | null,
): Omit<RoomRecord, "roomNumber" | "roomName" | "level" | "pdfPage" | "sourceSheet"> {
  const lower = roomName.toLowerCase().trim();
  const tokens = tokenize(lower);

  // Multi-word token check helper
  function hasToken(tokenSet: Set<string>): boolean {
    for (const token of tokens) {
      if (tokenSet.has(token)) return true;
    }
    // Also check bigrams (two adjacent tokens joined by space)
    for (let i = 0; i < tokens.length - 1; i++) {
      const bigram = `${tokens[i]!} ${tokens[i + 1]!}`;
      if (tokenSet.has(bigram)) return true;
    }
    // Substring check: ONLY for multi-word entries (entries with spaces).
    // Single-word tokens are already covered by the first loop above.
    // Checking single-word tokens via substring causes false positives, e.g.
    // "STAIRWELL" containing "air" (MEP_TOKENS) → incorrectly isMepUnoccupied.
    for (const entry of tokenSet) {
      if (entry.includes(" ") && lower.includes(entry)) return true;
    }
    return false;
  }

  const isRestroom = hasToken(RESTROOM_TOKENS)
    || hasToken(WOMEN_TOKENS)
    || hasToken(MEN_TOKENS)
    || hasToken(UNISEX_TOKENS);

  const isGenderedRestroom = (hasToken(WOMEN_TOKENS) || hasToken(MEN_TOKENS)) && isRestroom;
  const isUnisexRestroom = hasToken(UNISEX_TOKENS) && isRestroom;
  const isAccessibleRestroom = lower.includes("accessible") || lower.includes("ada") || lower.includes("handicap");

  // Staff-only restroom heuristic: has "staff", "employee", "private" near restroom keywords
  const isStaffOnlyRestroom = isRestroom && (
    lower.includes("staff") || lower.includes("employee") || lower.includes("private") ||
    lower.includes("back of house") || lower.includes("service")
  );
  // Public-facing = isRestroom AND not staff-only AND (gendered OR accessible lobby area)
  const isPublicFacing = hasToken(PUBLIC_FACING_TOKENS) || (isRestroom && !isStaffOnlyRestroom);

  const isCorridorOrHall = hasToken(CORRIDOR_HALL_TOKENS);
  const isVehicleBay = hasToken(VEHICLE_BAY_TOKENS);
  const isMepUnoccupied = !isRestroom && hasToken(MEP_TOKENS);
  const isElevator = hasToken(ELEVATOR_TOKENS);
  const isStair = hasToken(STAIR_TOKENS);

  // Mezzanine: either level name or room name contains "mezz" or "mezzanine"
  const isMezzanine =
    level.toLowerCase().includes("mezz") ||
    level.toLowerCase().includes("mezzanine") ||
    lower.includes("mezzanine") ||
    lower.includes("mezz");

  const isAssembly = hasToken(ASSEMBLY_TOKENS);
  const isVariableUse = hasToken(VARIABLE_USE_TOKENS) && !isAssembly;

  // isOccupied: false for MEP/unoccupied, vehicle bays, and explicitly excluded rooms
  const isOccupied = !isMepUnoccupied && !isVehicleBay;

  return {
    isOccupied,
    isCorridorOrHall,
    isVehicleBay,
    isMepUnoccupied,
    isVariableUse,
    isRestroom,
    isPublicFacing,
    isGenderedRestroom,
    isStaffOnlyRestroom,
    isUnisexRestroom,
    isAccessibleRestroom,
    isElevator,
    isStair,
    isMezzanine,
    isAssembly,
  };
}

// ── Rule application ──────────────────────────────────────────────────────────

/**
 * Apply rules R1-R15 to a single room record.
 */
function applyRulesToRoom(
  room: RoomRecord,
  plaqueTable: PlaqueEntry[],
  elevatorJobCount: number,
  exitDischargeVestibules: Set<string>,
  publicLobbyRooms: Set<string>,
  levelLobbies: Map<string, RoomRecord[]>,
): SignAssignment {
  const assignment: SignAssignment = {
    roomNumber: room.roomNumber,
    roomName: room.roomName,
    level: room.level,
    pdfPage: room.pdfPage,
    roomId: null,
    roomIdWithInsert: null,
    restroom: null,
    exit: null,
    maxOccupancy: null,
    stairCorridor: null,
    stairLanding: null,
    inCaseOfFire: null,
    evacuationMap: null,
    officeDirectory: null,
    appliedRules: [],
    exclusionReasons: [],
    sourceSheet: room.sourceSheet,
    ambiguous: false,
    ambiguityNote: null,
  };

  const nameUpper = room.roomName.toUpperCase();

  // ── R15 — Mezzanine exclusion (checked first as it vetoes everything) ──────
  if (room.isMezzanine && room.isMepUnoccupied) {
    assignment.exclusionReasons.push("R15: mezzanine MEP unoccupied — all signs excluded");
    return assignment;
  }

  // ── R4 — Corridor exclusion ───────────────────────────────────────────────
  if (room.isCorridorOrHall) {
    assignment.roomId = 0;
    assignment.exclusionReasons.push("R4: is_corridor_or_hall");
    // Corridors can still get EXIT signs per R9 if they are exit-discharge corridors
    // (handled at job level; skip per-room R9 for plain corridors)
    return assignment;
  }

  // ── R2 — Variable use (takes priority over R1) ────────────────────────────
  if (room.isVariableUse) {
    // Variable-use rooms: Room ID with insert
    // Quantity depends on egress door count — we can't count doors without Phase 4,
    // so we default to 1 and flag as ambiguous.
    assignment.roomIdWithInsert = 1;
    assignment.roomId = 0;
    assignment.appliedRules.push("R2");
    assignment.ambiguous = true;
    assignment.ambiguityNote =
      "R2: variable-use room — door count unknown; quantity may be 1 or 2 depending on egress doors";
  } else if (room.isOccupied && !room.isMepUnoccupied && !room.isVehicleBay) {
    // ── R1 — Room ID default ────────────────────────────────────────────────
    // Restrooms, stairs, and elevators get their own specialized signs below,
    // not a generic Room ID sign.
    if (!room.isRestroom && !room.isStair && !room.isElevator) {
      assignment.roomId = 1;
      assignment.appliedRules.push("R1");
    }
  }

  // R3 — Multi-entry large rooms: flag as ambiguous since we can't count doors
  // without Phase 4. The ambiguityNote from R2 already covers this for variable-use rooms.
  if (!room.isVariableUse && room.isAssembly) {
    if (assignment.roomId !== null && assignment.roomId > 0) {
      assignment.ambiguous = true;
      assignment.ambiguityNote =
        "R3 candidate: assembly space may have multiple entry doors — verify door count for quantity";
    }
  }

  // ── R5/R6 — Office/suite IDs (not implemented) ───────────────────────────
  // Deferred — requires additional floor plan analysis.

  // ── R7 — Restroom type selection ─────────────────────────────────────────
  if (room.isRestroom) {
    // Look up plaque table for this room
    const plaqueMatch = findPlaqueForRoom(room, plaqueTable);
    if (plaqueMatch) {
      assignment.restroom = plaqueMatch.quantity ?? 1;
      assignment.appliedRules.push("R7");
      // R8 — ADA accessible variant already handled by plaque table lookup
      if (room.isAccessibleRestroom) {
        assignment.appliedRules.push("R8");
      }
    } else {
      // No plaque table match — default to 1, flag for verification
      assignment.restroom = 1;
      assignment.appliedRules.push("R7");
      if (room.isAccessibleRestroom) assignment.appliedRules.push("R8");
      assignment.ambiguous = true;
      assignment.ambiguityNote =
        (assignment.ambiguityNote ?? "") +
        "; R7/R8: no matching plaque table entry — type unknown (verify plaque selection)";
    }
    // Restrooms do NOT get a generic Room ID sign (R1 already skipped above)
  }

  // ── R9 — EXIT plaque ───────────────────────────────────────────────────────
  // 1 EXIT at each exit-discharge vestibule
  // 1 EXIT at public lobby with exit door
  // For assembly rooms: count = required exits per IBC 1006.2.1
  if (exitDischargeVestibules.has(room.roomName.toLowerCase())) {
    assignment.exit = 1;
    assignment.appliedRules.push("R9");
  } else if (room.isPublicFacing && (nameUpper.includes("LOBBY") || nameUpper.includes("VESTIBULE") || nameUpper.includes("FOYER"))) {
    assignment.exit = 1;
    assignment.appliedRules.push("R9");
  } else if (room.isAssembly) {
    // Assembly: IBC 1006.2.1 requires exits based on occupant load
    // Without occupant load data, flag as ambiguous
    assignment.exit = 2; // minimum for assembly spaces per IBC 1004.1
    assignment.appliedRules.push("R9");
    assignment.ambiguous = true;
    assignment.ambiguityNote =
      (assignment.ambiguityNote ?? "") +
      "; R9: assembly exit count — verify per IBC 1006.2.1 (occupant load required)";
  }

  // ── R10 — Capacity sign ──────────────────────────────────────────────────
  if (room.isAssembly) {
    // Assembly spaces with occupancy group A-2/A-3 or occupant load >= 50
    // We flag assembly rooms as needing capacity sign (ambiguous quantity)
    assignment.maxOccupancy = 1;
    assignment.appliedRules.push("R10");
    assignment.ambiguous = true;
    const note = "; R10: capacity sign — verify occupant load (≥50 required for A-2/A-3)";
    if (!assignment.ambiguityNote?.includes("R10:")) {
      assignment.ambiguityNote = (assignment.ambiguityNote ?? "") + note;
    }
  }

  // ── R11 — Stair plaques per level ────────────────────────────────────────
  if (room.isStair) {
    // stairCorridor = count of corridor entry doors at this level (unknown without Phase 4 — set to 1)
    // stairLanding = 1 (one landing sign per stair per level)
    assignment.stairCorridor = 1;
    assignment.stairLanding = 1;
    assignment.appliedRules.push("R11");
    assignment.ambiguous = true;
    assignment.ambiguityNote =
      (assignment.ambiguityNote ?? "") +
      "; R11: stair corridor sign count may be >1 — verify door count";
    // Stairs do NOT get a generic Room ID sign (R1 already skipped above)
  }

  // ── R12 — Elevator "In Case of Fire" ─────────────────────────────────────
  if (room.isElevator) {
    // One ICF sign per elevator bank (deduplicated job-wide by the caller)
    assignment.inCaseOfFire = 1;
    assignment.appliedRules.push("R12");
    // Elevators do NOT get a generic Room ID sign (R1 already skipped above)
  }

  // ── R13 — Evacuation map ─────────────────────────────────────────────────
  // 1 × at each elevator lobby + 1 × at each main public entry/lobby
  if (room.isElevator) {
    assignment.evacuationMap = 1;
    assignment.appliedRules.push("R13");
  } else if (room.isPublicFacing && (
    nameUpper.includes("LOBBY") ||
    nameUpper.includes("VESTIBULE") ||
    nameUpper.includes("FOYER") ||
    nameUpper.includes("NARTHEX")
  )) {
    assignment.evacuationMap = 1;
    assignment.appliedRules.push("R13");
  }

  // ── R14 — Office Directory ──────────────────────────────────────────────
  // 1 × at main public-facing hall/lobby per wing/department zone per level
  // We emit one per public lobby; final dedup is done at summary level.
  if (nameUpper.includes("LOBBY") || nameUpper.includes("MAIN ENTRY") || nameUpper.includes("ATRIUM")) {
    const levelLobbiesForThisLevel = levelLobbies.get(room.level) ?? [];
    // Only assign directory to the first lobby on this level (simplification)
    const isFirstLobbyOnLevel = levelLobbiesForThisLevel[0]?.roomName === room.roomName;
    if (isFirstLobbyOnLevel) {
      assignment.officeDirectory = 1;
      assignment.appliedRules.push("R14");
    }
  }

  // Final: rooms that got nothing (isOccupied but excluded by room type checks)
  // should still be tracked with explicit zero
  if (
    !room.isRestroom &&
    !room.isStair &&
    !room.isElevator &&
    !room.isCorridorOrHall &&
    !room.isMepUnoccupied &&
    !room.isVehicleBay &&
    assignment.roomId === null &&
    assignment.roomIdWithInsert === null
  ) {
    // Unusual case: occupied room that didn't get a sign — flag for review
    assignment.ambiguous = true;
    assignment.ambiguityNote =
      "No rule applied — verify room type and flag classification";
  }

  return assignment;
}

/**
 * Find the best matching plaque table entry for a room.
 */
function findPlaqueForRoom(
  room: RoomRecord,
  plaqueTable: PlaqueEntry[],
): PlaqueEntry | null {
  if (plaqueTable.length === 0) return null;

  const lowerName = room.roomName.toLowerCase();

  // Exact room number match
  if (room.roomNumber) {
    const byNum = plaqueTable.find(
      (p) => p.roomNumber && p.roomNumber.toUpperCase() === room.roomNumber!.toUpperCase(),
    );
    if (byNum) return byNum;
  }

  // Name-based match for restrooms
  if (room.isGenderedRestroom) {
    if (WOMEN_TOKENS.has(lowerName.split(/\s+/)[0]!)) {
      const entry = plaqueTable.find((p) =>
        p.signTypeCode.toUpperCase().includes("WRR") ||
        p.signTypeCode.toUpperCase().includes("WOMEN") ||
        (p.roomName && p.roomName.toLowerCase().includes("women")),
      );
      if (entry) return entry;
    }
    if (MEN_TOKENS.has(lowerName.split(/\s+/)[0]!)) {
      const entry = plaqueTable.find((p) =>
        p.signTypeCode.toUpperCase().includes("MRR") ||
        p.signTypeCode.toUpperCase().includes("MEN") ||
        (p.roomName && p.roomName.toLowerCase().includes("men")),
      );
      if (entry) return entry;
    }
  }

  if (room.isUnisexRestroom || room.isAccessibleRestroom) {
    const entry = plaqueTable.find((p) =>
      p.signTypeCode.toUpperCase().includes("UNR") ||
      (p.roomName && p.roomName.toLowerCase().includes("unisex")),
    );
    if (entry) return entry;
  }

  return null;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Main entry point: apply rules R1–R15 to a Phase 4 RoomInventory.
 *
 * Phase 4 (room-inventory.ts) must complete before Phase 5 is called.
 * The inventory is bridged to Phase 5's richer RoomRecord type, which adds
 * restroom sub-types (gendered/unisex/accessible) and mezzanine detection
 * that Phase 4 does not explicitly track.
 *
 * @param inventory    Phase 4 RoomInventory produced by buildRoomInventory()
 * @param plaqueTable  Per-file signage schedule entries for R7/R8 lookup
 * @param jobId        Job ID for logging
 */
export function applySignRules(
  inventory: Phase4RoomInventory,
  plaqueTable: PlaqueEntry[],
  jobId: string,
): RuleEngineResult {
  logger.info(
    { jobId, roomCount: inventory.rooms.length },
    "[RuleEngine] Starting rule application from Phase 4 inventory",
  );

  // ── Step 1: Bridge Phase 4 rooms → Phase 5 RoomRecord ────────────────────
  // classifyRoom() is re-run on the room name to add Phase 5-specific flags
  // (isGenderedRestroom, isUnisexRestroom, isAccessibleRestroom, isMezzanine).
  // Phase 4 flags are OR-merged so both systems must agree a room is NOT a
  // restroom/stair/etc. before it loses that designation.
  // Note: Phase 4 (room-inventory.ts) handles deduplication using spatial
  // proximity, preserving distinct same-named rooms at different positions
  // (e.g. 5× "COLLABORATION ROOM" each become separate RoomRecord entries).
  const rooms: RoomRecord[] = inventory.rooms.map(bridgeInventoryRoom);

  logger.info(
    { jobId, uniqueRoomCount: rooms.length },
    "[RuleEngine] Phase 4 inventory bridged to Phase 5 room records",
  );

  // Count stair and elevator appearances before deduplication.
  // Each (room, page) pair counts once, so named stairs that appear on multiple
  // floor-plan pages produce one count per appearance — approximating
  // "distinct stairs × levels served" without Phase 4 data.
  const rawStairCount = rooms.filter((r) => r.isStair).length;
  const rawElevatorCount = rooms.filter((r) => r.isElevator).length;

  // ── Step 3: Build job-level context for R12/R13/R14 ─────────────────────
  const exitDischargeVestibules = new Set<string>();
  const publicLobbyRooms = new Set<string>();
  const levelLobbies = new Map<string, RoomRecord[]>();

  for (const room of rooms) {
    const nameUpper = room.roomName.toUpperCase();
    if (
      nameUpper.includes("VESTIBULE") ||
      nameUpper.includes("EXIT") ||
      nameUpper.includes("DISCHARGE")
    ) {
      exitDischargeVestibules.add(room.roomName.toLowerCase());
    }
    if (room.isPublicFacing) {
      publicLobbyRooms.add(room.roomName.toLowerCase());
    }
    if (
      nameUpper.includes("LOBBY") ||
      nameUpper.includes("MAIN ENTRY") ||
      nameUpper.includes("ATRIUM")
    ) {
      const levelRooms = levelLobbies.get(room.level) ?? [];
      levelRooms.push(room);
      levelLobbies.set(room.level, levelRooms);
    }
  }

  // R12 deduplication: elevator "In Case of Fire" = 1 per elevator (not per floor)
  const elevatorRooms = rooms.filter((r) => r.isElevator);
  const elevatorJobCount = elevatorRooms.length;

  // ── Step 4: Apply rules R1-R15 to each room ──────────────────────────────
  const assignments: SignAssignment[] = [];
  const decisionsLog: string[] = [];
  const questionsForVerification: string[] = [];

  // Track elevators that already have an ICF sign (job-wide dedup for R12)
  let icfAssigned = false;

  for (const room of rooms) {
    const assignment = applyRulesToRoom(
      room,
      plaqueTable,
      elevatorJobCount,
      exitDischargeVestibules,
      publicLobbyRooms,
      levelLobbies,
    );

    // R12 deduplication: only the first elevator gets ICF sign if same bank
    // (simplified: assign ICF only to the first elevator found)
    if (assignment.inCaseOfFire !== null) {
      if (icfAssigned) {
        assignment.inCaseOfFire = null;
        // Still keep R12 in appliedRules but note dedup
        assignment.exclusionReasons.push("R12: ICF already assigned to another elevator in this job");
      } else {
        icfAssigned = true;
      }
    }

    assignments.push(assignment);

    // Build decisions log entry
    const signSummary: string[] = [];
    if (assignment.roomId && assignment.roomId > 0) signSummary.push(`Room ID ×${assignment.roomId}`);
    if (assignment.roomIdWithInsert && assignment.roomIdWithInsert > 0) signSummary.push(`Room ID w/ Insert ×${assignment.roomIdWithInsert}`);
    if (assignment.restroom && assignment.restroom > 0) signSummary.push(`Restroom ×${assignment.restroom}`);
    if (assignment.exit && assignment.exit > 0) signSummary.push(`Exit ×${assignment.exit}`);
    if (assignment.maxOccupancy && assignment.maxOccupancy > 0) signSummary.push(`Max Occupancy ×${assignment.maxOccupancy}`);
    if (assignment.stairCorridor && assignment.stairCorridor > 0) signSummary.push(`Stair Corridor ×${assignment.stairCorridor}`);
    if (assignment.stairLanding && assignment.stairLanding > 0) signSummary.push(`Stair Landing ×${assignment.stairLanding}`);
    if (assignment.inCaseOfFire && assignment.inCaseOfFire > 0) signSummary.push(`In Case of Fire ×${assignment.inCaseOfFire}`);
    if (assignment.evacuationMap && assignment.evacuationMap > 0) signSummary.push(`Evacuation Map ×${assignment.evacuationMap}`);
    if (assignment.officeDirectory && assignment.officeDirectory > 0) signSummary.push(`Office Directory ×${assignment.officeDirectory}`);

    const identifier = room.roomNumber ? `${room.roomNumber} ${room.roomName}` : room.roomName;
    const levelStr = room.level !== `Page ${room.pdfPage}` ? ` [${room.level}]` : "";
    const rulesStr = assignment.appliedRules.length > 0 ? ` → ${assignment.appliedRules.join(", ")}` : "";
    const exclusions = assignment.exclusionReasons.length > 0 ? ` (${assignment.exclusionReasons.join("; ")})` : "";
    const signsStr = signSummary.length > 0 ? ` | ${signSummary.join(", ")}` : " | no signs";

    const logEntry = `Room ${identifier}${levelStr}${rulesStr}${signsStr}${exclusions}`;
    decisionsLog.push(logEntry);

    if (assignment.ambiguous) {
      questionsForVerification.push(
        `${identifier}${levelStr}: ${assignment.ambiguityNote ?? "review required"}`,
      );
    }
  }

  // ── Step 5: Verification checks (R15-equivalent) ─────────────────────────
  const verificationErrors: string[] = [];

  const totalRoomsWithNoSigns = assignments.filter((a) =>
    !a.appliedRules.length && !a.exclusionReasons.length,
  ).length;
  if (totalRoomsWithNoSigns > 0) {
    verificationErrors.push(
      `${totalRoomsWithNoSigns} room(s) have no applied rules and no exclusion reason — verify completeness`,
    );
  }

  const stairAssignments = assignments.filter((a) => a.stairLanding !== null);
  if (stairAssignments.length === 0 && rooms.some((r) => r.isStair)) {
    verificationErrors.push("Stair rooms found but no stair landing signs assigned — verify R11");
  }

  const elevatorAssignments = assignments.filter((a) => a.inCaseOfFire !== null && a.inCaseOfFire > 0);
  const elevatorCount = rooms.filter((r) => r.isElevator).length;
  if (elevatorCount > 0 && elevatorAssignments.length === 0) {
    verificationErrors.push("Elevator rooms found but no In Case of Fire signs assigned — verify R12");
  }
  if (elevatorCount > 1 && elevatorAssignments.length > 1) {
    verificationErrors.push(
      `Multiple In Case of Fire signs assigned (${elevatorAssignments.length}) — R12 deduplication may be needed`,
    );
  }

  logger.info(
    {
      jobId,
      roomCount: rooms.length,
      assignmentCount: assignments.length,
      ambiguousCount: assignments.filter((a) => a.ambiguous).length,
      verificationErrors: verificationErrors.length,
    },
    "[RuleEngine] Rule application complete",
  );

  // ── Per-page marker audit log ─────────────────────────────────────────────
  // Emit one structured log entry per processed page listing:
  //   rooms_found   — how many rooms were extracted from that page
  //   signs_extracted — how many distinct sign-type assignments were made for those rooms
  //   markers_placed  — total sign quantity (sum of all assigned counts)
  // This lets operators identify pages where Collaboration Rooms (or any rooms)
  // were found but received no markers, without running a full re-scan.
  {
    const pageAudit = new Map<number, { rooms_found: number; signs_extracted: number; markers_placed: number }>();
    for (const room of rooms) {
      const entry = pageAudit.get(room.pdfPage) ?? { rooms_found: 0, signs_extracted: 0, markers_placed: 0 };
      entry.rooms_found++;
      pageAudit.set(room.pdfPage, entry);
    }
    for (const a of assignments) {
      const entry = pageAudit.get(a.pdfPage) ?? { rooms_found: 0, signs_extracted: 0, markers_placed: 0 };
      const signRows = assignmentToRows(a);
      entry.signs_extracted += signRows.length;
      entry.markers_placed += signRows.reduce((sum, r) => sum + r.quantity, 0);
      pageAudit.set(a.pdfPage, entry);
    }
    for (const [page, stats] of [...pageAudit.entries()].sort((a, b) => a[0] - b[0])) {
      logger.info(
        {
          jobId,
          page,
          rooms_found: stats.rooms_found,
          signs_extracted: stats.signs_extracted,
          markers_placed: stats.markers_placed,
        },
        "[RuleEngine] Per-page marker audit",
      );
    }
  }

  return {
    assignments,
    verificationErrors,
    decisionsLog,
    questionsForVerification,
    roomCount: rooms.length,
    rawStairCount,
    rawElevatorCount,
  };
}

// ── Sign type mapping helpers (for extractedSignsTable insertion) ─────────────

/**
 * Maps a SignAssignment to one or more InsertExtractedSign-compatible rows.
 * Each distinct sign type in the assignment becomes its own row.
 */
export interface SignRow {
  signType: string;
  signIdentifier: string;
  quantity: number;
  location: string;
  notes: string;
  pageNumber: number;
  confidenceScore: number;
  reviewFlag: boolean;
  extractionMethod: "rule_engine";
  placementSource: "rule_engine";
  exceptionReason: string | null;
  rawJson: Record<string, unknown>;
}

export function assignmentToRows(assignment: SignAssignment): SignRow[] {
  const rows: SignRow[] = [];

  const identifier =
    assignment.roomNumber ??
    assignment.roomName.toUpperCase().replace(/\s+/g, "_").slice(0, 40);
  const confidence = assignment.ambiguous ? 0.7 : 1.0;
  const reviewFlag = assignment.ambiguous;
  const baseRawJson: Record<string, unknown> = {
    appliedRules: assignment.appliedRules,
    exclusionReasons: assignment.exclusionReasons,
    level: assignment.level,
    ambiguous: assignment.ambiguous,
    ambiguityNote: assignment.ambiguityNote,
  };

  function push(signType: string, quantity: number, rule: string): void {
    rows.push({
      signType,
      signIdentifier: identifier,
      quantity,
      location: assignment.roomName,
      notes: `Rule engine: ${rule}`,
      pageNumber: assignment.pdfPage,
      confidenceScore: confidence,
      reviewFlag,
      extractionMethod: "rule_engine",
      placementSource: "rule_engine",
      exceptionReason: assignment.ambiguityNote,
      rawJson: { ...baseRawJson, rule },
    });
  }

  if (assignment.roomId && assignment.roomId > 0) {
    push("ROOM ID SIGN", assignment.roomId, "R1");
  }
  if (assignment.roomIdWithInsert && assignment.roomIdWithInsert > 0) {
    push("ROOM ID SIGN W/ INSERT", assignment.roomIdWithInsert, "R2");
  }
  if (assignment.restroom && assignment.restroom > 0) {
    push("RESTROOM SIGN", assignment.restroom, "R7/R8");
  }
  if (assignment.exit && assignment.exit > 0) {
    push("EXIT SIGN", assignment.exit, "R9");
  }
  if (assignment.maxOccupancy && assignment.maxOccupancy > 0) {
    push("MAX OCCUPANCY SIGN", assignment.maxOccupancy, "R10");
  }
  if (assignment.stairCorridor && assignment.stairCorridor > 0) {
    push("STAIR CORRIDOR SIGN", assignment.stairCorridor, "R11");
  }
  if (assignment.stairLanding && assignment.stairLanding > 0) {
    push("STAIR LANDING SIGN", assignment.stairLanding, "R11");
  }
  if (assignment.inCaseOfFire && assignment.inCaseOfFire > 0) {
    push("IN CASE OF FIRE SIGN", assignment.inCaseOfFire, "R12");
  }
  if (assignment.evacuationMap && assignment.evacuationMap > 0) {
    push("EVACUATION MAP", assignment.evacuationMap, "R13");
  }
  if (assignment.officeDirectory && assignment.officeDirectory > 0) {
    push("OFFICE DIRECTORY", assignment.officeDirectory, "R14");
  }

  return rows;
}
