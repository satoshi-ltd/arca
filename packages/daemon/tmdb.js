import { fail } from "./storage.js";
import { collectionName, normalizeTitle } from "../core/video-names.js";

export const TMDB_API = "https://api.themoviedb.org/3";
export const TMDB_IMAGES = "https://image.tmdb.org/t/p";
const IMAGE_BYTES = 16 * 1024 ** 2;
const BACKOFF_MS = 30000;
const BACKOFF_MAX_MS = 3600000;
const NONE_MS = 7 * 86400000;
const MISSING_MS = 86400000;

const CERTIFICATIONS = {
  ES: { movie: ["TP", "7", "12", "16", "18"], numeric: true },
  US: { movie: ["G", "PG", "PG-13", "R", "NC-17"] },
  GB: { movie: ["U", "PG", "12A", "12", "15", "18"] },
  DE: { movie: ["0", "6", "12", "16", "18"], numeric: true },
  FR: { movie: ["U", "10", "12", "16", "18"], numeric: true },
};
const ALL_AGES = new Set(["TP", "A", "APTA", "AI", "U", "0", "TOUS PUBLICS", "TOUT PUBLIC", "ALL"]);

function rank(rules, value) {
  const cert = String(value || "").trim().toUpperCase();
  if (!cert) return null;
  if (rules.numeric) {
    if (ALL_AGES.has(cert)) return 0;
    const number = /^\+?(\d{1,2})\+?$/.exec(cert)?.[1];
    return number === undefined ? null : Number(number);
  }
  const index = rules.movie.findIndex((item) => item.toUpperCase() === cert);
  return index >= 0 ? index : null;
}

export function withinLimit(country, certification, limit) {
  const rules = CERTIFICATIONS[country];
  if (!rules || !certification) return false;
  const value = rank(rules, certification);
  if (value === null) return false;
  const cap = rules.numeric ? rank(rules, limit) : rules.movie.indexOf(limit);
  return cap !== null && cap >= 0 && value <= cap;
}

export const CONTENT_KEY = "tmdb:contents";
const CONTENTS_MS = 7 * 86400000;
const CONTENT_ID = /^[a-z]{2}-[A-Z]{2}$/;
const PRIMARY = ["es-ES", "en-US", "en-GB", "de-DE", "fr-FR"];
export const FALLBACK_CONTENTS = [
  ...PRIMARY,
  "es-MX", "es-AR", "en-CA", "en-AU", "en-IE", "de-AT", "de-CH", "fr-CA", "it-IT", "pt-PT", "pt-BR", "nl-NL",
  "sv-SE", "da-DK", "nb-NO", "fi-FI", "pl-PL", "ru-RU", "ja-JP", "ko-KR", "zh-CN", "tr-TR", "ca-ES",
];
const UNRATED = /^(nr|unrated|not rated|no rating|no rated|sin calificar)$/i;
const KIDS_LIMITS = { ES: "TP", US: "G", GB: "U", DE: "0", FR: "U" };

export function contentLabel(id) {
  const [language, country] = id.split("-");
  const capital = (value) => (value ? value[0].toLocaleUpperCase(language) + value.slice(1) : value);
  try {
    return `${capital(new Intl.DisplayNames([language], { type: "language" }).of(language))} · ${new Intl.DisplayNames([language], { type: "region" }).of(country)}`;
  } catch {
    return id;
  }
}
export function contentList(data) {
  const ids = [...new Set([...(Array.isArray(data?.pairs) && data.pairs.length ? data.pairs : FALLBACK_CONTENTS), ...PRIMARY])].filter((id) => CONTENT_ID.test(id));
  return ids.map((id) => ({ id, label: contentLabel(id) })).sort((a, b) => a.label.localeCompare(b.label) || (a.id < b.id ? -1 : 1));
}
export function kidsCertification(country, certification, lists = null) {
  if (UNRATED.test(String(certification || "").trim())) return false;
  const list = (lists?.movie?.[country] || []).filter(([value, order]) => order > 0 && !UNRATED.test(value));
  if (list.length) {
    const lowest = Math.min(...list.map(([, order]) => order));
    const allowed = new Set(list.filter(([, order]) => order === lowest).map(([value]) => value.toUpperCase()));
    return allowed.has(String(certification || "").trim().toUpperCase());
  }
  return withinLimit(country, certification, KIDS_LIMITS[country]);
}

