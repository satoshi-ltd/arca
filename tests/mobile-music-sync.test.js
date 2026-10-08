import test from "node:test";
import assert from "node:assert/strict";
import { buildLibrary } from "../apps/mobile/src/music-library.js";
import {
  folderLibrary,
  publishMusic,
  readMusicHistory,
  recordMusicPlay,
  refreshMusic,
  renameMusicPlay,
} from "../apps/mobile/src/music-sync.js";

const KEY = "a".repeat(64);
const STALE = "b".repeat(64);
const pause = () => new Promise((resolve) => setTimeout(resolve, 5));

function phone({ cover }) {
  const disk = new Map([[`/covers/${STALE}-small.jpg`, "old"]]);
  const log = [];
  const coverCalls = [];
  const saved = { value: { tracks: [{ path: "a.mp3", hash: "h1", title: "A", cover: KEY }] }, indexing: 0 };
  const replica = {
    scope: "hub",
    player: { reload: async () => log.push("reload") },
    check() {},
    client: {
      state: () => ({ catalog: { music: true, volumes: [{ id: "v", music: true }] } }),
      api: async (route) => {
        if (route.startsWith("/v1/music/library")) return { version: "1", indexing: false, unchanged: true };
        coverCalls.push(route);
        return cover(route);
      },
    },
    store: {
      folders: async () => [{ id: "v", selected: true }],
      get: async () => false,
      musicVersion: async () => ({ version: "1", indexing: 0 }),
      musicLibrary: async () => saved,
      rows: async () => [{ path: "a.mp3", hash: "h1" }],
    },
    files: {
      musicLibrary: () => "/library.json",
      musicHistory: () => "/history.json",
      text: async (uri) => disk.get(uri),
      stat: async (uri) => (disk.has(uri) ? { size: String(disk.get(uri) ?? "").length } : null),
      musicCovers: () => "/covers",
      musicCover: (scope, key, size) => `/covers/${key}-${size}.jpg`,
      work: (scope, id, path) => `/work/${path}`,
      parent: (uri) => uri.slice(0, uri.lastIndexOf("/")),
      exists: async (uri) => uri === "/covers" || disk.has(uri),
      listNames: async (dir) => [...disk.keys()].filter((uri) => uri.startsWith(`${dir}/`)).map((uri) => uri.slice(dir.length + 1)),
      mkdir: async () => {},
      remove: async (uri) => {
        log.push(`remove ${uri}`);
        disk.delete(uri);
      },
      write: async (uri, data) => {
        log.push(`write ${uri}`);
        await pause();
        disk.set(uri, (disk.get(uri) || "") + new TextDecoder().decode(data));
      },
      writeBase64: async (uri, data) => disk.set(uri, data),
      replace: async (from, to) => {
        log.push(`replace ${to}`);
        disk.set(to, disk.get(from));
        disk.delete(from);
      },
    },
  };
  return { replica, disk, log, coverCalls };
}

test("a cover the hub keeps failing neither reloads the open library nor lets stale covers go, and a missing one stops being asked", async () => {
  let failure = 500;
  const { replica, disk, coverCalls } = phone({
    cover: async () => {
      if (failure === "retry") return { retry: true };
      throw Object.assign(new Error("failed"), { status: failure });
    },
  });
  failure = "retry";
  await refreshMusic(replica);
  assert.equal(coverCalls.length, 2);
  assert.ok(disk.has(`/covers/${STALE}-small.jpg`), "a cover the hub will retry keeps the pass incomplete");
  failure = 500;
  await refreshMusic(replica);
  await refreshMusic(replica);
  assert.equal(replica.musicTick, undefined, "nothing new arrived, so the open library is not read again");
  assert.ok(disk.has(`/covers/${STALE}-small.jpg`), "an incomplete pass keeps covers it cannot judge");
  assert.equal(coverCalls.length, 6);
  failure = 404;
  await refreshMusic(replica);
  await refreshMusic(replica);
  assert.equal(coverCalls.length, 8, "a cover the hub does not have is asked once");
  assert.ok(!disk.has(`/covers/${STALE}-small.jpg`), "a complete pass removes covers no library references");
});

