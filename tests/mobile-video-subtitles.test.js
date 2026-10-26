import test from "node:test";
import assert from "node:assert/strict";
import { createClient } from "../apps/mobile/src/client.js";
import { EMBEDDED_TIMEOUT, loadSubtitles } from "../apps/mobile/src/video-sync.js";
import {
  activeCues,
  applyChoice,
  chosenKey,
  cueText,
  parseCues,
  parseTime,
  restoreChoice,
  subtitleOptions,
  subtitleRoute,
  titleKey,
} from "../apps/mobile/src/subtitles.js";

const VTT = `WEBVTT

1
00:00:01.000 --> 00:00:03.500 align:middle
<i>¿Y ahora qué</i>
<i>vas a hacer?</i>

00:02.000 --> 00:04.000
<b>Walt</b> &amp; Jesse

00:00:10.5 --> 00:00:09.000
backwards

NOTE a comment --> not a cue

01:02:03.004 --> 01:02:05.000
Late
`;

test("WebVTT cues parse hh:mm:ss.mmm and mm:ss.mmm, keep multi-line text, strip tags and skip broken cues", () => {
  assert.equal(parseTime("01:02:03.004"), 3723.004);
  assert.equal(parseTime("02:03.5"), 123.5);
  assert.equal(parseTime("00:00:01,250"), 1.25);
  assert.equal(parseTime("nope"), null);
  const cues = parseCues(VTT);
  assert.deepEqual(cues.map((cue) => [cue.start, cue.end, cue.text, cue.italic]), [
    [1, 3.5, "¿Y ahora qué\nvas a hacer?", true],
    [2, 4, "Walt & Jesse", false],
    [3723.004, 3725, "Late", false],
  ]);
});

test("SRT parses with the same rules", () => {
  const srt = "﻿1\r\n00:00:01,000 --> 00:00:02,000\r\nHola\r\n\r\n2\r\n00:00:02,500 --> 00:00:04,000\r\n{\\i1}Adiós{\\i0}\r\n";
  assert.deepEqual(parseCues(srt).map((cue) => [cue.start, cue.text, cue.italic]), [
    [1, "Hola", false],
    [2.5, "Adiós", true],
  ]);
});

test("the cue on screen follows the time, and overlapping cues show together", () => {
  const cues = parseCues(VTT);
  assert.deepEqual(activeCues(cues, 0.5), []);
  assert.equal(cueText(cues, 1).text, "¿Y ahora qué\nvas a hacer?");
  assert.deepEqual(cueText(cues, 2.5), { text: "¿Y ahora qué\nvas a hacer?\nWalt & Jesse", italic: false });
  assert.equal(cueText(cues, 3.5).text, "Walt & Jesse", "a cue ends at its end time");
  assert.equal(cueText(cues, 5), null);
  assert.equal(cueText(cues, 3724).text, "Late");
  assert.equal(cueText(null, 1), null);
  const many = Array.from({ length: 5000 }, (_, index) => ({ start: index * 2, end: index * 2 + 1.5, text: String(index), italic: false }));
  assert.equal(cueText(many, 4001).text, "2000");
  assert.equal(cueText(many, 4001.8), null);
});

test("the panel offers Off, embedded tracks and every sidecar; a sidecar turns embedded tracks off and is remembered per title", () => {
  const embedded = { id: "3", language: "en", label: "English" };
  const options = subtitleOptions({ availableSubtitleTracks: [embedded] }, [
    { path: "Movies/A.es.srt", language: "es", label: "Spanish" },
    { path: "Movies/A.en.forced.srt", language: "en", label: "English (forced)" },
  ]);
  assert.deepEqual(options.map((o) => [o.kind, o.label]), [["off", "Off"], ["track", "English"], ["file", "Spanish"], ["file", "English (forced)"]]);
  assert.deepEqual(applyChoice(options[2]), { track: null, sidecar: "Movies/A.es.srt" });
  assert.deepEqual(applyChoice(options[1]), { track: embedded, sidecar: null });
  assert.deepEqual(applyChoice(options[0]), { track: null, sidecar: null });
  assert.equal(chosenKey(options, null, "Movies/A.es.srt"), "file:Movies/A.es.srt");
  assert.equal(chosenKey(options, { id: "3" }, null), "track:3");
  assert.equal(chosenKey(options, null, null), "off");
  assert.equal(restoreChoice(options, { key: "file:Movies/A.es.srt" }), options[2]);
  const next = subtitleOptions({ availableSubtitleTracks: [] }, [{ path: "Show/S1E2.es.srt", label: "Spanish" }]);
  assert.equal(restoreChoice(next, { key: "file:Show/S1E1.es.srt", kind: "file", label: "Spanish" }).path, "Show/S1E2.es.srt", "the next episode keeps the same language");
  assert.equal(restoreChoice(next, null), null);
  assert.equal(titleKey({ kind: "episode", show: "s:bb", id: "e:1" }), "s:bb");
  assert.equal(titleKey({ kind: "movie", id: "m:1" }), "m:1");
  assert.equal(subtitleRoute("v1", "Movies/A & B.es.srt"), "/v1/video/subtitles?volume=v1&path=Movies%2FA+%26+B.es.srt&format=json");
});

