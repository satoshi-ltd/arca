import test from "node:test";
import assert from "node:assert/strict";
import { createVideoDownloads } from "../apps/mobile/src/video-downloads.js";
import { keepVideoLibraries, pruneVideoLibraries, refreshVideoLibrary, videoModes, videoModesKey } from "../apps/mobile/src/video-sync.js";
import { normalizeLibrary } from "../apps/mobile/src/video-library.js";
import { Replica } from "../apps/mobile/src/replica.js";

const hash = (n) => String(n).repeat(64).slice(0, 64);

function memoryStore() {
  const values = new Map();
  const downloads = new Map();
  const libraries = new Map();
  return {
    values,
    downloads,
    get: async (key, fallback) => (values.has(key) ? structuredClone(values.get(key)) : fallback),
    set: async (key, value) => void values.set(key, structuredClone(value)),
    videoDownloads: async () => [...downloads.values()],
    saveVideoDownload: async (scope, row) => void downloads.set(`${row.volume}\n${row.path}`, row),
    foreignVideoDownloads: async () => [],
    forgetVideoDownload: async (scope, volume, path) => void downloads.delete(`${volume}\n${path}`),
    videoLibrary: async (scope, volume) => libraries.get(volume) || null,
    saveVideoLibrary: async (scope, volume, value) => void libraries.set(volume, { version: value.version, value }),
    pruneVideoLibraries: async (scope, keep) => {
      for (const id of [...libraries.keys()]) if (!keep.includes(id)) libraries.delete(id);
    },
  };
}

const removed = [];
const files = {
  videoDownload: (scope, volume, name) => `${scope}/${volume}/${name}`,
  remove: async (uri) => void removed.push(uri),
  free: async () => 1000 * 1024 * 1024 * 1024,
};

const raw = {
  version: "1",
  movies: [
    { id: "m1", path: "Movies/Old.mkv", hash: hash(1), size: 10, added: 100 },
    { id: "m2", path: "Movies/New.mp4", hash: hash(2), size: 20, added: 300 },
    { id: "m3", path: "Movies/Started.mp4", hash: hash(3), size: 30, added: 50, position: { position: 40, duration: 100 } },
  ],
  shows: [{ id: "s1", title: "Show", seasons: [{ season: 1, episodes: [{ id: "e1", path: "Shows/S01E01.mp4", hash: hash(4), size: 5, added: 200, episode: 1 }] }] }],
  other: [],
  continue: [],
  nextUp: [],
};

