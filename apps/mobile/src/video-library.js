import { formatDuration, formatLength, plural } from "./music-library.js";
import { fraction, timeLeft } from "./audio-positions.js";
import { languageCode } from "./video-audio.js";

export const TAB_LABELS = {
  home: "Home",
  movies: "Movies",
  shows: "TV Shows",
  kids: "Kids",
  other: "Others",
};
export const MOVIE_SORTS = [
  { value: "title", label: "A–Z" },
  { value: "added", label: "Recently added" },
  { value: "year", label: "Year" },
  { value: "rating", label: "Rating" },
];
export const SHELF_LIMIT = 20;
export const GRID_GAP = 12;
export const GRID_BUFFER = 3;
export const GRID_FIRST_ROWS = 12;
export const WATCH_REASONS = new Set(["resume", "next", "related", "new", "waiting"]);
export const RELATED_LIMIT = 12;
export const UP_NEXT_SECONDS = 30;
export const UP_NEXT_COUNTDOWN = 10000;
export const SAVE_EVERY = 10000;
export const MIN_POSITION = 10;

const text = (value) => (typeof value === "string" ? value : "");
const number = (value) => (Number.isFinite(value) ? value : 0);
const strings = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === "string") : []);
const stamp = (value) => (typeof value === "string" ? Date.parse(value) || 0 : number(value));
const languageNames = (value) =>
  [...new Set((Array.isArray(value) ? value : []).map((entry) => (typeof entry === "string" ? entry : text(entry?.label) || text(entry?.language))).filter(Boolean))];
const artKey = (value) => (typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : null);

function file(raw) {
  const position =
    raw.position && Number.isFinite(raw.position.position)
      ? {
          position: raw.position.position,
          duration: number(raw.position.duration),
          updated: number(raw.position.updated),
          device: text(raw.position.device) || null,
        }
      : null;
  return {
    path: raw.path,
    hash: text(raw.hash),
    rev: number(raw.rev),
    size: number(raw.size),
    duration: number(raw.duration),
    width: number(raw.width),
    height: number(raw.height),
    videoCodec: text(raw.videoCodec),
    audioCodec: text(raw.audioCodec),
    container: text(raw.container),
    subtitles: (Array.isArray(raw.subtitles) ? raw.subtitles : [])
      .filter((item) => item && (typeof item.path === "string" || (item.embedded === true && Number.isSafeInteger(item.stream))))
      .map((item) =>
        item.embedded === true
          ? { embedded: true, stream: item.stream, language: text(item.language), label: text(item.label) || text(item.language), forced: item.forced === true, image: item.image === true }
          : { path: item.path, language: text(item.language), label: text(item.label) || text(item.language) },
      ),
    audioTracks: (Array.isArray(raw.audioTracks) ? raw.audioTracks : [])
      .filter((track) => track && typeof track === "object")
      .map((track) => ({ stream: number(track.stream), codec: text(track.codec), language: text(track.language), label: text(track.label), channels: number(track.channels), default: track.default === true })),
    audioLanguages: languageNames(raw.audioLanguages),
    subtitleLanguages: languageNames(raw.subtitleLanguages),
    position,
    watched: raw.watched === true,
    added: stamp(raw.added),
  };
}

function titleFields(raw) {
  return {
    title: text(raw.title) || "Untitled",
    year: Number.isSafeInteger(raw.year) ? raw.year : null,
    overview: text(raw.overview),
    genres: strings(raw.genres),
    certification: text(raw.certification),
    rating: number(raw.rating),
    cast: strings(raw.cast).slice(0, 5),
    kids: raw.kids === true,
    poster: artKey(raw.poster),
    backdrop: artKey(raw.backdrop),
    tmdb: Number.isSafeInteger(raw.tmdb) ? raw.tmdb : null,
    matched: raw.matched === true,
    added: stamp(raw.added),
    audioLanguages: languageNames(raw.audioLanguages),
    subtitleLanguages: languageNames(raw.subtitleLanguages),
    related: strings(raw.related).slice(0, RELATED_LIMIT),
  };
}

