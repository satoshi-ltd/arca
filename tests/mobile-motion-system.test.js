import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createLeaving } from "../apps/mobile/src/list-motion.js";
import { motion } from "../apps/mobile/src/design-tokens.js";

const read = (name) => fs.readFileSync(new URL(`../apps/mobile/src/${name}`, import.meta.url), "utf8");

test("a removed row stays in place, marked leaving, until its exit ends", () => {
  const leaving = createLeaving((item) => item.id);
  const [a, b, c] = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert.deepEqual(leaving.rows([a, b, c]).map((row) => [row.key, row.leaving]), [["a", false], ["b", false], ["c", false]]);
  assert.deepEqual(leaving.rows([a, c]).map((row) => [row.key, row.leaving]), [["a", false], ["b", true], ["c", false]], "b fades where it was");
  assert.deepEqual(leaving.rows([a, c]).map((row) => row.key), ["a", "b", "c"], "a re-render keeps it until it has left");
  assert.equal(leaving.left("b"), true);
  assert.deepEqual(leaving.rows([a, c]).map((row) => row.key), ["a", "c"], "then the rows below close the gap");
  assert.equal(leaving.left("b"), false);
  leaving.rows([a]);
  assert.deepEqual(leaving.rows([a, c]).map((row) => [row.key, row.leaving]), [["a", false], ["c", false]], "a row that comes back during its exit is simply there");
});

test("Rise fades a leaving row 140 ms in place, then closes its height 140 ms; reduced motion removes it at once", () => {
  const source = read("motion.js");
  const rise = source.slice(source.indexOf("export function Rise("), source.indexOf("export function useFlight("));
  assert.match(rise, /if \(reduce \|\| !measured\.current\) return void onLeft\?\.\(\);/);
  assert.match(rise, /Animated\.timing\(fade, \{ toValue: 0, duration: duration\(motion\.exit\), easing, useNativeDriver: true \}\)/);
  assert.match(rise, /Animated\.timing\(height, \{ toValue: 0, duration: duration\(motion\.exit\), easing, useNativeDriver: false \}\)/);
  assert.match(rise, /pointerEvents=\{leaving \? "none" : "auto"\}/, "a leaving row takes no taps");
  assert.match(rise, /if \(unseen && leaving\) return null;/, "a row that left while the list was hidden never flashes");
  const app = read("App.jsx");
  assert.match(app, /const \[folderRows, folderLeft\] = useLeaving\(locals, \(f\) => f\.id\);/, "a folder that stops syncing");
  const favorites = read("Favorites.jsx");
  assert.equal(favorites.match(/useLeaving\(items, favoriteKey\)/g).length, 2, "and a favorite removed on the phone or in the drawer");
  assert.equal(favorites.match(/<Rise key=\{key\} leaving=\{leaving\} onLeft=\{\(\) => left\(key\)\}>/g).length, 2);
});

