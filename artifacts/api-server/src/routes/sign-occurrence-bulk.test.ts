/**
 * Regression tests: occurrence columns (occurrenceIndex / occurrenceTotal) must
 * never be overwritten by the re-extraction (ai-scan) bulk-update path.
 *
 * These columns are computed once by deduplicateSignRows at extraction time.
 * Any bulk update that accidentally includes them would silently reset every
 * sign's occurrence labels. This file ensures that regression cannot happen.
 *
 * Coverage:
 *   1. PATCH /extracted-signs/:signId — schema strips occurrence columns from
 *      the DB update payload even when the client sends them.
 *   2. POST /jobs/:jobId/ai-scan (floor_plan_text) — mergeAiSignRows does not
 *      include occurrence columns when performing an additive update on an
 *      existing (non-verified) sign row.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// ─── Auth fixture ─────────────────────────────────────────────────────────────

const SUPER_ADMIN = {
  userId: "user-super",
  role: "SUPER_ADMIN" as const,
  organizationId: null,
  isSuperAdmin: true,
  userName: "Super Admin",
  userInitials: "SA",
};

// ─── Data fixtures ────────────────────────────────────────────────────────────

const JOB_ID  = "job00000-0000-0000-0000-000000000001";
const SIGN_ID = "sign0000-0000-0000-0000-000000000001";
const FILE_ID = "file0000-0000-0000-0000-000000000001";

const EXISTING_SIGN = {
  id: SIGN_ID,
  jobId: JOB_ID,
  jobFileId: FILE_ID,
  signType: "EXIT",
  signIdentifier: "E-1",
  location: "Corridor A",
  pageNumber: 1,
  xPos: 0.30,
  yPos: 0.50,
  occurrenceIndex: 2,
  occurrenceTotal: 5,
  userVerified: false,
  manuallyAdded: false,
  hidden: false,
  dimensions: null,
  mountingType: null,
  finishColor: null,
  illumination: null,
  materials: null,
  messageContent: null,
  notes: null,
  signIdentifier2: null,
};

const MOCK_JOB = {
  id: JOB_ID,
  organizationId: null,
  status: "complete",
  projectAddress: null,
  projectCity: null,
  projectState: null,
};

const MOCK_FILE = {
  id: FILE_ID,
  jobId: JOB_ID,
  storedPath: "/tmp/test.pdf",
  pageStats: {
    floorPlanPages: [1],
    signSchedulePages: [],
    bothPages: [],
    pageImagePaths: null,
  },
};

// ─── Hoisted DB mock ──────────────────────────────────────────────────────────

const dbMock = vi.hoisted(() => {
  const mockSelect = vi.fn();
  const mockUpdate = vi.fn();
  const mockInsert = vi.fn();
  return { mockSelect, mockUpdate, mockInsert };
});

vi.mock("@workspace/db", () => ({
  db: {
    select: dbMock.mockSelect,
    update: dbMock.mockUpdate,
    insert: dbMock.mockInsert,
  },
  extractedSignsTable: { _brand: "extractedSignsTable" },
  jobsTable:           { _brand: "jobsTable" },
  jobFilesTable:       { _brand: "jobFilesTable" },
  activityLogsTable:   { _brand: "activityLogsTable" },
  signTypeSpecsTable:  { _brand: "signTypeSpecsTable" },
  signageScheduleEntriesTable: { _brand: "signageScheduleEntriesTable" },
}));

vi.mock("drizzle-orm", () => ({
  eq:         vi.fn((col, val) => ({ eq: [col, val] })),
  and:        vi.fn((...c) => ({ and: c })),
  or:         vi.fn((...c) => ({ or: c })),
  desc:       vi.fn((col) => ({ desc: col })),
  ne:         vi.fn((col, val) => ({ ne: [col, val] })),
  inArray:    vi.fn((col, vals) => ({ inArray: [col, vals] })),
  isNull:     vi.fn((col) => ({ isNull: col })),
  isNotNull:  vi.fn((col) => ({ isNotNull: col })),
  not:        vi.fn((c) => ({ not: c })),
  sql:        vi.fn(),
  getTableColumns: vi.fn(() => ({})),
}));

vi.mock("../lib/process-job",   () => ({ processJob: vi.fn(), retryFileExtraction: vi.fn(), deduplicateSignRows: vi.fn() }));
vi.mock("../lib/extraction",    () => ({ extractSignsFromPdfImage: vi.fn(), extractSignsFromPdf: vi.fn(), visualLocateDoors: vi.fn() }));
vi.mock("../lib/export",        () => ({ buildExcelExport: vi.fn() }));
vi.mock("../lib/storage",       () => ({ getJobExportPath: vi.fn(), PAGES_DIR: "/tmp" }));
vi.mock("../lib/ai-processor",  () => ({
  AI_CALL_REGISTRY: {},
  runProjectInfoExtraction:   vi.fn(),
  runFloorPlanTextExtraction: vi.fn(),
  runBboxDetection:           vi.fn(),
  runVisionFallback:          vi.fn(),
  runTitleBlockVision:        vi.fn(),
  runSignScheduleEnrich:      vi.fn(),
}));
vi.mock("../lib/pdf-words",     () => ({ extractPagePhrases: vi.fn(), matchLocationToCoords: vi.fn() }));
vi.mock("@workspace/integrations-gemini-ai", () => ({ ai: {} }));
vi.mock("../middlewares/authMiddleware", () => ({
  requireRole: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../lib/record-activity", () => ({ recordActivity: vi.fn() }));

import { runFloorPlanTextExtraction } from "../lib/ai-processor";
import jobsRouter from "./jobs";

// ─── Query chain helpers ──────────────────────────────────────────────────────

function stubSelect(rows: unknown[]) {
  const where = vi.fn().mockResolvedValue(rows);
  const from  = vi.fn().mockReturnValue({ where });
  dbMock.mockSelect.mockReturnValueOnce({ from });
}

/** Stub a db.update() chain without .returning() (used by mergeAiSignRows). */
function stubBulkUpdate() {
  const where = vi.fn().mockResolvedValue(undefined);
  const set   = vi.fn().mockReturnValue({ where });
  dbMock.mockUpdate.mockReturnValueOnce({ set });
  return set;
}

