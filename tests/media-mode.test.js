import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import ffmpeg from "ffmpeg-static";
import { digest, init, Store, SCHEMA_VERSION, token } from "../packages/daemon/storage.js";
import { start } from "../packages/daemon/server.js";
import { VideoDownloads, keptTitles } from "../packages/daemon/video-downloads.js";
import { api, clip, hub, image } from "./video-support.js";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "arca-media-mode-"));
process.on("exit", () => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
let made = 0;
function tone(tags = {}, seconds = 0.6) {
  const output = path.join(scratch, `${made++}.mp3`);
  const args = ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `sine=frequency=${300 + made * 37}:duration=${seconds}`];
  for (const [key, value] of Object.entries(tags)) args.push("-metadata", `${key}=${value}`);
  execFileSync(ffmpeg, [...args, "-id3v2_version", "3", output]);
  return fs.readFileSync(output);
}

async function musicHub(t) {
  const f = await hub(t);
  const music = f.s.addVolume("Music");
  await f.call("/v1/music/mark", { volume: music.id });
  const tracks = {
    "Miles Davis/Kind of Blue/01 So What.mp3": tone({ title: "So What", artist: "Miles Davis", album: "Kind of Blue", track: "1" }),
    "Miles Davis/Kind of Blue/02 Blue in Green.mp3": tone({ title: "Blue in Green", artist: "Miles Davis", album: "Kind of Blue", track: "2" }),
    "Miles Davis/Sketches/01 Saeta.mp3": tone({ title: "Saeta", artist: "Miles Davis", album: "Sketches", track: "1" }),
    "Talks/2026-01-02 Episode.mp3": tone({ title: "Episode", genre: "Podcast", album: "Talks" }),
    "Drafts/demo.mp3": tone({ title: "Demo" }),
  };
  for (const [name, buffer] of Object.entries(tracks)) await f.propose(name, buffer, music.id);
  await f.propose("Miles Davis/Kind of Blue/cover.jpg", await image("red", 400, 400), music.id);
  fs.mkdirSync(path.join(music.path, "Drafts"), { recursive: true });
  fs.writeFileSync(path.join(music.path, ".arcaignore"), "Drafts/\n");
  await f.daemon.engine.cycle();
  const library = async () => {
    for (let i = 0; i < 100; i++) {
      await f.daemon.engine.music?.background;
      const value = await f.call(`/v1/music/library?volume=${music.id}`);
      if (!value.indexing) return value;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("Music index did not finish");
  };
  return { ...f, music, tracks, musicLibrary: library, indexed: await library() };
}

async function replicaOf(t, f, options = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-media-replica-"));
  init(home, { port: 0, name: "Desk", role: "replica" });
  const replica = await start(home, { timer: false, videoDownloads: { chunk: 4 * 1024, poll: 20, keepEvery: 0, ...options } });
  t.after(async () => {
    await replica.close();
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const call = api(replica.port, replica.engine.config.adminToken);
  const desk = await f.call("/v1/devices", { name: "Desk", role: "replica" });
  await call("/v1/connect", { url: `http://127.0.0.1:${f.daemon.port}`, token: desk.token });
  await replica.engine.cycle();
  return { replica, call, home, token: desk.token, base: `http://127.0.0.1:${replica.port}`, downloads: replica.engine.videoDownloads, hubUrl: replica.engine.config.hub.url };
}

const idle = async (r) => {
  await r.downloads.wake();
  await (r.downloads.running || Promise.resolve());
};
const away = (r) => {
  r.replica.engine.config.hub.url = "http://127.0.0.1:9";
  r.replica.engine.hubUnavailable = true;
};
const back = (r) => {
  r.replica.engine.config.hub.url = r.hubUrl;
  r.replica.engine.hubUnavailable = false;
};
const trackNamed = (library, name) => library.tracks.find((track) => track.path === name);

test("the hub streams an audio library to a linked replica with ranges, never to a player, a stale hash or an excluded file", async (t) => {
  const f = await musicHub(t);
  const name = "Miles Davis/Kind of Blue/01 So What.mp3";
  const buffer = f.tracks[name];
  const { hash } = trackNamed(f.indexed, name);
  const linked = await f.call("/v1/devices", { name: "Phone", role: "replica" });
  const media = (query, token, headers = {}) =>
    fetch(`http://127.0.0.1:${f.daemon.port}/v1/music/media?${new URLSearchParams(query)}`, { headers: { Authorization: `Bearer ${token}`, ...headers } });
  let response = await media({ volume: f.music.id, path: name, hash }, linked.token, { Range: "bytes=3-10" });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), `bytes 3-10/${buffer.length}`);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), buffer.subarray(3, 11));
  response = await fetch(`http://127.0.0.1:${f.daemon.port}/v1/music/media?${new URLSearchParams({ volume: f.music.id, path: name, hash })}`, { method: "HEAD", headers: { Authorization: `Bearer ${linked.token}` } });
  assert.equal(response.status, 200);
  assert.equal(Number(response.headers.get("content-length")), buffer.length);
  assert.equal((await media({ volume: f.music.id, path: name, hash: "0".repeat(64) }, linked.token)).status, 404, "a stale hash is refused");
  assert.equal((await media({ volume: f.music.id, path: "Drafts/demo.mp3", hash: digest(f.tracks["Drafts/demo.mp3"]) }, linked.token)).status, 404, "an excluded path is not served");
  const tv = { token: token() };
  f.s.db.prepare("INSERT INTO devices(id,name,token_hash,role) VALUES(?,?,?,?)").run("tv", "TV", digest(tv.token), "player");
  assert.equal((await media({ volume: f.music.id, path: name, hash }, tv.token)).status, 403, "players keep the blob route");
  await f.call("/v1/revoke", { id: linked.id });
  assert.equal((await media({ volume: f.music.id, path: name, hash }, linked.token)).status, 401, "a revoked credential is refused");
  await assert.rejects(f.call(`/v1/music/playback?${new URLSearchParams({ volume: f.music.id, path: name, hash })}`, undefined, tv.token), { status: 403 });
});

