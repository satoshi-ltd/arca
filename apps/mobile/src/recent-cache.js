export const knownRecent = new Map();

export function rememberRecent(key, value) {
  knownRecent.set(key, value);
  while (knownRecent.size > 40)
    knownRecent.delete(knownRecent.keys().next().value);
}

export function newestChange(page) {
  const row = page?.versions?.[0];
  return row
    ? {
        created: row.created,
        path: row.path,
        author: row.author,
      }
    : null;
}

export function cachedChange(key) {
  const page = knownRecent.get(key);
  return page?.versions?.length
    ? { change: newestChange(page), saved: !!page.offline }
    : null;
}

export async function readLastChange({ key, volume, load }) {
  try {
    const page = await load(
      `/v1/activity?${new URLSearchParams({ volume, limit: "4" })}`,
    );
    rememberRecent(key, page);
    return { change: newestChange(page), saved: !!page?.offline };
  } catch (error) {
    const cached = cachedChange(key);
    if (cached) return { ...cached, saved: true };
    throw error;
  }
}

export function seededChange(previous, key) {
  return previous?.key === key
    ? previous
    : { key, value: cachedChange(key) || undefined };
}

export function failedChange(previous, key) {
  return previous?.key === key && previous.value
    ? previous
    : { key, value: null };
}

export function shortName(path, max = 14) {
  const name = path.split("/").pop();
  return name.length > max ? `${name.slice(0, max - 1)}…` : name;
}
