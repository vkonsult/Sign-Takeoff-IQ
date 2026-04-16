export interface ExportButtonStateInput {
  extractedSigns: Array<{ pageNumber?: number | null }>;
  plaqueCount: number;
  loadsCount: number;
  assemblyRoomsCount: number;
  isProcessingNow: boolean;
  supplementalDataLoading: boolean;
  exportingPdf: boolean;
  hasNoMapData: boolean;
}

export interface SingleExportButtonState {
  disabled: boolean;
  tooltip: string;
  showBadge: boolean;
}

export interface ExportButtonStateResult {
  xlsx: SingleExportButtonState;
  pdf: SingleExportButtonState;
}

export function useExportButtonState(input: ExportButtonStateInput): ExportButtonStateResult {
  const {
    extractedSigns,
    plaqueCount,
    loadsCount,
    assemblyRoomsCount,
    isProcessingNow,
    supplementalDataLoading,
    exportingPdf,
    hasNoMapData,
  } = input;

  // ── XLSX button ──────────────────────────────────────────────────────────
  const hasNoSigns = extractedSigns.length === 0;
  const hasPartialData = plaqueCount > 0 || loadsCount > 0 || assemblyRoomsCount > 0;
  const hasNoData = !supplementalDataLoading && hasNoSigns && !hasPartialData;
  const exportDisabled = isProcessingNow || supplementalDataLoading || hasNoData;
  const showXlsxBadge = hasNoSigns && hasPartialData && !exportDisabled;

  let xlsxTooltip: string;
  if (exportDisabled) {
    if (isProcessingNow) {
      xlsxTooltip =
        "Job is still processing — wait for extraction to finish before exporting";
    } else if (supplementalDataLoading) {
      xlsxTooltip = "Loading data…";
    } else {
      xlsxTooltip = "No sign, plaque, or occupant load data to export";
    }
  } else if (showXlsxBadge) {
    xlsxTooltip =
      "Partial export — no sign takeoff rows found. File will contain plaque/occupant load data only.";
  } else {
    xlsxTooltip = "Download sign takeoff data as an Excel spreadsheet";
  }

  // ── PDF button ───────────────────────────────────────────────────────────
  const placedCount = extractedSigns.filter((s) => s.pageNumber != null).length;
  const unplacedCount = extractedSigns.length - placedCount;
  const noneArePlaced = extractedSigns.length > 0 && placedCount === 0;
  const someAreUnplaced =
    extractedSigns.length > 0 && unplacedCount > 0 && placedCount > 0;
  const showPdfBadge =
    !exportingPdf && !isProcessingNow && (noneArePlaced || someAreUnplaced);

  let pdfTooltip: string;
  if (isProcessingNow) {
    pdfTooltip =
      "Job is still processing — wait for extraction to finish before exporting";
  } else if (noneArePlaced) {
    pdfTooltip =
      "Partial export — signs exist but none have floor plan locations. The PDF will have no markers.";
  } else if (someAreUnplaced) {
    const total = extractedSigns.length;
    pdfTooltip = `Partial export — ${unplacedCount} of ${total} sign${total !== 1 ? "s" : ""} ${unplacedCount !== 1 ? "are" : "is"} not placed on the floor plan and will be missing from the PDF.`;
  } else if (hasNoMapData) {
    pdfTooltip =
      "No signs have floor plan locations — nothing to mark on the PDF";
  } else {
    pdfTooltip =
      "Download the original PDF with sign markers drawn on each floor plan page";
  }

  return {
    xlsx: {
      disabled: exportDisabled,
      tooltip: xlsxTooltip,
      showBadge: showXlsxBadge,
    },
    pdf: {
      disabled: exportingPdf || hasNoMapData,
      tooltip: pdfTooltip,
      showBadge: showPdfBadge,
    },
  };
}
