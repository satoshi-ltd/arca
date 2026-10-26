import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import ffmpeg from "ffmpeg-static";
import { init } from "../packages/daemon/storage.js";
import { start } from "../packages/daemon/server.js";
import { api, clip, hub, image } from "./video-support.js";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "arca-video-downloads-"));
process.on("exit", () => fs.rmSync(scratch, { recursive: true, force: true }));

function subtitledFilm() {
  const srt = path.join(scratch, "en.srt");
  fs.writeFileSync(srt, "1\n00:00:01,000 --> 00:00:02,500\nInside the file\n");
  const output = path.join(scratch, "film.mkv");
  execFileSync(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc=duration=3:size=160x120:rate=10",
    "-f", "lavfi", "-i", "sine=frequency=400:duration=3",
    "-i", srt,
    "-map", "0:v", "-map", "1:a", "-map", "2",
    "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-c:s:0", "srt",
    "-metadata:s:s:0", "language=eng",
    output,
  ]);
  return fs.readFileSync(output);
}

async function replicaAt(t, f, home, options = {}) {
  const replica = await start(home, { timer: false, videoDownloads: { chunk: 8 * 1024, poll: 20 }, ...options });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await replica.close();
  };
  t.after(close);
  const call = api(replica.port, replica.engine.config.adminToken);
  return { replica, call, close, home, base: `http://127.0.0.1:${replica.port}`, downloads: replica.engine.videoDownloads };
}

async function replicaOf(t, f, options) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-video-download-replica-"));
  init(home, { port: 0, name: "Desk", role: "replica" });
  const r = await replicaAt(t, f, home, options);
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const desk = await f.call("/v1/devices", { name: "Desk", role: "replica" });
  await r.call("/v1/connect", { url: `http://127.0.0.1:${f.daemon.port}`, token: desk.token });
  await r.replica.engine.cycle();
  return r;
}

async function relay(t, target) {
  const control = { ranges: [], cut: null, media: 0 };
  const server = http.createServer((req, res) => {
    const media = req.url.startsWith("/v1/video/media");
    if (media) control.ranges.push(req.headers.range || null);
    const cut = media && control.cut?.(++control.media);
    const held = control.hold?.(req);
    if (held) return void held.then(() => forward(req, res, cut));
    forward(req, res, cut);
  });
  const forward = (req, res, cut) => {
    const upstream = http.request(`${target}${req.url}`, { method: req.method, headers: { ...req.headers, host: new URL(target).host } }, (answer) => {
      res.writeHead(answer.statusCode, answer.headers);
      let sent = 0;
      answer.on("data", (data) => {
        if (cut && sent + data.length > cut) {
          res.write(data.subarray(0, cut - sent));
          res.destroy();
          answer.destroy();
          return;
        }
        sent += data.length;
        res.write(data);
      });
      answer.on("end", () => res.end());
    });
    upstream.on("error", () => res.destroy());
    req.pipe(upstream);
  };
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { url: `http://127.0.0.1:${server.address().port}`, control };
}

async function movieLibrary(f, film = clip({ seconds: 4, tone: 1234 })) {
  await f.call("/v1/video/mark", { volume: f.v.id });
  fs.mkdirSync(path.join(f.v.path, "Heat (1995)"), { recursive: true });
  fs.writeFileSync(path.join(f.v.path, "Heat (1995)", "Heat (1995).mkv"), film);
  fs.writeFileSync(path.join(f.v.path, "Heat (1995)", "Heat (1995).es.srt"), "1\n00:00:01,000 --> 00:00:02,000\nHola\n");
  fs.writeFileSync(path.join(f.v.path, "Heat (1995)", "poster.jpg"), await image("red"));
  await f.daemon.engine.cycle();
  const value = await f.settled();
  return { film, movie: value.movies[0], name: "Heat (1995)/Heat (1995).mkv" };
}

const idle = (r) => r.downloads.running || Promise.resolve();
const offline = (r) => {
  r.replica.engine.config.hub.url = "http://127.0.0.1:9";
  r.replica.engine.hubUnavailable = true;
};

