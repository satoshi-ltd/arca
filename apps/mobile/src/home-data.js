import { mediaKind } from "../../../packages/core/gallery-date.js";

export const ARRIVALS = 3;

export function homeFromActivity(rows, selected) {
  const allowed = new Set(selected);
  const fresh = (rows || []).filter((row) => !row.deleted && allowed.has(row.volume));
  const last = {};
  for (const row of fresh)
    if (!last[row.volume])
      last[row.volume] = { path: row.path, created: row.created, author: row.author };
  return {
    arrivals: fresh.slice(0, ARRIVALS).map(({ volume, path, rev, created, author }) => ({
      volume,
      path,
      rev,
      created,
      author,
    })),
    last,
  };
}

export function newestImages(rows, limit = 4) {
  return (rows || [])
    .filter(
      (row) =>
        !row.deleted &&
        !row.directory &&
        mediaKind(row.path) === "image" &&
        !/\.hei[cf]$/i.test(row.path),
    )
    .sort((a, b) => (b.rev || 0) - (a.rev || 0))
    .slice(0, limit)
    .map((row) => row.path);
}

export function newestCovers(library, limit = 3) {
  const tracks = Array.isArray(library?.tracks) ? library.tracks : [];
  const seen = new Set();
  const keys = [];
  for (const track of [...tracks].sort((a, b) => String(b.added || "").localeCompare(String(a.added || "")))) {
    if (!track.cover || seen.has(track.cover)) continue;
    seen.add(track.cover);
    keys.push(track.cover);
    if (keys.length >= limit) break;
  }
  return keys;
}

export function latestLine(entry, nameOf, relative) {
  return entry
    ? `${entry.path.split("/").pop()} · ${nameOf(entry.author)} · ${relative(entry.created)}`
    : "";
}
