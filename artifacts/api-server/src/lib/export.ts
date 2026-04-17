import ExcelJS from "exceljs";
import type { ExtractedSign } from "@workspace/db";

const COLUMN_HEADERS = [
  { key: "sheet_number", header: "Sheet #", width: 12 },
  { key: "detail_reference", header: "Detail/Ref", width: 14 },
  { key: "sign_identifier", header: "Sign ID", width: 12 },
  { key: "sign_type", header: "Sign Type", width: 20 },
  { key: "quantity", header: "Qty", width: 8 },
  { key: "location", header: "Location", width: 28 },
  { key: "dimensions", header: "Dimensions", width: 16 },
  { key: "mounting_type", header: "Mounting Type", width: 20 },
  { key: "finish_color", header: "Finish / Color", width: 22 },
  { key: "illumination", header: "Illumination", width: 20 },
  { key: "materials", header: "Materials", width: 24 },
  { key: "message_content", header: "Message / Content", width: 32 },
  { key: "notes", header: "Notes", width: 30 },
  { key: "confidence_score", header: "Confidence", width: 12 },
  { key: "review_flag", header: "Review Flag", width: 14 },
];

const HEADER_FILL: ExcelJS.Fill = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FF1E3A5F" },
};

const HEADER_FONT: Partial<ExcelJS.Font> = {
  bold: true,
  color: { argb: "FFFFFFFF" },
  size: 11,
};

const REVIEW_FLAG_FILL: ExcelJS.Fill = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FFFFF3CD" },
};

const HIGH_CONFIDENCE_FILL: ExcelJS.Fill = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FFD4EDDA" },
};

export interface VerificationReportDetails {
  passed: boolean;
  errorDetails: string[];
  warningDetails: string[];
  questionDetails: string[];
  checksPassed: string[];
}

