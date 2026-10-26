import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { isHubUnreachable } from "../../desktop/src/notice-contract.js";
import { parseCues } from "./subtitles.js";
import { audioTrackOf, needsCompatible } from "./video-compatible.js";
import { mediaRoute } from "./video-library.js";
import { isVideoFolder, refreshVideoLibrary, subtitleText } from "./video-sync.js";

export const DOWNLOAD_CHUNK = 1024 * 1024;
export const QUICK_PART = 4 * 1024 * 1024;
export const SPACE_MARGIN = 512 * 1024 * 1024;
export const DOWNLOAD_NOTE = "Downloads stay in the app until you remove them.";
export const OFFLINE_DOWNLOADS = "Offline · showing your downloads";
export const HUB_AWAY = "Waiting for your hub.";
export const NO_SPACE = "Not enough free space on this phone for this download.";
export const MISMATCH = "The download did not match the hub’s copy. Download it again.";
export const HUB_SYNCING = "Waiting for the hub to finish syncing this video.";
export const NOT_DOWNLOADABLE = "This file needs the hub to play, so it can’t be downloaded to this phone.";
export const RETRY_LATER = 60 * 1000;
const IOS_CONTAINERS = new Set(["mp4", "m4v", "mov"]);
const ACTIVE = new Set(["queued", "waiting"]);

const encoder = new TextEncoder();
const blockTimeout = (length) => 15000 + Math.ceil(length / 32768) * 1000;
export const downloadKey = (volume, path) => `${volume}\n${path}`;
const extension = (path) => {
  const match = /\.([a-z0-9]{1,5})$/i.exec(path || "");
  return match ? match[1].toLowerCase() : "mp4";
};
const waiting = (message) => Object.assign(new Error(message), { downloadWait: true });
const failure = (message) => Object.assign(new Error(message), { downloadFailed: true });

export async function quickHash(read, size) {
  const digest = sha256.create();
  digest.update(encoder.encode(`arca-quick-1\0${size}\0`));
  const head = Math.min(size, QUICK_PART);
  if (head) digest.update(await read(0, head));
  if (size > QUICK_PART) {
    const tail = Math.min(QUICK_PART, size - QUICK_PART);
    digest.update(await read(size - tail, tail));
  }
  return bytesToHex(digest.digest());
}

export function downloadSubtitles(item) {
  return (item.subtitles || [])
    .filter((sub) => typeof sub.path === "string" || (sub.embedded && !sub.image && Number.isSafeInteger(sub.stream)))
    .map((sub) => (sub.embedded ? `stream:${sub.stream}` : sub.path));
}

export function downloadFraction(row) {
  if (!row) return 0;
  if (row.state === "done") return 1;
  return row.size > 0 ? Math.min(1, row.done / row.size) : 0;
}

export function downloadLabel(row) {
  const percent = `${Math.floor(downloadFraction(row) * 100)}%`;
  if (!row) return "Download";
  if (row.state === "done") return "Downloaded";
  if (row.state === "failed" || row.state === "stale") return "Download again";
  if (row.state === "waiting") return `Waiting for hub · ${percent}`;
  return `Downloading · ${percent}`;
}

export function downloadable(item, platform) {
  if (!item?.path || item.kind === "show") return false;
  return platform !== "ios" || IOS_CONTAINERS.has(extension(item.path));
}

const CODEC_NAMES = { ac3: "AC3", eac3: "E-AC3", dts: "DTS", dca: "DTS", truehd: "TrueHD", mlp: "TrueHD" };

export function downloadBlock(item, platform) {
  if (!item?.path || item.kind === "show") return "";
  if (platform === "ios" && !IOS_CONTAINERS.has(extension(item.path))) return `${extension(item.path).toUpperCase()} files can’t play from a copy on this iPhone. Streaming works.`;
  return "";
}

export function downloadCaution(item) {
  const codec = CODEC_NAMES[String(audioTrackOf(item)?.codec || "").toLowerCase()];
  return codec ? `${codec} audio: with the hub away, the copy plays only if this phone can decode it.` : "";
}

export function downloadTile(row, allowed) {
  if (isDownloading(row)) return { label: row.state === "waiting" ? "Waiting" : `${Math.floor(downloadFraction(row) * 100)}%`, icon: "download", action: "cancel", ring: true };
  if (row?.state === "done") return { label: "Downloaded", icon: "check-circle", action: "manage" };
  if (row?.state === "failed") return { label: "Try again", icon: "download", action: "start" };
  if (row?.state === "stale") return { label: "Download again", icon: "download", action: "start" };
  if (!allowed) return { label: "Stream only", icon: "download", action: "none", disabled: true };
  return { label: "Download", icon: "download", action: "start" };
}

