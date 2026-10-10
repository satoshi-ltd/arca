import { galleryDate, mediaKind, realDate } from "../core/gallery-date.js";
import { isPlaylistPath } from "../core/playlist.js";
import { SEARCH_AUDIO, SEARCH_TYPES, dateQuery, searchFold, searchRank as rank, searchTokens } from "../core/search.js";
import { buildLibrary } from "../../apps/desktop/src/music-library.js";
import { fail } from "./storage.js";

const CANDIDATES = 2000;
const fold = searchFold;
const libraries = new WeakMap();

function libraryIndex(music, volume) {
  let cache = libraries.get(music);
  if (!cache) libraries.set(music, (cache = new Map()));
  const raw = music.library(volume);
  const known = cache.get(volume);
  if (known?.version === raw.version) return known.index;
  const library = buildLibrary(raw);
  const text = (...values) => fold(values.filter(Boolean).join(" "));
  const index = {
    songs: library.albumList.flatMap((album) => album.tracks.map((track) => ({ item: track, name: track.title, text: text(track.title, track.artist, track.albumArtist, track.album), album }))),
    albums: library.albumList.map((album) => ({ item: album, name: album.title, text: text(album.title, album.artist) })),
    artists: library.artists.map((artist) => ({ item: artist, name: artist.name, text: text(artist.name) })),
    shows: library.shows.map((show) => ({ item: show, name: show.name, text: text(show.name) })),
    episodes: library.shows.flatMap((show) => show.tracks.map((track) => ({ item: track, name: track.title, text: text(track.title, track.album), show }))),
    playlists: library.playlists.map((list) => ({ item: list, name: list.name, text: text(list.name) })),
  };
  cache.set(volume, { version: raw.version, index });
  if (cache.size > 16) cache.delete(cache.keys().next().value);
  return index;
}

const LIBRARY_ROWS = {
  songs: ({ item, album }) => ({ path: item.path, hash: item.hash, title: item.title, artist: item.artist, album: item.album, albumId: album.id, cover: item.cover, duration: item.duration }),
  albums: ({ item }) => ({ id: item.id, path: item.tracks[0]?.path || null, title: item.title, artist: item.artist, cover: item.cover, songs: item.tracks.length }),
  artists: ({ item }) => ({ id: item.id, name: item.name, cover: item.cover, albums: item.albums.length, songs: item.albums.reduce((total, album) => total + album.tracks.length, 0) }),
  shows: ({ item }) => ({ id: item.id, path: item.tracks[0]?.path || null, name: item.name, cover: item.cover, episodes: item.tracks.length }),
  episodes: ({ item, show }) => ({ path: item.path, hash: item.hash, title: item.title, show: show.name, showId: show.id, cover: item.cover, duration: item.duration, date: item.date }),
  playlists: ({ item }) => ({ id: item.id, name: item.name, cover: item.cover, songs: item.entries.length }),
};

function galleryFolder(store, id) {
  return store.config.role === "hub"
    ? !!store.db.prepare("SELECT 1 FROM gallery_folders WHERE volume=?").get(id)
    : !!store.config.catalog?.find((row) => row.id === id)?.gallery;
}

