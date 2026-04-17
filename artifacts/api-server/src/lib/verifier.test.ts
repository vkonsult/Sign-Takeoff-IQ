import { describe, it, expect } from "vitest";
import { verifyRuleEngineResult } from "./verifier";
import type { AssignmentsSummary, RoomSummary, JobContext } from "./verifier";
import type { SignAssignment } from "./rule-engine";

// ── Factories ─────────────────────────────────────────────────────────────────

function makeAssignment(overrides: Partial<SignAssignment> = {}): SignAssignment {
  return {
    roomNumber: "101",
    roomName: "Office",
    level: "L1",
    pdfPage: 1,
    roomId: 1,
    roomIdWithInsert: null,
    restroom: null,
    exit: null,
    maxOccupancy: null,
    stairCorridor: null,
    stairLanding: null,
    inCaseOfFire: null,
    evacuationMap: null,
    officeDirectory: null,
    appliedRules: ["R1"],
    exclusionReasons: [],
    sourceSheet: null,
    ambiguous: false,
    ambiguityNote: null,
    ...overrides,
  };
}

function makeRoomSummary(overrides: Partial<RoomSummary> = {}): RoomSummary {
  return {
    rooms: [],
    elevatorCount: 0,
    stairCount: 0,
    levelNames: ["L1"],
    ...overrides,
  };
}

function makeJobContext(overrides: Partial<JobContext> = {}): JobContext {
  return {
    levels: ["L1"],
    pageCount: 1,
    ...overrides,
  };
}

function makeResult(
  assignments: SignAssignment[],
  byLevel: Record<string, SignAssignment[]> = {},
): AssignmentsSummary {
  return { assignments, byLevel };
}

// ── No-data guard ─────────────────────────────────────────────────────────────

describe("no-data guard", () => {
  it("returns passed=true with a checksPassed note when no files were processed", () => {
    const report = verifyRuleEngineResult(
      makeResult([]),
      makeRoomSummary(),
      makeJobContext({ pageCount: 0 }),
    );
    expect(report.passed).toBe(true);
    expect(report.errors).toHaveLength(0);
    expect(report.checksPassed.some((c) => /V1.*V7.*no files processed/i.test(c))).toBe(true);
  });

  it("returns passed=true with a warning when files existed but no assignments were produced", () => {
    const report = verifyRuleEngineResult(
      makeResult([]),
      makeRoomSummary(),
      makeJobContext({ pageCount: 2 }),
    );
    expect(report.passed).toBe(true);
    expect(report.errors).toHaveLength(0);
    expect(report.warnings.some((w) => /V1.*V7.*no rule engine assignments/i.test(w))).toBe(true);
  });
});

// ── V1: Room completeness ──────────────────────────────────────────────────────

describe("V1 — Room completeness", () => {
  it("passes when every room has at least one applied rule", () => {
    const assignment = makeAssignment({ appliedRules: ["R1"] });
    const report = verifyRuleEngineResult(
      makeResult([assignment]),
      makeRoomSummary(),
      makeJobContext(),
    );
    expect(report.checksPassed.some((c) => c.startsWith("V1"))).toBe(true);
    expect(report.errors.filter((e) => e.startsWith("V1"))).toHaveLength(0);
  });

  it("passes when a room has no applied rules but has an exclusion reason", () => {
    const assignment = makeAssignment({ appliedRules: [], exclusionReasons: ["R4: is_corridor_or_hall"] });
    const report = verifyRuleEngineResult(
      makeResult([assignment]),
      makeRoomSummary(),
      makeJobContext(),
    );
    expect(report.checksPassed.some((c) => c.startsWith("V1"))).toBe(true);
    expect(report.errors.filter((e) => e.startsWith("V1"))).toHaveLength(0);
  });

  it("fails when a room has no applied rules and no exclusion reason", () => {
    const assignment = makeAssignment({ appliedRules: [], exclusionReasons: [] });
    const report = verifyRuleEngineResult(
      makeResult([assignment]),
      makeRoomSummary(),
      makeJobContext(),
    );
    expect(report.errors.some((e) => e.startsWith("V1"))).toBe(true);
    expect(report.passed).toBe(false);
  });

  it("includes sampled room names in the V1 error message", () => {
    const assignments = [
      makeAssignment({ roomNumber: "101", roomName: "Room A", appliedRules: [], exclusionReasons: [] }),
      makeAssignment({ roomNumber: "102", roomName: "Room B", appliedRules: [], exclusionReasons: [] }),
    ];
    const report = verifyRuleEngineResult(makeResult(assignments), makeRoomSummary(), makeJobContext());
    expect(report.errors[0]).toMatch(/101/);
  });
});

