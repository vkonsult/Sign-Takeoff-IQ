import { vi, describe, it, expect, beforeEach } from "vitest";
import {
  classifyPageFromPhrases,
  extractRawPageItems,
  extractPagePhrases,
  sanitizePhraseCoords,
  type PdfPhrase,
} from "./pdf-words";

// ── pdfjs-dist mock ─────────────────────────────────────────────────────────
// vi.mock is hoisted so mock function variables must be declared at module scope.
const mockGetTextContent = vi.fn().mockResolvedValue({ items: [] });
const mockGetViewport = vi.fn().mockReturnValue({
  width: 100,
  height: 200,
  convertToViewportPoint: (x: number, y: number): [number, number] => [x, 200 - y],
});
const mockGetPage = vi.fn().mockResolvedValue({
  getViewport: mockGetViewport,
  getTextContent: mockGetTextContent,
});
const mockDocumentPromise = vi.fn().mockResolvedValue({
  numPages: 1,
  getPage: mockGetPage,
  destroy: vi.fn(),
});
const mockGetDocument = vi.fn().mockReturnValue({ promise: mockDocumentPromise() });

vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  getDocument: (...args: unknown[]) => mockGetDocument(...args),
}));

vi.mock("fs/promises", () => ({
  default: {
    readFile: vi.fn().mockResolvedValue(Buffer.from("fake-pdf-bytes")),
  },
}));

vi.mock("./logger", () => ({
  logger: {
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }),
  },
}));

/**
 * Helper: create a PdfPhrase centred at (cx, cy) in title-block zone.
 * Default centre (0.80, 0.80) satisfies: cx > 0.60 AND cy > 0.60.
 */
function phrase(text: string, cx = 0.80, cy = 0.80): PdfPhrase {
  const half = 0.05;
  return { text, x0: cx - half, x1: cx + half, y0: cy - half, y1: cy + half };
}

/**
 * Helper: create a PdfPhrase that is OUTSIDE the title-block zone.
 * Centre (0.30, 0.30) fails all three zone conditions.
 */
function phraseOutside(text: string): PdfPhrase {
  return phrase(text, 0.30, 0.30);
}