test("covers that arrive refresh the open library once", async () => {
  const { replica, disk } = phone({ cover: async () => ({ data: "data:image/jpeg;base64,AAAA" }) });
  await refreshMusic(replica);
  assert.equal(replica.musicTick, 1);
  assert.ok(disk.has(`/covers/${KEY}-small.jpg`) && disk.has(`/covers/${KEY}-large.jpg`));
  await refreshMusic(replica);
  assert.equal(replica.musicTick, 1);
});

const titled = (title) =>
  buildLibrary([
    { id: "v", library: { tracks: [{ path: "a.mp3", hash: "h1", title }] }, present: new Map([["a.mp3", "h1"]]), uri: (path) => `/work/${path}` },
  ]);

test("two publishes of the car library never interleave their writes", async () => {
  const { replica, disk, log } = phone({ cover: async () => ({}) });
  await Promise.all([publishMusic(replica, titled("First")), publishMusic(replica, titled("A much longer second title"))]);
  assert.deepEqual(log, [
    "remove /library.json.part",
    "write /library.json.part",
    "replace /library.json",
    "reload",
    "remove /library.json.part",
    "write /library.json.part",
    "replace /library.json",
    "reload",
  ]);
  const published = JSON.parse(disk.get("/library.json"));
  assert.equal(published.tracks[0].title, "A much longer second title");
});

test("a library the car service failed to load is offered again, even after the catalog changes back", async () => {
  const { replica, disk } = phone({ cover: async () => ({}) });
  await publishMusic(replica, titled("First"));
  let failures = 1;
  const reloads = [];
  replica.player.reload = async () => {
    reloads.push(JSON.parse(disk.get("/library.json")).tracks[0].title);
    if (failures-- > 0) throw new Error("service gone");
  };
  await assert.rejects(publishMusic(replica, titled("Second")), /service gone/);
  await publishMusic(replica, titled("Second"));
  await publishMusic(replica, titled("Second"));
  assert.deepEqual(reloads, ["Second", "Second"], "the same catalog is offered until the service takes it, then once is enough");
  failures = 1;
  await assert.rejects(publishMusic(replica, titled("Third")), /service gone/);
  await publishMusic(replica, titled("Second"));
  assert.deepEqual(reloads.slice(2), ["Third", "Second"], "the file the service reloads from is rewritten too");
});

test("a track that finishes downloading during a partial cycle refreshes the open screen once", async () => {
  const { replica } = phone({ cover: async () => ({}) });
  const saved = await replica.store.musicLibrary();
  saved.value.tracks.push({ path: "b.mp3", hash: "h2", title: "B" });
  const rows = [{ path: "a.mp3", hash: "h1" }];
  replica.store.rows = async () => rows;
  await refreshMusic(replica, { covers: false });
  assert.equal(replica.musicTick, undefined, "the first pass only notes what the phone holds");
  rows.push({ path: "b.mp3", hash: "h2" });
  replica.musicRefreshed = 0;
  await refreshMusic(replica, { covers: false });
  assert.equal(replica.musicTick, 1, "the downloaded track reaches the open library before the cycle completes");
  replica.musicRefreshed = 0;
  await refreshMusic(replica, { covers: false });
  assert.equal(replica.musicTick, 1);
});

test("a hub that cannot be reached ends the music step instead of letting the cycle carry on", async () => {
  const { replica } = phone({ cover: async () => ({}) });
  replica.store.musicVersion = async () => ({ version: "0", indexing: 0 });
  replica.client.api = async () => {
    throw Object.assign(new Error("Hub request timed out"), { code: "HUB_TIMEOUT" });
  };
  await assert.rejects(refreshMusic(replica), { code: "HUB_TIMEOUT" });
  replica.client.api = async () => {
    throw Object.assign(new Error("Hub 500"), { status: 500 });
  };
  await refreshMusic(replica);
});

test("a new library still refreshes the open screen when the cover pass stops", async () => {
  const { replica } = phone({
    cover: async () => {
      throw Object.assign(new Error("paused"), { code: "SYNC_INTERRUPTED" });
    },
  });
  replica.store.musicVersion = async () => ({ version: "0", indexing: 0 });
  replica.store.saveMusicLibrary = async () => {};
  replica.client.api = async (route) => {
    if (route.startsWith("/v1/music/library")) return { version: "1", indexing: false, tracks: [] };
    throw Object.assign(new Error("paused"), { code: "SYNC_INTERRUPTED" });
  };
  await refreshMusic(replica);
  assert.equal(replica.musicTick, 1);
});

