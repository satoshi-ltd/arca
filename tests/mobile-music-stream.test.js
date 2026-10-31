import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ReplicaStore } from "../apps/mobile/src/replica-store.js";
import { DOWNLOAD_NAME, MISMATCH, downloadAction } from "../apps/mobile/src/video-downloads.js";
import { AUDIO_KIND, audioActions, audioRows, audioTargets, createAudioDownloads } from "../apps/mobile/src/audio-downloads.js";
import { folderLibrary, localLibrary, refreshMusic, streamedKey, streamedMusic } from "../apps/mobile/src/music-sync.js";
import { musicMenu, nativeLibrary } from "../apps/mobile/src/music-library.js";
import { selectFirstFolders } from "../apps/mobile/src/onboarding.js";
import { Replica } from "../apps/mobile/src/replica.js";
import { stopStreaming } from "../apps/mobile/src/confirm-copy.js";

const read = (file) => fs.readFileSync(new URL(`../apps/mobile/${file}`, import.meta.url), "utf8");
const sha = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");
const HUB = "https://hub.example:8443";

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arca-stream-"));
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
    audioDownload(scope, volume, name) {
      if (!DOWNLOAD_NAME.test(name)) throw new Error("Invalid download");
      return path.join(storage, scope, "audio-downloads", volume, name);
    },
    parent: (uri) => path.dirname(uri),
    mkdir: async (uri) => fs.mkdirSync(uri, { recursive: true }),
    exists: async (uri) => fs.existsSync(uri),
    present: (uri) => fs.existsSync(uri),
    stat: async (uri) => (fs.existsSync(uri) ? { size: fs.statSync(uri).size } : null),
    free: async () => 64 * 1024 * 1024 * 1024,
    async write(uri, data, offset = 0) {
      fs.mkdirSync(path.dirname(uri), { recursive: true });
      const fd = fs.openSync(uri, fs.existsSync(uri) ? "r+" : "w+");
      try {
        fs.writeSync(fd, data, 0, data.length, offset);
      } finally {
        fs.closeSync(fd);
      }
    },
    read: async (uri, offset, length) => new Uint8Array(fs.readFileSync(uri).subarray(offset, offset + length)),
    remove: async (uri) => fs.rmSync(uri, { force: true }),
    async move(from, to) {
      fs.renameSync(from, to);
    },
    hash: async (uri) => sha(fs.readFileSync(uri)),
    work: (scope, volume, at) => path.join(storage, scope, "folders", volume, ...at.split("/")),
    text: async (uri) => fs.readFileSync(uri, "utf8"),
    listNames: async (uri) => fs.readdirSync(uri),
    removeAudioDownloads: async (scope, volume) => fs.rmSync(path.join(storage, scope, "audio-downloads", volume), { recursive: true, force: true }),
  };
  return { store, files };
}

const tracks = (one, two) => [
  { path: "Ann/First/1.mp3", hash: sha(one), size: one.length, rev: 3, title: "One", artist: "Ann", album: "First", track: 1 },
  { path: "Ann/First/2.mp3", hash: sha(two), size: two.length, rev: 4, title: "Two", artist: "Ann", album: "First", track: 2 },
];

function hub(content, library) {
  const calls = [];
  const client = {
    fileTransfers: false,
    state: () => ({
      connection: { linked: true, url: HUB },
      catalog: { music: true, volumes: [{ id: "v", name: "music", music: true }] },
    }),
    async raw(route, options) {
      calls.push(route);
      const query = new URLSearchParams(route.split("?")[1]);
      const body = content.get(query.get("path"));
      const [, from, to] = /bytes=(\d+)-(\d+)/.exec(options.headers.Range).map(Number);
      const part = body.subarray(from, to + 1);
      return {
        status: 206,
        headers: { get: (name) => (name === "content-range" ? `bytes ${from}-${to}/${body.length}` : null) },
        arrayBuffer: async () => part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength),
      };
    },
    async api(route) {
      calls.push(route);
      if (route.startsWith("/v1/music/library")) return library();
      throw new Error(`unexpected ${route}`);
    },
  };
  return { client, calls };
}

