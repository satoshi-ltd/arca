export const DESTINATION_LIMIT = 20;
export const SHOWN_DESTINATIONS = 3;
export const destinationsKey = (scope) => `shareDestinations:${scope}`;
export const normalizeDirectory = (directory) =>
  (directory || "")
    .trim()
    .normalize("NFC")
    .replace(/^\/+|\/+$/g, "");
export function rankDestinations(ledger) {
  return [...ledger].sort((a, b) => b.uses - a.uses || b.last - a.last);
}
export function pruneDestinations(ledger, folders) {
  const known = new Set(folders.map((folder) => folder.id));
  return ledger.filter((entry) => known.has(entry.volume));
}
export function recordDestination(ledger, volume, directory, at = Date.now()) {
  const path = normalizeDirectory(directory);
  const same = (entry) => entry.volume === volume && entry.directory === path;
  const previous = ledger.find(same);
  const entry = {
    volume,
    directory: path,
    uses: (previous?.uses || 0) + 1,
    last: at,
  };
  return rankDestinations([
    entry,
    ...ledger.filter((item) => !same(item)),
  ]).slice(0, DESTINATION_LIMIT);
}
export function recentDestinations(
  ledger,
  folders,
  limit = SHOWN_DESTINATIONS,
) {
  const known = new Map(folders.map((folder) => [folder.id, folder]));
  return rankDestinations(pruneDestinations(ledger, folders))
    .slice(0, limit)
    .map((entry) => ({ ...entry, folder: known.get(entry.volume) }));
}
const stored = (value) => (Array.isArray(value) ? value : []);
export async function loadDestinations(store, scope, folders) {
  return recentDestinations(
    stored(await store.get(destinationsKey(scope), [])),
    folders,
  );
}
export async function saveDestination(
  store,
  scope,
  folders,
  volume,
  directory,
  at = Date.now(),
) {
  const key = destinationsKey(scope);
  const ledger = pruneDestinations(stored(await store.get(key, [])), folders);
  await store.set(key, recordDestination(ledger, volume, directory, at));
}
export const destinationLabel = (entry) =>
  entry.directory
    ? `${entry.folder.name} / ${entry.directory}`
    : entry.folder.name;
export function destinationUsage(entry, now = Date.now()) {
  const times = entry.uses === 1 ? "Used once" : `Used ${entry.uses} times`;
  return `${times} · ${since(entry.last, now)}`;
}
function since(at, now) {
  const days = Math.max(0, Math.floor((now - at) / 86400000));
  if (days < 1) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 14) return "last week";
  if (days < 28) return `${Math.floor(days / 7)} weeks ago`;
  if (days < 60) return "last month";
  if (days < 360) return `${Math.floor(days / 30)} months ago`;
  return "over a year ago";
}
