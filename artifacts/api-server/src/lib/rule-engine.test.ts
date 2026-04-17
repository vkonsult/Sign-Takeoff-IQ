/**
 * rule-engine.test.ts — Unit tests for Phase 5: R1–R15 rule engine
 *
 * Tests the two independently testable exports:
 *   - classifyRoom()   — boolean flags derived from room name + level
 *   - assignmentToRows() — maps SignAssignment → extractedSignsTable rows
 */

import { describe, it, expect } from "vitest";
import { classifyRoom, assignmentToRows, type SignAssignment } from "./rule-engine";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeAssignment(overrides: Partial<SignAssignment>): SignAssignment {
  return {
    roomNumber: "101",
    roomName: "CONFERENCE ROOM",
    level: "L1",
    pdfPage: 3,
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
    sourceSheet: null,
    ambiguous: false,
    ambiguityNote: null,
    ...overrides,
  };
}

// ── classifyRoom — boolean flag derivation ────────────────────────────────────

describe("classifyRoom — restroom flags", () => {
  it("detects WOMEN'S RESTROOM → isRestroom + isGenderedRestroom", () => {
    const f = classifyRoom("WOMEN'S RESTROOM", "L1", "105");
    expect(f.isRestroom).toBe(true);
    expect(f.isGenderedRestroom).toBe(true);
    expect(f.isUnisexRestroom).toBe(false);
  });

  it("detects MEN'S RESTROOM → isRestroom + isGenderedRestroom", () => {
    const f = classifyRoom("MEN'S RESTROOM", "L1", "106");
    expect(f.isRestroom).toBe(true);
    expect(f.isGenderedRestroom).toBe(true);
  });

  it("detects UNISEX TOILET → isRestroom + isUnisexRestroom", () => {
    const f = classifyRoom("UNISEX TOILET", "L1", "107");
    expect(f.isRestroom).toBe(true);
    expect(f.isUnisexRestroom).toBe(true);
    expect(f.isGenderedRestroom).toBe(false);
  });

  it("detects ACCESSIBLE RESTROOM → isAccessibleRestroom", () => {
    const f = classifyRoom("ACCESSIBLE RESTROOM", "L1", "108");
    expect(f.isRestroom).toBe(true);
    expect(f.isAccessibleRestroom).toBe(true);
  });

  it("detects staff-only restroom → isStaffOnlyRestroom, isPublicFacing=false", () => {
    const f = classifyRoom("STAFF RESTROOM", "L1", "109");
    expect(f.isRestroom).toBe(true);
    expect(f.isStaffOnlyRestroom).toBe(true);
    expect(f.isPublicFacing).toBe(false);
  });
});

describe("classifyRoom — stair and elevator flags", () => {
  it("STAIRWELL → isStair, not isElevator", () => {
    const f = classifyRoom("STAIRWELL", "L1", null);
    expect(f.isStair).toBe(true);
    expect(f.isElevator).toBe(false);
    expect(f.isOccupied).toBe(true);
  });

  it("ELEVATOR → isElevator, not isStair", () => {
    const f = classifyRoom("ELEVATOR", "L1", null);
    expect(f.isElevator).toBe(true);
    expect(f.isStair).toBe(false);
  });

  it("ELEV → isElevator (abbreviation)", () => {
    const f = classifyRoom("ELEV", "L1", "E1");
    expect(f.isElevator).toBe(true);
  });
});

describe("classifyRoom — corridor / hall flags", () => {
  it("CORRIDOR → isCorridorOrHall", () => {
    const f = classifyRoom("CORRIDOR", "L1", null);
    expect(f.isCorridorOrHall).toBe(true);
  });

  it("HALL → isCorridorOrHall", () => {
    const f = classifyRoom("HALL", "L2", null);
    expect(f.isCorridorOrHall).toBe(true);
  });

  it("LOBBY → not isCorridorOrHall, isPublicFacing=true", () => {
    const f = classifyRoom("LOBBY", "L1", null);
    expect(f.isCorridorOrHall).toBe(false);
    expect(f.isPublicFacing).toBe(true);
  });
});

