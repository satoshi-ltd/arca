import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { noticeMetrics } from "../apps/desktop/src/notice-contract.js";
import { geometry, radius, space } from "../apps/mobile/src/design-tokens.js";
import { palettes } from "../apps/mobile/src/palette.js";

const read = (name) => fs.readFileSync(new URL(`../apps/mobile/src/${name}`, import.meta.url), "utf8");
const theme = read("theme.js");
const c = palettes.light;

function makeStyles(wide = false) {
  const context = {
    g: geometry,
    n: noticeMetrics,
    sp: space,
    r: radius,
    palettes,
    StyleSheet: { create: (value) => value, absoluteFillObject: {}, absoluteFill: {} },
  };
  const source = theme
    .replace(/^import .*;$/gm, "")
    .replace("export { palettes };", "")
    .replace("export function styles", "function styles");
  vm.runInNewContext(source + ";this.makeStyles = styles;", context);
  return context.makeStyles(c, wide, wide, 1, 1);
}

test("Now playing is one paper surface whose only accents are the play button and on states", () => {
  const s = makeStyles();
  const page = read("NowPlayingPage.jsx");
  assert.equal(s.nowRoot.backgroundColor, c.paper);
  for (const [name, rule] of Object.entries(s).filter(([name]) => /^(now|player|sleep)/.test(name)))
    for (const value of Object.values(rule))
      if (name !== "playButton") assert.ok(![c.tint, c.accent].includes(value), `${name} uses the accent`);
  assert.ok(!/textDecorationLine: "underline"/.test(theme));
  assert.ok(!/nowLink\b/.test(page));
  assert.deepEqual(page.slice(page.indexOf("export function NowPlayingPage")).match(/c\.accent/g), ["c.accent"]);
  assert.match(page, /primary \? c\.onAccent : active \? c\.accent : c\.ink/);
});

test("buttons come in four kinds and two sizes, and only a destructive confirmation fills danger", () => {
  const s = makeStyles();
  const sources = fs.readdirSync(new URL("../apps/mobile/src/", import.meta.url)).filter((name) => name.endsWith(".jsx")).map(read).join("\n");
  const button = read("components.jsx").split("export function Button(")[1].split("\nexport function ")[0];
  for (const gone of ["quietButton", "compactButton", "compactLabel", "destructivePrimary"]) assert.equal(s[gone], undefined, gone);
  assert.ok(!/\bquiet\b/.test(button) && !/compact/.test(button));
  assert.ok(!/<Button[^>]*\bquiet\b/.test(sources) && !/\n\s+quiet\n/.test(sources) && !/size=\{?[^}\n]*"compact"/.test(sources));
  assert.deepEqual([s.iconButton.width, s.iconButton.height, s.button.minHeight], [geometry.touchControlHeight, geometry.touchControlHeight, geometry.touchControlHeight]);
  assert.deepEqual([s.smallIconButton.width, s.smallIconButton.height, s.smallButton.minHeight], [geometry.buttonSmallHeight, geometry.buttonSmallHeight, geometry.buttonSmallHeight]);
  assert.deepEqual([s.ghostButton.backgroundColor, s.ghostButton.borderColor, s.ghostButton.width], ["transparent", "transparent", undefined]);
  assert.deepEqual([s.dangerButton.backgroundColor, s.dangerButton.borderColor], [c.danger, c.danger]);
  assert.equal(s.button.gap, space[2]);
  const dangers = [...sources.matchAll(/<Button\b[^>]*?\bdanger\b[^>]*?>|<Button\b(?:(?!\/>)[\s\S])*?\n\s+danger(=\{[^}]*\})?\n(?:(?!\/>)[\s\S])*?\/>/g)].map((m) => m[0]);
  assert.equal(dangers.length, 1);
  assert.match(dangers[0], /danger=\{destructive\}/);
});

