import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SCRUB_SETTLE_MS, scrubFraction, scrubGrant, scrubHeld, scrubMove, scrubPercent, scrubShown, scrubTarget } from "../apps/mobile/src/scrub.js";
import { controlsLeave } from "../apps/mobile/src/video-player-state.js";
import { ANDROID_TOUCH, touchSlop } from "../apps/mobile/src/touch-target.js";
import { geometry as g } from "../packages/core/design-tokens.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "apps", "mobile", "src");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");
const theme = read("theme.js");
const rule = (key) => theme.match(new RegExp(`\\n    ${key}: \\{([^}]*)\\}`))[1];
const reach = (slop, height, width = ANDROID_TOUCH) => ({
  height: height + (slop?.top || 0) + (slop?.bottom || 0),
  width: width + (slop?.left || 0) + (slop?.right || 0),
});

test("the scrub position follows the finger inside the track and clamps at both ends", () => {
  assert.equal(scrubFraction(50, 200), 0.25);
  assert.equal(scrubFraction(-30, 200), 0);
  assert.equal(scrubFraction(260, 200), 1);
  const drag = scrubGrant(50, 200);
  assert.deepEqual(drag, { origin: 50, width: 200, rtl: false, slid: false, at: 0.25 });
  assert.equal(scrubMove(drag, 50).at, 0.5, "a drag moves from where the finger landed");
  assert.equal(scrubMove(drag, -400).at, 0);
  assert.equal(scrubMove(drag, 400).at, 1);
  assert.equal(scrubMove(null, 40), null, "a move without a grant is ignored");
});

test("right to left, the position runs from the right edge like the mirrored fill and handle", () => {
  assert.equal(scrubFraction(50, 200, true), 0.75);
  const drag = scrubGrant(50, 200, true);
  assert.equal(drag.at, 0.75);
  assert.equal(scrubMove(drag, -50).at, 1, "moving the finger left moves the handle toward the end");
  assert.equal(scrubMove(drag, 100).at, 0.25);
});

test("a vertical swipe on the strip is abandoned and never seeks; a horizontal drag or a tap seeks", () => {
  const grant = scrubGrant(100, 400);
  const vertical = scrubMove(grant, 3, 40);
  assert.equal(vertical, null);
  assert.equal(scrubTarget(scrubMove(vertical, 60, 50), 600), null, "nothing seeks after the drag is abandoned");
  const horizontal = scrubMove(scrubMove(grant, 20, 4), 100, 4);
  assert.equal(scrubTarget(horizontal, 600), 300);
  assert.equal(scrubMove(scrubMove(grant, 30, 2), 40, 60).at, 0.35, "once the handle moved sideways, vertical wobble keeps the drag");
  assert.equal(scrubMove(grant, 2, 8).at, 0.255, "a wobble below the slop stays a drag");
  assert.equal(scrubTarget(grant, 600), 150, "a tap seeks where it landed");
});

test("after release the handle stays on the target until the player catches up or 1.5 s pass", () => {
  const held = { target: 90000, at: 1000 };
  assert.equal(scrubHeld(held, 30000, 1500, 1000), 90000, "the player still reports the old place");
  assert.equal(scrubHeld(held, 89500, 1500, 1000), null, "within a second of the target the player's own position shows");
  assert.equal(scrubHeld(held, 30000, 1000 + SCRUB_SETTLE_MS, 1000), null, "a seek that never lands stops holding");
  assert.equal(scrubHeld(null, 30000, 1500, 1000), null);
});

test("a track not yet measured never seeks, so a touch cannot jump to the start", () => {
  assert.equal(scrubGrant(80, 0), null);
  assert.equal(scrubTarget(scrubGrant(80, 0), 600), null);
});

test("the handle and elapsed time show the drag, and the target exists only with a duration", () => {
  const drag = scrubMove(scrubGrant(100, 400), 100);
  assert.equal(scrubShown(drag, 30, 600), 300);
  assert.equal(scrubShown(null, 30, 600), 30, "without a drag the player's position shows");
  assert.equal(scrubTarget(drag, 600), 300);
  assert.equal(scrubTarget(drag, 0), null, "an unknown duration never seeks");
  assert.equal(scrubTarget(null, 600), null);
  assert.equal(scrubPercent(150, 600), "25%");
  assert.equal(scrubPercent(900, 600), "100%");
  assert.equal(scrubPercent(5, 0), "0%");
});

test("the controls stay up while the film's handle is held", () => {
  assert.equal(controlsLeave({ playing: true, idle: 9000, screenReader: false, dragging: true }), false);
  assert.equal(controlsLeave({ playing: true, idle: 9000, screenReader: false, dragging: false }), true);
  const player = read("VideoPlayer.jsx");
  assert.match(player, /screenReader: reader\.current, dragging: scrubbing\.current \}\)\) setControls\(false\);/);
  assert.match(player, /onDragging=\{\(on\) => \(scrubbing\.current = on\)\}/);
});

