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
import { OFFICE_TOKENS, SUITE_TOKENS } from "./room-classification-tokens";

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
  isOffice: boolean;
  isSuite: boolean;

  /** Occupant load carried from Phase 4 — used by R9/R10 to suppress ambiguity
   *  flags when occupant data is actually available. */
  occupantLoad: number | null;

  /** Door count carried from Phase 4 extraction — used by R2/R5/R11 to set
   *  the correct sign quantity when a drawing text hint is available.
   *  Null means no hint was found; the rule falls back to quantity=1. */
  doorCount: number | null;

  /** Zone qualifier inherited from a large-font zone label (e.g. "AREA A").
   *  Carried from Phase 4; used in decisionsLog and SignAssignment for
   *  location context in sign schedules. */
  zoneQualifier: string | null;

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

  // R5 — Office Room ID (per door; default 1 when door count unavailable)
  // R5 is satisfied by the standard roomId field — offices are handled the
  // same as R1 but with an explicit audit note when door count is assumed.

  // R6 — Suite ID (one sign at suite entry)
  suiteId: number | null;

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

  /** Zone qualifier from Phase 4 spatial anchors (e.g. "AREA A").
   *  Null when no zone anchor was close enough to this room.
   *  Intended for use in sign schedule location text columns. */
  zoneQualifier: string | null;
}

/**
 * Per-page summary emitted by the rule engine for Timeline display.
 */
