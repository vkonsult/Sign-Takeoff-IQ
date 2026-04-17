import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PdfPhrase } from "./pdf-words";

vi.mock("./pdf-words", () => ({
  extractPdfMetadata: vi.fn(),
  extractPagePhrases: vi.fn(),
  getPdfPageCount: vi.fn(),
  getOrOpenPdfjsDoc: vi.fn(),
}));

import {
  buildSheetManifest,
  classifyTitle,
  extractLevelFromTitle,
  normalizeSheetNum,
} from "./sheet-manifest";
import {
  extractPdfMetadata,
  extractPagePhrases,
  getPdfPageCount,
} from "./pdf-words";

const mockMeta = vi.mocked(extractPdfMetadata);
const mockPhrases = vi.mocked(extractPagePhrases);
const mockPageCount = vi.mocked(getPdfPageCount);

function phrase(
  text: string,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
): PdfPhrase {
  return { text, x0, x1, y0, y1 };
}

function pageWords(phrases: PdfPhrase[]) {
  return { pageWidth: 800, pageHeight: 600, phrases };
}

/**
 * Set up extractPagePhrases mock to return phrases keyed by page number.
 * Each page can be requested multiple times (once during index scan, once
 * during per-page classification) and always gets the same data.
 */
function setupPageMocks(pages: Record<number, PdfPhrase[]>) {
  mockPhrases.mockImplementation(
    (_path: string, _fileId: string, pageNum: number) =>
      Promise.resolve(pageWords(pages[pageNum] ?? [])),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockMeta.mockResolvedValue({ pageLabels: [], outlineSections: [] });
});

// ── classifyTitle ─────────────────────────────────────────────────────────────

describe("classifyTitle — task-spec validation examples", () => {
  it('"OVERALL FLOOR PLAN" → floor_plan', () => {
    expect(classifyTitle("OVERALL FLOOR PLAN")).toBe("floor_plan");
  });

  it('"MAIN LEVEL PLAN" → floor_plan', () => {
    expect(classifyTitle("MAIN LEVEL PLAN")).toBe("floor_plan");
  });

  it('"FIRST FLOOR PLAN - OVERALL" → floor_plan', () => {
    expect(classifyTitle("FIRST FLOOR PLAN - OVERALL")).toBe("floor_plan");
  });

  it('"FIRST FLOOR FRAMING PLAN" → ignore (framing veto)', () => {
    expect(classifyTitle("FIRST FLOOR FRAMING PLAN")).toBe("ignore");
  });

  it('"FOUNDATION FLOOR PLAN" → ignore (foundation veto)', () => {
    expect(classifyTitle("FOUNDATION FLOOR PLAN")).toBe("ignore");
  });
});

describe("classifyTitle — P1 signage_schedule", () => {
  it("sign schedule → signage_schedule", () => {
    expect(classifyTitle("sign schedule")).toBe("signage_schedule");
  });

  it("SIGNAGE SCHEDULE → signage_schedule", () => {
    expect(classifyTitle("SIGNAGE SCHEDULE")).toBe("signage_schedule");
  });

  it("sign criteria → signage_schedule", () => {
    expect(classifyTitle("sign criteria")).toBe("signage_schedule");
  });

  it("signage plan → signage_schedule", () => {
    expect(classifyTitle("signage plan")).toBe("signage_schedule");
  });

  it("sign types → signage_schedule", () => {
    expect(classifyTitle("sign types")).toBe("signage_schedule");
  });

  it("plaque schedule → signage_schedule", () => {
    expect(classifyTitle("plaque schedule")).toBe("signage_schedule");
  });
});

describe("classifyTitle — P2 life_safety", () => {
  it("life safety plan → life_safety", () => {
    expect(classifyTitle("life safety plan")).toBe("life_safety");
  });

  it("EGRESS PLAN → life_safety", () => {
    expect(classifyTitle("EGRESS PLAN")).toBe("life_safety");
  });

  it("CODE COMPLIANCE → life_safety", () => {
    expect(classifyTitle("CODE COMPLIANCE")).toBe("life_safety");
  });

  it("OCCUPANT LOAD → life_safety", () => {
    expect(classifyTitle("OCCUPANT LOAD")).toBe("life_safety");
  });
});

describe("classifyTitle — P3 key_plan", () => {
  it("key plan → key_plan", () => {
    expect(classifyTitle("key plan")).toBe("key_plan");
  });

  it("OVERALL KEY PLAN → key_plan", () => {
    expect(classifyTitle("OVERALL KEY PLAN")).toBe("key_plan");
  });
});

