import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ReplicaStore } from "../apps/mobile/src/replica-store.js";
import { createVideoDownloads, keptSource, playbackSource } from "../apps/mobile/src/video-downloads.js";
import { pruneVideoLibraries, videoModes, videoModesKey } from "../apps/mobile/src/video-sync.js";
import { Replica } from "../apps/mobile/src/replica.js";
import { quickHashFile } from "../packages/daemon/storage.js";

const hash = (n) => String(n).repeat(64).slice(0, 64);
const catalog = { video: true, volumes: [{ id: "v", name: "kids-shows", video: true, bytes: 30 }, { id: "d", name: "docs", bytes: 1 }] };

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arca-video-keep-"));
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
    folder: (scope, volume) => path.join(storage, scope, "folders", volume),
    work: (scope, volume, at) => path.join(storage, scope, "folders", volume, ...at.split("/")),
    videoDownload: (scope, volume, name) => path.join(storage, scope, "video-downloads", volume, name),
    mkdir: async (uri) => fs.mkdirSync(uri, { recursive: true }),
    exists: async (uri) => fs.existsSync(uri),
    present: (uri) => fs.existsSync(uri),
    stat: async (uri) => (fs.existsSync(uri) ? { size: fs.statSync(uri).size } : null),
    free: async () => 1024 * 1024 * 1024 * 1024,
    remove: async (uri) => fs.rmSync(uri, { force: true }),
    hash: async (uri) => crypto.createHash("sha256").update(fs.readFileSync(uri)).digest("hex"),
    read: async (uri, offset, length) => new Uint8Array(fs.readFileSync(uri).subarray(offset, offset + length)),
  };
  const client = { state: () => ({ connection: null, catalog }) };
  const replica = Object.assign(Object.create(Replica.prototype), {
    scope: "hub",
    store,
    files,
    client,
    requireActiveReplica: async () => {},
    changed: () => {},
  });
  return { store, files, replica, storage };
}

async function download(store, volume, at, state = "done") {
  await store.saveVideoDownload("hub", { volume, path: at, hash: hash(at.length), ext: "mp4", subtitles: [], state, done: 10, size: 10, saved: [], added: 0 });
}

test("Keep selects a Movies & TV library as a complete copy, dropping its stream mode and per-title downloads", async (t) => {
  const { store, replica } = setup(t);
  await store.init();
  await replica.streamVideo(catalog.volumes[0]);
  assert.deepEqual(await videoModes(replica), { v: "stream" });
  await download(store, "v", "Movies/A.mp4");
  await download(store, "w", "Movies/B.mp4");
  await replica.select(catalog.volumes[0]);
  assert.equal((await store.folder("hub", "v")).selected, 1, "selecting a Movies & TV folder is allowed");
  assert.deepEqual(await videoModes(replica), {});
  assert.deepEqual((await store.videoDownloads("hub")).map((row) => row.volume), ["w"], "its per-title downloads give way to the copy");
  await assert.rejects(replica.streamVideo(catalog.volumes[0]), /already kept on this phone/);
  await assert.rejects(replica.stopVideo("v"), /Use Stop syncing to remove its copy/);
});

test("streaming records only the mode, and Stop syncing removes the mode and its downloads", async (t) => {
  const { store, replica } = setup(t);
  await store.init();
  await assert.rejects(replica.streamVideo(catalog.volumes[1]), /Only Movies & TV libraries/);
  replica.removing = true;
  await assert.rejects(replica.streamVideo(catalog.volumes[0]), /Wait for the current operation/);
  replica.removing = false;
  await replica.streamVideo(catalog.volumes[0]);
  assert.equal(await store.folder("hub", "v"), null, "nothing is selected");
  await download(store, "v", "Movies/A.mp4", "queued");
  await replica.stopVideo("v");
  assert.deepEqual(await videoModes(replica), {});
  assert.deepEqual(await store.videoDownloads("hub"), []);
});

test("a library kept the old way keeps its downloads until Stop syncing removes them", async (t) => {
  const { store, replica } = setup(t);
  await store.init();
  await store.set(videoModesKey("hub"), { v: "keep" });
  await download(store, "v", "Movies/A.mp4");
  const downloads = createVideoDownloads({ replica, client: replica.client });
  replica.videoDownloads = downloads;
  await downloads.load();
  assert.equal(downloads.get("v", "Movies/A.mp4").state, "done", "nothing deletes it by itself");
  await replica.stopVideo("v");
  assert.deepEqual(await videoModes(replica), {});
  assert.deepEqual(await store.videoDownloads("hub"), []);
  await downloads.stop();
});

test("a library the hub no longer lists as Movies & TV loses its mode", async (t) => {
  const { store, replica } = setup(t);
  await store.init();
  await store.set(videoModesKey("hub"), { v: "stream", gone: "stream" });
  await pruneVideoLibraries(replica, { video: true, volumes: [{ id: "v", video: true }, { id: "gone" }] });
  assert.deepEqual(await videoModes(replica), { v: "stream" });
  await pruneVideoLibraries(replica, { video: true, volumes: [] });
  assert.deepEqual(await videoModes(replica), { v: "stream" }, "an empty answer drops nothing");
});

