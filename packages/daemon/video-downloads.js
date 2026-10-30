import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { digest, fail, quickHashFile } from "./storage.js";
import { videoType } from "../core/video-names.js";
import { VIDEO_OFFLINE, fileOf, forward, replicaLibrary } from "./video-routes.js";
import { RESUME_HEAD_SECONDS, finishedAt } from "./video.js";

const CHUNK = 8 * 1024 * 1024;
const POLL_MS = 3000;
const WAIT_MS = 30 * 60000;
const GONE = "This video is no longer on the hub";
const MISMATCH = "The downloaded copy did not match the hub's file";
const UPDATING = "The hub is updating this video";
const UNSENT = "The hub could not send this video";
const NO_SPACE = "Not enough free space on this computer to finish the download";
const MISSING = "The downloaded file is missing. Download it again.";
const ACTIVE = ["queued", "downloading"];

const offline = () => Object.assign(new Error(VIDEO_OFFLINE), { status: 503 });
const extension = (name) => {
  const ext = path.extname(name).toLowerCase();
  return /^\.[a-z0-9]{1,6}$/.test(ext) ? ext : "";
};
const json = (value, fallback) => {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

export class VideoDownloads {
  constructor(engine, options = {}) {
    this.engine = engine;
    this.s = engine.store;
    this.dir = path.join(this.s.home, "video-downloads");
    this.chunk = options.chunk || CHUNK;
    this.poll = options.poll ?? POLL_MS;
    this.s.db.exec(`
      CREATE TABLE IF NOT EXISTS video_downloads(hub TEXT NOT NULL,volume TEXT NOT NULL,path TEXT NOT NULL,hash TEXT NOT NULL,size INTEGER NOT NULL,state TEXT NOT NULL,error TEXT,file TEXT NOT NULL,item TEXT NOT NULL,show TEXT,subtitles TEXT NOT NULL DEFAULT '[]',art TEXT NOT NULL DEFAULT '{}',added INTEGER NOT NULL,PRIMARY KEY(hub,volume,path));
      CREATE TABLE IF NOT EXISTS video_outbox(hub TEXT NOT NULL,volume TEXT NOT NULL,path TEXT NOT NULL,route TEXT NOT NULL,body TEXT NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(hub,volume,path,route));
    `);
    this.s.db.prepare("UPDATE video_downloads SET state='queued' WHERE state='downloading'").run();
    this.current = null;
    this.running = null;
    this.closed = false;
    this.stopping = new AbortController();
  }
  get hub() {
    return this.engine.config.hub?.id || "";
  }
  rows(volume) {
    return this.s.db.prepare("SELECT * FROM video_downloads WHERE hub=? AND volume=? ORDER BY added,path").all(this.hub, volume);
  }
  row(volume, name) {
    return this.s.db.prepare("SELECT * FROM video_downloads WHERE hub=? AND volume=? AND path=?").get(this.hub, volume, name);
  }
  where(row, suffix = "") {
    return path.join(this.dir, row.file + suffix);
  }
  isCurrent(row) {
    const current = this.current?.row;
    return !!current && current.hub === row.hub && current.volume === row.volume && current.path === row.path;
  }
  progress(row) {
    if (row.state === "done") return row.size;
    if (this.isCurrent(row)) return this.current.done;
    if (fs.statSync(this.where(row), { throwIfNoEntry: false })?.size === row.size) return row.size;
    return fs.statSync(this.where(row, ".part"), { throwIfNoEntry: false })?.size || 0;
  }
  missing(row) {
    if (row.state !== "done" || fs.statSync(this.where(row), { throwIfNoEntry: false })?.size === row.size) return false;
    this.update(row, { state: "failed", error: MISSING });
    return true;
  }
  list(volume) {
    return {
      downloads: this.rows(volume).map((row) => {
        this.missing(row);
        const item = json(row.item, {});
        return {
        id: item.id || null,
        title: item.kind === "episode" ? [item.showTitle, item.title].filter(Boolean).join(" · ") : item.title || null,
        path: row.path,
        hash: row.hash,
        size: row.size,
        done: Math.min(row.size, this.progress(row)),
        state: row.state,
        ...(row.error ? { error: row.error } : {}),
        };
      }),
    };
  }
  library(volume, stop = null) {
    return replicaLibrary({ engine: this.engine, s: this.s }, volume, null, stop).then((value) => {
      if (value.offline) throw offline();
      return value;
    });
  }
  showOf(library, item) {
    if (item.kind !== "episode") return null;
    const show = (library.shows || []).find((entry) => (entry.seasons || []).some((season) => (season.episodes || []).some((episode) => episode.path === item.path)));
    if (!show) return null;
    const { seasons, episodes, ...rest } = show;
    return rest;
  }
  async queue(volume, paths) {
    if (typeof volume !== "string" || !Array.isArray(paths) || !paths.length || paths.length > 1000 || paths.some((name) => typeof name !== "string"))
      fail("Invalid download");
    if (!this.hub) fail(VIDEO_OFFLINE, 503);
    const library = await this.library(volume);
    const found = [...new Set(paths)].map((name) => fileOf(library, name)).filter((item) => item?.path && /^[a-f0-9]{64}$/.test(item.hash || ""));
    if (!found.length) fail("This video is no longer available", 404);
    const insert = this.s.db.prepare("INSERT INTO video_downloads(hub,volume,path,hash,size,state,file,item,show,added) VALUES(?,?,?,?,?,'queued',?,?,?,?)");
    let added = Date.now();
    for (const item of found) {
      const known = this.row(volume, item.path);
      if (known && ACTIVE.includes(known.state)) continue;
      if (known && known.state === "done" && known.hash === item.hash && !this.missing(known)) continue;
      if (known && known.state === "failed" && known.hash === item.hash) {
        this.update(known, { state: "queued", error: null });
        continue;
      }
      if (known) this.discard(known);
      const file = digest(`${this.hub}\0${volume}\0${item.path}`).slice(0, 32) + extension(item.path);
      const show = this.showOf(library, item);
      insert.run(this.hub, volume, item.path, item.hash, Number(item.size) || 0, file, JSON.stringify(item), show ? JSON.stringify(show) : null, added++);
    }
    void this.wake();
    return this.list(volume);
  }
  drop(volume, paths, active) {
    if (typeof volume !== "string" || !Array.isArray(paths) || paths.some((name) => typeof name !== "string")) fail("Invalid download");
    for (const name of paths) {
      const row = this.row(volume, name);
      if (row && (!active || ACTIVE.includes(row.state))) this.discard(row);
    }
    return this.list(volume);
  }
  cancel(volume, paths) {
    return this.drop(volume, paths, true);
  }
  remove(volume, paths) {
    return this.drop(volume, paths, false);
  }
  discard(row) {
    const remove = this.s.db.prepare("DELETE FROM video_downloads WHERE hub=? AND volume=? AND path=?");
    if (this.isCurrent(row)) {
      remove.run(row.hub, row.volume, row.path);
      this.current.controller.abort();
      return;
    }
    try {
      this.erase(row);
    } catch {
      fail("Close the video before removing its download", 409);
    }
    remove.run(row.hub, row.volume, row.path);
  }
  forget(rows) {
    const remove = this.s.db.prepare("DELETE FROM video_downloads WHERE hub=? AND volume=? AND path=?");
    for (const row of rows) {
      remove.run(row.hub, row.volume, row.path);
      if (this.isCurrent(row)) this.current.controller.abort();
      else
        try {
          this.erase(row);
        } catch {}
    }
  }
  pruneLibrary(volume, library) {
    if (!this.hub || typeof volume !== "string" || !library || library.offline || library.indexing) return;
    if (![library.movies, library.shows, library.other].some((list) => Array.isArray(list) && list.length)) return;
    this.forget(this.rows(volume).filter((row) => !fileOf(library, row.path)));
  }
  pruneCatalog(volumes) {
    if (!this.hub || !Array.isArray(volumes) || !volumes.length) return;
    const kept = new Set(volumes.filter((v) => v?.video).map((v) => v.id));
    this.forget(this.s.db.prepare("SELECT * FROM video_downloads WHERE hub=?").all(this.hub).filter((row) => !kept.has(row.volume)));
  }
  pruneHubs() {
    if (!this.hub) return;
    this.forget(this.s.db.prepare("SELECT * FROM video_downloads WHERE hub<>?").all(this.hub));
  }
  erase(row) {
    if (!fs.existsSync(this.dir)) return;
    const prefix = row.file.slice(0, 32);
    for (const name of fs.readdirSync(this.dir)) if (name.startsWith(prefix)) fs.rmSync(path.join(this.dir, name), { force: true });
  }
  update(row, fields) {
    const keys = Object.keys(fields);
    this.s.db
      .prepare(`UPDATE video_downloads SET ${keys.map((key) => `${key}=?`).join(",")} WHERE hub=? AND volume=? AND path=?`)
      .run(...keys.map((key) => fields[key]), row.hub, row.volume, row.path);
    Object.assign(row, fields);
    return row;
  }
  wake() {
    const { config } = this.engine;
    if (this.closed || this.halting || config.role === "hub" || !config.hub || this.engine.hubUnavailable) return Promise.resolve();
    this.pruneHubs();
    this.flushing ||= this.engine.requestContext
      .exit(() => this.flush())
      .catch(() => {})
      .finally(() => {
        this.flushing = null;
      });
    this.running ||= this.engine.requestContext
      .exit(() => this.run())
      .catch(() => {})
      .finally(() => {
        this.running = null;
      });
    return Promise.all([this.flushing, this.running]).then(() => {});
  }
  async halt() {
    this.halting = true;
    this.stopping.abort();
    try {
      this.current?.controller.abort();
      await this.running;
      await this.flushing;
    } finally {
      this.stopping = new AbortController();
      this.halting = false;
    }
  }
  sweep() {
    if (!fs.existsSync(this.dir)) return;
    const kept = new Set(this.s.db.prepare("SELECT file FROM video_downloads").all().map((row) => row.file.slice(0, 32)));
    for (const name of fs.readdirSync(this.dir))
      if (!kept.has(name.slice(0, 32)))
        try {
          fs.rmSync(path.join(this.dir, name), { force: true });
        } catch {}
  }
  async run() {
    this.sweep();
    while (!this.closed && !this.halting) {
      const row = this.s.db
        .prepare(`SELECT * FROM video_downloads WHERE hub=? AND state IN ('queued','downloading') ORDER BY added,path LIMIT 1`)
        .get(this.hub);
      if (!row) return;
      const controller = new AbortController();
      this.current = { row, controller, done: this.progress(row) };
      try {
        await this.download(row, controller.signal);
      } catch (error) {
        if (controller.signal.aborted) {
          if (!this.row(row.volume, row.path))
            try {
              this.erase(row);
            } catch {}
          continue;
        }
        if (!this.row(row.volume, row.path)) continue;
        if (error.status === 503) {
          this.update(row, { state: "queued", error: error.message || VIDEO_OFFLINE });
          return;
        }
        if (error.message === GONE) {
          this.forget([row]);
          continue;
        }
        this.update(row, { state: "failed", error: error.code === "ENOSPC" ? NO_SPACE : error.message || "This video could not be downloaded" });
      } finally {
        this.current = null;
      }
    }
  }
  async download(row, signal) {
    const library = await this.library(row.volume, signal);
    const item = fileOf(library, row.path);
    if (!item) fail(GONE, 404);
    if (signal.aborted) throw signal.reason;
    const show = this.showOf(library, item);
    if (item.hash !== row.hash || Number(item.size) !== row.size) {
      this.erase(row);
      this.update(row, { hash: item.hash, size: Number(item.size) || 0, subtitles: "[]", art: "{}" });
      this.current.done = 0;
    }
    this.update(row, { state: "downloading", error: null, item: JSON.stringify(item), show: show ? JSON.stringify(show) : null });
    fs.mkdirSync(this.dir, { recursive: true });
    const file = this.where(row);
    const part = this.where(row, ".part");
    if (fs.statSync(file, { throwIfNoEntry: false })?.size !== row.size || quickHashFile(file) !== row.hash) {
      fs.rmSync(file, { force: true });
      try {
        await this.fetchMedia(row, part, signal);
      } catch (error) {
        if (signal.aborted || !error.stale) throw error;
        return this.restart(row, signal, error.status === 409 ? UPDATING : UNSENT);
      }
      if (quickHashFile(part) !== row.hash) {
        fs.rmSync(part, { force: true });
        return this.restart(row, signal, MISMATCH);
      }
      fs.renameSync(part, file);
    }
    const subtitles = await this.subtitles(row, item, signal);
    const art = await this.art(row, item, show, signal);
    if (signal.aborted) throw signal.reason;
    this.update(row, { state: "done", error: null, subtitles: JSON.stringify(subtitles), art: JSON.stringify(art) });
  }
  async restart(row, signal, message) {
    const item = fileOf(await this.library(row.volume, signal), row.path);
    if (!item) fail(GONE, 409);
    if (item.hash === row.hash) fail(message, message === UPDATING ? 503 : 409);
    return this.download(row, signal);
  }
  async fetchMedia(row, part, signal) {
    let done = fs.statSync(part, { throwIfNoEntry: false })?.size || 0;
    if (done > row.size) {
      fs.rmSync(part, { force: true });
      done = 0;
    }
    while (done < row.size) {
      this.current.done = done;
      const hub = this.engine.config.hub;
      if (!hub || this.engine.hubUnavailable) throw offline();
      const idle = new AbortController();
      let timer;
      const wait = () => {
        clearTimeout(timer);
        timer = setTimeout(() => idle.abort(new DOMException("The hub stopped sending", "TimeoutError")), this.engine.videoIdleMs ?? 60000);
      };
      const chunkSignal = AbortSignal.any([signal, idle.signal]);
      wait();
      try {
        let response;
        try {
          response = await fetch(`${hub.url}/v1/video/media?${new URLSearchParams({ volume: row.volume, path: row.path, hash: row.hash })}`, {
            redirect: "error",
            headers: { Authorization: `Bearer ${hub.token}`, Range: `bytes=${done}-${Math.min(row.size, done + this.chunk) - 1}` },
            signal: chunkSignal,
          });
        } catch (error) {
          if (signal.aborted) throw error;
          throw offline();
        }
        const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get("content-range") || "");
        if (response.status !== 206 || !range || Number(range[1]) !== done || Number(range[3]) !== row.size) {
          await response.body?.cancel().catch(() => {});
          if ([502, 503, 504].includes(response.status)) throw offline();
          if ([404, 409, 416].includes(response.status) || (range && Number(range[3]) !== row.size))
            throw Object.assign(new Error(GONE), { status: response.status === 409 ? 409 : 404, stale: true });
          fail("The hub answered the download unexpectedly", 502);
        }
        const body = Readable.fromWeb(response.body).on("data", (data) => {
          if (this.isCurrent(row)) this.current.done += data.length;
          wait();
        });
        try {
          await pipeline(body, fs.createWriteStream(part, { flags: "a" }), { signal: chunkSignal });
        } catch (error) {
          if (signal.aborted || error.syscall) throw error;
          throw offline();
        }
      } finally {
        clearTimeout(timer);
      }
      done = fs.statSync(part).size;
      if (done > row.size) fail(MISMATCH, 409);
    }
    this.current.done = done;
  }
  async subtitles(row, item, signal) {
    const saved = [];
    for (const [index, sub] of (item.subtitles || []).entries()) {
      if (!sub || sub.image) continue;
      let text;
      try {
        if (sub.embedded && Number.isSafeInteger(sub.stream)) text = await this.embedded(row, sub.stream, signal);
        else if (!sub.embedded && typeof sub.path === "string")
          text = (await forward(this.engine, `/v1/video/subtitles?${new URLSearchParams({ volume: row.volume, path: sub.path, format: "json" })}`, undefined, undefined, signal))?.text;
      } catch (error) {
        if (signal.aborted || error.status === 503) throw error;
        continue;
      }
      if (signal.aborted) throw signal.reason;
      if (typeof text !== "string") continue;
      const file = `${row.file}.s${index}.vtt`;
      fs.writeFileSync(path.join(this.dir, file), text);
      saved.push(sub.embedded ? { stream: sub.stream, file } : { path: sub.path, file });
    }
    return saved;
  }
  async embedded(row, stream, signal) {
    const route = `/v1/video/subtitles?${new URLSearchParams({ volume: row.volume, path: row.path, hash: row.hash, stream: String(stream), poll: "1", format: "json" })}`;
    const until = Date.now() + WAIT_MS;
    for (;;) {
      const answer = await forward(this.engine, route, undefined, undefined, signal);
      if (signal.aborted) throw signal.reason;
      if (!answer?.preparing) return answer?.text;
      if (Date.now() > until) return null;
      await sleep(this.poll, undefined, { signal });
    }
  }
  async art(row, item, show, signal) {
    const wanted = [
      [item.poster, "small"],
      [item.backdrop, "large"],
      [item.still, "small"],
      [show?.poster, "small"],
      [show?.backdrop, "large"],
    ].filter(([key]) => typeof key === "string" && key);
    const saved = {};
    for (const [index, [key, size]] of wanted.entries()) {
      if (saved[`${size}:${key}`]) continue;
      let answer;
      try {
        answer = await forward(this.engine, `/v1/video/art?${new URLSearchParams({ volume: row.volume, key, size })}`, undefined, undefined, signal);
      } catch (error) {
        if (signal.aborted || error.status === 503) throw error;
        continue;
      }
      if (signal.aborted) throw signal.reason;
      if (typeof answer?.data !== "string") continue;
      const file = `${row.file}.a${index}.json`;
      fs.writeFileSync(path.join(this.dir, file), JSON.stringify({ data: answer.data }));
      saved[`${size}:${key}`] = file;
    }
    return saved;
  }
  local(volume, name, hash) {
    if (typeof volume !== "string" || typeof name !== "string") return null;
    const row = this.row(volume, name);
    if (!row || row.state !== "done" || row.hash !== hash || this.missing(row)) return null;
    const file = this.where(row);
    return { file, size: row.size, type: videoType(name) || "video/mp4", item: json(row.item, null) };
  }
  subtitle(volume, name, embedded) {
    if (typeof volume !== "string" || typeof name !== "string") return null;
    for (const row of this.rows(volume)) {
      if (row.state !== "done" || (embedded && (row.path !== name || row.hash !== embedded.hash))) continue;
      const hit = json(row.subtitles, []).find((sub) => (embedded ? sub.stream === embedded.stream : sub.path === name));
      if (!hit) continue;
      try {
        return fs.readFileSync(path.join(this.dir, hit.file), "utf8");
      } catch {
        return null;
      }
    }
    return null;
  }
  artData(volume, key, size) {
    if (typeof volume !== "string" || typeof key !== "string") return null;
    for (const row of this.rows(volume)) {
      const file = row.state === "done" && json(row.art, {})[`${size}:${key}`];
      if (!file) continue;
      let data;
      try {
        data = JSON.parse(fs.readFileSync(path.join(this.dir, file), "utf8")).data;
      } catch {}
      if (typeof data === "string") return data;
    }
    return null;
  }
  offlineLibrary(volume) {
    const rows = this.rows(volume).filter((row) => row.state === "done");
    if (!rows.length) return null;
    const movies = [];
    const other = [];
    const shows = new Map();
    for (const row of rows) {
      const item = json(row.item, null);
      if (!item?.id) continue;
      if (item.kind === "movie") movies.push(item);
      else if (item.kind === "episode") {
        const show = json(row.show, null) || { id: item.show, kind: "show", title: item.showTitle || "Untitled" };
        if (!shows.has(show.id)) shows.set(show.id, { ...show, seasons: [] });
        const entry = shows.get(show.id);
        let season = entry.seasons.find((value) => value.season === item.season);
        if (!season) entry.seasons.push((season = { season: item.season, name: item.season === 0 ? "Specials" : `Season ${item.season}`, episodes: [] }));
        season.episodes.push(item);
      } else other.push(item);
    }
    for (const show of shows.values()) {
      show.seasons.sort((a, b) => a.season - b.season);
      for (const season of show.seasons) season.episodes.sort((a, b) => (a.episode ?? 0) - (b.episode ?? 0));
    }
    return {
      version: `downloads-${digest(rows.map((row) => `${row.path}:${row.hash}`).join("\n")).slice(0, 16)}`,
      indexing: false,
      matching: false,
      movies,
      shows: [...shows.values()],
      other,
      continue: [],
      nextUp: [],
      watchNext: [],
      offline: true,
    };
  }
  queued(volume, library) {
    const rows = this.s.db.prepare("SELECT route,body,at FROM video_outbox WHERE hub=? AND volume=? ORDER BY at,rowid").all(this.hub, volume);
    if (!rows.length) return library;
    const changes = new Map();
    for (const row of rows) {
      const body = json(row.body, null);
      if (typeof body?.path === "string") changes.set(body.path, [...(changes.get(body.path) || []), { ...row, body }]);
    }
    const apply = (item) => {
      let next = item;
      for (const { route, body, at } of changes.get(item.path) || []) {
        if (body.hash !== undefined && body.hash !== item.hash) continue;
        const [position, duration] = [Number(body.position), Number(body.duration)];
        if (route === "/v1/video/watched") next = { ...next, watched: body.watched === true, position: null };
        else if (!(position >= 0 && duration > 0)) continue;
        else if (position >= finishedAt(duration)) next = { ...next, watched: true, position: null };
        else if (position >= RESUME_HEAD_SECONDS) next = { ...next, position: { position, duration, updated: at, device: this.engine.config.name } };
      }
      return next;
    };
    return {
      ...library,
      version: `${library.version}-${digest(rows.map((row) => `${row.at}:${row.body}`).join("\n")).slice(0, 8)}`,
      movies: (library.movies || []).map(apply),
      other: (library.other || []).map(apply),
      shows: (library.shows || []).map((show) => ({
        ...show,
        seasons: (show.seasons || []).map((season) => ({ ...season, episodes: (season.episodes || []).map(apply) })),
      })),
    };
  }
  defer(route, body) {
    if (typeof body?.volume !== "string" || typeof body?.path !== "string" || !this.hub) fail("Invalid video");
    this.s.db.prepare("INSERT OR REPLACE INTO video_outbox(hub,volume,path,route,body,at) VALUES(?,?,?,?,?,?)").run(this.hub, body.volume, body.path, route, JSON.stringify(body), Date.now());
    return route === "/v1/video/position" ? { kept: true, queued: true } : { watched: body.watched === true, queued: true };
  }
  async send(route, body) {
    await this.flushing;
    this.sent(route, body);
    try {
      return await forward(this.engine, route, body);
    } catch (error) {
      if (error.status !== 503) throw error;
      return this.defer(route, body);
    }
  }
  sent(route, body) {
    if (typeof body?.volume === "string" && typeof body?.path === "string")
      this.s.db.prepare("DELETE FROM video_outbox WHERE hub=? AND volume=? AND path=? AND route=?").run(this.hub, body.volume, body.path, route);
  }
  async flush() {
    const rows = this.s.db.prepare("SELECT * FROM video_outbox WHERE hub=? ORDER BY at,rowid").all(this.hub);
    const still = this.s.db.prepare("SELECT 1 FROM video_outbox WHERE hub=? AND volume=? AND path=? AND route=? AND body=? AND at=?");
    for (const row of rows) {
      if (this.halting || this.closed) return;
      if (!still.get(row.hub, row.volume, row.path, row.route, row.body, row.at)) continue;
      try {
        await forward(this.engine, row.route, JSON.parse(row.body), undefined, this.stopping.signal);
      } catch (error) {
        if (this.stopping.signal.aborted) return;
        if (!(error.status >= 400 && error.status < 500) || [401, 408, 429].includes(error.status)) return;
      }
      this.s.db
        .prepare("DELETE FROM video_outbox WHERE hub=? AND volume=? AND path=? AND route=? AND body=? AND at=?")
        .run(row.hub, row.volume, row.path, row.route, row.body, row.at);
    }
  }
  async close() {
    this.closed = true;
    this.stopping.abort();
    this.current?.controller.abort();
    await this.running;
    await this.flushing;
  }
}
