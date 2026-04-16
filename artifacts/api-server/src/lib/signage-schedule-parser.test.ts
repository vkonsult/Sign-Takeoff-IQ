import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { extractSignageData, phrasesToRawItems } from "./signage-schedule-parser";
import type { RawTextItem } from "./signage-schedule-parser";
import type { PdfPhrase } from "./pdf-words";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a minimal RawTextItem at a given position. */
function item(text: string, x: number, y: number, w = 40, h = 10): RawTextItem {
  return { text, x, y, w, h };
}

/**
 * Build a "row" of items all on the same y-line (same y baseline).
 * Each cell is placed 60pt to the right of the previous one.
 */
function row(texts: string[], y: number, startX = 10, cellW = 50): RawTextItem[] {
  return texts.map((t, i) => item(t, startX + i * cellW, y, cellW, 10));
}

const PAGE_W = 612;
const PAGE_H = 792;

// ── phrasesToRawItems ─────────────────────────────────────────────────────────

describe("phrasesToRawItems", () => {
  it("converts normalized [0,1] coords to viewport pts", () => {
    const phrases = [
      { text: "HELLO", x0: 0.1, y0: 0.2, x1: 0.3, y1: 0.3 },
    ] as Parameters<typeof phrasesToRawItems>[0];

    const [result] = phrasesToRawItems(phrases, PAGE_W, PAGE_H);

    expect(result!.text).toBe("HELLO");
    expect(result!.x).toBeCloseTo(0.1 * PAGE_W);
    expect(result!.y).toBeCloseTo(0.2 * PAGE_H);
    expect(result!.w).toBeCloseTo((0.3 - 0.1) * PAGE_W);
    expect(result!.h).toBeCloseTo((0.3 - 0.2) * PAGE_H);
  });

  it("converts multiple phrases preserving order", () => {
    const phrases = [
      { text: "A", x0: 0.0, y0: 0.0, x1: 0.1, y1: 0.1 },
      { text: "B", x0: 0.5, y0: 0.5, x1: 0.6, y1: 0.6 },
    ] as Parameters<typeof phrasesToRawItems>[0];

    const result = phrasesToRawItems(phrases, 100, 200);
    expect(result).toHaveLength(2);
    expect(result[0]!.text).toBe("A");
    expect(result[1]!.text).toBe("B");
  });

  it("returns empty array for empty input", () => {
    expect(phrasesToRawItems([], PAGE_W, PAGE_H)).toEqual([]);
  });

  it("swaps inverted x coordinates so w is always non-negative", () => {
    const phrases = [
      { text: "RTL", x0: 0.4, y0: 0.1, x1: 0.2, y1: 0.2 },
    ] as Parameters<typeof phrasesToRawItems>[0];

    const [result] = phrasesToRawItems(phrases, PAGE_W, PAGE_H);

    expect(result!.x).toBeCloseTo(0.2 * PAGE_W);
    expect(result!.w).toBeCloseTo((0.4 - 0.2) * PAGE_W);
    expect(result!.w).toBeGreaterThan(0);
  });

  it("swaps inverted y coordinates so h is always non-negative", () => {
    const phrases = [
      { text: "FLIP", x0: 0.1, y0: 0.5, x1: 0.3, y1: 0.2 },
    ] as Parameters<typeof phrasesToRawItems>[0];

    const [result] = phrasesToRawItems(phrases, PAGE_W, PAGE_H);

    expect(result!.y).toBeCloseTo(0.2 * PAGE_H);
    expect(result!.h).toBeCloseTo((0.5 - 0.2) * PAGE_H);
    expect(result!.h).toBeGreaterThan(0);
  });

  it("clamps coordinates that exceed [0, 1] before scaling", () => {
    const phrases = [
      { text: "OVERFLOW", x0: -0.1, y0: -0.05, x1: 1.2, y1: 1.1 },
    ] as Parameters<typeof phrasesToRawItems>[0];

    const [result] = phrasesToRawItems(phrases, PAGE_W, PAGE_H);

    expect(result!.x).toBe(0);
    expect(result!.y).toBe(0);
    expect(result!.w).toBeCloseTo(PAGE_W);
    expect(result!.h).toBeCloseTo(PAGE_H);
  });

  it("clamps and swaps when coordinates are both inverted and out of range", () => {
    const phrases = [
      { text: "BAD", x0: 1.5, y0: 0.8, x1: -0.2, y1: 0.3 },
    ] as Parameters<typeof phrasesToRawItems>[0];

    const [result] = phrasesToRawItems(phrases, PAGE_W, PAGE_H);

    expect(result!.x).toBe(0);
    expect(result!.w).toBeCloseTo(PAGE_W);
    expect(result!.y).toBeCloseTo(0.3 * PAGE_H);
    expect(result!.h).toBeCloseTo((0.8 - 0.3) * PAGE_H);
    expect(result!.w).toBeGreaterThan(0);
    expect(result!.h).toBeGreaterThan(0);
  });
});

