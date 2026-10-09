import { mediaKind } from "../core/gallery-date.js";
import { fail } from "./storage.js";

const SCOPES = new Set(["all", "files", "photos", "music"]);
const CANDIDATES = 2000;
const fold = (text) => String(text ?? "").normalize("NFC").toLowerCase();
const AUDIO = /\.(mp3|m4a|flac|wav|ogg|opus|aac|aiff?|wma)$/i;

function score(name, path, tokens, query) {
  const base = fold(name);
  if (base === query || base.replace(/\.[^.]+$/, "") === query) return 100;
  if (base.startsWith(query)) return 80;
  if (base.includes(query)) return 60;
  return tokens.every((token) => fold(path).includes(token)) ? 30 : 0;
}

export function searchLocal(store, params) {
  const raw = (params.get("q") || "").trim();
  const scope = params.get("scope") || "all";
  const limit = Number(params.get("limit") || 6);
  if (!SCOPES.has(scope)) fail("Invalid search scope", 400);
  if (raw.length < 1 || raw.length > 100) fail("Invalid search", 400);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) fail("Invalid search limit", 400);
  const query = fold(raw);
  const tokens = query.split(/\s+/).filter(Boolean);
  store.db.function("arca_fold", fold);
  const volumes = store.volumes().filter((v) => store.config.role === "hub" || v.selected);
  const source = store.fileSource();
  const result = { folders: [], files: [], photos: [], music: [], counts: {} };
  if (scope === "all")
    result.folders = volumes
      .filter((v) => tokens.every((token) => fold(v.name).includes(token)))
      .slice(0, limit)
      .map(({ id, name }) => ({ id, name }));
  const found = { files: [], photos: [], music: [] };
  for (const volume of volumes) {
    let hidden;
    try {
      hidden = store.visibleRules(volume.id);
    } catch {
      continue;
    }
    const rows = store.db
      .prepare(
        `SELECT f.path,f.hash,f.size,f.rev,t.title,t.artist,t.album,t.cover FROM ${source} f LEFT JOIN music_tracks t ON t.hash=f.hash
         WHERE f.volume=? AND f.deleted=0 AND f.directory=0 AND f.hash IS NOT NULL
         AND (instr(arca_fold(f.path),?)>0 OR instr(arca_fold(t.title),?)>0 OR instr(arca_fold(t.artist),?)>0 OR instr(arca_fold(t.album),?)>0)
         ORDER BY f.rev DESC LIMIT ${CANDIDATES}`,
      )
      .all(volume.id, tokens[0], tokens[0], tokens[0], tokens[0]);
    for (const row of rows) {
      if (hidden(row.path, false)) continue;
      const name = row.path.split("/").pop();
      const kind = mediaKind(row.path);
      const group = AUDIO.test(row.path) ? "music" : kind ? "photos" : "files";
      if (scope !== "all" && scope !== group) continue;
      const haystack = fold([row.path, row.title, row.artist, row.album].filter(Boolean).join(" "));
      if (!tokens.every((token) => haystack.includes(token))) continue;
      const tag = group === "music" ? Math.max(score(row.title || name, haystack, tokens, query), score(name, haystack, tokens, query)) : score(name, row.path, tokens, query);
      if (!tag) continue;
      found[group].push({
        score: tag,
        volume: volume.id,
        folder: volume.name,
        path: row.path,
        name,
        hash: row.hash,
        size: row.size,
        rev: row.rev,
        ...(kind ? { kind } : {}),
        ...(group === "music" ? { title: row.title || null, artist: row.artist || null, album: row.album || null, cover: row.cover || null } : {}),
      });
    }
  }
  for (const group of ["files", "photos", "music"]) {
    found[group].sort((a, b) => b.score - a.score || b.rev - a.rev);
    result.counts[group] = found[group].length;
    result[group] = found[group].slice(0, limit).map(({ score: _score, ...row }) => row);
  }
  result.counts.folders = result.folders.length;
  return result;
}
