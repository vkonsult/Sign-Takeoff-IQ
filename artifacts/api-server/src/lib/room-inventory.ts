/**
 * room-inventory.ts — Converts HeuristicSignInsert rows into structured
 * RoomInventory objects carrying 11 typed boolean flags.
 *
 * This is the data foundation consumed by the rules engine (Task 2) and the
 * occupant-loads enrichment step (Task 3).  occupantLoad / occupancyGroup are
 * intentionally left null here and filled in by Task 3.
 */

import type { HeuristicSignInsert } from "./extraction-heuristic.js";

// ── Public interfaces ─────────────────────────────────────────────────────────

export interface RoomLabel {
  roomNumber: string;
  roomName: string;
  level: string;
  sheetId: string;
  pdfPage: number;
  coords: { x: number; y: number };
}

export interface RoomInventory extends RoomLabel {
  occupantLoad: number | null;
  occupancyGroup: string | null;
  flags: {
    isRestroom: boolean;
    isStair: boolean;
    isElevator: boolean;
    isVestibule: boolean;
    isCorridorOrHall: boolean;
    isVehicleBay: boolean;
    isMepUnoccupied: boolean;
    isVariableUse: boolean;
    isPublicFacing: boolean;
    isStaffOnly: boolean;
    isAssembly: boolean;
  };
}

// ── Keyword sets ──────────────────────────────────────────────────────────────

const RESTROOM_KEYWORDS = [
  "TOILET",
  "BATH",
  "SHOWER",
  "WC",
  "RESTROOM",
  "LAVATORY",
] as const;

const ELEVATOR_KEYWORDS = ["ELEV", "ELEVATOR"] as const;

const VESTIBULE_KEYWORDS = ["VEST", "VESTIBULE"] as const;

const CORRIDOR_HALL_KEYWORDS = [
  "HALL",
  "CORR",
  "CORRIDOR",
  "LOBBY",
  "FOYER",
] as const;

const VEHICLE_BAY_KEYWORDS = [
  "APPARATUS",
  "VEHICLE BAY",
  "SALLY PORT",
  "GARAGE",
] as const;

const MEP_UNOCCUPIED_KEYWORDS = [
  "MECHANICAL",
  "ELECTRICAL",
  "TELECOM",
  "JANITOR",
  "STORAGE",
  "RISER",
] as const;

const VARIABLE_USE_KEYWORDS = [
  "TRAINING",
  "COMMUNITY",
  "EOC",
  "MULTIPURPOSE",
] as const;

const PUBLIC_FACING_KEYWORDS = [
  "LOBBY",
  "RECEPTION",
  "WAITING",
  "ENTRY",
] as const;

// ── Helpers ───────────────────────────────────────────────────────────────────

function upper(text: string): string {
  return text.toUpperCase();
}

function containsAny(text: string, keywords: readonly string[]): boolean {
  const u = upper(text);
  return keywords.some((kw) => u.includes(kw));
}

function startsWithPrefix(text: string, prefix: string): boolean {
  return upper(text).trimStart().startsWith(prefix);
}

// ── Flag derivation ───────────────────────────────────────────────────────────

function deriveFlags(
  location: string,
  occupantLoad: number | null,
  occupancyGroup: string | null,
): RoomInventory["flags"] {
  const isRestroom = containsAny(location, RESTROOM_KEYWORDS);

  const isStair = startsWithPrefix(location, "STAIR");

  const isElevator = containsAny(location, ELEVATOR_KEYWORDS);

  const isVestibule = containsAny(location, VESTIBULE_KEYWORDS);

  const isCorridorOrHall = containsAny(location, CORRIDOR_HALL_KEYWORDS);

  const isVehicleBay = containsAny(location, VEHICLE_BAY_KEYWORDS);

  const isMepUnoccupied = containsAny(location, MEP_UNOCCUPIED_KEYWORDS);

  const isVariableUse = containsAny(location, VARIABLE_USE_KEYWORDS);

  const isPublicFacing = containsAny(location, PUBLIC_FACING_KEYWORDS);

  const isStaffOnly = upper(location).includes("STAFF");

  const isAssembly =
    (occupancyGroup != null &&
      (occupancyGroup.toUpperCase().startsWith("A-2") ||
        occupancyGroup.toUpperCase().startsWith("A-3"))) ||
    (occupantLoad != null && occupantLoad >= 50);

  return {
    isRestroom,
    isStair,
    isElevator,
    isVestibule,
    isCorridorOrHall,
    isVehicleBay,
    isMepUnoccupied,
    isVariableUse,
    isPublicFacing,
    isStaffOnly,
    isAssembly,
  };
}

// ── Builder function ──────────────────────────────────────────────────────────

/**
 * Converts an array of HeuristicSignInsert rows into RoomInventory objects.
 *
 * @param rows   Output of the heuristic extractor.
 * @param level  Optional floor/level label (e.g. "LEVEL 1").  Falls back to
 *               an empty string when omitted; the occupant-loads step (Task 3)
 *               will fill this in from the PDF page metadata.
 */
export function buildRoomInventory(
  rows: HeuristicSignInsert[],
  level = "",
): RoomInventory[] {
  return rows.map((row) => {
    const occupantLoad: number | null = null;
    const occupancyGroup: string | null = null;

    return {
      roomNumber: row.signIdentifier,
      roomName: row.location,
      level,
      sheetId: "",
      pdfPage: row.pageNumber,
      coords: {
        x: Math.round(row.xPos * 1000),
        y: Math.round(row.yPos * 1000),
      },
      occupantLoad,
      occupancyGroup,
      flags: deriveFlags(row.location, occupantLoad, occupancyGroup),
    };
  });
}
