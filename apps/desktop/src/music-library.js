export const UNKNOWN_ARTIST = "Unknown artist";
export const UNKNOWN_ALBUM = "Unknown album";
export const VARIOUS_ARTISTS = "Various artists";
export const RECENTLY_ADDED = 30;
export const RECENTLY_PLAYED = 20;

const musicCollator = new Intl.Collator("en", {
  sensitivity: "base",
  numeric: true,
});
const musicCompare = (a, b) => musicCollator.compare(a, b);
const musicBase = (path) => path.slice(path.lastIndexOf("/") + 1);
const musicDirectory = (path) =>
  path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
const musicFold = (value) => value.trim().toLowerCase();

const PODCAST_GENRE = /^podcast$/i;
const SPOKEN_SECONDS = 1200;
const EPISODE_DATE = /^(\d{4}-\d{2}-\d{2})(?![\d])/;
export function episodeDate(path) {
  return EPISODE_DATE.exec(musicBase(path))?.[1] || null;
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
    (!item?.artist && !item?.albumArtist && Number.isFinite(item?.duration) && item.duration >= SPOKEN_SECONDS)
  );
}
export function episodeFolders(items) {
  const folders = new Set();
  for (const item of items || [])
    if (typeof item?.path === "string" && item.path.includes("/") && isEpisode(item))
      folders.add(musicDirectory(item.path));
  return folders;
}
export const showId = (name) => `show:${JSON.stringify(musicFold(name))}`;
export const artistId = (name) => `artist:${JSON.stringify(musicFold(name))}`;

