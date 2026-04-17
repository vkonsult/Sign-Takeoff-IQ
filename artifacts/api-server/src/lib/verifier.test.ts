import { describe, it, expect } from "vitest";
import {
  verifyRuleEngineResult,
  type Room,
  type RoomAssignment,
  type RoomInventory,
  type RuleEngineResult,
  type SheetManifest,
} from "./verifier";

// ── Factories ─────────────────────────────────────────────────────────────────

function makeRoom(overrides: Partial<Room> = {}): Room {
  return {
    roomId: "r1",
    roomNumber: "101",
    roomName: "Office",
    level: "L1",
    isRestroom: false,
    isStair: false,
    isElevator: false,
    isAssembly: false,
    isMepUnoccupied: false,
    passedR1Filter: true,
    ...overrides,
  };
}

function makeAssignment(overrides: Partial<RoomAssignment> = {}): RoomAssignment {
  return {
    roomId: "r1",
    roomNumber: "101",
    roomName: "Office",
    level: "L1",
    signs: ["Room ID"],
    exclusionReasons: [],
    restroom: 0,
    exit: 0,
    stairCorridor: 0,
    stairLanding: 0,
    inCaseOfFire: 0,
    maxOccupancy: 0,
    ...overrides,
  };
}

function makeInventory(overrides: Partial<RoomInventory> = {}): RoomInventory {
  return {
    rooms: [],
    elevatorCount: 0,
    stairCount: 0,
    levelNames: ["L1"],
    ...overrides,
  };
}

function makeResult(
  assignments: RoomAssignment[],
  byLevel: RuleEngineResult["byLevel"] = {},
): RuleEngineResult {
  return { assignments, byLevel };
}

function makeManifest(levels: string[] = ["L1"]): SheetManifest {
  return { levels, pageCount: levels.length };
}

// ── Prerequisite guard ────────────────────────────────────────────────────────

describe("prerequisite guard", () => {
  it("returns passed=false with a question when both rooms and assignments are empty", () => {
    const report = verifyRuleEngineResult(
      makeResult([]),
      makeInventory({ rooms: [] }),
      makeManifest([]),
    );
    expect(report.passed).toBe(false);
    expect(report.errors).toHaveLength(0);
    expect(report.questionsForVerification).toHaveLength(1);
    expect(report.questionsForVerification[0]).toMatch(/not yet available/i);
  });
});

// ── V1: Every room accounted for ──────────────────────────────────────────────

describe("V1 — Every room accounted for", () => {
  it("passes when every room has signs", () => {
    const room = makeRoom();
    const assignment = makeAssignment({ signs: ["Room ID"] });
    const report = verifyRuleEngineResult(
      makeResult([assignment]),
      makeInventory({ rooms: [room] }),
      makeManifest(),
    );
    expect(report.checksPassed).toContain("V1 — Every room accounted for");
    expect(report.errors.filter((e) => e.startsWith("V1"))).toHaveLength(0);
  });

  it("passes when a room has no signs but has an exclusion reason", () => {
    const room = makeRoom();
    const assignment = makeAssignment({ signs: [], exclusionReasons: ["MEP room"] });
    const report = verifyRuleEngineResult(
      makeResult([assignment]),
      makeInventory({ rooms: [room] }),
      makeManifest(),
    );
    expect(report.checksPassed).toContain("V1 — Every room accounted for");
    expect(report.errors.filter((e) => e.startsWith("V1"))).toHaveLength(0);
  });

  it("fails when a room has no signs and no exclusion reason", () => {
    const room = makeRoom({ roomId: "r1", roomNumber: "101" });
    const assignment = makeAssignment({ signs: [], exclusionReasons: [] });
    const report = verifyRuleEngineResult(
      makeResult([assignment]),
      makeInventory({ rooms: [room] }),
      makeManifest(),
    );
    expect(report.errors.some((e) => e.startsWith("V1"))).toBe(true);
  });

  it("fails when a room has no assignment at all", () => {
    const room = makeRoom({ roomId: "r1" });
    const report = verifyRuleEngineResult(
      makeResult([]),
      makeInventory({ rooms: [room] }),
      makeManifest(),
    );
    expect(report.errors.some((e) => e.startsWith("V1"))).toBe(true);
  });
});

// ── V2: Restroom count matches ────────────────────────────────────────────────

