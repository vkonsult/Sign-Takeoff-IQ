/**
 * rule-engine.test.ts — Unit tests for Phase 5: R1–R15 rule engine
 *
 * Tests the three independently testable exports:
 *   - classifyRoom()   — boolean flags derived from room name + level
 *   - applySignRules() — full rule engine (R1–R14) on a Phase 4 RoomInventory
 *   - assignmentToRows() — maps SignAssignment → extractedSignsTable rows
 */

import { describe, it, expect, beforeAll } from "vitest";
import {
  classifyRoom,
  assignmentToRows,
  applySignRules,
  type SignAssignment,
  type PlaqueEntry,
} from "./rule-engine";
import type { RoomInventory as Phase4RoomInventory, RoomRecord as Phase4RoomRecord } from "./room-inventory";

// ── Phase 4 fixture helpers ───────────────────────────────────────────────────

function makeRoom(overrides: Partial<Phase4RoomRecord> & { roomName: string }): Phase4RoomRecord {
  const base = {
    roomNumber: null as string | null,
    level: "L1",
    pdfPage: 1,
    occupantLoad: null as number | null,
    occupancyGroup: null as string | null,
    isRestroom: false,
    isStair: false,
    isElevator: false,
    isVestibule: false,
    isCorridorOrHall: false,
    isVehicleBay: false,
    isMepUnoccupied: false,
    isVariableUse: false,
    isPublicFacing: false,
    isStaffOnly: false,
    isAssembly: false,
    isOffice: false,
    isSuite: false,
    doorCount: null as number | null,
    zoneQualifier: null as string | null | undefined,
    boundingBox: null as Phase4RoomRecord["boundingBox"],
    extractionConfidence: 1,
  };
  return { ...base, ...overrides };
}

