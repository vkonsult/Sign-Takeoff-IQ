/**
 * Integration tests for the AI enrichment gate in pdf-processor.ts (lines 697-748).
 *
 * These tests call runPdfProcessor end-to-end with all heavy dependencies mocked,
 * driving execution all the way through the room inventory phase so the actual
 * production gate code runs.  They verify:
 *
 *   1. enrichAmbiguousRoomsWithAI is NOT called when hasLifeSafetyPage is false
 *   2. The room_inventory_ai_<fileId> step record is emitted with
 *      { skipped: true, skipReason, ambiguousSubmitted: 0, enrichedCount: 0 }
 *   3. The positive-control path: enrichAmbiguousRoomsWithAI IS called when
 *      a life safety page is present (prevents the tests from vacuously passing).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ProcessingStep } from "@workspace/db";
import type { RoomRecord } from "./room-inventory";

// ── Hoisted state ─────────────────────────────────────────────────────────────
// Declared before vi.mock() calls so they are available inside mock factories.

const {
  captureState,
  jobsTableSym,
  jobFilesTableSym,
  extractedSignsTableSym,
  signTypeSpecsTableSym,
  signageScheduleEntriesTableSym,
  mockRunPhase2Classification,
  mockBuildRoomInventory,
  mockEnrichAmbiguousRoomsWithAI,
} = vi.hoisted(() => {
  const captureState = {
    processingLog: null as ProcessingStep[] | null,
    mockFile: {
      id: "file-gate-1",
      jobId: "job-gate-test",
      originalName: "floor-plans.pdf",
      storedPath: "/fake/floor-plans.pdf",
      pageStats: null,
      pageCount: null,
      roomInventory: null,
      extractedText: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  };

  return {
    captureState,
    jobsTableSym: Symbol("jobsTable"),
    jobFilesTableSym: Symbol("jobFilesTable"),
    extractedSignsTableSym: Symbol("extractedSignsTable"),
    signTypeSpecsTableSym: Symbol("signTypeSpecsTable"),
    signageScheduleEntriesTableSym: Symbol("signageScheduleEntriesTable"),
    mockRunPhase2Classification: vi.fn(),
    mockBuildRoomInventory: vi.fn(),
    mockEnrichAmbiguousRoomsWithAI: vi.fn(),
  };
});

// ── drizzle-orm mock ──────────────────────────────────────────────────────────
// eq/and/inArray return the value argument directly so .where(eq(table.col, val))
// passes val to the where handler — same pattern as pdf-processor-rescan.test.ts.

vi.mock("drizzle-orm", () => ({
  eq: (_col: unknown, value: unknown) => value,
  and: (...args: unknown[]) => args[0],
  inArray: (_col: unknown, values: unknown) => values,
}));

// ── @workspace/db mock ────────────────────────────────────────────────────────

vi.mock("@workspace/db", () => {
  const mockDb = {
    select: (_fields?: unknown) => ({
      from: (table: symbol) => ({
        where: (_cond: unknown) => {
          if (table === jobFilesTableSym) {
            return Promise.resolve([captureState.mockFile]);
          }
          return Promise.resolve([]);
        },
        then: (resolve: (v: unknown[]) => unknown) => {
          return Promise.resolve([]).then(resolve);
        },
      }),
    }),

    delete: (_table: symbol) => ({
      where: (_cond: unknown) => Promise.resolve([]),
    }),

    update: (table: symbol) => ({
      set: (values: Record<string, unknown>) => ({
        where: (_cond: unknown) => {
          if ("processingLog" in values && Array.isArray(values.processingLog)) {
            captureState.processingLog = values.processingLog as ProcessingStep[];
          }
          return Promise.resolve([]);
        },
      }),
    }),

    insert: (_table: symbol) => ({
      values: (_rows: unknown) => ({
        returning: (_fields?: unknown) => Promise.resolve([]),
        then: (resolve: (v: unknown) => unknown) => Promise.resolve({}).then(resolve),
      }),
    }),
  };

  return {
    db: mockDb,
    jobsTable: jobsTableSym,
    jobFilesTable: jobFilesTableSym,
    extractedSignsTable: extractedSignsTableSym,
    signTypeSpecsTable: signTypeSpecsTableSym,
    signageScheduleEntriesTable: signageScheduleEntriesTableSym,
  };
});

// ── Other module mocks ────────────────────────────────────────────────────────

vi.mock("./extraction", () => ({
  extractTextFromPdf: vi.fn().mockResolvedValue({
    pages: [{ pageNum: 1, text: "TEST ROOM A 100 SQFT" }],
    numPages: 1,
  }),
}));

vi.mock("./sign-vocabulary", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sign-vocabulary")>();
  return {
    ...actual,
    isCodeOnlyLocation: vi.fn().mockReturnValue(false),
  };
});

vi.mock("./storage", () => ({
  saveParsedResult: vi.fn().mockResolvedValue(undefined),
  getFilePageImagesDir: vi.fn().mockReturnValue("/tmp/pages/file-gate-1"),
  PAGES_DIR: "/tmp/pages",
}));

vi.mock("./pdf-render", () => ({
  renderFloorPlanPages: vi.fn().mockResolvedValue(new Map()),
}));

vi.mock("./logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("./pdf-words", () => ({
  extractPagePhrases: vi.fn().mockResolvedValue({ phrases: [] }),
  extractRawPageItems: vi.fn().mockResolvedValue({ items: [], pageWidth: 600, pageHeight: 800 }),
  matchLocationToCoords: vi.fn().mockReturnValue(null),
}));

vi.mock("./phase-1-intake", () => ({
  runPhase1Intake: vi.fn().mockResolvedValue({
    fileType: "data",
    buildingType: null,
    projectName: null,
    jurisdiction: null,
    issueDate: null,
    drawingIndexPageNum: null,
    levelCount: 1,
    levelNames: ["L1"],
  }),
  classifyFileType: vi.fn().mockReturnValue("data"),
}));

vi.mock("./phase-2-classification", () => ({
  runPhase2Classification: mockRunPhase2Classification,
}));

vi.mock("./signage-schedule-parser", () => ({
  extractSignageData: vi.fn().mockReturnValue({ specs: [], entries: [] }),
}));

vi.mock("./sign-schedule-extractor", () => ({
  extractSignSchedule: vi.fn().mockResolvedValue({
    plaqueTypes: [],
    generalNotes: [],
    sourcePages: [],
    extractionMethod: "text_fallback",
    warnings: [],
  }),
}));

vi.mock("./rule-engine", () => ({
  applySignRules: vi.fn().mockReturnValue({
    roomCount: 1,
    assignments: [],
    verificationErrors: [],
    decisionsLog: [],
    questionsForVerification: [],
    pageAudit: [],
    rawStairCount: 0,
    rawElevatorCount: 0,
  }),
  assignmentToRows: vi.fn().mockReturnValue([]),
}));

vi.mock("./verifier", () => ({
  verifyRuleEngineResult: vi.fn().mockReturnValue({
    passed: true,
    errors: [],
    warnings: [],
    questionsForVerification: [],
    summary: { totalSigns: 0, byType: {} },
    checksPassed: [],
  }),
}));

vi.mock("./occurrence-group-key", () => ({
  occurrenceGroupKey: vi.fn().mockReturnValue("group-key"),
}));

// room-inventory: keep isAmbiguousRoom real; mock buildRoomInventory so it can be
// configured per-test; spy on enrichAmbiguousRoomsWithAI.
vi.mock("./room-inventory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./room-inventory")>();
  return {
    ...actual,
    buildRoomInventory: mockBuildRoomInventory,
    enrichAmbiguousRoomsWithAI: mockEnrichAmbiguousRoomsWithAI,
  };
});

// ── Imports (resolved after mocks) ────────────────────────────────────────────

import { runPdfProcessor } from "./pdf-processor";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRoom(overrides: Partial<RoomRecord> = {}): RoomRecord {
  return {
    roomNumber: null,
    roomName: "HOLDING",
    level: "L1",
    pdfPage: 1,
    occupantLoad: null,
    occupancyGroup: null,
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
    isResidentialUnit: false,
    boundingBox: null,
    extractionConfidence: 0.9,
    ...overrides,
  };
}

function makeRoomInventory(rooms: RoomRecord[] = [makeRoom()]) {
  return {
    rooms,
    occupantLoadTableFound: false,
    occupantLoadRoomsMatched: 0,
    occupantLoadSource: "none" as const,
    warnings: [],
  };
}

/** Minimal classification with floor-plan pages but NO life safety page. */
function makeClassificationNoLifeSafety() {
  return {
    floorPlanPages: [1],
    signSchedulePages: [],
    bothPages: [],
    otherPages: [],
    manifest: {
      entries: [],
      totalPages: 1,
      isExcerpt: false,
      warnings: [],
    },
    spatialFloorLevelNames: new Map<number, string>(),
  };
}

