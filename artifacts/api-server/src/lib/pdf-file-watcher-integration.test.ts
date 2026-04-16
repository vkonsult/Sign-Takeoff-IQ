/**
 * Integration tests for pdf-file-watcher.ts that exercise the REAL in-memory
 * caches from pdf-words.ts.
 *
 * Unlike the unit tests (pdf-file-watcher.test.ts) which mock both `fs` and
 * `pdf-words`, these tests use:
 *   - The real `fs` module (actual disk I/O)
 *   - The real `pdf-words` cache singletons (__phraseCache / __pdfjsDocCache)
 *
 * This proves the end-to-end flow: cache populated → file replaced on disk →
 * OS delivers the watch event → caches invalidated.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import fsPromises from "fs/promises";
import os from "os";
import path from "path";

// Only mock the DB — watchPdfFile never touches it, so this avoids the need
// for a live Postgres connection during tests.
vi.mock("@workspace/db", () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockResolvedValue([]),
    }),
  },
  jobFilesTable: { id: "id", storedPath: "stored_path" },
}));

import { watchPdfFile, unwatchPdfFile } from "./pdf-file-watcher";
import { __phraseCache, __pdfjsDocCache } from "./pdf-words";
import type { PageWords, PdfPhrase } from "./pdf-words";

// ── Helper: poll until a condition is true or timeout ─────────────────────

async function waitFor(
  condition: () => boolean,
  timeoutMs = 3000,
  pollMs = 20,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise<void>((r) => setTimeout(r, pollMs));
  }
  throw new Error("waitFor: condition not met within timeout");
}

// ── Per-test temp file management ─────────────────────────────────────────

const FILE_ID = "integration-file-id-12345";
let tmpPath: string;

beforeEach(async () => {
  tmpPath = path.join(os.tmpdir(), `pdf-watcher-integ-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
  await fsPromises.writeFile(tmpPath, Buffer.from("%PDF-1.4 initial"));
});

afterEach(async () => {
  unwatchPdfFile(tmpPath);

  // Clean up any phrase cache entries seeded for this fileId
  for (const key of __phraseCache.keys()) {
    if (key.startsWith(`${FILE_ID}:`)) __phraseCache.delete(key);
  }

  // Clean up any doc cache entry for this path
  const existing = __pdfjsDocCache.get(tmpPath);
  if (existing) {
    __pdfjsDocCache.delete(tmpPath);
    existing
      .then((d) => { try { d.destroy(); } catch { /* ignore */ } })
      .catch(() => { /* ignore */ });
  }

  await fsPromises.unlink(tmpPath).catch(() => undefined);
});

// ── Tests ─────────────────────────────────────────────────────────────────

describe("pdf-file-watcher + pdf-words cache (real integration)", () => {
  it("removes phrase cache entries when the watched file is overwritten on disk", async () => {
    const phrase: PdfPhrase = { text: "STALE DATA", x0: 0, y0: 0, x1: 1, y1: 1 };
    const fakePage: PageWords = { pageWidth: 100, pageHeight: 100, phrases: [phrase] };
    __phraseCache.set(`${FILE_ID}:1`, fakePage);
    __phraseCache.set(`${FILE_ID}:2`, fakePage);

    expect(__phraseCache.has(`${FILE_ID}:1`)).toBe(true);
    expect(__phraseCache.has(`${FILE_ID}:2`)).toBe(true);

    watchPdfFile(tmpPath, FILE_ID);

    // Overwrite the file — triggers a "change" event in fs.watch
    await fsPromises.writeFile(tmpPath, Buffer.from("%PDF-1.4 replaced content"));

    // Wait for the OS event to fire and for invalidatePdfCaches to clear the cache
    await waitFor(() => !__phraseCache.has(`${FILE_ID}:1`));

    expect(__phraseCache.has(`${FILE_ID}:1`)).toBe(false);
    expect(__phraseCache.has(`${FILE_ID}:2`)).toBe(false);
  });

  it("removes the pdfjsDocCache entry for the watched path when the file is overwritten", async () => {
    // Seed the doc cache with a fake resolved promise
    const fakeDestroy = vi.fn();
    const fakeDoc = { numPages: 1, getPage: vi.fn(), destroy: fakeDestroy };
    __pdfjsDocCache.set(tmpPath, Promise.resolve(fakeDoc as never));

    expect(__pdfjsDocCache.has(tmpPath)).toBe(true);

    watchPdfFile(tmpPath, FILE_ID);

    await fsPromises.writeFile(tmpPath, Buffer.from("%PDF-1.4 replaced content v2"));

    await waitFor(() => !__pdfjsDocCache.has(tmpPath));

    expect(__pdfjsDocCache.has(tmpPath)).toBe(false);
  });

  it("uses the updated fileId when invalidating after a fileId re-registration", async () => {
    const OLD_FILE_ID = "integration-old-file-id";
    const NEW_FILE_ID = "integration-new-file-id";

    const fakePage: PageWords = { pageWidth: 100, pageHeight: 100, phrases: [] };
    __phraseCache.set(`${OLD_FILE_ID}:1`, fakePage);
    __phraseCache.set(`${NEW_FILE_ID}:1`, fakePage);

    watchPdfFile(tmpPath, OLD_FILE_ID);
    // Re-register with a new fileId (simulates a future "replace file" endpoint)
    watchPdfFile(tmpPath, NEW_FILE_ID);

    await fsPromises.writeFile(tmpPath, Buffer.from("%PDF-1.4 re-registered"));

    // The NEW fileId's cache entries should be cleared; old ones should remain
    await waitFor(() => !__phraseCache.has(`${NEW_FILE_ID}:1`));

    expect(__phraseCache.has(`${NEW_FILE_ID}:1`)).toBe(false);
    // OLD_FILE_ID entries are NOT touched (they belong to a different file record)
    expect(__phraseCache.has(`${OLD_FILE_ID}:1`)).toBe(true);

    // Cleanup
    __phraseCache.delete(`${OLD_FILE_ID}:1`);
  });
});