export interface PageAuditEntry {
  page: number;
  rooms_found: number;
  signs_extracted: number;
  markers_placed: number;
  /** Names (and room numbers) of every room extracted from this page. */
  roomNames: string[];
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
  /** Per-page audit entries for Processing Timeline display. */
  pageAudit: PageAuditEntry[];
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
    isOffice: flags.isOffice || p4.isOffice,
    isSuite: flags.isSuite || p4.isSuite,
    occupantLoad: p4.occupantLoad,
    doorCount: p4.doorCount ?? null,
    zoneQualifier: p4.zoneQualifier ?? null,
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
/**
 * Storage/utility qualifier words that, when present alongside a collaboration
 * keyword, indicate the room is a storage or service space rather than a true
 * variable-use room (e.g. "Workshop Storage", "Collab Closet").
 * These are intentionally kept separate from MEP_TOKENS to avoid reclassifying
 * plain storage rooms as MEP-unoccupied, which would trigger the R15 mezzanine veto.
 */
const STORAGE_QUALIFIER_TOKENS = new Set([
  "storage", "storeroom", "closet", "supply", "supplies", "janitor", "jan",
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
// OFFICE_TOKENS and SUITE_TOKENS are imported from room-classification-tokens.ts
/**
 * Occupied-use tokens: rooms with any of these in their name are clearly
 * human-occupied spaces and must NOT trigger the R15 mezzanine MEP veto even
 * if Phase 4 mistakenly flagged them as isMepUnoccupied (e.g. "STORAGE").
 */
const OCCUPIED_USE_TOKENS = new Set([
  "office", "conference", "lobby", "reception", "waiting", "classroom",
  "training", "meeting", "breakout", "collaboration", "workspace", "workroom",
  "collab", "collaborative", "seminar", "lecture", "huddle", "flex",
]);
const ASSEMBLY_TOKENS = new Set([
  "worship", "sanctuary", "chapel", "auditorium", "fellowship",
  "cafeteria", "gymnasium", "gym", "ballroom", "banquet",
  "theater", "theatre", "amphitheater", "stage", "arena",
  "community", "multipurpose hall", "great hall", "grand hall",
]);

/** Appends a note to an existing ambiguity/audit note, joining with "; ".
 *  When existing is null or empty, returns note directly (no leading semicolon). */
function appendNote(existing: string | null, note: string): string {
  return existing ? `${existing}; ${note}` : note;
}

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
): Omit<RoomRecord, "roomNumber" | "roomName" | "level" | "pdfPage" | "sourceSheet" | "occupantLoad" | "doorCount" | "zoneQualifier"> {
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
  const isVariableUse =
    hasToken(VARIABLE_USE_TOKENS) &&
    !isAssembly &&
    !isMepUnoccupied &&
    !hasToken(STORAGE_QUALIFIER_TOKENS);

  // R5: Office rooms — detected by OFFICE_TOKENS but not restroom/stair/elevator/corridor
  const isOffice =
    hasToken(OFFICE_TOKENS) &&
    !isRestroom &&
    !isStair &&
    !isElevator &&
    !isCorridorOrHall &&
    !isMepUnoccupied;

  // R6: Suite rooms — detected by SUITE_TOKENS
  const isSuite = hasToken(SUITE_TOKENS) && !isRestroom && !isMepUnoccupied;

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
    isOffice,
    isSuite,
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
    suiteId: null,
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
    zoneQualifier: room.zoneQualifier,
  };

  const nameUpper = room.roomName.toUpperCase();
  // Tracks whether R15 near-veto fired: mezzanine room claimed as MEP by Phase 4
  // but lacking true MEP tokens.  When true, the generic MEP exclusion is skipped
  // and the room is treated as occupied for R1–R14.
  let isMepNearVeto = false;

  // ── R15 — Mezzanine exclusion (checked first as it vetoes everything) ──────
  if (room.isMezzanine && room.isMepUnoccupied) {
    // Hardened guard: require at least one true MEP token (mechanical, electrical,
    // etc.) AND absence of human-occupied-use tokens before firing the veto.
    // This prevents plain "STORAGE" on a mezzanine from triggering R15 when Phase 4
    // classified it as MEP due to its broad keyword list.
    const roomNameTokens = tokenize(room.roomName);
    const hasTrueMepToken = roomNameTokens.some((t) => MEP_TOKENS.has(t));
    const hasOccupiedUseToken = roomNameTokens.some((t) => OCCUPIED_USE_TOKENS.has(t));

    if (hasTrueMepToken && !hasOccupiedUseToken) {
      assignment.exclusionReasons.push("R15: mezzanine MEP unoccupied — all signs excluded");
      return assignment;
    } else {
      // Near-veto: isMepUnoccupied set by Phase 4 but Phase 5 name analysis
      // does not confirm true MEP use — log and continue with normal rules.
      isMepNearVeto = true;
      logger.info(
        { roomName: room.roomName, level: room.level, hasTrueMepToken, hasOccupiedUseToken },
        "[RuleEngine] R15 near-veto: mezzanine room classified MEP by Phase 4 but did not pass hardened MEP criteria — normal rules applied",
      );
      assignment.exclusionReasons.push(
        `R15-near-veto: mezzanine isMepUnoccupied=${room.isMepUnoccupied} but lacks true MEP tokens or has occupied-use tokens; normal rules applied`,
      );
    }
  }

  // ── R4 — Corridor exclusion ───────────────────────────────────────────────
  if (room.isCorridorOrHall) {
    assignment.roomId = 0;
    assignment.exclusionReasons.push("R4: is_corridor_or_hall");
    // Corridors can still get EXIT signs per R9 if they are exit-discharge corridors
    // (handled at job level; skip per-room R9 for plain corridors)
    return assignment;
  }

  // ── MEP / unoccupied room exclusion ──────────────────────────────────────
  // Non-mezzanine MEP/unoccupied rooms (mechanical, electrical, server rooms,
  // etc.) require no signage.  Mezzanine rooms that triggered the R15 near-veto
  // (isMepNearVeto=true) must NOT be excluded here — normal rules apply to them.
  if (room.isMepUnoccupied && !isMepNearVeto) {
    assignment.exclusionReasons.push("excluded: MEP/unoccupied — no signs required");
    return assignment;
  }

  // ── Vehicle bay exclusion ─────────────────────────────────────────────────
  if (room.isVehicleBay) {
    assignment.exclusionReasons.push("excluded: vehicle_bay — no signs required");
    return assignment;
  }

  // ── R2 — Variable use (takes priority over R1) ────────────────────────────
  if (room.isVariableUse) {
    // Variable-use rooms: Room ID with insert.
    // When a door count was extracted from drawing text, use it directly and
    // suppress the ambiguity flag. When unknown, default to 1 and flag for review.
    const r2Qty = room.doorCount ?? 1;
    assignment.roomIdWithInsert = r2Qty;
    assignment.roomId = 0;
    assignment.appliedRules.push("R2");
    if (room.doorCount != null) {
      // Door count known from drawing — no ambiguity
      assignment.ambiguityNote =
        `R2: variable-use room — quantity ${r2Qty} from extracted door count`;
    } else {
      // Default of 1 is the conservative assumption; record as audit note,
      // not as ambiguity (reviewer can verify without blocking production).
      assignment.ambiguityNote =
        "R2: variable-use room — quantity 1 assumed (no door count in drawings; verify egress count)";
    }
  } else if ((room.isOccupied || isMepNearVeto) && !room.isVehicleBay) {
    // ── R1 — Room ID default ────────────────────────────────────────────────
    // Restrooms, stairs, and elevators get their own specialized signs below,
    // not a generic Room ID sign.
    // isMepNearVeto: mezzanine falsely flagged as MEP by Phase 4 — treat as occupied.
    if (!room.isRestroom && !room.isStair && !room.isElevator) {
      assignment.roomId = 1;
      assignment.appliedRules.push("R1");
    }
  }

  // R3 — Multi-entry large rooms: flag as ambiguous since we can't count doors
  // without Phase 4. When doorCount is available, use it and suppress ambiguity.
  if (!room.isVariableUse && room.isAssembly) {
    if (assignment.roomId !== null && assignment.roomId > 0) {
      if (room.doorCount != null) {
        assignment.roomId = room.doorCount;
        assignment.ambiguityNote =
          `R3: assembly space — quantity ${room.doorCount} from extracted door count`;
      } else {
        assignment.ambiguous = true;
        assignment.ambiguityNote =
          "R3 candidate: assembly space may have multiple entry doors — verify door count for quantity";
      }
    }
  }

  // ── R5 — Office Room ID ──────────────────────────────────────────────────
  // Offices receive one Room ID sign per entry door. When a door count was
  // extracted from drawing text, use it directly (no ambiguity flag).
  // When unknown, default to 1 and record an audit assumption (NOT an
  // ambiguity flag, per the task specification).
  // R1 already assigns roomId=1 for generic occupied rooms; for isOffice rooms
  // we confirm this via R5 and update the quantity if doorCount is available.
  if (room.isOffice && assignment.roomId !== null && assignment.roomId > 0) {
    // Replace R1 attribution with explicit R5
    const r1idx = assignment.appliedRules.indexOf("R1");
    if (r1idx !== -1) assignment.appliedRules[r1idx] = "R5";
    else assignment.appliedRules.push("R5");
    // Apply doorCount if available, else default to 1 with an assumption note
    if (room.doorCount != null) {
      assignment.roomId = room.doorCount;
      if (!assignment.ambiguityNote?.includes("R5")) {
        assignment.ambiguityNote = appendNote(
          assignment.ambiguityNote,
          `R5: office Room ID quantity ${room.doorCount} from extracted door count`,
        );
      }
    } else {
      // Record as assumption (not ambiguity) since 1-door default is defensible
      if (!assignment.ambiguityNote?.includes("R5")) {
        assignment.ambiguityNote = appendNote(
          assignment.ambiguityNote,
          "R5: office Room ID quantity assumes 1 door — verify if multi-entry",
        );
      }
    }
  }

  // ── R6 — Suite ID ────────────────────────────────────────────────────────
  // Each suite receives one Suite ID sign at its entry point.
  // Business rule: suiteId coexists with roomId (R1) — both signs are emitted.
  // If policy changes to suite-only (R6 replaces R1), add `!room.isSuite` to the
  // R1 guard above and remove this note.  Pending client confirmation (Task #522).
  if (room.isSuite) {
    assignment.suiteId = 1;
    if (!assignment.appliedRules.includes("R6")) assignment.appliedRules.push("R6");
    // Assumption: one entry — record in audit log, not as ambiguity
    const suiteNote = "R6: suite ID assigned with default quantity 1 — verify entry door count";
    if (!assignment.ambiguityNote?.includes("R6")) {
      assignment.ambiguityNote = appendNote(assignment.ambiguityNote, suiteNote);
    }
  }

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
      assignment.ambiguityNote = appendNote(
        assignment.ambiguityNote,
        "R7/R8: no matching plaque table entry — type unknown (verify plaque selection)",
      );
    }
    // Restrooms do NOT get a generic Room ID sign (R1 already skipped above)
  }

  // ── R9 — EXIT plaque ───────────────────────────────────────────────────────
  // 1 EXIT at each exit-discharge vestibule
  // 1 EXIT at public lobby with exit door
  // For assembly rooms: count = required exits per IBC 1006.2.1.
  // When occupant load is available (from Phase 4 Gemini enrichment), use the
  // most conservative applicable rule and suppress the ambiguity flag.
  if (exitDischargeVestibules.has(room.roomName.toLowerCase())) {
    assignment.exit = 1;
    assignment.appliedRules.push("R9");
  } else if (room.isPublicFacing && (nameUpper.includes("LOBBY") || nameUpper.includes("VESTIBULE") || nameUpper.includes("FOYER"))) {
    assignment.exit = 1;
    assignment.appliedRules.push("R9");
  } else if (room.isAssembly) {
    // Assembly: IBC 1006.2.1 requires exits based on occupant load.
    // Conservative non-ambiguous default is 2 exits (minimum per IBC 1004.1).
    // When occupant load is known, apply the exact IBC requirement.
    // When unknown, keep 2-exit default with an audit note (not ambiguous=true)
    // since 2 is the most conservative allowed minimum.
    assignment.exit = 2;
    assignment.appliedRules.push("R9");
    if (room.occupantLoad != null) {
      // Occupant load known — scale exits per IBC 1006.2.1
      if (room.occupantLoad >= 1000) assignment.exit = 4;
      else if (room.occupantLoad >= 500) assignment.exit = 3;
      // else: 2 exits (already set above)
    } else {
      // No occupant load — 2-exit conservative default; audit note for reviewer
      assignment.ambiguityNote = appendNote(
        assignment.ambiguityNote,
        "R9: assembly exit quantity 2 assumed (IBC 1004.1 minimum; verify per 1006.2.1 when load known)",
      );
    }
  } else if ((room.isOccupied || isMepNearVeto) && !room.isCorridorOrHall && !room.isVehicleBay) {
    // Non-assembly occupied rooms with exterior doors: conservative rule = 1 exit plaque
    // (only applies when room has an exterior exit indicator in its name)
    if (nameUpper.includes("EXIT") || nameUpper.includes("DISCHARGE")) {
      assignment.exit = 1;
      assignment.appliedRules.push("R9");
    }
  }

  // ── R10 — Capacity sign ──────────────────────────────────────────────────
  if (room.isAssembly) {
    // Assembly spaces with occupancy group A-2/A-3 or occupant load >= 50 require
    // a posted capacity sign. When occupant load is available, use it directly.
    assignment.maxOccupancy = 1;
    assignment.appliedRules.push("R10");
    if (room.occupantLoad == null) {
      assignment.ambiguous = true;
      if (!assignment.ambiguityNote?.includes("R10:")) {
        assignment.ambiguityNote = appendNote(
          assignment.ambiguityNote,
          "R10: capacity sign — verify occupant load (≥50 required for A-2/A-3)",
        );
      }
    }
    // If occupant load is known, assign without ambiguity (load already confirmed ≥50
    // because isAssembly = true when occupantLoad ≥ 50 from Phase 4)
  }

  // ── R11 — Stair plaques per level ────────────────────────────────────────
  if (room.isStair) {
    // stairCorridor = count of corridor entry doors at this level.
    // When a door count was extracted from drawing text, use it directly
    // and suppress the ambiguity flag. Otherwise default to 1 and flag.
    const r11DoorQty = room.doorCount ?? 1;
    assignment.stairCorridor = r11DoorQty;
    assignment.stairLanding = 1;
    assignment.appliedRules.push("R11");
    if (room.doorCount != null) {
      assignment.ambiguityNote = appendNote(
        assignment.ambiguityNote,
        `R11: stair corridor quantity ${r11DoorQty} from extracted door count`,
      );
    } else {
      // Default of 1 is the conservative assumption per IBC; record as audit
      // note rather than blocking ambiguity — reviewer can confirm door count.
      assignment.ambiguityNote = appendNote(
        assignment.ambiguityNote,
        "R11: stair corridor quantity 1 assumed (no door count in drawings; verify)",
      );
    }
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
  // 1 × at EVERY lobby / main-entry / atrium on a level.
  // IBC and ADA guidance requires a directory at each accessible building entry;
  // a multi-lobby level (e.g. east wing + west wing) needs one at each lobby.
  if (nameUpper.includes("LOBBY") || nameUpper.includes("MAIN ENTRY") || nameUpper.includes("ATRIUM")) {
    assignment.officeDirectory = 1;
    assignment.appliedRules.push("R14");
  }

  // Final: rooms that got nothing (isOccupied but excluded by room type checks)
  // should still be tracked with an explicit typed reason for the audit log.
  if (
    !room.isRestroom &&
    !room.isStair &&
    !room.isElevator &&
    !room.isCorridorOrHall &&
    !room.isMepUnoccupied &&
    !room.isVehicleBay &&
    assignment.roomId === null &&
    assignment.roomIdWithInsert === null &&
    assignment.suiteId === null
  ) {
    // Unusual case: occupied room that didn't get a sign — flag for review
    assignment.ambiguous = true;
    assignment.ambiguityNote =
      "NO_RULE_MATCH — verify room type and classification";
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

// ── Typed zero-sign reason codes ─────────────────────────────────────────────

/**
 * Typed reason codes for rooms that received zero signs.
 * These are surfaced in the per-job questionsForVerification list so reviewers
 * can act on them by category without reading every individual log entry.
 */
export type ZeroSignReason =
  | "VETOED_MEP"            // non-mezzanine MEP/unoccupied room — no signs required
  | "VETOED_MEZZANINE"      // R15 fired: mezzanine MEP room, all signs excluded
  | "EXPLICIT_EXCLUSION"    // explicitly excluded room type (corridor, vehicle bay, etc.)
  | "NO_RULE_MATCH"         // occupied room but no rule produced a sign
  | "CLASSIFICATION_FAILURE"// no flags derived from room name
  | "EXTRACTION_MISS";      // ambiguous extraction — may not be a real room

/**
 * A zero-sign room entry included in the questionsForVerification list.
 */
export interface ZeroSignRoom {
  roomName: string;
  roomNumber: string | null;
  level: string;
  pdfPage: number;
  reason: ZeroSignReason;
  detail: string;
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

  // ── Step 3b: Staff-only restroom resolution ──────────────────────────────
  // Phase 4 (room-inventory.ts) now runs a geometric k-nearest detection using
  // boundingBox centroids and surfaces the result via p4.isStaffOnly, which
  // bridgeInventoryRoom already ORs into isStaffOnlyRestroom above.
  // This Phase 5 pass handles rooms whose Phase 4 boundingBox was unavailable
  // (e.g. AI-enriched rooms without text-layer positions) by applying a
  // level-cluster fallback: if every non-restroom room on the same level is
  // an explicit office or back-of-house type (no public or assembly rooms),
  // classify the restroom as staff-only.  This is more conservative than the
  // prior implementation — only explicit office/MEP/service types pass through.
  const roomsByLevel = new Map<string, RoomRecord[]>();
  for (const room of rooms) {
    const existing = roomsByLevel.get(room.level) ?? [];
    existing.push(room);
    roomsByLevel.set(room.level, existing);
  }

  for (const room of rooms) {
    if (!room.isRestroom || room.isStaffOnlyRestroom) continue;
    const levelRooms = roomsByLevel.get(room.level) ?? [];
    const nonRestroomRooms = levelRooms.filter((r) => !r.isRestroom);
    if (nonRestroomRooms.length === 0) continue;

    const hasPublicOrAssembly = nonRestroomRooms.some(
      (r) => r.isPublicFacing || r.isAssembly,
    );
    // Stricter than the prior heuristic: only explicit office or back-of-house
    // types qualify.  Variable-use, generic occupied rooms, and classifyRoom
    // fallthrough rooms do NOT qualify, preventing overclassification on
    // mixed-use floors with unlabelled spaces.
    const hasOnlyExplicitBackOfHouse = nonRestroomRooms.every(
      (r) =>
        r.isOffice ||
        r.isMepUnoccupied ||
        r.isVehicleBay ||
        r.isCorridorOrHall ||
        r.isStair ||
        r.isElevator,
    );

    if (!hasPublicOrAssembly && hasOnlyExplicitBackOfHouse) {
      room.isStaffOnlyRestroom = true;
      room.isPublicFacing = false;
      logger.info(
        { roomName: room.roomName, level: room.level },
        "[RuleEngine] Staff-only restroom detected via level-cluster fallback (no bounding box in Phase 4)",
      );
    }
  }

  // ── Step 4: Apply rules R1-R15 to each room ──────────────────────────────
  const assignments: SignAssignment[] = [];
  const decisionsLog: string[] = [];
  const questionsForVerification: string[] = [];
  const zeroSignRooms: ZeroSignRoom[] = [];

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
    if (assignment.suiteId && assignment.suiteId > 0) signSummary.push(`Suite ID ×${assignment.suiteId}`);
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
    const zoneStr = room.zoneQualifier ? ` {zone: ${room.zoneQualifier}}` : "";
    const rulesStr = assignment.appliedRules.length > 0 ? ` → ${assignment.appliedRules.join(", ")}` : "";
    const exclusions = assignment.exclusionReasons.length > 0 ? ` (${assignment.exclusionReasons.join("; ")})` : "";
    const signsStr = signSummary.length > 0 ? ` | ${signSummary.join(", ")}` : " | no signs";

    const logEntry = `Room ${identifier}${levelStr}${zoneStr}${rulesStr}${signsStr}${exclusions}`;
    decisionsLog.push(logEntry);

    if (assignment.ambiguous) {
      questionsForVerification.push(
        `${identifier}${levelStr}: ${assignment.ambiguityNote ?? "review required"}`,
      );
    } else if (assignment.ambiguityNote) {
      // Non-blocking audit note — surfaced for reviewers but does not flag room
      questionsForVerification.push(
        `[AUDIT_ASSUMPTION] ${identifier}${levelStr}: ${assignment.ambiguityNote}`,
      );
    }

    // ── Typed zero-sign reason codes ────────────────────────────────────────
    const hasAnySigns = signSummary.length > 0;
    if (!hasAnySigns) {
      let reason: ZeroSignReason;
      let detail: string;

      if (assignment.exclusionReasons.some((r) => r.startsWith("R15: mezzanine"))) {
        reason = "VETOED_MEZZANINE";
        detail = "R15 mezzanine MEP veto — all signs excluded for this unoccupied mezzanine room";
      } else if (assignment.exclusionReasons.some((r) => r.includes("MEP") || r.includes("unoccupied"))) {
        reason = "VETOED_MEP";
        detail = "MEP/unoccupied room — no signs required per building code";
      } else if (assignment.exclusionReasons.some((r) => r.includes("R4:") || r.includes("vehicle_bay"))) {
        reason = "EXPLICIT_EXCLUSION";
        detail = assignment.exclusionReasons.find((r) => r.includes("R4:") || r.includes("vehicle_bay"))
          ?? "Explicitly excluded room type — no signs required";
      } else if (assignment.ambiguityNote?.includes("NO_RULE_MATCH")) {
        reason = "NO_RULE_MATCH";
        detail = assignment.ambiguityNote ?? "No matching rule for this room type";
      } else if (!room.isMepUnoccupied && !room.isCorridorOrHall && !room.isVehicleBay) {
        reason = "CLASSIFICATION_FAILURE";
        detail = "Room had no flags derived from its name — likely an unusual abbreviation or label";
      } else {
        reason = "EXTRACTION_MISS";
        detail = "Room may be a false-positive extraction or label fragment";
      }

      zeroSignRooms.push({
        roomName: room.roomName,
        roomNumber: room.roomNumber,
        level: room.level,
        pdfPage: room.pdfPage,
        reason,
        detail,
      });
    }
  }

  // Append zero-sign rooms grouped by reason to questionsForVerification
  if (zeroSignRooms.length > 0) {
    const byReason = new Map<ZeroSignReason, ZeroSignRoom[]>();
    for (const z of zeroSignRooms) {
      const group = byReason.get(z.reason) ?? [];
      group.push(z);
      byReason.set(z.reason, group);
    }
    for (const [reason, items] of byReason) {
      const names = items.map((z) => z.roomName + (z.roomNumber ? ` (${z.roomNumber})` : "")).join(", ");
      questionsForVerification.push(
        `[${reason}] ${items.length} room(s) received zero signs — ${names}`,
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
  //   roomNames       — display label for each room on this page
  // This lets operators identify pages where Collaboration Rooms (or any rooms)
  // were found but received no markers, without running a full re-scan.
  const pageAuditMap = new Map<number, { rooms_found: number; signs_extracted: number; markers_placed: number; roomNames: string[] }>();
  for (const room of rooms) {
    const entry = pageAuditMap.get(room.pdfPage) ?? { rooms_found: 0, signs_extracted: 0, markers_placed: 0, roomNames: [] };
    entry.rooms_found++;
    const label = room.roomNumber ? `${room.roomNumber} ${room.roomName}` : room.roomName;
    entry.roomNames.push(label);
    pageAuditMap.set(room.pdfPage, entry);
  }
  for (const a of assignments) {
    const entry = pageAuditMap.get(a.pdfPage) ?? { rooms_found: 0, signs_extracted: 0, markers_placed: 0, roomNames: [] };
    const signRows = assignmentToRows(a);
    entry.signs_extracted += signRows.length;
    entry.markers_placed += signRows.reduce((sum, r) => sum + r.quantity, 0);
    pageAuditMap.set(a.pdfPage, entry);
  }
  const pageAudit: PageAuditEntry[] = [...pageAuditMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([page, stats]) => ({ page, ...stats }));

  for (const entry of pageAudit) {
    logger.info(
      {
        jobId,
        page: entry.page,
        rooms_found: entry.rooms_found,
        signs_extracted: entry.signs_extracted,
        markers_placed: entry.markers_placed,
      },
      "[RuleEngine] Per-page marker audit",
    );
  }

  return {
    assignments,
    verificationErrors,
    decisionsLog,
    questionsForVerification,
    roomCount: rooms.length,
    rawStairCount,
    rawElevatorCount,
    pageAudit,
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

  // When a room has no number, append the zone qualifier so fabricators can
  // locate it on the plan (e.g. "LOBBY [AREA A]" instead of just "LOBBY").
  const baseSlug = assignment.roomName.toUpperCase().replace(/\s+/g, "_").slice(0, 40);
  const identifier =
    assignment.roomNumber ??
    (assignment.zoneQualifier
      ? `${baseSlug.slice(0, 32)} [${assignment.zoneQualifier}]`
      : baseSlug);

  // The human-readable location always includes the zone qualifier when known.
  const location = assignment.zoneQualifier
    ? `${assignment.roomName} — ${assignment.zoneQualifier}`
    : assignment.roomName;

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
      location,
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
  if (assignment.suiteId && assignment.suiteId > 0) {
    push("SUITE ID SIGN", assignment.suiteId, "R6");
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
