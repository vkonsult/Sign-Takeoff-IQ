/**
 * Rules Engine R1–R15
 *
 * Takes RoomInventory[] and produces TakeoffEntry[] — one entry per required sign.
 * Pure TypeScript; no database or network I/O.
 */

// ─── Interfaces ──────────────────────────────────────────────────────────────

export interface RoomInventory {
  roomNumber: string;
  roomName: string;
  level: string;
  pageNumber: number;
  coords?: { x: number; y: number };
  occupantLoad?: number;
  // 11 typed boolean flags
  isCorridor: boolean;
  isBay: boolean;
  isMepUnoccupied: boolean;
  isStairwell: boolean;
  isElevator: boolean;
  isVariableUse: boolean;
  isAssembly: boolean;
  isRestroom: boolean;
  isVestibule: boolean;
  isPublicCorridor: boolean;
  isOccupied: boolean;
  // Restroom sub-variant (not part of the 11 boolean flags)
  restroomVariant?: "mens" | "womens" | "unisex" | "family" | "mothers";
}

export interface TakeoffEntry {
  signType: string;
  qty: number;
  ruleRef: string;
  color: string;
  plaqueTypeId?: string;
  roomNumber: string;
  roomName: string;
  level: string;
  pageNumber: number;
  coords?: { x: number; y: number };
}

export interface PlaqueSchedule {
  plaques: Array<{
    type_id: string;
    name: string;
    braille: boolean;
    insert: boolean;
    letter_height: string | null;
    trigger: string;
  }>;
}

// ─── Rule colours (hex) ───────────────────────────────────────────────────────

