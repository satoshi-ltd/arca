import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { digest, fail, hashFileAsync, quickHashFile } from "./storage.js";
import { videoType } from "../core/video-names.js";
import { VIDEO_OFFLINE, fileOf, forward, replicaLibrary } from "./video-routes.js";
import { RESUME_HEAD_SECONDS, finishedAt } from "./video.js";
import { audioType } from "./music.js";
import { MUSIC_OFFLINE, streamedLibrary, trackOf } from "./music-routes.js";

const CHUNK = 8 * 1024 * 1024;
const POLL_MS = 3000;
const WAIT_MS = 30 * 60000;
const GONE = "This video is no longer on the hub";
const MISMATCH = "The downloaded copy did not match the hub's file";
const UPDATING = "The hub is updating this video";
const UNSENT = "The hub could not send this video";
const NO_SPACE = "Not enough free space on this device to finish the download";
const MISSING = "The downloaded file is missing. Download it again.";
const ACTIVE = ["queued", "downloading"];
const KEEP_EVERY_MS = 60000;
const KEEP_GONE_MS = 60000;
const BUSY = "Close the video on this device so its new copy can replace the old one";
const FLOOR_BYTES = 5 * 1024 ** 3;
const FLOOR_SHARE = 0.1;
const KINDS = ["video", "music"];

const offline = (kind = "video") => Object.assign(new Error(kind === "music" ? MUSIC_OFFLINE : VIDEO_OFFLINE), { status: 503 });
const complete = (library) =>
  !!library && !library.offline && !library.indexing && [library.movies, library.shows, library.other, library.tracks].some((list) => Array.isArray(list) && list.length);
