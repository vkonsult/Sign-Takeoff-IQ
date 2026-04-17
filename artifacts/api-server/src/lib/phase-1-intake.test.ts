import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  classifyFileType,
  extractFloorLevelName,
  extractTitleBlockBuildingType,
  runPhase1Intake,
} from "./phase-1-intake";
import type { PdfPhrase } from "./pdf-words";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Phrase centred in the title-block zone (cx > 0.60, cy > 0.60). */
function tbPhrase(text: string, cx = 0.80, cy = 0.80): PdfPhrase {
  const half = 0.05;
  return { text, x0: cx - half, x1: cx + half, y0: cy - half, y1: cy + half };
}

/** Phrase outside the title-block zone. */
function bodyPhrase(text: string): PdfPhrase {
  return { text, x0: 0.05, x1: 0.25, y0: 0.05, y1: 0.15 };
}

// ── classifyFileType ──────────────────────────────────────────────────────────

describe("classifyFileType — CSI 10-14 patterns", () => {
  it.each([
    ["10-14-00 Signage Spec.pdf"],
    ["10_14_00 Signs.pdf"],
    ["101400 Signs and Directories.pdf"],
    ["DIV 10 14 Signage.pdf"],
    ["Section 10 14 00.pdf"],
  ])('classifies "%s" as spec', (filename) => {
    expect(classifyFileType(filename)).toBe("spec");
  });
});

describe("classifyFileType — spec/specification + sign patterns", () => {
  it.each([
    ["Sign Specifications.pdf"],
    ["Signage Spec.pdf"],
    ["Specifications - Signage Package.pdf"],
    ["sign_spec_rev2.pdf"],
    ["Interior Signage Specification.pdf"],
  ])('classifies "%s" as spec', (filename) => {
    expect(classifyFileType(filename)).toBe("spec");
  });
});

describe("classifyFileType — plain drawing filenames", () => {
  it.each([
    ["Floor Plan Level 1.pdf"],
    ["Architectural Drawings.pdf"],
    ["A101 - Site Plan.pdf"],
    ["Construction Documents.pdf"],
    ["drawings_set_2024.pdf"],
    ["Sheet Index.pdf"],
  ])('classifies "%s" as data', (filename) => {
    expect(classifyFileType(filename)).toBe("data");
  });
});

describe("classifyFileType — edge cases", () => {
  it("classifies a filename containing spec but no sign as data", () => {
    expect(classifyFileType("Mechanical Specifications.pdf")).toBe("data");
  });

  it("classifies a filename containing sign but no spec keyword as data", () => {
    expect(classifyFileType("Existing Sign Locations.pdf")).toBe("data");
  });

  it("handles empty string without throwing", () => {
    expect(classifyFileType("")).toBe("data");
  });

  it("is case-insensitive — SIGN SPECIFICATION.PDF", () => {
    expect(classifyFileType("SIGN SPECIFICATION.PDF")).toBe("spec");
  });
});

// ── extractFloorLevelName ─────────────────────────────────────────────────────

describe("extractFloorLevelName", () => {
  it("returns null for empty phrase list", () => {
    expect(extractFloorLevelName([])).toBeNull();
  });

  it("detects 'first floor' from title-block phrase", () => {
    const phrases = [tbPhrase("FIRST FLOOR PLAN")];
    expect(extractFloorLevelName(phrases)).toBe("first floor");
  });

  it("detects 'second floor' from title-block phrase", () => {
    const phrases = [tbPhrase("SECOND FLOOR PLAN")];
    expect(extractFloorLevelName(phrases)).toBe("second floor");
  });

  it("detects 'basement' from title-block phrase", () => {
    const phrases = [tbPhrase("BASEMENT LEVEL")];
    expect(extractFloorLevelName(phrases)).toBe("basement");
  });

  it("detects 'main level' from title-block phrase", () => {
    const phrases = [tbPhrase("MAIN LEVEL - OVERALL")];
    expect(extractFloorLevelName(phrases)).toBe("main level");
  });

  it("prefers title-block phrases over body phrases", () => {
    const phrases = [
      bodyPhrase("SECOND FLOOR PLAN"),
      tbPhrase("FIRST FLOOR PLAN"),
    ];
    // title-block zone wins; second floor text is in body only
    expect(extractFloorLevelName(phrases)).toBe("first floor");
  });

  it("falls back to body phrases when no title-block phrases exist", () => {
    const phrases = [bodyPhrase("GROUND FLOOR PLAN")];
    expect(extractFloorLevelName(phrases)).toBe("ground floor");
  });

  it("returns null when no canonical level name is found", () => {
    const phrases = [tbPhrase("ELEVATION A-101")];
    expect(extractFloorLevelName(phrases)).toBeNull();
  });
});

// ── extractTitleBlockBuildingType ─────────────────────────────────────────────

