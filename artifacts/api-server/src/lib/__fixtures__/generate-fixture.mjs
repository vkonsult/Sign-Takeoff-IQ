/**
 * generate-fixture.mjs
 *
 * Generates the PDF fixture files used by signage-schedule-parser.test.ts.
 *
 * Usage:
 *   node artifacts/api-server/src/lib/__fixtures__/generate-fixture.mjs
 *
 * Outputs:
 *   sign-schedule-sample.pdf   — standard US Letter page (0° rotation)
 *   sign-schedule-rotated.pdf  — same content, page has /Rotate = 90
 *
 * Both fixtures contain the same logical schedule content so the parser
 * integration tests can verify correct output for both orientations.
 */

import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { writeFile } from "fs/promises";
import { PDFDocument, degrees, StandardFonts, rgb } from "pdf-lib";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Schedule content ──────────────────────────────────────────────────────────
// Logical layout expressed as [text, visual_x, visual_y] tuples.
// "visual" coordinates use a top-left origin, y increasing downward.
// For the unrotated fixture the page is 612 × 792 pt (US Letter portrait).
// Sections:
//   SIGN TYPE LEGEND → 1A Acrylic
//   SIGNAGE SCHEDULE → room 101 → sign row 1A 2 ROOM ID
//   KEYNOTES         → A  Field verify dimensions

/** @type {Array<[string, number, number]>} */
const CONTENT = [
  // text                    vis_x  vis_y
  ["SIGN TYPE LEGEND",        40,    50],
  ["1A",                      40,    80],
  ["Acrylic",                120,    80],
  ["SIGNAGE SCHEDULE",        40,   150],
  ["101",                     40,   180],
  ["1A",                      40,   210],
  ["2",                      120,   210],
  ["ROOM ID",                200,   210],
  ["KEYNOTES",                40,   330],
  ["A",                       40,   360],
  ["Field verify dimensions", 120,   360],
];

const FONT_SIZE = 12;

// ── Unrotated fixture (0°) ─────────────────────────────────────────────────────
// Page user space: 612 × 792 (portrait).
// pdf-lib origin is bottom-left, y pointing up.
// Conversion: x_pdf = vis_x,  y_pdf = pageHeight - vis_y
async function buildUnrotated() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);

  for (const [text, vx, vy] of CONTENT) {
    page.drawText(text, {
      x: vx,
      y: 792 - vy,
      size: FONT_SIZE,
      font,
      color: rgb(0, 0, 0),
    });
  }

  return doc.save();
}

// ── Rotated fixture (/Rotate = 90) ────────────────────────────────────────────
// Page user space: 612 × 792 (portrait MediaBox), but /Rotate = 90.
// pdfjs-dist with scale=1.0 returns viewport { width: 792, height: 612 }.
//
// For a page with /Rotate=90, pdfjs convertToViewportPoint maps:
//   vx = y_pdf_user    (user y → visual x, i.e. horizontal in the landscape viewport)
//   vy = x_pdf_user    (user x → visual y, i.e. vertical  in the landscape viewport)
//
// Real architectural PDFs with /Rotate=90 store text with a matching 90° rotation
// in the text transform matrix so that the glyphs read left-to-right in the
// visual viewport.  pdf-lib's drawText with `rotate: degrees(90)` emulates this:
//   - advance direction: user +y → viewport +x  (text advances rightward visually)
//   - height  direction: user -x → viewport -y  (glyph cap is above baseline visually)
//
// Viewport bounding box for a glyph drawn at user (x_pdf, y_pdf) with size=S:
//   vx: y_pdf  … y_pdf + advance_width
//   vy: x_pdf - S … x_pdf              (text sits above the baseline y-value)
//   vyC ≈ x_pdf - S/2
//
// To place content at visual position (vis_x, vis_y):
//   y_pdf = vis_x        → vx_start = vis_x  (left column in viewport)
//   x_pdf = vis_y + S/2  → vyC     ≈ vis_y   (correct visual row in viewport)
async function buildRotated() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  // Portrait MediaBox; /Rotate=90 makes it display as landscape (792 × 612 viewport).
  const page = doc.addPage([612, 792]);
  page.setRotation(degrees(90));

  for (const [text, vis_x, vis_y] of CONTENT) {
    // y_pdf = vis_x  → the text starts at viewport x = vis_x (correct column)
    // x_pdf = vis_y + FONT_SIZE/2  → viewport vyC ≈ vis_y (correct visual row)
    const y_pdf = vis_x;
    const x_pdf = vis_y + FONT_SIZE / 2;
    page.drawText(text, {
      x: x_pdf,
      y: y_pdf,
      size: FONT_SIZE,
      font,
      color: rgb(0, 0, 0),
      // 90° CCW rotation makes the text advance in user +y → viewport +x.
      // This is the same orientation that real CAD tools use when embedding
      // text on a /Rotate=90 drawing sheet, so pdfjs interprets the transform
      // matrix the same way it would for a real document.
      rotate: degrees(90),
    });
  }

  return doc.save();
}

// ── Write fixtures ────────────────────────────────────────────────────────────
const unrotatedBytes = await buildUnrotated();
const rotatedBytes = await buildRotated();

const unrotatedPath = join(__dirname, "sign-schedule-sample.pdf");
const rotatedPath = join(__dirname, "sign-schedule-rotated.pdf");

await writeFile(unrotatedPath, unrotatedBytes);
await writeFile(rotatedPath, rotatedBytes);

console.log("Written:", unrotatedPath);
console.log("Written:", rotatedPath);
