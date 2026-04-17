/**
 * Regression: rescanning must never carry over stale sign type data.
 *
 * Uses a stateful in-memory DB mock so tests can seed stale rows, trigger the
 * reset, and assert the final persisted state — not just operation call counts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted state (must be declared before vi.mock) ───────────────────────────

type JobRow = { plaqueTable: unknown };
type SpecRow = { jobId: string; typeCode: string };
type ScheduleRow = { jobId: string };

const {
  db: inMemDb,
  jobsTableSym,
  signTypeSpecsTableSym,
  signageScheduleEntriesTableSym,
  jobFilesTableSym,
  extractedSignsTableSym,
} = vi.hoisted(() => {
  const jobs = new Map<string, JobRow>();
  const signTypeSpecs: SpecRow[] = [];
  const scheduleEntries: ScheduleRow[] = [];

  const db = { jobs, signTypeSpecs, scheduleEntries };

  return {
    db,
    jobsTableSym: Symbol("jobsTable"),
    signTypeSpecsTableSym: Symbol("signTypeSpecsTable"),
    signageScheduleEntriesTableSym: Symbol("signageScheduleEntriesTable"),
    jobFilesTableSym: Symbol("jobFilesTable"),
    extractedSignsTableSym: Symbol("extractedSignsTable"),
  };
});

// ── DB mock ───────────────────────────────────────────────────────────────────
//
// `eq(col, value)` returns `value` so that `.where(eq(table.jobId, id))` hands
// the job-id string directly to the mock's where handler.

// pdf-processor.ts imports eq/and from drizzle-orm (not @workspace/db), so we
// mock drizzle-orm to return the filter value directly as the where argument.
vi.mock("drizzle-orm", () => ({
  eq: (_col: unknown, value: unknown) => value,
  and: (...args: unknown[]) => args[0],
}));

vi.mock("@workspace/db", () => {
  const eq = (_col: unknown, value: unknown) => value;
  const and = (...args: unknown[]) => args[0];

  const mockDb = {
    update: (table: symbol) => ({
      set: (values: Record<string, unknown>) => ({
        where: (jobId: unknown) => {
          if (table === jobsTableSym && typeof jobId === "string") {
            const row = inMemDb.jobs.get(jobId) ?? { plaqueTable: undefined };
            Object.assign(row, values);
            inMemDb.jobs.set(jobId, row);
          }
          return Promise.resolve([]);
        },
      }),
    }),

    delete: (table: symbol) => ({
      where: (jobId: unknown) => {
        if (typeof jobId !== "string") return Promise.resolve([]);
        if (table === signTypeSpecsTableSym) {
          const keep = inMemDb.signTypeSpecs.filter((r) => r.jobId !== jobId);
          inMemDb.signTypeSpecs.length = 0;
          inMemDb.signTypeSpecs.push(...keep);
        } else if (table === signageScheduleEntriesTableSym) {
          const keep = inMemDb.scheduleEntries.filter((r) => r.jobId !== jobId);
          inMemDb.scheduleEntries.length = 0;
          inMemDb.scheduleEntries.push(...keep);
        }
        return Promise.resolve([]);
      },
    }),

    // Always returns empty — causes runPdfProcessor to exit after the reset
    // phase so we don't need to mock the full processing pipeline.
    select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
    insert: () => ({
      values: () => ({ returning: () => Promise.resolve([]) }),
    }),
  };

  return {
    db: mockDb,
    jobsTable: jobsTableSym,
    signTypeSpecsTable: signTypeSpecsTableSym,
    signageScheduleEntriesTable: signageScheduleEntriesTableSym,
    jobFilesTable: jobFilesTableSym,
    extractedSignsTable: extractedSignsTableSym,
    eq,
    and,
  };
});

import { resetScanData, runPdfProcessor } from "./pdf-processor";

// ── Helpers ───────────────────────────────────────────────────────────────────

function seedStaleData(jobId: string): void {
  inMemDb.jobs.set(jobId, {
    plaqueTable: {
      plaqueTypes: [{ typeCode: "STALE-A" }, { typeCode: "STALE-B" }],
      generalNotes: [],
      sourcePages: [2],
      extractionMethod: "text_fallback",
      warnings: [],
    },
  });
  inMemDb.signTypeSpecs.push(
    { jobId, typeCode: "STALE-A" },
    { jobId, typeCode: "STALE-B" },
  );
  inMemDb.scheduleEntries.push({ jobId }, { jobId });
}

function clearState(): void {
  inMemDb.jobs.clear();
  inMemDb.signTypeSpecs.length = 0;
  inMemDb.scheduleEntries.length = 0;
}

// ── resetScanData ─────────────────────────────────────────────────────────────

describe("resetScanData — stale type data is absent after reset", () => {
  beforeEach(clearState);

  it("sets plaqueTable to null even when the prior run stored sign type codes", async () => {
    seedStaleData("job-1");
    expect((inMemDb.jobs.get("job-1")!.plaqueTable as { plaqueTypes: unknown[] }).plaqueTypes).toHaveLength(2);

    await resetScanData("job-1");

    expect(inMemDb.jobs.get("job-1")!.plaqueTable).toBeNull();
  });

  it("removes all sign_type_specs rows seeded for the job", async () => {
    seedStaleData("job-1");
    expect(inMemDb.signTypeSpecs.filter((r) => r.jobId === "job-1")).toHaveLength(2);

    await resetScanData("job-1");

    expect(inMemDb.signTypeSpecs.filter((r) => r.jobId === "job-1")).toHaveLength(0);
  });

  it("removes all signage_schedule_entries rows seeded for the job", async () => {
    seedStaleData("job-1");
    expect(inMemDb.scheduleEntries.filter((r) => r.jobId === "job-1")).toHaveLength(2);

    await resetScanData("job-1");

    expect(inMemDb.scheduleEntries.filter((r) => r.jobId === "job-1")).toHaveLength(0);
  });

  it("does not affect rows belonging to a different job", async () => {
    seedStaleData("job-A");
    seedStaleData("job-B");

    await resetScanData("job-A");

    // job-A data gone
    expect(inMemDb.signTypeSpecs.filter((r) => r.jobId === "job-A")).toHaveLength(0);
    // job-B data untouched
    expect(inMemDb.signTypeSpecs.filter((r) => r.jobId === "job-B")).toHaveLength(2);
  });

  it("stale type codes STALE-A and STALE-B are absent from sign_type_specs after reset", async () => {
    seedStaleData("job-1");

    await resetScanData("job-1");

    const remaining = inMemDb.signTypeSpecs.filter((r) => r.jobId === "job-1").map((r) => r.typeCode);
    expect(remaining).not.toContain("STALE-A");
    expect(remaining).not.toContain("STALE-B");
    expect(remaining).toHaveLength(0);
  });
});

// ── runPdfProcessor wiring ────────────────────────────────────────────────────
//
// Confirms the processor itself calls the resets — so dropping the resetScanData
// call from runPdfProcessor would cause these tests to fail.

describe("runPdfProcessor — stale type data cleared before any processing", () => {
  beforeEach(clearState);

  it("plaqueTable is null after a rescan even when the prior run populated it", async () => {
    seedStaleData("job-2");
    expect(inMemDb.jobs.get("job-2")!.plaqueTable).not.toBeNull();

    await runPdfProcessor("job-2");

    expect(inMemDb.jobs.get("job-2")!.plaqueTable).toBeNull();
  });

  it("sign_type_specs rows seeded by a prior run are gone after rescan", async () => {
    seedStaleData("job-2");

    await runPdfProcessor("job-2");

    expect(inMemDb.signTypeSpecs.filter((r) => r.jobId === "job-2")).toHaveLength(0);
  });

  it("signage_schedule_entries rows seeded by a prior run are gone after rescan", async () => {
    seedStaleData("job-2");

    await runPdfProcessor("job-2");

    expect(inMemDb.scheduleEntries.filter((r) => r.jobId === "job-2")).toHaveLength(0);
  });

  it("a second rescan also starts clean — stale codes cannot accumulate over multiple runs", async () => {
    seedStaleData("job-3");

    // First rescan clears stale data
    await runPdfProcessor("job-3");
    expect(inMemDb.signTypeSpecs.filter((r) => r.jobId === "job-3")).toHaveLength(0);

    // Simulate a new set of stale data arriving (e.g. partial prior run)
    inMemDb.signTypeSpecs.push({ jobId: "job-3", typeCode: "NEW-STALE" });

    // Second rescan must also clear it
    await runPdfProcessor("job-3");
    expect(inMemDb.signTypeSpecs.filter((r) => r.jobId === "job-3")).toHaveLength(0);
  });
});
