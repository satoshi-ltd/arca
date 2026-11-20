import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { noticeMetrics } from "../apps/desktop/src/notice-contract.js";

const read = (file) => fs.readFileSync(new URL(`../apps/mobile/src/${file}`, import.meta.url), "utf8");

async function phoneStyles(fontScale = 1) {
  const { geometry, radius, space } = await import("../apps/mobile/src/design-tokens.js");
  const { palettes } = await import("../apps/mobile/src/palette.js");
  const source = read("theme.js")
    .replace(/^import .*;$/gm, "")
    .replace("export { palettes };", "")
    .replace("export function styles", "function styles");
  const context = { g: geometry, n: noticeMetrics, sp: space, r: radius, palettes, StyleSheet: { create: (value) => value, absoluteFill: {}, absoluteFillObject: {} } };
  vm.runInNewContext(source + ";this.makeStyles = styles;", context);
  return { s: context.makeStyles(palettes.light, false, false, fontScale), g: geometry };
}

test("a segmented control's sliding thumb sits on its segment, with the same inset above and below", async () => {
  const { s } = await phoneStyles();
  assert.equal(s.segmentThumb.top, s.segments.padding);
});

test("a gallery tile's selection ring and its selected badge are the same circle", async () => {
  const { s, g } = await phoneStyles();
  assert.equal(s.photoBadge.padding * 2 + g.photoMarkIcon, s.photoRing.width);
  assert.deepEqual([s.photoBadge.right, s.photoBadge.bottom], [s.photoRing.right, s.photoRing.bottom]);
  assert.equal((read("FolderGallery.jsx").match(/size=\{g\.photoMarkIcon\}/g) || []).length, 2);
});

test("a video card's rating chip is a tag, and its Next chip a pill, as the kit draws them", async () => {
  const { s, g } = await phoneStyles();
  assert.deepEqual([s.videoRating.minHeight, s.videoRating.paddingVertical, s.videoRating.paddingHorizontal, s.videoRating.borderRadius], [g.tagHeight, undefined, g.tagX, g.tagRadius]);
  assert.deepEqual([s.videoNext.paddingVertical, s.videoNext.paddingHorizontal, s.videoNext.borderRadius], [g.pillY, g.pillLeft, g.pillRadius]);
  const kit = fs.readFileSync(new URL("../design/mobile.css", import.meta.url), "utf8");
  assert.match(kit, /\.m-video-rating \{[^}]*padding: 0 var\(--m-tag-x\);/);
  assert.match(kit, /\.m-video-rating\.m-video-next \{[^}]*padding: var\(--m-pill-y\) var\(--m-pill-left\);[^}]*border-radius: var\(--m-pill-radius\);/);
});
test("a notice card's icon is centred on its title line, at every text size", async () => {
  for (const scale of [1, 1.5, 2]) {
    const { s } = await phoneStyles(scale);
    assert.equal(s.noticeIcon.marginTop * 2 + noticeMetrics.icon, s.noticeTitle.lineHeight * scale, `font scale ${scale}`);
  }
  assert.match(read("Notice.jsx"), /<View style=\{!pill && s\.noticeIcon\}>\s+<Icon/);
});

test("episode state glyphs share one 24-point box and the download ring sits on whole pixels in it", async () => {
  const { s } = await phoneStyles();
  const ring = Number(read("components.jsx").match(/<ProgressRing fraction=\{glyph\.ring\} size=\{(\d+)\}/)[1]);
  assert.equal((s.videoGlyph.width - ring) % 2, 0);
  assert.match(read("VideoLibrary.jsx"), /\{ep\.watched && \(\s+<View style=\{s\.videoGlyph\}>\s+<Icon name="check" size=\{20\}/);
});

test("labels in fixed-height boxes carry their line height and drop Android's font padding", async () => {
  const { s } = await phoneStyles();
  for (const name of ["levelPillText", "sleepChipText", "compactNavLabel", "navLabel", "codeDigit", "codeSeparator", "searchChipText", "viewerCount", "noticeDetailsLabel", "videoTime"]) {
    assert.ok(s[name].lineHeight >= s[name].fontSize, `${name} has a line height`);
    assert.equal(s[name].includeFontPadding, false, `${name} drops Android font padding`);
  }
});

test("small icons in pills, tags and chips leave whole-pixel insets", async () => {
  const { g } = await phoneStyles();
  for (const box of [g.pillLine, g.pillLine + 2 * g.pillY, g.tagHeight - 2 * g.tagY - 2, g.touchCaptionLine]) assert.equal((box - g.pillIcon) % 2, 0, `${g.pillIcon} in ${box}`);
  assert.equal((g.buttonSmallHeight - g.chipIcon) % 2, 0);
  assert.match(read("NowPlayingPage.jsx"), /<Icon name="moon" size=\{g\.chipIcon\}/);
  assert.match(read("components.jsx"), /<Icon name="shield-check" size=\{g\.pillIcon\}/);
});