// ── V2: Stair plaque totals ────────────────────────────────────────────────────

describe("V2 — Stair plaque totals", () => {
  it("passes (informational) when no stair rooms are detected", () => {
    const assignment = makeAssignment({ appliedRules: ["R1"] });
    const report = verifyRuleEngineResult(
      makeResult([assignment]),
      makeRoomSummary({ stairCount: 0 }),
      makeJobContext(),
    );
    expect(report.checksPassed.some((c) => /stair.*no stair rooms/i.test(c))).toBe(true);
    expect(report.errors.filter((e) => e.startsWith("V2"))).toHaveLength(0);
  });

  it("fails when stair rooms exist but no stair landing signs were assigned", () => {
    const assignment = makeAssignment({ appliedRules: ["R1"], stairLanding: null });
    const report = verifyRuleEngineResult(
      makeResult([assignment]),
      makeRoomSummary({ stairCount: 2 }),
      makeJobContext(),
    );
    expect(report.errors.some((e) => e.startsWith("V2") && /landing/i.test(e))).toBe(true);
    expect(report.passed).toBe(false);
  });

  it("fails when stair landing total does not equal stairCount", () => {
    // stairCount = 3 (3 stair × level occurrences), but only 2 landing signs assigned
    const assignments = [
      makeAssignment({ roomNumber: "S1", appliedRules: ["R11"], stairLanding: 1, stairCorridor: 1 }),
      makeAssignment({ roomNumber: "S2", appliedRules: ["R11"], stairLanding: 1, stairCorridor: 1 }),
    ];
    const report = verifyRuleEngineResult(
      makeResult(assignments),
      makeRoomSummary({ stairCount: 3 }),
      makeJobContext(),
    );
    expect(report.errors.some((e) => e.startsWith("V2") && /≠/.test(e))).toBe(true);
    expect(report.passed).toBe(false);
  });

  it("passes when total stairLanding equals stairCount", () => {
    const assignments = [
      makeAssignment({ roomNumber: "S1", appliedRules: ["R11"], stairLanding: 1, stairCorridor: 1 }),
      makeAssignment({ roomNumber: "S2", appliedRules: ["R11"], stairLanding: 1, stairCorridor: 1 }),
    ];
    const report = verifyRuleEngineResult(
      makeResult(assignments),
      makeRoomSummary({ stairCount: 2 }),
      makeJobContext(),
    );
    expect(report.errors.filter((e) => e.startsWith("V2"))).toHaveLength(0);
    expect(report.checksPassed.some((c) => c.startsWith("V2"))).toBe(true);
  });

  it("fails when stair rooms exist but no stair corridor signs were assigned", () => {
    const assignment = makeAssignment({ appliedRules: ["R11"], stairLanding: 2, stairCorridor: null });
    const report = verifyRuleEngineResult(
      makeResult([assignment, makeAssignment({ appliedRules: ["R11"], stairLanding: 1, stairCorridor: null })]),
      makeRoomSummary({ stairCount: 2 }),
      makeJobContext(),
    );
    expect(report.errors.some((e) => e.startsWith("V2") && /corridor/i.test(e))).toBe(true);
  });
});

// ── V3: EXIT count (IBC Table 1006.3) ────────────────────────────────────────

describe("V3 — EXIT count (IBC Table 1006.3)", () => {
  it("passes when assembly spaces each have ≥2 exits", () => {
    const assignment = makeAssignment({
      appliedRules: ["R1", "R9", "R10"],
      maxOccupancy: 1,
      exit: 2,
    });
    const report = verifyRuleEngineResult(makeResult([assignment]), makeRoomSummary(), makeJobContext());
    expect(report.errors.filter((e) => e.startsWith("V3"))).toHaveLength(0);
    expect(report.checksPassed.some((c) => c.startsWith("V3"))).toBe(true);
  });

  it("fails (hard error) when an assembly space has fewer than 2 exits", () => {
    const assignment = makeAssignment({
      appliedRules: ["R1", "R9", "R10"],
      maxOccupancy: 1,
      exit: 1,
    });
    const report = verifyRuleEngineResult(makeResult([assignment]), makeRoomSummary(), makeJobContext());
    expect(report.errors.some((e) => e.startsWith("V3"))).toBe(true);
    expect(report.passed).toBe(false);
    // Must be an error, not just a warning
    expect(report.warnings.filter((w) => w.startsWith("V3"))).toHaveLength(0);
  });

  it("fails (hard error) when an assembly space has 0 exits assigned", () => {
    const assignment = makeAssignment({
      appliedRules: ["R10"],
      maxOccupancy: 1,
      exit: null,
    });
    const report = verifyRuleEngineResult(makeResult([assignment]), makeRoomSummary(), makeJobContext());
    expect(report.errors.some((e) => e.startsWith("V3"))).toBe(true);
  });

  it("passes (informational) when there are no assembly spaces", () => {
    const assignment = makeAssignment({ appliedRules: ["R1"], maxOccupancy: null });
    const report = verifyRuleEngineResult(makeResult([assignment]), makeRoomSummary(), makeJobContext());
    expect(report.errors.filter((e) => e.startsWith("V3"))).toHaveLength(0);
    expect(report.checksPassed.some((c) => c.startsWith("V3"))).toBe(true);
  });

  it("includes the assembly room name in the V3 error message", () => {
    const assignment = makeAssignment({
      roomNumber: "200",
      roomName: "Auditorium",
      appliedRules: ["R10"],
      maxOccupancy: 1,
      exit: 1,
    });
    const report = verifyRuleEngineResult(makeResult([assignment]), makeRoomSummary(), makeJobContext());
    expect(report.errors[0]).toMatch(/200/);
  });
});

