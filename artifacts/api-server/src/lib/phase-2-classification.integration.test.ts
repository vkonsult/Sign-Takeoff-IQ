/**
 * Phase 2 Classification — Integration test against real Church Plan PDFs.
 *
 * STRUCTURE
 * ─────────
 * Part A — Fast title-classifier unit tests for the exact bookmark titles that
 *           appear in "Church Plan All Pages" (confirmed from the database
 *           page_stats record for job 395025a6).  These tests run in < 1 ms each
 *           and give immediate signal that the task-586 fix handles every Church
 *           Plan title correctly.
 *
 * Part B — Full-PDF integration tests (slow; requires RUN_SLOW_PDF_TESTS=1 and
 *           the PDF on disk).  These call buildSheetManifest and
 *           runPhase2Classification against the real 74 MB, 111-page PDF.
 *
 *           Run with:  RUN_SLOW_PDF_TESTS=1 vitest run phase-2-classification.integration.test.ts
 *
 * Part C — Regression test (fast, ~400 ms) against a second representative PDF
 *           ("4th_Floor_Union_at_Tower_Dist__1_.pdf", 1 page, no bookmarks) to
 *           confirm the title-block classification path is not regressed.
 *
 * Expected result for "Church Plan All Pages":
 *   - exactly 1 floor_plan page   (page 20: "A102 MAIN LEVEL: FLOOR PLAN")
 *   - exactly 0 signage_schedule pages
 *
 * This validates the fix from task-586 against the real document that first
 * exhibited the false-positive floor_plan / signage_schedule classifications.
 */

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { buildSheetManifest, classifyTitle } from "./sheet-manifest";
import { runPhase2Classification } from "./phase-2-classification";

// Part B slow tests only run when explicitly requested via env flag.
// Usage: RUN_SLOW_PDF_TESTS=1 vitest run phase-2-classification.integration.test.ts
const RUN_SLOW = !!process.env["RUN_SLOW_PDF_TESTS"];

// ── Helpers ────────────────────────────────────────────────────────────────────

const UPLOADS_DIR = path.resolve(
  import.meta.dirname,
  "../../data/uploads",
);

/**
 * Recursively searches `uploadsDir` for filenames matching `pattern` and
 * returns the full path of the most recently created file (highest numeric
 * timestamp prefix), or null if none found.
 */
function findMostRecentUpload(
  uploadsDir: string,
  pattern: RegExp,
): string | null {
  if (!fs.existsSync(uploadsDir)) return null;

  let best: { ts: number; filePath: string } | null = null;

  for (const jobDir of fs.readdirSync(uploadsDir)) {
    const jobPath = path.join(uploadsDir, jobDir);
    try {
      const stat = fs.statSync(jobPath);
      if (!stat.isDirectory()) continue;
    } catch {
      continue;
    }

    for (const filename of fs.readdirSync(jobPath)) {
      if (!pattern.test(filename)) continue;
      const match = filename.match(/^(\d+)-/);
      const ts = match ? parseInt(match[1], 10) : 0;
      if (!best || ts > best.ts) {
        best = { ts, filePath: path.join(jobPath, filename) };
      }
    }
  }

  return best?.filePath ?? null;
}

// ── Part A — Fast: Church Plan bookmark title classification ──────────────────
//
// These titles are the exact bookmark strings stored in "Church Plan All Pages"
// (confirmed via the database page_stats sheetManifest for job 395025a6).
// They should all pass without touching the file system.