describe("classifyTitle — P4 ignore (discipline veto before floor_plan)", () => {
  it("reflected ceiling plan → ignore", () => {
    expect(classifyTitle("reflected ceiling plan")).toBe("ignore");
  });

  it("RCP → ignore", () => {
    expect(classifyTitle("RCP")).toBe("ignore");
  });

  it("roof plan → ignore", () => {
    expect(classifyTitle("roof plan")).toBe("ignore");
  });

  it("foundation plan → ignore", () => {
    expect(classifyTitle("foundation plan")).toBe("ignore");
  });

  it("framing plan → ignore", () => {
    expect(classifyTitle("framing plan")).toBe("ignore");
  });

  it("mechanical plan → ignore", () => {
    expect(classifyTitle("mechanical plan")).toBe("ignore");
  });

  it("electrical plan → ignore", () => {
    expect(classifyTitle("electrical plan")).toBe("ignore");
  });

  it("plumbing plan → ignore", () => {
    expect(classifyTitle("plumbing plan")).toBe("ignore");
  });

  it("fire protection plan → ignore", () => {
    expect(classifyTitle("fire protection plan")).toBe("ignore");
  });

  it("structural plan → ignore", () => {
    expect(classifyTitle("structural plan")).toBe("ignore");
  });

  it("demolition plan → ignore", () => {
    expect(classifyTitle("demolition plan")).toBe("ignore");
  });

  it("site plan → ignore", () => {
    expect(classifyTitle("site plan")).toBe("ignore");
  });

  it("furniture plan → ignore", () => {
    expect(classifyTitle("furniture plan")).toBe("ignore");
  });

  it("finish plan → ignore", () => {
    expect(classifyTitle("finish plan")).toBe("ignore");
  });

  it("lighting plan → ignore", () => {
    expect(classifyTitle("lighting plan")).toBe("ignore");
  });

  it("sprinkler plan → ignore", () => {
    expect(classifyTitle("sprinkler plan")).toBe("ignore");
  });

  it("photometric plan → ignore", () => {
    expect(classifyTitle("photometric plan")).toBe("ignore");
  });

  it("power plan → ignore", () => {
    expect(classifyTitle("power plan")).toBe("ignore");
  });

  it('any title containing "foundation" is ignored — not just "foundation plan"', () => {
    expect(classifyTitle("FOUNDATION NOTES")).toBe("ignore");
    expect(classifyTitle("FOUNDATION DETAIL")).toBe("ignore");
  });
});

describe("classifyTitle — P4 ignore veto has priority over P5 floor_plan", () => {
  it("FIRST FLOOR REFLECTED CEILING PLAN → ignore (rcp veto beats first floor inclusion)", () => {
    expect(classifyTitle("FIRST FLOOR REFLECTED CEILING PLAN")).toBe("ignore");
  });

  it("SECOND FLOOR RCP → ignore", () => {
    expect(classifyTitle("SECOND FLOOR RCP")).toBe("ignore");
  });

  it("MAIN LEVEL FRAMING PLAN → ignore (framing veto beats main level inclusion)", () => {
    expect(classifyTitle("MAIN LEVEL FRAMING PLAN")).toBe("ignore");
  });

  it("GROUND FLOOR FOUNDATION PLAN → ignore (foundation veto)", () => {
    expect(classifyTitle("GROUND FLOOR FOUNDATION PLAN")).toBe("ignore");
  });

  it("MEZZANINE ROOF PLAN → ignore (roof veto beats mezzanine inclusion)", () => {
    expect(classifyTitle("MEZZANINE ROOF PLAN")).toBe("ignore");
  });
});

