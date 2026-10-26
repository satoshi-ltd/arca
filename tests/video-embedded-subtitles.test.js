import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import ffmpeg from "ffmpeg-static";
import { init } from "../packages/daemon/storage.js";
import { start } from "../packages/daemon/server.js";
import { api, hub } from "./video-support.js";
import { extractSubtitles, SUBTITLE_BYTES } from "../packages/daemon/video.js";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "arca-embedded-subtitles-"));
process.on("exit", () => fs.rmSync(scratch, { recursive: true, force: true }));

test("oversized extracted subtitles are rejected before reading them into memory", async (t) => {
  const source = path.join(scratch, "large.srt");
  const output = path.join(scratch, "large.mkv");
  fs.writeFileSync(source, Array.from({ length: 2200 }, (_, i) => `${i + 1}\n00:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")},000 --> 01:00:00,000\n${"x".repeat(1000)}\n\n`).join(""));
  execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-i", source, "-c:s", "srt", output], { timeout: 15000 });
  const read = fs.readFileSync;
  t.mock.method(fs, "readFileSync", function (file, ...args) {
    if (String(file).endsWith(".vtt")) assert.ok(fs.statSync(file).size <= SUBTITLE_BYTES, "never allocate an oversized subtitle buffer");
    return read.call(this, file, ...args);
  });
  assert.equal((await extractSubtitles(output, "large.mkv", [0])).get(0), null);
});

function film() {
  const srt = path.join(scratch, "en.srt");
  const ass = path.join(scratch, "es.ass");
  fs.writeFileSync(srt, "1\n00:00:01,000 --> 00:00:02,500\nHello there\n\n2\n00:00:03,000 --> 00:00:04,000\nSecond line\n");
  fs.writeFileSync(
    ass,
    "[Script Info]\nScriptType: v4.00+\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,2,10,10,10,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\i1}Hola{\\i0} amigo\n",
  );
  const output = path.join(scratch, "film.mkv");
  execFileSync(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc=duration=5:size=160x120:rate=10",
    "-f", "lavfi", "-i", "sine=frequency=400:duration=5",
    "-i", srt, "-i", ass,
    "-map", "0:v", "-map", "1:a", "-map", "2", "-map", "3",
    "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-c:s:0", "srt", "-c:s:1", "ass",
    "-metadata:s:s:0", "language=eng", "-metadata:s:s:0", "title=SDH", "-metadata:s:s:1", "language=spa", "-metadata:s:s:1", "title=Spanish (Latin America)",
    output,
  ]);
  return fs.readFileSync(output);
}

async function library(t) {
  const f = await hub(t);
  await f.call("/v1/video/mark", { volume: f.v.id });
  const name = "Heat (1995).mkv";
  const hash = await f.propose(name, film());
  await f.settled();
  const subtitles = (stream, extra = {}, call = f.call, volume = f.v.id) =>
    call(`/v1/video/subtitles?${new URLSearchParams({ volume, path: name, hash, stream: String(stream), format: "json", ...extra })}`);
  return { ...f, name, hash, subtitles };
}

test("embedded text subtitles in an MKV are extracted to WebVTT, one pass for every track", async (t) => {
  const f = await library(t);
  const value = await f.library();
  const item = value.movies[0] || value.other[0];
  assert.deepEqual(
    item.subtitles.filter((row) => row.embedded).map((row) => [row.stream, row.language, row.label, row.image]),
    [
      [0, "en", "English · SDH", false],
      [1, "es", "Spanish (Latin America)", false],
    ],
    "a track's own title tells two of the same language apart",
  );
  const english = await f.subtitles(0);
  assert.match(english.text, /^WEBVTT/);
  assert.match(english.text, /00:01\.0\d\d --> 00:02\.5\d\d\nHello there/);
  assert.match(english.text, /Second line/);
  const spanish = await f.subtitles(1);
  assert.match(spanish.text, /<i>Hola<\/i> amigo/, "ASS styling becomes WebVTT tags");
  assert.deepEqual(fs.readdirSync(path.join(f.home, "video-subtitles")).sort(), [`${f.hash}-0.vtt`, `${f.hash}-1.vtt`, `${f.hash}.done`].sort(), "both tracks came from one extraction, kept on disk");

  const vtt = await fetch(`http://127.0.0.1:${f.daemon.port}/v1/video/subtitles?${new URLSearchParams({ volume: f.v.id, path: f.name, hash: f.hash, stream: "0" })}`, {
    headers: { Authorization: `Bearer ${f.daemon.engine.config.adminToken}` },
  });
  assert.equal(vtt.status, 200);
  assert.match(vtt.headers.get("content-type"), /text\/vtt/);

  await assert.rejects(f.subtitles(2), (error) => error.status === 404, "a stream the file does not have");
  await assert.rejects(f.subtitles(0, { hash: "0".repeat(64) }), (error) => error.status === 404, "a stale hash");
  await assert.rejects(f.subtitles("x"), (error) => error.status === 400);
  await assert.rejects(f.subtitles(0, { hash: "nope" }), (error) => error.status === 400);
});