// ── V4: In Case of Fire = elevator count ──────────────────────────────────────

describe("V4 — In Case of Fire count = elevator count", () => {
  it("passes when ICF count matches elevator count exactly", () => {
    const a1 = makeAssignment({ roomNumber: "E1", appliedRules: ["R12"], inCaseOfFire: 1 });
    const a2 = makeAssignment({ roomNumber: "E2", appliedRules: ["R12"], inCaseOfFire: 1 });
    const report = verifyRuleEngineResult(
      makeResult([a1, a2]),
      makeRoomSummary({ elevatorCount: 2 }),
      makeJobContext(),
    );
    expect(report.errors.filter((e) => e.startsWith("V4"))).toHaveLength(0);
    expect(report.checksPassed.some((c) => c.startsWith("V4"))).toBe(true);
  });

  it("fails when elevators exist but no ICF signs were assigned", () => {
    const assignment = makeAssignment({ appliedRules: ["R1"], inCaseOfFire: null });
    const report = verifyRuleEngineResult(
      makeResult([assignment]),
      makeRoomSummary({ elevatorCount: 2 }),
      makeJobContext(),
    );
    expect(report.errors.some((e) => e.startsWith("V4") && /no In Case of Fire/i.test(e))).toBe(true);
    expect(report.passed).toBe(false);
  });

  it("fails when ICF count differs from elevator count", () => {
    // R12 deduplication assigned only 1 but there are 3 elevators
    const assignment = makeAssignment({ appliedRules: ["R12"], inCaseOfFire: 1 });
    const report = verifyRuleEngineResult(
      makeResult([assignment]),
      makeRoomSummary({ elevatorCount: 3 }),
      makeJobContext(),
    );
    expect(report.errors.some((e) => e.startsWith("V4") && /counts must match/i.test(e))).toBe(true);
    expect(report.passed).toBe(false);
  });

  it("passes (informational) when there are no elevators and no ICF signs", () => {
    const assignment = makeAssignment({ appliedRules: ["R1"], inCaseOfFire: null });
    const report = verifyRuleEngineResult(
      makeResult([assignment]),
      makeRoomSummary({ elevatorCount: 0 }),
      makeJobContext(),
    );
    expect(report.errors.filter((e) => e.startsWith("V4"))).toHaveLength(0);
    expect(report.checksPassed.some((c) => /no elevators/i.test(c))).toBe(true);
  });
});

// ── V1 edge cases ─────────────────────────────────────────────────────────────

