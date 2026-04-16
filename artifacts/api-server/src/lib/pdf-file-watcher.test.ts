import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FSWatcher } from "fs";
import type EventEmitter from "events";

// ── Mocks ─────────────────────────────────────────────────────────────────

// We capture the watch callback so tests can trigger it manually.
type WatchListener = (event: string, filename: string | null) => void;
const watchListeners = new Map<string, WatchListener>();
const mockWatcherInstances = new Map<
  string,
  { close: ReturnType<typeof vi.fn>; errorListeners: Array<(err: Error) => void> }
>();

vi.mock("fs", () => {
  return {
    default: {
      watch: vi.fn((filePath: string, listener: WatchListener) => {
        watchListeners.set(filePath, listener);
        const instance = {
          close: vi.fn(),
          errorListeners: [] as Array<(err: Error) => void>,
          on(event: string, cb: (err: Error) => void) {
            if (event === "error") this.errorListeners.push(cb);
            return this;
          },
        };
        mockWatcherInstances.set(filePath, instance);
        return instance as unknown as FSWatcher & EventEmitter;
      }),
    },
  };
});

vi.mock("./pdf-words", () => ({
  invalidatePdfCaches: vi.fn(),
}));

vi.mock("@workspace/db", () => ({
  db: { select: vi.fn() },
  jobFilesTable: {},
}));

import { invalidatePdfCaches } from "./pdf-words";
import {
  watchPdfFile,
  unwatchPdfFile,
  unwatchAllPdfFiles,
  __watchers,
} from "./pdf-file-watcher";

const mockInvalidate = vi.mocked(invalidatePdfCaches);

// ── Helpers ───────────────────────────────────────────────────────────────

function triggerWatchEvent(pdfPath: string, eventType: "change" | "rename") {
  const listener = watchListeners.get(pdfPath);
  if (!listener) throw new Error(`No watcher registered for ${pdfPath}`);
  listener(eventType, pdfPath);
}

// ── Setup / Teardown ──────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  watchListeners.clear();
  mockWatcherInstances.clear();
  // Clean up any watchers left from previous tests
  unwatchAllPdfFiles();
});

afterEach(() => {
  unwatchAllPdfFiles();
});

// ── Tests ─────────────────────────────────────────────────────────────────

describe("watchPdfFile", () => {
  it("calls invalidatePdfCaches when a 'change' event fires for the watched path", () => {
    const pdfPath = "/uploads/jobs/42/file.pdf";
    const fileId = "file-abc-123";

    watchPdfFile(pdfPath, fileId);
    triggerWatchEvent(pdfPath, "change");

    expect(mockInvalidate).toHaveBeenCalledOnce();
    expect(mockInvalidate).toHaveBeenCalledWith(pdfPath, fileId);
  });

  it("calls invalidatePdfCaches when a 'rename' event fires for the watched path", () => {
    const pdfPath = "/uploads/jobs/42/replaced.pdf";
    const fileId = "file-rename-456";

    watchPdfFile(pdfPath, fileId);
    triggerWatchEvent(pdfPath, "rename");

    expect(mockInvalidate).toHaveBeenCalledOnce();
    expect(mockInvalidate).toHaveBeenCalledWith(pdfPath, fileId);
  });

  it("does NOT call invalidatePdfCaches for unrelated events", () => {
    const pdfPath = "/uploads/jobs/42/other.pdf";
    const fileId = "file-other-789";

    watchPdfFile(pdfPath, fileId);

    const listener = watchListeners.get(pdfPath)!;
    listener("close", null);

    expect(mockInvalidate).not.toHaveBeenCalled();
  });

  it("registers the watcher in the internal registry", () => {
    const pdfPath = "/uploads/jobs/99/doc.pdf";
    watchPdfFile(pdfPath, "file-999");

    expect(__watchers.has(pdfPath)).toBe(true);
  });

  it("reuses the existing OS watcher but updates fileId when called again for the same path", async () => {
    const { default: fs } = await import("fs");
    const pdfPath = "/uploads/jobs/42/idempotent.pdf";

    watchPdfFile(pdfPath, "file-old");
    watchPdfFile(pdfPath, "file-new");

    // fs.watch called exactly once — the OS watcher is reused
    expect(vi.mocked(fs.watch)).toHaveBeenCalledTimes(1);

    // The updated fileId is used when the event fires
    triggerWatchEvent(pdfPath, "change");
    expect(mockInvalidate).toHaveBeenCalledWith(pdfPath, "file-new");
  });

  it("each distinct path gets its own watcher", async () => {
    const { default: fs } = await import("fs");
    const pathA = "/uploads/jobs/1/a.pdf";
    const pathB = "/uploads/jobs/2/b.pdf";

    watchPdfFile(pathA, "file-a");
    watchPdfFile(pathB, "file-b");

    expect(vi.mocked(fs.watch)).toHaveBeenCalledTimes(2);
  });

  it("uses the updated fileId (not the original one) when invalidating", () => {
    const pdfPath = "/uploads/jobs/42/fileid-update.pdf";

    watchPdfFile(pdfPath, "file-original");
    watchPdfFile(pdfPath, "file-updated");

    triggerWatchEvent(pdfPath, "change");

    expect(mockInvalidate).toHaveBeenCalledWith(pdfPath, "file-updated");
    expect(mockInvalidate).not.toHaveBeenCalledWith(pdfPath, "file-original");
  });
});

describe("unwatchPdfFile", () => {
  it("closes the watcher and removes it from the registry", () => {
    const pdfPath = "/uploads/jobs/55/close-me.pdf";
    watchPdfFile(pdfPath, "file-close-1");

    expect(__watchers.has(pdfPath)).toBe(true);
    unwatchPdfFile(pdfPath);
    expect(__watchers.has(pdfPath)).toBe(false);

    const instance = mockWatcherInstances.get(pdfPath);
    expect(instance?.close).toHaveBeenCalledOnce();
  });

  it("is safe to call for a path that was never watched", () => {
    expect(() => unwatchPdfFile("/not/watched.pdf")).not.toThrow();
  });

  it("does not call invalidatePdfCaches after being unwatched", () => {
    const pdfPath = "/uploads/jobs/55/no-more.pdf";
    watchPdfFile(pdfPath, "file-no-more");
    unwatchPdfFile(pdfPath);

    const listener = watchListeners.get(pdfPath)!;
    listener("change", pdfPath);

    expect(mockInvalidate).not.toHaveBeenCalled();
  });
});

describe("watcher error handling", () => {
  it("removes the registry entry when the FSWatcher emits an error", () => {
    const pdfPath = "/uploads/jobs/77/error.pdf";
    watchPdfFile(pdfPath, "file-err");

    expect(__watchers.has(pdfPath)).toBe(true);

    const instance = mockWatcherInstances.get(pdfPath)!;
    for (const cb of instance.errorListeners) {
      cb(new Error("ENOENT: file deleted"));
    }

    expect(__watchers.has(pdfPath)).toBe(false);
  });
});
