// Same responsive principle as Alf: usable window size, never device model.
// Hysteresis avoids switching layouts repeatedly while a fold/window settles.
export function sidebarLayout(previous, width, height) {
  return height >= 500 && width >= (previous ? 676 : 700);
}

// Coordinates are relative to the app root, keeping the dropdown inside the screen.
export function fileMenuPosition(x, y, triggerWidth, triggerHeight, rootWidth) {
  const width = Math.min(240, rootWidth - 32);
  return {
    width,
    left: Math.max(
      16,
      Math.min(x + triggerWidth - width, rootWidth - width - 16),
    ),
    top: y + triggerHeight + 6,
  };
}

export const VIEWER_BAR_HEIGHT = 52;
export const VIEWER_STRIP_HEIGHT = 88;

export function videoSurfaceMargins(insets) {
  return {
    marginTop: insets.top + VIEWER_BAR_HEIGHT,
    marginBottom: insets.bottom + VIEWER_STRIP_HEIGHT,
    marginLeft: insets.left,
    marginRight: insets.right,
  };
}
