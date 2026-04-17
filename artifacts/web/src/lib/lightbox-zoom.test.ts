import { describe, it, expect } from "vitest";
import {
  computeWheelZoom,
  resetLbView,
  LB_MIN_SCALE,
  LB_MAX_SCALE,
  LB_ZOOM_FACTOR,
} from "./lightbox-zoom";

const identity = (v: number) => v;
const noClamp = (v: number, _scale: number, _axis: "x" | "y") => v;

// ── resetLbView ───────────────────────────────────────────────────────────────

describe("resetLbView", () => {
  it("returns scale 1", () => {
    expect(resetLbView().scale).toBe(1);
  });

  it("returns panX 0", () => {
    expect(resetLbView().panX).toBe(0);
  });

  it("returns panY 0", () => {
    expect(resetLbView().panY).toBe(0);
  });

  it("always returns fresh default state regardless of previous state", () => {
    const state = resetLbView();
    expect(state).toEqual({ scale: LB_MIN_SCALE, panX: 0, panY: 0 });
  });
});

// ── computeWheelZoom — reset to 1x ───────────────────────────────────────────

describe("computeWheelZoom — scrolling back to 1x resets pan to (0, 0)", () => {
  it("resets panX to 0 when zoom-out brings scale back to 1", () => {
    const prev = { scale: LB_ZOOM_FACTOR, panX: 50, panY: 80 };
    const result = computeWheelZoom(prev, 1 /* scroll down = zoom out */, 100, 100, noClamp);
    expect(result.scale).toBe(LB_MIN_SCALE);
    expect(result.panX).toBe(0);
  });

  it("resets panY to 0 when zoom-out brings scale back to 1", () => {
    const prev = { scale: LB_ZOOM_FACTOR, panX: 50, panY: 80 };
    const result = computeWheelZoom(prev, 1, 100, 100, noClamp);
    expect(result.panY).toBe(0);
  });

  it("resets pan to (0, 0) even when cursor is far from centre", () => {
    const prev = { scale: LB_ZOOM_FACTOR, panX: -120, panY: 200 };
    const result = computeWheelZoom(prev, 1, 9999, -9999, noClamp);
    expect(result.panX).toBe(0);
    expect(result.panY).toBe(0);
  });

  it("keeps scale at 1 when further zoom-out is attempted at minimum", () => {
    const prev = { scale: 1, panX: 0, panY: 0 };
    const result = computeWheelZoom(prev, 1, 0, 0, noClamp);
    expect(result.scale).toBe(LB_MIN_SCALE);
  });
});

// ── computeWheelZoom — zooming in from 1x ────────────────────────────────────

