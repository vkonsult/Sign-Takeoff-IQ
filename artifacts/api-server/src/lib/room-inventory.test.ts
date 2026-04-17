import { describe, it, expect } from "vitest";
import { deriveFlags, parseSlashLabel, isLikelyRoomName, isLikelyRoomNumber } from "./room-inventory";

// ── deriveFlags ───────────────────────────────────────────────────────────────

describe("deriveFlags — stair detection", () => {
  it('sets isStair=true for "STAIR 1"', () => {
    const flags = deriveFlags("STAIR 1", null, null);
    expect(flags.isStair).toBe(true);
  });

  it('sets isStair=true for lowercase "stair a"', () => {
    const flags = deriveFlags("stair a", null, null);
    expect(flags.isStair).toBe(true);
  });

  it('sets isStair=false for a name that contains "stair" mid-word (e.g. "UPSTAIRS")', () => {
    const flags = deriveFlags("UPSTAIRS STORAGE", null, null);
    expect(flags.isStair).toBe(false);
  });
});

describe("deriveFlags — restroom detection", () => {
  it('sets isRestroom=true for "WOMEN\'S RESTROOM"', () => {
    const flags = deriveFlags("WOMEN'S RESTROOM", null, null);
    expect(flags.isRestroom).toBe(true);
  });

  it('sets isRestroom=true for "MEN\'S TOILET ROOM"', () => {
    const flags = deriveFlags("MEN'S TOILET ROOM", null, null);
    expect(flags.isRestroom).toBe(true);
  });

  it('sets isRestroom=true for "SHOWER ROOM"', () => {
    const flags = deriveFlags("SHOWER ROOM", null, null);
    expect(flags.isRestroom).toBe(true);
  });

  it('sets isRestroom=true for "LAVATORY"', () => {
    const flags = deriveFlags("LAVATORY", null, null);
    expect(flags.isRestroom).toBe(true);
  });

  it('sets isRestroom=false for "CONFERENCE"', () => {
    const flags = deriveFlags("CONFERENCE", null, null);
    expect(flags.isRestroom).toBe(false);
  });
});

describe("deriveFlags — elevator detection", () => {
  it('sets isElevator=true for "ELEVATOR LOBBY"', () => {
    const flags = deriveFlags("ELEVATOR LOBBY", null, null);
    expect(flags.isElevator).toBe(true);
  });

  it('sets isElevator=true for "ELEV MACHINE ROOM"', () => {
    const flags = deriveFlags("ELEV MACHINE ROOM", null, null);
    expect(flags.isElevator).toBe(true);
  });
});

describe("deriveFlags — HOLDING produces all flags false", () => {
  it("returns all flags false for a generic holding room with no occupant load", () => {
    const flags = deriveFlags("HOLDING", null, null);
    expect(flags.isRestroom).toBe(false);
    expect(flags.isStair).toBe(false);
    expect(flags.isElevator).toBe(false);
    expect(flags.isVestibule).toBe(false);
    expect(flags.isCorridorOrHall).toBe(false);
    expect(flags.isVehicleBay).toBe(false);
    expect(flags.isMepUnoccupied).toBe(false);
    expect(flags.isVariableUse).toBe(false);
    expect(flags.isPublicFacing).toBe(false);
    expect(flags.isStaffOnly).toBe(false);
    expect(flags.isAssembly).toBe(false);
  });
});

describe("deriveFlags — assembly flag", () => {
  it("sets isAssembly=true when occupantLoad >= 50", () => {
    const flags = deriveFlags("HOLDING", 50, null);
    expect(flags.isAssembly).toBe(true);
  });

  it("sets isAssembly=true when occupantLoad is well above 50", () => {
    const flags = deriveFlags("MULTIPURPOSE ROOM", 200, null);
    expect(flags.isAssembly).toBe(true);
  });

  it("sets isAssembly=false when occupantLoad is below 50", () => {
    const flags = deriveFlags("HOLDING", 49, null);
    expect(flags.isAssembly).toBe(false);
  });

  it("sets isAssembly=true when occupancyGroup matches A-2 pattern", () => {
    const flags = deriveFlags("HOLDING", null, "A-2");
    expect(flags.isAssembly).toBe(true);
  });

  it("sets isAssembly=true when occupancyGroup is 'A 3'", () => {
    const flags = deriveFlags("HOLDING", null, "A 3");
    expect(flags.isAssembly).toBe(true);
  });

  it("sets isAssembly=false when occupancyGroup is non-assembly (e.g. 'B')", () => {
    const flags = deriveFlags("HOLDING", null, "B");
    expect(flags.isAssembly).toBe(false);
  });

  it("sets isAssembly=false when occupantLoad is null and occupancyGroup is null", () => {
    const flags = deriveFlags("CONFERENCE ROOM", null, null);
    expect(flags.isAssembly).toBe(false);
  });
});