describe("classifyTitle — P5 floor_plan (inclusion phrases)", () => {
  it("floor plan → floor_plan", () => {
    expect(classifyTitle("floor plan")).toBe("floor_plan");
  });

  it("SECOND FLOOR → floor_plan", () => {
    expect(classifyTitle("SECOND FLOOR")).toBe("floor_plan");
  });

  it("THIRD FLOOR PLAN → floor_plan", () => {
    expect(classifyTitle("THIRD FLOOR PLAN")).toBe("floor_plan");
  });

  it("FOURTH FLOOR PLAN → floor_plan", () => {
    expect(classifyTitle("FOURTH FLOOR PLAN")).toBe("floor_plan");
  });

  it("FIFTH FLOOR PLAN → floor_plan", () => {
    expect(classifyTitle("FIFTH FLOOR PLAN")).toBe("floor_plan");
  });

  it("GROUND FLOOR PLAN → floor_plan", () => {
    expect(classifyTitle("GROUND FLOOR PLAN")).toBe("floor_plan");
  });

  it("BASEMENT PLAN → floor_plan", () => {
    expect(classifyTitle("BASEMENT PLAN")).toBe("floor_plan");
  });

  it("LOWER LEVEL PLAN → floor_plan", () => {
    expect(classifyTitle("LOWER LEVEL PLAN")).toBe("floor_plan");
  });

  it("UPPER LEVEL PLAN → floor_plan", () => {
    expect(classifyTitle("UPPER LEVEL PLAN")).toBe("floor_plan");
  });

  it("MEZZANINE PLAN → floor_plan", () => {
    expect(classifyTitle("MEZZANINE PLAN")).toBe("floor_plan");
  });
});

describe("classifyTitle — P5 floor_plan via LEVEL_PLAN_RE (\\bword level plan\\b)", () => {
  it('"MAIN LEVEL PLAN" → floor_plan via regex', () => {
    expect(classifyTitle("MAIN LEVEL PLAN")).toBe("floor_plan");
  });

  it('"LOBBY LEVEL PLAN" → floor_plan via regex (any word + level plan)', () => {
    expect(classifyTitle("LOBBY LEVEL PLAN")).toBe("floor_plan");
  });

  it('"CONCOURSE LEVEL PLAN" → floor_plan via regex', () => {
    expect(classifyTitle("CONCOURSE LEVEL PLAN")).toBe("floor_plan");
  });
});

describe("classifyTitle — P5 floor_plan — sheet number fallback", () => {
  it("A-101 with unrecognised title → floor_plan", () => {
    expect(classifyTitle("ARCHITECTURAL DRAWING", "A-101")).toBe("floor_plan");
  });

  it("A-201 → floor_plan", () => {
    expect(classifyTitle("ARCHITECTURAL DRAWING", "A-201")).toBe("floor_plan");
  });

  it("A-301 with ambiguous title → floor_plan", () => {
    expect(classifyTitle("ARCHITECTURAL", "A-301")).toBe("floor_plan");
  });

  it("A3.2 with ambiguous title → floor_plan", () => {
    expect(classifyTitle("ARCHITECTURAL", "A3.2")).toBe("floor_plan");
  });

  it("A-401 does NOT match floor plan sheet regex (only 1xx, 2xx, 3xx)", () => {
    expect(classifyTitle("DETAIL SHEET", "A-401")).not.toBe("floor_plan");
  });

  it("A-001 → general_notes (not floor_plan)", () => {
    expect(classifyTitle("DRAWING", "A-001")).toBe("general_notes");
  });

  it("A-201 with 6+ words of non-floor-plan text is NOT promoted by sheet number alone", () => {
    // Task requirement: tightened regex — sheet number fallback suppressed when
    // the title block has substantial text that did not phrase-match.
    expect(classifyTitle("ELEVATION EAST SIDE ENTRY CANOPY DETAIL", "A-201")).not.toBe("floor_plan");
  });

  it("A-101 with long elevation text is NOT promoted by sheet number alone", () => {
    expect(classifyTitle("EXTERIOR ELEVATION NORTH WALL SECTION DETAIL", "A-101")).not.toBe("floor_plan");
  });
});

describe("classifyTitle — P5 sheet-number fallback discipline-word veto", () => {
  it('"ELEVATION" with sheet A-201 is NOT promoted to floor_plan', () => {
    expect(classifyTitle("ELEVATION", "A-201")).not.toBe("floor_plan");
  });

  it('"SECTION" with sheet A-301 is NOT promoted to floor_plan', () => {
    expect(classifyTitle("SECTION", "A-301")).not.toBe("floor_plan");
  });

  it('"DETAIL" with sheet A-101 is NOT promoted to floor_plan', () => {
    expect(classifyTitle("DETAIL", "A-101")).not.toBe("floor_plan");
  });

  it('"STAIR" with sheet A-201 is NOT promoted to floor_plan', () => {
    expect(classifyTitle("STAIR", "A-201")).not.toBe("floor_plan");
  });

  it('"WALL" with sheet A-101 is NOT promoted to floor_plan', () => {
    expect(classifyTitle("WALL", "A-101")).not.toBe("floor_plan");
  });

  it('"ARCHITECTURAL DRAWING" (no discipline word, 2 words) with A-101 still promotes to floor_plan', () => {
    expect(classifyTitle("ARCHITECTURAL DRAWING", "A-101")).toBe("floor_plan");
  });
});