describe("classifyRoom — MEP unoccupied flag", () => {
  it("MECHANICAL ROOM → isMepUnoccupied, isOccupied=false", () => {
    const f = classifyRoom("MECHANICAL ROOM", "L1", null);
    expect(f.isMepUnoccupied).toBe(true);
    expect(f.isOccupied).toBe(false);
  });

  it("ELECTRICAL → isMepUnoccupied", () => {
    const f = classifyRoom("ELECTRICAL", "L1", "E101");
    expect(f.isMepUnoccupied).toBe(true);
  });

  it("IT ROOM / SERVER ROOM → isMepUnoccupied", () => {
    const f1 = classifyRoom("SERVER ROOM", "L1", null);
    const f2 = classifyRoom("IDF ROOM", "L1", null);
    expect(f1.isMepUnoccupied).toBe(true);
    expect(f2.isMepUnoccupied).toBe(true);
  });
});

describe("classifyRoom — assembly / variable use flags", () => {
  it("SANCTUARY → isAssembly", () => {
    const f = classifyRoom("SANCTUARY", "L1", null);
    expect(f.isAssembly).toBe(true);
  });

  it("GYMNASIUM → isAssembly", () => {
    const f = classifyRoom("GYMNASIUM", "L1", null);
    expect(f.isAssembly).toBe(true);
  });

  it("CONFERENCE ROOM → isVariableUse, not isAssembly", () => {
    const f = classifyRoom("CONFERENCE ROOM", "L1", "201");
    expect(f.isVariableUse).toBe(true);
    expect(f.isAssembly).toBe(false);
  });

  it("TRAINING ROOM → isVariableUse", () => {
    const f = classifyRoom("TRAINING ROOM", "L1", null);
    expect(f.isVariableUse).toBe(true);
  });
});

describe("classifyRoom — mezzanine flag", () => {
  it("room on MEZZ level → isMezzanine", () => {
    const f = classifyRoom("STORAGE", "MEZZ", null);
    expect(f.isMezzanine).toBe(true);
  });

  it("room on L1 → not isMezzanine", () => {
    const f = classifyRoom("OFFICE", "L1", "301");
    expect(f.isMezzanine).toBe(false);
  });
});

// ── assignmentToRows — sign row mapping ───────────────────────────────────────

describe("assignmentToRows — R1 Room ID", () => {
  it("R1: roomId=1 emits one ROOM ID SIGN row", () => {
    const a = makeAssignment({ roomId: 1, appliedRules: ["R1"] });
    const rows = assignmentToRows(a);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.signType).toBe("ROOM ID SIGN");
    expect(rows[0]!.quantity).toBe(1);
    expect(rows[0]!.extractionMethod).toBe("rule_engine");
    expect(rows[0]!.placementSource).toBe("rule_engine");
    expect(rows[0]!.reviewFlag).toBe(false);
  });

  it("R1: roomId=0 or null emits no row", () => {
    const rows1 = assignmentToRows(makeAssignment({ roomId: 0 }));
    const rows2 = assignmentToRows(makeAssignment({ roomId: null }));
    expect(rows1.filter((r) => r.signType === "ROOM ID SIGN")).toHaveLength(0);
    expect(rows2.filter((r) => r.signType === "ROOM ID SIGN")).toHaveLength(0);
  });
});

describe("assignmentToRows — R2 Variable Use Insert", () => {
  it("R2: roomIdWithInsert=1 emits ROOM ID SIGN W/ INSERT row", () => {
    const a = makeAssignment({
      roomIdWithInsert: 1,
      appliedRules: ["R2"],
      ambiguous: true,
      ambiguityNote: "R2: door count unknown",
    });
    const rows = assignmentToRows(a);
    expect(rows.some((r) => r.signType === "ROOM ID SIGN W/ INSERT")).toBe(true);
    const row = rows.find((r) => r.signType === "ROOM ID SIGN W/ INSERT")!;
    expect(row.reviewFlag).toBe(true);
    expect(row.confidenceScore).toBe(0.7);
  });
});

describe("assignmentToRows — R7/R8 Restroom", () => {
  it("R7: restroom=1 emits RESTROOM SIGN row", () => {
    const a = makeAssignment({ restroom: 1, appliedRules: ["R7"] });
    const rows = assignmentToRows(a);
    const rrRow = rows.find((r) => r.signType === "RESTROOM SIGN");
    expect(rrRow).toBeDefined();
    expect(rrRow!.quantity).toBe(1);
  });
});