test("the shared scrubber keeps its drag to itself, seeks only on release and drops an abandoned or cancelled drag", () => {
  const components = read("components.jsx");
  const scrub = components.slice(components.indexOf("export function Scrub("), components.indexOf("export function Breadcrumbs("));
  assert.equal((scrub.match(/\.seek\(/g) || []).length, 1, "one seek call");
  assert.match(scrub, /onPanResponderRelease: \(\) => \{\s+const target = scrubTarget\(dragRef\.current, live\.current\.duration\);[\s\S]*?show\(null\);\s+if \(target != null\) live\.current\.seek\(target\);/);
  assert.match(scrub, /onPanResponderMove: \(_, gesture\) => dragRef\.current && show\(scrubMove\(dragRef\.current, gesture\.dx, gesture\.dy\)\)/);
  assert.match(scrub, /onPanResponderTerminate: \(\) => show\(null\)/, "a drag taken away by the system does not seek");
  assert.match(scrub, /onPanResponderTerminationRequest: \(\) => !dragRef\.current/, "an abandoned drag lets go of the touch");
  assert.match(scrub, /scrubGrant\(event\.nativeEvent\.locationX, live\.current\.width, I18nManager\.isRTL\)/);
  assert.match(scrub, /held\.current = \{ target, at: Date\.now\(\) \};/);
  assert.match(scrub, /const landing = scrubHeld\(held\.current, position, Date\.now\(\), near\);/);
  assert.match(scrub, /const shown = scrubShown\(drag, landing \?\? position, duration\);/);
  assert.match(scrub, /\{times\(shown\)\}/, "the elapsed time renders inside the scrubber, so a drag re-renders only it");
  assert.match(scrub, /<View pointerEvents="none" style=\{\[knob, \{ left: percent \}\]\} \/>/);
  assert.match(scrub, /live\.current\.onDragging\?\.\(!!next\);/);
});

test("the film scrubber draws a 16 dp handle in a 48 dp strip, drags, and keeps its screen-reader steps", () => {
  assert.equal(g.scrubKnob, 16);
  const player = read("VideoPlayer.jsx");
  const scrubber = player.slice(player.indexOf("function Scrubber("), player.indexOf("function Round("));
  assert.match(rule("videoScrub"), /height: g\.touchControlHeight/);
  assert.ok(g.touchControlHeight >= ANDROID_TOUCH);
  assert.match(rule("videoScrubKnob"), /width: g\.scrubKnob, height: g\.scrubKnob, marginLeft: -g\.scrubKnob \/ 2, borderRadius: r\.pill, backgroundColor: c\.onMedia/);
  assert.match(rule("videoScrubTrack"), /backgroundColor: c\.mediaGlyph/, "the legible track stays");
  assert.match(scrubber, /strip=\{s\.videoScrub\}\s+track=\{s\.videoScrubTrack\}\s+fill=\{s\.videoScrubFill\}\s+knob=\{s\.videoScrubKnob\}/);
  assert.match(scrubber, /near=\{1\}/, "film positions are seconds");
  assert.doesNotMatch(scrubber, /onResponderRelease/);
  assert.match(scrubber, /accessibilityRole: "adjustable",\s+accessibilityLabel: "Position"/);
  assert.match(scrubber, /const target = scrubAction\(nativeEvent\.actionName, position, duration\);/);
  assert.match(player, /onActive=\{wake\}/, "dragging keeps the controls up");
  assert.match(scrubber, /<Text style=\{s\.videoTime\}>\{clock\(shown\)\}<\/Text>/);
  assert.match(scrubber, /\{`−\$\{clock\(Math\.max\(0, duration - shown\)\)\}`\}/);
});

test("the Now playing line draws an ink handle in a 48 dp strip, drags, and keeps its 15 second steps", () => {
  const page = read("NowPlayingPage.jsx");
  assert.match(rule("playerTrackArea"), /height: g\.touchControlHeight/);
  assert.match(rule("playerKnob"), /width: g\.scrubKnob, height: g\.scrubKnob, marginLeft: -g\.scrubKnob \/ 2, borderRadius: r\.pill, backgroundColor: c\.ink/);
  assert.match(page, /<Scrub\s+key=\{state\.id\}\s+position=\{position\}\s+duration=\{total\}\s+seek=\{seek\}\s+near=\{1000\}/, "Now playing positions are milliseconds");
  assert.match(page, /strip=\{s\.playerTrackArea\}\s+track=\{s\.playerTrack\}\s+fill=\{s\.playerFill\}\s+knob=\{s\.playerKnob\}/);
  assert.match(page, /accessibilityRole: "adjustable",\s+accessibilityLabel: "Position"/);
  assert.match(page, /seek\(position \+ \(event\.nativeEvent\.actionName === "increment" \? 15000 : -15000\)\)/);
  assert.match(page, /formatDuration\(shown \/ 1000\)/, "the elapsed time follows the drag");
  assert.doesNotMatch(page, /locationX|setDrag/);
});

test("the scrub starts over on a new track and never leaves the film controls held", () => {
  const components = read("components.jsx");
  assert.match(read("NowPlayingPage.jsx"), /<Scrub\s+key=\{state\.id\}/, "a held target or live drag never carries to the next track");
  assert.match(components, /clearTimeout\(timer\.current\);\s+if \(dragRef\.current\) live\.current\.onDragging\?\.\(false\);/, "unmounting mid-drag lets the controls hide again");
  assert.match(components, /setTimeout\(\(\) => \{\s+held\.current = null;\s+settle\(/, "the settle timer ends the hold whatever the clock reads");
});

test("breadcrumbs keep the scroll row they had: slop there would be clipped", () => {
  const components = read("components.jsx");
  assert.match(components, /<ScrollView\s+horizontal\s+showsHorizontalScrollIndicator=\{false\}\s+contentContainerStyle=\{s\.breadcrumb\}\s*>/);
  assert.doesNotMatch(components, /accessibilityLabel=\{`Open \$\{crumb\.label\}`\}\s+hitSlop/);
});

test("hit slop brings small targets to 48 dp on Android only", () => {
  assert.equal(touchSlop("ios", 32), undefined);
  assert.equal(touchSlop("android", 48), undefined);
  assert.deepEqual(touchSlop("android", 32), { top: 8, bottom: 8, left: 0, right: 0 });
  assert.deepEqual(touchSlop("android", 44, 44), { top: 2, bottom: 2, left: 2, right: 2 });
  assert.deepEqual(touchSlop("android", 22, ANDROID_TOUCH, { bottom: 1 }), { top: 13, bottom: 1, left: 0, right: 0 });
  assert.ok(reach(touchSlop("android", 31), 31).height >= ANDROID_TOUCH, "odd sizes round up");
});

test("the listed small targets reach 48 dp on Android", () => {
  const targets = [
    ["NowPlayingPage.jsx", /accessibilityLabel=\{`Sleep timer, \$\{label\}`\} hitSlop=\{touchSlop\(Platform\.OS, g\.buttonSmallHeight\)\}/, g.buttonSmallHeight, rule("sleepChip").includes("minHeight: g.buttonSmallHeight")],
    ["components.jsx", /hitSlop=\{touchSlop\(Platform\.OS, g\.touchHeight, g\.touchHeight\)\}\s+onPress=\{\(\) => onChange\(!value\)\}/, g.touchHeight, rule("switchTarget").includes("minHeight: g.touchHeight")],
    ["components.jsx", /"Tap again to clear" : undefined\}\s+hitSlop=\{touchSlop\(Platform\.OS, g\.touchHeight\)\}/, g.touchHeight, rule("segment").includes("minHeight: g.touchHeight")],
    ["PairingForm.jsx", /accessibilityLabel="Using local Wi-Fi\?"[\s\S]{0,80}hitSlop=\{touchSlop\(Platform\.OS, g\.touchCaptionLine\)\}/, g.touchCaptionLine, true],
  ];
  for (const [file, pattern, height, sized] of targets) {
    assert.match(read(file), pattern, `${file} sets the slop`);
    assert.ok(sized, `${file}: the slop is computed from the style's own height`);
    assert.ok(reach(touchSlop("android", height), height).height >= ANDROID_TOUCH);
  }
  const viewer = read("PhotoViewer.jsx");
  assert.match(viewer, /const barSlop = touchSlop\(Platform\.OS, g\.touchHeight, g\.touchHeight\);/);
  assert.equal((viewer.match(/hitSlop=\{barSlop\}\s+style=\{\[?s\.viewerIconButton/g) || []).length, 4, "every viewer bar button");
  assert.match(rule("viewerIconButton"), /width: g\.touchHeight,\s+height: g\.touchHeight/);
  const bar = reach(touchSlop("android", g.touchHeight, g.touchHeight), g.touchHeight, g.touchHeight);
  assert.ok(bar.height >= ANDROID_TOUCH && bar.width >= ANDROID_TOUCH);
});

test("the Now playing artist and album links grow without stealing each other's taps", () => {
  const page = read("NowPlayingPage.jsx");
  assert.match(page, /const linkSlop = \(edge\) => touchSlop\(Platform\.OS, g\.touchBodyLine, ANDROID_TOUCH, bothLinks \? \{ \[edge\]: 1 \} : \{\}\);/);
  assert.match(page, /onPress=\{\(\) => artist && openArtist\(artist\)\} hitSlop=\{linkSlop\("bottom"\)\}/);
  assert.match(page, /onPress=\{\(\) => track && openAlbum\(track\)\} hitSlop=\{linkSlop\("top"\)\}/);
  assert.match(page, /accessibilityLabel=\{`Show \$\{track\.artist\}`\} hitSlop=\{linkSlop\(\)\}/);
  assert.match(rule("nowLinks"), /gap: 2/, "the stacked links are 2 dp apart, so each keeps one of them");
  assert.ok(reach(touchSlop("android", g.touchBodyLine), g.touchBodyLine).height >= ANDROID_TOUCH, "a lone link reaches 48");
});
