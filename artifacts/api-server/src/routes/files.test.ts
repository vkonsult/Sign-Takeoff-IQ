import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import os from "os";
import path from "path";
import fsSync from "fs";

// ── Mocks ────────────────────────────────────────────────────────────────────
// vi.mock() calls are hoisted before imports; factory fns run at hoist time.

vi.mock("@workspace/db", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
  jobFilesTable: {},
  jobsTable: {},
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(),
}));

vi.mock("../lib/pdf-words", () => ({
  invalidatePdfCaches: vi.fn(),
}));

vi.mock("../lib/pdf-file-watcher", () => ({
  watchPdfFile: vi.fn(),
}));

// Import after mocks are declared so they receive the mocked versions.
import { db } from "@workspace/db";
import { invalidatePdfCaches } from "../lib/pdf-words";
import { watchPdfFile } from "../lib/pdf-file-watcher";
import filesRouter from "./files";

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildApp(authUser?: object) {
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as Record<string, unknown>).authUser = authUser ?? {
      userId: "admin-user",
      role: "ADMIN",
      organizationId: "org-123",
      isSuperAdmin: false,
      userName: "Admin User",
      userInitials: "AU",
    };
    (req as unknown as Record<string, unknown>).log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    next();
  });
  app.use(filesRouter);
  return app;
}

function mockDbSelect(rows: unknown[]) {
  const chain = {
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(rows),
  };
  vi.mocked(db.select).mockReturnValue(chain as never);
}

// Pre-create a real temp file that can be used as storedPath so that
// fs.copyFile succeeds without hitting a missing directory.
const storedPath = path.join(os.tmpdir(), "sign-takeoff-test-replace-target.pdf");
fsSync.writeFileSync(storedPath, Buffer.from("%PDF-1.4 original"));

// ── Tests ────────────────────────────────────────────────────────────────────

describe("PATCH /files/:fileId/replace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("replaces the file, invalidates cache, and re-registers watcher on happy path", async () => {
    const fileRecord = {
      id: "file-abc",
      storedPath,
      originalName: "original.pdf",
      jobId: "job-1",
      organizationId: "org-123",
    };
    mockDbSelect([fileRecord]);

    const app = buildApp();
    const res = await request(app)
      .patch("/files/file-abc/replace")
      .attach("file", Buffer.from("%PDF-1.4 replacement"), {
        filename: "replacement.pdf",
        contentType: "application/pdf",
      });

    expect(res.status).toBe(200);
    expect(res.body.fileId).toBe("file-abc");
    expect(res.body.jobId).toBe("job-1");
    expect(res.body.message).toMatch(/replaced successfully/i);
    expect(invalidatePdfCaches).toHaveBeenCalledWith(storedPath, "file-abc");
    expect(watchPdfFile).toHaveBeenCalledWith(storedPath, "file-abc");
  });

  it("returns 400 when no file is attached", async () => {
    const app = buildApp();
    const res = await request(app).patch("/files/file-abc/replace");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no pdf file/i);
  });

  it("returns 400 when an invalid file type is uploaded", async () => {
    const app = buildApp();
    const res = await request(app)
      .patch("/files/file-abc/replace")
      .attach("file", Buffer.from("not a pdf"), {
        filename: "malware.exe",
        contentType: "application/octet-stream",
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/only pdf/i);
  });

  it("returns 404 when the file record does not exist in the database", async () => {
    mockDbSelect([]);

    const app = buildApp();
    const res = await request(app)
      .patch("/files/nonexistent/replace")
      .attach("file", Buffer.from("%PDF-1.4 data"), {
        filename: "replacement.pdf",
        contentType: "application/pdf",
      });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("File not found");
  });

  it("returns 403 when the caller belongs to a different organization", async () => {
    mockDbSelect([{
      id: "file-abc",
      storedPath,
      originalName: "original.pdf",
      jobId: "job-1",
      organizationId: "org-other",
    }]);

    const app = buildApp({
      userId: "admin-user",
      role: "ADMIN",
      organizationId: "org-123",
      isSuperAdmin: false,
      userName: "Admin User",
      userInitials: "AU",
    });
    const res = await request(app)
      .patch("/files/file-abc/replace")
      .attach("file", Buffer.from("%PDF-1.4 data"), {
        filename: "replacement.pdf",
        contentType: "application/pdf",
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/different organization/i);
  });

  it("allows a super admin to replace a file from any organization", async () => {
    mockDbSelect([{
      id: "file-abc",
      storedPath,
      originalName: "original.pdf",
      jobId: "job-1",
      organizationId: "org-other",
    }]);

    const app = buildApp({
      userId: "super-admin",
      role: "SUPER_ADMIN",
      organizationId: null,
      isSuperAdmin: true,
      userName: "Super Admin",
      userInitials: "SA",
    });
    const res = await request(app)
      .patch("/files/file-abc/replace")
      .attach("file", Buffer.from("%PDF-1.4 data"), {
        filename: "replacement.pdf",
        contentType: "application/pdf",
      });

    expect(res.status).toBe(200);
    expect(invalidatePdfCaches).toHaveBeenCalled();
    expect(watchPdfFile).toHaveBeenCalled();
  });
});