export function downloadNote(row, allowed, item, platform) {
  if (row?.state === "failed") return row.error || "";
  if (isDownloading(row)) return DOWNLOAD_NOTE;
  if (!allowed && !row) return downloadBlock(item, platform) || NOT_DOWNLOADABLE;
  return downloadCaution(item);
}

export const DOWNLOAD_NAME = /^[a-f0-9]{64}(?:\.[a-z0-9]{1,5}|\.sub\.txt)$/;

export function subtitleFile(row, key) {
  return `${bytesToHex(sha256(encoder.encode(`${row.path}\0${row.hash}\0${key}`)))}.sub.txt`;
}

export function itemDownload(row, item) {
  return row && item?.hash && row.state === "done" && row.hash !== item.hash ? { ...row, state: "stale" } : row || null;
}

export const isDownloading = (row) => !!row && ACTIVE.has(row.state);

export function createVideoDownloads({ replica, client, onChange = () => {}, chunk = DOWNLOAD_CHUNK, refresh = null, pause = null, retryDelay = RETRY_LATER, since = Date.now() }) {
  const store = replica.store;
  const files = replica.files;
  const scope = replica.scope;
  const rows = new Map();
  let running = null;
  let stopped = false;
  let loaded = null;
  let retry = null;
  const emit = () => onChange(new Map(rows));
  const uri = (row, name) => files.videoDownload(scope, row.volume, name);
  const mediaName = (row) => `${row.hash}.${row.ext}`;
  const cancelled = () => Object.assign(new Error("Download cancelled"), { code: "REQUEST_CANCELLED" });
  const sleeper = (signal) => (ms) =>
    pause
      ? pause(ms)
      : new Promise((resolve) => {
          const timer = setTimeout(resolve, ms);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
          }, { once: true });
        });
  async function save(row, quiet = false, signal = null, fresh = false) {
    if (stopped) throw cancelled();
    if (signal?.aborted) throw signal.reason || cancelled();
    if (!fresh && !rows.has(downloadKey(row.volume, row.path))) throw cancelled();
    rows.set(downloadKey(row.volume, row.path), row);
    await store.saveVideoDownload(scope, row);
    if (!quiet) emit();
    return row;
  }
  async function discard(row) {
    for (const key of row.subtitles) await files.remove(uri(row, subtitleFile(row, key)));
    if ([...rows.values()].some((other) => other.volume === row.volume && other.hash === row.hash && other.path !== row.path)) return;
    await files.remove(`${uri(row, mediaName(row))}.part`);
    await files.remove(uri(row, mediaName(row)));
  }
  async function gate() {
    if (!client.state().connection?.linked) throw waiting(HUB_AWAY);
  }
  async function drop(row) {
    rows.delete(downloadKey(row.volume, row.path));
    emit();
    await store.forgetVideoDownload(scope, row.volume, row.path);
    await discard(row);
    if (row.replaces) await discard({ ...row, ...row.replaces });
  }
  async function current(volume, path) {
    if (refresh) return refresh(volume, path);
    const { library } = await refreshVideoLibrary({ scope, store, client }, volume);
    return [...library.items.values()].find((item) => item.kind !== "show" && item.path === path) || null;
  }
  async function changed(row, error, signal) {
    const item = await current(row.volume, row.path);
    if (item && item.hash === row.hash) throw error?.status === 409 ? waiting(HUB_SYNCING) : error;
    if (!item) {
      await drop(row);
      throw cancelled();
    }
    await discard(row);
    return save({ ...row, id: item.id, hash: item.hash, size: item.size, ext: extension(item.path), subtitles: downloadSubtitles(item), saved: [], done: 0, error: "" }, false, signal);
  }
  async function fetchCopy(start, signal, retried) {
    let row = start;
    const target = uri(row, mediaName(row));
    await files.mkdir(files.parent(target));
    if (await files.exists(target)) return { row };
    const partial = `${target}.part`;
    let offset = (await files.stat(partial))?.size || 0;
    if (offset > row.size) {
      await files.remove(partial);
      offset = 0;
    }
    if (offset !== row.done) row = await save({ ...row, done: offset }, false, signal);
    const free = await files.free();
    if (Number.isFinite(free) && free < row.size - offset + SPACE_MARGIN) throw failure(NO_SPACE);
    if (!(await files.exists(partial))) await files.write(partial, new Uint8Array());
    while (offset < row.size) {
      if (signal.aborted) throw signal.reason || cancelled();
      await gate();
      const end = Math.min(offset + chunk, row.size) - 1;
      const range = `bytes ${offset}-${end}/${row.size}`;
      let response;
      try {
        response = await client.raw(mediaRoute(row.volume, row), {
          signal,
          timeout: blockTimeout(end - offset + 1),
          headers: { Range: `bytes=${offset}-${end}` },
          ...(client.fileTransfers ? { transfer: { destination: partial, offset: String(offset), length: String(end - offset + 1), range } } : {}),
        });
      } catch (error) {
        if (retried || ![404, 409].includes(error?.status)) throw error;
        return { row: await changed(row, error, signal), restart: true };
      }
      if (response.status !== 206 || response.headers.get("content-range") !== range) {
        const error = new Error("The hub did not return the requested part of this video.");
        if (retried) throw error;
        return { row: await changed(row, error, signal), restart: true };
      }
      const data = client.fileTransfers ? null : new Uint8Array(await response.arrayBuffer());
      if ((data?.length ?? response.bytesWritten) !== end - offset + 1) throw new Error("The hub sent an incomplete part of this video.");
      if (data) await files.write(partial, data, offset);
      const before = Math.floor((offset / row.size) * 100);
      offset = end + 1;
      row = await save({ ...row, done: offset }, Math.floor((offset / row.size) * 100) === before, signal);
    }
    if ((await files.stat(partial))?.size !== row.size) throw new Error("The download is incomplete. It resumes on Wi-Fi.");
    if ((await quickHash((at, length) => files.read(partial, at, length), row.size)) !== row.hash) {
      await files.remove(partial);
      throw failure(MISMATCH);
    }
    await files.move(partial, target);
    return { row };
  }
  async function fetchMedia(start, signal) {
    let outcome = await fetchCopy(start, signal, false);
    if (outcome.restart) outcome = await fetchCopy(outcome.row, signal, true);
    return outcome.row;
  }
  async function fetchSubtitles(start, signal) {
    let row = start;
    for (const key of row.subtitles) {
      if (row.saved.includes(key)) continue;
      if (signal.aborted) throw signal.reason || cancelled();
      await gate();
      let text;
      try {
        text = await subtitleText({ client, volume: row.volume, path: key, item: row, signal, pause: sleeper(signal) });
      } catch (error) {
        if (signal.aborted) throw signal.reason || cancelled();
        if (isHubUnreachable(error)) throw error;
        continue;
      }
      const file = uri(row, subtitleFile(row, key));
      await files.remove(file);
      await files.write(file, encoder.encode(text));
      row = await save({ ...row, saved: [...row.saved, key] }, true, signal);
    }
    return row;
  }
  async function work(start, signal) {
    let row = await save({ ...start, state: "queued", error: "" }, false, signal);
    await gate();
    row = await fetchMedia(row, signal);
    row = await fetchSubtitles(row, signal);
    const { replaces, ...finished } = row;
    await save({ ...finished, done: row.size, state: "done", error: "" }, false, signal);
    if (replaces) await discard({ ...finished, ...replaces });
  }
  function later() {
    if (retry || stopped) return;
    retry = setTimeout(() => {
      retry = null;
      manager.resume().catch(() => {});
    }, retryDelay);
  }
  function pump() {
    if (running || stopped) return;
    const next = [...rows.values()].filter((row) => row.state === "queued").sort((a, b) => a.added - b.added)[0];
    if (!next) return;
    const key = downloadKey(next.volume, next.path);
    const controller = new AbortController();
    running = { key, controller, promise: null };
    running.promise = work(next, controller.signal)
      .catch(async (error) => {
        const row = rows.get(key);
        if (controller.signal.aborted || stopped || !row) return;
        if (error?.downloadWait || isHubUnreachable(error) || error?.code === "HUB_TIMEOUT") {
          await save({ ...row, state: "waiting", error: error?.downloadWait ? error.message : HUB_AWAY });
          if (error?.message === HUB_SYNCING) later();
        } else await save({ ...row, state: "failed", error: error?.message || "This download failed." });
      })
      .catch(() => {})
      .finally(() => {
        running = null;
        pump();
      });
  }
  const manager = {
    async load() {
      loaded ||= (async () => {
        const foreign = await store.foreignVideoDownloads(scope).catch(() => []);
        for (const { scope: other, row } of foreign) {
          const media = `${row.hash}.${row.ext}`;
          const targets = [[media, ".part"], [media, ""], ...(row.subtitles || []).map((key) => [subtitleFile(row, key), ""])];
          for (const [name, suffix] of targets)
            try {
              await files.remove(files.videoDownload(other, row.volume, name) + suffix);
            } catch {
              continue;
            }
          await store.forgetVideoDownload(other, row.volume, row.path).catch(() => {});
        }
        for (const row of await store.videoDownloads(scope)) rows.set(downloadKey(row.volume, row.path), row);
        emit();
      })();
      await loaded;
      pump();
    },
    snapshot: () => new Map(rows),
    async prune(volume, library) {
      await this.load();
      if (!library?.items || library.indexing || !(library.movies.length || library.shows.length || library.other.length)) return;
      const paths = new Set([...library.items.values()].filter((item) => item.kind !== "show").map((item) => item.path));
      for (const row of [...rows.values()]) if (row.volume === volume && !paths.has(row.path)) await this.remove(volume, row.path);
    },
    async pruneVolumes(catalog) {
      await this.load();
      if (!Array.isArray(catalog?.volumes) || !catalog.volumes.length || !(catalog.fetchedAt > since)) return;
      for (const row of [...rows.values()]) if (!isVideoFolder(catalog, row.volume)) await this.remove(row.volume, row.path);
    },
    get(volume, path) {
      return rows.get(downloadKey(volume, path)) || null;
    },
    async add(volume, items) {
      await this.load();
      for (const item of items) {
        const old = rows.get(downloadKey(volume, item.path));
        if (old && old.state !== "failed" && old.hash === item.hash) continue;
        if (old && running?.key === downloadKey(volume, item.path)) continue;
        const replaces = old?.state === "done" && old.hash !== item.hash ? { hash: old.hash, ext: old.ext, subtitles: old.subtitles } : old?.replaces;
        await save({
          volume,
          path: item.path,
          id: item.id,
          hash: item.hash,
          size: item.size,
          ext: extension(item.path),
          subtitles: downloadSubtitles(item),
          saved: [],
          done: 0,
          state: "queued",
          error: "",
          added: Date.now(),
          ...(replaces ? { replaces } : {}),
        }, false, null, true);
      }
      pump();
    },
    async resume() {
      await this.load();
      if (stopped) return;
      for (const row of rows.values()) if (row.state === "waiting") await save({ ...row, state: "queued" }, true);
      emit();
      pump();
    },
    async remove(volume, path) {
      await this.load();
      const key = downloadKey(volume, path);
      const row = rows.get(key);
      if (!row) return;
      rows.delete(key);
      const active = running?.key === key ? running : null;
      active?.controller.abort(cancelled());
      emit();
      await store.forgetVideoDownload(scope, volume, path);
      await active?.promise;
      await discard(row);
      if (row.replaces) await discard({ ...row, ...row.replaces });
      pump();
    },
    localSource(volume, item) {
      const row = rows.get(downloadKey(volume, item?.path));
      if (row?.state !== "done" || row.hash !== item.hash) return null;
      const target = uri(row, mediaName(row));
      if (files.present && !files.present(target)) return null;
      return { uri: target, local: true, lan: false, offset: 0 };
    },
    async localCues(volume, item, key) {
      const row = rows.get(downloadKey(volume, item?.path));
      if (row?.state !== "done" || row.hash !== item.hash || !row.saved.includes(key)) return null;
      return files.text(uri(row, subtitleFile(row, key)));
    },
    async stop() {
      stopped = true;
      clearTimeout(retry);
      retry = null;
      const active = running;
      active?.controller.abort(cancelled());
      await active?.promise;
    },
  };
  return manager;
}

export async function playbackSource({ downloads, volume, item, mode = "auto", audio = null, stream }) {
  const local = mode !== "compatible" && downloads?.localSource(volume, item);
  if (!local) return stream();
  if (!needsCompatible(item, audio)) return local;
  return stream().catch(() => local);
}

export async function playbackCues({ downloads, volume, item, key, load }) {
  const text = await downloads?.localCues(volume, item, key).catch(() => null);
  return typeof text === "string" ? parseCues(text) : load();
}