const playable = (raw) => raw && typeof raw === "object" && typeof raw.id === "string" && typeof raw.path === "string" && !!raw.path;

export function normalizeLibrary(value) {
  if (!value || typeof value !== "object") return null;
  const items = new Map();
  const movies = (Array.isArray(value.movies) ? value.movies : []).filter(playable).map((raw) => ({
    ...file(raw),
    ...titleFields(raw),
    id: raw.id,
    kind: "movie",
    runtime: number(raw.runtime),
    collection: text(raw.collection) || null,
  }));
  const shows = (Array.isArray(value.shows) ? value.shows : [])
    .filter((raw) => raw && typeof raw.id === "string")
    .map((raw) => {
      const show = { ...titleFields(raw), id: raw.id, kind: "show", seasons: [] };
      for (const season of Array.isArray(raw.seasons) ? raw.seasons : []) {
        if (!season || !Number.isSafeInteger(season.season)) continue;
        const episodes = (Array.isArray(season.episodes) ? season.episodes : [])
          .filter(playable)
          .map((ep) => ({
            ...file(ep),
            id: ep.id,
            kind: "episode",
            show: show.id,
            season: season.season,
            episode: Number.isSafeInteger(ep.episode) ? ep.episode : 0,
            title: text(ep.title),
            overview: text(ep.overview),
            still: artKey(ep.still),
            aired: text(ep.aired),
          }))
          .sort((a, b) => a.episode - b.episode || a.path.localeCompare(b.path));
        if (episodes.length) show.seasons.push({ season: season.season, name: text(season.name), episodes });
      }
      show.seasons.sort((a, b) => (a.season === 0) - (b.season === 0) || a.season - b.season);
      show.added = Math.max(show.added, ...show.seasons.flatMap((season) => season.episodes.map((ep) => ep.added)), 0);
      return show;
    })
    .filter((show) => show.seasons.length);
  const other = (Array.isArray(value.other) ? value.other : []).filter(playable).map((raw) => ({
    ...file(raw),
    id: raw.id,
    kind: "other",
    title: text(raw.title) || raw.path.split("/").pop(),
    kids: false,
  }));
  for (const movie of movies) items.set(movie.id, movie);
  for (const show of shows) {
    items.set(show.id, show);
    for (const season of show.seasons) for (const ep of season.episodes) items.set(ep.id, ep);
  }
  for (const item of other) items.set(item.id, item);
  return {
    version: text(value.version),
    indexing: !!value.indexing,
    matching: !!value.matching,
    movies,
    shows,
    other,
    items,
    watchNext: (Array.isArray(value.watchNext) ? value.watchNext : [])
      .filter((entry) => typeof entry?.id === "string" && items.has(entry.id) && WATCH_REASONS.has(entry.reason) && typeof entry.title === "string" && typeof entry.caption === "string")
      .map((entry) => ({
        id: entry.id,
        reason: entry.reason,
        title: entry.title,
        caption: entry.caption,
        tag: entry.tag === "next" || entry.tag === "new" ? entry.tag : null,
        art: artKey(entry.art),
        progress: Number.isFinite(entry.progress) ? Math.max(0, Math.min(100, entry.progress)) / 100 : null,
        item: items.get(entry.id),
      })),
  };
}

export const showOf = (library, item) => (item?.kind === "episode" ? library.items.get(item.show) || null : null);
export const hasKids = (library) => !!library && library.movies.some((m) => m.kids);

export function videoTabs(library) {
  if (!library) return [];
  const tabs = [];
  if (library.movies.length || library.shows.length) tabs.push("home");
  if (library.movies.some((m) => !m.kids)) tabs.push("movies");
  if (library.shows.length) tabs.push("shows");
  if (hasKids(library)) tabs.push("kids");
  if (library.other.length) tabs.push("other");
  return tabs;
}

export const episodes = (show) => show.seasons.flatMap((season) => season.episodes);
export const episodeCode = (ep) => `S${ep.season} · E${ep.episode}`;

