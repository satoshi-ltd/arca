import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { browseEntries } from "../apps/mobile/src/browse.js";
import { sidebarLayout } from "../apps/mobile/src/layout.js";
import { icons, iconNames } from "../apps/mobile/src/icons.js";

test("fold/tablet layout uses available space, preserves hysteresis and excludes short landscape phones", () => {
  assert.equal(sidebarLayout(false, 393, 852), false);
  assert.equal(sidebarLayout(false, 852, 393), false);
  assert.equal(sidebarLayout(false, 700, 700), true);
  assert.equal(sidebarLayout(true, 690, 700), true);
  assert.equal(sidebarLayout(true, 675, 700), false);
  assert.equal(sidebarLayout(false, 690, 700), false);
});
test("mobile icons use the exact desktop Lucide geometry", () => {
  const context = { exports: {}, module: {} };
  vm.runInNewContext(
    fs.readFileSync(
      new URL("../apps/desktop/src/vendor/lucide.js", import.meta.url),
      "utf8",
    ),
    context,
  );
  for (const [mobile, desktop] of Object.entries(iconNames))
    assert.equal(
      JSON.stringify(icons[mobile]),
      JSON.stringify(context.exports.icons[desktop][2]),
    );
});

test("mobile surface and text colors match the desktop light and dark tokens", async () => {
  const { palettes } = await import("../apps/mobile/src/palette.js");
  const css = fs.readFileSync(
    new URL("../apps/desktop/src/tokens.css", import.meta.url),
    "utf8",
  );
  const [light, dark] = css.split('[data-theme="dark"] {');
  const parse = (source) =>
    Object.fromEntries(
      [...source.matchAll(/--([\w]+):\s*(#[\da-f]+);/g)].map((m) => [
        m[1],
        m[2],
      ]),
    );
  const colors = {
    light: parse(light),
    dark: { ...parse(light), ...parse(dark) },
  };
  const mapping = {
    paper: "paper",
    surface: "surface",
    side: "side",
    ink: "ink",
    soft: "soft",
    mute: "mute",
    line: "line",
    divider: "div",
    accent: "green",
    onAccent: "onGreen",
    tint: "tint",
    okFg: "okFg",
    hover: "hover",
    danger: "erFg",
    dangerBg: "erBg",
  };
  for (const theme of ["light", "dark"])
    for (const [mobile, desktop] of Object.entries(mapping))
      assert.equal(
        palettes[theme][mobile],
        colors[theme][desktop],
        `${theme}.${mobile}`,
      );
});

test("folder browsing groups directories and searches nested paths", async () => {
  const { browseEntries } = await import("../apps/mobile/src/browse.js");
  const entries = [
    { path: "old.txt", mtime: 10 },
    { path: "notes/new.txt", mtime: 30 },
    { path: "notes/other.txt", mtime: 20 },
  ];
  assert.deepEqual(
    browseEntries(entries, "", "").map((e) => e.label),
    ["notes", "old.txt"],
  );
  assert.equal(browseEntries(entries, "", "")[0].count, 2);
  assert.deepEqual(
    browseEntries(entries, "", "NEW").map((e) => e.path),
    ["notes/new.txt"],
  );
  assert.deepEqual(
    browseEntries(entries, "notes/", "").map((e) => e.label),
    ["new.txt", "other.txt"],
  );
  assert.equal(browseEntries(entries, "", "missing").length, 0);
  assert.equal(entries[0].path, "old.txt");
});

test("shared chip, badge and surface geometry matches desktop tokens", async () => {
  const { geometry } = await import("../apps/mobile/src/design-tokens.js");
  const css = fs.readFileSync(
    new URL("../apps/desktop/src/tokens.css", import.meta.url),
    "utf8",
  );
  const pairs = {
    tagHeight: "tag-height",
    tagFont: "tag-font",
    tagLine: "tag-line",
    tagRadius: "r-tag",
    tagX: "tag-x",
    tagY: "tag-y",
    pillFont: "pill-font",
    pillLine: "pill-line",
    pillRadius: "r-pill",
    pillLeft: "pill-left",
    pillRight: "pill-right",
    pillY: "pill-y",
    pillGap: "pill-gap",
    pillIcon: "pill-icon",
    controlRadius: "r-control",
    cardRadius: "r-card",
    segmentRadius: "r-segment",
    iconStroke: "icon-stroke",
  };
  for (const [key, token] of Object.entries(pairs)) {
    const value = css.match(new RegExp(`--${token}:\\s*([\\d.]+)`));
    assert.ok(value, token);
    assert.equal(geometry[key], Number(value[1]), key);
  }
});

test("file search stays under the current breadcrumb and folder totals include nested bytes", () => {
  const entries = [
    { path: "outside/note.txt", size: 100 },
    { path: "inside/note.txt", size: 3 },
    { path: "inside/nested/note.txt", size: 7 },
  ];
  assert.deepEqual(
    browseEntries(entries, "inside/", "note").map((e) => e.path),
    ["inside/note.txt", "inside/nested/note.txt"],
  );
  const inside = browseEntries(entries, "", "").find(
    (e) => e.path === "inside",
  );
  assert.equal(inside.count, 2);
  assert.equal(inside.size, 10);
});
