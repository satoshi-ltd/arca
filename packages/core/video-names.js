import { searchFold } from "./search.js";

export const VIDEO_TYPES = new Set(["mp4", "m4v", "mov", "mkv", "webm", "avi"]);
export const SUBTITLE_TYPES = new Set(["srt", "vtt"]);
const MIME = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  webm: "video/webm",
  avi: "video/x-msvideo",
};

const baseName = (name) => String(name).slice(String(name).lastIndexOf("/") + 1);
export function extensionOf(name) {
  const base = baseName(name);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}
export function stemOf(name) {
  const base = baseName(name);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}
export const videoType = (name) => MIME[extensionOf(name)] || null;
export const subtitleType = (name) => (SUBTITLE_TYPES.has(extensionOf(name)) ? extensionOf(name) : null);

const STRONG = new Set([
  "480p", "540p", "576p", "720p", "1080p", "1080i", "1440p", "2160p", "4320p", "4k", "8k", "uhd",
  "bluray", "blu-ray", "bdrip", "brrip", "bdremux", "bd25", "bd50", "web-dl", "webdl", "webrip", "web-rip",
  "hdtv", "pdtv", "sdtv", "dvdrip", "dvdscr", "dvd5", "dvd9", "hdrip", "hdcam", "telesync", "vhsrip",
  "x264", "x265", "h264", "h265", "hevc", "avc", "av1", "xvid", "divx", "vp9", "mpeg2",
  "dts", "dts-hd", "dtshd", "dts-x", "truehd", "atmos", "aac", "ac3", "eac3", "dd", "ddp", "flac", "opus", "mp3",
  "dd51", "ddp51", "dd71", "ddp71", "ddp20", "aac20", "aac51", "ac351", "eac351", "dts51", "truehd71", "atmos71", "ch51", "ch71", "ch20",
  "hdr", "hdr10", "hdr10+", "hdr10plus", "dv", "dovi", "dolbyvision", "sdr", "10bit", "8bit", "12bit", "hi10p",
  "remux", "proper", "repack", "rerip", "internal", "limited", "unrated", "uncut", "extended", "remastered",
  "imax", "criterion", "multi", "dual", "dubbed", "subbed", "multisubs", "vostfr", "castellano",
  "amzn", "nf", "dsnp", "hmax", "atvp", "hulu", "pcok", "pmtp", "itunes", "mkv", "mp4",
]);
const WEAK = new Set(["web", "dvd", "hd", "sd", "fhd", "cam", "ts", "tc", "r5", "scr", "screener", "spanish", "english", "latino", "subs", "sub", "esp", "eng", "spa"]);
const isTag = (token, strongOnly) => {
  const value = token.toLowerCase().replace(/^-+|-+$/g, "");
  const head = value.split("-")[0];
  if (STRONG.has(value) || STRONG.has(head)) return true;
  if (/^\d{3,4}[pi]$/.test(head)) return true;
  if (/^(19|20)\d{2}[pi]$/.test(head)) return true;
  return !strongOnly && (WEAK.has(value) || WEAK.has(head));
};
const isYear = (token) => /^(19|20)\d{2}$/.test(token);

function prepare(text) {
  return text
    .replace(/\{(?:tmdb|tmdbid|tvdb|tvdbid|imdb|imdbid|edition)-[^}]*\}/gi, " ")
    .replace(/\[(?:tmdb|tmdbid|tvdb|tvdbid|imdb|imdbid)-[^\]]*\]/gi, " ")
    .replace(/\[((?:19|20)\d{2})\]/g, " $1 ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\{[^}]*\}/g, " ")
    .replace(/^(?:www\.)?[a-z0-9-]+\.(?:com|org|net|to|me|mx|tv|cc|ws)\s+-\s+/i, "")
    .replace(/\bh[ .]?26([45])\b/gi, "h26$1")
    .replace(/\b(ddp|dd|eac3|ac3|aac|dts|truehd|atmos|flac|opus)[ .+]?([257])[ .]([01])\b/gi, "$1$2$3")
    .replace(/(^|[\s._])([257])\.([01])(?=$|[\s._-])/g, "$1ch$2$3")
    .replace(/\bdd\+/gi, "ddp")
    .replace(/\bdts[ .-]hd\b/gi, "dts-hd")
    .replace(/\bweb[ .]dl\b/gi, "web-dl")
    .replace(/\bblu[ .]ray\b/gi, "bluray");
}
const tokensOf = (text) => text.split(/[\s._()[\]{}]+/).filter(Boolean);
function tidy(tokens) {
  const words = [...tokens];
  while (words.length && /^[-–—:,;+&]+$/.test(words.at(-1))) words.pop();
  while (words.length && /^[-–—:,;+&]+$/.test(words[0])) words.shift();
  const text = words
    .join(" ")
    .replace(/\s+/g, " ")
    .replace(/[\s\-–—:,;]+$/, "")
    .replace(/^[\s\-–—:,;]+/, "")
    .trim();
  return text || null;
}

