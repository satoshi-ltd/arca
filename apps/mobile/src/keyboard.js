// Measure the pane, not keyboard height: Android may already resize the window.
export function keyboardOverlap(top, height, keyboardTop) {
  return keyboardTop == null
    ? 0
    : Math.max(0, Math.min(height, top + height - keyboardTop));
}
export function focusScrollDelta(top, height, fieldTop, fieldHeight, gap = 16) {
  if (fieldTop < top + gap) return fieldTop - top - gap;
  if (fieldHeight > height - gap * 2) return fieldTop - top - gap;
  return Math.max(0, fieldTop + fieldHeight - (top + height - gap));
}
