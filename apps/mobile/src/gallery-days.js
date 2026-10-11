
const pad = (value) => String(value).padStart(2, "0");
const moment = (value) =>
  new Date(
    typeof value !== "string"
      ? NaN
      : /^\d{4}-\d{2}$/.test(value)
        ? `${value}-01T12:00:00`
        : /^\d{4}-\d{2}-\d{2}$/.test(value)
          ? `${value}T12:00:00`
          : value,
  );
export function photoDay(value) {
  const date = moment(value);
  if (!Number.isFinite(date.getTime())) return "";
  const month = `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
  return /^\d{4}-\d{2}$/.test(value) ? month : `${month}-${pad(date.getDate())}`;
}

const instant = (item) => moment(item.date).getTime();
export function newestFirst(a, b) {
  const x = photoDay(a.date);
  const y = photoDay(b.date);
  if (x !== y) return !x ? 1 : !y ? -1 : x < y ? 1 : -1;
  return x ? instant(b) - instant(a) : 0;
}
const ordered = (items) =>
  items.every((item, index) => !index || newestFirst(items[index - 1], item) <= 0)
    ? items
    : [...items].sort(newestFirst);

// The hub groups by the date's text; a UTC capture near midnight belongs to the viewer's local month.
export function localMonths(view) {
  const result = new Map();
  const moved = new Map();
  for (const [month, items] of view) {
    const kept = items.filter((item) => {
      const local = month === "undated" ? "" : photoDay(item.date).slice(0, 7);
      if (!local || local === month) return true;
      moved.set(local, [...(moved.get(local) || []), item]);
      return false;
    });
    result.set(month, ordered(kept.length === items.length ? items : kept));
  }
  for (const [month, items] of moved) result.set(month, ordered([...(result.get(month) || []), ...items]));
  return result;
}

export function shownMonths(source, months) {
  const listed = new Set(source.timeline.map(({ month }) => month));
  const added = [...months.keys()].filter(
    (month) => month !== "undated" && !listed.has(month) && months.get(month).length,
  );
  if (!added.length) return source.months;
  const view = { ...source.months };
  for (const month of added)
    view[month] = { items: months.get(month), fresh: months.get(month).length, complete: true, next: null };
  return view;
}

export function monthSections(source, months, shown) {
  const listed = new Set(source.timeline.map(({ month }) => month));
  const list = [
    ...source.timeline,
    ...[...months.keys()]
      .filter((month) => month !== "undated" && !listed.has(month))
      .map((month) => ({ month, count: 0 })),
  ]
    .sort((a, b) => (a.month < b.month ? 1 : a.month > b.month ? -1 : 0))
    .map(({ month, count }) => {
      const entry = shown[month];
      const loaded = months.get(month)?.length || 0;
      const removed = entry ? entry.items.length - loaded : 0;
      return {
        month,
        count: entry?.complete ? loaded : Math.max(loaded, count - removed),
      };
    })
    .filter((section) => section.count > 0);
  const undated = source.months.undated;
  const loadedUndated = months.get("undated")?.length || 0;
  const undatedCount = undated?.complete
    ? loadedUndated
    : Math.max(loadedUndated + (undated ? 1 : 0), source.undated || 0);
  if (undatedCount) list.push({ month: "undated", count: undatedCount });
  return list;
}

export function galleryComplete(source) {
  const undated = source.months.undated;
  return (
    (undated ? undated.complete !== false : !(source.undated > 0)) &&
    source.timeline.every(({ month }) => source.months[month]?.complete)
  );
}

export function galleryCounts(source, loaded = []) {
  const videos = Math.max(
    source.timeline.reduce((sum, row) => sum + (row.videos || 0), source.undatedVideos || 0),
    loaded.filter((item) => item.kind === "video").length,
  );
  return { photos: Math.max(0, Math.max(source.total || 0, loaded.length) - videos), videos };
}

const counted = (n, word) => `${n.toLocaleString("en")} ${word}${n === 1 ? "" : "s"}`;
export function mediaSummary(photos, videos) {
  return [photos && counted(photos, "photo"), videos && counted(videos, "video")].filter(Boolean).join(" · ") || counted(0, "photo");
}

export const photoCount = (count) => `${count.toLocaleString("en")} ${count === 1 ? "photo" : "photos"}`;

export function memoryText(memory, day, currentYear) {
  const ago = currentYear - Number(memory.year);
  return {
    title: new Date(`${memory.year}-${day}T12:00:00`).toLocaleDateString("en", { day: "numeric", month: "long", year: "numeric" }),
    caption: `${ago === 1 ? "1 year ago" : `${ago} years ago`} · ${photoCount(memory.count)}`,
  };
}