test("a pressed row, button or tile goes down at once and eases back over 120 ms", () => {
  const components = read("components.jsx");
  const press = components.slice(components.indexOf("export function PressScale("), components.indexOf("export function Button("));
  assert.match(press, /value\.stopAnimation\(\);\s+value\.setValue\(scale && !reduce \? motion\.pressScale : 1\);/);
  assert.match(press, /Animated\.timing\(value, \{\s+toValue: 1,\s+duration: reduce \? 0 : motion\.fast,\s+easing,\s+useNativeDriver: true,/);
  assert.match(press, /style=\{\[typeof style === "function" \? style\(\{ pressed \}\) : style, \{ transform: \[\{ scale: value \}\] \}\]\}/);
  assert.doesNotMatch(components + read("MusicLibrary.jsx") + read("NowPlayingPage.jsx"), /pressScale\(pressed/, "no press snaps back any more");
  assert.equal(motion.fast, 120);
});

test("the file history ⋯ menu is a popover that leaves in 80 ms and returns focus to its trigger", () => {
  const app = read("App.jsx");
  assert.match(app, /const \[fileMenuShown, releaseFileMenu\] = useRetained\(fileActionsOpen \? "open" : null\);/);
  assert.match(app, /Animated\.timing\(value, \{ toValue: 1, duration: motionMs\(motion\.fast\), easing: motionEase, useNativeDriver: true \}\)/, "in 120 ms");
  assert.match(app, /Animated\.timing\(fileMenuFade, \{ toValue: 0, duration: motionMs\(motion\.exitFast\), easing: motionEase, useNativeDriver: true \}\)\.start\(\s+\(\{ finished \}\) => finished && releaseFileMenu\(\),/, "out in 80 ms, opacity only");
  assert.match(app, /outputRange: \[-motion\.distance \/ 2, 0\]/, "4 dp down from the ⋯ corner");
  assert.match(app, /<View style=\{s\.fileMenuOverlay\} pointerEvents=\{fileActionsOpen \? "box-none" : "none"\}>/, "no taps from the first exit frame");
  assert.match(app, /function dismissFileMenu\(\) \{\s+setFileActionsOpen\(false\);\s+const trigger = fileMenuTrigger\.current && findNodeHandle\(fileMenuTrigger\.current\);\s+if \(trigger\) AccessibilityInfo\.setAccessibilityFocus\(trigger\);/);
  assert.match(app, /if \(fileActionsOpen\) \{\s+dismissFileMenu\(\);\s+return true;/, "Back closes it the same way");
  assert.equal(motion.exitFast, 80);
});

test("notices enter on the shared ease and fall and fade 140 ms when dismissed or swiped", () => {
  const notice = read("Notice.jsx");
  assert.doesNotMatch(notice, /AccessibilityInfo|noticeMetrics\.duration/, "no own timing and no own reduced-motion read");
  assert.match(notice, /toValue: leaving \? 0 : 1,\s+duration: duration\(leaving \? motion\.exit : motion\.enter\),\s+easing,/);
  assert.match(notice, /onPanResponderMove: \(_, g\) => drag\.setValue\(Math\.max\(0, g\.dy\)\)/, "a swipe moves it with the finger");
  assert.match(notice, /if \(g\.dy > 32\) dismiss\.current\(\);\s+else settle\.current\(\);/);
  assert.match(notice, /const \[rows, left\] = useLeaving\(items, noticeKey\);/, "the stack keeps a dismissed notice until its fall ends");
  assert.match(notice, /onDismiss=\{\(\) => !leaving && onDismiss\(item\.id\)\}/);
  assert.match(notice, /const noticeKey = \(item\) => item\.id;/, "an updated notice keeps its card instead of leaving a duplicate behind");
  assert.match(notice, /if \(shownAt\.current === item\.created\) return;[\s\S]*?swap\.setValue\(0\);\s+Animated\.timing\(swap, \{ toValue: 1, duration: duration\(motion\.fast\), easing, useNativeDriver: true \}\)\.start\(\);/, "its new content fades in place");
  assert.match(notice, /<Animated\.View style=\{\[s\.noticeMain, \{ opacity: swap \}\]\} \{\.\.\.swipe\.panHandlers\}>/);
  assert.match(notice, /leaving=\{leaving === error\}\s+onLeft=\{\(\) => setDismissed\(error\)\}\s+onDismiss=\{\(\) => setLeaving\(error\)\}/);
});

test("Now Playing, Search Arca and the photo viewer run on the tokens and honour reduced motion", () => {
  const playing = read("NowPlayingPage.jsx");
  assert.match(playing, /duration: ms\(motion\.enter\), easing, useNativeDriver: true/);
  assert.match(playing, /duration: ms\(motion\.exit\), easing, useNativeDriver: true/, "leaves in 140 ms");
  assert.match(playing, /pointerEvents=\{visible \? "auto" : "none"\}/);
  const search = read("GlobalSearch.jsx");
  assert.match(search, /<Modal visible=\{mounted\} animationType="none" transparent/);
  assert.match(search, /duration: duration\(visible \? motion\.enter : motion\.exit\)/);
  assert.match(search, /outputRange: \[motion\.dialogScale, 1\]/, "the Fold dialog scales like every dialog");
  assert.match(search, /useEffect\(\(\) => \{\s+if \(!mounted\) \{\s+setQuery\(""\);/, "the field clears after the exit, not during it");
  const viewer = read("PhotoViewer.jsx");
  assert.match(viewer, /animationType="none"/);
  assert.match(viewer, /<Animated\.View\s+style=\{\[s\.viewerRoot, s\.viewerTransparent, \{ opacity: appear \}\]\}/);
  assert.match(viewer, /toValue: chromeOn \? 1 : 0,\s+duration: duration\(motion\.fast\),/);
  assert.match(read("App.jsx"), /duration: ms\(motion\.exit\), easing, useNativeDriver: true/, "the edge swipe finishes on the exit token");
});

test("a Fold dialog starts at the desktop dialog's .985", () => {
  assert.equal(motion.dialogScale, 0.985);
  assert.match(read("components.jsx"), /outputRange: \[motion\.dialogScale, 1\]/);
});
