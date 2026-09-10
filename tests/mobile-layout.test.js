import { noticeMetrics } from "../apps/desktop/src/notice-contract.js";
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
    listItemGap: "list-item-gap",
    workspaceInset: "space-6",
    desktopTitleFont: "text-title",
    desktopTitleLine: "text-title-line",
    touchTitleFont: "touch-title-font",
    touchTitleLine: "touch-title-line",
    touchRowFont: "touch-row-font",
    touchRowLine: "touch-row-line",
    touchBodyFont: "touch-body-font",
    touchBodyLine: "touch-body-line",
    touchCaptionFont: "touch-caption-font",
    touchCaptionLine: "touch-caption-line",
    touchControlFont: "touch-control-font",
    touchControlLine: "touch-control-line",
    touchInputFont: "touch-input-font",
    touchInputLine: "touch-input-line",
    listRowPaddingY: "list-row-padding-y",
    listRowPaddingX: "list-row-padding-x",
    sectionLabelGap: "section-label-gap",
    sectionGap: "section-gap",
    headerBottomGap: "header-bottom-gap",

    screenTitleLogo: "screen-title-logo",
    touchControlHeight: "touch-control-height",
    touchHeight: "touch-target-min",
    detailSideWidth: "detail-side-width",
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

test("empty directory entries remain navigable without inflating recursive file counts", () => {
  const entries = [
    { path: "doc", directory: true, size: 0 },
    { path: "doc/Coros", directory: true, size: 0 },
    { path: "doc/notes.txt", size: 12 },
  ];
  assert.equal(browseEntries(entries, "", "")[0].count, 1);
  assert.equal(browseEntries(entries, "", "")[0].size, 12);
  assert.deepEqual(
    browseEntries(entries, "doc/", "").map((e) => e.label),
    ["Coros", "notes.txt"],
  );
  assert.equal(browseEntries(entries, "doc/Coros/", "").length, 0);
});

test("mobile single-line fields reserve stable geometry and grow only for accessibility scaling", async () => {
  const { geometry } = await import("../apps/mobile/src/design-tokens.js");
  const { palettes } = await import("../apps/mobile/src/palette.js");
  const source = fs
    .readFileSync(
      new URL("../apps/mobile/src/theme.js", import.meta.url),
      "utf8",
    )
    .replace(/^import .*;$/gm, "")
    .replace("export { palettes };", "")
    .replace("export function styles", "function styles");
  const context = {
    g: geometry,
    n: noticeMetrics,
    palettes,
    StyleSheet: { create: (value) => value, absoluteFillObject: {} },
  };
  vm.runInNewContext(source + ";this.makeStyles = styles;", context);
  for (const wide of [false, true])
    for (const scale of [1, 2, 3]) {
      const s = context.makeStyles(palettes.light, wide, false, scale);
      if (wide) {
        assert.equal(s.navigation.paddingTop, s.viewHeader.padding);
        assert.equal(s.brand.minHeight, s.screenHeader.minHeight);
        assert.equal(s.title.fontSize, geometry.desktopTitleFont);
      }
      assert.equal(s.section.gap, geometry.sectionLabelGap);
      assert.equal(s.content.gap, geometry.sectionGap);
      assert.equal(s.buttonLabel.fontSize, geometry.touchControlFont);
      assert.equal(s.caption.fontSize, geometry.touchCaptionFont);
      assert.equal(s.rowTitle.fontSize, geometry.touchRowFont);
      assert.equal(
        s.folderRow.minHeight,
        s.button.minHeight + 2 * s.folderRow.paddingVertical + 2,
      );
      assert.equal(s.viewHeader.paddingBottom, geometry.headerBottomGap);
      assert.equal(s.input.height, s.input.minHeight);
      assert.equal(s.input.height, s.inputShell.height);
      assert.equal(s.inputEmbedded.height + 2, s.inputShell.height);
      assert.ok(s.input.height >= 26 * scale + 18);
      assert.equal(s.input.includeFontPadding, false);
      assert.equal(s.input.paddingVertical, 0);
      assert.equal(s.button.minHeight, geometry.touchControlHeight);
      assert.ok(s.screenHeader.minHeight >= s.button.minHeight);
      if (scale === 1)
        assert.equal(s.screenHeader.minHeight, s.button.minHeight);
    }
});
