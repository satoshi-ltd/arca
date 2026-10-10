export const DAY_HEAD = 28;
const TITLE_CHAR = 8.5;
const CAPTION_CHAR = 7;
const LABEL_GAP = 8;
const DAY_TICK = 2;
const FOLLOWED_ROOM = 12;

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const parts = (day) => {
  const [year, month, date] = day.split("-").map(Number);
  return { year, month: month - 1, date, weekday: new Date(Date.UTC(year, month - 1, date)).getUTCDay() };
};

export function dayShort(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return "Date unknown";
  const { month, date, weekday } = parts(day);
  return `${WEEKDAYS[weekday].slice(0, 3)} ${date} ${MONTHS[month].slice(0, 3)}`;
}

export function dayHeading(day, currentYear = new Date().getFullYear()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return "Date unknown";
  const { year, month, date, weekday } = parts(day);
  return `${WEEKDAYS[weekday]} ${date} ${MONTHS[month]}${year === currentYear ? "" : ` ${year}`}`;
}

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

export function completeDays(sections, months, shown) {
  const byDay = new Map();
  for (const { month, count } of sections) {
    const items = months.get(month);
    if (shown[month]?.complete && items?.length === count) byDay.set(month, items);
  }
  return byDay;
}

export function dayBlocks(items) {
  const blocks = new Map();
  items.forEach((item, index) => {
    const day = photoDay(item.date);
    const block = blocks.get(day);
    if (block) block.indices.push(index);
    else blocks.set(day, { day, indices: [index] });
  });
  return [...blocks.values()]
    .sort((a, b) => (a.day === b.day ? 0 : !a.day ? 1 : !b.day ? -1 : a.day < b.day ? 1 : -1))
    .map((block) => ({ ...block, count: block.indices.length }));
}

export function blockLabel(block, currentYear) {
  if (/^\d{4}-\d{2}$/.test(block.day)) return "Day unknown";
  return dayHeading(block.day, currentYear);
}

export function blockShort(block) {
  if (/^\d{4}-\d{2}$/.test(block.day)) return "Day unknown";
  return dayShort(block.day);
}

function blockTiny(block) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(block.day)) return [];
  const { month, date } = parts(block.day);
  return [`${date} ${MONTHS[month].slice(0, 3)}`, String(date)];
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

function fitLabel(block, width, { currentYear, scale, countable }) {
  const caption = photoCount(block.count).length * CAPTION_CHAR * scale + LABEL_GAP;
  const forms = [
    ...[blockLabel(block, currentYear), blockShort(block)].flatMap((label) =>
      countable ? [[label, true], [label, false]] : [[label, false]],
    ),
    ...blockTiny(block).map((label) => [label, false]),
  ];
  const [label, counted] =
    forms.find(([label, counted]) => label.length * TITLE_CHAR * scale + (counted ? caption : 0) <= width) ||
    forms.at(-1);
  return { label, counted };
}

export function dayPlan(items, { columns, tile, gap, currentYear, fontScale = 1 }) {
  const step = tile + gap;
  const blocks = dayBlocks(items);
  const starts = [];
  let slot = 0;
  for (const block of blocks) {
    starts.push(slot);
    slot += block.count;
  }
  const rows = Math.ceil(slot / columns);
  const labelled = new Set(starts.map((start) => Math.floor(start / columns)));
  const tops = [];
  let y = 0;
  for (let row = 0; row < rows; row++) {
    if (row) y += step;
    if (labelled.has(row)) y += DAY_HEAD;
    tops.push(y);
  }
  const cells = new Array(items.length);
  const heads = blocks.map((block, order) => {
    const start = starts[order];
    block.indices.forEach((index, offset) => {
      const position = start + offset;
      cells[index] = {
        top: tops[Math.floor(position / columns)],
        left: (position % columns) * step,
        width: tile,
        height: tile,
      };
    });
    const row = Math.floor(start / columns);
    const column = start % columns;
    const span = Math.min(block.count, columns - column);
    const width = span * step - gap;
    const followed = order + 1 < blocks.length && Math.floor(starts[order + 1] / columns) === row;
    const tick = column > 0;
    const room = width - (followed ? FOLLOWED_ROOM : 0) - (tick ? DAY_TICK + LABEL_GAP : 0);
    return {
      top: tops[row] - DAY_HEAD,
      left: column * step,
      width,
      count: block.count,
      tick,
      ...fitLabel(block, room, {
        currentYear,
        scale: fontScale,
        countable: (!tick && !followed) || span * 2 >= columns,
      }),
    };
  });
  return { cells, heads, height: rows ? tops[rows - 1] + tile : 0 };
}

export function planCell(plan, x, y) {
  let best = 0;
  let distance = Infinity;
  plan.cells.forEach((cell, index) => {
    const dy = y < cell.top ? cell.top - y : y > cell.top + cell.height ? y - cell.top - cell.height : 0;
    const dx = x < cell.left ? cell.left - x : x > cell.left + cell.width ? x - cell.left - cell.width : 0;
    const d = dy * 1000 + dx;
    if (d < distance) {
      distance = d;
      best = index;
    }
  });
  return { index: best, top: plan.cells[best]?.top ?? 0 };
}
