import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { init, quickHashFile } from "../packages/daemon/storage.js";
import { start } from "../packages/daemon/server.js";
import { api, clip, hub, image } from "./video-support.js";

async function replicaOf(t, f) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-video-replica-"));
  init(home, { port: 0, name: "Desk", role: "replica" });
  const replica = await start(home, { timer: false });
  t.after(async () => {
    await replica.close();
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const call = api(replica.port, replica.engine.config.adminToken);
  const desk = await f.call("/v1/devices", { name: "Desk", role: "replica" });
  await call("/v1/connect", { url: `http://127.0.0.1:${f.daemon.port}`, token: desk.token });
  await replica.engine.cycle();
  return { replica, call, home, base: `http://127.0.0.1:${replica.port}` };
}

function outside(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arca-kept-videos-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return path.join(dir, "films");
}

async function library(f) {
  await f.call("/v1/video/mark", { volume: f.v.id });
  const film = clip({ seconds: 2, tone: 3000 });
  const hash = await f.propose("Heat (1995)/Heat (1995).mp4", film);
  await f.propose("Heat (1995)/Heat (1995).es.srt", Buffer.from("1\n00:00:01,000 --> 00:00:02,000\nHola\n"));
  await f.propose("Heat (1995)/poster.jpg", await image("red"));
  await f.settled();
  return { film, hash, name: "Heat (1995)/Heat (1995).mp4" };
}

test("a replica that has not selected a video folder browses, streams with ranges and saves progress through the hub", async (t) => {
  const f = await hub(t);
  const { film, hash, name } = await library(f);
  const r = await replicaOf(t, f);
  assert.equal(r.replica.engine.config.catalog.find((row) => row.id === f.v.id).video, true);
  assert.equal((await r.call("/v1/status")).volumes.length, 0, "the folder is not selected here");
  const hubLibrary = await f.library();
  const listed = await r.call(`/v1/video/library?volume=${f.v.id}`);
  assert.deepEqual(listed, hubLibrary);
  assert.deepEqual(await r.call(`/v1/video/library?volume=${f.v.id}&version=${listed.version}`), {
    version: listed.version,
    indexing: false,
    matching: false,
    tmdb: "none",
    unchanged: true,
  });
  const [movie] = listed.movies;
  assert.match((await r.call(`/v1/video/art?${new URLSearchParams({ volume: f.v.id, key: movie.poster })}`)).data, /^data:image\/jpeg/);
  const query = new URLSearchParams({ volume: f.v.id, path: name, hash });
  let response = await fetch(`${r.base}/v1/video/media?${query}`, {
    headers: { Authorization: `Bearer ${r.replica.engine.config.adminToken}`, Range: "bytes=3-12" },
  });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), `bytes 3-12/${film.length}`);
  assert.equal(response.headers.get("content-type"), "video/mp4");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), film.subarray(3, 13));
  response = await fetch(`${r.base}/v1/video/media?${query}`, {
    method: "HEAD",
    headers: { Authorization: `Bearer ${r.replica.engine.config.adminToken}` },
  });
  assert.equal(response.status, 200);
  assert.equal(Number(response.headers.get("content-length")), film.length);
  response = await fetch(`${r.base}/v1/video/media?${query}`, {
    headers: { Authorization: `Bearer ${r.replica.engine.config.adminToken}`, Range: `bytes=${film.length}-` },
  });
  assert.equal(response.status, 416, "an impossible range is refused by the hub and passed on");
  const playback = await r.call(`/v1/video/playback?${query}`);
  assert.match(playback.url, new RegExp(`^${r.base}/v1/video/media\\?ticket=`));
  assert.deepEqual(playback.subtitles, [{ path: "Heat (1995)/Heat (1995).es.srt", label: "Spanish", language: "es" }]);
  response = await fetch(playback.url, { headers: { Range: "bytes=0-4" } });
  assert.equal(response.status, 206);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), film.subarray(0, 5));
  response = await fetch(`${r.base}/v1/video/subtitles?${new URLSearchParams({ volume: f.v.id, path: playback.subtitles[0].path })}`, {
    headers: { Authorization: `Bearer ${r.replica.engine.config.adminToken}` },
  });
  assert.equal(response.headers.get("content-type"), "text/vtt; charset=utf-8");
  assert.match(await response.text(), /^WEBVTT\n\n1\n00:00:01\.000 --> 00:00:02\.000\nHola/);
  const subtitleQuery = new URLSearchParams({ volume: f.v.id, path: "Heat (1995)/Heat (1995).es.srt", format: "json" });
  const json = await r.call(`/v1/video/subtitles?${subtitleQuery}`);
  assert.deepEqual(json, await f.call(`/v1/video/subtitles?${subtitleQuery}`), "the JSON form is forwarded from the hub");
  assert.match(json.text, /^WEBVTT\n\n1\n00:00:01\.000 --> 00:00:02\.000\nHola/);
  const phoneJson = await f.call("/v1/devices", { name: "Phone", role: "replica" });
  await assert.rejects(r.call(`/v1/video/subtitles?${subtitleQuery}`, undefined, phoneJson.token), { status: 401 });

  assert.deepEqual(await r.call("/v1/video/position", { volume: f.v.id, path: name, hash, position: 300, duration: 6000 }), { kept: true });
  const progress = await f.library();
  assert.equal(progress.movies[0].position.device, "Desk", "the hub records the replica as the device");
  assert.deepEqual(progress.continue, [movie.id]);
  await r.call("/v1/video/watched", { volume: f.v.id, path: name, watched: true });
  assert.equal((await f.library()).movies[0].watched, true);
  for (const [route, body] of [
    ["/v1/video/kids", { volume: f.v.id, id: movie.id, kids: true }],
    ["/v1/video/match", { volume: f.v.id, id: movie.id, none: true }],
    ["/v1/video/settings", { country: "ES" }],
    ["/v1/video/settings"],
    ["/v1/video/tmdb-search?query=heat&type=movie"],
    ["/v1/video/tmdb-image?path=%2Fheat.jpg"],
  ])
    await assert.rejects(r.call(route, body), { status: 403, message: "Manage video settings and matches on the hub" }, route);
  assert.equal(f.daemon.engine.config.video, undefined);
  await assert.rejects(r.call("/v1/video/mark", { volume: f.v.id }), { status: 409 }, "a replica never enables a video library");
  await assert.rejects(r.call(`/v1/video/library?volume=missing`), { status: 404 });
  const errors = await r.call(`/v1/video/watched`, { volume: f.v.id, path: "none.mp4", watched: true }).catch((error) => error);
  assert.equal(errors.status, 404);
  assert.equal(errors.message, "This video is no longer available", "the hub's error reaches the replica's caller");

  const phone = await f.call("/v1/devices", { name: "Phone", role: "replica" });
  await assert.rejects(r.call(`/v1/video/library?volume=${f.v.id}`, undefined, phone.token), { status: 401 }, "only the replica's own administrator uses its video routes");
});