test("the phone's own renames and deletions show in the library, its playlists and the car's file before the hub hears of them", async () => {
  const { replica, disk } = phone({ cover: async () => ({}) });
  const saved = await replica.store.musicLibrary();
  saved.value.tracks = [
    { path: "a.mp3", hash: "h1", title: "A" },
    { path: "b.mp3", hash: "h2", title: "B" },
    { path: "c.mp3", hash: "h3", title: "C" },
  ];
  saved.value.playlists = [
    { path: "Playlists/Hub only.m3u8", name: "Hub only", hash: "p1", entries: ["a.mp3"] },
    { path: "Playlists/Other.m3u8", name: "Other", hash: "p2", entries: ["b.mp3"] },
  ];
  replica.store.rows = async () => [
    { path: "a.mp3", hash: "h1" },
    { path: "b.mp3", hash: "h2" },
    { path: "c.mp3", hash: "h3" },
  ];
  let journal = [];
  replica.store.get = async (key) => (key === "journal:hub:v" ? journal : false);
  const titles = async () => {
    const { library } = await folderLibrary(replica, "v");
    return [...library.tracks.values()].map((track) => track.path.replace(/^.*:/, "")).sort();
  };
  assert.deepEqual(await titles(), ["a.mp3", "b.mp3", "c.mp3"]);
  journal = [
    { kind: "rename", from: "a.mp3", to: "renamed.mp3", seq: 1 },
    { kind: "remove", path: "b.mp3", seq: 2 },
    { kind: "remove", path: "Playlists/Hub only.m3u8", seq: 3 },
    { kind: "rename", from: "renamed.mp3", to: "again.mp3", seq: 4 },
  ];
  assert.deepEqual(await titles(), ["again.mp3", "c.mp3"], "a renamed track moves (again and again) and a deleted one leaves");
  const { library } = await folderLibrary(replica, "v");
  assert.deepEqual([...library.playlists.values()].map((list) => list.name).sort(), ["Other"], "a playlist deleted on the phone leaves the list the hub described");
  await publishMusic(replica);
  const car = JSON.parse(disk.get("/library.json"));
  assert.deepEqual(car.tracks.map((track) => track.uri).sort(), ["/work/again.mp3", "/work/c.mp3"], "the car plays the renamed file and never the deleted one");
  journal = [];
  assert.deepEqual(await titles(), ["a.mp3", "b.mp3", "c.mp3"], "once the hub has the changes the journal is empty and its own answer rules");
});

test("an iPhone records what it opens in the same history file, one write at a time", async () => {
  const { replica, disk } = phone({ cover: async () => ({}) });
  assert.deepEqual(await readMusicHistory(replica), []);
  await Promise.all([recordMusicPlay(replica, "album:a"), recordMusicPlay(replica, "album:b")]);
  assert.deepEqual(JSON.parse(disk.get("/history.json")), { format: 1, scope: "hub", items: ["album:b", "album:a"] });
  assert.deepEqual(await readMusicHistory(replica), ["album:b", "album:a"]);
  replica.scope = "other";
  assert.deepEqual(await readMusicHistory(replica), [], "another hub's history is ignored");
});