// ── extractSignageData — empty / trivial inputs ───────────────────────────────

describe("extractSignageData — empty input", () => {
  it("returns empty specs and entries for no items", () => {
    const result = extractSignageData([], 1, PAGE_W, PAGE_H);
    expect(result.specs).toHaveLength(0);
    expect(result.entries).toHaveLength(0);
  });

  it("returns empty results when no recognised sections are present", () => {
    const items = [
      item("GENERAL NOTES", 10, 10),
      item("See sheet A-001 for details.", 10, 30),
    ];
    const result = extractSignageData(items, 1, PAGE_W, PAGE_H);
    expect(result.specs).toHaveLength(0);
    expect(result.entries).toHaveLength(0);
  });
});

// ── extractSignageData — schedule section ─────────────────────────────────────

describe("extractSignageData — schedule section: room headings", () => {
  function scheduleItems(extraItems: RawTextItem[]): RawTextItem[] {
    return [
      ...row(["SIGNAGE SCHEDULE"], 10),
      ...extraItems,
    ];
  }

  it("parses a bare room number heading", () => {
    const items = scheduleItems([
      ...row(["101"], 40),
      ...row(["1A", "1", "EXIT"], 60),
    ]);
    const { entries } = extractSignageData(items, 1, PAGE_W, PAGE_H);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.roomNumber).toBe("101");
  });

  it("parses a room number with name", () => {
    const items = scheduleItems([
      ...row(["A-101", "LOBBY"], 40),
      ...row(["2", "1", "WELCOME"], 60),
    ]);
    const { entries } = extractSignageData(items, 1, PAGE_W, PAGE_H);
    expect(entries[0]!.roomNumber).toBe("A-101");
  });

  it("parses UNIT keyword room heading", () => {
    const items = scheduleItems([
      ...row(["UNIT", "1C", "Main Entry"], 40),
      ...row(["3", "1", "LOBBY"], 60),
    ]);
    const { entries } = extractSignageData(items, 1, PAGE_W, PAGE_H);
    expect(entries[0]!.roomNumber).toBe("1C");
    expect(entries[0]!.roomName).toContain("UNIT");
  });

  it("parses SUITE keyword room heading", () => {
    const items = scheduleItems([
      ...row(["SUITE", "200", "Conference"], 40),
      ...row(["1A", "2", "CONF ROOM"], 60),
    ]);
    const { entries } = extractSignageData(items, 1, PAGE_W, PAGE_H);
    expect(entries[0]!.roomNumber).toBe("200");
  });

  it("does not confuse a sign row as a room heading (sign-code + qty pattern)", () => {
    // Line: "1A  2  ENTRY TEXT" — sign row, not a heading
    const items = scheduleItems([
      ...row(["101"], 30),
      ...row(["1A", "2", "ENTRY TEXT"], 50),
    ]);
    const { entries } = extractSignageData(items, 1, PAGE_W, PAGE_H);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.signTypeCode).toBe("1A");
  });

  it("carries forward room heading to subsequent sign rows", () => {
    const items = scheduleItems([
      ...row(["B202"], 40),
      ...row(["1A", "1", "CORRIDOR"], 60),
      ...row(["2B", "1", "MAIN SIGN"], 80),
    ]);
    const { entries } = extractSignageData(items, 1, PAGE_W, PAGE_H);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.roomNumber).toBe("B202");
    expect(entries[1]!.roomNumber).toBe("B202");
  });

  it("resets room context when a new heading is encountered", () => {
    const items = scheduleItems([
      ...row(["101"], 30),
      ...row(["1A", "1", "SIGN A"], 50),
      ...row(["102"], 80),
      ...row(["2", "1", "SIGN B"], 100),
    ]);
    const { entries } = extractSignageData(items, 1, PAGE_W, PAGE_H);
    expect(entries[0]!.roomNumber).toBe("101");
    expect(entries[1]!.roomNumber).toBe("102");
  });
});

// ── extractSignageData — sign row parsing ─────────────────────────────────────

