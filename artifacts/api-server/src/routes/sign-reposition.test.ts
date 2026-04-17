/**
 * Tests that PATCHing xPos/yPos on an extracted sign leaves
 * occurrenceIndex and occurrenceTotal untouched.
 *
 * The PATCH handler updates only the fields provided in the request body.
 * Occurrence columns are set at extraction time and are never included in
 * the update payload by this endpoint, so they must come back unchanged
 * in the response.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// ─── Auth fixtures ────────────────────────────────────────────────────────────

const SUPER_ADMIN = {
  userId: "user-super",
  role: "SUPER_ADMIN" as const,
  organizationId: null,
  isSuperAdmin: true,
  userName: "Super Admin",
  userInitials: "SA",
};

// ─── DB data fixtures ─────────────────────────────────────────────────────────

const SIGN_ID = "11111111-2222-3333-4444-555555555555";
const JOB_ID  = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

/** An existing sign with stable occurrence columns already populated */
const EXISTING_SIGN = {
  id: SIGN_ID,
  jobId: JOB_ID,
  signType: "EXIT",
  signIdentifier: "E-1",
  location: "Corridor 1",
  pageNumber: 1,
  xPos: 0.25,
  yPos: 0.40,
  occurrenceIndex: 2,
  occurrenceTotal: 3,
  userVerified: false,
  hidden: false,
};

const MOCK_JOB = { id: JOB_ID, organizationId: null };

// ─── Hoisted DB mock ──────────────────────────────────────────────────────────

const dbMock = vi.hoisted(() => {
  const mockSelect = vi.fn();
  const mockUpdate = vi.fn();
  return { mockSelect, mockUpdate };
});

vi.mock("@workspace/db", () => ({
  db: {
    select: dbMock.mockSelect,
    update: dbMock.mockUpdate,
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

// Heavy side-effect modules not needed in these tests
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
vi.mock("../middlewares/authMiddleware", () => ({ requireRole: () => (_req: unknown, _res: unknown, next: () => void) => next() }));
vi.mock("../lib/record-activity", () => ({ recordActivity: vi.fn() }));

import jobsRouter from "./jobs";

// ─── Query chain helpers ──────────────────────────────────────────────────────

/**
 * Stubs one db.select() chain: .from().where() → resolves with `rows`.
 */
function stubSelect(rows: unknown[]) {
  const where = vi.fn().mockResolvedValue(rows);
  const from  = vi.fn().mockReturnValue({ where });
  dbMock.mockSelect.mockReturnValueOnce({ from });
}

/**
 * Stubs one db.update() chain: .set().where().returning() → resolves with `rows`.
 */
function stubUpdate(rows: unknown[]) {
  const returning = vi.fn().mockResolvedValue(rows);
  const where     = vi.fn().mockReturnValue({ returning });
  const set       = vi.fn().mockReturnValue({ where });
  dbMock.mockUpdate.mockReturnValueOnce({ set });
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

describe("PATCH /extracted-signs/:signId — occurrence stability when repositioning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the sign with occurrenceIndex unchanged after a position update", async () => {
    const updatedSign = { ...EXISTING_SIGN, xPos: 0.55, yPos: 0.72 };

    // Select the existing sign
    stubSelect([EXISTING_SIGN]);
    // getJobWithOrgCheck job lookup
    stubSelect([MOCK_JOB]);
    // db.update(...).returning()
    stubUpdate([updatedSign]);

    const app = buildApp();
    const res = await request(app)
      .patch(`/extracted-signs/${SIGN_ID}`)
      .send({ xPos: 0.55, yPos: 0.72 });

    expect(res.status).toBe(200);
    expect(res.body.sign.occurrenceIndex).toBe(EXISTING_SIGN.occurrenceIndex);
    expect(res.body.sign.occurrenceTotal).toBe(EXISTING_SIGN.occurrenceTotal);
  });

  it("returns the sign with occurrenceTotal unchanged after a position update", async () => {
    const updatedSign = { ...EXISTING_SIGN, xPos: 0.10, yPos: 0.90 };

    stubSelect([EXISTING_SIGN]);
    stubSelect([MOCK_JOB]);
    stubUpdate([updatedSign]);

    const app = buildApp();
    const res = await request(app)
      .patch(`/extracted-signs/${SIGN_ID}`)
      .send({ xPos: 0.10, yPos: 0.90 });

    expect(res.status).toBe(200);
    expect(res.body.sign.occurrenceTotal).toBe(3);
  });

  it("does not include occurrenceIndex or occurrenceTotal in the db.update payload", async () => {
    const updatedSign = { ...EXISTING_SIGN, xPos: 0.80, yPos: 0.15 };

    stubSelect([EXISTING_SIGN]);
    stubSelect([MOCK_JOB]);
    stubUpdate([updatedSign]);

    const app = buildApp();
    await request(app)
      .patch(`/extracted-signs/${SIGN_ID}`)
      .send({ xPos: 0.80, yPos: 0.15 });

    // The set() call on db.update() must not contain occurrence columns
    const setCall = dbMock.mockUpdate.mock.results[0]?.value?.set;
    expect(setCall).toBeDefined();
    const setPayload = setCall.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setPayload).not.toHaveProperty("occurrenceIndex");
    expect(setPayload).not.toHaveProperty("occurrenceTotal");
  });

  it("preserves occurrenceIndex=null for a sign that is the sole occurrence", async () => {
    const singleSign = { ...EXISTING_SIGN, occurrenceIndex: null, occurrenceTotal: null };
    const updatedSingle = { ...singleSign, xPos: 0.60, yPos: 0.30 };

    stubSelect([singleSign]);
    stubSelect([MOCK_JOB]);
    stubUpdate([updatedSingle]);

    const app = buildApp();
    const res = await request(app)
      .patch(`/extracted-signs/${SIGN_ID}`)
      .send({ xPos: 0.60, yPos: 0.30 });

    expect(res.status).toBe(200);
    expect(res.body.sign.occurrenceIndex).toBeNull();
    expect(res.body.sign.occurrenceTotal).toBeNull();
  });

  it("returns 404 when the sign does not exist", async () => {
    stubSelect([]); // sign not found

    const app = buildApp();
    const res = await request(app)
      .patch(`/extracted-signs/${SIGN_ID}`)
      .send({ xPos: 0.5, yPos: 0.5 });

    expect(res.status).toBe(404);
  });

  it("returns 400 when xPos is outside the valid 0–1 range", async () => {
    const app = buildApp();
    const res = await request(app)
      .patch(`/extracted-signs/${SIGN_ID}`)
      .send({ xPos: 1.5, yPos: 0.5 });

    expect(res.status).toBe(400);
  });
});