test("a linked replica deletes a track of an audio library on the hub with the revision checked, and History keeps it", async (t) => {
  const f = await musicHub(t);
  const name = "Miles Davis/Sketches/01 Saeta.mp3";
  const linked = await f.call("/v1/devices", { name: "Desk", role: "replica" });
  const { rev } = f.s.current(f.music.id, name);
  await assert.rejects(f.call("/v1/delete-file", { volume: f.music.id, path: name, rev: rev - 1 }, linked.token), { status: 409 });
  await f.call("/v1/delete-file", { volume: f.music.id, path: name, rev }, linked.token);
  assert.equal(f.s.current(f.music.id, name).deleted, 1);
  const history = await f.call(`/v1/history?${new URLSearchParams({ volume: f.music.id, path: name })}`);
  assert.ok(history.versions.some((version) => !version.deleted), "History keeps the deleted track");
  const plain = f.s.addVolume("Plain");
  await f.propose("note.txt", Buffer.from("note"), plain.id);
  await assert.rejects(
    f.call("/v1/delete-file", { volume: plain.id, path: "note.txt", rev: f.s.current(plain.id, "note.txt").rev }, linked.token),
    { status: 403 },
    "ordinary folders stay the administrator's",
  );
});

test("a replica streams an audio library with no local copy: forwarded, cached, played through the hub, and offline it says so", async (t) => {
  const f = await musicHub(t);
  const r = await replicaOf(t, f);
  await assert.rejects(r.call("/v1/select", { id: f.v.id, mode: "sideways" }), { status: 400 });
  const plain = f.s.addVolume("Plain");
  await r.replica.engine.cycle();
  await assert.rejects(r.call("/v1/select", { id: plain.id, mode: "stream" }), { status: 400, message: "Only Audio and Movies & TV libraries stream" });
  const selected = await r.call("/v1/select", { id: f.music.id, mode: "stream" });
  assert.deepEqual(selected, { id: f.music.id, name: "Music", mode: "stream" });
  assert.deepEqual(r.replica.engine.store.volumes(), [], "streaming creates no destination");
  assert.equal(fs.existsSync(path.join(r.replica.engine.config.root, "Music")), false);
  const status = await r.call("/v1/status");
  assert.deepEqual(status.media, { [f.music.id]: "stream" });
  assert.equal(status.volumes.length, 0);
  assert.deepEqual(await r.call("/v1/select", { id: f.music.id, mode: "stream" }), selected, "choosing the same mode again changes nothing");
  await assert.rejects(r.call("/v1/select", { id: f.music.id, path: path.join(r.home, "x") }), { status: 409, message: "Stop syncing this library before choosing again." });

  const library = await r.call(`/v1/music/library?volume=${f.music.id}`);
  assert.deepEqual(library.tracks.map((track) => track.path), f.indexed.tracks.map((track) => track.path), "the hub's library is forwarded");
  assert.equal(library.tracks.some((track) => track.pending), false);
  assert.equal((await r.call(`/v1/music/library?volume=${f.music.id}&version=${library.version}`)).unchanged, true);
  const name = "Miles Davis/Kind of Blue/01 So What.mp3";
  const track = trackNamed(library, name);
  const query = new URLSearchParams({ volume: f.music.id, path: name, hash: track.hash });
  const { url } = await r.call(`/v1/music/playback?${query}`);
  assert.match(url, new RegExp(`^${r.base}/v1/music/media\\?ticket=`));
  let response = await fetch(url, { headers: { Range: "bytes=5-20" } });
  assert.equal(response.status, 206, "the replica proxies the hub with the range");
  assert.equal(response.headers.get("content-range"), `bytes 5-20/${f.tracks[name].length}`);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.tracks[name].subarray(5, 21));
  await assert.rejects(r.call(`/v1/music/playback?${new URLSearchParams({ volume: f.music.id, path: name, hash: "1".repeat(64) })}`), { status: 404 });

  await assert.rejects(r.call("/v1/rename-file", { volume: f.music.id, path: name, name: "x.mp3", rev: track.rev }), { status: 409, message: "Keep this folder on this device to edit it" });
  await assert.rejects(r.call("/v1/music/playlist", { volume: f.music.id, action: "create", name: "Mix" }), { status: 409, message: "Keep this folder on this device to edit it" });

  away(r);
  const offline = await r.call(`/v1/music/library?volume=${f.music.id}`);
  assert.equal(offline.offline, true, "the last answer is kept for when the hub is away");
  assert.equal(offline.tracks.length, library.tracks.length);
  await assert.rejects(r.call(`/v1/music/playback?${query}`), { status: 503, message: "Connect to your hub to listen" });
  response = await fetch(url, { headers: { Range: "bytes=0-3" } });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, "Connect to your hub to listen");
  back(r);

  const saeta = trackNamed(library, "Miles Davis/Sketches/01 Saeta.mp3");
  await assert.rejects(r.call("/v1/delete-file", { volume: f.music.id, path: saeta.path, rev: saeta.rev - 1 }), { status: 409 }, "Delete reaches the hub with its revision check");
  await r.call("/v1/delete-file", { volume: f.music.id, path: saeta.path, rev: saeta.rev });
  assert.equal(f.s.current(f.music.id, saeta.path).deleted, 1);
  const blue = "Miles Davis/Kind of Blue/02 Blue in Green.mp3";
  await r.call("/v1/delete-file", { volume: f.music.id, path: blue });
  assert.equal(f.s.current(f.music.id, blue).deleted, 1, "without a revision the hub's library row supplies it");
  const history = await f.call(`/v1/history?${new URLSearchParams({ volume: f.music.id, path: saeta.path })}`);
  assert.ok(history.versions.some((version) => !version.deleted));

  assert.deepEqual(await r.call("/v1/unselect", { id: f.music.id, deleteFiles: true }), { deleted: 0, deletedBytes: 0, kept: 0 });
  assert.deepEqual((await r.call("/v1/status")).media, {});
  await assert.rejects(r.call(`/v1/music/library?volume=${f.music.id}`), { status: 404 });
  const destination = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "arca-media-kept-")), "Music");
  t.after(() => fs.rmSync(path.dirname(destination), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  await r.call("/v1/select", { id: f.music.id, mode: "keep", path: destination });
  assert.equal(r.replica.engine.store.volume(f.music.id).path, fs.realpathSync(destination), "Keep is today's complete copy at a destination");
  await assert.rejects(r.call("/v1/select", { id: f.music.id, mode: "stream" }), { status: 409, message: "Stop syncing this library before choosing again." });
  await assert.rejects(f.call("/v1/select", { id: f.music.id, mode: "stream" }), { status: 403 }, "the hub never streams or keeps");
});

