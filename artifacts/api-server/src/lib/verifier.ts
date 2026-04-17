/**
 * Phase 6 — Verify & Output
 *
 * Implements the mandatory pre-output verification checks described in
 * SignTakeoff System Prompt v1.1, Phase 6.  These checks run after the
 * rule engine (Phase 5) and before writing the final results to the DB.
 *
 * Checks implemented:
 *   V1 — Every room accounted for
 *   V2 — Restroom count matches
 *   V3 — EXIT count ≥ IBC Table 1006.3 minimum
 *   V4 — Stair plaque totals match expected values
 *   V5 — "In Case of Fire" count = elevator count
 *   V6 — Assembly rooms have capacity signs
 *   V7 — No zero-sign rooms without justification
 *
 * When Phase 4 (RoomInventory) and Phase 5 (RuleEngine) prerequisites are not
 * yet available, the verifier returns `passed: false` with an explicit
 * "prerequisites not yet available" question for each check rather than
 * silently reporting all-clear.
 */

// ── Type definitions ──────────────────────────────────────────────────────────
// These types represent the output of the (planned) Phase 4 and Phase 5 modules.
// They are defined here so the verifier can be used as-is once those modules ship.

/** A single room extracted by the Phase 4 Room Inventory module. */
export interface Room {
  roomId: string;
  roomNumber: string;
  roomName: string;
  level: string;
  isRestroom: boolean;
  isStair: boolean;
  isElevator: boolean;
  isAssembly: boolean;
  isMepUnoccupied: boolean;
  occupantLoad?: number;
  /** Whether this room passed the R1 filter (should have at least one sign). */
  passedR1Filter: boolean;
  /**
   * For stair rooms: the number of levels this stairwell serves.
   * Used by V4 to compute expected stair corridor sign count.
   * Optional — when absent the V4 equality check is skipped (only the
   * zero-total guard runs).
   */
  levelsServed?: number;
  /**
   * For stair rooms: the number of corridor entry points per level
   * (typically 2 for a two-sided corridor, 1 for a single-entry stair).
   * Used by V4 to compute expected stair corridor sign count.
   * Defaults to 1 when not provided.
   */
  corridorEntries?: number;
}

/** Sign counts assigned to a single room by the Phase 5 rule engine. */
export interface RoomAssignment {
  roomId: string;
  roomNumber: string;
  roomName: string;
  level: string;
  /** Sign type names assigned to this room (e.g. "Room ID", "EXIT"). */
  signs: string[];
  /** Reasons why this room was explicitly excluded from sign assignment. */
  exclusionReasons: string[];
  restroom: number;
  exit: number;
  stairCorridor: number;
  stairLanding: number;
  inCaseOfFire: number;
  maxOccupancy: number;
}

/** Output from the Phase 4 Room Inventory module. */
export interface RoomInventory {
  rooms: Room[];
  elevatorCount: number;
  stairCount: number;
  levelNames: string[];
}

/** Per-level aggregation inside a RuleEngineResult. */
export interface LevelResult {
  assignments: RoomAssignment[];
  /** Total occupant load for the level; undefined if not determinable. */
  totalOccupantLoad?: number;
}

/** Output from the Phase 5 rule engine. */
export interface RuleEngineResult {
  assignments: RoomAssignment[];
  byLevel: Record<string, LevelResult>;
}

/** Summary derived from the Phase 2 Sheet Manifest. */
export interface SheetManifest {
  /** Ordered list of level names (e.g. ["L1", "L2", "ROOF"]). */
  levels: string[];
  pageCount: number;
}

