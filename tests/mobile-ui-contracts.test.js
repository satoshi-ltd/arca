import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { noticeMetrics } from "../apps/desktop/src/notice-contract.js";
import { geometry } from "../apps/mobile/src/design-tokens.js";
import { palettes } from "../apps/mobile/src/palette.js";
import { fontCap, maxTextScale, railLabelFontCap, textSizes } from "../apps/mobile/src/text-size.js";

const read = (name) => fs.readFileSync(new URL(`../apps/mobile/src/${name}`, import.meta.url), "utf8");
const app = read("App.jsx");
const components = read("components.jsx");
const notice = read("Notice.jsx");
const theme = read("theme.js");

function makeStyles(wide, fontScale, textScale, compact = wide) {
  const context = {
    g: geometry,
    n: noticeMetrics,
    palettes,
    StyleSheet: { create: (value) => value, absoluteFillObject: {}, absoluteFill: {} },
  };
  const source = theme
    .replace(/^import .*;$/gm, "")
    .replace("export { palettes };", "")
    .replace("export function styles", "function styles");
  vm.runInNewContext(source + ";this.makeStyles = styles;", context);
  return context.makeStyles(palettes.light, wide, compact, fontScale, textScale);
}

test("the notice dock sits above the measured tab bar, mini player and selection bar", () => {
  assert.match(notice, /export function NoticeStack\(\{ items, onDismiss, onAction, disabled, lift = 0 \}\)/);
  assert.match(notice, /bottom: insets\.bottom \+ lift \+ noticeMetrics\.inset,/);
  assert.match(notice, /height - insets\.top - insets\.bottom - lift - 2 \* noticeMetrics\.inset/);
  assert.match(app, /<View onLayout=\{\(\{ nativeEvent: \{ layout \} \}\) => setBottomBars\(layout\.height\)\}>\s+\{folder && screen === "Folders" && musicFolder && !sheet && \(\s+<MiniPlayer[\s\S]+?<SelectionBar[\s\S]+?<Navigation[\s\S]+?<\/View>\s+<\/KeyboardPane>/);
  assert.match(app, /<NoticeStack\s+items=\{noticeItems\}\s+lift=\{bottomBars\}/);
  assert.doesNotMatch(app, /items=\{noticeItems\.filter\(\(n\) => n\.kind === "info"\)\}\s+lift=/, "a sheet's own stack covers the bars under it");
});

test("Fold rail labels use the pill size, ignore the app text size and cap the system scale", () => {
  for (const textScale of [1, 1.15, 1.3]) {
    const label = makeStyles(true, 1, textScale).compactNavLabel;
    assert.equal(label.fontSize, geometry.pillFont);
    assert.equal(label.lineHeight, geometry.pillLine);
  }
  assert.ok(geometry.pillFont * railLabelFontCap * 4.4 <= 60, "Favorites at the cap fits the 60 dp item");
  assert.equal(components.match(/maxFontSizeMultiplier=\{[^}]*railLabelFontCap/g).length, 2, "both rail label sites cap the scale");
  assert.match(components, /numberOfLines=\{1\}\s+maxFontSizeMultiplier=\{compact \? railLabelFontCap : undefined\}/);
});

test("every list row shares one 44 dp lead slot and the two-line row height", () => {
  const s = makeStyles(false, 1, 1);
  assert.equal(s.leadSlot.width, 44);
  assert.equal(s.homeLead.width, 44);
  assert.equal(s.rowThumb.width, 44);
  assert.equal(s.settingRowTall.minHeight, 74);
  assert.equal(s.folderRow.minHeight, 74);
  assert.equal(s.machineRow.minHeight, 74);
  assert.match(components, /<ProgressRing size=\{g\.touchHeight\}/);
  assert.match(read("FilePreview.jsx"), /<View style=\{s\.leadSlot\}>\s+\{thumbnail \? \(/);
  assert.match(components, /export function HistoryGlyph[\s\S]+?<View style=\{s\.leadSlot\}>\s+<View style=\{\[s\.historyGlyph[\s\S]+?size=\{16\}/);
  assert.match(components, /<View style=\{s\.leadSlot\}>\{tile\}<\/View>/);
  assert.match(app, /s\.settingRow,\s+s\.settingRowTall,\s+s\.separator,\s+\(\(previewEntry/, "Files rows use the tall row");
  assert.match(app, /s\.settingRow,\s+s\.settingRowTall,\s+index > 0 && s\.separator,\s+s\.row,/, "History rows use the tall row");
  assert.match(read("FolderRecent.jsx"), /\[s\.settingRow, s\.settingRowTall, s\.row, index > 0 && s\.separator\]/);
  assert.equal((app.match(/<View style=\{s\.leadSlot\}>/g) || []).length, 3, "Copies rows hold their icons in the slot");
});

test("32 dp tiles hold 16 dp glyphs and loading rows inside a list draw no border", () => {
  assert.match(components, /<Icon name=\{icon\} size=\{16\} color=\{c\.accent\} \/>/, "sheet header");
  assert.match(components, /<Icon name=\{icon\} size=\{16\} \/>/, "confirm dialog header");
  assert.match(components, /size=\{wide \? 20 : 16\}\s+color=\{tone === "danger"/, "device tile");
  const s = makeStyles(false, 1, 1);
  assert.equal(s.scaffoldGrouped.borderWidth, 0);
  assert.match(app, /<Scaffold grouped label="Loading files" \/>/);
  assert.match(components, /grouped && s\.scaffoldGrouped/);
});

test("on the phone the folder and file headers put the actions on the back row", () => {
  assert.match(app, /const stackedHeader =\s+!wide &&\s+!onboarding &&\s+\(detail \|\| !\(musicDeep && !musicArtist\)\) &&\s+\(detail \|\| \(!!folder && screen === "Folders"\)\);/);
  assert.equal((app.match(/\{stackedHeader && \(\s+<View style=\{s\.rowAction\}>\s+\{headerLead\}\s+\{headerSync\}/g) || []).length, 2, "file and folder back rows");
  assert.match(app, /\{!stackedHeader && headerLead\}/);
  assert.match(app, /\{!stackedHeader && headerSync\}/);
  assert.match(app, /numberOfLines=\{wide \? undefined : 2\}/, "file titles take two lines");
  assert.match(components, /numberOfLines=\{wide \? undefined : 1\}\s+style=\{detail \? s\.detailTitle : s\.title\}/, "folder titles take one line");
  assert.match(app, /subtitle=\{videoView \? unbroken\(videoSubtitle\) : folderSubtitle\}/, "subtitles wrap only at the dot");
  assert.match(theme, /headerBack: \{ flexDirection: "row", alignItems: "center", justifyContent: "space-between"/);
});

test("a shared font cap keeps the app text size times the system scale within the layout", () => {
  for (const { value } of textSizes) {
    assert.ok(fontCap(value) >= 1);
    assert.ok(value * fontCap(value) <= Math.max(maxTextScale, value) + 1e-9);
  }
  assert.equal(fontCap(1), maxTextScale);
  assert.equal(fontCap("unknown"), maxTextScale);
  const text = read("Text.jsx");
  assert.match(text, /maxFontSizeMultiplier=\{maxFontSizeMultiplier \?\? cap\}/);
  assert.match(app, /<FontCap\.Provider value=\{fontCap\(prefs\.textSize\)\}>/);
  for (const file of fs.readdirSync(new URL("../apps/mobile/src/", import.meta.url)).filter((name) => name.endsWith(".jsx") && !["Text.jsx", "ErrorBoundary.jsx"].includes(name))) {
    const source = read(file);
    for (const [, names] of source.matchAll(/import \{([^}]*)\} from "react-native";/g))
      assert.doesNotMatch(names, /\bText\b/, `${file} takes Text from the shared wrapper`);
  }
});

test("large text scrolls the music tabs, grows video badges and scales the Fold date column", () => {
  assert.match(read("MusicLibrary.jsx"), /<SegmentedControl\s+options=\{tabs\.map[\s\S]+?fit\s+onChange=\{select\}/);
  assert.match(components, /contentContainerStyle=\{fit \? s\.segmentsFitContent : undefined\}/);
  const s = makeStyles(false, 1, 1.3);
  assert.equal(s.segmentFit.flexShrink, 0, "tabs never shrink below their label");
  assert.equal(s.segmentFit.flexGrow, 1, "tabs fill the width when they fit");
  assert.equal(s.videoBadge.height, undefined);
  assert.equal(s.videoBadge.minHeight, geometry.tagHeight);
  assert.equal(s.videoBadgeText.lineHeight, geometry.tagLine * 1.3);
  const fold = (fontScale, textScale) => makeStyles(true, fontScale, textScale);
  assert.equal(fold(1, 1).historyDate.width, 90);
  assert.equal(fold(1.3, 1.3).historyDate.width, Math.ceil(90 * 1.69));
  assert.equal(fold(1.3, 1.3).historyDate.flexShrink, 0);
});

test("the unfolded Fold stacks every side column into one full-width column and keeps the split from 1100 dp", () => {
  const fold = makeStyles(true, 1, 1, true);
  const large = makeStyles(true, 1, 1, false);
  assert.equal(fold.detailGrid.flexDirection, "column");
  assert.equal(fold.detailSide.width, undefined);
  assert.equal(fold.musicSplit.flexDirection, "column");
  assert.equal(fold.musicSplitList.width, undefined);
  assert.equal(fold.videoEpisodeStill.width, 160);
  assert.equal(fold.videoState.flexDirection, "row");
  assert.equal(large.videoState.flexDirection, "column");
  assert.equal(large.detailGrid.flexDirection, "row");
  assert.equal(large.detailSide.width, geometry.detailSideWidth);
  assert.equal(large.musicSplit.flexDirection, "row");
  assert.equal(large.musicSplitList.width, geometry.detailSideWidth);
  assert.equal(large.videoEpisodeStill.width, 120);
  assert.match(app, /wide,\s+compact,\s+active:/);
});

test("the Fold title page is the desktop hero with only the mark-all action for shows and a single Play for movies", () => {
  const library = read("VideoLibrary.jsx");
  const fold = library.slice(library.indexOf("const heroActions"), library.indexOf("return (\n    <View style={s.musicPage}>\n      <Band item={item} art={art} back={back} backLabel={videoBackLabel(route)} more={() => more(item, season?.season)} />"));
  assert.match(fold, /Mark all episodes as unwatched" : "Mark all episodes as watched"/);
  assert.doesNotMatch(fold, /Start over|Continue/);
  assert.equal((fold.match(/primary label=\{playLabel/g) || []).length, 1);
  assert.doesNotMatch(fold.slice(0, fold.indexOf(") : (")), /play\(/, "a show has no Play button in the hero");
  assert.match(library, /if \(compact\)\s+return \(\s+<View style=\{s\.musicPage\}>\s+<Band[\s\S]+?\{hero\}[\s\S]+?\{episodesPane\}/);
  assert.match(library, /upNext=\{ep\.id === target\?\.id\}/);
  assert.match(library, /\(compact \? upNext : ep\.position\) && s\.videoNow/);
  assert.match(read("StickyDetailSide.jsx"), /if \(!wide \|\| compact \|\| !position\)/);
});