describe("V1 — Room completeness (edge cases)", () => {
  it("error message includes '…' when more than 3 rooms are incomplete", () => {
    const assignments = [
      makeAssignment({ roomNumber: "101", roomName: "Room A", appliedRules: [], exclusionReasons: [] }),
      makeAssignment({ roomNumber: "102", roomName: "Room B", appliedRules: [], exclusionReasons: [] }),
      makeAssignment({ roomNumber: "103", roomName: "Room C", appliedRules: [], exclusionReasons: [] }),
      makeAssignment({ roomNumber: "104", roomName: "Room D", appliedRules: [], exclusionReasons: [] }),
    ];
    const report = verifyRuleEngineResult(makeResult(assignments), makeRoomSummary(), makeJobContext());
    expect(report.errors[0]).toMatch(/…/);
  });

  it("counts all incomplete rooms in the error even when some rooms are complete", () => {
    const assignments = [
      makeAssignment({ roomNumber: "101", roomName: "Office A", appliedRules: ["R1"], exclusionReasons: [] }),
      makeAssignment({ roomNumber: "102", roomName: "Office B", appliedRules: [], exclusionReasons: ["R4: corridor"] }),
      makeAssignment({ roomNumber: "103", roomName: "Mystery Room", appliedRules: [], exclusionReasons: [] }),
      makeAssignment({ roomNumber: "104", roomName: "Another Room", appliedRules: [], exclusionReasons: [] }),
    ];
    const report = verifyRuleEngineResult(makeResult(assignments), makeRoomSummary(), makeJobContext());
    expect(report.errors.some((e) => e.startsWith("V1") && e.includes("2 room"))).toBe(true);
    expect(report.passed).toBe(false);
  });

  it("uses roomName alone in the sample when roomNumber is null", () => {
    const assignment = makeAssignment({ roomNumber: null, roomName: "Unnamed Corridor", appliedRules: [], exclusionReasons: [] });
    const report = verifyRuleEngineResult(makeResult([assignment]), makeRoomSummary(), makeJobContext());
    expect(report.errors[0]).toMatch(/Unnamed Corridor/);
  });
});

// ── V2 edge cases (partial levelsServed) ──────────────────────────────────────

describe("V2 — Stair plaque totals (edge cases)", () => {
  it("fails with a mismatch error when stairLanding count exceeds stairCount (over-assigned)", () => {
    // 2 stair rooms, each assigned 1 landing sign, but stairCount says only 1 occurrence
    const assignments = [
      makeAssignment({ roomNumber: "S1", appliedRules: ["R11"], stairLanding: 1, stairCorridor: 1 }),
      makeAssignment({ roomNumber: "S2", appliedRules: ["R11"], stairLanding: 1, stairCorridor: 1 }),
    ];
    const report = verifyRuleEngineResult(
      makeResult(assignments),
      makeRoomSummary({ stairCount: 1 }),
      makeJobContext(),
    );
    expect(report.errors.some((e) => e.startsWith("V2") && /≠/.test(e))).toBe(true);
    expect(report.passed).toBe(false);
  });

  it("fails with partial level coverage: 2 stairs × 3 levels = 6 expected, only 4 landing signs assigned", () => {
    // Realistic multi-stair multi-level scenario
    const assignments = [
      makeAssignment({ roomNumber: "S1-L1", level: "L1", appliedRules: ["R11"], stairLanding: 1, stairCorridor: 1 }),
      makeAssignment({ roomNumber: "S1-L2", level: "L2", appliedRules: ["R11"], stairLanding: 1, stairCorridor: 1 }),
      makeAssignment({ roomNumber: "S2-L1", level: "L1", appliedRules: ["R11"], stairLanding: 1, stairCorridor: 1 }),
      makeAssignment({ roomNumber: "S2-L2", level: "L2", appliedRules: ["R11"], stairLanding: 1, stairCorridor: 1 }),
    ];
    const report = verifyRuleEngineResult(
      makeResult(assignments),
      makeRoomSummary({ stairCount: 6 }),
      makeJobContext({ levels: ["L1", "L2", "L3"] }),
    );
    expect(report.errors.some((e) => e.startsWith("V2") && /4.*6|6.*4/.test(e))).toBe(true);
    expect(report.passed).toBe(false);
  });

  it("passes when multi-stair multi-level counts match exactly (2 stairs × 2 levels = 4)", () => {
    const assignments = [
      makeAssignment({ roomNumber: "SA-L1", level: "L1", appliedRules: ["R11"], stairLanding: 1, stairCorridor: 1 }),
      makeAssignment({ roomNumber: "SA-L2", level: "L2", appliedRules: ["R11"], stairLanding: 1, stairCorridor: 1 }),
      makeAssignment({ roomNumber: "SB-L1", level: "L1", appliedRules: ["R11"], stairLanding: 1, stairCorridor: 1 }),
      makeAssignment({ roomNumber: "SB-L2", level: "L2", appliedRules: ["R11"], stairLanding: 1, stairCorridor: 1 }),
    ];
    const report = verifyRuleEngineResult(
      makeResult(assignments),
      makeRoomSummary({ stairCount: 4 }),
      makeJobContext({ levels: ["L1", "L2"] }),
    );
    expect(report.errors.filter((e) => e.startsWith("V2"))).toHaveLength(0);
    expect(report.checksPassed.some((c) => c.startsWith("V2") && /4/.test(c))).toBe(true);
  });
});

