export const AWAY_MS = 4 * 3600000;
export const STRIP_DAYS = 30;

const pad2 = (n) => String(n).padStart(2, "0");

export function localDay(value) {
  const d = new Date(value);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function dayName(key) {
  return new Date(`${key}T12:00:00`).toLocaleDateString("en", {
    month: "short",
    day: "numeric",
  });
}

const changes = (n) => `${n} ${n === 1 ? "change" : "changes"}`;

export function stripBars(days, now = new Date()) {
  const byDay = new Map((days || []).map((d) => [d.day, d]));
  const keys = [];
  for (let i = STRIP_DAYS - 1; i >= 0; i--)
    keys.push(
      localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)),
    );
  const max = Math.max(1, ...keys.map((key) => byDay.get(key)?.changes || 0));
  return keys.map((key, index) => {
    const entry = byDay.get(key);
    const count = entry?.changes || 0;
    const today = index === keys.length - 1;
    return {
      key,
      count,
      level: count ? Math.max(1, Math.ceil((count / max) * 9)) : 0,
      mark: entry?.conflicts ? "conflict" : entry?.deleted ? "deleted" : null,
      today,
      caption: `${today ? "Today" : dayName(key)}, ${changes(count)}`,
    };
  });
}

export function barIndexAt(x, width, count = STRIP_DAYS) {
  if (!width) return count - 1;
  return Math.min(count - 1, Math.max(0, Math.floor((x / width) * count)));
}

export function deviceSummary(devices, nameOf) {
  return Object.entries(devices || {})
    .sort((a, b) => b[1] - a[1])
    .map(([id, count]) => ({ id, name: nameOf(id), count }));
}

export function daySummary(entry, nameOf) {
  return entry
    ? { text: changes(entry.changes), devices: deviceSummary(entry.devices, nameOf) }
    : null;
}

export function awayDue(last, now = Date.now()) {
  return Boolean(last) && now - Number(last) >= AWAY_MS;
}

export function awayText(notice, nameOf, now = new Date()) {
  const since = new Date(notice.since);
  const sameDay = localDay(since) === localDay(now);
  const yesterday = localDay(since) === localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  const when = sameDay ? "today" : yesterday ? "yesterday" : dayName(localDay(since));
  const time = `${pad2(since.getHours())}:${pad2(since.getMinutes())}`;
  const devices = deviceSummary(notice.devices, nameOf)
    .map((d) => `${d.name} ${d.count}`)
    .join(" · ");
  return `Since ${when} ${time} · ${changes(notice.changes)}${devices ? ` · ${devices}` : ""}`;
}
