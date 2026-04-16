import { vi, describe, it, expect, beforeEach } from "vitest";
import path from "path";

vi.mock("./logger", () => ({
  logger: {
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }),
  },
}));

const mockWriteFile = vi.fn().mockResolvedValue(undefined);
const mockReadFile = vi.fn().mockResolvedValue(Buffer.from("fake-pdf-bytes"));
const mockMkdir = vi.fn().mockResolvedValue(undefined);
const mockAccess = vi.fn();

vi.mock("fs/promises", () => ({
  default: {
    mkdir: (...args: unknown[]) => mockMkdir(...args),
    access: (...args: unknown[]) => mockAccess(...args),
    readFile: (...args: unknown[]) => mockReadFile(...args),
    writeFile: (...args: unknown[]) => mockWriteFile(...args),
  },
}));

const mockEncode = vi.fn().mockResolvedValue(Buffer.from("fake-png-bytes"));
const mockGetContext = vi.fn().mockReturnValue({});
const mockCreateCanvas = vi.fn().mockReturnValue({
  getContext: mockGetContext,
  encode: mockEncode,
});

vi.mock("@napi-rs/canvas", () => ({
  createCanvas: (...args: unknown[]) => mockCreateCanvas(...args),
}));

const mockRenderPromise = vi.fn().mockReturnValue({ promise: Promise.resolve() });
const mockGetViewport = vi.fn().mockReturnValue({ width: 850.5, height: 1100.3 });
const mockGetPage = vi.fn().mockResolvedValue({
  getViewport: mockGetViewport,
  render: mockRenderPromise,
});
const mockDestroy = vi.fn();
const mockDocumentPromise = vi.fn().mockResolvedValue({
  numPages: 3,
  getPage: mockGetPage,
  destroy: mockDestroy,
});
const mockGetDocument = vi.fn().mockReturnValue({
  promise: mockDocumentPromise(),
});

vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  getDocument: (...args: unknown[]) => mockGetDocument(...args),
}));

import { renderFloorPlanPages } from "./pdf-render";

describe("renderFloorPlanPages — empty input", () => {
  it("returns an empty map when pageNums is empty without doing any I/O", async () => {
    const result = await renderFloorPlanPages("/tmp/test.pdf", [], "/tmp/output");
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
    expect(mockMkdir).not.toHaveBeenCalled();
    expect(mockReadFile).not.toHaveBeenCalled();
  });
});

describe("renderFloorPlanPages — caching behaviour", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMkdir.mockResolvedValue(undefined);
    mockGetDocument.mockReturnValue({ promise: mockDocumentPromise() });
    mockEncode.mockResolvedValue(Buffer.from("fake-png-bytes"));
    mockGetContext.mockReturnValue({});
    mockCreateCanvas.mockReturnValue({ getContext: mockGetContext, encode: mockEncode });
    mockGetViewport.mockReturnValue({ width: 850.5, height: 1100.3 });
    mockRenderPromise.mockReturnValue({ promise: Promise.resolve() });
    mockGetPage.mockResolvedValue({ getViewport: mockGetViewport, render: mockRenderPromise });
  });

  it("skips rendering a page whose PNG already exists in outputDir", async () => {
    mockAccess.mockResolvedValue(undefined);
    mockReadFile.mockResolvedValue(Buffer.from("pdf-bytes"));

    const result = await renderFloorPlanPages("/tmp/test.pdf", [1], "/tmp/output");

    expect(mockReadFile).not.toHaveBeenCalled();
    expect(mockCreateCanvas).not.toHaveBeenCalled();
    expect(result.size).toBe(1);
    expect(result.get(1)).toBe(path.join("/tmp/output", "page-1.png"));
  });

  it("renders a page that is not yet cached", async () => {
    mockAccess.mockRejectedValue(new Error("not found"));
    mockReadFile.mockResolvedValue(Buffer.from("pdf-bytes"));
    mockDocumentPromise.mockResolvedValue({
      numPages: 3,
      getPage: mockGetPage,
      destroy: mockDestroy,
    });
    mockGetDocument.mockReturnValue({ promise: mockDocumentPromise() });

    const result = await renderFloorPlanPages("/tmp/test.pdf", [2], "/tmp/output");

    expect(mockCreateCanvas).toHaveBeenCalled();
    expect(mockWriteFile).toHaveBeenCalled();
    expect(result.size).toBe(1);
    expect(result.get(2)).toBe(path.join("/tmp/output", "page-2.png"));
  });

  it("mixes cached and uncached pages — only uncached pages are re-rendered", async () => {
    mockAccess
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("not found"));

    mockReadFile.mockResolvedValue(Buffer.from("pdf-bytes"));
    mockDocumentPromise.mockResolvedValue({
      numPages: 3,
      getPage: mockGetPage,
      destroy: mockDestroy,
    });
    mockGetDocument.mockReturnValue({ promise: mockDocumentPromise() });

    const result = await renderFloorPlanPages("/tmp/test.pdf", [1, 2], "/tmp/output");

    expect(result.size).toBe(2);
    expect(result.get(1)).toBe(path.join("/tmp/output", "page-1.png"));
    expect(result.get(2)).toBe(path.join("/tmp/output", "page-2.png"));
    expect(mockCreateCanvas).toHaveBeenCalledTimes(1);
  });
});