describe("classifyTitle — reference-only floor plan mentions are not false positives", () => {
  it('"SEE FLOOR PLAN A-301" alone does not classify as floor_plan', () => {
    expect(classifyTitle("SEE FLOOR PLAN A-301")).toBe("other");
  });

  it('"PER FLOOR PLAN" alone does not classify as floor_plan', () => {
    expect(classifyTitle("PER FLOOR PLAN")).toBe("other");
  });

  it('"REF FLOOR PLAN A-201 FOR DIMENSIONS" does not classify as floor_plan', () => {
    expect(classifyTitle("REF FLOOR PLAN A-201 FOR DIMENSIONS")).toBe("other");
  });

  it('"EXTERIOR ELEVATION — SEE FLOOR PLAN A-101" does not classify as floor_plan', () => {
    expect(classifyTitle("EXTERIOR ELEVATION — SEE FLOOR PLAN A-101")).toBe("other");
  });

  it('"REFERENCE TO FLOOR PLAN" does not classify as floor_plan', () => {
    expect(classifyTitle("REFER TO FLOOR PLAN")).toBe("other");
  });

  it('"FIRST FLOOR PLAN" (without reference prefix) still classifies as floor_plan', () => {
    expect(classifyTitle("FIRST FLOOR PLAN")).toBe("floor_plan");
  });

  it('"SEE FLOOR PLAN A-301" with sheet number A-301 is NOT promoted by the sheet-number fallback', () => {
    // Real title-block path: extractSheetNumber finds A-301 from the phrase,
    // classifyTitle is called with both text AND sheetNumber.  The reference-only
    // guard must block sheet-number promotion in this scenario.
    expect(classifyTitle("SEE FLOOR PLAN A-301", "A-301")).toBe("other");
  });

  it('"PER FLOOR PLAN" with sheet number A-201 is NOT promoted by the sheet-number fallback', () => {
    expect(classifyTitle("PER FLOOR PLAN", "A-201")).toBe("other");
  });

  it('"REF FLOOR PLAN" with sheet number A-101 is NOT promoted by the sheet-number fallback', () => {
    expect(classifyTitle("REF FLOOR PLAN", "A-101")).toBe("other");
  });
});

describe("buildSheetManifest — reference-only floor plan text + matching sheet number stays non-floor_plan", () => {
  it("title-block with 'SEE FLOOR PLAN A-201' and sheet A-201 is not classified floor_plan", async () => {
    // Both phrases are placed at cy > 0.90 so they are picked up together in the
    // narrow title strip (Pass 1).  The combined text "SEE FLOOR PLAN A-201"
    // must not promote the page to floor_plan even though A-201 matches the regex.
    mockPageCount.mockResolvedValue(1);
    setupPageMocks({
      1: [
        phrase("SEE FLOOR PLAN", 0.50, 0.80, 0.91, 0.95),
        phrase("A-201", 0.70, 0.78, 0.92, 0.96),
      ],
    });

    const manifest = await buildSheetManifest("/fake/file.pdf", "test-file");

    const page1 = manifest.entries.find((e) => e.pdfPage === 1);
    expect(page1?.bucket).not.toBe("floor_plan");
  });
});

describe("classifyTitle — P6 general_notes", () => {
  it("general notes → general_notes", () => {
    expect(classifyTitle("general notes")).toBe("general_notes");
  });

  it("abbreviations → general_notes", () => {
    expect(classifyTitle("abbreviations")).toBe("general_notes");
  });

  it("symbols legend → general_notes", () => {
    expect(classifyTitle("symbols legend")).toBe("general_notes");
  });

  it("mounting heights → general_notes", () => {
    expect(classifyTitle("mounting heights")).toBe("general_notes");
  });

  it("A-000 sheet number → general_notes", () => {
    expect(classifyTitle("COVER", "A-000")).toBe("general_notes");
  });

  it("G-101 sheet number → general_notes", () => {
    expect(classifyTitle("NOTES", "G-101")).toBe("general_notes");
  });
});

describe("classifyTitle — P7 accessibility", () => {
  it("accessibility plan → accessibility", () => {
    expect(classifyTitle("accessibility plan")).toBe("accessibility");
  });

  it("ADA COMPLIANCE → accessibility", () => {
    expect(classifyTitle("ADA COMPLIANCE")).toBe("accessibility");
  });

  it("barrier-free design → accessibility", () => {
    expect(classifyTitle("barrier-free design")).toBe("accessibility");
  });
});