describe("computeWheelZoom — zooming in from 1x moves pan toward the cursor", () => {
  it("increases scale by the zoom factor when zooming in", () => {
    const prev = { scale: 1, panX: 0, panY: 0 };
    const result = computeWheelZoom(prev, -1 /* scroll up = zoom in */, 0, 0, noClamp);
    expect(result.scale).toBeCloseTo(LB_ZOOM_FACTOR, 10);
  });

  it("pan stays at (0, 0) when cursor is exactly at the container centre", () => {
    const prev = { scale: 1, panX: 0, panY: 0 };
    const result = computeWheelZoom(prev, -1, 0, 0, noClamp);
    expect(result.panX).toBeCloseTo(0, 10);
    expect(result.panY).toBeCloseTo(0, 10);
  });

  it("panX moves toward positive cursor when cursor is to the right of centre", () => {
    const prev = { scale: 1, panX: 0, panY: 0 };
    const result = computeWheelZoom(prev, -1, 200, 0, noClamp);
    expect(result.panX).toBeLessThan(0);
  });

  it("panX moves toward negative cursor when cursor is to the left of centre", () => {
    const prev = { scale: 1, panX: 0, panY: 0 };
    const result = computeWheelZoom(prev, -1, -200, 0, noClamp);
    expect(result.panX).toBeGreaterThan(0);
  });

  it("panY moves toward positive cursor when cursor is below centre", () => {
    const prev = { scale: 1, panX: 0, panY: 0 };
    const result = computeWheelZoom(prev, -1, 0, 150, noClamp);
    expect(result.panY).toBeLessThan(0);
  });

  it("panY moves toward negative cursor when cursor is above centre", () => {
    const prev = { scale: 1, panX: 0, panY: 0 };
    const result = computeWheelZoom(prev, -1, 0, -150, noClamp);
    expect(result.panY).toBeGreaterThan(0);
  });

  it("pan shift is proportional to cursor distance from centre", () => {
    const prev = { scale: 1, panX: 0, panY: 0 };
    const resultNear = computeWheelZoom(prev, -1, 100, 0, noClamp);
    const resultFar  = computeWheelZoom(prev, -1, 200, 0, noClamp);
    expect(Math.abs(resultFar.panX)).toBeGreaterThan(Math.abs(resultNear.panX));
  });

  it("matches the expected pan formula: cx*(1 - ratio) + panX*ratio", () => {
    const prev = { scale: 2, panX: 30, panY: -20 };
    const deltaY = -1;
    const cx = 50;
    const cy = -40;
    const result = computeWheelZoom(prev, deltaY, cx, cy, noClamp);

    const expectedScale = Math.min(LB_MAX_SCALE, Math.max(LB_MIN_SCALE, prev.scale * LB_ZOOM_FACTOR));
    const ratio = expectedScale / prev.scale;
    const expectedPanX = cx * (1 - ratio) + prev.panX * ratio;
    const expectedPanY = cy * (1 - ratio) + prev.panY * ratio;

    expect(result.scale).toBeCloseTo(expectedScale, 10);
    expect(result.panX).toBeCloseTo(expectedPanX, 10);
    expect(result.panY).toBeCloseTo(expectedPanY, 10);
  });
});

// ── computeWheelZoom — scale bounds ──────────────────────────────────────────

describe("computeWheelZoom — scale is always clamped within [1, 10]", () => {
  it("does not exceed LB_MAX_SCALE", () => {
    const prev = { scale: LB_MAX_SCALE, panX: 0, panY: 0 };
    const result = computeWheelZoom(prev, -1, 0, 0, noClamp);
    expect(result.scale).toBe(LB_MAX_SCALE);
  });

  it("does not go below LB_MIN_SCALE", () => {
    const prev = { scale: LB_MIN_SCALE, panX: 0, panY: 0 };
    const result = computeWheelZoom(prev, 1, 0, 0, noClamp);
    expect(result.scale).toBe(LB_MIN_SCALE);
  });
});

// ── navigateLightbox (via resetLbView) ───────────────────────────────────────

describe("navigating between images resets scale and pan", () => {
  it("scale is 1 after navigation (resetLbView)", () => {
    const state = resetLbView();
    expect(state.scale).toBe(1);
  });

  it("panX is 0 after navigation (resetLbView)", () => {
    expect(resetLbView().panX).toBe(0);
  });

  it("panY is 0 after navigation (resetLbView)", () => {
    expect(resetLbView().panY).toBe(0);
  });

  it("reset clears a non-zero scale acquired during zoom", () => {
    const zoomed = computeWheelZoom({ scale: 1, panX: 0, panY: 0 }, -1, 100, 100, noClamp);
    expect(zoomed.scale).toBeGreaterThan(1);
    const reset = resetLbView();
    expect(reset.scale).toBe(1);
  });

  it("reset clears pan acquired during zoom", () => {
    const zoomed = computeWheelZoom({ scale: 1, panX: 0, panY: 0 }, -1, 200, 150, noClamp);
    expect(zoomed.panX).not.toBe(0);
    const reset = resetLbView();
    expect(reset.panX).toBe(0);
    expect(reset.panY).toBe(0);
  });

  it("reset clears pan that was set while already zoomed in", () => {
    let state = { scale: 1, panX: 0, panY: 0 };
    for (let i = 0; i < 5; i++) {
      state = computeWheelZoom(state, -1, 80, -60, noClamp);
    }
    expect(state.scale).toBeGreaterThan(1);
    const reset = resetLbView();
    expect(reset.panX).toBe(0);
    expect(reset.panY).toBe(0);
    expect(reset.scale).toBe(1);
  });
});