describe("renderFloorPlanPages — canvas dimensions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMkdir.mockResolvedValue(undefined);
    mockAccess.mockRejectedValue(new Error("not found"));
    mockReadFile.mockResolvedValue(Buffer.from("pdf-bytes"));
    mockEncode.mockResolvedValue(Buffer.from("fake-png-bytes"));
    mockGetContext.mockReturnValue({});
    mockCreateCanvas.mockReturnValue({ getContext: mockGetContext, encode: mockEncode });
    mockRenderPromise.mockReturnValue({ promise: Promise.resolve() });
    mockGetPage.mockResolvedValue({ getViewport: mockGetViewport, render: mockRenderPromise });
    mockDocumentPromise.mockResolvedValue({
      numPages: 3,
      getPage: mockGetPage,
      destroy: mockDestroy,
    });
    mockGetDocument.mockReturnValue({ promise: mockDocumentPromise() });
  });

  it("creates a canvas with dimensions ceiling'd from the viewport at default scale 1.5", async () => {
    mockGetViewport.mockReturnValue({ width: 850.5, height: 1100.3 });

    await renderFloorPlanPages("/tmp/test.pdf", [1], "/tmp/output");

    expect(mockGetViewport).toHaveBeenCalledWith({ scale: 1.5 });
    const [width, height] = mockCreateCanvas.mock.calls[0] as [number, number];
    expect(width).toBe(851);
    expect(height).toBe(1101);
  });

  it("creates a canvas with dimensions ceiling'd at a custom scale", async () => {
    mockGetViewport.mockReturnValue({ width: 566.7, height: 734.1 });

    await renderFloorPlanPages("/tmp/test.pdf", [1], "/tmp/output", 2.0);

    expect(mockGetViewport).toHaveBeenCalledWith({ scale: 2.0 });
    const [width, height] = mockCreateCanvas.mock.calls[0] as [number, number];
    expect(width).toBe(567);
    expect(height).toBe(735);
  });

  it("creates a canvas with integer-exact viewport dimensions unchanged", async () => {
    mockGetViewport.mockReturnValue({ width: 816, height: 1056 });

    await renderFloorPlanPages("/tmp/test.pdf", [1], "/tmp/output");

    const [width, height] = mockCreateCanvas.mock.calls[0] as [number, number];
    expect(width).toBe(816);
    expect(height).toBe(1056);
  });
});

describe("renderFloorPlanPages — output structure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMkdir.mockResolvedValue(undefined);
    mockAccess.mockRejectedValue(new Error("not found"));
    mockReadFile.mockResolvedValue(Buffer.from("pdf-bytes"));
    mockEncode.mockResolvedValue(Buffer.from("fake-png-bytes"));
    mockGetContext.mockReturnValue({});
    mockGetViewport.mockReturnValue({ width: 800, height: 1000 });
    mockCreateCanvas.mockReturnValue({ getContext: mockGetContext, encode: mockEncode });
    mockRenderPromise.mockReturnValue({ promise: Promise.resolve() });
    mockGetPage.mockResolvedValue({ getViewport: mockGetViewport, render: mockRenderPromise });
    mockDocumentPromise.mockResolvedValue({
      numPages: 5,
      getPage: mockGetPage,
      destroy: mockDestroy,
    });
    mockGetDocument.mockReturnValue({ promise: mockDocumentPromise() });
  });

  it("returns a Map keyed by 1-indexed page number", async () => {
    const result = await renderFloorPlanPages("/tmp/test.pdf", [1, 3], "/tmp/output");

    expect(result).toBeInstanceOf(Map);
    expect(result.has(1)).toBe(true);
    expect(result.has(3)).toBe(true);
    expect(result.has(2)).toBe(false);
  });

  it("output file paths follow the page-{n}.png naming convention", async () => {
    const result = await renderFloorPlanPages("/tmp/test.pdf", [2], "/tmp/output");

    expect(result.get(2)).toBe(path.join("/tmp/output", "page-2.png"));
  });

  it("writes PNG bytes returned from canvas.encode to the output path", async () => {
    await renderFloorPlanPages("/tmp/test.pdf", [1], "/tmp/output");

    expect(mockWriteFile).toHaveBeenCalledWith(
      path.join("/tmp/output", "page-1.png"),
      expect.any(Buffer),
    );
  });

  it("skips out-of-range page numbers silently", async () => {
    mockDocumentPromise.mockResolvedValue({
      numPages: 2,
      getPage: mockGetPage,
      destroy: mockDestroy,
    });
    mockGetDocument.mockReturnValue({ promise: mockDocumentPromise() });

    const result = await renderFloorPlanPages("/tmp/test.pdf", [5], "/tmp/output");

    expect(mockCreateCanvas).not.toHaveBeenCalled();
    expect(result.size).toBe(0);
  });

  it("calls doc.destroy after rendering even when all pages are in range", async () => {
    await renderFloorPlanPages("/tmp/test.pdf", [1], "/tmp/output");

    expect(mockDestroy).toHaveBeenCalled();
  });

  it("creates outputDir before rendering", async () => {
    await renderFloorPlanPages("/tmp/test.pdf", [1], "/tmp/output");

    expect(mockMkdir).toHaveBeenCalledWith("/tmp/output", { recursive: true });
  });
});
