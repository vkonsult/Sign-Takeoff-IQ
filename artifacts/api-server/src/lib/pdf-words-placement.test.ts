import { describe, it, expect } from "vitest";
import {
  matchLocationToCoords,
  extractFloorLevelName,
  extractCodeProximityPairs,
  type PdfPhrase,
  type PageWords,
} from "./pdf-words";

function makePhrase(text: string, x0: number, y0: number, x1: number, y1: number): PdfPhrase {
  return { text, x0, y0, x1, y1 };
}

function bodyPhrase(text: string, cx = 0.3, cy = 0.3): PdfPhrase {
  const half = 0.03;
  return makePhrase(text, cx - half, cy - half, cx + half, cy + half);
}

function titlePhrase(text: string, cx = 0.80, cy = 0.80): PdfPhrase {
  const half = 0.03;
  return makePhrase(text, cx - half, cy - half, cx + half, cy + half);
}

function makePageWords(phrases: PdfPhrase[], pageWidth = 1000, pageHeight = 1400): PageWords {
  return { pageWidth, pageHeight, phrases };
}

// ── matchLocationToCoords ─────────────────────────────────────────────────────

describe("matchLocationToCoords — null / empty guards", () => {
  it("returns null when both location and signIdentifier are empty", () => {
    const phrases = [bodyPhrase("LOBBY")];
    expect(matchLocationToCoords(phrases, null, null)).toBeNull();
  });

  it("returns null when query is whitespace only", () => {
    const phrases = [bodyPhrase("LOBBY")];
    expect(matchLocationToCoords(phrases, "   ", "")).toBeNull();
  });

  it("returns null when phrase list is empty", () => {
    expect(matchLocationToCoords([], "LOBBY", null)).toBeNull();
  });

  it("returns null when no phrase scores above 0.5", () => {
    const phrases = [bodyPhrase("STAIRWELL 4B")];
    expect(matchLocationToCoords(phrases, "MAIN ENTRANCE", null)).toBeNull();
  });
});

describe("matchLocationToCoords — coordinate output", () => {
  it("returns the centre of the best-matching phrase", () => {
    const p = bodyPhrase("LOBBY", 0.25, 0.35);
    const result = matchLocationToCoords([p], "LOBBY", null);
    expect(result).not.toBeNull();
    expect(result!.xPos).toBeCloseTo(0.25, 5);
    expect(result!.yPos).toBeCloseTo(0.35, 5);
  });

  it("picks the higher-scoring phrase when multiple candidates exist", () => {
    const weak = bodyPhrase("OFFICE", 0.1, 0.1);
    const strong = bodyPhrase("LOBBY ENTRANCE", 0.5, 0.5);
    const result = matchLocationToCoords([weak, strong], "LOBBY ENTRANCE", null);
    expect(result!.xPos).toBeCloseTo(0.5, 5);
    expect(result!.yPos).toBeCloseTo(0.5, 5);
  });

  it("uses signIdentifier as a fallback when location is null", () => {
    const p = bodyPhrase("A-101", 0.4, 0.6);
    const result = matchLocationToCoords([p], null, "A-101");
    expect(result).not.toBeNull();
    expect(result!.xPos).toBeCloseTo(0.4, 5);
  });
});

describe("matchLocationToCoords — room-number matching", () => {
  it("boosts score to 0.85 when a room-number token exactly matches", () => {
    const p = bodyPhrase("B-204", 0.45, 0.55);
    const other = bodyPhrase("CONFERENCE ROOM", 0.7, 0.7);
    const result = matchLocationToCoords([p, other], "B-204", null);
    expect(result!.xPos).toBeCloseTo(0.45, 5);
  });

  it("handles alphanumeric room numbers like 101A", () => {
    const p = bodyPhrase("101A", 0.3, 0.4);
    const result = matchLocationToCoords([p], "101A", null);
    expect(result).not.toBeNull();
  });
});

describe("matchLocationToCoords — excludeCoords", () => {
  it("skips a phrase whose centre is within the exclusion threshold", () => {
    const p = bodyPhrase("LOBBY", 0.30, 0.30);
    const cx = 0.30;
    const cy = 0.30;
    const excluded = new Set([`${cx},${cy}`]);
    const result = matchLocationToCoords([p], "LOBBY", null, excluded);
    expect(result).toBeNull();
  });

  it("returns coords when the phrase is outside the exclusion radius", () => {
    const p = bodyPhrase("LOBBY", 0.30, 0.30);
    const excluded = new Set(["0.90,0.90"]);
    const result = matchLocationToCoords([p], "LOBBY", null, excluded);
    expect(result).not.toBeNull();
  });
});

// ── extractFloorLevelName ─────────────────────────────────────────────────────

describe("extractFloorLevelName — null / empty guards", () => {
  it("returns null for an empty phrase list", () => {
    expect(extractFloorLevelName([])).toBeNull();
  });

  it("returns null when no level keywords appear in the title-block zone", () => {
    const phrases = [bodyPhrase("ELEVATION A-201")];
    expect(extractFloorLevelName(phrases)).toBeNull();
  });
});

