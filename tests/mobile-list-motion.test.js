import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createListMotion, RISE_LIMIT } from "../apps/mobile/src/list-motion.js";

const read = (file) => fs.readFileSync(new URL(file, import.meta.url), "utf8");
const ids = (count, from = 0) => Array.from({ length: count }, (_, i) => `f${from + i}`);
const drain = (list, all) => Object.fromEntries(all.map((id) => [id, list.take(id)]).filter(([, v]) => v));

test("the first six rows of a list cascade and the rest stay still", () => {
  const list = createListMotion();
  const all = ids(9);
  list.note(all);
  const modes = drain(list, all);
  assert.equal(Object.keys(modes).length, RISE_LIMIT);
  assert.deepEqual(Object.values(modes).map((m) => m.index), [0, 1, 2, 3, 4, 5]);
  assert.ok(Object.values(modes).every((m) => m.mode === "cascade"));
});

test("an empty list does not use up the cascade", () => {
  const list = createListMotion();
  list.note([]);
  list.note(ids(2));
  assert.equal(Object.keys(drain(list, ids(2))).length, 2);
});

test("a row that appears later settles once and the others stay still", () => {
  const list = createListMotion();
  list.note(ids(3));
  drain(list, ids(3));
  list.note(["new", ...ids(3)]);
  assert.deepEqual(drain(list, ["new", ...ids(3)]), { new: { mode: "arrival", index: 0 } });
  list.note(ids(3));
  assert.deepEqual(drain(list, ids(3)), {}, "removing a row animates nothing");
});

test("remounting the list never replays what already played", () => {
  const list = createListMotion();
  list.note(ids(3));
  drain(list, ids(3));
  list.note(ids(3));
  assert.deepEqual(drain(list, ids(3)), {});
});

test("motion not yet shown waits for the list to render", () => {
  const list = createListMotion();
  list.note(ids(2));
  list.note(ids(3));
  const modes = drain(list, ids(3));
  assert.equal(modes.f0.mode, "cascade");
  assert.equal(modes.f2.mode, "arrival");
});

test("a whole new list replacing the old one is not an arrival", () => {
  const list = createListMotion();
  list.note(ids(3));
  drain(list, ids(3));
  list.note(ids(12, 100));
  assert.deepEqual(drain(list, ids(12, 100)), {});
});

test("folder rows scale on press and rise through Rise, both off under reduced motion", () => {
  const components = read("../apps/mobile/src/components.jsx");
  assert.match(components, /!disabled && pressScale\(pressed, reduce\)/);
  const app = read("../apps/mobile/src/App.jsx");
  assert.match(app, /useListMotion\(locals\.map\(\(f\) => f\.id\)\)/);
  assert.match(app, /<Rise\s+key=\{f\.id\}\s+tint=\{c\.tint\}\s+\{\.\.\.folderMotion\(f\.id\)\}/);
  const motion = read("../apps/mobile/src/motion.js");
  assert.match(motion, /new Animated\.Value\(mode && !reduce \? 0 : 1\)/);
});
