/**
 * Tests that PATCHing `location` or `signType` on an extracted sign correctly
 * recomputes occurrenceIndex and occurrenceTotal for both the old group (which
 * now has one fewer member) and the new group (which the sign has joined).
 *
 * The group key is (signType + location).  When either field changes, both
 * groups must be recalculated so that no sign displays a stale "(2/3)" label.
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

const SIGN_ID  = "aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb";
const PEER1_ID = "aaaaaaaa-1111-2222-3333-cccccccccccc";
const PEER3_ID = "aaaaaaaa-1111-2222-3333-dddddddddddd";
const JOB_ID   = "cccccccc-4444-5555-6666-dddddddddddd";

/**
 * The sign under test — currently in a group of 3 ("Corridor 1" / "EXIT").
 * occurrenceIndex=2, occurrenceTotal=3 were assigned at extraction time.
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

/** Two peers that share the same group as EXISTING_SIGN. */
const PEER1 = { ...EXISTING_SIGN, id: PEER1_ID, occurrenceIndex: 1, occurrenceTotal: 3 };
const PEER3 = { ...EXISTING_SIGN, id: PEER3_ID, occurrenceIndex: 3, occurrenceTotal: 3 };

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
  asc:        vi.fn((col) => ({ asc: col })),
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
  const orderBy = vi.fn().mockResolvedValue(rows);
  const where   = vi.fn().mockReturnValue({
    then:    (resolve: (v: unknown) => unknown) => Promise.resolve(rows).then(resolve),
    catch:   (reject:  (e: unknown) => unknown) => Promise.resolve(rows).catch(reject),
    finally: (cb: () => void)                   => Promise.resolve(rows).finally(cb),
    orderBy,
  });
  const from = vi.fn().mockReturnValue({ where });
  dbMock.mockSelect.mockReturnValueOnce({ from });
}

/**
 * Stub for updates that call `.returning()` (the main sign update).
 */
function stubUpdateReturning(rows: unknown[]) {
  const returning = vi.fn().mockResolvedValue(rows);
  const where     = vi.fn().mockReturnValue({ returning });
  const set       = vi.fn().mockReturnValue({ where });
  dbMock.mockUpdate.mockReturnValueOnce({ set });
}

/**
 * Stub for bulk updates that do NOT call `.returning()`.
 * `.where()` returns a plain object; `await`ing it resolves immediately.
 */
