export const compactColumns = (base) => (base > 4 ? 12 : 10);
export function pinchLevel(level, ratio) {
  if (ratio > 1.35) return level === "years" ? "compact" : "base";
  if (ratio < 1 / 1.35) return level === "base" ? "compact" : "years";
  return level;
}
export const levelColumns = (level, base) =>
  level === "years"
    ? "years"
    : level === "compact"
      ? compactColumns(base)
      : base;
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
