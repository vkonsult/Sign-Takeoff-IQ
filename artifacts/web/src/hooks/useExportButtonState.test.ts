import { describe, expect, it } from "vitest";
import { useExportButtonState } from "./useExportButtonState";
import type { ExportButtonStateInput } from "./useExportButtonState";

const placedSign = { pageNumber: 1 };
const unplacedSign = { pageNumber: null };

function makeInput(overrides: Partial<ExportButtonStateInput> = {}): ExportButtonStateInput {
  return {
    extractedSigns: [],
    plaqueCount: 0,
    loadsCount: 0,
    assemblyRoomsCount: 0,
    isProcessingNow: false,
    supplementalDataLoading: false,
    exportingPdf: false,
    hasNoMapData: false,
    ...overrides,
  };
}

describe("useExportButtonState — xlsx", () => {
  it("is disabled with processing tooltip when job is still processing", () => {
    const { xlsx } = useExportButtonState(makeInput({ isProcessingNow: true }));
    expect(xlsx.disabled).toBe(true);
    expect(xlsx.tooltip).toMatch(/still processing/i);
    expect(xlsx.showBadge).toBe(false);
  });

  it("is disabled with loading tooltip while supplemental data loads", () => {
    const { xlsx } = useExportButtonState(
      makeInput({ supplementalDataLoading: true }),
    );
    expect(xlsx.disabled).toBe(true);
    expect(xlsx.tooltip).toMatch(/loading data/i);
    expect(xlsx.showBadge).toBe(false);
  });

  it("is disabled with no-data tooltip when there is nothing to export", () => {
    const { xlsx } = useExportButtonState(makeInput());
    expect(xlsx.disabled).toBe(true);
    expect(xlsx.tooltip).toMatch(/no sign, plaque/i);
    expect(xlsx.showBadge).toBe(false);
  });

  it("shows partial-export badge when signs are absent but supplemental data exists", () => {
    const { xlsx } = useExportButtonState(
      makeInput({ plaqueCount: 3 }),
    );
    expect(xlsx.disabled).toBe(false);
    expect(xlsx.showBadge).toBe(true);
    expect(xlsx.tooltip).toMatch(/partial export/i);
  });

  it("is enabled with normal tooltip when sign data is present", () => {
    const { xlsx } = useExportButtonState(
      makeInput({ extractedSigns: [placedSign] }),
    );
    expect(xlsx.disabled).toBe(false);
    expect(xlsx.showBadge).toBe(false);
    expect(xlsx.tooltip).toMatch(/download sign takeoff/i);
  });
});

describe("useExportButtonState — pdf", () => {
  it("is disabled with processing tooltip when job is still processing", () => {
    const { pdf } = useExportButtonState(
      makeInput({ isProcessingNow: true, hasNoMapData: true }),
    );
    expect(pdf.disabled).toBe(true);
    expect(pdf.tooltip).toMatch(/still processing/i);
    expect(pdf.showBadge).toBe(false);
  });

  it("is disabled with no-map-data tooltip when no signs are placed", () => {
    const { pdf } = useExportButtonState(makeInput({ hasNoMapData: true }));
    expect(pdf.disabled).toBe(true);
    expect(pdf.tooltip).toMatch(/no signs have floor plan locations/i);
    expect(pdf.showBadge).toBe(false);
  });

  it("shows badge and partial tooltip when none of the signs are placed", () => {
    const { pdf } = useExportButtonState(
      makeInput({ extractedSigns: [unplacedSign, unplacedSign] }),
    );
    expect(pdf.showBadge).toBe(true);
    expect(pdf.tooltip).toMatch(/none have floor plan locations/i);
  });

  it("shows badge and count tooltip when some signs are unplaced", () => {
    const { pdf } = useExportButtonState(
      makeInput({ extractedSigns: [placedSign, unplacedSign] }),
    );
    expect(pdf.showBadge).toBe(true);
    expect(pdf.tooltip).toMatch(/1 of 2/i);
    expect(pdf.tooltip).toMatch(/not placed/i);
  });

  it("is enabled with download tooltip when all signs are placed", () => {
    const { pdf } = useExportButtonState(
      makeInput({ extractedSigns: [placedSign, placedSign] }),
    );
    expect(pdf.disabled).toBe(false);
    expect(pdf.showBadge).toBe(false);
    expect(pdf.tooltip).toMatch(/download the original pdf/i);
  });

  it("is disabled while pdf is being exported", () => {
    const { pdf } = useExportButtonState(
      makeInput({ extractedSigns: [placedSign], exportingPdf: true }),
    );
    expect(pdf.disabled).toBe(true);
    expect(pdf.showBadge).toBe(false);
  });
});
