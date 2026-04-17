/**
 * verifier.ts — Phase 6: Verify & Output
 *
 * Runs mandatory pre-output checks on the aggregated rule-engine result before
 * writing the final sign schedule to the database.  Produces a structured
 * VerificationReport consumed by the Timeline UI in JobDetails.tsx.
 *
 * Checks implemented:
 *   V1 — Room completeness: every room has applied rules or an exclusion reason
 *   V2 — Stair plaque totals: total stairLanding signs = rawStairCount
 *         (rawStairCount ≈ distinct stairs × levels served, counted pre-dedup)
 *   V3 — EXIT count (IBC Table 1006.3): assembly spaces must have ≥ 2 exits
 *   V4 — "In Case of Fire" count = elevator count (per IBC 11B-407.4)
 *   V5 — Sign count summary for output confirmation
 *   V6 — Assembly capacity sign: every R10 room must have maxOccupancy > 0
 *   V7 — Evacuation map per-level: every level must have ≥ 1 evacuation map
 */

import type { SignAssignment } from "./rule-engine";

// ── Input shapes ───────────────────────────────────────────────────────────────

/** Aggregated assignments from all per-file rule engine runs. */
export interface AssignmentsSummary {
  assignments: SignAssignment[];
  byLevel: Record<string, SignAssignment[]>;
}

/**
 * Room-level counts from the rule engine.
 * rawStairCount and rawElevatorCount are derived from room appearances BEFORE
 * job-level deduplication, so they represent (stair/elevator × level) pairs.
 */
export interface RoomSummary {
  rooms: unknown[];
  /** Elevator appearances before job-level dedup (≈ distinct elevators) */
  elevatorCount: number;
  /** Stair appearances before job-level dedup (≈ distinct stairs × levels served) */
  stairCount: number;
  levelNames: string[];
}

/** Job-level context from the sheet manifest (Phase 2). */
export interface JobContext {
  levels: string[];
  pageCount: number;
}

// ── Output shape ──────────────────────────────────────────────────────────────

export interface VerificationReport {
  /** True when there are zero hard errors. */
  passed: boolean;
  /** Hard failures — block export and are surfaced prominently in the UI. */
  errors: string[];
  /** Soft issues — worth reviewing but do not block export. */
  warnings: string[];
  /** Ambiguous assignments requiring human review. */
  questionsForVerification: string[];
  /** Checks that explicitly passed (shown in the Timeline). */
  checksPassed: string[];
  summary: {
    totalSigns: number;
    /** Sign counts grouped by type key. */
    byType: Record<string, number>;
  };
}

// ── Verifier ──────────────────────────────────────────────────────────────────

/**
 * Run V1–V7 pre-output checks against the aggregated rule engine output.
 *
 * Call after all per-file rule engine runs are complete.  Pass the merged
 * assignments together with rawStairCount and rawElevatorCount derived from
 * pre-deduplication room inventory counts.
 *
 * When no floor plan pages were processed (assignments is empty), the function
 * returns a trivial pass with an informational note rather than raising errors.
 */