describe("classifyTitle — P8 millwork_interiors", () => {
  it("millwork plan → millwork_interiors", () => {
    expect(classifyTitle("millwork plan")).toBe("millwork_interiors");
  });

  it("casework schedule → millwork_interiors", () => {
    expect(classifyTitle("casework schedule")).toBe("millwork_interiors");
  });

  it("interior elevations → millwork_interiors", () => {
    expect(classifyTitle("interior elevations")).toBe("millwork_interiors");
  });

  it("interior details → millwork_interiors", () => {
    expect(classifyTitle("interior details")).toBe("millwork_interiors");
  });

  it("A-701 sheet number → millwork_interiors", () => {
    expect(classifyTitle("DRAWING", "A-701")).toBe("millwork_interiors");
  });

  it("A-801 sheet number → millwork_interiors", () => {
    expect(classifyTitle("DRAWING", "A-801")).toBe("millwork_interiors");
  });
});

describe("classifyTitle — P9 specifications", () => {
  it("specifications → specifications", () => {
    expect(classifyTitle("specifications")).toBe("specifications");
  });

  it("specs → specifications", () => {
    expect(classifyTitle("specs")).toBe("specifications");
  });
});

describe("classifyTitle — P10 other (fallback)", () => {
  it("empty string → other", () => {
    expect(classifyTitle("")).toBe("other");
  });

  it("whitespace-only → other", () => {
    expect(classifyTitle("   ")).toBe("other");
  });

  it("unrecognised title → other", () => {
    expect(classifyTitle("SECTION A-A")).toBe("other");
  });

  it("ELEVATION EAST → other", () => {
    expect(classifyTitle("ELEVATION EAST")).toBe("other");
  });

  it("DETAIL 1/A-501 → other", () => {
    expect(classifyTitle("DETAIL 1/A-501")).toBe("other");
  });
});

describe("classifyTitle — priority ordering (P1 beats P5)", () => {
  it("signage plan is signage_schedule, not floor_plan, even though it contains 'plan'", () => {
    expect(classifyTitle("FIRST FLOOR SIGNAGE PLAN")).toBe("signage_schedule");
  });
});

describe("classifyTitle — sheetNumber argument is optional / null-safe", () => {
  it("null sheetNumber does not throw", () => {
    expect(() => classifyTitle("DRAWING", null)).not.toThrow();
  });

  it("undefined sheetNumber does not throw", () => {
    expect(() => classifyTitle("DRAWING", undefined)).not.toThrow();
  });
});

// ── extractLevelFromTitle ─────────────────────────────────────────────────────

describe("extractLevelFromTitle — basement / B1", () => {
  it("b1 → B1", () => {
    expect(extractLevelFromTitle("B1 FLOOR PLAN").level).toBe("B1");
  });

  it("basement → B1", () => {
    expect(extractLevelFromTitle("BASEMENT FLOOR PLAN").level).toBe("B1");
  });

  it("lower level → B1", () => {
    expect(extractLevelFromTitle("LOWER LEVEL PLAN").level).toBe("B1");
  });

  it("below grade → B1", () => {
    expect(extractLevelFromTitle("BELOW GRADE PARKING PLAN").level).toBe("B1");
  });
});

describe("extractLevelFromTitle — L1 through L5", () => {
  it("main level → L1", () => {
    expect(extractLevelFromTitle("MAIN LEVEL PLAN").level).toBe("L1");
  });

  it("first floor → L1", () => {
    expect(extractLevelFromTitle("FIRST FLOOR PLAN").level).toBe("L1");
  });

  it("ground floor → L1", () => {
    expect(extractLevelFromTitle("GROUND FLOOR PLAN").level).toBe("L1");
  });

  it("l1 → L1", () => {
    expect(extractLevelFromTitle("L1 FLOOR PLAN").level).toBe("L1");
  });

  it("second floor → L2", () => {
    expect(extractLevelFromTitle("SECOND FLOOR PLAN").level).toBe("L2");
  });

  it("upper level → L2", () => {
    expect(extractLevelFromTitle("UPPER LEVEL PLAN").level).toBe("L2");
  });

  it("l2 → L2", () => {
    expect(extractLevelFromTitle("L2 FLOOR PLAN").level).toBe("L2");
  });

  it("third floor → L3", () => {
    expect(extractLevelFromTitle("THIRD FLOOR PLAN").level).toBe("L3");
  });

  it("l3 → L3", () => {
    expect(extractLevelFromTitle("L3 FLOOR PLAN").level).toBe("L3");
  });

  it("fourth floor → L4", () => {
    expect(extractLevelFromTitle("FOURTH FLOOR PLAN").level).toBe("L4");
  });

  it("l4 → L4", () => {
    expect(extractLevelFromTitle("L4 FLOOR PLAN").level).toBe("L4");
  });

  it("fifth floor → L5", () => {
    expect(extractLevelFromTitle("FIFTH FLOOR PLAN").level).toBe("L5");
  });

  it("l5 → L5", () => {
    expect(extractLevelFromTitle("L5 FLOOR PLAN").level).toBe("L5");
  });
});

