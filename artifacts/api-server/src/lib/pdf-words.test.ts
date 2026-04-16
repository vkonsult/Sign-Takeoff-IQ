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