test("files of a Movies & TV folder are fingerprinted like the hub; other folders keep the whole-file SHA-256", async (t) => {
  const { files, replica, storage } = setup(t);
  for (const size of [0, 1000, 4 * 1024 * 1024, 9 * 1024 * 1024 + 7]) {
    const file = path.join(storage, `clip-${size}.mp4`);
    fs.mkdirSync(storage, { recursive: true });
    fs.writeFileSync(file, Buffer.alloc(size, size % 251));
    assert.equal(await replica.fingerprint(file, "v"), quickHashFile(file), `size ${size}`);
    assert.equal(await replica.fingerprint(file, "d"), await files.hash(file));
    assert.equal(await replica.fingerprint(file, null), await files.hash(file));
  }
});

test("a kept title plays from the local copy, and a file the iPhone cannot open streams", async (t) => {
  const { files, storage } = setup(t);
  const movie = { path: "Movies/Heat.mp4", hash: hash(1) };
  const mkv = { path: "Movies/Up.mkv", hash: hash(2) };
  assert.equal(keptSource(files, "hub", "v", movie, "android"), null, "a copy that has not arrived yet streams");
  for (const item of [movie, mkv]) {
    fs.mkdirSync(path.dirname(files.work("hub", "v", item.path)), { recursive: true });
    fs.writeFileSync(files.work("hub", "v", item.path), "film");
  }
  assert.deepEqual(keptSource(files, "hub", "v", movie, "ios"), { uri: path.join(storage, "hub", "folders", "v", "Movies", "Heat.mp4"), local: true, lan: false, offset: 0 });
  assert.equal(keptSource(files, "hub", "v", mkv, "ios"), null);
  assert.ok(keptSource(files, "hub", "v", mkv, "android"));
  const kept = keptSource(files, "hub", "v", movie, "android");
  const streamed = { uri: "https://hub/stream" };
  assert.equal(await playbackSource({ downloads: null, kept, volume: "v", item: movie, stream: async () => streamed }), kept);
  assert.equal(await playbackSource({ downloads: null, kept, volume: "v", item: movie, mode: "compatible", stream: async () => streamed }), streamed, "the compatible stream still comes from the hub");
  assert.equal(await playbackSource({ downloads: null, kept: null, volume: "v", item: mkv, stream: async () => streamed }), streamed);
});

test("the Stop syncing confirmation of a streamed Movies & TV library says what it stops", async () => {
  const { stopVideo } = await import("../apps/mobile/src/confirm-copy.js");
  assert.equal(stopVideo({ name: "kids", files: 0, size: 0, kept: false }).message, "Stops streaming it here. Hub files and history are kept.");
  assert.equal(stopVideo({ name: "kids", files: 0, size: 0, kept: true }).message, "Stops keeping it on this phone. Hub files and history are kept.");
  const counted = stopVideo({ name: "kids", files: 3, size: 1024, kept: false });
  assert.match(counted.message, /^3 files · 1(\.0)? KB downloaded on this phone will be deleted\./);
  assert.equal(counted.label, "Stop syncing and delete");
});

test("a kept folder that becomes Movies & TV forgets its cached whole-file hashes once, so its files are fingerprinted instead of downloaded again", async (t) => {
  const { store, replica } = setup(t);
  await store.init();
  replica.hashCache = new Map();
  const record = (volume, at) => ({ size: 4, mtime: 1, hash: hash(9), due: 0, scope: "hub", volume, path: at, uri: `u/${volume}/${at}` });
  for (const [volume, at] of [["v", "Heat.mp4"], ["d", "notes.txt"]]) {
    await store.cacheHash(`u/${volume}/${at}`, record(volume, at));
    replica.hashCache.set(`u/${volume}/${at}`, record(volume, at));
  }
  await replica.matchFingerprint("d");
  assert.ok(await store.cachedHash("u/d/notes.txt"), "an ordinary folder keeps its cache");
  await replica.matchFingerprint("v");
  assert.equal(await store.cachedHash("u/v/Heat.mp4"), null);
  assert.equal(replica.hashCache.has("u/v/Heat.mp4"), false);
  assert.ok(replica.hashCache.has("u/d/notes.txt"));
  await store.cacheHash("u/v/Heat.mp4", record("v", "Heat.mp4"));
  await replica.matchFingerprint("v");
  assert.ok(await store.cachedHash("u/v/Heat.mp4"), "only a change of kind clears it");
});

test("selecting a library kept the old way is refused until Stop syncing removes its downloads", async (t) => {
  const { store, replica } = setup(t);
  await store.init();
  await store.set(videoModesKey("hub"), { v: "keep" });
  await download(store, "v", "Movies/A.mp4");
  await assert.rejects(replica.select(catalog.volumes[0]), /This library is kept on this device\. Stop syncing it to remove its titles\./);
  assert.equal(await store.folder("hub", "v"), null);
  assert.equal((await store.videoDownloads("hub")).length, 1, "nothing is deleted by the refusal");
});
