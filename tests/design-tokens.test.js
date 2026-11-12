import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { radius, space, type } from "../packages/core/design-tokens.js";
import { desktopTokens, mobileTokens, stale } from "../design/build.js";

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("desktop and phone tokens come from one generated source", () => {
  assert.equal(read("apps/desktop/src/tokens.css"), desktopTokens());
  assert.equal(read("design/mobile-tokens.css"), mobileTokens());
  assert.deepEqual(stale(), []);
  assert.match(read("apps/mobile/src/palette.js"), /^export \{ brandMark, palettes \} from "\.\.\/\.\.\/\.\.\/packages\/core\/design-tokens\.js";\s*$/);
  assert.match(read("apps/mobile/src/design-tokens.js"), /^export \{[^}]*\} from "\.\.\/\.\.\/\.\.\/packages\/core\/design-tokens\.js";\s*$/);
});

test("one spacing, radius and type scale shared by both platforms", () => {
  assert.deepEqual(Object.values(space), [4, 8, 12, 16, 20, 24, 32]);
  assert.deepEqual({ ...radius }, { small: 6, control: 8, surface: 12, pill: 999 });
  assert.deepEqual(
    Object.fromEntries(Object.entries(type).map(([role, sizes]) => [role, [sizes.desktop, sizes.touch]])),
    { caption: [11, 13], body: [12, 15], control: [13, 15], row: [14, 16], heading: [16, 18], title: [20, 26], display: [28, 28] },
  );
  const css = read("apps/desktop/src/tokens.css");
  assert.match(css, /--text-display: 28px;\s*--text-display-line: 34px;/);
  for (const selector of [".code-display", ".request-number"])
    assert.match(read("apps/desktop/src/style.css"), new RegExp(`\\n\\${selector} \\{[^}]*font: var\\(--text-display\\) \\/ var\\(--text-display-line\\) var\\(--font-mono\\);`), selector);
  for (const selector of [".access-card .request-number"])
    assert.match(read("apps/desktop/src/style.css"), new RegExp(`\\n\\${selector.replaceAll(" ", " \\")} \\{\\s*font-size: var\\(--text-display\\);`), selector);
  const theme = read("apps/mobile/src/theme.js");
  for (const rule of ["codeDigit"]) assert.match(theme, new RegExp(`${rule}: \\{\\s*fontFamily: "FragmentMono_400Regular",\\s*fontSize: g\\.touchDisplayFont,`), rule);
  assert.match(theme, /codeSeparator: \{ fontSize: g\.touchDisplayFont,/);
  for (const [step, value] of Object.entries(space)) assert.match(css, new RegExp(`--space-${step}: ${value}px;`));
  for (const name of ["r-tag", "r-segment", "r-card", "r-window", "r-dialog", "notice-radius", "notice-title", "notice-body", "dialog-title", "onboarding-title", "onboarding-welcome-title", "access-reference-font", "approval-reference-font"])
    assert.doesNotMatch(css, new RegExp(`--${name}:`), name);
});

const hairline = (value) => Math.abs(value) <= 2;

test("style.css takes padding, margin, gap, radius and font size only from tokens", () => {
  const css = read("apps/desktop/src/style.css");
  const literal = [];
  for (const [, prop, value] of css.matchAll(/(?<![\w-])(padding(?:-[a-z-]+)?|margin(?:-[a-z-]+)?|gap|row-gap|column-gap|border(?:-[a-z]+)*-radius|font-size|font)\s*:\s*([^;{}]+)[;}]/g))
    for (const [, number] of value.matchAll(/(?<![\w.#-])(-?\d*\.?\d+)px/g))
      if (!hairline(Number(number)) && !(prop === "font" && /\/\d+px/.test(value) && value.indexOf(`${number}px`) > value.indexOf("/"))) literal.push(`${prop}: ${value.trim()}`);
  assert.deepEqual(literal, []);
});

test("theme.js takes padding, margin, gap, radius and font size only from tokens", () => {
  const theme = read("apps/mobile/src/theme.js");
  const literal = [];
  for (const [, prop, value] of theme.matchAll(/\b(padding\w*|margin\w*|gap|rowGap|columnGap|border\w*Radius|fontSize|lineHeight)\s*:\s*([^,\n{}]+?)\s*(?=[,}\n])/g))
    for (const [number] of value.matchAll(/(?<![\w.[])-?\d+(?:\.\d+)?(?![\w.\]])/g))
      if (!hairline(Number(number)) && !/[*/] *\d|\d *[*/]/.test(value)) literal.push(`${prop}: ${value}`);
  assert.deepEqual(literal, []);
});

test("a notice's close button takes exactly one text line, so the card's inner space is equal above and below", () => {
  const css = read("apps/desktop/src/style.css");
  const close = css.match(/\n\.notice-close \{\s*flex: none;([^}]*)\}/)[1];
  const half = "calc((var(--notice-line) - var(--notice-close)) / 2)";
  assert.equal(close.match(/margin: ([^;]+);/)[1], `${half} calc(var(--space-2) * -1) ${half} 0`, "the same pull above and below, none on the text side");
  assert.match(css, /\n\.notice-content strong \{[^}]*font-size: var\(--text-control\);[^}]*line-height: var\(--notice-line\);/, "a notice title reads at the control size");
  assert.match(css, /\n\.notice-content p \{[^}]*font-size: var\(--text-body\);[^}]*line-height: var\(--notice-line\);/, "and its reason at the body size on the same line height");
  const theme = read("apps/mobile/src/theme.js");
  assert.match(theme, /noticeClose: \{\s+width: g\.touchHeight,\s+height: g\.touchHeight,\s+marginHorizontal: -sp\[3\],\s+marginVertical: \(g\.touchControlLine - g\.touchHeight\) \/ 2,/);
  assert.match(theme, /noticeTitle: \{\s+fontFamily: "InstrumentSans_600SemiBold",\s+fontSize: g\.touchControlFont,\s+lineHeight: g\.touchControlLine,/);
});

test("a dialog's title line centres on its tile with or without a description, on desktop and phone alike", () => {
  const css = read("apps/desktop/src/style.css");
  assert.match(css, /\n\.modal-title \{\s*display: flex;\s*gap: var\(--space-3\);\s*align-items: flex-start;/);
  assert.match(css, /\n\.modal-title > :not\(\.tile\) \{\s*padding-top: calc\(\(var\(--dialog-tile\) - var\(--text-heading-line\)\) \/ 2\);/);
  assert.match(css, /\n\.modal-title h2 \{\s*font-size: var\(--text-heading\);\s*line-height: var\(--text-heading-line\);/);
  const theme = read("apps/mobile/src/theme.js");
  assert.match(theme, /confirmHeader: \{ flexDirection: "row", alignItems: "flex-start", gap: sp\[3\] \},\s*confirmCopy: \{ paddingTop: \(g\.touchTile - g\.touchRowLine\) \/ 2 \},/);
  assert.match(theme, /\n    tile: \{\s*width: g\.touchTile,\s*height: g\.touchTile,/);
  assert.match(theme, /\n    heading: \{\s*fontFamily: "InstrumentSans_600SemiBold",\s*fontSize: g\.touchRowFont,\s*lineHeight: g\.touchRowLine,/);
  assert.match(read("apps/mobile/src/components.jsx"), /<View style=\{s\.confirmHeader\}>\s*<View style=\{s\.tile\}>[\s\S]{0,80}<View style=\{\[s\.flex, s\.stack, s\.confirmCopy\]\}>/);
});

test("the gallery scrubber's year chip centres on its mark at the caption line plus its border", () => {
  assert.match(read("apps/mobile/src/theme.js"), /scrubYear: \{[^}]*transform: \[\{ translateY: -\(g\.touchCaptionLine \+ 2\) \/ 2 \}\],[^}]*borderWidth: 1,[^}]*lineHeight: g\.touchCaptionLine,/);
});

test("a segmented control is exactly one control height: its padding, the button padding and the control line add up to 32", async () => {
  const css = read("apps/desktop/src/style.css");
  const tokens = read("apps/desktop/src/tokens.css");
  const px = (name) => Number(tokens.match(new RegExp(`--${name}: (\\d+)px;`))[1]);
  const track = css.match(/\n\.segmented \{\s*display: flex;([^}]*)\}/)[1];
  const button = css.match(/\n\.segmented button \{([^}]*)\}/)[1];
  assert.match(track, /padding: var\(--space-1\);/);
  assert.match(button, /padding: var\(--space-1\) var\(--space-3\);/);
  assert.match(button, /line-height: var\(--text-control-line\);/);
  assert.equal(2 * px("space-1") + 2 * px("space-1") + px("text-control-line"), px("control-height"));
});