function offlineClient(library = raw) {
  return {
    state: () => ({ connection: null, catalog: { video: true, volumes: [{ id: "v", video: true, bytes: 65 }, { id: "d", bytes: 1 }] } }),
    api: async (route) => {
      if (route.startsWith("/v1/video/library")) return structuredClone(library);
      throw new Error(`unexpected ${route}`);
    },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("Keep queues every movie and episode the phone can play, started titles first and then the newest, once per version", async () => {
  const store = memoryStore();
  const replica = { scope: "hub", store, files };
  const downloads = createVideoDownloads({ replica, client: offlineClient() });
  const library = normalizeLibrary(raw);
  await downloads.keep("v", library, "android");
  await settle();
  const queued = [...store.downloads.values()].sort((a, b) => a.added - b.added || 0);
  assert.deepEqual(new Set(queued.map((row) => row.path)), new Set(["Movies/Started.mp4", "Movies/New.mp4", "Shows/S01E01.mp4", "Movies/Old.mkv"]), "every title but the show itself");
  assert.equal(queued[0].path, "Movies/Started.mp4", "a started title goes first");
  await store.saveVideoDownload("hub", { ...store.downloads.get("v\nMovies/New.mp4"), state: "failed" });
  const before = store.downloads.get("v\nMovies/New.mp4");
  await downloads.keep("v", library, "android");
  assert.equal(store.downloads.get("v\nMovies/New.mp4"), before, "a failed copy of the same file is not queued again on every cycle");
  await downloads.stop();

  const ios = memoryStore();
  const iphone = createVideoDownloads({ replica: { scope: "hub", store: ios, files }, client: offlineClient() });
  await iphone.keep("v", library, "ios");
  assert.equal(ios.downloads.has("v\nMovies/Old.mkv"), false, "the iPhone keeps only files it can play");
  await iphone.keep("v", normalizeLibrary({ ...raw, movies: [], shows: [] }), "ios");
  await iphone.stop();
});

test("a library read keeps only a library in Keep mode, and the cycle reads every kept library", async () => {
  const store = memoryStore();
  const client = offlineClient();
  const replica = { scope: "hub", store, files, client };
  const downloads = createVideoDownloads({ replica, client });
  await store.set(videoModesKey("hub"), { v: "stream" });
  await refreshVideoLibrary(replica, "v", { downloads, platform: "android" });
  assert.equal(store.downloads.size, 0, "a streamed library downloads nothing by itself");
  await store.set(videoModesKey("hub"), { v: "keep" });
  await refreshVideoLibrary(replica, "v", { downloads });
  assert.equal(store.downloads.size, 0, "without the platform nothing is guessed");
  await keepVideoLibraries(replica, downloads, "android");
  assert.equal(store.downloads.size, 4);
  await downloads.stop();
});

test("starting a Movies & TV library records its mode without selecting it, and Stop syncing removes the mode and its downloads", async () => {
  const store = memoryStore();
  const client = offlineClient();
  const changes = [];
  const replica = Object.assign(Object.create(Replica.prototype), {
    scope: "hub",
    store,
    files,
    client,
    requireActiveReplica: async () => {},
    changed: () => changes.push("changed"),
  });
  await replica.startVideo({ id: "v", bytes: 65 }, "stream");
  assert.deepEqual(await videoModes(replica), { v: "stream" });
  await replica.startVideo({ id: "v", bytes: 65 }, "keep");
  assert.deepEqual(await videoModes(replica), { v: "keep" });
  await assert.rejects(replica.startVideo({ id: "d", bytes: 1 }, "keep"), /Only Movies & TV libraries/);
  const tight = Object.assign(Object.create(Replica.prototype), { ...replica, files: { ...files, free: async () => 10 } });
  await assert.rejects(tight.startVideo({ id: "v", bytes: 65 }, "keep"), /Not enough storage/);
  await store.saveVideoDownload("hub", { volume: "v", path: "Movies/New.mp4", hash: hash(2), ext: "mp4", subtitles: [], state: "done" });
  await store.saveVideoDownload("hub", { volume: "w", path: "Movies/Else.mp4", hash: hash(5), ext: "mp4", subtitles: [], state: "done" });
  removed.length = 0;
  await replica.stopVideo("v");
  assert.deepEqual(await videoModes(replica), {});
  assert.deepEqual([...store.downloads.keys()], ["w\nMovies/Else.mp4"], "only this library's downloads go");
  assert.ok(removed.includes(`hub/v/${hash(2)}.mp4`));
  assert.equal(replica.removing, false);
});

test("a library the hub no longer lists as Movies & TV loses its mode", async () => {
  const store = memoryStore();
  const replica = { scope: "hub", store };
  await store.set(videoModesKey("hub"), { v: "keep", gone: "stream" });
  await pruneVideoLibraries(replica, { video: true, volumes: [{ id: "v", video: true }, { id: "gone" }] });
  assert.deepEqual(await videoModes(replica), { v: "keep" });
  await pruneVideoLibraries(replica, { video: true, volumes: [] });
  assert.deepEqual(await videoModes(replica), { v: "keep" }, "an empty answer drops nothing");
});

test("Stop syncing a kept library during a keep cycle leaves no mode and no downloads behind", async () => {
  const store = memoryStore();
  const slow = store.forgetVideoDownload;
  store.forgetVideoDownload = async (...args) => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return slow(...args);
  };
  let release;
  const client = {
    state: () => ({ connection: null, catalog: { video: true, volumes: [{ id: "v", video: true, bytes: 20 }] } }),
    api: async () => {
      await new Promise((resolve) => (release = resolve));
      return structuredClone(raw);
    },
  };
  const replica = Object.assign(Object.create(Replica.prototype), { scope: "hub", store, files, client, requireActiveReplica: async () => {}, changed: () => {} });
  const downloads = createVideoDownloads({ replica, client });
  replica.videoDownloads = downloads;
  await store.set(videoModesKey("hub"), { v: "keep" });
  await store.saveVideoDownload("hub", { volume: "v", path: "Movies/Old.mkv", hash: hash(1), ext: "mkv", subtitles: [], state: "done", done: 10, size: 10, saved: [], added: 0 });
  await downloads.load();
  const cycle = keepVideoLibraries(replica, downloads, "android");
  await new Promise((resolve) => setTimeout(resolve, 1));
  const stop = replica.stopVideo("v");
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await Promise.all([cycle, stop]);
  assert.deepEqual(await videoModes(replica), {});
  assert.deepEqual([...store.downloads.keys()], []);
  await downloads.stop();
});

test("a keep already past its library read waits for removal order: Stop syncing still removes what it queued", async () => {
  const store = memoryStore();
  const client = offlineClient();
  const replica = Object.assign(Object.create(Replica.prototype), { scope: "hub", store, files, client, requireActiveReplica: async () => {}, changed: () => {} });
  const downloads = createVideoDownloads({ replica, client });
  replica.videoDownloads = downloads;
  await store.set(videoModesKey("hub"), { v: "keep" });
  const keeping = downloads.keep("v", normalizeLibrary(raw), "android", async () => (await videoModes(replica)).v === "keep");
  await replica.stopVideo("v");
  await keeping;
  assert.deepEqual([...store.downloads.keys()], []);
  await downloads.stop();
});

test("starting waits for a removal, and Keep on an iPhone needs room only for the files it can play", async () => {
  const store = memoryStore();
  const client = offlineClient();
  const replica = Object.assign(Object.create(Replica.prototype), { scope: "hub", store, files: { ...files, free: async () => 300 * 1024 * 1024 }, client, requireActiveReplica: async () => {}, changed: () => {} });
  replica.removing = true;
  await assert.rejects(replica.startVideo({ id: "v", bytes: 65 }, "stream"), /Wait for the current operation/);
  replica.removing = false;
  assert.equal(await replica.keptBytes({ id: "v", bytes: 65 }, "ios"), 55, "the MKV is left out");
  assert.equal(await replica.keptBytes({ id: "v", bytes: 65 }, "android"), 65);
  assert.equal(await replica.keptBytes({ id: "v", bytes: 65 }), 65);
});

test("the Stop syncing confirmation of a Movies & TV library says what it stops", async () => {
  const { stopVideo } = await import("../apps/mobile/src/confirm-copy.js");
  assert.equal(stopVideo({ name: "kids", files: 0, size: 0, kept: true }).message, "Stops keeping it on this phone. Hub files and history are kept.");
  assert.equal(stopVideo({ name: "kids", files: 0, size: 0, kept: false }).message, "Stops streaming it here. Hub files and history are kept.");
  const counted = stopVideo({ name: "kids", files: 3, size: 1024, kept: true });
  assert.match(counted.message, /^3 files · 1(\.0)? KB downloaded on this phone will be deleted\. Stops keeping it on this phone\./);
  assert.equal(counted.label, "Stop syncing and delete");
});

test("the playable size of a library counts only what this phone can keep", async () => {
  const { playableBytes } = await import("../apps/mobile/src/video-downloads.js");
  const library = normalizeLibrary(raw);
  assert.equal(playableBytes(library, "ios"), 55);
  assert.equal(playableBytes(library, "android"), 65);
  assert.equal(playableBytes(null, "ios"), null, "unknown until the library is read");
});