test("a desktop replica downloads a title with its subtitles into its own storage and plays it offline", async (t) => {
  const f = await hub(t);
  const { film, movie, name } = await movieLibrary(f, subtitledFilm());
  const r = await replicaOf(t, f);
  const hubUrl = r.replica.engine.config.hub.url;
  assert.deepEqual((await r.call(`/v1/video/downloads?volume=${f.v.id}`)).downloads, []);
  const queued = await r.call("/v1/video/download", { volume: f.v.id, paths: [name] });
  assert.equal(queued.downloads[0].id, movie.id);
  await idle(r);
  const [row] = (await r.call(`/v1/video/downloads?volume=${f.v.id}`)).downloads;
  assert.deepEqual({ ...row, error: row.error ?? null }, { id: movie.id, title: "Heat", path: name, hash: movie.hash, size: film.length, done: film.length, state: "done", error: null });
  const folder = path.join(r.home, "video-downloads");
  const stored = fs.readdirSync(folder);
  const video = stored.find((file) => file.endsWith(".mkv"));
  assert.deepEqual(fs.readFileSync(path.join(folder, video)), film, "the copy is the hub's file");
  assert.equal(stored.filter((file) => file.endsWith(".vtt")).length, 2, "the sidecar and the embedded track are kept beside it");
  assert.equal(r.replica.engine.store.volumes().length, 0, "nothing lands in a synced folder");

  await assert.rejects(f.call(`/v1/video/downloads?volume=${f.v.id}`), { status: 403 }, "the hub never downloads");
  await assert.rejects(f.call("/v1/video/download", { volume: f.v.id, paths: [name] }), { status: 403 });

  await r.call(`/v1/video/library?volume=${f.v.id}`);
  offline(r);
  const listed = await r.call(`/v1/video/library?volume=${f.v.id}`);
  assert.equal(listed.offline, true);
  assert.equal(listed.movies[0].id, movie.id);
  r.replica.engine.store.db.exec("DELETE FROM remote_views");
  const kept = await r.call(`/v1/video/library?volume=${f.v.id}`);
  assert.equal(kept.offline, true, "with no saved library the downloads still list");
  assert.deepEqual([kept.movies.map((item) => item.id), kept.shows, kept.other], [[movie.id], [], []]);
  const query = new URLSearchParams({ volume: f.v.id, path: name, hash: movie.hash });
  const playback = await r.call(`/v1/video/playback?${query}`);
  let response = await fetch(playback.url, { headers: { Range: "bytes=2-11" } });
  assert.equal(response.status, 206, "the downloaded copy plays with no hub");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), film.subarray(2, 12));
  response = await fetch(`${r.base}/v1/video/media?${query}`, { headers: { Authorization: `Bearer ${r.replica.engine.config.adminToken}` } });
  assert.equal(response.status, 200);
  assert.equal(Number(response.headers.get("content-length")), film.length);
  await response.arrayBuffer();
  const sidecar = await r.call(`/v1/video/subtitles?${new URLSearchParams({ volume: f.v.id, path: "Heat (1995)/Heat (1995).es.srt", format: "json" })}`);
  assert.match(sidecar.text, /Hola/);
  const embedded = await r.call(`/v1/video/subtitles?${new URLSearchParams({ volume: f.v.id, path: name, hash: movie.hash, stream: "0", poll: "1", format: "json" })}`);
  assert.match(embedded.text, /Inside the file/);
  const compatible = await r.call(`/v1/video/compatible?${query}`);
  assert.match(compatible.url, new RegExp(`^${r.base}/v1/video/hls/[a-f0-9]{32}/index\\.m3u8$`), "the compatible stream is made here from the copy");
  const art = await r.call(`/v1/video/art?${new URLSearchParams({ volume: f.v.id, key: movie.poster, size: "small" })}`);
  assert.match(art.data, /^data:image\/jpeg/, "the poster was kept for the offline library");

  assert.deepEqual(await r.call("/v1/video/position", { volume: f.v.id, path: name, hash: movie.hash, position: 1.5, duration: 4 }), { kept: true, queued: true });
  await r.call("/v1/video/position", { volume: f.v.id, path: name, hash: movie.hash, position: 2, duration: 4 });
  assert.equal(r.replica.engine.store.db.prepare("SELECT count(*) AS n FROM video_outbox").get().n, 1, "only the latest position per title waits");
  assert.deepEqual(await r.call("/v1/video/watched", { volume: f.v.id, path: name, watched: true }), { watched: true, queued: true });
  assert.equal((await f.library()).movies[0].watched, false, "the hub has not heard yet");

  r.replica.engine.config.hub.url = hubUrl;
  r.replica.engine.hubUnavailable = false;
  await r.downloads.wake();
  assert.equal((await f.library()).movies[0].watched, true, "what was saved offline reaches the hub once it is back");
  assert.equal(r.replica.engine.store.db.prepare("SELECT count(*) AS n FROM video_outbox").get().n, 0);

  await r.call("/v1/video/download/remove", { volume: f.v.id, paths: [name] });
  assert.deepEqual(fs.readdirSync(folder), [], "Remove download frees the space");
  assert.deepEqual((await r.call(`/v1/video/downloads?volume=${f.v.id}`)).downloads, []);
});