// ── V3 edge cases (assembly capacity) ─────────────────────────────────────────

describe("V3 — EXIT count (edge cases)", () => {
  it("does NOT flag a room with maxOccupancy=0 as an assembly space", () => {
    // maxOccupancy=0 means no capacity sign was assigned — not treated as assembly room
    const assignment = makeAssignment({
      appliedRules: ["R1"],
      maxOccupancy: 0,
      exit: 1,
    });
    const report = verifyRuleEngineResult(makeResult([assignment]), makeRoomSummary(), makeJobContext());
    expect(report.errors.filter((e) => e.startsWith("V3"))).toHaveLength(0);
    expect(report.checksPassed.some((c) => c.startsWith("V3") && /no assembly/i.test(c))).toBe(true);
  });

  it("counts only the failing assembly rooms in the V3 error (not the passing ones)", () => {
    // Auditorium passes; Conference Room fails
    const passing = makeAssignment({ roomNumber: "200", roomName: "Auditorium", appliedRules: ["R10"], maxOccupancy: 1, exit: 2 });
    const failing = makeAssignment({ roomNumber: "201", roomName: "Conference Room", appliedRules: ["R10"], maxOccupancy: 1, exit: 1 });
    const report = verifyRuleEngineResult(makeResult([passing, failing]), makeRoomSummary(), makeJobContext());
    expect(report.errors.some((e) => e.startsWith("V3") && e.includes("1 assembly"))).toBe(true);
    expect(report.errors[0]).toMatch(/201/);
    expect(report.passed).toBe(false);
  });

  it("V3 error message truncates with '…' when more than 3 assembly spaces fail", () => {
    const rooms = ["Hall A", "Hall B", "Hall C", "Hall D"].map((name, i) =>
      makeAssignment({ roomNumber: String(300 + i), roomName: name, appliedRules: ["R10"], maxOccupancy: 1, exit: 0 }),
    );
    const report = verifyRuleEngineResult(makeResult(rooms), makeRoomSummary(), makeJobContext());
    expect(report.errors[0]).toMatch(/…/);
    expect(report.passed).toBe(false);
  });

  it("passes when all assembly spaces have exactly 2 exits (boundary)", () => {
    const assignments = [
      makeAssignment({ roomNumber: "300", roomName: "Ballroom", appliedRules: ["R10"], maxOccupancy: 1, exit: 2 }),
      makeAssignment({ roomNumber: "301", roomName: "Theater", appliedRules: ["R10"], maxOccupancy: 1, exit: 3 }),
    ];
    const report = verifyRuleEngineResult(makeResult(assignments), makeRoomSummary(), makeJobContext());
    expect(report.errors.filter((e) => e.startsWith("V3"))).toHaveLength(0);
    expect(report.checksPassed.some((c) => c.startsWith("V3") && /2 assembly/i.test(c))).toBe(true);
  });
});

// ── V4 edge cases (mixed elevator ICF counts) ─────────────────────────────────

describe("V4 — In Case of Fire count (edge cases)", () => {
  it("passes when ICF signs are spread across multiple assignments and total matches", () => {
    // 3 elevators, ICF sign assigned in three separate assignments
    const a1 = makeAssignment({ roomNumber: "EL1", appliedRules: ["R12"], inCaseOfFire: 1 });
    const a2 = makeAssignment({ roomNumber: "EL2", appliedRules: ["R12"], inCaseOfFire: 1 });
    const a3 = makeAssignment({ roomNumber: "EL3", appliedRules: ["R12"], inCaseOfFire: 1 });
    const report = verifyRuleEngineResult(
      makeResult([a1, a2, a3]),
      makeRoomSummary({ elevatorCount: 3 }),
      makeJobContext(),
    );
    expect(report.errors.filter((e) => e.startsWith("V4"))).toHaveLength(0);
    expect(report.checksPassed.some((c) => c.startsWith("V4") && /3/.test(c))).toBe(true);
  });

  it("fails (mismatch) when more ICF signs than elevators (over-assigned)", () => {
    // 2 elevators but 3 ICF signs assigned
    const assignments = [
      makeAssignment({ roomNumber: "EL1", appliedRules: ["R12"], inCaseOfFire: 2 }),
      makeAssignment({ roomNumber: "EL2", appliedRules: ["R12"], inCaseOfFire: 1 }),
    ];
    const report = verifyRuleEngineResult(
      makeResult(assignments),
      makeRoomSummary({ elevatorCount: 2 }),
      makeJobContext(),
    );
    expect(report.errors.some((e) => e.startsWith("V4") && /counts must match/i.test(e))).toBe(true);
    expect(report.passed).toBe(false);
  });

  it("fails correctly when some assignments have ICF and some do not, resulting in a total mismatch", () => {
    // 4 elevators detected, but only 2 ICF signs assigned (mixed scenario)
    const a1 = makeAssignment({ roomNumber: "EL1", appliedRules: ["R12"], inCaseOfFire: 1 });
    const a2 = makeAssignment({ roomNumber: "EL2", appliedRules: ["R12"], inCaseOfFire: 1 });
    const a3 = makeAssignment({ roomNumber: "EL3", appliedRules: ["R1"], inCaseOfFire: null });
    const a4 = makeAssignment({ roomNumber: "EL4", appliedRules: ["R1"], inCaseOfFire: null });
    const report = verifyRuleEngineResult(
      makeResult([a1, a2, a3, a4]),
      makeRoomSummary({ elevatorCount: 4 }),
      makeJobContext(),
    );
    expect(report.errors.some((e) => e.startsWith("V4") && /counts must match/i.test(e))).toBe(true);
    expect(report.passed).toBe(false);
  });
});