describe("classifyPageFromPhrases — exclusion veto scope", () => {
  it('vetos a floor plan when an exclusion word appears in any title-block phrase ("fire")', () => {
    const phrases = [
      phrase("FIRST FLOOR PLAN - OVERALL"),
      phrase("FIRE PROTECTION NOTES", 0.65, 0.65),
    ];
    const result = classifyPageFromPhrases(phrases);
    expect(result.type).toBe("unknown");
  });

  it('vetos a page when the exclusion word is inside the candidate title phrase itself', () => {
    const phrases = [
      phrase("FIRST FLOOR - REFLECTED CEILING PLAN"),
    ];
    const result = classifyPageFromPhrases(phrases);
    expect(result.type).toBe("unknown");
  });

  it('vetos when exclusion is in the same candidate phrase (multi-word exclusion: "rcp")', () => {
    const phrases = [
      phrase("SECOND FLOOR PLAN - RCP"),
    ];
    const result = classifyPageFromPhrases(phrases);
    expect(result.type).toBe("unknown");
  });

  it('vetos when "site" appears in a separate title-block phrase (task-132)', () => {
    const phrases = [
      phrase("GROUND FLOOR PLAN"),
      phrase("SEE SITE PLAN A101 FOR REFERENCE", 0.62, 0.62),
    ];
    const result = classifyPageFromPhrases(phrases);
    expect(result.type).toBe("unknown");
  });

  it('vetos when "safety" appears in a separate title-block phrase', () => {
    const phrases = [
      phrase("THIRD FLOOR PLAN"),
      phrase("LIFE SAFETY NOTES APPLY", 0.65, 0.75),
    ];
    const result = classifyPageFromPhrases(phrases);
    expect(result.type).toBe("unknown");
  });

  it('does NOT veto a pure sign_schedule page due to exclusion text (task-132)', () => {
    const phrases = [
      phrase("SIGN SCHEDULE"),
      phrase("ELECTRICAL NOTES", 0.62, 0.65),
    ];
    const result = classifyPageFromPhrases(phrases);
    expect(result.type).toBe("sign_schedule");
  });

  it('returns unknown for phrases with no inclusion keyword even with no exclusion text', () => {
    const phrases = [
      phrase("ELEVATION A-101"),
      phrase("DETAIL 3/A-201"),
    ];
    const result = classifyPageFromPhrases(phrases);
    expect(result.type).toBe("unknown");
  });

  it('returns unknown when there are no title-block-zone phrases at all', () => {
    const phrases = [
      phraseOutside("FIRST FLOOR PLAN"),
    ];
    const result = classifyPageFromPhrases(phrases);
    expect(result.type).toBe("unknown");
  });

  it('returns unknown for an empty phrase list', () => {
    expect(classifyPageFromPhrases([]).type).toBe("unknown");
  });

  it('vetos when inclusion is in one phrase and exclusion ("ceiling") is in a separate non-candidate phrase (task-132 split-title case)', () => {
    const phrases = [
      phrase("FIRST FLOOR"),
      phrase("REFLECTED CEILING PLAN", 0.65, 0.65),
    ];
    const result = classifyPageFromPhrases(phrases);
    expect(result.type).toBe("unknown");
  });

  it('vetos a "both" (floor plan + sign schedule) page when exclusion word appears in title block', () => {
    const phrases = [
      phrase("SECOND FLOOR PLAN"),
      phrase("SIGN SCHEDULE"),
      phrase("FIRE PROTECTION NOTES", 0.62, 0.62),
    ];
    const result = classifyPageFromPhrases(phrases);
    expect(result.type).toBe("unknown");
  });

  it('page 93 regression: "framing" in separate drawing-title phrase vetoes floor plan classification', () => {
    const phrases = [
      phrase("SECOND FLOOR"),
      phrase("S2.1 STAGE FRAMING PLAN", 0.70, 0.70),
    ];
    const result = classifyPageFromPhrases(phrases);
    expect(result.type).toBe("unknown");
  });

  it('titlePhrases returned are empty when the page is vetoed', () => {
    const incidental = phrase("FIRE PROTECTION NOTES", 0.62, 0.62);
    const title = phrase("SECOND FLOOR PLAN");
    const result = classifyPageFromPhrases([title, incidental]);
    expect(result.type).toBe("unknown");
    expect(result.titlePhrases).toHaveLength(0);
  });
});

// ── extractRawPageItems / extractPagePhrases ─────────────────────────────────
// These tests use a mocked pdfjs-dist document to validate coordinate mapping,
// rotation handling, phrase grouping, and cache behaviour without touching disk.

/** Build a minimal TextItem with an identity-scale transform (no rotation). */
function makeTextItem(
  str: string,
  tx: number,
  ty: number,
  width = 10,
  height = 10,
  fontSize = 1,
) {
  return {
    str,
    transform: [fontSize, 0, 0, fontSize, tx, ty] as [
      number, number, number, number, number, number,
    ],
    width,
    height,
  };
}

/**
 * Return a viewport object whose convertToViewportPoint simulates an
 * unrotated page: PDF user space has origin at bottom-left, y-up.
 * Viewport space has origin at top-left, y-down.
 */
function makeIdentityViewport(pageW: number, pageH: number) {
  return {
    width: pageW,
    height: pageH,
    convertToViewportPoint: (x: number, y: number): [number, number] => [
      x,
      pageH - y,
    ],
  };
}

// Each test must get a unique pdfPath / fileId so the module-level caches
// (pdfjsDocCache, phraseCache) do not bleed between tests.
let _testId = 0;
const uniquePath = () => `/tmp/pdf-words-test-${++_testId}.pdf`;
const uniqueFileId = () => `file-${_testId}`;

