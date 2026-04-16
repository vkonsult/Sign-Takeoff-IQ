import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type IRouter, type Request, type Response, type NextFunction } from "express";
import supertest from "supertest";

// ── Shared mock state ─────────────────────────────────────────────────────────

const FAKE_JOB = {
  id: "job-111",
  organizationId: "org-abc",
  name: "Test Job",
};

const FAKE_FILES = [{ id: "file-1", storedPath: "/tmp/test.pdf", pageStats: null }];

const FAKE_PLAQUES = [
  {
    id: "plaque-1",
    jobId: "job-111",
    typeId: "T1",
    name: "Standard",
    braille: true,
    insert: false,
    insertSize: null,
    letterHeight: "1/2\"",
    trigger: null,
    mapsToColumn: null,
    generalNotes: null,
    rawJson: null,
    sourcePage: 3,
    createdAt: new Date(),
  },
];

const FAKE_LOADS = [
  {
    id: "load-1",
    jobId: "job-111",
    roomNum: "101",
    roomName: "Conference",
    occupantLoad: 75,
    occupancyGroup: "A-2",
    sourcePage: 5,
    createdAt: new Date(),
  },
  {
    id: "load-2",
    jobId: "job-111",
    roomNum: "102",
    roomName: "Storage",
    occupantLoad: 10,
    occupancyGroup: "S-1",
    sourcePage: 5,
    createdAt: new Date(),
  },
];

// Per-test db query result — tests override these
let jobQueryResult: unknown[] = [FAKE_JOB];
let filesQueryResult: unknown[] = FAKE_FILES;
let plaqueQueryResult: unknown[] = FAKE_PLAQUES;
let loadsQueryResult: unknown[] = FAKE_LOADS;
let signsQueryResult: unknown[] = [];