export function left(item) {
  const total = item.position?.duration || item.duration;
  return item.position && total ? timeLeft(total - item.position.position) : "";
}

export function progress(item) {
  return item?.position ? fraction(item.position.position, item.position.duration || item.duration) : null;
}

export function episodeCaption(ep) {
  return [episodeCode(ep), ep.position ? left(ep) : formatLength(ep.duration)].filter(Boolean).join(" · ");
}

export function episodeTitle(ep) {
  return ep.title ? `${ep.episode}. ${ep.title}` : `Episode ${ep.episode}`;
}

const byUpdated = (a, b) => (b.position?.updated || 0) - (a.position?.updated || 0);

export function nextEpisode(show) {
  const list = episodes(show).filter((ep) => ep.season !== 0);
  const all = list.length ? list : episodes(show);
  const started = all.filter((ep) => ep.position && !ep.watched).sort(byUpdated)[0];
  if (started) return started;
  let last = -1;
  all.forEach((ep, index) => {
    if (ep.watched) last = index;
  });
  return all.slice(last + 1).find((ep) => !ep.watched) || all[0] || null;
}

export function followingEpisode(library, ep) {
  const show = showOf(library, ep);
  if (!show) return null;
  const list = episodes(show).filter((item) => (ep.season === 0 ? item.season === 0 : item.season !== 0));
  const index = list.findIndex((item) => item.id === ep.id);
  return index >= 0 ? list[index + 1] || null : null;
}

export function watchedCount(show) {
  const list = episodes(show);
  return { watched: list.filter((ep) => ep.watched).length, total: list.length };
}

export function seasonLabel(season) {
  return season.season === 0 ? season.name || "Specials" : season.name || `Season ${season.season}`;
}

export function runtimeOf(movie) {
  return movie.duration || movie.runtime * 60;
}

export function ratingLabel(rating) {
  return rating > 0 ? `★ ${rating.toFixed(1)}` : "";
}

export function watchedLine(show) {
  const { watched, total } = watchedCount(show);
  return `${watched} of ${total} watched`;
}

export function quality(item) {
  if (item.width >= 3800 || item.height >= 2000) return "4K";
  if (item.width >= 1280 || item.height >= 720) return "HD";
  return "";
}

export function surround(item) {
  const tracks = item.audioTracks || [];
  const channels = (tracks.find((track) => track.default) || tracks[0])?.channels || 0;
  return channels >= 8 ? "7.1" : channels >= 6 ? "5.1" : "";
}

export function titleFile(library, item) {
  if (item?.kind !== "show") return item || null;
  return (library && playTarget(library, item)) || episodes(item)[0] || null;
}

export function titleFacts(item, library = null) {
  const show = item.kind === "show";
  const seasons = show ? item.seasons.filter((season) => season.season !== 0).length || item.seasons.length : 0;
  const media = titleFile(library, item);
  return [
    item.rating > 0 && { kind: "rating", text: ratingLabel(item.rating) },
    item.certification && { kind: "badge", text: item.certification },
    item.year && { kind: "text", text: String(item.year) },
    show ? { kind: "text", text: plural(seasons, "season", "seasons") } : formatLength(runtimeOf(item)) && { kind: "text", text: formatLength(runtimeOf(item)) },
    item.genres.length > 0 && { kind: "text", text: item.genres.slice(0, 3).join(", ") },
    media && quality(media) && { kind: "badge", text: quality(media) },
    media && surround(media) && { kind: "badge", text: surround(media) },
  ].filter(Boolean);
}


