import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import ffmpeg from "ffmpeg-static";
import { init } from "../packages/daemon/storage.js";
import { start } from "../packages/daemon/server.js";
import { probeVideo } from "../packages/daemon/video.js";
import { EventEmitter } from "node:events";
import { VideoSessions, hlsArguments } from "../packages/daemon/video-sessions.js";
import { loopbackAllowed } from "../packages/daemon/video-routes.js";
import { playerRoute } from "../packages/daemon/machines.js";
import { api, clip, hub } from "./video-support.js";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "arca-compatible-"));
process.on("exit", () => fs.rmSync(scratch, { recursive: true, force: true }));
const made = new Map();
function film(kind) {
  if (made.has(kind)) return made.get(kind);
  const output = path.join(scratch, `${kind}.${["mp4", "gop", "silent"].includes(kind) ? "mp4" : "mkv"}`);
  const video = ["-f", "lavfi", "-i", "testsrc=duration=7:size=160x120:rate=10"];
  const tone = (frequency) => ["-f", "lavfi", "-i", `sine=frequency=${frequency}:duration=7`];
  const args = {
    ac3: [...video, ...tone(400), ...tone(800), "-map", "0:v", "-map", "1:a", "-map", "2:a", "-c:v", "libx264", "-preset", "ultrafast", "-g", "10", "-c:a:0", "ac3", "-ac:a:0", "6", "-c:a:1", "libmp3lame", "-disposition:a:0", "default"],
    hevc: [...video, ...tone(500), "-map", "0:v", "-map", "1:a", "-c:v", "libx265", "-preset", "ultrafast", "-x265-params", "keyint=10:log-level=none", "-c:a", "aac"],
    mp4: [...video, ...tone(600), "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-preset", "ultrafast", "-g", "10", "-c:a", "aac", "-ac", "1"],
    gop: ["-f", "lavfi", "-i", "testsrc=duration=25:size=160x120:rate=10", "-f", "lavfi", "-i", "sine=frequency=300:duration=25", "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-preset", "ultrafast", "-x264-params", "keyint=100:min-keyint=100:scenecut=0", "-c:a", "aac"],
    silent: [...video, "-map", "0:v", "-c:v", "libx264", "-preset", "ultrafast", "-g", "10"],
    late: ["-f", "lavfi", "-i", "testsrc=duration=25:size=160x120:rate=10", "-f", "lavfi", "-i", "sine=frequency=310:duration=25", "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-preset", "ultrafast", "-x264-params", "keyint=100:min-keyint=100:scenecut=0", "-c:a", "aac", "-output_ts_offset", "3"],
    bframes: ["-f", "lavfi", "-i", "testsrc=duration=25:size=160x120:rate=10", "-f", "lavfi", "-i", "sine=frequency=300:duration=25", "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-preset", "veryfast", "-bf", "3", "-x264-params", "keyint=50:min-keyint=50:scenecut=0", "-c:a", "ac3"],
  }[kind];
  execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...args, output]);
  made.set(kind, fs.readFileSync(output));
  return made.get(kind);
}

async function library(t, options = {}) {
  const f = await hub(t, { videoSessions: { sweepMs: 50, ...options } });
  await f.call("/v1/video/mark", { volume: f.v.id });
  const hashes = {
    ac3: await f.propose("Heat (1995).mkv", film("ac3")),
    hevc: await f.propose("Up (2009).mkv", film("hevc")),
    mp4: await f.propose("Coco (2017).mp4", film("mp4")),
  };
  await f.settled();
  const names = { ac3: "Heat (1995).mkv", hevc: "Up (2009).mkv", mp4: "Coco (2017).mp4" };
  const compatible = (kind, extra = {}, token) =>
    f.call(`/v1/video/compatible?${new URLSearchParams({ volume: f.v.id, path: names[kind], hash: hashes[kind], ...extra })}`, undefined, token);
  return { ...f, hashes, names, compatible };
}