describe("deriveFlags — isMepUnoccupied", () => {
  it("sets isMepUnoccupied=true for MECHANICAL room with no occupant load", () => {
    const flags = deriveFlags("MECHANICAL", null, null);
    expect(flags.isMepUnoccupied).toBe(true);
  });

  it("sets isMepUnoccupied=false for MECHANICAL room with occupants", () => {
    const flags = deriveFlags("MECHANICAL", 10, null);
    expect(flags.isMepUnoccupied).toBe(false);
  });

  it("sets isMepUnoccupied=true for STORAGE CLOSET with occupantLoad=0", () => {
    const flags = deriveFlags("STORAGE CLOSET", 0, null);
    expect(flags.isMepUnoccupied).toBe(true);
  });
});

// ── parseSlashLabel ───────────────────────────────────────────────────────────

describe("parseSlashLabel — room label parsing", () => {
  it('parses "CONFERENCE / 201" into name=CONFERENCE and number=201', () => {
    const result = parseSlashLabel("CONFERENCE / 201");
    expect(result).not.toBeNull();
    expect(result!.name).toBe("CONFERENCE");
    expect(result!.number).toBe("201");
  });

  it('parses "SERVER ROOM/B-105" without spaces around slash', () => {
    const result = parseSlashLabel("SERVER ROOM/B-105");
    expect(result).not.toBeNull();
    expect(result!.name).toBe("SERVER ROOM");
    expect(result!.number).toBe("B-105");
  });

  it("upcases both name and number", () => {
    const result = parseSlashLabel("lobby / 101a");
    expect(result).not.toBeNull();
    expect(result!.name).toBe("LOBBY");
    expect(result!.number).toBe("101A");
  });

  it("returns null when there is no slash", () => {
    expect(parseSlashLabel("CONFERENCE ROOM")).toBeNull();
  });

  it("returns null when the name portion is too short (< 2 chars)", () => {
    expect(parseSlashLabel("X / 201")).toBeNull();
  });
});

// ── isLikelyRoomName — dimension filtering ────────────────────────────────────

describe("isLikelyRoomName — dimension text is rejected", () => {
  const TYPICAL_HEIGHT = 10;

  it('rejects "10\'-0\\"" (feet-inches dimension)', () => {
    expect(isLikelyRoomName("10'-0\"", TYPICAL_HEIGHT)).toBe(false);
  });

  it('rejects "8\'" (feet-only dimension)', () => {
    expect(isLikelyRoomName("8'", TYPICAL_HEIGHT)).toBe(false);
  });

  it('rejects "1/4" = (scale notation)', () => {
    expect(isLikelyRoomName('1/4 =', TYPICAL_HEIGHT)).toBe(false);
  });

  it("rejects a pure integer string", () => {
    expect(isLikelyRoomName("201", TYPICAL_HEIGHT)).toBe(false);
  });

  it("rejects a drawing-reference like A-101", () => {
    expect(isLikelyRoomName("A-101", TYPICAL_HEIGHT)).toBe(false);
  });

  it("accepts a normal room name like CONFERENCE", () => {
    expect(isLikelyRoomName("CONFERENCE", TYPICAL_HEIGHT)).toBe(true);
  });

  it("accepts a multi-word room name like WOMEN'S RESTROOM", () => {
    expect(isLikelyRoomName("WOMEN'S RESTROOM", TYPICAL_HEIGHT)).toBe(true);
  });

  it("rejects text with font height outside 4–20 pts", () => {
    expect(isLikelyRoomName("LOBBY", 2)).toBe(false);
    expect(isLikelyRoomName("LOBBY", 25)).toBe(false);
  });

  it("rejects a room-number-formatted string (reserved for number candidates)", () => {
    expect(isLikelyRoomName("B-201", TYPICAL_HEIGHT)).toBe(false);
  });
});

// ── isLikelyRoomNumber ────────────────────────────────────────────────────────

describe("isLikelyRoomNumber", () => {
  it('accepts "120"', () => {
    expect(isLikelyRoomNumber("120")).toBe(true);
  });

  it('accepts "B-201"', () => {
    expect(isLikelyRoomNumber("B-201")).toBe(true);
  });

  it('accepts "A103"', () => {
    expect(isLikelyRoomNumber("A103")).toBe(true);
  });

  it('accepts "101A"', () => {
    expect(isLikelyRoomNumber("101A")).toBe(true);
  });

  it('rejects a plain word like "LOBBY"', () => {
    expect(isLikelyRoomNumber("LOBBY")).toBe(false);
  });

  it('rejects a single digit "5"', () => {
    expect(isLikelyRoomNumber("5")).toBe(false);
  });
});