test("a streamed audio library downloads an album and an episode that then play offline, resume and follow the hub", async (t) => {
  const f = await musicHub(t);
  const r = await replicaOf(t, f);
  const album = ["Miles Davis/Kind of Blue/01 So What.mp3", "Miles Davis/Kind of Blue/02 Blue in Green.mp3"];
  const episode = "Talks/2026-01-02 Episode.mp3";
  await assert.rejects(r.call("/v1/music/download", { volume: f.music.id, paths: album }), { status: 409 }, "only a streamed library downloads");
  await r.call("/v1/select", { id: f.music.id, mode: "stream" });
  await assert.rejects(f.call(`/v1/music/downloads?volume=${f.music.id}`), { status: 403, message: "Only the desktop app downloads tracks" });
  const library = await r.call(`/v1/music/library?volume=${f.music.id}`);
  const queued = await r.call("/v1/music/download", { volume: f.music.id, paths: [...album, episode] });
  assert.equal(queued.downloads.length, 3);
  await idle(r);
  const rows = (await r.call(`/v1/music/downloads?volume=${f.music.id}`)).downloads;
  assert.deepEqual(rows.map((row) => [row.path, row.state]).sort(), [...album, episode].map((name) => [name, "done"]).sort());
  const folder = path.join(r.home, "music-downloads");
  const stored = fs.readdirSync(folder).filter((file) => file.endsWith(".mp3"));
  assert.equal(stored.length, 3, "each copy lives under the device's own download folder");
  assert.ok(stored.every((file) => /^[a-f0-9]{32}\.mp3$/.test(file)), "hashed names, never the track's path");
  assert.equal(fs.existsSync(path.join(r.replica.engine.config.root, "Music")), false);

  away(r);
  for (const name of [...album, episode]) {
    const { hash } = trackNamed(library, name);
    const { url } = await r.call(`/v1/music/playback?${new URLSearchParams({ volume: f.music.id, path: name, hash })}`);
    const response = await fetch(url, { headers: { Range: "bytes=2-9" } });
    assert.equal(response.status, 206, `${name} plays offline from its copy`);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.tracks[name].subarray(2, 10));
  }
  const missing = trackNamed(library, "Miles Davis/Sketches/01 Saeta.mp3");
  await assert.rejects(r.call(`/v1/music/playback?${new URLSearchParams({ volume: f.music.id, path: missing.path, hash: missing.hash })}`), { status: 503 });
  r.replica.engine.store.db.exec("DELETE FROM remote_views");
  const kept = await r.call(`/v1/music/library?volume=${f.music.id}`);
  assert.equal(kept.offline, true);
  assert.deepEqual(kept.tracks.map((track) => track.path).sort(), [...album, episode].sort(), "with no saved library the downloads still list");
  back(r);

  const changed = tone({ title: "So What (take 2)", artist: "Miles Davis", album: "Kind of Blue", track: "1" }, 0.8);
  fs.writeFileSync(path.join(f.music.path, ...album[0].split("/")), changed);
  await f.daemon.engine.cycle();
  await f.musicLibrary();
  await r.call("/v1/music/download", { volume: f.music.id, paths: [album[0]] });
  await idle(r);
  const [fresh] = (await r.call(`/v1/music/downloads?volume=${f.music.id}`)).downloads.filter((row) => row.path === album[0]);
  assert.equal(fresh.state, "done");
  assert.equal(fresh.size, changed.length, "a changed track downloads anew");
  assert.ok(r.downloads.local(f.music.id, album[0], fresh.hash));

  const offlineCover = trackNamed(library, album[1]).cover;
  assert.match(offlineCover, /^[a-f0-9]{64}$/);
  away(r);
  assert.match((await r.call(`/v1/music/cover?${new URLSearchParams({ volume: f.music.id, key: offlineCover })}`)).data, /^data:image\/jpeg/, "a downloaded track's cover serves offline");
  back(r);
  await r.call("/v1/music/download/remove", { volume: f.music.id, paths: [episode] });
  assert.equal(fs.readdirSync(folder).filter((file) => file.endsWith(".mp3")).length, 2);
  assert.deepEqual(await r.call("/v1/unselect", { id: f.music.id, deleteFiles: true }), { deleted: 2, deletedBytes: changed.length + f.tracks[album[1]].length, kept: 0 });
  assert.deepEqual(fs.readdirSync(folder), [], "Stop syncing and delete removes the downloads");
  await r.call("/v1/select", { id: f.music.id, mode: "stream" });
  await r.call("/v1/music/download", { volume: f.music.id, paths: [episode] });
  await idle(r);
  assert.equal(fs.readdirSync(folder).filter((file) => file.endsWith(".mp3")).length, 1);
  await r.replica.engine.destroyReplica();
  assert.equal(fs.existsSync(folder), false, "Erase removes the audio downloads");
});

