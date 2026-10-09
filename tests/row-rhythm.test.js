import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { geometry } from "../apps/mobile/src/design-tokens.js";

const read = (file) => fs.readFileSync(new URL(file, import.meta.url), "utf8");
const tokens = read("../apps/desktop/src/tokens.css");
const style = read("../apps/desktop/src/style.css");
const theme = read("../apps/mobile/src/theme.js");
const app = read("../apps/desktop/src/app.js");

test("rows share one gap, one padding and one section rhythm", () => {
  for (const [name, value] of [["row-gap", "12px"], ["row-padding-y", "12px"], ["row-padding-x", "16px"], ["section-gap", "24px"], ["section-label-gap", "8px"]])
    assert.match(tokens, new RegExp(`--${name}: ${value};`));
  assert.deepEqual(
    [geometry.rowGap, geometry.rowPaddingY, geometry.rowPaddingX, geometry.rowMinHeight, geometry.sectionGap, geometry.sectionLabelGap],
    [12, 12, 16, 74, 24, 8],
  );
});

test("no desktop row class sets its own padding or spacing outside the tokens", () => {
  for (const selector of [".folder-card", ".device-row", ".history-row", ".setting-row", ".browser-file-row", ".music-row"]) {
    const rule = new RegExp(`\\n${selector.replace(".", "\\.")} \\{([^}]*)\\}`, "g");
    for (const match of style.matchAll(rule)) {
      const padding = match[1].match(/padding:\s*([^;]+);/);
      if (padding) assert.match(padding[1], /var\(--row-padding-y\) var\(--row-padding-x\)|^0 /, `${selector} padding`);
      assert.doesNotMatch(match[1], /margin-bottom:\s*\d+px/, `${selector} spacing`);
    }
  }
  assert.match(style, /\.device-row \+ \.device-row \{\s*margin-top: var\(--row-gap\);/);
});

test("no phone row style declares its own vertical padding", () => {
  assert.doesNotMatch(theme.match(/\n    musicTrack: \{([^}]*)\}/)[1], /paddingVertical: \d/);
  for (const key of ["folderRow", "machineRow", "settingRow", "actionRow"]) {
    const rule = theme.match(new RegExp(`\\n    ${key}: \\{([^}]*)\\}`))[1];
    assert.match(rule, /paddingVertical: g\.rowPaddingY/, key);
    assert.doesNotMatch(rule, /paddingVertical: \d/, key);
  }
  for (const key of ["machineRow", "settingRow", "actionRow"])
    assert.match(theme.match(new RegExp(`\\n    ${key}: \\{([^}]*)\\}`))[1], /minHeight: g\.rowMinHeight/, key);
});

const twoLine = [
  ".folder-card", ".device-row", ".history-row", ".browser-file-row", ".music-row", ".home-arrival",
  ".backup-card", ".scaffold-row", ".restore-version", ".setting-row:has(p)", ".music-episodes .music-track:not(.music-track-head)",
  ".resume-card", ".selection-summary",
];
const oneLine = [".setting-row", ".pal-row", ".copy-row", ".music-track:not(.music-track-head)", ".music-track-head"];

const rule = (selector) => {
  const escaped = selector.replace(/[.:()+*-]/g, "\\$&");
  return [...style.matchAll(new RegExp(`\\n${escaped} \\{([^}]*)\\}`, "g"))].map((m) => m[1]);
};

test("list items take one of two heights from two tokens", () => {
  assert.match(tokens, /--row-height: 66px;/);
  assert.match(tokens, /--row-height-compact: 48px;/);
  assert.doesNotMatch(tokens + style, /--card-row-height/);
  for (const [selectors, token] of [[twoLine, "row-height"], [oneLine, "row-height-compact"]])
    for (const selector of selectors)
      assert.ok(rule(selector).some((body) => new RegExp(`min-height: var\\(--${token}\\);`).test(body)), selector);
  assert.match(style, /\.device-row \.row-end \{[^}]*flex-direction: row;/);
  assert.match(style, /\.row-tags \{[^}]*min-height: var\(--tag-height\);/);
});

test("no list item class sets a literal min-height or height", () => {
  for (const selector of [...twoLine, ...oneLine])
    for (const body of rule(selector)) {
      assert.doesNotMatch(body, /(?:^|[\s;])(?:min-)?height:\s*\d/, selector);
      for (const match of body.matchAll(/min-height:\s*([^;]+);/g))
        assert.match(match[1], /^var\(--row-height(-compact)?\)$/, selector);
    }
});

test("a folder ring is drawn outside the 40 px lead so cards keep the row height", () => {
  assert.match(style, /\.home-lead \{[^}]*width: var\(--detail-tile\);[^}]*height: var\(--detail-tile\);/);
  assert.match(style, /\.home-ring \{[^}]*overflow: visible;[^}]*\}/);
  assert.match(style, /\.home-ring \{[^}]*top: calc\(var\(--space-1\) \* -1\);/);
  assert.match(style, /\.row-preview \{[^}]*width: var\(--detail-tile\);/);
});