// ── V5 — Sign count summary (edge cases) ──────────────────────────────────────

describe("V5 — Sign count summary (edge cases)", () => {
  it("null sign quantities are omitted from summary.byType", () => {
    const assignment = makeAssignment({ appliedRules: ["R1"], roomId: 1, restroom: null, exit: null });
    const report = verifyRuleEngineResult(makeResult([assignment]), makeRoomSummary(), makeJobContext());
    expect(report.summary.byType["restroom"]).toBeUndefined();
    expect(report.summary.byType["exit"]).toBeUndefined();
    expect(report.summary.byType["roomId"]).toBe(1);
  });

  it("all sign types aggregate correctly across multiple assignments", () => {
    const a1 = makeAssignment({ appliedRules: ["R1"], roomId: 1, exit: 2, maxOccupancy: 1 });
    const a2 = makeAssignment({ roomNumber: "102", appliedRules: ["R1"], roomId: 1, exit: 2 });
    const report = verifyRuleEngineResult(
      makeResult([a1, a2]),
      makeRoomSummary(),
      makeJobContext(),
    );
    expect(report.summary.byType["roomId"]).toBe(2);
    expect(report.summary.byType["exit"]).toBe(4);
    expect(report.summary.byType["maxOccupancy"]).toBe(1);
    expect(report.summary.totalSigns).toBe(7);
  });

  it("duplicate ambiguous notes from the same room+level are deduplicated", () => {
    const a1 = makeAssignment({
      roomNumber: "150",
      roomName: "Flex Space",
      level: "L2",
      appliedRules: ["R2"],
      ambiguous: true,
      ambiguityNote: "R2: variable-use room — verify door count",
    });
    const a2 = makeAssignment({
      roomNumber: "150",
      roomName: "Flex Space",
      level: "L2",
      appliedRules: ["R2"],
      ambiguous: true,
      ambiguityNote: "R2: variable-use room — verify door count",
    });
    const report = verifyRuleEngineResult(makeResult([a1, a2]), makeRoomSummary(), makeJobContext());
    expect(report.questionsForVerification.filter((q) => q.includes("variable-use"))).toHaveLength(1);
  });

  it("zero-valued sign quantities are omitted from summary.byType", () => {
    const assignment = makeAssignment({ appliedRules: ["R1"], roomId: 1, exit: 0 });
    const report = verifyRuleEngineResult(makeResult([assignment]), makeRoomSummary(), makeJobContext());
    expect(report.summary.byType["exit"]).toBeUndefined();
  });
});

// ── V6: Assembly capacity sign completeness ────────────────────────────────────

