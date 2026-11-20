import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { geometry } from "../packages/core/design-tokens.js";

const read = (file) => fs.readFileSync(new URL(file, import.meta.url), "utf8");
const components = read("../apps/mobile/src/components.jsx");
const motion = read("../apps/mobile/src/motion.js");
const gallery = read("../apps/mobile/src/FolderGallery.jsx");
const app = read("../apps/mobile/src/App.jsx");
const theme = read("../apps/mobile/src/theme.js");

test("the switch knob slides and its track tints through opacity, not a colour animation", () => {
  assert.match(components, /<Animated\.View style=\{\[s\.switchFill, \{ opacity: slide \}\]\} \/>/);
  assert.match(components, /translateX: slide\.interpolate\(\{ inputRange: \[0, 1\], outputRange: \[0, I18nManager\.isRTL \? -g\.switchTravel : g\.switchTravel\] \}\)/);
  assert.match(theme, /switchFill: \{\s+position: "absolute"/);
  assert.doesNotMatch(theme, /switchThumbOn/);
});

test("status pills cross-fade, counts roll, a selected tile settles and its tick grows in", () => {
  assert.match(components, /<ChangeFade token=\{children\}>/);
  assert.match(components, /<RollText style=\{s\.caption\} token=\{`\$\{state\.word \|\| ""\}\|\$\{description \|\| ""\}`\}>/);
  assert.match(gallery, /<Pop style=\{s\.photoBadge\}>/);
  assert.match(gallery, /toValue: selected \? 0\.94 : 1/);
});

test("Sync now turns its icon into a tick for a moment after a cycle that finished cleanly", () => {
  assert.match(app, /wasBusy\.current && !status\.busy && !status\.offline && !status\.error/);
  assert.match(app, /setTimeout\(\(\) => setSyncDone\(false\), 1200\)/);
  assert.match(app, /icon=\{syncDone \? "check" : "refresh"\}/);
  assert.match(components, /<Pop key=\{icon\}>/);
});

test("every new move uses only transform and opacity with the native driver", () => {
  for (const name of ["Pop", "RollText", "ChangeFade"]) {
    const body = motion.slice(motion.indexOf(`export function ${name}`));
    const end = body.indexOf("\nexport function", 10);
    const part = end < 0 ? body : body.slice(0, end);
    assert.match(part, /useNativeDriver: true/, name);
    assert.doesNotMatch(part, /width|height|margin|padding|backgroundColor/, name);
  }
});

test("the switch knob sits centred in its track, off and on", () => {
  const { switchWidth: width, switchHeight: height, switchKnob: thumb, switchInset: inset, switchTravel: travel } = geometry;
  assert.equal(inset * 2 + thumb, height, "the knob fills the track's height between equal insets");
  assert.equal(width - (inset + travel + thumb), inset, "switched on, the knob keeps the same inset on the right as on the left");
  assert.match(theme, /switchTrack: \{\s+width: g\.switchWidth,\s+height: g\.switchHeight,\s+borderRadius: g\.cardRadius,\s+padding: g\.switchInset,/);
  assert.match(theme, /switchThumb: \{\s+width: g\.switchKnob,\s+height: g\.switchKnob,/);
  assert.match(fs.readFileSync(new URL("../design/mobile.css", import.meta.url), "utf8"), /\.m-switch \{\s+width: var\(--m-switch-width\);\s+height: var\(--m-switch-height\);\s+display: flex;\s+padding: var\(--m-switch-inset\);/);
});
