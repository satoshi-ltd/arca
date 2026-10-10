import { DAY_HEAD, dayPlan } from "./gallery-days.js";
import { galleryTileSize } from "./gallery-scale.js";

export const GALLERY_HEADER = 30;
export const GALLERY_SECTION_GAP = 20;
export const SCRUB_THUMB = 48;
const YEAR_SPACING = 28;

export function galleryLayout(months, width, columns, days = null, fontScale = 1) {
  const { gap, size: tile } = galleryTileSize(width, columns);
  const step = tile + gap;
  let top = 0;
  const sections = months.map(({ month, count }) => {
    const rows = Math.ceil(count / columns);
    const items = days?.get(month);
    const plan =
      items && items.length === count && count
        ? dayPlan(items, { columns, tile, gap, fontScale })
        : null;
    const section = {
      month,
      count,
      rows,
      top,
      gridTop: top + GALLERY_HEADER,
      height: GALLERY_HEADER + (plan ? plan.height : Math.max(0, rows * step - gap)),
      ...(plan ? { plan } : {}),
    };
    top += section.height + GALLERY_SECTION_GAP;
    return section;
  });
  return {
    sections,
    columns,
    tile,
    gap,
    step,
    height: sections.length ? top - GALLERY_SECTION_GAP : 0,
  };
}
export function sectionAt(layout, y) {
  let low = 0,
    high = layout.sections.length - 1,
    found = 0;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (layout.sections[middle].top <= y) {
      found = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  return found;
}
export function galleryWindow(layout, top, bottom) {
  const rows = [];
  if (!layout.step) return rows;
  for (
    let index = sectionAt(layout, top);
    index < layout.sections.length;
    index++
  ) {
    const section = layout.sections[index];
    if (section.top > bottom) break;
    if (section.top + section.height < top) continue;
    if (section.plan) {
      const from = top - section.gridTop;
      const to = bottom - section.gridTop;
      rows.push({
        section,
        header: section.top + GALLERY_HEADER >= top,
        first: 0,
        last: -1,
        cells: section.plan.cells.flatMap((cell, index) =>
          cell.top + cell.height >= from && cell.top <= to ? [index] : [],
        ),
        heads: section.plan.heads.filter(
          (head) => head.top + DAY_HEAD >= from && head.top <= to,
        ),
      });
      continue;
    }
    const row = (y) =>
      Math.max(
        0,
        Math.min(
          section.rows - 1,
          Math.floor((y - section.gridTop) / layout.step),
        ),
      );
    rows.push({
      section,
      header: section.top + GALLERY_HEADER >= top,
      first: row(top),
      last: row(bottom),
    });
  }
  return rows;
}
export function itemOffset(layout, month, index) {
  const section = layout.sections.find((item) => item.month === month);
  if (!section) return null;
  if (section.plan) {
    const cell = section.plan.cells[index];
    return section.gridTop + (cell ? cell.top : 0);
  }
  return section.gridTop + Math.floor(index / layout.columns) * layout.step;
}
// Rows added or removed above the viewport must not move the photos being looked at.
export function keptOffset(previous, current, view) {
  if (view <= 0 || !previous?.sections.length) return null;
  if (previous.columns !== current.columns) return null;
  const old = previous.sections[sectionAt(previous, view)];
  const now = current.sections.find((section) => section.month === old.month);
  return now ? now.top + (view - old.top) : null;
}
export function neededMonth(layout, months, top, bottom, viewTop, viewBottom) {
  const outside = ({ section }) =>
    section.top + section.height < viewTop || section.top > viewBottom ? 1 : 0;
  const wanted = galleryWindow(layout, top, bottom).sort(
    (a, b) => outside(a) - outside(b),
  );
  for (const { section, last } of wanted) {
    const entry = months[section.month];
    if (entry?.complete) continue;
    if (
      (entry?.fresh || 0) < Math.min(section.count, (last + 1) * layout.columns)
    )
      return section.month;
  }
  return null;
}
export function scrubYears(sections, start, end, travel) {
  const shown = [];
  sections.forEach((section, index) => {
    if (!section.year || section.year === sections[index - 1]?.year) return;
    const top =
      Math.min(1, Math.max(0, (section.offset - start) / (end - start))) *
        travel +
      SCRUB_THUMB / 2;
    while (shown.length && top - shown[shown.length - 1].top < YEAR_SPACING)
      shown.pop();
    shown.push({ key: section.key, year: section.year, top });
  });
  return shown;
}
