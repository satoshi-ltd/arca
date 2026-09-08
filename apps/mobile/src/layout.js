// Same responsive principle as Alf: usable window size, never device model.
// Hysteresis avoids switching layouts repeatedly while a fold/window settles.
export function sidebarLayout(previous, width, height) {
  return height >= 500 && width >= (previous ? 676 : 700);
}