describe("extractSignageData — sign row parsing", () => {
  function pageWithSchedule(signRows: RawTextItem[][]): RawTextItem[] {
    return [
      ...row(["SIGNAGE SCHEDULE"], 10),
      ...row(["101"], 30),
      ...signRows.flat(),
    ];
  }

  it("parses a sign row with code, quantity, and text", () => {
    const items = pageWithSchedule([row(["1A", "3", "ROOM ID"], 50)]);
    const { entries } = extractSignageData(items, 1, PAGE_W, PAGE_H);
    expect(entries).toHaveLength(1);
    const e = entries[0]!;
    expect(e.signTypeCode).toBe("1A");
    expect(e.quantity).toBe(3);
    expect(e.signageText).toBe("ROOM ID");
  });

  it("parses glass backer Yes token", () => {
    const items = pageWithSchedule([row(["1A", "1", "LABEL", "Yes"], 50)]);
    const { entries } = extractSignageData(items, 1, PAGE_W, PAGE_H);
    expect(entries[0]!.glassBacker).toBe(true);
    expect(entries[0]!.signageText).toBe("LABEL");
  });

  it("parses glass backer No token", () => {
    const items = pageWithSchedule([row(["1A", "1", "LABEL", "No"], 50)]);
    const { entries } = extractSignageData(items, 1, PAGE_W, PAGE_H);
    expect(entries[0]!.glassBacker).toBe(false);
  });

  it("captures comment codes at end of a sign row", () => {
    const items = pageWithSchedule([row(["1A", "1", "SIGNAGE TEXT", "A,B"], 50)]);
    const { entries } = extractSignageData(items, 1, PAGE_W, PAGE_H);
    expect(entries[0]!.rawComments).toBe("A,B");
  });

  it("uppercases the sign type code", () => {
    const items = pageWithSchedule([row(["1a", "1", "LABEL"], 50)]);
    const { entries } = extractSignageData(items, 1, PAGE_W, PAGE_H);
    expect(entries[0]!.signTypeCode).toBe("1A");
  });

  it("treats a two-token line starting with a sign code (and no qty) as a room heading, not a sign row", () => {
    // The parser checks room headings before sign rows.  "1A ROOM TEXT" is
    // ambiguous; without a qty token the parser resolves it as a heading.
    const items = pageWithSchedule([row(["1A", "ROOM TEXT"], 50)]);
    const { entries } = extractSignageData(items, 1, PAGE_W, PAGE_H);
    // No sign row entry is created; the line was consumed as a room heading
    expect(entries).toHaveLength(0);
  });

  it("sets pageNumber from the pageNum argument", () => {
    const items = pageWithSchedule([row(["1A", "1", "TEST"], 50)]);
    const { entries } = extractSignageData(items, 5, PAGE_W, PAGE_H);
    expect(entries[0]!.pageNumber).toBe(5);
  });

  it("sets sourceTableName from the schedule header text", () => {
    const items = [
      ...row(["LEVEL 1 SIGNAGE SCHEDULE"], 10),
      ...row(["101"], 30),
      ...row(["1A", "1", "ENTRY"], 50),
    ];
    const { entries } = extractSignageData(items, 1, PAGE_W, PAGE_H);
    expect(entries[0]!.sourceTableName).toContain("LEVEL 1 SIGNAGE SCHEDULE");
  });

  it("ignores lines that don't match a sign code pattern", () => {
    const items = pageWithSchedule([
      row(["SIGN TYPE", "QTY", "MESSAGE"], 50),
      row(["1A", "1", "REAL SIGN"], 70),
    ]);
    const { entries } = extractSignageData(items, 1, PAGE_W, PAGE_H);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.signTypeCode).toBe("1A");
  });
});

// ── extractSignageData — sign type legend ─────────────────────────────────────

describe("extractSignageData — sign type legend", () => {
  function buildPage(legendRows: RawTextItem[][]): RawTextItem[] {
    return [
      ...row(["SIGN TYPE LEGEND"], 10),
      ...legendRows.flat(),
    ];
  }

  it("parses a legend row with type code, dimensions, and material", () => {
    const items = buildPage([
      row(['1A', '6"', 'x', '8"', 'Acrylic'], 40),
    ]);
    const { specs } = extractSignageData(items, 1, PAGE_W, PAGE_H);
    expect(specs).toHaveLength(1);
    const s = specs[0]!;
    expect(s.typeCode).toBe("1A");
    expect(s.dimensions).not.toBeNull();
    expect(s.material).toBe("Acrylic");
  });

  it("parses features after material", () => {
    const items = buildPage([
      row(['2B', '4"', 'x', '6"', 'Metal', 'Braille', 'Tactile'], 40),
    ]);
    const { specs } = extractSignageData(items, 1, PAGE_W, PAGE_H);
    expect(specs[0]!.features).toContain("Braille");
    expect(specs[0]!.features).toContain("Tactile");
  });

  it("stores multiple legend entries independently", () => {
    const items = buildPage([
      row(['1A', '6"', 'x', '8"', 'Acrylic'], 40),
      row(['2B', '4"', 'x', '6"', 'Metal'], 60),
    ]);
    const { specs } = extractSignageData(items, 1, PAGE_W, PAGE_H);
    expect(specs).toHaveLength(2);
    const codes = specs.map((s) => s.typeCode).sort();
    expect(codes).toEqual(["1A", "2B"]);
  });

  it("uppercases type code from legend", () => {
    const items = buildPage([row(['3a', 'Vinyl'], 40)]);
    const { specs } = extractSignageData(items, 1, PAGE_W, PAGE_H);
    expect(specs[0]!.typeCode).toBe("3A");
  });

  it("attaches spec dimensions/material to matching schedule entries", () => {
    const items = [
      ...row(["SIGN TYPE LEGEND"], 10),
      ...row(['1A', '6"', 'x', '8"', 'Acrylic'], 30),
      ...row(["SIGNAGE SCHEDULE"], 60),
      ...row(["101"], 80),
      ...row(["1A", "1", "ROOM ID"], 100),
    ];
    const { entries } = extractSignageData(items, 1, PAGE_W, PAGE_H);
    expect(entries[0]!.material).toBe("Acrylic");
    expect(entries[0]!.dimensions).not.toBeNull();
  });

  it("initialises hasDrawing to false for legend-only specs", () => {
    const items = buildPage([row(['1A', 'Acrylic'], 40)]);
    const { specs } = extractSignageData(items, 1, PAGE_W, PAGE_H);
    expect(specs[0]!.hasDrawing).toBe(false);
  });
});