test("a replica keeps a Movies & TV folder as a two-way copy with the hub's fingerprints, uploads into it and deletes through it", async (t) => {
  const f = await hub(t);
  await f.call("/v1/video/mark", { volume: f.v.id });
  const film = clip({ seconds: 2, tone: 3000 });
  fs.writeFileSync(path.join(f.v.path, "Heat (1995).mp4"), film);
  await f.daemon.engine.cycle();
  const hubFile = path.join(f.v.path, "Heat (1995).mp4");
  const hash = f.s.current(f.v.id, "Heat (1995).mp4").hash;
  assert.equal(hash, quickHashFile(hubFile), "the hub keeps the sampled fingerprint");
  const r = await replicaOf(t, f);
  const store = r.replica.engine.store;
  const destination = outside(t);
  await r.call("/v1/select", { id: f.v.id, mode: "keep", path: destination });
  await r.replica.engine.cycle();
  const local = path.join(destination, "Heat (1995).mp4");
  assert.deepEqual(fs.readFileSync(local), film, "the kept copy is an ordinary file");
  assert.equal(store.current(f.v.id, "Heat (1995).mp4").hash, hash, "with the same fingerprint, so nothing downloads again");
  assert.deepEqual(store.mediaModes(), {}, "Keep is a selection, not a media mode");
  assert.equal(fs.readdirSync(store.objects).filter((name) => /^[a-f0-9]{64}$/.test(name)).length, 0, "and no copy stays in the replica's objects");

  const added = clip({ seconds: 1, tone: 3100 });
  fs.writeFileSync(path.join(destination, "Up (2009).mp4"), added);
  await r.replica.engine.cycle();
  const up = path.join(f.v.path, "Up (2009).mp4");
  assert.deepEqual(fs.readFileSync(up), added, "a film added on the replica reaches the hub's folder");
  assert.equal(f.s.current(f.v.id, "Up (2009).mp4").hash, quickHashFile(up), "under its sampled fingerprint");
  assert.equal(store.current(f.v.id, "Up (2009).mp4").hash, quickHashFile(up));

  fs.rmSync(local);
  await r.replica.engine.cycle();
  assert.equal(fs.existsSync(hubFile), false, "deleting on the replica deletes on the hub");
  assert.deepEqual(fs.readFileSync(path.join(f.v.path, ".arca-versions", hash)), film, "and the hub keeps the film as a version beside it");
  const version = f.s.history(f.v.id, "Heat (1995).mp4").find((row) => row.hash === hash);
  await f.call("/v1/restore", { volume: f.v.id, path: "Heat (1995).mp4", rev: version.rev });
  assert.deepEqual(fs.readFileSync(hubFile), film, "restoring brings the film back");
  await r.replica.engine.cycle();
  assert.deepEqual(fs.readFileSync(local), film, "to the replica too");
});