/** Wire up mock pdfjs page with the supplied text items and viewport. */
function setupDoc(
  items: ReturnType<typeof makeTextItem>[],
  pageW = 100,
  pageH = 200,
  vp = makeIdentityViewport(pageW, pageH),
) {
  mockGetViewport.mockReturnValue(vp);
  mockGetTextContent.mockResolvedValue({ items });
  mockGetPage.mockResolvedValue({
    getViewport: mockGetViewport,
    getTextContent: mockGetTextContent,
  });
  const doc = { numPages: 1, getPage: mockGetPage, destroy: vi.fn() };
  mockDocumentPromise.mockResolvedValue(doc);
  mockGetDocument.mockReturnValue({ promise: mockDocumentPromise() });
}

// ── extractRawPageItems ───────────────────────────────────────────────────────

describe("extractRawPageItems", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns empty items and correct dimensions for a blank page", async () => {
    setupDoc([], 612, 792);
    const result = await extractRawPageItems(uniquePath(), 1);
    expect(result.pageWidth).toBe(612);
    expect(result.pageHeight).toBe(792);
    expect(result.items).toHaveLength(0);
  });

  it("filters out whitespace-only items", async () => {
    setupDoc([makeTextItem("   ", 10, 100, 5, 5), makeTextItem("A", 10, 100, 5, 5)]);
    const result = await extractRawPageItems(uniquePath(), 1);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.text).toBe("A");
  });

  it("maps an axis-aligned item to the correct viewport-space bounding box", async () => {
    // Page 100 × 200.  Item at PDF (10, 50), w=20, h=10.
    // convertToViewportPoint(x,y) = [x, 200-y]
    // Corners: (10,50),(30,50),(10,60),(30,60) → vp [10,150],[30,150],[10,140],[30,140]
    // bbox: x=10, y=140, w=20, h=10
    setupDoc([makeTextItem("Hi", 10, 50, 20, 10)]);
    const result = await extractRawPageItems(uniquePath(), 1);
    const item = result.items[0]!;
    expect(item.text).toBe("Hi");
    expect(item.x).toBeCloseTo(10);
    expect(item.y).toBeCloseTo(140);
    expect(item.w).toBeCloseTo(20);
    expect(item.h).toBeCloseTo(10);
  });

  it("trims leading/trailing whitespace from item.str", async () => {
    setupDoc([makeTextItem("  Hello  ", 0, 100, 50, 10)]);
    const result = await extractRawPageItems(uniquePath(), 1);
    expect(result.items[0]!.text).toBe("Hello");
  });

  it("uses a fallback size of 8 pt when item width/height are zero", async () => {
    // zero width/height → fallback 8 used for both
    // Corners: (10,100),(18,100),(10,108),(18,108) → vp [10,100],[18,100],[10,92],[18,92]
    // w = 8, h = 8
    setupDoc([makeTextItem("X", 10, 100, 0, 0)]);
    const result = await extractRawPageItems(uniquePath(), 1);
    expect(result.items[0]!.w).toBeCloseTo(8);
    expect(result.items[0]!.h).toBeCloseTo(8);
  });

  it("ignores non-TextItem entries (TextMarkedContent lacks str/transform/width)", async () => {
    setupDoc([
      { type: "beginMarkedContent", tag: "P" } as unknown as ReturnType<typeof makeTextItem>,
      makeTextItem("Real", 0, 100, 30, 10),
    ]);
    const result = await extractRawPageItems(uniquePath(), 1);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.text).toBe("Real");
  });

  it("handles a 90° rotation simulation — swapped axes produce correct bbox", async () => {
    // Simulate 90° rotated page: (x,y) → [y, x]; viewport 200 × 100
    const swappedVp = {
      width: 200,
      height: 100,
      convertToViewportPoint: (x: number, y: number): [number, number] => [y, x],
    };
    // Item at user (5,30), w=20, h=10  → corners (5,30),(25,30),(5,40),(25,40)
    // swapped:  [30,5],[30,25],[40,5],[40,25]
    // bbox: x=30, y=5, w=10, h=20
    setupDoc([makeTextItem("R", 5, 30, 20, 10)], 200, 100, swappedVp);
    const result = await extractRawPageItems(uniquePath(), 1);
    const item = result.items[0]!;
    expect(item.x).toBeCloseTo(30);
    expect(item.y).toBeCloseTo(5);
    expect(item.w).toBeCloseTo(10);
    expect(item.h).toBeCloseTo(20);
  });
});

