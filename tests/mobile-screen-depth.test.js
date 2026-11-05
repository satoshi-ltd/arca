import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { enterKind, screenDepth } from "../apps/mobile/src/screen-depth.js";

const app = fs.readFileSync(new URL("../apps/mobile/src/App.jsx", import.meta.url), "utf8");
const base = { onboarding: false, step: "welcome", detail: false, inFolder: true, musicLevel: null, videoRoute: null, directory: "" };

test("every step deeper pushes forward and every step back pushes back", () => {
  const at = (fields) => screenDepth({ ...base, ...fields });
  assert.equal(enterKind(at({ directory: "2026" }), at({})), "forward", "a sub-folder");
  assert.equal(enterKind(at({ directory: "2026/trip" }), at({ directory: "2026" })), "forward");
  assert.equal(enterKind(at({}), at({ directory: "2026" })), "back");
  assert.equal(enterKind(at({ videoRoute: [{ kind: "home" }, { kind: "movie" }] }), at({ videoRoute: [{ kind: "home" }] })), "forward", "a title page");
  assert.equal(enterKind(at({ musicLevel: 2 }), at({ musicLevel: 1 })), "forward", "artist to album");
  assert.equal(enterKind(at({ inFolder: false }), at({})), "back", "back to Folders");
  assert.equal(enterKind(at({ detail: true }), at({ directory: "a/b/c" })), "forward", "a file detail is always deeper");
  assert.equal(enterKind(at({ onboarding: true, step: "pair" }), at({ onboarding: true, step: "welcome" })), "forward", "the next onboarding step");
  assert.equal(enterKind(at({ musicLevel: 0 }), at({ musicLevel: 0 })), "fade", "a tab switch at the same level");
});

test("the screen remounts on every level and restores the scroll it left when going back", () => {
  assert.match(app, /key=\{screenKey\}/);
  const key = app.split("\n").find((line) => line.includes("const screenKey = "));
  for (const part of ['${onboarding ? onboardingStep : ""}', "videoRoute.length}:${videoRoute[1]?.id ?? \"\"}", ":${directory}"]) assert.ok(key.includes(part), part);
  assert.match(app, /\{!musicView && <ScrollMemory id=\{screenKey\} restore=\{screenEnter === "back"\} \/>\}/);
  const pane = fs.readFileSync(new URL("../apps/mobile/src/KeyboardPane.jsx", import.meta.url), "utf8");
  assert.match(pane, /if \(restore\) frame = requestAnimationFrame\([\s\S]*?scrollTo\(scrollOffset\(id\)\)/);
  assert.match(pane, /keepScroll\(id, live\.current\?\.offset\(\) \?\? 0\)/);
});

test("a tab change or leaving setup fades, and a video title or season change keeps the library mounted", () => {
  assert.match(app, /const place = `\$\{onboarding\}:\$\{view\}`;/);
  assert.match(app, /const screenEnter = place === lastPlace\.current \? enterKind\(depth, lastDepth\.current\) : "fade";/);
  const key = app.split("\n").find((line) => line.includes("const screenKey = "));
  assert.doesNotMatch(key, /JSON\.stringify\(videoRoute/, "a season or tab inside a title never remounts the screen");
  const library = fs.readFileSync(new URL("../apps/mobile/src/VideoLibrary.jsx", import.meta.url), "utf8");
  assert.match(library, /const \[sort, setSortState\] = useState\(\(\) => librarySort\.current\);/, "the chosen sort survives opening a title");
});