function stubUpdateNoReturn() {
  const where = vi.fn().mockReturnValue({});
  const set   = vi.fn().mockReturnValue({ where });
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

describe("PATCH /extracted-signs/:signId — occurrence label recomputation on group-key change", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── location change: sign moves to an empty new group ───────────────────────

  it("returns occurrenceIndex=null when the sign is the sole member of its new group after location change", async () => {
    const updatedSign = { ...EXISTING_SIGN, location: "Stairwell B" };
    const allJobSigns = [updatedSign, PEER1, PEER3];

    stubSelect([EXISTING_SIGN]);
    stubSelect([MOCK_JOB]);
    stubUpdateReturning([updatedSign]);
    stubSelect(allJobSigns);
    stubUpdateNoReturn(); // peer1 old-group update
    stubUpdateNoReturn(); // peer3 old-group update
    stubUpdateNoReturn(); // SIGN new-group update (set to null)

    const res = await request(buildApp())
      .patch(`/extracted-signs/${SIGN_ID}`)
      .send({ location: "Stairwell B" });

    expect(res.status).toBe(200);
    expect(res.body.sign.occurrenceIndex).toBeNull();
    expect(res.body.sign.occurrenceTotal).toBeNull();
  });

  it("returns the correct occurrenceIndex when the sign joins an existing group after location change", async () => {
    const existingMember = { ...EXISTING_SIGN, id: "other-id", location: "Stairwell B", occurrenceIndex: null, occurrenceTotal: null };
    const updatedSign    = { ...EXISTING_SIGN, location: "Stairwell B" };
    const allJobSigns    = [PEER1, PEER3, existingMember, updatedSign];

    stubSelect([EXISTING_SIGN]);
    stubSelect([MOCK_JOB]);
    stubUpdateReturning([updatedSign]);
    stubSelect(allJobSigns);
    stubUpdateNoReturn(); // peer1 old-group
    stubUpdateNoReturn(); // peer3 old-group
    stubUpdateNoReturn(); // existingMember new-group
    stubUpdateNoReturn(); // SIGN new-group

    const res = await request(buildApp())
      .patch(`/extracted-signs/${SIGN_ID}`)
      .send({ location: "Stairwell B" });

    expect(res.status).toBe(200);
    expect(res.body.sign.occurrenceIndex).toBe(2);
    expect(res.body.sign.occurrenceTotal).toBe(2);
  });

  // ── old group: peers get recomputed indices ──────────────────────────────────

  it("issues db.update calls for the old group's remaining peers", async () => {
    const updatedSign = { ...EXISTING_SIGN, location: "Stairwell B" };
    const allJobSigns = [updatedSign, PEER1, PEER3];

    stubSelect([EXISTING_SIGN]);
    stubSelect([MOCK_JOB]);
    stubUpdateReturning([updatedSign]);
    stubSelect(allJobSigns);
    stubUpdateNoReturn(); // peer1
    stubUpdateNoReturn(); // peer3
    stubUpdateNoReturn(); // SIGN (new group)

    await request(buildApp())
      .patch(`/extracted-signs/${SIGN_ID}`)
      .send({ location: "Stairwell B" });

    expect(dbMock.mockUpdate).toHaveBeenCalledTimes(4);
  });

  // ── the main update payload must NOT include occurrence fields ───────────────

  it("does not include occurrenceIndex or occurrenceTotal in the main db.update payload when location changes", async () => {
    const updatedSign = { ...EXISTING_SIGN, location: "Lobby" };
    const allJobSigns = [updatedSign, PEER1, PEER3];

    stubSelect([EXISTING_SIGN]);
    stubSelect([MOCK_JOB]);
    stubUpdateReturning([updatedSign]);
    stubSelect(allJobSigns);
    stubUpdateNoReturn();
    stubUpdateNoReturn();
    stubUpdateNoReturn();

    await request(buildApp())
      .patch(`/extracted-signs/${SIGN_ID}`)
      .send({ location: "Lobby" });

    const firstUpdateSet = dbMock.mockUpdate.mock.results[0]?.value?.set;
    expect(firstUpdateSet).toBeDefined();
    const setPayload = firstUpdateSet.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setPayload).not.toHaveProperty("occurrenceIndex");
    expect(setPayload).not.toHaveProperty("occurrenceTotal");
  });

  it("does not include occurrenceIndex or occurrenceTotal in the main db.update payload when signType changes", async () => {
    const updatedSign = { ...EXISTING_SIGN, signType: "FIRE_EXTINGUISHER" };
    const allJobSigns = [updatedSign, PEER1, PEER3];

    stubSelect([EXISTING_SIGN]);
    stubSelect([MOCK_JOB]);
    stubUpdateReturning([updatedSign]);
    stubSelect(allJobSigns);
    stubUpdateNoReturn();
    stubUpdateNoReturn();
    stubUpdateNoReturn();

    await request(buildApp())
      .patch(`/extracted-signs/${SIGN_ID}`)
      .send({ signType: "FIRE_EXTINGUISHER" });

    const firstUpdateSet = dbMock.mockUpdate.mock.results[0]?.value?.set;
    expect(firstUpdateSet).toBeDefined();
    const setPayload = firstUpdateSet.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setPayload).not.toHaveProperty("occurrenceIndex");
    expect(setPayload).not.toHaveProperty("occurrenceTotal");
  });

  // ── signType change ──────────────────────────────────────────────────────────

  it("returns occurrenceIndex=null when the sign is the sole member of its new group after signType change", async () => {
    const updatedSign = { ...EXISTING_SIGN, signType: "FIRE_EXTINGUISHER" };
    const allJobSigns = [updatedSign, PEER1, PEER3];

    stubSelect([EXISTING_SIGN]);
    stubSelect([MOCK_JOB]);
    stubUpdateReturning([updatedSign]);
    stubSelect(allJobSigns);
    stubUpdateNoReturn();
    stubUpdateNoReturn();
    stubUpdateNoReturn();

    const res = await request(buildApp())
      .patch(`/extracted-signs/${SIGN_ID}`)
      .send({ signType: "FIRE_EXTINGUISHER" });

    expect(res.status).toBe(200);
    expect(res.body.sign.occurrenceIndex).toBeNull();
    expect(res.body.sign.occurrenceTotal).toBeNull();
  });

  // ── simultaneous location + signType change ──────────────────────────────────

  it("recomputes indices correctly when both location and signType are patched together", async () => {
    const updatedSign = { ...EXISTING_SIGN, location: "Roof Level", signType: "WAYFINDING" };
    const allJobSigns = [updatedSign, PEER1, PEER3];

    stubSelect([EXISTING_SIGN]);
    stubSelect([MOCK_JOB]);
    stubUpdateReturning([updatedSign]);
    stubSelect(allJobSigns);
    stubUpdateNoReturn();
    stubUpdateNoReturn();
    stubUpdateNoReturn();

    const res = await request(buildApp())
      .patch(`/extracted-signs/${SIGN_ID}`)
      .send({ location: "Roof Level", signType: "WAYFINDING" });

    expect(res.status).toBe(200);
    expect(res.body.sign.occurrenceIndex).toBeNull();
    expect(res.body.sign.occurrenceTotal).toBeNull();
  });

  // ── no recomputation when group key is unchanged ─────────────────────────────

  it("does not issue extra db queries when location is patched to the same value", async () => {
    const updatedSign = { ...EXISTING_SIGN };

    stubSelect([EXISTING_SIGN]);
    stubSelect([MOCK_JOB]);
    stubUpdateReturning([updatedSign]);

    const res = await request(buildApp())
      .patch(`/extracted-signs/${SIGN_ID}`)
      .send({ location: "Corridor 1" });

    expect(res.status).toBe(200);
    expect(dbMock.mockSelect).toHaveBeenCalledTimes(2);
    expect(dbMock.mockUpdate).toHaveBeenCalledTimes(1);
    expect(res.body.sign.occurrenceIndex).toBe(EXISTING_SIGN.occurrenceIndex);
  });

  it("does not issue extra db queries when only non-group-key fields change", async () => {
    const updatedSign = { ...EXISTING_SIGN, notes: "updated note" };

    stubSelect([EXISTING_SIGN]);
    stubSelect([MOCK_JOB]);
    stubUpdateReturning([updatedSign]);

    const res = await request(buildApp())
      .patch(`/extracted-signs/${SIGN_ID}`)
      .send({ notes: "updated note" });

    expect(res.status).toBe(200);
    expect(dbMock.mockSelect).toHaveBeenCalledTimes(2);
    expect(dbMock.mockUpdate).toHaveBeenCalledTimes(1);
    expect(res.body.sign.occurrenceIndex).toBe(EXISTING_SIGN.occurrenceIndex);
  });

  // ── null occurrence values: sole-occurrence sign that moves ──────────────────

  it("recomputes correctly when a sole-occurrence sign (null index) moves to another group", async () => {
    const singleSign  = { ...EXISTING_SIGN, occurrenceIndex: null, occurrenceTotal: null };
    const updatedSign = { ...singleSign, location: "Server Room" };
    const allJobSigns = [updatedSign];

    stubSelect([singleSign]);
    stubSelect([MOCK_JOB]);
    stubUpdateReturning([updatedSign]);
    stubSelect(allJobSigns);
    stubUpdateNoReturn();

    const res = await request(buildApp())
      .patch(`/extracted-signs/${SIGN_ID}`)
      .send({ location: "Server Room" });

    expect(res.status).toBe(200);
    expect(res.body.sign.occurrenceIndex).toBeNull();
    expect(res.body.sign.occurrenceTotal).toBeNull();
  });
});
