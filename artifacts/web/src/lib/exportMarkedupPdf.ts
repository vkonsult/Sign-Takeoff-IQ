import { PDFDocument, rgb, StandardFonts, PDFPage } from "pdf-lib";
import { apiFetch } from "./apiClient";
import { normalizedToMediaBox } from "./pdfCoords";

export interface MarkerSign {
  id: string;
  pageNumber: number | null | undefined;
  xPos: number | null | undefined;
  yPos: number | null | undefined;
  signIdentifier: string | null | undefined;
  signType: string | null | undefined;
  sheetNumber: string | null | undefined;
  manuallyAdded: boolean | null | undefined;
  userVerified: boolean | null | undefined;
}

export interface FileEntry {
  id: string;
  originalName: string;
}

// ── Sign type color palette (matches FloorPlanViewer) ────────────────────────
export const SIGN_TYPE_COLORS: Record<string, [number, number, number]> = {
  wayfinding:          [0.231, 0.510, 0.965],
  directional:         [0.063, 0.725, 0.506],
  informational:       [0.024, 0.714, 0.831],
  regulatory:          [0.937, 0.267, 0.267],
  safety:              [0.976, 0.604, 0.094],
  exit:                [0.863, 0.149, 0.149],
  ada:                 [0.545, 0.361, 0.965],
  accessibility:       [0.545, 0.361, 0.965],
  "room id":           [0.965, 0.620, 0.043],
  "building id":       [0.388, 0.400, 0.945],
  monument:            [0.471, 0.443, 0.424],
  pylon:               [0.471, 0.443, 0.424],
  parking:             [0.925, 0.318, 0.600],
  restroom:            [0.925, 0.318, 0.600],
  "channel letter":    [0.518, 0.800, 0.086],
  cabinet:             [0.078, 0.722, 0.647],
  "dimensional letter":[0.655, 0.545, 0.980],
  "building sign":     [0.388, 0.400, 0.945],
};

export function getSignColor(signType: string | null | undefined): [number, number, number] {
  if (!signType) return [0.420, 0.447, 0.502];
  const key = signType.toLowerCase();
  for (const [k, v] of Object.entries(SIGN_TYPE_COLORS)) {
    if (key.includes(k)) return v;
  }
  return [0.420, 0.447, 0.502];
}


export async function exportMarkedupPdf(
  jobId: string,
  jobName: string,
  files: FileEntry[],
  signs: MarkerSign[]
): Promise<void> {
  const mergedPdf = await PDFDocument.create();

  for (const file of files) {
    const response = await apiFetch(`/api/jobs/${jobId}/files/${file.id}/pdf`);
    if (!response.ok) throw new Error(`Failed to fetch PDF for file ${file.id}`);
    const pdfBytes = await response.arrayBuffer();

    const srcDoc = await PDFDocument.load(pdfBytes);
    const regularFont = await srcDoc.embedFont(StandardFonts.Helvetica);

    const fileSigns = signs.filter(
      (s) => s.xPos != null && s.yPos != null && s.pageNumber != null
    );

    const pageCount = srcDoc.getPageCount();

    for (let pageIdx = 0; pageIdx < pageCount; pageIdx++) {
      const page = srcDoc.getPage(pageIdx);
      const { width, height } = page.getSize();
      const pageNumber = pageIdx + 1;

      const pageMarkers = fileSigns.filter((s) => s.pageNumber === pageNumber);
      if (pageMarkers.length === 0) continue;

      const rotationDeg = page.getRotation().angle;
      drawMarkersOnPage(page, pageMarkers, width, height, rotationDeg, regularFont);
    }

    const copiedPages = await mergedPdf.copyPages(srcDoc, srcDoc.getPageIndices());
    for (const pg of copiedPages) {
      mergedPdf.addPage(pg);
    }
  }

  const pdfBytes = await mergedPdf.save();
  triggerDownload(pdfBytes, `${sanitizeFileName(jobName)}_marked-up.pdf`);
}

function drawMarkersOnPage(
  page: PDFPage,
  markers: MarkerSign[],
  pageWidth: number,
  pageHeight: number,
  rotationDeg: number,
  regularFont: ReturnType<PDFDocument["embedFont"]> extends Promise<infer T> ? T : never
) {
  // Collect unique sign types on this page for the legend
  const seenTypes = new Set<string>();

  for (const sign of markers) {
    if (sign.xPos == null || sign.yPos == null) continue;

    const { x, y } = normalizedToMediaBox(sign.xPos, sign.yPos, pageWidth, pageHeight, rotationDeg);
    const [r, g, b] = getSignColor(sign.signType);

    // Simple solid filled dot — no border, no label
    page.drawCircle({
      x,
      y,
      size: 4,
      color: rgb(r, g, b),
      opacity: 1,
    });

    if (sign.signType) seenTypes.add(sign.signType);
  }

  // ── Compact legend (bottom-left) ────────────────────────────────────────────
  const legendTypes = [...seenTypes].sort();
  if (legendTypes.length === 0) return;

  const rowH = 9;
  const legendW = 100;
  const legendH = legendTypes.length * rowH + 8;
  const legendX = 8;
  const legendY = 8;

  page.drawRectangle({
    x: legendX - 2,
    y: legendY - 2,
    width: legendW,
    height: legendH,
    color: rgb(0.10, 0.10, 0.10),
    opacity: 0.72,
    borderColor: rgb(0.28, 0.28, 0.28),
    borderWidth: 0.5,
  });

  legendTypes.forEach((signType, i) => {
    const [r, g, b] = getSignColor(signType);
    const iy = legendY + i * rowH + 4;
    page.drawCircle({
      x: legendX + 4,
      y: iy,
      size: 3,
      color: rgb(r, g, b),
      opacity: 1,
    });
    page.drawText(signType, {
      x: legendX + 10,
      y: iy - 2.5,
      size: 5,
      font: regularFont,
      color: rgb(0.88, 0.88, 0.88),
    });
  });
}

function triggerDownload(bytes: Uint8Array, fileName: string) {
  const blob = new Blob([bytes], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function sanitizeFileName(name: string): string {
  return name.replace(/[^a-z0-9_\-. ]/gi, "_").replace(/\s+/g, "_").slice(0, 80);
}
