import { bytes, fileCount } from "./format.js";
import { formatDay } from "./music-library.js";
export function browseEntries(entries, directory) {
  const result = new Map();
  for (const entry of entries) {
    if (!entry.path.startsWith(directory)) continue;
    const name = entry.path.slice(directory.length),
      slash = name.indexOf("/");
    if (!name) continue;
    if (slash < 0)
      result.set(entry.path, {
        ...entry,
        count: result.get(entry.path)?.count || 0,
        size: entry.directory ? result.get(entry.path)?.size || 0 : entry.size,
        label: name,
      });
    else {
      const path = directory + name.slice(0, slash),
        previous = result.get(path);
      result.set(path, {
        path,
        label: name.slice(0, slash),
        directory: true,
        count: (previous?.count || 0) + (entry.directory ? 0 : 1),
        size: (previous?.size || 0) + (entry.size || 0),
      });
    }
  }
  return [...result.values()].sort(
    (a, b) =>
      Number(!!b.directory) - Number(!!a.directory) ||
      a.label.localeCompare(b.label),
  );
}

export const FIRST_ROWS = { start: 0, end: 100 };
export const REVEAL_ROWS = 500;

export function revealWindow(entries, path, shown, page = 100, cap = REVEAL_ROWS) {
  const index = path ? entries.findIndex((entry) => entry.path === path) : -1;
  if (index < 0 || (index >= shown.start && index < shown.end)) return shown;
  if (index < cap)
    return { start: 0, end: Math.max(shown.start ? page : shown.end, Math.ceil((index + 1) / page) * page) };
  const start = Math.floor(index / page) * page;
  return { start, end: start + page };
}

export const entryLabel = (entry) =>
  entry.directory
    ? `${entry.label}, folder, ${fileCount(entry.count)}, ${bytes(entry.size)}`
    : `${entry.label}, ${bytes(entry.size)}`;
export const tileLabel = (item) => {
  const kind = item.kind === "video" ? "Video" : "Photo";
  const day = formatDay((item.date || "").slice(0, 10));
  return day ? `${kind}, ${day}` : `${kind} ${item.path.split("/").pop()}`;
};