describe("V2 — Restroom count matches", () => {
  it("passes when restroom room and restroom assignment counts match", () => {
    const room = makeRoom({ isRestroom: true });
    const assignment = makeAssignment({ restroom: 1 });
    const report = verifyRuleEngineResult(
      makeResult([assignment]),
      makeInventory({ rooms: [room] }),
      makeManifest(),
    );
    expect(report.checksPassed).toContain("V2 — Restroom count matches");
    expect(report.warnings.filter((w) => w.startsWith("V2"))).toHaveLength(0);
  });

  it("emits a warning when restroom assignment count differs from restroom room count", () => {
    const room1 = makeRoom({ roomId: "r1", isRestroom: true });
    const room2 = makeRoom({ roomId: "r2", roomNumber: "102", isRestroom: true });
    const assignment = makeAssignment({ roomId: "r1", restroom: 1 });
    const report = verifyRuleEngineResult(
      makeResult([assignment]),
      makeInventory({ rooms: [room1, room2] }),
      makeManifest(),
    );
    expect(report.warnings.some((w) => w.startsWith("V2"))).toBe(true);
  });

  it("passes when there are no restroom rooms on a level", () => {
    const room = makeRoom({ isRestroom: false });
    const assignment = makeAssignment({ signs: ["Room ID"] });
    const report = verifyRuleEngineResult(
      makeResult([assignment]),
      makeInventory({ rooms: [room] }),
      makeManifest(),
    );
    expect(report.warnings.filter((w) => w.startsWith("V2"))).toHaveLength(0);
  });
});

// ── V3: EXIT count ≥ IBC minimum ─────────────────────────────────────────────

describe("V3 — EXIT count ≥ IBC minimum (IBC Table 1006.3)", () => {
  function makeV3Report(occupantLoad: number, exitCount: number) {
    const room = makeRoom();
    const assignment = makeAssignment({ exit: exitCount });
    return verifyRuleEngineResult(
      makeResult([assignment], {
        L1: {
          assignments: [assignment],
          totalOccupantLoad: occupantLoad,
        },
      }),
      makeInventory({ rooms: [room] }),
      makeManifest(),
    );
  }

  it("OL ≤ 499 — passes with exactly 2 exits", () => {
    const report = makeV3Report(499, 2);
    expect(report.checksPassed).toContain("V3 — EXIT count ≥ IBC minimum");
    expect(report.errors.filter((e) => e.startsWith("V3"))).toHaveLength(0);
  });

  it("OL ≤ 499 — fails with fewer than 2 exits", () => {
    const report = makeV3Report(100, 1);
    expect(report.errors.some((e) => e.startsWith("V3"))).toBe(true);
  });

  it("OL 500–999 — passes with exactly 3 exits", () => {
    const report = makeV3Report(750, 3);
    expect(report.checksPassed).toContain("V3 — EXIT count ≥ IBC minimum");
  });

  it("OL 500–999 — fails with only 2 exits", () => {
    const report = makeV3Report(500, 2);
    expect(report.errors.some((e) => e.startsWith("V3"))).toBe(true);
    expect(report.errors[0]).toMatch(/IBC minimum 3/);
  });

  it("OL ≥ 1000 — passes with exactly 4 exits", () => {
    const report = makeV3Report(1000, 4);
    expect(report.checksPassed).toContain("V3 — EXIT count ≥ IBC minimum");
  });

  it("OL ≥ 1000 — fails with only 3 exits", () => {
    const report = makeV3Report(1500, 3);
    expect(report.errors.some((e) => e.startsWith("V3"))).toBe(true);
    expect(report.errors[0]).toMatch(/IBC minimum 4/);
  });

  it("emits a question when occupant load is unknown", () => {
    const room = makeRoom();
    const assignment = makeAssignment({ exit: 2 });
    const report = verifyRuleEngineResult(
      makeResult([assignment], {
        L1: { assignments: [assignment], totalOccupantLoad: undefined },
      }),
      makeInventory({ rooms: [room] }),
      makeManifest(),
    );
    expect(report.questionsForVerification.some((q) => q.startsWith("V3"))).toBe(true);
    expect(report.checksPassed).not.toContain("V3 — EXIT count ≥ IBC minimum");
  });

  it("passes at the OL 499/500 boundary: OL=499 needs 2, OL=500 needs 3", () => {
    expect(makeV3Report(499, 2).errors.filter((e) => e.startsWith("V3"))).toHaveLength(0);
    expect(makeV3Report(500, 2).errors.some((e) => e.startsWith("V3"))).toBe(true);
    expect(makeV3Report(500, 3).errors.filter((e) => e.startsWith("V3"))).toHaveLength(0);
  });

  it("passes at the OL 999/1000 boundary: OL=999 needs 3, OL=1000 needs 4", () => {
    expect(makeV3Report(999, 3).errors.filter((e) => e.startsWith("V3"))).toHaveLength(0);
    expect(makeV3Report(1000, 3).errors.some((e) => e.startsWith("V3"))).toBe(true);
    expect(makeV3Report(1000, 4).errors.filter((e) => e.startsWith("V3"))).toHaveLength(0);
  });
});

