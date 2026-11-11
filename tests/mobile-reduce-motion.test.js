import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createReduceMotion } from "../apps/mobile/src/reduce-motion.js";

const read = (name) => fs.readFileSync(new URL(`../apps/mobile/src/${name}`, import.meta.url), "utf8");

function accessibility(enabled) {
  const handlers = [];
  let answer;
  const info = {
    asked: 0,
    handlers,
    isReduceMotionEnabled() {
      info.asked++;
      return new Promise((resolve) => {
        answer = resolve;
        if (enabled !== undefined) resolve(enabled);
      });
    },
    addEventListener(name, handler) {
      handlers.push([name, handler]);
      return { remove() {} };
    },
    answer: (value) => answer(value),
    change: (value) => handlers.forEach(([, handler]) => handler(value)),
  };
  return info;
}

test("once primed, Reduce Motion is read synchronously, so a screen mounted afterwards is instant on its first render", async () => {
  const info = accessibility(true);
  const store = createReduceMotion(info);
  assert.equal(store.get(), false);
  assert.equal(store.ready(), false, "the first screen waits for the answer");
  await store.prime();
  assert.equal(store.ready(), true);
  assert.equal(store.get(), true, "a hook mounted now reads true at once, with no later update");
});

test("priming twice asks once and registers one listener for the whole app", async () => {
  const info = accessibility(false);
  const store = createReduceMotion(info);
  const first = store.prime();
  assert.equal(store.prime(), first);
  await first;
  for (let i = 0; i < 5; i++) store.subscribe(() => {});
  assert.equal(info.asked, 1);
  assert.deepEqual(info.handlers.map(([name]) => name), ["reduceMotionChanged"]);
});

test("a change of the setting reaches every subscriber, and a removed one hears nothing", async () => {
  const info = accessibility(false);
  const store = createReduceMotion(info);
  await store.prime();
  const heard = [[], [], []];
  const unsubscribe = heard.map((list) => store.subscribe(() => list.push(store.get())));
  unsubscribe[2]();
  info.change(true);
  assert.deepEqual(heard, [[true], [true], []]);
  info.change(false);
  assert.equal(store.get(), false);
  assert.deepEqual(heard[0], [true, false]);
});

test("a change heard before the first answer wins over that answer, and a failed answer means motion stays on", async () => {
  const info = accessibility();
  const store = createReduceMotion(info);
  const priming = store.prime();
  await Promise.resolve();
  info.change(true);
  info.answer(false);
  await priming;
  assert.equal(store.get(), true);
  assert.equal(store.ready(), true);
  const failing = createReduceMotion({ ...accessibility(), isReduceMotionEnabled: () => Promise.reject(new Error("unavailable")), addEventListener: () => ({ remove() {} }) });
  await failing.prime();
  assert.equal(failing.ready(), true, "the app still opens");
  assert.equal(failing.get(), false);
});

test("the app primes one store before the first screen and every motion reads it synchronously", () => {
  const motion = read("motion.js");
  assert.match(motion, /export const reduceMotion = createReduceMotion\(AccessibilityInfo\);/);
  assert.match(motion, /export function useReduceMotion\(\) \{\s+return useSyncExternalStore\(reduceMotion\.subscribe, reduceMotion\.get\);\s+\}/);
  assert.doesNotMatch(motion, /isReduceMotionEnabled|addEventListener\(\s*"reduceMotionChanged"/, "hooks register no listener of their own");
  const app = read("App.jsx");
  assert.match(app, /SplashScreen\.preventAutoHideAsync\(\)\.catch\(\(\) => \{\}\);\s+reduceMotion\.prime\(\);/, "priming starts when the app module loads");
  assert.match(app, /const opening =\s+\(!fonts && !fontError\) \|\|\s+!motionReady \|\|/, "the first screen waits for the setting, like it waits for fonts");
  const sources = fs.readdirSync(new URL("../apps/mobile/src/", import.meta.url)).filter((name) => /\.(js|jsx)$/.test(name));
  const readers = sources.filter((name) => /isReduceMotionEnabled|"reduceMotionChanged"/.test(read(name)));
  assert.deepEqual(readers, ["reduce-motion.js"], "one native read and one listener for the app");
});