/** Classification with a life safety page. */
function makeClassificationWithLifeSafety() {
  return {
    floorPlanPages: [1],
    signSchedulePages: [],
    bothPages: [],
    otherPages: [],
    manifest: {
      entries: [
        {
          pdfPage: 2,
          bucket: "life_safety" as const,
          sheetTitle: "Life Safety Plan",
          sheetNumber: "LS1",
          level: "L1",
          area: null,
          building: null,
          source: "bookmark" as const,
        },
      ],
      totalPages: 2,
      isExcerpt: false,
      warnings: [],
    },
    spatialFloorLevelNames: new Map<number, string>(),
  };
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe("AI enrichment gate — integration (runs through actual pdf-processor.ts gate code)", () => {
  beforeEach(() => {
    captureState.processingLog = null;
    mockRunPhase2Classification.mockReset();
    mockBuildRoomInventory.mockReset();
    mockEnrichAmbiguousRoomsWithAI.mockReset();
  });

  // ── Gate blocks Gemini calls ────────────────────────────────────────────────

  describe("enrichAmbiguousRoomsWithAI is NOT called when hasLifeSafetyPage is false", () => {
    it("gate prevents the Gemini enrichment call on a floor-plan-only PDF", async () => {
      mockRunPhase2Classification.mockResolvedValue(makeClassificationNoLifeSafety());
      mockBuildRoomInventory.mockResolvedValue(makeRoomInventory());

      await runPdfProcessor("job-gate-test");

      expect(mockEnrichAmbiguousRoomsWithAI).not.toHaveBeenCalled();
    });

    it("gate prevents Gemini call even when rooms in the inventory are ambiguous", async () => {
      mockRunPhase2Classification.mockResolvedValue(makeClassificationNoLifeSafety());

      // Ambiguous rooms (no flags set, no clear classification).
      const ambiguousRooms = [
        makeRoom({ roomName: "HOLDING", extractionConfidence: 0.3 }),
        makeRoom({ roomName: "WC", extractionConfidence: 0.2 }),
      ];
      mockBuildRoomInventory.mockResolvedValue(makeRoomInventory(ambiguousRooms));

      await runPdfProcessor("job-gate-test");

      expect(mockEnrichAmbiguousRoomsWithAI).not.toHaveBeenCalled();
    });
  });

  // ── room_inventory_ai_* step record when gate is skipped ───────────────────

  describe("room_inventory_ai_* step record carries skipped: true and skipReason when hasLifeSafetyPage is false", () => {
    async function runAndGetAiStep() {
      mockRunPhase2Classification.mockResolvedValue(makeClassificationNoLifeSafety());
      mockBuildRoomInventory.mockResolvedValue(makeRoomInventory());

      await runPdfProcessor("job-gate-test");

      const log = captureState.processingLog;
      expect(log).not.toBeNull();
      const fileId = captureState.mockFile.id;
      return log!.find((s) => s.step === `room_inventory_ai_${fileId}`);
    }

    it("emits the room_inventory_ai_* step record when the gate is skipped", async () => {
      const aiStep = await runAndGetAiStep();
      expect(aiStep).toBeDefined();
    });

    it("step record has skipped: true", async () => {
      const aiStep = await runAndGetAiStep();
      expect(aiStep?.details?.skipped).toBe(true);
    });

    it("step record has the expected skipReason", async () => {
      const aiStep = await runAndGetAiStep();
      expect(aiStep?.details?.skipReason).toBe("No life safety sheet in manifest");
    });

    it("step record has ambiguousSubmitted: 0", async () => {
      const aiStep = await runAndGetAiStep();
      expect(aiStep?.details?.ambiguousSubmitted).toBe(0);
    });

    it("step record has enrichedCount: 0", async () => {
      const aiStep = await runAndGetAiStep();
      expect(aiStep?.details?.enrichedCount).toBe(0);
    });
  });

  // ── Positive-control: gate allows Gemini call when life safety page present ──

  describe("enrichAmbiguousRoomsWithAI IS called when hasLifeSafetyPage is true (positive control)", () => {
    it("gate allows the Gemini enrichment call when a life safety page exists in the manifest", async () => {
      mockRunPhase2Classification.mockResolvedValue(makeClassificationWithLifeSafety());
      mockBuildRoomInventory.mockResolvedValue(makeRoomInventory([makeRoom()]));
      mockEnrichAmbiguousRoomsWithAI.mockResolvedValue({
        rooms: [makeRoom()],
        enrichedCount: 0,
      });

      await runPdfProcessor("job-gate-test");

      expect(mockEnrichAmbiguousRoomsWithAI).toHaveBeenCalledTimes(1);
    });

    it("room_inventory_ai_* step record does NOT have skipped: true when life safety page is present", async () => {
      mockRunPhase2Classification.mockResolvedValue(makeClassificationWithLifeSafety());
      mockBuildRoomInventory.mockResolvedValue(makeRoomInventory([makeRoom()]));
      mockEnrichAmbiguousRoomsWithAI.mockResolvedValue({
        rooms: [makeRoom()],
        enrichedCount: 0,
      });

      await runPdfProcessor("job-gate-test");

      const log = captureState.processingLog;
      expect(log).not.toBeNull();
      const fileId = captureState.mockFile.id;
      const aiStep = log!.find((s) => s.step === `room_inventory_ai_${fileId}`);
      expect(aiStep).toBeDefined();
      expect(aiStep?.details?.skipped).not.toBe(true);
    });
  });
});