const readableSubtitle = (row) => !!row && !row.image && !row.forced && !/forced/i.test(row.label || "");
const capChips = (list, shown = 3) => (list.length > shown ? [...list.slice(0, shown), `+${list.length - shown}`] : list);
const spokenNames = (rows) => [...new Set(rows.filter((row) => row.language).map((row) => String(row.label || row.language).split(/ · | \(/)[0]))];

export function languageChips(item) {
  const tracks = [...(item.audioTracks || []).filter((track) => track.default), ...(item.audioTracks || []).filter((track) => !track.default)];
  const audio = [...new Set(tracks.map((track) => languageCode(track.language).toUpperCase()).filter(Boolean))];
  const readable = (item.subtitles || []).filter(readableSubtitle);
  const subtitles = [...new Set(readable.map((row) => languageCode(row.language).toUpperCase()).filter(Boolean))];
  if (!subtitles.length && readable.length) subtitles.push("?");
  return {
    audio: capChips(audio),
    subtitles: capChips(subtitles),
    audioLabel: `Audio: ${spokenNames(tracks).join(", ")}`,
    subtitleLabel: `Subtitles: ${(spokenNames(readable).length ? spokenNames(readable) : ["unknown language"]).join(", ")}`,
  };
}

export function resumeLine(item) {
  if (!item?.position) return "";
  return `From ${formatDuration(item.position.position) || "0:00"} · ${left(item)}`;
}

export function librarySummary(library) {
  if (!library) return "";
  const parts = [];
  if (library.movies.length) parts.push(plural(library.movies.length, "movie", "movies"));
  if (library.shows.length) parts.push(plural(library.shows.length, "show", "shows"));
  if (library.other.length) parts.push(plural(library.other.length, "other video", "other videos"));
  return parts.join(" · ") || "No videos yet";
}

function watchCard(entry) {
  const { item } = entry;
  return {
    key: `${entry.reason}:${item.id}`,
    item,
    title: entry.title,
    caption: entry.caption,
    art: entry.art,
    progress: entry.progress,
    next: entry.tag === "next",
    fresh: entry.tag === "new",
    removable: true,
    icon: item.kind === "show" || item.kind === "episode" ? "tv" : "clapperboard",
  };
}

function card(library, item, kind) {
  return {
    key: `${kind}:${item.id}`,
    item,
    title: item.title,
    caption: item.year ? String(item.year) : "",
    rating: ratingLabel(item.rating),
    art: item.poster,
    progress: item.kind === "show" ? null : progress(item),
    watched: item.kind === "show" ? watchedCount(item).watched === watchedCount(item).total : item.watched,
    icon: item.kids ? "smile" : item.kind === "show" ? "tv" : "clapperboard",
  };
}

const recent = (a, b) => b.added - a.added || a.title.localeCompare(b.title);

export function cardLabel(card) {
  const state = card.watched ? "watched" : card.progress != null ? `${Math.round(card.progress * 100)}% watched` : card.next ? "next" : card.fresh ? "new" : "";
  return [card.title, card.caption, state].filter(Boolean).join(", ");
}

export function downloadedTitles(library, saved) {
  if (!library || !saved) return [];
  const cards = [];
  for (const item of [...library.movies, ...library.shows, ...library.other]) {
    const rows = (item.kind === "show" ? episodes(item) : [item]).map(saved).filter((row) => row?.state === "done");
    if (!rows.length) continue;
    const base = card(library, item, "saved");
    const at = Math.max(...rows.map((row) => row.added || 0));
    cards.push({ ...base, saved: true, at, caption: item.kind === "show" ? plural(rows.length, "episode", "episodes") : base.caption });
  }
  return cards.sort((a, b) => b.at - a.at || a.title.localeCompare(b.title));
}

export function videoShelves(library, saved = null) {
  if (!library) return [];
  const shelves = [
    { key: "downloads", title: "Downloads", wide: false, cards: downloadedTitles(library, saved) },
    {
      key: "watch-next",
      title: "Watch next",
      wide: true,
      cards: library.watchNext.map(watchCard),
    },
    { key: "recent", title: "Recently added", wide: false, cards: [...library.movies.filter((item) => !item.kids), ...library.shows].sort(recent).map((item) => card(library, item, "recent")) },
    { key: "kids", title: "Kids picks", wide: false, cards: library.movies.filter((item) => item.kids).sort(recent).map((item) => card(library, item, "kids")) },
  ];
  return shelves.filter((shelf) => shelf.cards.length).map((shelf) => (shelf.key === "watch-next" ? shelf : { ...shelf, cards: shelf.cards.slice(0, SHELF_LIMIT) }));
}

export const gridColumns = (wide) => (wide ? 5 : 3);

export function gridRows(cards, columns) {
  const rows = [];
  for (let index = 0; index < cards.length; index += columns) rows.push(cards.slice(index, index + columns));
  return rows;
}

export function gridWindow({ scroll, top, viewport, pitch, rows, buffer = GRID_BUFFER }) {
  if (rows <= 0) return { first: 0, last: -1 };
  if (!(pitch > 0)) return { first: 0, last: Math.min(rows, GRID_FIRST_ROWS) - 1 };
  const first = Math.min(rows - 1, Math.max(0, Math.floor((scroll - top) / pitch) - buffer));
  const last = Math.min(rows - 1, Math.max(first, Math.ceil((scroll - top + viewport) / pitch) + buffer));
  return { first, last };
}

export function relatedShelf(library, item) {
  const cards = (item?.related || [])
    .map((id) => library.items.get(id))
    .filter((title) => title && (title.kind === "movie" || title.kind === "show"))
    .map((title) => card(library, title, "related"));
  return cards.length ? { key: "related", title: "Related", wide: false, cards } : null;
}

const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });
const sortTitle = (title) => title.replace(/^(?:the|an?|el|la|los|las|le|les|der|die|das)\s+(?=\S)/i, "");

