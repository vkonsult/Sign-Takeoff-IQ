import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import express from "express";
import request from "supertest";

const SUPER_ADMIN_USER = {
  userId: "user-super",
  role: "SUPER_ADMIN" as const,
  organizationId: null,
  isSuperAdmin: true,
  userName: "Super Admin",
  userInitials: "SA",
};

const ADMIN_USER = {
  userId: "user-admin",
  role: "ADMIN" as const,
  organizationId: "org-uuid-1",
  isSuperAdmin: false,
  userName: "Admin User",
  userInitials: "AU",
};

const SAMPLE_JOB_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

// Valid RFC 4122 v4 UUIDs for query-param tests that go through Zod validation
const VALID_ORG_JOB_ID = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
const FOREIGN_JOB_ID = "b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22";

const SAMPLE_ROW = {
  id: "row-uuid-1",
  jobId: SAMPLE_JOB_ID,
  pageNumber: 2,
  callType: "bbox_detection",
  prompt: "Detect bounding boxes on this floor plan page.",
  responseJson: { boxes: [{ x: 10, y: 20, w: 50, h: 30 }] },
  inputTokens: 150,
  outputTokens: 80,
  durationMs: 320,
  createdAt: new Date("2025-01-01T00:00:00Z"),
};

const SAMPLE_JOB = { id: SAMPLE_JOB_ID, name: "Acme HQ Signage" };

/**
 * Each Drizzle query in the route is one of two shapes:
 *  - Full:  db.select().from().where().orderBy().limit().offset()  → Promise<row[]>
 *  - Short: db.select().from().where()                             → Promise<row[]>
 *
 * We model these with two separate factory functions that each push one
 * mockReturnValueOnce call onto the shared mockSelect spy.
 */
const dbMock = vi.hoisted(() => {
  const mockSelect = vi.fn();
  return { mockSelect };
});

vi.mock("@workspace/db", () => ({
  db: { select: dbMock.mockSelect },
  aiCallLogsTable: { _brand: "aiCallLogsTable" },
  jobsTable: { _brand: "jobsTable" },
  activityLogsTable: { _brand: "activityLogsTable" },
  organizationsTable: { _brand: "organizationsTable" },
}));

vi.mock("drizzle-orm", () => ({
  desc: vi.fn((col) => ({ desc: col })),
  eq: vi.fn((col, val) => ({ eq: [col, val] })),
  and: vi.fn((...conds) => ({ and: conds })),
  gte: vi.fn(),
  lte: vi.fn(),
  inArray: vi.fn((col, vals) => ({ inArray: [col, vals] })),
  like: vi.fn(),
}));

import activityRouter from "./activity";
import { eq, inArray } from "drizzle-orm";

/**
 * Sets up one mocked query that chains:
 *   db.select().from().where().orderBy().limit().offset() → resolved with `rows`
 */
function setupFullQuery(rows: unknown[]) {
  const offset = vi.fn().mockResolvedValue(rows);
  const limit = vi.fn().mockReturnValue({ offset });
  const orderBy = vi.fn().mockReturnValue({ limit });
  const where = vi.fn().mockReturnValue({ orderBy });
  const from = vi.fn().mockReturnValue({ where });
  dbMock.mockSelect.mockReturnValueOnce({ from });
}

/**
 * Sets up one mocked query that chains:
 *   db.select().from().where() → resolved with `rows`
 *
 * This is used for sub-queries that don't paginate (e.g. org job IDs lookup,
 * job name enrichment lookup).
 */
function setupShortQuery(rows: unknown[]) {
  const where = vi.fn().mockResolvedValue(rows);
  const from = vi.fn().mockReturnValue({ where });
  dbMock.mockSelect.mockReturnValueOnce({ from });
}

function buildApp(authUser: typeof SUPER_ADMIN_USER | typeof ADMIN_USER) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.authUser = authUser;
    (req as express.Request & { log: unknown }).log = {
      error: vi.fn(),
      warn: vi.fn(),
    };
    next();
  });
  app.use("/", activityRouter);
  return app;
}

