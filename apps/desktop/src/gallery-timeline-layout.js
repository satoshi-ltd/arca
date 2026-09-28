// Square-root weights keep busy months larger without leaving long empty stretches below their dot.
export function timelineSegments(counts, height, floor) {
  const weights = counts.map((count) => Math.sqrt(Math.max(0, count)));
  const total = weights.reduce((sum, weight) => sum + weight, 0) || 1;
  const minimum = Math.min(floor, height / Math.max(1, counts.length));
  const spare = Math.max(0, height - minimum * counts.length);
  let top = 0;
  return weights.map((weight) => {
    const size = minimum + (spare * weight) / total;
    const segment = { top, size };
    top += size;
    return segment;
  });
}