// ── extractPagePhrases ────────────────────────────────────────────────────────

describe("extractPagePhrases", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns empty phrases and correct dimensions for a blank page", async () => {
    setupDoc([], 612, 792);
    const result = await extractPagePhrases(uniquePath(), uniqueFileId(), 1);
    expect(result.pageWidth).toBe(612);
    expect(result.pageHeight).toBe(792);
    expect(result.phrases).toHaveLength(0);
  });

  it("normalises a single item's coordinates to [0, 1]", async () => {
    // Page 100×200.  Item PDF (10, 150), w=20, h=10.
    // vp corners: (10,50),(30,50),(10,40),(30,40) → bbox vx0=10,vx1=30,vy0=40,vy1=50
    // normalised: x0=0.1, x1=0.3, y0=0.2, y1=0.25
    setupDoc([makeTextItem("AB", 10, 150, 20, 10)]);
    const result = await extractPagePhrases(uniquePath(), uniqueFileId(), 1);
    const p = result.phrases[0]!;
    expect(p.x0).toBeCloseTo(0.1, 5);
    expect(p.x1).toBeCloseTo(0.3, 5);
    expect(p.y0).toBeCloseTo(0.2, 5);
    expect(p.y1).toBeCloseTo(0.25, 5);
  });

  it("clamps normalised coordinates to [0, 1] when item is outside page bounds", async () => {
    setupDoc([makeTextItem("Z", -10, 210, 5, 5)]);
    const p = (await extractPagePhrases(uniquePath(), uniqueFileId(), 1)).phrases[0]!;
    expect(p.x0).toBeGreaterThanOrEqual(0);
    expect(p.x1).toBeLessThanOrEqual(1);
    expect(p.y0).toBeGreaterThanOrEqual(0);
    expect(p.y1).toBeLessThanOrEqual(1);
  });

  it("merges single-character CAD glyphs on the same baseline into one phrase", async () => {
    // "U","N","I","T" each 5 pts wide and directly adjacent — gap is within merge threshold
    setupDoc([
      makeTextItem("U", 0,  100, 5, 8),
      makeTextItem("N", 5,  100, 5, 8),
      makeTextItem("I", 10, 100, 5, 8),
      makeTextItem("T", 15, 100, 5, 8),
    ]);
    const result = await extractPagePhrases(uniquePath(), uniqueFileId(), 1);
    expect(result.phrases).toHaveLength(1);
    expect(result.phrases[0]!.text).toBe("UNIT");
  });

  it("keeps two multi-character labels that are far apart as separate phrases", async () => {
    // "ROOM" at x=0–30, "NAME" at x=80–110 (gap ≫ merge threshold)
    setupDoc([
      makeTextItem("ROOM", 0,  100, 30, 8),
      makeTextItem("NAME", 80, 100, 30, 8),
    ], 200, 200);
    const result = await extractPagePhrases(uniquePath(), uniqueFileId(), 1);
    expect(result.phrases).toHaveLength(2);
    const texts = result.phrases.map((p) => p.text);
    expect(texts).toContain("ROOM");
    expect(texts).toContain("NAME");
  });

  it("inserts a space between two adjacent multi-character words when they merge", async () => {
    // "100H" (w=30) at x=0, "OFFICE" (w=40) at x=32 — gap is 2 pts which is
    // well within the merge threshold (min(30*1.2, 7.5*4) = 30).
    // Both strings have >1 char so the code always inserts a space: "100H OFFICE".
    setupDoc([
      makeTextItem("100H",   0,  100, 30, 8),
      makeTextItem("OFFICE", 32, 100, 40, 8),
    ], 200, 200);
    const result = await extractPagePhrases(uniquePath(), uniqueFileId(), 1);
    expect(result.phrases).toHaveLength(1);
    expect(result.phrases[0]!.text).toBe("100H OFFICE");
  });

  it("creates separate phrases for items on clearly different baselines", async () => {
    // PDF y=150 → vp y=50;  PDF y=100 → vp y=100.  50 pt gap > 3 pt threshold.
    setupDoc([
      makeTextItem("TOP",    10, 150, 20, 8),
      makeTextItem("BOTTOM", 10, 100, 30, 8),
    ]);
    const result = await extractPagePhrases(uniquePath(), uniqueFileId(), 1);
    expect(result.phrases).toHaveLength(2);
    const texts = result.phrases.map((p) => p.text);
    expect(texts).toContain("TOP");
    expect(texts).toContain("BOTTOM");
  });

  it("sorts phrases top-to-bottom then left-to-right in viewport space", async () => {
    // Items are supplied in a shuffled order; result must be spatially ordered.
    setupDoc([
      makeTextItem("RIGHT", 60, 150, 20, 8),   // same line as LEFT, rightward
      makeTextItem("BELOW", 10, 100, 20, 8),   // lower line (PDF y=100 → vp y=100)
      makeTextItem("LEFT",  10, 150, 20, 8),   // upper line, leftward
    ]);
    const result = await extractPagePhrases(uniquePath(), uniqueFileId(), 1);
    const texts = result.phrases.map((p) => p.text);
    // "BELOW" must come after any phrase containing "LEFT" or "RIGHT"
    const aboveIdx = texts.findIndex((t) => t.includes("LEFT") || t.includes("RIGHT"));
    const belowIdx = texts.findIndex((t) => t.includes("BELOW"));
    expect(aboveIdx).not.toBe(-1);
    expect(belowIdx).not.toBe(-1);
    expect(aboveIdx).toBeLessThan(belowIdx);
  });

  it("serves subsequent calls from cache without re-invoking pdfjs", async () => {
    setupDoc([makeTextItem("CACHED", 0, 100, 40, 8)]);
    const pdfPath = uniquePath();
    const fileId = uniqueFileId();

    const first = await extractPagePhrases(pdfPath, fileId, 1);
    mockGetPage.mockClear();
    mockGetTextContent.mockClear();

    const second = await extractPagePhrases(pdfPath, fileId, 1);

    expect(mockGetPage).not.toHaveBeenCalled();
    expect(second).toBe(first); // identical object reference
  });

  it("caches independently per fileId+page — different keys give different results", async () => {
    setupDoc([makeTextItem("PAGE1", 0, 100, 40, 8)]);
    const r1 = await extractPagePhrases(uniquePath(), uniqueFileId(), 1);

    setupDoc([makeTextItem("PAGE2", 0, 100, 40, 8)]);
    const r2 = await extractPagePhrases(uniquePath(), uniqueFileId(), 2);

    expect(r1.phrases[0]!.text).toBe("PAGE1");
    expect(r2.phrases[0]!.text).toBe("PAGE2");
  });

  it("handles a 90° rotation simulation — coordinates are correctly normalised", async () => {
    // Rotated viewport 200 × 100; (x,y) → [y, x]
    // Item at user (5, 30), w=20, h=10
    // Corners: (5,30),(25,30),(5,40),(25,40) → swapped [30,5],[30,25],[40,5],[40,25]
    // vx0=30,vx1=40,vy0=5,vy1=25
    // normalised over 200×100: x0=0.15, x1=0.2, y0=0.05, y1=0.25
    const rotatedVp = {
      width: 200,
      height: 100,
      convertToViewportPoint: (x: number, y: number): [number, number] => [y, x],
    };
    setupDoc([makeTextItem("R", 5, 30, 20, 10)], 200, 100, rotatedVp);
    const result = await extractPagePhrases(uniquePath(), uniqueFileId(), 1);
    expect(result.pageWidth).toBe(200);
    expect(result.pageHeight).toBe(100);
    const p = result.phrases[0]!;
    expect(p.x0).toBeCloseTo(0.15, 4);
    expect(p.x1).toBeCloseTo(0.2, 4);
    expect(p.y0).toBeCloseTo(0.05, 4);
    expect(p.y1).toBeCloseTo(0.25, 4);
  });

  it("does not crash for zero-dimension items — fallback keeps phrase dimensions positive", async () => {
    setupDoc([makeTextItem("X", 10, 100, 0, 0)]);
    const result = await extractPagePhrases(uniquePath(), uniqueFileId(), 1);
    expect(result.phrases).toHaveLength(1);
    const p = result.phrases[0]!;
    expect(p.x1 - p.x0).toBeGreaterThan(0);
    expect(p.y1 - p.y0).toBeGreaterThan(0);
  });

  it("filters out whitespace-only items and produces no phrase for them", async () => {
    setupDoc([
      makeTextItem("   ", 0, 100, 10, 8),
      makeTextItem("\t",  15, 100, 10, 8),
      makeTextItem("OK",  30, 100, 15, 8),
    ]);
    const result = await extractPagePhrases(uniquePath(), uniqueFileId(), 1);
    expect(result.phrases).toHaveLength(1);
    expect(result.phrases[0]!.text).toBe("OK");
  });
});