// ── extractSignageData — keynote legend ──────────────────────────────────────

describe("extractSignageData — keynote legend", () => {
  it("parses a keynote row into the keynote map attached to specs", () => {
    // Include a sign type legend so specs are emitted and keynoteMap is populated
    const items = [
      ...row(["SIGN TYPE LEGEND"], 10),
      ...row(["1A", "Acrylic"], 30),
      ...row(["SIGNAGE SCHEDULE"], 60),
      ...row(["101"], 80),
      ...row(["1A", "1", "LABEL"], 100),
      ...row(["KEYNOTES"], 200),
      ...row(["A", "Verify dimensions in field"], 220),
    ];
    const { specs } = extractSignageData(items, 1, PAGE_W, PAGE_H);
    expect(specs).toHaveLength(1);
    expect(specs[0]!.keynoteMap["A"]).toBe("Verify dimensions in field");
  });

  it("expands rawComments codes into expandedComments via keynote lookup", () => {
    const items = [
      ...row(["SIGNAGE SCHEDULE"], 10),
      ...row(["101"], 30),
      ...row(["1A", "1", "LABEL", "A"], 50),
      ...row(["SIGN KEYNOTES"], 200),
      ...row(["A", "Verify dimensions in field"], 220),
    ];
    const { entries } = extractSignageData(items, 1, PAGE_W, PAGE_H);
    expect(entries[0]!.expandedComments).toBe("Verify dimensions in field");
  });

  it("expands multiple keynote codes separated by comma", () => {
    const items = [
      ...row(["SIGNAGE SCHEDULE"], 10),
      ...row(["101"], 30),
      ...row(["1A", "1", "LABEL", "Yes", "A,B"], 50),
      ...row(["KEYNOTES"], 200),
      ...row(["A", "Coordinate with owner"], 220),
      ...row(["B", "Verify ADA compliance"], 240),
    ];
    const { entries } = extractSignageData(items, 1, PAGE_W, PAGE_H);
    const exp = entries[0]!.expandedComments ?? "";
    expect(exp).toContain("Coordinate with owner");
    expect(exp).toContain("Verify ADA compliance");
  });

  it("attaches keynoteMap to specs parsed on the same page", () => {
    const items = [
      ...row(["SIGN TYPE LEGEND"], 10),
      ...row(["1A", "Acrylic"], 30),
      ...row(["SIGN KEYNOTES"], 100),
      ...row(["A", "Field verify"], 120),
    ];
    const { specs } = extractSignageData(items, 1, PAGE_W, PAGE_H);
    expect(specs[0]!.keynoteMap["A"]).toBe("Field verify");
  });
});

// ── extractSignageData — deduplication across columns ─────────────────────────

describe("extractSignageData — spec deduplication in multi-column layout", () => {
  /**
   * Simulate a two-column layout by placing two independent sets of items
   * side by side with a large horizontal gap (>8% of page width = >49pt on 612pt page).
   * We place col2 starting at x=400 so the gap from col1 (ending ~x=110) is >8%.
   */
  function twoColumnItems(
    col1Items: RawTextItem[],
    col2Items: RawTextItem[],
  ): RawTextItem[] {
    // Shift col2 items to the right
    const shifted = col2Items.map((it) => ({ ...it, x: it.x + 400 }));
    return [...col1Items, ...shifted];
  }

  it("merges duplicate specs from two columns without duplication", () => {
    const col1 = [
      ...row(["SIGN TYPE LEGEND"], 10),
      ...row(["1A", "Acrylic"], 30),
      ...row(["SIGNAGE SCHEDULE"], 60),
      ...row(["101"], 80),
      ...row(["1A", "1", "ROOM ID"], 100),
    ];
    const col2 = [
      ...row(["SIGN TYPE LEGEND"], 10),
      ...row(["1A", "Acrylic"], 30),
      ...row(["SIGNAGE SCHEDULE"], 60),
      ...row(["102"], 80),
      ...row(["1A", "2", "ANOTHER ROOM"], 100),
    ];

    const items = twoColumnItems(col1, col2);
    const { specs, entries } = extractSignageData(items, 1, PAGE_W, PAGE_H);

    // Should only have one spec for "1A"
    const specsFor1A = specs.filter((s) => s.typeCode === "1A");
    expect(specsFor1A).toHaveLength(1);

    // Should have entries from both columns
    expect(entries).toHaveLength(2);
  });

  it("enriches existing spec with dimensions from second column", () => {
    // Col1 has spec without dimensions; col2 has same spec with dimensions
    const col1 = [
      ...row(["SIGN TYPE LEGEND"], 10),
      ...row(["1A", "Acrylic"], 30),
    ];
    const col2 = [
      ...row(["SIGN TYPE LEGEND"], 10),
      ...row(['1A', '6"', 'x', '8"', 'Acrylic'], 30),
    ];

    const items = twoColumnItems(col1, col2);
    const { specs } = extractSignageData(items, 1, PAGE_W, PAGE_H);
    const spec = specs.find((s) => s.typeCode === "1A");
    expect(spec).toBeDefined();
    // The spec from col2 has dimensions; both material and dimensions should be merged in
    expect(spec!.material).toBe("Acrylic");
    expect(spec!.dimensions).not.toBeNull();
  });
});

