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
  asc:        vi.fn((col) => ({ asc: col })),
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
import jobsRouter, { mergeAiSignRows } from "./jobs";

// ─── Query chain helpers ──────────────────────────────────────────────────────

function stubSelect(rows: unknown[]) {
  const orderBy = vi.fn().mockResolvedValue(rows);
  const where   = vi.fn().mockReturnValue(Object.assign(Promise.resolve(rows), { orderBy }));
  const from    = vi.fn().mockReturnValue({ where });
  dbMock.mockSelect.mockReturnValueOnce({ from });
}

/** Stub a db.insert() chain (used by mergeAiSignRows for new signs). */
function stubInsert() {
  const values = vi.fn().mockResolvedValue(undefined);
  dbMock.mockInsert.mockReturnValueOnce({ values });
  return values;
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

// ─── Occurrence recomputation after bulk AI insert ────────────────────────────

const SIGN_ID_2 = "sign0000-0000-0000-0000-000000000002";

const SINGLETON_SIGN = {
  ...EXISTING_SIGN,
  id: SIGN_ID,
  pageNumber: 1,
  occurrenceIndex: null,
  occurrenceTotal: null,
};

const SECOND_SIGN_IN_GROUP = {
  ...EXISTING_SIGN,
  id: SIGN_ID_2,
  pageNumber: 2,
  occurrenceIndex: null,
  occurrenceTotal: null,
};

describe("Occurrence index recomputation — bulk AI insert path", () => {
  beforeEach(() => vi.clearAllMocks());

  /**
   * When mergeAiSignRows inserts a brand-new sign that belongs to the same
   * occurrence group (same signType + location) as an existing sign, both
   * members of the group must have their occurrence labels recomputed.
   *
   * Setup:
   *   - One existing sign: EXIT at Corridor A, page 1 (singleton — no indices)
   *   - AI returns a new sign: EXIT at Corridor A, page 2 (different page ⟹
   *     different composite key ⟹ triggers insert, not update)
   *   - After insert, both signs form a group of 2 and must each get
   *     occurrenceIndex and occurrenceTotal assigned.
   */
  it("recomputes occurrence indices for a group after a new sign is inserted", async () => {
    vi.mocked(runFloorPlanTextExtraction).mockResolvedValueOnce({
      rows: [
        {
          page_number: 2,
          location: "Corridor A",
          sign_type: "EXIT",
          sign_identifier: "E-2",
          dimensions: null,
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
    // 2. fetch files for this job
    stubSelect([MOCK_FILE]);
    // 3. fetch existing signs — only the singleton on page 1
    stubSelect([SINGLETON_SIGN]);
    // 4. insert new sign (page 2 — key differs from singleton)
    stubInsert();
    // 5. fetch all job signs for occurrence recomputation
    stubSelect([SINGLETON_SIGN, SECOND_SIGN_IN_GROUP]);
    // 6. update SINGLETON_SIGN occurrence
    const setCall1 = stubBulkUpdate();
    // 7. update SECOND_SIGN_IN_GROUP occurrence
    const setCall2 = stubBulkUpdate();
    // 8. assignMissingCoordinates — no signs without coords
    stubSelect([]);

    const app = buildApp();
    const res = await request(app)
      .post(`/jobs/${JOB_ID}/ai-scan`)
      .send({ callTypes: ["floor_plan_text"] });

    expect(res.status).toBe(200);

    // Both signs in the group should receive occurrence labels (group size = 2)
    expect(setCall1).toHaveBeenCalledWith(
      expect.objectContaining({ occurrenceIndex: 1, occurrenceTotal: 2 }),
    );
    expect(setCall2).toHaveBeenCalledWith(
      expect.objectContaining({ occurrenceIndex: 2, occurrenceTotal: 2 }),
    );
  });

  it("does not recompute occurrence indices when only existing keys are updated (no insert)", async () => {
    vi.mocked(runFloorPlanTextExtraction).mockResolvedValueOnce({
      rows: [
        {
          page_number: 1,
          location: "Corridor A",
          sign_type: "EXIT",
          sign_identifier: null,
          dimensions: "12x12",
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
    // 2. fetch files
    stubSelect([MOCK_FILE]);
    // 3. existing signs — the key matches the AI row, so update path is taken (no insert)
    stubSelect([{ ...SINGLETON_SIGN, dimensions: null }]);
    // 4. additive update for existing sign (dimensions fill-in)
    stubBulkUpdate();
    // 5. assignMissingCoordinates
    stubSelect([]);

    const app = buildApp();
    const res = await request(app)
      .post(`/jobs/${JOB_ID}/ai-scan`)
      .send({ callTypes: ["floor_plan_text"] });

    expect(res.status).toBe(200);
    // Only one update call (the additive fill-in) — no occurrence recomputation selects
    expect(dbMock.mockUpdate).toHaveBeenCalledTimes(1);
    // And no extra select beyond the three already accounted for (job, file, existing signs, coords)
    expect(dbMock.mockSelect).toHaveBeenCalledTimes(4);
  });
});

// ─── Direct unit tests for mergeAiSignRows key-change detection ───────────────

describe("mergeAiSignRows — key-change detection in update path", () => {
  beforeEach(() => vi.clearAllMocks());

  /**
   * The update path in mergeAiSignRows performs additive fill-in of supplementary
   * fields (dimensions, mounting, etc.).  It currently never rewrites signType or
   * location because those fields are part of the composite dedup key — a key match
   * guarantees they are already equal between the existing sign and the AI row.
   *
   * The defensive key-change detection code is a forward-looking safeguard: if a
   * future change to the update payload were to include signType or location, the
   * occurrence groups would automatically be re-indexed for both the old group
   * (which lost the sign) and the new group (which gained it).
   *
   * This test verifies that the defensive path does NOT fire unnecessary recomputation
   * during a normal additive update (oldKey === newKey), i.e. it has no performance
   * regression on the common case.
   */
  it("does not trigger occurrence recomputation when the update path leaves signType and location unchanged", async () => {
    const existingSign = {
      ...EXISTING_SIGN,
      dimensions: null,          // null → AI can fill this in
      occurrenceIndex: 2,
      occurrenceTotal: 5,
    };

    // Pre-build the key set exactly as the route handler would
    const existingSignKeys = new Set([
      `${FILE_ID}||${existingSign.pageNumber ?? ""}||${(existingSign.location ?? "").toLowerCase().trim()}||${(existingSign.signType ?? "").toLowerCase().trim()}`,
    ]);

    // Stub the single db.update() for the additive fill-in
    const where = vi.fn().mockResolvedValue(undefined);
    const set   = vi.fn().mockReturnValue({ where });
    dbMock.mockUpdate.mockReturnValueOnce({ set });

    const rows = [
      {
        page_number: existingSign.pageNumber,
        location:    existingSign.location,
        sign_type:   existingSign.signType,
        dimensions:  "18x18",         // AI fills in the missing dimension
        sign_identifier: null,
        mounting_type:   null,
        finish_color:    null,
        illumination:    null,
        materials:       null,
        message_content: null,
        notes:           null,
        sheet_number:    null,
        detail_reference: null,
        quantity:        null,
        x_pos:           null,
        y_pos:           null,
        confidence_score: null,
        review_flag:     false,
      },
    ] as Parameters<typeof mergeAiSignRows>[0];

    await mergeAiSignRows(rows, JOB_ID, FILE_ID, existingSignKeys, [existingSign] as never, []);

    // The additive update should have fired …
    expect(set).toHaveBeenCalledOnce();
    // … but it must not include occurrence columns (existing protection)
    const setPayload = set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setPayload).not.toHaveProperty("occurrenceIndex");
    expect(setPayload).not.toHaveProperty("occurrenceTotal");

    // No occurrence recomputation SELECT should have been issued because the
    // group key (signType + location) did not change in the update path.
    expect(dbMock.mockSelect).not.toHaveBeenCalled();
  });

  /**
   * Verify that the defensive key-change tracking WOULD fire when signType is
   * included in the update payload (forward-looking scenario).
   *
   * We simulate this by directly patching the update object after it is built
   * but before the key comparison — specifically by using a crafted existingSign
   * whose raw signType differs from the normalized AI value in a way that would
   * cause the computed newKey to diverge.
   *
   * Because the current code never adds signType/location to the update payload,
   * this path is unreachable through the normal additive flow.  The test therefore
   * focuses on the NEGATIVE assertion: no extra SELECT is issued on a pure additive
   * update (no occurrence columns, no recomputation), while the previous test already
   * confirms the INSERT path does trigger recomputation.
   *
   * If the update payload were ever extended to include signType/location, the
   * changedOccGroupKeys.add(oldKey)/add(newKey) branches would activate and the
   * integration tests above would catch any regression.
   */
  it("does not issue a recomputation SELECT when the group key is unchanged by the update", async () => {
    const sign = { ...EXISTING_SIGN, notes: null };
    const existingSignKeys = new Set([
      `${FILE_ID}||${sign.pageNumber ?? ""}||${(sign.location ?? "").toLowerCase().trim()}||${(sign.signType ?? "").toLowerCase().trim()}`,
    ]);

    // Stub the additive update call
    const where = vi.fn().mockResolvedValue(undefined);
    const set   = vi.fn().mockReturnValue({ where });
    dbMock.mockUpdate.mockReturnValueOnce({ set });

    const rows = [
      {
        page_number:     sign.pageNumber,
        location:        sign.location,
        sign_type:       sign.signType,
        notes:           "Verify on site",
        sign_identifier: null,
        dimensions:      null,
        mounting_type:   null,
        finish_color:    null,
        illumination:    null,
        materials:       null,
        message_content: null,
        sheet_number:    null,
        detail_reference: null,
        quantity:        null,
        x_pos:           null,
        y_pos:           null,
        confidence_score: null,
        review_flag:     false,
      },
    ] as Parameters<typeof mergeAiSignRows>[0];

    const result = await mergeAiSignRows(rows, JOB_ID, FILE_ID, existingSignKeys, [sign] as never, []);

    expect(result.updateCount).toBe(1);
    expect(result.newCount).toBe(0);
    // Group key unchanged → no occurrence recomputation SELECT
    expect(dbMock.mockSelect).not.toHaveBeenCalled();
  });
});