test("an interrupted track download resumes from its partial file", async (t) => {
  const f = await musicHub(t);
  const r = await replicaOf(t, f, { chunk: 1024 });
  await r.call("/v1/select", { id: f.music.id, mode: "stream" });
  const name = "Miles Davis/Kind of Blue/01 So What.mp3";
  const library = await r.call(`/v1/music/library?volume=${f.music.id}`);
  const row = { ...trackNamed(library, name) };
  r.downloads.enqueue(f.music.id, row, "music");
  const stored = r.downloads.row(f.music.id, name);
  fs.mkdirSync(path.join(r.home, "music-downloads"), { recursive: true });
  fs.writeFileSync(r.downloads.where(stored, ".part"), f.tracks[name].subarray(0, 2048));
  const seen = [];
  const original = globalThis.fetch;
  globalThis.fetch = (url, options) => {
    if (String(url).includes("/v1/music/media")) seen.push(options.headers.Range);
    return original(url, options);
  };
  try {
    await idle(r);
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(seen[0], "bytes=2048-3071", "only the missing bytes are asked for");
  assert.deepEqual(fs.readFileSync(r.downloads.where(stored)), f.tracks[name]);
});

async function showLibrary(f) {
  await f.call("/v1/video/mark", { volume: f.v.id });
  const files = {
    "Movies/Heat (1995)/Heat (1995).mp4": clip({ seconds: 2, tone: 600 }),
    "Movies/Up (2009)/Up (2009).mp4": clip({ seconds: 2, tone: 700 }),
    "TV/Andor/Season 1/Andor S01E01.mp4": clip({ seconds: 2, tone: 800 }),
  };
  for (const [name, buffer] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(f.v.path, ...name.split("/"))), { recursive: true });
    fs.writeFileSync(path.join(f.v.path, ...name.split("/")), buffer);
  }
  await f.daemon.engine.cycle();
  return { files, library: await f.settled() };
}
const titlesOf = (library) => keptTitles(library);

