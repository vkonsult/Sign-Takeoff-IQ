import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("fs/promises", () => ({
  default: {
    readFile: vi.fn(),
  },
}));

vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  getDocument: vi.fn(() => ({
    promise: Promise.resolve({
      numPages: 1,
      destroy: vi.fn(),
      getPage: vi.fn(),
    }),
  })),
  GlobalWorkerOptions: { workerSrc: "" },
}));

import fs from "fs/promises";
import { getOrOpenPdfjsDoc } from "./pdf-words";

const mockReadFile = vi.mocked(fs.readFile);

beforeEach(() => {
  mockReadFile.mockReset();
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
