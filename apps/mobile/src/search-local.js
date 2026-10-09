import { mediaKind } from "../../../packages/core/gallery-date.js";

export const fold = (text) => String(text ?? "").normalize("NFC").toLowerCase();
export const SEARCH_LIMIT = 6;
const AUDIO = /\.(mp3|m4a|flac|wav|ogg|opus|aac|aiff?|wma)$/i;

function score(name, haystack, tokens, query) {
  const base = fold(name);
  if (base === query || base.replace(/\.[^.]+$/, "") === query) return 100;
  if (base.startsWith(query)) return 80;
  if (base.includes(query)) return 60;
  return tokens.every((token) => haystack.includes(token)) ? 30 : 0;
}

export function searchTokens(raw) {
  const query = fold(String(raw || "").trim());
  return { query, tokens: query.split(/\s+/).filter(Boolean) };
}

export function buildResults({ query: raw, scope = "all", volumes, rows = {}, tracks = {}, limit = SEARCH_LIMIT }) {
  const { query, tokens } = searchTokens(raw);
  const result = { folders: [], files: [], photos: [], music: [], counts: {} };
  if (!query) return { ...result, counts: { folders: 0, files: 0, photos: 0, music: 0 } };
  if (scope === "all")
    result.folders = volumes
      .filter((v) => tokens.every((token) => fold(v.name).includes(token)))
      .map(({ id, name }) => ({ id, name }));
  const found = { files: [], photos: [], music: [] };
  const trackByPath = new Map();
  for (const volume of volumes)
    for (const track of tracks[volume.id] || []) trackByPath.set(`${volume.id}\u0000${track.path}`, track);
  const candidates = {};
  for (const volume of volumes) {
    const have = new Set((rows[volume.id] || []).map((row) => row.path));
    candidates[volume.id] = [
      ...(rows[volume.id] || []),
      ...(tracks[volume.id] || [])
        .filter((track) => track.path && !have.has(track.path))
        .map((track) => ({ path: track.path, rev: track.rev || 0, size: track.size || 0 })),
    ];
  }
  for (const volume of volumes)
    for (const row of candidates[volume.id]) {
      if (row.deleted || row.directory) continue;
      const name = row.path.split("/").pop();
      const kind = mediaKind(row.path);
      const group = AUDIO.test(row.path) ? "music" : kind ? "photos" : "files";
      if (scope !== "all" && scope !== group) continue;
      const track = trackByPath.get(`${volume.id}\u0000${row.path}`);
      const haystack = fold([row.path, track?.title, track?.artist, track?.album].filter(Boolean).join(" "));
      if (!tokens.every((token) => haystack.includes(token))) continue;
      const tag = group === "music" ? Math.max(score(track?.title || name, haystack, tokens, query), score(name, haystack, tokens, query)) : score(name, haystack, tokens, query);
      if (!tag) continue;
      found[group].push({
        score: tag,
        volume: volume.id,
        folder: volume.name,
        path: row.path,
        name,
        size: row.size,
        rev: row.rev,
        ...(kind ? { kind } : {}),
        ...(group === "music" ? { title: track?.title || null, artist: track?.artist || null, album: track?.album || null, cover: track?.cover || null } : {}),
      });
    }
  for (const group of ["files", "photos", "music"]) {
    found[group].sort((a, b) => b.score - a.score || (b.rev || 0) - (a.rev || 0));
    result.counts[group] = found[group].length;
    result[group] = found[group].slice(0, limit).map(({ score: _score, ...row }) => row);
  }
  result.counts.folders = result.folders.length;
  result.folders = result.folders.slice(0, limit);
  return result;
}

export const MAX_RECENTS = 5;
export function rememberSearch(list, text) {
  const value = String(text || "").trim();
  if (!value) return list || [];
  return [value, ...(list || []).filter((item) => item !== value)].slice(0, MAX_RECENTS);
}
export function forgetSearch(list, text) {
  return (list || []).filter((item) => item !== text);
}
