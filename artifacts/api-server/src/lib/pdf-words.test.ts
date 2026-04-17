import { describe, it, expect } from "vitest";
import {
  classifyPageFromPhrases,
  extractFloorPlanTextCandidates,
  TABLE_COL_MIN_PHRASES,
  TABLE_COL_X_TOLERANCE,
  type PdfPhrase,
  type PageWords,
} from "./pdf-words";

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

describe("classifyPageFromPhrases — exclusion veto scope (task-124 fix)", () => {
  it('classifies "FIRST FLOOR PLAN - OVERALL" as floor_plan when an incidental exclusion word is in a non-candidate corner phrase', () => {
    const phrases = [
      phrase("FIRST FLOOR PLAN - OVERALL"),
      phrase("FIRE PROTECTION NOTES", 0.65, 0.65),
    ];
    const result = classifyPageFromPhrases(phrases);
    expect(result.type).toBe("floor_plan");
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

  it('classifies correctly when "site" appears only in a non-candidate corner phrase', () => {
    const phrases = [
      phrase("GROUND FLOOR PLAN"),
      phrase("SEE SITE PLAN A101 FOR REFERENCE", 0.62, 0.62),
    ];
    const result = classifyPageFromPhrases(phrases);
    expect(result.type).toBe("floor_plan");
  });

  it('classifies correctly when "safety" appears only in a non-candidate corner phrase', () => {
    const phrases = [
      phrase("THIRD FLOOR PLAN"),
      phrase("LIFE SAFETY NOTES APPLY", 0.65, 0.75),
    ];
    const result = classifyPageFromPhrases(phrases);
    expect(result.type).toBe("floor_plan");
  });

  it('classifies sign_schedule correctly and is not vetoed by incidental exclusion text', () => {
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

  it('edge case: title split across two phrases — inclusion in one, exclusion in adjacent non-candidate phrase — both in corner', () => {
    // "FIRST FLOOR" triggers inclusion; "REFLECTED CEILING PLAN" does not
    // individually match any inclusion phrase, so it is NOT a candidate.
    // The exclusion veto therefore does not fire; the page is floor_plan.
    // This is documented, intended behaviour: the task spec states the veto
    // only fires when the exclusion word "appears in the same phrase as the title".
    const phrases = [
      phrase("FIRST FLOOR"),
      phrase("REFLECTED CEILING PLAN", 0.65, 0.65),
    ];
    const result = classifyPageFromPhrases(phrases);
    expect(result.type).toBe("floor_plan");
  });

  it('titlePhrases returned are only the candidate matching phrases, not incidental corner text', () => {
    const incidental = phrase("FIRE PROTECTION NOTES", 0.62, 0.62);
    const title = phrase("SECOND FLOOR PLAN");
    const result = classifyPageFromPhrases([title, incidental]);
    expect(result.type).toBe("floor_plan");
    expect(result.titlePhrases).toContain(title);
    expect(result.titlePhrases).not.toContain(incidental);
  });
});

// ── extractFloorPlanTextCandidates — table-column exclusion heuristic ─────────

/**
 * Build a PageWords payload with a synthetic table column and scattered room labels.
 *
 * Table column: normalised x-centre = 0.50, placed in the drawing area (cx ≤ 0.75)
 * so it survives the title-block pre-filter and reaches the column detector.
 * Row y-centres are 0.10 apart in normalised units (80 pts with pageHeight=800),
 * producing perfectly uniform spacing that satisfies the regularity check.
 *
 * Room labels sit in the left quarter of the page at varied x positions.
 */
function makePageWithTableAndRoomLabels(): PageWords {
  const pageWidth = 1000;
  const pageHeight = 800;

  // 8 rows — safely above TABLE_COL_MIN_PHRASES (currently 6)
  const tableRowCount = TABLE_COL_MIN_PHRASES + 2;

  // Normalised x-centre 0.50; bucket = round(0.50 / TABLE_COL_X_TOLERANCE) * TABLE_COL_X_TOLERANCE = 0.50
  const tableCx = Math.round(0.50 / TABLE_COL_X_TOLERANCE) * TABLE_COL_X_TOLERANCE;
  const half = 0.03; // half-width of each phrase bounding box in normalised units

  const tablePhrases: PdfPhrase[] = Array.from({ length: tableRowCount }, (_, i) => {
    // y-centres: 0.10, 0.20, … — uniform 0.10 spacing (80 pts) satisfies TABLE_COL_Y_SPACING_MAX
    const cy = 0.10 + i * 0.10;
    return {
      text: `SIGN TYPE ${i + 1}`,
      x0: tableCx - half,
      x1: tableCx + half,
      y0: cy - 0.03,
      y1: cy + 0.03,
    };
  });

  // A handful of room labels at irregular x positions in the left half of the page,
  // outside the title-block zone (centre must not be in bottom-right corner).
  const roomPhrases: PdfPhrase[] = [
    { text: "OFFICE", x0: 0.10, x1: 0.20, y0: 0.20, y1: 0.26 },
    { text: "CONFERENCE ROOM", x0: 0.25, x1: 0.45, y0: 0.40, y1: 0.46 },
    { text: "RECEPTION", x0: 0.05, x1: 0.20, y0: 0.60, y1: 0.66 },
  ];

  return {
    pageWidth,
    pageHeight,
    phrases: [...tablePhrases, ...roomPhrases],
  };
}

describe("extractFloorPlanTextCandidates — embedded table-column exclusion", () => {
  it("excludes table-column phrases while preserving room labels", () => {
    const pw = makePageWithTableAndRoomLabels();
    const candidates = extractFloorPlanTextCandidates(pw, 1);

    const texts = candidates.map((c) => c.text);

    // Room labels must be present
    expect(texts).toContain("OFFICE");
    expect(texts).toContain("CONFERENCE ROOM");
    expect(texts).toContain("RECEPTION");

    // Table column phrases must be absent
    for (let i = 1; i <= TABLE_COL_MIN_PHRASES + 2; i++) {
      expect(texts).not.toContain(`SIGN TYPE ${i}`);
    }
  });

  it("does not exclude a column with fewer than TABLE_COL_MIN_PHRASES phrases", () => {
    const pageWidth = 1000;
    const pageHeight = 800;

    // Only 4 phrases in the column — below the threshold of 6.
    // Centre at cx=0.30 so the title-block-zone filter (cx > 0.75 or
    // bottom-right quadrant) does not remove them before the column check.
    const shortColumnPhrases: PdfPhrase[] = Array.from({ length: TABLE_COL_MIN_PHRASES - 2 }, (_, i) => {
      const cy = 0.10 + i * 0.10;
      return {
        text: `LEGEND ITEM ${i + 1}`,
        x0: 0.27,
        x1: 0.33,
        y0: cy - 0.03,
        y1: cy + 0.03,
      };
    });

    const pw: PageWords = { pageWidth, pageHeight, phrases: shortColumnPhrases };
    const candidates = extractFloorPlanTextCandidates(pw, 1);
    const texts = candidates.map((c) => c.text);

    // All four legend items should survive (column too short to be excluded)
    for (let i = 1; i <= TABLE_COL_MIN_PHRASES - 2; i++) {
      expect(texts).toContain(`LEGEND ITEM ${i}`);
    }
  });
});