test("phone rows use a two-line and a compact minimum height", () => {
  assert.equal(geometry.rowMinHeight, geometry.touchControlHeight + 2 * geometry.rowPaddingY + 2);
  assert.equal(geometry.rowMinHeightCompact, 48);
  for (const key of ["folderRow", "machineRow", "scaffoldRow"])
    assert.match(theme.match(new RegExp(`\\n    ${key}: \\{([^}]*)\\}`))[1], /minHeight: g\.rowMinHeight,/, key);
  for (const key of ["settingRow", "actionRow", "searchRow", "musicTrack"])
    assert.match(theme.match(new RegExp(`\\n    ${key}: \\{([^}]*)\\}`))[1], /minHeight: g\.rowMinHeightCompact/, key);
});

test("a toggle never carries the generic label margin, so rows with a switch match their neighbours", () => {
  assert.match(style, /\nlabel\.toggle \{\s*margin: 0;\s*\}/);
  assert.match(style, /\.setting-row > :not\(\.row-main\):last-child \{\s*align-self: center;/);
});

const body = (selector) => rule(selector).join("\n");

test("every list row pads 12/16 and leads with a 40 px tile or a 16 px icon, then 12", () => {
  assert.match(tokens, /--row-icon: 16px;/);
  for (const selector of [".home-arrival", ".copy-row", ".backup-card", ".resume-card", ".restore-version", ".selection-summary"]) {
    assert.match(body(selector), /padding: var\(--row-padding-y\) var\(--row-padding-x\);/, selector);
    assert.match(body(selector), /gap: var\(--row-gap\);/, selector);
  }
  assert.doesNotMatch(style, /--list-media-width, 20px/);
  assert.match(body(".history-row"), /gap: var\(--space-2\) var\(--row-gap\);/);
  assert.match(body(".restore-version > .icon"), /width: var\(--row-icon\);/);
  assert.match(body(".resume-card > .music-cover"), /width: var\(--detail-tile\);/);
  assert.match(app, /class="home-arrival"[^`]*<span class="tile large">/);
  assert.match(app, /<div class="resume-card"[^`]*\$\{musicCover\(v\.id, track\.cover, track\.podcast \? "podcast" : "music"\)\}/);
  assert.match(app, /<div class="selection-summary"><div class="tile large">/);
  assert.match(app, /\? `<div class="tile large"\$\{state\[2\] === "busy"/);
});

test("row titles are 14/600 and subtitles 12/400 on every list", () => {
  for (const selector of [".home-arrival-text strong", ".resume-text strong", ".music-row strong", ".music-track-play > strong", ".restore-version strong", ".selection-summary strong", ".backup-card .row-main strong", ".copy-row strong"]) {
    assert.match(body(selector), /font-size: var\(--text-row\);/, selector);
    assert.match(body(selector), /font-weight: 600;/, selector);
  }
  assert.match(style, /\n\.pal-row strong \{[^}]*font-size: var\(--text-row\);/);
  for (const selector of [".home-arrival-text span", ".restore-version p", ".device-row .row-main p", ".setting-row .path"])
    assert.match(body(selector), /font-size: var\(--text-body\);/, selector);
  assert.match(style, /\n\.pal-row p \{[^}]*font-size: var\(--text-body\);/);
  assert.match(body(".music-row strong + span"), /margin-top: 2px;/);
});

test("episode tables keep every row at 66 and music tables at 48, progress included", () => {
  assert.doesNotMatch(style, /\.music-track:not\(\.music-track-head\):has\(\.music-progress\)/);
  assert.match(app, /\{ head: musicHeadRow\(false, "Published", false\), episodes: true \}/);
  assert.match(app, /\$\{episodes \? " music-episodes" : ""\}/);
});

test("right-hand controls are 32 px boxes on the 16 px edge, centred between hairlines", () => {
  assert.match(body(".ghost.icon-button"), /width: var\(--button-small-height\);[^}]*height: var\(--button-small-height\);/);
  assert.match(body(".music-track"), /padding-right: var\(--row-padding-x\);/);
  assert.match(style, /\n\.segmented \{\s*display: flex;\s*min-height: var\(--control-height\);/);
  assert.match(style, /\n\.dropdown-trigger \{[^}]*min-height: var\(--control-height\);\s*padding: 0 var\(--space-3\);/);
  assert.match(style, /\n\.setting-row \{[^}]*padding: var\(--row-padding-y\) var\(--row-padding-x\);\s*border-bottom/);
  assert.match(style, /\n#service-control \{\s*display: flex;\s*align-items: center;/);
  assert.match(style, /\n\.image-process-hint \{[^}]*margin-bottom: calc\(var\(--space-2\) \* -1\);/);
  assert.match(style, /\n\.folder-breadcrumb \{[^}]*padding: 6px var\(--row-padding-x\);/);
});

test("captions under a list sit 8 below it at 12 px with the row inset; side sections are 24 apart", () => {
  assert.match(body(".page > section + .hint"), /margin-top: calc\(var\(--section-label-gap\) - var\(--section-gap\)\);\s*padding: 0 var\(--row-padding-x\);\s*font-size: var\(--text-body\);/);
  assert.match(body(".settings-card + .hint"), /margin-top: var\(--section-label-gap\);/);
  assert.match(style, /\n\.detail-side \{[^}]*gap: var\(--section-gap\);/);
});

test("a device row keeps its name and puts its totals on one line", () => {
  assert.match(style, /\n\.device-row \.row-main \{\s*flex: 1 1 auto;/);
  assert.match(body(".device-row .row-end > .hint"), /white-space: nowrap;/);
  assert.match(body(".device-row .row-end > .hint"), /text-overflow: ellipsis;/);
  assert.doesNotMatch(style, /\n\.device-row \{\s*gap: 14px;/);
});
