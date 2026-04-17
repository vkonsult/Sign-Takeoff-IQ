export interface LbViewState {
  scale: number;
  panX: number;
  panY: number;
}

export const LB_MIN_SCALE = 1;
export const LB_MAX_SCALE = 10;
export const LB_ZOOM_FACTOR = 1.12;

/**
 * Compute the new scale + pan after a wheel zoom event.
 *
 * @param prev     Current view state.
 * @param deltaY   Wheel delta – negative means zoom-in.
 * @param cx       Cursor X offset relative to the container centre (px).
 * @param cy       Cursor Y offset relative to the container centre (px).
 * @param clampFn  Optional clamping function; defaults to the identity.
 */
export function computeWheelZoom(
  prev: LbViewState,
  deltaY: number,
  cx: number,
  cy: number,
  clampFn: (value: number, scale: number, axis: "x" | "y") => number = (v) => v,
): LbViewState {
  const factor = deltaY < 0 ? LB_ZOOM_FACTOR : 1 / LB_ZOOM_FACTOR;
  const next = Math.min(LB_MAX_SCALE, Math.max(LB_MIN_SCALE, prev.scale * factor));

  if (next === LB_MIN_SCALE) {
    return { scale: LB_MIN_SCALE, panX: 0, panY: 0 };
  }

  const ratio = next / prev.scale;
  const panX = clampFn(cx * (1 - ratio) + prev.panX * ratio, next, "x");
  const panY = clampFn(cy * (1 - ratio) + prev.panY * ratio, next, "y");
  return { scale: next, panX, panY };
}

/** Reset scale and pan to their defaults (called on navigate or explicit reset). */
export function resetLbView(): LbViewState {
  return { scale: LB_MIN_SCALE, panX: 0, panY: 0 };
}