export function closestContent(saved = {}, choices = FALLBACK_CONTENTS) {
  if (CONTENT_ID.test(saved.content || "")) return saved.content;
  const language = typeof saved.language === "string" ? saved.language : "";
  if (CONTENT_ID.test(language) && choices.includes(language)) return language;
  const base = language.split("-")[0];
  return (
    PRIMARY.find((id) => id === language) ||
    PRIMARY.find((id) => id.endsWith(`-${saved.country}`) && (!base || id.startsWith(`${base}-`))) ||
    PRIMARY.find((id) => base && id.startsWith(`${base}-`)) ||
    "en-US"
  );
}
export function videoSettings(config) {
  const saved = config.video || {};
  const content = closestContent(saved);
  return {
    tmdbToken: typeof saved.tmdbToken === "string" && saved.tmdbToken ? saved.tmdbToken : null,
    content,
    language: content,
    country: content.slice(3),
  };
}

const originalLanguage = (value) => (/^[a-z]{2,3}$/i.test(value || "") ? value.toLowerCase() : "");
const yearOf = (date) => (/^\d{4}/.test(date || "") ? Number(date.slice(0, 4)) : null);
const text = (value, limit = 4000) =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, limit) : null;
const imagePath = (value) => (/^\/[A-Za-z0-9_-]{1,128}\.(?:jpe?g|png)$/.test(value || "") ? value : null);
const ids = (list, limit) =>
  (Array.isArray(list) ? list : []).map((row) => row?.id).filter((value) => Number.isSafeInteger(value) && value > 0).slice(0, limit);
const names = (list, limit) =>
  (Array.isArray(list) ? list : [])
    .map((item) => text(item?.name, 200))
    .filter(Boolean)
    .slice(0, limit);
const rating = (value) => (Number.isFinite(value) && value > 0 ? Math.round(value * 10) / 10 : null);

function movieCertifications(results) {
  const certifications = {};
  for (const country of Array.isArray(results) ? results : []) {
    const dates = Array.isArray(country?.release_dates) ? country.release_dates : [];
    const pick =
      dates.find((row) => row.type === 3 && text(row.certification, 16)) ||
      dates.find((row) => text(row.certification, 16));
    if (typeof country?.iso_3166_1 === "string" && pick)
      certifications[country.iso_3166_1] = text(pick.certification, 16);
  }
  return certifications;
}
function tvCertifications(results) {
  const certifications = {};
  for (const row of Array.isArray(results) ? results : [])
    if (typeof row?.iso_3166_1 === "string" && text(row.rating, 16))
      certifications[row.iso_3166_1] = text(row.rating, 16);
  return certifications;
}

