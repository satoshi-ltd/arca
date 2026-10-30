export const RECENT_VIDEOS = 20;
export const UP_NEXT_SECONDS = 30;
export const VIDEO_SORTS = { az: "A–Z", added: "Recently added", year: "Year", rating: "Rating" };
export const VIDEO_TABS = { home: "Home", movies: "Movies", shows: "TV Shows", kids: "Kids", other: "Others" };

const videoCollator = new Intl.Collator("en", { sensitivity: "base", numeric: true });
const videoCompare = (a, b) => videoCollator.compare(String(a ?? ""), String(b ?? ""));
export const sortTitle = (title) => String(title ?? "").replace(/^(?:the|an?|el|la|los|las|le|les|der|die|das)\s+(?=\S)/i, "");
const newer = (a, b) => String(b ?? "").localeCompare(String(a ?? ""));
const count = (n, word) => `${n.toLocaleString("en")} ${word}${n === 1 ? "" : "s"}`;

export function videoLength(seconds) {
  const minutes = Math.round((Number(seconds) || 0) / 60);
  if (minutes <= 0) return "";
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;
}
export function timeLeftLabel(seconds) {
  const minutes = Math.max(1, Math.round((Number(seconds) || 0) / 60));
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min left` : `${minutes} min left`;
}
export function videoClock(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = String(total % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}
export function itemDuration(item) {
  if (Number(item?.duration) > 0) return Number(item.duration);
  if (Number(item?.position?.duration) > 0) return Number(item.position.duration);
  return Number(item?.runtime) > 0 ? Number(item.runtime) * 60 : 0;
}
export function inProgress(item) {
  const saved = item?.position;
  return !!saved && Number(saved.position) > 0 && Number(saved.duration) > Number(saved.position);
}
export function progressPercent(item) {
  if (!inProgress(item)) return 0;
  return Math.min(100, Math.max(0, Math.round((item.position.position / item.position.duration) * 100)));
}
export function episodeCode(episode) {
  const season = Number.isSafeInteger(episode?.season) ? `S${episode.season}` : "";
  const number = Number.isSafeInteger(episode?.episode) ? `E${episode.episode}` : "";
  return [season, number].filter(Boolean).join(" · ");
}
export function videoProgressLabel(item) {
  const left = inProgress(item) ? timeLeftLabel(item.position.duration - item.position.position) : "";
  if (item?.kind === "episode") return [episodeCode(item), left].filter(Boolean).join(" · ");
  return left;
}
export function episodeMeta(episode) {
  const tail = inProgress(episode) ? timeLeftLabel(episode.position.duration - episode.position.position) : videoLength(itemDuration(episode));
  return [episodeCode(episode), tail].filter(Boolean).join(" · ");
}
export function episodeName(episode) {
  const title = episode?.title || "";
  return Number.isSafeInteger(episode?.episode) ? `${episode.episode}. ${title || `Episode ${episode.episode}`}` : title || "Episode";
}
export function seasonName(season) {
  return season === 0 ? "Specials" : `Season ${season}`;
}
const VIDEO_CODECS = { h264: "H.264", avc: "H.264", hevc: "HEVC", h265: "HEVC", av1: "AV1", vp9: "VP9", vp8: "VP8", mpeg4: "MPEG-4", mpeg2video: "MPEG-2", vc1: "VC-1" };
const AUDIO_CODECS = { aac: "AAC", ac3: "AC3", eac3: "E-AC3", dts: "DTS", truehd: "TrueHD", opus: "Opus", mp3: "MP3", flac: "FLAC", vorbis: "Vorbis", pcm_s16le: "PCM" };
const codecName = (names, codec) => (codec ? names[String(codec).toLowerCase()] || String(codec).toUpperCase() : "");
export function videoResolution(item) {
  const width = Number(item?.width) || 0;
  const height = Number(item?.height) || 0;
  if (width >= 3800 || height >= 2000) return "2160p";
  if (width >= 2500 || height >= 1400) return "1440p";
  if (width >= 1900 || height >= 1000) return "1080p";
  if (width >= 1260 || height >= 700) return "720p";
  return height ? `${height}p` : "";
}
export function videoFormat(item) {
  return [
    item?.videoCodec ? `${codecName(VIDEO_CODECS, item.videoCodec)} video` : "",
    item?.audioCodec ? `${codecName(AUDIO_CODECS, item.audioCodec)} audio` : "",
  ]
    .filter(Boolean)
    .join(", ");
}
export function videoTechLine(item) {
  return [item?.year, videoResolution(item), codecName(VIDEO_CODECS, item?.videoCodec), codecName(AUDIO_CODECS, item?.audioCodec)].filter(Boolean).join(" · ");
}
export function ratingLabel(rating) {
  return Number(rating) > 0 ? `★ ${Number(rating).toFixed(1)}` : "";
}
export function showWatched(show) {
  const episodes = show?.episodes || [];
  return { watched: episodes.filter((episode) => episode.watched).length, total: episodes.length };
}
export function fullyWatched(item) {
  if (item?.kind !== "show") return item?.watched === true;
  const { watched, total } = showWatched(item);
  return total > 0 && watched === total;
}
export function showSubtitle(show) {
  const { watched, total } = showWatched(show);
  if (watched) return `${watched} of ${total} watched`;
  const seasons = (show?.seasons || []).filter((season) => season.season !== 0).length;
  return seasons ? count(seasons, "season") : count(total, "episode");
}
export function videoQuality(file) {
  const resolution = videoResolution(file);
  return resolution === "2160p" ? "4K" : resolution === "1080p" || resolution === "720p" || resolution === "1440p" ? "HD" : "";
}
export function videoSurround(file) {
  const tracks = file?.audioTracks || [];
  const track = tracks.find((row) => row.default) || tracks[0];
  const channels = Number(track?.channels) || 0;
  return channels >= 8 ? "7.1" : channels >= 6 ? "5.1" : "";
}
export function titleFile(item) {
  if (item?.kind !== "show") return item;
  return nextEpisode(item) || item.episodes?.[0] || null;
}
export function videoFacts(item) {
  const file = titleFile(item);
  const seasons = item?.kind === "show" ? (item.seasons || []).filter((season) => season.season !== 0).length : 0;
  return [
    { text: ratingLabel(item?.rating) },
    { text: item?.certification || "", badge: true },
    { text: item?.year ? String(item.year) : "" },
    { text: item?.kind === "show" ? (seasons ? count(seasons, "season") : "") : videoLength(itemDuration(item)) },
    { text: (item?.genres || []).join(", ") },
    { text: videoQuality(file), badge: true },
    { text: videoSurround(file), badge: true },
  ].filter((fact) => fact.text);
}
const readableSubtitle = (row) => !!row && !row.image && !row.forced && !/forced/i.test(row.label || "");
const capChips = (list, shown = 3) => (list.length > shown ? [...list.slice(0, shown), `+${list.length - shown}`] : list);
const spokenNames = (rows) => [...new Set(rows.filter((row) => row.language).map((row) => String(row.label || row.language).split(/ · | \(/)[0]))];
export function languageChips(item) {
  const file = titleFile(item);
  if (!file) return null;
  const tracks = [...(file.audioTracks || []).filter((track) => track.default), ...(file.audioTracks || []).filter((track) => !track.default)];
  const audio = [...new Set(tracks.map((track) => languageCode(track.language).toUpperCase()).filter(Boolean))];
  const readable = (file.subtitles || []).filter(readableSubtitle);
  const subtitles = [...new Set(readable.map((row) => languageCode(row.language).toUpperCase()).filter(Boolean))];
  if (!subtitles.length && readable.length) subtitles.push("?");
  return {
    audio: capChips(audio),
    subtitles: capChips(subtitles),
    audioLabel: `Audio: ${spokenNames(tracks).join(", ")}`,
    subtitleLabel: `Subtitles: ${(spokenNames(readable).length ? spokenNames(readable) : ["unknown language"]).join(", ")}`,
  };
}
export function posterSubtitle(item) {
  return item?.year ? String(item.year) : "";
}
const MIME = { mkv: "video/x-matroska", avi: "video/x-msvideo", webm: "video/webm", mov: "video/quicktime", mp4: "video/mp4", m4v: "video/mp4" };
export function videoExtension(item) {
  const name = String(item?.path || "");
  const dot = name.lastIndexOf(".");
  const extension = dot > name.lastIndexOf("/") ? name.slice(dot + 1).toLowerCase() : "";
  if (MIME[extension]) return extension;
  const container = String(item?.container || "").toLowerCase();
  return container.includes("matroska") ? "mkv" : container.includes("avi") ? "avi" : container.includes("mp4") ? "mp4" : extension;
}
export function videoFinished(position, duration) {
  const total = Number(duration) || 0;
  return total > 0 && Number(position) >= total - Math.min(Math.max(120, total * 0.05), total * 0.1);
}
const LONG_LANGUAGES = { eng: "en", spa: "es", fre: "fr", fra: "fr", ger: "de", deu: "de", ita: "it", por: "pt", jpn: "ja", kor: "ko", chi: "zh", zho: "zh", rus: "ru", cat: "ca", dut: "nl", nld: "nl", swe: "sv", nor: "no", dan: "da", fin: "fi", pol: "pl" };
export function languageCode(value) {
  const code = String(value || "").toLowerCase().split(/[-_]/)[0];
  return LONG_LANGUAGES[code] || code;
}
export function sameLanguage(a, b) {
  return !!languageCode(a) && languageCode(a) === languageCode(b);
}
export function channelLabel(channels) {
  return channels >= 8 ? "7.1" : channels >= 6 ? "5.1" : channels === 2 ? "2.0" : channels === 1 ? "1.0" : "";
}
export function audioOptions(engineTracks, libraryTracks) {
  const tracks = [...(engineTracks || [])];
  const known = Array.isArray(libraryTracks) ? libraryTracks : [];
  if (tracks.length < 2) return null;
  const used = new Set();
  const options = tracks.map((track, index) => {
    const byOrder = known[index] && (!track?.language || !known[index].language || sameLanguage(track.language, known[index].language)) ? index : -1;
    const byLanguage = known.findIndex((entry, at) => !used.has(at) && sameLanguage(entry.language, track?.language));
    const at = byOrder >= 0 && !used.has(byOrder) ? byOrder : byLanguage;
    if (at >= 0) used.add(at);
    const match = at >= 0 ? known[at] : null;
    if (!match) return null;
    const channels = channelLabel(Number(match.channels) || 0);
    const name = match.label || track?.label || match.language || `Track ${index + 1}`;
    return { index, stream: at, label: channels ? `${name} · ${channels}` : name, language: languageCode(track?.language || match.language), default: !!match.default };
  });
  return options.every(Boolean) ? options : null;
}
const DIRECT_CONTAINERS = new Set(["mp4", "mov", "m4v"]);
const DIRECT_AUDIO = new Set(["aac", "mp3", "ac3", "eac3", "alac", "flac"]);
export function needsCompatible(item, audio = null) {
  if (!DIRECT_CONTAINERS.has(videoExtension(item))) return true;
  const tracks = item?.audioTracks || [];
  const track = tracks[audio ?? -1] || tracks.find((row) => row.default) || tracks[0];
  const codec = String(track?.codec || item?.audioCodec || "").toLowerCase();
  return !!codec && !DIRECT_AUDIO.has(codec);
}
export function upNextDue(current, duration, threshold = UP_NEXT_SECONDS) {
  return Number(duration) > threshold && Number(current) >= Number(duration) - threshold;
}

function orderedEpisodes(show) {
  const regular = show.episodes.filter((episode) => episode.season !== 0);
  return regular.length ? regular : show.episodes;
}
export function nextEpisode(show) {
  const episodes = orderedEpisodes(show || { episodes: [] });
  if (!episodes.length) return null;
  const started = episodes
    .filter((episode) => inProgress(episode) && !episode.watched)
    .sort((a, b) => (Number(b.position.updated) || 0) - (Number(a.position.updated) || 0))[0];
  if (started) return started;
  let last = -1;
  episodes.forEach((episode, index) => {
    if (episode.watched) last = index;
  });
  if (last === -1) return episodes[0];
  return episodes.slice(last + 1).find((episode) => !episode.watched) || null;
}
export function episodeAfter(show, episode) {
  if (!show || !episode) return null;
  const episodes = show.episodes;
  const index = episodes.findIndex((item) => item.id === episode.id);
  if (index < 0) return null;
  const next = episodes[index + 1];
  return next && (next.season !== 0 || episode.season === 0) ? next : null;
}
export function sortVideos(list, sort = "az") {
  const title = (a, b) => videoCompare(sortTitle(a.title), sortTitle(b.title)) || videoCompare(a.id, b.id);
  const ordered = [...list];
  if (sort === "added") return ordered.sort((a, b) => newer(a.added, b.added) || title(a, b));
  if (sort === "year") return ordered.sort((a, b) => (Number(b.year) || 0) - (Number(a.year) || 0) || title(a, b));
  if (sort === "rating") return ordered.sort((a, b) => (Number(b.rating) || 0) - (Number(a.rating) || 0) || title(a, b));
  return ordered.sort(title);
}
export function videoTabs(library) {
  const tabs = [];
  if (library.movies.length || library.shows.length) tabs.push("home");
  if (grownUp(library.movies).length) tabs.push("movies");
  if (library.shows.length) tabs.push("shows");
  if (hasKids(library)) tabs.push("kids");
  if (library.other.length) tabs.push("other");
  return tabs;
}
export const grownUp = (list) => list.filter((item) => !item.kids);
export function hasKids(library) {
  return library.movies.some((movie) => movie.kids);
}
export function downloadedTitles(library, rows) {
  const byPath = new Map();
  for (const item of library.items.values()) if (item.path) byPath.set(item.path, item);
  const titles = new Map();
  for (const row of rows || []) {
    if (!row?.path) continue;
    const item = byPath.get(row.path);
    if (!item || row.state !== "done" || item.hash !== row.hash) continue;
    const title = item.kind === "episode" ? library.items.get(item.show) : item;
    if (title) titles.set(title.id, title);
  }
  return [...titles.values()];
}
export const WATCH_REASONS = new Set(["resume", "next", "related", "new", "waiting"]);
export function videoShelves(library, limit = RECENT_VIDEOS, downloaded = []) {
  const shelves = [
    { id: "downloads", label: "Downloads", items: downloaded },
    { id: "watch-next", label: "Watch next", items: library.watchNext.map((entry) => entry.item), entries: library.watchNext },
    { id: "movies", label: "Recently added movies", items: sortVideos(grownUp(library.movies).filter((item) => item.added), "added").slice(0, limit) },
    { id: "shows", label: "Recently added shows", items: sortVideos(grownUp(library.shows).filter((item) => item.added), "added").slice(0, limit) },
    { id: "kids", label: "Kids picks", items: sortVideos(library.movies.filter((item) => item.kids), "added").slice(0, limit) },
  ];
  return shelves.filter((shelf) => shelf.items.length);
}
function fileFields(row) {
  return {
    ...row,
    subtitles: Array.isArray(row.subtitles) ? row.subtitles : [],
    position: row.position && Number(row.position.position) > 0 ? row.position : null,
    watched: row.watched === true,
  };
}
export function buildVideoLibrary(raw) {
  const items = new Map();
  const movies = [];
  for (const row of raw?.movies || []) {
    if (typeof row?.id !== "string" || items.has(row.id)) continue;
    const movie = { ...fileFields(row), kind: "movie", title: row.title || "Untitled", genres: row.genres || [], cast: row.cast || [] };
    items.set(movie.id, movie);
    movies.push(movie);
  }
  const shows = [];
  for (const row of raw?.shows || []) {
    if (typeof row?.id !== "string" || items.has(row.id)) continue;
    const show = { ...row, kind: "show", title: row.title || "Untitled", genres: row.genres || [], cast: row.cast || [], seasons: [], episodes: [] };
    const seasons = [...(row.seasons || [])]
      .filter((season) => Number.isSafeInteger(season?.season))
      .sort((a, b) => (a.season === 0) - (b.season === 0) || a.season - b.season);
    for (const season of seasons) {
      const episodes = (season.episodes || [])
        .filter((episode) => typeof episode?.id === "string" && !items.has(episode.id))
        .map((episode) => ({ ...fileFields(episode), kind: "episode", show: show.id, showTitle: show.title, season: season.season }))
        .sort((a, b) => (a.episode ?? Number.MAX_SAFE_INTEGER) - (b.episode ?? Number.MAX_SAFE_INTEGER) || videoCompare(a.path, b.path));
      for (const episode of episodes) items.set(episode.id, episode);
      show.seasons.push({ season: season.season, name: season.name || seasonName(season.season), episodes });
      show.episodes.push(...episodes);
    }
    if (!show.added) show.added = show.episodes.map((episode) => episode.added).filter(Boolean).sort().at(-1) || null;
    items.set(show.id, show);
    shows.push(show);
  }
  const other = [];
  for (const row of raw?.other || []) {
    if (typeof row?.id !== "string" || items.has(row.id)) continue;
    const item = { ...fileFields(row), kind: "other", title: row.title || String(row.path || "").split("/").pop() };
    items.set(item.id, item);
    other.push(item);
  }
  const watchNext = (Array.isArray(raw?.watchNext) ? raw.watchNext : [])
    .map((entry) => ({ ...entry, item: items.get(entry?.id) }))
    .filter((entry) => entry.item && WATCH_REASONS.has(entry.reason) && typeof entry.title === "string" && typeof entry.caption === "string");
  return {
    version: raw?.version ?? null,
    movies: sortVideos(movies),
    shows: sortVideos(shows),
    other: sortVideos(other),
    items,
    watchNext,
  };
}
