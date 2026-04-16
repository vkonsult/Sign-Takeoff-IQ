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
 *   /Rotate 90:  x = ny*W,       y = nx*H        (landscape: display w=H,h=W)
 *   /Rotate 180: x = (1−nx)*W,   y = ny*H
 *   /Rotate 270: x = (1−ny)*W,   y = (1−nx)*H   (landscape: display w=H,h=W)
 *
 * Verified against the Python pdfplumber+ReportLab reference implementation:
 *   /Rotate 90:  canvas_x = plumber_y = ny*(raw_w),  canvas_y = plumber_x = nx*(raw_h)
 *   Display for /Rotate 90 is raw_h wide × raw_w tall; plumber_y=ny*raw_w, plumber_x=nx*raw_h.
 */
export function normalizedToMediaBox(
  nx: number,
  ny: number,
  W: number,
  H: number,
  rotationDeg: number,
): { x: number; y: number } {
  const r = ((rotationDeg % 360) + 360) % 360;
  switch (r) {
    case 90:  return { x: ny * W,       y: nx * H };
    case 180: return { x: (1 - nx) * W, y: ny * H };
    case 270: return { x: (1 - ny) * W, y: (1 - nx) * H };
    default:  return { x: nx * W,       y: (1 - ny) * H };
  }
}