export function verifyRuleEngineResult(
  assignmentsSummary: AssignmentsSummary,
  roomSummary: RoomSummary,
  jobContext: JobContext,
): VerificationReport {
  const { assignments } = assignmentsSummary;
  const { elevatorCount, stairCount } = roomSummary;

  const errors: string[] = [];
  const warnings: string[] = [];
  const questionsForVerification: string[] = [];
  const checksPassed: string[] = [];

  // ── No data guard ─────────────────────────────────────────────────────────
  if (assignments.length === 0) {
    if (jobContext.pageCount > 0) {
      // Files were processed but the rule engine produced no assignments.
      // This likely means no floor plan pages were detected — flag as a warning
      // so it is visible in the Timeline rather than silently passing.
      warnings.push(
        "V1–V7: no rule engine assignments produced — no floor plan pages were processed or rule engine output is empty",
      );
    } else {
      checksPassed.push("V1–V7: no files processed");
    }
    return {
      passed: true,
      errors,
      warnings,
      questionsForVerification,
      checksPassed,
      summary: { totalSigns: 0, byType: {} },
    };
  }

  // ── V1 — Room completeness ────────────────────────────────────────────────
  // Every room must have at least one rule applied or an explicit exclusion
  // reason.  Rooms with neither were not handled by any rule and slipped
  // through silently.
  const incomplete = assignments.filter(
    (a) => a.appliedRules.length === 0 && a.exclusionReasons.length === 0,
  );
  if (incomplete.length > 0) {
    const sample = incomplete
      .slice(0, 3)
      .map((a) => (a.roomNumber ? `${a.roomNumber} ${a.roomName}` : a.roomName))
      .join(", ");
    errors.push(
      `V1 — Room completeness: ${incomplete.length} room(s) have no applied rules and no exclusion reason` +
        ` (${sample}${incomplete.length > 3 ? " …" : ""})`,
    );
  } else {
    checksPassed.push(`V1 — Room completeness: all ${assignments.length} rooms accounted for`);
  }

  // ── V2 — Stair plaque totals (stairs × levels served) ────────────────────
  // stairCount is derived from rawRooms (before job-level deduplication) so
  // each (stair, level) appearance counts once — approximating
  // "distinct stairs × levels served".
  // Expected: total stairLanding signs == stairCount.
  // Expected: total stairCorridor signs == stairCount (1 corridor sign per landing level).
  const totalStairLanding = assignments.reduce(
    (sum, a) => sum + (a.stairLanding ?? 0),
    0,
  );
  const totalStairCorridor = assignments.reduce(
    (sum, a) => sum + (a.stairCorridor ?? 0),
    0,
  );

  if (stairCount > 0 && totalStairLanding === 0) {
    errors.push(
      `V2 — Stair plaques: ${stairCount} stair occurrence(s) detected across all levels but no stair landing signs assigned — verify R11`,
    );
  } else if (stairCount > 0 && totalStairLanding !== stairCount) {
    errors.push(
      `V2 — Stair plaques: total stair landing signs (${totalStairLanding}) ≠ expected (${stairCount} stair × level occurrences) — verify R11`,
    );
  } else if (stairCount > 0) {
    checksPassed.push(
      `V2 — Stair plaques: ${totalStairLanding} stair landing sign(s) = ${stairCount} stair × level occurrence(s) ✓`,
    );
  } else {
    checksPassed.push("V2 — Stair plaques: no stair rooms detected");
  }

  // Corridor sign total is informational (can be > 1 per level for multi-entry stairs)
  if (stairCount > 0 && totalStairCorridor === 0) {
    errors.push(
      `V2 — Stair corridor: ${stairCount} stair occurrence(s) detected but no stair corridor signs assigned — verify R11`,
    );
  }

  // ── V3 — EXIT count (IBC Table 1006.3) ───────────────────────────────────
  // Assembly spaces (R10 max-occupancy flag — only applied to assembly rooms)
  // must have ≥ 2 exits per IBC Table 1006.3.3 (occupant load ≥ 49).
  // Without exact occupant load data, ≥ 2 is the minimum code-compliant floor.
  // Failure is a hard error because IBC 1006.3 is a mandatory life-safety requirement.
  const assemblyAssignments = assignments.filter(
    (a) => a.maxOccupancy !== null && a.maxOccupancy > 0,
  );
  const assemblyFewerThan2Exits = assemblyAssignments.filter(
    (a) => (a.exit ?? 0) < 2,
  );
  if (assemblyFewerThan2Exits.length > 0) {
    const sample = assemblyFewerThan2Exits
      .slice(0, 3)
      .map((a) => (a.roomNumber ? `${a.roomNumber} ${a.roomName}` : a.roomName))
      .join(", ");
    errors.push(
      `V3 — EXIT count (IBC Table 1006.3): ${assemblyFewerThan2Exits.length} assembly space(s)` +
        ` have fewer than 2 exits assigned (${sample}${assemblyFewerThan2Exits.length > 3 ? " …" : ""})` +
        ` — IBC 1006.3.3 requires ≥2 exits for occupant loads ≥49`,
    );
  } else if (assemblyAssignments.length > 0) {
    checksPassed.push(
      `V3 — EXIT count: ${assemblyAssignments.length} assembly space(s) each have ≥2 exits (IBC Table 1006.3) ✓`,
    );
  } else {
    checksPassed.push("V3 — EXIT count: no assembly spaces requiring EXIT verification found");
  }

  // ── V4 — In Case of Fire = elevator count (per IBC 11B-407.4) ────────────
  // Each elevator requires its own "In Case of Fire" instruction sign.
  // elevatorCount is derived from rawElevatorCount (pre-dedup) so it
  // represents the total number of distinct elevator locations.
  // The rule engine's R12 currently deduplicates to 1 ICF sign per job; if
  // that number does not match the elevator count, flag as an error.
  const totalIcf = assignments.reduce(
    (sum, a) => sum + (a.inCaseOfFire ?? 0),
    0,
  );

  if (elevatorCount > 0 && totalIcf === 0) {
    errors.push(
      `V4 — In Case of Fire: ${elevatorCount} elevator(s) detected but no In Case of Fire signs assigned — verify R12`,
    );
  } else if (elevatorCount > 0 && totalIcf !== elevatorCount) {
    errors.push(
      `V4 — In Case of Fire: ${totalIcf} sign(s) assigned for ${elevatorCount} elevator(s)` +
        ` — counts must match (IBC 11B-407.4 requires one sign per elevator)`,
    );
  } else if (elevatorCount > 0 && totalIcf === elevatorCount) {
    checksPassed.push(
      `V4 — In Case of Fire: ${totalIcf} sign(s) for ${elevatorCount} elevator(s) ✓`,
    );
  } else if (elevatorCount === 0) {
    checksPassed.push("V4 — In Case of Fire: no elevators detected");
  }

  // ── V6 — Assembly capacity sign completeness (per R10 / IBC 1004) ─────────
  // Every assignment where R10 was applied (max-occupancy/capacity sign rule)
  // must have maxOccupancy > 0.  A zero or null value means the rule fired but
  // produced no sign, which is a rule-engine bug that must be caught before export.
  const r10Assignments = assignments.filter((a) => a.appliedRules.includes("R10"));
  const missingCapacity = r10Assignments.filter(
    (a) => a.maxOccupancy === null || a.maxOccupancy === 0,
  );
  if (missingCapacity.length > 0) {
    const sample = missingCapacity
      .slice(0, 3)
      .map((a) => (a.roomNumber ? `${a.roomNumber} ${a.roomName}` : a.roomName))
      .join(", ");
    errors.push(
      `V6 — Assembly capacity sign: ${missingCapacity.length} assembly room(s) had R10 applied but have no capacity sign assigned` +
        ` (${sample}${missingCapacity.length > 3 ? " …" : ""}) — verify R10`,
    );
  } else if (r10Assignments.length > 0) {
    checksPassed.push(
      `V6 — Assembly capacity sign: all ${r10Assignments.length} R10 room(s) have a capacity sign assigned ✓`,
    );
  } else {
    checksPassed.push("V6 — Assembly capacity sign: no R10 (assembly capacity) rooms detected");
  }

  // ── V7 — Evacuation map per-level coverage (per R13) ──────────────────────
  // Every level that contains at least one room should have an evacuation map
  // sign assigned somewhere on that level (R13 targets lobbies/elevator lobbies).
  // A level with rooms but zero evacuation maps is flagged as a warning because
  // the level may legitimately lack a lobby (e.g. a mechanical floor).
  const levelSet = new Set(assignments.map((a) => a.level));
  const levelsWithoutEvacMap: string[] = [];
  for (const lvl of levelSet) {
    const lvlAssignments = assignments.filter((a) => a.level === lvl);
    const hasMap = lvlAssignments.some((a) => (a.evacuationMap ?? 0) > 0);
    if (!hasMap) {
      levelsWithoutEvacMap.push(lvl);
    }
  }
  if (levelsWithoutEvacMap.length > 0) {
    warnings.push(
      `V7 — Evacuation map coverage: ${levelsWithoutEvacMap.length} level(s) have no evacuation map sign assigned` +
        ` (${levelsWithoutEvacMap.join(", ")}) — verify R13 or confirm level has no public lobby`,
    );
  } else {
    checksPassed.push(
      `V7 — Evacuation map coverage: all ${levelSet.size} level(s) have at least one evacuation map sign ✓`,
    );
  }

  // ── Ambiguous questions forwarded from rule engine ────────────────────────
  const seenNotes = new Set<string>();
  for (const a of assignments) {
    if (a.ambiguous && a.ambiguityNote) {
      const identifier = a.roomNumber
        ? `${a.roomNumber} ${a.roomName}`
        : a.roomName;
      const note = `${identifier} [${a.level}]: ${a.ambiguityNote}`;
      if (!seenNotes.has(note)) {
        seenNotes.add(note);
        questionsForVerification.push(note);
      }
    }
  }

  // ── V5 — Sign count summary ───────────────────────────────────────────────
  const byType: Record<string, number> = {};
  let totalSigns = 0;

  function addCount(type: string, qty: number | null): void {
    if (qty !== null && qty > 0) {
      byType[type] = (byType[type] ?? 0) + qty;
      totalSigns += qty;
    }
  }

  for (const a of assignments) {
    addCount("roomId", a.roomId);
    addCount("roomIdWithInsert", a.roomIdWithInsert);
    addCount("restroom", a.restroom);
    addCount("exit", a.exit);
    addCount("maxOccupancy", a.maxOccupancy);
    addCount("stairCorridor", a.stairCorridor);
    addCount("stairLanding", a.stairLanding);
    addCount("inCaseOfFire", a.inCaseOfFire);
    addCount("evacuationMap", a.evacuationMap);
    addCount("officeDirectory", a.officeDirectory);
  }

  const passed = errors.length === 0;

  return {
    passed,
    errors,
    warnings,
    questionsForVerification,
    checksPassed,
    summary: { totalSigns, byType },
  };
}
