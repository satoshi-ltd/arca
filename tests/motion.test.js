import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { motion, motionDurations } from "../apps/mobile/src/design-tokens.js";

const read = (file) => fs.readFileSync(new URL(file, import.meta.url), "utf8");
const tokens = read("../apps/desktop/src/tokens.css");
const style = read("../apps/desktop/src/style.css");
const app = read("../apps/desktop/src/app.js");
const token = (name) =>
  tokens.match(new RegExp(`--motion-${name}:\\s*([^;]+);`))[1].trim();

test("mobile motion tokens match the desktop motion tokens", () => {
  assert.equal(token("fast"), `${motion.fast}ms`);
  assert.equal(token("enter"), `${motion.enter}ms`);
  assert.equal(token("exit"), `${motion.exit}ms`);
  assert.equal(token("touch-push"), `${motion.push}px`);
  assert.equal(token("touch-dialog-scale"), String(motion.dialogScale));
  assert.equal(token("ease"), `cubic-bezier(${motion.ease.join(", ")})`);
  const reduced = tokens.slice(
    tokens.indexOf("@media (prefers-reduced-motion: reduce)"),
  );
  for (const name of ["fast", "enter", "exit"])
    assert.match(reduced, new RegExp(`--motion-${name}:\\s*0ms;`));
  assert.match(reduced, /--motion-touch-push:\s*0px;/);
  assert.match(reduced, /--motion-touch-dialog-scale:\s*1;/);
  assert.deepEqual(motionDurations(true), { fast: 0, enter: 0, exit: 0 });
  assert.deepEqual(motionDurations(false), {
    fast: motion.fast,
    enter: motion.enter,
    exit: motion.exit,
  });
});

test("desktop motion never delays hiding or reanimates photo resolution upgrades", () => {
  assert.doesNotMatch(style, /view-enter|view-forward|view-back/);
  assert.doesNotMatch(app, /enterView|view-forward|view-back/);
  assert.doesNotMatch(style, /allow-discrete|@starting-style|photo-enter/);
  assert.match(style, /dialog\[open\] \{\s*animation: dialog-enter var\(--motion-enter\)/);
  assert.match(style, /dialog\.photo-viewer\[open\] \{\s*animation-name: overlay-enter;/);
  assert.match(style, /\.dropdown-menu\[hidden\] \{\s*display: none;/);
  assert.match(style, /\.notice-card\.notice-enter \{\s*animation: notice-enter var\(--motion-enter\)/);
});