describe("assignmentToRows — R9 EXIT", () => {
  it("R9: exit=2 emits EXIT SIGN row with qty 2", () => {
    const a = makeAssignment({ exit: 2, appliedRules: ["R9"], ambiguous: true });
    const rows = assignmentToRows(a);
    const exitRow = rows.find((r) => r.signType === "EXIT SIGN");
    expect(exitRow).toBeDefined();
    expect(exitRow!.quantity).toBe(2);
    expect(exitRow!.reviewFlag).toBe(true);
  });
});

describe("assignmentToRows — R10 Max Occupancy", () => {
  it("R10: maxOccupancy=1 emits MAX OCCUPANCY SIGN row", () => {
    const a = makeAssignment({ maxOccupancy: 1, appliedRules: ["R10"] });
    const rows = assignmentToRows(a);
    expect(rows.some((r) => r.signType === "MAX OCCUPANCY SIGN")).toBe(true);
  });
});

describe("assignmentToRows — R11 Stair signs", () => {
  it("R11: stairCorridor=1 + stairLanding=1 emit two rows", () => {
    const a = makeAssignment({
      stairCorridor: 1,
      stairLanding: 1,
      appliedRules: ["R11"],
    });
    const rows = assignmentToRows(a);
    expect(rows.some((r) => r.signType === "STAIR CORRIDOR SIGN")).toBe(true);
    expect(rows.some((r) => r.signType === "STAIR LANDING SIGN")).toBe(true);
    expect(rows).toHaveLength(2);
  });
});

describe("assignmentToRows — R12 In Case of Fire", () => {
  it("R12: inCaseOfFire=1 emits IN CASE OF FIRE SIGN row", () => {
    const a = makeAssignment({ inCaseOfFire: 1, appliedRules: ["R12"] });
    const rows = assignmentToRows(a);
    expect(rows.some((r) => r.signType === "IN CASE OF FIRE SIGN")).toBe(true);
  });
});

describe("assignmentToRows — R13 Evacuation Map", () => {
  it("R13: evacuationMap=1 emits EVACUATION MAP row", () => {
    const a = makeAssignment({ evacuationMap: 1, appliedRules: ["R13"] });
    const rows = assignmentToRows(a);
    expect(rows.some((r) => r.signType === "EVACUATION MAP")).toBe(true);
  });
});

describe("assignmentToRows — R14 Office Directory", () => {
  it("R14: officeDirectory=1 emits OFFICE DIRECTORY row", () => {
    const a = makeAssignment({ officeDirectory: 1, appliedRules: ["R14"] });
    const rows = assignmentToRows(a);
    expect(rows.some((r) => r.signType === "OFFICE DIRECTORY")).toBe(true);
  });
});

describe("assignmentToRows — multiple signs in one assignment", () => {
  it("lobby with evacuation map + exit + office directory → 3 rows", () => {
    const a = makeAssignment({
      exit: 1,
      evacuationMap: 1,
      officeDirectory: 1,
      appliedRules: ["R9", "R13", "R14"],
    });
    const rows = assignmentToRows(a);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.extractionMethod === "rule_engine")).toBe(true);
    expect(rows.every((r) => r.placementSource === "rule_engine")).toBe(true);
  });

  it("fully excluded room (0 signs) → 0 rows", () => {
    const a = makeAssignment({ exclusionReasons: ["R4: is_corridor_or_hall"] });
    const rows = assignmentToRows(a);
    expect(rows).toHaveLength(0);
  });
});

describe("assignmentToRows — rawJson traceability", () => {
  it("rawJson includes appliedRules, exclusionReasons, level, and ambiguous", () => {
    const a = makeAssignment({
      roomId: 1,
      appliedRules: ["R1"],
      level: "L2",
      ambiguous: false,
    });
    const rows = assignmentToRows(a);
    const raw = rows[0]!.rawJson;
    expect(raw.appliedRules).toEqual(["R1"]);
    expect(raw.level).toBe("L2");
    expect(raw.ambiguous).toBe(false);
  });
});