export function cleanTitle(raw, { episode = false } = {}) {
  const tokens = tokensOf(prepare(String(raw || "")));
  if (!tokens.length) return { title: null, year: null, tagged: false };
  let strong = tokens.findIndex((token, index) => (episode || index > 0) && isTag(token, true));
  const tagged = strong >= 0;
  if (strong < 0) strong = tokens.length;
  if (!episode) {
    let year = -1;
    for (let index = 1; index < strong; index++) if (isYear(tokens[index])) year = index;
    if (year > 0) {
      return { title: tidy(tokens.slice(0, year)), year: Number(tokens[year]), tagged: true };
    }
  }
  let cut = tokens.findIndex((token, index) => (episode || index > 0) && index < strong && isTag(token, false));
  if (cut < 0) cut = strong;
  return { title: tidy(tokens.slice(0, cut)), year: null, tagged: tagged || cut < tokens.length };
}

const SEASON_DIR = /^(?:season|temporada|series|saison|staffel|stagione|seizoen|temp\.?|t)[\s._-]*(\d{1,3})$/i;
const SHORT_SEASON_DIR = /^s(\d{1,3})$/i;
const SPECIALS_DIR = /^(?:specials?|especiales|extras? especiales|season[\s._-]*0+|temporada[\s._-]*0+)$/i;
const PACK_DIR = /^(.*?)[\s._-]+(?:s(\d{1,2})|season[\s._-]*(\d{1,2})|temporada[\s._-]*(\d{1,2}))(?=$|[\s._-])(?![\s._-]*e\d)/i;
const GENERIC_DIR = /^(?:tv|tv[\s._-]?shows?|shows?|series|tv[\s._-]?series|séries|anime|animes|television|televisión|television shows|programas|movies|películas|peliculas|pelis|films?|cine|videos?|vídeos|media|library|kids|niños|ninos|infantil|children|documentaries|documentales|cartoons|dibujos(?: animados)?|completed?|downloads?|descargas)$/i;
const OTHER_DIR = /^(?:home[\s._-]?videos?|other|others|other videos|personal|family videos|videos caseros|vídeos caseros|camera|camera roll|dcim|screen recordings|clips|extras|featurettes|behind the scenes|trailers|samples?|deleted scenes|interviews|bonus)$/i;
const MOVIE_DIR = /^(?:movies|películas|peliculas|pelis|films?|cine)$/i;
export const KIDS_DIR = /^(?:kids|niños|ninos|infantil)$/i;
const CAMERA = /^(?:img|vid|pxl|mvi|dsc[nf]?|dji|gopr|gp\d{2}|gh\d{2}|gx\d{2}|mov|mah|mvc|wp|video|whatsapp video|screen recording|screenrecording|screen_recording|signal|trim|vlc-record|rpreplay|snapchat|insta)[\s_.-]*\d/i;
const DATE_NAME = /^(?:19|20)\d{2}[-_.]?(?:0[1-9]|1[0-2])[-_.]?(?:0[1-9]|[12]\d|3[01])(?=$|[\sT_.-])/;
const GENERIC_STEM = /^(?:movie|film|video|main|feature|pelicula|película)$/i;
const SAMPLE = /(?:^|[\s._-])sample(?:$|[\s._-])/i;
const EPISODE_MARKERS = [
  /(?:^|[\s._\-[(])s(\d{1,3})[\s._-]?e(\d{1,4})(?:[\s._-]?-?e?\d{1,4}(?=$|[\s._\-\])]))*(?=$|[^a-z0-9]|[a-z])/i,
  /(?:^|[\s._\-[(])(\d{1,2})x(\d{2,3})(?=$|[\s._\-\])])/i,
  /(?:^|[\s._\-[(])season[\s._-]*(\d{1,3})[\s._-]*episode[\s._-]*(\d{1,4})(?=$|[^0-9])/i,
  /(?:^|[\s._\-[(])temporada[\s._-]*(\d{1,3})[\s._-]*(?:episodio|cap[ií]tulo)[\s._-]*(\d{1,4})(?=$|[^0-9])/i,
];
const LEADING_EPISODE = /^(?:e|ep|episode|episodio|cap|cap[ií]tulo|chapter)?[\s._-]*(\d{1,4})(?=$|[\s._-])/i;

function tmdbTag(segments) {
  for (const segment of [...segments].reverse()) {
    const match = /\{tmdb(?:id)?-(\d{1,10})\}|\[tmdb(?:id)?-(\d{1,10})\]/i.exec(segment);
    if (match) return Number(match[1] || match[2]);
  }
  return null;
}
function episodeMarker(text) {
  for (const pattern of EPISODE_MARKERS) {
    const match = pattern.exec(text);
    if (match) {
      const start = match.index + (/^[\s._\-[(]/.test(match[0]) ? 1 : 0);
      return {
        season: Number(match[1]),
        episode: Number(match[2]),
        before: text.slice(0, start),
        after: text.slice(match.index + match[0].length),
      };
    }
  }
  return null;
}
function seasonOf(dir) {
  if (SPECIALS_DIR.test(dir)) return 0;
  const match = SEASON_DIR.exec(dir.trim()) || SHORT_SEASON_DIR.exec(dir.trim());
  return match ? Number(match[1]) : null;
}
const DISC_DIR = /^(?:disc|disk|cd|dvd|part|parte|vol(?:ume)?)[\s._-]*\d{1,2}$/i;
export const showSubfolder = (dir) => seasonOf(dir) !== null || DISC_DIR.test(dir.trim());
export const genericFolder = (dir) => GENERIC_DIR.test(dir.trim()) || OTHER_DIR.test(dir.trim());
function showFromDirs(dirs) {
  for (const dir of [...dirs].reverse()) {
    if (seasonOf(dir) !== null || GENERIC_DIR.test(dir.trim()) || OTHER_DIR.test(dir.trim()) || DISC_DIR.test(dir.trim())) continue;
    const marker = episodeMarker(dir);
    if (marker) {
      const before = cleanTitle(marker.before);
      if (before.title) return { ...before, season: marker.season };
      continue;
    }
    const pack = PACK_DIR.exec(prepare(dir));
    if (pack && pack[1].trim()) {
      const parsed = cleanTitle(pack[1].replace(/[\s._-]+complete(?:d)?$/i, ""));
      if (parsed.title) return { ...parsed, season: Number(pack[2] || pack[3] || pack[4]) };
    }
    const parsed = cleanTitle(dir);
    if (parsed.title) return { ...parsed, season: null };
  }
  return null;
}
function kidsMovie(dirs, title) {
  const folders = dirs.filter((dir) => !DISC_DIR.test(dir.trim()));
  if (KIDS_DIR.test((folders.at(-1) || "").trim())) return true;
  return KIDS_DIR.test((folders.at(-2) || "").trim()) && normalizeTitle(cleanTitle(folders.at(-1)).title) === normalizeTitle(title);
}
const blank = (kind, title) => ({
  kind,
  title,
  year: null,
  show: null,
  season: null,
  episode: null,
  episodeTitle: null,
  tmdb: null,
});

export function parseVideoPath(relPath) {
  const segments = String(relPath || "").split("/").filter(Boolean);
  const file = segments.at(-1) || "";
  const dirs = segments.slice(0, -1);
  const stem = stemOf(file);
  const plain = stem.replace(/[_]+/g, " ").trim() || stem;
  const tmdb = tmdbTag(segments);
  if (
    CAMERA.test(stem) ||
    DATE_NAME.test(stem) ||
    SAMPLE.test(stem) ||
    dirs.some((dir) => OTHER_DIR.test(dir.trim()))
  )
    return blank("other", plain);
  const marker = episodeMarker(stem);
  const folderSeason = dirs.map(seasonOf).filter((season) => season !== null).at(-1) ?? null;
  const fromDirs = showFromDirs(dirs);
  if (marker || folderSeason !== null || (fromDirs?.season != null && LEADING_EPISODE.test(stem))) {
    let season = marker?.season ?? folderSeason ?? fromDirs?.season ?? null;
    let episode = marker?.episode ?? null;
    let rest = marker?.after ?? "";
    if (!marker) {
      const leading = LEADING_EPISODE.exec(stem);
      if (leading) {
        episode = Number(leading[1]);
        rest = stem.slice(leading[0].length);
      } else {
        const inner = /(?:^|[\s._-])(?:e|ep|episode|episodio|cap[ií]tulo)?[\s._-]?(\d{1,3})(?=[\s._-]*$|[\s._]+-)/i.exec(stem);
        if (inner) {
          episode = Number(inner[1]);
          rest = stem.slice(inner.index + inner[0].length);
        }
      }
    }
    if (episode !== null && season !== null) {
      const show = fromDirs?.title
        ? fromDirs
        : marker
          ? cleanTitle(marker.before)
          : { title: null, year: null };
      const name = show.title;
      if (name) {
        const episodeTitle = cleanTitle(rest.replace(/^[\s._-]*(?:-[\s._-]*)?/, ""), { episode: true }).title;
        return {
          kind: "episode",
          title: episodeTitle || `Episode ${episode}`,
          year: show.year ?? null,
          show: name,
          season,
          episode,
          episodeTitle,
          tmdb: tmdb ? { type: "tv", id: tmdb } : null,
        };
      }
    }
  }
  let movie = cleanTitle(stem);
  const parent = dirs.findLast((dir) => !DISC_DIR.test(dir.trim()));
  if (parent && !GENERIC_DIR.test(parent.trim()) && (!movie.year || GENERIC_STEM.test(movie.title || ""))) {
    const folder = cleanTitle(parent);
    if (folder.title && (folder.year || GENERIC_STEM.test(movie.title || "")))
      movie = { ...folder, tagged: true };
  }
  const titled = movie.title && !GENERIC_STEM.test(movie.title);
  if (titled && !marker && (movie.year || movie.tagged || tmdb || dirs.some((dir) => MOVIE_DIR.test(dir.trim())) || kidsMovie(dirs, movie.title)))
    return { ...blank("movie", movie.title), year: movie.year, tmdb: tmdb ? { type: "movie", id: tmdb } : null };
  return blank("other", plain);
}

export const collectionName = (value) =>
  String(value || "")
    .replace(/\s*[-–:]?\s*(?:collection|colección|coleccion|coleção|collezione|sammlung|collectie|filmreihe)$/i, "")
    .trim() || null;

export const normalizeTitle = (value) =>
  searchFold(value || "")
    .replace(/&/g, " and ")
    .replace(/['’`]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

const LANGUAGES = {
  en: "English", es: "Spanish", fr: "French", de: "German", it: "Italian", pt: "Portuguese", nl: "Dutch",
  ca: "Catalan", eu: "Basque", gl: "Galician", ja: "Japanese", zh: "Chinese", ko: "Korean", ru: "Russian",
  pl: "Polish", sv: "Swedish", da: "Danish", no: "Norwegian", fi: "Finnish", tr: "Turkish", ar: "Arabic",
  he: "Hebrew", el: "Greek", hi: "Hindi", cs: "Czech", hu: "Hungarian", ro: "Romanian", uk: "Ukrainian",
};
const ALIASES = {
  eng: "en", english: "en", ingles: "en", inglés: "en",
  spa: "es", esp: "es", spanish: "es", español: "es", espanol: "es", castellano: "es", castilian: "es",
  fre: "fr", fra: "fr", french: "fr", français: "fr", francais: "fr",
  ger: "de", deu: "de", german: "de", deutsch: "de",
  ita: "it", italian: "it", italiano: "it",
  por: "pt", portuguese: "pt", português: "pt", portugues: "pt",
  dut: "nl", nld: "nl", dutch: "nl", nederlands: "nl",
  cat: "ca", catalan: "ca", català: "ca", catala: "ca",
  baq: "eu", eus: "eu", basque: "eu", euskera: "eu",
  glg: "gl", galician: "gl", galego: "gl", gallego: "gl",
  jpn: "ja", japanese: "ja", chi: "zh", zho: "zh", chinese: "zh", kor: "ko", korean: "ko",
  rus: "ru", russian: "ru", pol: "pl", polish: "pl", swe: "sv", swedish: "sv", dan: "da", danish: "da",
  nor: "no", nob: "no", norwegian: "no", fin: "fi", finnish: "fi", tur: "tr", turkish: "tr",
  ara: "ar", arabic: "ar", heb: "he", hebrew: "he", gre: "el", ell: "el", greek: "el", hin: "hi", hindi: "hi",
  cze: "cs", ces: "cs", czech: "cs", hun: "hu", hungarian: "hu", rum: "ro", ron: "ro", romanian: "ro",
  ukr: "uk", ukrainian: "uk",
};
const REGIONS = {
  "es-419": { base: "es", tokens: ["419", "la", "lat", "latam", "latino", "mx", "lta"], label: "Spanish (Latin America)" },
  "pt-BR": { base: "pt", tokens: ["br", "bra", "brazil", "brasil", "brazilian"], label: "Portuguese (Brazil)" },
};

export const languageName = (code) => REGIONS[code]?.label || LANGUAGES[code] || null;

const RELEASE_TITLE = /\.(?:mkv|mp4|m4v|avi|mov|srt|ass|ssa|vtt|sub)\b|\b(?:480|576|720|1080|1440|2160)[pi]\b|\b(?:x26[45]|h\.?26[45]|hevc|avc|xvid|divx|web-?dl|web-?rip|bluray|blu-ray|bdrip|brrip|dvdrip|hdtv|hdrip|remux|yts|yify|rarbg|galaxyrg|ettv|eztv|psa|qxr|tigole)\b/i;
const AUDIO_TOKEN = /\bdd\+|\b(?:e?-?ac-?3|dts(?:-?hd)?(?:[\s._-]*ma)?|truehd|aac|ddp?|atmos|flac|lpcm|[1-7]\.[01])(?![\w.])/gi;
export function trackTitle(value) {
  const title = String(value || "").trim();
  if (!title || title.length > 48 || RELEASE_TITLE.test(title)) return "";
  const rest = title
    .replace(AUDIO_TOKEN, " ")
    .replace(/\(\s*\)|\[\s*\]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s\-–·|/,]+|[\s\-–·|/,]+$/g, "");
  return /\p{L}/u.test(rest) ? rest : "";
}

export function numberRepeats(entries) {
  const totals = new Map();
  for (const entry of entries) totals.set(entry.label, (totals.get(entry.label) || 0) + 1);
  const seen = new Map();
  return entries.map((entry) => {
    if (totals.get(entry.label) < 2) return entry;
    const count = (seen.get(entry.label) || 0) + 1;
    seen.set(entry.label, count);
    return count === 1 ? entry : { ...entry, label: `${entry.label} · ${count}` };
  });
}

export function languageOf(subtitlePath, videoPath = "") {
  const subtitle = stemOf(subtitlePath);
  const video = videoPath ? stemOf(videoPath) : "";
  const rest = video && subtitle.toLowerCase().startsWith(video.toLowerCase()) ? subtitle.slice(video.length) : subtitle;
  const tokens = rest
    .toLowerCase()
    .split(/[\s._\-[\]()]+/)
    .filter(Boolean);
  let language = null;
  for (const token of tokens) {
    if (["latino", "lat", "latam"].includes(token)) {
      language = "es-419";
      break;
    }
    if (["pob", "ptbr", "brazilian"].includes(token)) {
      language = "pt-BR";
      break;
    }
    const code = LANGUAGES[token] && token.length === 2 ? token : ALIASES[token];
    if (code) {
      language = code;
      break;
    }
  }
  if (language) {
    const regional = Object.entries(REGIONS).find(
      ([, region]) => region.base === language && tokens.some((token) => region.tokens.includes(token)),
    );
    if (regional) language = regional[0];
  }
  const flags = [];
  if (tokens.includes("forced") || tokens.includes("forzados") || tokens.includes("forzado")) flags.push("forced");
  if (tokens.some((token) => ["sdh", "cc", "hi", "hoh"].includes(token))) flags.push("SDH");
  const name = language ? languageName(language) : "Subtitles";
  return { language, label: flags.length ? `${name} (${flags.join(", ")})` : name };
}