test("a kept Movies & TV library plays from its local copy, offline too", async (t) => {
  const f = await hub(t);
  const { film, name } = await library(f);
  await f.daemon.engine.cycle();
  const r = await replicaOf(t, f);
  await r.call("/v1/select", { id: f.v.id, mode: "keep", path: outside(t) });
  await r.replica.engine.cycle();
  const listed = await r.call(`/v1/video/library?volume=${f.v.id}`);
  const movie = listed.movies[0];
  r.replica.engine.config.hub.url = "http://127.0.0.1:9";
  r.replica.engine.hubUnavailable = true;
  const query = new URLSearchParams({ volume: f.v.id, path: name, hash: movie.hash });
  const response = await fetch(`${r.base}/v1/video/media?${query}`, {
    headers: { Authorization: `Bearer ${r.replica.engine.config.adminToken}`, Range: "bytes=2-9" },
  });
  assert.equal(response.status, 206, "the kept file streams without the hub");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), film.subarray(2, 10));
  const { url } = await r.call(`/v1/video/playback?${query}`);
  assert.equal((await fetch(url, { headers: { Range: "bytes=0-3" } })).status, 206, "and the desktop player opens it offline");
});

test("Stop syncing a kept Movies & TV library with its files deletes the local copy", async (t) => {
  const f = await hub(t);
  await f.call("/v1/video/mark", { volume: f.v.id });
  fs.writeFileSync(path.join(f.v.path, "Heat (1995).mp4"), clip({ seconds: 1, tone: 3200 }));
  await f.daemon.engine.cycle();
  const r = await replicaOf(t, f);
  const destination = outside(t);
  await r.call("/v1/select", { id: f.v.id, mode: "keep", path: destination });
  await r.replica.engine.cycle();
  assert.ok(fs.existsSync(path.join(destination, "Heat (1995).mp4")));
  const result = await r.call("/v1/unselect", { id: f.v.id, deleteFiles: true });
  assert.equal(result.deleted, 1);
  assert.equal(fs.existsSync(path.join(destination, "Heat (1995).mp4")), false, "the film checked by its fingerprint is deleted");
});

test("promoting a replica that keeps a Movies & TV library leaves the library behind with its files and copies none of it", async (t) => {
  const f = await hub(t);
  await f.call("/v1/video/mark", { volume: f.v.id });
  const film = clip({ seconds: 1, tone: 3300 });
  fs.writeFileSync(path.join(f.v.path, "Heat (1995).mp4"), film);
  const docs = f.s.addVolume("Docs");
  fs.writeFileSync(path.join(docs.path, "note.txt"), "hello");
  await f.daemon.engine.cycle();
  const r = await replicaOf(t, f);
  const destination = outside(t);
  await r.call("/v1/select", { id: f.v.id, mode: "keep", path: destination });
  await r.call("/v1/select", { id: docs.id, path: outside(t) });
  await r.replica.engine.cycle();
  assert.equal((await r.call("/v1/promotion-plan")).ready, true);
  r.replica.engine.config.hub.url = "http://127.0.0.1:9";
  assert.equal((await r.call("/v1/promote", { confirmed: true })).promoted, true);
  const store = r.replica.engine.store;
  assert.equal(store.volumes().some((v) => v.id === f.v.id), false, "the library is not brought along");
  assert.deepEqual(fs.readFileSync(path.join(destination, "Heat (1995).mp4")), film, "its files stay on disk");
  const objects = fs.readdirSync(store.objects).filter((name) => /^[a-f0-9]{64}$/.test(name));
  assert.equal(objects.some((name) => fs.statSync(store.blob(name)).size === film.length), false, "and nothing of it is copied into objects");
});

