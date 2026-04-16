import { describe, it, expect } from "vitest";
import { classifyPageFromPhrases, type PdfPhrase } from "./pdf-words";

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