// ── extractSignageData — spatial grouping edge cases ─────────────────────────

describe("extractSignageData — spatial grouping", () => {
  it("items within 3pt y-distance are grouped into the same line", () => {
    // Two items at y=50 and y=52 (within 3pt center-to-center) should be one line / one row
    const items = [
      ...row(["SIGNAGE SCHEDULE"], 10),
      ...row(["101"], 30),
      item("1A", 10, 50, 30, 10),  // center y = 55
      item("1",  50, 52, 30, 10),  // center y = 57 — diff = 2pt, same line
      item("LABEL", 90, 51, 60, 10), // center y = 56 — same line
    ];
    const { entries } = extractSignageData(items, 1, PAGE_W, PAGE_H);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.signTypeCode).toBe("1A");
    expect(entries[0]!.quantity).toBe(1);
  });

  it("items more than 3pt apart in y form separate lines", () => {
    const items = [
      ...row(["SIGNAGE SCHEDULE"], 10),
      ...row(["101"], 30),
      item("1A", 10, 50, 30, 10),  // center 55
      item("1",  50, 70, 30, 10),  // center 75 — diff = 20pt → different line
      item("SIGN B", 10, 70, 60, 10),
    ];
    // "1A" alone on its line has no qty — skipped (< 2 tokens with code + qty)
    // "1 SIGN B" line: "1" doesn't match SIGN_TYPE_CODE_RE → skipped
    const { entries } = extractSignageData(items, 1, PAGE_W, PAGE_H);
    expect(entries).toHaveLength(0);
  });
});

// ── extractSignageData — post-processing: backfill entries from later legend ──

describe("extractSignageData — post-processing backfill", () => {
  it("backfills dimensions/material from a legend that appears after the schedule", () => {
    const items = [
      ...row(["SIGNAGE SCHEDULE"], 10),
      ...row(["101"], 30),
      ...row(["1A", "1", "ENTRY SIGN"], 50),
      // Legend appears AFTER schedule entries on the page
      ...row(["SIGN TYPE LEGEND"], 120),
      ...row(['1A', '6"', 'x', '8"', 'Aluminum'], 140),
    ];
    const { entries } = extractSignageData(items, 1, PAGE_W, PAGE_H);
    expect(entries[0]!.material).toBe("Aluminum");
    expect(entries[0]!.dimensions).not.toBeNull();
  });

  it("backfills features from a legend that appears after the schedule", () => {
    const items = [
      ...row(["SIGNAGE SCHEDULE"], 10),
      ...row(["101"], 30),
      ...row(["1A", "1", "ENTRY"], 50),
      ...row(["SIGN TYPE LEGEND"], 120),
      ...row(['1A', '6"', 'x', '8"', 'Acrylic', 'Tactile', 'Braille'], 140),
    ];
    const { entries } = extractSignageData(items, 1, PAGE_W, PAGE_H);
    expect(entries[0]!.features).toContain("Tactile");
    expect(entries[0]!.features).toContain("Braille");
  });
});

// ── extractSignageData — header detection variants ───────────────────────────