test("a sheet pins its actions in a footer outside the scroll and pads its header like its content, with no Cancel", () => {
  const s = makeStyles();
  const fold = makeStyles(true);
  const components = read("components.jsx");
  const sheet = components.slice(components.indexOf("export function Sheet("), components.indexOf("export function ConfirmDialog("));
  assert.ok(sheet.indexOf("</KeyboardScrollView>") < sheet.indexOf("<View style={s.sheetFooter}>{footer}</View>"), "the footer sits below the scroll");
  assert.match(sheet, /<SheetSlot\.Provider value=\{setFooter\}>\{children\}<\/SheetSlot\.Provider>/);
  assert.match(components, /export function SheetFooter\(\{ children \}\) \{\s+const place = useContext\(SheetSlot\);/);
  assert.deepEqual([s.sheetHeader.paddingVertical, s.sheetHeader.paddingHorizontal], [space[3], space[4]]);
  assert.equal(fold.sheetHeader.paddingHorizontal, geometry.workspaceInset);
  assert.deepEqual([s.sheetFooter.paddingVertical, s.sheetFooter.paddingHorizontal, s.sheetFooter.borderTopWidth, s.sheetFooter.borderColor], [space[4], space[4], 1, c.divider], "the footer pads its action equally on every side");
  assert.equal(s.sheetHeaderDialog, undefined);
  const sources = fs.readdirSync(new URL("../apps/mobile/src/", import.meta.url)).filter((name) => name.endsWith(".jsx")).map((name) => [name, read(name)]);
  const cancels = sources.flatMap(([name, text]) => (text.match(/label="Cancel"/g) || []).map(() => name));
  assert.deepEqual(cancels.sort(), ["VideoPlayer.jsx", "components.jsx"], "only the confirmation dialog and the up-next countdown say Cancel");
  const app = read("App.jsx");
  for (const label of ['label="Rename"', 'label="Start streaming"', 'label="Start syncing"', 'label="Restore selected"'])
    assert.ok(app.lastIndexOf("<SheetFooter>", app.indexOf(label)) > app.lastIndexOf("</SheetFooter>", app.indexOf(label)), `${label} sits in a footer`);
  for (const [name, label] of [["GallerySource.jsx", 'label={source ? "Save changes" : "Enable uploads"}'], ["MusicLibrary.jsx", "label={label}"], ["components.jsx", 'label="Allow"'], ["IncomingShare.jsx", 'label="Save here"']]) {
    const text = read(name);
    assert.ok(text.lastIndexOf("<SheetFooter>", text.indexOf(label)) > text.lastIndexOf("</SheetFooter>", text.indexOf(label)), `${name} ${label} sits in a footer`);
  }
});

test("rows share one geometry and a folder not selected is a paper row, the dash kept for empty states", () => {
  const s = makeStyles();
  for (const name of ["card", "folderRow", "scaffoldRow", "machineRow"]) {
    assert.equal(s[name].borderRadius ?? geometry.controlRadius, geometry.controlRadius, name);
    assert.equal(s[name].paddingVertical, geometry.rowPaddingY, name);
    assert.equal(s[name].paddingHorizontal, geometry.rowPaddingX, name);
  }
  for (const name of ["card", "folderRow", "scaffoldRow"]) assert.equal(s[name].gap, space[3], name);
  assert.deepEqual([s.scaffoldMark.width, s.tile.width], [geometry.touchTile, geometry.touchTile]);
  assert.deepEqual([s.available.borderStyle, s.available.borderColor, s.available.backgroundColor], [undefined, c.divider, c.paper]);
  assert.deepEqual([s.availableGroup.borderStyle, s.availableGroup.borderColor, s.availableGroup.backgroundColor], [undefined, c.divider, c.paper]);
  assert.equal(s.dashedSeparator, undefined);
  assert.equal(s.requestReference.borderStyle, undefined);
  const dashed = Object.entries(s).filter(([, rule]) => rule.borderStyle === "dashed").map(([name]) => name);
  assert.deepEqual(dashed, ["empty"], "only the empty state is dashed");
  assert.doesNotMatch(read("components.jsx"), /dashedDivider|scaffoldDashed/);
});

test("feedback is one inline message in three tones, and state overlays use the pill tokens", () => {
  const s = makeStyles();
  const components = read("components.jsx");
  assert.deepEqual([s.message.paddingVertical, s.message.paddingHorizontal, s.message.borderRadius, s.message.gap, s.message.backgroundColor], [space[2], space[3], geometry.controlRadius, space[2], c.hover]);
  assert.deepEqual([s.messageWarning.backgroundColor, s.messageError.backgroundColor], [c.warningBg, c.dangerBg]);
  assert.deepEqual([s.messageText.fontSize, s.messageText.lineHeight], [geometry.touchCaptionFont, geometry.touchCaptionLine]);
  assert.match(components, /<Icon name=\{icon \|\| \(tone === "neutral" \? "info" : "alert"\)\} size=\{16\} color=\{ink\} \/>/);
  assert.match(components, /accessibilityRole=\{tone === "error" \? "alert" : undefined\}/);
  assert.match(read("NowPlayingPage.jsx"), /<InlineMessage tone="error">\{state\.error\}<\/InlineMessage>/);
  assert.match(read("GallerySource.jsx"), /<InlineMessage tone="warning">\s+Limited photo access/);
  assert.doesNotMatch(read("Onboarding.jsx"), /<Card/);
  for (const name of ["videoNext", "levelPill", "newPill", "badge"]) {
    assert.equal(s[name].borderRadius, geometry.pillRadius, name);
    assert.equal(s[name].paddingVertical, geometry.pillY, name);
  }
  assert.deepEqual([s.videoNextText.fontSize, s.levelPillText.fontSize], [geometry.pillFont, geometry.pillFont]);
});

test("a field reads label, field, then one hint that an error replaces", () => {
  const s = makeStyles();
  const fold = makeStyles(true);
  const components = read("components.jsx");
  assert.match(components, /function FieldNote\(\{ hint, error \}\) \{\s+const \{ s \} = useDesign\(\);\s+if \(error\) return <InlineMessage tone="error">\{error\}<\/InlineMessage>;\s+return hint \? <Text style=\{s\.hint\}>\{hint\}<\/Text> : null;/);
  assert.equal((components.match(/<FieldNote hint=\{hint\} error=\{error\} \/>/g) || []).length, 2, "fields and the code input");
  assert.deepEqual([s.hint.color, s.hint.fontSize, s.fieldBody.gap, s.inputInvalid.borderColor], [c.mute, geometry.touchCaptionFont, space[1], c.danger]);
  assert.deepEqual([s.input.paddingHorizontal, fold.input.paddingHorizontal, s.inputShell.paddingHorizontal], [space[3], space[3], space[3]]);
  const pair = read("PairingForm.jsx");
  assert.match(pair, /hint="Use HTTPS or Tailscale\."/);
  assert.match(pair, /hint="Single use · valid ten minutes"\s+error=\{codeError\}/);
  assert.doesNotMatch(pair, /<Text[^>]*>\s*Use HTTPS or Tailscale/);
});

test("the share picker steps back on gestures, starts each place empty, resets with a new share and refuses unusable folder names", async () => {
  const { incomingFolderError } = await import("../apps/mobile/src/incoming-files.js");
  assert.match(incomingFolderError(".git"), /never syncs/);
  assert.match(incomingFolderError("node_modules"), /never syncs/);
  assert.match(incomingFolderError("con."), /^Choose another folder name/);
  assert.equal(incomingFolderError("a/b"), "Enter a folder name, not a path.");
  assert.equal(incomingFolderError("Receipts", ["2025", "receipts"]), "This folder already exists.");
  assert.equal(incomingFolderError("2027", ["2025", "2026"]), "");
  assert.equal(incomingFolderError("Notes", ["2025"], ["notes"]), "A file with this name already exists.", "a file at that level is refused before Save");
  assert.match(read("IncomingShare.jsx"), /incomingFolderError\(\s+named,\s+children\.map\(\(p\) => p\.split\("\/"\)\.pop\(\)\),\s+filePaths\.filter/);
  const components = read("components.jsx");
  const sheet = components.slice(components.indexOf("export function Sheet("), components.indexOf("export function ConfirmDialog("));
  assert.match(sheet, /const retreat = \(\) => \{\s+if \(busy \|\| leaving\.current\) return;\s+\(onBack \|\| onClose\)\?\.\(\);/);
  assert.match(sheet, /onRequestClose=\{retreat\}/);
  assert.match(sheet, /\{!onBack && \(\s+<Button\s+label="Close"/, "inside the picker only Back shows, so the header never discards the batch");
  assert.match(sheet, /onPress=\{retreat\}\s+style=\{s\.modalScrim\}/);
  assert.match(sheet, /dismissRef\.current = retreat;/);
  assert.match(sheet, /label="Close"\s+ghost\s+icon="close"\s+iconOnly\s+disabled=\{busy\}\s+onPress=\{dismiss\}/, "Close still discards");
  assert.match(components, /accessibilityLiveRegion=\{tone === "error" \? "polite" : undefined\}/);
  const share = read("IncomingShare.jsx");
  assert.match(share, /let active = true;\s+setDirectories\(\[\]\);/, "a place never shows the previous folder's subfolders");
  assert.equal((share.match(/setPlace\(null\);\s+setNaming\(null\);/g) || []).length, 3, "a new share and another hub leave the picker");
  assert.doesNotMatch(share, /InlineMessage/);
});