export function trackTitle(track) {
  if (track.title) return track.title;
  const name = musicBase(track.path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}
const DISC_FOLDER = /^(cd|dis[ck])[\s._-]*\d+$/i;
function albumDirectory(path) {
  const directory = musicDirectory(path);
  const name = directory.slice(directory.lastIndexOf("/") + 1).trim();
  return directory.includes("/") && DISC_FOLDER.test(name)
    ? musicDirectory(directory)
    : directory;
}
export function albumKey(track) {
  if (track.release) return `album:${JSON.stringify(["release", track.release])}`;
  return `album:${JSON.stringify([albumDirectory(track.path), musicFold(track.albumArtist || ""), musicFold(track.album || "")])}`;
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
export function nextRepeat(mode) {
  return mode === "off" ? "all" : mode === "all" ? "one" : "off";
}
export function shuffleOrder(length, first, random = Math.random) {
  const rest = [];
  for (let index = 0; index < length; index++)
    if (index !== first) rest.push(index);
  for (let index = rest.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [rest[index], rest[other]] = [rest[other], rest[index]];
  }
  return [first, ...rest];
}
export function rememberPlayed(history, entry, limit = RECENTLY_PLAYED) {
  return [
    entry,
    ...history.filter(
      (item) => !(item.kind === entry.kind && item.id === entry.id),
    ),
  ].slice(0, limit);
}
export function playedItems(library, history) {
  const items = [];
  for (const entry of history) {
    const item =
      entry.kind === "album"
        ? library.albums.get(entry.id)
        : entry.kind === "playlist"
          ? library.playlists.find((list) => list.id === entry.id)
          : null;
    if (item) items.push({ kind: entry.kind, item });
    if (items.length === RECENTLY_PLAYED) break;
  }
  return items;
}

export function buildLibrary(raw) {
  const tracks = new Map();
  const albums = new Map();
  const episodes = [];
  const showFolders = episodeFolders(raw?.tracks);
  for (const item of raw?.tracks || []) {
    if (typeof item?.path !== "string" || tracks.has(item.path)) continue;
    const key = albumKey(item);
    const spoken = isEpisode(item) || (item.path.includes("/") && showFolders.has(musicDirectory(item.path)));
    const track = {
      path: item.path,
      hash: item.hash,
      title: spoken
        ? episodeTitle(item, item.album || musicBase(albumDirectory(item.path)))
        : trackTitle(item),
      artist: item.artist || item.albumArtist || UNKNOWN_ARTIST,
      albumArtist: item.albumArtist || null,
      album:
        item.album || musicBase(albumDirectory(item.path)) || UNKNOWN_ALBUM,
      albumId: key,
      track: Number.isSafeInteger(item.track) ? item.track : null,
      disc: Number.isSafeInteger(item.disc) ? item.disc : null,
      year: Number.isSafeInteger(item.year) ? item.year : null,
      duration: Number.isFinite(item.duration) ? item.duration : null,
      cover: typeof item.cover === "string" ? item.cover : null,
      added: item.added || null,
      podcast: spoken,
      date: episodeDate(item.path),
      pending: item.pending === true,
    };
    tracks.set(track.path, track);
    if (track.podcast) {
      episodes.push(track);
      continue;
    }
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
  const order = (a, b) =>
    (a.disc ?? 1) - (b.disc ?? 1) ||
    (a.track ?? Number.MAX_SAFE_INTEGER) -
      (b.track ?? Number.MAX_SAFE_INTEGER) ||
    musicCompare(a.path, b.path);
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
    delete album.artists;
    delete album.albumArtist;
    albumList.push(album);
  }
  albumList.sort(
    (a, b) => musicCompare(a.title, b.title) || musicCompare(a.artist, b.artist),
  );
  const artistMap = new Map();
  for (const album of albumList) {
    const key = artistId(album.artist);
    let artist = artistMap.get(key);
    if (!artist) {
      artist = { id: key, name: album.artist, albums: [], cover: null };
      artistMap.set(key, artist);
    }
    artist.albums.push(album);
  }
  const artists = [...artistMap.values()]
    .map((artist) => {
      artist.albums.sort(
        (a, b) =>
          (a.year ?? Number.MAX_SAFE_INTEGER) -
            (b.year ?? Number.MAX_SAFE_INTEGER) ||
          musicCompare(a.title, b.title),
      );
      artist.covers = [
        ...new Set(
          artist.albums
            .filter((album) => album.cover)
            .sort(
              (a, b) =>
                (b.year ?? -Infinity) - (a.year ?? -Infinity) ||
                musicCompare(a.title, b.title),
            )
            .map((album) => album.cover),
        ),
      ];
      artist.cover = artist.covers[0] || null;
      artist.letter = artistLetter(artist.name);
      return artist;
    })
    .sort(
      (a, b) =>
        (a.letter === "#") - (b.letter === "#") ||
        musicCompare(a.letter, b.letter) ||
        musicCompare(a.name, b.name),
    );
  const recent = albumList
    .filter((album) => album.added)
    .sort((a, b) => (a.added < b.added ? 1 : a.added > b.added ? -1 : 0))
    .slice(0, RECENTLY_ADDED);
  const showMap = new Map();
  for (const episode of episodes) {
    const name = episode.album;
    const key = showId(name);
    let show = showMap.get(key);
    if (!show) {
      show = { id: key, name, tracks: [], cover: null, latest: null, duration: 0 };
      showMap.set(key, show);
    }
    show.tracks.push(episode);
    show.duration += episode.duration || 0;
  }
  const newest = (a, b) =>
    (b.date || "").localeCompare(a.date || "") ||
    (b.added || "").localeCompare(a.added || "") ||
    musicCompare(a.title, b.title);
  const shows = [...showMap.values()].map((show) => {
    show.tracks.sort(newest);
    show.cover = show.tracks.find((episode) => episode.cover)?.cover || null;
    show.latest = show.tracks[0].date;
    return show;
  });
  shows.sort(
    (a, b) => (b.latest || "").localeCompare(a.latest || "") || musicCompare(a.name, b.name),
  );
  const playlists = [];
  for (const list of raw?.playlists || []) {
    if (typeof list?.path !== "string" || !Array.isArray(list.entries)) continue;
    const entries = list.entries.map((path, position) => ({
      position,
      path: typeof path === "string" ? path : null,
      track: typeof path === "string" ? tracks.get(path) || null : null,
    }));
    const playable = entries.filter((entry) => entry.track);
    playlists.push({
      id: list.path,
      name: typeof list.name === "string" && list.name ? list.name : musicBase(list.path),
      hash: list.hash,
      editable: !!list.editable,
      entries,
      tracks: playable.map((entry) => entry.track),
      positions: playable.map((entry) => entry.position),
      cover: playable.find((entry) => entry.track.cover)?.track.cover || null,
      duration: playable.reduce((total, entry) => total + (entry.track.duration || 0), 0),
    });
  }
  playlists.sort((a, b) => musicCompare(a.name, b.name) || musicCompare(a.id, b.id));
  return {
    tracks,
    albums: new Map(albumList.map((album) => [album.id, album])),
    albumList,
    artists,
    recent,
    shows,
    playlists,
  };
}
