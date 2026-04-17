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
    expect(report.checksPassed.some((c) => /no files processed/i.test(c))).toBe(true);
  });

  it("returns passed=true with a warning when files existed but no assignments were produced", () => {
    const report = verifyRuleEngineResult(
      makeResult([]),
      makeRoomSummary(),
      makeJobContext({ pageCount: 2 }),
    );
    expect(report.passed).toBe(true);
    expect(report.errors).toHaveLength(0);
    expect(report.warnings.some((w) => /no rule engine assignments/i.test(w))).toBe(true);
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