test("a replica without a local copy forwards embedded subtitles to the hub", async (t) => {
  const f = await library(t);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-embedded-replica-"));
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
  const answer = await f.subtitles(1, {}, call);
  assert.match(answer.text, /Hola<\/i> amigo/);
  const vtt = await fetch(`http://127.0.0.1:${replica.port}/v1/video/subtitles?${new URLSearchParams({ volume: f.v.id, path: f.name, hash: f.hash, stream: "0" })}`, {
    headers: { Authorization: `Bearer ${replica.engine.config.adminToken}` },
  });
  assert.equal(vtt.status, 200);
  assert.match(await vtt.text(), /Hello there/);
});

test("extraction survives a restart from its disk cache, starts by itself when the video plays, and a failure answers cleanly", async (t) => {
  const f = await library(t);
  const media = await fetch(`http://127.0.0.1:${f.daemon.port}/v1/video/media?${new URLSearchParams({ volume: f.v.id, path: f.name, hash: f.hash })}`, {
    headers: { Authorization: `Bearer ${f.daemon.engine.config.adminToken}`, Range: "bytes=0-9" },
  });
  assert.equal(media.status, 206);
  await f.daemon.engine.video.extracting.get(f.hash);
  assert.ok(fs.existsSync(path.join(f.home, "video-subtitles", `${f.hash}.done`)), "playing the video prepared its subtitles");
  f.daemon.engine.video.extracting.clear();
  const video = f.daemon.engine.video;
  const extractAll = video.extractAll;
  video.extractAll = () => assert.fail("a saved extraction is never repeated");
  assert.match((await f.subtitles(1)).text, /Hola/);
  fs.rmSync(path.join(f.home, "video-subtitles"), { recursive: true, force: true });
  video.extractAll = () => Promise.reject(new Error("Command failed: /opt/ffmpeg -i /srv/secret/Heat.mkv"));
  const failed = await fetch(`http://127.0.0.1:${f.daemon.port}/v1/video/subtitles?${new URLSearchParams({ volume: f.v.id, path: f.name, hash: f.hash, stream: "0", format: "json" })}`, {
    headers: { Authorization: `Bearer ${f.daemon.engine.config.adminToken}` },
  }).then((r) => r.json().then((body) => [r.status, body.error]));
  video.extractAll = extractAll;
  assert.deepEqual(failed, [422, "These subtitles could not be read"], "a failed extraction answers a clean status");
  assert.doesNotMatch(String(failed[1]), /ffmpeg|Command failed|\//, "and never leaks commands or hub paths");
});

test("a failed extraction is never saved, and a chosen track stops another film's background preparation", async (t) => {
  const f = await library(t);
  const video = f.daemon.engine.video;
  await assert.rejects(video.extractAll(path.join(f.home, "missing.mkv"), "missing.mkv", "f".repeat(64), [0], 10), { status: 422 });
  assert.equal(fs.existsSync(path.join(f.home, "video-subtitles", `${"f".repeat(64)}.done`)), false);
  const background = new AbortController();
  video.warming = { hash: "e".repeat(64), controller: background };
  await video.extractAll(path.join(f.home, "missing2.mkv"), "missing2.mkv", "d".repeat(64), [0], 10).catch(() => {});
  assert.equal(background.signal.aborted, true);
});

test("a client that polls gets “preparing” at once, also through a replica, then the track once it is extracted", async (t) => {
  const f = await library(t);
  const first = await f.subtitles(0, { poll: "1" });
  assert.deepEqual(first, { preparing: true });
  await f.daemon.engine.video.extracting.get(f.hash);
  assert.match((await f.subtitles(0, { poll: "1" })).text, /Hello there/);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-embedded-poll-"));
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
  fs.rmSync(path.join(f.home, "video-subtitles"), { recursive: true, force: true });
  assert.deepEqual(await f.subtitles(1, { poll: "1" }, call), { preparing: true }, "the replica passes “preparing” through instead of waiting on the hub");
});