const worded = (row, message) => (row.kind === "music" ? message.replace("video", "track") : message);
export function keptTitles(library) {
  const items = new Map();
  for (const item of [...(library.movies || []), ...(library.other || [])]) items.set(item.id, item);
  for (const show of library.shows || [])
    for (const season of show.seasons || []) for (const episode of season.episodes || []) items.set(episode.id, episode);
  const first = [...(library.continue || []), ...(library.nextUp || [])].map((id) => items.get(id)).filter(Boolean);
  const rest = [...items.values()].sort((a, b) => String(b.added || "").localeCompare(String(a.added || "")) || (a.path < b.path ? -1 : 1));
  return [...new Set([...first, ...rest])].filter((item) => typeof item.path === "string" && /^[a-f0-9]{64}$/.test(item.hash || ""));
}
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
    this.musicDir = path.join(this.s.home, "music-downloads");
    this.chunk = options.chunk || CHUNK;
    this.poll = options.poll ?? POLL_MS;
    this.keepEvery = options.keepEvery ?? KEEP_EVERY_MS;
    this.space = options.space || ((directory) => fs.statfsSync(directory));
    this.platform = options.platform || process.platform;
    this.keptAt = new Map();
    this.s.db.exec(`
      CREATE TABLE IF NOT EXISTS video_downloads(hub TEXT NOT NULL,volume TEXT NOT NULL,path TEXT NOT NULL,hash TEXT NOT NULL,size INTEGER NOT NULL,state TEXT NOT NULL,error TEXT,file TEXT NOT NULL,item TEXT NOT NULL,show TEXT,subtitles TEXT NOT NULL DEFAULT '[]',art TEXT NOT NULL DEFAULT '{}',added INTEGER NOT NULL,kind TEXT NOT NULL DEFAULT 'video',previous TEXT,PRIMARY KEY(hub,volume,path));
      CREATE TABLE IF NOT EXISTS video_outbox(hub TEXT NOT NULL,volume TEXT NOT NULL,path TEXT NOT NULL,route TEXT NOT NULL,body TEXT NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(hub,volume,path,route));
      CREATE TABLE IF NOT EXISTS video_keep_missing(hub TEXT NOT NULL,volume TEXT NOT NULL,path TEXT NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(hub,volume,path));
    `);
    const columns = this.s.db.prepare("PRAGMA table_info(video_downloads)").all().map((column) => column.name);
    if (!columns.includes("kind")) this.s.db.exec("ALTER TABLE video_downloads ADD COLUMN kind TEXT NOT NULL DEFAULT 'video'");
    if (!columns.includes("previous")) this.s.db.exec("ALTER TABLE video_downloads ADD COLUMN previous TEXT");
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
  folder(row) {
    return row.kind === "music" ? this.musicDir : this.dir;
  }
  where(row, suffix = "") {
    return path.join(this.folder(row), row.file + suffix);
  }
  isCurrent(row) {
    const current = this.current?.row;
    return !!current && current.hub === row.hub && current.volume === row.volume && current.path === row.path;
  }
  progress(row) {
    if (row.state === "done") return row.size;
    if (this.isCurrent(row)) return this.current.done;
    if (!row.previous && fs.statSync(this.where(row), { throwIfNoEntry: false })?.size === row.size) return row.size;
    return fs.statSync(this.where(row, ".part"), { throwIfNoEntry: false })?.size || 0;
  }
  missing(row) {
    if (row.state !== "done" || fs.statSync(this.where(row), { throwIfNoEntry: false })?.size === row.size) return false;
    this.update(row, { state: "failed", error: MISSING });
    return true;
  }
  freeBytes() {
    try {
      const space = this.space(this.s.home);
      return Number(space.bavail) * Number(space.bsize);
    } catch {
      return null;
    }
  }
  list(volume) {
    return {
      freeBytes: this.freeBytes(),
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
  musicLibrary(volume, stop = null) {
    return streamedLibrary({ engine: this.engine, s: this.s }, volume, null, stop).then((value) => {
      if (value.offline) throw offline("music");
      return value;
    });
  }
  libraryOf(row, stop = null) {
    return row.kind === "music" ? this.musicLibrary(row.volume, stop) : this.library(row.volume, stop);
  }
  itemOf(row, library) {
    return row.kind === "music" ? trackOf(library, row.path) : fileOf(library, row.path);
  }
  showOf(library, item) {
    if (item.kind !== "episode") return null;
    const show = (library.shows || []).find((entry) => (entry.seasons || []).some((season) => (season.episodes || []).some((episode) => episode.path === item.path)));
    if (!show) return null;
    const { seasons, episodes, ...rest } = show;
    return rest;
  }
  async queue(volume, paths, kind = "video") {
    if (typeof volume !== "string" || !Array.isArray(paths) || !paths.length || paths.length > 1000 || paths.some((name) => typeof name !== "string"))
      fail("Invalid download");
    if (!this.hub) fail(kind === "music" ? MUSIC_OFFLINE : VIDEO_OFFLINE, 503);
    const library = kind === "music" ? await this.musicLibrary(volume) : await this.library(volume);
    const found = [...new Set(paths)]
      .map((name) => (kind === "music" ? trackOf(library, name) : fileOf(library, name)))
      .filter((item) => item?.path && /^[a-f0-9]{64}$/.test(item.hash || ""));
    if (!found.length) fail(kind === "music" ? "This track is no longer available" : "This video is no longer available", 404);
    for (const item of found) this.enqueue(volume, item, kind, kind === "music" ? null : this.showOf(library, item));
    void this.wake();
    return this.list(volume);
  }
  enqueue(volume, item, kind = "video", show = null, replace = false) {
    const known = this.row(volume, item.path);
    if (known && ACTIVE.includes(known.state)) return false;
    if (known && known.state === "done" && known.hash === item.hash && !this.missing(known)) return false;
    if (known && known.state === "failed" && known.hash === item.hash) {
      if (replace && known.error !== MISSING) return false;
      this.update(known, { state: "queued", error: null });
      return true;
    }
    const added = Math.max(Date.now(), (this.s.db.prepare("SELECT max(added) AS added FROM video_downloads").get().added || 0) + 1);
    if (known && replace && (known.state === "done" || known.previous)) {
      const previous = known.previous || (this.missing(known) ? null : JSON.stringify({ hash: known.hash, size: known.size, item: json(known.item, null), show: json(known.show, null) }));
      if (known.hash !== item.hash) fs.rmSync(this.where(known, ".part"), { force: true });
      this.update(known, { state: "queued", error: null, hash: item.hash, size: Number(item.size) || 0, item: JSON.stringify(item), show: show ? JSON.stringify(show) : null, added, previous });
      return true;
    }
    if (known) this.discard(known);
    const file = digest(`${this.hub}\0${volume}\0${item.path}`).slice(0, 32) + extension(item.path);
    this.s.db
      .prepare("INSERT INTO video_downloads(hub,volume,path,hash,size,state,file,item,show,added,kind) VALUES(?,?,?,?,?,'queued',?,?,?,?,?)")
      .run(this.hub, volume, item.path, item.hash, Number(item.size) || 0, file, JSON.stringify(item), show ? JSON.stringify(show) : null, added, kind);
    return true;
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
  unmark(row) {
    this.s.db.prepare("DELETE FROM video_keep_missing WHERE hub=? AND volume=? AND path=?").run(row.hub, row.volume, row.path);
  }
  discard(row) {
    this.unmark(row);
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
      this.unmark(row);
      if (this.isCurrent(row)) this.current.controller.abort();
      else
        try {
          this.erase(row);
        } catch {}
    }
  }
  pruneLibrary(volume, library) {
    if (!this.hub || typeof volume !== "string" || !complete(library) || this.s.mediaMode(volume) === "keep") return;
    this.forget(this.rows(volume).filter((row) => row.kind !== "music" && !fileOf(library, row.path)));
  }
  pruneMusic(volume, library) {
    if (!this.hub || typeof volume !== "string" || !complete(library)) return;
    this.forget(this.rows(volume).filter((row) => row.kind === "music" && !trackOf(library, row.path)));
  }
  pruneCatalog(volumes) {
    if (!this.hub || !Array.isArray(volumes) || !volumes.length) return;
    const kinds = { video: new Set(volumes.filter((v) => v?.video).map((v) => v.id)), music: new Set(volumes.filter((v) => v?.music).map((v) => v.id)) };
    this.forget(this.s.db.prepare("SELECT * FROM video_downloads WHERE hub=?").all(this.hub).filter((row) => !kinds[row.kind === "music" ? "music" : "video"].has(row.volume)));
    for (const { volume } of this.s.db.prepare("SELECT DISTINCT volume FROM video_keep_missing WHERE hub=?").all(this.hub))
      if (!kinds.video.has(volume)) this.s.db.prepare("DELETE FROM video_keep_missing WHERE hub=? AND volume=?").run(this.hub, volume);
    for (const [volume, mode] of Object.entries(this.s.mediaModes()))
      if (!kinds.video.has(volume) && !(mode === "stream" && kinds.music.has(volume))) this.s.db.prepare("DELETE FROM media_modes WHERE volume=?").run(volume);
  }
  forgetVolume(volume, kind = null) {
    const rows = this.rows(volume).filter((row) => !kind || (row.kind === "music") === (kind === "music"));
    const held = rows.map((row) => (row.state === "done" ? row.size : row.previous ? json(row.previous, {}).size || 0 : null)).filter((size) => size !== null);
    this.forget(rows);
    this.s.db.prepare("DELETE FROM video_keep_missing WHERE hub=? AND volume=?").run(this.hub, volume);
    return { deleted: held.length, deletedBytes: held.reduce((total, size) => total + size, 0) };
  }
  floor() {
    try {
      const space = this.space(this.s.home);
      const floor = Number(space.bavail) * Number(space.bsize) - Math.max(FLOOR_BYTES, FLOOR_SHARE * Number(space.blocks) * Number(space.bsize));
      return Number.isFinite(floor) ? floor : null;
    } catch {
      return null;
    }
  }
  reconcile(volume, library) {
    if (!this.hub || this.engine.config.installation !== "desktop" || this.s.mediaMode(volume) !== "keep" || !complete(library)) return;
    this.keptAt.set(volume, Date.now());
    const missing = this.s.db.prepare("SELECT at FROM video_keep_missing WHERE hub=? AND volume=? AND path=?");
    const clear = this.s.db.prepare("DELETE FROM video_keep_missing WHERE hub=? AND volume=? AND path=?");
    for (const row of this.rows(volume)) {
      if (fileOf(library, row.path)) {
        clear.run(this.hub, volume, row.path);
        continue;
      }
      const since = missing.get(this.hub, volume, row.path)?.at;
      if (since === undefined) this.s.db.prepare("INSERT INTO video_keep_missing(hub,volume,path,at) VALUES(?,?,?,?)").run(this.hub, volume, row.path, Date.now());
      else if (Date.now() - since >= KEEP_GONE_MS) {
        this.forget([row]);
        clear.run(this.hub, volume, row.path);
      }
    }
    let budget = this.floor();
    if (budget === null) return;
    for (const row of this.s.db.prepare("SELECT * FROM video_downloads WHERE hub=? AND state IN ('queued','downloading')").all(this.hub))
      budget -= Math.max(0, row.size - this.progress(row));
    let queued = false;
    for (const item of keptTitles(library)) {
      const known = this.row(volume, item.path);
      if (known && (ACTIVE.includes(known.state) || (known.state === "failed" && known.hash === item.hash && known.error !== MISSING) || (known.state === "done" && known.hash === item.hash && !this.missing(known)))) continue;
      const size = Number(item.size) || 0;
      if (size > budget) break;
      if (this.enqueue(volume, item, "video", this.showOf(library, item), true)) {
        budget -= size;
        queued = true;
      }
    }
    if (queued) void this.wake();
  }
  async readKept(stop) {
    if (this.engine.config.installation !== "desktop") return;
    for (const [volume, mode] of Object.entries(this.s.mediaModes())) {
      if (mode !== "keep" || stop.aborted || Date.now() - (this.keptAt.get(volume) || 0) < this.keepEvery) continue;
      this.keptAt.set(volume, Date.now());
      try {
        await replicaLibrary({ engine: this.engine, s: this.s }, volume, null, stop);
      } catch {}
    }
  }
  pruneHubs() {
    if (!this.hub) return;
    this.forget(this.s.db.prepare("SELECT * FROM video_downloads WHERE hub<>?").all(this.hub));
    this.s.db.prepare("DELETE FROM video_keep_missing WHERE hub<>?").run(this.hub);
  }
  erase(row) {
    const folder = this.folder(row);
    if (!fs.existsSync(folder)) return;
    const prefix = row.file.slice(0, 32);
    for (const name of fs.readdirSync(folder)) if (name.startsWith(prefix)) fs.rmSync(path.join(folder, name), { force: true });
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
    const kept = new Set(this.s.db.prepare("SELECT file FROM video_downloads").all().map((row) => row.file.slice(0, 32)));
    for (const folder of [this.dir, this.musicDir]) {
      if (!fs.existsSync(folder)) continue;
      for (const name of fs.readdirSync(folder))
        if (!kept.has(name.slice(0, 32)))
          try {
            fs.rmSync(path.join(folder, name), { force: true });
          } catch {}
    }
  }
  async run() {
    this.sweep();
    await this.readKept(this.stopping.signal);
    const busy = new Set();
    while (!this.closed && !this.halting) {
      const row = this.s.db
        .prepare(`SELECT * FROM video_downloads WHERE hub=? AND state IN ('queued','downloading') ORDER BY added,path`)
        .all(this.hub)
        .find((entry) => !busy.has(`${entry.volume}\0${entry.path}`));
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
        if (error.message === BUSY) {
          this.update(row, { state: "queued", error: BUSY });
          busy.add(`${row.volume}\0${row.path}`);
          continue;
        }
        if (error.status === 503) {
          this.update(row, { state: "queued", error: error.message || offline(row.kind).message });
          return;
        }
        if (error.message === GONE) {
          this.forget([row]);
          continue;
        }
        this.update(row, { state: "failed", error: worded(row, error.code === "ENOSPC" ? NO_SPACE : error.message || "This video could not be downloaded") });
      } finally {
        this.current = null;
      }
    }
  }
  async identity(row, file) {
    if (fs.statSync(file, { throwIfNoEntry: false })?.size !== row.size) return null;
    return row.kind === "music" ? hashFileAsync(file) : quickHashFile(file);
  }
  async download(row, signal) {
    const library = await this.libraryOf(row, signal);
    const item = this.itemOf(row, library);
    if (!item) fail(GONE, 404);
    if (signal.aborted) throw signal.reason;
    const show = row.kind === "music" ? null : this.showOf(library, item);
    if (item.hash !== row.hash || Number(item.size) !== row.size) {
      fs.rmSync(this.where(row, ".part"), { force: true });
      this.update(row, { hash: item.hash, size: Number(item.size) || 0, ...(row.previous ? {} : { subtitles: "[]", art: "{}" }) });
      this.current.done = 0;
    }
    this.update(row, { state: "downloading", error: null, item: JSON.stringify(item), show: show ? JSON.stringify(show) : null });
    fs.mkdirSync(this.folder(row), { recursive: true });
    const file = this.where(row);
    const part = this.where(row, ".part");
    if ((await this.identity(row, file)) !== row.hash) {
      try {
        await this.fetchMedia(row, part, signal);
      } catch (error) {
        if (signal.aborted || !error.stale) throw error;
        return this.restart(row, signal, error.status === 409 ? UPDATING : UNSENT);
      }
      if ((await this.identity(row, part)) !== row.hash) {
        fs.rmSync(part, { force: true });
        return this.restart(row, signal, MISMATCH);
      }
      try {
        fs.renameSync(part, file);
      } catch (error) {
        if (this.platform !== "win32" || !["EPERM", "EBUSY"].includes(error.code)) throw error;
        throw new Error(BUSY);
      }
    }
    if (row.previous) this.update(row, { previous: null });
    const subtitles = row.kind === "music" ? [] : await this.subtitles(row, item, signal);
    const art = row.kind === "music" ? await this.covers(row, item, signal) : await this.art(row, item, show, signal);
    if (signal.aborted) throw signal.reason;
    this.update(row, { state: "done", error: null, subtitles: JSON.stringify(subtitles), art: JSON.stringify(art) });
  }
  async restart(row, signal, message) {
    const item = this.itemOf(row, await this.libraryOf(row, signal));
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
      if (!hub || this.engine.hubUnavailable) throw offline(row.kind);
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
          response = await fetch(`${hub.url}/v1/${row.kind === "music" ? "music" : "video"}/media?${new URLSearchParams({ volume: row.volume, path: row.path, hash: row.hash })}`, {
            redirect: "error",
            headers: { Authorization: `Bearer ${hub.token}`, Range: `bytes=${done}-${Math.min(row.size, done + this.chunk) - 1}` },
            signal: chunkSignal,
          });
        } catch (error) {
          if (signal.aborted) throw error;
          throw offline(row.kind);
        }
        const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get("content-range") || "");
        if (response.status !== 206 || !range || Number(range[1]) !== done || Number(range[3]) !== row.size) {
          await response.body?.cancel().catch(() => {});
          if ([502, 503, 504].includes(response.status)) throw offline(row.kind);
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
          throw offline(row.kind);
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
  async covers(row, item, signal) {
    const saved = {};
    if (typeof item.cover !== "string" || !item.cover) return saved;
    for (const size of ["small", "large"]) {
      let answer;
      try {
        answer = await forward(this.engine, `/v1/music/cover?${new URLSearchParams({ volume: row.volume, key: item.cover, size })}`, undefined, undefined, signal);
      } catch (error) {
        if (signal.aborted || error.status === 503) throw offline("music");
        continue;
      }
      if (signal.aborted) throw signal.reason;
      if (typeof answer?.data !== "string") continue;
      const file = `${row.file}.c-${size}.json`;
      fs.writeFileSync(path.join(this.musicDir, file), JSON.stringify({ data: answer.data }));
      saved[`${size}:${item.cover}`] = file;
    }
    return saved;
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
  standIn(volume, name) {
    if (typeof volume !== "string" || typeof name !== "string") return null;
    const row = this.row(volume, name);
    const previous = row?.previous ? json(row.previous, null) : null;
    if (!previous?.item || fs.statSync(this.where(row), { throwIfNoEntry: false })?.size !== previous.size) return null;
    return { file: this.where(row), size: previous.size, type: videoType(name) || "video/mp4", item: previous.item };
  }
  local(volume, name, hash) {
    if (typeof volume !== "string" || typeof name !== "string") return null;
    const row = this.row(volume, name);
    const previous = row?.previous ? json(row.previous, null) : null;
    if (previous?.item && previous.hash === hash && row.hash !== hash && fs.statSync(this.where(row), { throwIfNoEntry: false })?.size === previous.size)
      return { file: this.where(row), size: previous.size, type: videoType(name) || "video/mp4", item: previous.item };
    if (!row || row.state !== "done" || row.hash !== hash || this.missing(row)) return null;
    const file = this.where(row);
    if (row.kind === "music") return { file, size: row.size, type: audioType(name) || "application/octet-stream" };
    return { file, size: row.size, type: videoType(name) || "video/mp4", item: json(row.item, null) };
  }
  subtitle(volume, name, embedded) {
    if (typeof volume !== "string" || typeof name !== "string") return null;
    for (const row of this.rows(volume)) {
      const previous = row.previous ? json(row.previous, null) : null;
      if ((row.state !== "done" && !previous) || (embedded && (row.path !== name || (row.hash !== embedded.hash && previous?.hash !== embedded.hash)))) continue;
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
  coverData(volume, key, size) {
    return this.artData(volume, key, size);
  }
  artData(volume, key, size) {
    if (typeof volume !== "string" || typeof key !== "string") return null;
    for (const row of this.rows(volume)) {
      const file = (row.state === "done" || row.previous) && json(row.art, {})[`${size}:${key}`];
      if (!file) continue;
      let data;
      try {
        data = JSON.parse(fs.readFileSync(path.join(this.folder(row), file), "utf8")).data;
      } catch {}
      if (typeof data === "string") return data;
    }
    return null;
  }
  offlineMusic(volume) {
    const rows = this.rows(volume).filter((row) => row.kind === "music" && row.state === "done");
    if (!rows.length) return null;
    return {
      version: `downloads-${digest(rows.map((row) => `${row.path}:${row.hash}`).join("\n")).slice(0, 16)}`,
      indexing: false,
      tracks: rows.map((row) => json(row.item, null)).filter((item) => item?.path).sort((a, b) => (a.path < b.path ? -1 : 1)),
      playlists: [],
      offline: true,
    };
  }
  offlineLibrary(volume) {
    const rows = this.rows(volume)
      .filter((row) => row.kind !== "music" && (row.state === "done" || row.previous))
      .map((row) => (row.state === "done" ? row : { ...row, item: JSON.stringify(json(row.previous, {}).item), show: JSON.stringify(json(row.previous, {}).show) }));
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
