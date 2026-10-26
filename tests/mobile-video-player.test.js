import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  clock,
  countdown,
  initialPlayer,
  playerStep,
  scrubAction,
  seekTarget,
} from "../apps/mobile/src/video-player-state.js";

function run(events, hasNext = false, start = initialPlayer(0)) {
  let state = start;
  const effects = [];
  for (const event of events) {
    const step = playerStep(state, event, hasNext);
    state = step.state;
    effects.push(...step.effects.map((effect) => ({ ...effect, at: event.now })));
  }
  return { state, effects };
}

const tick = (now, position, duration = 2880, playing = true) => ({ type: "tick", now, position, duration, playing });

test("the position is saved every 10 s while playing, never twice for the same second, and not in the first 10 s", () => {
  const { effects } = run([tick(1000, 2), tick(5000, 6), tick(10000, 11), tick(15000, 16), tick(20000, 21), tick(30000, 31)]);
  assert.deepEqual(effects.map((e) => [e.type, e.at, e.position]), [
    ["save", 10000, 11],
    ["save", 20000, 21],
    ["save", 30000, 31],
  ]);
  assert.deepEqual(run([tick(10000, 3)]).effects, [], "the hub ignores under 10 s, so nothing is sent");
  assert.deepEqual(run([tick(10000, 40, 2880, false), tick(20000, 40, 2880, false)]).effects, [], "a paused player does not repeat itself");
});

test("pause and exit save at once with the player's own position", () => {
  const paused = run([tick(1000, 60), { type: "pause", now: 2000, position: 61.5 }]);
  assert.deepEqual(paused.effects.map((e) => [e.type, e.position]), [["save", 61.5]]);
  const exit = run([tick(1000, 60), { type: "pause", now: 2000, position: 61.5 }, { type: "exit", now: 3000, position: 61.5 }]);
  assert.equal(exit.effects.length, 1, "exit right after a pause does not save the same second again");
  const moved = run([tick(1000, 60), { type: "exit", now: 3000, position: null }]);
  assert.deepEqual(moved.effects.map((e) => e.position), [60], "an exit without a readable position keeps the last tick");
});

test("Up next appears in the last 30 s of an episode, counts down 10 s and plays the next one once", () => {
  const near = run([tick(1000, 2840), tick(2000, 2852)], true);
  assert.equal(near.effects.length, 0);
  assert.ok(near.state.upNext);
  assert.equal(countdown(near.state, 2000), 10);
  assert.equal(countdown(near.state, 6500), 6);
  const played = run([tick(1000, 2852), tick(5000, 2856), tick(11000, 2862), tick(12000, 2863)], true);
  assert.deepEqual(played.effects.filter((e) => e.type === "next").map((e) => e.at), [11000]);
  assert.ok(played.effects.some((e) => e.type === "save"), "the finished episode's position is saved before switching");
  const ended = run([tick(1000, 2852), { type: "ended", now: 2000 }], true);
  assert.deepEqual(ended.effects.map((e) => e.type), ["save", "next"], "reaching the end plays the next episode at once");
  const twice = run([tick(1000, 2852), tick(12000, 2863), { type: "ended", now: 13000 }], true);
  assert.equal(twice.effects.filter((e) => e.type === "next").length, 1);
});

test("Cancel keeps watching, Play now skips the countdown, a movie or last episode never shows Up next", () => {
  const cancelled = run([tick(1000, 2852), { type: "cancel", now: 2000 }, tick(13000, 2863), { type: "ended", now: 14000 }], true);
  assert.equal(cancelled.effects.some((e) => e.type === "next"), false);
  assert.equal(cancelled.state.upNext, null);
  const now = run([tick(1000, 2852), { type: "playNext", now: 2000 }], true);
  assert.deepEqual(now.effects.map((e) => e.type), ["save", "next"]);
  const alone = run([tick(1000, 2852), tick(13000, 2870), { type: "ended", now: 14000 }], false);
  assert.equal(alone.state.upNext, null);
  assert.equal(alone.effects.some((e) => e.type === "next"), false);
  const short = run([tick(1000, 40, 50)], true);
  assert.equal(short.state.upNext, null, "a clip shorter than a minute plays out");
  const back = run([tick(1000, 2852), { type: "seek", now: 2000, position: 100 }, tick(3000, 100)], true);
  assert.equal(back.state.upNext, null, "seeking back hides Up next");
  const again = run([tick(1000, 2852), { type: "cancel", now: 2000 }, { type: "seek", now: 3000, position: 100 }, tick(4000, 2852)], true);
  assert.ok(again.state.upNext, "after seeking back, reaching the end offers Up next again");
});

test("controls helpers clamp seeks and print clocks like the boards", () => {
  assert.equal(seekTarget(5, 100, -10), 0);
  assert.equal(seekTarget(90, 100, 30), 100);
  assert.equal(seekTarget(90, 0, 30), 120);
  assert.equal(clock(1486), "24:46");
  assert.equal(clock(3730), "1:02:10");
  assert.equal(clock(-3), "0:00");
});

test("a paused player holds the Up next countdown and never plays the next episode by itself", () => {
  const paused = run([tick(1000, 2852), tick(2000, 2853), tick(3000, 2853, 2880, false), tick(20000, 2853, 2880, false), tick(40000, 2853, 2880, false)], true);
  assert.equal(paused.effects.some((e) => e.type === "next"), false);
  assert.equal(countdown(paused.state, 40000), 9, "the countdown resumes where it stopped");
  const resumed = run([tick(1000, 2852), tick(2000, 2853), tick(3000, 2853, 2880, false), tick(30000, 2853, 2880, false), tick(31000, 2854), tick(39000, 2862), tick(40000, 2863)], true);
  assert.deepEqual(resumed.effects.filter((e) => e.type === "next").map((e) => e.at), [39000], "eight seconds were left when it paused");
});

test("the scrubber's accessibility actions move forward 30 s and back 10 s", () => {
  assert.equal(scrubAction("increment", 100, 2880), 130);
  assert.equal(scrubAction("decrement", 100, 2880), 90);
  assert.equal(scrubAction("decrement", 4, 2880), 0);
  assert.equal(scrubAction("activate", 100, 2880), null);
});

test("the player starts from the saved point, so a direct-play failure falls back to the compatible stream there and never saves 0:00 over it", () => {
  assert.equal(initialPlayer(0, 2700).position, 2700);
  assert.equal(initialPlayer(0).position, 0);
  assert.equal(initialPlayer(0, "x").position, 0);
  const player = fs.readFileSync(new URL("../apps/mobile/src/VideoPlayer.jsx", import.meta.url), "utf8");
  assert.match(player, /const model = useRef\(initialPlayer\(Date\.now\(\), session\.at\)\);/);
  assert.match(player, /restarter\.current\.now\(\{ start: model\.current\.position, audio: chosenAudio\.current \}\)/);
});