test("a streamed Movies & TV library downloads a movie and an episode that then play offline", async (t) => {
  const f = await hub(t);
  const { files, library } = await showLibrary(f);
  const r = await replicaOf(t, f);
  assert.deepEqual(await r.call("/v1/select", { id: f.v.id, mode: "stream" }), { id: f.v.id, name: "Videos", mode: "stream" });
  const movie = "Movies/Heat (1995)/Heat (1995).mp4";
  const episode = "TV/Andor/Season 1/Andor S01E01.mp4";
  await r.call("/v1/video/download", { volume: f.v.id, paths: [movie, episode] });
  await idle(r);
  assert.deepEqual((await r.call(`/v1/video/downloads?volume=${f.v.id}`)).downloads.map((row) => row.state), ["done", "done"]);
  away(r);
  for (const name of [movie, episode]) {
    const { hash } = titlesOf(library).find((item) => item.path === name);
    const { url } = await r.call(`/v1/video/playback?${new URLSearchParams({ volume: f.v.id, path: name, hash })}`);
    const response = await fetch(url, { headers: { Range: "bytes=1-8" } });
    assert.equal(response.status, 206, `${name} plays offline`);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), files[name].subarray(1, 9));
  }
  back(r);
  await r.call("/v1/video/download/remove", { volume: f.v.id, paths: [episode] });
  assert.equal((await r.call(`/v1/video/downloads?volume=${f.v.id}`)).downloads.length, 1, "per-title Remove works while streaming");
});

