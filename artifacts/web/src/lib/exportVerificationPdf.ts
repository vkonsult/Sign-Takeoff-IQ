import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import { apiFetch } from "./apiClient";
import { normalizedToMediaBox } from "./pdfCoords";


export interface VerificationMarker {
  pageNumber: number;
  xPos: number;
  yPos: number;
  signIdentifier: string | null;
  signType: string | null;
  location: string | null;
  status: "matched" | "extra";
}

export interface MissedSign {
  signIdentifier: string | null;
  signType: string | null;
  location: string | null;
}

export async function exportVerificationPdf(
  jobId: string,
  fileId: string,
  jobName: string,
  markers: VerificationMarker[]
): Promise<void> {
  const response = await apiFetch(`/api/jobs/${jobId}/files/${fileId}/pdf`);
  if (!response.ok) throw new Error("Failed to fetch training PDF");
  const pdfBytes = await response.arrayBuffer();

  const doc = await PDFDocument.load(pdfBytes);
  const boldFont = await doc.embedFont(StandardFonts.HelveticaBold);
  const regularFont = await doc.embedFont(StandardFonts.Helvetica);

  const pageCount = doc.getPageCount();

  for (let pageIdx = 0; pageIdx < pageCount; pageIdx++) {
    const pageNum = pageIdx + 1;
    const pageMarkers = markers.filter(
      (m) => m.pageNumber === pageNum && m.xPos != null && m.yPos != null
    );
    if (pageMarkers.length === 0) continue;

    const page = doc.getPage(pageIdx);
    const { width, height } = page.getSize();
    const rotationDeg = page.getRotation().angle;

    for (const m of pageMarkers) {
      const { x, y } = normalizedToMediaBox(m.xPos, m.yPos, width, height, rotationDeg);

      const isMatched = m.status === "matched";
      const markerColor = isMatched
        ? rgb(0.133, 0.773, 0.369)
        : rgb(0.918, 0.702, 0.031);

      const outerR = 10;
      const innerR = 3;

      page.drawCircle({
        x, y,
        size: outerR,
        borderColor: markerColor,
        borderWidth: 1.5,
        opacity: 0.9,
        borderOpacity: 1,
        color: markerColor,
      });

      page.drawCircle({
        x, y,
        size: innerR,
        color: rgb(1, 1, 1),
        opacity: 1,
      });

      const label = m.signIdentifier || m.signType?.slice(0, 6) || "SIGN";
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
      { label: "Matched — AI found schedule sign", r: 0.133, g: 0.773, b: 0.369 },
      { label: "Extra — AI found, not in schedule", r: 0.918, g: 0.702, b: 0.031 },
    ];

    const legendX = 8;
    const legendY = 8;
    const rowH = 11;
    const legendW = 145;
    const legendH = legendItems.length * rowH + 10;

    page.drawRectangle({
      x: legendX - 2,
      y: legendY - 2,
      width: legendW,
      height: legendH,
      color: rgb(0.1, 0.1, 0.1),
      opacity: 0.8,
      borderColor: rgb(0.3, 0.3, 0.3),
      borderWidth: 0.5,
    });

    legendItems.forEach((item, i) => {
      const iy = legendY + i * rowH + 5;
      page.drawCircle({
        x: legendX + 5,
        y: iy,
        size: 4,
        color: rgb(item.r, item.g, item.b),
      });
      page.drawText(item.label, {
        x: legendX + 13,
        y: iy - 2.5,
        size: 5,
        font: regularFont,
        color: rgb(0.9, 0.9, 0.9),
      });
    });
  }

  const saved = await doc.save();
  const blob = new Blob([saved], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${jobName.replace(/[^a-z0-9_\-. ]/gi, "_")}_verification.pdf`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
