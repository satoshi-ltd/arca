const mediaCounted = (n, word) => `${n.toLocaleString("en")} ${word}${n === 1 ? "" : "s"}`;
export function mediaSummary(photos, videos) {
  return [photos && mediaCounted(photos, "photo"), videos && mediaCounted(videos, "video")].filter(Boolean).join(" · ") || mediaCounted(0, "photo");
}
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

export function tilePreviewSize(width, height, pixelRatio) {
  const edge = Math.max(width, height) * pixelRatio;
  return edge <= 360 ? "thumb" : edge <= 720 ? "medium" : "large";
}
export function coverPreviewSize(width, height, pixelRatio, photoWidth, photoHeight) {
  if (!(photoWidth > 0 && photoHeight > 0)) return tilePreviewSize(width, height, pixelRatio);
  const ratio = photoWidth / photoHeight;
  const edge = Math.max(width / Math.min(1, ratio), height / Math.min(1, 1 / ratio)) * pixelRatio;
  return edge <= 360 ? "thumb" : edge <= 720 ? "medium" : "large";
}
export const PREVIEW_RANK = { thumb: 0, medium: 1, large: 2 };
const previewRank = (size) => PREVIEW_RANK[size] ?? -1;
export function cardPreviews({ load, show, busy, retry }) {
  const request = async (card, item, size) => {
    if (
      previewRank(size) <= Math.max(previewRank(card.dataset.source), previewRank(card.previewPending)) ||
      card.dataset.failed === size
    )
      return;
    card.previewPending = size;
    let outcome = "failed";
    try {
      const data = await load(item, size);
      if (data) {
        outcome = "shown";
        if (previewRank(size) > previewRank(card.dataset.source) && show(card, data)) card.dataset.source = size;
      }
    } catch (error) {
      if (busy(error)) outcome = "busy";
    }
    if (card.previewPending === size) delete card.previewPending;
    if (outcome === "failed") card.dataset.failed = size;
    if (outcome === "shown") card.retries = 0;
    if (outcome === "busy") retry(card, () => request(card, item, size));
  };
  return request;
}
export function galleryMoment(value) {
  if (typeof value !== "string" || !value) return null;
  const date = new Date(
    /^\d{4}-\d{2}$/.test(value)
      ? `${value}-01T12:00:00`
      : /^\d{4}-\d{2}-\d{2}$/.test(value)
        ? `${value}T12:00:00`
        : value,
  );
  return Number.isFinite(date.getTime()) ? date : null;
}
export function galleryDay(value) {
  const date = galleryMoment(value);
  if (!date) return "";
  const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  return /^\d{4}-\d{2}$/.test(value)
    ? month
    : `${month}-${String(date.getDate()).padStart(2, "0")}`;
}
export function photoFlow(ratios, { width, target, gap }) {
  const tiles = ratios.map((ratio, index) => ({ index, ratio }));
  const rows = [];
  let start = 0,
    sum = 0,
    space = 0;
  const fit = (total, spaced) => (width - spaced) / total;
  const close = (end, height) => {
    rows.push({ start, end, height });
    start = end;
    sum = 0;
    space = 0;
  };
  tiles.forEach((tile, index) => {
    const spacing = index === start ? 0 : gap;
    if ((sum + tile.ratio) * target + space + spacing < width) {
      sum += tile.ratio;
      space += spacing;
      return;
    }
    const without = index > start && fit(sum, space);
    const including = fit(sum + tile.ratio, space + spacing);
    if (
      without &&
      without <= target * 1.25 &&
      Math.abs(Math.log(without / target)) <
        Math.abs(Math.log(including / target))
    ) {
      close(index, without);
      sum = tile.ratio;
      if (tile.ratio * target >= width)
        close(index + 1, Math.min(target * 1.25, fit(tile.ratio, 0)));
    } else close(index + 1, Math.min(target * 1.25, including));
  });
  if (start < tiles.length)
    close(tiles.length, Math.min(target, fit(sum, space)));
  const round = (value) => Math.round(value * 100) / 100;
  let top = 0;
  rows.forEach((row, number) => {
    if (number) top += gap;
    row.top = round(top);
    let left = 0;
    for (let index = row.start; index < row.end; index++) {
      const tile = tiles[index];
      if (index > row.start) left += gap;
      tile.row = number;
      tile.left = round(left);
      tile.top = row.top;
      tile.height = round(row.height);
      tile.width = Math.max(1, Math.floor(row.height * tile.ratio * 100) / 100);
      left += row.height * tile.ratio;
    }
    top += row.height;
  });
  return { tiles, rows, height: round(top) };
}
const ZOOM_STOPS = ["years", "months", "small", "medium", "large"];
const ROW_SCALES = { small: 2 / 3, medium: 1, large: 4 / 3 };
export function rowTarget(width, stop = "medium") {
  return Math.round(
    Math.min(180, Math.max(120, width / 5)) * (ROW_SCALES[stop] || 1),
  );
}
export function galleryZoomStep(stop, direction) {
  const at = Math.max(0, ZOOM_STOPS.indexOf(stop));
  return ZOOM_STOPS[Math.max(0, Math.min(ZOOM_STOPS.length - 1, at + direction))];
}
export function pinchSteps(threshold = Math.log(1.35), idle = 400) {
  let total = 0,
    last = -Infinity;
  return (amount, now) => {
    if (now - last > idle) total = 0;
    last = now;
    total += amount;
    if (!(Math.abs(total) >= threshold)) return 0;
    const direction = Math.sign(total);
    total = 0;
    return direction;
  };
}