describe("extractTitleBlockBuildingType", () => {
  it("returns null for empty phrase list", () => {
    expect(extractTitleBlockBuildingType([])).toBeNull();
  });

  it("detects 'church' from a title-block phrase containing the word church", () => {
    const phrases = [tbPhrase("First Church of Springfield")];
    expect(extractTitleBlockBuildingType(phrases)).toBe("church");
  });

  it("detects 'church' from a title-block phrase containing 'chapel'", () => {
    const phrases = [tbPhrase("Heritage Chapel Parish")];
    expect(extractTitleBlockBuildingType(phrases)).toBe("church");
  });

  it("detects 'office' from a title-block phrase containing 'tower'", () => {
    const phrases = [tbPhrase("One Commerce Tower Office Park")];
    expect(extractTitleBlockBuildingType(phrases)).toBe("office");
  });

  it("returns null when phrases contain no recognisable building type keyword", () => {
    const phrases = [tbPhrase("PROJECT ALPHA - GENERAL NOTES")];
    expect(extractTitleBlockBuildingType(phrases)).toBeNull();
  });

  it("uses body phrases as fallback when no title-block phrases exist", () => {
    const phrases = [bodyPhrase("First Church of Springfield")];
    expect(extractTitleBlockBuildingType(phrases)).toBe("church");
  });
});

// ── runPhase1Intake (integration, mocked I/O) ─────────────────────────────────

vi.mock("./pdf-words", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pdf-words")>();
  return {
    ...actual,
    getPdfPageCount: vi.fn(),
    extractPagePhrases: vi.fn(),
  };
});