test("Keep on the desktop app follows the hub: queues every title in order, replaces a changed one once complete, removes a gone one only after two complete reads", async (t) => {
  const f = await hub(t);
  const { files, library } = await showLibrary(f);
  const r = await replicaOf(t, f);
  r.replica.engine.config.installation = "desktop";
  await assert.rejects(f.call("/v1/select", { id: f.v.id, mode: "keep" }), { status: 403 }, "the hub answers 403 to keep");
  await r.call("/v1/select", { id: f.v.id, mode: "keep" });
  await r.call(`/v1/video/library?volume=${f.v.id}`);
  await idle(r);
  const rows = () => r.downloads.rows(f.v.id);
  assert.deepEqual(rows().map((row) => row.state), ["done", "done", "done"], "every title is kept");
  assert.deepEqual(rows().map((row) => row.path), titlesOf(library).map((item) => item.path), "queued newest first");
  const movie = "Movies/Heat (1995)/Heat (1995).mp4";
  await assert.rejects(r.call("/v1/video/download/remove", { volume: f.v.id, paths: [movie] }), { status: 409 }, "a kept title is not removed by hand");

  const changed = clip({ seconds: 3, tone: 650 });
  fs.writeFileSync(path.join(f.v.path, ...movie.split("/")), changed);
  await f.daemon.engine.cycle();
  await f.settled();
  const stored = r.downloads.row(f.v.id, movie);
  const held = r.downloads.halt();
  await held;
  r.downloads.halting = true;
  await r.call(`/v1/video/library?volume=${f.v.id}`);
  assert.equal(r.downloads.row(f.v.id, movie).state, "queued", "the changed file is queued again");
  assert.deepEqual(fs.readFileSync(r.downloads.where(stored)), files[movie], "the old copy stays until the new one is complete");
  const playsOld = async (message) => {
    const current = (await r.call(`/v1/video/library?volume=${f.v.id}`)).movies.find((item) => item.path === movie);
    away(r);
    const { url } = await r.call(`/v1/video/playback?${new URLSearchParams({ volume: f.v.id, path: movie, hash: current.hash })}`);
    const response = await fetch(url, { headers: { Range: "bytes=0-7" } });
    assert.equal(response.status, 206, message);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), files[movie].subarray(0, 8));
    const saved = r.replica.engine.store.db.prepare("SELECT key,value,used FROM remote_views").all();
    r.replica.engine.store.db.exec("DELETE FROM remote_views");
    assert.ok((await r.call(`/v1/video/library?volume=${f.v.id}`)).movies.some((item) => item.path === movie), "the offline library still lists it");
    for (const row of saved) r.replica.engine.store.db.prepare("INSERT INTO remote_views(key,value,used) VALUES(?,?,?)").run(row.key, row.value, row.used);
    back(r);
  };
  await playsOld("the old copy plays offline while its replacement waits");
  const online = await fetch(`${r.base}/v1/video/media?${new URLSearchParams({ volume: f.v.id, path: movie, hash: stored.hash })}`, {
    headers: { Authorization: `Bearer ${r.replica.engine.config.adminToken}`, Range: "bytes=2-9" },
  });
  assert.equal(online.status, 206, "with the hub online the old copy still plays under its own hash");
  assert.deepEqual(Buffer.from(await online.arrayBuffer()), files[movie].subarray(2, 10));
  await assert.rejects(r.call("/v1/video/download/cancel", { volume: f.v.id, paths: [movie] }), { status: 409 }, "a kept title cannot be cancelled");
  assert.deepEqual(fs.readFileSync(r.downloads.where(stored)), files[movie], "and its old copy stays");
  const rename = fs.renameSync;
  t.after(() => {
    fs.renameSync = rename;
  });
  fs.renameSync = () => {
    throw Object.assign(new Error(`ENOSPC: no space left, rename '${r.home}'`), { code: "ENOSPC" });
  };
  r.downloads.halting = false;
  await idle(r);
  fs.renameSync = rename;
  assert.equal(r.downloads.row(f.v.id, movie).state, "failed", "the replacement failed");
  await playsOld("the old copy still plays offline after a failed replacement");
  r.downloads.halting = true;
  await r.call(`/v1/video/library?volume=${f.v.id}`);
  assert.equal(r.downloads.row(f.v.id, movie).state, "failed", "a failed replacement is not downloaded again while the hub's file stays the same");
  const again = clip({ seconds: 3, tone: 660 });
  fs.writeFileSync(path.join(f.v.path, ...movie.split("/")), again);
  await f.daemon.engine.cycle();
  await f.settled();
  await r.call(`/v1/video/library?volume=${f.v.id}`);
  assert.equal(r.downloads.row(f.v.id, movie).state, "queued", "a new file on the hub is tried");
  await playsOld("the original copy still stands in");
  r.downloads.platform = "win32";
  let busy = 0;
  fs.renameSync = (...args) => {
    if (!busy++) throw Object.assign(new Error(`EPERM: operation not permitted, rename '${args[0]}'`), { code: "EPERM" });
    return rename(...args);
  };
  r.downloads.halting = false;
  await idle(r);
  const waiting = r.downloads.row(f.v.id, movie);
  assert.equal(waiting.state, "queued", "an open copy on Windows never fails the download");
  assert.equal(waiting.error, "Close the video on this device so its new copy can replace the old one");
  assert.doesNotMatch(waiting.error, /EPERM|\//);
  await idle(r);
  fs.renameSync = rename;
  assert.equal(r.downloads.row(f.v.id, movie).state, "done");
  assert.equal(r.downloads.row(f.v.id, movie).previous, null);
  assert.deepEqual(fs.readFileSync(r.downloads.where(stored)), again, "and is replaced once complete");

  const up = "Movies/Up (2009)/Up (2009).mp4";
  const rev = f.s.current(f.v.id, up).rev;
  await f.call("/v1/video/delete", { volume: f.v.id, path: up, rev });
  await f.settled();
  away(r);
  await r.call(`/v1/video/library?volume=${f.v.id}`);
  await r.call(`/v1/video/library?volume=${f.v.id}`);
  assert.ok(r.downloads.row(f.v.id, up), "an offline read never removes");
  back(r);
  await r.call(`/v1/video/library?volume=${f.v.id}`);
  assert.ok(r.downloads.row(f.v.id, up), "one complete read without it keeps it");
  await r.call(`/v1/video/library?volume=${f.v.id}`);
  assert.ok(r.downloads.row(f.v.id, up), "an unchanged read seconds later keeps it");
  r.replica.engine.store.db.prepare("UPDATE video_keep_missing SET at=at-61000").run();
  await r.call(`/v1/video/library?volume=${f.v.id}`);
  assert.equal(r.downloads.row(f.v.id, up), undefined, "an unchanged read a minute after the first removes it");
  assert.equal(r.replica.engine.store.db.prepare("SELECT count(*) AS n FROM video_keep_missing").get().n, 0, "its mark goes with it");

  const result = await r.call("/v1/unselect", { id: f.v.id, deleteFiles: true });
  assert.equal(result.deleted, 2);
  assert.deepEqual(rows(), []);
  assert.deepEqual(fs.readdirSync(path.join(r.home, "video-downloads")), [], "Stop syncing and delete removes the kept copies");
});

test("Keep stops queuing at the free-space floor without evicting anything", async (t) => {
  const f = await hub(t);
  const { library } = await showLibrary(f);
  const [first] = titlesOf(library);
  const gib = 1024 ** 3;
  const space = { bsize: 1, blocks: 20 * gib, bavail: 5 * gib + first.size + 10 };
  const r = await replicaOf(t, f, { space: () => space });
  r.replica.engine.config.installation = "desktop";
  await r.call("/v1/select", { id: f.v.id, mode: "keep" });
  await r.call(`/v1/video/library?volume=${f.v.id}`);
  await idle(r);
  assert.deepEqual(r.downloads.rows(f.v.id).map((row) => row.path), [first.path], "only what fits above 5 GB free is queued");
  space.bavail = 3 * gib;
  space.blocks = 40 * gib;
  await r.call(`/v1/video/library?volume=${f.v.id}`);
  assert.deepEqual(r.downloads.rows(f.v.id).map((row) => [row.path, row.state]), [[first.path, "done"]], "below the floor nothing new is queued and nothing is removed");
});

