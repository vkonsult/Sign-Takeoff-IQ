import { describe, it, expect } from "vitest";
import { normalizedToMediaBox } from "./pdfCoords";

const W = 612;
const H = 792;

describe("normalizedToMediaBox", () => {
  // ── /Rotate 0 (and equivalent angles) ────────────────────────────────────

  describe("rotation 0°", () => {
    it("maps the top-left corner to the top-left in MediaBox space", () => {
      expect(normalizedToMediaBox(0, 0, W, H, 0)).toEqual({ x: 0, y: H });
    });

    it("maps the bottom-right corner to the bottom-right in MediaBox space", () => {
      expect(normalizedToMediaBox(1, 1, W, H, 0)).toEqual({ x: W, y: 0 });
    });

    it("maps the top-right corner correctly", () => {
      expect(normalizedToMediaBox(1, 0, W, H, 0)).toEqual({ x: W, y: H });
    });

    it("maps the bottom-left corner correctly", () => {
      expect(normalizedToMediaBox(0, 1, W, H, 0)).toEqual({ x: 0, y: 0 });
    });

    it("maps a centred point correctly", () => {
      expect(normalizedToMediaBox(0.5, 0.5, W, H, 0)).toEqual({
        x: W * 0.5,
        y: H * 0.5,
      });
    });

    it("treats 360° as equivalent to 0°", () => {
      const r0   = normalizedToMediaBox(0.3, 0.7, W, H, 0);
      const r360 = normalizedToMediaBox(0.3, 0.7, W, H, 360);
      expect(r360).toEqual(r0);
    });

    it("treats 720° as equivalent to 0°", () => {
      const r0   = normalizedToMediaBox(0.25, 0.6, W, H, 0);
      const r720 = normalizedToMediaBox(0.25, 0.6, W, H, 720);
      expect(r720).toEqual(r0);
    });
  });

  // ── /Rotate 90 ───────────────────────────────────────────────────────────

  describe("rotation 90°", () => {
    it("maps (nx=0, ny=0) to (x=0, y=0)", () => {
      expect(normalizedToMediaBox(0, 0, W, H, 90)).toEqual({ x: 0, y: 0 });
    });

    it("maps (nx=1, ny=1) to (x=W, y=H)", () => {
      expect(normalizedToMediaBox(1, 1, W, H, 90)).toEqual({ x: W, y: H });
    });

    it("maps (nx=0, ny=1) to (x=W, y=0)", () => {
      expect(normalizedToMediaBox(0, 1, W, H, 90)).toEqual({ x: W, y: 0 });
    });

    it("maps (nx=1, ny=0) to (x=0, y=H)", () => {
      expect(normalizedToMediaBox(1, 0, W, H, 90)).toEqual({ x: 0, y: H });
    });

    it("maps a centred point correctly", () => {
      expect(normalizedToMediaBox(0.5, 0.5, W, H, 90)).toEqual({
        x: W * 0.5,
        y: H * 0.5,
      });
    });

    it("treats 450° as equivalent to 90°", () => {
      const r90  = normalizedToMediaBox(0.3, 0.7, W, H, 90);
      const r450 = normalizedToMediaBox(0.3, 0.7, W, H, 450);
      expect(r450).toEqual(r90);
    });

    it("treats −270° as equivalent to 90°", () => {
      const r90   = normalizedToMediaBox(0.4, 0.2, W, H, 90);
      const rNeg  = normalizedToMediaBox(0.4, 0.2, W, H, -270);
      expect(rNeg).toEqual(r90);
    });
  });

  // ── /Rotate 180 ──────────────────────────────────────────────────────────

  describe("rotation 180°", () => {
    it("maps (nx=0, ny=0) to (x=W, y=0)", () => {
      expect(normalizedToMediaBox(0, 0, W, H, 180)).toEqual({ x: W, y: 0 });
    });

    it("maps (nx=1, ny=1) to (x=0, y=H)", () => {
      expect(normalizedToMediaBox(1, 1, W, H, 180)).toEqual({ x: 0, y: H });
    });

    it("maps (nx=1, ny=0) to (x=0, y=0)", () => {
      expect(normalizedToMediaBox(1, 0, W, H, 180)).toEqual({ x: 0, y: 0 });
    });

    it("maps (nx=0, ny=1) to (x=W, y=H)", () => {
      expect(normalizedToMediaBox(0, 1, W, H, 180)).toEqual({ x: W, y: H });
    });

    it("maps a centred point correctly", () => {
      expect(normalizedToMediaBox(0.5, 0.5, W, H, 180)).toEqual({
        x: W * 0.5,
        y: H * 0.5,
      });
    });

    it("treats −180° as equivalent to 180°", () => {
      const r180 = normalizedToMediaBox(0.3, 0.7, W, H, 180);
      const rNeg = normalizedToMediaBox(0.3, 0.7, W, H, -180);
      expect(rNeg).toEqual(r180);
    });

    it("treats 540° as equivalent to 180°", () => {
      const r180 = normalizedToMediaBox(0.1, 0.9, W, H, 180);
      const r540 = normalizedToMediaBox(0.1, 0.9, W, H, 540);
      expect(r540).toEqual(r180);
    });
  });

  // ── /Rotate 270 ──────────────────────────────────────────────────────────

  describe("rotation 270°", () => {
    it("maps (nx=0, ny=0) to (x=W, y=H)", () => {
      expect(normalizedToMediaBox(0, 0, W, H, 270)).toEqual({ x: W, y: H });
    });

    it("maps (nx=1, ny=1) to (x=0, y=0)", () => {
      expect(normalizedToMediaBox(1, 1, W, H, 270)).toEqual({ x: 0, y: 0 });
    });

    it("maps (nx=0, ny=1) to (x=0, y=H)", () => {
      expect(normalizedToMediaBox(0, 1, W, H, 270)).toEqual({ x: 0, y: H });
    });

    it("maps (nx=1, ny=0) to (x=W, y=0)", () => {
      expect(normalizedToMediaBox(1, 0, W, H, 270)).toEqual({ x: W, y: 0 });
    });

    it("maps a centred point correctly", () => {
      expect(normalizedToMediaBox(0.5, 0.5, W, H, 270)).toEqual({
        x: W * 0.5,
        y: H * 0.5,
      });
    });

    it("treats −90° as equivalent to 270°", () => {
      const r270 = normalizedToMediaBox(0.3, 0.7, W, H, 270);
      const rNeg = normalizedToMediaBox(0.3, 0.7, W, H, -90);
      expect(rNeg).toEqual(r270);
    });

    it("treats 630° as equivalent to 270°", () => {
      const r270 = normalizedToMediaBox(0.6, 0.2, W, H, 270);
      const r630 = normalizedToMediaBox(0.6, 0.2, W, H, 630);
      expect(r630).toEqual(r270);
    });
  });

  // ── Rotation symmetry (180° is its own inverse) ───────────────────────────

  describe("rotation symmetry", () => {
    it("applying 0° twice gives the same point (trivially)", () => {
      const { x, y } = normalizedToMediaBox(0.3, 0.7, W, H, 0);
      expect(normalizedToMediaBox(x / W, 1 - y / H, W, H, 0)).toEqual({ x, y });
    });

    it("0° and 180° are each other's inverse at the corners", () => {
      const corners: [number, number][] = [[0, 0], [1, 0], [0, 1], [1, 1]];
      for (const [nx, ny] of corners) {
        const p0   = normalizedToMediaBox(nx, ny, W, H, 0);
        const p180 = normalizedToMediaBox(nx, ny, W, H, 180);
        expect(p0.x + p180.x).toBeCloseTo(W);
        expect(p0.y + p180.y).toBeCloseTo(H);
      }
    });

    it("90° and 270° are each other's complement at the corners", () => {
      const corners: [number, number][] = [[0, 0], [1, 0], [0, 1], [1, 1]];
      for (const [nx, ny] of corners) {
        const p90  = normalizedToMediaBox(nx, ny, W, H, 90);
        const p270 = normalizedToMediaBox(nx, ny, W, H, 270);
        expect(p90.x + p270.x).toBeCloseTo(W);
        expect(p90.y + p270.y).toBeCloseTo(H);
      }
    });
  });

  // ── Non-square page ───────────────────────────────────────────────────────

  describe("non-square page dimensions", () => {
    it("uses W for x-axis and H for y-axis at 0°", () => {
      const result = normalizedToMediaBox(0.25, 0.75, 400, 300, 0);
      expect(result).toEqual({ x: 100, y: 75 });
    });

    it("swaps axis roles at 90° (W governs ny, H governs nx)", () => {
      const result = normalizedToMediaBox(0.25, 0.75, 400, 300, 90);
      expect(result).toEqual({ x: 300, y: 75 });
    });
  });
});