// Track which table was queried so tests can inspect behaviour
let lastQueriedTable: unknown = null;

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("@workspace/db", () => {
  const plaqueSchedulesTable = Symbol("plaqueSchedulesTable");
  const occupantLoadsTable = Symbol("occupantLoadsTable");
  const jobsTable = Symbol("jobsTable");
  const jobFilesTable = Symbol("jobFilesTable");
  const extractedSignsTable = Symbol("extractedSignsTable");
  const activityLogsTable = Symbol("activityLogsTable");
  const signTypeSpecsTable = Symbol("signTypeSpecsTable");
  const signageScheduleEntriesTable = Symbol("signageScheduleEntriesTable");
  const complianceEntriesTable = Symbol("complianceEntriesTable");
  const organizationMembershipsTable = Symbol("organizationMembershipsTable");

  const makeSelectChain = (table: unknown) => {
    lastQueriedTable = table;
    let result: unknown[];
    if (table === jobsTable) result = jobQueryResult;
    else if (table === jobFilesTable) result = filesQueryResult;
    else if (table === plaqueSchedulesTable) result = plaqueQueryResult;
    else if (table === occupantLoadsTable) result = loadsQueryResult;
    else if (table === extractedSignsTable) result = signsQueryResult;
    else result = [];

    const chain: Record<string, unknown> = {};
    const awaitable = Object.assign(Promise.resolve(result), chain);
    chain.where = vi.fn().mockReturnValue(awaitable);
    chain.limit = vi.fn().mockReturnValue(awaitable);
    return chain;
  };

  const db = {
    select: vi.fn().mockImplementation(() => ({ from: vi.fn().mockImplementation(makeSelectChain) })),
    delete: vi.fn().mockImplementation(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
    insert: vi.fn().mockImplementation(() => ({ values: vi.fn().mockResolvedValue(undefined) })),
  };

  return {
    db,
    jobsTable,
    jobFilesTable,
    extractedSignsTable,
    activityLogsTable,
    signTypeSpecsTable,
    signageScheduleEntriesTable,
    complianceEntriesTable,
    plaqueSchedulesTable,
    occupantLoadsTable,
    organizationMembershipsTable,
    eq: vi.fn((_col: unknown, _val: unknown) => "EQ_CONDITION"),
    desc: vi.fn(() => "DESC"),
    inArray: vi.fn(() => "IN_ARRAY"),
    and: vi.fn(() => "AND"),
    or: vi.fn(() => "OR"),
    ne: vi.fn(() => "NE"),
    isNull: vi.fn(() => "IS_NULL"),
    isNotNull: vi.fn(() => "IS_NOT_NULL"),
    not: vi.fn(() => "NOT"),
    sql: vi.fn(() => "SQL"),
    getTableColumns: vi.fn(() => ({})),
  };
});

vi.mock("../lib/ai-processor", () => ({
  AI_CALL_REGISTRY: {},
  runPlaqueScheduleExtraction: vi.fn().mockResolvedValue({
    plaques: [{ typeId: "T1", name: "Standard", braille: true }],
    generalNotes: null,
    sourcePage: 3,
    inputTokens: 100,
    outputTokens: 50,
    skipped: false,
    skipReason: null,
  }),
  persistPlaqueSchedule: vi.fn().mockResolvedValue(undefined),
  runOccupantLoadsExtraction: vi.fn().mockResolvedValue({
    rooms: [{ roomNum: "101", roomName: "Conference", occupantLoad: 75 }],
    sourcePages: [5],
    inputTokens: 80,
    outputTokens: 40,
    skipped: false,
    skipReason: null,
  }),
  persistOccupantLoads: vi.fn().mockResolvedValue(undefined),
  fetchOccupantLoadsForJob: vi.fn().mockResolvedValue([]),
  runProjectInfoExtraction: vi.fn().mockResolvedValue({}),
  runFloorPlanTextExtraction: vi.fn().mockResolvedValue({}),
  runBboxDetection: vi.fn().mockResolvedValue({}),
  runVisionFallback: vi.fn().mockResolvedValue({}),
  runTitleBlockVision: vi.fn().mockResolvedValue({}),
  runSignScheduleEnrich: vi.fn().mockResolvedValue({}),
}));

vi.mock("../lib/record-activity", () => ({
  recordActivity: vi.fn(),
}));

vi.mock("../lib/storage", () => ({
  getJobExportPath: vi.fn().mockReturnValue("/tmp/export.xlsx"),
  PAGES_DIR: "/tmp/pages",
}));

vi.mock("../lib/process-job", () => ({
  processJob: vi.fn().mockResolvedValue({}),
  deduplicateSignRows: vi.fn().mockReturnValue([]),
}));

vi.mock("../lib/extraction", () => ({
  extractSignsFromPdfImage: vi.fn().mockResolvedValue([]),
  extractSignsFromPdf: vi.fn().mockResolvedValue([]),
  visualLocateDoors: vi.fn().mockResolvedValue([]),
}));

vi.mock("../lib/export", () => ({
  buildExcelExport: vi.fn().mockResolvedValue(Buffer.from("")),
}));

vi.mock("../lib/pdf-words", () => ({
  extractPagePhrases: vi.fn().mockResolvedValue([]),
  matchLocationToCoords: vi.fn().mockReturnValue(null),
}));

vi.mock("../lib/rules-engine", () => ({
  applyRules: vi.fn().mockReturnValue([]),
  applyStairRules: vi.fn().mockReturnValue([]),
  applyElevatorRules: vi.fn().mockReturnValue([]),
  applyEvacMapRules: vi.fn().mockReturnValue([]),
  buildRoomInventory: vi.fn().mockReturnValue([]),
  selectRestroomVariant: vi.fn().mockReturnValue("Restroom"),
}));

vi.mock("../lib/room-inventory", () => ({
  buildRoomInventoryFromExtractedSigns: vi.fn().mockReturnValue([]),
  mergeOccupantLoads: vi.fn().mockReturnValue([]),
}));

vi.mock("@workspace/integrations-gemini-ai", () => ({
  ai: { models: {}, generateContent: vi.fn() },
}));

vi.mock("../middlewares/authMiddleware", () => ({
  requireRole: vi.fn(() => (_req: Request, _res: Response, next: NextFunction) => next()),
  requireAuth: vi.fn((_req: Request, _res: Response, next: NextFunction) => next()),
}));

vi.mock("../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../lib/seed", () => ({
  getDefaultOrgId: vi.fn().mockResolvedValue("org-abc"),
}));

vi.mock("@clerk/express", () => ({
  getAuth: vi.fn().mockReturnValue({ userId: null }),
  clerkMiddleware: vi.fn(() => (_req: Request, _res: Response, next: NextFunction) => next()),
}));

// ── App factory ───────────────────────────────────────────────────────────────

const SUPER_ADMIN_USER = {
  userId: "user-1",
  role: "SUPER_ADMIN",
  organizationId: null,
  isSuperAdmin: true,
  userName: "Test Admin",
  userInitials: "TA",
};

async function buildApp(authUser: Record<string, unknown> | null = null) {
  const { default: jobsRouter } = await import("./jobs.js") as { default: IRouter };
  const app = express();
  app.use(express.json());
  // Inject authUser so getJobWithOrgCheck sees a super-admin (bypasses org filtering)
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.authUser = authUser ?? SUPER_ADMIN_USER;
    next();
  });
  app.use(jobsRouter);
  return app;
}

