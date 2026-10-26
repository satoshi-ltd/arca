import test from "node:test";
import assert from "node:assert/strict";
import { createClient } from "../apps/mobile/src/client.js";
import { videoSource } from "../apps/mobile/src/video-sync.js";
import { libraryAudioOptions, audioOptions, sameLanguage } from "../apps/mobile/src/video-audio.js";
import {
  absoluteTime,
  audioForLanguage,
  audioTrackOf,
  compatibleRoute,
  createRestarter,
  fullDuration,
  needsCompatible,
  recoveryPlan,
  SEEK_BEHIND,
  seekPlan,
} from "../apps/mobile/src/video-compatible.js";

const movie = (audioTracks, extra = {}) => ({ path: "Movies/Heat (1995).mkv", hash: "h1", duration: 6000, audioCodec: audioTracks[0]?.codec || "", audioTracks, ...extra });
const ac3 = movie([
  { stream: 0, codec: "ac3", language: "eng", label: "English", channels: 6, default: true },
  { stream: 1, codec: "aac", language: "spa", label: "Spanish", channels: 2 },
]);

test("direct play is the default; the compatible stream is only for AC3, E-AC3, DTS or TrueHD audio", () => {
  assert.equal(needsCompatible(ac3), true, "the default track decides");
  assert.equal(needsCompatible(ac3, 1), false, "choosing the AAC track plays directly");
  assert.equal(needsCompatible(movie([{ stream: 0, codec: "aac" }])), false, "an MKV with AAC plays directly");
  for (const codec of ["eac3", "dts", "truehd", "EAC3"]) assert.equal(needsCompatible(movie([{ stream: 0, codec }])), true, codec);
  assert.equal(needsCompatible({ audioCodec: "dts" }), true, "older libraries without tracks use the file's audio codec");
  assert.equal(needsCompatible({}), false);
  assert.equal(audioTrackOf(ac3, 7).stream, 0, "an unknown choice falls back to the default track");
  assert.equal(audioForLanguage(ac3, "es", sameLanguage), 1);
  assert.equal(audioForLanguage(ac3, "fr", sameLanguage), null);
  assert.equal(compatibleRoute("v1", ac3, 61.9, 1), "/v1/video/compatible?volume=v1&path=Movies%2FHeat+%281995%29.mkv&hash=h1&start=61&audio=1");
  assert.equal(compatibleRoute("v1", ac3), "/v1/video/compatible?volume=v1&path=Movies%2FHeat+%281995%29.mkv&hash=h1&start=0");
});

test("a compatible stream shows absolute time: offset plus the player's time, over the library's full length", () => {
  const source = { compatible: true, offset: 1800, duration: 6000 };
  assert.equal(absoluteTime(source, 12.5), 1812.5);
  assert.equal(absoluteTime({ offset: 0 }, 12.5), 12.5);
  assert.equal(absoluteTime(source, NaN), 1800);
  assert.equal(fullDuration(source, ac3, 240), 6000, "a growing playlist never shrinks the scrubber");
  assert.equal(fullDuration({ compatible: true, offset: 0 }, ac3, 240), 6000);
  assert.equal(fullDuration({ offset: 0 }, ac3, 5990), 5990);
});

test("seeking a compatible stream restarts it once after the last seek, and late answers never replace a newer one", async () => {
  const timers = [];
  const runs = [];
  const restarter = createRestarter((request, fresh) => runs.push({ request, fresh }), {
    schedule: (fn) => (timers.push(fn), timers.length),
    cancel: (id) => (timers[id - 1] = null),
  });
  restarter.request(100, { audio: 1 });
  restarter.request(130, { audio: 1 });
  assert.equal(restarter.pending(), true);
  restarter.request(160, { audio: 1 });
  timers.filter(Boolean).forEach((fn) => fn());
  assert.deepEqual(runs.map((run) => run.request), [{ start: 160, audio: 1 }], "only the last seek opens a session");
  assert.equal(restarter.pending(), false);
  restarter.now({ start: 200, audio: 0 });
  assert.equal(runs[0].fresh(), false, "an older session's answer is ignored");
  assert.equal(runs[1].fresh(), true);
  restarter.stop();
  assert.equal(runs[1].fresh(), false, "closing the player drops answers still on the way");
});

