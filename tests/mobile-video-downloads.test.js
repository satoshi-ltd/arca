import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ReplicaStore } from "../apps/mobile/src/replica-store.js";
import { HubError } from "../apps/mobile/src/client.js";
import {
  DOWNLOAD_NAME,
  DOWNLOAD_NOTE,
  NOT_DOWNLOADABLE,
  downloadBlock,
  downloadCaution,
  downloadChip,
  downloadAction,
  downloadNote,
  downloadTile,
  HUB_AWAY,
  itemDownload,
  HUB_SYNCING,
  MISMATCH,
  NO_SPACE,
  downloadable,
  subtitleFile,
  createVideoDownloads,
  downloadLabel,
  downloadSubtitles,
  playbackCues,
  playbackSource,
  quickHash,
} from "../apps/mobile/src/video-downloads.js";
import { cachedVideoLibrary, createArtLoader, flushPositions, refreshVideoLibrary, sendPosition, withQueuedPositions } from "../apps/mobile/src/video-sync.js";
import { downloadTargets, downloadedTitles, normalizeLibrary, titleActions, videoShelves } from "../apps/mobile/src/video-library.js";
import { quickHashFile } from "../packages/daemon/storage.js";
import { Replica } from "../apps/mobile/src/replica.js";

const MIB = 1024 * 1024;

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arca-downloads-"));
  const db = new DatabaseSync(path.join(root, "replica.sqlite"));
  t.after(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const store = new ReplicaStore({
    execAsync: async (sql) => db.exec(sql),
    runAsync: async (sql, ...args) => db.prepare(sql).run(...args),
    getFirstAsync: async (sql, ...args) => db.prepare(sql).get(...args) ?? null,
    getAllAsync: async (sql, ...args) => db.prepare(sql).all(...args),
  });
  const storage = path.join(root, "files");
  const files = {
    videoDownload(scope, volume, name) {
      if (!DOWNLOAD_NAME.test(name)) throw new Error("Invalid download");
      return path.join(storage, scope, "video-downloads", volume, name);
    },
    parent: (uri) => path.dirname(uri),
    mkdir: async (uri) => fs.mkdirSync(uri, { recursive: true }),
    exists: async (uri) => fs.existsSync(uri),
    present: (uri) => fs.existsSync(uri),
    stat: async (uri) => (fs.existsSync(uri) ? { size: fs.statSync(uri).size } : null),
    free: async () => 64 * 1024 * MIB,
    async write(uri, data, offset = 0) {
      fs.mkdirSync(path.dirname(uri), { recursive: true });
      const fd = fs.openSync(uri, fs.existsSync(uri) ? "r+" : "w+");
      try {
        fs.writeSync(fd, data, 0, data.length, offset);
      } finally {
        fs.closeSync(fd);
      }
    },
    async read(uri, offset, length) {
      const buffer = Buffer.alloc(length);
      const fd = fs.openSync(uri, "r");
      try {
        fs.readSync(fd, buffer, 0, length, offset);
      } finally {
        fs.closeSync(fd);
      }
      return new Uint8Array(buffer);
    },
    remove: async (uri) => fs.rmSync(uri, { force: true }),
    async move(from, to) {
      if (fs.existsSync(to)) throw new Error("Destination already exists");
      fs.renameSync(from, to);
    },
    text: async (uri) => fs.readFileSync(uri, "utf8"),
    hash: async (uri) => crypto.createHash("sha256").update(fs.readFileSync(uri)).digest("hex"),
  };
  return { root, store, files, storage };
}