export function searchLocal(store, params, music = null) {
  const raw = (params.get("q") || "").trim();
  const type = params.get("type") || "";
  const limit = Number(params.get("limit") || 3);
  const offset = Number(params.get("offset") || 0);
  if (type && !SEARCH_TYPES.includes(type)) fail("Invalid search type", 400);
  if (raw.length < 1 || raw.length > 100) fail("Invalid search", 400);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) fail("Invalid search limit", 400);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > CANDIDATES) fail("Invalid search offset", 400);
  const { query, tokens } = searchTokens(raw);
  const wanted = (group) => !type || type === group;
  const found = Object.fromEntries(SEARCH_TYPES.map((group) => [group, []]));
  const result = { groups: [] };
  if (!tokens.length) return result;
  store.db.function("arca_fold", fold);
  store.db.function("arca_search_media", (name) => (mediaKind(name) ? 1 : 0));
  const volumes = store.volumes().filter((v) => store.config.role === "hub" || v.selected);
  const source = store.fileSource();
  const date = dateQuery(query);
  const matches = (text) => tokens.every((token) => text.includes(token));
  if (wanted("folders"))
    for (const v of volumes)
      if (matches(fold(v.name))) found.folders.push({ score: rank(v.name, query), name: v.name, row: { id: v.id, name: v.name } });
  for (const volume of volumes) {
    let hidden;
    try {
      hidden = store.visibleRules(volume.id);
    } catch {
      continue;
    }
    const gallery = galleryFolder(store, volume.id);
    let index = null;
    if (music && !gallery && music.isMusic(volume.id))
      try {
        index = libraryIndex(music, volume.id);
      } catch {
        index = null;
      }
    if (index)
      for (const group of Object.keys(LIBRARY_ROWS)) {
        if (!wanted(group)) continue;
        for (const entry of index[group])
          if (matches(entry.text))
            found[group].push({ score: rank(entry.name, query), name: entry.name, row: { volume: volume.id, folder: volume.name, ...LIBRARY_ROWS[group](entry) } });
      }
    const seen = new Set();
    const take = (row, score) => {
      if (seen.has(row.path) || hidden(row.path, false)) return;
      const kind = mediaKind(row.path);
      if (index && !kind && (SEARCH_AUDIO.test(row.path) || isPlaylistPath(row.path))) return;
      const group = kind ? "photos" : "files";
      if (!wanted(group)) return;
      seen.add(row.path);
      const name = row.path.split("/").pop();
      found[group].push({
        score,
        name,
        rev: row.rev,
        captured: realDate(row.captured) || "",
        row: { volume: volume.id, folder: volume.name, gallery, path: row.path, name, hash: row.hash, size: row.size, rev: row.rev, ...(kind ? { kind } : {}) },
      });
    };
    if (date && wanted("photos")) {
      const condition = date.prefix ? "substr(m.captured,1,?)=?" : "substr(m.captured,6,2)=?";
      const rows = store.db
        .prepare(
          `SELECT f.path,f.hash,f.size,f.rev,m.captured FROM ${source} f JOIN gallery_metadata m ON m.hash=f.hash
           WHERE f.volume=? AND f.deleted=0 AND f.directory=0 AND f.hash IS NOT NULL AND arca_search_media(f.path)=1 AND ${condition}
           ORDER BY m.captured DESC LIMIT ${CANDIDATES}`,
        )
        .all(volume.id, ...(date.prefix ? [date.prefix.length, date.prefix] : [date.month]));
      for (const row of rows) if (realDate(row.captured)) take(row, 50);
    }
    if (!wanted("photos") && !wanted("files")) continue;
    const rows = store.db
      .prepare(
        `SELECT f.path,f.hash,f.size,f.rev FROM ${source} f
         WHERE f.volume=? AND f.deleted=0 AND f.directory=0 AND f.hash IS NOT NULL AND instr(arca_fold(f.path),?)>0
         ORDER BY f.rev DESC LIMIT ${CANDIDATES}`,
      )
      .all(volume.id, tokens[0]);
    for (const row of rows) if (matches(fold(row.path))) take(row, rank(row.path.split("/").pop(), query));
  }
  const order = new Intl.Collator("en", { sensitivity: "base", numeric: true });
  for (const group of SEARCH_TYPES) {
    const list = found[group];
    if (!list.length) continue;
    list.sort((a, b) => b.score - a.score || (b.captured || "").localeCompare(a.captured || "") || (b.rev || 0) - (a.rev || 0) || order.compare(a.name, b.name));
    const rows = list.slice(type ? offset : 0, (type ? offset : 0) + limit).map((entry) => entry.row);
    const entry = { type: group, count: list.length, rows };
    if (group === "photos") {
      for (const row of rows) Object.assign(row, photoDate(store, source, row));
      if (date) {
        entry.label = date.label;
        entry.periods = periods(store, source, list, date);
      }
    }
    result.groups.push(entry);
  }
  return result;
}

function photoDate(store, source, row) {
  const meta = store.db
    .prepare(
      `SELECT m.captured,m.modified,(SELECT min(r.created) FROM revisions r WHERE r.volume=f.volume AND r.path=f.path AND r.hash=f.hash) AS added
       FROM ${source} f LEFT JOIN gallery_metadata m ON m.hash=f.hash WHERE f.volume=? AND f.path=? AND f.deleted=0`,
    )
    .get(row.volume, row.path);
  const date = galleryDate(row.path, meta?.captured, meta?.added, meta?.modified).date || "";
  return { date: date || null, cursor: `${date || "!"}|${row.path}` };
}

function periods(store, source, list, date) {
  const byVolume = new Map();
  for (const entry of list)
    if (entry.captured && entry.row.gallery) {
      const known = byVolume.get(entry.row.volume);
      if (known) known.count++;
      else byVolume.set(entry.row.volume, { volume: entry.row.volume, folder: entry.row.folder, label: date.label, count: 1, newest: entry.row });
    }
  return [...byVolume.values()].map(({ newest, ...period }) => ({ ...period, cursor: photoDate(store, source, newest).cursor }));
}