/** Stub a db.update() chain with .returning() (used by PATCH endpoint). */
function stubUpdateWithReturning(rows: unknown[]) {
  const returning = vi.fn().mockResolvedValue(rows);
  const where     = vi.fn().mockReturnValue({ returning });
  const set       = vi.fn().mockReturnValue({ where });
  dbMock.mockUpdate.mockReturnValueOnce({ set });
  return set;
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.authUser = SUPER_ADMIN;
    (req as express.Request & { log: unknown }).log = {
      info:  vi.fn(),
      error: vi.fn(),
      warn:  vi.fn(),
    };
    next();
  });
  app.use("/", jobsRouter);
  return app;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Occurrence column write-protection — PATCH single-sign endpoint", () => {
  beforeEach(() => vi.clearAllMocks());

  it("strips occurrenceIndex from the DB update payload when the client sends it", async () => {
    const updatedSign = { ...EXISTING_SIGN };

    stubSelect([EXISTING_SIGN]);
    stubSelect([MOCK_JOB]);
    const set = stubUpdateWithReturning([updatedSign]);

    const app = buildApp();
    const res = await request(app)
      .patch(`/extracted-signs/${SIGN_ID}`)
      .send({ signType: "EXIT", occurrenceIndex: 99 });

    expect(res.status).toBe(200);

    const setPayload = set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setPayload).toBeDefined();
    expect(setPayload).not.toHaveProperty("occurrenceIndex");
  });

  it("strips occurrenceTotal from the DB update payload when the client sends it", async () => {
    const updatedSign = { ...EXISTING_SIGN };

    stubSelect([EXISTING_SIGN]);
    stubSelect([MOCK_JOB]);
    const set = stubUpdateWithReturning([updatedSign]);

    const app = buildApp();
    const res = await request(app)
      .patch(`/extracted-signs/${SIGN_ID}`)
      .send({ signType: "EXIT", occurrenceTotal: 99 });

    expect(res.status).toBe(200);

    const setPayload = set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setPayload).toBeDefined();
    expect(setPayload).not.toHaveProperty("occurrenceTotal");
  });
});