const settled = async (downloads, volume, at) => {
  for (let i = 0; i < 500; i++) {
    const row = downloads.get(volume, at);
    if (row && row.state !== "queued") return row;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("download did not settle");
};

test("an audio download reads the hub's music media, verifies the whole content hash and stays in app storage", async (t) => {
  const { store, files } = setup(t);
  await store.init();
  const one = crypto.randomBytes(3000);
  const two = crypto.randomBytes(2000);
  const list = tracks(one, two);
  const { client, calls } = hub(new Map([[list[0].path, one], [list[1].path, two]]), () => ({ version: "1", tracks: list }));
  const replica = { scope: "hub-a", store, files, client };
  const downloads = createAudioDownloads({ replica, client, chunk: 1024 });
  await downloads.add("v", [list[0]]);
  const row = await settled(downloads, "v", list[0].path);
  assert.equal(row.state, "done");
  assert.ok(calls.every((route) => route.startsWith("/v1/music/media?")), "never the video route");
  assert.deepEqual(fs.readFileSync(files.audioDownload("hub-a", "v", `${list[0].hash}.mp3`)), one);
  assert.deepEqual((await store.audioDownloads("hub-a")).map((entry) => entry.path), [list[0].path]);
  assert.deepEqual(await store.videoDownloads("hub-a"), [], "audio rows keep their own table");

  const wrong = { ...list[1], hash: sha(Buffer.from("other")) };
  await downloads.add("v", [wrong]);
  const failed = await settled(downloads, "v", wrong.path);
  assert.equal(failed.state, "failed");
  assert.equal(failed.error, MISMATCH, "bytes that do not hash to the track are never kept");

  await downloads.prune("v", { tracks: [list[1]], indexing: false });
  assert.equal(downloads.get("v", list[0].path), null, "a track the hub's complete library no longer lists drops its download");
  assert.equal(fs.existsSync(files.audioDownload("hub-a", "v", `${list[0].hash}.mp3`)), false);
  await downloads.stop();
});

test("a streamed library reads the hub's answer whole online, only its downloads offline, and publishes local or hub URIs", async (t) => {
  const { store, files } = setup(t);
  await store.init();
  const one = crypto.randomBytes(1000);
  const two = crypto.randomBytes(1000);
  const list = tracks(one, two);
  const { client } = hub(new Map([[list[0].path, one]]), () => ({ version: "1", tracks: list }));
  const replica = { scope: "hub-a", store, files, client, hubUnavailable: false };
  await store.saveMusicLibrary("hub-a", "v", { version: "1", tracks: list, playlists: [{ path: "Playlists/Mix.m3u8", name: "Mix", entries: [list[0].path] }] });
  assert.equal((await folderLibrary(replica, "v")).streamed, undefined, "a library not started stays as it was");
  await store.set(streamedKey("hub-a"), ["v"]);
  const downloads = createAudioDownloads({ replica, client, chunk: 4096 });
  await downloads.add("v", [list[0]]);
  await settled(downloads, "v", list[0].path);

  const online = await folderLibrary(replica, "v", true);
  assert.equal(online.streamed, true);
  assert.equal(online.library.tracks.size, 2, "no Downloading dim while the hub answers");
  assert.equal(online.library.pending.size, 0);
  assert.equal([...online.library.playlists.values()][0].editable, false, "playlists are read-only while streaming");
  const offline = await folderLibrary(replica, "v", false);
  assert.deepEqual([...offline.library.tracks.values()].map((track) => track.path), [list[0].path]);
  assert.deepEqual([...offline.library.pending.values()].map((track) => track.path), [list[1].path]);

  const published = nativeLibrary(await localLibrary(replica, [], await streamedMusic(replica)), "hub-a");
  const [local, remote] = published.tracks;
  assert.equal(local.uri, files.audioDownload("hub-a", "v", `${list[0].hash}.mp3`));
  assert.equal(local.stream, undefined);
  assert.equal(remote.uri, `${HUB}/v1/music/media?volume=v&path=Ann%2FFirst%2F2.mp3&hash=${list[1].hash}`);
  assert.equal(remote.stream, true);
  assert.doesNotMatch(JSON.stringify(published), /Bearer|token/i, "the library file never carries the credential");
  await downloads.stop();
});

test("the cycle reads streamed libraries from the hub and prunes their downloads only from a complete answer", async (t) => {
  const { store, files } = setup(t);
  await store.init();
  const one = crypto.randomBytes(500);
  const two = crypto.randomBytes(500);
  const list = tracks(one, two);
  let answer = { version: "1", tracks: list };
  const { client, calls } = hub(new Map([[list[0].path, one]]), () => answer);
  const replica = { scope: "hub-a", store, files: { ...files, musicLibrary: undefined }, client, check() {} };
  await store.set(streamedKey("hub-a"), ["v"]);
  replica.files.musicLibrary = () => path.join(os.tmpdir(), "unused.json");
  replica.files.musicCovers = () => path.join(os.tmpdir(), "arca-no-covers");
  const downloads = createAudioDownloads({ replica, client, chunk: 4096 });
  replica.audioDownloads = downloads;
  await downloads.add("v", [list[0]]);
  await settled(downloads, "v", list[0].path);
  await refreshMusic(replica, { covers: false });
  assert.ok(calls.includes("/v1/music/library?volume=v"), "a streamed folder is read like a kept one");
  assert.equal((await store.musicLibrary("hub-a", "v")).value.tracks.length, 2);
  answer = { version: "2", tracks: [list[1]], indexing: true };
  replica.musicRefreshed = 0;
  await refreshMusic(replica, { covers: false });
  assert.equal(downloads.get("v", list[0].path)?.state, "done", "a library still indexing removes nothing");
  answer = { version: "3", tracks: [list[1]] };
  replica.musicRefreshed = 0;
  await refreshMusic(replica, { covers: false });
  assert.equal(downloads.get("v", list[0].path), null);
  await downloads.stop();
});

test("Start streaming records the folder without selecting it, and Stop syncing forgets its downloads and the flag", async (t) => {
  const { store, files } = setup(t);
  await store.init();
  const one = crypto.randomBytes(800);
  const list = tracks(one, one);
  const { client } = hub(new Map([[list[0].path, one]]), () => ({ version: "1", tracks: list }));
  const changes = [];
  const replica = Object.assign(Object.create(Replica.prototype), {
    scope: "hub-a",
    store,
    files,
    client,
    player: null,
    requireActiveReplica: async () => {},
    changed: () => changes.push("changed"),
  });
  await replica.streamMusic({ id: "v", name: "music" });
  await replica.streamMusic({ id: "v", name: "music" });
  assert.deepEqual(await store.get(streamedKey("hub-a")), ["v"]);
  assert.equal(await store.folder("hub-a", "v"), null, "nothing is selected, so no file of it syncs");
  await assert.rejects(replica.streamMusic({ id: "x", name: "docs" }), /Only Audio libraries/);
  await store.saveMusicLibrary("hub-a", "v", { version: "1", tracks: list });
  const downloads = createAudioDownloads({ replica, client, chunk: 4096 });
  replica.audioDownloads = downloads;
  await downloads.add("v", [list[0]]);
  await settled(downloads, "v", list[0].path);
  await replica.stopStreaming("v");
  assert.deepEqual(await store.get(streamedKey("hub-a")), []);
  assert.deepEqual(await store.audioDownloads("hub-a"), []);
  assert.equal(fs.existsSync(files.audioDownload("hub-a", "v", `${list[0].hash}.mp3`)), false);
  assert.equal(await store.musicLibrary("hub-a", "v"), null);
  await downloads.stop();
});

test("Stop syncing a streamed library asks only about what this phone downloaded", () => {
  assert.deepEqual(stopStreaming({ name: "music", files: 0, size: 0 }), {
    title: "Stop syncing “music”?",
    message: "Stops streaming it here. Hub files and history are kept.",
    label: "Stop syncing",
    icon: "unlink",
    destructive: true,
  });
  assert.match(stopStreaming({ name: "music", files: 12, size: 1024 * 1024 }).message, /^12 files · 1(\.0)? MB downloaded on this phone will be deleted\./);
  assert.equal(stopStreaming({ name: "music", files: 12, size: 1 }).label, "Stop syncing and delete");
});

test("onboarding starts each folder in its chosen mode and counts only what downloads", async () => {
  const done = [];
  const replica = {
    space: async (bytes) => done.push(`space ${bytes}`),
    select: async (volume) => done.push(`select ${volume.id}`),
    streamMusic: async (volume) => done.push(`stream ${volume.id}`),
    startVideo: async (volume, mode, platform) => done.push(`${mode} video ${volume.id}${platform ? ` ${platform}` : ""}`),
    keptBytes: async (volume) => volume.bytes - 15,
    store: { set: async () => {} },
  };
  const catalog = {
    music: true,
    video: true,
    volumes: [{ id: "a", bytes: 10, music: true }, { id: "b", bytes: 5 }, { id: "c", bytes: 7, music: true }, { id: "m", bytes: 100, video: true }, { id: "k", bytes: 40, video: true }],
  };
  await selectFirstFolders(replica, catalog, ["a", "b", "c", "m", "k"], { a: "stream", b: "keep", c: "keep", m: "stream", k: "keep" }, "ios");
  assert.deepEqual(done, ["space 37", "stream a", "select b", "select c", "stream video m ios", "keep video k ios"], "a kept Movies & TV library counts only what this phone can play");
  done.length = 0;
  await selectFirstFolders(replica, catalog, ["c", "b"]);
  assert.deepEqual(done, ["space 12", "select c", "select b"], "without a choice every folder is kept");
});

test("album, artist and show actions offer each download action their tracks need", () => {
  const library = {
    tracks: new Map([["t1", { id: "t1", path: "a" }], ["t2", { id: "t2", path: "b" }]]),
    pending: new Map([["t3", { id: "t3", path: "c" }]]),
    albums: new Map([["album:1", { rows: ["t1", "t2"] }], ["album:2", { rows: ["t3"] }]]),
    shows: new Map([["show:1", { rows: ["t3", "t1"] }]]),
    artists: [{ id: "artist:1", albums: ["album:1", "album:2"] }],
    playlists: new Map([["playlist:1", { editable: true }]]),
  };
  assert.deepEqual(audioTargets(library, "album", "album:1").map((track) => track.id), ["t1", "t2"]);
  assert.deepEqual(audioTargets(library, "artist", "artist:1").map((track) => track.id), ["t1", "t2", "t3"], "an artist covers all its albums");
  assert.deepEqual(audioTargets(library, "show", "show:1").map((track) => track.id), ["t3", "t1"], "a show covers every episode");
  const rows = new Map([
    ["v\na", { path: "a", hash: "h", state: "done" }],
    ["v\nb", { path: "b", hash: "h", state: "queued" }],
  ]);
  const shown = audioRows(rows, "v", [{ path: "a", hash: "h" }, { path: "b", hash: "h" }, { path: "c", hash: "h" }]);
  assert.deepEqual(audioActions(shown), ["download", "cancel-download", "remove-download"]);
  assert.deepEqual(audioActions(shown.slice(0, 1)), ["remove-download"]);
  assert.equal(audioRows(rows, "v", [{ path: "a", hash: "new" }])[0].state, "stale", "a changed track downloads again");
  assert.deepEqual(downloadAction(null), ["download"], "a track's sheet holds the same single action");
  assert.deepEqual(musicMenu({ kind: "album", id: "album:1" }, library, true), { kind: "album", id: "album:1" });
  assert.equal(musicMenu({ kind: "album", id: "album:1" }, library, false), null, "a kept library shows none of this");
  assert.deepEqual(musicMenu({ kind: "playlist", id: "playlist:1" }, library, false), { kind: "playlist", id: "playlist:1" });
  assert.equal(AUDIO_KIND.paths({ tracks: [], indexing: false }), null, "an empty answer is a missing disk, not tracks leaving");
});

test("streamed library screens: Start streaming, the downloaded-only caption, the page ⋯ and the row glyph", () => {
  const app = read("src/App.jsx");
  const library = read("src/MusicLibrary.jsx");
  assert.match(app, /const selectMedia = shownSheet\?\.kind === "select" \? mediaKind\(catalog, shownSheet\.volume, playerAvailable\) : null;/, "the iPhone, without the player, keeps an Audio library");
  assert.match(app, /const selectMode = shownSheet\?\.mode \|\| \(selectMedia \? defaultMode\(selectMedia\) : "keep"\);/);
  const select = app.slice(app.indexOf('{shownSheet.kind === "select" && ('), app.indexOf('{shownSheet.kind === "conflict" && ('));
  assert.match(select, /\{!!selectMedia && \(\s+<SegmentedControl\s+fit\s+options=\{\[\s+\{ value: "stream", label: "Stream" \},\s+\{ value: "keep", label: "Keep" \},\s+\]\}\s+value=\{selectMode\}\s+onChange=\{\(value\) => setSheet\(\{ \.\.\.shownSheet, mode: value \}\)\}/);
  assert.match(select, /<Card title="Stream from the hub">[\s\S]{0,200}"Download titles to watch offline\."\s+: "Download tracks or albums to listen offline\."[\s\S]{0,200}label="Start streaming"\s+icon="play"[\s\S]{0,300}if \(selectMedia === "video"\) await engine\.current\.startVideo\(shownSheet\.volume, "stream", Platform\.OS\);\s+else await engine\.current\.streamMusic\(shownSheet\.volume\);/);
  assert.match(select, /<Card title=\{selectMedia \? "Keep on this phone" : "Start syncing"\}>[\s\S]{0,200}"Every movie and episode, new ones too\."[\s\S]{0,120}"A full copy that syncs both ways\."[\s\S]{0,120}"Download this folder and keep it in sync\."[\s\S]{0,300}`Needs \$\{bytes\(selectNeeds\)\} · `/);
  assert.match(select, /label="Start syncing"\s+icon="refresh"[\s\S]{0,200}if \(selectMedia === "video"\) await engine\.current\.startVideo\(shownSheet\.volume, "keep", Platform\.OS\);\s+else await engine\.current\.select\(shownSheet\.volume\);/);
  assert.match(app, /saved\.length \? `\$\{fileCount\(saved\.length\)\} · \$\{bytes\(saved\.reduce\(\(total, row\) => total \+ \(row\.size \|\| 0\), 0\)\)\} local` : "Streams from hub"/, "its Folders caption counts only what is downloaded");
  assert.match(app, /\{!audioStreaming && !videoStarted && \(\s+<View style=\{s\.actionGroup\}>/, "its folder ⋯ holds only Stop syncing…");
  assert.match(app, /if \(audioStreaming\) \{\s+confirm\(\s+confirmCopy\.stopStreaming\(/);
  assert.match(app, /await client\.api\("\/v1\/delete-file", \{ volume: track\.folder, path: track\.path, rev: track\.rev \}\);/, "Delete… goes to the hub with the library row's revision");
  assert.match(app, /collectionActions=\{musicCollectionSheet\}\s+streamed=\{audioStreaming\}\s+download=\{audioStreaming \? audioDownload : undefined\}/);
  assert.match(library, /menu=\{streamed \? \(\) => collectionActions\(\{ kind: "album", id: album\.id \}\) : undefined\}\s+menuLabel="Album actions"/);
  assert.match(library, /menu=\{streamed \? \(\) => collectionActions\(\{ kind: "show", id: show\.id \}\) : undefined\}\s+menuLabel="Show actions"/);
  assert.match(library, /\{wide && streamed && \(\s+<Button iconOnly label="Artist actions" icon="more" onPress=\{\(\) => collectionActions\(\{ kind: "artist", id: artist\.id \}\)\} \/>/, "the Fold pane keeps the ⋯ after its actions");
  const list = library.slice(library.indexOf("function TrackList("), library.indexOf("const readyRows"));
  assert.match(list, /const glyph = download \? downloadGlyph\(download\(track\)\) : null;/);
  assert.match(list, /<\/View>\s+<DownloadGlyph glyph=\{glyph\} \/>\s+\{!numbered && current && <NowGlyph \/>\}/, "the glyph follows the row's text");
  const sheet = library.slice(library.indexOf("const DOWNLOAD_ACTIONS"), library.indexOf("const playingTrack"));
  assert.match(sheet, /download: \["Download", "download"\],\s+"cancel-download": \["Cancel download", "x"\],\s+"remove-download": \["Remove from this device", "phone"\],/);
  assert.ok(sheet.indexOf("label=\"Add to playlist…\"") < sheet.indexOf("<DownloadActions names={saving}") && sheet.indexOf("<DownloadActions names={saving}") < sheet.indexOf('label="Delete…"'), "the track's action sits after Add to playlist… and before Delete…");
  assert.doesNotMatch(sheet, /confirm/, "Remove from this device asks nothing");
});

test("Android plays hub URLs through Media3 with the credential held only in memory", () => {
  const app = read("src/App.jsx");
  const service = read("modules/arca-network/android/src/main/java/expo/modules/arcanetwork/MusicService.kt");
  const hubFile = read("modules/arca-network/android/src/main/java/expo/modules/arcanetwork/MusicHub.kt");
  const module = read("modules/arca-network/android/src/main/java/expo/modules/arcanetwork/ArcaNetworkModule.kt");
  assert.match(app, /client\s+\.stream\("\/v1\/music\/media"\)\s+\.then\(\(\{ uri, headers \}\) => active && player\.hub\(uri\.slice\(0, uri\.indexOf\("\/v1\/"\)\), headers\.Authorization\)\)/);
  assert.match(app, /if \(!replica\?\.scope \|\| !musicOnline \|\| !status\.streamed\) \{\s+player\.hub\(null, null\)/, "without the hub the service forgets the credential, so stream tracks leave the playable set");
  assert.match(read("src/music-player.js"), /if \(typeof native\.musicHub === "function"\) await native\.musicHub\(url \|\| "", authorization \|\| ""\);/);
  assert.match(module, /AsyncFunction\("musicHub"\) \{ url: String, authorization: String ->\s+if \(MusicHub\.set\(url\.ifEmpty \{ null \}, authorization\.ifEmpty \{ null \}\)\) MusicService\.instance\?\.hubChanged\(\)/);
  assert.match(service, /ResolvingDataSource\.Factory\(DefaultDataSource\.Factory\(this, DefaultHttpDataSource\.Factory\(\)\)\) \{ spec ->\s+MusicHub\.headers\(spec\.uri\.toString\(\)\)\.takeIf \{ it\.isNotEmpty\(\) \}\?\.let\(spec::withAdditionalHeaders\) \?: spec/);
  assert.match(service, /\.setMediaSourceFactory\(DefaultMediaSourceFactory\(hub\)\)/);
  assert.match(service, /\.setUri\(if \(track\.stream\) Uri\.parse\(track\.path\) else Uri\.fromFile\(File\(track\.path\)\)\)/);
  assert.match(service, /private fun playing\(\) = tree\.streaming\(MusicHub\.ready\)/);
  assert.match(hubFile, /@Volatile private var access: Access\? = null/);
  for (const source of [service, hubFile, module]) assert.doesNotMatch(source, /Log\.|println|SharedPreferences.*authorization/i, "the credential is never logged or stored");
  assert.match(service, /\.setWakeMode\(C\.WAKE_MODE_NETWORK\)/, "a Wi-Fi lock keeps a stream playing with the screen off");
  assert.match(app, /let active = true;\s+client\s+\.stream\("\/v1\/music\/media"\)\s+\.then\(\(\{ uri, headers \}\) => active && player\.hub\(/, "a late answer after going offline never hands the credential over");
  assert.match(app, /return \(\) => \{\s+active = false;\s+\};\s+\}, \[replica, replica\?\.scope, musicOnline, status\.streamed, connection\?\.url\]\);/);
  assert.match(app, /const audioStreaming = musicFolder && streamedSet\.has\(folder\?\.id\) && !locals\.some\(\(f\) => f\.id === folder\.id\);/, "a kept folder is never treated as streamed");
  const gradle = read("modules/arca-network/android/build.gradle");
  assert.doesNotMatch(gradle, /datasource-okhttp/, "the HTTP data source ships with media3-exoplayer");
});

test("a kept library is never streamed or emptied by Stop streaming, and selecting a folder leaves the streamed list", async (t) => {
  const { store, files } = setup(t);
  await store.init();
  const one = crypto.randomBytes(100);
  const { client } = hub(new Map(), () => ({ version: "1", tracks: [] }));
  const replica = Object.assign(Object.create(Replica.prototype), {
    scope: "hub-a",
    store,
    files,
    client,
    player: null,
    requireActiveReplica: async () => {},
    changed() {},
  });
  await store.select("hub-a", { id: "v", name: "music" });
  await store.put("hub-a", { volume: "v", path: "Ann/1.mp3", hash: sha(one), rev: 1 });
  const working = files.work("hub-a", "v", "Ann/1.mp3");
  fs.mkdirSync(path.dirname(working), { recursive: true });
  fs.writeFileSync(working, one);
  await assert.rejects(replica.streamMusic({ id: "v", name: "music" }), /already kept/);
  await store.set(streamedKey("hub-a"), ["v"]);
  await assert.rejects(replica.stopStreaming("v"), /kept on this phone/);
  assert.equal((await store.rows("hub-a", "v")).length, 1, "its synced rows survive");
  assert.deepEqual(fs.readFileSync(working), one, "and so does its working file");
  replica.removing = true;
  await store.folder("hub-a", "v");
  await store.set(streamedKey("hub-a"), ["w"]);
  await assert.rejects(replica.stopStreaming("w"), /Wait for the current operation/);
  replica.removing = false;
  const selecting = Object.assign(Object.create(Replica.prototype), {
    scope: "hub-a",
    store,
    files: { ...files, folder: (scope, volume) => path.join(os.tmpdir(), `arca-select-${process.pid}`, volume), mkdir: async () => {} },
    client,
    requireActiveReplica: async () => {},
    space: async () => {},
    changed() {},
  });
  await store.set(streamedKey("hub-a"), ["x", "w"]);
  await selecting.select({ id: "x", name: "x", bytes: 0 });
  assert.deepEqual(await store.get(streamedKey("hub-a")), ["w"]);
});

test("Stop streaming removes the whole download directory, and a library the catalog dropped leaves the streamed list", async (t) => {
  const { store, files } = setup(t);
  await store.init();
  const { client } = hub(new Map(), () => ({ version: "1", tracks: [] }));
  const replica = Object.assign(Object.create(Replica.prototype), {
    scope: "hub-a",
    store,
    files,
    client,
    player: null,
    requireActiveReplica: async () => {},
    changed() {},
  });
  await store.set(streamedKey("hub-a"), ["v"]);
  const orphan = files.audioDownload("hub-a", "v", `${"c".repeat(64)}.mp3`) + ".part";
  fs.mkdirSync(path.dirname(orphan), { recursive: true });
  fs.writeFileSync(orphan, "x");
  await replica.stopStreaming("v");
  assert.equal(fs.existsSync(path.dirname(orphan)), false);

  await store.set(streamedKey("hub-a"), ["v", "gone"]);
  await store.saveMusicLibrary("hub-a", "gone", { version: "1", tracks: [] });
  const cycle = { scope: "hub-a", store, files: { ...files, musicLibrary: () => path.join(os.tmpdir(), "unused.json") }, client, check() {} };
  await refreshMusic(cycle, { covers: false });
  assert.deepEqual(await store.get(streamedKey("hub-a")), ["v"]);
  assert.equal(await store.musicLibrary("hub-a", "gone"), null);
});

test("audio download errors name a track and never mention Wi-Fi", async (t) => {
  const { store, files } = setup(t);
  await store.init();
  const one = crypto.randomBytes(3000);
  const list = tracks(one, one);
  const { client } = hub(new Map([[list[0].path, one]]), () => ({ version: "1", tracks: list }));
  client.raw = async () => ({ status: 206, headers: { get: () => "bytes 0-0/1" }, arrayBuffer: async () => new ArrayBuffer(0) });
  const downloads = createAudioDownloads({ replica: { scope: "hub-a", store, files, client }, client, chunk: 1024 });
  await downloads.add("v", [list[0]]);
  const row = await settled(downloads, "v", list[0].path);
  assert.equal(row.state, "failed");
  assert.equal(row.error, "The hub did not return the requested part of this track.");
  assert.equal(AUDIO_KIND.syncing, "Waiting for the hub to finish syncing this track.");
  assert.doesNotMatch(read("src/video-downloads.js"), /Wi-Fi/, "downloads run on any network");
  await downloads.stop();
});

function phoneReplica(store, files, client, extra = {}) {
  return Object.assign(Object.create(Replica.prototype), {
    scope: "hub-a",
    store,
    files: { ...files, folder: (scope, volume) => path.join(os.tmpdir(), `arca-select-${process.pid}`, volume), mkdir: async () => {} },
    client,
    player: null,
    requireActiveReplica: async () => {},
    space: async () => {},
    changed() {},
    ...extra,
  });
}

test("keeping a streamed library drops its downloads but keeps the selected folder's rows", async (t) => {
  const { store, files } = setup(t);
  await store.init();
  const one = crypto.randomBytes(400);
  const list = tracks(one, one);
  const { client } = hub(new Map([[list[0].path, one]]), () => ({ version: "1", tracks: list }));
  const replica = phoneReplica(store, files, client);
  await replica.streamMusic({ id: "v", name: "music" });
  const downloads = createAudioDownloads({ replica, client, chunk: 4096 });
  await downloads.add("v", [list[0]]);
  await settled(downloads, "v", list[0].path);
  await downloads.stop();
  const directory = path.dirname(files.audioDownload("hub-a", "v", `${list[0].hash}.mp3`));
  assert.ok(fs.existsSync(directory));
  await store.saveMusicLibrary("hub-a", "v", { version: "1", tracks: list });
  await replica.select({ id: "v", name: "music", bytes: 0 });
  await store.put("hub-a", { volume: "v", path: list[0].path, hash: list[0].hash, rev: 1 });
  assert.deepEqual(await store.audioDownloads("hub-a"), []);
  assert.equal(fs.existsSync(directory), false);
  assert.deepEqual(await store.get(streamedKey("hub-a")), []);
  assert.equal((await store.folder("hub-a", "v")).selected, 1);
  assert.equal((await store.rows("hub-a", "v")).length, 1);
  assert.ok(await store.musicLibrary("hub-a", "v"), "the kept library keeps its saved index");
  await assert.rejects(replica.forgetStreamed("v"), /kept on this phone/, "the selection is checked again right before forgetting");
  assert.ok(await store.musicLibrary("hub-a", "v"));
  replica.removing = true;
  await assert.rejects(replica.select({ id: "w", name: "w", bytes: 0 }), /Wait for the current operation/);
});

test("forgetting a streamed library touches only its saved library and views", async (t) => {
  const { store, files } = setup(t);
  await store.init();
  const { client } = hub(new Map(), () => ({ version: "1", tracks: [] }));
  await store.db.runAsync("INSERT INTO folders(scope,id,name,selected) VALUES(?,?,?,0)", "hub-a", "gone", "gone");
  await store.put("hub-a", { volume: "gone", path: "a.mp3", hash: "h", rev: 1 });
  await store.db.runAsync("INSERT INTO pending VALUES(?,?,?,?)", "hub-a", "gone", "a.mp3", "{}");
  await store.saveMusicLibrary("hub-a", "gone", { version: "1", tracks: [] });
  await store.set(streamedKey("hub-a"), ["gone"]);
  const cycle = { scope: "hub-a", store, files: { ...files, musicLibrary: () => path.join(os.tmpdir(), "unused.json") }, client, check() {} };
  await refreshMusic(cycle, { covers: false });
  assert.deepEqual(await store.get(streamedKey("hub-a")), []);
  assert.equal(await store.musicLibrary("hub-a", "gone"), null);
  assert.ok(await store.folder("hub-a", "gone"));
  assert.equal((await store.rows("hub-a", "gone")).length, 1);
  assert.equal((await store.db.getAllAsync("SELECT * FROM pending WHERE volume='gone'")).length, 1);

  await store.set(streamedKey("hub-a"), ["gone"]);
  await store.saveMusicLibrary("hub-a", "gone", { version: "1", tracks: [] });
  await phoneReplica(store, files, client).stopStreaming("gone");
  assert.equal(await store.musicLibrary("hub-a", "gone"), null);
  assert.equal((await store.rows("hub-a", "gone")).length, 1, "Stop syncing a streamed library never forgets another folder record");
});

test("a failed Stop streaming keeps the folder in the list to retry, and no hub writes no list", async (t) => {
  const { store, files } = setup(t);
  await store.init();
  const { client } = hub(new Map(), () => ({ version: "1", tracks: [] }));
  await store.set(streamedKey("hub-a"), ["v"]);
  const failing = phoneReplica(store, { ...files, removeAudioDownloads: async () => { throw new Error("disk"); } }, client);
  await assert.rejects(failing.stopStreaming("v"), /disk/);
  assert.deepEqual(await store.get(streamedKey("hub-a")), ["v"]);
  await phoneReplica(store, files, client, { scope: null }).forgetStreamed("v");
  assert.equal(await store.get("streamed:null"), null);
});