// ── V4: Stair plaque totals ───────────────────────────────────────────────────

describe("V4 — Stair plaque totals", () => {
  it("passes (skipped) when there are no stairs in inventory", () => {
    const room = makeRoom({ isStair: false });
    const assignment = makeAssignment({ signs: ["Room ID"] });
    const report = verifyRuleEngineResult(
      makeResult([assignment]),
      makeInventory({ rooms: [room] }),
      makeManifest(),
    );
    expect(report.checksPassed).toContain("V4 — No stairs in inventory (skipped)");
  });

  it("fails when stairs exist but stairCorridor total is 0", () => {
    const stair = makeRoom({ roomId: "s1", isStair: true, levelsServed: 3 });
    const assignment = makeAssignment({ roomId: "s1", signs: [], stairCorridor: 0, stairLanding: 3 });
    const report = verifyRuleEngineResult(
      makeResult([assignment]),
      makeInventory({ rooms: [stair] }),
      makeManifest(),
    );
    expect(report.errors.some((e) => e.startsWith("V4") && /corridor/.test(e))).toBe(true);
  });

  it("fails when stairs exist but stairLanding total is 0", () => {
    const stair = makeRoom({ roomId: "s1", isStair: true, levelsServed: 3 });
    const assignment = makeAssignment({ roomId: "s1", signs: [], stairCorridor: 6, stairLanding: 0 });
    const report = verifyRuleEngineResult(
      makeResult([assignment]),
      makeInventory({ rooms: [stair] }),
      makeManifest(),
    );
    expect(report.errors.some((e) => e.startsWith("V4") && /landing/.test(e))).toBe(true);
  });

  it("fails when corridor count mismatches expected (levelsServed × corridorEntries)", () => {
    const stair = makeRoom({ roomId: "s1", isStair: true, levelsServed: 3, corridorEntries: 2 });
    // expected corridor = 3 × 2 = 6; we supply 4
    const assignment = makeAssignment({ roomId: "s1", signs: [], stairCorridor: 4, stairLanding: 3 });
    const report = verifyRuleEngineResult(
      makeResult([assignment]),
      makeInventory({ rooms: [stair] }),
      makeManifest(),
    );
    expect(report.errors.some((e) => e.startsWith("V4") && /corridor sign count mismatch/.test(e))).toBe(true);
  });

  it("fails when landing count mismatches expected (levelsServed)", () => {
    const stair = makeRoom({ roomId: "s1", isStair: true, levelsServed: 3, corridorEntries: 2 });
    // expected landing = 3; we supply 2
    const assignment = makeAssignment({ roomId: "s1", signs: [], stairCorridor: 6, stairLanding: 2 });
    const report = verifyRuleEngineResult(
      makeResult([assignment]),
      makeInventory({ rooms: [stair] }),
      makeManifest(),
    );
    expect(report.errors.some((e) => e.startsWith("V4") && /landing sign count mismatch/.test(e))).toBe(true);
  });

  it("passes when corridor and landing counts match expected values", () => {
    const stair = makeRoom({ roomId: "s1", isStair: true, levelsServed: 3, corridorEntries: 2 });
    const assignment = makeAssignment({ roomId: "s1", signs: [], stairCorridor: 6, stairLanding: 3 });
    const report = verifyRuleEngineResult(
      makeResult([assignment]),
      makeInventory({ rooms: [stair] }),
      makeManifest(),
    );
    expect(report.checksPassed).toContain("V4 — Stair plaque totals match expected values");
    expect(report.errors.filter((e) => e.startsWith("V4"))).toHaveLength(0);
  });

  it("defers equality check with a question when levelsServed data is absent", () => {
    const stair = makeRoom({ roomId: "s1", isStair: true }); // no levelsServed
    const assignment = makeAssignment({ roomId: "s1", signs: [], stairCorridor: 3, stairLanding: 2 });
    const report = verifyRuleEngineResult(
      makeResult([assignment]),
      makeInventory({ rooms: [stair] }),
      makeManifest(),
    );
    expect(report.questionsForVerification.some((q) => q.startsWith("V4"))).toBe(true);
  });
});

