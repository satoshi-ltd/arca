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
const PODCAST_GENRE = /^podcast$/i;
export const SPOKEN_SECONDS = 1200;
const EPISODE_DATE = /^(\d{4}-\d{2}-\d{2})(?!\d)/;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function episodeDate(path) {
  return EPISODE_DATE.exec(base(path))?.[1] || null;
}
export function episodeTitle(item, show) {
  const tagged = typeof item?.title === "string" ? item.title.trim() : "";
  const folder = item.path.includes("/") ? item.path.slice(0, item.path.lastIndexOf("/")).split("/").pop() : "";
  const fold = (value) => String(value || "").trim().toLowerCase();
  if (tagged && fold(tagged) !== fold(show) && fold(tagged) !== fold(folder)) return tagged;
  const name = item.path.slice(item.path.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "");
  return name.replace(/^\d{4}-\d{2}-\d{2}\s+/, "") || name;
}
export function isEpisode(item) {
  return (
    PODCAST_GENRE.test(item?.genre || "") ||
    (!!episodeDate(item?.path || "") && (!item?.album || !Number.isSafeInteger(item?.track))) ||
    (!item?.artist &&
      !item?.albumArtist &&
      Number.isFinite(item?.duration) &&
      item.duration >= SPOKEN_SECONDS)
  );
}
export function episodeFolders(items) {
  const folders = new Set();
  for (const item of items || [])
    if (typeof item?.path === "string" && item.path.includes("/") && isEpisode(item))
      folders.add(item.path.slice(0, item.path.lastIndexOf("/")));
  return folders;
}
export function formatDay(date) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || "");
  const month = match ? MONTHS[Number(match[2]) - 1] : null;
  return month ? `${month} ${Number(match[3])}, ${match[1]}` : "";
}
export function formatLength(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  const minutes = Math.max(1, Math.round(seconds / 60));
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours} h ${minutes % 60} min` : `${minutes} min`;
}

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
export function playingFolder(id) {
  const track = parseTrackNode(id)?.track;
  return track?.includes(":") ? track.slice(0, track.indexOf(":")) : null;
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
export function showKey(folder, name) {
  return `show:${shortHash(JSON.stringify([folder, fold(name)]))}`;
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
  const shows = new Map();
  for (const folder of folders) {
    const raw = folder.library;
    if (!raw?.tracks) continue;
    const showFolders = episodeFolders(raw.tracks);
    for (const item of raw.tracks) {
      if (typeof item?.path !== "string") continue;
      const id = trackId(folder.id, item.path);
      const key = albumKey(folder.id, item);
      const albumName = item.album || base(albumDirectory(item.path)) || UNKNOWN_ALBUM;
      const podcast =
        isEpisode(item) ||
        (item.path.includes("/") && showFolders.has(item.path.slice(0, item.path.lastIndexOf("/"))));
      const track = {
        id,
        folder: folder.id,
        path: item.path,
        hash: typeof item.hash === "string" ? item.hash : null,
        uri: folder.uri?.(item.path) ?? null,
        title: podcast ? episodeTitle(item, albumName) : trackTitle(item),
        artist: podcast ? albumName : item.artist || item.albumArtist || UNKNOWN_ARTIST,
        albumArtist: item.albumArtist || null,
        album: albumName,
        albumId: podcast ? null : key,
        podcast,
        show: podcast ? showKey(folder.id, albumName) : null,
        date: podcast ? episodeDate(item.path) : null,
        track: Number.isSafeInteger(item.track) ? item.track : null,
        disc: Number.isSafeInteger(item.disc) ? item.disc : null,
        year: Number.isSafeInteger(item.year) ? item.year : null,
        duration: Number.isFinite(item.duration) ? item.duration : null,
        cover: typeof item.cover === "string" ? item.cover : null,
        added: item.added || null,
      };
      if (podcast) {
        let show = shows.get(track.show);
        if (!show) {
          show = { id: track.show, name: albumName, tracks: [], rows: [], cover: null, latest: null, duration: 0 };
          shows.set(track.show, show);
        }
        show.rows.push(track);
        if (folder.present.get(item.path) !== item.hash) pending.set(id, track);
        else {
          tracks.set(id, track);
          show.tracks.push(track);
          show.duration += track.duration || 0;
        }
        continue;
      }
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
  const newest = (a, b) =>
    (b.date || "").localeCompare(a.date || "") ||
    (b.added || "").localeCompare(a.added || "") ||
    compare(a.title, b.title);
  const showList = [...shows.values()]
    .map((show) => {
      show.rows.sort(newest);
      show.tracks.sort(newest);
      show.cover = show.rows.find((episode) => episode.cover)?.cover || null;
      show.latest = show.rows[0]?.date || null;
      show.added = show.rows.reduce((last, episode) => (episode.added && (!last || episode.added > last) ? episode.added : last), null);
      show.rows = show.rows.map((episode) => episode.id);
      show.tracks = show.tracks.map((episode) => episode.id);
      return show;
    })
    .sort(
      (a, b) =>
        (b.latest || "").localeCompare(a.latest || "") ||
        (b.added || "").localeCompare(a.added || "") ||
        compare(a.name, b.name),
    );
  return {
    shows: new Map(showList.map((show) => [show.id, show])),
    showOrder: showList.map((show) => show.id),
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
    albums: [
      ...library.albumOrder.map((id) => {
        const album = library.albums.get(id);
        return {
          id,
          title: album.title,
          artist: album.artist,
          cover: album.cover,
          tracks: album.tracks,
        };
      }),
      ...(library.showOrder || [])
        .map((id) => library.shows.get(id))
        .filter((show) => show.tracks.length)
        .map((show) => ({
          id: show.id,
          title: show.name,
          artist: show.name,
          cover: show.cover,
          tracks: show.tracks,
        })),
    ],
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
  const podcasts = library.showOrder?.length ? ["podcasts"] : [];
  if (!library.albumOrder.length && podcasts.length) return podcasts;
  return [
    "artists",
    "albums",
    ...(library.playlistOrder.length ? ["playlists"] : []),
    "recent",
    ...podcasts,
  ];
}

export const TAB_LABELS = {
  artists: "Artists",
  albums: "Albums",
  playlists: "Playlists",
  recent: "Recent",
  podcasts: "Podcasts",
  artist: "Artist",
};

export function librarySummary(library) {
  const episodes = [...library.tracks.values()].filter((track) => track.podcast).length;
  const songs = library.tracks.size - episodes;
  const shows = library.showOrder?.length || 0;
  const parts = [
    ...(songs || !episodes ? [plural(songs, "track", "tracks")] : []),
    ...(library.albums.size ? [plural(library.albums.size, "album", "albums")] : []),
    ...(!songs && episodes ? [plural(episodes, "episode", "episodes")] : []),
    ...(shows ? [plural(shows, "show", "shows")] : []),
  ];
  return parts.join(" · ");
}

export function librarySymbol(library) {
  return library?.showOrder?.length && !library.albums.size ? "podcast" : "music";
}

export function savedSymbol(saved) {
  const items = Array.isArray(saved?.tracks) ? saved.tracks.filter((item) => typeof item?.path === "string") : [];
  if (!items.length) return "music";
  const shows = episodeFolders(items);
  return items.every((item) => isEpisode(item) || shows.has(directoryOf(item.path))) ? "podcast" : "music";
}

export function musicPane(route, wide) {
  if (!wide || route.length < 2) return { level: route.length - 1, detail: null };
  const level = route.reduce((at, item, index) => (item.kind === "artist" ? index : at), 0);
  return { level, detail: level < route.length - 1 ? route.at(-1) : null };
}

export function musicBackLabel(route, level, library, folderName, searching) {
  if (level === 0) return "Folders";
  if (level === 1) return searching ? "Search" : folderName;
  const parent = route[level - 1];
  if (parent.kind === "artist")
    return library?.artists.find((item) => item.id === parent.id)?.name || TAB_LABELS.artist;
  if (parent.kind === "show") return library?.shows.get(parent.id)?.name || folderName;
  return TAB_LABELS[parent.kind] || folderName;
}

export function showSummary(show) {
  return [plural(show.rows.length, "episode", "episodes"), formatLength(show.duration)]
    .filter(Boolean)
    .join(" · ");
}

export function showCaption(show) {
  return [plural(show.rows.length, "episode", "episodes"), formatDay(show.latest)]
    .filter(Boolean)
    .join(" · ");
}

export function showRows(library, show) {
  let ready = 0;
  return show.rows.map((id, index) => {
    const here = library.tracks.has(id);
    const track = here ? library.tracks.get(id) : library.pending.get(id);
    return {
      track,
      title: track.title,
      state: here ? "ready" : "pending",
      position: here ? ready++ : null,
      number: index + 1,
    };
  });
}

export function trackContext(track) {
  return track?.show || track?.albumId || null;
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
      icon: sheet.track?.podcast ? "podcast" : "music",
      subtitle: sheet.track
        ? sheet.track.podcast
          ? [sheet.track.artist, formatDay(sheet.track.date)].filter(Boolean).join(" · ")
          : `${sheet.track.artist} · ${sheet.track.album}`
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

export function showTracks(library) {
  const ids = [];
  for (const id of library.showOrder || [])
    for (const track of library.shows.get(id)?.tracks || [])
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
      shows: (library.showOrder || []).map((id) => {
        const show = library.shows.get(id);
        return [show, [plain(show.name)]];
      }),
      episodes: showTracks(library).map((id) => {
        const track = library.tracks.get(id);
        return [id, [track.title, track.album].map(plain)];
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
    shows: hits(index.shows),
    episodes: hits(index.episodes),
  };
}

export function musicSearchLabel(library) {
  return !library.showOrder?.length ? "Search music" : library.albums.size ? "Search" : "Search podcasts";
}

export function episodeRows(library, ids) {
  return ids
    .map((id) => library.tracks.get(id))
    .filter(Boolean)
    .map((track, index) => ({
      track,
      title: track.title,
      state: "ready",
      position: library.shows.get(track.show)?.tracks.indexOf(track.id) ?? null,
      number: index + 1,
    }));
}

export function upNext(library, state, limit = 30) {
  const node = parseTrackNode(state?.id);
  if (!node || !library) return { name: "", current: null, shuffled: false, rows: [] };
  const base = baseContext(node.context);
  const album = library.albums.get(base);
  const playlist = library.playlists.get(base);
  const show = library.shows?.get(base);
  const ids = (album ? album.tracks : playlist ? playlist.tracks : show ? show.tracks : libraryTracks(library)).filter((id) =>
    library.tracks.has(id),
  );
  const at = Number.isSafeInteger(node.position) && ids[node.position] === node.track ? node.position : ids.indexOf(node.track);
  return {
    name: album?.title || playlist?.name || show?.name || "Library",
    show: show || null,
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

export async function spokenRepeat(spoken, kept, control) {
  const state = await control.command("state").catch(() => null);
  const repeat = state?.repeat || "off";
  if (spoken) {
    if (repeat === "off") return kept;
    await control.command("repeat", "off");
    return repeat;
  }
  if (kept && repeat === "off") await control.command("repeat", kept);
  return null;
}