test("the library reads this phone's own playlist files, so an edit made offline shows and reaches the car at once", async () => {
  const { replica, disk } = phone({ cover: async () => ({}) });
  const saved = await replica.store.musicLibrary();
  saved.value.playlists = [
    { path: "Playlists/Mix.m3u8", name: "Mix", hash: "p1", entries: [] },
    { path: "Playlists/Later.m3u8", name: "Later", hash: "p2", entries: ["a.mp3"] },
  ];
  disk.set("/work/Playlists/Mix.m3u8", "#EXTM3U\n#PLAYLIST:Mix\n../a.mp3\n../a.mp3\n");
  disk.set("/work/Playlists/broken.m3u8", null);
  replica.files.exists = async (uri) => uri === "/covers" || uri === "/work/Playlists" || disk.has(uri);
  const read = replica.files.text;
  replica.files.text = async (uri) => {
    if (uri.endsWith("broken.m3u8")) throw new Error("unreadable");
    return read(uri);
  };
  const { library } = await folderLibrary(replica, "v");
  assert.deepEqual(
    library.playlistOrder.map((id) => [library.playlists.get(id).name, library.playlists.get(id).tracks]),
    [["Later", ["v:a.mp3"]], ["Mix", ["v:a.mp3", "v:a.mp3"]]],
    "the phone's copy wins and a playlist not downloaded yet comes from the hub; an unreadable file is skipped",
  );
  await publishMusic(replica);
  assert.deepEqual(JSON.parse(disk.get("/library.json")).playlists.map((playlist) => playlist.tracks), [["v:a.mp3"], ["v:a.mp3", "v:a.mp3"]]);
  replica.files.listNames = async () => {
    throw new Error("listing failed");
  };
  const fallback = await folderLibrary(replica, "v");
  assert.deepEqual(fallback.library.playlistOrder.map((id) => fallback.library.playlists.get(id).tracks.length), [1, 0], "without a listing the hub's answer is shown");
});

test("a renamed playlist keeps its place in the phone's history, once", async () => {
  const { replica, disk } = phone({ cover: async () => ({}) });
  replica.player = null;
  await recordMusicPlay(replica, "playlist:old");
  await recordMusicPlay(replica, "album:a");
  await renameMusicPlay(replica, "playlist:old", "playlist:new");
  assert.deepEqual(await readMusicHistory(replica), ["album:a", "playlist:new"]);
  await renameMusicPlay(replica, "playlist:none", "playlist:x");
  assert.deepEqual(JSON.parse(disk.get("/history.json")).items, ["album:a", "playlist:new"]);
});

test("on Android a renamed playlist's history goes through the media service, which owns the file", async () => {
  const { replica, disk } = phone({ cover: async () => ({}) });
  const renamed = [];
  replica.player.renameHistory = async (from, to) => renamed.push([from, to]);
  await renameMusicPlay(replica, "playlist:old", "playlist:new");
  assert.deepEqual(renamed, [["playlist:old", "playlist:new"]]);
  assert.equal(disk.has("/history.json"), false, "the phone never writes the file the service keeps in memory");
});

test("a playlist the folder's .arcaignore or the fixed list excludes is not read into the library", async () => {
  const { replica } = phone({ cover: async () => ({}) });
  const saved = await replica.store.musicLibrary();
  saved.value.playlists = [];
  const disk = new Map([
    ["/work/.arcaignore", "Playlists/private*\n"],
    ["/work/Playlists/Private mix.m3u8", "../a.mp3\n"],
    ["/work/Playlists/._Mix.m3u8", "../a.mp3\n"],
    ["/work/Playlists/Mix.m3u8", "../a.mp3\n"],
  ]);
  replica.files.exists = async (uri) => uri === "/covers" || uri === "/work/Playlists" || disk.has(uri);
  replica.files.stat = async (uri) => (disk.has(uri) ? { size: disk.get(uri).length } : null);
  replica.files.text = async (uri) => disk.get(uri);
  replica.files.listNames = async () => [...disk.keys()].filter((uri) => uri.startsWith("/work/Playlists/")).map((uri) => uri.split("/").at(-1));
  const { library } = await folderLibrary(replica, "v");
  assert.deepEqual(library.playlistOrder.map((id) => library.playlists.get(id).name), ["Mix"]);
});

test("a playlist file over the size cap is not read into the library", async () => {
  const { replica } = phone({ cover: async () => ({}) });
  const saved = await replica.store.musicLibrary();
  saved.value.playlists = [];
  const disk = new Map([["/work/Playlists/Big.m3u8", "#".repeat(1024 * 1024 + 1)], ["/work/Playlists/Small.m3u8", "../a.mp3\n"]]);
  replica.files.exists = async (uri) => uri === "/covers" || uri === "/work/Playlists" || disk.has(uri);
  replica.files.stat = async (uri) => (disk.has(uri) ? { size: disk.get(uri).length } : null);
  replica.files.text = async (uri) => disk.get(uri);
  replica.files.listNames = async () => [...disk.keys()].map((uri) => uri.split("/").at(-1));
  const { library } = await folderLibrary(replica, "v");
  assert.deepEqual(library.playlistOrder.map((id) => library.playlists.get(id).name), ["Small"]);
});
