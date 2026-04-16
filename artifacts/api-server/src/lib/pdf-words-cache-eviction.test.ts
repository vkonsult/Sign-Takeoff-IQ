import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks must be declared before any module is imported ─────────────────
vi.mock("node:fs/promises", () => ({
  default: {
    readFile: vi.fn().mockResolvedValue(Buffer.alloc(0)),
  },
  readFile: vi.fn().mockResolvedValue(Buffer.alloc(0)),
}));

vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => {
  const mockDestroy = vi.fn();
  const makeDoc = () => ({
    getPage: vi.fn().mockResolvedValue({
      getViewport: () => ({ width: 800, height: 600 }),
      getTextContent: vi.fn().mockResolvedValue({ items: [] }),
    }),
    destroy: mockDestroy,
  });

  return {
    getDocument: vi.fn().mockReturnValue({ promise: Promise.resolve(makeDoc()) }),
    GlobalWorkerOptions: { workerSrc: "" },
  };
});

import {
  getOrOpenPdfjsDoc,
  extractPagePhrases,
  __pdfjsDocCache,
  __phraseCache,
  __PDFJS_DOC_CACHE_MAX,
  __resetPdfjsLibForTesting,
} from "./pdf-words";

beforeEach(() => {
  __pdfjsDocCache.clear();
  __phraseCache.clear();
  __resetPdfjsLibForTesting();
  vi.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// pdfjsDocCache eviction
// ─────────────────────────────────────────────────────────────────────────────

describe("pdfjsDocCache eviction", () => {
  it("evicts the oldest entry when a 21st PDF path is opened", async () => {
    const destroyFn = vi.fn();

    const evictedDoc = { getPage: vi.fn(), destroy: destroyFn };
    const oldestPath = "/pdf/oldest.pdf";

    __pdfjsDocCache.set(oldestPath, Promise.resolve(evictedDoc as never));

    for (let i = 1; i < __PDFJS_DOC_CACHE_MAX; i++) {
      const mockDoc = { getPage: vi.fn(), destroy: vi.fn() };
      __pdfjsDocCache.set(`/pdf/file-${i}.pdf`, Promise.resolve(mockDoc as never));
    }

    expect(__pdfjsDocCache.size).toBe(__PDFJS_DOC_CACHE_MAX);
    expect(__pdfjsDocCache.has(oldestPath)).toBe(true);

    await getOrOpenPdfjsDoc("/pdf/new-21st.pdf");

    expect(__pdfjsDocCache.has(oldestPath)).toBe(false);
    expect(__pdfjsDocCache.size).toBe(__PDFJS_DOC_CACHE_MAX);

    await vi.waitFor(() => expect(destroyFn).toHaveBeenCalledOnce(), { timeout: 200 });
  });

  it("does not evict anything when cache has fewer than 20 entries", async () => {
    for (let i = 0; i < __PDFJS_DOC_CACHE_MAX - 1; i++) {
      const mockDoc = { getPage: vi.fn(), destroy: vi.fn() };
      __pdfjsDocCache.set(`/pdf/file-${i}.pdf`, Promise.resolve(mockDoc as never));
    }

    expect(__pdfjsDocCache.size).toBe(__PDFJS_DOC_CACHE_MAX - 1);

    await getOrOpenPdfjsDoc("/pdf/exactly-20th.pdf");

    expect(__pdfjsDocCache.size).toBe(__PDFJS_DOC_CACHE_MAX);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// phraseCache eviction
// ─────────────────────────────────────────────────────────────────────────────

describe("phraseCache eviction", () => {
  function seedPhraseCache(count: number): string {
    const oldestKey = "file-0:1";
    for (let i = 0; i < count; i++) {
      __phraseCache.set(`file-${i}:1`, {
        pageWidth: 800,
        pageHeight: 600,
        phrases: [],
      });
    }
    return oldestKey;
  }

  function seedDocCache(path: string) {
    const mockDoc = {
      getPage: vi.fn().mockResolvedValue({
        getViewport: () => ({ width: 800, height: 600 }),
        getTextContent: vi.fn().mockResolvedValue({ items: [] }),
      }),
      destroy: vi.fn(),
    };
    __pdfjsDocCache.set(path, Promise.resolve(mockDoc as never));
  }

  it("evicts the oldest phraseCache entry when a 201st fileId:page is extracted", async () => {
    const pdfPath = "/pdf/plan.pdf";
    seedDocCache(pdfPath);

    const oldestKey = seedPhraseCache(200);

    expect(__phraseCache.size).toBe(200);
    expect(__phraseCache.has(oldestKey)).toBe(true);

    await extractPagePhrases(pdfPath, "file-new", 1);

    expect(__phraseCache.has(oldestKey)).toBe(false);
    expect(__phraseCache.size).toBe(200);
    expect(__phraseCache.has("file-new:1")).toBe(true);
  });

  it("does not evict anything when phraseCache has fewer than 200 entries", async () => {
    const pdfPath = "/pdf/plan.pdf";
    seedDocCache(pdfPath);

    seedPhraseCache(199);

    expect(__phraseCache.size).toBe(199);

    await extractPagePhrases(pdfPath, "file-new", 1);

    expect(__phraseCache.size).toBe(200);
  });
});