describe("extractFloorLevelName — level detection", () => {
  it('detects "main level" from a title-block phrase', () => {
    const phrases = [titlePhrase("MAIN LEVEL FLOOR PLAN")];
    const result = extractFloorLevelName(phrases);
    expect(result).toBe("main level");
  });

  it('detects "lower level" from a title-block phrase', () => {
    const phrases = [titlePhrase("LOWER LEVEL PLAN")];
    const result = extractFloorLevelName(phrases);
    expect(result).toBe("lower level");
  });

  it('detects "upper level" from a title-block phrase', () => {
    const phrases = [titlePhrase("UPPER LEVEL PLAN - OVERALL")];
    const result = extractFloorLevelName(phrases);
    expect(result).toBe("upper level");
  });

  it("falls back to all phrases when no title-block zone phrase is present", () => {
    const p = bodyPhrase("MAIN LEVEL FLOOR PLAN", 0.3, 0.3);
    const result = extractFloorLevelName([p]);
    expect(result).toBe("main level");
  });

  it("is case-insensitive", () => {
    const phrases = [titlePhrase("Main Level Floor Plan")];
    expect(extractFloorLevelName(phrases)).toBe("main level");
  });
});

// ── extractCodeProximityPairs ─────────────────────────────────────────────────

describe("extractCodeProximityPairs — null / empty guards", () => {
  it("returns an empty array when there are no phrases", () => {
    const pw = makePageWords([]);
    expect(extractCodeProximityPairs(pw, 1)).toEqual([]);
  });

  it("returns an empty array when there are no code tokens", () => {
    const pw = makePageWords([bodyPhrase("LOBBY")]);
    expect(extractCodeProximityPairs(pw, 1)).toEqual([]);
  });

  it("returns an empty array when there are no valid label candidates", () => {
    const pw = makePageWords([bodyPhrase("A-101")]);
    expect(extractCodeProximityPairs(pw, 1)).toEqual([]);
  });
});

describe("extractCodeProximityPairs — pairing logic", () => {
  it("pairs a code token with an adjacent label on the same row", () => {
    const pageWidth = 1000;
    const pageHeight = 1400;

    const codePx = 0.30;
    const labelPx = 0.20;
    const rowNy = 0.40;

    const codePhrase = makePhrase("A-101", codePx - 0.02, rowNy - 0.01, codePx + 0.02, rowNy + 0.01);
    const labelPhrase = makePhrase("WORSHIP CENTER", labelPx - 0.05, rowNy - 0.01, labelPx + 0.05, rowNy + 0.01);

    const codeCy = rowNy * pageHeight;
    const labelCy = rowNy * pageHeight;
    const codeCx = codePx * pageWidth;
    const labelCx = labelPx * pageWidth;

    expect(Math.abs(labelCy - codeCy)).toBeLessThanOrEqual(25);
    expect(Math.abs(labelCx - codeCx)).toBeLessThanOrEqual(250);

    const pw = makePageWords([codePhrase, labelPhrase], pageWidth, pageHeight);
    const pairs = extractCodeProximityPairs(pw, 3);

    expect(pairs.length).toBeGreaterThanOrEqual(1);
    const pair = pairs[0]!;
    expect(pair.code).toBe("A-101");
    expect(pair.label).toBe("WORSHIP CENTER");
    expect(pair.page).toBe(3);
    expect(pair.x).toBeCloseTo(labelPx, 3);
    expect(pair.y).toBeCloseTo(rowNy, 3);
  });

  it("does not pair code and label that are too far apart vertically", () => {
    const codePhrase = makePhrase("B-202", 0.30 - 0.02, 0.20 - 0.01, 0.30 + 0.02, 0.20 + 0.01);
    const labelPhrase = makePhrase("LOBBY AREA", 0.25 - 0.04, 0.60 - 0.01, 0.25 + 0.04, 0.60 + 0.01);

    const pageWidth = 1000;
    const pageHeight = 1000;
    const dy = Math.abs(0.20 - 0.60) * pageHeight;
    expect(dy).toBeGreaterThan(25);

    const pw = makePageWords([codePhrase, labelPhrase], pageWidth, pageHeight);
    const pairs = extractCodeProximityPairs(pw, 1);
    expect(pairs).toHaveLength(0);
  });

  it("excludes title-block phrases from both code tokens and labels", () => {
    const titleCode = titlePhrase("A-101");
    const titleLabel = titlePhrase("SIGN SCHEDULE");
    const pw = makePageWords([titleCode, titleLabel]);
    const pairs = extractCodeProximityPairs(pw, 1);
    expect(pairs).toHaveLength(0);
  });

  it("stores the 1-indexed page number on every pair", () => {
    const pageWidth = 1000;
    const pageHeight = 1400;

    const codePx = 0.30;
    const labelPx = 0.20;
    const rowNy = 0.40;

    const codePhrase = makePhrase("C-3", codePx - 0.02, rowNy - 0.01, codePx + 0.02, rowNy + 0.01);
    const labelPhrase = makePhrase("HALLWAY", labelPx - 0.04, rowNy - 0.01, labelPx + 0.04, rowNy + 0.01);

    const pw = makePageWords([codePhrase, labelPhrase], pageWidth, pageHeight);
    const pairs = extractCodeProximityPairs(pw, 7);

    expect(pairs.length).toBeGreaterThanOrEqual(1);
    expect(pairs.every((p) => p.page === 7)).toBe(true);
  });
});