/**
 * Build an app whose routes exercise the `if (!jobId)` guard (400 path).
 *
 * Express routing always extracts a non-empty segment for `:jobId`, so the
 * guard is unreachable via normal HTTP routing. We add the param interceptor
 * directly on the ROUTER (not the app) — `router.param()` runs between param
 * extraction and the route handler, letting us force an empty string into
 * `req.params.jobId` before the handler runs.
 */
async function buildEmptyJobIdApp() {
  const { default: jobsRouter } = await import("./jobs.js") as { default: IRouter };
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.authUser = SUPER_ADMIN_USER;
    next();
  });
  // Add param callback directly to the router so it fires for all routes
  // inside jobsRouter that match `:jobId`. Convert sentinel → empty string.
  // IRouter.param() runs between param extraction and route handler, letting
  // us force req.params.jobId to "" before the handler's guard check.
  jobsRouter.param("jobId", (req: Request, _res: Response, next: NextFunction, value: string) => {
    if (value === "_EMPTY_") {
      req.params.jobId = "";
    }
    next();
  });
  app.use(jobsRouter);
  return app;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /jobs/:jobId/plaque-schedule", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    jobQueryResult = [FAKE_JOB];
    plaqueQueryResult = FAKE_PLAQUES;
    app = await buildApp();
  });

  it("returns 400 when jobId is missing/empty", async () => {
    // Uses the sentinel + app.param() trick to inject an empty jobId into the handler.
    const emptyIdApp = await buildEmptyJobIdApp();
    const res = await supertest(emptyIdApp).get("/jobs/_EMPTY_/plaque-schedule");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/job id required/i);
  });

  it("returns 200 with plaques array on happy path", async () => {
    const res = await supertest(app).get("/jobs/job-111/plaque-schedule");
    expect(res.status).toBe(200);
    expect(res.body.jobId).toBe("job-111");
    expect(Array.isArray(res.body.plaques)).toBe(true);
    expect(res.body.plaques).toHaveLength(1);
    expect(res.body.plaques[0].typeId).toBe("T1");
  });

  it("returns empty plaques array when no plaque schedule exists", async () => {
    plaqueQueryResult = [];
    const res = await supertest(app).get("/jobs/job-111/plaque-schedule");
    expect(res.status).toBe(200);
    expect(res.body.plaques).toHaveLength(0);
  });

  it("returns 404 when job does not exist", async () => {
    jobQueryResult = [];
    const res = await supertest(app).get("/jobs/nonexistent-job/plaque-schedule");
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });
});

describe("GET /jobs/:jobId/occupant-loads", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    jobQueryResult = [FAKE_JOB];
    loadsQueryResult = FAKE_LOADS;
    app = await buildApp();
  });

  it("returns 400 when jobId is missing/empty", async () => {
    const emptyIdApp = await buildEmptyJobIdApp();
    const res = await supertest(emptyIdApp).get("/jobs/_EMPTY_/occupant-loads");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/job id required/i);
  });

  it("returns 200 with loads array on happy path", async () => {
    const res = await supertest(app).get("/jobs/job-111/occupant-loads");
    expect(res.status).toBe(200);
    expect(res.body.jobId).toBe("job-111");
    expect(Array.isArray(res.body.loads)).toBe(true);
    expect(res.body.loads).toHaveLength(2);
  });

  it("identifies assembly rooms (occupantLoad >= 50) correctly", async () => {
    const res = await supertest(app).get("/jobs/job-111/occupant-loads");
    expect(res.status).toBe(200);
    const assemblyRooms = res.body.assemblyRooms as Array<{ roomNumber: string }>;
    expect(Array.isArray(assemblyRooms)).toBe(true);
    // Only room 101 has occupantLoad=75 (>=50); room 102 has 10 (<50)
    expect(assemblyRooms).toHaveLength(1);
    expect(assemblyRooms[0].roomNumber).toBe("101");
  });

  it("returns empty arrays when no occupant loads exist", async () => {
    loadsQueryResult = [];
    const res = await supertest(app).get("/jobs/job-111/occupant-loads");
    expect(res.status).toBe(200);
    expect(res.body.loads).toHaveLength(0);
    expect(res.body.assemblyRooms).toHaveLength(0);
  });

  it("returns 404 when job does not exist", async () => {
    jobQueryResult = [];
    const res = await supertest(app).get("/jobs/nonexistent-job/occupant-loads");
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });
});

