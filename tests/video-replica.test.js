import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { init } from "../packages/daemon/storage.js";
import { start } from "../packages/daemon/server.js";
import { api, clip, hub, image } from "./video-support.js";

async function replicaOf(t, f) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-video-replica-"));
  init(home, { port: 0, name: "Desk", role: "replica" });
  const replica = await start(home, { timer: false });
  t.after(async () => {
    await replica.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const call = api(replica.port, replica.engine.config.adminToken);
  const desk = await f.call("/v1/devices", { name: "Desk", role: "replica" });
  await call("/v1/connect", { url: `http://127.0.0.1:${f.daemon.port}`, token: desk.token });
  await replica.engine.cycle();
  return { replica, call, home, base: `http://127.0.0.1:${replica.port}` };
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

test("a replica never keeps a Movies & TV folder: selecting is refused and an earlier copy is forgotten with its files kept", async (t) => {
  const f = await hub(t);
  const film = clip({ seconds: 2, tone: 3000 });
  const hash = await f.propose("Heat (1995)/Heat (1995).mp4", film);
  const r = await replicaOf(t, f);
  await r.call("/v1/select", { id: f.v.id });
  await r.replica.engine.cycle();
  const local = path.join(r.replica.engine.store.volume(f.v.id).path, "Heat (1995)", "Heat (1995).mp4");
  assert.ok(fs.existsSync(local), "an ordinary folder syncs as before");
  await f.call("/v1/video/mark", { volume: f.v.id });
  await f.settled();
  await r.replica.engine.cycle();
  assert.equal(r.replica.engine.store.volumes().some((v) => v.id === f.v.id), false, "once it becomes a video library the replica lets it go");
  assert.ok(fs.existsSync(local), "and keeps every file it had");
  await assert.rejects(r.call("/v1/select", { id: f.v.id }), { status: 409, message: "Movies & TV folders live only on the hub. Play them from the library." });
  assert.equal(r.replica.engine.promotionPlan().catalog.some((v) => v.id === f.v.id), false, "a video folder never blocks promoting this replica");
  const listed = await r.call(`/v1/video/library?volume=${f.v.id}`);
  assert.equal(listed.movies[0].hash, hash, "the library still streams from the hub");
  const desk = await f.call("/v1/devices", { name: "Phone", role: "replica" });
  await assert.rejects(
    f.call("/v1/propose", { volume: f.v.id, path: "Up (2009).mp4", hash, size: film.length, base: 0 }, desk.token),
    { status: 403 },
    "devices never write into a video folder",
  );
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