describe("Phase 2 — Church Plan bookmark titles (fast, no PDF I/O)", () => {
  // The ONLY correct floor_plan page
  it('"A102 MAIN LEVEL: FLOOR PLAN" → floor_plan', () => {
    expect(classifyTitle("A102 MAIN LEVEL: FLOOR PLAN")).toBe("floor_plan");
  });

  // Foundation plan must be vetoed even though it contains "FLOOR PLAN"
  it('"A101 FOUNDATION LEVEL: FLOOR PLAN" → ignore (foundation veto)', () => {
    expect(classifyTitle("A101 FOUNDATION LEVEL: FLOOR PLAN")).toBe("ignore");
  });

  // Other plan types should NOT become floor_plan
  it('"A103 ROOF PLAN" → ignore (roof veto)', () => {
    expect(classifyTitle("A103 ROOF PLAN")).toBe("ignore");
  });

  it('"A104 FOUNDATION LEVEL: DIMENSIONAL PLAN" → ignore (foundation veto)', () => {
    expect(classifyTitle("A104 FOUNDATION LEVEL: DIMENSIONAL PLAN")).toBe("ignore");
  });

  it('"A106 MAIN LEVEL: CEILING PLAN" → ignore (ceiling/RCP veto)', () => {
    expect(classifyTitle("A106 MAIN LEVEL: CEILING PLAN")).toBe("ignore");
  });

  it('"A107 MAIN LEVEL: FINISH PLAN" → ignore (finish veto)', () => {
    expect(classifyTitle("A107 MAIN LEVEL: FINISH PLAN")).toBe("ignore");
  });

  // Elevation and section sheets must NOT match floor_plan (key fix in task-586)
  it('"A201 BUILDING ELEVATIONS" → other (not promoted by A-2xx sheet fallback)', () => {
    expect(classifyTitle("A201 BUILDING ELEVATIONS")).not.toBe("floor_plan");
  });

  it('"A301 BUILDING SECTIONS" → other (not promoted by A-3xx sheet fallback)', () => {
    expect(classifyTitle("A301 BUILDING SECTIONS")).not.toBe("floor_plan");
  });

  // Structural plans should stay ignore
  it('"S2.1 SECOND FLOOR/STAGE FRAMING PLAN" → ignore (framing veto)', () => {
    expect(classifyTitle("S2.1 SECOND FLOOR/STAGE FRAMING PLAN")).toBe("ignore");
  });

  it('"S2.0 FOUNDATION PLAN" → ignore (foundation veto)', () => {
    expect(classifyTitle("S2.0 FOUNDATION PLAN")).toBe("ignore");
  });

  // MEP plans should stay ignore
  it('"M-1.0 FIRST FLOOR MECHANICAL PLAN" → ignore (mechanical discipline veto)', () => {
    expect(classifyTitle("M-1.0 FIRST FLOOR MECHANICAL PLAN")).toBe("ignore");
  });

  it('"E-1.0 FIRST FLOOR POWER PLAN" → ignore (electrical discipline / power veto)', () => {
    expect(classifyTitle("E-1.0 FIRST FLOOR POWER PLAN")).toBe("ignore");
  });

  it('"P-1.0 FIRST FLOOR SANITARY PLAN" → ignore (plumbing discipline veto)', () => {
    expect(classifyTitle("P-1.0 FIRST FLOOR SANITARY PLAN")).toBe("ignore");
  });

  it('"FP-1.0 FIRST FLOOR FIRE PROTECTION PLAN" → ignore (fire protection veto)', () => {
    expect(classifyTitle("FP-1.0 FIRST FLOOR FIRE PROTECTION PLAN")).toBe("ignore");
  });

  // Signage schedule — must produce 0 (no such bookmark in this PDF)
  it('"G005 OCCUPANCY & EGRESS PLANS" → life_safety (not signage_schedule)', () => {
    expect(classifyTitle("G005 OCCUPANCY & EGRESS PLANS")).toBe("life_safety");
  });
});

// ── Part B — Full-PDF integration tests (slow; requires RUN_SLOW_PDF_TESTS=1) ──