test("a folder a replica already keeps becoming a Movies & TV library takes the new fingerprints without downloading again", async (t) => {
  const f = await hub(t);
  const film = clip({ seconds: 1, tone: 3400 });
  fs.writeFileSync(path.join(f.v.path, "Heat (1995).mp4"), film);
  await f.daemon.engine.cycle();
  const r = await replicaOf(t, f);
  const destination = outside(t);
  await r.call("/v1/select", { id: f.v.id, path: destination });
  await r.replica.engine.cycle();
  await f.call("/v1/video/mark", { volume: f.v.id });
  await f.daemon.engine.cycle();
  const downloads = [];
  const download = r.replica.engine.download.bind(r.replica.engine);
  r.replica.engine.download = (hash, size) => {
    downloads.push(hash);
    return download(hash, size);
  };
  const copies = [];
  const copy = fs.copyFileSync;
  t.after(() => {
    fs.copyFileSync = copy;
  });
  fs.copyFileSync = (from, to) => {
    copies.push(String(from));
    return copy(from, to);
  };
  await r.replica.engine.cycle();
  await r.replica.engine.cycle();
  fs.copyFileSync = copy;
  assert.deepEqual(copies.filter((from) => from.startsWith(destination)), [], "the kept films are never copied to be hashed again");
  const local = path.join(destination, "Heat (1995).mp4");
  assert.equal(r.replica.engine.store.current(f.v.id, "Heat (1995).mp4").hash, quickHashFile(local));
  assert.equal(f.s.current(f.v.id, "Heat (1995).mp4").hash, quickHashFile(local));
  assert.deepEqual(downloads, [], "nothing downloads again");
  assert.deepEqual(fs.readdirSync(r.replica.engine.store.objects).filter((name) => /^[a-f0-9]{64}$/.test(name)), [], "and nothing is copied into objects");
  assert.deepEqual(fs.readdirSync(destination).filter((name) => name.includes("conflict")), []);
  const store = r.replica.engine.store;
  store.db.prepare("DELETE FROM scan_cache").run();
  copies.length = 0;
  fs.copyFileSync = (from, to) => {
    copies.push(String(from));
    return copy(from, to);
  };
  assert.equal(store.capture(local, quickHashFile(local), false, true).hash, quickHashFile(local));
  fs.copyFileSync = copy;
  assert.deepEqual(copies, [], "a kept film whose fingerprint is already known is never copied to be hashed");
});

async function keptPair(t, tone) {
  const f = await hub(t);
  await f.call("/v1/video/mark", { volume: f.v.id });
  const film = clip({ seconds: 1, tone });
  fs.writeFileSync(path.join(f.v.path, "Heat.mp4"), film);
  await f.daemon.engine.cycle();
  const r = await replicaOf(t, f);
  const destination = outside(t);
  await r.call("/v1/select", { id: f.v.id, mode: "keep", path: destination });
  await r.replica.engine.cycle();
  return { f, r, film, destination, hash: f.s.current(f.v.id, "Heat.mp4").hash };
}

test("a version the hub cannot move beside its file after a device's deletion is never lost and never wedges the folder", async (t) => {
  const { f, r, film, destination } = await keptPair(t, 3500);
  const rename = fs.renameSync;
  t.after(() => {
    fs.renameSync = rename;
  });
  fs.renameSync = (from, to) => {
    if (String(to).includes(".arca-versions")) throw Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" });
    return rename(from, to);
  };
  fs.rmSync(path.join(destination, "Heat.mp4"));
  await r.replica.engine.cycle();
  await f.daemon.engine.cycle();
  await r.replica.engine.cycle();
  fs.renameSync = rename;
  assert.equal(f.s.db.prepare("SELECT count(*) AS n FROM pending").get().n, 0, "nothing is left to retry");
  assert.equal(r.replica.engine.folderStates.get(f.v.id).state, "synced");
  assert.deepEqual(fs.readFileSync(path.join(f.v.path, "Heat.mp4")), film, "the film the hub could not keep as a version stays as a file");
  assert.deepEqual(fs.readFileSync(path.join(destination, "Heat.mp4")), film, "and every copy agrees again");
});

test("a film replaced and then put back takes its kept version back instead of keeping a duplicate", async (t) => {
  const { f, r, film, destination, hash } = await keptPair(t, 3600);
  const other = clip({ seconds: 1, tone: 3700 });
  fs.writeFileSync(path.join(destination, "Heat.mp4"), other);
  await r.replica.engine.cycle();
  const versions = path.join(f.v.path, ".arca-versions");
  assert.deepEqual(fs.readdirSync(versions), [hash]);
  const replaced = f.s.current(f.v.id, "Heat.mp4").hash;
  fs.writeFileSync(path.join(destination, "Heat.mp4"), film);
  await r.replica.engine.cycle();
  assert.deepEqual(fs.readFileSync(path.join(f.v.path, "Heat.mp4")), film);
  assert.deepEqual(fs.readdirSync(versions), [replaced], "only the replaced film is kept, never a second copy of the current one");
});