export class Tmdb {
  constructor(store, options = {}) {
    this.s = store;
    this.controller = new AbortController();
    this.fetch = options.fetch || ((...args) => globalThis.fetch(...args));
    this.interval = options.interval ?? 250;
    this.last = 0;
    const saved = store.db.prepare("SELECT data,fetched FROM video_meta WHERE key='backoff'").get();
    const state = saved ? JSON.parse(saved.data || "{}") : {};
    this.until = saved?.fetched || 0;
    this.failures = Number(state.failures) || 0;
    this.tokenRefused = state.refused === true;
    this.refreshed = store.db.prepare("SELECT fetched FROM video_meta WHERE key='refresh'").get()?.fetched || 0;
  }
  close() {
    this.controller.abort();
  }
  markRefresh() {
    if (this.controller.signal.aborted) return;
    this.refreshed = Date.now();
    this.s.db.prepare("INSERT OR REPLACE INTO video_meta(key,data,fetched,error) VALUES('refresh',NULL,?,0)").run(this.refreshed);
  }
  stale(row) {
    return tmdbStale(row) || (!!row && row.data !== null && row.fetched < this.refreshed);
  }
  settings() {
    return videoSettings(this.s.config);
  }
  enabled() {
    return !!this.settings().tmdbToken;
  }
  waiting() {
    return this.until > Date.now();
  }
  reset() {
    if (this.controller.signal.aborted) return;
    this.until = 0;
    this.failures = 0;
    this.tokenRefused = false;
    this.s.db.prepare("DELETE FROM video_meta WHERE key='backoff'").run();
  }
  back(ms) {
    if (this.controller.signal.aborted) return;
    this.failures++;
    const delay = ms || Math.min(BACKOFF_MAX_MS, BACKOFF_MS * 2 ** (this.failures - 1));
    this.until = Date.now() + delay;
    this.s.db
      .prepare("INSERT OR REPLACE INTO video_meta(key,data,fetched,error) VALUES('backoff',?,?,0)")
      .run(JSON.stringify({ failures: this.failures, refused: !!this.tokenRefused }), this.until);
  }
  async slot() {
    const now = Date.now();
    const at = Math.max(now, this.last + this.interval);
    this.last = at;
    if (at > now) await new Promise((resolve) => setTimeout(resolve, at - now));
  }
  async call(pathname, params = {}) {
    this.controller.signal.throwIfAborted();
    const token = this.settings().tmdbToken;
    if (!token) fail("Add a TMDB token in Settings first", 409);
    if (this.waiting())
      throw Object.assign(new Error("TMDB is not answering. Try again later."), { status: 503, transient: true });
    await this.slot();
    this.controller.signal.throwIfAborted();
    const url = new URL(TMDB_API + pathname);
    for (const [key, value] of Object.entries(params))
      if (value !== null && value !== undefined && value !== "") url.searchParams.set(key, String(value));
    const apiKey = /^[a-f0-9]{32}$/i.test(token);
    if (apiKey) url.searchParams.set("api_key", token);
    let response;
    try {
      response = await this.fetch(url.href, {
        headers: apiKey ? { Accept: "application/json" } : { Authorization: `Bearer ${token}`, Accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(15000)]),
      });
    } catch {
      this.back();
      throw Object.assign(new Error("TMDB is not reachable. Try again later."), { status: 503, transient: true });
    }
    if (response.status === 429 || response.status >= 500) {
      const after = Number(response.headers?.get?.("retry-after"));
      this.back(Number.isFinite(after) && after > 0 ? Math.min(after * 1000, BACKOFF_MAX_MS) : 0);
      throw Object.assign(new Error("TMDB is busy. Try again later."), { status: 503, transient: true });
    }
    if (response.status === 401) {
      this.tokenRefused = true;
      this.back(BACKOFF_MAX_MS);
      throw Object.assign(new Error("TMDB refused the token. Check it in Settings."), { status: 502, transient: true });
    }
    if (!response.ok)
      throw Object.assign(new Error("TMDB has no such title"), { status: response.status === 404 ? 404 : 502 });
    try {
      const body = await response.json();
      if (this.failures || this.tokenRefused) this.reset();
      return body;
    } catch {
      this.back();
      throw Object.assign(new Error("TMDB answered with something unreadable"), { status: 502, transient: true });
    }
  }
  store(key, data, error = 0) {
    if (this.controller.signal.aborted) return;
    this.s.db
      .prepare("INSERT OR REPLACE INTO video_meta(key,data,fetched,error) VALUES(?,?,?,?)")
      .run(key, data === null ? null : JSON.stringify(data), Date.now(), error);
  }
  async searchResults(query, type, year) {
    const language = this.settings().language;
    const body = await this.call(type === "tv" ? "/search/tv" : "/search/movie", {
      query,
      language,
      include_adult: "false",
      ...(year ? (type === "tv" ? { first_air_date_year: year } : { year }) : {}),
    });
    return (Array.isArray(body?.results) ? body.results : [])
      .filter((row) => Number.isSafeInteger(row?.id) && row.id > 0)
      .slice(0, 20)
      .map((row) => ({
        type: type === "tv" ? "tv" : "movie",
        id: row.id,
        title: text(type === "tv" ? row.name : row.title, 300) || text(type === "tv" ? row.original_name : row.original_title, 300) || "",
        year: yearOf(type === "tv" ? row.first_air_date : row.release_date),
        overview: text(row.overview, 1000),
        poster: imagePath(row.poster_path),
      }));
  }
  async resolve(job) {
    try {
      if (job.kind === "search") {
        let results = await this.searchResults(job.title, job.type, job.year);
        if (!results.length && job.year) results = await this.searchResults(job.title, job.type, null);
        const wanted = normalizeTitle(job.title);
        const score = (row) => (normalizeTitle(row.title) === wanted ? 2 : 0) + (job.year && row.year === job.year ? 1 : 0);
        const best = results.slice(0, 5).reduce((top, row) => (score(row) > score(top) ? row : top), results[0]);
        this.store(job.key, best ? { id: best.id } : { none: true });
      } else if (job.kind === "movie") this.store(job.key, await this.movie(job.id));
      else if (job.kind === "tv") this.store(job.key, await this.tv(job.id));
      else if (job.kind === "season") this.store(job.key, await this.season(job.id, job.season));
      else if (job.kind === "contents") this.store(job.key, await this.loadContents());
    } catch (error) {
      if (error.transient) throw error;
      this.store(job.key, null, Date.now() + MISSING_MS);
    }
  }
  contentsRow() {
    return this.s.db.prepare("SELECT data,fetched,error FROM video_meta WHERE key=?").get(CONTENT_KEY);
  }
  contentsData() {
    const row = this.contentsRow();
    return row?.data ? JSON.parse(row.data) : null;
  }
  contentsStale() {
    const row = this.contentsRow();
    return !row || (row.data === null ? !(row.error > Date.now()) : row.fetched < Date.now() - CONTENTS_MS || row.fetched < this.refreshed);
  }
  contents() {
    return contentList(this.contentsData());
  }
  async loadContents() {
    const translations = await this.call("/configuration/primary_translations");
    const compact = (body) =>
      Object.fromEntries(
        Object.entries(body?.certifications || {}).map(([country, list]) => [
          country,
          (Array.isArray(list) ? list : [])
            .filter(
              (row) =>
                typeof row?.certification === "string" &&
                row.certification &&
                Number.isFinite(row.order) &&
                row.order > 0 &&
                !UNRATED.test(row.certification) &&
                !UNRATED.test(row.meaning || ""),
            )
            .map((row) => [row.certification, row.order]),
        ]),
      );
    const movie = compact(await this.call("/certification/movie/list"));
    const tv = compact(await this.call("/certification/tv/list"));
    const pairs = (Array.isArray(translations) ? translations : []).filter(
      (id) => CONTENT_ID.test(id) && (movie[id.slice(3)]?.length || tv[id.slice(3)]?.length),
    );
    return { pairs, movie, tv };
  }
  async english(pathname, value) {
    const language = this.settings().language;
    if (value.overview || /^en(-|$)/.test(language)) return value;
    try {
      const fallback = await this.call(pathname, { language: "en-US" });
      return { ...value, overview: text(fallback?.overview) };
    } catch (error) {
      if (error.transient) throw error;
      return value;
    }
  }
  async movie(id) {
    const language = this.settings().language;
    const body = await this.call(`/movie/${id}`, { language, append_to_response: "release_dates,credits,keywords,recommendations" });
    return this.english(`/movie/${id}`, {
      id: body.id,
      title: text(body.title, 300) || text(body.original_title, 300),
      year: yearOf(body.release_date),
      overview: text(body.overview),
      genres: names(body.genres, 10),
      genreIds: (Array.isArray(body.genres) ? body.genres : []).map((row) => row?.id).filter(Number.isSafeInteger),
      runtime: Number.isSafeInteger(body.runtime) && body.runtime > 0 ? body.runtime : null,
      rating: rating(body.vote_average),
      certifications: movieCertifications(body.release_dates?.results),
      cast: names(body.credits?.cast, 5),
      collection: collectionName(text(body.belongs_to_collection?.name, 300)),
      keywords: ids(body.keywords?.keywords, 40),
      recommended: ids(body.recommendations?.results, 40).map((value) => `movie:${value}`),
      poster: imagePath(body.poster_path),
      backdrop: imagePath(body.backdrop_path),
      originalLanguage: originalLanguage(body.original_language),
      language,
    });
  }
  async tv(id) {
    const language = this.settings().language;
    const body = await this.call(`/tv/${id}`, { language, append_to_response: "content_ratings,credits,keywords,recommendations" });
    return this.english(`/tv/${id}`, {
      id: body.id,
      title: text(body.name, 300) || text(body.original_name, 300),
      year: yearOf(body.first_air_date),
      overview: text(body.overview),
      genres: names(body.genres, 10),
      genreIds: (Array.isArray(body.genres) ? body.genres : []).map((row) => row?.id).filter(Number.isSafeInteger),
      rating: rating(body.vote_average),
      certifications: tvCertifications(body.content_ratings?.results),
      cast: names(body.credits?.cast, 5),
      keywords: ids(body.keywords?.results, 40),
      recommended: ids(body.recommendations?.results, 40).map((value) => `tv:${value}`),
      poster: imagePath(body.poster_path),
      backdrop: imagePath(body.backdrop_path),
      seasons: (Array.isArray(body.seasons) ? body.seasons : [])
        .filter((row) => Number.isSafeInteger(row?.season_number))
        .map((row) => ({ season: row.season_number, name: text(row.name, 200) })),
      originalLanguage: originalLanguage(body.original_language),
      language,
    });
  }
  async season(id, number) {
    const language = this.settings().language;
    const body = await this.call(`/tv/${id}/season/${number}`, { language });
    return {
      name: text(body.name, 200),
      episodes: (Array.isArray(body.episodes) ? body.episodes : [])
        .filter((row) => Number.isSafeInteger(row?.episode_number))
        .map((row) => ({
          episode: row.episode_number,
          title: text(row.name, 300),
          overview: text(row.overview),
          still: imagePath(row.still_path),
          aired: /^\d{4}-\d{2}-\d{2}$/.test(row.air_date || "") ? row.air_date : null,
          runtime: Number.isSafeInteger(row.runtime) && row.runtime > 0 ? row.runtime : null,
        })),
      language,
    };
  }
  async image(pathname, size) {
    if (this.controller.signal.aborted) return null;
    if (!imagePath(pathname)) fail("Invalid image", 400);
    if (this.waiting()) return null;
    await this.slot();
    if (this.controller.signal.aborted) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      let response;
      try {
        response = await this.fetch(`${TMDB_IMAGES}/${size}${pathname}`, { redirect: "error", signal: AbortSignal.any([this.controller.signal, controller.signal]) });
      } catch {
        this.back();
        return null;
      }
      if (response.status === 429 || response.status >= 500) {
        const after = Number(response.headers?.get?.("retry-after"));
        this.back(Number.isFinite(after) && after > 0 ? Math.min(after * 1000, BACKOFF_MAX_MS) : 0);
        return null;
      }
      if (!response.ok) return false;
      if (Number(response.headers?.get?.("content-length")) > IMAGE_BYTES) {
        controller.abort();
        return false;
      }
      const chunks = [];
      let total = 0;
      try {
        for await (const chunk of response.body) {
          total += chunk.length;
          if (total > IMAGE_BYTES) {
            controller.abort();
            return false;
          }
          chunks.push(chunk);
        }
      } catch {
        return null;
      }
      return total ? Buffer.concat(chunks) : false;
    } finally {
      clearTimeout(timer);
    }
  }
}

export const tmdbStale = (row) =>
  !row ||
  (row.data === null && !(row.error > Date.now())) ||
  (row.data !== null && JSON.parse(row.data).none && row.fetched < Date.now() - NONE_MS);
export { imagePath };