describe("POST /jobs/:jobId/extract-plaque-schedule", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    jobQueryResult = [FAKE_JOB];
    filesQueryResult = FAKE_FILES;
    app = await buildApp();
  });

  it("returns 400 when jobId is missing/empty", async () => {
    const emptyIdApp = await buildEmptyJobIdApp();
    const res = await supertest(emptyIdApp).post("/jobs/_EMPTY_/extract-plaque-schedule");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/job id required/i);
  });

  it("returns 200 with success and plaque count on happy path", async () => {
    const res = await supertest(app).post("/jobs/job-111/extract-plaque-schedule");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.jobId).toBe("job-111");
    expect(typeof res.body.totalPlaques).toBe("number");
    expect(res.body.totalPlaques).toBeGreaterThanOrEqual(0);
  });

  it("calls persistPlaqueSchedule to save extracted data", async () => {
    const { persistPlaqueSchedule } = await import("../lib/ai-processor");
    await supertest(app).post("/jobs/job-111/extract-plaque-schedule");
    expect(persistPlaqueSchedule).toHaveBeenCalledOnce();
    const [callJobId, callPlaques] = (persistPlaqueSchedule as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
    expect(callJobId).toBe("job-111");
    expect(Array.isArray(callPlaques)).toBe(true);
  });

  it("returns 404 when no files exist for the job", async () => {
    filesQueryResult = [];
    const res = await supertest(app).post("/jobs/job-111/extract-plaque-schedule");
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/no files/i);
  });

  it("returns 404 when job does not exist", async () => {
    jobQueryResult = [];
    const res = await supertest(app).post("/jobs/nonexistent-job/extract-plaque-schedule");
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });
});

describe("POST /jobs/:jobId/extract-occupant-loads", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    jobQueryResult = [FAKE_JOB];
    filesQueryResult = FAKE_FILES;
    signsQueryResult = [];
    app = await buildApp();
  });

  it("returns 400 when jobId is missing/empty", async () => {
    const emptyIdApp = await buildEmptyJobIdApp();
    const res = await supertest(emptyIdApp).post("/jobs/_EMPTY_/extract-occupant-loads");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/job id required/i);
  });

  it("returns 200 with success and room count on happy path", async () => {
    const res = await supertest(app).post("/jobs/job-111/extract-occupant-loads");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.jobId).toBe("job-111");
    expect(typeof res.body.totalRooms).toBe("number");
  });

  it("calls persistOccupantLoads to save extracted data", async () => {
    const { persistOccupantLoads } = await import("../lib/ai-processor");
    await supertest(app).post("/jobs/job-111/extract-occupant-loads");
    expect(persistOccupantLoads).toHaveBeenCalledOnce();
    expect(persistOccupantLoads).toHaveBeenCalledWith(
      "job-111",
      expect.any(Array),
      expect.anything(),
    );
  });

  it("includes assemblyRooms in response", async () => {
    const res = await supertest(app).post("/jobs/job-111/extract-occupant-loads");
    expect(res.status).toBe(200);
    expect(typeof res.body.assemblyRoomCount).toBe("number");
    expect(Array.isArray(res.body.assemblyRooms)).toBe(true);
  });

  it("returns 404 when no files exist for the job", async () => {
    filesQueryResult = [];
    const res = await supertest(app).post("/jobs/job-111/extract-occupant-loads");
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/no files/i);
  });

  it("returns 404 when job does not exist", async () => {
    jobQueryResult = [];
    const res = await supertest(app).post("/jobs/nonexistent-job/extract-occupant-loads");
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });
});
