export const SHARP_IDLE_MS = 400;
export const SHARP_BATCH = 8;
export const SHARP_KEEP = 400;
export async function sharpenTiles({ items, render, active, done, known = {}, failed = new Set() }) {
  let found = {};
  let count = 0;
  const flush = () => {
    if (!count) return;
    done(found);
    found = {};
    count = 0;
  };
  for (const item of items) {
    if (!active()) return;
    if (item.kind === "video" || item.upload || known[item.key] || failed.has(item.key)) continue;
    let uri = null;
    try {
      uri = await render(item);
    } catch {
      uri = null;
    }
    if (!active()) return;
    if (!uri) {
      failed.add(item.key);
      continue;
    }
    found[item.key] = uri;
    if (++count >= SHARP_BATCH) flush();
  }
  if (active()) flush();
}
export const keepRecent = (map, limit = SHARP_KEEP) => {
  const keys = Object.keys(map);
  return keys.length <= limit ? map : Object.fromEntries(keys.slice(-limit).map((key) => [key, map[key]]));
};
export const tileSources = (uri, fallback) => [...new Set([uri, fallback].filter(Boolean))];
