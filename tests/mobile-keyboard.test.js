import test from "node:test";
import assert from "node:assert/strict";
import {
  keyboardOverlap,
  focusScrollDelta,
} from "../apps/mobile/src/keyboard.js";

test("keyboard avoidance handles edge-to-edge, safe areas, native resize and dismissal", () => {
  assert.equal(keyboardOverlap(24, 776, 500), 300);
  assert.equal(keyboardOverlap(24, 742, 500), 266);
  assert.equal(keyboardOverlap(24, 476, 500), 0);
  assert.equal(keyboardOverlap(24, 776, null), 0);
  assert.equal(keyboardOverlap(24, 776, 0), 776);
});

test("focused fields remain inside the scrolling viewport, including large text editors", () => {
  assert.equal(focusScrollDelta(100, 400, 180, 48), 0);
  assert.equal(focusScrollDelta(100, 200, 300, 48), 64);
  assert.equal(focusScrollDelta(100, 200, 80, 48), -36);
  assert.equal(focusScrollDelta(100, 200, 140, 500), 24);
});