// ── V5: "In Case of Fire" = elevator count ────────────────────────────────────

describe("V5 — In Case of Fire count = elevator count", () => {
  it("passes when counts match", () => {
    const room = makeRoom();
    const assignment = makeAssignment({ signs: ["Room ID"], inCaseOfFire: 2 });
    const report = verifyRuleEngineResult(
      makeResult([assignment]),
      makeInventory({ rooms: [room], elevatorCount: 2 }),
      makeManifest(),
    );
    expect(report.checksPassed).toContain("V5 — In Case of Fire count = elevator count");
    expect(report.warnings.filter((w) => w.startsWith("V5"))).toHaveLength(0);
  });

  it("emits a warning when inCaseOfFire count < elevator count", () => {
    const room = makeRoom();
    const assignment = makeAssignment({ signs: ["Room ID"], inCaseOfFire: 1 });
    const report = verifyRuleEngineResult(
      makeResult([assignment]),
      makeInventory({ rooms: [room], elevatorCount: 3 }),
      makeManifest(),
    );
    expect(report.warnings.some((w) => w.startsWith("V5"))).toBe(true);
  });

  it("emits a warning when inCaseOfFire count > elevator count", () => {
    const room = makeRoom();
    const assignment = makeAssignment({ signs: ["Room ID"], inCaseOfFire: 4 });
    const report = verifyRuleEngineResult(
      makeResult([assignment]),
      makeInventory({ rooms: [room], elevatorCount: 2 }),
      makeManifest(),
    );
    expect(report.warnings.some((w) => w.startsWith("V5"))).toBe(true);
  });

  it("passes (skipped) when there are no elevators and no inCaseOfFire signs", () => {
    const room = makeRoom();
    const assignment = makeAssignment({ signs: ["Room ID"], inCaseOfFire: 0 });
    const report = verifyRuleEngineResult(
      makeResult([assignment]),
      makeInventory({ rooms: [room], elevatorCount: 0 }),
      makeManifest(),
    );
    expect(report.checksPassed).toContain("V5 — No elevators in inventory (skipped)");
  });

  it("emits a warning when inCaseOfFire signs exist but no elevators in inventory", () => {
    const room = makeRoom();
    const assignment = makeAssignment({ signs: ["Room ID"], inCaseOfFire: 1 });
    const report = verifyRuleEngineResult(
      makeResult([assignment]),
      makeInventory({ rooms: [room], elevatorCount: 0 }),
      makeManifest(),
    );
    expect(report.warnings.some((w) => w.startsWith("V5"))).toBe(true);
  });
});

// ── V6: Assembly rooms have capacity signs ────────────────────────────────────

describe("V6 — Assembly rooms have capacity signs", () => {
  it("passes when an assembly room has a maxOccupancy sign", () => {
    const room = makeRoom({ isAssembly: true });
    const assignment = makeAssignment({ signs: ["Max Occupancy"], maxOccupancy: 1 });
    const report = verifyRuleEngineResult(
      makeResult([assignment]),
      makeInventory({ rooms: [room] }),
      makeManifest(),
    );
    expect(report.checksPassed).toContain("V6 — Assembly rooms have capacity signs");
    expect(report.errors.filter((e) => e.startsWith("V6"))).toHaveLength(0);
  });

  it("passes when an assembly room has no capacity sign but has an exclusion reason", () => {
    const room = makeRoom({ isAssembly: true });
    const assignment = makeAssignment({ signs: [], maxOccupancy: 0, exclusionReasons: ["Owner waived"] });
    const report = verifyRuleEngineResult(
      makeResult([assignment]),
      makeInventory({ rooms: [room] }),
      makeManifest(),
    );
    expect(report.checksPassed).toContain("V6 — Assembly rooms have capacity signs");
  });

  it("fails when an assembly room has no capacity sign and no exclusion reason", () => {
    const room = makeRoom({ isAssembly: true });
    const assignment = makeAssignment({ signs: ["Room ID"], maxOccupancy: 0 });
    const report = verifyRuleEngineResult(
      makeResult([assignment]),
      makeInventory({ rooms: [room] }),
      makeManifest(),
    );
    expect(report.errors.some((e) => e.startsWith("V6"))).toBe(true);
  });

  it("passes when there are no assembly rooms", () => {
    const room = makeRoom({ isAssembly: false });
    const assignment = makeAssignment({ signs: ["Room ID"] });
    const report = verifyRuleEngineResult(
      makeResult([assignment]),
      makeInventory({ rooms: [room] }),
      makeManifest(),
    );
    expect(report.checksPassed).toContain("V6 — Assembly rooms have capacity signs");
  });
});

