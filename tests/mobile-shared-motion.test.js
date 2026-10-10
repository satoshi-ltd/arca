import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { originTransform } from "../apps/mobile/src/viewer-origin.js";
import { flightTransform, putFlight, takeFlight } from "../apps/mobile/src/flight.js";

const read = (file) => fs.readFileSync(new URL(file, import.meta.url), "utf8");

test("a photo opens from the centre of the cell it was tapped in", () => {
  assert.deepEqual(originTransform({ x: 0, y: 100, width: 90, height: 90 }, 360, 800), {
    dx: -135,
    dy: -255,
    scale: 0.25,
  });
});

test("a cell off screen or unmeasured opens with the plain fade", () => {
  assert.equal(originTransform(null, 360, 800), null);
  assert.equal(originTransform({ x: 0, y: 5000, width: 90, height: 90 }, 360, 800), null);
  assert.equal(originTransform({ x: -200, y: 10, width: 90, height: 90 }, 360, 800), null);
  assert.equal(originTransform({ x: 0, y: 0, width: 0, height: 0 }, 360, 800), null);
});

test("a flight moves from the origin centre to the target centre at the origin's size", () => {
  assert.deepEqual(
    flightTransform({ x: 10, y: 10, width: 48, height: 48 }, { x: 100, y: 20, width: 40, height: 40 }),
    { dx: -86, dy: -6, scale: 1.2 },
  );
  assert.equal(flightTransform(null, { x: 0, y: 0, width: 1, height: 1 }), null);
});

test("an origin is taken once and expires", () => {
  putFlight("folder", { x: 1, y: 1, width: 2, height: 2 });
  assert.deepEqual(takeFlight("folder"), { x: 1, y: 1, width: 2, height: 2 });
  assert.equal(takeFlight("folder"), null);
  const now = Date.now;
  putFlight("folder", { x: 1, y: 1, width: 2, height: 2 });
  Date.now = () => now() + 5000;
  try {
    assert.equal(takeFlight("folder"), null);
  } finally {
    Date.now = now;
  }
});

test("the shared moments are wired into the screens", () => {
  const viewer = read("../apps/mobile/src/PhotoViewer.jsx");
  assert.match(viewer, /originTransform\(origin\?\.rect, width, height\)/);
  assert.match(viewer, /items\[index\]\?\.path !== origin\.path/);
  assert.match(viewer, /onPress=\{closeToOrigin\}/);
  assert.match(viewer, /const closeToOrigin = \(\) => \{\s+if \(closingRef\.current\) return;\s+closingRef\.current = true;\s+setClosing\(true\);/, "a second Close while the viewer leaves closes it once");
  assert.match(viewer, /style=\{\[s\.viewerRoot, s\.viewerTransparent, \{ opacity: appear \}\]\}\s+pointerEvents=\{closing \? "none" : "auto"\}/, "the fading viewer takes no touches");
  assert.match(viewer, /if \(visible\) \{\s+closingRef\.current = false;\s+setClosing\(false\);/, "the next photo opens interactive");
  const gallery = read("../apps/mobile/src/FolderGallery.jsx");
  assert.match(gallery, /measureInWindow\(\(x, y, width, height\) =>\s+onPress\(item, \{ x, y, width, height \}\)/);
  assert.match(gallery, /origin=\{viewer\?\.origin\}/);
  const components = read("../apps/mobile/src/components.jsx");
  assert.match(components, /putFlight\("folder"/);
  assert.match(components, /useFlight\(detail && wide && contentIcon \? "folder" : null\)/);
  assert.match(components, /<Animated\.View\s+pointerEvents="none"\s+style=\{\[\s+s\.navIndicator/);
  assert.match(components, /<ProgressRing fraction=\{Math\.min\(1, progress\)\} \/>/);
  assert.match(components, /<PressScale\s+scale=\{!disabled && !busy && !ghost\}/);
  assert.match(components, /s\.segmentSelected,\s+s\.segmentThumb/);
  const app = read("../apps/mobile/src/App.jsx");
  assert.match(app, /<RefreshControl\s+refreshing=\{pulling\}/);
});

test("an edge swipe moves the folder screen with the finger and runs the same Back, and the arch follows a pull on iOS", () => {
  const app = read("../apps/mobile/src/App.jsx");
  assert.match(app, /onMoveShouldSetPanResponder: \(_, g\) =>\s+edgeState\.current\.ready && g\.dx > 8/);
  assert.match(app, /g\.dx > span \/ 3 \|\| g\.vx > 0\.6/);
  assert.match(app, /backRef\.current = handler;/);
    assert.match(app, /Platform\.OS === "ios"\) pull\.setValue\(Math\.max\(0, Math\.min\(1, -contentOffset\.y \/ 56\)\)\)/);
  assert.match(app, /opacity: pulling \? 1 : pull/);
});

test("the edge strip only claims a horizontal drag, the gallery viewport is measured on the wrapper and a swipe that was interrupted never goes back", () => {
  const app = read("../apps/mobile/src/App.jsx");
  assert.match(app, /onStartShouldSetPanResponder: \(\) => false/);
  assert.match(app, /<Animated\.View\s+style=\{\[s\.flex, \{ transform: \[\{ translateX: edge \}\] \}\]\}\s+onLayout=/);
  assert.match(app, /\(\{ finished \}\) => \{\s+if \(!finished\) return;\s+backRef\.current\?\.\(\);/);
  assert.match(app, /!sheet && !fileActionsOpen/);
  assert.match(app, /pull\.setValue\(0\);\s+\}, \[screen, folder\]\);/);
});

test("a tile inside a progress ring turns round so a square never sits in a circle", () => {
  const css = read("../apps/desktop/src/style.css");
  assert.match(css, /\.home-lead:has\(\.home-ring\) > \.tile \{\s*border-radius: var\(--r-pill\);/);
  const components = read("../apps/mobile/src/components.jsx");
  assert.match(components, /syncing && progress > 0 && s\.tileRound/);
});
