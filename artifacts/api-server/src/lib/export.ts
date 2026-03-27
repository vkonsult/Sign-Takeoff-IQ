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

export async function buildExcelExport(
  signs: ExtractedSign[],
  jobId: string,
  outputPath: string
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

  await workbook.xlsx.writeFile(outputPath);
}