test("Continue watching and Next up are kept first, then the newest added", () => {
  const item = (id, added) => ({ id, path: `${id}.mp4`, hash: digest(id), added });
  const library = {
    movies: [item("old", "2020-01-01"), item("new", "2026-01-01"), item("paused", "2019-01-01")],
    shows: [{ seasons: [{ episodes: [item("next", "2018-01-01"), item("later", "2025-01-01")] }] }],
    other: [],
    continue: ["paused"],
    nextUp: ["next"],
  };
  assert.deepEqual(keptTitles(library).map((entry) => entry.id), ["paused", "next", "new", "later", "old"]);
});

test("the index records its media modes under schema 2, and an older download table gains its kind", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-media-schema-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  init(home, { port: 0, role: "replica" });
  const raw = new DatabaseSync(path.join(home, "index.sqlite"));
  raw.exec("PRAGMA user_version=1; CREATE TABLE video_downloads(hub TEXT NOT NULL,volume TEXT NOT NULL,path TEXT NOT NULL,hash TEXT NOT NULL,size INTEGER NOT NULL,state TEXT NOT NULL,error TEXT,file TEXT NOT NULL,item TEXT NOT NULL,show TEXT,subtitles TEXT NOT NULL DEFAULT '[]',art TEXT NOT NULL DEFAULT '{}',added INTEGER NOT NULL,PRIMARY KEY(hub,volume,path)); INSERT INTO video_downloads VALUES('h','v','a.mp4','x',1,'done',NULL,'f.mp4','{}',NULL,'[]','{}',1)");
  raw.close();
  assert.equal(SCHEMA_VERSION, 2);
  const store = new Store(home);
  assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, 2);
  store.db.prepare("INSERT INTO media_modes(volume,mode) VALUES('v','stream')").run();
  assert.throws(() => store.db.prepare("INSERT INTO media_modes(volume,mode) VALUES('w','sideways')").run());
  assert.equal(store.mediaMode("v"), "stream");
  new VideoDownloads({ store, config: store.config });
  assert.equal(store.db.prepare("SELECT kind FROM video_downloads").get().kind, "video", "existing downloads are video downloads");
  store.db.close();
});

test("Keep never fails a library read when free space cannot be read, and queues nothing then", async (t) => {
  const f = await hub(t);
  await showLibrary(f);
  const r = await replicaOf(t, f, {
    space: () => {
      throw Object.assign(new Error("EIO: statfs"), { code: "EIO" });
    },
  });
  r.replica.engine.config.installation = "desktop";
  await r.call("/v1/select", { id: f.v.id, mode: "keep" });
  const library = await r.call(`/v1/video/library?volume=${f.v.id}`);
  assert.equal(library.movies.length, 2, "the library still answers");
  assert.deepEqual(r.downloads.rows(f.v.id), [], "nothing is queued without knowing the free space");
});

test("Stop syncing a streamed Audio library removes its downloads even when the files are kept", async (t) => {
  const f = await musicHub(t);
  const r = await replicaOf(t, f);
  await r.call("/v1/select", { id: f.music.id, mode: "stream" });
  const name = "Miles Davis/Kind of Blue/01 So What.mp3";
  await r.call("/v1/music/download", { volume: f.music.id, paths: [name] });
  await idle(r);
  const folder = path.join(r.home, "music-downloads");
  assert.equal(fs.readdirSync(folder).filter((file) => file.endsWith(".mp3")).length, 1);
  assert.deepEqual(await r.call("/v1/unselect", { id: f.music.id }), { retained: true });
  assert.deepEqual(r.downloads.rows(f.music.id), [], "a read-only cache nothing can reach any more is not kept");
  assert.deepEqual(fs.readdirSync(folder), []);
});

test("Stop syncing a streamed Movies & TV library without deleting keeps its downloads playable", async (t) => {
  const f = await hub(t);
  await showLibrary(f);
  const r = await replicaOf(t, f);
  await r.call("/v1/select", { id: f.v.id, mode: "stream" });
  await r.call("/v1/video/download", { volume: f.v.id, paths: ["Movies/Heat (1995)/Heat (1995).mp4"] });
  await idle(r);
  await r.call("/v1/unselect", { id: f.v.id });
  assert.equal(r.downloads.rows(f.v.id)[0].state, "done");
});

