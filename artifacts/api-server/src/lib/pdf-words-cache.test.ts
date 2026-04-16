import { vi, describe, it, expect, beforeEach } from "vitest";

const mockDestroy = vi.fn();

vi.mock("fs/promises", () => ({
  default: {
    readFile: vi.fn(),
  },
}));

vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  getDocument: vi.fn(() => ({
    promise: Promise.resolve({
      numPages: 1,
      destroy: mockDestroy,
      getPage: vi.fn(),
    }),
  })),
  GlobalWorkerOptions: { workerSrc: "" },
}));

import fs from "fs/promises";
import {
  getOrOpenPdfjsDoc,
  __pdfjsDocCache,
  __PDFJS_DOC_CACHE_MAX,
  __resetPdfjsLibForTesting,
} from "./pdf-words";

const mockReadFile = vi.mocked(fs.readFile);

beforeEach(() => {
  mockReadFile.mockReset();
  mockDestroy.mockReset();
  __pdfjsDocCache.clear();
  __resetPdfjsLibForTesting();
});

describe("getOrOpenPdfjsDoc — cache recovery on failure", () => {
  it("removes the failed cache entry so a second call can retry and succeed", async () => {
    const pdfPath = "/tmp/test-recovery.pdf";

    mockReadFile.mockRejectedValueOnce(new Error("ENOENT: no such file"));

    await expect(getOrOpenPdfjsDoc(pdfPath)).rejects.toThrow("ENOENT");

    // Allow the internal .catch() cleanup handler to run
    await Promise.resolve();

    // Second call: file is now readable — provide a minimal valid-looking buffer
    mockReadFile.mockResolvedValueOnce(Buffer.from([0x25, 0x50, 0x44, 0x46]));

    const doc = await getOrOpenPdfjsDoc(pdfPath);
    expect(doc).toBeDefined();

    // readFile must have been called twice (once for each attempt)
    expect(mockReadFile).toHaveBeenCalledTimes(2);
  });

  it("does not call readFile a second time when the first call is cached", async () => {
    const pdfPath = "/tmp/test-cache-hit.pdf";

    mockReadFile.mockResolvedValue(Buffer.from([0x25, 0x50, 0x44, 0x46]));

    await getOrOpenPdfjsDoc(pdfPath);
    await getOrOpenPdfjsDoc(pdfPath);

    // readFile should only be called once because the second call hits the cache
    expect(mockReadFile).toHaveBeenCalledTimes(1);
  });
});

describe("getOrOpenPdfjsDoc — concurrent first-touch deduplication", () => {
  it("issues only one readFile when two calls arrive simultaneously for the same path", async () => {
    const pdfPath = "/tmp/test-concurrent.pdf";

    mockReadFile.mockResolvedValue(Buffer.from([0x25, 0x50, 0x44, 0x46]));

    // Fire both calls at the same time without awaiting the first
    const [doc1, doc2] = await Promise.all([
      getOrOpenPdfjsDoc(pdfPath),
      getOrOpenPdfjsDoc(pdfPath),
    ]);

    // Both callers should receive a valid document
    expect(doc1).toBeDefined();
    expect(doc2).toBeDefined();

    // Both callers must get the exact same document object (shared promise, not two separate parses)
    expect(doc1).toBe(doc2);

    // The Promise stored in the cache means only one readFile should have been issued
    expect(mockReadFile).toHaveBeenCalledTimes(1);
  });
});

describe("getOrOpenPdfjsDoc — LRU eviction when cache is full", () => {
  it("keeps cache size at PDFJS_DOC_CACHE_MAX after opening one more than the limit", async () => {
    mockReadFile.mockResolvedValue(Buffer.from([0x25, 0x50, 0x44, 0x46]));

    const paths: string[] = [];
    for (let i = 0; i < __PDFJS_DOC_CACHE_MAX + 1; i++) {
      paths.push(`/pdf/file-${i}.pdf`);
    }

    for (const path of paths) {
      await getOrOpenPdfjsDoc(path);
    }

    expect(__pdfjsDocCache.size).toBe(__PDFJS_DOC_CACHE_MAX);
  });

  it("evicts the oldest (first-inserted) entry when the cache overflows", async () => {
    mockReadFile.mockResolvedValue(Buffer.from([0x25, 0x50, 0x44, 0x46]));

    const paths: string[] = [];
    for (let i = 0; i < __PDFJS_DOC_CACHE_MAX + 1; i++) {
      paths.push(`/pdf/file-${i}.pdf`);
    }

    const earliestPath = paths[0];
    const latestPath = paths[paths.length - 1];

    for (const path of paths) {
      await getOrOpenPdfjsDoc(path);
    }

    expect(__pdfjsDocCache.has(earliestPath)).toBe(false);
    expect(__pdfjsDocCache.has(latestPath)).toBe(true);
  });

  it("calls destroy() exactly once — on the evicted document", async () => {
    mockReadFile.mockResolvedValue(Buffer.from([0x25, 0x50, 0x44, 0x46]));

    for (let i = 0; i < __PDFJS_DOC_CACHE_MAX + 1; i++) {
      await getOrOpenPdfjsDoc(`/pdf/file-${i}.pdf`);
    }

    // Let the asynchronous destroy() call resolve
    await vi.waitFor(() => expect(mockDestroy).toHaveBeenCalledTimes(1), {
      timeout: 200,
    });
  });
});
