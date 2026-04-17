import { describe, it, expect, vi } from "vitest";
import type { RoomRecord } from "./room-inventory";

// ── Module mocks (hoisted before imports) ─────────────────────────────────────
// planAiEnrichment is a pure function that only uses isAmbiguousRoom from
// room-inventory. Mock all the other heavy dependencies so the module loads.

vi.mock("@workspace/db", () => ({
  db: { update: vi.fn(), delete: vi.fn() },
  jobsTable: {},
  jobFilesTable: {},
  extractedSignsTable: {},
  signTypeSpecsTable: {},
  signageScheduleEntriesTable: {},
}));

vi.mock("./extraction", () => ({ extractTextFromPdf: vi.fn() }));
vi.mock("./sign-vocabulary", () => ({ isCodeOnlyLocation: vi.fn() }));
vi.mock("./storage", () => ({
  saveParsedResult: vi.fn(),
  getFilePageImagesDir: vi.fn(),
  PAGES_DIR: "/tmp/pages",
}));
vi.mock("./pdf-render", () => ({ renderFloorPlanPages: vi.fn() }));
vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
vi.mock("./pdf-words", () => ({
  extractPagePhrases: vi.fn(),
  extractRawPageItems: vi.fn(),
  matchLocationToCoords: vi.fn(),
}));
vi.mock("./phase-2-classification", () => ({ runPhase2Classification: vi.fn() }));
vi.mock("./phase-1-intake", () => ({
  runPhase1Intake: vi.fn(),
  classifyFileType: vi.fn(),
}));
vi.mock("./signage-schedule-parser", () => ({ extractSignageData: vi.fn() }));
vi.mock("./sign-schedule-extractor", () => ({ extractSignSchedule: vi.fn() }));
vi.mock("./rule-engine", () => ({
  applySignRules: vi.fn(),
  assignmentToRows: vi.fn(),
}));
vi.mock("./verifier", () => ({ verifyRuleEngineResult: vi.fn() }));
vi.mock("./occurrence-group-key", () => ({ occurrenceGroupKey: vi.fn() }));

// room-inventory is NOT mocked — planAiEnrichment uses isAmbiguousRoom from it

import { planAiEnrichment } from "./pdf-processor";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRoom(overrides: Partial<RoomRecord> = {}): RoomRecord {
  return {
    roomNumber: null,
    roomName: "HOLDING",
    level: "1",
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

// ── planAiEnrichment — life safety gate ───────────────────────────────────────

describe("planAiEnrichment — life safety gate (Task 602)", () => {
  it("skips enrichment when hasLifeSafetyPage is false", () => {
    const rooms = [makeRoom(), makeRoom()];
    const result = planAiEnrichment(rooms, false);
    expect(result.skipped).toBe(true);
  });

  it("includes the expected skipReason when skipped", () => {
    const result = planAiEnrichment([makeRoom()], false);
    expect(result.skipped).toBe(true);
    if (result.skipped) {
      expect(result.skipReason).toBe("No life safety sheet in manifest");
    }
  });

  it("skips even when rooms would be ambiguous (life safety gate takes priority)", () => {
    const ambiguous = makeRoom({ roomName: "HOLDING", extractionConfidence: 0.9 });
    const result = planAiEnrichment([ambiguous], false);
    expect(result.skipped).toBe(true);
  });

  it("does NOT skip when hasLifeSafetyPage is true", () => {
    const result = planAiEnrichment([makeRoom({ isRestroom: true })], true);
    expect(result.skipped).toBe(false);
  });

  it("counts ambiguous rooms correctly when life safety page is present", () => {
    const classified = makeRoom({ isRestroom: true, extractionConfidence: 0.9 });
    const unclassified = makeRoom({ roomName: "HOLDING", extractionConfidence: 0.9 });
    const result = planAiEnrichment([classified, unclassified], true);
    expect(result.skipped).toBe(false);
    if (!result.skipped) {
      expect(result.ambiguousCount).toBe(1);
    }
  });

  it("returns ambiguousCount=0 when all rooms are already classified", () => {
    const rooms = [
      makeRoom({ isRestroom: true }),
      makeRoom({ isStair: true }),
      makeRoom({ isMepUnoccupied: true }),
    ];
    const result = planAiEnrichment(rooms, true);
    expect(result.skipped).toBe(false);
    if (!result.skipped) {
      expect(result.ambiguousCount).toBe(0);
    }
  });

  it("excludes residential units from the ambiguous count", () => {
    const rooms = [
      makeRoom({ roomName: "202", isResidentialUnit: true, extractionConfidence: 0.9 }),
      makeRoom({ roomName: "1A", isResidentialUnit: true, extractionConfidence: 0.9 }),
    ];
    const result = planAiEnrichment(rooms, true);
    expect(result.skipped).toBe(false);
    if (!result.skipped) {
      expect(result.ambiguousCount).toBe(0);
    }
  });
});