test("progress saved while the hub is away shows in the offline library until the hub hears it", async (t) => {
  const f = await hub(t);
  const { movie, name } = await movieLibrary(f);
  const r = await replicaOf(t, f);
  await r.call(`/v1/video/library?volume=${f.v.id}`);
  offline(r);
  await r.call("/v1/video/position", { volume: f.v.id, path: name, hash: movie.hash, position: 120, duration: 6000 });
  const resumed = await r.call(`/v1/video/library?volume=${f.v.id}`);
  assert.equal(resumed.offline, true);
  assert.equal(resumed.movies[0].position.position, 120, "Resume shows what was just watched");
  await r.call("/v1/video/watched", { volume: f.v.id, path: name, hash: "0".repeat(64), watched: true });
  assert.equal((await r.call(`/v1/video/library?volume=${f.v.id}`)).movies[0].watched, false, "a mark for other content changes nothing");
  await r.call("/v1/video/watched", { volume: f.v.id, path: name, hash: movie.hash, watched: true });
  const seen = await r.call(`/v1/video/library?volume=${f.v.id}`);
  assert.deepEqual([seen.movies[0].watched, seen.movies[0].position], [true, null]);
  assert.notEqual(seen.version, resumed.version);
});

test("an interrupted download resumes from its partial file after a restart", async (t) => {
  const f = await hub(t);
  const { film, movie, name } = await movieLibrary(f);
  const first = await replicaOf(t, f);
  const hubUrl = first.replica.engine.config.hub.url;
  const proxy = await relay(t, hubUrl);
  first.replica.engine.config.hub.url = proxy.url;
  proxy.control.cut = (count) => (count === 3 ? 3000 : 0);
  await first.call("/v1/video/download", { volume: f.v.id, paths: [name] });
  await idle(first);
  const [stopped] = (await first.call(`/v1/video/downloads?volume=${f.v.id}`)).downloads;
  assert.equal(stopped.state, "queued", "a dropped connection waits for the hub instead of failing");
  assert.ok(stopped.done >= 2 * 8 * 1024 && stopped.done < film.length, "and keeps the bytes it received");
  proxy.control.cut = null;
  await first.close();

  const second = await replicaAt(t, f, first.home);
  second.replica.engine.config.hub.url = proxy.url;
  proxy.control.ranges.length = 0;
  await second.downloads.wake();
  assert.equal(proxy.control.ranges[0], `bytes=${stopped.done}-${stopped.done + 8 * 1024 - 1}`, "the restarted daemon asks only for what is missing");
  const [row] = (await second.call(`/v1/video/downloads?volume=${f.v.id}`)).downloads;
  assert.equal(row.state, "done");
  assert.equal(row.hash, movie.hash);
  const folder = path.join(first.home, "video-downloads");
  assert.deepEqual(fs.readFileSync(path.join(folder, fs.readdirSync(folder).find((file) => file.endsWith(".mkv")))), film);
  await second.close();
});

test("a title whose file changed on the hub starts over with the new file", async (t) => {
  const f = await hub(t);
  const { movie, name } = await movieLibrary(f);
  const r = await replicaOf(t, f);
  const proxy = await relay(t, r.replica.engine.config.hub.url);
  r.replica.engine.config.hub.url = proxy.url;
  proxy.control.cut = (count) => (count === 2 ? 1000 : 0);
  await r.call("/v1/video/download", { volume: f.v.id, paths: [name] });
  await idle(r);
  assert.equal((await r.call(`/v1/video/downloads?volume=${f.v.id}`)).downloads[0].state, "queued");
  const changed = clip({ seconds: 4, tone: 4321 });
  fs.writeFileSync(path.join(f.v.path, name), changed);
  await f.daemon.engine.cycle();
  const fresh = (await f.settled()).movies[0];
  assert.notEqual(fresh.hash, movie.hash);
  proxy.control.cut = null;
  proxy.control.ranges.length = 0;
  await r.downloads.wake();
  assert.equal(proxy.control.ranges[0], "bytes=0-8191", "the partial copy of the old file is discarded");
  const [row] = (await r.call(`/v1/video/downloads?volume=${f.v.id}`)).downloads;
  assert.equal(row.state, "done");
  assert.equal(row.hash, fresh.hash, "the download follows the hub's new identity");
  assert.equal(row.size, changed.length);
  const folder = path.join(r.home, "video-downloads");
  assert.deepEqual(fs.readFileSync(path.join(folder, fs.readdirSync(folder).find((file) => file.endsWith(".mkv")))), changed);
  assert.equal(r.downloads.local(f.v.id, name, movie.hash), null, "the old identity never plays from the copy");
  assert.ok(r.downloads.local(f.v.id, name, fresh.hash));
});