export async function buildExcelExport(
  signs: ExtractedSign[],
  jobId: string,
  outputPath: string,
  verificationReport?: VerificationReportDetails,
): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Sign Takeoff Portal";
  workbook.created = new Date();

  const sheet = workbook.addWorksheet("Sign Takeoff", {
    views: [{ state: "frozen", xSplit: 0, ySplit: 1 }],
  });

  sheet.columns = COLUMN_HEADERS.map((col) => ({
    header: col.header,
    key: col.key,
    width: col.width,
  }));

  const headerRow = sheet.getRow(1);
  headerRow.eachCell((cell) => {
    cell.fill = HEADER_FILL;
    cell.font = HEADER_FONT;
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: false };
    cell.border = {
      bottom: { style: "medium", color: { argb: "FF0D2137" } },
    };
  });
  headerRow.height = 22;

  signs.forEach((sign) => {
    const row = sheet.addRow({
      sheet_number: sign.sheetNumber ?? "",
      detail_reference: sign.detailReference ?? "",
      sign_identifier: sign.signIdentifier ?? "",
      sign_type: sign.signType ?? "",
      quantity: sign.quantity ?? "",
      location: sign.location ?? "",
      dimensions: sign.dimensions ?? "",
      mounting_type: sign.mountingType ?? "",
      finish_color: sign.finishColor ?? "",
      illumination: sign.illumination ?? "",
      materials: sign.materials ?? "",
      message_content: sign.messageContent ?? "",
      notes: sign.notes ?? "",
      confidence_score: sign.confidenceScore,
      review_flag: sign.reviewFlag ? "REVIEW" : "",
    });

    const isReview = sign.reviewFlag;
    const isHighConf = sign.confidenceScore >= 0.8;

    row.eachCell({ includeEmpty: true }, (cell, colNum) => {
      cell.alignment = { vertical: "top", wrapText: true };
      if (colNum === COLUMN_HEADERS.findIndex((c) => c.key === "review_flag") + 1) {
        if (isReview) {
          cell.font = { bold: true, color: { argb: "FF856404" } };
        }
      }
      if (isReview) {
        cell.fill = REVIEW_FLAG_FILL;
      } else if (isHighConf) {
        cell.fill = HIGH_CONFIDENCE_FILL;
      }
      cell.border = {
        bottom: { style: "thin", color: { argb: "FFD0D0D0" } },
      };
    });

    row.height = 18;
  });

  // ── Summary sheet ────────────────────────────────────────────────────────
  const summarySheet = workbook.addWorksheet("Summary");
  summarySheet.columns = [
    { header: "Metric", key: "metric", width: 30 },
    { header: "Value", key: "value", width: 20 },
  ];
  const summaryHeaderRow = summarySheet.getRow(1);
  summaryHeaderRow.eachCell((cell) => {
    cell.fill = HEADER_FILL;
    cell.font = HEADER_FONT;
    cell.alignment = { vertical: "middle", horizontal: "center" };
  });

  const totalSigns = signs.reduce((acc, s) => acc + (s.quantity ?? 1), 0);
  const reviewCount = signs.filter((s) => s.reviewFlag).length;
  const highConfCount = signs.filter((s) => s.confidenceScore >= 0.8).length;

  [
    { metric: "Job ID", value: jobId },
    { metric: "Export Date", value: new Date().toLocaleDateString() },
    { metric: "Total Sign Line Items", value: signs.length },
    { metric: "Total Sign Quantity", value: totalSigns },
    { metric: "High Confidence Items", value: highConfCount },
    { metric: "Items Flagged for Review", value: reviewCount },
  ].forEach((row) => {
    summarySheet.addRow(row);
  });

  // ── By Sign Type sheet ───────────────────────────────────────────────────
  // Group signs by Sign Type + Dimensions, sum quantity, collect unique sheets/floors
  type GroupRow = { signType: string; dimensions: string; qty: number; sheets: Set<string> };
  const groupMap = new Map<string, GroupRow>();
  for (const sign of signs) {
    const st = (sign.signType ?? "Unknown").trim();
    const dim = (sign.dimensions ?? "—").trim();
    const key = `${st}||${dim}`;
    const ex = groupMap.get(key);
    const qty = sign.quantity ?? 1;
    const sheet = sign.sheetNumber ?? null;
    if (ex) {
      ex.qty += qty;
      if (sheet) ex.sheets.add(sheet);
    } else {
      const sheets = new Set<string>();
      if (sheet) sheets.add(sheet);
      groupMap.set(key, { signType: st, dimensions: dim, qty, sheets });
    }
  }
  const groupRows = [...groupMap.values()].sort((a, b) =>
    a.signType.localeCompare(b.signType) || a.dimensions.localeCompare(b.dimensions)
  );

  const byTypeSheet = workbook.addWorksheet("By Sign Type");
  byTypeSheet.columns = [
    { header: "Sign Type",       key: "sign_type",   width: 26 },
    { header: "Size",            key: "dimensions",  width: 18 },
    { header: "Total Qty",       key: "qty",         width: 12 },
    { header: "Floors / Sheets", key: "sheets",      width: 32 },
  ];

  const byTypeHeader = byTypeSheet.getRow(1);
  byTypeHeader.eachCell((cell) => {
    cell.fill = HEADER_FILL;
    cell.font = HEADER_FONT;
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: false };
    cell.border = { bottom: { style: "medium", color: { argb: "FF0D2137" } } };
  });
  byTypeHeader.height = 22;

  let grandTotal = 0;
  groupRows.forEach((r, i) => {
    grandTotal += r.qty;
    const row = byTypeSheet.addRow({
      sign_type:  r.signType,
      dimensions: r.dimensions,
      qty:        r.qty,
      sheets:     [...r.sheets].sort().join(", ") || "—",
    });
    row.eachCell({ includeEmpty: true }, (cell) => {
      cell.alignment = { vertical: "middle", wrapText: true };
      cell.border = { bottom: { style: "thin", color: { argb: "FFD0D0D0" } } };
      if (i % 2 === 1) {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF5F5F5" } };
      }
    });
    row.height = 18;
  });

  // Grand total row
  const totalRow = byTypeSheet.addRow({ sign_type: "TOTAL", dimensions: "", qty: grandTotal, sheets: "" });
  totalRow.eachCell({ includeEmpty: true }, (cell) => {
    cell.font = { bold: true, size: 11 };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1E3A5F" } };
    cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
    cell.alignment = { vertical: "middle", horizontal: "center" };
  });
  totalRow.height = 20;

  // ── Verification Report sheet ─────────────────────────────────────────────
  if (verificationReport) {
    const vrSheet = workbook.addWorksheet("Verification Report", {
      views: [{ state: "frozen", xSplit: 0, ySplit: 1 }],
    });

    vrSheet.columns = [
      { header: "Check",   key: "check",   width: 36 },
      { header: "Status",  key: "status",  width: 10 },
      { header: "Detail",  key: "detail",  width: 72 },
    ];

    const vrHeaderRow = vrSheet.getRow(1);
    vrHeaderRow.eachCell((cell) => {
      cell.fill = HEADER_FILL;
      cell.font = HEADER_FONT;
      cell.alignment = { vertical: "middle", horizontal: "center", wrapText: false };
      cell.border = { bottom: { style: "medium", color: { argb: "FF0D2137" } } };
    });
    vrHeaderRow.height = 22;

    type VrRow = { check: string; status: string; detail: string; kind: "pass" | "error" | "warning" | "question" };
    const vrRows: VrRow[] = [];

    for (const msg of verificationReport.errorDetails) {
      const match = msg.match(/^(V\d+):/);
      vrRows.push({ check: match ? match[1] : "Error", status: "✗", detail: msg, kind: "error" });
    }
    for (const msg of verificationReport.warningDetails) {
      const match = msg.match(/^(V\d+):/);
      vrRows.push({ check: match ? match[1] : "Warning", status: "⚠", detail: msg, kind: "warning" });
    }
    for (const msg of verificationReport.questionDetails) {
      const match = msg.match(/^(V\d+):/);
      vrRows.push({ check: match ? match[1] : "Question", status: "?", detail: msg, kind: "question" });
    }
    for (const msg of verificationReport.checksPassed) {
      vrRows.push({ check: msg, status: "✓", detail: "Passed", kind: "pass" });
    }

    const ERROR_FILL: ExcelJS.Fill   = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF8D7DA" } };
    const WARNING_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF3CD" } };
    const QUESTION_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD1ECF1" } };
    const PASS_FILL: ExcelJS.Fill    = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD4EDDA" } };

    for (const vr of vrRows) {
      const row = vrSheet.addRow({ check: vr.check, status: vr.status, detail: vr.detail });
      const fill =
        vr.kind === "error"    ? ERROR_FILL :
        vr.kind === "warning"  ? WARNING_FILL :
        vr.kind === "question" ? QUESTION_FILL :
        PASS_FILL;
      row.eachCell({ includeEmpty: true }, (cell) => {
        cell.fill = fill;
        cell.alignment = { vertical: "top", wrapText: true };
        cell.border = { bottom: { style: "thin", color: { argb: "FFD0D0D0" } } };
      });
      row.height = 18;
    }

    // Overall result summary row at the bottom
    vrSheet.addRow({});
    const summaryRow = vrSheet.addRow({
      check: "Overall Result",
      status: verificationReport.passed ? "✓" : "✗",
      detail: verificationReport.passed
        ? "All checks passed"
        : `${verificationReport.errorDetails.length} error(s), ${verificationReport.warningDetails.length} warning(s), ${verificationReport.questionDetails.length} question(s) for review`,
    });
    summaryRow.eachCell({ includeEmpty: true }, (cell) => {
      cell.font = { bold: true, size: 11 };
      cell.fill = verificationReport.passed
        ? { type: "pattern", pattern: "solid", fgColor: { argb: "FF1E3A5F" } }
        : { type: "pattern", pattern: "solid", fgColor: { argb: "FF721C24" } };
      cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
      cell.alignment = { vertical: "middle", horizontal: "center" };
    });
    summaryRow.height = 20;
  }

  await workbook.xlsx.writeFile(outputPath);
}