describe("extractSignageData — section header detection", () => {
  it("recognises 'sign schedule' (lower-case) as a schedule header", () => {
    const items = [
      ...row(["sign schedule"], 10),
      ...row(["101"], 30),
      ...row(["1A", "1", "ENTRY"], 50),
    ];
    const { entries } = extractSignageData(items, 1, PAGE_W, PAGE_H);
    expect(entries).toHaveLength(1);
  });

  it("recognises 'SIGN TYPES' as a type legend header", () => {
    const items = [
      ...row(["SIGN TYPES"], 10),
      ...row(["1A", "Acrylic"], 30),
    ];
    const { specs } = extractSignageData(items, 1, PAGE_W, PAGE_H);
    expect(specs).toHaveLength(1);
    expect(specs[0]!.typeCode).toBe("1A");
  });

  it("recognises 'SIGN KEYNOTES' as a keynote legend header", () => {
    const items = [
      ...row(["SIGNAGE SCHEDULE"], 10),
      ...row(["101"], 30),
      ...row(["1A", "1", "LABEL", "A"], 50),
      ...row(["SIGN KEYNOTES"], 200),
      ...row(["A", "Coordinate with owner"], 220),
    ];
    const { entries } = extractSignageData(items, 1, PAGE_W, PAGE_H);
    expect(entries[0]!.expandedComments).toBe("Coordinate with owner");
  });
});

// ── phrasesToRawItems → extractSignageData integration ────────────────────────
//
// These tests exercise the full pipeline from raw PdfPhrase arrays (normalized
// [0,1] coords as produced by the PDF extraction layer) through
// phrasesToRawItems and into extractSignageData.  They catch regressions in the
// coordinate normalization step — for example swapping x0/x1 would place items
// at wrong horizontal positions, changing column order and producing incorrect
// sign-code / quantity / text assignments; swapping y0/y1 would distort item
// heights and top edges, potentially collapsing separate rows or misaligning the
// vertical ordering of sections.

