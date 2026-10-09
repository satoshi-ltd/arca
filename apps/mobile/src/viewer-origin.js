export function originTransform(rect, width, height) {
  if (!rect || !(rect.width > 0) || !(rect.height > 0) || !(width > 0) || !(height > 0))
    return null;
  if (
    rect.x + rect.width <= 0 ||
    rect.y + rect.height <= 0 ||
    rect.x >= width ||
    rect.y >= height
  )
    return null;
  return {
    dx: rect.x + rect.width / 2 - width / 2,
    dy: rect.y + rect.height / 2 - height / 2,
    scale: Math.min(1, rect.width / width),
  };
}
