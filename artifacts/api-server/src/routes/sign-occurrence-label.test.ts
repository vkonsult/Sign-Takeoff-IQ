/**
 * Tests that PATCHing `location` or `signType` on an extracted sign leaves
 * occurrenceIndex and occurrenceTotal untouched.
 *
 * The group key for occurrence grouping is (location + signType). When a user
 * edits either of those fields the sign logically moves to a different group,
 * but the stored occurrence columns are NOT automatically re-computed by the
 * PATCH handler — they retain the values set at extraction time.
 *
 * These tests document that current behaviour so that any future change that
 * accidentally starts clobbering or silently staling the columns is caught.
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

const SIGN_ID = "aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb";
const JOB_ID  = "cccccccc-4444-5555-6666-dddddddddddd";

/**
 * A sign belonging to a group of 3 ("Corridor 1" / "EXIT").
 * occurrenceIndex=2, occurrenceTotal=3 were set at extraction time.
 */
const EXISTING_SIGN = {
  id: SIGN_ID,
  jobId: JOB_ID,
  signType: "EXIT",
  signIdentifier: "E-2",
  location: "Corridor 1",
  pageNumber: 2,
  xPos: 0.30,
  yPos: 0.50,
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

function stubSelect(rows: unknown[]) {
  const where = vi.fn().mockResolvedValue(rows);
  const from  = vi.fn().mockReturnValue({ where });
  dbMock.mockSelect.mockReturnValueOnce({ from });
}

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

describe("PATCH /extracted-signs/:signId — occurrence label stability when editing group-key fields", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── location edits ──────────────────────────────────────────────────────────

  it("does not alter occurrenceIndex when location is patched to a new value", async () => {
    const updatedSign = { ...EXISTING_SIGN, location: "Stairwell B" };

    stubSelect([EXISTING_SIGN]);
    stubSelect([MOCK_JOB]);
    stubUpdate([updatedSign]);

    const app = buildApp();
    const res = await request(app)
      .patch(`/extracted-signs/${SIGN_ID}`)
      .send({ location: "Stairwell B" });

    expect(res.status).toBe(200);
    expect(res.body.sign.occurrenceIndex).toBe(EXISTING_SIGN.occurrenceIndex);
  });

  it("does not alter occurrenceTotal when location is patched to a new value", async () => {
    const updatedSign = { ...EXISTING_SIGN, location: "Stairwell B" };

    stubSelect([EXISTING_SIGN]);
    stubSelect([MOCK_JOB]);
    stubUpdate([updatedSign]);

    const app = buildApp();
    const res = await request(app)
      .patch(`/extracted-signs/${SIGN_ID}`)
      .send({ location: "Stairwell B" });

    expect(res.status).toBe(200);
    expect(res.body.sign.occurrenceTotal).toBe(EXISTING_SIGN.occurrenceTotal);
  });

  it("does not include occurrenceIndex or occurrenceTotal in the db.update payload when location changes", async () => {
    const updatedSign = { ...EXISTING_SIGN, location: "Lobby" };

    stubSelect([EXISTING_SIGN]);
    stubSelect([MOCK_JOB]);
    stubUpdate([updatedSign]);

    const app = buildApp();
    await request(app)
      .patch(`/extracted-signs/${SIGN_ID}`)
      .send({ location: "Lobby" });

    const setCall = dbMock.mockUpdate.mock.results[0]?.value?.set;
    expect(setCall).toBeDefined();
    const setPayload = setCall.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setPayload).not.toHaveProperty("occurrenceIndex");
    expect(setPayload).not.toHaveProperty("occurrenceTotal");
  });

  // ── signType edits ──────────────────────────────────────────────────────────

  it("does not alter occurrenceIndex when signType is patched to a new value", async () => {
    const updatedSign = { ...EXISTING_SIGN, signType: "FIRE_EXTINGUISHER" };

    stubSelect([EXISTING_SIGN]);
    stubSelect([MOCK_JOB]);
    stubUpdate([updatedSign]);

    const app = buildApp();
    const res = await request(app)
      .patch(`/extracted-signs/${SIGN_ID}`)
      .send({ signType: "FIRE_EXTINGUISHER" });

    expect(res.status).toBe(200);
    expect(res.body.sign.occurrenceIndex).toBe(EXISTING_SIGN.occurrenceIndex);
  });

  it("does not alter occurrenceTotal when signType is patched to a new value", async () => {
    const updatedSign = { ...EXISTING_SIGN, signType: "FIRE_EXTINGUISHER" };

    stubSelect([EXISTING_SIGN]);
    stubSelect([MOCK_JOB]);
    stubUpdate([updatedSign]);

    const app = buildApp();
    const res = await request(app)
      .patch(`/extracted-signs/${SIGN_ID}`)
      .send({ signType: "FIRE_EXTINGUISHER" });

    expect(res.status).toBe(200);
    expect(res.body.sign.occurrenceTotal).toBe(EXISTING_SIGN.occurrenceTotal);
  });

  it("does not include occurrenceIndex or occurrenceTotal in the db.update payload when signType changes", async () => {
    const updatedSign = { ...EXISTING_SIGN, signType: "FIRE_EXTINGUISHER" };

    stubSelect([EXISTING_SIGN]);
    stubSelect([MOCK_JOB]);
    stubUpdate([updatedSign]);

    const app = buildApp();
    await request(app)
      .patch(`/extracted-signs/${SIGN_ID}`)
      .send({ signType: "FIRE_EXTINGUISHER" });

    const setCall = dbMock.mockUpdate.mock.results[0]?.value?.set;
    expect(setCall).toBeDefined();
    const setPayload = setCall.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setPayload).not.toHaveProperty("occurrenceIndex");
    expect(setPayload).not.toHaveProperty("occurrenceTotal");
  });

  // ── simultaneous location + signType edit ───────────────────────────────────

  it("does not alter occurrenceIndex when both location and signType are patched together", async () => {
    const updatedSign = { ...EXISTING_SIGN, location: "Roof Level", signType: "WAYFINDING" };

    stubSelect([EXISTING_SIGN]);
    stubSelect([MOCK_JOB]);
    stubUpdate([updatedSign]);

    const app = buildApp();
    const res = await request(app)
      .patch(`/extracted-signs/${SIGN_ID}`)
      .send({ location: "Roof Level", signType: "WAYFINDING" });

    expect(res.status).toBe(200);
    expect(res.body.sign.occurrenceIndex).toBe(EXISTING_SIGN.occurrenceIndex);
    expect(res.body.sign.occurrenceTotal).toBe(EXISTING_SIGN.occurrenceTotal);
  });

  // ── null occurrence values remain null after group-key edit ─────────────────

  it("preserves null occurrenceIndex for a sole-occurrence sign after location change", async () => {
    const singleSign = { ...EXISTING_SIGN, occurrenceIndex: null, occurrenceTotal: null };
    const updatedSign = { ...singleSign, location: "Server Room" };

    stubSelect([singleSign]);
    stubSelect([MOCK_JOB]);
    stubUpdate([updatedSign]);

    const app = buildApp();
    const res = await request(app)
      .patch(`/extracted-signs/${SIGN_ID}`)
      .send({ location: "Server Room" });

    expect(res.status).toBe(200);
    expect(res.body.sign.occurrenceIndex).toBeNull();
    expect(res.body.sign.occurrenceTotal).toBeNull();
  });

  it("preserves null occurrenceIndex for a sole-occurrence sign after signType change", async () => {
    const singleSign = { ...EXISTING_SIGN, occurrenceIndex: null, occurrenceTotal: null };
    const updatedSign = { ...singleSign, signType: "EXIT_STAIR" };

    stubSelect([singleSign]);
    stubSelect([MOCK_JOB]);
    stubUpdate([updatedSign]);

    const app = buildApp();
    const res = await request(app)
      .patch(`/extracted-signs/${SIGN_ID}`)
      .send({ signType: "EXIT_STAIR" });

    expect(res.status).toBe(200);
    expect(res.body.sign.occurrenceIndex).toBeNull();
    expect(res.body.sign.occurrenceTotal).toBeNull();
  });
});
