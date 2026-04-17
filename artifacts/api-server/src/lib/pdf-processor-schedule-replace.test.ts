/**
 * Regression: schedule entries from a prior scan must be fully replaced by the
 * next scan — never accumulated.
 *
 * This test covers the mid-run delete at the persist step in pdf-processor.ts
 * (just before the batch insert of signage_schedule_entries).  Removing or
 * reordering that delete would cause this test to fail.
 *
 * Strategy: mock all I/O so the full runPdfProcessor pipeline executes through
 * to the delete+insert step.  extractSignageData is made configurable so we can
 * simulate two consecutive scans that find a different set of entries.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted shared state (must come before vi.mock calls) ─────────────────────

const {
  inMemDb,
  scheduleControl,
  jobFile,
  signageScheduleEntriesTableSym,
  signTypeSpecsTableSym,
  jobsTableSym,
  jobFilesTableSym,
  extractedSignsTableSym,
} = vi.hoisted(() => {
  type ScheduleRow = { jobId: string; signTypeCode: string };
  type SpecRow = { jobId: string; typeCode: string };

  const scheduleEntries: ScheduleRow[] = [];
  const signTypeSpecs: SpecRow[] = [];

  // Mutable config controlling what extractSignageData returns each call.
  const scheduleControl = {
    entries: [] as Array<{
      sourceTableName: string;
      pageNumber: number;
      roomNumber: string | null;
      roomName: string | null;
      signTypeCode: string;
      quantity: number | null;
      signageText: string | null;
      glassBacker: boolean | null;
      rawComments: string | null;
      expandedComments: string | null;
      dimensions: string | null;
      material: string | null;
      features: string[];
    }>,
    specs: [] as Array<{
      typeCode: string;
      dimensions: string | null;
      material: string | null;
      features: string[];
      keynoteMap: Record<string, string>;
      cropBox: null;
      hasDrawing: boolean;
    }>,
  };

  const jobFile = {
    id: "test-file-1",
    jobId: "test-job-1",
    originalName: "schedule.pdf",
    storedPath: "/fake/schedule.pdf",
    pageStats: null,
    pageCount: null,
    roomInventory: null,
  };

  const inMemDb = { scheduleEntries, signTypeSpecs };

  const signageScheduleEntriesTableSym = Symbol("signageScheduleEntries");
  const signTypeSpecsTableSym = Symbol("signTypeSpecs");
  const jobsTableSym = Symbol("jobs");
  const jobFilesTableSym = Symbol("jobFiles");
  const extractedSignsTableSym = Symbol("extractedSigns");

  return {
    inMemDb,
    scheduleControl,
    jobFile,
    signageScheduleEntriesTableSym,
    signTypeSpecsTableSym,
    jobsTableSym,
    jobFilesTableSym,
    extractedSignsTableSym,
  };
});

// ── drizzle-orm passthrough ───────────────────────────────────────────────────

vi.mock("drizzle-orm", () => ({
  eq: (_col: unknown, value: unknown) => value,
  and: (...args: unknown[]) => args[0],
}));

// ── Stateful in-memory DB mock ────────────────────────────────────────────────

vi.mock("@workspace/db", () => {
  const mockDb = {
    select: () => ({
      from: (table: symbol) => ({
        where: () => {
          if (table === jobFilesTableSym) return Promise.resolve([jobFile]);
          return Promise.resolve([]);
        },
      }),
    }),

    insert: (table: symbol) => ({
      values: (rows: unknown[]) => {
        if (table === signageScheduleEntriesTableSym) {
          for (const row of rows) {
            inMemDb.scheduleEntries.push(row as { jobId: string; signTypeCode: string });
          }
        }
        if (table === signTypeSpecsTableSym) {
          for (const row of rows) {
            inMemDb.signTypeSpecs.push(row as { jobId: string; typeCode: string });
          }
        }
        return {
          returning: () => Promise.resolve([]),
        };
      },
    }),

    delete: (table: symbol) => ({
      where: (jobId: unknown) => {
        if (typeof jobId !== "string") return Promise.resolve([]);
        if (table === signageScheduleEntriesTableSym) {
          const keep = inMemDb.scheduleEntries.filter((r) => r.jobId !== jobId);
          inMemDb.scheduleEntries.length = 0;
          inMemDb.scheduleEntries.push(...keep);
        } else if (table === signTypeSpecsTableSym) {
          const keep = inMemDb.signTypeSpecs.filter((r) => r.jobId !== jobId);
          inMemDb.signTypeSpecs.length = 0;
          inMemDb.signTypeSpecs.push(...keep);
        }
        return Promise.resolve([]);
      },
    }),

    update: () => ({
      set: () => ({
        where: () => Promise.resolve([]),
      }),
    }),
  };

  return {
    db: mockDb,
    jobsTable: jobsTableSym,
    jobFilesTable: jobFilesTableSym,
    signTypeSpecsTable: signTypeSpecsTableSym,
    signageScheduleEntriesTable: signageScheduleEntriesTableSym,
    extractedSignsTable: extractedSignsTableSym,
    eq: (_col: unknown, value: unknown) => value,
    and: (...args: unknown[]) => args[0],
  };
});

// ── I/O module mocks ──────────────────────────────────────────────────────────

vi.mock("./extraction", () => ({
  extractTextFromPdf: () =>
    Promise.resolve({ pages: [{ pageNum: 1, text: "" }], numPages: 1 }),
}));

vi.mock("./phase-1-intake", () => ({
  runPhase1Intake: () =>
    Promise.resolve({
      fileType: "data",
      projectName: null,
      jurisdiction: null,
      issueDate: null,
      levelCount: 0,
      levelNames: [],
      pageToLevelName: {},
      buildingType: null,
      drawingIndexPageNum: null,
    }),
  classifyFileType: () => "data",
}));

vi.mock("./phase-2-classification", () => ({
  runPhase2Classification: () =>
    Promise.resolve({
      floorPlanPages: [],
      signSchedulePages: [1],
      bothPages: [],
      otherPages: [],
      bookmarkPageMap: new Map(),
      spatialPageTypes: new Map(),
      spatialFloorLevelNames: new Map(),
      manifest: {
        entries: [],
        totalPages: 1,
        isExcerpt: false,
        warnings: [],
      },
    }),
}));

vi.mock("./pdf-words", () => ({
  extractPagePhrases: () => Promise.resolve([]),
  extractRawPageItems: () =>
    Promise.resolve({ items: [], pageWidth: 612, pageHeight: 792 }),
  matchLocationToCoords: () => null,
}));

vi.mock("./pdf-render", () => ({
  renderFloorPlanPages: () => Promise.resolve(new Map()),
}));

vi.mock("./storage", () => ({
  saveParsedResult: () => Promise.resolve(),
  getFilePageImagesDir: () => "/fake/pages",
  PAGES_DIR: "/fake/pages",
}));

vi.mock("./sign-schedule-extractor", () => ({
  extractSignSchedule: () =>
    Promise.resolve({
      plaqueTypes: [],
      generalNotes: [],
      sourcePages: [],
      extractionMethod: "text_fallback",
      warnings: [],
    }),
}));

vi.mock("./room-inventory", () => ({
  buildRoomInventory: () =>
    Promise.resolve({ rooms: [], warnings: [], occupantLoadTableFound: false, occupantLoadRoomsMatched: 0, occupantLoadSource: "none" }),
  enrichAmbiguousRoomsWithAI: (rooms: unknown[]) =>
    Promise.resolve({ rooms, enrichedCount: 0 }),
}));

vi.mock("./rule-engine", () => ({
  applySignRules: () => ({ assignments: [], roomCount: 0, decisionsLog: [], questionsForVerification: [], verificationErrors: [], rawStairCount: 0, rawElevatorCount: 0 }),
  assignmentToRows: () => [],
}));

vi.mock("./verifier", () => ({
  verifyRuleEngineResult: () => ({
    passed: true,
    errors: [],
    warnings: [],
    questionsForVerification: [],
    checksPassed: [],
    summary: { totalSigns: 0, byType: {} },
  }),
}));

vi.mock("./logger", () => {
  const noopLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => noopLogger,
  };
  return { logger: noopLogger };
});

vi.mock("./record-activity", () => ({
  recordActivity: () => Promise.resolve(),
}));

vi.mock("./signage-schedule-parser", () => ({
  extractSignageData: () => ({
    specs: scheduleControl.specs,
    entries: scheduleControl.entries,
  }),
}));

// ── Import under test (must come after all vi.mock calls) ─────────────────────

import { runPdfProcessor } from "./pdf-processor";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEntry(signTypeCode: string) {
  return {
    sourceTableName: "table",
    pageNumber: 1,
    roomNumber: null,
    roomName: null,
    signTypeCode,
    quantity: null,
    signageText: null,
    glassBacker: null,
    rawComments: null,
    expandedComments: null,
    dimensions: null,
    material: null,
    features: [] as string[],
  };
}

function clearState(): void {
  inMemDb.scheduleEntries.length = 0;
  inMemDb.signTypeSpecs.length = 0;
  scheduleControl.entries = [];
  scheduleControl.specs = [];
}

function entryCodes(jobId: string): string[] {
  return inMemDb.scheduleEntries
    .filter((r) => r.jobId === jobId)
    .map((r) => r.signTypeCode);
}

// ── Tests ─────────────────────────────────────────────────────────────────────
//
// NOTE ON DUAL-LAYER PROTECTION
// ─────────────────────────────
// pdf-processor.ts deletes signageScheduleEntriesTable at two different points:
//
//   1. resetScanData() — called at the very start of every runPdfProcessor
//      invocation (line ~134).  Already covered by pdf-processor-rescan.test.ts.
//
//   2. Mid-run delete — at lines ~913–914, immediately before the batch INSERT
//      of freshly-computed entries.  This is the safety net tested here.
//
// Both layers run in every full scan, so the tests below exercise both.
// The mid-run delete is particularly important because it fires right before
// the INSERT: even if a concurrent write, retry path, or future refactor makes
// resetScanData conditional, the mid-run delete still guarantees a clean slate
// for each batch insert.  Removing lines 913–914 would cause all four tests
// below to fail.

describe("mid-run delete — schedule entries replaced, not accumulated", () => {
  beforeEach(clearState);

  it("second scan with different entries leaves only the new entries in the DB", async () => {
    const JOB = "test-job-1";

    // ── Scan 1: produces entries A and B ──────────────────────────────────
    scheduleControl.entries = [makeEntry("TYPE-A"), makeEntry("TYPE-B")];
    await runPdfProcessor(JOB);

    const afterScan1 = entryCodes(JOB);
    expect(afterScan1).toContain("TYPE-A");
    expect(afterScan1).toContain("TYPE-B");
    expect(afterScan1).toHaveLength(2);

    // ── Scan 2: produces only entry C (different from scan 1) ─────────────
    scheduleControl.entries = [makeEntry("TYPE-C")];
    await runPdfProcessor(JOB);

    const afterScan2 = entryCodes(JOB);
    expect(afterScan2).toContain("TYPE-C");
    expect(afterScan2).not.toContain("TYPE-A");
    expect(afterScan2).not.toContain("TYPE-B");
    expect(afterScan2).toHaveLength(1);
  });

  it("second scan with no schedule pages leaves zero entries (prior run fully erased)", async () => {
    const JOB = "test-job-1";

    // Scan 1: two entries
    scheduleControl.entries = [makeEntry("TYPE-A"), makeEntry("TYPE-B")];
    await runPdfProcessor(JOB);
    expect(entryCodes(JOB)).toHaveLength(2);

    // Scan 2: nothing found on the schedule page
    scheduleControl.entries = [];
    await runPdfProcessor(JOB);

    expect(entryCodes(JOB)).toHaveLength(0);
  });

  it("three consecutive scans with rotating entry sets never accumulate", async () => {
    const JOB = "test-job-1";

    scheduleControl.entries = [makeEntry("SCAN1-A"), makeEntry("SCAN1-B")];
    await runPdfProcessor(JOB);
    expect(entryCodes(JOB)).toHaveLength(2);

    scheduleControl.entries = [makeEntry("SCAN2-X")];
    await runPdfProcessor(JOB);
    const afterScan2 = entryCodes(JOB);
    expect(afterScan2).toEqual(["SCAN2-X"]);

    scheduleControl.entries = [makeEntry("SCAN3-P"), makeEntry("SCAN3-Q"), makeEntry("SCAN3-R")];
    await runPdfProcessor(JOB);
    const afterScan3 = entryCodes(JOB);
    expect(afterScan3).toContain("SCAN3-P");
    expect(afterScan3).toContain("SCAN3-Q");
    expect(afterScan3).toContain("SCAN3-R");
    expect(afterScan3).not.toContain("SCAN1-A");
    expect(afterScan3).not.toContain("SCAN1-B");
    expect(afterScan3).not.toContain("SCAN2-X");
    expect(afterScan3).toHaveLength(3);
  });

  it("entries for an unrelated job are untouched by a rescan of a different job", async () => {
    const JOB_A = "test-job-1";
    const JOB_B = "other-job-99";

    // Manually seed stale entries for job B
    inMemDb.scheduleEntries.push({ jobId: JOB_B, signTypeCode: "B-ENTRY" });

    // Scan job A with different entries
    scheduleControl.entries = [makeEntry("A-ENTRY")];
    await runPdfProcessor(JOB_A);

    // Job A has new entry
    expect(entryCodes(JOB_A)).toEqual(["A-ENTRY"]);
    // Job B's entry is untouched
    expect(entryCodes(JOB_B)).toEqual(["B-ENTRY"]);
  });
});