export function sortTitles(list, sort = "title") {
  const byTitle = (a, b) => collator.compare(sortTitle(a.title), sortTitle(b.title));
  const order = {
    title: byTitle,
    added: (a, b) => b.added - a.added || byTitle(a, b),
    year: (a, b) => (b.year || 0) - (a.year || 0) || byTitle(a, b),
    rating: (a, b) => b.rating - a.rating || byTitle(a, b),
  }[sort] || byTitle;
  return [...list].sort(order);
}

export function posterGrid(library, tab, { sort = "title" } = {}) {
  if (!library) return [];
  const list =
    tab === "movies"
      ? library.movies.filter((item) => !item.kids)
      : tab === "shows"
        ? library.shows
        : tab === "kids"
          ? library.movies.filter((item) => item.kids)
          : tab === "other"
            ? library.other
            : [];
  return sortTitles(list, tab === "other" && sort === "rating" ? "title" : sort).map((item) => card(library, item, tab));
}

export function playTarget(library, item) {
  if (!item) return null;
  if (item.kind === "show") return nextEpisode(item);
  return library.items.has(item.id) ? item : null;
}

export function playLabel(library, item) {
  const target = playTarget(library, item);
  if (!target) return "Play";
  if (item.kind === "show") return `${target.position ? "Continue" : "Play"} ${episodeCode(target)}`;
  return target.position ? "Resume" : "Play";
}

export function playerTitles(library, item) {
  const show = showOf(library, item);
  return show
    ? { title: item.title || episodeTitle(item), subtitle: `${show.title} · ${episodeCode(item)}` }
    : { title: item.title, subtitle: item.year ? String(item.year) : "" };
}

export function titleActions(item, saved = null) {
  if (!item) return [];
  const watched = item.kind === "show" ? watchedCount(item).watched === watchedCount(item).total : item.watched;
  return [watched ? "unwatched" : "watched", ...[saved || []].flat()];
}

export function deleteChoices(item, season = null) {
  if (!item) return [];
  if (item.kind === "movie") return [{ name: "delete-movie", label: "Delete movie…", title: item.title, items: [item], unit: "movie" }];
  if (item.kind === "episode") return [{ name: "delete-episode", label: "Delete episode…", title: episodeTitle(item), items: [item], unit: "episode" }];
  if (item.kind !== "show") return [];
  const chosen = item.seasons.find((entry) => entry.season === season);
  return [
    ...(chosen ? [{ name: "delete-season", label: `Delete season ${chosen.season}…`, title: item.title, season: chosen.season, items: chosen.episodes, unit: "episode" }] : []),
    { name: "delete-show", label: "Delete show…", title: item.title, items: episodes(item), unit: "episode" },
  ];
}