test("sidecars come from the hub with the bearer header through the private-network rules, or from the local copy", async () => {
  const seen = [];
  const fetcher = async (url, options) => {
    seen.push({ url, auth: options.headers.Authorization });
    return new Response(JSON.stringify({ text: "WEBVTT\n\n00:01.000 --> 00:02.000\nHub" }), { status: 200 });
  };
  const client = createClient({
    secrets: { read: async () => ({ url: "http://casa.tail1.ts.net:7443", token: "tok", id: "p", hubId: "h" }), write: async () => {}, clear: async () => {} },
    cache: { read: async () => null, write: async () => {} },
    fetcher,
    resolvePrivateURL: async () => "http://100.100.1.2:7443",
  });
  await client.load();
  const hub = await loadSubtitles({ client, volume: "v1", path: "a.es.srt" });
  assert.equal(hub[0].text, "Hub");
  assert.equal(seen[0].url, "http://100.100.1.2:7443/v1/video/subtitles?volume=v1&path=a.es.srt&format=json");
  assert.equal(seen[0].auth, "Bearer tok");
  await assert.rejects(loadSubtitles({ client: { api: async () => ({}) }, volume: "v1", path: "a.srt" }), /no subtitles/);
});

test("embedded MKV subtitles come from the hub's extraction, replacing the engine's own tracks so HLS keeps them", async () => {
  const engineTrack = { id: "9", language: "en", label: "English (engine)" };
  const options = subtitleOptions({ availableSubtitleTracks: [engineTrack] }, [
    { embedded: true, stream: 0, language: "en", label: "English" },
    { embedded: true, stream: 1, language: "en", label: "English PGS", image: true },
    { embedded: true, stream: 2, language: "es", label: "Spanish" },
    { path: "Movies/A.fr.srt", language: "fr", label: "French" },
  ]);
  assert.deepEqual(options.map((o) => [o.kind, o.label]), [["off", "Off"], ["stream", "English"], ["stream", "Spanish"], ["file", "French"]]);
  assert.deepEqual(applyChoice(options[2]), { track: null, sidecar: "stream:2" });
  assert.equal(chosenKey(options, null, "stream:2"), "stream:2");
  assert.equal(chosenKey(options, null, "Movies/A.fr.srt"), "file:Movies/A.fr.srt");
  const seen = [];
  const answers = [{ preparing: true }, { preparing: true }, { text: "WEBVTT\n\n00:01.000 --> 00:02.000\n<i>Hola</i>" }];
  const client = { api: async (route, body, options) => (seen.push([route, body, options]), answers.shift() || { text: "WEBVTT\n\n00:03.000 --> 00:04.000\nBonjour" }) };
  const pauses = [];
  const cues = await loadSubtitles({ client, volume: "v1", path: "stream:2", item: { path: "Movies/A.mkv", hash: "a".repeat(64) }, pause: async (ms) => pauses.push(ms) });
  assert.deepEqual(cues.map((cue) => [cue.start, cue.text, cue.italic]), [[1, "Hola", true]]);
  assert.equal(seen[0][0], `/v1/video/subtitles?volume=v1&path=Movies%2FA.mkv&hash=${"a".repeat(64)}&stream=2&poll=1&format=json`);
  assert.equal(seen.length, 3, "the phone asks again while the hub is still preparing the file's subtitles");
  assert.deepEqual(pauses, [3000, 3000]);
  let clock = 0;
  const stuck = { api: async () => ({ preparing: true }) };
  await assert.rejects(
    loadSubtitles({ client: stuck, volume: "v1", path: "stream:2", item: { path: "Movies/A.mkv", hash: "a".repeat(64) }, pause: async () => {}, now: () => (clock += EMBEDDED_TIMEOUT) }),
    /taking too long/,
  );
  await loadSubtitles({ client, volume: "v1", path: "Movies/A.fr.srt", item: { path: "Movies/A.mkv", hash: "a".repeat(64) } });
  assert.doesNotMatch(seen.at(-1)[0], /poll=1/, "a sidecar is read in one request");
});

test("a remembered embedded track follows its name to the next episode, whose stream numbers differ", () => {
  const ep1 = subtitleOptions({}, [
    { embedded: true, stream: 0, language: "es", label: "Spanish" },
    { embedded: true, stream: 1, language: "en", label: "English" },
  ]);
  const chosen = ep1.find((o) => o.label === "English");
  const ep2 = subtitleOptions({}, [
    { embedded: true, stream: 0, language: "en", label: "English" },
    { embedded: true, stream: 1, language: "es", label: "Spanish" },
  ]);
  assert.equal(restoreChoice(ep2, { key: chosen.key, kind: chosen.kind, label: chosen.label }).label, "English");
  assert.equal(restoreChoice(subtitleOptions({}, [{ embedded: true, stream: 1, label: "German" }]), { key: "stream:1", kind: "stream", label: "English" }), null, "no English there: subtitles stay off");
});
