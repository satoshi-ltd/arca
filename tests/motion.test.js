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

test("the palette enters with its own keyframes and the selected segment slides", () => {
  assert.match(style, /dialog\.palette\[open\] \{\s*animation-name: palette-enter;\s*\}/);
  assert.match(style, /@keyframes palette-enter \{[^}]*opacity: 0;[^}]*transform: translateY\(calc\(var\(--motion-distance\) \* -1\)\) scale\(var\(--motion-dialog-scale\)\)/);
  assert.match(style, /\.segmented-thumb \{\s*position: absolute;/);
  assert.doesNotMatch(style, /@keyframes palette-enter \{[^}]*(width|height|top|left)/);
  assert.match(app, /staggerRows\("#palette \.pal-row"\)/);
});

test("small controls animate only opacity and transform with the motion tokens", () => {
  assert.match(style, /\.folder-card \{\s*transition: background-color var\(--motion-fast\) var\(--motion-ease\);\s*\}\s*\.folder-card:hover \{\s*background: var\(--hover\);\s*\}/);
  assert.doesNotMatch(style, /\.folder-card:hover \{[^}]*transform/);
  assert.match(style, /\.menu-items \{\s*animation: menu-enter var\(--motion-fast\)/);
  assert.match(style, /\.dropdown-menu \{[^}]*animation: menu-enter var\(--motion-fast\)/);
  assert.match(style, /\.copy-confirmed > \.icon \{\s*animation: tick-in var\(--motion-fast\)/);
  for (const name of ["menu-enter", "tick-in", "label-in"])
    assert.doesNotMatch(style.match(new RegExp(`@keyframes ${name} \\{[\\s\\S]*?\\n\\}`))[0], /(width|height|top|left|margin|padding)/);
  assert.match(app, /\}, 1500\);/);
  assert.match(app, /noteRows\(\);\s+noteMicro\(\);/);
});

test("mobile motion tokens match the desktop motion tokens", () => {
  assert.equal(token("fast"), `${motion.fast}ms`);
  assert.equal(token("enter"), `${motion.enter}ms`);
  assert.equal(token("exit"), `${motion.exit}ms`);
  assert.equal(token("distance"), `${motion.distance}px`);
  assert.equal(token("shared"), `${motion.shared}ms`);
  assert.equal(token("stagger"), `${motion.stagger}ms`);
  assert.equal(token("settle"), `${motion.settle}ms`);
  assert.equal(token("touch-push"), `${motion.push}px`);
  assert.equal(token("dialog-scale"), String(motion.dialogScale), "a Fold dialog starts at the desktop dialog's scale");
  assert.equal(token("touch-dialog-scale"), String(motion.dialogScale));
  assert.equal(token("exit-fast"), `${motion.exitFast}ms`);
  assert.equal(token("ease"), `cubic-bezier(${motion.ease.join(", ")})`);
  const reduced = tokens.slice(
    tokens.indexOf("@media (prefers-reduced-motion: reduce)"),
  );
  for (const name of ["fast", "enter", "exit", "shared", "stagger", "settle"])
    assert.match(reduced, new RegExp(`--motion-${name}:\\s*0ms;`));
  assert.match(reduced, /--motion-touch-push:\s*0px;/);
  assert.match(reduced, /--motion-dialog-scale:\s*1;/);
  assert.equal(token("touch-press-scale"), String(motion.pressScale));
  assert.match(reduced, /--motion-touch-press-scale:\s*1;/);
  assert.deepEqual(motionDurations(true), { fast: 0, enter: 0, exit: 0, exitFast: 0 });
  assert.deepEqual(motionDurations(false), {
    fast: motion.fast,
    enter: motion.enter,
    exit: motion.exit,
    exitFast: motion.exitFast,
  });
});

test("every phone and Fold animation takes its duration from the motion tokens and no Modal fades on its own", () => {
  const source = new URL("../apps/mobile/src/", import.meta.url);
  const files = fs.readdirSync(source).filter((name) => /\.(js|jsx)$/.test(name));
  const token = /^(duration\(|ms\(|motionMs\(|edgeState\.current\.ms\()?(motion\.(fast|enter|exit|exitFast|shared|settle)|ms|half|exit)\)?$|^reduce \? 0 : motion\.fast$|^duration\(visible \? motion\.enter : motion\.exit\)$|^duration\(leaving \? motion\.exit : motion\.enter\)$/;
  const loose = [];
  const unshaped = [];
  for (const name of files) {
    const text = read(new URL(name, source));
    assert.doesNotMatch(text, /animationType="(fade|slide)"/, `${name} leaves Modal timing to the platform`);
    if (name === "components.jsx") {
      const busy = text.slice(text.indexOf("export function Busy("), text.indexOf("export function Icon("));
      assert.match(busy, /AccessibilityInfo\.isReduceMotionEnabled\(\)\.then\(update\)/, "the busy dots, the one loop with its own rhythm, stop under reduced motion");
    }
    const scan = name === "components.jsx"
      ? text.slice(0, text.indexOf("export function Busy(")) + text.slice(text.indexOf("export function Icon("))
      : text;
    for (const match of scan.matchAll(/Animated\.timing\([\s\S]*?duration: ([^,\n}]+)/g))
      if (!token.test(match[1].trim())) loose.push(`${name}: ${match[1].trim()}`);
    for (const match of scan.matchAll(/Animated\.timing\(/g)) {
      let depth = 0;
      let end = match.index + match[0].length;
      for (; end < scan.length && (scan[end] !== ")" || depth); end++)
        depth += scan[end] === "(" ? 1 : scan[end] === ")" ? -1 : 0;
      const call = scan.slice(match.index, end);
      if (!/\beasing\b/.test(call)) unshaped.push(`${name}: ${call.replace(/\s+/g, " ")}`);
    }
  }
  assert.deepEqual(loose, []);
  assert.deepEqual(unshaped, [], "every timing follows the shared ease");
});

test("desktop motion never reanimates photo resolution upgrades and every exit goes through one helper", () => {
  assert.doesNotMatch(style, /view-enter|view-forward|view-back/);
  assert.doesNotMatch(app, /enterView|view-forward|view-back/);
  assert.doesNotMatch(style, /allow-discrete|@starting-style|photo-enter/);
  assert.match(style, /dialog\[open\] \{\s*animation: dialog-enter var\(--motion-enter\)/);
  assert.match(style, /dialog\.photo-viewer\[open\] \{\s*animation-name: overlay-enter;/);
  assert.match(style, /\.dropdown-menu\[hidden\] \{\s*display: none;/);
  assert.match(style, /\.notice-card\.notice-enter \{\s*animation: notice-enter var\(--motion-enter\)/);
  assert.match(app, /function leave\(element, role, done\) \{/);
  assert.doesNotMatch(app, /\$\("#dialog"\)\.close\(\);\n\s*(return|\})/, "dialogs close through closeDialog");
});
