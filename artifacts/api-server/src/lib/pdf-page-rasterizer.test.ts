import { describe, it, expect } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { PDFDocument, rgb } from "pdf-lib";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Create a minimal single-page PDF in memory using pdf-lib.
 * Returns a Buffer containing the raw PDF bytes.
 */
async function createMinimalPdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]); // US Letter (8.5 × 11 in at 72 dpi)
  page.drawRectangle({ x: 50, y: 50, width: 512, height: 692, color: rgb(0.9, 0.9, 0.9) });
  const bytes = await doc.save();
  return Buffer.from(bytes);
}

async function makeTmpPdf(): Promise<{ tmpDir: string; pdfPath: string }> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rasterize-test-"));
  const pdfPath = path.join(tmpDir, "test.pdf");
  await fs.writeFile(pdfPath, await createMinimalPdf());
  return { tmpDir, pdfPath };
}

describe("rasterizePage", () => {
  it("renders page 1 to a PNG file that exists and has a .png extension", async () => {
    const { rasterizePage } = await import("./pdf-page-rasterizer");
    const { tmpDir, pdfPath } = await makeTmpPdf();
    const outputDir = path.join(tmpDir, "output");

    try {
      const result = await rasterizePage(pdfPath, 1, outputDir);

      expect(result).toMatch(/page-1\.png$/);
      expect(path.extname(result)).toBe(".png");
      const stat = await fs.stat(result);
      expect(stat.isFile()).toBe(true);
      expect(stat.size).toBeGreaterThan(0);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("output file starts with the PNG signature bytes (89 50 4E 47)", async () => {
    const { rasterizePage } = await import("./pdf-page-rasterizer");
    const { tmpDir, pdfPath } = await makeTmpPdf();
    const outputDir = path.join(tmpDir, "output-sig");

    try {
      const result = await rasterizePage(pdfPath, 1, outputDir);

      const buf = await fs.readFile(result);
      const header = buf.slice(0, 8);
      expect(header.equals(PNG_SIGNATURE)).toBe(true);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("rendered dimensions stay within the maxPixels ceiling", async () => {
    const { rasterizePage } = await import("./pdf-page-rasterizer");
    const { loadImage } = await import("@napi-rs/canvas");
    const { tmpDir, pdfPath } = await makeTmpPdf();
    const outputDir = path.join(tmpDir, "output-capped");
    const maxPixels = 100_000;

    try {
      const result = await rasterizePage(pdfPath, 1, outputDir, { maxPixels });

      const buf = await fs.readFile(result);
      const img = await loadImage(buf);
      const totalPixels = img.width * img.height;
      // Allow a small rounding margin (1 pixel per dimension)
      const margin = img.width + img.height;
      expect(totalPixels).toBeLessThanOrEqual(maxPixels + margin);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("second call returns the cached path without re-rendering (mtime unchanged)", async () => {
    const { rasterizePage } = await import("./pdf-page-rasterizer");
    const { tmpDir, pdfPath } = await makeTmpPdf();
    const outputDir = path.join(tmpDir, "output-cache");

    try {
      const first = await rasterizePage(pdfPath, 1, outputDir);
      const statBefore = await fs.stat(first);

      // Brief pause so that a re-write would produce a different mtime
      await new Promise((r) => setTimeout(r, 50));

      const second = await rasterizePage(pdfPath, 1, outputDir);
      const statAfter = await fs.stat(second);

      expect(second).toBe(first);
      expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
