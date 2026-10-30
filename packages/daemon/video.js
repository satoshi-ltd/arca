import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import bundledFfmpeg from "ffmpeg-static";
import sharp from "sharp";
import { fail } from "./storage.js";
import { SyncWork } from "./sync-work.js";
import { relatedTitles } from "../core/video-related.js";
import { watchNext } from "../core/video-watch-next.js";
import {
  collectionName,
  extensionOf,
  KIDS_DIR,
  languageName,
  languageOf,
  normalizeTitle,
  numberRepeats,
  genericFolder,
  parseVideoPath,
  showSubfolder,
  stemOf,
  subtitleType,
  trackTitle,
  videoType,
} from "../core/video-names.js";
import { detectLanguage, stripSpans } from "../core/subtitle-language.js";
import { CONTENT_KEY, Tmdb, closestContent, imagePath, kidsCertification, videoSettings } from "./tmdb.js";

const execute = promisify(execFile);
const INDEX_VERSION = 2;
const TEXT_SUBTITLES = new Set(["subrip", "srt", "ass", "ssa", "mov_text", "webvtt", "text"]);
const IMAGE_SUBTITLES = new Set(["hdmv_pgs_subtitle", "dvd_subtitle", "dvb_subtitle", "xsub"]);
const BATCH = 16;
const RETRY_MS = 3600000;
const BUSY_MS = 600000;
const SWEEP_MS = 3600000;
const SEARCH_ART_MS = 86400000;
const IMAGE_FILE_BYTES = 32 * 1024 ** 2;
const NFO_BYTES = 256 * 1024;
export const SUBTITLE_BYTES = 2 * 1024 ** 2;
const SUBTITLE_CACHE_BYTES = 64 * 1024 ** 2;
export const PREPARING = Symbol("preparing");
const lacksRelations = (job, data) => (job.kind === "movie" || job.kind === "tv") && !!data && !data.none && !(Array.isArray(data.keywords) && Array.isArray(data.recommended) && typeof data.originalLanguage === "string");
function pruneDirectory(dir, limit, keep = "") {
  const files = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const stat = fs.statSync(path.join(dir, entry.name));
      return { name: entry.name, size: stat.size, at: stat.mtimeMs };
    })
    .sort((a, b) => a.at - b.at);
  let total = files.reduce((sum, file) => sum + file.size, 0);
  for (const file of files) {
    if (total <= limit) break;
    if (keep && file.name.startsWith(keep)) continue;
    fs.rmSync(path.join(dir, file.name), { force: true });
    if (!file.name.endsWith(".done")) fs.rmSync(path.join(dir, `${file.name.split(/[-.]/)[0]}.done`), { force: true });
    total -= file.size;
  }
}
export const RESUME_HEAD_SECONDS = 10;
export const finishedAt = (duration) => duration - Math.min(Math.max(120, duration * 0.05), duration * 0.1);
const CONTINUE_LIMIT = 30;
const REBUILD_MS = 2000;
const PROBE_RETRIES_MS = [3600000, 6 * 3600000, 24 * 3600000];
const RENDERERS = 2;
export const ART_SIZES = {
  poster: { small: 240, large: 600, source: "w780" },
  backdrop: { small: 640, large: 1280, source: "w1280" },
  still: { small: 400, large: 400, source: "original" },
};
const KIDS_GENRES = new Set([10751, 10762]);
const KIDS_GENRE_NAMES = /^(family|kids|children|familia|infantil|niños|ninos)$/i;
const POSTERS = ["poster", "folder", "cover"];
const BACKDROPS = ["fanart", "backdrop", "background"];
const IMAGE_TYPES = new Set(["jpg", "jpeg", "png", "webp"]);
const SUBTITLE_DIRS = new Set(["subs", "subtitles", "subtítulos", "subtitulos"]);
const order = new Intl.Collator("en", { sensitivity: "base", numeric: true });
const EMPTY = Object.freeze({ duration: null, width: null, height: null, videoCodec: null, audioCodec: null, container: null, audioTracks: [], subtitleStreams: [] });

const spokenCode = (code) => (code ? languageOf(`x.${code}.srt`, "x.mkv").language : null);
const directoryOf = (name) => (name.includes("/") ? name.slice(0, name.lastIndexOf("/")) : "");
const baseOf = (name) => name.slice(name.lastIndexOf("/") + 1);
const join = (directory, name) => (directory ? `${directory}/${name}` : name);
const artKey = (value) => crypto.createHash("sha256").update(value).digest("hex");
const transient = (error) =>
  /^E[A-Z]+$/.test(error?.code || "") || error?.name === "NotReadableError" || error?.name === "NotFoundError";

const SUBTITLE_FLAGS = new Set(["forced", "sdh", "cc", "hi", "default"]);
export function subtitleFor(subtitle, stem) {
  if (subtitle === stem) return true;
  if (!subtitle.startsWith(`${stem}.`)) return false;
  const [code, ...flags] = subtitle.slice(stem.length + 1).split(".");
  return (!!languageOf(`x.${code}.srt`, "x.mkv").language || SUBTITLE_FLAGS.has(code)) && flags.every((flag) => SUBTITLE_FLAGS.has(flag));
}

export function sidecarKind(name) {
  const base = baseOf(name).toLowerCase();
  const extension = extensionOf(base);
  if (subtitleType(base)) return "subtitle";
  if (extension === "nfo") return "nfo";
  if (!IMAGE_TYPES.has(extension)) return null;
  const stem = stemOf(base);
  if ([...POSTERS, ...BACKDROPS].includes(stem)) return "image";
  return /-(poster|fanart|backdrop|thumb|landscape)$/.test(stem) ? "image" : null;
}

export function parseProbe(stderr) {
  const output = String(stderr || "");
  const duration = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(output);
  const streams = output.split(/\r?\n/).filter((line) => /^\s*Stream #\d+:\d+/.test(line));
  const video = streams.find((line) => /:\s*Video:\s*/.test(line) && !/attached pic/i.test(line));
  const audio = streams.find((line) => /:\s*Audio:\s*/.test(line));
  const container = /Input #0,\s*([a-z0-9_]+)/i.exec(output)?.[1]?.toLowerCase() || null;
  if (!duration && !video && !audio) return EMPTY;
  const audioTracks = [];
  const subtitleStreams = [];
  let last = null;
  for (const line of output.split(/\r?\n/)) {
    const stream = /^\s*Stream #\d+:\d+(?:\[[^\]]*\])?(?:\(([A-Za-z]{2,3})\))?:\s*(\w+):\s*([A-Za-z0-9_.-]+)(.*)$/.exec(line);
    if (stream) {
      const [, lang, type, codec, rest] = stream;
      const common = { codec: codec.toLowerCase(), language: lang && lang.toLowerCase() !== "und" ? lang.toLowerCase() : null, title: null, default: /\(default\)/.test(rest) };
      last = null;
      if (type === "Audio") audioTracks.push((last = { stream: audioTracks.length, ...common, channels: channelsOf(rest) }));
      if (type === "Subtitle") subtitleStreams.push((last = { stream: subtitleStreams.length, ...common, forced: /\(forced\)/.test(rest) }));
      continue;
    }
    const title = /^\s+title\s*:\s*(.+)$/.exec(line);
    if (title && last) last.title = title[1].trim().slice(0, 200);
  }
  const size = video ? /,\s*(\d{2,5})x(\d{2,5})(?=[\s,[]|$)/.exec(video.slice(video.indexOf("Video:"))) : null;
  const seconds = duration ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]) : null;
  return {
    duration: seconds > 0 ? Math.round(seconds * 1000) / 1000 : null,
    width: size ? Number(size[1]) : null,
    height: size ? Number(size[2]) : null,
    videoCodec: video ? /Video:\s*([A-Za-z0-9_.-]+)/.exec(video)?.[1]?.toLowerCase() || null : null,
    audioCodec: audio ? /Audio:\s*([A-Za-z0-9_.-]+)/.exec(audio)?.[1]?.toLowerCase() || null : null,
    container,
    audioTracks,
    subtitleStreams,
  };
}

function channelsOf(text) {
  const count = /(\d+) channels/.exec(text);
  if (count) return Number(count[1]);
  if (/\bmono\b/.test(text)) return 1;
  if (/\bstereo\b/.test(text)) return 2;
  const layout = /\b(\d)\.(\d)\b/.exec(text);
  return layout ? Number(layout[1]) + Number(layout[2]) : null;
}

export async function probeVideo(file, name) {
  const binary = bundledFfmpeg && fs.existsSync(bundledFfmpeg) ? bundledFfmpeg : "ffmpeg";
  const format = { mkv: "matroska", webm: "matroska", avi: "avi" }[extensionOf(name)] || "mov";
  let stderr;
  try {
    ({ stderr } = await execute(
      binary,
      ["-hide_banner", "-nostdin", "-protocol_whitelist", "file", "-f", format, "-i", file],
      { encoding: "utf8", timeout: 15000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024, windowsHide: true },
    ));
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    if (error.killed || error.signal || typeof error.code === "string") {
      if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" && error.stderr) return parseProbe(error.stderr);
      return null;
    }
    stderr = error.stderr || "";
  }
  return parseProbe(stderr);
}