describe("V6 — Assembly capacity sign completeness (R10)", () => {
  it("passes when every R10 room has a maxOccupancy sign assigned", () => {
    const assignment = makeAssignment({
      appliedRules: ["R1", "R9", "R10"],
      maxOccupancy: 1,
      exit: 2,
      evacuationMap: 1,
    });
    const report = verifyRuleEngineResult(makeResult([assignment]), makeRoomSummary(), makeJobContext());
    expect(report.errors.filter((e) => e.startsWith("V6"))).toHaveLength(0);
    expect(report.checksPassed.some((c) => c.startsWith("V6") && /all.*R10/i.test(c))).toBe(true);
  });

  it("fails (hard error) when an R10 room has maxOccupancy=null", () => {
    const assignment = makeAssignment({
      appliedRules: ["R1", "R10"],
      maxOccupancy: null,
      exit: 2,
      evacuationMap: 1,
    });
    const report = verifyRuleEngineResult(makeResult([assignment]), makeRoomSummary(), makeJobContext());
    expect(report.errors.some((e) => e.startsWith("V6"))).toBe(true);
    expect(report.passed).toBe(false);
    expect(report.warnings.filter((w) => w.startsWith("V6"))).toHaveLength(0);
  });

  it("fails (hard error) when an R10 room has maxOccupancy=0", () => {
    const assignment = makeAssignment({
      roomNumber: "400",
      roomName: "Assembly Hall",
      appliedRules: ["R10"],
      maxOccupancy: 0,
      exit: 2,
      evacuationMap: 1,
    });
    const report = verifyRuleEngineResult(makeResult([assignment]), makeRoomSummary(), makeJobContext());
    expect(report.errors.some((e) => e.startsWith("V6") && /400/.test(e))).toBe(true);
    expect(report.passed).toBe(false);
  });

  it("passes (informational) when no R10 rooms are present", () => {
    const assignment = makeAssignment({ appliedRules: ["R1"], evacuationMap: 1 });
    const report = verifyRuleEngineResult(makeResult([assignment]), makeRoomSummary(), makeJobContext());
    expect(report.errors.filter((e) => e.startsWith("V6"))).toHaveLength(0);
    expect(report.checksPassed.some((c) => c.startsWith("V6") && /no R10/i.test(c))).toBe(true);
  });

  it("V6 error message includes '…' when more than 3 R10 rooms are missing capacity signs", () => {
    const rooms = ["Hall A", "Hall B", "Hall C", "Hall D"].map((name, i) =>
      makeAssignment({ roomNumber: String(500 + i), roomName: name, appliedRules: ["R10"], maxOccupancy: null, exit: 2, evacuationMap: 1 }),
    );
    const report = verifyRuleEngineResult(makeResult(rooms), makeRoomSummary(), makeJobContext());
    expect(report.errors[0]).toMatch(/…/);
  });

  it("does not flag a room that has R10 absent from appliedRules even if maxOccupancy is null", () => {
    const assignment = makeAssignment({ appliedRules: ["R1"], maxOccupancy: null, evacuationMap: 1 });
    const report = verifyRuleEngineResult(makeResult([assignment]), makeRoomSummary(), makeJobContext());
    expect(report.errors.filter((e) => e.startsWith("V6"))).toHaveLength(0);
  });
});

// ── V7: Evacuation map per-level coverage ─────────────────────────────────────

