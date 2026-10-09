import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DRAG_SCALE, decideRelease, dragLook, isVerticalIntent } from "../apps/mobile/src/viewer-gestures.js";

test("only a clearly vertical drag on an unzoomed photo starts the dismiss or info gesture", () => {
  assert.equal(isVerticalIntent(2, 40, 1), true);
  assert.equal(isVerticalIntent(30, 40, 1), false, "a diagonal drag stays with paging");
  assert.equal(isVerticalIntent(0, 8, 1), false, "a small movement is a tap");
  assert.equal(isVerticalIntent(0, 80, 2), false, "a zoomed photo pans instead");
});

test("releasing past a third of the height or fast closes, an upward swipe opens Info on the phone only", () => {
  const height = 900;
  assert.equal(decideRelease({ dy: 301, vy: 0, height }), "close");
  assert.equal(decideRelease({ dy: 299, vy: 0, height }), "back");
  assert.equal(decideRelease({ dy: 80, vy: 1.5, height }), "close", "a fast flick closes early");
  assert.equal(decideRelease({ dy: -120, height }), "info");
  assert.equal(decideRelease({ dy: -100, height }), "back", "an eighth of the height is the threshold");
  assert.equal(decideRelease({ dy: -50, height }), "back");
  assert.equal(decideRelease({ dy: -400, height, wide: true }), "back", "on the Fold swiping up does nothing");
  assert.equal(decideRelease({ dy: 400, height, wide: true }), "close", "dragging down still dismisses on the Fold");
});

test("the dragged photo shrinks and the backdrop fades with the finger, an upward drag only lifts a little", () => {
  const down = dragLook(450, 900);
  assert.equal(down.translateY, 450);
  assert.ok(Math.abs(down.scale - (1 - (1 - DRAG_SCALE) * 0.5)) < 1e-9);
  assert.equal(down.backdrop, 0, "half the height is fully faded");
  assert.deepEqual(dragLook(0, 900), { translateY: 0, scale: 1, backdrop: 1 });
  assert.equal(dragLook(-900, 900).translateY, -150, "an upward drag is clamped");
  assert.equal(dragLook(-900, 900).scale, 1);
  assert.equal(dragLook(5000, 900).translateY, 900);
});

test("the photo viewer opens without its bar, toggles bar and filmstrip on a single tap and wires the gestures", () => {
  const viewer = fs.readFileSync(new URL("../apps/mobile/src/PhotoViewer.jsx", import.meta.url), "utf8");
  assert.match(viewer, /useState\(false\);\s*\n\s*const \[chromeOn, setChromeOn\] = useState\(false\)/);
  assert.match(viewer, /setChromeOn\(false\);\s*\n\s*drag\.setValue\(0\)/, "every opening starts without the bar");
  assert.match(viewer, /onTap\?\.\(\)/);
  assert.match(viewer, /\} of \$\{items\.length\}/, "the position reads N of M");
  assert.match(viewer, /onIndexChange\(position\)/, "a filmstrip photo moves there");
  assert.match(viewer, /decideRelease\(\{ dy, vy, height: h, wide: fold \}\)/);
  assert.match(viewer, /action === "info"/);
  assert.match(viewer, /name: "dismiss"/, "TalkBack and VoiceOver reach each gesture");
  assert.match(viewer, /transparent/);
  assert.match(viewer, /onPanResponderTerminate: \(\) => \{[\s\S]*onDragEnd\?\.\(0, 0\)/, "a cancelled drag always eases the photo back");
  assert.match(viewer, /onDragEnd\?\.\(0, 0\);\s*\n\s*gesture\.current = begun = \{ \.\.\.begin\(touches/, "a second finger ends the drag instead of stranding it");
  assert.match(viewer, /directionalLockEnabled/);
  assert.match(viewer, /strip\.current\?\.scrollToOffset/, "the filmstrip follows the photo");
});