describe("Phase 2 integration — Church Plan All Pages PDF", () => {
  const churchPlanPath = findMostRecentUpload(
    UPLOADS_DIR,
    /Church_Plan_All_Pages\.pdf$/i,
  );

  it.skipIf(!RUN_SLOW || churchPlanPath === null)(
    "produces exactly 1 floor_plan page and 0 signage_schedule pages",
    async () => {
      const manifest = await buildSheetManifest(churchPlanPath!, "church-plan-all-pages-integration");

      const floorPlanEntries = manifest.entries.filter(
        (e) => e.bucket === "floor_plan",
      );
      const signScheduleEntries = manifest.entries.filter(
        (e) => e.bucket === "signage_schedule",
      );

      expect(floorPlanEntries).toHaveLength(1);
      expect(signScheduleEntries).toHaveLength(0);
    },
    // Allow up to 5 minutes for the 111-page, 74 MB PDF
    300_000,
  );

  it.skipIf(!RUN_SLOW || churchPlanPath === null)(
    "the single floor_plan entry has a valid source, sheetTitle, and sheetNumber",
    async () => {
      const manifest = await buildSheetManifest(
        churchPlanPath!,
        "church-plan-all-pages-integration-detail",
      );

      const fpEntry = manifest.entries.find((e) => e.bucket === "floor_plan");

      expect(fpEntry).toBeDefined();

      // source must be one of the known values
      expect(["bookmark", "index_page", "title_block", "full_page_fallback", "excerpt_fallback"]).toContain(
        fpEntry!.source,
      );

      // sheetTitle must be a non-empty string containing "FLOOR PLAN"
      expect(typeof fpEntry!.sheetTitle).toBe("string");
      expect(fpEntry!.sheetTitle.trim().length).toBeGreaterThan(0);
      expect(fpEntry!.sheetTitle.toUpperCase()).toContain("FLOOR PLAN");

      // sheetNumber may be null for this doc but must not throw
      expect(fpEntry!.sheetNumber === null || typeof fpEntry!.sheetNumber === "string").toBe(true);
    },
    300_000,
  );

  it.skipIf(!RUN_SLOW || churchPlanPath === null)(
    "runPhase2Classification returns matching counts",
    async () => {
      const fakeIntakeResult = {
        fileType: "data" as const,
        projectName: null,
        jurisdiction: null,
        issueDate: null,
        levelCount: 0,
        levelNames: [],
        pageToLevelName: {},
        buildingType: null,
        drawingIndexPageNum: null,
      };

      const result = await runPhase2Classification(
        churchPlanPath!,
        "church-plan-all-pages-phase2",
        fakeIntakeResult,
      );

      expect(result.floorPlanPages).toHaveLength(1);
      expect(result.signSchedulePages).toHaveLength(0);
    },
    300_000,
  );
});

// ── Part C — Regression: title-block classification path (fast, ~400 ms) ───────
//
// Uses "4th_Floor_Union_at_Tower_Dist__1_.pdf" — a 1-page excerpt with a
// FLOOR PLAN title block and no bookmarks — to confirm that the title-block
// classification path still works after the bookmark-extraction changes.
//
// Expected: exactly 1 floor_plan, 0 signage_schedule.  Auto-skipped when the
// PDF is not present in data/uploads/.

describe("Phase 2 regression — 4th Floor Union at Tower (title-block path)", () => {
  const unionFloorPath = findMostRecentUpload(
    UPLOADS_DIR,
    /4th_Floor_Union_at_Tower_Dist__1_\.pdf$/i,
  );

  it.skipIf(unionFloorPath === null)(
    "single-page floor plan PDF without bookmarks → 1 floor_plan, 0 signage_schedule",
    async () => {
      const manifest = await buildSheetManifest(
        unionFloorPath!,
        "union-4th-floor-regression",
      );

      const fpEntries = manifest.entries.filter((e) => e.bucket === "floor_plan");
      const ssEntries = manifest.entries.filter((e) => e.bucket === "signage_schedule");

      expect(fpEntries).toHaveLength(1);
      expect(ssEntries).toHaveLength(0);

      // Title-block path confirmed: no bookmarks in this PDF
      expect(manifest.metadata?.fromBookmarks ?? 0).toBe(0);
      expect(fpEntries[0].source).toBe("title_block");
    },
    30_000,
  );
});