const base = (f) => `http://127.0.0.1:${f.daemon.port}`;
const absolute = (f, url) => (url.startsWith("http") ? url : base(f) + url);
async function get(f, url, token) {
  return fetch(absolute(f, url), token ? { headers: { Authorization: `Bearer ${token}` } } : {});
}
async function segment(f, url, token, name = "seg-0.m4s") {
  const folder = absolute(f, url).replace(/index\.m3u8$/, "");
  const parts = [];
  for (const file of ["init.mp4", name]) {
    const response = await get(f, folder + file, token);
    assert.equal(response.status, 200, file);
    parts.push(Buffer.from(await response.arrayBuffer()));
  }
  const file = path.join(scratch, `${Math.random().toString(16).slice(2)}.mp4`);
  fs.writeFileSync(file, Buffer.concat(parts));
  return { probe: await probeVideo(file, "x.mp4"), init: parts[0] };
}
async function until(check, ms = 60000) {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
const playlistSeconds = (text) => [...text.matchAll(/#EXTINF:([\d.]+)/g)].reduce((sum, match) => sum + Number(match[1]), 0);

test("Erase revokes an already issued loopback HLS session", async (t) => {
  const f = await library(t);
  const answer = await f.compatible("mp4");
  assert.equal((await get(f, answer.url)).status, 200);
  const sessions = f.daemon.engine.videoSessions;
  const sequence = sessions.next("pending-playback");
  await f.call("/v1/destroy-hub", { confirmed: true });
  assert.equal(sessions.sessions.size, 0);
  assert.equal(sessions.current("pending-playback", sequence), false);
  assert.equal((await get(f, answer.url)).status, 401);
  assert.equal(fs.existsSync(path.join(f.home, "transcodes")), false);
});

test("an MKV with AC3 becomes HLS with fMP4 segments whose video is copied and audio is AAC", async (t) => {
  const f = await library(t);
  const answer = await f.compatible("ac3");
  assert.match(answer.url, new RegExp(`^${base(f).replace(/\./g, "\\.")}/v1/video/hls/[a-f0-9]{32}/index\\.m3u8$`), "the desktop app gets a loopback URL");
  assert.equal(answer.offset, 0);
  assert.equal(answer.audio, 0);
  assert.ok(Math.abs(answer.duration - 7) < 0.5);
  const playlist = await (await get(f, answer.url)).text();
  assert.match(playlist, /#EXT-X-MAP:URI="init\.mp4"/);
  assert.match(playlist, /seg-0\.m4s/);
  const { probe } = await segment(f, answer.url);
  assert.equal(probe.videoCodec, "h264");
  assert.equal(probe.audioTracks.length, 1);
  assert.equal(probe.audioTracks[0].codec, "aac");
  assert.equal(probe.audioTracks[0].channels, 6, "converted audio keeps its 5.1 channels");
  const copied = await f.compatible("ac3", { copy: "ac3,eac3,dts-x" });
  const kept = (await segment(f, copied.url)).probe.audioTracks[0];
  assert.deepEqual([kept.codec, kept.channels], ["ac3", 6], "a client that plays AC3 gets it untouched");
  const second = await f.compatible("ac3", { audio: "1" });
  assert.equal(second.audio, 1);
  assert.equal((await segment(f, second.url)).probe.audioTracks[0].codec, "mp3", "the second track is chosen and MP3 is copied");
  await assert.rejects(f.compatible("ac3", { audio: "7" }), { status: 400 });
  await assert.rejects(f.compatible("ac3", { start: "-3" }), { status: 400 });
});

test("HEVC is copied and tagged hvc1, AAC is copied untouched, and a start offset begins the stream later", async (t) => {
  const f = await library(t);
  const hevc = await f.compatible("hevc");
  const { probe, init } = await segment(f, hevc.url);
  assert.equal(probe.videoCodec, "hevc");
  assert.ok(init.includes(Buffer.from("hvc1")));
  const mp4 = await f.compatible("mp4", { start: "3" });
  assert.equal(mp4.offset, 3);
  const copied = await segment(f, mp4.url);
  assert.equal(copied.probe.audioTracks[0].codec, "aac");
  assert.equal(copied.probe.audioTracks[0].channels, 1, "AAC is copied, not converted to stereo");
  let playlist = "";
  await until(async () => /#EXT-X-ENDLIST/.test((playlist = await (await get(f, mp4.url)).text())));
  assert.ok(Math.abs(playlistSeconds(playlist) - 4) < 1, `the stream starts at 3 s: ${playlistSeconds(playlist)}`);
});

test("sessions belong to their credential, end when replaced or idle, and are limited per machine", async (t) => {
  const f = await library(t, { limit: 2 });
  const phone = await f.call("/v1/devices", { name: "Phone", role: "replica" });
  const tablet = await f.call("/v1/devices", { name: "Tablet", role: "replica" });
  const mine = await f.compatible("mp4", {}, phone.token);
  assert.match(mine.url, /^\/v1\/video\/hls\/[a-f0-9]{32}\/index\.m3u8$/, "a linked device gets a relative URL");
  assert.equal((await get(f, mine.url, phone.token)).status, 200);
  assert.equal((await get(f, mine.url, tablet.token)).status, 404, "another credential cannot use the session");
  assert.equal((await get(f, mine.url, f.daemon.engine.config.adminToken)).status, 404, "nor can the hub's own administrator");
  const replaced = await f.compatible("ac3", {}, phone.token);
  assert.equal((await get(f, mine.url, phone.token)).status, 404, "a new session ends the previous one");
  assert.equal((await get(f, replaced.url, phone.token)).status, 200);
  await f.compatible("mp4", {}, tablet.token);
  await assert.rejects(f.compatible("hevc"), { status: 503, message: "The hub is busy with another video. Try again in a moment." });
});

test("a session nobody reads is ended and leaves no files", async (t) => {
  const f = await library(t, { idleMs: 200, sweepMs: 20 });
  const phone = await f.call("/v1/devices", { name: "Phone", role: "replica" });
  const answer = await f.compatible("ac3", {}, phone.token);
  const folder = path.join(f.home, "transcodes", answer.url.split("/").at(-2));
  await until(() => !fs.existsSync(folder));
  assert.equal((await get(f, answer.url, phone.token)).status, 404);
  assert.deepEqual(fs.readdirSync(path.join(f.home, "transcodes")), []);
  assert.ok((await f.compatible("hevc")).url);
});

test("a player starts a compatible stream and reads it", async (t) => {
  const f = await library(t);
  const { code } = await f.call("/v1/pairing", { name: "TV" });
  const player = await (
    await fetch(`${base(f)}/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, kind: "player", name: "tv" }) })
  ).json();
  const answer = await f.compatible("ac3", {}, player.token);
  assert.equal((await get(f, answer.url, player.token)).status, 200);
  assert.equal(playerRoute("GET", "/v1/video/compatible"), true);
  assert.equal(playerRoute("GET", `/v1/video/hls/${"a".repeat(32)}/seg-1.m4s`), true);
  assert.equal(playerRoute("POST", "/v1/video/compatible"), false);
});

test("a replica without a local copy forwards the request and proxies the hub's session", async (t) => {
  const f = await library(t);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-compatible-replica-"));
  init(home, { port: 0, name: "Desk", role: "replica" });
  const replica = await start(home, { timer: false });
  t.after(async () => {
    await replica.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const call = api(replica.port, replica.engine.config.adminToken);
  const desk = await f.call("/v1/devices", { name: "Desk", role: "replica" });
  await call("/v1/connect", { url: base(f), token: desk.token });
  await replica.engine.cycle();
  const answer = await call(`/v1/video/compatible?${new URLSearchParams({ volume: f.v.id, path: f.names.ac3, hash: f.hashes.ac3, start: "2" })}`);
  assert.match(answer.url, new RegExp(`^http://127\\.0\\.0\\.1:${replica.port}/v1/video/hls/[a-f0-9]{32}/index\\.m3u8$`));
  assert.ok(answer.offset > 0 && answer.offset <= 2, `the stream starts at the keyframe before 2 s: ${answer.offset}`);
  const playlist = await (await fetch(answer.url)).text();
  assert.match(playlist, /seg-0\.m4s/);
  assert.match(playlist, /^#EXTM3U\n#EXT-X-START:TIME-OFFSET=0,PRECISE=YES\n/, "players start at the requested point, not the live edge");
  const initFile = await fetch(answer.url.replace("index.m3u8", "init.mp4"));
  assert.equal(initFile.status, 200);
  assert.ok((await initFile.arrayBuffer()).byteLength > 0);
  const id = answer.url.split("/").at(-2);
  assert.equal((await fetch(`${base(f)}/v1/video/hls/${id}/index.m3u8`)).status, 401, "the hub's session needs the replica's credential");

  await assert.rejects(call("/v1/select", { id: f.v.id }), { status: 409 }, "a replica never keeps a copy to convert on its own");
});

test("leftover conversion files are deleted when the daemon starts", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-compatible-start-"));
  init(home, { port: 0 });
  fs.mkdirSync(path.join(home, "transcodes", "old"), { recursive: true });
  fs.writeFileSync(path.join(home, "transcodes", "old", "seg-0.m4s"), "x");
  const daemon = await start(home, { timer: false });
  t.after(async () => {
    await daemon.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  assert.deepEqual(fs.readdirSync(path.join(home, "transcodes")), []);
});

test("a request waiting for a segment keeps its session alive, and init.mp4 waits for the first playlist", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-compatible-wait-"));
  const sessions = new VideoSessions(home, { idleMs: 30, sweepMs: 5, waitMs: 30000 });
  t.after(() => {
    sessions.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const directory = path.join(home, "transcodes", "a".repeat(32));
  fs.mkdirSync(directory);
  const session = { id: "a".repeat(32), owner: "x", directory, created: Date.now(), touched: Date.now() };
  sessions.sessions.set(session.id, session);
  let served = false;
  const waiting = sessions.file(session, "init.mp4").then((value) => {
    served = true;
    return value;
  });
  fs.writeFileSync(path.join(directory, "init.mp4"), "partial");
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(served, false, "init.mp4 is not served before the playlist exists");
  assert.ok(sessions.sessions.has(session.id), "the waiting request kept the session");
  fs.writeFileSync(path.join(directory, "index.m3u8"), "#EXTM3U\n");
  assert.equal((await waiting).file, path.join(directory, "init.mp4"));
});

function firstTimes(file) {
  const out = execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-copyts", "-i", file, "-map", "0", "-c", "copy", "-f", "framecrc", "-"], { encoding: "utf8" });
  const bases = Object.fromEntries([...out.matchAll(/#tb (\d+): (\d+)\/(\d+)/g)].map((m) => [m[1], Number(m[2]) / Number(m[3])]));
  const first = {};
  for (const line of out.split("\n")) {
    const parts = line.split(",").map((part) => part.trim());
    if (!/^\d+$/.test(parts[0]) || parts[0] in first) continue;
    first[parts[0]] = Number(parts[2]) * bases[parts[0]];
  }
  return first;
}

test("a start inside a long group of pictures begins at the keyframe before it, with audio from the same instant", async (t) => {
  const f = await hub(t, { videoSessions: { sweepMs: 50 } });
  await f.call("/v1/video/mark", { volume: f.v.id });
  const hash = await f.propose("Long (2001).mp4", film("gop"));
  await f.settled();
  const answer = await f.call(`/v1/video/compatible?${new URLSearchParams({ volume: f.v.id, path: "Long (2001).mp4", hash, start: "13" })}`);
  assert.equal(answer.offset, 10);
  let playlist = "";
  await until(async () => /#EXT-X-ENDLIST/.test((playlist = await (await get(f, answer.url)).text())));
  assert.ok(Math.abs(playlistSeconds(playlist) - 15) < 0.6, `the stream covers 10–25 s: ${playlistSeconds(playlist)}`);
  const folder = answer.url.replace(/index\.m3u8$/, "");
  const parts = [];
  for (const name of ["init.mp4", "seg-0.m4s"]) parts.push(Buffer.from(await (await get(f, folder + name)).arrayBuffer()));
  const file = path.join(scratch, "gop-start.mp4");
  fs.writeFileSync(file, Buffer.concat(parts));
  const times = firstTimes(file);
  assert.ok(Math.abs(times[0] - times[1]) < 0.1, `video and audio start together: ${JSON.stringify(times)}`);
  await assert.rejects(f.call(`/v1/video/compatible?${new URLSearchParams({ volume: f.v.id, path: "Long (2001).mp4", hash, start: "1e2" })}`), { status: 400 });
  const silent = await f.propose("Silent (2001).mp4", film("silent"));
  await f.settled();
  assert.equal((await f.call(`/v1/video/compatible?${new URLSearchParams({ volume: f.v.id, path: "Silent (2001).mp4", hash: silent })}`)).audio, null, "a file without audio echoes no track");
});

test("an MKV whose keyframes carry B-frame delays starts audio and video at the same keyframe", async (t) => {
  const f = await hub(t, { videoSessions: { sweepMs: 50 } });
  await f.call("/v1/video/mark", { volume: f.v.id });
  const hash = await f.propose("Delayed (2001).mkv", film("bframes"));
  await f.settled();
  const answer = await f.call(`/v1/video/compatible?${new URLSearchParams({ volume: f.v.id, path: "Delayed (2001).mkv", hash, start: "13" })}`);
  assert.ok(answer.offset > 9.5 && answer.offset <= 10.5, `the keyframe at 10 s: ${answer.offset}`);
  let playlist = "";
  await until(async () => /#EXT-X-ENDLIST/.test((playlist = await (await get(f, answer.url)).text())));
  assert.ok(Math.abs(playlistSeconds(playlist) - (25 - answer.offset)) < 0.6, `the stream starts at the offset: ${playlistSeconds(playlist)}`);
  const folder = answer.url.replace(/index\.m3u8$/, "");
  const parts = [];
  for (const name of ["init.mp4", "seg-0.m4s"]) parts.push(Buffer.from(await (await get(f, folder + name)).arrayBuffer()));
  const file = path.join(scratch, "bframes-start.mp4");
  fs.writeFileSync(file, Buffer.concat(parts));
  const times = firstTimes(file);
  assert.equal(Object.keys(times).length, 2, "the first segment carries audio too");
  assert.ok(Math.abs(times[0] - times[1]) < 0.35, `video and audio start together, but for the B-frame delay: ${JSON.stringify(times)}`);
});

function fakeChild() {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.signals = [];
  child.kill = (signal) => {
    child.signals.push(signal);
    if (signal === "SIGKILL") setTimeout(() => {
      child.signalCode = "SIGKILL";
      child.emit("exit", null, "SIGKILL");
    }, 100);
    return true;
  };
  return child;
}
function fakeSession(sessions, id, segments, extra = {}) {
  const directory = path.join(sessions.directory, id.padEnd(32, "0"));
  fs.mkdirSync(directory, { recursive: true });
  for (let i = 0; i < segments; i++) fs.writeFileSync(path.join(directory, `seg-${i}.m4s`), Buffer.alloc(10));
  const session = { id: id.padEnd(32, "0"), owner: id, directory, process: fakeChild(), created: Date.now(), touched: Date.now(), ...extra };
  sessions.sessions.set(session.id, session);
  return session;
}

test("conversion pauses far ahead of the viewer, keeps watched sessions under the disk cap and prunes old segments", { skip: process.platform === "win32" }, async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-compatible-pace-"));
  const sessions = new VideoSessions(home, { sweepMs: 3600000, aheadSegments: 30, behindSegments: 100, capBytes: 50 });
  t.after(() => {
    sessions.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const watched = fakeSession(sessions, "a", 40);
  sessions.pace(watched);
  assert.deepEqual(watched.process.signals, ["SIGSTOP"]);
  await sessions.file(watched, "seg-25.m4s");
  assert.deepEqual(watched.process.signals, ["SIGSTOP", "SIGCONT"], "asking for a later segment resumes it");
  const old = fakeSession(sessions, "b", 10, { touched: Date.now() - 3600000 });
  sessions.sweep();
  assert.ok(sessions.sessions.has(watched.id), "a session being watched is never ended for the cap");
  assert.ok(!sessions.sessions.has(old.id), "an unwatched one is");
  const long = fakeSession(sessions, "c", 160, { highest: 150 });
  sessions.prune(long);
  assert.deepEqual(sessions.segments(long).sort((x, y) => x - y)[0], 50);
});

test("a heavy stream is bounded by bytes too: it pauses with little ahead and keeps little behind", { skip: process.platform === "win32" }, async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-compatible-bytes-"));
  const sessions = new VideoSessions(home, { sweepMs: 3600000, aheadSegments: 30, behindSegments: 100, aheadBytes: 100, behindBytes: 100 });
  t.after(() => {
    sessions.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const heavy = fakeSession(sessions, "h", 8, { highest: 4 });
  for (let n = 0; n < 8; n++) fs.writeFileSync(path.join(heavy.directory, `seg-${n}.m4s`), Buffer.alloc(40));
  sessions.pace(heavy);
  assert.deepEqual(heavy.process.signals, ["SIGSTOP"], "three segments ahead of 40 bytes pass the 100-byte budget");
  sessions.prune(heavy);
  assert.deepEqual(sessions.segments(heavy).sort((x, y) => x - y), [2, 3, 4, 5, 6, 7], "only 80 bytes behind the viewer stay");
});

test("a file whose timestamps start late still reports the keyframe in file time, and a format no player streams is refused early", async (t) => {
  const f = await hub(t, { videoSessions: { sweepMs: 50 } });
  await f.call("/v1/video/mark", { volume: f.v.id });
  const late = await f.propose("Late (2001).mkv", film("late"));
  const old = await f.propose("Old (1999).mp4", clip({ seconds: 2, tone: 330 }));
  await f.settled();
  const answer = await f.call(`/v1/video/compatible?${new URLSearchParams({ volume: f.v.id, path: "Late (2001).mkv", hash: late, start: "13" })}`);
  assert.ok(Math.abs(answer.offset - 10) < 0.2, `the keyframe at 10 s of the film, not 13 s of its clock: ${answer.offset}`);
  await assert.rejects(f.call(`/v1/video/compatible?${new URLSearchParams({ volume: f.v.id, path: "Old (1999).mp4", hash: old })}`), { status: 415 });
  const args = hlsArguments({ source: path.join("objects", "abc"), name: "Movies/Heat.mkv", start: 5, audio: 0, videoCodec: "h264", audioCodec: "aac", directory: "d" });
  assert.deepEqual(args.slice(args.indexOf("-f"), args.indexOf("-f") + 2), ["-f", "matroska"], "the container comes from the name, even for an object path");
  assert.equal(args[args.indexOf("-map") + 1], "0:V:0", "never a cover picture as the video");
});

test("two web viewers keep their own compatible streams and cannot read each other's", async (t) => {
  const { issueWebCode } = await import("../packages/daemon/web.js");
  const f = await library(t);
  const url = base(f);
  const browser = async () => {
    const { code } = issueWebCode(f.home);
    const response = await fetch(`${url}/auth/login`, { method: "POST", headers: { Origin: url, "Content-Type": "application/json" }, body: JSON.stringify({ code }) });
    return response.headers.get("set-cookie").split(";")[0];
  };
  const [one, two] = [await browser(), await browser()];
  const query = new URLSearchParams({ volume: f.v.id, path: f.names.ac3, hash: f.hashes.ac3 });
  const start = async (cookie) => (await fetch(`${url}/v1/video/compatible?${query}`, { headers: { Cookie: cookie } })).json();
  const first = await start(one);
  const second = await start(two);
  assert.notEqual(first.url, second.url);
  assert.equal((await fetch(url + first.url, { headers: { Cookie: one } })).status, 200, "the second viewer did not end the first stream");
  assert.equal((await fetch(url + first.url, { headers: { Cookie: two } })).status, 404, "nor can read it");
});

test("a segment already pruned answers 404 at once instead of waiting for it", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-compatible-pruned-"));
  const sessions = new VideoSessions(home, { sweepMs: 3600000, behindSegments: 2, waitMs: 30000 });
  t.after(() => {
    sessions.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const session = fakeSession(sessions, "p", 10, { highest: 9 });
  fs.writeFileSync(path.join(session.directory, "index.m3u8"), "#EXTM3U\n");
  sessions.prune(session);
  const started = Date.now();
  await assert.rejects(sessions.file(session, "seg-1.m4s"), { status: 404 });
  assert.ok(Date.now() - started < 1000);
});

test("a session folder is deleted only after FFmpeg has exited, and a failing sweep never escapes its timer", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-compatible-end-"));
  const sessions = new VideoSessions(home, { sweepMs: 5 });
  t.after(() => {
    sessions.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const session = fakeSession(sessions, "d", 2);
  sessions.end(session.id);
  assert.deepEqual(session.process.signals, ["SIGKILL"]);
  assert.ok(fs.existsSync(session.directory), "still there while FFmpeg runs");
  await new Promise((resolve) => session.process.once("exit", () => setImmediate(resolve)));
  assert.ok(!fs.existsSync(session.directory));
  sessions.sweep = () => {
    throw new Error("boom");
  };
  await new Promise((resolve) => setTimeout(resolve, 50));
});

test("audio is copied when the client plays it, else AAC with the same channels at 128 kb/s each, at most 5.1", () => {
  const audio = (codec, channels, copy) => {
    const args = hlsArguments({ source: "in.mkv", start: 0, audio: 0, videoCodec: "h264", audioCodec: codec, audioChannels: channels, copy, directory: "d" });
    const at = args.indexOf("-c:a");
    return args.slice(at + 1, args[at + 1] === "copy" ? at + 2 : at + 6).join(" ");
  };
  assert.equal(audio("aac", 6), "copy");
  assert.equal(audio("ac3", 6, ["ac3"]), "copy");
  assert.equal(audio("ac3", 6), "aac -ac 6 -b:a 640k");
  assert.equal(audio("dts", 8), "aac -ac 6 -b:a 640k");
  assert.equal(audio("truehd", 2), "aac -ac 2 -b:a 256k");
  assert.equal(audio("ac3", null), "aac -ac 2 -b:a 256k");
  assert.equal(audio("ac3", 1), "aac -ac 1 -b:a 128k");
});

test("segment paths escape percent signs, and the loopback capability holds only for local GETs from the app", () => {
  const args = hlsArguments({ source: "in.mkv", start: 0, audio: 0, videoCodec: "h264", audioCodec: "ac3", directory: path.join("a%d", "b") });
  assert.equal(args[args.indexOf("-hls_segment_filename") + 1], "a%%d/b/seg-%d.m4s");
  assert.equal(args.at(-1), "a%d/b/index.m3u8", "FFmpeg finds the playlist's folder only by its forward slashes, so init.mp4 lands beside it on Windows too");
  const session = { loopback: true };
  assert.equal(loopbackAllowed(session, "GET", "127.0.0.1", undefined), true);
  assert.equal(loopbackAllowed(session, "GET", "::1", "tauri://localhost"), true);
  assert.equal(loopbackAllowed(session, "GET", "127.0.0.1", "https://evil.example"), false);
  assert.equal(loopbackAllowed(session, "GET", "192.168.1.20", undefined), false, "another machine needs the owner's credential");
  assert.equal(loopbackAllowed(session, "POST", "127.0.0.1", undefined), false);
  assert.equal(loopbackAllowed({ loopback: false }, "GET", "127.0.0.1", undefined), false);
});

test("a loopback session plays without a credential locally but refuses a foreign page", async (t) => {
  const f = await library(t);
  const answer = await f.compatible("mp4");
  assert.equal((await fetch(answer.url)).status, 200);
  assert.equal((await fetch(answer.url, { headers: { Origin: "https://evil.example" } })).status, 403);
  const phone = await f.call("/v1/devices", { name: "Phone", role: "replica" });
  assert.equal((await get(f, answer.url.replace(base(f), ""), phone.token)).status, 200, "the capability holds for local requests");
});

test("a replica passes on the hub's conversion error and keeps only its newest forwarded session", async (t) => {
  const f = await library(t);
  const broken = await f.propose("Broken (2003).mkv", Buffer.from("this is not a matroska file at all".repeat(100)));
  await f.settled();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-compatible-replica2-"));
  init(home, { port: 0, name: "Desk", role: "replica" });
  const replica = await start(home, { timer: false });
  t.after(async () => {
    await replica.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const call = api(replica.port, replica.engine.config.adminToken);
  const desk = await f.call("/v1/devices", { name: "Desk", role: "replica" });
  await call("/v1/connect", { url: base(f), token: desk.token });
  await replica.engine.cycle();
  const failing = await call(`/v1/video/compatible?${new URLSearchParams({ volume: f.v.id, path: "Broken (2003).mkv", hash: broken })}`);
  const response = await fetch(failing.url);
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error, "This video could not be converted");
  const real = replica.engine.json.bind(replica.engine);
  let first = true;
  replica.engine.json = async (...args) => {
    if (first && String(args[0]).startsWith("/v1/video/compatible")) {
      first = false;
      const value = await real(...args);
      await new Promise((resolve) => setTimeout(resolve, 300));
      return value;
    }
    return real(...args);
  };
  const ask = () => call(`/v1/video/compatible?${new URLSearchParams({ volume: f.v.id, path: f.names.mp4, hash: f.hashes.mp4 })}`).catch((error) => error);
  const slow = ask();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const [older, newer] = await Promise.all([slow, ask()]);
  assert.equal(older.status, 409, "the slower, older request does not take over");
  assert.match(newer.url, /index\.m3u8$/);
  assert.equal((await fetch(newer.url)).status, 200);
});