test("a file that changes on the hub between the library and the next chunk is caught and fetched again", async (t) => {
  const f = await hub(t);
  const { name } = await movieLibrary(f);
  const r = await replicaOf(t, f);
  const proxy = await relay(t, r.replica.engine.config.hub.url);
  r.replica.engine.config.hub.url = proxy.url;
  const changed = clip({ seconds: 4, tone: 2468 });
  let swap = null;
  proxy.control.cut = (count) => {
    if (count === 2) swap = (async () => {
      fs.writeFileSync(path.join(f.v.path, name), changed);
      await f.daemon.engine.cycle();
      await f.settled();
    })();
    return 0;
  };
  const original = r.downloads.fetchMedia.bind(r.downloads);
  r.downloads.fetchMedia = async (...args) => {
    try {
      return await original(...args);
    } finally {
      await swap;
    }
  };
  let restarts = 0;
  const restart = r.downloads.restart.bind(r.downloads);
  r.downloads.restart = (...args) => (restarts++, restart(...args));
  await r.call("/v1/video/download", { volume: f.v.id, paths: [name] });
  await idle(r);
  assert.ok(restarts >= 1, "the stale answer sent the download back to the library");
  const fresh = (await f.library()).movies[0];
  const [row] = (await r.call(`/v1/video/downloads?volume=${f.v.id}`)).downloads;
  assert.equal(row.state, "done", row.error);
  assert.equal(row.hash, fresh.hash);
  const folder = path.join(r.home, "video-downloads");
  assert.deepEqual(fs.readFileSync(path.join(folder, fs.readdirSync(folder).find((file) => file.endsWith(".mkv")))), changed, "a mix of old and new bytes is never kept");
});

test("cancel stops a download and removes its partial file", async (t) => {
  const f = await hub(t);
  const { name } = await movieLibrary(f);
  const r = await replicaOf(t, f);
  const proxy = await relay(t, r.replica.engine.config.hub.url);
  r.replica.engine.config.hub.url = proxy.url;
  proxy.control.cut = (count) => (count === 2 ? 100 : 0);
  await r.call("/v1/video/download", { volume: f.v.id, paths: [name] });
  await idle(r);
  const folder = path.join(r.home, "video-downloads");
  assert.ok(fs.readdirSync(folder).some((file) => file.endsWith(".part")));
  await r.call("/v1/video/download/remove", { volume: f.v.id, paths: [] });
  await r.call("/v1/video/download/cancel", { volume: f.v.id, paths: [name] });
  assert.deepEqual(fs.readdirSync(folder), []);
  assert.deepEqual((await r.call(`/v1/video/downloads?volume=${f.v.id}`)).downloads, []);
});

const stored = (r) => (fs.existsSync(path.join(r.home, "video-downloads")) ? fs.readdirSync(path.join(r.home, "video-downloads")) : []);
const rows = async (r, f) => (await r.call(`/v1/video/downloads?volume=${f.v.id}`)).downloads;
async function interrupted(t, f, r) {
  const proxy = await relay(t, r.replica.engine.config.hub.url);
  r.replica.engine.config.hub.url = proxy.url;
  proxy.control.cut = (count) => (count === 2 ? 1000 : 0);
  return proxy;
}
async function held(t, f, r, name) {
  const proxy = await relay(t, r.replica.engine.config.hub.url);
  r.replica.engine.config.hub.url = proxy.url;
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  proxy.control.hold = (req) => (req.url.startsWith("/v1/video/media") ? gate : null);
  await r.call("/v1/video/download", { volume: f.v.id, paths: [name] });
  while (!(r.downloads.current && proxy.control.ranges.length)) await new Promise((resolve) => setTimeout(resolve, 5));
  return { proxy, release };
}

