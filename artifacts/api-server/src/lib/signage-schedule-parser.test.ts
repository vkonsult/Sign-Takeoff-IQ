import { describe, it, expect } from "vitest";
import { extractSignageData, phrasesToRawItems } from "./signage-schedule-parser";
import type { RawTextItem } from "./signage-schedule-parser";

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
  function buildPage(keynoteRows: RawTextItem[][], signRows: RawTextItem[][]): RawTextItem[] {
    return [
      ...row(["SIGNAGE SCHEDULE"], 10),
      ...row(["101"], 30),
      ...signRows.flat(),
      ...row(["KEYNOTES"], 200),
      ...keynoteRows.flat(),
    ];
  }

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
