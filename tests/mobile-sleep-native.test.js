import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { drainOutbox, permanentRefusal } from "../apps/mobile/src/audio-outbox.js";
import { SLEEP_OFF, SLEEP_OPTIONS, sameSleep, sleepFromState } from "../apps/mobile/src/sleep-timer.js";
import { buildLibrary, nativeLibrary } from "../apps/mobile/src/music-library.js";
import {
  RESUME_HEAD_SECONDS,
  RESUME_MIN_SECONDS,
} from "../packages/daemon/audio-positions.js";

const base = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (name) => fs.readFileSync(path.join(base, "apps", "mobile", "src", name), "utf8");
const kotlinDirectory = path.join(base, "apps", "mobile", "modules", "arca-network", "android", "src");
const main = (name) => fs.readFileSync(path.join(kotlinDirectory, "main", "java", "expo", "modules", "arcanetwork", name), "utf8");
const jvm = (name) => fs.readFileSync(path.join(kotlinDirectory, "test", "java", "expo", "modules", "arcanetwork", name), "utf8");
const constant = (text, name) => Number(new RegExp(`const val ${name} = ([0-9_]+)L?`).exec(text)?.[1].replaceAll("_", ""));

test("the service saves with the hub's own thresholds and the JavaScript no longer decides", () => {
  const rules = main("PositionOutbox.kt");
  assert.equal(constant(rules, "MIN_SECONDS"), RESUME_MIN_SECONDS);
  assert.equal(constant(rules, "HEAD_SECONDS"), RESUME_HEAD_SECONDS);
  assert.equal(constant(rules, "INTERVAL_MS"), 15000);
  assert.equal(constant(rules, "SEEK_SETTLE_MS"), 2000);
  assert.equal(constant(rules, "END_SLACK_MS"), 3000);
  const positions = src("audio-positions.js");
  assert.doesNotMatch(positions, /shouldSave|positionToSave|SAVE_INTERVAL/);
});

test("the sleep timer's options, durations and near window live in the service", () => {
  const timer = main("SleepTimer.kt");
  assert.deepEqual(SLEEP_OPTIONS.map((option) => option.value), ["30", "60", "end"]);
  assert.match(timer, /mapOf\("30" to 30 \* 60_000L, "60" to 60 \* 60_000L\)/);
  assert.match(timer, /const val END = "end"/);
  assert.equal(constant(timer, "DUE_MS"), 1500);
  assert.equal(constant(timer, "NEAR_MS"), 4000);
  assert.doesNotMatch(src("sleep-timer.js"), /sleepCheck|startSleep|endsAt:\s*now|setInterval/);
});