export function survivesDeletion(item, deleted) {
  const gone = new Set(deleted.map((entry) => entry.id));
  if (item.kind === "show") return item.seasons.some((entry) => entry.episodes.some((ep) => !gone.has(ep.id)));
  return !gone.has(item.id);
}

export function routeAfterDeletion(route, library, deleted) {
  const open = library?.items.get(route[1]?.id);
  return open && !survivesDeletion(open, deleted) ? route.slice(0, 1) : route;
}

export function downloadTargets(item) {
  if (!item) return [];
  return item.kind === "show" ? episodes(item) : [item];
}

export function watchedTargets(item) {
  if (!item) return [];
  return item.kind === "show" ? episodes(item) : [item];
}

export function artKeys(value) {
  const library = normalizeLibrary(value);
  const keys = new Set();
  if (!library) return keys;
  for (const item of library.items.values())
    for (const key of [item.poster, item.backdrop, item.still]) if (key) keys.add(key);
  return keys;
}

export function videoBackLabel(route) {
  return TAB_LABELS[route?.[0]?.kind] || "Library";
}

export function videoSheet(sheet) {
  if (sheet?.kind === "video-watch")
    return { title: sheet.card.title, icon: sheet.card.icon, subtitle: ["Watch next", sheet.card.caption].filter(Boolean).join(" · "), menu: true };
  if (sheet?.kind !== "video-actions") return null;
  const item = sheet.item;
  if (item.kind === "episode")
    return { title: episodeTitle(item), icon: "tv", subtitle: [sheet.showTitle, episodeCode(item)].filter(Boolean).join(" · "), menu: true };
  return {
    title: item.title,
    icon: item.kind === "show" ? "tv" : "clapperboard",
    subtitle: [item.year, TAB_LABELS[item.kind === "show" ? "shows" : item.kind === "movie" ? "movies" : "other"], sheet.folder]
      .filter(Boolean)
      .join(" · "),
    menu: true,
  };
}

export function searchVideos(library, tokens, fold) {
  if (!library || !tokens.length) return [];
  const matches = (value) => {
    const folded = fold(value);
    return tokens.every((token) => folded.includes(token));
  };
  const rows = [];
  for (const movie of library.movies)
    if (matches(movie.title)) rows.push({ id: movie.id, kind: "movie", title: movie.title, year: movie.year, path: movie.path, poster: movie.poster, kids: movie.kids });
  for (const show of library.shows) {
    if (matches(show.title)) rows.push({ id: show.id, kind: "show", title: show.title, year: show.year, poster: show.poster, episodes: episodes(show).length });
    for (const ep of episodes(show))
      if (ep.title && matches(ep.title))
        rows.push({ id: ep.id, kind: "episode", title: ep.title, show: show.title, showId: show.id, code: episodeCode(ep), path: ep.path, poster: ep.still || show.poster });
  }
  return rows;
}

export function shelfTarget(item) {
  if (item?.kind === "other") return { play: true };
  if (item?.kind === "episode") return { route: { kind: "title", id: item.show, episode: item.id } };
  return { route: { kind: "title", id: item.id } };
}

export function videoSearchRoute(row) {
  const tab = { kind: row.kids ? "kids" : row.kind === "movie" ? "movies" : "shows" };
  if (row.kind === "episode") return [tab, { kind: "title", id: row.showId, episode: row.id }];
  return [tab, { kind: "title", id: row.id }];
}

export const libraryRoute = (volume, version) =>
  `/v1/video/library?${new URLSearchParams({ volume, ...(version ? { version } : {}) })}`;
export const artRoute = (volume, key, size) => `/v1/video/art?${new URLSearchParams({ volume, key, size })}`;
export const mediaRoute = (volume, item) => `/v1/video/media?${new URLSearchParams({ volume, path: item.path, hash: item.hash })}`;
export function positionBody(volume, item, position, duration) {
  return {
    volume,
    path: item.path,
    hash: item.hash,
    position: Math.max(0, Math.round(position)),
    duration: Math.max(0, Math.round(duration || item.duration || 0)),
  };
}