test("a copy the hub has since changed can still be removed, and a title gone from the hub mid-download disappears with its partial file", async (t) => {
  const f = await hub(t);
  const { name } = await movieLibrary(f);
  const r = await replicaOf(t, f);
  await r.call("/v1/video/download", { volume: f.v.id, paths: [name] });
  await idle(r);
  fs.writeFileSync(path.join(f.v.path, name), clip({ seconds: 4, tone: 999 }));
  await f.daemon.engine.cycle();
  await f.settled();
  assert.equal((await rows(r, f))[0].state, "done");
  await r.call("/v1/video/download/remove", { volume: f.v.id, paths: [name] });
  assert.deepEqual(stored(r), [], "a copy of an older file is removed like any other");


  const g = await hub(t);
  const second = await movieLibrary(g);
  fs.writeFileSync(path.join(g.v.path, "Ronin (1998).mkv"), clip({ seconds: 2, tone: 779 }));
  await g.daemon.engine.cycle();
  await g.settled();
  const s = await replicaOf(t, g);
  await interrupted(t, g, s);
  await s.call("/v1/video/download", { volume: g.v.id, paths: [second.name] });
  await idle(s);
  assert.ok(stored(s).some((file) => file.endsWith(".part")));
  fs.rmSync(path.join(g.v.path, "Heat (1995)"), { recursive: true });
  await g.daemon.engine.cycle();
  await g.settled();
  await s.downloads.wake();
  assert.deepEqual(await rows(s, g), [], "a download of a title gone from the hub disappears");
  assert.deepEqual(stored(s), [], "with its partial file");
});

test("a failure outside the transfer never escapes as an unhandled rejection", async (t) => {
  const f = await hub(t);
  const { name } = await movieLibrary(f);
  const r = await replicaOf(t, f);
  const escaped = [];
  const listen = (error) => escaped.push(error);
  process.on("unhandledRejection", listen);
  t.after(() => process.off("unhandledRejection", listen));
  const { release } = await held(t, f, r, name);
  r.downloads.erase = () => {
    throw Object.assign(new Error("resource busy"), { code: "EBUSY" });
  };
  await r.call("/v1/video/download/cancel", { volume: f.v.id, paths: [name] });
  release();
  await r.downloads.wake();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(escaped, []);
});

test("retrying a failed download keeps its partial file, and a full disk says so", async (t) => {
  const f = await hub(t);
  const { film, name } = await movieLibrary(f);
  const r = await replicaOf(t, f);
  const proxy = await interrupted(t, f, r);
  await r.call("/v1/video/download", { volume: f.v.id, paths: [name] });
  await idle(r);
  const kept = (await rows(r, f))[0].done;
  const fetchMedia = r.downloads.fetchMedia;
  r.downloads.fetchMedia = async () => {
    throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC", syscall: "write" });
  };
  await r.downloads.wake();
  const [full] = await rows(r, f);
  assert.deepEqual([full.state, full.error, full.done], ["failed", "Not enough free space on this computer to finish the download", kept]);
  r.downloads.fetchMedia = fetchMedia;
  proxy.control.cut = null;
  proxy.control.ranges.length = 0;
  await r.call("/v1/video/download", { volume: f.v.id, paths: [name] });
  await idle(r);
  assert.equal(proxy.control.ranges[0], `bytes=${kept}-${kept + 8 * 1024 - 1}`, "the retry continues where the failure stopped");
  assert.equal((await rows(r, f))[0].state, "done");
  assert.equal((await rows(r, f))[0].size, film.length);
});

test("saved positions reach the hub while a long download runs, and never overwrite a newer one", async (t) => {
  const f = await hub(t);
  const { movie, name } = await movieLibrary(f);
  const r = await replicaOf(t, f);
  const { proxy, release } = await held(t, f, r, name);
  r.replica.engine.hubUnavailable = true;
  await r.call("/v1/video/watched", { volume: f.v.id, path: name, watched: true });
  r.replica.engine.hubUnavailable = false;
  void r.downloads.wake();
  await r.downloads.flushing;
  assert.equal((await f.library()).movies[0].watched, true, "the outbox is not stuck behind the download");
  release();
  await idle(r);

  r.replica.engine.hubUnavailable = true;
  await r.call("/v1/video/position", { volume: f.v.id, path: name, hash: movie.hash, position: 300, duration: 6000 });
  r.replica.engine.hubUnavailable = false;
  let open;
  const late = new Promise((resolve) => (open = resolve));
  let first = true;
  proxy.control.hold = (req) => {
    if (!req.url.startsWith("/v1/video/position") || !first) return null;
    first = false;
    return late;
  };
  void r.downloads.wake();
  while (first) await new Promise((resolve) => setTimeout(resolve, 5));
  const live = r.call("/v1/video/position", { volume: f.v.id, path: name, hash: movie.hash, position: 600, duration: 6000 });
  await new Promise((resolve) => setTimeout(resolve, 50));
  open();
  await live;
  await r.downloads.flushing;
  assert.equal((await f.library()).movies[0].position.position, 600, "the live position is sent after the older saved one");
});

