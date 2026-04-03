import { PDFDocument, rgb, StandardFonts, PDFPage } from "pdf-lib";
import { apiFetch } from "./apiClient";

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

/**
 * Convert normalised marker coordinates (nx ∈ [0,1] left→right,
 * ny ∈ [0,1] top→bottom in viewport / screen space) to pdf-lib drawing
 * coordinates (x, y in MediaBox space: origin bottom-left, y upward).
 *
 * pdf-lib's page.getSize() returns the raw MediaBox dimensions WITHOUT
 * accounting for the page's /Rotate attribute.  Drawing commands operate in
 * that same unrotated space, so we must un-apply the rotation ourselves.
 *
 * Derivation (for a MediaBox [0,0,W,H]):
 *   /Rotate 0:   x = nx*W,       y = (1−ny)*H
 *   /Rotate 90:  x = (1−ny)*W,   y = (1−nx)*H   (landscape: display w=H,h=W)
 *   /Rotate 180: x = (1−nx)*W,   y = ny*H
 *   /Rotate 270: x = ny*W,       y = nx*H        (landscape: display w=H,h=W)
 */
function normalizedToMediaBox(
  nx: number,
  ny: number,
  W: number,
  H: number,
  rotationDeg: number,
): { x: number; y: number } {
  const r = ((rotationDeg % 360) + 360) % 360;
  switch (r) {
    case 90:  return { x: (1 - ny) * W, y: (1 - nx) * H };
    case 180: return { x: (1 - nx) * W, y: ny * H };
    case 270: return { x: ny * W,       y: nx * H };
    default:  return { x: nx * W,       y: (1 - ny) * H };
  }
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
    const helveticaBold = await srcDoc.embedFont(StandardFonts.HelveticaBold);
    const helvetica = await srcDoc.embedFont(StandardFonts.Helvetica);

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
      drawMarkersOnPage(page, pageMarkers, width, height, rotationDeg, helveticaBold, helvetica);
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
  boldFont: ReturnType<PDFDocument["embedFont"]> extends Promise<infer T> ? T : never,
  regularFont: ReturnType<PDFDocument["embedFont"]> extends Promise<infer T> ? T : never
) {
  for (const sign of markers) {
    if (sign.xPos == null || sign.yPos == null) continue;

    const { x, y } = normalizedToMediaBox(sign.xPos, sign.yPos, pageWidth, pageHeight, rotationDeg);

    let r: number, g: number, b: number;
    if (sign.userVerified) {
      r = 0.133; g = 0.773; b = 0.369;
    } else if (sign.manuallyAdded) {
      r = 0.659; g = 0.333; b = 0.969;
    } else {
      r = 0.918; g = 0.702; b = 0.031;
    }
    const markerColor = rgb(r, g, b);

    const outerR = 9;
    const innerR = 2.5;

    page.drawCircle({
      x,
      y,
      size: outerR,
      borderColor: markerColor,
      borderWidth: 1.2,
      opacity: 0.9,
      borderOpacity: 1,
      color: markerColor,
    });

    page.drawCircle({
      x,
      y,
      size: innerR,
      color: rgb(1, 1, 1),
      opacity: 1,
    });

    const label = sign.signIdentifier || sign.signType?.slice(0, 5) || "SIGN";
    const fontSize = 5.5;
    const textW = label.length * fontSize * 0.52;
    const labelX = x - textW / 2;
    const labelY = y + outerR + 2;

    page.drawRectangle({
      x: labelX - 1.5,
      y: labelY - 1,
      width: textW + 3,
      height: fontSize + 2.5,
      color: markerColor,
      opacity: 0.92,
      borderWidth: 0,
    });

    page.drawText(label, {
      x: labelX,
      y: labelY + 0.5,
      size: fontSize,
      font: boldFont,
      color: rgb(0.05, 0.05, 0.05),
    });
  }

  const legendItems = [
    { label: "AI Extracted", r: 0.918, g: 0.702, b: 0.031 },
    { label: "Manually Added", r: 0.659, g: 0.333, b: 0.969 },
    { label: "Verified", r: 0.133, g: 0.773, b: 0.369 },
  ];

  const legendX = 8;
  const legendY = 8;
  const rowH = 10;
  const legendW = 90;
  const legendH = legendItems.length * rowH + 8;

  page.drawRectangle({
    x: legendX - 2,
    y: legendY - 2,
    width: legendW,
    height: legendH,
    color: rgb(0.12, 0.12, 0.12),
    opacity: 0.75,
    borderColor: rgb(0.3, 0.3, 0.3),
    borderWidth: 0.5,
  });

  legendItems.forEach((item, i) => {
    const iy = legendY + i * rowH + 4;
    page.drawCircle({
      x: legendX + 4,
      y: iy,
      size: 3.5,
      color: rgb(item.r, item.g, item.b),
    });
    page.drawText(item.label, {
      x: legendX + 10,
      y: iy - 2.5,
      size: 5,
      font: regularFont,
      color: rgb(0.9, 0.9, 0.9),
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

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-z0-9_\-. ]/gi, "_").replace(/\s+/g, "_").slice(0, 80);
}
