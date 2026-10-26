import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ReplicaStore } from "../apps/mobile/src/replica-store.js";
import { createClient } from "../apps/mobile/src/client.js";
import {
  PART_GRACE,
  acceptsWrites,
  cachedVideoLibrary,
  createArtLoader,
  isVideoFolder,
  markWatched,
  pruneVideoArt,
  pruneVideoLibraries,
  refreshVideoLibrary,
  savePosition,
  videoArtURI,
  videoSource,
  watchPrivateNetwork,
  withQueuedPositions,
} from "../apps/mobile/src/video-sync.js";

const KEY = "a".repeat(64);

test("offline queued progress applies only to the same video content", async () => {
  const item = { kind: "movie", path: "Film.mp4", hash: KEY, position: null, watched: false };
  const library = { items: new Map([["movie", item]]) };
  const row = { at: 123, body: { path: item.path, hash: "b".repeat(64), position: 999, duration: 1000 } };
  const replica = { scope: "hub", store: { videoPositions: async () => [row] } };
  await withQueuedPositions(replica, "volume", library);
  assert.equal(item.watched, false);
  assert.equal(item.position, null);
  row.body.hash = KEY;
  await withQueuedPositions(replica, "volume", library);
  assert.equal(item.watched, true);
});

function sqliteStore(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arca-video-"));
  const db = new DatabaseSync(path.join(root, "replica.sqlite"));
  t.after(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return new ReplicaStore({
    execAsync: async (sql) => db.exec(sql),
    runAsync: async (sql, ...args) => db.prepare(sql).run(...args),
    getFirstAsync: async (sql, ...args) => db.prepare(sql).get(...args) ?? null,
    getAllAsync: async (sql, ...args) => db.prepare(sql).all(...args),
  });
}

const library = (version, title = "Inception") => ({
  version,
  indexing: false,
  movies: [{ id: "m:1", kind: "movie", title, path: "Inception.mkv", hash: "h1", duration: 100 }],
  shows: [],
  other: [],
  continue: [],
  nextUp: [],
});

test("the library is cached per hub and folder for offline listing and refreshed only when its version changes", async (t) => {
  const store = sqliteStore(t);
  await store.init();
  const routes = [];
  let answer = library("1");
  const replica = { scope: "hub-a", store, client: { api: async (route) => (routes.push(route), answer) } };
  assert.equal(await cachedVideoLibrary(replica, "v1"), null);
  const first = await refreshVideoLibrary(replica, "v1");
  assert.equal(first.changed, true);
  assert.equal(first.library.movies[0].title, "Inception");
  assert.equal(routes[0], "/v1/video/library?volume=v1");
  answer = { version: "1", unchanged: true, indexing: false };
  const same = await refreshVideoLibrary(replica, "v1");
  assert.equal(same.changed, false);
  assert.equal(routes[1], "/v1/video/library?volume=v1&version=1", "the saved version lets the hub answer unchanged");
  assert.equal(same.library.movies[0].title, "Inception");
  answer = { version: "1", unchanged: true, indexing: true };
  assert.equal((await refreshVideoLibrary(replica, "v1")).library.indexing, true, "a reading hub is remembered without a full answer");
  answer = library("2", "Interstellar");
  await refreshVideoLibrary(replica, "v1");
  assert.equal((await cachedVideoLibrary(replica, "v1")).movies[0].title, "Interstellar");
  assert.equal(await cachedVideoLibrary({ ...replica, scope: "hub-b" }, "v1"), null, "another hub never sees this cache");
  const saved = await store.videoLibrary("hub-a", "v1");
  assert.equal(saved.value.unchanged, undefined);
  answer = { version: 3 };
  await assert.rejects(refreshVideoLibrary(replica, "v1"), /invalid video library/);
  assert.equal((await cachedVideoLibrary(replica, "v1")).movies[0].title, "Interstellar", "a bad answer keeps the last good list");
});

test("cached libraries go with the hub's video folders, and Erase removes them", async (t) => {
  const store = sqliteStore(t);
  await store.init();
  await store.saveVideoLibrary("hub", "v1", library("1"));
  await store.saveVideoLibrary("hub", "v2", library("1"));
  const catalog = { video: true, volumes: [{ id: "v1", video: true }, { id: "v2" }] };
  assert.equal(isVideoFolder(catalog, "v1"), true);
  assert.equal(isVideoFolder(catalog, "v2"), false);
  assert.equal(isVideoFolder({ volumes: catalog.volumes }, "v1"), false, "an older hub without the capability has no video folders");
  await pruneVideoLibraries({ scope: "hub", store }, catalog);
  assert.ok(await store.videoLibrary("hub", "v1"));
  assert.equal(await store.videoLibrary("hub", "v2"), null);
  await store.reset();
  assert.equal(await store.videoLibrary("hub", "v1"), null);
});

function artReplica(answers) {
  const disk = new Map();
  const calls = [];
  return {
    disk,
    calls,
    replica: {
      scope: "hub",
      client: {
        api: async (route) => {
          calls.push(route);
          const answer = answers(route);
          if (answer instanceof Error) throw answer;
          return answer;
        },
      },
      files: {
        videoArt: (scope, key, size) => path.join("art", `${key}-${size}.jpg`),
        exists: async (uri) => disk.has(uri),
        present: (uri) => disk.has(uri),
        parent: (uri) => path.dirname(uri),
        mkdir: async () => {},
        remove: async (uri) => disk.delete(uri),
        writeBase64: async (uri, data) => disk.set(uri, data),
        replace: async (from, to) => {
          disk.set(to, disk.get(from));
          disk.delete(from);
        },
      },
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

test("art is fetched once per key and size, stored like covers, and a missing one stops being asked", async () => {
  const { replica, disk, calls } = artReplica((route) =>
    route.includes("size=large") ? { unavailable: true } : { data: "data:image/jpeg;base64,QUJD" },
  );
  let loaded = 0;
  const loader = createArtLoader(replica, () => loaded++);
  loader.request("v1", KEY, "small");
  loader.request("v1", KEY, "small");
  loader.request("v1", KEY, "large");
  loader.request("v1", "not-a-key", "small");
  await settle();
  assert.equal(calls.length, 2);
  assert.equal(loaded, 1);
  assert.equal(disk.get(path.join("art", `${KEY}-small.jpg`)), "QUJD");
  assert.equal(videoArtURI(replica, KEY, "large"), path.join("art", `${KEY}-small.jpg`), "large falls back to the small copy");
  loader.request("v1", KEY, "large");
  loader.request("v1", KEY, "small");
  await settle();
  assert.equal(calls.length, 2, "unavailable art and art already on disk are not asked again");
  loader.stop();
  loader.request("v1", "b".repeat(64), "small");
  await settle();
  assert.equal(calls.length, 2);
  assert.equal(videoArtURI(replica, null, "small"), null);
});

function streamingClient({ url, fetcher, resolvePrivateURL }) {
  const secrets = { read: async () => ({ url, token: "secret-token", id: "phone", hubId: "hub" }), write: async () => {}, clear: async () => {} };
  const cache = { read: async () => null, write: async () => {} };
  return createClient({ secrets, cache, fetcher, resolvePrivateURL });
}

test("streaming sends the device token in a header to the hub's media route, and a Tailscale name resolves to its private address", async () => {
  const client = streamingClient({ url: "https://hub.example:8443", fetcher: async () => {} });
  await client.load();
  const item = { path: "Movies/Inception (2010).mkv", hash: "h1" };
  const source = await videoSource({ client, volume: "v1", item, networkType: async () => ({ type: "CELLULAR" }) });
  assert.equal(source.uri, "https://hub.example:8443/v1/video/media?volume=v1&path=Movies%2FInception+%282010%29.mkv&hash=h1");
  assert.deepEqual(source.headers, { Authorization: "Bearer secret-token" });
  assert.equal(source.uri.includes("secret-token"), false, "the token never travels in the URL");
  const tail = streamingClient({ url: "http://casa.tail1234.ts.net:7443", fetcher: async () => {}, resolvePrivateURL: async () => "http://100.101.102.103:7443" });
  await tail.load();
  const resolved = await videoSource({ client: tail, volume: "v1", item, networkType: async () => ({ type: "VPN" }) });
  assert.match(resolved.uri, /^http:\/\/100\.101\.102\.103:7443\/v1\/video\/media\?/);
});

test("a private hub on the local network is never streamed over mobile data", async () => {
  let verified = 0;
  const client = streamingClient({ url: "http://192.168.1.20:7443", fetcher: async () => {}, resolvePrivateURL: async (value) => (verified++, value) });
  await client.load();
  const item = { path: "a.mkv", hash: "h" };
  for (const type of ["CELLULAR", "VPN", "UNKNOWN", null])
    await assert.rejects(
      videoSource({ client, volume: "v1", item, networkType: async () => (type ? { type } : null) }),
      (error) => error.code === "HUB_UNREACHABLE" && /mobile data/.test(error.message),
    );
  await assert.rejects(
    videoSource({ client, volume: "v1", item, networkType: async () => { throw new Error("no module"); } }),
    /mobile data/,
    "an unknown network fails closed",
  );
  assert.equal(verified, 0, "nothing is sent before the network is known");
  const wifi = await videoSource({ client, volume: "v1", item, networkType: async () => ({ type: "WIFI" }) });
  assert.equal(verified, 1);
  assert.match(wifi.uri, /^http:\/\/192\.168\.1\.20:7443\//);
  assert.equal(wifi.lan, true, "a local hub's stream is watched for leaving Wi-Fi");
  const unreachable = streamingClient({ url: "http://192.168.1.20:7443", fetcher: async () => {}, resolvePrivateURL: async () => { throw Object.assign(new Error("Cannot reach"), { code: "HUB_UNREACHABLE" }); } });
  await unreachable.load();
  await assert.rejects(
    videoSource({ client: unreachable, volume: "v1", item, networkType: async () => ({ type: "ETHERNET" }) }),
    { message: "Connect to your hub to watch" },
  );
});

test("an unlinked phone never streams and asks for the hub", async () => {
  const offline = { state: () => ({ connection: null }), stream: async () => assert.fail("no hub request") };
  await assert.rejects(videoSource({ client: offline, volume: "v1", item: { path: "Movies/A.mkv", hash: "h1" }, networkType: async () => null }), { message: "Connect to your hub to watch", code: "HUB_UNREACHABLE" });
});

test("a Movies & TV folder takes no writes on the phone, even when an old copy is still selected", () => {
  const catalog = { video: true, volumes: [{ id: "v1", video: true }, { id: "f1" }] };
  assert.equal(acceptsWrites(catalog, { id: "v1", selected: 1 }), false);
  assert.equal(acceptsWrites(catalog, { id: "f1", selected: 1 }), true);
  assert.equal(acceptsWrites(catalog, { id: "f1", selected: 0 }), false);
});

test("positions and watched marks go to the hub routes from the contract", async () => {
  const calls = [];
  const client = { api: async (route, body) => calls.push([route, body]) };
  const item = { id: "m:1", path: "a.mkv", hash: "h", duration: 600 };
  await savePosition(client, "v1", item, 61.4, 600.2);
  await markWatched(client, "v1", [item, { ...item, path: "b.mkv" }], true);
  assert.deepEqual(calls, [
    ["/v1/video/position", { volume: "v1", path: "a.mkv", hash: "h", position: 61, duration: 600 }],
    ["/v1/video/watched", { volume: "v1", path: "a.mkv", hash: "h", watched: true }],
    ["/v1/video/watched", { volume: "v1", path: "b.mkv", hash: "h", watched: true }],
  ]);
});

test("art dropped while the hub is unreachable is asked again once it is back", async () => {
  let down = true;
  const { replica, calls } = artReplica(() => (down ? Object.assign(new Error("Hub unavailable"), { code: "HUB_UNREACHABLE" }) : { data: "data:image/jpeg;base64,QUJD" }));
  const loader = createArtLoader(replica, () => {}, 1);
  const keys = ["a", "b", "c"].map((letter) => letter.repeat(64));
  for (const key of keys) loader.request("v1", key, "small");
  await settle();
  assert.equal(calls.length, 1, "the queue is dropped after the first unreachable answer");
  down = false;
  for (const key of keys) loader.request("v1", key, "small");
  await settle();
  assert.equal(calls.length, 4, "the dropped keys are no longer marked as queued");
});

test("cached art goes when no cached library uses it, and abandoned half-written files go", async (t) => {
  const store = sqliteStore(t);
  await store.init();
  const keep = "c".repeat(64);
  const still = "d".repeat(64);
  const stale = "e".repeat(64);
  await store.saveVideoLibrary("hub", "v1", {
    version: "1",
    movies: [{ id: "m:1", path: "a.mkv", title: "A", poster: keep }],
    shows: [{ id: "s:1", title: "S", seasons: [{ season: 1, episodes: [{ id: "e:1", path: "s/e1.mkv", episode: 1, still }] }] }],
    other: [],
  });
  const now = Date.now();
  const disk = new Set([`${keep}-small.jpg`, `${keep}-large.jpg.part`, `${still}-large.jpg.part`, `${still}-small.jpg`, `${stale}-large.jpg`, "notes.txt"]);
  const mtimes = { [`${keep}-large.jpg.part`]: now - PART_GRACE - 1, [`${still}-large.jpg.part`]: now - 1000 };
  const replica = {
    scope: "hub",
    store,
    files: {
      videoArts: () => "art",
      videoArt: (scope, key, size) => path.join("art", `${key}-${size}.jpg`),
      exists: async () => true,
      listNames: async () => [...disk],
      remove: async (uri) => disk.delete(path.basename(uri)),
      stat: async (uri) => (disk.has(path.basename(uri)) ? { size: 1, mtime: mtimes[path.basename(uri)] } : null),
    },
  };
  await pruneVideoArt(replica, now);
  assert.deepEqual([...disk].sort(), [`${keep}-small.jpg`, `${still}-large.jpg.part`, `${still}-small.jpg`, "notes.txt"].sort(), "a file the art loader is still writing stays");
});

test("streaming from a local hub stops when the phone leaves Wi-Fi or Ethernet", () => {
  let listener = null;
  let removed = 0;
  const subscribe = (next) => ((listener = next), { remove: () => removed++ });
  let left = 0;
  const stop = watchPrivateNetwork({ lan: true }, subscribe, () => left++);
  listener({ type: "WIFI" });
  listener({ type: "ETHERNET" });
  listener({ type: "UNKNOWN" });
  listener({ type: "VPN", isConnected: true });
  assert.equal(left, 0, "a handover's transient state does not stop playback");
  listener({ type: "CELLULAR" });
  listener({ type: "NONE" });
  assert.equal(left, 1, "playback stops once");
  stop();
  assert.equal(removed, 1);
  let subscribed = false;
  watchPrivateNetwork({ lan: false }, () => ((subscribed = true), null), () => {});
  watchPrivateNetwork({ local: true }, () => ((subscribed = true), null), () => {});
  assert.equal(subscribed, false, "HTTPS, Tailscale and local copies are not watched");
  for (const event of [{ type: "NONE" }, { type: "WIFI", isConnected: false }]) {
    let stopped = 0;
    let send;
    watchPrivateNetwork({ lan: true }, (next) => ((send = next), null), () => stopped++);
    send(event);
    assert.equal(stopped, 1, JSON.stringify(event));
  }
});
