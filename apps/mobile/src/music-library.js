import {
  isEditablePlaylist,
  isPlaylistPath,
  parsePlaylist,
} from "../../../packages/core/playlist.js";

export const UNKNOWN_ARTIST = "Unknown artist";
export const UNKNOWN_ALBUM = "Unknown album";
export const VARIOUS_ARTISTS = "Various artists";
export const RECENT_ALBUMS = 30;
export const HISTORY_LIMIT = 20;
export const LIBRARY_CONTEXT = "albums";
export const folderContext = (folder, context) => `in:${folder}:${context}`;
export const baseContext = (context) => context.replace(/^in:[^:]+:/, "");

const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });
const compare = (a, b) => collator.compare(a, b);
const base = (path) => path.slice(path.lastIndexOf("/") + 1);
const directoryOf = (path) =>
  path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
const fold = (value) => value.trim().toLowerCase();

export function trackTitle(track) {
  if (track.title) return track.title;
  const name = base(track.path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}
export function trackId(folder, path) {
  return `${folder}:${path}`;
}
export const NODE_SEPARATOR = "\u001F";
export function trackNodeId(context, track, position = null) {
  const id = `track${NODE_SEPARATOR}${context}${NODE_SEPARATOR}${track}`;
  return Number.isSafeInteger(position) && position >= 0
    ? `${id}${NODE_SEPARATOR}${position}`
    : id;
}
export function parseTrackNode(id) {
  const parts = typeof id === "string" ? id.split(NODE_SEPARATOR) : [];
  if (parts[0] !== "track" || (parts.length !== 3 && parts.length !== 4))
    return null;
  if (parts.length === 3)
    return { context: parts[1], track: parts[2], position: null };
  const position = Number(parts[3]);
  return /^(0|[1-9]\d*)$/.test(parts[3]) && Number.isSafeInteger(position)
    ? { context: parts[1], track: parts[2], position }
    : null;
}
export function nextRepeat(mode) {
  return mode === "off" ? 2 : mode === "all" ? 1 : 0;
}
const DISC_FOLDER = /^(cd|dis[ck])[\s._-]*\d+$/i;
function albumDirectory(path) {
  const directory = directoryOf(path);
  return directory.includes("/") && DISC_FOLDER.test(base(directory).trim())
    ? directoryOf(directory)
    : directory;
}
function shortHash(text) {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    a = Math.imul(a ^ code, 0x01000193);
    b = Math.imul(b ^ code, 0x5bd1e995);
  }
  return (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
}
export function playlistKey(folder, path) {
  return `playlist:${shortHash(JSON.stringify([folder, path]))}`;
}
export function albumKey(folder, track) {
  const identity = track.release
    ? [folder, "release", track.release]
    : [folder, albumDirectory(track.path), fold(track.albumArtist || ""), fold(track.album || "")];
  return `album:${shortHash(JSON.stringify(identity))}`;
}
export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = String(total % 60).padStart(2, "0");
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}`
    : `${minutes}:${rest}`;
}

function folderPlaylists(folder, tracks, pending) {
  const local = folder.playlists instanceof Map ? folder.playlists : null;
  const hub = new Map();
  for (const item of Array.isArray(folder.library.playlists)
    ? folder.library.playlists
    : [])
    if (isPlaylistPath(item?.path) && !hub.has(item.path))
      hub.set(item.path, item);
  const sources = new Map();
  const own = (path) =>
    local?.has(path) && (isEditablePlaylist(path) || !hub.has(path));
  for (const [path, item] of hub)
    if (!local || (local.has(path) ? !own(path) : !folder.present.has(path)))
      sources.set(path, {
        name: item.name,
        entries: Array.isArray(item.entries) ? item.entries : [],
      });
  for (const [path, text] of local || [])
    if (isPlaylistPath(path) && own(path)) {
      const parsed = parsePlaylist(text, path);
      sources.set(path, {
        name: parsed.name,
        entries: parsed.entries.map((entry) => entry.path),
      });
    }
  return [...sources].map(([path, source]) => {
    const entries = source.entries.map((value) => {
      const id = typeof value === "string" ? trackId(folder.id, value) : null;
      const state = tracks.has(id)
        ? "ready"
        : pending.has(id)
          ? "pending"
          : "missing";
      return {
        track: state === "missing" ? null : id,
        path: typeof value === "string" ? value : null,
        state,
      };
    });
    const ready = entries
      .filter((entry) => entry.state === "ready")
      .map((entry) => entry.track);
    return {
      id: playlistKey(folder.id, path),
      folder: folder.id,
      path,
      name:
        typeof source.name === "string" && source.name.trim()
          ? source.name.trim()
          : parsePlaylist("", path).name,
      hash: typeof hub.get(path)?.hash === "string" ? hub.get(path).hash : null,
      editable: isEditablePlaylist(path),
      entries,
      tracks: ready,
      cover: tracks.get(ready[0])?.cover || null,
      duration: ready.reduce(
        (total, id) => total + (tracks.get(id).duration || 0),
        0,
      ),
    };
  });
}

export function buildLibrary(folders) {
  const tracks = new Map();
  const pending = new Map();
  const albums = new Map();
  const waiting = new Map();
  const playlists = [];
  for (const folder of folders) {
    const raw = folder.library;
    if (!raw?.tracks) continue;
    for (const item of raw.tracks) {
      if (typeof item?.path !== "string") continue;
      const id = trackId(folder.id, item.path);
      const key = albumKey(folder.id, item);
      const track = {
        id,
        folder: folder.id,
        path: item.path,
        uri: folder.uri?.(item.path) ?? null,
        title: trackTitle(item),
        artist: item.artist || item.albumArtist || UNKNOWN_ARTIST,
        albumArtist: item.albumArtist || null,
        album: item.album || base(albumDirectory(item.path)) || UNKNOWN_ALBUM,
        albumId: key,
        track: Number.isSafeInteger(item.track) ? item.track : null,
        disc: Number.isSafeInteger(item.disc) ? item.disc : null,
        year: Number.isSafeInteger(item.year) ? item.year : null,
        duration: Number.isFinite(item.duration) ? item.duration : null,
        cover: typeof item.cover === "string" ? item.cover : null,
        added: item.added || null,
      };
      if (folder.present.get(item.path) !== item.hash) {
        pending.set(id, track);
        if (!waiting.has(key)) waiting.set(key, []);
        waiting.get(key).push(track);
        continue;
      }
      tracks.set(id, track);
      let album = albums.get(key);
      if (!album) {
        album = {
          id: key,
          title: track.album,
          albumArtist: item.albumArtist || null,
          artists: new Set(),
          year: null,
          cover: null,
          added: null,
          tracks: [],
        };
        albums.set(key, album);
      }
      album.artists.add(item.artist || UNKNOWN_ARTIST);
      album.tracks.push(track);
      if (track.year && (!album.year || track.year < album.year))
        album.year = track.year;
      if (track.added && (!album.added || track.added > album.added))
        album.added = track.added;
    }
    playlists.push(...folderPlaylists(folder, tracks, pending));
  }
  const order = (a, b) =>
    (a.disc ?? 1) - (b.disc ?? 1) ||
    (a.track ?? Number.MAX_SAFE_INTEGER) -
      (b.track ?? Number.MAX_SAFE_INTEGER) ||
    compare(a.path, b.path);
  const albumList = [];
  for (const album of albums.values()) {
    album.tracks.sort(order);
    album.cover = album.tracks.find((track) => track.cover)?.cover || null;
    album.artist =
      album.albumArtist ||
      (album.artists.size === 1 ? [...album.artists][0] : VARIOUS_ARTISTS);
    album.duration = album.tracks.reduce(
      (total, track) => total + (track.duration || 0),
      0,
    );
    album.rows = [...album.tracks, ...(waiting.get(album.id) || [])]
      .sort(order)
      .map((track) => track.id);
    album.tracks = album.tracks.map((track) => track.id);
    delete album.artists;
    delete album.albumArtist;
    albumList.push(album);
  }
  albumList.sort(
    (a, b) => compare(a.title, b.title) || compare(a.artist, b.artist),
  );
  const artistMap = new Map();
  for (const album of albumList) {
    const key = `artist:${JSON.stringify(fold(album.artist))}`;
    let artist = artistMap.get(key);
    if (!artist) {
      artist = {
        id: key,
        name: album.artist,
        albums: [],
        tracks: 0,
        cover: null,
      };
      artistMap.set(key, artist);
    }
    artist.albums.push(album);
    artist.tracks += album.tracks.length;
  }
  const artists = [...artistMap.values()]
    .map((artist) => {
      artist.albums.sort(
        (a, b) =>
          (a.year ?? Number.MAX_SAFE_INTEGER) -
            (b.year ?? Number.MAX_SAFE_INTEGER) || compare(a.title, b.title),
      );
      artist.cover =
        artist.albums
          .filter((album) => album.cover)
          .sort(
            (a, b) =>
              (b.year ?? -Infinity) - (a.year ?? -Infinity) ||
              compare(a.title, b.title),
          )[0]?.cover || null;
      artist.letter = artistLetter(artist.name);
      return { ...artist, albums: artist.albums.map((album) => album.id) };
    })
    .sort(
      (a, b) =>
        (a.letter === "#") - (b.letter === "#") ||
        compare(a.letter, b.letter) ||
        compare(a.name, b.name),
    );
  const recent = albumList
    .filter((album) => album.added)
    .sort((a, b) => (a.added < b.added ? 1 : a.added > b.added ? -1 : 0))
    .slice(0, RECENT_ALBUMS)
    .map((album) => album.id);
  playlists.sort((a, b) => compare(a.name, b.name) || compare(a.path, b.path));
  return {
    tracks,
    pending,
    albums: new Map(albumList.map((album) => [album.id, album])),
    albumOrder: albumList.map((album) => album.id),
    artists,
    recent,
    playlists: new Map(playlists.map((playlist) => [playlist.id, playlist])),
    playlistOrder: playlists.map((playlist) => playlist.id),
  };
}

export function nativeLibrary(library, scope) {
  return {
    format: 1,
    scope,
    tracks: [...library.tracks.values()].map((track) => ({
      id: track.id,
      uri: track.uri,
      title: track.title,
      artist: track.artist,
      album: track.album,
      duration: track.duration,
      cover: track.cover,
    })),
    albums: library.albumOrder.map((id) => {
      const album = library.albums.get(id);
      return {
        id,
        title: album.title,
        artist: album.artist,
        cover: album.cover,
        tracks: album.tracks,
      };
    }),
    artists: library.artists.map((artist) => ({
      id: artist.id,
      name: artist.name,
      letter: artist.letter,
      cover: artist.cover,
      albums: artist.albums,
    })),
    playlists: library.playlistOrder
      .map((id) => library.playlists.get(id))
      .filter((playlist) => playlist.tracks.length)
      .map((playlist) => ({
        id: playlist.id,
        name: playlist.name,
        tracks: playlist.tracks,
      })),
    recent: library.recent,
  };
}

export function coverKeys(library) {
  const keys = new Set();
  for (const track of library.tracks.values())
    if (track.cover) keys.add(track.cover);
  return keys;
}

export function parseHistory(text, scope) {
  try {
    const value = JSON.parse(text);
    if (!scope || value?.format !== 1 || value.scope !== scope) return [];
    const items = Array.isArray(value.items) ? value.items : [];
    return [
      ...new Set(items.filter((id) => typeof id === "string" && id)),
    ].slice(0, HISTORY_LIMIT);
  } catch {
    return [];
  }
}

export function recordHistory(history, id) {
  return [id, ...history.filter((item) => item !== id)].slice(
    0,
    HISTORY_LIMIT,
  );
}

export function encodeHistory(scope, history) {
  return JSON.stringify({ format: 1, scope, items: history });
}

export function recentPlayed(library, history) {
  return history
    .map((id) => library.albums.get(id) || library.playlists.get(id))
    .filter(Boolean)
    .slice(0, HISTORY_LIMIT);
}

export function musicTabs(library) {
  return library.playlistOrder.length
    ? ["artists", "albums", "playlists", "recent"]
    : ["artists", "albums", "recent"];
}

export const plural = (count, one, many) =>
  `${count.toLocaleString("en")} ${count === 1 ? one : many}`;

export function albumSummary(album) {
  return [
    album.artist,
    album.year,
    ...(album.rows.length > album.tracks.length
      ? [`${album.tracks.length} of ${album.rows.length} on this phone`]
      : [plural(album.tracks.length, "track", "tracks"), formatDuration(album.duration)]),
  ]
    .filter(Boolean)
    .join(" · ");
}

export function playlistSummary(playlist) {
  return [plural(playlist.tracks.length, "track", "tracks"), formatDuration(playlist.duration)]
    .filter(Boolean)
    .join(" · ");
}

export function musicSheet(sheet) {
  if (sheet?.kind === "track-actions")
    return {
      title: sheet.track?.title || sheet.title,
      icon: "music",
      subtitle: sheet.track
        ? `${sheet.track.artist} · ${sheet.track.album}`
        : "Not in this folder",
      menu: true,
    };
  if (sheet?.kind === "add-to-playlist")
    return {
      title: "Add to playlist",
      icon: "list-plus",
      subtitle: `${sheet.track.title} · ${sheet.track.artist}`,
    };
  if (sheet?.kind === "new-playlist")
    return { title: "New playlist", icon: "list-plus", subtitle: sheet.track.title };
  if (sheet?.kind === "playlist-actions")
    return {
      title: sheet.playlist.name,
      icon: "playlist",
      subtitle: playlistSummary(sheet.playlist),
      menu: true,
    };
  if (sheet?.kind === "rename-playlist")
    return { title: "Rename playlist", icon: "edit", subtitle: sheet.playlist.name };
  return null;
}

export function albumRows(library, album) {
  let ready = 0;
  return album.rows.map((id, index) => {
    const here = library.tracks.has(id);
    const track = here ? library.tracks.get(id) : library.pending.get(id);
    return {
      track,
      title: track.title,
      state: here ? "ready" : "pending",
      position: here ? ready++ : null,
      number: track.track ?? index + 1,
    };
  });
}

export function playlistRows(library, playlist) {
  let ready = 0;
  return playlist.entries.map((entry, index) => {
    const track =
      library.tracks.get(entry.track) || library.pending.get(entry.track) || null;
    return {
      track,
      path: entry.path,
      title: track?.title || (entry.path ? trackTitle({ path: entry.path }) : "Unknown track"),
      state: entry.state,
      position: entry.state === "ready" ? ready++ : null,
      entry: index,
      number: index + 1,
    };
  });
}

const plain = (value) =>
  String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

const LETTER_BASE = { Æ: "A", Ð: "D", Đ: "D", Ł: "L", Ø: "O", Œ: "O", Þ: "T" };
export function artistLetter(name) {
  const first = String(name ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .charAt(0)
    .toUpperCase()
    .charAt(0);
  const letter = LETTER_BASE[first] || first;
  return /^[A-Z]$/.test(letter) ? letter : "#";
}
export function artistGroups(artists) {
  const groups = [];
  for (const artist of artists) {
    if (groups.at(-1)?.letter !== artist.letter)
      groups.push({ letter: artist.letter, artists: [] });
    groups.at(-1).artists.push(artist);
  }
  return groups;
}

export function libraryTracks(library, albumIds = library.albumOrder) {
  const ids = [];
  for (const id of albumIds)
    for (const track of library.albums.get(id)?.tracks || [])
      if (library.tracks.has(track)) ids.push(track);
  return ids;
}

const folded = new WeakMap();

function searchIndex(library) {
  let index = folded.get(library);
  if (!index) {
    index = {
      tracks: libraryTracks(library).map((id) => {
        const track = library.tracks.get(id);
        return [id, [track.title, track.artist, track.albumArtist, track.album].map(plain)];
      }),
      albums: library.albumOrder.map((id) => {
        const album = library.albums.get(id);
        return [album, [album.title, album.artist].map(plain)];
      }),
      artists: library.artists.map((artist) => [artist, [plain(artist.name)]]),
      playlists: library.playlistOrder.map((id) => {
        const playlist = library.playlists.get(id);
        return [playlist, [plain(playlist.name)]];
      }),
    };
    folded.set(library, index);
  }
  return index;
}

export function searchLibrary(library, query) {
  const needle = plain(query).trim();
  if (!needle) return null;
  const index = searchIndex(library);
  const hits = (rows) =>
    rows.filter(([, values]) => values.some((value) => value.includes(needle))).map(([item]) => item);
  return {
    tracks: hits(index.tracks),
    albums: hits(index.albums),
    artists: hits(index.artists),
    playlists: hits(index.playlists),
  };
}

export function upNext(library, state, limit = 30) {
  const node = parseTrackNode(state?.id);
  if (!node || !library) return { name: "", current: null, shuffled: false, rows: [] };
  const base = baseContext(node.context);
  const album = library.albums.get(base);
  const playlist = library.playlists.get(base);
  const ids = (album ? album.tracks : playlist ? playlist.tracks : libraryTracks(library)).filter((id) =>
    library.tracks.has(id),
  );
  const at = Number.isSafeInteger(node.position) && ids[node.position] === node.track ? node.position : ids.indexOf(node.track);
  return {
    name: album?.title || playlist?.name || "Library",
    context: node.context,
    current: node.track,
    shuffled: !!state.shuffle,
    rows: state.shuffle || at < 0 ? [] : ids.slice(at + 1, at + 1 + limit).map((id, offset) => ({ track: library.tracks.get(id), position: at + 1 + offset })),
  };
}

export function artistFor(library, track) {
  return (
    library?.artists.find((artist) => artist.name === track?.artist) ||
    library?.artists.find((artist) => artist.name === track?.albumArtist) ||
    null
  );
}