describe("extractLevelFromTitle — MEZZ", () => {
  it("mezzanine → MEZZ", () => {
    expect(extractLevelFromTitle("MEZZANINE PLAN").level).toBe("MEZZ");
  });

  it("mezz → MEZZ", () => {
    expect(extractLevelFromTitle("MEZZ PLAN").level).toBe("MEZZ");
  });
});

describe("extractLevelFromTitle — ROOF", () => {
  it("penthouse → ROOF", () => {
    expect(extractLevelFromTitle("PENTHOUSE FLOOR PLAN").level).toBe("ROOF");
  });

  it("roof level → ROOF", () => {
    expect(extractLevelFromTitle("ROOF LEVEL PLAN").level).toBe("ROOF");
  });
});

describe("extractLevelFromTitle — ATTIC", () => {
  it("attic → ATTIC", () => {
    expect(extractLevelFromTitle("ATTIC FLOOR PLAN").level).toBe("ATTIC");
  });
});

describe("extractLevelFromTitle — no level found", () => {
  it("returns null when no level phrase is present", () => {
    expect(extractLevelFromTitle("SIGN SCHEDULE").level).toBeNull();
  });

  it("levelRaw is null when no level found", () => {
    expect(extractLevelFromTitle("OVERALL PLAN").levelRaw).toBeNull();
  });
});

describe("extractLevelFromTitle — levelRaw preserves original casing", () => {
  it("levelRaw matches the exact slice of the input string", () => {
    const result = extractLevelFromTitle("First Floor Plan - Overall");
    expect(result.levelRaw).toBe("First Floor");
    expect(result.level).toBe("L1");
  });
});

describe("extractLevelFromTitle — area extraction", () => {
  it("AREA A → AREA A", () => {
    expect(extractLevelFromTitle("FIRST FLOOR PLAN - AREA A").area).toBe("AREA A");
  });

  it("AREA B → AREA B", () => {
    expect(extractLevelFromTitle("MAIN LEVEL PLAN AREA B").area).toBe("AREA B");
  });

  it("AREA C → AREA C", () => {
    expect(extractLevelFromTitle("FLOOR PLAN - AREA C").area).toBe("AREA C");
  });

  it("AREA D → AREA D", () => {
    expect(extractLevelFromTitle("FLOOR PLAN AREA D").area).toBe("AREA D");
  });

  it("no area → null", () => {
    expect(extractLevelFromTitle("FIRST FLOOR PLAN").area).toBeNull();
  });
});

describe("extractLevelFromTitle — building extraction", () => {
  it("BUILDING A → BUILDING A", () => {
    expect(extractLevelFromTitle("FIRST FLOOR PLAN - BUILDING A").building).toBe("BUILDING A");
  });

  it("BLDG B → BUILDING B", () => {
    expect(extractLevelFromTitle("MAIN LEVEL PLAN BLDG B").building).toBe("BUILDING B");
  });

  it("no building → null", () => {
    expect(extractLevelFromTitle("FIRST FLOOR PLAN").building).toBeNull();
  });
});

describe("extractLevelFromTitle — combined area + building + level", () => {
  it("extracts all three from a compound title", () => {
    const result = extractLevelFromTitle("SECOND FLOOR PLAN - BUILDING A - AREA B");
    expect(result.level).toBe("L2");
    expect(result.building).toBe("BUILDING A");
    expect(result.area).toBe("AREA B");
  });
});

// ── normalizeSheetNum ─────────────────────────────────────────────────────────