function hubClient(answer, seen) {
  return createClient({
    secrets: { read: async () => ({ url: "https://hub.example:8443", token: "tok", id: "p", hubId: "h" }), write: async () => {}, clear: async () => {} },
    cache: { read: async () => null, write: async () => {} },
    fetcher: async (url, options) => {
      seen.push({ url, auth: options.headers.Authorization });
      return new Response(JSON.stringify(answer), { status: 200 });
    },
  });
}

test("AC3 audio opens a compatible HLS session with the bearer header, from the start and audio track asked", async () => {
  const seen = [];
  const client = hubClient({ url: "/v1/video/hls/abc/index.m3u8", offset: 61, audio: 0, duration: 6000 }, seen);
  await client.load();
  const source = await videoSource({ client, volume: "v1", item: ac3, networkType: async () => null, start: 61.4 });
  assert.equal(seen.length, 1, "one session request");
  assert.match(seen[0].url, /\/v1\/video\/compatible\?volume=v1&path=.*&hash=h1&start=61$/);
  assert.equal(seen[0].auth, "Bearer tok");
  assert.equal(source.uri, "https://hub.example:8443/v1/video/hls/abc/index.m3u8");
  assert.deepEqual(source.headers, { Authorization: "Bearer tok" });
  assert.deepEqual([source.compatible, source.offset, source.audio, source.duration], [true, 61, 0, 6000]);
  const direct = await videoSource({ client, volume: "v1", item: ac3, networkType: async () => null, audio: 1 });
  assert.equal(direct.compatible, undefined, "the AAC track plays the file directly");
  assert.match(direct.uri, /\/v1\/video\/media\?/);
  assert.equal(seen.length, 1, "direct play asks the hub for no session");
  const forced = await videoSource({ client, volume: "v1", item: movie([{ stream: 0, codec: "aac" }]), networkType: async () => null, mode: "compatible", start: 300 });
  assert.equal(forced.compatible, true, "a direct playback error falls back to the compatible stream");
  assert.match(seen[1].url, /start=300$/);
});

test("a compatible stream follows the private-network rule, and an unlinked phone asks for the hub", async () => {
  const lan = createClient({
    secrets: { read: async () => ({ url: "http://192.168.1.20:7443", token: "tok", id: "p", hubId: "h" }), write: async () => {}, clear: async () => {} },
    cache: { read: async () => null, write: async () => {} },
    fetcher: async () => assert.fail("no request over mobile data"),
    resolvePrivateURL: async (value) => value,
  });
  await lan.load();
  await assert.rejects(videoSource({ client: lan, volume: "v1", item: ac3, networkType: async () => ({ type: "CELLULAR" }) }), /mobile data/);
  const offline = { state: () => ({ connection: null }), api: async () => assert.fail("no hub"), stream: async () => assert.fail("no hub") };
  await assert.rejects(videoSource({ client: offline, volume: "v1", item: ac3, networkType: async () => null }), { code: "HUB_UNREACHABLE" });
});

test("the Audio panel of a compatible stream lists the file's tracks, and AC3 tracks found while playing directly switch to it", () => {
  const options = libraryAudioOptions(ac3.audioTracks);
  assert.deepEqual(options.map((o) => [o.key, o.label, o.stream, o.codec]), [
    ["stream:0", "English · 5.1", 0, "ac3"],
    ["stream:1", "Spanish · 2.0", 1, "aac"],
  ]);
  const direct = audioOptions([{ id: "a", language: "en" }, { id: "b", language: "es" }], ac3.audioTracks);
  assert.deepEqual(direct.map((o) => [o.stream, o.codec]), [[0, "ac3"], [1, "aac"]]);
});