const RULE_COLORS: Record<string, string> = {
  R1: "#6B7280",
  R2: "#F59E0B",
  R3: "#EC4899",
  R4: "#EC4899",
  R5: "#EC4899",
  R6: "#EC4899",
  R7: "#EC4899",
  R8: "#EC4899",
  R9: "#EF4444",
  R10: "#DC2626",
  R11: "#8B5CF6",
  R12: "#3B82F6",
  R13: "#10B981",
  R14: "#F97316",
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function entry(
  partial: Pick<TakeoffEntry, "signType" | "ruleRef"> &
    Partial<TakeoffEntry> &
    Pick<RoomInventory, "roomNumber" | "roomName" | "level" | "pageNumber"> & {
      coords?: { x: number; y: number };
    }
): TakeoffEntry {
  return {
    qty: 1,
    color: RULE_COLORS[partial.ruleRef] ?? "#6B7280",
    ...partial,
  };
}

function isExcluded(room: RoomInventory): boolean {
  return (
    room.isMepUnoccupied ||
    room.isStairwell ||
    room.isElevator ||
    room.isCorridor ||
    room.isBay
  );
}

// ─── Restroom variant selector ────────────────────────────────────────────────

export function selectRestroomVariant(
  room: RoomInventory,
  plaqueSchedule?: PlaqueSchedule
): { signType: string; ruleRef: string; plaqueTypeId?: string } {
  const variant = room.restroomVariant;

  if (plaqueSchedule) {
    const matched = plaqueSchedule.plaques.find(
      (p) =>
        p.trigger === variant ||
        p.trigger === "restroom" ||
        p.name.toLowerCase().includes(variant ?? "restroom")
    );
    if (matched) {
      return {
        signType: matched.name,
        ruleRef: variantToRuleRef(variant),
        plaqueTypeId: matched.type_id,
      };
    }
  }

  switch (variant) {
    case "mens":
      return { signType: "Men's Restroom", ruleRef: "R3" };
    case "womens":
      return { signType: "Women's Restroom", ruleRef: "R4" };
    case "unisex":
      return { signType: "Unisex Restroom", ruleRef: "R5" };
    case "family":
      return { signType: "Family Restroom", ruleRef: "R6" };
    case "mothers":
      return { signType: "Mother's Room", ruleRef: "R7" };
    default:
      return { signType: "Restroom", ruleRef: "R8" };
  }
}

function variantToRuleRef(variant?: string): string {
  switch (variant) {
    case "mens":
      return "R3";
    case "womens":
      return "R4";
    case "unisex":
      return "R5";
    case "family":
      return "R6";
    case "mothers":
      return "R7";
    default:
      return "R8";
  }
}

// ─── Per-room rule application ────────────────────────────────────────────────

export function applyRules(
  room: RoomInventory,
  plaqueSchedule?: PlaqueSchedule
): TakeoffEntry[] {
  const entries: TakeoffEntry[] = [];

  const base = {
    roomNumber: room.roomNumber,
    roomName: room.roomName,
    level: room.level,
    pageNumber: room.pageNumber,
    coords: room.coords,
  };

  // R15 — Hard exclusion for MEP / unoccupied rooms
  if (room.isMepUnoccupied) {
    return [];
  }

  // R8 — Restroom (dispatched by selectRestroomVariant; R3–R7 handled inside)
  if (room.isRestroom) {
    const { signType, ruleRef, plaqueTypeId } = selectRestroomVariant(
      room,
      plaqueSchedule
    );
    entries.push(
      entry({ ...base, signType, ruleRef, ...(plaqueTypeId ? { plaqueTypeId } : {}) })
    );
    // Restroom rooms do not receive a plain Room ID sign — return early.
    return entries;
  }

  // R1 — Default Room ID for every occupied, non-excluded room
  if (!isExcluded(room)) {
    if (room.isOccupied || (!room.isCorridor && !room.isBay)) {
      // R2 — Variable-use room: upgrade to "Room ID w/ Insert"
      if (room.isVariableUse) {
        const qty = room.isAssembly ? 2 : 1;
        entries.push(
          entry({ ...base, signType: "Room ID w/ Insert", ruleRef: "R2", qty })
        );
      } else {
        entries.push(entry({ ...base, signType: "Room ID", ruleRef: "R1" }));
      }
    }
  }

  // R9 — Exit sign
  if (room.isVestibule) {
    entries.push(entry({ ...base, signType: "Exit Sign", ruleRef: "R9", qty: 2 }));
  } else if (room.isAssembly && (room.occupantLoad ?? 0) >= 50) {
    entries.push(entry({ ...base, signType: "Exit Sign", ruleRef: "R9", qty: 2 }));
  } else if (room.isAssembly || room.isVestibule) {
    entries.push(entry({ ...base, signType: "Exit Sign", ruleRef: "R9" }));
  }

  // R10 — Max Occupancy placard for assembly rooms
  if (room.isAssembly) {
    entries.push(
      entry({ ...base, signType: "Max Occupancy Placard", ruleRef: "R10" })
    );
  }

  // R14 — Office Directory for public-facing corridors / halls
  if (room.isPublicCorridor) {
    entries.push(entry({ ...base, signType: "Office Directory", ruleRef: "R14" }));
  }

  return entries;
}

// ─── Stair rules (R11) ────────────────────────────────────────────────────────

export function applyStairRules(
  stairs: RoomInventory[],
  levels: string[]
): TakeoffEntry[] {
  const entries: TakeoffEntry[] = [];

  for (const stair of stairs) {
    for (const level of levels) {
      // Two faces per level per stairwell
      entries.push(
        entry({
          signType: "Stairwell Sign",
          ruleRef: "R11",
          roomNumber: stair.roomNumber,
          roomName: stair.roomName,
          level,
          pageNumber: stair.pageNumber,
          coords: stair.coords,
          qty: 2,
        })
      );
    }
  }

  return entries;
}

// ─── Elevator rules (R12) ─────────────────────────────────────────────────────

export function applyElevatorRules(elevators: RoomInventory[]): TakeoffEntry[] {
  return elevators.map((elev) =>
    entry({
      signType: "Elevator Sign",
      ruleRef: "R12",
      roomNumber: elev.roomNumber,
      roomName: elev.roomName,
      level: elev.level,
      pageNumber: elev.pageNumber,
      coords: elev.coords,
    })
  );
}

// ─── Evac map rules (R13) ─────────────────────────────────────────────────────

/**
 * R13 — One evac map per floor at the main exit stairwell.
 * Picks the first stairwell found on each level as the "main exit stairwell".
 */
export function applyEvacMapRules(stairs: RoomInventory[]): TakeoffEntry[] {
  const seenLevels = new Set<string>();
  const entries: TakeoffEntry[] = [];

  for (const stair of stairs) {
    if (!seenLevels.has(stair.level)) {
      seenLevels.add(stair.level);
      entries.push(
        entry({
          signType: "Evacuation Map",
          ruleRef: "R13",
          roomNumber: stair.roomNumber,
          roomName: stair.roomName,
          level: stair.level,
          pageNumber: stair.pageNumber,
          coords: stair.coords,
        })
      );
    }
  }

  return entries;
}

// ─── buildRoomInventory ───────────────────────────────────────────────────────

/**
 * Converts extracted_signs rows into RoomInventory objects.
 * Groups rows by location (room number), then infers room-type flags from
 * the location name and sign types present in the group.
 */
export function buildRoomInventory(
  rows: Array<{
    location: string | null;
    signType: string | null;
    signIdentifier: string | null;
    pageNumber: number | null;
    xPos: number | null;
    yPos: number | null;
    sheetNumber: string | null;
    messageContent: string | null;
    notes: string | null;
    quantity: number | null;
  }>
): RoomInventory[] {
  type GroupRow = typeof rows[number];

  // Group by (location, level) — rooms with the same name on different floors
  // are distinct inventory entries. Level is inferred before grouping so that
  // stairwells, elevators, and repeated room numbers on multiple levels each
  // produce their own RoomInventory item (critical for R11 / R13 accuracy).
  const groups = new Map<string, GroupRow[]>();

  for (const row of rows) {
    const locKey = (row.location ?? "UNKNOWN").trim().toUpperCase();
    const level = inferLevel(row.sheetNumber, row.pageNumber);
    const key = `${locKey}\x00${level}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }

  const inventories: RoomInventory[] = [];

  for (const [roomKey, group] of groups.entries()) {
    const representative = group[0];
    const signTypes = group.map((r) => (r.signType ?? "").toUpperCase());
    // Composite key is "LOCATION\x00LEVEL" — split it back out.
    const [locationUpper, level] = roomKey.split("\x00") as [string, string];
    const roomName = inferRoomName(locationUpper, signTypes);
    const restroomVariant = inferRestroomVariant(locationUpper, signTypes);

    const isCorridor =
      /CORR(?:IDOR)?|HALL(?:WAY)?|LOBBY|FOYER/.test(locationUpper) &&
      !restroomVariant;
    const isBay = /\bBAY\b/.test(locationUpper);
    const isMepUnoccupied =
      /\b(?:MEP|MECHANICAL|ELECTRICAL|PLUMBING|TELECOM|IT ROOM|JANITOR|STORAGE|UTILITY|EQUIP(?:MENT)?)\b/.test(
        locationUpper
      );
    const isStairwell =
      /\b(?:STAIR(?:WELL)?|STAIR #?\d|STAIRCASE)\b/.test(locationUpper) ||
      signTypes.some((s) => s.includes("STAIRWELL") || s.includes("STAIR SIGN"));
    const isElevator =
      /\bELEVATOR\b/.test(locationUpper) ||
      signTypes.some((s) => s.includes("ELEVATOR"));
    const isVariableUse =
      /\b(?:MULTI.?PURPOSE|FLEX|VARIABLE|CONF(?:ERENCE)?|TRAINING|CLASSROOM|SEMINAR)\b/.test(
        locationUpper
      );
    const isAssembly =
      /\b(?:ASSEMBLY|AUDITORIUM|CHAPEL|SANCTUARY|GYMNASIUM|GYM|THEATER|THEATRE|WORSHIP|FELLOWSHIP)\b/.test(
        locationUpper
      );
    const isRestroom = !!restroomVariant || /\bR(?:ESTROOM|R)\b/.test(locationUpper);
    const isVestibule = /\bVESTIBULE\b/.test(locationUpper);
    const isPublicCorridor =
      (isCorridor || /\bPUBLIC\b/.test(locationUpper)) &&
      /\b(?:PUBLIC|MAIN|ENTRY|ENTRANCE|LOBBY)\b/.test(locationUpper);
    const isOccupied =
      !isMepUnoccupied &&
      !isCorridor &&
      !isBay &&
      !isStairwell &&
      !isElevator;

    const occupantLoad = inferOccupantLoad(group);

    const firstWithCoords = group.find((r) => r.xPos != null && r.yPos != null);

    inventories.push({
      roomNumber: locationUpper,
      roomName,
      level,
      pageNumber: representative.pageNumber ?? 1,
      coords:
        firstWithCoords?.xPos != null && firstWithCoords?.yPos != null
          ? { x: firstWithCoords.xPos, y: firstWithCoords.yPos }
          : undefined,
      occupantLoad,
      isCorridor,
      isBay,
      isMepUnoccupied,
      isStairwell,
      isElevator,
      isVariableUse,
      isAssembly,
      isRestroom,
      isVestibule,
      isPublicCorridor,
      isOccupied,
      ...(restroomVariant ? { restroomVariant } : {}),
    });
  }

  return inventories;
}

// ─── Private helpers for buildRoomInventory ───────────────────────────────────

function inferLevel(sheetNumber: string | null, pageNumber: number | null): string {
  if (sheetNumber) {
    const m = sheetNumber.match(/LEVEL\s+(\d+|[A-Z])/i);
    if (m) return `LEVEL ${m[1].toUpperCase()}`;
    const m2 = sheetNumber.match(/FL(?:OOR)?\s*(\d+)/i);
    if (m2) return `LEVEL ${m2[1]}`;
    return sheetNumber.toUpperCase();
  }
  if (pageNumber != null) return `PAGE ${pageNumber}`;
  return "LEVEL 1";
}

function inferRoomName(locationUpper: string, _signTypes: string[]): string {
  return locationUpper
    .split(/[\s,;/]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

function inferRestroomVariant(
  locationUpper: string,
  signTypes: string[]
): RoomInventory["restroomVariant"] {
  const all = [locationUpper, ...signTypes].join(" ");
  if (/\bMEN(?:'?S)?\b/.test(all) && !/WOMEN/.test(all)) return "mens";
  if (/\bWOMEN(?:'?S)?\b|\bLADIES\b/.test(all)) return "womens";
  if (/\bUNISEX\b|\bGENDER.?NEUTRAL\b/.test(all)) return "unisex";
  if (/\bFAMILY\b/.test(all)) return "family";
  if (/\bMOTHER(?:'?S)?\b|\bLACTATION\b|\bNURSING\b/.test(all)) return "mothers";
  if (/\bRESTROOM\b|\b(?:RR|WC)\b/.test(all)) return undefined;
  return undefined;
}

function inferOccupantLoad(
  group: Array<{ notes: string | null; quantity: number | null }>
): number | undefined {
  for (const row of group) {
    if (row.notes) {
      const m = row.notes.match(/occ(?:upant)?\s*(?:load|capacity)[:\s]+(\d+)/i);
      if (m) return parseInt(m[1], 10);
      const m2 = row.notes.match(/(\d+)\s*(?:occupants?|persons?|people)/i);
      if (m2) return parseInt(m2[1], 10);
    }
  }
  return undefined;
}
