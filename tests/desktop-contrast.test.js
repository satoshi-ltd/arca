import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const css = fs.readFileSync(new URL("../apps/desktop/src/tokens.css", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const split = css.indexOf('\n[data-theme="dark"] {');
const parse = (block) => Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})\b/gi)].map((match) => [match[1], match[2]]));
const light = parse(css.slice(0, split));
const themes = { light, dark: { ...light, ...parse(css.slice(split, css.indexOf("@keyframes"))) } };
const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
};
const text = [
  ...["ink", "soft", "mute"].flatMap((fg) => ["paper", "surface", "side", "hover", "press", "notice-surface"].map((bg) => [fg, bg])),
  ["mute", "segmentTrack"], ["soft", "idBg"], ["idFg", "idBg"],
  ...["surface", "paper", "side", "hover", "notice-surface", "tint"].map((bg) => ["green", bg]),
  ["deep", "tint"], ["okFg", "okBg"], ["okFg", "surface"], ["waFg", "waBg"], ["waFg", "surface"], ["waFg", "hover"],
  ["erFg", "erBg"], ["erFg", "surface"], ["erFg", "hover"], ["erFg", "notice-surface"], ["onGreen", "fill"], ["onGreen", "er"],
  ["toast-fg", "toast-bg"], ["surface", "ink"], ["notice-link", "notice-surface"],
];
const graphics = [
  ["control", "surface"], ["control", "paper"], ["control", "side"], ["id", "surface"], ["id", "side"],
  ["wa", "surface"], ["wa", "notice-surface"], ["er", "surface"], ["er", "notice-surface"], ["ok", "surface"], ["green", "tint"],
  ["fill", "surface"], ["fill", "paper"], ["fill", "side"], ["fill", "notice-surface"],
];

test("every desktop text and state colour meets WCAG AA on each surface it sits on, in light and dark", () => {
  for (const [name, tokens] of Object.entries(themes))
    for (const [pairs, minimum] of [[text, 4.5], [graphics, 3]])
      for (const [fg, bg] of pairs) {
        assert.ok(tokens[fg] && tokens[bg], `${name}: --${fg} and --${bg} are solid colours`);
        const value = ratio(tokens[fg], tokens[bg]);
        assert.ok(value >= minimum, `${name}: --${fg} on --${bg} is ${value.toFixed(2)}, below ${minimum}`);
      }
});

test("the phone's filled controls carry a white label on the brand fill, never on the text accent, in light and dark", async () => {
  const { palettes } = await import("../apps/mobile/src/palette.js");
  for (const [name, c] of Object.entries(palettes)) {
    for (const [fg, bg, minimum] of [
      ["onAccent", "fill", 4.5], ["onAccent", "dangerFill", 4.5], ["accent", "surface", 4.5], ["accent", "paper", 4.5], ["accent", "tint", 4.5],
      ["danger", "surface", 4.5], ["fill", "surface", 3], ["fill", "paper", 3],
    ]) {
      const value = ratio(c[fg], c[bg]);
      assert.ok(value >= minimum, `${name}: ${fg} on ${bg} is ${value.toFixed(2)}, below ${minimum}`);
    }
    assert.equal(c.fill, palettes.light.fill, "one brand green in both themes");
  }
  const theme = fs.readFileSync(new URL("../apps/mobile/src/theme.js", import.meta.url), "utf8");
  assert.match(theme, /primary: \{ backgroundColor: c\.fill, borderColor: c\.fill \},/);
  assert.match(theme, /hubTile: \{ backgroundColor: c\.fill \},\s+hubTag: \{ backgroundColor: c\.fill, borderColor: c\.fill \},/);
  assert.match(theme, /dangerButton: \{ backgroundColor: c\.dangerFill, borderColor: c\.dangerFill \},/);
  assert.match(theme, /playButton: \{[^}]*backgroundColor: c\.fill,/);
  assert.match(theme, /selectionCheck: \{[^}]*backgroundColor: c\.fill,/);
});

test("a card draws one ring in dark, never a second line inside it", () => {
  const dark = /--shadow-card:\s*([^;]+);/.exec(css.slice(split))[1];
  assert.equal(dark, "0 0 0 1px var(--div)");
  const style = fs.readFileSync(new URL("../apps/desktop/src/style.css", import.meta.url), "utf8");
  assert.doesNotMatch(style, /box-shadow:[^;]*var\(--shadow-card\)[^;]*inset/, "no card adds an inner line of its own");
});