function quick(buffer) {
  const file = path.join(os.tmpdir(), `arca-quick-${process.pid}-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(file, buffer);
  try {
    return quickHashFile(file);
  } finally {
    fs.rmSync(file, { force: true });
  }
}

function media(size, seed = 1) {
  const buffer = Buffer.alloc(size);
  for (let i = 0; i < size; i++) buffer[i] = (i * 31 + seed * 7) & 255;
  return buffer;
}

function hub({ content, hash, item }) {
  const state = { content, hash, item, ranges: [], fail: null, linked: true, preparing: 1, subtitleCalls: [] };
  const client = {
    fileTransfers: false,
    state: () => ({ connection: state.linked ? { linked: true, url: "https://hub.example" } : null }),
    async raw(route, options) {
      const query = new URLSearchParams(route.split("?")[1]);
      const [, from, to] = /bytes=(\d+)-(\d+)/.exec(options.headers.Range).map(Number);
      state.ranges.push([from, query.get("hash")]);
      if (state.fail && state.fail(from)) throw new Error("Network request failed");
      if (query.get("hash") !== state.hash) throw new HubError("This video is no longer available", 404);
      const body = state.content.subarray(from, to + 1);
      return {
        status: 206,
        headers: { get: (name) => (name === "content-range" ? `bytes ${from}-${to}/${state.content.length}` : null) },
        arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
      };
    },
    async api(route) {
      if (route.startsWith("/v1/video/library"))
        return { version: String(Math.random()), movies: state.item ? [state.item] : [], shows: [], other: [], continue: [], nextUp: [] };
      if (route.startsWith("/v1/video/subtitles")) {
        const query = new URLSearchParams(route.split("?")[1]);
        state.subtitleCalls.push(query.get("stream") ?? query.get("path"));
        if (query.get("stream") && state.preparing-- > 0) return { preparing: true };
        return { text: `1\n00:00:01,000 --> 00:00:02,000\n${query.get("stream") ? "Embedded" : "Sidecar"} line\n` };
      }
      throw new Error(`unexpected ${route}`);
    },
  };
  return { state, client };
}

const movie = (content, hash, extra = {}) => ({
  id: "m:1",
  kind: "movie",
  title: "Inception",
  path: "Movies/Inception (2010).mkv",
  hash,
  size: content.length,
  duration: 100,
  subtitles: [
    { path: "Movies/Inception (2010).en.srt", language: "en", label: "English" },
    { embedded: true, stream: 2, language: "es", label: "Spanish" },
    { embedded: true, stream: 3, language: "en", label: "PGS", image: true },
  ],
  ...extra,
});

const settled = async (downloads, volume, itemPath) => {
  for (let i = 0; i < 500; i++) {
    const row = downloads.get(volume, itemPath);
    if (row && !["queued"].includes(row.state)) return row;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("download did not settle");
};

test("the phone checks a download with the hub's quick identity, byte for byte", async () => {
  for (const size of [0, 1000, 4 * MIB, 4 * MIB + 3, 9 * MIB + 17]) {
    const content = media(size, size);
    const read = async (at, length) => new Uint8Array(content.subarray(at, at + length));
    assert.equal(await quickHash(read, size), quick(content), `size ${size}`);
  }
});

test("an interrupted download resumes from its partial file after a restart, then saves every readable subtitle", async (t) => {
  const { store, files } = setup(t);
  await store.init();
  const content = media(9 * MIB + 5);
  const hash = quick(content);
  const item = movie(content, hash);
  const { state, client } = hub({ content, hash, item });
  const replica = { scope: "hub-a", store, files };
  const wifi = async () => ({ type: "WIFI" });
  state.fail = (from) => from >= 3 * MIB;
  const first = createVideoDownloads({ replica, client, networkType: wifi, chunk: MIB, pause: async () => {} });
  await first.add("v1", [item]);
  const stalled = await settled(first, "v1", item.path);
  assert.equal(stalled.state, "waiting", "a dropped connection waits instead of failing");
  assert.equal(stalled.done, 3 * MIB);
  const partial = files.videoDownload("hub-a", "v1", `${hash}.mkv`) + ".part";
  assert.equal(fs.statSync(partial).size, 3 * MIB, "the bytes already fetched stay on disk");
  first.stop();

  state.fail = null;
  state.ranges.length = 0;
  const changes = [];
  const second = createVideoDownloads({ replica, client, networkType: wifi, chunk: MIB, pause: async () => {}, onChange: (rows) => changes.push(rows) });
  await second.load();
  assert.equal(second.get("v1", item.path).state, "waiting", "the index survives the restart");
  await second.resume();
  const done = await settled(second, "v1", item.path);
  assert.equal(done.state, "done");
  assert.equal(state.ranges[0][0], 3 * MIB, "it asks only for the missing bytes");
  assert.equal(state.ranges.length, 7);
  const target = files.videoDownload("hub-a", "v1", `${hash}.mkv`);
  assert.ok(fs.readFileSync(target).equals(content));
  assert.equal(fs.existsSync(partial), false);
  assert.deepEqual(done.subtitles, ["Movies/Inception (2010).en.srt", "stream:2"], "image subtitles are skipped");
  assert.deepEqual(done.saved, done.subtitles);
  assert.deepEqual(state.subtitleCalls, ["Movies/Inception (2010).en.srt", "2", "2"], "an embedded track waits while the hub prepares it");
  assert.ok(changes.length > 0);
  assert.match(downloadLabel(changes.find((rows) => rows.get(`v1\n${item.path}`)?.state === "queued")?.get(`v1\n${item.path}`)), /^Downloading · \d+%$/);
  assert.equal(downloadLabel(done), "Downloaded");
  second.stop();
});

test("a title whose hash changed on the hub restarts from the new copy, and a removed title fails clearly", async (t) => {
  const { store, files } = setup(t);
  await store.init();
  const old = media(3 * MIB, 1);
  const oldHash = quick(old);
  const fresh = media(2 * MIB + 9, 2);
  const freshHash = quick(fresh);
  const { state, client } = hub({ content: old, hash: oldHash, item: movie(old, oldHash, { subtitles: [] }) });
  const replica = { scope: "hub-a", store, files };
  const wifi = async () => ({ type: "WIFI" });
  state.fail = (from) => from >= MIB;
  const first = createVideoDownloads({ replica, client, networkType: wifi, chunk: MIB });
  await first.add("v1", [state.item]);
  assert.equal((await settled(first, "v1", state.item.path)).state, "waiting");
  first.stop();
  const stale = files.videoDownload("hub-a", "v1", `${oldHash}.mkv`) + ".part";
  assert.equal(fs.existsSync(stale), true);

  state.fail = null;
  state.content = fresh;
  state.hash = freshHash;
  state.item = movie(fresh, freshHash, { subtitles: [] });
  const second = createVideoDownloads({ replica, client, networkType: wifi, chunk: MIB });
  await second.resume();
  const row = await settled(second, "v1", state.item.path);
  assert.equal(row.state, "done");
  assert.equal(row.hash, freshHash);
  assert.equal(row.size, fresh.length);
  assert.equal(fs.existsSync(stale), false, "the old partial is discarded");
  assert.ok(fs.readFileSync(files.videoDownload("hub-a", "v1", `${freshHash}.mkv`)).equals(fresh));
  second.stop();

  const other = media(MIB + 1, 3);
  const otherHash = quick(other);
  const gone = { ...movie(other, otherHash, { subtitles: [] }), id: "m:2", path: "Movies/Gone.mp4" };
  const third = createVideoDownloads({ replica, client, networkType: wifi, chunk: MIB });
  await third.add("v1", [gone]);
  for (let i = 0; i < 500 && third.get("v1", gone.path); i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(third.get("v1", gone.path), null, "a title no longer on the hub is removed instead of failing");
  assert.deepEqual((await store.videoDownloads("hub-a")).map((row) => row.path), [state.item.path]);
  assert.equal(fs.existsSync(files.videoDownload("hub-a", "v1", `${otherHash}.mp4`) + ".part"), false);
  await third.stop();
});

test("a download that does not match the hub's identity is discarded", async (t) => {
  const { store, files } = setup(t);
  await store.init();
  const content = media(2 * MIB);
  const { client } = hub({ content, hash: "f".repeat(64), item: null });
  const item = movie(content, "f".repeat(64), { subtitles: [] });
  files.hash = async () => {
    throw new Error("a stream-only title is never hashed in full");
  };
  const downloads = createVideoDownloads({ replica: { scope: "hub-a", store, files }, client, networkType: async () => ({ type: "WIFI" }), chunk: MIB });
  await downloads.add("v1", [item]);
  const row = await settled(downloads, "v1", item.path);
  assert.equal(row.state, "failed");
  assert.equal(row.error, MISMATCH);
  assert.equal(fs.existsSync(files.videoDownload("hub-a", "v1", `${"f".repeat(64)}.mkv`) + ".part"), false);
  downloads.stop();
});

test("downloads run on any network that reaches the hub, and wait only while the hub is away", async (t) => {
  const { store, files } = setup(t);
  await store.init();
  const content = media(MIB + 3);
  const hash = quick(content);
  const item = movie(content, hash, { subtitles: [] });
  const { state, client } = hub({ content, hash, item });
  state.linked = false;
  const downloads = createVideoDownloads({ replica: { scope: "hub-a", store, files }, client, networkType: async () => ({ type: "CELLULAR" }), chunk: MIB });
  await downloads.add("v1", [item]);
  const row = await settled(downloads, "v1", item.path);
  assert.equal(row.state, "waiting");
  assert.equal(row.error, HUB_AWAY);
  assert.equal(downloadLabel(row), "Waiting for hub · 0%");
  assert.equal(state.ranges.length, 0);
  state.linked = true;
  await downloads.resume();
  assert.equal((await settled(downloads, "v1", item.path)).state, "done", "mobile data is enough");
  assert.equal(DOWNLOAD_NOTE, "Downloads stay in the app until you remove them.");
  await downloads.stop();
});

test("a finished download plays and shows its subtitles with no hub, and Remove download frees the space", async (t) => {
  const { store, files } = setup(t);
  await store.init();
  const content = media(MIB + 3);
  const hash = quick(content);
  const item = movie(content, hash);
  const { state, client } = hub({ content, hash, item });
  state.preparing = 0;
  const replica = { scope: "hub-a", store, files };
  const downloads = createVideoDownloads({ replica, client, networkType: async () => ({ type: "WIFI" }), chunk: MIB });
  await downloads.add("v1", [item]);
  assert.equal((await settled(downloads, "v1", item.path)).state, "done");
  state.linked = false;
  const unreachable = async () => {
    throw Object.assign(new Error("Connect to your hub to watch"), { code: "HUB_UNREACHABLE" });
  };
  const source = await playbackSource({ downloads, volume: "v1", item, stream: unreachable });
  assert.equal(source.uri, files.videoDownload("hub-a", "v1", `${hash}.mkv`));
  assert.equal(source.local, true);
  assert.equal(source.lan, false, "a local file never watches the Wi-Fi");
  await assert.rejects(playbackSource({ downloads, volume: "v1", item, mode: "compatible", stream: unreachable }), /Connect to your hub/);
  const cues = await playbackCues({ downloads, volume: "v1", item, key: "stream:2", load: unreachable });
  assert.equal(cues[0].text, "Embedded line");
  assert.equal((await playbackCues({ downloads, volume: "v1", item, key: "Movies/Inception (2010).en.srt", load: unreachable }))[0].text, "Sidecar line");
  await assert.rejects(playbackSource({ downloads, volume: "v1", item: { ...item, path: "Movies/Other.mkv" }, stream: unreachable }), /Connect to your hub/);

  await downloads.remove("v1", item.path);
  assert.equal(downloads.get("v1", item.path), null);
  assert.deepEqual(fs.readdirSync(path.dirname(source.uri)), [], "the video and its subtitles are deleted");
  assert.deepEqual(await store.videoDownloads("hub-a"), []);
  assert.equal(downloads.localSource("v1", item), null);
  downloads.stop();
});

test("cancelling a running download stops it and deletes the partial file", async (t) => {
  const { store, files } = setup(t);
  await store.init();
  const content = media(4 * MIB);
  const hash = quick(content);
  const item = movie(content, hash, { subtitles: [] });
  const { state, client } = hub({ content, hash, item });
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const raw = client.raw;
  client.raw = async (route, options) => {
    if (state.ranges.length === 2) await gate;
    return raw(route, options);
  };
  const downloads = createVideoDownloads({ replica: { scope: "hub-a", store, files }, client, networkType: async () => ({ type: "WIFI" }), chunk: MIB });
  await downloads.add("v1", [item]);
  while (state.ranges.length < 2) await new Promise((resolve) => setImmediate(resolve));
  const removing = downloads.remove("v1", item.path);
  release();
  await removing;
  assert.equal(downloads.get("v1", item.path), null);
  assert.equal(fs.existsSync(files.videoDownload("hub-a", "v1", `${hash}.mkv`) + ".part"), false);
  assert.deepEqual(await store.videoDownloads("hub-a"), []);
  downloads.stop();
});

test("cancelling several downloads at once never starts a queued one", async (t) => {
  const { store, files } = setup(t);
  await store.init();
  const content = media(4 * MIB);
  const hash = quick(content);
  const first = movie(content, hash, { subtitles: [] });
  const second = { ...first, path: "Movies/Second.mkv", id: "m:second" };
  const { state, client } = hub({ content, hash, item: first });
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const raw = client.raw;
  client.raw = async (route, options) => {
    if (state.ranges.length === 2) await gate;
    return raw(route, options);
  };
  const startedSecond = [];
  const downloads = createVideoDownloads({ replica: { scope: "hub-a", store, files }, client, networkType: async () => ({ type: "WIFI" }), chunk: MIB, onChange: (rows) => startedSecond.push(rows.get(`v1\n${second.path}`)?.running === true) });
  await downloads.add("v1", [first, second]);
  while (state.ranges.length < 2) await new Promise((resolve) => setImmediate(resolve));
  const removing = downloads.removeMany("v1", [first.path, second.path]);
  release();
  await removing;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(startedSecond.includes(true), false, "the second episode never started");
  assert.equal(downloads.get("v1", first.path), null);
  assert.equal(downloads.get("v1", second.path), null);
  assert.deepEqual(await store.videoDownloads("hub-a"), []);
  downloads.stop();
});

test("subtitle choices to download keep sidecars and readable embedded tracks", () => {
  assert.deepEqual(downloadSubtitles(movie(Buffer.alloc(1), "a")), ["Movies/Inception (2010).en.srt", "stream:2"]);
});

test("positions saved while the hub is away queue, keep the latest per title, and flush when it returns", async (t) => {
  const { store } = setup(t);
  await store.init();
  const replica = { scope: "hub-a", store };
  const sent = [];
  let online = false;
  const client = {
    state: () => ({ connection: { linked: true } }),
    async api(route, body) {
      if (!online) throw Object.assign(new Error("Network request failed"), {});
      sent.push(body);
      return {};
    },
  };
  const item = { path: "Movies/Inception.mkv", hash: "a".repeat(64), duration: 6000 };
  let clock = 1;
  const now = () => clock++;
  await sendPosition({ client, replica, volume: "v1", item, position: 100, duration: 6000, now });
  await sendPosition({ client, replica, volume: "v1", item, position: 200, duration: 6000, now });
  await sendPosition({ client, replica, volume: "v1", item: { ...item, path: "Movies/Heat.mkv" }, position: 50, duration: 6000, now });
  const queued = await store.videoPositions("hub-a");
  assert.equal(queued.length, 2);
  assert.equal(queued[0].body.position, 200, "only the latest position per title is kept");

  const library = normalizeLibrary({
    version: "1",
    movies: [
      { id: "m:1", title: "Inception", path: "Movies/Inception.mkv", hash: item.hash, duration: 6000 },
      { id: "m:2", title: "Heat", path: "Movies/Heat.mkv", hash: item.hash, duration: 6000 },
    ],
  });
  await withQueuedPositions(replica, "v1", library);
  assert.equal(library.items.get("m:1").position.position, 200, "offline, the library resumes from the queued position");
  assert.equal(library.items.get("m:2").position.position, 50);

  assert.equal(await flushPositions({ client, replica }), 0, "a still-unreachable hub keeps the queue");
  assert.equal((await store.videoPositions("hub-a")).length, 2);
  online = true;
  assert.equal(await flushPositions({ client, replica }), 2);
  assert.deepEqual(sent.map((body) => [body.path, body.position]), [["Movies/Inception.mkv", 200], ["Movies/Heat.mkv", 50]]);
  assert.deepEqual(await store.videoPositions("hub-a"), []);

  await sendPosition({ client, replica, volume: "v1", item, position: 300, duration: 6000, now });
  assert.deepEqual(await store.videoPositions("hub-a"), [], "a reachable hub takes the position directly");
  assert.equal(sent.at(-1).position, 300);
});

test("Home leads with a Downloads shelf of badged posters whenever anything is downloaded", () => {
  const library = normalizeLibrary({
    version: "1",
    movies: [
      { id: "m:1", title: "Stuart Little", year: 1999, path: "Movies/Stuart.mkv", hash: "a" },
      { id: "m:2", title: "Heat", year: 1995, path: "Movies/Heat.mkv", hash: "b" },
    ],
    shows: [
      {
        id: "s:1",
        title: "Andor",
        seasons: [{ season: 1, episodes: [1, 2, 3].map((n) => ({ id: `e:${n}`, episode: n, path: `Andor/S1E${n}.mkv`, hash: String(n) })) }],
      },
    ],
  });
  assert.equal(videoShelves(library, () => null)[0].key, "recent", "no downloads, no shelf");
  const rows = new Map([
    ["Movies/Stuart.mkv", { state: "done", added: 1 }],
    ["Andor/S1E1.mkv", { state: "done", added: 2 }],
    ["Andor/S1E2.mkv", { state: "done", added: 3 }],
    ["Movies/Heat.mkv", { state: "queued", added: 4 }],
  ]);
  const saved = (item) => rows.get(item.path) || null;
  const [first] = videoShelves(library, saved);
  assert.equal(first.key, "downloads");
  assert.equal(first.title, "Downloads");
  assert.deepEqual(first.cards.map((card) => [card.title, card.caption, card.saved]), [["Andor", "2 episodes", true], ["Stuart Little", "1999", true]]);
  assert.deepEqual(downloadedTitles(library, saved).map((card) => card.item.id), ["s:1", "m:1"], "offline shows the same downloads");
  assert.deepEqual(titleActions(library.items.get("m:1"), "remove-download"), ["watched", "remove-download"]);
  assert.deepEqual(titleActions(library.items.get("e:1"), downloadAction(saved(library.items.get("e:1")))), ["watched", "remove-download"]);
  assert.deepEqual(titleActions(library.items.get("m:2"), downloadAction(saved(library.items.get("m:2")))), ["watched", "cancel-download"]);
  assert.deepEqual(titleActions(library.items.get("e:3"), downloadAction(saved(library.items.get("e:3")))), ["watched", "download"]);
  assert.deepEqual(titleActions(library.items.get("m:2")), ["watched"]);
  assert.deepEqual(downloadTargets(library.items.get("s:1")).map((ep) => ep.id), ["e:1", "e:2", "e:3"]);
});

test("every file downloads except an MKV or WebM on iPhone, and a copy needing the converted audio plays from the hub when it answers and from the copy when it does not", async () => {
  const dts = { path: "Movies/A.mp4", hash: "a", audioTracks: [{ stream: 1, codec: "dts", default: true }, { stream: 2, codec: "aac" }] };
  const aac = { path: "Movies/B.mkv", hash: "b", audioTracks: [{ stream: 1, codec: "aac", default: true }] };
  assert.equal(downloadable(dts, "android"), true, "a DTS file downloads; the copy plays when the phone can decode it");
  assert.equal(downloadable(dts, "ios"), true);
  assert.equal(downloadable(aac, "android"), true);
  assert.equal(downloadable(aac, "ios"), false, "AVPlayer opens no MKV");
  assert.equal(downloadable({ ...aac, path: "Movies/B.M4V" }, "ios"), true);
  assert.equal(downloadable({ ...aac, path: "Movies/B.mov" }, "ios"), true);
  assert.equal(downloadable({ ...aac, path: "Movies/B.webm" }, "ios"), false);
  const downloads = { localSource: () => ({ uri: "file:///local.mp4", local: true }) };
  const stream = async () => ({ uri: "https://hub/stream" });
  const away = async () => {
    throw new Error("Connect to your hub’s Wi-Fi to watch.");
  };
  assert.equal((await playbackSource({ downloads, volume: "v1", item: dts, stream })).uri, "https://hub/stream", "a file needing the converted stream goes to the hub while it answers");
  assert.equal((await playbackSource({ downloads, volume: "v1", item: dts, stream: away })).uri, "file:///local.mp4", "with the hub away the copy plays");
  assert.equal((await playbackSource({ downloads, volume: "v1", item: dts, audio: 2, stream })).uri, "file:///local.mp4", "an AAC track plays from the download");
  assert.equal((await playbackSource({ downloads, volume: "v1", item: aac, stream })).uri, "file:///local.mp4");
  await assert.rejects(playbackSource({ downloads: { localSource: () => null }, volume: "v1", item: dts, stream: away }), /Connect to your hub/, "with no copy the hub is needed");
});

test("removing a download while its embedded subtitles are still preparing settles at once and stops polling", async (t) => {
  const { store, files } = setup(t);
  await store.init();
  const content = media(MIB);
  const hash = quick(content);
  const item = movie(content, hash, { subtitles: [{ embedded: true, stream: 2, language: "es" }] });
  const { state, client } = hub({ content, hash, item });
  state.preparing = Infinity;
  const signals = [];
  const api = client.api;
  client.api = async (route, body, options) => {
    if (route.startsWith("/v1/video/subtitles")) signals.push(options?.signal);
    return api(route, body, options);
  };
  const downloads = createVideoDownloads({ replica: { scope: "hub-a", store, files }, client, networkType: async () => ({ type: "WIFI" }), chunk: MIB });
  await downloads.add("v1", [item]);
  while (state.subtitleCalls.length < 1) await new Promise((resolve) => setTimeout(resolve, 5));
  const started = Date.now();
  await downloads.remove("v1", item.path);
  assert.ok(Date.now() - started < 1000, "remove does not wait for the hub to prepare the track");
  assert.ok(signals[0] instanceof AbortSignal, "subtitle requests carry the job's signal");
  assert.equal(downloads.get("v1", item.path), null);
  assert.deepEqual(await store.videoDownloads("hub-a"), []);
  assert.deepEqual(fs.readdirSync(path.dirname(files.videoDownload("hub-a", "v1", `${hash}.mkv`))), []);
  const calls = state.subtitleCalls.length;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(state.subtitleCalls.length, calls, "polling stops");

  let release;
  const stuck = new Promise((resolve) => (release = resolve));
  client.api = async (route, body, options) => {
    if (route.startsWith("/v1/video/subtitles")) {
      state.subtitleCalls.push("stuck");
      await stuck;
      return { preparing: true };
    }
    return api(route, body, options);
  };
  const slow = createVideoDownloads({ replica: { scope: "hub-a", store, files }, client, networkType: async () => ({ type: "WIFI" }), chunk: MIB });
  await slow.add("v1", [item]);
  while (!state.subtitleCalls.includes("stuck")) await new Promise((resolve) => setTimeout(resolve, 5));
  const removing = slow.remove("v1", item.path);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(await store.videoDownloads("hub-a"), [], "the index row is forgotten before waiting for a slow request");
  release();
  await removing;
  client.api = async (route, body, options) => {
    if (route.startsWith("/v1/video/subtitles")) signals.push(options?.signal);
    return api(route, body, options);
  };
  const before = state.subtitleCalls.length;
  const again = createVideoDownloads({ replica: { scope: "hub-a", store, files }, client, networkType: async () => ({ type: "WIFI" }), chunk: MIB });
  await again.add("v1", [item]);
  while (state.subtitleCalls.length < before + 1) await new Promise((resolve) => setTimeout(resolve, 5));
  const stopping = Date.now();
  await again.stop();
  assert.ok(Date.now() - stopping < 1000, "stop ends the polling loop too");
  const after = state.subtitleCalls.length;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(state.subtitleCalls.length, after);
});

test("erasing the device stops downloads before deleting their storage, and nothing is written back", async (t) => {
  const { store, files, storage } = setup(t);
  await store.init();
  const content = media(2 * MIB);
  const hash = quick(content);
  const item = movie(content, hash, { subtitles: [] });
  const { state, client } = hub({ content, hash, item });
  let release;
  const held = new Promise((resolve) => (release = resolve));
  const raw = client.raw;
  client.raw = async (route, options) => {
    const answer = await raw(route, options);
    if (state.ranges.length === 1) await held;
    return answer;
  };
  const downloads = createVideoDownloads({ replica: { scope: "hub-a", store, files }, client, networkType: async () => ({ type: "WIFI" }), chunk: MIB });
  await downloads.add("v1", [item]);
  while (state.ranges.length < 1) await new Promise((resolve) => setImmediate(resolve));
  const order = [];
  const replica = {
    videoDownloads: {
      async stop() {
        const stopping = downloads.stop();
        setTimeout(release, 20);
        await stopping;
        order.push("downloads stopped");
      },
    },
    files: {
      destroy: async () => {
        order.push("files destroyed");
        fs.rmSync(storage, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      },
    },
    client: { destroy: async () => order.push("client destroyed") },
    cleanupDevice: async () => {},
    store: { reset: async () => order.push("store reset"), set: async () => {} },
    hashCache: new Map(),
    verified: new Map(),
    lastInventory: new Map(),
    inventoryDue: new Map(),
  };
  await Replica.prototype.finishDestroy.call(replica);
  assert.equal(order[0], "downloads stopped");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(fs.existsSync(storage), false, "no partial or subtitle file is written back");
  assert.equal((await store.videoDownloads("hub-a"))[0].done, 0, "no progress is saved after the stop");
});

test("erasing the device waits for a picture being saved and drops library and picture answers still on their way", async (t) => {
  const { store } = setup(t);
  await store.init();
  const [saving, waiting] = ["a".repeat(64), "b".repeat(64)];
  const disk = new Map();
  let started = false;
  let [releaseLibrary, releaseArt, releaseWrite] = [];
  const libraryAnswer = new Promise((resolve) => (releaseLibrary = resolve));
  const artAnswer = new Promise((resolve) => (releaseArt = resolve));
  const writing = new Promise((resolve) => (releaseWrite = resolve));
  const picture = { data: "data:image/jpeg;base64,QUJD" };
  const replica = {
    scope: "hub-a",
    store,
    client: {
      api: async (route) => (route.startsWith("/v1/video/library") ? libraryAnswer : route.includes(saving) ? picture : artAnswer),
      destroy: async () => {},
    },
    files: {
      videoArt: (scope, key, size) => `art/${key}-${size}.jpg`,
      exists: async (uri) => disk.has(uri),
      parent: () => "art",
      mkdir: async () => {},
      remove: async (uri) => disk.delete(uri),
      writeBase64: async (uri, data) => {
        if (uri.includes(saving)) {
          started = true;
          await writing;
        }
        disk.set(uri, data);
      },
      replace: async (from, to) => {
        disk.set(to, disk.get(from));
        disk.delete(from);
      },
      destroy: async () => disk.clear(),
    },
    cleanupDevice: async () => {},
    hashCache: new Map(),
    verified: new Map(),
    lastInventory: new Map(),
    inventoryDue: new Map(),
  };
  const loader = createArtLoader(replica, () => {});
  loader.request("v1", saving, "small");
  loader.request("v1", waiting, "small");
  const refreshing = refreshVideoLibrary(replica, "v1");
  while (!started) await new Promise((resolve) => setImmediate(resolve));
  setTimeout(releaseWrite, 20);
  await Replica.prototype.finishDestroy.call(replica);
  assert.equal(disk.size, 0, "the picture being saved finished before the storage was deleted");
  releaseArt(picture);
  releaseLibrary({ version: "1", movies: [], shows: [], other: [], continue: [], nextUp: [] });
  await assert.rejects(refreshing, /erased/);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(disk.size, 0, "a picture answered after Erase is not saved");
  assert.equal(await store.videoLibrary("hub-a", "v1"), null, "a library answered after Erase is not saved");
});

test("two paths with the same content keep their own subtitles, and removing one deletes only its own", async (t) => {
  const { store, files } = setup(t);
  await store.init();
  const content = media(MIB + 7);
  const hash = quick(content);
  const first = movie(content, hash, { subtitles: [{ path: "Movies/A.en.srt", language: "en" }] });
  const second = { ...movie(content, hash, { subtitles: [{ path: "Movies/B.en.srt", language: "en" }] }), id: "m:2", path: "Movies/B.mkv" };
  const { client } = hub({ content, hash, item: first });
  const api = client.api;
  client.api = async (route, body, options) => {
    const query = new URLSearchParams(route.split("?")[1]);
    if (route.startsWith("/v1/video/subtitles")) return { text: `1\n00:00:01,000 --> 00:00:02,000\n${query.get("path")}\n` };
    return api(route, body, options);
  };
  const downloads = createVideoDownloads({ replica: { scope: "hub-a", store, files }, client, networkType: async () => ({ type: "WIFI" }), chunk: MIB });
  await downloads.add("v1", [first, second]);
  await settled(downloads, "v1", first.path);
  for (let i = 0; i < 500 && downloads.get("v1", second.path).state !== "done"; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(downloads.get("v1", second.path).state, "done");
  assert.match(subtitleFile(downloads.get("v1", first.path), "Movies/A.en.srt"), /^[a-f0-9]{64}\.sub\.txt$/);
  assert.equal((await downloads.localCues("v1", first, "Movies/A.en.srt")), "1\n00:00:01,000 --> 00:00:02,000\nMovies/A.en.srt\n");
  assert.equal((await downloads.localCues("v1", second, "Movies/B.en.srt")), "1\n00:00:01,000 --> 00:00:02,000\nMovies/B.en.srt\n");
  const kept = files.videoDownload("hub-a", "v1", subtitleFile(downloads.get("v1", second.path), "Movies/B.en.srt"));
  const gone = files.videoDownload("hub-a", "v1", subtitleFile(downloads.get("v1", first.path), "Movies/A.en.srt"));
  await downloads.remove("v1", first.path);
  assert.equal(fs.existsSync(gone), false, "the removed title's subtitles go even though the video stays");
  assert.equal(fs.existsSync(kept), true);
  assert.ok(downloads.localSource("v1", second), "the shared video stays for the other path");
  downloads.stop();
});

test("a hub still syncing the video makes the download wait and retry, not fail", async (t) => {
  const { store, files } = setup(t);
  await store.init();
  const content = media(MIB + 1);
  const hash = quick(content);
  const item = movie(content, hash, { subtitles: [] });
  const { state, client } = hub({ content, hash, item });
  let syncing = 1;
  const raw = client.raw;
  client.raw = async (route, options) => {
    if (syncing-- > 0) throw new HubError("Sync this video before playing it", 409);
    return raw(route, options);
  };
  const seen = [];
  const downloads = createVideoDownloads({ replica: { scope: "hub-a", store, files }, client, networkType: async () => ({ type: "WIFI" }), chunk: MIB, retryDelay: 10, onChange: (rows) => seen.push(rows.get(`v1\n${item.path}`)) });
  await downloads.add("v1", [item]);
  for (let i = 0; i < 200 && downloads.get("v1", item.path).state !== "done"; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(seen.some((row) => row?.state === "waiting" && row.error === HUB_SYNCING));
  assert.ok(seen.some((row) => row?.state === "queued" && row.running === true), "the row being downloaded says so");
  assert.equal(downloads.get("v1", item.path).state, "done");
  assert.ok(state.ranges.length >= 1);
  downloads.stop();
});

test("after a hash change the free space is checked again and an existing copy of the new content is reused", async (t) => {
  const { store, files } = setup(t);
  await store.init();
  const old = media(2 * MIB, 1);
  const oldHash = quick(old);
  const fresh = media(MIB + 5, 2);
  const freshHash = quick(fresh);
  const original = { ...movie(old, oldHash, { subtitles: [] }), path: "Movies/B.mkv", id: "m:2" };
  const { state, client } = hub({ content: old, hash: oldHash, item: original });
  state.fail = (from) => from >= MIB;
  const first = createVideoDownloads({ replica: { scope: "hub-a", store, files }, client, networkType: async () => ({ type: "WIFI" }), chunk: MIB });
  await first.add("v1", [original]);
  assert.equal((await settled(first, "v1", original.path)).state, "waiting");
  await first.stop();
  state.fail = null;
  const target = files.videoDownload("hub-a", "v1", `${freshHash}.mkv`);
  fs.writeFileSync(target, fresh);
  state.content = fresh;
  state.hash = freshHash;
  const updated = { ...original, hash: freshHash, size: fresh.length };
  state.ranges.length = 0;
  const second = createVideoDownloads({ replica: { scope: "hub-a", store, files }, client, networkType: async () => ({ type: "WIFI" }), chunk: MIB, refresh: async () => updated });
  await second.resume();
  const row = await settled(second, "v1", original.path);
  assert.equal(row.state, "done");
  assert.equal(row.hash, freshHash);
  assert.deepEqual(state.ranges.map(([, h]) => h), [oldHash], "the existing copy is reused without downloading it again");
  await second.stop();

  const big = { ...movie(media(3 * MIB, 4), quick(media(3 * MIB, 4)), { subtitles: [] }), path: "Movies/C.mkv", id: "m:3" };
  state.content = media(3 * MIB, 4);
  state.hash = big.hash;
  let free = 64 * 1024 * MIB;
  files.free = async () => free;
  const huge = { ...big, hash: "e".repeat(64), size: 900 * 1024 * MIB };
  const third = createVideoDownloads({
    replica: { scope: "hub-a", store, files },
    client: { ...client, raw: async () => { throw new HubError("This video is no longer available", 404); } },
    networkType: async () => ({ type: "WIFI" }),
    chunk: MIB,
    refresh: async () => {
      free = 100 * 1024 * MIB;
      return huge;
    },
  });
  await third.add("v1", [big]);
  const failed = await settled(third, "v1", big.path);
  assert.equal(failed.state, "failed");
  assert.equal(failed.error, NO_SPACE);
  await third.stop();
});

test("a queued position older than a live save is never sent after it", async (t) => {
  const { store } = setup(t);
  await store.init();
  const replica = { scope: "hub-race", store };
  const sent = [];
  let online = false;
  let during = null;
  const client = {
    state: () => ({ connection: { linked: true } }),
    async api(route, body) {
      if (!online) throw new Error("Network request failed");
      if (during) {
        const run = during;
        during = null;
        await run();
      }
      sent.push([body.path, body.position]);
      return {};
    },
  };
  const a = { path: "Movies/A.mkv", hash: "a".repeat(64), duration: 6000 };
  const b = { path: "Movies/B.mkv", hash: "b".repeat(64), duration: 6000 };
  await sendPosition({ client, replica, volume: "v1", item: a, position: 100, duration: 6000, now: () => 1 });
  await sendPosition({ client, replica, volume: "v1", item: b, position: 200, duration: 6000, now: () => 2 });
  online = true;
  during = () => sendPosition({ client, replica, volume: "v1", item: b, position: 900, duration: 6000, now: () => 10 });
  await flushPositions({ client, replica });
  assert.deepEqual(sent, [["Movies/B.mkv", 900], ["Movies/A.mkv", 100]], "B's old queued position is dropped after the live one");
  assert.deepEqual(await store.videoPositions("hub-race"), []);
});

test("the file layer accepts exactly the names downloads write: the video by hash and extension, subtitles by their own digest", async () => {
  const { DOWNLOAD_NAME, subtitleFile } = await import("../apps/mobile/src/video-downloads.js");
  const row = { path: "Movies/A.mkv", hash: "a".repeat(64) };
  assert.match(subtitleFile(row, "stream:2"), DOWNLOAD_NAME);
  assert.match(`${"a".repeat(64)}.mkv`, DOWNLOAD_NAME);
  assert.doesNotMatch("../x.mkv", DOWNLOAD_NAME);
  assert.doesNotMatch(`${"a".repeat(64)}.sub.txt/../x`, DOWNLOAD_NAME);
  const source = (await import("node:fs")).readFileSync(new URL("../apps/mobile/src/files.js", import.meta.url), "utf8");
  assert.match(source, /if \(!DOWNLOAD_NAME\.test\(name\)\)/, "files.js checks the same pattern");
});

test("removing a download while a chunk is landing never brings its row back", async (t) => {
  const { store, files } = setup(t);
  await store.init();
  const content = media(4 * MIB);
  const hash = quick(content);
  const item = movie(content, hash, { subtitles: [] });
  const { state, client } = hub({ content, hash, item });
  let releaseChunk = () => {};
  const forget = store.forgetVideoDownload.bind(store);
  store.forgetVideoDownload = async (...args) => {
    await forget(...args);
    releaseChunk();
    await new Promise((resolve) => setTimeout(resolve, 20));
  };
  const raw = client.raw;
  client.raw = async (route, options) => {
    if (state.ranges.length === 1) await new Promise((resolve) => (releaseChunk = resolve));
    return raw(route, options);
  };
  const downloads = createVideoDownloads({ replica: { scope: "hub-a", store, files }, client, networkType: async () => ({ type: "WIFI" }), chunk: MIB });
  await downloads.add("v1", [item]);
  while (state.ranges.length < 1) await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setTimeout(resolve, 5));
  await downloads.remove("v1", item.path);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(downloads.get("v1", item.path), null);
  assert.deepEqual(await store.videoDownloads("hub-a"), []);
  assert.ok(state.ranges.length <= 2, "nothing is downloaded again");
  assert.equal(fs.existsSync(files.videoDownload("hub-a", "v1", `${hash}.mkv`) + ".part"), false);
  await downloads.stop();
});

test("a copy of an older version on the hub is not played; downloading again replaces it", async (t) => {
  const { store, files } = setup(t);
  await store.init();
  const old = media(MIB + 3, 1);
  const oldHash = quick(old);
  const item = movie(old, oldHash, { subtitles: [{ path: "Movies/Inception (2010).en.srt", language: "en" }] });
  const { state, client } = hub({ content: old, hash: oldHash, item });
  const downloads = createVideoDownloads({ replica: { scope: "hub-a", store, files }, client, networkType: async () => ({ type: "WIFI" }), chunk: MIB });
  await downloads.add("v1", [item]);
  assert.equal((await settled(downloads, "v1", item.path)).state, "done");
  const oldFile = files.videoDownload("hub-a", "v1", `${oldHash}.mkv`);
  const fresh = media(MIB + 9, 2);
  const freshHash = quick(fresh);
  const replaced = { ...item, hash: freshHash, size: fresh.length };
  const stream = async () => ({ uri: "https://hub/stream" });
  assert.equal((await playbackSource({ downloads, volume: "v1", item: replaced, stream })).uri, "https://hub/stream");
  assert.equal(await downloads.localCues("v1", replaced, "Movies/Inception (2010).en.srt"), null);
  const row = itemDownload(downloads.get("v1", item.path), replaced);
  assert.equal(row.state, "stale");
  assert.equal(downloadLabel(row), "Download again");
  assert.equal(itemDownload(downloads.get("v1", item.path), item).state, "done");
  assert.deepEqual(downloadedTitles(normalizeLibrary({ version: "1", movies: [replaced] }), (title) => itemDownload(downloads.get("v1", title.path), title)), [], "it leaves the Downloads shelf");
  state.content = fresh;
  state.hash = freshHash;
  await downloads.add("v1", [replaced]);
  for (let i = 0; i < 500 && downloads.get("v1", item.path).hash !== freshHash; i++) await new Promise((resolve) => setImmediate(resolve));
  const done = await settled(downloads, "v1", item.path);
  assert.equal(done.state, "done");
  assert.equal(done.hash, freshHash);
  assert.equal(done.replaces, undefined);
  assert.equal(fs.existsSync(oldFile), false, "the old copy is deleted once the new one is complete");
  assert.deepEqual(fs.readdirSync(path.dirname(oldFile)).sort(), [`${freshHash}.mkv`, subtitleFile(done, "Movies/Inception (2010).en.srt")].sort());
  assert.equal((await playbackSource({ downloads, volume: "v1", item: replaced, stream })).local, true);
  await downloads.stop();
});

test("a live position supersedes the queue before it is sent, and returns to the queue if the hub is away", async (t) => {
  const { store } = setup(t);
  await store.init();
  const replica = { scope: "hub-live", store };
  const sent = [];
  let online = false;
  let hold = null;
  const client = {
    state: () => ({ connection: { linked: true } }),
    async api(route, body) {
      sent.push([body.path, body.position]);
      if (hold && body.position === 900) await hold;
      if (!online) throw new Error("Network request failed");
      return {};
    },
  };
  const a = { path: "Movies/A.mkv", hash: "a".repeat(64), duration: 6000 };
  await sendPosition({ client, replica, volume: "v1", item: a, position: 100, duration: 6000, now: () => 1 });
  sent.length = 0;
  online = true;
  let release;
  hold = new Promise((resolve) => (release = resolve));
  const live = sendPosition({ client, replica, volume: "v1", item: a, position: 900, duration: 6000, now: () => 10 });
  await new Promise((resolve) => setImmediate(resolve));
  await flushPositions({ client, replica });
  release();
  await live;
  assert.deepEqual(sent, [["Movies/A.mkv", 900]], "the older queued position is never sent while the live one is in flight");

  online = false;
  hold = null;
  await sendPosition({ client, replica, volume: "v1", item: a, position: 1200, duration: 6000, now: () => 20 });
  assert.deepEqual((await store.videoPositions("hub-live")).map((row) => row.body.position), [1200], "an unreachable live save is queued");
  online = true;
  sent.length = 0;
  assert.equal(await flushPositions({ client, replica }), 1);
  assert.deepEqual(sent, [["Movies/A.mkv", 1200]]);
});

test("downloads disappear when a fresh read from the hub no longer has them, never from a cached list or a failed read", async (t) => {
  const { store, files } = setup(t);
  await store.init();
  const a = media(MIB + 1, 1);
  const b = media(MIB + 2, 2);
  const first = { ...movie(a, quick(a), { subtitles: [{ path: "Movies/A.en.srt", language: "en" }] }), id: "m:1", path: "Movies/A.mp4" };
  const second = { ...movie(b, quick(b), { subtitles: [] }), id: "m:2", path: "Movies/B.mp4" };
  const shared = { ...first, id: "m:3", path: "Movies/A copy.mp4", subtitles: [] };
  const contents = new Map([[first.hash, a], [second.hash, b]]);
  let listed = [first, second, shared];
  let reachable = true;
  const client = {
    fileTransfers: false,
    state: () => ({ connection: { linked: true } }),
    async raw(route, options) {
      const query = new URLSearchParams(route.split("?")[1]);
      const content = contents.get(query.get("hash"));
      const [, from, to] = /bytes=(\d+)-(\d+)/.exec(options.headers.Range).map(Number);
      const body = content.subarray(from, to + 1);
      return { status: 206, headers: { get: () => `bytes ${from}-${to}/${content.length}` }, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) };
    },
    async api(route) {
      if (route.startsWith("/v1/video/subtitles")) return { text: "1\n00:00:01,000 --> 00:00:02,000\nHi\n" };
      if (!reachable) throw new Error("Network request failed");
      return { version: String(Math.random()), movies: listed, shows: [], other: [] };
    },
  };
  const replica = { scope: "hub-a", store, files, client };
  const downloads = createVideoDownloads({ replica, client, chunk: MIB });
  await downloads.add("v1", [first, second, shared]);
  for (let i = 0; i < 2000 && [first, second, shared].some((item) => downloads.get("v1", item.path)?.state !== "done"); i++) await new Promise((resolve) => setImmediate(resolve));
  const aFile = files.videoDownload("hub-a", "v1", `${first.hash}.mp4`);
  const aSub = files.videoDownload("hub-a", "v1", subtitleFile(downloads.get("v1", first.path), "Movies/A.en.srt"));
  assert.ok(fs.existsSync(aSub));

  listed = [shared, { ...second, hash: "c".repeat(64) }];
  reachable = false;
  await assert.rejects(refreshVideoLibrary(replica, "v1", { downloads }));
  await cachedVideoLibrary(replica, "v1");
  assert.ok(downloads.get("v1", first.path), "an unreachable hub removes nothing");

  reachable = true;
  await refreshVideoLibrary(replica, "v1", { downloads });
  assert.equal(downloads.get("v1", first.path), null, "a title gone from a fresh library is removed");
  assert.equal(fs.existsSync(aSub), false, "with its subtitles");
  assert.equal(fs.existsSync(aFile), true, "the video stays while another downloaded path uses it");
  assert.equal(itemDownload(downloads.get("v1", second.path), { ...second, hash: "c".repeat(64) }).state, "stale", "a changed file is kept for Download again");
  assert.deepEqual((await store.videoDownloads("hub-a")).map((row) => row.path).sort(), [second.path, shared.path].sort());
  await downloads.stop();
});

test("downloads disappear when a fresh catalog drops their Movies & TV folder, and on another hub", async (t) => {
  const { store, files } = setup(t);
  await store.init();
  const content = media(MIB + 1);
  const hash = quick(content);
  const one = movie(content, hash, { subtitles: [] });
  const { client } = hub({ content, hash, item: one });
  const downloads = createVideoDownloads({ replica: { scope: "hub-a", store, files }, client, chunk: MIB, since: 1000 });
  await downloads.add("v1", [one]);
  await downloads.add("v2", [one]);
  for (let i = 0; i < 1000 && ["v1", "v2"].some((v) => downloads.get(v, one.path)?.state !== "done"); i++) await new Promise((resolve) => setImmediate(resolve));
  const volumes = [{ id: "v1", name: "Movies", video: true }, { id: "v2", name: "Kids", video: true }];
  await downloads.pruneVolumes({ video: true, fetchedAt: 999, volumes: volumes.slice(0, 1) });
  assert.ok(downloads.get("v2", one.path), "a catalog older than this run removes nothing");
  await downloads.pruneVolumes({ video: true, fetchedAt: 2000, volumes });
  assert.ok(downloads.get("v1", one.path) && downloads.get("v2", one.path));
  await downloads.pruneVolumes({ video: true, fetchedAt: 2000, volumes: [volumes[0], { ...volumes[1], video: false }] });
  assert.equal(downloads.get("v2", one.path), null, "a folder that is no longer Movies & TV loses its downloads");
  await downloads.pruneVolumes({ video: true, fetchedAt: 3000, volumes: [{ id: "v3", name: "Other", video: true }] });
  assert.equal(downloads.get("v1", one.path), null, "a folder gone from the catalog loses its downloads");
  assert.equal(fs.existsSync(files.videoDownload("hub-a", "v1", `${hash}.mkv`)), false);
  await downloads.stop();

  const again = createVideoDownloads({ replica: { scope: "hub-a", store, files }, client, chunk: MIB });
  await again.add("v1", [one]);
  for (let i = 0; i < 1000 && again.get("v1", one.path)?.state !== "done"; i++) await new Promise((resolve) => setImmediate(resolve));
  await again.stop();
  const file = files.videoDownload("hub-a", "v1", `${hash}.mkv`);
  assert.ok(fs.existsSync(file));
  const other = createVideoDownloads({ replica: { scope: "hub-b", store, files }, client, chunk: MIB });
  await other.load();
  assert.deepEqual(await store.videoDownloads("hub-a"), [], "linking another hub removes the old hub's downloads");
  assert.equal(fs.existsSync(file), false);
  await other.stop();
});

test("linking another hub removes the old hub's partial downloads and keeps the manager working", async (t) => {
  const { store, files } = setup(t);
  await store.init();
  const content = media(2 * MIB);
  const hash = quick(content);
  const item = movie(content, hash, { subtitles: [{ path: "Movies/Inception (2010).en.srt", language: "en" }] });
  const { state, client } = hub({ content, hash, item });
  state.fail = (from) => from >= MIB;
  const old = createVideoDownloads({ replica: { scope: "hub-a", store, files }, client, chunk: MIB });
  await old.add("v1", [item]);
  assert.equal((await settled(old, "v1", item.path)).state, "waiting");
  await old.stop();
  const partial = files.videoDownload("hub-a", "v1", `${hash}.mkv`) + ".part";
  assert.ok(fs.existsSync(partial));
  state.fail = null;
  const other = createVideoDownloads({ replica: { scope: "hub-b", store, files }, client, chunk: MIB });
  await other.load();
  assert.equal(fs.existsSync(partial), false);
  assert.deepEqual(await store.videoDownloads("hub-a"), []);
  await other.add("v1", [item]);
  assert.equal((await settled(other, "v1", item.path)).state, "done", "add still works after the cleanup");
  await other.prune("v1", normalizeLibrary({ version: "1", movies: [item] }));
  await other.resume();
  assert.equal(other.get("v1", item.path).state, "done");
  await other.stop();
});

test("an empty or still-reading library and an empty catalog never remove downloads", async (t) => {
  const { store, files } = setup(t);
  await store.init();
  const content = media(MIB + 1);
  const hash = quick(content);
  const item = movie(content, hash, { subtitles: [] });
  const { client } = hub({ content, hash, item });
  const downloads = createVideoDownloads({ replica: { scope: "hub-a", store, files }, client, chunk: MIB, since: 0 });
  await downloads.add("v1", [item]);
  assert.equal((await settled(downloads, "v1", item.path)).state, "done");
  const elsewhere = { id: "m:9", title: "Heat", path: "Movies/Heat.mkv", hash: "b".repeat(64) };
  await downloads.prune("v1", normalizeLibrary({ version: "1", movies: [], shows: [], other: [] }));
  assert.ok(downloads.get("v1", item.path), "an empty library looks like an unmounted disk");
  await downloads.prune("v1", normalizeLibrary({ version: "1", indexing: true, movies: [elsewhere] }));
  assert.ok(downloads.get("v1", item.path), "a library still being read is incomplete");
  await downloads.pruneVolumes({ video: true, fetchedAt: Date.now() + 1000, volumes: [] });
  assert.ok(downloads.get("v1", item.path), "a catalog with no folders removes nothing");
  await downloads.prune("v1", normalizeLibrary({ version: "1", movies: [elsewhere] }));
  assert.equal(downloads.get("v1", item.path), null, "a complete library without the title still removes it");
  await downloads.stop();
});

test("a Download that cannot be offered names its cause, the caution rides on files needing converted audio, and the tile reads its state in one short word", () => {
  const movie = (extra) => ({ kind: "movie", path: "movies/Heat (1995).mp4", audioTracks: [{ stream: 0, codec: "aac", default: true }], ...extra });
  assert.equal(downloadBlock(movie({}), "android"), "");
  assert.equal(downloadBlock(movie({ audioTracks: [{ stream: 0, codec: "eac3", default: true }] }), "android"), "", "audio never blocks a download");
  assert.equal(downloadCaution(movie({})), "");
  assert.equal(downloadCaution(movie({ audioTracks: [{ stream: 0, codec: "eac3", default: true }] })), "E-AC3 audio: with the hub away, the copy plays only if this phone can decode it.");
  assert.match(downloadCaution(movie({ audioTracks: [{ stream: 0, codec: "ac3" }] })), /^AC3 audio/);
  assert.match(downloadCaution(movie({ audioTracks: [{ stream: 0, codec: "dts" }] })), /^DTS audio/);
  assert.match(downloadCaution(movie({ audioTracks: [{ stream: 0, codec: "truehd" }] })), /^TrueHD audio/);
  assert.equal(downloadBlock(movie({ path: "movies/Heat (1995).mkv" }), "ios"), "MKV files can’t play from a copy on this iPhone. Streaming works.");
  assert.equal(downloadBlock(movie({ path: "movies/Heat (1995).mkv" }), "android"), "", "Android plays an MKV with a phone-friendly audio track");
  assert.equal(downloadBlock({ kind: "show", path: "x" }, "android"), "");
  assert.deepEqual(downloadTile(null, true), { label: "Download", icon: "download", action: "start" });
  assert.deepEqual(downloadTile(null, false), { label: "Stream only", icon: "download", action: "none", disabled: true });
  assert.deepEqual(downloadTile({ state: "queued", size: 100, done: 43 }, true), { label: "43%", icon: "download", action: "cancel", ring: true });
  assert.equal(downloadTile({ state: "waiting", size: 100, done: 43 }, true).label, "Waiting");
  assert.deepEqual(downloadTile({ state: "done" }, false), { label: "Downloaded", icon: "check-circle", action: "manage" });
  assert.equal(downloadTile({ state: "failed" }, true).label, "Try again");
  assert.equal(downloadTile({ state: "stale" }, true).label, "Download again");
  assert.equal(downloadNote(null, true, movie({}), "android"), "", "the permanent note is gone");
  assert.equal(downloadNote({ state: "queued", size: 1, done: 0 }, true, movie({}), "android"), DOWNLOAD_NOTE, "it shows while a download runs");
  assert.equal(downloadNote({ state: "failed", error: "Not enough free space" }, true, movie({}), "android"), "Not enough free space");
  assert.match(downloadNote(null, true, movie({ audioTracks: [{ stream: 0, codec: "eac3" }] }), "android"), /^E-AC3 audio: with the hub away/, "an allowed file that needs the converted audio carries the caution");
  assert.match(downloadNote(null, false, movie({ path: "movies/Heat (1995).mkv" }), "ios"), /^MKV files can’t play/);
  assert.equal(downloadNote(null, false, { kind: "movie", path: "movies/x.mp4" }, "android"), NOT_DOWNLOADABLE);
});


test("an episode's chip says Downloaded, Downloading with its percentage for the running row, or Waiting", () => {
  assert.deepEqual(downloadChip({ state: "done", done: 10, size: 10 }), { label: "Downloaded", variant: "self" });
  assert.deepEqual(downloadChip({ state: "queued", running: true, done: 640, size: 1000 }), { label: "Downloading 64%", variant: "hub" });
  assert.deepEqual(downloadChip({ state: "queued", done: 0, size: 1000 }), { label: "Waiting", variant: undefined }, "queued behind the running one");
  assert.deepEqual(downloadChip({ state: "waiting", running: false, done: 400, size: 1000 }), { label: "Waiting", variant: undefined }, "the hub is away");
  assert.equal(downloadChip({ state: "failed" }), null);
  assert.equal(downloadChip(null), null);
});

test("an episode's or movie's sheet offers Download, Cancel download or Remove from this device by its download state", () => {
  assert.deepEqual(downloadAction(null), ["download"]);
  assert.deepEqual(downloadAction({ state: "failed" }), ["download", "remove-download"], "a failed partial retries or leaves the phone");
  assert.deepEqual(downloadAction({ state: "stale" }), ["download", "remove-download"], "a copy of an older version downloads again or leaves the phone");
  assert.deepEqual(downloadAction({ state: "queued", running: true, done: 500, size: 1000 }), ["cancel-download"]);
  assert.deepEqual(downloadAction({ state: "queued", done: 0, size: 1000 }), ["cancel-download"]);
  assert.deepEqual(downloadAction({ state: "waiting", done: 400, size: 1000 }), ["cancel-download"]);
  assert.deepEqual(downloadAction({ state: "done", done: 10, size: 10 }), ["remove-download"]);
});

test("a movie's sheet with an outdated or failed copy lists Download again or Try again, then Remove from this device, before Delete movie…", () => {
  const heat = { id: "m:1", kind: "movie", path: "movies/Heat.mp4", title: "Heat", watched: false };
  for (const [state, label] of [["stale", "Download again"], ["failed", "Try again"]]) {
    const row = { state, done: 1, size: 2 };
    assert.deepEqual(titleActions(heat, downloadAction(row)), ["watched", "download", "remove-download"], state);
    assert.equal(downloadTile(row, true).label, label);
  }
});