/** Verification report produced by Phase 6. */
export interface VerificationReport {
  /** True when there are zero hard errors and prerequisites were available. */
  passed: boolean;
  /** Hard failures — should block output or be prominently surfaced in the UI. */
  errors: string[];
  /** Soft issues — worth reviewing but not necessarily wrong. */
  warnings: string[];
  /** Ambiguous cases that require human review before accepting results. */
  questionsForVerification: string[];
  /** Names of checks that passed cleanly. */
  checksPassed: string[];
  summary: {
    totalRooms: number;
    accountedFor: number;
    totalSigns: number;
    /** Sign counts grouped by type. */
    byType: Record<string, number>;
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * IBC Table 1006.3 — minimum number of exits required per level based on
 * the level's total occupant load.
 */
function ibcMinExits(occupantLoad: number): number {
  if (occupantLoad <= 499) return 2;
  if (occupantLoad <= 999) return 3;
  return 4;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Run all Phase 6 verification checks against rule engine output.
 *
 * **Prerequisites not yet available:**
 * When Phase 4 (room-inventory.ts) and Phase 5 (rule-engine.ts) are not yet
 * built, callers should pass empty objects:
 *   verifyRuleEngineResult(
 *     { assignments: [], byLevel: {} },
 *     { rooms: [], elevatorCount: 0, stairCount: 0, levelNames: [] },
 *     { levels: [], pageCount: 0 },
 *   )
 * The verifier detects empty prerequisites and returns `passed: false` with
 * explicit "not yet available" questions rather than falsely reporting success.
 * This ensures the UI correctly shows that verification has not yet occurred.
 */
export function verifyRuleEngineResult(
  result: RuleEngineResult,
  roomInventory: RoomInventory,
  manifest: SheetManifest,
): VerificationReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const questionsForVerification: string[] = [];
  const checksPassed: string[] = [];

  const { assignments, byLevel } = result;
  const { rooms } = roomInventory;

  // ── Prerequisite guard ─────────────────────────────────────────────────────
  // When Phase 4 and Phase 5 have not yet run, both the room inventory and
  // rule engine result will be empty.  Rather than trivially passing all checks
  // against empty data, we push each check to questionsForVerification and
  // return passed=false so the UI correctly reflects the unverified state.
  const prerequisitesMissing =
    rooms.length === 0 && assignments.length === 0;

  if (prerequisitesMissing) {
    questionsForVerification.push(
      "V1–V7: Room inventory and rule engine data not yet available — verification checks will run automatically once Phase 4 (Room Inventory) and Phase 5 (Apply Rules) are implemented.",
    );
    return {
      passed: false,
      errors: [],
      warnings: [],
      questionsForVerification,
      checksPassed: [],
      summary: {
        totalRooms: 0,
        accountedFor: 0,
        totalSigns: 0,
        byType: {
          roomId: 0,
          restroom: 0,
          exit: 0,
          stairCorridor: 0,
          stairLanding: 0,
          inCaseOfFire: 0,
          maxOccupancy: 0,
        },
      },
    };
  }

  // Build lookup: roomId → assignment
  const assignmentMap = new Map<string, RoomAssignment>();
  for (const a of assignments) {
    assignmentMap.set(a.roomId, a);
  }

  // Derive level list (prefer manifest, fall back to rooms, then byLevel keys)
  const levelNames: string[] =
    manifest.levels.length > 0
      ? manifest.levels
      : rooms.length > 0
        ? [...new Set(rooms.map((r) => r.level))]
        : Object.keys(byLevel);

  // ── V1: Every room accounted for ───────────────────────────────────────────
  {
    let failed = false;
    for (const room of rooms) {
      const assignment = assignmentMap.get(room.roomId);
      const hasSigns = assignment && assignment.signs.length > 0;
      const hasExclusion = assignment && assignment.exclusionReasons.length > 0;
      if (!hasSigns && !hasExclusion) {
        errors.push(
          `V1: Room ${room.roomNumber} "${room.roomName}" (level ${room.level}) has no sign assignment and no exclusion reason`,
        );
        failed = true;
      }
    }
    if (!failed) checksPassed.push("V1 — Every room accounted for");
  }

  // ── V2: Restroom count ─────────────────────────────────────────────────────
  {
    let failed = false;
    for (const level of levelNames) {
      const restroomRooms = rooms.filter((r) => r.level === level && r.isRestroom).length;
      const restroomAssignments = assignments.filter((a) => a.level === level && a.restroom > 0).length;
      if (restroomRooms > 0 && restroomAssignments !== restroomRooms) {
        warnings.push(
          `V2: Level "${level}" — ${restroomAssignments} restroom sign assignment(s) vs ${restroomRooms} restroom room(s) (may be multi-stall)`,
        );
        failed = true;
      }
    }
    if (!failed) checksPassed.push("V2 — Restroom count matches");
  }

  // ── V3: EXIT count ≥ IBC minimum ───────────────────────────────────────────
  {
    let anyHardFail = false;
    let anyQuestion = false;
    for (const level of levelNames) {
      const levelResult = byLevel[level];
      const totalOL = levelResult?.totalOccupantLoad;
      const exitCount = (levelResult?.assignments ?? []).reduce((sum, a) => sum + a.exit, 0);
      if (totalOL == null) {
        questionsForVerification.push(
          `V3: Level "${level}" — occupant load unknown; cannot verify EXIT count (found ${exitCount} EXIT sign(s))`,
        );
        anyQuestion = true;
      } else {
        const required = ibcMinExits(totalOL);
        if (exitCount < required) {
          errors.push(
            `V3: Level "${level}" — ${exitCount} EXIT sign(s) < IBC minimum ${required} (occupant load: ${totalOL})`,
          );
          anyHardFail = true;
        }
      }
    }
    if (!anyHardFail && !anyQuestion) checksPassed.push("V3 — EXIT count ≥ IBC minimum");
  }

  // ── V4: Stair plaque totals ────────────────────────────────────────────────
  // Per spec: sum(stairCorridor) must equal Σ(stairs × levels_served × corridor_entries)
  //           sum(stairLanding)  must equal Σ(stairs × levels_served)
  // Flag if either total is 0 and stairs exist in inventory.
  // When levelsServed/corridorEntries are absent (Phase 4 not yet built), the
  // equality check is skipped and only the zero-total guard is enforced.
  {
    const stairRooms = rooms.filter((r) => r.isStair);
    if (stairRooms.length > 0) {
      const totalStairCorridor = assignments.reduce((sum, a) => sum + a.stairCorridor, 0);
      const totalStairLanding = assignments.reduce((sum, a) => sum + a.stairLanding, 0);

      // Compute expected totals (only when levelsServed data is available)
      const stairsWithData = stairRooms.filter((r) => r.levelsServed != null);
      const expectedCorridor =
        stairsWithData.length > 0
          ? stairsWithData.reduce((sum, r) => sum + (r.levelsServed ?? 0) * (r.corridorEntries ?? 1), 0)
          : null; // null = cannot compute yet
      const expectedLanding =
        stairsWithData.length > 0
          ? stairsWithData.reduce((sum, r) => sum + (r.levelsServed ?? 0), 0)
          : null;

      let v4Failed = false;

      // Zero-total guards (always enforced when stairs exist)
      if (totalStairCorridor === 0) {
        errors.push(`V4: ${stairRooms.length} stair(s) found in inventory but no stair corridor signs assigned`);
        v4Failed = true;
      } else if (expectedCorridor != null && expectedCorridor > 0 && totalStairCorridor !== expectedCorridor) {
        errors.push(
          `V4: Stair corridor sign count mismatch — expected ${expectedCorridor} (Σ stairs × levels served × entries), got ${totalStairCorridor}`,
        );
        v4Failed = true;
      }

      if (totalStairLanding === 0) {
        errors.push(`V4: ${stairRooms.length} stair(s) found in inventory but no stair landing signs assigned`);
        v4Failed = true;
      } else if (expectedLanding != null && expectedLanding > 0 && totalStairLanding !== expectedLanding) {
        errors.push(
          `V4: Stair landing sign count mismatch — expected ${expectedLanding} (Σ stairs × levels served), got ${totalStairLanding}`,
        );
        v4Failed = true;
      }

      // If per-stair data is partially available, note what couldn't be checked
      if (stairsWithData.length === 0) {
        questionsForVerification.push(
          `V4: ${stairRooms.length} stair(s) found — levels-served data not yet available; equality check deferred (zero-total guard: corridor=${totalStairCorridor}, landing=${totalStairLanding})`,
        );
      } else if (stairsWithData.length < stairRooms.length) {
        questionsForVerification.push(
          `V4: ${stairRooms.length - stairsWithData.length} stair(s) missing levels-served data; expected totals are partial`,
        );
      }

      if (!v4Failed) checksPassed.push("V4 — Stair plaque totals match expected values");
    } else {
      checksPassed.push("V4 — No stairs in inventory (skipped)");
    }
  }

  // ── V5: "In Case of Fire" = elevator count ─────────────────────────────────
  {
    const totalInCaseOfFire = assignments.reduce((sum, a) => sum + a.inCaseOfFire, 0);
    const { elevatorCount } = roomInventory;
    if (elevatorCount > 0) {
      if (totalInCaseOfFire !== elevatorCount) {
        warnings.push(
          `V5: ${totalInCaseOfFire} "In Case of Fire" sign(s) vs ${elevatorCount} elevator(s) in inventory`,
        );
      } else {
        checksPassed.push("V5 — In Case of Fire count = elevator count");
      }
    } else if (totalInCaseOfFire > 0) {
      warnings.push(
        `V5: ${totalInCaseOfFire} "In Case of Fire" sign(s) assigned but no elevators found in inventory`,
      );
    } else {
      checksPassed.push("V5 — No elevators in inventory (skipped)");
    }
  }

  // ── V6: Assembly rooms have capacity signs ─────────────────────────────────
  {
    let failed = false;
    for (const room of rooms.filter((r) => r.isAssembly)) {
      const assignment = assignmentMap.get(room.roomId);
      const hasExclusion = assignment && assignment.exclusionReasons.length > 0;
      if (!hasExclusion && (!assignment || assignment.maxOccupancy === 0)) {
        errors.push(
          `V6: Assembly room ${room.roomNumber} "${room.roomName}" has no capacity sign and no exclusion reason`,
        );
        failed = true;
      }
    }
    if (!failed) checksPassed.push("V6 — Assembly rooms have capacity signs");
  }

  // ── V7: No zero-sign rooms without justification ───────────────────────────
  {
    let failed = false;
    for (const room of rooms.filter((r) => r.passedR1Filter)) {
      const assignment = assignmentMap.get(room.roomId);
      const hasExclusion = assignment && assignment.exclusionReasons.length > 0;
      if (!hasExclusion && (!assignment || assignment.signs.length === 0)) {
        errors.push(
          `V7: Room ${room.roomNumber} "${room.roomName}" passed R1 filter but has 0 signs and no exclusion reason`,
        );
        failed = true;
      }
    }
    if (!failed) checksPassed.push("V7 — All R1-filtered rooms have signs or justification");
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  const totalSigns = assignments.reduce((sum, a) => sum + a.signs.length, 0);
  const accountedFor = assignments.filter(
    (a) => a.signs.length > 0 || a.exclusionReasons.length > 0,
  ).length;

  const byType: Record<string, number> = {
    roomId: assignments.reduce(
      (sum, a) => sum + (a.signs.some((s) => s.toLowerCase().includes("room id")) ? 1 : 0),
      0,
    ),
    restroom: assignments.reduce((sum, a) => sum + a.restroom, 0),
    exit: assignments.reduce((sum, a) => sum + a.exit, 0),
    stairCorridor: assignments.reduce((sum, a) => sum + a.stairCorridor, 0),
    stairLanding: assignments.reduce((sum, a) => sum + a.stairLanding, 0),
    inCaseOfFire: assignments.reduce((sum, a) => sum + a.inCaseOfFire, 0),
    maxOccupancy: assignments.reduce((sum, a) => sum + a.maxOccupancy, 0),
  };

  return {
    passed: errors.length === 0,
    errors,
    warnings,
    questionsForVerification,
    checksPassed,
    summary: {
      totalRooms: rooms.length,
      accountedFor,
      totalSigns,
      byType,
    },
  };
}