describe("phrasesToRawItems → extractSignageData integration", () => {
  const IW = 612;
  const IH = 792;

  /** Build a single PdfPhrase from normalized [0,1] coords. */
  function phrase(text: string, x0: number, y0: number, x1: number, y1: number): PdfPhrase {
    return { text, x0, y0, x1, y1 };
  }

  /**
   * Build a row of phrases that all share the same y-band, placed side by side.
   * cellW is a fraction of page width (default 0.10 ≈ 61 pt on a 612 pt page).
   */
  function phraseRow(
    texts: string[],
    y0: number,
    y1: number,
    startX = 0.02,
    cellW = 0.10,
  ): PdfPhrase[] {
    return texts.map((text, i) =>
      phrase(text, startX + i * cellW, y0, startX + i * cellW + cellW * 0.9, y1),
    );
  }

  it("parses a minimal schedule end-to-end and returns the correct entry", () => {
    // header → room heading → sign row, all supplied as PdfPhrase normalized coords
    const phrases: PdfPhrase[] = [
      ...phraseRow(["SIGNAGE SCHEDULE"], 0.01, 0.025),
      ...phraseRow(["101"],              0.04, 0.055),
      ...phraseRow(["1A", "2", "ENTRY SIGN"], 0.07, 0.085),
    ];

    const items = phrasesToRawItems(phrases, IW, IH);
    const { entries } = extractSignageData(items, 1, IW, IH);

    expect(entries).toHaveLength(1);
    const e = entries[0]!;
    expect(e.roomNumber).toBe("101");
    expect(e.signTypeCode).toBe("1A");
    expect(e.quantity).toBe(2);
    expect(e.signageText).toBe("ENTRY SIGN");
  });

  it("assigns columns left-to-right so sign-code, qty, and text are not transposed", () => {
    // Items are spread across a wide x range with clear gaps between columns.
    // If x0/x1 were swapped in phrasesToRawItems, each item's x coordinate would
    // shift right by its own width, changing the sort order within the row and
    // causing the parser to mis-read which token is the sign code, quantity, or text.
    const phrases: PdfPhrase[] = [
      ...phraseRow(["SIGNAGE SCHEDULE"], 0.01, 0.025),
      ...phraseRow(["C303"],             0.04, 0.055),
      phrase("3C",         0.02, 0.07, 0.10, 0.085), // leftmost  → sign code
      phrase("4",          0.15, 0.07, 0.20, 0.085), // middle    → quantity
      phrase("STAIR SIGN", 0.25, 0.07, 0.55, 0.085), // rightmost → signage text
    ];

    const items = phrasesToRawItems(phrases, IW, IH);
    const { entries } = extractSignageData(items, 1, IW, IH);

    expect(entries).toHaveLength(1);
    const e = entries[0]!;
    expect(e.signTypeCode).toBe("3C");
    expect(e.quantity).toBe(4);
    expect(e.signageText).toBe("STAIR SIGN");
  });

  it("keeps rows on separate y-bands as distinct parsed lines", () => {
    // Two sign rows at y-bands 0.07 and 0.11 — far enough apart (>3 pt) to be
    // separate lines.  If y0/y1 were swapped in phrasesToRawItems the computed
    // top-edge y of every item would shift, potentially mis-ordering sections so
    // the room heading falls below the sign rows and the parser ignores them.
    const phrases: PdfPhrase[] = [
      ...phraseRow(["SIGNAGE SCHEDULE"], 0.01, 0.025),
      ...phraseRow(["B202"],             0.04, 0.055),
      ...phraseRow(["1A", "1", "CORRIDOR"],   0.07, 0.085),
      ...phraseRow(["2B", "3", "LOBBY SIGN"], 0.11, 0.125),
    ];

    const items = phrasesToRawItems(phrases, IW, IH);
    const { entries } = extractSignageData(items, 1, IW, IH);

    expect(entries).toHaveLength(2);
    expect(entries[0]!.signTypeCode).toBe("1A");
    expect(entries[1]!.signTypeCode).toBe("2B");
    // Both entries inherit the room heading from the same room section
    expect(entries[0]!.roomNumber).toBe("B202");
    expect(entries[1]!.roomNumber).toBe("B202");
  });

  it("parses a type legend end-to-end and returns the spec with dimensions", () => {
    const phrases: PdfPhrase[] = [
      ...phraseRow(["SIGN TYPE LEGEND"], 0.01, 0.025),
      phrase("2A",       0.02, 0.04, 0.10, 0.055),
      phrase('12"',      0.12, 0.04, 0.22, 0.055),
      phrase("x",        0.23, 0.04, 0.26, 0.055),
      phrase('18"',      0.27, 0.04, 0.37, 0.055),
      phrase("Aluminum", 0.38, 0.04, 0.55, 0.055),
    ];

    const items = phrasesToRawItems(phrases, IW, IH);
    const { specs } = extractSignageData(items, 1, IW, IH);

    expect(specs).toHaveLength(1);
    const s = specs[0]!;
    expect(s.typeCode).toBe("2A");
    expect(s.material).toBe("Aluminum");
    expect(s.dimensions).not.toBeNull();
  });

  it("links legend specs to schedule entries so material and dimensions are backfilled", () => {
    // Legend followed by schedule — verifies that the full pipeline preserves
    // enough spatial information for the backfill pass to match specs to entries.
    const phrases: PdfPhrase[] = [
      ...phraseRow(["SIGN TYPE LEGEND"], 0.01, 0.025),
      phrase("1A",      0.02, 0.04, 0.08, 0.055),
      phrase('6"',      0.09, 0.04, 0.17, 0.055),
      phrase("x",       0.18, 0.04, 0.21, 0.055),
      phrase('8"',      0.22, 0.04, 0.30, 0.055),
      phrase("Acrylic", 0.31, 0.04, 0.48, 0.055),
      ...phraseRow(["SIGNAGE SCHEDULE"], 0.08, 0.095),
      ...phraseRow(["101"],              0.11, 0.125),
      ...phraseRow(["1A", "1", "ROOM ID"], 0.14, 0.155),
    ];

    const items = phrasesToRawItems(phrases, IW, IH);
    const { entries, specs } = extractSignageData(items, 1, IW, IH);

    expect(specs).toHaveLength(1);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.material).toBe("Acrylic");
    expect(entries[0]!.dimensions).not.toBeNull();
  });

  it("expands keynote comments via the full phrase pipeline", () => {
    const phrases: PdfPhrase[] = [
      ...phraseRow(["SIGNAGE SCHEDULE"],       0.01, 0.025),
      ...phraseRow(["101"],                    0.04, 0.055),
      ...phraseRow(["1A", "1", "LABEL", "A"], 0.07, 0.085),
      ...phraseRow(["KEYNOTES"],               0.30, 0.315),
      ...phraseRow(["A", "Verify field dimensions"], 0.33, 0.345),
    ];

    const items = phrasesToRawItems(phrases, IW, IH);
    const { entries } = extractSignageData(items, 1, IW, IH);

    expect(entries).toHaveLength(1);
    expect(entries[0]!.expandedComments).toBe("Verify field dimensions");
  });
});

// ── Real PDF fixture — full pipeline integration ───────────────────────────────
//
// All tests above use hand-crafted coordinate arrays.  A regression in
// pdf-words.ts (e.g. a broken coordinate normalisation) that produces
// differently-shaped PdfPhrase objects would not be caught there.  This suite
// loads an actual PDF fixture file through the real pdfjs extraction layer and
// asserts on a known set of expected entries and specs so that the whole stack
// — pdfjs → extractPagePhrases → phrasesToRawItems → extractSignageData — is
// exercised in a single integration pass.

const _req = createRequire(import.meta.url);
const FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "__fixtures__",
  "sign-schedule-sample.pdf",
);
const FIXTURE_FILE_ID = "test-sign-schedule-sample";

