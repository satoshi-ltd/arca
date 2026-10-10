export const compactColumns = (base) => (base > 4 ? 12 : 10);
export function pinchLevel(level, ratio) {
  if (ratio > 1.35) return level === "years" ? "compact" : "base";
  if (ratio < 1 / 1.35) return level === "base" ? "compact" : "years";
  return level;
}
const spread = (touches) =>
  Math.hypot(
    touches[0].pageX - touches[1].pageX,
    touches[0].pageY - touches[1].pageY,
  );
export function pinchTracker({ lock, level, change }) {
  let gesture = null;
  const pair = (event) => event.nativeEvent.touches.length === 2;
  return {
    claims: pair,
    current: () => gesture,
    begin(event) {
      if (!pair(event)) return null;
      lock(true);
      gesture = { distance: spread(event.nativeEvent.touches) };
      return gesture;
    },
    move(event) {
      if (!gesture || gesture.changed || !pair(event)) return;
      const from = level();
      const next = pinchLevel(
        from,
        spread(event.nativeEvent.touches) / Math.max(1, gesture.distance),
      );
      if (next === from) return;
      gesture.changed = true;
      change(next, gesture, from);
    },
    end() {
      gesture = null;
      lock(false);
    },
  };
}
export const levelColumns = (level, base) =>
  level === "years"
    ? "years"
    : level === "compact"
      ? compactColumns(base)
      : base;
export function pinchCell(count, columns, step, x, y) {
  const row = Math.max(
    0,
    Math.min(Math.ceil(count / columns) - 1, Math.floor(y / step)),
  );
  const column = Math.max(0, Math.min(columns - 1, Math.floor(x / step)));
  return { row, index: Math.min(count - 1, row * columns + column) };
}
export function pinchGroup(groups, positions, y) {
  const placed = groups.filter((group) => positions.get(group.month));
  return (
    placed.find((group) => {
      const box = positions.get(group.month);
      return box.top + box.height > y;
    }) ||
    placed.at(-1) ||
    groups[0] ||
    null
  );
}
export function galleryYears(dates) {
  const years = new Map();
  for (const date of dates) {
    const year = date.month.slice(0, 4);
    const current = years.get(year) || {
      year,
      month: date.month,
      count: 0,
      annual: true,
    };
    current.month = current.month > date.month ? current.month : date.month;
    current.count += date.count;
    years.set(year, current);
  }
  return [...years.values()].sort((a, b) => b.year.localeCompare(a.year));
}
export function galleryTileSize(width, columns) {
  const gap = columns >= 10 ? 2 : 4;
  return {
    gap,
    size: width
      ? Math.max(1, Math.floor((width - gap * (columns - 1)) / columns))
      : 0,
  };
}