describe("Occurrence column write-protection — ai-scan bulk re-extraction path", () => {
  beforeEach(() => vi.clearAllMocks());

  /**
   * The ai-scan route's floor_plan_text call type runs mergeAiSignRows, which
   * performs additive updates on existing sign rows. Those updates must never
   * include occurrenceIndex or occurrenceTotal.
   *
   * This test:
   *   - Seeds an existing sign that has occurrenceIndex=2, occurrenceTotal=5
   *   - Makes runFloorPlanTextExtraction return a row whose key matches that
   *     existing sign, triggering the update (rather than insert) path
   *   - Asserts that db.update().set() was called but did not include either
   *     occurrence column
   */
  it("does not include occurrenceIndex in the mergeAiSignRows update payload", async () => {
    vi.mocked(runFloorPlanTextExtraction).mockResolvedValueOnce({
      rows: [
        {
          page_number: 1,
          location: "Corridor A",
          sign_type: "EXIT",
          sign_identifier: "E-1",
          dimensions: "12x12",   // non-null so it would be written if occurrence were in the update
          mounting_type: null,
          finish_color: null,
          illumination: null,
          materials: null,
          message_content: null,
          notes: null,
          sheet_number: null,
          detail_reference: null,
          quantity: null,
          x_pos: null,
          y_pos: null,
          confidence_score: null,
          review_flag: false,
        },
      ],
      inputTokens: 0,
      outputTokens: 0,
    });

    // 1. getJobWithOrgCheck
    stubSelect([MOCK_JOB]);
    // 2. db.select().from(jobFilesTable).where()
    stubSelect([MOCK_FILE]);
    // 3. db.select().from(extractedSignsTable).where() — existing signs
    stubSelect([EXISTING_SIGN]);
    // 4. mergeAiSignRows update (no .returning())
    const set = stubBulkUpdate();
    // 5. assignMissingCoordinates: select signs without coords → none (sign has xPos)
    stubSelect([]);

    const app = buildApp();
    const res = await request(app)
      .post(`/jobs/${JOB_ID}/ai-scan`)
      .send({ callTypes: ["floor_plan_text"] });

    expect(res.status).toBe(200);
    expect(set).toHaveBeenCalled();

    const setPayload = set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setPayload).not.toHaveProperty("occurrenceIndex");
    expect(setPayload).not.toHaveProperty("occurrenceTotal");
  });

  it("does not include occurrenceTotal in the mergeAiSignRows update payload", async () => {
    vi.mocked(runFloorPlanTextExtraction).mockResolvedValueOnce({
      rows: [
        {
          page_number: 1,
          location: "Corridor A",
          sign_type: "EXIT",
          sign_identifier: null,
          dimensions: null,
          mounting_type: "Wall",  // non-null — would be written if occurrence were in the update
          finish_color: null,
          illumination: null,
          materials: null,
          message_content: null,
          notes: null,
          sheet_number: null,
          detail_reference: null,
          quantity: null,
          x_pos: null,
          y_pos: null,
          confidence_score: null,
          review_flag: false,
        },
      ],
      inputTokens: 0,
      outputTokens: 0,
    });

    stubSelect([MOCK_JOB]);
    stubSelect([MOCK_FILE]);
    stubSelect([EXISTING_SIGN]);
    const set = stubBulkUpdate();
    stubSelect([]);

    const app = buildApp();
    const res = await request(app)
      .post(`/jobs/${JOB_ID}/ai-scan`)
      .send({ callTypes: ["floor_plan_text"] });

    expect(res.status).toBe(200);
    expect(set).toHaveBeenCalled();

    const setPayload = set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setPayload).not.toHaveProperty("occurrenceTotal");
    expect(setPayload).not.toHaveProperty("occurrenceIndex");
  });

  it("does not touch userVerified or manuallyAdded signs during bulk re-extraction", async () => {
    const verifiedSign = { ...EXISTING_SIGN, userVerified: true, occurrenceIndex: 3, occurrenceTotal: 4 };

    vi.mocked(runFloorPlanTextExtraction).mockResolvedValueOnce({
      rows: [
        {
          page_number: 1,
          location: "Corridor A",
          sign_type: "EXIT",
          sign_identifier: null,
          dimensions: "24x24",
          mounting_type: null,
          finish_color: null,
          illumination: null,
          materials: null,
          message_content: null,
          notes: null,
          sheet_number: null,
          detail_reference: null,
          quantity: null,
          x_pos: null,
          y_pos: null,
          confidence_score: null,
          review_flag: false,
        },
      ],
      inputTokens: 0,
      outputTokens: 0,
    });

    stubSelect([MOCK_JOB]);
    stubSelect([MOCK_FILE]);
    stubSelect([verifiedSign]);
    // No update should be called — mergeAiSignRows skips verified/manual rows
    stubSelect([]); // assignMissingCoordinates

    const app = buildApp();
    const res = await request(app)
      .post(`/jobs/${JOB_ID}/ai-scan`)
      .send({ callTypes: ["floor_plan_text"] });

    expect(res.status).toBe(200);
    // db.update must not have been called at all for this sign
    expect(dbMock.mockUpdate).not.toHaveBeenCalled();
  });
});