describe("GET /activity/ai-calls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 403 for non-admin users", async () => {
    const nonAdmin = { ...ADMIN_USER, role: "SALES" as const, isSuperAdmin: false };
    const app = buildApp(nonAdmin);
    const res = await request(app).get("/activity/ai-calls");
    expect(res.status).toBe(403);
  });

  it("returns aiCalls array, limit, and offset for super admin", async () => {
    setupFullQuery([SAMPLE_ROW]);
    setupShortQuery([SAMPLE_JOB]);

    const app = buildApp(SUPER_ADMIN_USER);
    const res = await request(app).get("/activity/ai-calls");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ limit: 50, offset: 0 });
    expect(Array.isArray(res.body.aiCalls)).toBe(true);
  });

  it("enriches each row with jobName", async () => {
    setupFullQuery([SAMPLE_ROW]);
    setupShortQuery([SAMPLE_JOB]);

    const app = buildApp(SUPER_ADMIN_USER);
    const res = await request(app).get("/activity/ai-calls");

    expect(res.status).toBe(200);
    expect(res.body.aiCalls[0].jobName).toBe("Acme HQ Signage");
  });

  it("returns prompt and responseJson fields on each log row", async () => {
    setupFullQuery([SAMPLE_ROW]);
    setupShortQuery([SAMPLE_JOB]);

    const app = buildApp(SUPER_ADMIN_USER);
    const res = await request(app).get("/activity/ai-calls");

    expect(res.status).toBe(200);
    const [first] = res.body.aiCalls;
    expect(first.prompt).toBe("Detect bounding boxes on this floor plan page.");
    expect(first.responseJson).toEqual({ boxes: [{ x: 10, y: 20, w: 50, h: 30 }] });
  });

  it("returns token counts, durationMs, and callType fields", async () => {
    setupFullQuery([SAMPLE_ROW]);
    setupShortQuery([SAMPLE_JOB]);

    const app = buildApp(SUPER_ADMIN_USER);
    const res = await request(app).get("/activity/ai-calls");

    const [first] = res.body.aiCalls;
    expect(first.inputTokens).toBe(150);
    expect(first.outputTokens).toBe(80);
    expect(first.durationMs).toBe(320);
    expect(first.callType).toBe("bbox_detection");
  });

  it("respects limit and offset query params", async () => {
    setupFullQuery([]);

    const app = buildApp(SUPER_ADMIN_USER);
    const res = await request(app).get("/activity/ai-calls?limit=10&offset=20");

    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(10);
    expect(res.body.offset).toBe(20);
    expect(res.body.aiCalls).toEqual([]);
  });

  it("returns 400 for invalid query params", async () => {
    const app = buildApp(SUPER_ADMIN_USER);
    const res = await request(app).get("/activity/ai-calls?limit=notanumber");
    expect(res.status).toBe(400);
  });

  it("returns empty aiCalls array when org admin has no jobs", async () => {
    setupShortQuery([]);

    const app = buildApp(ADMIN_USER);
    const res = await request(app).get("/activity/ai-calls");

    expect(res.status).toBe(200);
    expect(res.body.aiCalls).toEqual([]);
  });

  it("returns scoped aiCalls for org admin with jobs (inArray branch)", async () => {
    // 1st query: org job IDs lookup
    setupShortQuery([{ id: SAMPLE_JOB_ID }]);
    // 2nd query: paginated ai-call rows
    setupFullQuery([SAMPLE_ROW]);
    // 3rd query: job name enrichment
    setupShortQuery([SAMPLE_JOB]);

    const app = buildApp(ADMIN_USER);
    const res = await request(app).get("/activity/ai-calls");

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.aiCalls)).toBe(true);
    expect(res.body.aiCalls).toHaveLength(1);
    // The route makes two inArray calls:
    //   [0] inArray(aiCallLogsTable.jobId, orgJobIdSet)  — org scoping (must come first)
    //   [1] inArray(jobsTable.id, jobIds)                — job name enrichment
    // Table column refs resolve to undefined in the mock, so we inspect the
    // second argument (the values array) of the FIRST call to confirm that
    // org-scoping specifically used the org's job ID set.
    const inArrayCalls = (inArray as Mock).mock.calls;
    expect(inArrayCalls).toHaveLength(2);
    const [, orgScopeVals] = inArrayCalls[0] as [unknown, string[]];
    expect(Array.isArray(orgScopeVals)).toBe(true);
    expect(orgScopeVals).toContain(SAMPLE_JOB_ID);
  });

  it("applies ?jobId= filter via eq on aiCallLogsTable.jobId", async () => {
    // 1st query: org job IDs lookup (VALID_ORG_JOB_ID belongs to this org)
    setupShortQuery([{ id: VALID_ORG_JOB_ID }]);
    // 2nd query: paginated ai-call rows
    setupFullQuery([SAMPLE_ROW]);
    // 3rd query: job name enrichment
    setupShortQuery([SAMPLE_JOB]);

    const app = buildApp(ADMIN_USER);
    const res = await request(app).get(`/activity/ai-calls?jobId=${VALID_ORG_JOB_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.aiCalls).toHaveLength(1);
    // eq was called with the jobId filter value as its second argument
    const eqCalls = (eq as Mock).mock.calls;
    expect(
      eqCalls.some(([, val]: [unknown, unknown]) => val === VALID_ORG_JOB_ID)
    ).toBe(true);
  });

  it("applies ?page= filter via eq on aiCallLogsTable.pageNumber", async () => {
    // 1st query: org job IDs lookup
    setupShortQuery([{ id: SAMPLE_JOB_ID }]);
    // 2nd query: paginated ai-call rows (row on page 2)
    setupFullQuery([SAMPLE_ROW]);
    // 3rd query: job name enrichment
    setupShortQuery([SAMPLE_JOB]);

    const app = buildApp(ADMIN_USER);
    const res = await request(app).get("/activity/ai-calls?page=2");

    expect(res.status).toBe(200);
    expect(res.body.aiCalls).toHaveLength(1);
    // eq was called with the numeric page value as its second argument
    const eqCalls = (eq as Mock).mock.calls;
    expect(
      eqCalls.some(([, val]: [unknown, unknown]) => val === 2)
    ).toBe(true);
  });

  it("returns 403 when org admin queries a jobId belonging to a different org", async () => {
    // org jobs lookup returns VALID_ORG_JOB_ID — FOREIGN_JOB_ID is absent
    setupShortQuery([{ id: VALID_ORG_JOB_ID }]);

    const app = buildApp(ADMIN_USER);
    const res = await request(app).get(`/activity/ai-calls?jobId=${FOREIGN_JOB_ID}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/does not belong/i);
  });
});