describe("V7 — Evacuation map per-level coverage (R13)", () => {
  it("passes when every level has at least one evacuation map sign", () => {
    const a1 = makeAssignment({ level: "L1", appliedRules: ["R1"], evacuationMap: 1 });
    const a2 = makeAssignment({ roomNumber: "202", level: "L2", appliedRules: ["R1"], evacuationMap: 1 });
    const report = verifyRuleEngineResult(makeResult([a1, a2]), makeRoomSummary(), makeJobContext({ levels: ["L1", "L2"] }));
    expect(report.warnings.filter((w) => w.startsWith("V7"))).toHaveLength(0);
    expect(report.checksPassed.some((c) => c.startsWith("V7") && /2 level/i.test(c))).toBe(true);
  });

  it("warns (not errors) when a level has rooms but no evacuation map assigned", () => {
    const assignment = makeAssignment({ level: "L1", appliedRules: ["R1"], evacuationMap: null });
    const report = verifyRuleEngineResult(makeResult([assignment]), makeRoomSummary(), makeJobContext());
    expect(report.warnings.some((w) => w.startsWith("V7"))).toBe(true);
    expect(report.errors.filter((e) => e.startsWith("V7"))).toHaveLength(0);
    expect(report.passed).toBe(true);
  });

  it("warning message lists the level names missing evacuation maps", () => {
    const a1 = makeAssignment({ level: "L1", appliedRules: ["R1"], evacuationMap: 1 });
    const a2 = makeAssignment({ roomNumber: "202", level: "L2", appliedRules: ["R1"], evacuationMap: null });
    const report = verifyRuleEngineResult(makeResult([a1, a2]), makeRoomSummary(), makeJobContext({ levels: ["L1", "L2"] }));
    expect(report.warnings.some((w) => w.startsWith("V7") && w.includes("L2"))).toBe(true);
    expect(report.warnings.some((w) => w.startsWith("V7") && w.includes("L1"))).toBe(false);
  });

  it("warns when all levels are missing evacuation maps (multi-level building)", () => {
    const a1 = makeAssignment({ level: "L1", appliedRules: ["R1"], evacuationMap: null });
    const a2 = makeAssignment({ roomNumber: "202", level: "L2", appliedRules: ["R1"], evacuationMap: null });
    const a3 = makeAssignment({ roomNumber: "303", level: "L3", appliedRules: ["R1"], evacuationMap: null });
    const report = verifyRuleEngineResult(
      makeResult([a1, a2, a3]),
      makeRoomSummary(),
      makeJobContext({ levels: ["L1", "L2", "L3"] }),
    );
    expect(report.warnings.some((w) => w.startsWith("V7") && /3 level/i.test(w))).toBe(true);
  });

  it("passes when a level has multiple rooms and only one has an evacuation map", () => {
    const lobby = makeAssignment({ level: "L1", appliedRules: ["R13"], evacuationMap: 1 });
    const office = makeAssignment({ roomNumber: "102", level: "L1", appliedRules: ["R1"], evacuationMap: null });
    const storage = makeAssignment({ roomNumber: "103", level: "L1", appliedRules: ["R1"], evacuationMap: null });
    const report = verifyRuleEngineResult(makeResult([lobby, office, storage]), makeRoomSummary(), makeJobContext());
    expect(report.warnings.filter((w) => w.startsWith("V7"))).toHaveLength(0);
    expect(report.checksPassed.some((c) => c.startsWith("V7"))).toBe(true);
  });

  it("does NOT flag a level listed in jobContext.levels that has no assignments (V7 only checks levels with actual room assignments)", () => {
    // L1 has an assignment with an evac map; L3 is in the manifest but has no
    // assignment rows at all — V7 does not warn about L3 because there are no
    // rooms on that level to verify coverage against.
    const a1 = makeAssignment({ level: "L1", appliedRules: ["R13"], evacuationMap: 1 });
    const report = verifyRuleEngineResult(
      makeResult([a1]),
      makeRoomSummary(),
      makeJobContext({ levels: ["L1", "L2", "L3"] }),
    );
    expect(report.warnings.filter((w) => w.startsWith("V7"))).toHaveLength(0);
    expect(report.checksPassed.some((c) => c.startsWith("V7"))).toBe(true);
  });
});

// ── Overall report shape ───────────────────────────────────────────────────────

describe("overall report — passed flag and summary", () => {
  it("report.passed is true when there are no errors", () => {
    const assignment = makeAssignment({ appliedRules: ["R1"] });
    const report = verifyRuleEngineResult(
      makeResult([assignment]),
      makeRoomSummary(),
      makeJobContext(),
    );
    expect(report.passed).toBe(true);
  });

  it("report.passed is false when any error is present", () => {
    const assignment = makeAssignment({ appliedRules: [], exclusionReasons: [] });
    const report = verifyRuleEngineResult(
      makeResult([assignment]),
      makeRoomSummary(),
      makeJobContext(),
    );
    expect(report.passed).toBe(false);
  });

  it("summary.totalSigns sums all assigned sign quantities", () => {
    const a1 = makeAssignment({ appliedRules: ["R1"], roomId: 2, restroom: 1 });
    // Stair rooms have no roomId sign — set to null to avoid double-counting
    const a2 = makeAssignment({ roomNumber: "102", appliedRules: ["R11"], roomId: null, stairLanding: 1, stairCorridor: 1 });
    const report = verifyRuleEngineResult(
      makeResult([a1, a2]),
      makeRoomSummary({ stairCount: 1 }),
      makeJobContext(),
    );
    // a1: roomId=2 + restroom=1 = 3; a2: stairLanding=1 + stairCorridor=1 = 2; total = 5
    expect(report.summary.totalSigns).toBe(5);
  });

  it("summary.byType correctly groups sign quantities by type key", () => {
    const assignment = makeAssignment({
      appliedRules: ["R1", "R9"],
      roomId: 1,
      exit: 2,
    });
    const report = verifyRuleEngineResult(
      makeResult([assignment]),
      makeRoomSummary(),
      makeJobContext(),
    );
    expect(report.summary.byType["roomId"]).toBe(1);
    expect(report.summary.byType["exit"]).toBe(2);
  });

  it("ambiguous assignments are forwarded as questionsForVerification", () => {
    const assignment = makeAssignment({
      appliedRules: ["R2"],
      ambiguous: true,
      ambiguityNote: "R2: variable-use room — verify door count",
    });
    const report = verifyRuleEngineResult(
      makeResult([assignment]),
      makeRoomSummary(),
      makeJobContext(),
    );
    expect(report.questionsForVerification.some((q) => q.includes("variable-use"))).toBe(true);
  });
});