test("a failing direct play falls back once, and a failing compatible stream restarts once until it plays again", () => {
  assert.equal(recoveryPlan({ compatible: false, fellBack: false, retried: false }), "fallback");
  assert.equal(recoveryPlan({ compatible: false, fellBack: true, retried: false }), null, "a second direct failure shows the error");
  assert.equal(recoveryPlan({ compatible: true, fellBack: true, retried: false }), "retry", "an ended or evicted session is reopened from where it was");
  assert.equal(recoveryPlan({ compatible: true, fellBack: true, retried: true }), null);
  assert.equal(recoveryPlan({ compatible: true, fellBack: true, retried: false, networkLeft: true }), null, "leaving Wi-Fi never reopens a stream");
});

test("seeks inside what the session already produced move the player; only seeks beyond it open a new session", () => {
  const source = { compatible: true, offset: 1798 };
  assert.deepEqual(seekPlan(source, 1830, { duration: 60, buffered: 40 }), { local: true, time: 32 });
  assert.deepEqual(seekPlan(source, 1858, { duration: 30, buffered: 60 }), { local: true, time: 60 }, "the buffered position counts as produced");
  assert.deepEqual(seekPlan(source, 1900, { duration: 60, buffered: 40 }), { local: false, start: 1900 });
  assert.deepEqual(seekPlan(source, 1700, { duration: 60, buffered: 40 }), { local: false, start: 1700 }, "before the session's start needs a new one");
  assert.deepEqual(seekPlan({ offset: 0 }, 4000), { local: true, time: 4000 }, "direct play always seeks in place");
  assert.deepEqual(seekPlan(source, 1810, { duration: NaN, buffered: undefined }), { local: false, start: 1810 });
});

test("a growing playlist without a duration still seeks in place within the furthest point it produced", () => {
  const source = { compatible: true, offset: 0 };
  assert.deepEqual(seekPlan(source, 900, { duration: 0, buffered: 1230, currentTime: 1200, produced: 1500 }), { local: true, time: 900 }, "iOS reports duration 0 for an EVENT playlist");
  assert.deepEqual(seekPlan(source, 1400, { duration: 0, buffered: 1230, currentTime: 1200, produced: 1500 }), { local: true, time: 1400 }, "the furthest buffered point seen stays produced");
  assert.deepEqual(seekPlan(source, 1100, { duration: 0, buffered: 0, currentTime: 1200 }), { local: true, time: 1100 }, "where the player already is was produced");
  assert.deepEqual(seekPlan(source, 1600, { duration: 0, buffered: 1230, currentTime: 1200, produced: 1500 }), { local: false, start: 1600 });
});

test("a seek far behind the current position restarts, because the hub prunes old segments", () => {
  const source = { compatible: true, offset: 0 };
  assert.equal(SEEK_BEHIND, 540);
  assert.deepEqual(seekPlan(source, 3000 - SEEK_BEHIND, { duration: 3100, currentTime: 3000 }), { local: true, time: 3000 - SEEK_BEHIND });
  assert.deepEqual(seekPlan(source, 3000 - SEEK_BEHIND - 1, { duration: 3100, currentTime: 3000 }), { local: false, start: 3000 - SEEK_BEHIND - 1 });
});

test("time math uses the offset the hub returns, the real keyframe start, not the start asked for", async () => {
  const seen = [];
  const client = hubClient({ url: "/v1/video/hls/k/index.m3u8", offset: 58.04, audio: 1, duration: 6000 }, seen);
  await client.load();
  const source = await videoSource({ client, volume: "v1", item: ac3, networkType: async () => null, mode: "compatible", start: 61, audio: 1 });
  assert.match(seen[0].url, /start=61&audio=1$/, "a fallback keeps the chosen audio track");
  assert.equal(source.offset, 58.04);
  assert.equal(absoluteTime(source, 3), 61.04);
  assert.deepEqual(seekPlan(source, 59, { duration: 10 }), { local: true, time: 59 - 58.04 });
});