export async function extractSubtitles(file, name, streams, timeout = 180000, signal) {
  const binary = bundledFfmpeg && fs.existsSync(bundledFfmpeg) ? bundledFfmpeg : "ffmpeg";
  const format = { mkv: "matroska", webm: "matroska", avi: "avi" }[extensionOf(name)] || "mov";
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "arca-subtitles-"));
  try {
    const outputs = streams.flatMap((stream) => ["-map", `0:s:${stream}`, "-c:s", "webvtt", "-f", "webvtt", "-fs", String(SUBTITLE_BYTES + 1), path.join(directory, `${stream}.vtt`)]);
    try {
      await execute(binary, ["-hide_banner", "-nostdin", "-loglevel", "error", "-protocol_whitelist", "file", "-f", format, "-i", file, "-vn", "-an", ...outputs], {
        timeout,
        killSignal: "SIGKILL",
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        signal,
      });
    } catch {
      fail("These subtitles could not be read", 422);
    }
    const found = new Map();
    for (const stream of streams) {
      const output = path.join(directory, `${stream}.vtt`);
      if (fs.statSync(output, { throwIfNoEntry: false })?.size > SUBTITLE_BYTES) {
        found.set(stream, null);
        continue;
      }
      const data = fs.readFileSync(output, { throwIfNoEntry: false });
      if (data?.length) found.set(stream, data.length <= SUBTITLE_BYTES ? subtitleText(data, "vtt") : null);
    }
    return found;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

export function subtitleText(buffer, type) {
  let value;
  if (buffer[0] === 0xff && buffer[1] === 0xfe) value = new TextDecoder("utf-16le").decode(buffer.subarray(2));
  else if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.from(buffer.subarray(2, 2 + ((buffer.length - 2) & ~1)));
    swapped.swap16();
    value = new TextDecoder("utf-16le").decode(swapped);
  } else
    try {
      value = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch {
      value = new TextDecoder("latin1").decode(buffer);
    }
  value = value.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (type === "vtt") return /^WEBVTT/.test(value) ? value : `WEBVTT\n\n${value}`;
  const body = stripSpans(stripSpans(value, /\{\\/, "}"), /<\/?font/i, ">")
    .replace(
      /(\d{1,3}):(\d{1,2}):(\d{1,2})[,.](\d{1,3})\s{0,32}-->\s{0,32}(\d{1,3}):(\d{1,2}):(\d{1,2})[,.](\d{1,3})/g,
      (_, h1, m1, s1, f1, h2, m2, s2, f2) =>
        `${h1.padStart(2, "0")}:${m1.padStart(2, "0")}:${s1.padStart(2, "0")}.${f1.padEnd(3, "0")} --> ${h2.padStart(2, "0")}:${m2.padStart(2, "0")}:${s2.padStart(2, "0")}.${f2.padEnd(3, "0")}`,
    )
    .trim();
  return `WEBVTT\n\n${body}\n`;
}

export const subtitleLanguage = (buffer, type) => detectLanguage(subtitleText(buffer, type).slice(0, 65536));

function entities(value) {
  return value
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&#(\d{1,6});/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, "&")
    .trim();
}
export function parseNfo(source) {
  const xml = String(source || "");
  const bodies = (name, text = xml) => {
    const open = new RegExp(`<${name}(\\s[^<>]{0,256})?>`, "gi");
    const close = new RegExp(`</${name}>`, "gi");
    const found = [];
    for (let match; (match = open.exec(text)); ) {
      close.lastIndex = open.lastIndex;
      const end = close.exec(text);
      if (!end) break;
      found.push({ attributes: match[1] || "", body: text.slice(open.lastIndex, end.index) });
      open.lastIndex = close.lastIndex;
    }
    return found;
  };
  const all = (name) =>
    bodies(name)
      .map(({ body }) => entities(body.slice(0, 8000)))
      .filter((value) => value && !value.includes("<"));
  const one = (name) => all(name)[0] || null;
  const unique = bodies("uniqueid")
    .filter(({ attributes }) => /\btype=["']tmdb["']/i.test(attributes))
    .map(({ body }) => body.match(/^\s{0,32}(\d{1,10})\s{0,32}$/)?.[1])
    .find(Boolean);
  const set = bodies("set")[0]?.body;
  const setName = set ? (bodies("name", set)[0]?.body ?? set) : null;
  const year = Number(one("year"));
  const rating = Number(one("rating"));
  const tmdb = Number(unique || one("tmdbid"));
  return {
    title: one("title")?.slice(0, 300) || null,
    year: Number.isSafeInteger(year) && year > 1800 && year < 2200 ? year : null,
    plot: one("plot")?.slice(0, 4000) || null,
    genres: all("genre").map((genre) => genre.slice(0, 64)).slice(0, 10),
    tmdb: Number.isSafeInteger(tmdb) && tmdb > 0 ? tmdb : null,
    collection: setName && !setName.includes("<") ? collectionName(entities(setName).slice(0, 300)) : null,
    aired: /^\d{4}-\d{2}-\d{2}$/.test(one("aired") || "") ? one("aired") : null,
    certification: one("mpaa")?.replace(/^Rated\s+/i, "").slice(0, 16) || null,
    rating: Number.isFinite(rating) && rating > 0 ? Math.round(rating * 10) / 10 : null,
  };
}

export class Video {
  constructor(store, options = {}) {
    this.s = store;
    store.db.function("arca_video_type", (name) => (videoType(name) ? 1 : 0));
    store.db.function("arca_video_side", (name) => (sidecarKind(name) ? 1 : 0));
    this.tmdb = new Tmdb(store, options.tmdb || {});
    this.probe = options.probe || probeVideo;
    this.directory = path.join(store.home, "video-art");
    this.volumes = new Set();
    this.memo = new Map();
    this.quiet = new Map();
    this.nfos = new Map();
    this.languages = new Map();
    this.fileTimes = new Map();
    this.rendering = new Map();
    this.renderers = 0;
    this.renderQueue = [];
    this.failed = new Map();
    this.busy = new Map();
    this.wanted = new Map();
    this.generation = 0;
    this.discovered = 0;
    this.progressGeneration = 0;
    this.indexed = 0;
    this.swept = 0;
  }
  close() {
    this.closed = true;
    this.tmdb.close();
    clearTimeout(this.matchTimer);
    this.extractions?.abort();
  }
  hub() {
    return this.s.config.role === "hub";
  }
  isVideo(volume) {
    if (!this.hub()) return !!this.s.config.catalog?.find((row) => row.id === volume)?.video;
    return !!this.s.db.prepare("SELECT 1 FROM video_folders WHERE volume=?").get(volume);
  }
  libraries() {
    if (!this.hub()) return [];
    return this.s.db.prepare("SELECT volume FROM video_folders").all().map((row) => row.volume);
  }
  mark(volume) {
    this.s.volume(volume);
    if (this.s.db.prepare("SELECT 1 FROM gallery_folders WHERE volume=?").get(volume))
      fail("This folder is a gallery. A folder is a gallery, an audio library or a video library, not more than one.", 409);
    if (this.s.db.prepare("SELECT 1 FROM music_folders WHERE volume=?").get(volume))
      fail("This folder is an audio library. A folder is a gallery, an audio library or a video library, not more than one.", 409);
    this.s.db.prepare("INSERT OR IGNORE INTO video_folders(volume) VALUES(?)").run(volume);
    this.quickIdentity(volume);
    this.generation++;
    this.prepare(volume);
  }
  quickIdentity(volume) {
    const v = this.s.volume(volume);
    const prefix = `${v.path}${path.sep}`.replace(/[!%_]/g, (c) => `!${c}`);
    this.s.db.prepare("DELETE FROM scan_cache WHERE path LIKE ? ESCAPE '!'").run(`${prefix}%`);
    new SyncWork(this.s).mark(volume);
    const done = new Set(this.s.config.quickVideo || []);
    if (!done.has(volume)) {
      this.s.config.quickVideo = [...done, volume];
      this.s.saveConfig();
    }
  }
  resume() {
    this.migrateSettings();
    const quick = new Set(this.s.config.quickVideo || []);
    for (const volume of this.libraries()) if (!quick.has(volume)) this.quickIdentity(volume);
    this.s.db.prepare("UPDATE video_items SET checked=0,retry=0 WHERE retry=?").run(Number.MAX_SAFE_INTEGER);
    const volumes = this.libraries();
    for (const volume of volumes) this.prepare(volume);
    if (!volumes.length) this.sweep();
  }
  schedule(volume, name) {
    if (this.closed || !this.hub() || !videoType(name) || !this.isVideo(volume)) return;
    this.prepare(volume);
  }
  prepare(volume) {
    if (this.closed || !this.hub() || !this.isVideo(volume)) return;
    this.volumes.add(volume);
    if (!this.background)
      this.background = this.prepareQueued().finally(() => {
        this.background = null;
      });
  }
  async prepareQueued() {
    while (!this.closed && this.volumes.size) {
      const volume = this.volumes.values().next().value;
      this.volumes.delete(volume);
      const before = this.discovered;
      try {
        if (this.settled(volume)) continue;
        while (!this.closed && (await this.indexBatch(volume)))
          await new Promise((resolve) => setImmediate(resolve));
        if (this.discovered !== before) this.generation++;
        if (!this.closed && this.isVideo(volume)) this.library(volume);
      } catch {
        continue;
      }
      if (this.discovered !== before) this.indexed++;
    }
    if (!this.closed) this.sweep();
  }
  fileGeneration(volume) {
    return this.s.db.prepare("SELECT generation FROM file_generations WHERE volume=?").get(volume)?.generation || 0;
  }
  settled(volume) {
    const quiet = this.quiet.get(volume);
    return (
      !!quiet &&
      quiet.files === this.fileGeneration(volume) &&
      quiet.rules === this.s.visibleRules(volume) &&
      !(quiet.retryAt && quiet.retryAt <= Date.now())
    );
  }
  pending(volume) {
    const excluded = this.s.visibleRules(volume);
    this.s.db.function("arca_video_visible", (name) => (excluded(name, false) ? 0 : 1));
    return this.s.db
      .prepare(
        `SELECT f.hash,min(f.path) AS path,i.checked,i.hash AS known FROM ${this.s.fileSource()} f LEFT JOIN video_items i ON i.hash=f.hash
        WHERE f.volume=? AND f.deleted=0 AND f.directory=0 AND f.hash IS NOT NULL
        AND arca_video_type(f.path)=1 AND arca_video_visible(f.path)=1
        AND (i.hash IS NULL OR (i.checked<? AND i.retry<=?))
        GROUP BY f.hash LIMIT ?`,
      )
      .all(volume, INDEX_VERSION, Date.now(), BATCH);
  }
  async indexBatch(volume) {
    const files = this.fileGeneration(volume);
    const rules = this.s.visibleRules(volume);
    const rows = this.pending(volume);
    for (const row of rows) {
      if (this.closed) return false;
      const source = this.s.localContent(volume, row.path, row.hash);
      const probed = source ? await this.probe(source, row.path) : null;
      if (this.closed) return false;
      if (!this.isVideo(volume)) {
        this.sweep(true);
        return false;
      }
      const value = probed || EMPTY;
      const previous = Math.max(0, -(row.checked || 0));
      const skipped = !source || probed === undefined;
      const failures = probed ? 0 : skipped ? previous : previous + 1;
      const checked = probed ? INDEX_VERSION : -failures;
      const retry = probed
        ? 0
        : skipped
          ? Date.now() + RETRY_MS
          : failures > PROBE_RETRIES_MS.length
            ? Number.MAX_SAFE_INTEGER
            : Date.now() + PROBE_RETRIES_MS[failures - 1];
      if (!probed && row.known)
        this.s.db.prepare("UPDATE video_items SET checked=?,retry=? WHERE hash=?").run(checked, retry, row.hash);
      else
        this.s.db
          .prepare(
            `INSERT OR REPLACE INTO video_items(hash,duration,width,height,video_codec,audio_codec,container,checked,retry,audio_tracks,subtitle_streams)
            VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            row.hash,
            value.duration,
            value.width,
            value.height,
            value.videoCodec,
            value.audioCodec,
            value.container,
            checked,
            retry,
            JSON.stringify(value.audioTracks || []),
            JSON.stringify(value.subtitleStreams || []),
          );
      this.discovered++;
      await new Promise((resolve) => setImmediate(resolve));
    }
    if (rows.length < BATCH)
      this.quiet.set(volume, {
        files,
        rules,
        retryAt:
          this.s.db.prepare("SELECT min(retry) AS at FROM video_items WHERE checked<? AND retry>?").get(INDEX_VERSION, Date.now())
            ?.at || 0,
      });
    return rows.length === BATCH;
  }
  requireLibrary(volume) {
    if (this.hub() || this.s.volumes().some((v) => v.id === volume)) this.s.volume(volume);
    if (!this.isVideo(volume)) fail("This folder is not a video library", 404);
  }
  settingsSignature() {
    const settings = videoSettings(this.s.config);
    return JSON.stringify([settings.content, !!settings.tmdbToken, this.tmdb.contentsRow()?.fetched || 0]);
  }
  current(volume) {
    this.requireLibrary(volume);
    if (!this.hub()) fail("This device does not index video", 409);
    const rules = this.s.visibleRules(volume);
    const files = this.fileGeneration(volume);
    const settings = this.settingsSignature();
    let value = this.memo.get(volume);
    const fresh =
      value &&
      value.rules === rules &&
      value.files === files &&
      value.generation === this.generation &&
      value.settings === settings &&
      (value.discovered === this.discovered || Date.now() - value.built < REBUILD_MS);
    if (!fresh) {
      value = {
        rules,
        files,
        generation: this.generation,
        discovered: this.discovered,
        settings,
        built: Date.now(),
        ...this.build(volume, rules),
      };
      this.memo.delete(volume);
      this.memo.set(volume, value);
      if (this.memo.size > 16) this.memo.delete(this.memo.keys().next().value);
    }
    return value;
  }
  overlay(volume, value) {
    const day = new Date().toISOString().slice(0, 10);
    if (value.overlay?.progress === this.progressGeneration && value.overlay.day === day) return value.overlay;
    const positions = new Map(
      this.s.db
        .prepare("SELECT path,hash,position,duration,name,updated FROM video_positions WHERE volume=? AND position>0")
        .all(volume)
        .map((row) => [row.path, row]),
    );
    const watched = new Map(
      this.s.db
        .prepare("SELECT path,updated FROM video_watched WHERE volume=?")
        .all(volume)
        .map((row) => [row.path, row.updated]),
    );
    const marks = [];
    const progressOf = (item) => {
      const stored = positions.get(item.path);
      const saved = stored?.hash === item.hash ? stored : null;
      const seen = watched.has(item.path);
      if (saved || seen)
        marks.push([item.path, saved ? Math.floor(saved.position / 60) : null, saved ? Math.floor(saved.updated / 60000) : null, seen]);
      return {
        ...item,
        position: saved ? { position: saved.position, duration: saved.duration, updated: saved.updated, device: saved.name } : null,
        watched: seen,
      };
    };
    const movies = value.movies.map(progressOf);
    const other = value.other.map(progressOf);
    const shows = value.shows.map((show) => ({
      ...show,
      seasons: show.seasons.map((season) => ({ ...season, episodes: season.episodes.map(progressOf) })),
    }));
    const { continueIds, nextUp } = this.progress(movies, shows, other, watched);
    const hidden = new Map(this.s.db.prepare("SELECT id,since FROM video_hidden WHERE volume=?").all(volume).map((row) => [row.id, row.since]));
    const next = watchNext({ movies, shows, continueIds, nextUp, watchedAt: watched, hidden });
    const version = crypto
      .createHash("sha256")
      .update(JSON.stringify([value.contentVersion, marks, next]))
      .digest("hex")
      .slice(0, 32);
    value.overlay = { progress: this.progressGeneration, day, version, movies, shows, other, continueIds, nextUp, watchNext: next };
    return value.overlay;
  }
  library(volume, known = null) {
    const value = this.current(volume);
    if (value.indexing || (value.retryAt && value.retryAt <= Date.now())) this.prepare(volume);
    this.want({ key: CONTENT_KEY, kind: "contents" });
    for (const job of value.wants) this.want(job);
    const matching = this.tmdb.enabled() && value.matching;
    const view = this.overlay(volume, value);
    const tmdb = this.tmdbState(!!matching);
    if (known && known === view.version) return { version: view.version, indexing: value.indexing, matching, tmdb, unchanged: true };
    return {
      version: view.version,
      indexing: value.indexing,
      matching,
      tmdb,
      movies: view.movies,
      shows: view.shows,
      other: view.other,
      continue: view.continueIds,
      nextUp: view.nextUp,
      watchNext: view.watchNext,
      kids: value.kids,
    };
  }
  want(job) {
    if (this.closed || !this.hub() || !this.tmdb.enabled()) return;
    if (this.wanted.has(job.key)) return this.kick();
    const row = this.metaRow(job.key);
    if (job.kind === "contents" ? !this.tmdb.contentsStale() : !this.tmdb.stale(row) && !lacksRelations(job, row?.data ? JSON.parse(row.data) : null) && (job.kind === "search" || !row.data || JSON.parse(row.data).language === this.tmdb.settings().language)) return;
    this.wanted.set(job.key, job);
    this.kick();
  }
  kick() {
    if (this.matcher || this.closed) return;
    this.matcher = this.matchQueued().finally(() => {
      this.matcher = null;
    });
  }
  async matchQueued() {
    const before = this.discovered;
    while (!this.closed && this.wanted.size && this.tmdb.enabled()) {
      if (this.tmdb.waiting()) {
        clearTimeout(this.matchTimer);
        this.matchTimer = setTimeout(() => this.kick(), Math.max(1000, this.tmdb.until - Date.now()));
        this.matchTimer.unref?.();
        break;
      }
      const [key, job] = this.wanted.entries().next().value;
      try {
        await this.tmdb.resolve(job);
        this.wanted.delete(key);
        this.discovered++;
      } catch {
        if (!this.tmdb.waiting()) this.wanted.delete(key);
      }
    }
    if (!this.tmdb.enabled()) this.wanted.clear();
    if (this.discovered !== before) {
      this.generation++;
      this.indexed++;
    }
  }
  metaRow(key) {
    return this.s.db.prepare("SELECT data,fetched,error FROM video_meta WHERE key=?").get(key);
  }
  meta(key, job, wants, language = null) {
    const row = this.metaRow(key);
    const data = row?.data ? JSON.parse(row.data) : null;
    if (this.tmdb.stale(row) || (language && data && data.language !== language) || lacksRelations(job, data)) wants.push({ key, ...job });
    return data && !data.none ? data : null;
  }
  overrides(volume) {
    return new Map(
      this.s.db
        .prepare("SELECT key,tmdb,kind,kids FROM video_overrides WHERE volume=?")
        .all(volume)
        .map((row) => [row.key, row]),
    );
  }
  nfo(volume, row) {
    if (!row || row.size > NFO_BYTES) return null;
    if (this.nfos.has(row.hash)) return this.nfos.get(row.hash);
    let value = null;
    try {
      const file = this.s.localContent(volume, row.path, row.hash);
      if (file) value = parseNfo(fs.readFileSync(file, "utf8"));
    } catch {
      value = null;
    }
    if (value) {
      this.nfos.set(row.hash, value);
      if (this.nfos.size > 4096) this.nfos.delete(this.nfos.keys().next().value);
    }
    return value;
  }
  spoken(volume, row) {
    if (this.languages.has(row.hash)) return this.languages.get(row.hash);
    let language = null;
    if (row.size <= SUBTITLE_BYTES)
      try {
        const file = this.s.localContent(volume, row.path, row.hash);
        if (!file) return null;
        language = subtitleLanguage(fs.readFileSync(file), subtitleType(row.path));
      } catch {
        return null;
      }
    this.languages.set(row.hash, language);
    if (this.languages.size > 4096) this.languages.delete(this.languages.keys().next().value);
    return language;
  }
  fileTime(stored, row) {
    const key = `${stored.id}\0${row.path}\0${row.hash}`;
    if (!this.fileTimes.has(key)) {
      let time = null;
      try {
        time = new Date(fs.statSync(this.s.filePath(stored, row.path)).mtimeMs).toISOString();
      } catch {}
      this.fileTimes.set(key, time);
      if (this.fileTimes.size > 65536) this.fileTimes.delete(this.fileTimes.keys().next().value);
    }
    return this.fileTimes.get(key);
  }
  build(volume, excluded) {
    if (!this.revisionIndex) {
      this.s.db.exec("CREATE INDEX IF NOT EXISTS music_revision_hash ON revisions(volume,hash,created)");
      this.revisionIndex = true;
    }
    const settings = videoSettings(this.s.config);
    const lists = this.tmdb.contentsData();
    const now = Date.now();
    const rows = this.s.db
      .prepare(
        `SELECT f.path,f.hash,f.rev,f.size,i.checked,i.retry,i.duration,i.width,i.height,i.video_codec,i.audio_codec,i.audio_tracks,i.subtitle_streams,
        (SELECT min(r.created) FROM revisions r WHERE r.volume=f.volume AND r.hash=f.hash) AS added
        FROM ${this.s.fileSource()} f LEFT JOIN video_items i ON i.hash=f.hash
        WHERE f.volume=? AND f.deleted=0 AND f.directory=0 AND f.hash IS NOT NULL
        AND (arca_video_type(f.path)=1 OR arca_video_side(f.path)=1)
        ORDER BY f.path`,
      )
      .all(volume)
      .filter((row) => !excluded(row.path, false));
    const stored = this.s.volume(volume);
    for (const row of rows) {
      if (!videoType(row.path)) continue;
      const modified = this.fileTime(stored, row);
      if (modified && (!row.added || modified < row.added)) row.added = modified;
    }
    const folders = new Map();
    const folder = (directory) => {
      let entry = folders.get(directory);
      if (!entry) folders.set(directory, (entry = { videos: [], images: new Map(), nfos: new Map(), subtitles: [] }));
      return entry;
    };
    for (const row of rows) {
      const directory = directoryOf(row.path);
      const kind = videoType(row.path) ? "video" : sidecarKind(row.path);
      const entry = folder(directory);
      if (kind === "video") entry.videos.push(row);
      else if (kind === "subtitle") entry.subtitles.push(row);
      else if (kind === "nfo") entry.nfos.set(stemOf(baseOf(row.path)).toLowerCase(), row);
      else if (kind === "image" && row.size <= IMAGE_FILE_BYTES) entry.images.set(stemOf(baseOf(row.path)).toLowerCase(), row);
    }
    const children = new Map();
    for (const name of [...folders.keys()])
      for (let child = name; child; child = directoryOf(child)) {
        const parent = directoryOf(child);
        folder(child);
        if (!children.has(parent)) children.set(parent, new Set());
        children.get(parent).add(child);
      }
    const art = new Map();
    const wants = [];
    const fileArt = (row, kind) => {
      if (!row) return null;
      const key = artKey(row.hash);
      if (!art.has(key)) art.set(key, { kind, file: { path: row.path, hash: row.hash } });
      return key;
    };
    const tmdbArt = (pathname, kind) => {
      if (!imagePath(pathname)) return null;
      const key = artKey(pathname);
      if (!art.has(key)) art.set(key, { kind, tmdb: pathname });
      return key;
    };
    const pick = (entry, names) => {
      for (const name of names) if (entry?.images.has(name)) return entry.images.get(name);
      return null;
    };
    const streamsOf = (row, sidecars, original = "") => {
      const parse = (value) => {
        try {
          return Array.isArray(JSON.parse(value || "[]")) ? JSON.parse(value || "[]") : [];
        } catch {
          return [];
        }
      };
      const named = (track, fallback) => {
        const language = languageName(spokenCode(track.language));
        const title = trackTitle(track.title);
        if (!language) return title || fallback;
        if (!title || title.toLowerCase() === language.toLowerCase()) return language;
        return title.toLowerCase().includes(language.toLowerCase()) ? title : `${language} · ${title}`;
      };
      const declared = parse(row.audio_tracks);
      const only = declared.length === 1 && !spokenCode(declared[0].language) && spokenCode(original) ? original : null;
      const audioTracks = numberRepeats(declared.map((track) => ({
        stream: track.stream,
        codec: track.codec,
        language: spokenCode(only || track.language),
        label: named(only ? { ...track, language: only } : track, `Track ${track.stream + 1}`),
        channels: track.channels ?? null,
        default: !!track.default,
      })));
      const embedded = parse(row.subtitle_streams)
        .filter((track) => TEXT_SUBTITLES.has(track.codec) || IMAGE_SUBTITLES.has(track.codec))
        .map((track) => ({
          embedded: true,
          stream: track.stream,
          language: spokenCode(track.language),
          label: `${named(track, `Subtitles ${track.stream + 1}`)}${track.forced ? " (forced)" : ""}`,
          forced: !!track.forced,
          image: IMAGE_SUBTITLES.has(track.codec),
          default: !!track.default,
        }));
      const unique = (entries) => [...new Set(entries.filter((entry) => entry.language).map((entry) => languageName(entry.language)).filter(Boolean))];
      const firstDefault = (list) => [...list.filter((item) => item.default), ...list.filter((item) => !item.default)];
      const text = embedded.filter((track) => !track.image && !track.forced);
      return {
        audioTracks,
        subtitles: numberRepeats([...sidecars, ...embedded.map(({ default: _, ...track }) => track)]),
        audioLanguages: unique(firstDefault(audioTracks)),
        subtitleLanguages: unique([
          ...text.filter((track) => track.default),
          ...sidecars.filter((sub) => !/forced/.test(sub.label)),
          ...text.filter((track) => !track.default),
        ]),
      };
    };
    const subtitlesOf = (row) => {
      const directory = directoryOf(row.path);
      const entry = folders.get(directory);
      const stem = stemOf(baseOf(row.path)).toLowerCase();
      const single = entry.videos.length === 1;
      const own = (sub) => single || subtitleFor(stemOf(baseOf(sub.path)).toLowerCase(), stem);
      const found = entry.subtitles.filter(own);
      for (const name of children.get(directory) || []) {
        if (!SUBTITLE_DIRS.has(baseOf(name).toLowerCase())) continue;
        found.push(...folders.get(name).subtitles.filter(own));
        for (const nested of children.get(name) || [])
          if (baseOf(nested).toLowerCase() === stem) found.push(...folders.get(nested).subtitles);
      }
      return found
        .map((sub) => {
          const named = languageOf(sub.path, row.path);
          const spoken = named.language ? null : this.spoken(volume, sub);
          return { path: sub.path, ...(spoken ? { language: spoken, label: named.label.replace("Subtitles", languageName(spoken)) } : named) };
        })
        .sort((a, b) => order.compare(a.label, b.label) || (a.path < b.path ? -1 : 1));
    };
    const overrides = this.overrides(volume);
    let indexed = 0;
    let unread = 0;
    let matchable = 0;
    let unmatched = 0;
    const counted = (start) => {
      matchable++;
      if (wants.length > start) unmatched++;
    };
    let retryAt = 0;
    const fileFields = (row, original = "") => {
      if (row.checked !== INDEX_VERSION) {
        if (row.retry > now) retryAt = retryAt ? Math.min(retryAt, row.retry) : row.retry;
        else unread++;
      }
      indexed++;
      return {
        path: row.path,
        hash: row.hash,
        rev: row.rev,
        size: row.size,
        duration: row.duration ?? null,
        width: row.width ?? null,
        height: row.height ?? null,
        videoCodec: row.video_codec ?? null,
        audioCodec: row.audio_codec ?? null,
        container: extensionOf(row.path),
        ...streamsOf(row, subtitlesOf(row), original),
        position: null,
        watched: false,
        added: row.added,
      };
    };
    const kidsFolder = (name) => name.split("/").slice(0, -1).some((part) => KIDS_DIR.test(part.trim()));
    const kidsOf = (override, certification, genreIds, genres, name) => {
      if (override?.kids === 1) return true;
      if (override?.kids === 0) return false;
      if (kidsFolder(name)) return true;
      if ((genreIds || []).some((id) => KIDS_GENRES.has(id))) return true;
      if ((genres || []).some((genre) => KIDS_GENRE_NAMES.test(genre))) return true;
      return kidsCertification(settings.country, certification, lists);
    };
    const movies = [];
    const signals = new Map();
    const other = [];
    const shows = new Map();
    const kidsOverride = (override) => (override?.kids === 1 ? true : override?.kids === 0 ? false : null);
    const otherOf = (row) => ({
      id: `o:${row.path}`,
      kind: "other",
      title: stemOf(baseOf(row.path)),
      ...fileFields(row),
    });
    for (const row of rows) {
      if (!videoType(row.path)) continue;
      const parsed = parseVideoPath(row.path);
      const override = overrides.get(`file:${row.path}`);
      const directory = directoryOf(row.path);
      const entry = folders.get(directory);
      const stem = stemOf(baseOf(row.path)).toLowerCase();
      if (override?.kind === "other") {
        other.push(otherOf(row));
        continue;
      }
      const forcedMovie = override?.tmdb?.startsWith("movie:");
      if (parsed.kind === "episode" && !forcedMovie) {
        const key = `${normalizeTitle(parsed.show)}${parsed.year ? `|${parsed.year}` : ""}`;
        let show = shows.get(key);
        if (!show) shows.set(key, (show = { key, parsed, rows: [] }));
        show.rows.push({ row, parsed, entry, stem });
        continue;
      }
      if (parsed.kind === "other" && !forcedMovie) {
        other.push(otherOf(row));
        continue;
      }
      const title = parsed.kind === "movie" ? parsed.title : stemOf(baseOf(row.path));
      const nfo = this.nfo(volume, entry.nfos.get(stem) || (entry.videos.length === 1 ? entry.nfos.get("movie") : null));
      const start = wants.length;
      let id = forcedMovie ? Number(override.tmdb.slice(6)) : nfo?.tmdb || (parsed.tmdb?.type === "movie" ? parsed.tmdb.id : null);
      if (!id && this.tmdb.enabled() && parsed.kind === "movie") {
        const searchKey = `movie:${normalizeTitle(title)}|${parsed.year || ""}`;
        id = this.meta(searchKey, { kind: "search", type: "movie", title, year: parsed.year }, wants)?.id || null;
      }
      const details = id && this.tmdb.enabled() ? this.meta(`tmdb:movie:${id}`, { kind: "movie", id }, wants, settings.language) : id ? this.cached(`tmdb:movie:${id}`) : null;
      const first = forcedMovie ? details : nfo;
      const second = forcedMovie ? nfo : details;
      const genres = first?.genres?.length ? first.genres : second?.genres || [];
      const certification = details?.certifications?.[settings.country] || nfo?.certification || null;
      counted(start);
      const fields = fileFields(row, details?.originalLanguage);
      const single = directory && entry.videos.length === 1;
      movies.push({
        id: `m:${row.path}`,
        kind: "movie",
        title: first?.title || second?.title || title,
        year: first?.year || second?.year || parsed.year || null,
        overview: first?.plot || first?.overview || second?.plot || second?.overview || null,
        genres,
        runtime: details?.runtime || (fields.duration >= 60 ? Math.round(fields.duration / 60) : null),
        certification,
        rating: details?.rating ?? nfo?.rating ?? null,
        cast: details?.cast || [],
        collection: collectionName(nfo?.collection || details?.collection),
        kids: kidsOf(override, certification, details?.genreIds, genres, row.path),
        kidsOverride: kidsOverride(override),
        poster:
          fileArt(pick(entry, [`${stem}-poster`]) || (single ? pick(entry, POSTERS) : null), "poster") ||
          tmdbArt(details?.poster, "poster"),
        backdrop:
          fileArt(pick(entry, [`${stem}-fanart`, `${stem}-backdrop`]) || (single ? pick(entry, BACKDROPS) : null), "backdrop") ||
          tmdbArt(details?.backdrop, "backdrop"),
        tmdb: details?.id ?? null,
        matched: !!details,
        ...fields,
      });
      if (details) signals.set(movies.at(-1), { key: `movie:${details.id}`, keywords: details.keywords, recommended: details.recommended });
    }
    const showList = [];
    for (const show of shows.values()) {
      const override = overrides.get(`s:${show.key}`);
      if (override?.kind === "other") {
        for (const { row } of show.rows) other.push(otherOf(row));
        continue;
      }
      const sample = show.rows[0];
      const ancestors = [];
      for (let directory = directoryOf(sample.row.path); directory; directory = directoryOf(directory))
        if (!showSubfolder(baseOf(directory))) ancestors.push(directory);
      const showArt = (names) => ancestors.filter((directory) => !genericFolder(baseOf(directory))).map((directory) => pick(folders.get(directory), names)).find(Boolean) || null;
      const showNfo = ancestors
        .map((directory) => folders.get(directory)?.nfos.get("tvshow"))
        .map((row) => this.nfo(volume, row))
        .find(Boolean);
      const start = wants.length;
      const overrideId = override?.tmdb?.startsWith("tv:") ? Number(override.tmdb.slice(3)) : null;
      const tagged = show.rows.find((item) => item.parsed.tmdb)?.parsed.tmdb?.id || null;
      let id = overrideId || showNfo?.tmdb || tagged;
      if (!id && this.tmdb.enabled())
        id = this.meta(`tv:${show.key}`, { kind: "search", type: "tv", title: show.parsed.show, year: show.parsed.year }, wants)?.id || null;
      const details = id && this.tmdb.enabled() ? this.meta(`tmdb:tv:${id}`, { kind: "tv", id }, wants, settings.language) : id ? this.cached(`tmdb:tv:${id}`) : null;
      const first = overrideId ? details : showNfo;
      const second = overrideId ? showNfo : details;
      const showId = `s:${show.key}`;
      const genres = first?.genres?.length ? first.genres : second?.genres || [];
      const certification = details?.certifications?.[settings.country] || showNfo?.certification || null;
      const seasons = new Map();
      for (const item of show.rows) {
        const number = item.parsed.season;
        if (!seasons.has(number)) seasons.set(number, []);
        seasons.get(number).push(item);
      }
      const seasonList = [];
      let added = null;
      for (const [number, items] of [...seasons].sort((a, b) => (a[0] === 0) - (b[0] === 0) || a[0] - b[0])) {
        const seasonData = details
          ? this.tmdb.enabled()
            ? this.meta(`tmdb:season:${details.id}:${number}`, { kind: "season", id: details.id, season: number }, wants, settings.language)
            : this.cached(`tmdb:season:${details.id}:${number}`)
          : null;
        const episodes = items
          .sort((a, b) => a.parsed.episode - b.parsed.episode || order.compare(a.row.path, b.row.path))
          .map(({ row, parsed, entry, stem }) => {
            const nfo = this.nfo(volume, entry.nfos.get(stem));
            const remote = seasonData?.episodes?.find((episode) => episode.episode === parsed.episode);
            if (row.added && (!added || row.added > added)) added = row.added;
            return {
              id: `e:${row.path}`,
              kind: "episode",
              show: showId,
              season: number,
              episode: parsed.episode,
              title: nfo?.title || remote?.title || parsed.episodeTitle || `Episode ${parsed.episode}`,
              overview: nfo?.plot || remote?.overview || null,
              still: fileArt(pick(entry, [`${stem}-thumb`, `${stem}-landscape`]), "still") || tmdbArt(remote?.still, "still"),
              aired: nfo?.aired || remote?.aired || null,
              ...fileFields(row, details?.originalLanguage),
            };
          });
        seasonList.push({
          season: number,
          name: seasonData?.name || (number === 0 ? "Specials" : `Season ${number}`),
          episodes,
        });
      }
      counted(start);
      showList.push({
        id: showId,
        kind: "show",
        title: first?.title || second?.title || show.parsed.show,
        year: first?.year || second?.year || show.parsed.year || null,
        overview: first?.plot || first?.overview || second?.plot || second?.overview || null,
        genres,
        certification,
        rating: details?.rating ?? showNfo?.rating ?? null,
        cast: details?.cast || [],
        kids: false,
        kidsOverride: null,
        poster: fileArt(showArt(POSTERS), "poster") || tmdbArt(details?.poster, "poster"),
        backdrop: fileArt(showArt(BACKDROPS), "backdrop") || tmdbArt(details?.backdrop, "backdrop"),
        tmdb: details?.id ?? null,
        matched: !!details,
        added,
        seasons: seasonList,
      });
      if (details) signals.set(showList.at(-1), { key: `tv:${details.id}`, keywords: details.keywords, recommended: details.recommended });
    }
    movies.sort((a, b) => order.compare(a.title, b.title) || (a.year || 0) - (b.year || 0) || (a.path < b.path ? -1 : 1));
    showList.sort((a, b) => order.compare(a.title, b.title) || (a.year || 0) - (b.year || 0));
    for (const [title, related] of relatedTitles([...movies, ...showList], signals)) title.related = related;
    other.sort((a, b) => order.compare(a.path, b.path));
    const kids = movies.some((movie) => movie.kids);
    const contentVersion = crypto
      .createHash("sha256")
      .update(JSON.stringify([movies, showList, other, kids]))
      .digest("hex");
    const items = new Map();
    for (const item of [...movies, ...other]) items.set(item.id, item);
    for (const show of showList) {
      items.set(show.id, show);
      for (const season of show.seasons) for (const episode of season.episodes) items.set(episode.id, episode);
    }
    const indexing = unread ? { done: indexed - unread, total: indexed } : false;
    const matching = this.tmdb.enabled() && unmatched ? { done: matchable - unmatched, total: matchable } : false;
    return { contentVersion, indexing, matching, retryAt, movies, shows: showList, other, kids, art, wants, items };
  }
  cached(key) {
    const row = this.metaRow(key);
    const data = row?.data ? JSON.parse(row.data) : null;
    return data && !data.none ? data : null;
  }
  progress(movies, shows, other, watched) {
    const started = [];
    for (const item of [...movies, ...other]) if (item.position) started.push({ id: item.id, updated: item.position.updated });
    const nextUp = [];
    for (const show of shows) {
      const regular = show.seasons.filter((season) => season.season !== 0).flatMap((season) => season.episodes);
      const specials = show.seasons.filter((season) => season.season === 0).flatMap((season) => season.episodes);
      let resume = null;
      let last = null;
      let lastAt = -1;
      for (const episode of [...regular, ...specials]) {
        if (episode.position && !episode.watched && (!resume || episode.position.updated > resume.position.updated)) resume = episode;
        const at = watched.get(episode.path);
        if (at !== undefined && at > lastAt) [last, lastAt] = [episode, at];
      }
      let next = null;
      if (last && (!resume || lastAt > resume.position.updated)) {
        const fresh = (episode) => !episode.watched && (!episode.position || episode === resume);
        const list = last.season === 0 ? specials : regular;
        next = list.slice(list.indexOf(last) + 1).find(fresh) || (last.season === 0 ? regular.find(fresh) : null);
      }
      if (next && next !== resume) nextUp.push({ id: next.id, updated: lastAt });
      else if (resume) started.push({ id: resume.id, updated: resume.position.updated });
    }
    started.sort((a, b) => b.updated - a.updated);
    nextUp.sort((a, b) => b.updated - a.updated);
    return {
      continueIds: started.slice(0, CONTINUE_LIMIT).map((item) => item.id),
      nextUp: nextUp.slice(0, CONTINUE_LIMIT).map((item) => item.id),
    };
  }
  find(volume, id) {
    return this.current(volume).items.get(id) || null;
  }
  entry(volume, name) {
    for (const prefix of ["m:", "e:", "o:"]) {
      const item = this.find(volume, prefix + name);
      if (item) return item;
    }
    return null;
  }
  artFile(key, size) {
    return path.join(this.directory, `${key}-${size}.jpg`);
  }
  async renderArt(key, kind, load, sizes = ["small", "large"]) {
    if (sizes.every((size) => fs.existsSync(this.artFile(key, size)))) return true;
    if (this.rendering.has(key)) return this.rendering.get(key);
    const job = (async () => {
      if (this.renderers >= RENDERERS) await new Promise((resolve) => this.renderQueue.push(resolve));
      else this.renderers++;
      try {
        const input = await load();
        if (!input) return input === false ? false : null;
        const options = { limitInputPixels: 100000000, failOn: "none" };
        const { width, height } = await sharp(input, options).metadata();
        if (!width || !height) return false;
        if (this.closed) return null;
        fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
        for (const size of sizes) {
          const data = await sharp(input, options)
            .rotate()
            .resize({ width: ART_SIZES[kind][size], withoutEnlargement: true })
            .jpeg({ quality: size === "large" ? 85 : 78 })
            .timeout({ seconds: 10 })
            .toBuffer();
          if (this.closed) return null;
          const target = this.artFile(key, size);
          const temporary = `${target}.${crypto.randomUUID()}.tmp`;
          try {
            fs.writeFileSync(temporary, data, { mode: 0o600 });
            fs.renameSync(temporary, target);
          } finally {
            fs.rmSync(temporary, { force: true });
          }
        }
        return true;
      } catch (error) {
        return transient(error) ? null : false;
      } finally {
        const next = this.renderQueue.shift();
        if (next) next();
        else this.renderers--;
      }
    })().finally(() => this.rendering.delete(key));
    this.rendering.set(key, job);
    return job;
  }
  async art(volume, key, size = "small") {
    if (!/^[a-f0-9]{64}$/.test(key || "")) fail("Invalid picture", 400);
    if (!["small", "large"].includes(size)) fail("Invalid picture size", 400);
    const source = this.current(volume).art.get(key);
    if (!source) fail("This picture is no longer available", 404);
    const file = this.artFile(key, size);
    if (!fs.existsSync(file)) {
      if (Date.now() - (this.failed.get(key) || 0) < RETRY_MS) return { unavailable: true };
      if (Date.now() - (this.busy.get(key) || 0) < BUSY_MS) return { retry: true };
      const rendered = await this.renderArt(key, source.kind, async () => {
        if (source.file) {
          const local = this.s.localContent(volume, source.file.path, source.file.hash);
          return local ? fs.promises.readFile(local) : null;
        }
        return this.tmdb.image(source.tmdb, ART_SIZES[source.kind].source);
      });
      if (!this.isVideo(volume)) this.sweep(true);
      if (!fs.existsSync(file)) {
        const map = rendered === null ? this.busy : this.failed;
        map.set(key, Date.now());
        if (map.size > 1024) map.delete(map.keys().next().value);
        return rendered === null ? { retry: true } : { unavailable: true };
      }
    }
    return { data: `data:image/jpeg;base64,${fs.readFileSync(file).toString("base64")}` };
  }
  async tmdbImage(pathname) {
    if (!imagePath(pathname)) fail("Invalid image", 400);
    if (!this.tmdb.enabled()) fail("Add a TMDB token in Settings first", 409);
    const key = `search-${artKey(pathname)}`;
    const file = this.artFile(key, "small");
    if (!fs.existsSync(file)) {
      const rendered = await this.renderArt(key, "poster", () => this.tmdb.image(pathname, "w342"), ["small"]);
      if (!fs.existsSync(file)) return rendered === null ? { retry: true } : { unavailable: true };
    }
    return { data: `data:image/jpeg;base64,${fs.readFileSync(file).toString("base64")}` };
  }
  async tmdbSearch(query, type, year) {
    if (typeof query !== "string" || !query.trim() || query.length > 200) fail("Type a title to search");
    if (!["movie", "tv"].includes(type)) fail("Choose Movie or TV");
    const parsedYear = year ? Number(year) : null;
    if (parsedYear !== null && !(Number.isSafeInteger(parsedYear) && parsedYear > 1800 && parsedYear < 2200)) fail("Invalid year");
    if (!this.tmdb.enabled()) fail("Add a TMDB token in Settings first", 409);
    const results = await this.tmdb.searchResults(query.trim(), type, parsedYear);
    return {
      results: results.map((row) => ({
        ...row,
        poster: row.poster ? `/v1/video/tmdb-image?${new URLSearchParams({ path: row.poster })}` : null,
      })),
    };
  }
  playable(volume, name, hash) {
    this.requireLibrary(volume);
    if (!this.hub() && !this.s.volume(volume).selected) fail("Select this folder first", 403);
    const row = typeof name === "string" ? this.s.viewCurrent(volume, name) : null;
    if (!row || row.deleted || row.directory || row.hash !== hash || this.s.visibleRules(volume)(name, false)) return null;
    return row;
  }
  media(volume, name, hash) {
    const row = this.playable(volume, name, hash);
    if (!row || !videoType(name)) fail("This video is no longer available", 404);
    const file = this.s.localContent(volume, name, hash);
    if (!file || fs.statSync(file, { throwIfNoEntry: false })?.size !== row.size) fail("Sync this video before playing it", 409);
    return { file, size: row.size, type: videoType(name) };
  }
  subtitles(volume, name) {
    const row = typeof name === "string" ? this.playable(volume, name, this.s.viewCurrent(volume, name)?.hash) : null;
    if (!row || !subtitleType(name)) fail("These subtitles are no longer available", 404);
    if (row.size > SUBTITLE_BYTES) fail("These subtitles are too large", 413);
    const file = this.s.localContent(volume, name, row.hash);
    if (!file) fail("Sync these subtitles first", 409);
    const data = fs.readFileSync(file);
    if (data.length > SUBTITLE_BYTES) fail("These subtitles are too large", 413);
    return subtitleText(data, subtitleType(name));
  }
  textStreams(hash) {
    let streams = [];
    try {
      streams = JSON.parse(this.s.db.prepare("SELECT subtitle_streams FROM video_items WHERE hash=?").get(hash)?.subtitle_streams || "[]");
    } catch {}
    return (Array.isArray(streams) ? streams : []).filter((track) => TEXT_SUBTITLES.has(track.codec)).map((track) => track.stream);
  }
  savedSubtitle(hash, stream) {
    const dir = path.join(this.s.home, "video-subtitles");
    if (!fs.existsSync(path.join(dir, `${hash}.done`))) return { done: false };
    const file = path.join(dir, `${hash}-${stream}.vtt`);
    if (fs.existsSync(file)) return { done: true, text: fs.readFileSync(file, "utf8") };
    return { done: true, text: fs.existsSync(path.join(dir, `${hash}-${stream}.large`)) ? null : undefined };
  }
  extractAll(file, name, hash, streams, size, warm = false) {
    this.extracting ||= new Map();
    this.extractions ||= new AbortController();
    if (!warm && this.warming && this.warming.hash !== hash) this.warming.controller.abort();
    if (this.extracting.has(hash)) return this.extracting.get(hash);
    const controller = new AbortController();
    const stop = () => controller.abort();
    this.extractions.signal.addEventListener("abort", stop, { once: true });
    const run = async () => {
      if (this.closed || controller.signal.aborted) fail("These subtitles could not be read", 422);
      if (warm) this.warming = { hash, controller };
      try {
        const found = await extractSubtitles(file, name, streams, Math.max(180000, Math.ceil(size / (5 * 1024 * 1024)) * 1000), controller.signal);
        if (this.closed) return;
        const dir = path.join(this.s.home, "video-subtitles");
        fs.mkdirSync(dir, { recursive: true });
        for (const [stream, text] of found)
          if (text === null) fs.writeFileSync(path.join(dir, `${hash}-${stream}.large`), "");
          else fs.writeFileSync(path.join(dir, `${hash}-${stream}.vtt`), text);
        fs.writeFileSync(path.join(dir, `${hash}.done`), "");
        pruneDirectory(dir, SUBTITLE_CACHE_BYTES, hash);
      } finally {
        if (this.warming?.controller === controller) this.warming = null;
        this.extractions?.signal.removeEventListener("abort", stop);
      }
    };
    this.subtitleQueue = (this.subtitleQueue || Promise.resolve()).then(run, run);
    const job = this.subtitleQueue.finally(() => this.extracting.delete(hash));
    this.extracting.set(hash, job);
    job.catch(() => {
      if (warm && controller.signal.aborted) return;
      this.subtitleFailures ||= new Map();
      this.subtitleFailures.set(hash, Date.now() + 10 * 60000);
    });
    return job;
  }
  warmSubtitles(volume, name, hash) {
    try {
      if (!this.hub() || this.closed || this.extracting?.size || (this.subtitleFailures?.get(hash) || 0) > Date.now()) return;
      const streams = this.textStreams(hash);
      if (!streams.length || this.savedSubtitle(hash, streams[0]).done) return;
      const media = this.media(volume, name, hash);
      this.extractAll(media.file, name, hash, streams, media.size, true).catch(() => {});
    } catch {}
  }
  async embeddedSubtitles(volume, name, hash, stream, { wait = true } = {}) {
    const media = this.media(volume, name, hash);
    const streams = this.textStreams(hash);
    if (!streams.includes(stream)) fail("These subtitles are no longer available", 404);
    let saved = this.savedSubtitle(hash, stream);
    if (!saved.done) {
      if ((this.subtitleFailures?.get(hash) || 0) > Date.now()) fail("These subtitles could not be read", 422);
      if (!wait) {
        this.extractAll(media.file, name, hash, streams, media.size).catch(() => {});
        return PREPARING;
      }
      try {
        await this.extractAll(media.file, name, hash, streams, media.size);
      } catch {
        fail("These subtitles could not be read", 422);
      }
      saved = this.savedSubtitle(hash, stream);
    }
    if (saved.text === undefined) fail("These subtitles could not be read", 422);
    if (saved.text === null) fail("These subtitles are too large", 413);
    return saved.text;
  }
  videoRow(volume, name) {
    this.requireLibrary(volume);
    const row = this.s.viewCurrent(volume, name);
    if (!row || row.deleted || row.directory || !videoType(name) || this.s.visibleRules(volume)(name, false))
      fail("This video is no longer available", 404);
    return row;
  }
  savePosition(owner, body) {
    const { volume, path: name, hash } = body;
    if (typeof volume !== "string" || typeof name !== "string" || typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) fail("Invalid video position");
    const position = Number(body.position);
    const duration = Number(body.duration);
    if (!Number.isFinite(position) || position < 0 || !Number.isFinite(duration) || duration <= 0) fail("Invalid video position");
    if (this.videoRow(volume, name).hash !== hash) fail("This video has changed. Reload the library.", 409);
    if (position < RESUME_HEAD_SECONDS) return { kept: false };
    const at = Date.now();
    if (position >= finishedAt(duration)) {
      this.finish(volume, name, hash, duration, owner, at);
      return { kept: false, finished: true };
    }
    this.s.db
      .prepare("INSERT OR REPLACE INTO video_positions(volume,path,hash,position,duration,device,name,updated) VALUES(?,?,?,?,?,?,?,?)")
      .run(volume, name, hash, Math.min(position, duration), duration, owner.id, owner.name, at);
    this.progressGeneration++;
    return { kept: true };
  }
  finish(volume, name, hash, duration, owner, at) {
    this.s.db.exec("BEGIN IMMEDIATE");
    try {
      this.s.db
        .prepare("INSERT OR REPLACE INTO video_positions(volume,path,hash,position,duration,device,name,updated) VALUES(?,?,?,0,?,?,?,?)")
        .run(volume, name, hash, duration, owner.id, owner.name, at);
      this.s.db.prepare("INSERT OR REPLACE INTO video_watched(volume,path,updated) VALUES(?,?,?)").run(volume, name, at);
      this.s.db.exec("COMMIT");
    } catch (error) {
      this.s.db.exec("ROLLBACK");
      throw error;
    }
    this.progressGeneration++;
  }
  setWatched(owner, body) {
    const { volume, path: name } = body;
    if (typeof volume !== "string" || typeof name !== "string" || typeof body.watched !== "boolean") fail("Invalid watched state");
    if (body.hash !== undefined && (typeof body.hash !== "string" || !/^[a-f0-9]{64}$/.test(body.hash))) fail("Invalid watched state");
    const row = this.videoRow(volume, name);
    if (body.hash !== undefined && row.hash !== body.hash) fail("This video has changed. Reload the library.", 409);
    if (body.watched) {
      const known = this.s.db.prepare("SELECT duration FROM video_positions WHERE volume=? AND path=? AND hash=?").get(volume, name, row.hash);
      this.finish(volume, name, row.hash, known?.duration || 0, owner, Date.now());
    } else {
      this.s.db.prepare("DELETE FROM video_watched WHERE volume=? AND path=?").run(volume, name);
      this.s.db.prepare("DELETE FROM video_positions WHERE volume=? AND path=?").run(volume, name);
      this.progressGeneration++;
    }
    return { watched: body.watched };
  }
  titleOf(view, id) {
    return view.shows.find((show) => show.seasons.some((season) => season.episodes.some((episode) => episode.id === id)))?.id || id;
  }
  watchNextAnswer(volume) {
    this.progressGeneration++;
    return { version: this.overlay(volume, this.current(volume)).version };
  }
  hideWatchNext(volume, id) {
    this.requireLibrary(volume);
    if (typeof id !== "string" || !/^[mes]:./.test(id) || id.length > 1100) fail("Invalid video");
    const view = this.overlay(volume, this.current(volume));
    if (!view.watchNext.some((card) => card.id === id)) return { version: view.version };
    this.s.db.prepare("INSERT OR REPLACE INTO video_hidden(volume,id,since) VALUES(?,?,?)").run(volume, this.titleOf(view, id), Date.now());
    return this.watchNextAnswer(volume);
  }
  restoreWatchNext(volume, id) {
    this.requireLibrary(volume);
    if (typeof id !== "string" || !/^[mes]:./.test(id) || id.length > 1100) fail("Invalid video");
    const view = this.overlay(volume, this.current(volume));
    if (!this.s.db.prepare("DELETE FROM video_hidden WHERE volume=? AND id=?").run(volume, this.titleOf(view, id)).changes) return { version: view.version };
    return this.watchNextAnswer(volume);
  }
  overrideKey(volume, id) {
    if (typeof id !== "string" || !/^[meos]:./.test(id) || id.length > 1100) fail("Invalid video");
    const show = id.startsWith("s:");
    const item = show
      ? this.find(volume, id) ||
        (this.s.db.prepare("SELECT 1 FROM video_overrides WHERE volume=? AND key=?").get(volume, id) ? { kind: "show" } : null)
      : this.entry(volume, id.slice(2));
    if (!item) fail("This video is no longer available", 404);
    return { item, key: show ? id : `file:${item.path}` };
  }
  saveOverride(volume, key, values) {
    const known = this.s.db.prepare("SELECT tmdb,kind,kids FROM video_overrides WHERE volume=? AND key=?").get(volume, key) || {
      tmdb: null,
      kind: null,
      kids: null,
    };
    const next = { ...known, ...values };
    if (next.tmdb === null && next.kind === null && next.kids === null)
      this.s.db.prepare("DELETE FROM video_overrides WHERE volume=? AND key=?").run(volume, key);
    else
      this.s.db
        .prepare("INSERT OR REPLACE INTO video_overrides(volume,key,tmdb,kind,kids) VALUES(?,?,?,?,?)")
        .run(volume, key, next.tmdb, next.kind, next.kids);
    this.generation++;
  }
  match(body) {
    if (typeof body.volume !== "string") fail("Invalid video");
    const { item, key } = this.overrideKey(body.volume, body.id);
    if (body.reset === true) this.saveOverride(body.volume, key, { tmdb: null, kind: null, kids: null });
    else if (body.none === true) this.saveOverride(body.volume, key, { tmdb: null, kind: "other", kids: null });
    else {
      const type = body.tmdb?.type;
      const id = body.tmdb?.id;
      if (!["movie", "tv"].includes(type) || !Number.isSafeInteger(id) || id <= 0) fail("Choose a title to match");
      if (item.kind === "show" ? type !== "tv" : type !== "movie")
        fail(item.kind === "show" ? "Choose a TV show for this show" : "Choose a movie for this file. Episodes take their show's match.");
      if (item.kind === "episode") fail("Fix the match of the show instead");
      this.saveOverride(body.volume, key, { tmdb: `${type}:${id}`, kind: null, kids: null });
    }
    return { ok: true };
  }
  setKids(body) {
    if (typeof body.volume !== "string") fail("Invalid video");
    if (![true, false, null].includes(body.kids)) fail("Choose kids, not for kids or automatic");
    const { item, key } = this.overrideKey(body.volume, body.id);
    if (item.kind !== "movie") fail("Only movies go under Kids; shows always stay in TV Shows");
    this.saveOverride(body.volume, key, { kids: body.kids === null ? null : body.kids ? 1 : 0 });
    return { kids: body.kids };
  }
  migrateSettings() {
    const saved = this.s.config.video;
    if (!saved || (saved.content && !("language" in saved) && !("country" in saved) && !("kidsLimit" in saved))) return;
    const next = { content: closestContent(saved, this.tmdb.contents().map((content) => content.id)), ...(saved.tmdbToken ? { tmdbToken: saved.tmdbToken } : {}) };
    this.s.config.video = next;
    this.s.saveConfig();
  }
  tmdbState(matching) {
    if (!this.tmdb.enabled()) return "none";
    if (this.tmdb.tokenRefused) return "refused";
    return matching || this.wanted.size ? "matching" : "connected";
  }
  settingsView() {
    this.want({ key: CONTENT_KEY, kind: "contents" });
    const settings = videoSettings(this.s.config);
    let matched = 0;
    let total = 0;
    let matching = false;
    const libraries = [];
    for (const volume of this.libraries()) {
      let value;
      try {
        value = this.current(volume);
      } catch {
        continue;
      }
      const titles = [...value.movies, ...value.shows];
      const found = titles.filter((item) => item.matched).length;
      matched += found;
      total += titles.length;
      if (value.matching) matching = true;
      libraries.push({
        volume,
        name: this.s.volume(volume).name,
        movies: value.movies.length,
        shows: value.shows.length,
        unrecognised: value.other.length + (settings.tmdbToken ? titles.length - found : 0),
      });
    }
    return {
      tokenSet: !!settings.tmdbToken,
      state: this.tmdbState(matching),
      matched,
      total,
      content: settings.content,
      contents: this.tmdb.contents(),
      libraries: libraries.sort((a, b) => a.name.localeCompare(b.name)),
    };
  }
  rematch() {
    for (const volume of this.libraries()) {
      try {
        this.library(volume);
      } catch {
        continue;
      }
    }
  }
  saveSettings(body) {
    const next = { content: videoSettings(this.s.config).content, ...(this.s.config.video?.tmdbToken ? { tmdbToken: this.s.config.video.tmdbToken } : {}) };
    if (body.tmdbToken !== undefined) {
      if (typeof body.tmdbToken !== "string" || body.tmdbToken.length > 2048 || /[\s\x00-\x1f]/.test(body.tmdbToken.trim()))
        fail("Paste the TMDB API key or Read Access Token");
      const value = body.tmdbToken.trim();
      if (value) next.tmdbToken = value;
      else delete next.tmdbToken;
    }
    if (body.content !== undefined) {
      if (!this.tmdb.contents().some((content) => content.id === body.content)) fail("Choose a content language and country");
      next.content = body.content;
    }
    this.s.config.video = next;
    this.s.saveConfig();
    if (body.tmdbToken !== undefined) {
      this.tmdb.reset();
      this.wanted.clear();
    }
    this.generation++;
    this.rematch();
    return this.settingsView();
  }
  refresh() {
    if (!this.tmdb.enabled()) fail("Add a TMDB key in Settings first", 409);
    this.tmdb.markRefresh();
    this.wanted.clear();
    this.generation++;
    this.rematch();
    return this.settingsView();
  }
  sweep(force = false) {
    if (this.closed || (!force && Date.now() - this.swept < SWEEP_MS)) return;
    this.swept = Date.now();
    try {
      this.removeUnreferenced();
    } catch {
      return;
    }
  }
  removeUnreferenced() {
    if (!this.hub()) return;
    const libraries = this.libraries();
    const current = `SELECT f.hash FROM ${this.s.fileSource()} f WHERE f.volume IN (SELECT value FROM json_each(?)) AND f.deleted=0 AND f.directory=0 AND f.hash IS NOT NULL`;
    if (this.s.db.prepare(`DELETE FROM video_items WHERE hash NOT IN (${current})`).run(JSON.stringify(libraries)).changes)
      this.generation++;
    const live = `SELECT 1 FROM ${this.s.fileSource()} f WHERE f.volume=t.volume AND f.path=t.path AND f.deleted=0 AND f.directory=0`;
    let pruned = 0;
    for (const table of ["video_positions", "video_watched"])
      pruned += this.s.db.prepare(`DELETE FROM ${table} AS t WHERE NOT EXISTS (${live})`).run().changes;
    if (pruned) this.progressGeneration++;
    if (!fs.existsSync(this.directory)) return;
    const keep = new Set();
    for (const volume of libraries) {
      try {
        for (const key of this.current(volume).art.keys()) keep.add(key);
      } catch {
        return;
      }
    }
    for (const name of fs.readdirSync(this.directory)) {
      const file = path.join(this.directory, name);
      if (name.startsWith("search-")) {
        if (name.endsWith(".tmp") || Date.now() - (fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs || 0) > SEARCH_ART_MS)
          fs.rmSync(file, { force: true });
        continue;
      }
      const key = name.slice(0, 64);
      if ((keep.has(key) && !name.endsWith(".tmp")) || this.rendering.has(key)) continue;
      try {
        fs.rmSync(file, { force: true });
      } catch {
        continue;
      }
    }
  }
}
