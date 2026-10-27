const LIMIT = 60;
const pages = new Map();
const offsets = new Map();

const keep = (map, key, value) => {
  map.delete(key);
  map.set(key, value);
  if (map.size > LIMIT) map.delete(map.keys().next().value);
};

export const entryKey = (folderId, route) =>
  `${folderId}:${route.map((entry) => `${entry.kind}:${entry.id ?? ""}`).join("/")}`;
export const pageSize = (key, initial) => pages.get(key) ?? initial;
export const keepPage = (key, size) => keep(pages, key, size);
export const scrollOffset = (key) => offsets.get(key) ?? 0;
export const keepScroll = (key, y) => keep(offsets, key, y);