describe("Real PDF fixture — full pipeline integration", () => {
  // extractPagePhrases lazy-loads pdfjs-dist and resolves the worker path via
  // globalThis.require (injected by the esbuild build banner in production).
  // We replicate that injection here so the same code path runs under vitest.
  beforeAll(async () => {
    (globalThis as Record<string, unknown>)["require"] = _req;
    // Reset any previously cached pdfjs instance so the worker is re-configured
    // using the require we just injected.
    const { __resetPdfjsLibForTesting } = await import("./pdf-words");
    __resetPdfjsLibForTesting();
  });

  afterAll(() => {
    delete (globalThis as Record<string, unknown>)["require"];
  });

  it("reads the fixture PDF and extracts at least one phrase per content row", async () => {
    const { extractPagePhrases } = await import("./pdf-words");
    const pageWords = await extractPagePhrases(FIXTURE_PATH, FIXTURE_FILE_ID, 1);

    // The fixture is a US Letter page
    expect(pageWords.pageWidth).toBeCloseTo(612, 0);
    expect(pageWords.pageHeight).toBeCloseTo(792, 0);
    // Fixture has 11 text items placed as separate phrases
    expect(pageWords.phrases.length).toBeGreaterThanOrEqual(9);
  });

  it("produces correct schedule entries and specs through the full pipeline", async () => {
    const { extractPagePhrases } = await import("./pdf-words");
    const { phrases, pageWidth, pageHeight } =
      await extractPagePhrases(FIXTURE_PATH, FIXTURE_FILE_ID, 1);

    const rawItems = phrasesToRawItems(phrases, pageWidth, pageHeight);
    const { entries, specs } = extractSignageData(rawItems, 1, pageWidth, pageHeight);

    // ── Schedule entry ──────────────────────────────────────────────────────
    // The fixture contains: "SIGNAGE SCHEDULE" → room "101" → sign row "1A 2 ROOM ID"
    expect(entries).toHaveLength(1);
    const e = entries[0]!;
    expect(e.signTypeCode).toBe("1A");
    expect(e.quantity).toBe(2);
    expect(e.signageText).toBe("ROOM ID");
    expect(e.roomNumber).toBe("101");
    expect(e.pageNumber).toBe(1);

    // ── Legend spec ─────────────────────────────────────────────────────────
    // The fixture contains: "SIGN TYPE LEGEND" → "1A  Acrylic"
    expect(specs).toHaveLength(1);
    const s = specs[0]!;
    expect(s.typeCode).toBe("1A");
    expect(s.material).toBe("Acrylic");

    // ── Backfill: spec material propagates to schedule entry ─────────────────
    expect(e.material).toBe("Acrylic");

    // ── Keynote map: "KEYNOTES" → "A  Field verify dimensions" ───────────────
    expect(s.keynoteMap["A"]).toBe("Field verify dimensions");
  });

  it("extractRawPageItems returns items with text and plausible viewport coordinates", async () => {
    const { extractRawPageItems } = await import("./pdf-words");
    const { items, pageWidth, pageHeight } = await extractRawPageItems(FIXTURE_PATH, 1);

    // The fixture is a US Letter page — verify dimensions are rotation-adjusted
    expect(pageWidth).toBeCloseTo(612, 0);
    expect(pageHeight).toBeCloseTo(792, 0);

    // Every item must fall within the page bounds
    for (const it of items) {
      expect(it.x).toBeGreaterThanOrEqual(0);
      expect(it.y).toBeGreaterThanOrEqual(0);
      expect(it.x + it.w).toBeLessThanOrEqual(pageWidth + 1); // +1 for floating-point tolerance
      expect(it.y + it.h).toBeLessThanOrEqual(pageHeight + 1);
      expect(it.w).toBeGreaterThan(0);
      expect(it.h).toBeGreaterThan(0);
    }

    // ── Required text items must be present ─────────────────────────────────
    const texts = items.map((it) => it.text);
    expect(texts).toContain("SIGNAGE SCHEDULE");
    expect(texts).toContain("1A");
    expect(texts).toContain("2");
    expect(texts).toContain("ROOM ID");

    // ── Vertical ordering: header above sign row ─────────────────────────────
    // "SIGNAGE SCHEDULE" must appear above the "1A" sign-code item (smaller y).
    const headerItem = items.find((it) => it.text === "SIGNAGE SCHEDULE")!;
    const signCodeItem = items.find((it) => it.text === "1A")!;
    expect(headerItem).toBeDefined();
    expect(signCodeItem).toBeDefined();
    expect(headerItem.y).toBeLessThan(signCodeItem.y);

    // ── Horizontal ordering: sign-code left of qty left of signage text ──────
    // In the sign row "1A  2  ROOM ID", the sign code must be the leftmost
    // token, quantity next, and signage text rightmost.  A broken corner
    // transformation (e.g. swapping ux/vy in the bounding-box computation)
    // would mis-place one or more items and break this ordering.
    const qtyItem = items.find((it) => it.text === "2" && it.y > headerItem.y)!;
    const textItem = items.find((it) => it.text === "ROOM ID")!;
    expect(qtyItem).toBeDefined();
    expect(textItem).toBeDefined();
    expect(signCodeItem.x).toBeLessThan(qtyItem.x);
    expect(qtyItem.x).toBeLessThan(textItem.x);
  });
});