// ── sanitizePhraseCoords ──────────────────────────────────────────────────────

describe("sanitizePhraseCoords", () => {
  it("passes through already-canonical, in-range coordinates unchanged", () => {
    const r = sanitizePhraseCoords(0.1, 0.9, 0.2, 0.8);
    expect(r.x0).toBeCloseTo(0.1);
    expect(r.x1).toBeCloseTo(0.9);
    expect(r.y0).toBeCloseTo(0.2);
    expect(r.y1).toBeCloseTo(0.8);
  });

  it("swaps x0 and x1 when they are inverted", () => {
    const r = sanitizePhraseCoords(0.9, 0.1, 0.2, 0.8);
    expect(r.x0).toBeCloseTo(0.1);
    expect(r.x1).toBeCloseTo(0.9);
  });

  it("swaps y0 and y1 when they are inverted", () => {
    const r = sanitizePhraseCoords(0.1, 0.9, 0.8, 0.2);
    expect(r.y0).toBeCloseTo(0.2);
    expect(r.y1).toBeCloseTo(0.8);
  });

  it("swaps both x and y when both axes are inverted (in-range values)", () => {
    const r = sanitizePhraseCoords(0.9, 0.1, 0.8, 0.2);
    expect(r.x0).toBeCloseTo(0.1);
    expect(r.x1).toBeCloseTo(0.9);
    expect(r.y0).toBeCloseTo(0.2);
    expect(r.y1).toBeCloseTo(0.8);
  });

  it("clamps negative values to 0", () => {
    const r = sanitizePhraseCoords(-0.5, 0.5, -1, 0.5);
    expect(r.x0).toBe(0);
    expect(r.y0).toBe(0);
  });

  it("clamps values greater than 1 to 1", () => {
    const r = sanitizePhraseCoords(0.5, 1.5, 0.5, 2.0);
    expect(r.x1).toBe(1);
    expect(r.y1).toBe(1);
  });

  it("handles both inversion and out-of-range simultaneously", () => {
    const r = sanitizePhraseCoords(1.5, -0.5, 2.0, -1.0);
    expect(r.x0).toBe(0);
    expect(r.x1).toBe(1);
    expect(r.y0).toBe(0);
    expect(r.y1).toBe(1);
  });

  it("returns x0 === x1 when both raw values normalise to the same clamped value", () => {
    const r = sanitizePhraseCoords(1.2, 1.8, 0.4, 0.4);
    expect(r.x0).toBe(1);
    expect(r.x1).toBe(1);
    expect(r.y0).toBeCloseTo(0.4);
    expect(r.y1).toBeCloseTo(0.4);
  });
});
