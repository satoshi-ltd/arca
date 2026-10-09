export const MIN_SCALE = 1;
export const MAX_SCALE = 4;
export const clampScale = (scale) =>
  Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
export const distance = (a, b) =>
  Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY);
export const midpoint = (a, b) => ({
  x: (a.pageX + b.pageX) / 2,
  y: (a.pageY + b.pageY) / 2,
});
// The scaled page never reveals space past its own edges.
export function clampOffset(offset, scale, viewport) {
  const maxX = ((scale - 1) * viewport.width) / 2;
  const maxY = ((scale - 1) * viewport.height) / 2;
  return {
    x: Math.min(maxX, Math.max(-maxX, offset.x)),
    y: Math.min(maxY, Math.max(-maxY, offset.y)),
  };
}
// `focal` is measured from the viewport center; the content under it stays put while scaling.
export function zoomAround(state, nextScale, focal, viewport) {
  const scale = clampScale(nextScale);
  const ratio = scale / state.scale;
  return {
    scale,
    ...clampOffset(
      {
        x: focal.x - (focal.x - state.x) * ratio,
        y: focal.y - (focal.y - state.y) * ratio,
      },
      scale,
      viewport,
    ),
  };
}
export const toggleZoom = (state, focal, viewport) =>
  zoomAround(state, state.scale > 1 ? 1 : 2.5, focal, viewport);

export const DISMISS_FRACTION = 1 / 3;
export const INFO_FRACTION = 1 / 8;
export const DISMISS_VELOCITY = 1.2;
export const DRAG_SCALE = 0.6;

export function isVerticalIntent(dx, dy, scale) {
  return scale <= 1.02 && Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx) * 1.5;
}

export function decideRelease({ dy, vy = 0, height, wide = false }) {
  if (dy > 0)
    return dy > height * DISMISS_FRACTION || vy > DISMISS_VELOCITY ? "close" : "back";
  if (!wide && -dy > height * INFO_FRACTION) return "info";
  return "back";
}

export function dragLook(dy, height) {
  const down = Math.max(0, Math.min(dy, height));
  const progress = height ? down / height : 0;
  return {
    translateY: dy < 0 ? Math.max(dy * 0.4, -height / 6) : down,
    scale: 1 - (1 - DRAG_SCALE) * progress,
    backdrop: Math.max(0, 1 - progress * 2),
  };
}
