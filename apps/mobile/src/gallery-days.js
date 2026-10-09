export const DAY_HEAD = 28;
export const BLOCK_GAP = 12;
export const QUIET_BELOW = 4;
export const HERO_FROM = 8;

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const parts = (day) => {
  const [year, month, date] = day.split("-").map(Number);
  return { year, month: month - 1, date, weekday: new Date(Date.UTC(year, month - 1, date)).getUTCDay() };
};

export function dayHeading(day, currentYear = new Date().getFullYear()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return "Undated";
  const { year, month, date, weekday } = parts(day);
  return `${WEEKDAYS[weekday]} ${date} ${MONTHS[month]}${year === currentYear ? "" : ` ${year}`}`;
}

export function dayRange(from, to, currentYear = new Date().getFullYear()) {
  if (from === to) return dayHeading(from, currentYear).replace(/^\w+ /, "");
  const a = parts(from);
  const b = parts(to);
  const tail = `${b.date} ${MONTHS[b.month]}${b.year === currentYear ? "" : ` ${b.year}`}`;
  if (a.year === b.year && a.month === b.month) return `${a.date} – ${tail}`;
  return `${a.date} ${MONTHS[a.month]}${a.year === b.year ? "" : ` ${a.year}`} – ${tail}`;
}

export function dayBlocks(items) {
  const groups = [];
  items.forEach((item, index) => {
    const day = (item.date || "").slice(0, 10);
    const last = groups.at(-1);
    if (last && last.day === day) last.count++;
    else groups.push({ day, start: index, count: 1 });
  });
  const blocks = [];
  for (const group of groups) {
    const dated = /^\d{4}-\d{2}-\d{2}$/.test(group.day);
    const quiet = dated && group.count < QUIET_BELOW;
    const last = blocks.at(-1);
    if (quiet && last?.kind === "quiet") {
      last.count += group.count;
      last.to = group.day;
      last.days++;
    } else
      blocks.push({
        kind: quiet ? "quiet" : "day",
        dated,
        day: group.day,
        from: group.day,
        to: group.day,
        start: group.start,
        count: group.count,
        days: 1,
      });
  }
  return blocks;
}

export function blockLabel(block, currentYear) {
  if (block.kind === "day" && !block.dated)
    return /^\d{4}-\d{2}$/.test(block.day)
      ? `${MONTHS[Number(block.day.slice(5)) - 1]} ${block.day.slice(0, 4)}`
      : "Undated";
  if (block.kind === "day") return dayHeading(block.day, currentYear);
  return block.days === 1
    ? dayHeading(block.day, currentYear)
    : `Quiet days · ${dayRange(block.to, block.from, currentYear)}`;
}

export function dayPlan(items, { columns, tile, gap, hero = true, currentYear }) {
  const step = tile + gap;
  const cells = new Array(items.length);
  const heads = [];
  let y = 0;
  dayBlocks(items).forEach((block, order) => {
    if (order) y += BLOCK_GAP;
    heads.push({ top: y, label: blockLabel(block, currentYear), count: block.count });
    y += DAY_HEAD;
    const heroCols = columns >= 6 ? 3 : 2;
    const heroOn = hero && block.kind === "day" && block.dated && block.count >= HERO_FROM && columns >= 4;
    const taken = new Set();
    let next = block.start;
    if (heroOn) {
      cells[next++] = {
        top: y,
        left: 0,
        width: heroCols * step - gap,
        height: 2 * step - gap,
      };
      for (let r = 0; r < 2; r++) for (let c = 0; c < heroCols; c++) taken.add(r * columns + c);
    }
    let slot = 0;
    let rows = heroOn ? 2 : 0;
    for (; next < block.start + block.count; next++) {
      while (taken.has(slot)) slot++;
      const row = Math.floor(slot / columns);
      cells[next] = { top: y + row * step, left: (slot % columns) * step, width: tile, height: tile };
      rows = Math.max(rows, row + 1);
      slot++;
    }
    y += rows * step - gap;
  });
  return { cells, heads, height: y };
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