describe("normalizeSheetNum — sheet-number format normalisation", () => {
  it.each([
    ["A-101", "A101"],
    ["A.101", "A101"],
    ["A101", "A101"],
    ["a-101", "A101"],
    ["G-001", "G001"],
    ["S 2.1", "S21"],
    ["M-01", "M01"],
    ["A-101A", "A101A"],
  ])("normalizeSheetNum(%s) === %s", (input, expected) => {
    expect(normalizeSheetNum(input)).toBe(expected);
  });
});

// ── buildSheetManifest — drawing index integration ────────────────────────────

describe("buildSheetManifest — drawing index table detection", () => {
  it("uses index_page source when an index table is detected and sheet number matches", async () => {
    mockPageCount.mockResolvedValue(3);

    setupPageMocks({
      1: [
        phrase("A-101", 0.05, 0.12, 0.10, 0.14),
        phrase("FIRST FLOOR PLAN", 0.30, 0.70, 0.10, 0.14),
        phrase("A-102", 0.05, 0.12, 0.20, 0.24),
        phrase("SECOND FLOOR PLAN", 0.30, 0.70, 0.20, 0.24),
        phrase("A-001", 0.05, 0.12, 0.30, 0.34),
        phrase("GENERAL NOTES", 0.30, 0.70, 0.30, 0.34),
      ],
      2: [
        phrase("A-101", 0.70, 0.80, 0.92, 0.96),
        phrase("FIRST FLOOR PLAN", 0.50, 0.85, 0.93, 0.97),
      ],
      3: [
        phrase("A-102", 0.70, 0.80, 0.92, 0.96),
        phrase("SECOND FLOOR PLAN", 0.50, 0.85, 0.93, 0.97),
      ],
    });

    const manifest = await buildSheetManifest("/fake/file.pdf", "test-file");

    const page2 = manifest.entries.find((e) => e.pdfPage === 2);
    const page3 = manifest.entries.find((e) => e.pdfPage === 3);

    expect(page2?.source).toBe("index_page");
    expect(page2?.bucket).toBe("floor_plan");
    expect(page2?.sheetTitle).toBe("FIRST FLOOR PLAN");

    expect(page3?.source).toBe("index_page");
    expect(page3?.bucket).toBe("floor_plan");
    expect(page3?.sheetTitle).toBe("SECOND FLOOR PLAN");
  });

  it("classifies via index when title-block scrape returns 'other' but sheet number matches index", async () => {
    mockPageCount.mockResolvedValue(2);

    setupPageMocks({
      1: [
        phrase("A-101", 0.05, 0.12, 0.10, 0.14),
        phrase("FIRST FLOOR PLAN", 0.30, 0.70, 0.10, 0.14),
        phrase("A-102", 0.05, 0.12, 0.20, 0.24),
        phrase("SECOND FLOOR PLAN", 0.30, 0.70, 0.20, 0.24),
        phrase("A-001", 0.05, 0.12, 0.30, 0.34),
        phrase("GENERAL NOTES", 0.30, 0.70, 0.30, 0.34),
      ],
      2: [phrase("A-102", 0.40, 0.47, 0.40, 0.44)],
    });

    const manifest = await buildSheetManifest("/fake/file.pdf", "test-file");

    const page2 = manifest.entries.find((e) => e.pdfPage === 2);
    expect(page2?.source).toBe("index_page");
    expect(page2?.bucket).toBe("floor_plan");
    expect(page2?.sheetTitle).toBe("SECOND FLOOR PLAN");
  });

  it("falls back to title_block source when no drawing index is found", async () => {
    mockPageCount.mockResolvedValue(2);

    setupPageMocks({
      1: [
        phrase("PROJECT NOTES", 0.10, 0.50, 0.05, 0.09),
        phrase("These notes apply to all sheets.", 0.10, 0.90, 0.12, 0.16),
      ],
      2: [
        phrase("A-101", 0.70, 0.80, 0.92, 0.96),
        phrase("FIRST FLOOR PLAN", 0.50, 0.85, 0.93, 0.97),
      ],
    });

    const manifest = await buildSheetManifest("/fake/file.pdf", "test-file");

    const page2 = manifest.entries.find((e) => e.pdfPage === 2);
    expect(page2?.source).toBe("title_block");
    expect(page2?.bucket).toBe("floor_plan");
  });

  it("resolves index entries when title block and index use different sheet number formats", async () => {
    mockPageCount.mockResolvedValue(2);

    setupPageMocks({
      1: [
        phrase("A101", 0.05, 0.12, 0.10, 0.14),
        phrase("FIRST FLOOR PLAN", 0.30, 0.70, 0.10, 0.14),
        phrase("A102", 0.05, 0.12, 0.20, 0.24),
        phrase("SECOND FLOOR PLAN", 0.30, 0.70, 0.20, 0.24),
        phrase("A001", 0.05, 0.12, 0.30, 0.34),
        phrase("GENERAL NOTES", 0.30, 0.70, 0.30, 0.34),
      ],
      2: [
        phrase("A-101", 0.70, 0.80, 0.92, 0.96),
        phrase("FIRST FLOOR PLAN", 0.50, 0.85, 0.93, 0.97),
      ],
    });

    const manifest = await buildSheetManifest("/fake/file.pdf", "test-file");

    const page2 = manifest.entries.find((e) => e.pdfPage === 2);
    expect(page2?.source).toBe("index_page");
    expect(page2?.sheetTitle).toBe("FIRST FLOOR PLAN");
  });

  it("bookmark-classified ignore page is NOT re-promoted to floor_plan by title block scrape", async () => {
    // Task requirement: bookmarks act as a hard veto.  If a page's bookmark
    // classified it as `ignore`, title-block scraping must never override it,
    // even when the title block text contains a floor plan phrase.
    mockPageCount.mockResolvedValue(2);
    mockMeta.mockResolvedValue({
      pageLabels: [],
      outlineSections: [
        { title: "Exterior Elevations", pageStart: 2, pageEnd: 2, type: "other" },
      ],
    });

    setupPageMocks({
      1: [],
      2: [
        phrase("FLOOR PLAN", 0.60, 0.90, 0.92, 0.96),
        phrase("SEE FLOOR PLAN A-201", 0.50, 0.85, 0.85, 0.89),
        phrase("A-201", 0.70, 0.80, 0.80, 0.84),
      ],
    });

    const manifest = await buildSheetManifest("/fake/file.pdf", "test-file");

    const page2 = manifest.entries.find((e) => e.pdfPage === 2);
    expect(page2?.source).toBe("bookmark");
    expect(page2?.bucket).not.toBe("floor_plan");
  });

  it("rejects a candidate index page when sheet numbers are horizontally scattered", async () => {
    mockPageCount.mockResolvedValue(2);

    setupPageMocks({
      1: [
        phrase("A-101", 0.05, 0.12, 0.10, 0.14),
        phrase("note about sheet A-101", 0.30, 0.90, 0.10, 0.14),
        phrase("A-202", 0.55, 0.62, 0.25, 0.29),
        phrase("structural sheet", 0.65, 0.90, 0.25, 0.29),
        phrase("G-001", 0.80, 0.87, 0.40, 0.44),
        phrase("general notes", 0.88, 0.99, 0.40, 0.44),
      ],
      2: [
        phrase("A-101", 0.70, 0.80, 0.92, 0.96),
        phrase("FIRST FLOOR PLAN", 0.50, 0.85, 0.93, 0.97),
      ],
    });

    const manifest = await buildSheetManifest("/fake/file.pdf", "test-file");

    const page2 = manifest.entries.find((e) => e.pdfPage === 2);
    expect(page2?.source).toBe("title_block");
    expect(page2?.bucket).toBe("floor_plan");
  });

  it("preserves bookmarks cascade — bookmark-covered pages are not reclassified by index", async () => {
    mockPageCount.mockResolvedValue(2);
    mockMeta.mockResolvedValue({
      pageLabels: [],
      outlineSections: [
        { title: "Floor Plans", pageStart: 2, pageEnd: 2, type: "floor_plan" },
      ],
    });

    setupPageMocks({
      1: [
        phrase("A-101", 0.05, 0.12, 0.10, 0.14),
        phrase("SIGN SCHEDULE", 0.30, 0.70, 0.10, 0.14),
        phrase("A-102", 0.05, 0.12, 0.20, 0.24),
        phrase("SIGN CRITERIA", 0.30, 0.70, 0.20, 0.24),
        phrase("A-001", 0.05, 0.12, 0.30, 0.34),
        phrase("GENERAL NOTES", 0.30, 0.70, 0.30, 0.34),
      ],
      2: [],
    });

    const manifest = await buildSheetManifest("/fake/file.pdf", "test-file");

    const page2 = manifest.entries.find((e) => e.pdfPage === 2);
    expect(page2?.source).toBe("bookmark");
    expect(page2?.sheetTitle).toBe("Floor Plans");
  });
});