test("a server replica keeps Movies & TV too, and a library kept the old way must be stopped before keeping it as a folder", async (t) => {
  const f = await hub(t);
  await f.call("/v1/video/mark", { volume: f.v.id });
  const r = await replicaOf(t, f);
  assert.notEqual(r.replica.engine.config.installation, "desktop");
  const films = outside(t);
  const kept = await r.call("/v1/select", { id: f.v.id, mode: "keep", path: films });
  assert.equal(kept.id, f.v.id);
  assert.ok(r.replica.engine.store.volume(f.v.id).selected, "a server keeps it as a selected folder");
  await r.call("/v1/unselect", { id: f.v.id });
  r.replica.engine.store.db.prepare("INSERT INTO media_modes(volume,mode) VALUES(?,'keep')").run(f.v.id);
  await assert.rejects(r.call("/v1/select", { id: f.v.id, mode: "keep", path: films }), { status: 409, message: "Stop syncing this library before choosing again." });
  assert.deepEqual(r.replica.engine.store.mediaModes(), { [f.v.id]: "keep" }, "nothing about the old library changes by itself");
  await r.call("/v1/unselect", { id: f.v.id });
  assert.deepEqual(r.replica.engine.store.mediaModes(), {});
});

test("offline, a replica refuses to start a video it holds no current copy of, and passes the hub's range errors on", async (t) => {
  const f = await hub(t);
  const { film, hash, name } = await library(f);
  const r = await replicaOf(t, f);
  const query = new URLSearchParams({ volume: f.v.id, path: name, hash });
  const response = await fetch(`${r.base}/v1/video/media?${query}`, {
    headers: { Authorization: `Bearer ${r.replica.engine.config.adminToken}`, Range: `bytes=${film.length + 5}-` },
  });
  assert.equal(response.status, 416);
  assert.equal(response.headers.get("content-range"), `bytes */${film.length}`);
  await r.call(`/v1/video/library?volume=${f.v.id}`);
  r.replica.engine.config.hub.url = "http://127.0.0.1:9";
  r.replica.engine.hubUnavailable = true;
  await assert.rejects(r.call(`/v1/video/playback?${query}`), { status: 503, message: "Connect to your hub to watch" });
});

test("a replica gives up on a hub that stops sending in the middle of a video", async (t) => {
  const f = await hub(t);
  const { hash, name } = await library(f);
  const r = await replicaOf(t, f);
  const http = await import("node:http");
  const stalled = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": "1000" });
    res.write(Buffer.alloc(10));
  });
  await new Promise((resolve) => stalled.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    stalled.closeAllConnections();
    stalled.close();
  });
  r.replica.engine.config.hub.url = `http://127.0.0.1:${stalled.address().port}`;
  r.replica.engine.videoIdleMs = 200;
  const response = await fetch(`${r.base}/v1/video/media?${new URLSearchParams({ volume: f.v.id, path: name, hash })}`, {
    headers: { Authorization: `Bearer ${r.replica.engine.config.adminToken}` },
  });
  assert.equal(response.status, 200);
  await assert.rejects(response.arrayBuffer(), "the stream ends with an error instead of hanging");
});

test("a client that pauses reading longer than the idle limit still gets the whole video", async (t) => {
  const f = await hub(t);
  const { hash, name } = await library(f);
  const r = await replicaOf(t, f);
  const http = await import("node:http");
  const size = 32 * 1024 * 1024;
  const steady = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": String(size) });
    let sent = 0;
    const chunk = Buffer.alloc(256 * 1024);
    const pump = () => {
      while (sent < size) {
        sent += chunk.length;
        if (!res.write(chunk)) return res.once("drain", pump);
      }
      res.end();
    };
    pump();
  });
  await new Promise((resolve) => steady.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    steady.closeAllConnections();
    steady.close();
  });
  r.replica.engine.config.hub.url = `http://127.0.0.1:${steady.address().port}`;
  r.replica.engine.videoIdleMs = 200;
  const response = await fetch(`${r.base}/v1/video/media?${new URLSearchParams({ volume: f.v.id, path: name, hash })}`, {
    headers: { Authorization: `Bearer ${r.replica.engine.config.adminToken}` },
  });
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal((await response.arrayBuffer()).byteLength, size);
});