test("downloads resume while sync is paused once the hub is back", async (t) => {
  const f = await hub(t);
  const { name } = await movieLibrary(f);
  const r = await replicaOf(t, f);
  const proxy = await interrupted(t, f, r);
  await r.call("/v1/video/download", { volume: f.v.id, paths: [name] });
  await idle(r);
  proxy.control.cut = null;
  r.replica.engine.setPaused(true);
  r.replica.engine.hubUnavailable = true;
  await r.replica.engine.cycle();
  for (let i = 0; i < 400 && r.replica.engine.hubUnavailable; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  await r.downloads.wake();
  assert.equal((await rows(r, f))[0].state, "done");
});

test("erasing the device stops an active download first and leaves downloads usable", async (t) => {
  const f = await hub(t);
  const { name } = await movieLibrary(f);
  const r = await replicaOf(t, f);
  const { release } = await held(t, f, r, name);
  t.after(release);
  await r.replica.engine.destroyReplica();
  assert.equal(r.downloads.current, null, "the transfer was stopped before the files were removed");
  assert.equal(r.downloads.running, null);
  assert.equal(fs.existsSync(path.join(r.home, "video-downloads")), false);
  assert.equal(r.replica.engine.store.db.prepare("SELECT count(*) AS n FROM video_downloads").get().n, 0);
  release();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(fs.existsSync(path.join(r.home, "video-downloads")), false);
  assert.deepEqual(r.downloads.list("any").downloads, []);
});

test("a stopped download saves no more art, online sidecars come from the hub, and a copy deleted by hand downloads again", async (t) => {
  const f = await hub(t);
  const { movie, name } = await movieLibrary(f);
  const r = await replicaOf(t, f);
  await r.call("/v1/video/download", { volume: f.v.id, paths: [name] });
  await idle(r);
  const row = { ...r.replica.engine.store.db.prepare("SELECT * FROM video_downloads").get(), file: `${"f".repeat(32)}.mkv` };
  await assert.rejects(r.downloads.art(row, movie, null, AbortSignal.abort()));
  assert.equal(stored(r).some((file) => file.startsWith("f".repeat(32))), false);

  fs.writeFileSync(path.join(f.v.path, "Heat (1995)", "Heat (1995).es.srt"), "1\n00:00:01,000 --> 00:00:02,000\nHola de nuevo\n");
  await f.daemon.engine.cycle();
  await f.settled();
  const sidecar = `/v1/video/subtitles?${new URLSearchParams({ volume: f.v.id, path: "Heat (1995)/Heat (1995).es.srt", format: "json" })}`;
  assert.match((await r.call(sidecar)).text, /Hola de nuevo/, "online, the hub's fixed sidecar wins");
  const hubUrl = r.replica.engine.config.hub.url;
  offline(r);
  assert.match((await r.call(sidecar)).text, /Hola\n/, "offline, the saved copy answers");
  r.replica.engine.config.hub.url = hubUrl;
  r.replica.engine.hubUnavailable = false;

  const video = stored(r).find((file) => file.endsWith(".mkv"));
  fs.rmSync(path.join(r.home, "video-downloads", video));
  const [missing] = await rows(r, f);
  assert.deepEqual([missing.state, missing.error], ["failed", "The downloaded file is missing. Download it again."]);
  await r.call("/v1/video/download", { volume: f.v.id, paths: [name] });
  await idle(r);
  assert.equal((await rows(r, f))[0].state, "done");
  assert.ok(fs.existsSync(path.join(r.home, "video-downloads", video)));
});

test("download routes refuse a browser session and a caller that is not this computer", async () => {
  const { videoRoute } = await import("../packages/daemon/video-routes.js");
  const context = (extra) => ({
    req: { method: "GET", headers: {} },
    url: new URL("http://local/v1/video/downloads?volume=v"),
    route: "/v1/video/downloads",
    send: () => assert.fail("must not answer"),
    admin: true,
    browserSession: false,
    remote: "127.0.0.1",
    engine: { videoDownloads: { list: () => ({ downloads: [] }) }, config: {} },
    config: { role: "replica" },
    ...extra,
  });
  await assert.rejects(videoRoute(context({ browserSession: true })), { status: 403, message: "Use the local desktop application" });
  await assert.rejects(videoRoute(context({ remote: "192.168.1.20" })), { status: 403, message: "Use the local desktop application" });
  await assert.rejects(videoRoute(context({ config: { role: "hub" } })), { status: 403 });
  let answered = null;
  await videoRoute(context({ send: (status, value) => (answered = [status, value]) }));
  assert.deepEqual(answered, [200, { downloads: [] }]);
});

test("a saved position the live path already replaced is never sent after it", async (t) => {
  const f = await hub(t);
  const { movie, name } = await movieLibrary(f);
  const r = await replicaOf(t, f);
  const proxy = await relay(t, r.replica.engine.config.hub.url);
  r.replica.engine.config.hub.url = proxy.url;
  r.replica.engine.hubUnavailable = true;
  await r.call("/v1/video/position", { volume: f.v.id, path: name, hash: movie.hash, position: 300, duration: 6000 });
  r.replica.engine.hubUnavailable = false;
  const gates = [];
  proxy.control.hold = (req) => {
    if (!req.url.startsWith("/v1/video/position")) return null;
    let open;
    const gate = new Promise((resolve) => (open = resolve));
    gates.push(open);
    return gate;
  };
  const live = r.call("/v1/video/position", { volume: f.v.id, path: name, hash: movie.hash, position: 600, duration: 6000 });
  while (!gates.length) await new Promise((resolve) => setTimeout(resolve, 5));
  void r.downloads.wake();
  for (let i = 0; i < 100 && gates.length < 2 && r.downloads.flushing; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  gates[0]();
  await live;
  gates[1]?.();
  await r.downloads.flushing;
  assert.equal((await f.library()).movies[0].position.position, 600);
});

test("Erase and shutdown never wait for a slow hub answer", async (t) => {
  const f = await hub(t);
  const { name } = await movieLibrary(f);
  const r = await replicaOf(t, f);
  const proxy = await relay(t, r.replica.engine.config.hub.url);
  r.replica.engine.config.hub.url = proxy.url;
  const never = new Promise(() => {});
  let seen = 0;
  let art = 0;
  proxy.control.hold = (req) => (req.url.startsWith("/v1/video/watched") ? (seen++, never) : req.url.startsWith("/v1/video/art") ? (art++, never) : null);
  r.replica.engine.hubUnavailable = true;
  await r.call("/v1/video/watched", { volume: f.v.id, path: name, watched: true });
  r.replica.engine.hubUnavailable = false;
  void r.downloads.wake();
  while (!seen) await new Promise((resolve) => setTimeout(resolve, 5));
  let started = Date.now();
  await r.downloads.halt();
  assert.ok(Date.now() - started < 2000, "a pending saved position does not hold up Erase");

  r.replica.engine.store.db.exec("DELETE FROM video_outbox");
  await r.call("/v1/video/download", { volume: f.v.id, paths: [name] });
  while (!art) await new Promise((resolve) => setTimeout(resolve, 5));
  started = Date.now();
  await r.downloads.halt();
  assert.ok(Date.now() - started < 2000, "nor does a poster the hub is slow to send");
});

test("downloads disappear when a fresh hub library no longer has them, and stay while the hub is away or the file only changed", async (t) => {
  const f = await hub(t);
  const { movie, name } = await movieLibrary(f);
  const extra = clip({ seconds: 2, tone: 777 });
  fs.writeFileSync(path.join(f.v.path, "Ronin (1998).mkv"), extra);
  await f.daemon.engine.cycle();
  const other = (await f.settled()).movies.find((item) => item.path === "Ronin (1998).mkv");
  const r = await replicaOf(t, f);
  await r.call("/v1/video/download", { volume: f.v.id, paths: [name, other.path] });
  await idle(r);
  assert.equal((await rows(r, f)).filter((row) => row.state === "done").length, 2);

  fs.writeFileSync(path.join(f.v.path, other.path), clip({ seconds: 2, tone: 778 }));
  fs.rmSync(path.join(f.v.path, "Heat (1995)"), { recursive: true });
  await f.daemon.engine.cycle();
  await f.settled();
  const hubUrl = r.replica.engine.config.hub.url;
  offline(r);
  assert.equal((await r.call(`/v1/video/library?volume=${f.v.id}`)).offline, true);
  assert.equal((await rows(r, f)).length, 2, "the saved library never removes anything");
  r.replica.engine.config.hub.url = hubUrl;
  r.replica.engine.hubUnavailable = false;

  await r.call(`/v1/video/library?volume=${f.v.id}`);
  const left = await rows(r, f);
  assert.deepEqual(left.map((row) => [row.path, row.state, row.hash]), [[other.path, "done", other.hash]], "the dropped title is gone, the changed file stays as an older copy");
  assert.equal(stored(r).filter((file) => file.endsWith(".mkv")).length, 1, "the dropped title's files are freed");
  assert.equal(r.downloads.local(f.v.id, name, movie.hash), null);
});

test("downloads disappear when the hub deletes the folder, and when the device links to another hub but not to the same one again", async (t) => {
  const f = await hub(t);
  const { name } = await movieLibrary(f);
  const r = await replicaOf(t, f);
  await r.call("/v1/video/download", { volume: f.v.id, paths: [name] });
  await idle(r);
  await r.call("/v1/disconnect", { confirmed: true });
  const again = await f.call("/v1/devices", { name: "Desk again", role: "replica" });
  await r.call("/v1/connect", { url: `http://127.0.0.1:${f.daemon.port}`, token: again.token });
  await r.replica.engine.cycle();
  await r.downloads.wake();
  assert.equal((await rows(r, f)).length, 1, "reconnecting to the same hub keeps the downloads");

  f.s.addVolume("Documents");
  await f.call("/v1/delete-share", { id: f.v.id, confirmedName: f.v.name });
  await r.replica.engine.cycle();
  assert.equal(r.replica.engine.store.db.prepare("SELECT count(*) AS n FROM video_downloads").get().n, 0, "a folder the hub no longer lists takes its downloads with it");
  assert.deepEqual(stored(r), []);

  const g = await hub(t);
  const second = await movieLibrary(g);
  const s = await replicaOf(t, g);
  await s.call("/v1/video/download", { volume: g.v.id, paths: [second.name] });
  await idle(s);
  await s.call("/v1/disconnect", { confirmed: true });
  const other = await hub(t);
  const token = await other.call("/v1/devices", { name: "Desk", role: "replica" });
  await s.call("/v1/connect", { url: `http://127.0.0.1:${other.daemon.port}`, token: token.token });
  assert.equal(s.replica.engine.store.db.prepare("SELECT count(*) AS n FROM video_downloads").get().n, 0, "another hub's downloads are removed");
  assert.deepEqual(stored(s), []);
});

test("an empty fresh library or an empty catalog never removes downloads", async (t) => {
  const f = await hub(t);
  const { name } = await movieLibrary(f);
  const r = await replicaOf(t, f);
  await r.call("/v1/video/download", { volume: f.v.id, paths: [name] });
  await idle(r);
  r.downloads.pruneLibrary(f.v.id, { version: "empty", movies: [], shows: [], other: [] });
  assert.equal((await rows(r, f)).length, 1, "a hub whose disk is missing lists nothing; that is not every title leaving");
  r.downloads.pruneCatalog([]);
  assert.equal((await rows(r, f)).length, 1, "nor is a catalog with no folders");
  r.downloads.pruneLibrary(f.v.id, { version: "other", movies: [{ path: "Ronin (1998).mkv", hash: "a".repeat(64) }], shows: [], other: [] });
  assert.deepEqual(await rows(r, f), [], "a library that still lists other titles removes the missing one");
  assert.deepEqual(stored(r), []);
});

test("a hub whose video disk is missing keeps every download through a fresh library", async (t) => {
  const f = await hub(t);
  const { name } = await movieLibrary(f);
  const r = await replicaOf(t, f);
  await r.call("/v1/video/download", { volume: f.v.id, paths: [name] });
  await idle(r);
  const value = await r.call(`/v1/video/library?volume=${f.v.id}`);
  const key = `${r.replica.engine.config.hub.id}:video-library:${f.v.id}`;
  r.replica.engine.store.db.prepare("DELETE FROM remote_views WHERE key=?").run(key);
  const library = f.daemon.engine.video.library.bind(f.daemon.engine.video);
  f.daemon.engine.video.library = (...args) => ({ ...library(...args), version: `${value.version}-empty`, movies: [], shows: [], other: [] });
  const empty = await r.call(`/v1/video/library?volume=${f.v.id}`);
  f.daemon.engine.video.library = library;
  assert.deepEqual([empty.movies, empty.offline], [[], undefined]);
  assert.equal((await rows(r, f)).length, 1);
});
