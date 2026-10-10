import { mediaKind } from "../../../packages/core/gallery-date.js";
import { isPlaylistPath } from "../../../packages/core/playlist.js";
import { SEARCH_AUDIO, SEARCH_TYPES, dateMatches, dateQuery, searchFold, searchRank, searchTokens } from "../../../packages/core/search.js";
import { formatDay, formatLength, plural, searchLibrary } from "./music-library.js";
import { bytes } from "./format.js";

export const SEARCH_SHOWN = 3;
export const SEARCH_PHOTOS = 4;
export const SEARCH_PAGE = 20;
export const SEARCH_LABELS = {
  folders: ["Folders", "folder", "Folder"],
  songs: ["Songs", "song", "Song"],
  albums: ["Albums", "album", "Album"],
  artists: ["Artists", "artist", "Artist"],
  shows: ["Shows", "show", "Show"],
  episodes: ["Episodes", "episode", "Episode"],
  playlists: ["Playlists", "playlist", "Playlist"],
  photos: ["Photos", "photo", "Photo"],
  files: ["Files", "file", "File"],
};

function libraryRows(library, query, volume) {
  const hits = searchLibrary(library, query);
  if (!hits) return {};
  const at = (row) => ({ volume: volume.id, folder: volume.name, ...row });
  const track = (id) => library.tracks.get(id);
  return {
    songs: hits.tracks.map(track).filter(Boolean).map((item) => [item.title, at({ id: item.id, path: item.path, title: item.title, artist: item.artist, album: item.album, albumId: item.albumId, cover: item.cover, duration: item.duration })]),
    albums: hits.albums.map((album) => [album.title, at({ id: album.id, path: track(album.tracks[0])?.path || null, title: album.title, artist: album.artist, cover: album.cover, songs: album.tracks.length })]),
    artists: hits.artists.map((artist) => [artist.name, at({ id: artist.id, name: artist.name, cover: artist.cover, albums: artist.albums.length, songs: artist.tracks })]),
    shows: hits.shows.map((show) => [show.name, at({ id: show.id, path: track(show.tracks[0])?.path || null, name: show.name, cover: show.cover, episodes: show.tracks.length })]),
    episodes: hits.episodes.map(track).filter(Boolean).map((item) => [item.title, at({ id: item.id, path: item.path, title: item.title, show: item.album, showId: item.show, cover: item.cover, duration: item.duration, date: item.date })]),
    playlists: hits.playlists.map((list) => [list.name, at({ id: list.id, path: list.path, name: list.name, cover: list.cover, songs: list.tracks.length })]),
  };
}

export function buildResults({ query: raw, type = "", volumes, rows = {}, libraries = {}, photos = {}, limit = SEARCH_PHOTOS, offset = 0 }) {
  const { query, tokens } = searchTokens(raw);
  const result = { groups: [] };
  if (!tokens.length) return result;
  const wanted = (group) => !type || type === group;
  const matches = (text) => tokens.every((token) => text.includes(token));
  const found = Object.fromEntries(SEARCH_TYPES.map((group) => [group, []]));
  const date = dateQuery(query);
  if (wanted("folders"))
    for (const volume of volumes)
      if (matches(searchFold(volume.name))) found.folders.push({ score: searchRank(volume.name, query), name: volume.name, row: { id: volume.id, name: volume.name } });
  for (const volume of volumes) {
    const library = libraries[volume.id];
    if (library)
      for (const [group, list] of Object.entries(libraryRows(library, raw, volume)))
        if (wanted(group)) for (const [name, row] of list) found[group].push({ score: searchRank(name, query), name, row });
    const dated = new Map((photos[volume.id] || []).map((item) => [item.path, item]));
    const seen = new Set();
    const take = (item, score, byDate = false) => {
      if (seen.has(item.path) || item.deleted || item.directory) return;
      const kind = mediaKind(item.path);
      if (library && !kind && (SEARCH_AUDIO.test(item.path) || isPlaylistPath(item.path))) return;
      const group = kind ? "photos" : "files";
      if (!wanted(group)) return;
      seen.add(item.path);
      const name = item.path.split("/").pop();
      const date = dated.get(item.path)?.date || item.date || null;
      found[group].push({
        score,
        name,
        rev: item.rev || 0,
        date: byDate ? date : "",
        row: { volume: volume.id, folder: volume.name, gallery: !!volume.gallery, path: item.path, name, hash: item.hash || null, size: item.size || 0, rev: item.rev || 0, ...(kind ? { kind, date } : {}) },
      });
    };
    if (date && wanted("photos"))
      for (const item of photos[volume.id] || []) if (dateMatches(item.date, date)) take(item, 50, true);
    if (!wanted("photos") && !wanted("files")) continue;
    for (const item of rows[volume.id] || []) if (matches(searchFold(item.path))) take(item, searchRank(item.path.split("/").pop(), query));
  }
  const order = new Intl.Collator("en", { sensitivity: "base", numeric: true });
  for (const group of SEARCH_TYPES) {
    const list = found[group];
    if (!list.length) continue;
    list.sort((a, b) => b.score - a.score || (b.date || "").localeCompare(a.date || "") || (b.rev || 0) - (a.rev || 0) || order.compare(a.name, b.name));
    const start = type ? offset : 0;
    const entry = { type: group, count: list.length, rows: list.slice(start, start + limit).map((item) => item.row) };
    if (group === "photos" && date) {
      entry.label = date.label;
      const periods = new Map();
      for (const item of list)
        if (item.date && item.row.gallery) {
          const known = periods.get(item.row.volume);
          if (known) known.count++;
          else periods.set(item.row.volume, { volume: item.row.volume, folder: item.row.folder, gallery: true, label: date.label, count: 1, month: item.date.slice(0, 7), path: item.row.path });
        }
      entry.periods = [...periods.values()];
    }
    result.groups.push(entry);
  }
  return result;
}

