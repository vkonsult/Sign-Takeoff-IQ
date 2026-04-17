import { describe, it, expect, vi, beforeEach } from "vitest";
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
});