describe("runPhase1Intake — integration tests with mocked PDF I/O", () => {
  let getPdfPageCount: ReturnType<typeof vi.fn>;
  let extractPagePhrases: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const mod = await import("./pdf-words");
    getPdfPageCount = mod.getPdfPageCount as ReturnType<typeof vi.fn>;
    extractPagePhrases = mod.extractPagePhrases as ReturnType<typeof vi.fn>;
    getPdfPageCount.mockReset();
    extractPagePhrases.mockReset();
  });

  it("classifies a spec file and returns fileType='spec'", async () => {
    getPdfPageCount.mockResolvedValue(1);
    extractPagePhrases.mockResolvedValue({ phrases: [] });

    const result = await runPhase1Intake("/tmp/fake.pdf", "10-14-00 Signage.pdf");
    expect(result.fileType).toBe("spec");
  });

  it("classifies a drawing file and returns fileType='data'", async () => {
    getPdfPageCount.mockResolvedValue(1);
    extractPagePhrases.mockResolvedValue({ phrases: [] });

    const result = await runPhase1Intake("/tmp/fake.pdf", "Floor Plans.pdf");
    expect(result.fileType).toBe("data");
  });

  it("extracts project name from title-block text on page 1", async () => {
    getPdfPageCount.mockResolvedValue(2);
    extractPagePhrases.mockResolvedValue({
      phrases: [tbPhrase("Project Name: Riverside Community Center")],
    });

    const result = await runPhase1Intake("/tmp/fake.pdf", "drawings.pdf");
    expect(result.projectName).toBe("Riverside Community Center");
  });

  it("extracts jurisdiction from title-block text", async () => {
    getPdfPageCount.mockResolvedValue(1);
    extractPagePhrases.mockResolvedValue({
      phrases: [tbPhrase("AHJ: City of Portland")],
    });

    const result = await runPhase1Intake("/tmp/fake.pdf", "drawings.pdf");
    expect(result.jurisdiction).toBe("City of Portland");
  });

  it("extracts issue date in numeric format", async () => {
    getPdfPageCount.mockResolvedValue(1);
    extractPagePhrases.mockResolvedValue({
      phrases: [tbPhrase("Issue Date: 03/15/2024")],
    });

    const result = await runPhase1Intake("/tmp/fake.pdf", "drawings.pdf");
    expect(result.issueDate).toBe("03/15/2024");
  });

  it("extracts issue date in written format", async () => {
    getPdfPageCount.mockResolvedValue(1);
    extractPagePhrases.mockResolvedValue({
      phrases: [tbPhrase("Issued: March 15, 2024")],
    });

    const result = await runPhase1Intake("/tmp/fake.pdf", "drawings.pdf");
    expect(result.issueDate).toBe("March 15, 2024");
  });

  it("detects drawing index page when 'sheet list' appears", async () => {
    getPdfPageCount.mockResolvedValue(3);
    extractPagePhrases.mockImplementation(
      async (_path: string, _key: string, pageNum: number) => {
        if (pageNum === 2) {
          return { phrases: [{ text: "Sheet List", x0: 0.1, x1: 0.4, y0: 0.1, y1: 0.2 }] };
        }
        return { phrases: [] };
      },
    );

    const result = await runPhase1Intake("/tmp/fake.pdf", "drawings.pdf");
    expect(result.drawingIndexPageNum).toBe(2);
  });

  it("returns drawingIndexPageNum=null when no drawing index phrase found", async () => {
    getPdfPageCount.mockResolvedValue(2);
    extractPagePhrases.mockResolvedValue({ phrases: [tbPhrase("General Notes")] });

    const result = await runPhase1Intake("/tmp/fake.pdf", "drawings.pdf");
    expect(result.drawingIndexPageNum).toBeNull();
  });

  it("collects level names across all pages and sorts them canonically", async () => {
    getPdfPageCount.mockResolvedValue(3);
    extractPagePhrases.mockImplementation(
      async (_path: string, _key: string, pageNum: number) => {
        if (pageNum === 1) return { phrases: [tbPhrase("SECOND FLOOR PLAN")] };
        if (pageNum === 2) return { phrases: [tbPhrase("FIRST FLOOR PLAN")] };
        return { phrases: [] };
      },
    );

    const result = await runPhase1Intake("/tmp/fake.pdf", "drawings.pdf");
    expect(result.levelNames).toEqual(["first floor", "second floor"]);
    expect(result.levelCount).toBe(2);
  });

  it("populates pageToLevelName correctly", async () => {
    getPdfPageCount.mockResolvedValue(2);
    extractPagePhrases.mockImplementation(
      async (_path: string, _key: string, pageNum: number) => {
        if (pageNum === 1) return { phrases: [tbPhrase("BASEMENT LEVEL")] };
        if (pageNum === 2) return { phrases: [tbPhrase("MAIN LEVEL")] };
        return { phrases: [] };
      },
    );

    const result = await runPhase1Intake("/tmp/fake.pdf", "drawings.pdf");
    expect(result.pageToLevelName[1]).toBe("basement");
    expect(result.pageToLevelName[2]).toBe("main level");
  });

  it("returns levelCount=0 and empty levelNames for a spec file with no floor info", async () => {
    getPdfPageCount.mockResolvedValue(1);
    extractPagePhrases.mockResolvedValue({ phrases: [] });

    const result = await runPhase1Intake("/tmp/fake.pdf", "10-14-00.pdf");
    expect(result.levelCount).toBe(0);
    expect(result.levelNames).toEqual([]);
    expect(result.pageToLevelName).toEqual({});
  });

  it("uses fileId as cache key when provided", async () => {
    getPdfPageCount.mockResolvedValue(1);
    extractPagePhrases.mockResolvedValue({ phrases: [] });

    await runPhase1Intake("/tmp/fake.pdf", "drawings.pdf", "file-abc-123");

    expect(extractPagePhrases).toHaveBeenCalledWith(
      "/tmp/fake.pdf",
      "file-abc-123",
      expect.any(Number),
    );
  });

  it("falls back to filePath as cache key when no fileId provided", async () => {
    getPdfPageCount.mockResolvedValue(1);
    extractPagePhrases.mockResolvedValue({ phrases: [] });

    await runPhase1Intake("/tmp/test/file.pdf", "drawings.pdf");

    expect(extractPagePhrases).toHaveBeenCalledWith(
      "/tmp/test/file.pdf",
      "/tmp/test/file.pdf",
      expect.any(Number),
    );
  });

  it("returns classification-only result when PDF read fails entirely", async () => {
    getPdfPageCount.mockRejectedValue(new Error("PDF not found"));

    const result = await runPhase1Intake("/tmp/missing.pdf", "10-14-00 Signs.pdf");
    expect(result.fileType).toBe("spec");
    expect(result.projectName).toBeNull();
    expect(result.jurisdiction).toBeNull();
    expect(result.issueDate).toBeNull();
    expect(result.levelCount).toBe(0);
    expect(result.drawingIndexPageNum).toBeNull();
  });

  it("continues processing remaining pages when one page extraction fails", async () => {
    getPdfPageCount.mockResolvedValue(3);
    extractPagePhrases.mockImplementation(
      async (_path: string, _key: string, pageNum: number) => {
        if (pageNum === 1) throw new Error("bad page");
        if (pageNum === 2) return { phrases: [tbPhrase("Project Name: Test Building")] };
        return { phrases: [] };
      },
    );

    const result = await runPhase1Intake("/tmp/fake.pdf", "drawings.pdf");
    expect(result.projectName).toBe("Test Building");
  });

  it("'first page wins' — project name from page 1 is not overwritten by page 2", async () => {
    getPdfPageCount.mockResolvedValue(2);
    extractPagePhrases.mockImplementation(
      async (_path: string, _key: string, pageNum: number) => {
        if (pageNum === 1) {
          return { phrases: [tbPhrase("Project Name: Alpha Campus")] };
        }
        return { phrases: [tbPhrase("Project Name: Beta Tower")] };
      },
    );

    const result = await runPhase1Intake("/tmp/fake.pdf", "drawings.pdf");
    expect(result.projectName).toBe("Alpha Campus");
  });
});