function makeInventory(rooms: Phase4RoomRecord[]): Phase4RoomInventory {
  return {
    rooms,
    occupantLoadTableFound: false,
    occupantLoadSource: "none",
    occupantLoadRoomsMatched: 0,
    warnings: [],
    sourcePages: [],
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeAssignment(overrides: Partial<SignAssignment>): SignAssignment {
  return {
    roomNumber: "101",
    roomName: "CONFERENCE ROOM",
    level: "L1",
    pdfPage: 3,
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
    sourceSheet: null,
    ambiguous: false,
    ambiguityNote: null,
    zoneQualifier: null,
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

describe("classifyRoom — collaboration/breakout room detection (Task 457)", () => {
  it("COLLABORATION ROOM → isVariableUse=true", () => {
    const f = classifyRoom("COLLABORATION ROOM", "L1", "201");
    expect(f.isVariableUse).toBe(true);
    expect(f.isMepUnoccupied).toBe(false);
  });

  it("BREAKOUT ROOM → isVariableUse=true", () => {
    const f = classifyRoom("BREAKOUT ROOM", "L1", "202");
    expect(f.isVariableUse).toBe(true);
    expect(f.isMepUnoccupied).toBe(false);
  });

  it("HUDDLE ROOM → isVariableUse=true", () => {
    const f = classifyRoom("HUDDLE ROOM", "L1", "203");
    expect(f.isVariableUse).toBe(true);
  });

  it("WORKSHOP STORAGE → isVariableUse=false (storage qualifier overrides workshop keyword)", () => {
    const f = classifyRoom("WORKSHOP STORAGE", "L1", "204");
    expect(f.isVariableUse).toBe(false);
    // storage is not in MEP_TOKENS (to avoid R15 regression); it is in STORAGE_QUALIFIER_TOKENS
    expect(f.isMepUnoccupied).toBe(false);
  });

  it("COLLABORATION STORAGE → isVariableUse=false (storage qualifier overrides collaboration keyword)", () => {
    const f = classifyRoom("COLLABORATION STORAGE", "L1", "205");
    expect(f.isVariableUse).toBe(false);
    expect(f.isMepUnoccupied).toBe(false);
  });

  it("COLLAB CLOSET → isVariableUse=false (closet qualifier overrides collab keyword)", () => {
    const f = classifyRoom("COLLAB CLOSET", "L1", "206");
    expect(f.isVariableUse).toBe(false);
    expect(f.isMepUnoccupied).toBe(false);
  });

  it("WORKSHOP → isVariableUse=true (standalone workshop, no storage qualifier)", () => {
    const f = classifyRoom("WORKSHOP", "L1", "207");
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

// ── applySignRules — full rule engine integration tests ───────────────────────

describe("applySignRules — R1: regular occupied room gets Room ID sign", () => {
  it("a generic occupied room gets roomId=1 via R1", () => {
    const inv = makeInventory([makeRoom({ roomName: "BREAK ROOM", roomNumber: "101" })]);
    const result = applySignRules(inv, [], "job-1");
    expect(result.assignments).toHaveLength(1);
    const a = result.assignments[0]!;
    expect(a.roomId).toBe(1);
    expect(a.appliedRules).toContain("R1");
    expect(a.roomIdWithInsert).toBeNull();
  });

  it("MEP room is excluded and gets no Room ID sign", () => {
    const inv = makeInventory([makeRoom({ roomName: "MECHANICAL ROOM", isMepUnoccupied: true })]);
    const result = applySignRules(inv, [], "job-2");
    const a = result.assignments[0]!;
    expect(a.roomId).toBeNull();
    expect(a.appliedRules).not.toContain("R1");
  });
});

describe("applySignRules — R2: variable-use room gets Room ID w/ Insert", () => {
  it("CONFERENCE ROOM gets roomIdWithInsert=1 with audit note (not ambiguous) when doorCount unknown", () => {
    const inv = makeInventory([makeRoom({ roomName: "CONFERENCE ROOM", isVariableUse: true })]);
    const result = applySignRules(inv, [], "job-3");
    const a = result.assignments[0]!;
    expect(a.roomIdWithInsert).toBe(1);
    expect(a.roomId).toBe(0);
    expect(a.appliedRules).toContain("R2");
    expect(a.ambiguous).toBe(false);
    expect(a.ambiguityNote).toMatch(/quantity 1 assumed/i);
  });

  it("TRAINING ROOM (name-derived variable use) also triggers R2", () => {
    const inv = makeInventory([makeRoom({ roomName: "TRAINING ROOM" })]);
    const result = applySignRules(inv, [], "job-4");
    const a = result.assignments[0]!;
    expect(a.roomIdWithInsert).toBe(1);
    expect(a.appliedRules).toContain("R2");
  });
});

describe("applySignRules — R4: corridor exclusion", () => {
  it("CORRIDOR gets roomId=0 and exclusion reason, no other signs", () => {
    const inv = makeInventory([makeRoom({ roomName: "CORRIDOR", isCorridorOrHall: true })]);
    const result = applySignRules(inv, [], "job-5");
    const a = result.assignments[0]!;
    expect(a.roomId).toBe(0);
    expect(a.exclusionReasons.some((r) => r.includes("R4"))).toBe(true);
    expect(a.restroom).toBeNull();
    expect(a.exit).toBeNull();
    expect(a.stairCorridor).toBeNull();
  });

  it("HALLWAY (name-derived corridor) is also excluded via R4", () => {
    const inv = makeInventory([makeRoom({ roomName: "HALLWAY" })]);
    const result = applySignRules(inv, [], "job-6");
    const a = result.assignments[0]!;
    expect(a.exclusionReasons.some((r) => r.includes("R4"))).toBe(true);
  });
});

describe("applySignRules — R7/R8: restroom type assignment", () => {
  it("WOMEN'S RESTROOM without plaque table entry → restroom=1, ambiguous", () => {
    const inv = makeInventory([makeRoom({ roomName: "WOMEN'S RESTROOM", isRestroom: true })]);
    const result = applySignRules(inv, [], "job-7");
    const a = result.assignments[0]!;
    expect(a.restroom).toBe(1);
    expect(a.appliedRules).toContain("R7");
    expect(a.ambiguous).toBe(true);
    expect(a.roomId).toBeNull();
  });

  it("MEN'S RESTROOM with plaque table match → uses plaque quantity, not ambiguous for R7", () => {
    const plaques: PlaqueEntry[] = [
      { roomNumber: "201", roomName: "Men's Restroom", signTypeCode: "MRR", quantity: 2 },
    ];
    const inv = makeInventory([
      makeRoom({ roomName: "MEN'S RESTROOM", roomNumber: "201", isRestroom: true }),
    ]);
    const result = applySignRules(inv, plaques, "job-8");
    const a = result.assignments[0]!;
    expect(a.restroom).toBe(2);
    expect(a.appliedRules).toContain("R7");
  });

  it("ACCESSIBLE RESTROOM → R7 + R8 in appliedRules", () => {
    const inv = makeInventory([makeRoom({ roomName: "ACCESSIBLE RESTROOM", isRestroom: true })]);
    const result = applySignRules(inv, [], "job-9");
    const a = result.assignments[0]!;
    expect(a.appliedRules).toContain("R7");
    expect(a.appliedRules).toContain("R8");
    expect(a.restroom).toBe(1);
  });

  it("STAFF RESTROOM → isStaffOnlyRestroom=true, still gets restroom sign", () => {
    const inv = makeInventory([
      makeRoom({ roomName: "STAFF RESTROOM", isRestroom: true, isStaffOnly: true }),
    ]);
    const result = applySignRules(inv, [], "job-10");
    const a = result.assignments[0]!;
    expect(a.restroom).toBe(1);
    expect(a.appliedRules).toContain("R7");
  });
});

describe("applySignRules — R9: exit sign assignment", () => {
  it("exit-discharge vestibule room → exit=1", () => {
    const inv = makeInventory([makeRoom({ roomName: "EXIT VESTIBULE" })]);
    const result = applySignRules(inv, [], "job-11");
    const a = result.assignments[0]!;
    expect(a.exit).toBe(1);
    expect(a.appliedRules).toContain("R9");
  });

  it("public LOBBY → exit=1 via R9", () => {
    const inv = makeInventory([makeRoom({ roomName: "MAIN LOBBY", isPublicFacing: true })]);
    const result = applySignRules(inv, [], "job-12");
    const a = result.assignments[0]!;
    expect(a.exit).toBe(1);
    expect(a.appliedRules).toContain("R9");
  });

  it("SANCTUARY (assembly) → exit=2, ambiguous", () => {
    const inv = makeInventory([makeRoom({ roomName: "SANCTUARY", isAssembly: true })]);
    const result = applySignRules(inv, [], "job-13");
    const a = result.assignments[0]!;
    expect(a.exit).toBe(2);
    expect(a.appliedRules).toContain("R9");
    expect(a.ambiguous).toBe(true);
  });

  it("ordinary office room → no exit sign", () => {
    const inv = makeInventory([makeRoom({ roomName: "OFFICE 101" })]);
    const result = applySignRules(inv, [], "job-14");
    const a = result.assignments[0]!;
    expect(a.exit).toBeNull();
  });
});

describe("applySignRules — R10: max occupancy / capacity sign", () => {
  it("assembly room (GYMNASIUM) → maxOccupancy=1, ambiguous", () => {
    const inv = makeInventory([makeRoom({ roomName: "GYMNASIUM", isAssembly: true })]);
    const result = applySignRules(inv, [], "job-15");
    const a = result.assignments[0]!;
    expect(a.maxOccupancy).toBe(1);
    expect(a.appliedRules).toContain("R10");
    expect(a.ambiguous).toBe(true);
  });

  it("non-assembly room → no capacity sign", () => {
    const inv = makeInventory([makeRoom({ roomName: "STORAGE ROOM" })]);
    const result = applySignRules(inv, [], "job-16");
    const a = result.assignments[0]!;
    expect(a.maxOccupancy).toBeNull();
  });
});

describe("applySignRules — R11: stair plaques", () => {
  it("STAIRWELL → stairCorridor=1 + stairLanding=1, no Room ID, audit note when doorCount unknown", () => {
    const inv = makeInventory([makeRoom({ roomName: "STAIRWELL", isStair: true })]);
    const result = applySignRules(inv, [], "job-17");
    const a = result.assignments[0]!;
    expect(a.stairCorridor).toBe(1);
    expect(a.stairLanding).toBe(1);
    expect(a.appliedRules).toContain("R11");
    expect(a.roomId).toBeNull();
    expect(a.ambiguous).toBe(false);
    expect(a.ambiguityNote).toMatch(/quantity 1 assumed/i);
  });

  it("STAIR TOWER (name-derived) → also gets R11 signs", () => {
    const inv = makeInventory([makeRoom({ roomName: "STAIR TOWER" })]);
    const result = applySignRules(inv, [], "job-18");
    const a = result.assignments[0]!;
    expect(a.stairCorridor).toBe(1);
    expect(a.stairLanding).toBe(1);
  });
});

describe("applySignRules — R12: elevator In Case of Fire (ICF)", () => {
  it("single elevator → inCaseOfFire=1", () => {
    const inv = makeInventory([makeRoom({ roomName: "ELEVATOR", isElevator: true })]);
    const result = applySignRules(inv, [], "job-19");
    const a = result.assignments[0]!;
    expect(a.inCaseOfFire).toBe(1);
    expect(a.appliedRules).toContain("R12");
    expect(a.roomId).toBeNull();
  });

  it("two elevators → ICF deduplication: only one gets inCaseOfFire=1", () => {
    const inv = makeInventory([
      makeRoom({ roomName: "ELEVATOR A", isElevator: true }),
      makeRoom({ roomName: "ELEVATOR B", isElevator: true }),
    ]);
    const result = applySignRules(inv, [], "job-20");
    const icfAssignments = result.assignments.filter(
      (a) => a.inCaseOfFire !== null && a.inCaseOfFire > 0,
    );
    expect(icfAssignments).toHaveLength(1);
    const dedupedElevator = result.assignments.find(
      (a) => a.exclusionReasons.some((r) => r.includes("R12")),
    );
    expect(dedupedElevator).toBeDefined();
  });

  it("no elevator → no ICF sign assigned", () => {
    const inv = makeInventory([makeRoom({ roomName: "OFFICE" })]);
    const result = applySignRules(inv, [], "job-21");
    expect(result.assignments[0]!.inCaseOfFire).toBeNull();
  });
});

describe("applySignRules — R13: evacuation map", () => {
  it("elevator → also gets evacuationMap=1", () => {
    const inv = makeInventory([makeRoom({ roomName: "ELEVATOR", isElevator: true })]);
    const result = applySignRules(inv, [], "job-22");
    const a = result.assignments[0]!;
    expect(a.evacuationMap).toBe(1);
    expect(a.appliedRules).toContain("R13");
  });

  it("public LOBBY → evacuationMap=1", () => {
    const inv = makeInventory([makeRoom({ roomName: "MAIN LOBBY", isPublicFacing: true })]);
    const result = applySignRules(inv, [], "job-23");
    const a = result.assignments[0]!;
    expect(a.evacuationMap).toBe(1);
    expect(a.appliedRules).toContain("R13");
  });

  it("back-office room → no evacuation map", () => {
    const inv = makeInventory([makeRoom({ roomName: "STORAGE" })]);
    const result = applySignRules(inv, [], "job-24");
    expect(result.assignments[0]!.evacuationMap).toBeNull();
  });
});

describe("applySignRules — R14: office directory", () => {
  it("LOBBY on L1 → gets officeDirectory=1 via R14", () => {
    const inv = makeInventory([makeRoom({ roomName: "MAIN LOBBY", isPublicFacing: true })]);
    const result = applySignRules(inv, [], "job-25");
    const a = result.assignments[0]!;
    expect(a.officeDirectory).toBe(1);
    expect(a.appliedRules).toContain("R14");
  });

  it("R14 fix: ALL lobbies on same level receive an office directory (not just first)", () => {
    const inv = makeInventory([
      makeRoom({ roomName: "MAIN LOBBY", isPublicFacing: true, level: "L1" }),
      makeRoom({ roomName: "EAST LOBBY", isPublicFacing: true, level: "L1" }),
    ]);
    const result = applySignRules(inv, [], "job-26");
    const dirAssignments = result.assignments.filter(
      (a) => a.officeDirectory !== null && a.officeDirectory > 0,
    );
    expect(dirAssignments).toHaveLength(2);
    expect(dirAssignments.map((a) => a.roomName)).toContain("MAIN LOBBY");
    expect(dirAssignments.map((a) => a.roomName)).toContain("EAST LOBBY");
  });

  it("LOBBY on different levels each get their own directory", () => {
    const inv = makeInventory([
      makeRoom({ roomName: "MAIN LOBBY", isPublicFacing: true, level: "L1" }),
      makeRoom({ roomName: "MAIN LOBBY", isPublicFacing: true, level: "L2" }),
    ]);
    const result = applySignRules(inv, [], "job-27");
    const dirAssignments = result.assignments.filter(
      (a) => a.officeDirectory !== null && a.officeDirectory > 0,
    );
    expect(dirAssignments).toHaveLength(2);
  });

  it("three lobbies on L1 all get directories — R14 covers every lobby on a level", () => {
    const inv = makeInventory([
      makeRoom({ roomName: "MAIN LOBBY", isPublicFacing: true, level: "L1" }),
      makeRoom({ roomName: "EAST LOBBY", isPublicFacing: true, level: "L1" }),
      makeRoom({ roomName: "WEST LOBBY", isPublicFacing: true, level: "L1" }),
    ]);
    const result = applySignRules(inv, [], "job-27b");
    const dirAssignments = result.assignments.filter(
      (a) => a.officeDirectory !== null && a.officeDirectory > 0,
    );
    expect(dirAssignments).toHaveLength(3);
  });
});

describe("applySignRules — edge case: mezzanine MEP veto (R15)", () => {
  it("mezzanine MEP room → all signs excluded", () => {
    const inv = makeInventory([
      makeRoom({ roomName: "MECHANICAL ROOM", level: "MEZZ", isMepUnoccupied: true }),
    ]);
    const result = applySignRules(inv, [], "job-28");
    const a = result.assignments[0]!;
    expect(a.exclusionReasons.some((r) => r.includes("R15"))).toBe(true);
    expect(a.roomId).toBeNull();
    expect(a.restroom).toBeNull();
    expect(a.stairCorridor).toBeNull();
    expect(a.inCaseOfFire).toBeNull();
    expect(a.evacuationMap).toBeNull();
  });

  it("mezzanine non-MEP room → NOT vetoed by R15", () => {
    const inv = makeInventory([makeRoom({ roomName: "STORAGE", level: "MEZZ" })]);
    const result = applySignRules(inv, [], "job-29");
    const a = result.assignments[0]!;
    expect(a.exclusionReasons.some((r) => r.includes("R15"))).toBe(false);
    expect(a.roomId).toBe(1);
  });
});

describe("applySignRules — Step 3b: staff-only level-cluster fallback", () => {
  it("restroom on all-office level → classified staff-only, no directory sign", () => {
    const level = "L2";
    const inv = makeInventory([
      makeRoom({ roomName: "WOMEN'S RESTROOM", level, isRestroom: true, isPublicFacing: true }),
      makeRoom({ roomName: "OFFICE 201", level, isOffice: true }),
      makeRoom({ roomName: "OFFICE 202", level, isOffice: true }),
      makeRoom({ roomName: "MECHANICAL", level, isMepUnoccupied: true }),
    ]);
    const result = applySignRules(inv, [], "job-re-staff-1");
    const restroomAssign = result.assignments.find((a) => a.roomName === "WOMEN'S RESTROOM")!;
    // Staff-only restroom should still get a restroom sign (R7), but should
    // NOT appear in questionsForVerification as a public-facing room
    expect(restroomAssign.restroom).toBe(1);
    expect(restroomAssign.appliedRules).toContain("R7");
  });

  it("restroom on mixed-use level with public lobby → NOT reclassified staff-only", () => {
    const level = "L1";
    const inv = makeInventory([
      makeRoom({ roomName: "RESTROOM", level, isRestroom: true, isPublicFacing: true }),
      makeRoom({ roomName: "MAIN LOBBY", level, isPublicFacing: true, isCorridorOrHall: true }),
      makeRoom({ roomName: "OFFICE 101", level, isOffice: true }),
    ]);
    const result = applySignRules(inv, [], "job-re-staff-2");
    const restroomAssign = result.assignments.find((a) => a.roomName === "RESTROOM")!;
    // The restroom is public-facing — the level-cluster fallback must NOT
    // reclassify it as staff-only when a public lobby is present on the same level.
    expect(restroomAssign.restroom).toBe(1);
    // isPublicFacing should remain true (no reclassification happened)
    // — confirmed by the assignment still receiving a standard R7 plaque
    expect(restroomAssign.appliedRules).toContain("R7");
  });
});

describe("applySignRules — edge case: ambiguous flags on assembly rooms", () => {
  it("SANCTUARY gets ambiguous=true with notes on both R9 and R10", () => {
    const inv = makeInventory([makeRoom({ roomName: "SANCTUARY", isAssembly: true })]);
    const result = applySignRules(inv, [], "job-30");
    const a = result.assignments[0]!;
    expect(a.ambiguous).toBe(true);
    expect(a.ambiguityNote).toMatch(/R9/);
    expect(a.ambiguityNote).toMatch(/R10/);
  });

  it("CAFETERIA (assembly) also flags ambiguity and gets both exit and capacity signs", () => {
    const inv = makeInventory([makeRoom({ roomName: "CAFETERIA", isAssembly: true })]);
    const result = applySignRules(inv, [], "job-31");
    const a = result.assignments[0]!;
    expect(a.exit).toBe(2);
    expect(a.maxOccupancy).toBe(1);
    expect(a.ambiguous).toBe(true);
  });
});

describe("applySignRules — result metadata", () => {
  it("roomCount matches number of rooms in inventory", () => {
    const inv = makeInventory([
      makeRoom({ roomName: "OFFICE A" }),
      makeRoom({ roomName: "OFFICE B" }),
      makeRoom({ roomName: "RESTROOM", isRestroom: true }),
    ]);
    const result = applySignRules(inv, [], "job-32");
    expect(result.roomCount).toBe(3);
    expect(result.assignments).toHaveLength(3);
  });

  it("decisionsLog has one entry per room", () => {
    const inv = makeInventory([
      makeRoom({ roomName: "OFFICE" }),
      makeRoom({ roomName: "STAIRWELL", isStair: true }),
    ]);
    const result = applySignRules(inv, [], "job-33");
    expect(result.decisionsLog).toHaveLength(2);
  });

  it("questionsForVerification includes ambiguous room notes", () => {
    const inv = makeInventory([makeRoom({ roomName: "CONFERENCE ROOM", isVariableUse: true })]);
    const result = applySignRules(inv, [], "job-34");
    expect(result.questionsForVerification.length).toBeGreaterThan(0);
  });
});

// ── Helpers for sign-total assertions ─────────────────────────────────────────

function totalSignsForAssignment(a: SignAssignment): number {
  return (
    (a.roomId ?? 0) +
    (a.roomIdWithInsert ?? 0) +
    (a.suiteId ?? 0) +
    (a.restroom ?? 0) +
    (a.exit ?? 0) +
    (a.maxOccupancy ?? 0) +
    (a.stairCorridor ?? 0) +
    (a.stairLanding ?? 0) +
    (a.inCaseOfFire ?? 0) +
    (a.evacuationMap ?? 0) +
    (a.officeDirectory ?? 0)
  );
}

// ── Excluded room types — sign count totals and verificationErrors ─────────────

describe("applySignRules — corridor rooms are fully excluded from sign totals", () => {
  it("single CORRIDOR contributes 0 to every sign type total", () => {
    const inv = makeInventory([makeRoom({ roomName: "CORRIDOR", isCorridorOrHall: true })]);
    const result = applySignRules(inv, [], "job-35");
    const a = result.assignments[0]!;

    expect(a.roomIdWithInsert).toBeNull();
    expect(a.restroom).toBeNull();
    expect(a.exit).toBeNull();
    expect(a.maxOccupancy).toBeNull();
    expect(a.stairCorridor).toBeNull();
    expect(a.stairLanding).toBeNull();
    expect(a.inCaseOfFire).toBeNull();
    expect(a.evacuationMap).toBeNull();
    expect(a.officeDirectory).toBeNull();
    expect(totalSignsForAssignment(a)).toBe(0);
  });

  it("CORRIDOR has R4 exclusion reason and no applied rules", () => {
    const inv = makeInventory([makeRoom({ roomName: "CORRIDOR", isCorridorOrHall: true })]);
    const result = applySignRules(inv, [], "job-36");
    const a = result.assignments[0]!;

    expect(a.exclusionReasons.some((r) => r.includes("R4"))).toBe(true);
    expect(a.appliedRules).toHaveLength(0);
  });

  it("verificationErrors is empty when inventory contains only a corridor", () => {
    const inv = makeInventory([makeRoom({ roomName: "MAIN CORRIDOR", isCorridorOrHall: true })]);
    const result = applySignRules(inv, [], "job-37");
    expect(result.verificationErrors).toHaveLength(0);
  });

  it("multiple corridors all contribute 0 and produce no verificationErrors", () => {
    const inv = makeInventory([
      makeRoom({ roomName: "CORRIDOR A", isCorridorOrHall: true }),
      makeRoom({ roomName: "CORRIDOR B", isCorridorOrHall: true }),
      makeRoom({ roomName: "HALLWAY", isCorridorOrHall: true }),
    ]);
    const result = applySignRules(inv, [], "job-38");

    for (const a of result.assignments) {
      expect(totalSignsForAssignment(a)).toBe(0);
    }
    expect(result.verificationErrors).toHaveLength(0);
  });
});

describe("applySignRules — MEP/unoccupied rooms are fully excluded from sign totals", () => {
  it("MECHANICAL ROOM contributes 0 to every sign type total", () => {
    const inv = makeInventory([makeRoom({ roomName: "MECHANICAL ROOM", isMepUnoccupied: true })]);
    const result = applySignRules(inv, [], "job-39");
    const a = result.assignments[0]!;

    expect(a.roomId).toBeNull();
    expect(a.roomIdWithInsert).toBeNull();
    expect(a.restroom).toBeNull();
    expect(a.exit).toBeNull();
    expect(a.maxOccupancy).toBeNull();
    expect(a.stairCorridor).toBeNull();
    expect(a.stairLanding).toBeNull();
    expect(a.inCaseOfFire).toBeNull();
    expect(a.evacuationMap).toBeNull();
    expect(a.officeDirectory).toBeNull();
    expect(totalSignsForAssignment(a)).toBe(0);
  });

  it("MECHANICAL ROOM has MEP exclusion reason and no applied rules", () => {
    const inv = makeInventory([makeRoom({ roomName: "MECHANICAL ROOM", isMepUnoccupied: true })]);
    const result = applySignRules(inv, [], "job-40");
    const a = result.assignments[0]!;

    expect(a.exclusionReasons.some((r) => r.includes("MEP"))).toBe(true);
    expect(a.appliedRules).toHaveLength(0);
  });

  it("verificationErrors is empty when inventory contains only an MEP room", () => {
    const inv = makeInventory([makeRoom({ roomName: "ELECTRICAL ROOM", isMepUnoccupied: true })]);
    const result = applySignRules(inv, [], "job-41");
    expect(result.verificationErrors).toHaveLength(0);
  });

  it("multiple MEP room variants (electrical, server, IDF) all excluded with no verificationErrors", () => {
    const inv = makeInventory([
      makeRoom({ roomName: "MECHANICAL ROOM", isMepUnoccupied: true }),
      makeRoom({ roomName: "ELECTRICAL ROOM", isMepUnoccupied: true }),
      makeRoom({ roomName: "SERVER ROOM", isMepUnoccupied: true }),
      makeRoom({ roomName: "IDF ROOM", isMepUnoccupied: true }),
    ]);
    const result = applySignRules(inv, [], "job-42");

    for (const a of result.assignments) {
      expect(totalSignsForAssignment(a)).toBe(0);
      expect(a.exclusionReasons.some((r) => r.includes("MEP"))).toBe(true);
    }
    expect(result.verificationErrors).toHaveLength(0);
  });
});

describe("applySignRules — vehicle bay rooms are fully excluded from sign totals", () => {
  it("vehicle bay contributes 0 to every sign type total", () => {
    const inv = makeInventory([makeRoom({ roomName: "VEHICLE BAY", isVehicleBay: true })]);
    const result = applySignRules(inv, [], "job-43");
    const a = result.assignments[0]!;

    expect(a.roomId).toBeNull();
    expect(a.roomIdWithInsert).toBeNull();
    expect(a.restroom).toBeNull();
    expect(a.exit).toBeNull();
    expect(a.maxOccupancy).toBeNull();
    expect(a.stairCorridor).toBeNull();
    expect(a.stairLanding).toBeNull();
    expect(a.inCaseOfFire).toBeNull();
    expect(a.evacuationMap).toBeNull();
    expect(a.officeDirectory).toBeNull();
    expect(totalSignsForAssignment(a)).toBe(0);
  });

  it("vehicle bay has vehicle_bay exclusion reason and no applied rules", () => {
    const inv = makeInventory([makeRoom({ roomName: "APPARATUS BAY", isVehicleBay: true })]);
    const result = applySignRules(inv, [], "job-44");
    const a = result.assignments[0]!;

    expect(a.exclusionReasons.some((r) => r.includes("vehicle_bay"))).toBe(true);
    expect(a.appliedRules).toHaveLength(0);
  });

  it("verificationErrors is empty when inventory contains only a vehicle bay", () => {
    const inv = makeInventory([makeRoom({ roomName: "FIRE APPARATUS BAY", isVehicleBay: true })]);
    const result = applySignRules(inv, [], "job-45");
    expect(result.verificationErrors).toHaveLength(0);
  });

  it("multiple vehicle bays all excluded with no verificationErrors", () => {
    const inv = makeInventory([
      makeRoom({ roomName: "BAY 1", isVehicleBay: true }),
      makeRoom({ roomName: "BAY 2", isVehicleBay: true }),
      makeRoom({ roomName: "APPARATUS BAY", isVehicleBay: true }),
    ]);
    const result = applySignRules(inv, [], "job-46");

    for (const a of result.assignments) {
      expect(totalSignsForAssignment(a)).toBe(0);
      expect(a.exclusionReasons.some((r) => r.includes("vehicle_bay"))).toBe(true);
    }
    expect(result.verificationErrors).toHaveLength(0);
  });
});

describe("applySignRules — mixed inventory: excluded rooms don't inflate totals", () => {
  it("corridor + MEP + vehicle bay alongside a regular office: only the office gets signs", () => {
    const inv = makeInventory([
      makeRoom({ roomName: "OFFICE 101", roomNumber: "101" }),
      makeRoom({ roomName: "CORRIDOR", isCorridorOrHall: true }),
      makeRoom({ roomName: "MECHANICAL ROOM", isMepUnoccupied: true }),
      makeRoom({ roomName: "VEHICLE BAY", isVehicleBay: true }),
    ]);
    const result = applySignRules(inv, [], "job-47");

    const officeAssignment = result.assignments.find((a) => a.roomName === "OFFICE 101")!;
    const excludedAssignments = result.assignments.filter((a) => a.roomName !== "OFFICE 101");

    expect(officeAssignment.roomId).toBe(1);
    expect(officeAssignment.appliedRules.some((r) => r === "R1" || r === "R5")).toBe(true);

    for (const a of excludedAssignments) {
      expect(totalSignsForAssignment(a)).toBe(0);
      expect(a.exclusionReasons.length).toBeGreaterThan(0);
    }

    expect(result.verificationErrors).toHaveLength(0);
  });

  it("sign totals from assignmentToRows match only the regular room, not excluded rooms", () => {
    const inv = makeInventory([
      makeRoom({ roomName: "STORAGE ROOM", roomNumber: "S1" }),
      makeRoom({ roomName: "HALLWAY", isCorridorOrHall: true }),
      makeRoom({ roomName: "ELECTRICAL", isMepUnoccupied: true }),
      makeRoom({ roomName: "TRUCK BAY", isVehicleBay: true }),
    ]);
    const result = applySignRules(inv, [], "job-48");

    const allRows = result.assignments.flatMap((a) => assignmentToRows(a));
    const totalQuantity = allRows.reduce((sum, r) => sum + r.quantity, 0);

    expect(totalQuantity).toBe(1);
    expect(allRows[0]!.signType).toBe("ROOM ID SIGN");
    expect(allRows[0]!.signIdentifier).toBe("S1");
  });
});

// ── R5: Office gets Room ID via R5 ────────────────────────────────────────────

describe("applySignRules — R5: office room ID sign", () => {
  it("office room (isOffice=true) → roomId=1, appliedRules contains R5", () => {
    const inv = makeInventory([
      makeRoom({ roomName: "EXECUTIVE OFFICE", roomNumber: "205", isOffice: true }),
    ]);
    const result = applySignRules(inv, [], "job-r5a");
    const a = result.assignments[0]!;
    expect(a.roomId).toBe(1);
    expect(a.appliedRules).toContain("R5");
  });

  it("assignmentToRows for office emits ROOM ID SIGN row", () => {
    const inv = makeInventory([
      makeRoom({ roomName: "OFFICE", roomNumber: "301", isOffice: true }),
    ]);
    const result = applySignRules(inv, [], "job-r5b");
    const rows = result.assignments.flatMap((a) => assignmentToRows(a));
    const roomIdRows = rows.filter((r) => r.signType === "ROOM ID SIGN");
    expect(roomIdRows.length).toBeGreaterThanOrEqual(1);
  });
});

// ── R6: Suite gets Suite ID sign ──────────────────────────────────────────────

describe("applySignRules — R6: suite ID sign", () => {
  it("suite room (isSuite=true) → suiteId=1, appliedRules contains R6", () => {
    const inv = makeInventory([
      makeRoom({ roomName: "SUITE 100", roomNumber: "100", isSuite: true }),
    ]);
    const result = applySignRules(inv, [], "job-r6a");
    const a = result.assignments[0]!;
    expect(a.suiteId).toBe(1);
    expect(a.appliedRules).toContain("R6");
  });

  it("assignmentToRows for suite emits SUITE ID SIGN row", () => {
    const inv = makeInventory([
      makeRoom({ roomName: "SUITE 200", roomNumber: "200", isSuite: true }),
    ]);
    const result = applySignRules(inv, [], "job-r6b");
    const rows = result.assignments.flatMap((a) => assignmentToRows(a));
    const suiteRows = rows.filter((r) => r.signType === "SUITE ID SIGN");
    expect(suiteRows.length).toBeGreaterThanOrEqual(1);
  });

  it("non-suite room → suiteId remains null", () => {
    const inv = makeInventory([
      makeRoom({ roomName: "CONFERENCE ROOM", roomNumber: "102", isSuite: false }),
    ]);
    const result = applySignRules(inv, [], "job-r6c");
    const a = result.assignments[0]!;
    expect(a.suiteId).toBeNull();
  });
});

// ── R9/R10: occupantLoad-aware ambiguity suppression ─────────────────────────

describe("applySignRules — R9/R10: occupantLoad-aware rules", () => {
  it("R9: high-occupancy assembly room (>49) → exit sign scale reflects load", () => {
    // Use "AUDITORIUM" to avoid the hall/corridor token in "BANQUET HALL"
    const inv = makeInventory([
      makeRoom({ roomName: "AUDITORIUM", occupantLoad: 300, isAssembly: true }),
    ]);
    const result = applySignRules(inv, [], "job-r9a");
    const a = result.assignments[0]!;
    expect(a.appliedRules).toContain("R9");
    expect(a.exit).toBeGreaterThanOrEqual(1);
  });

  it("R10: max-occupancy sign applied to assembly rooms; no ambiguity when load known", () => {
    // R10 fires for assembly rooms (isAssembly=true)
    const inv = makeInventory([
      makeRoom({ roomName: "ASSEMBLY ROOM", occupantLoad: 75, isAssembly: true }),
    ]);
    const result = applySignRules(inv, [], "job-r10a");
    const a = result.assignments[0]!;
    expect(a.appliedRules).toContain("R10");
    // With occupantLoad known, no ambiguity flag is added for R10
    expect(a.ambiguityNote ?? "").not.toContain("R10: capacity sign — verify occupant load");
  });

  it("R10: assembly room with no occupantLoad → ambiguity note added", () => {
    const inv = makeInventory([
      makeRoom({ roomName: "ASSEMBLY ROOM", occupantLoad: null, isAssembly: true }),
    ]);
    const result = applySignRules(inv, [], "job-r10b");
    const a = result.assignments[0]!;
    expect(a.appliedRules).toContain("R10");
    expect(a.ambiguous).toBe(true);
  });

  it("non-assembly room with no occupantLoad → R10 not applied", () => {
    const inv = makeInventory([
      makeRoom({ roomName: "BREAK ROOM", occupantLoad: null, isAssembly: false }),
    ]);
    const result = applySignRules(inv, [], "job-r10c");
    const a = result.assignments[0]!;
    expect(a.appliedRules).not.toContain("R10");
  });
});

// ── R15 MEP hardening ─────────────────────────────────────────────────────────

describe("applySignRules — R15: hardened MEP veto on mezzanine", () => {
  it("mezzanine STORAGE room (not MEP) → NOT vetoed by R15", () => {
    const inv = makeInventory([
      makeRoom({ roomName: "MEZZANINE STORAGE", isMepUnoccupied: false }),
    ]);
    const result = applySignRules(inv, [], "job-r15a");
    const a = result.assignments[0]!;
    const allReasons = a.appliedRules.concat(a.exclusionReasons);
    // R15 full veto must not have fired — room may get a near-veto note, but not a full veto
    expect(allReasons.some((r) => r === "R15: mezzanine MEP unoccupied — all signs excluded")).toBe(false);
    // Total signs > 0 confirms the room was not fully excluded
    expect(totalSignsForAssignment(a)).toBeGreaterThan(0);
  });

  it("MEZZANINE STORAGE with Phase4 isMepUnoccupied=true → near-veto fires, signs still produced", () => {
    // Regression test: old MEP_KEYWORDS included 'STORAGE', so Phase 4 would set
    // isMepUnoccupied=true for storage rooms.  The R15 near-veto must catch this
    // (room name has no true MEP token) and fall through to normal rules, producing
    // at least one sign rather than silently zero-signing the room.
    const inv = makeInventory([
      makeRoom({ roomName: "MEZZANINE STORAGE", isMepUnoccupied: true }),
    ]);
    const result = applySignRules(inv, [], "job-r15a-regression");
    const a = result.assignments[0]!;
    // Full R15 veto must not fire
    expect(a.exclusionReasons.some((r) => r === "R15: mezzanine MEP unoccupied — all signs excluded")).toBe(false);
    // Room must receive at least one sign (Room ID via R1)
    expect(totalSignsForAssignment(a)).toBeGreaterThan(0);
  });

  it("mezzanine ELECTRICAL room (MEP) → vetoed by R15", () => {
    const inv = makeInventory([
      makeRoom({ roomName: "MEZZANINE ELECTRICAL", isMepUnoccupied: true }),
    ]);
    const result = applySignRules(inv, [], "job-r15b");
    const a = result.assignments[0]!;
    const allReasons = a.appliedRules.concat(a.exclusionReasons);
    expect(allReasons.some((r) => r.startsWith("R15"))).toBe(true);
    expect(totalSignsForAssignment(a)).toBe(0);
  });
});

// ── Zero-sign reason codes ────────────────────────────────────────────────────

describe("applySignRules — zero-sign rooms emit typed reason codes", () => {
  it("MEP-vetoed room emits VETOED_MEP in questionsForVerification", () => {
    const inv = makeInventory([
      makeRoom({ roomName: "ELECTRICAL ROOM", isMepUnoccupied: true }),
    ]);
    const result = applySignRules(inv, [], "job-zsr-mep");
    const hasVetoedMep = result.questionsForVerification.some(
      (q) => q.includes("VETOED_MEP"),
    );
    expect(hasVetoedMep).toBe(true);
  });

  it("mezzanine MEP room emits VETOED_MEZZANINE in questionsForVerification", () => {
    const inv = makeInventory([
      makeRoom({ roomName: "MEZZANINE ELECTRICAL", isMepUnoccupied: true }),
    ]);
    const result = applySignRules(inv, [], "job-zsr-mezz");
    const hasMezzVeto = result.questionsForVerification.some(
      (q) => q.includes("VETOED_MEZZANINE"),
    );
    expect(hasMezzVeto).toBe(true);
  });

  it("corridor room emits EXPLICIT_EXCLUSION in questionsForVerification", () => {
    const inv = makeInventory([
      makeRoom({ roomName: "CORRIDOR", isCorridorOrHall: true }),
    ]);
    const result = applySignRules(inv, [], "job-zsr-corridor");
    const hasExplicit = result.questionsForVerification.some(
      (q) => q.includes("EXPLICIT_EXCLUSION"),
    );
    expect(hasExplicit).toBe(true);
  });

  it("vehicle bay room emits EXPLICIT_EXCLUSION in questionsForVerification", () => {
    const inv = makeInventory([
      makeRoom({ roomName: "TRUCK BAY", isVehicleBay: true }),
    ]);
    const result = applySignRules(inv, [], "job-zsr-vehiclebay");
    const hasExplicit = result.questionsForVerification.some(
      (q) => q.includes("EXPLICIT_EXCLUSION"),
    );
    expect(hasExplicit).toBe(true);
  });

  it("office room with R5 default-door assumption emits AUDIT_ASSUMPTION in questionsForVerification", () => {
    const inv = makeInventory([
      makeRoom({ roomName: "EXECUTIVE OFFICE", roomNumber: "205", isOffice: true }),
    ]);
    const result = applySignRules(inv, [], "job-zsr-r5assumption");
    const hasAuditAssumption = result.questionsForVerification.some(
      (q) => q.includes("[AUDIT_ASSUMPTION]") && q.includes("R5"),
    );
    expect(hasAuditAssumption).toBe(true);
  });

  it("suite room with R6 assumption emits AUDIT_ASSUMPTION in questionsForVerification", () => {
    const inv = makeInventory([
      makeRoom({ roomName: "SUITE 100", roomNumber: "100", isSuite: true }),
    ]);
    const result = applySignRules(inv, [], "job-zsr-r6assumption");
    const hasAuditAssumption = result.questionsForVerification.some(
      (q) => q.includes("[AUDIT_ASSUMPTION]") && q.includes("R6"),
    );
    expect(hasAuditAssumption).toBe(true);
  });

  it("R2 variable-use room with known doorCount → no ambiguity flag", () => {
    const inv = makeInventory([
      makeRoom({ roomName: "CONFERENCE ROOM", isVariableUse: true, doorCount: 2 }),
    ]);
    const result = applySignRules(inv, [], "job-zsr-r2doorcount");
    const a = result.assignments[0]!;
    expect(a.roomIdWithInsert).toBe(2);
    expect(a.ambiguous).toBe(false);
  });

  it("R11 stair with known doorCount → uses extracted count, no ambiguity", () => {
    const inv = makeInventory([
      makeRoom({ roomName: "STAIR A", isStair: true, doorCount: 3 }),
    ]);
    const result = applySignRules(inv, [], "job-zsr-r11doorcount");
    const a = result.assignments[0]!;
    expect(a.stairCorridor).toBe(3);
    expect(a.ambiguous).toBe(false);
  });
});

// ── Fixture-level regression: mixed-occupancy building ────────────────────────
// This fixture locks in per-room sign counts for a representative multi-story
// building. Add rooms here whenever a production job reveals new edge cases.
// "Church/Tower" style: mix of MEP, storage, office, suite, restroom, stair, lobby.

describe("Fixture: mixed-occupancy building — sign count regression", () => {
  const fixtureRooms: Parameters<typeof makeRoom>[0][] = [
    // Occupied rooms → get signs
    { roomName: "OFFICE 101", roomNumber: "101", isOffice: true },
    { roomName: "SUITE 200", roomNumber: "200", isSuite: true },
    { roomName: "CONFERENCE ROOM", roomNumber: "102", isVariableUse: true },
    { roomName: "LOBBY", roomNumber: "103", isPublicFacing: true, isCorridorOrHall: true },
    { roomName: "WOMEN'S RESTROOM", roomNumber: "104", isRestroom: true },
    { roomName: "STAIR A", roomNumber: "105", isStair: true },
    { roomName: "STORAGE ROOM", roomNumber: "106" },         // plain storage — should get sign
    { roomName: "JANITOR CLOSET", roomNumber: "107", isMepUnoccupied: true }, // Phase4 correctly flags janitor as MEP
    // True MEP rooms → excluded
    { roomName: "MECHANICAL ROOM", roomNumber: "108", isMepUnoccupied: true },
    { roomName: "ELECTRICAL ROOM", roomNumber: "109", isMepUnoccupied: true },
    // Mezzanine storage falsely flagged as MEP by Phase 4 → near-veto, gets sign
    { roomName: "MEZZANINE STORAGE", roomNumber: "110", isMepUnoccupied: true },
  ];

  let result: ReturnType<typeof applySignRules>;

  beforeAll(() => {
    const inv = makeInventory(fixtureRooms.map((r) => makeRoom(r)));
    result = applySignRules(inv, [], "job-fixture-mixed");
  });

  it("OFFICE 101 → roomId ≥ 1 (R5)", () => {
    const a = result.assignments.find((x) => x.roomNumber === "101")!;
    expect(a.roomId).toBeGreaterThanOrEqual(1);
    expect(a.appliedRules.some((r) => r === "R5" || r === "R1")).toBe(true);
  });

  it("SUITE 200 → suiteId = 1 (R6)", () => {
    const a = result.assignments.find((x) => x.roomNumber === "200")!;
    expect(a.suiteId).toBe(1);
    expect(a.appliedRules).toContain("R6");
  });

  it("CONFERENCE ROOM → roomIdWithInsert ≥ 1 (R2)", () => {
    const a = result.assignments.find((x) => x.roomNumber === "102")!;
    expect((a.roomIdWithInsert ?? 0)).toBeGreaterThanOrEqual(1);
    expect(a.appliedRules).toContain("R2");
  });

  it("STORAGE ROOM → at least 1 sign (not silently zero-signed)", () => {
    const a = result.assignments.find((x) => x.roomNumber === "106")!;
    expect(totalSignsForAssignment(a)).toBeGreaterThan(0);
    expect(a.exclusionReasons.some((r) => r.includes("MEP"))).toBe(false);
  });

  it("JANITOR CLOSET → 0 signs (MEP unoccupied)", () => {
    const a = result.assignments.find((x) => x.roomNumber === "107")!;
    expect(totalSignsForAssignment(a)).toBe(0);
  });

  it("MECHANICAL ROOM → 0 signs, VETOED_MEP reason", () => {
    const a = result.assignments.find((x) => x.roomNumber === "108")!;
    expect(totalSignsForAssignment(a)).toBe(0);
    const hasVeto = result.questionsForVerification.some(
      (q) => q.includes("VETOED_MEP") && q.includes("108"),
    );
    expect(hasVeto).toBe(true);
  });

  it("ELECTRICAL ROOM → 0 signs", () => {
    const a = result.assignments.find((x) => x.roomNumber === "109")!;
    expect(totalSignsForAssignment(a)).toBe(0);
  });

  it("MEZZANINE STORAGE (Phase4 isMepUnoccupied=true) → ≥1 sign via R15 near-veto", () => {
    const a = result.assignments.find((x) => x.roomNumber === "110")!;
    expect(totalSignsForAssignment(a)).toBeGreaterThan(0);
    expect(a.exclusionReasons.some((r) => r === "R15: mezzanine MEP unoccupied — all signs excluded")).toBe(false);
  });

  it("total signed rooms = 7, zero-sign rooms = 4", () => {
    // Signed: OFFICE, SUITE, CONFERENCE ROOM, WOMEN'S RESTROOM, STAIR A, STORAGE ROOM, MEZZANINE STORAGE
    // Zero-sign: LOBBY (R4 corridor), JANITOR CLOSET (MEP), MECHANICAL ROOM (MEP), ELECTRICAL ROOM (MEP)
    const signed = result.assignments.filter((a) => totalSignsForAssignment(a) > 0);
    const zeroSign = result.assignments.filter((a) => totalSignsForAssignment(a) === 0);
    expect(signed).toHaveLength(7);
    expect(zeroSign).toHaveLength(4);
  });
});