test("the missing marks of Keep go with another hub and with a folder the catalog no longer lists as Movies & TV", async (t) => {
  const f = await hub(t);
  await showLibrary(f);
  const r = await replicaOf(t, f);
  const marks = r.replica.engine.store.db;
  const insert = marks.prepare("INSERT INTO video_keep_missing(hub,volume,path,at) VALUES(?,?,?,?)");
  insert.run("old-hub", f.v.id, "a.mp4", 1);
  insert.run(r.replica.engine.config.hub.id, "gone", "b.mp4", 1);
  insert.run(r.replica.engine.config.hub.id, f.v.id, "c.mp4", 1);
  r.downloads.pruneHubs();
  r.downloads.pruneCatalog([{ id: f.v.id, video: true }]);
  assert.deepEqual(marks.prepare("SELECT volume,path FROM video_keep_missing").all().map((row) => ({ ...row })), [{ volume: f.v.id, path: "c.mp4" }]);
});

test("on Windows a copy that cannot be replaced while open waits without holding up the next download", async (t) => {
  const f = await hub(t);
  await showLibrary(f);
  const r = await replicaOf(t, f, { platform: "win32" });
  const [heat, up] = ["Movies/Heat (1995)/Heat (1995).mp4", "Movies/Up (2009)/Up (2009).mp4"];
  r.downloads.halting = true;
  await r.call("/v1/video/download", { volume: f.v.id, paths: [heat, up] });
  const blocked = r.downloads.where(r.downloads.row(f.v.id, heat));
  const rename = fs.renameSync;
  t.after(() => {
    fs.renameSync = rename;
  });
  fs.renameSync = (from, to) => {
    if (to === blocked) throw Object.assign(new Error(`EPERM: operation not permitted, rename '${from}'`), { code: "EPERM" });
    return rename(from, to);
  };
  r.downloads.halting = false;
  await idle(r);
  fs.renameSync = rename;
  assert.equal(r.downloads.row(f.v.id, up).state, "done", "the next title still downloads");
  const waiting = r.downloads.row(f.v.id, heat);
  assert.equal(waiting.state, "queued");
  assert.equal(waiting.error, "Close the video on this device so its new copy can replace the old one");
  await idle(r);
  assert.equal(r.downloads.row(f.v.id, heat).state, "done", "it finishes once the file is free");
});

test("outside Windows a refused rename is a real failure", async (t) => {
  const f = await hub(t);
  await showLibrary(f);
  const r = await replicaOf(t, f, { platform: "linux" });
  const rename = fs.renameSync;
  t.after(() => {
    fs.renameSync = rename;
  });
  fs.renameSync = () => {
    throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
  };
  await r.call("/v1/video/download", { volume: f.v.id, paths: ["Movies/Heat (1995)/Heat (1995).mp4"] });
  await idle(r);
  fs.renameSync = rename;
  assert.equal(r.downloads.row(f.v.id, "Movies/Heat (1995)/Heat (1995).mp4").state, "failed");
});

test("a replacement whose new file is already in place, after a crash or a hub that reverted, clears its stand-in", async (t) => {
  const f = await hub(t);
  const { library } = await showLibrary(f);
  const r = await replicaOf(t, f);
  const heat = "Movies/Heat (1995)/Heat (1995).mp4";
  await r.call("/v1/video/download", { volume: f.v.id, paths: [heat] });
  await idle(r);
  const item = titlesOf(library).find((entry) => entry.path === heat);
  const store = r.replica.engine.store.db;
  store
    .prepare("UPDATE video_downloads SET state='queued',previous=? WHERE path=?")
    .run(JSON.stringify({ hash: "0".repeat(64), size: item.size, item: { ...item, hash: "0".repeat(64) }, show: null }), heat);
  await idle(r);
  const row = r.downloads.row(f.v.id, heat);
  assert.equal(row.state, "done");
  assert.equal(row.previous, null, "the copy on disk is the current one, so nothing stands in for it");
  assert.equal(r.downloads.local(f.v.id, heat, "0".repeat(64)), null);
});

test("Stop syncing a kept library counts the old copies of pending replacements as deleted", async (t) => {
  const f = await hub(t);
  const { library } = await showLibrary(f);
  const r = await replicaOf(t, f);
  r.replica.engine.config.installation = "desktop";
  await r.call("/v1/select", { id: f.v.id, mode: "keep" });
  await r.call(`/v1/video/library?volume=${f.v.id}`);
  await idle(r);
  const heat = "Movies/Heat (1995)/Heat (1995).mp4";
  const item = titlesOf(library).find((entry) => entry.path === heat);
  r.replica.engine.store.db
    .prepare("UPDATE video_downloads SET state='queued',hash=?,previous=? WHERE path=?")
    .run("1".repeat(64), JSON.stringify({ hash: item.hash, size: item.size, item, show: null }), heat);
  const total = titlesOf(library).reduce((sum, entry) => sum + entry.size, 0);
  r.downloads.halting = true;
  assert.deepEqual(await r.call("/v1/unselect", { id: f.v.id, deleteFiles: true }), { deleted: 3, deletedBytes: total, kept: 0 });
});