// ── V7: No zero-sign rooms without justification ──────────────────────────────

describe("V7 — No zero-sign rooms without justification", () => {
  it("passes when an R1-filtered room has at least one sign", () => {
    const room = makeRoom({ passedR1Filter: true });
    const assignment = makeAssignment({ signs: ["Room ID"] });
    const report = verifyRuleEngineResult(
      makeResult([assignment]),
      makeInventory({ rooms: [room] }),
      makeManifest(),
    );
    expect(report.checksPassed).toContain("V7 — All R1-filtered rooms have signs or justification");
  });

  it("passes when an R1-filtered room has 0 signs but has an exclusion reason", () => {
    const room = makeRoom({ passedR1Filter: true });
    const assignment = makeAssignment({ signs: [], exclusionReasons: ["Closet"] });
    const report = verifyRuleEngineResult(
      makeResult([assignment]),
      makeInventory({ rooms: [room] }),
      makeManifest(),
    );
    expect(report.checksPassed).toContain("V7 — All R1-filtered rooms have signs or justification");
  });

  it("fails when an R1-filtered room has 0 signs and no exclusion reason", () => {
    const room = makeRoom({ passedR1Filter: true });
    const assignment = makeAssignment({ signs: [], exclusionReasons: [] });
    const report = verifyRuleEngineResult(
      makeResult([assignment]),
      makeInventory({ rooms: [room] }),
      makeManifest(),
    );
    expect(report.errors.some((e) => e.startsWith("V7"))).toBe(true);
  });

  it("ignores rooms that did not pass the R1 filter", () => {
    const room = makeRoom({ passedR1Filter: false });
    const assignment = makeAssignment({ signs: [], exclusionReasons: [] });
    const report = verifyRuleEngineResult(
      makeResult([assignment]),
      makeInventory({ rooms: [room] }),
      makeManifest(),
    );
    expect(report.errors.filter((e) => e.startsWith("V7"))).toHaveLength(0);
  });
});

// ── Overall report shape ──────────────────────────────────────────────────────

describe("overall report — passed flag and summary", () => {
  it("report.passed is true when there are no errors", () => {
    const room = makeRoom();
    const assignment = makeAssignment({ signs: ["Room ID"] });
    const report = verifyRuleEngineResult(
      makeResult([assignment]),
      makeInventory({ rooms: [room] }),
      makeManifest(),
    );
    expect(report.passed).toBe(true);
  });

  it("report.passed is false when any error is present", () => {
    const room = makeRoom({ passedR1Filter: true });
    const assignment = makeAssignment({ signs: [], exclusionReasons: [] });
    const report = verifyRuleEngineResult(
      makeResult([assignment]),
      makeInventory({ rooms: [room] }),
      makeManifest(),
    );
    expect(report.passed).toBe(false);
  });

  it("summary.totalRooms equals the number of rooms in inventory", () => {
    const rooms = [
      makeRoom({ roomId: "r1" }),
      makeRoom({ roomId: "r2", roomNumber: "102" }),
    ];
    const assignments = rooms.map((r) =>
      makeAssignment({ roomId: r.roomId, roomNumber: r.roomNumber, signs: ["Room ID"] }),
    );
    const report = verifyRuleEngineResult(
      makeResult(assignments),
      makeInventory({ rooms }),
      makeManifest(),
    );
    expect(report.summary.totalRooms).toBe(2);
  });
});