const ROW_TYPE = { folders: "folder", songs: "song", albums: "album", artists: "artist", shows: "show", episodes: "episode", playlists: "playlist", photos: "photo", files: "file" };

export function searchVerb(item, resume = false) {
  if (item.type === "song") return "Play in album";
  if (item.type === "episode") return resume ? "Resume" : "Play";
  if (item.type === "file") return "Details";
  if (item.type === "period") return "Open month";
  return "Open";
}

export function searchViewAction(item) {
  if (item.type === "song") return "Open album";
  if (item.type === "episode") return "Open show";
  return null;
}

export function searchTitle(item) {
  if (item.type === "period") return item.label;
  return item.title || item.name;
}

export function searchSubtitle(item, { files = 0, left = null } = {}) {
  if (item.type === "folder") return `Folder · ${plural(files, "file", "files")}`;
  if (item.type === "song") return [item.artist, item.album].filter(Boolean).join(" · ");
  if (item.type === "album") return `${item.artist} · ${plural(item.songs, "song", "songs")}`;
  if (item.type === "artist") return `${plural(item.albums, "album", "albums")} · ${plural(item.songs, "song", "songs")}`;
  if (item.type === "show") return `${plural(item.episodes, "episode", "episodes")} · ${item.folder}`;
  if (item.type === "episode") return [item.show, left || formatLength(item.duration)].filter(Boolean).join(" · ");
  if (item.type === "playlist") return `${plural(item.songs, "song", "songs")} · ${item.folder}`;
  if (item.type === "period") return `${item.folder} · ${plural(item.count, "photo and video", "photos and videos")}`;
  if (item.type === "photo") return [formatDay((item.date || "").slice(0, 10)), item.folder].filter(Boolean).join(" · ");
  return `${item.path.includes("/") ? item.path.slice(0, item.path.lastIndexOf("/")) : item.folder} · ${bytes(item.size || 0)}`;
}

export function searchItems(results, type) {
  const items = [];
  for (const entry of results?.groups || []) {
    const [label, one] = SEARCH_LABELS[entry.type] || [];
    if (!label) continue;
    const base = { group: entry.label ? `${label} · taken in ${entry.label}` : label, count: entry.count, of: entry.type };
    if (entry.type === "photos") items.push(...(entry.periods || []).map((period) => ({ ...period, ...base, type: "period" })));
    const shown = type ? entry.rows : entry.rows.slice(0, entry.type === "photos" ? SEARCH_PHOTOS : SEARCH_SHOWN);
    items.push(...shown.map((row) => ({ ...row, ...base, type: ROW_TYPE[entry.type] })));
    if (!type && entry.count > shown.length) items.push({ ...base, type: "more", title: `Show all ${plural(entry.count, one, `${one}s`)}` });
    if (type && entry.count > entry.rows.length) items.push({ ...base, type: "page", title: "Show more" });
  }
  return items;
}

const LIBRARY_TYPES = new Set(["song", "album", "artist", "show", "episode", "playlist"]);
const parentOf = (path) => (path?.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

export function searchReveal(item) {
  if (item.type === "album" || item.type === "show") return parentOf(item.path) || null;
  if (item.type === "folder" || item.type === "artist" || item.type === "period") return null;
  return item.path || null;
}

export function searchRoute(item) {
  if (item.type === "song") return [{ kind: "albums" }, { kind: "album", id: item.albumId }];
  if (item.type === "album") return [{ kind: "albums" }, { kind: "album", id: item.id }];
  if (item.type === "artist") return [{ kind: "artists" }, { kind: "artist", id: item.id }];
  if (item.type === "playlist") return [{ kind: "playlists" }, { kind: "playlist", id: item.id }];
  return [{ kind: "podcasts" }, { kind: "show", id: item.type === "show" ? item.id : item.showId }];
}

export const searchCanReveal = (item) => !item.gallery && !["folder", "artist", "period", "more", "page"].includes(item.type);

export function searchLanding(item, mode = "default") {
  if (mode === "reveal" && searchCanReveal(item)) {
    const focus = searchReveal(item);
    return { to: "files", directory: focus?.includes("/") ? `${parentOf(focus)}/` : "", focus };
  }
  if (item.type === "folder") return { to: "folder" };
  if (LIBRARY_TYPES.has(item.type))
    return { to: "music", route: searchRoute(item), play: mode === "play" || (mode === "default" && (item.type === "song" || item.type === "episode")) };
  if ((item.type === "photo" || item.type === "period") && item.gallery)
    return { to: "gallery", focus: { path: item.type === "photo" ? item.path : null, month: (item.type === "period" ? item.month : item.date?.slice(0, 7)) || null } };
  if (item.type === "period") return null;
  return { to: "history" };
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