test("MusicService ticks the timer and the position saves, and queues saves in the outbox", () => {
  const service = main("MusicService.kt");
  assert.match(service, /private val sleepTimer = SleepTimer\(\)/);
  assert.match(service, /private val positions = PositionTracker\(\)/);
  assert.match(service, /main\.postDelayed\(ticker, 1000\)/);
  assert.match(service, /if \(player\.isPlaying \|\| sleepTimer\.active\) main\.postDelayed/);
  assert.match(service, /override fun onPlaybackStateChanged\(playbackState: Int\) \{\s+observe\(\)/);
  assert.match(service, /if \(reason == Player\.DISCONTINUITY_REASON_SEEK\) \{\s+heard\(\)\s+if \(oldPosition\.mediaItemIndex == newPosition\.mediaItemIndex\) positions\.seeked\(\)\s+observe\(\)/, "only a seek inside one item arms the gate, and every seek refreshes what a skip would save");
  assert.match(service, /if \(SleepTimer\.pauses\(playing, player\.playWhenReady\)\) player\.pause\(\)\s+if \(!playing\) positions\.force\(/, "expiry pauses a player that is playing or about to, and force-saves one that is not playing");
  assert.match(service, /val hash = tree\.library\.tracks\[id\]\?\.hash \?: return/);
  assert.match(service, /val library = File\(root\(this\), "music-library\.json"\)\s+outboxWriter\.execute \{ runCatching \{ target\.add\(scope, entry\) \{ library\.isFile \} \} \}/, "a queued write after an erase finds no library and writes nothing");
  assert.match(main("PositionOutbox.kt"), /fun add\(scope: String, entry: QueuedPosition, live: \(\) -> Boolean = \{ true \}\) \{\s+synchronized\(lock\) \{\s+if \(!live\(\)\) return/);
  assert.match(service, /main\.removeCallbacks\(ticker\)\s+sleepTimer\.off\(\)/);
  assert.match(main("MusicLibrary.kt"), /text\(item, "hash"\)\.takeIf \{ it\.isNotEmpty\(\) \}/);
});

test("the module exposes the timer and the outbox and the state carries the timer", () => {
  const module = main("ArcaNetworkModule.kt");
  assert.match(module, /AsyncFunction\("musicSleep"\) Coroutine \{ value: String ->\s+music\(\)\.sleep\(value\)/);
  assert.match(module, /AsyncFunction\("musicOutbox"\) Coroutine \{ scope: String ->/);
  assert.match(module, /AsyncFunction\("musicOutboxAck"\) Coroutine \{ sent: String ->/);
  const remote = main("MusicRemote.kt");
  assert.match(remote, /"sleep" to \(MusicService\.instance\?\.sleepState\(\) \?: SleepTimer\.OFF\)/);
  assert.match(remote, /MusicService\.instance\?\.setSleep\(value\)/);
  const player = src("music-player.js");
  assert.match(player, /sleep: \(value\) => native\.musicSleep\(value\)/);
  assert.match(player, /native\.musicOutboxAck\(JSON\.stringify\(sent\)\)/);
});

test("JVM tests cover expiry, End of episode, cancel, the outbox and the save rules", () => {
  const timer = jvm("SleepTimerTest.kt");
  for (const name of [
    "aDurationTimerExpiresExactlyAtItsEndAndSurvivesTrackChanges",
    "endOfEpisodeIsNearWithinFourSecondsAndDueWithinOneAndAHalf",
    "endOfEpisodeIsDueWhenPlaybackEnded",
    "theItemRunningOutIntoTheNextOneIsDueButChoosingAnotherMidwayCancels",
  ])
    assert.match(timer, new RegExp(`fun ${name}\\(`));
  const outbox = jvm("PositionOutboxTest.kt");
  for (const name of ["leavingAnItemAfterAScrubStillSavesItAtTheScrubbedPlace", "aSeekWhilePausedRefreshesWhatASkipSaves"])
    assert.match(outbox, /fun aWriteForALibraryThatIsGoneNeverCreatesTheFile\(/);
  assert.match(timer, /fun expiryPausesAPlayerThatIsPlayingOrAboutToPlay\(/);
  for (const name of ["acknowledgingKeepsAnEntryThatChangedAfterItWasSent", "anotherHubOrACorruptFileNeverLeaksEntries", "seekingHoldsSavesUntilItSettles", "transitionsDecideWhatIsSaved"])
    assert.match(outbox, new RegExp(`fun ${name}\\(`));
});

test("the library file carries the hash of every track long enough to be resumable", () => {
  const folder = {
    id: "p",
    library: {
      tracks: [
        { path: "Show/long.mp3", hash: "h-long", duration: 3600, genre: "Podcast", album: "Show" },
        { path: "Show/short.mp3", hash: "h-short", duration: 1199, genre: "Podcast", album: "Show" },
        { path: "Music/song.mp3", hash: "h-song", duration: 200, album: "Album" },
        { path: "Music/unknown.mp3", hash: "h-unknown", album: "Album" },
      ],
    },
    present: new Map([["Show/long.mp3", "h-long"], ["Show/short.mp3", "h-short"], ["Music/song.mp3", "h-song"], ["Music/unknown.mp3", "h-unknown"]]),
    uri: (file) => `file:///${file}`,
  };
  const published = nativeLibrary(buildLibrary([folder]), "hub");
  const hashes = Object.fromEntries(published.tracks.map((track) => [track.id, track.hash]));
  assert.deepEqual(hashes, {
    "p:Show/long.mp3": "h-long",
    "p:Show/short.mp3": "h-short",
    "p:Music/song.mp3": null,
    "p:Music/unknown.mp3": "h-unknown",
  });
});

test("the timer shown in the app is whatever the service reports", () => {
  assert.deepEqual(sleepFromState({ sleep: { mode: "duration", value: "30", endsAt: 5000 } }), { mode: "duration", value: "30", endsAt: 5000 });
  assert.deepEqual(sleepFromState({ sleep: { mode: "end", value: "end", endsAt: null } }), { mode: "end", value: "end" });
  assert.deepEqual(sleepFromState({ sleep: { mode: "duration", value: "30", endsAt: null } }), SLEEP_OFF);
  assert.deepEqual(sleepFromState({ sleep: { mode: "off" } }), SLEEP_OFF);
  assert.deepEqual(sleepFromState({ id: "x" }), SLEEP_OFF, "a service without the timer reads as off");
  assert.deepEqual(sleepFromState(null), SLEEP_OFF);
  assert.equal(sameSleep({ mode: "end", value: "end" }, { mode: "end", value: "end" }), true);
  assert.equal(sameSleep({ mode: "duration", value: "30", endsAt: 1 }, { mode: "duration", value: "30", endsAt: 2 }), false);
  const session = src("audio-session.js");
  assert.match(session, /setSleep = useCallback\(\s+\(value\) => \{\s+player\.sleep\(value\)\.then\(observe/);
  assert.match(session, /latest\.current\.playing \|\| latest\.current\.sleeping/, "the display polls while a timer runs");
});

const entry = (path, at, extra = {}) => ({ volume: "v", path, hash: `h-${path}`, position: 600, duration: 3600, at, ...extra });

test("the drain sends queued positions with their own times and acknowledges what the hub took", async () => {
  const calls = [];
  const acknowledged = [];
  const sent = await drainOutbox({
    scope: "hub",
    read: async (scope) => ({ entries: [entry("a", 10), entry("b", 20)], scope }),
    acknowledge: async (rows) => acknowledged.push(...rows),
    send: async (body) => calls.push(body),
  });
  assert.deepEqual(calls[0], { volume: "v", path: "a", hash: "h-a", position: 600, duration: 3600, at: 10 });
  assert.equal(sent.length, 2);
  assert.deepEqual(acknowledged, [{ volume: "v", path: "a", at: 10 }, { volume: "v", path: "b", at: 20 }]);
});

test("the drain keeps entries while the hub is unreachable and drops the ones it refuses for good", async () => {
  const acknowledged = [];
  const refuse = (status) => Object.assign(new Error(`HTTP ${status}`), { status });
  let attempts = 0;
  const sent = await drainOutbox({
    scope: "hub",
    read: async () => ({ entries: [entry("gone", 1), entry("slow", 2), entry("later", 3)] }),
    acknowledge: async (rows) => acknowledged.push(...rows),
    send: async (body) => {
      attempts++;
      if (body.path === "gone") throw refuse(404);
      if (body.path === "slow") throw new Error("Network request failed");
    },
  });
  assert.equal(attempts, 2, "an unreachable hub stops the drain and keeps the rest");
  assert.deepEqual(sent, []);
  assert.deepEqual(acknowledged, [{ volume: "v", path: "gone", at: 1 }]);
  for (const status of [401, 408, 429, 500, 503]) assert.equal(permanentRefusal(refuse(status)), false, String(status));
  for (const status of [400, 403, 404, 409]) assert.equal(permanentRefusal(refuse(status)), true, String(status));
  assert.equal(permanentRefusal(new Error("offline")), false);
});

test("a refusal for one entry skips to the next while an unreachable hub stops the drain", async () => {
  const run = async (failure) => {
    const calls = [];
    const acknowledged = [];
    await drainOutbox({
      scope: "hub",
      read: async () => ({ entries: [entry("a", 1), entry("b", 2), entry("c", 3)] }),
      acknowledge: async (rows) => acknowledged.push(...rows.map((row) => row.path)),
      send: async (body) => {
        calls.push(body.path);
        if (body.path === "a") throw failure;
      },
    });
    return { calls, acknowledged };
  };
  const status = (code) => Object.assign(new Error(`HTTP ${code}`), { status: code });
  assert.deepEqual(await run(status(500)), { calls: ["a", "b", "c"], acknowledged: ["b", "c"] }, "a server error on one entry keeps it and goes on");
  assert.deepEqual(await run(status(404)), { calls: ["a", "b", "c"], acknowledged: ["a", "b", "c"] });
  assert.deepEqual(await run(new Error("Network request failed")), { calls: ["a"], acknowledged: [] });
  assert.deepEqual(await run(Object.assign(status(503), { hubUnavailable: true })), { calls: ["a"], acknowledged: [] }, "an unavailable hub stops it");
  assert.deepEqual(await run(status(401)), { calls: ["a"], acknowledged: [] });
  assert.deepEqual(await run(status(429)), { calls: ["a"], acknowledged: [] });
});

test("the drain does nothing without a scope or an outbox", async () => {
  let read = 0;
  assert.deepEqual(await drainOutbox({ scope: undefined, read: async () => (read++, { entries: [] }), acknowledge: async () => {}, send: async () => {} }), []);
  assert.equal(read, 0);
  let acknowledged = 0;
  await drainOutbox({ scope: "hub", read: async () => ({ entries: [] }), acknowledge: async () => acknowledged++, send: async () => {} });
  assert.equal(acknowledged, 0);
});
