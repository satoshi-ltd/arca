import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { noticeMetrics } from "../apps/desktop/src/notice-contract.js";

const read = (file) => fs.readFileSync(new URL(`../apps/mobile/src/${file}`, import.meta.url), "utf8");

async function phoneStyles(fontScale = 1, wide = false, compact = false) {
  const { geometry, radius, space } = await import("../apps/mobile/src/design-tokens.js");
  const { palettes } = await import("../apps/mobile/src/palette.js");
  const source = read("theme.js")
    .replace(/^import .*;$/gm, "")
    .replace("export { palettes };", "")
    .replace("export function styles", "function styles");
  const context = { g: geometry, n: noticeMetrics, sp: space, r: radius, palettes, StyleSheet: { create: (value) => value, absoluteFill: {}, absoluteFillObject: {} } };
  vm.runInNewContext(source + ";this.makeStyles = styles;", context);
  return { s: context.makeStyles(palettes.light, wide, compact, fontScale), g: geometry, c: palettes.light, space };
}

const kebab = (name) => name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

async function kitRules() {
  const { g, c, space } = await phoneStyles();
  const tokens = new Map([
    ...Object.entries(space).map(([step, value]) => [`--space-${step}`, `${value}px`]),
    ...Object.entries(g).map(([name, value]) => [`--m-${kebab(name)}`, typeof value === "number" ? `${value}px` : String(value)]),
    ...Object.entries(c).map(([name, value]) => [`--m-${kebab(name)}`, value]),
  ]);
  const rules = new Map();
  for (const [, selectors, body] of fs.readFileSync(new URL("../design/mobile.css", import.meta.url), "utf8").matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    for (const selector of selectors.split(",").map((part) => part.trim().replace(/\s+/g, " "))) {
      const rule = rules.get(selector) || {};
      for (const line of body.split(";")) {
        const at = line.indexOf(":");
        if (at > 0) rule[line.slice(0, at).trim()] = line.slice(at + 1).trim();
      }
      rules.set(selector, rule);
    }
  }
  const seen = new Set();
  const lastClass = (selector) => selector.split(" ").at(-1).match(/\.[\w-]+/g)?.at(-1);
  const rivals = () =>
    [...seen].flatMap((entry) => {
      const [selector, property] = entry.split("|");
      return [...rules.keys()]
        .filter((other) => other !== selector && lastClass(selector) && lastClass(other) === lastClass(selector) && property in rules.get(other) && !seen.has(`${other}|${property}`))
        .map((other) => `${other} also sets ${property} of ${selector}`);
    });
  const raw = (selector, property) => {
    const value = rules.get(selector)?.[property];
    assert.ok(value, `${selector} sets ${property}`);
    seen.add(`${selector}|${property}`);
    return value.replace(/var\((--[\w-]+)\)/g, (_, name) => {
      assert.ok(tokens.has(name), `${name} is a token`);
      return tokens.get(name);
    });
  };
  const sum = (expression) =>
    expression
      .split(" ")
      .reduce((state, part) => (part === "+" || part === "-" ? { ...state, sign: part === "-" ? -1 : 1 } : { total: state.total + state.sign * parseFloat(part), sign: 1 }), { total: 0, sign: 1 }).total;
  const kit = (selector, property) =>
    raw(selector, property)
      .match(/calc\([^)]*\)|\S+/g)
      .map((part) => (part.startsWith("calc(") ? sum(part.slice(5, -1)) : /^-?[\d.]+(px)?$/.test(part) ? parseFloat(part) : part));
  return { kit, raw, rivals };
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
  for (const [name, base, box] of [["segmentText", "buttonLabel", "segment"], ["tabLabel", "caption", "tab"]]) {
    const label = { ...s[base], ...s[name] };
    assert.ok(s[box].minHeight > label.lineHeight, `${name} sits in a box of its own height`);
    assert.equal(s[name].lineHeight, s[base].lineHeight, `${name} has a line height`);
    assert.ok(label.lineHeight >= label.fontSize, `${name} has a line height`);
    assert.equal(s[name].includeFontPadding, false, `${name} drops Android font padding`);
  }
  assert.match(read("components.jsx"), /style=\{\[\s+s\.buttonLabel,\s+s\.segmentText,/);
  assert.match(read("components.jsx"), /wide \? \(compact \? s\.compactNavLabel : s\.navLabel\) : \[s\.caption, s\.tabLabel\],/);
});

test("the kit draws the phone's own numbers", async () => {
  const { s, g, c } = await phoneStyles();
  const { s: fold } = await phoneStyles(1, true, true);
  const { kit, rivals } = await kitRules();
  const cover = read("MusicLibrary.jsx").match(/<Cover uri=\{coverUri\} size=\{wide \? (\d+) : (\d+)\}/);
  const pairs = [
    ["bottom tab gap", [s.tab.gap], kit(".m-tab", "gap")],
    ["pairing code cells gap", [s.codeCells.gap], kit(".m-code", "gap")],
    ["onboarding dots gap", [s.stepIndicator.gap], kit(".m-dots", "gap")],
    ["stat cell", [s.statCell.padding, s.statCell.gap], [...kit(".m-stat", "padding"), ...kit(".m-stat", "gap")]],
    ["device name to tag gap", [s.machineIdentity.gap], kit(".m-identity-row", "gap")],
    ["empty state gap", [s.empty.gap], kit(".m-empty", "gap")],
    ["sidebar brand gap", [s.brand.gap], kit(".m-brand", "gap")],
    ["nav and drawer item gap", [s.navItem.gap, s.drawerItem.gap], [...kit(".m-nav-item", "gap"), ...kit(".m-nav-item", "gap")]],
    ["rail item padding", [s.compactNav.paddingVertical, s.compactNav.paddingHorizontal], kit(".m-labelled .m-nav-item", "padding")],
    ["album header gap", [s.musicHeader.gap, s.musicHeaderWide.gap], [...kit(".m-album-head", "gap"), ...kit(".m-fold .m-album-head", "gap")]],
    ["album header cover", [Number(cover[2]), Number(cover[1])], [...kit(".m-album-head .m-cover", "width"), ...kit(".m-fold .m-album-head .m-cover", "width")]],
    ["Play and Shuffle top margin", [s.musicActions.marginTop], kit(".m-album-head .m-actions-row", "margin-top")],
    ["breadcrumb", [0, s.breadcrumb.paddingHorizontal, s.breadcrumb.gap], [...kit(".m-breadcrumb", "padding"), ...kit(".m-breadcrumb", "gap")]],
    ["video language chips gap", [s.videoLanguages.rowGap, s.videoLanguages.columnGap], kit(".m-video-languages", "gap")],
    ["sleep chip margin", [s.sleepChip.marginRight], kit(".m-np-top .m-sleep-chip", "margin-right")],
    ["track number column", [s.musicNumber.width], kit(".m-track-number", "width")],
    ["month bubble", [0, s.scrubBubble.paddingHorizontal, s.scrubBubbleText.fontSize, s.scrubBubbleText.lineHeight], [...kit(".m-scrub-bubble", "padding"), ...kit(".m-scrub-bubble", "font-size"), ...kit(".m-scrub-bubble", "line-height")]],
    ["year chip", [s.scrubYear.fontSize, s.scrubYear.lineHeight, `translateY(${s.scrubYear.transform[0].translateY}px)`], [...kit(".m-scrub-year", "font-size"), ...kit(".m-scrub-year", "line-height"), ...kit(".m-scrub-year", "transform")]],
    ["On this day card", [s.memoryCard.paddingBottom, s.memoryCard.paddingHorizontal, s.memoryTitle.fontSize, s.memoryTitle.lineHeight, s.memoryCaption.fontSize, s.memoryCaption.lineHeight], [...kit(".m-memory > span", "bottom"), ...kit(".m-memory > span", "left"), ...kit(".m-memory > span", "font-size"), ...kit(".m-memory > span", "line-height"), ...kit(".m-memory small", "font-size"), ...kit(".m-memory small", "line-height")]],
    ["History revision column", [s.historyRevision.width], kit(".m-history-rev", "width")],
    ["screen header", [s.viewHeader.padding, s.viewHeader.padding, s.viewHeader.paddingBottom, s.viewHeader.gap], [...kit(".m-header", "padding"), ...kit(".m-header", "gap")]],
    ["detail header", [s.detailViewHeader.paddingTop, s.detailViewHeader.gap], [...kit(".m-header:has(.m-back)", "padding-top"), ...kit(".m-header:has(.m-back)", "gap")]],
    ["Fold header", [fold.viewHeader.padding, fold.viewHeader.padding, fold.viewHeader.paddingBottom, fold.detailViewHeader.paddingTop], [...kit(".m-fold .m-header", "padding"), ...kit(".m-fold .m-header:has(.m-back)", "padding-top")]],
    ["content inset", [0, s.content.padding, s.content.padding], kit(".m-body", "padding")],
    ["Fold content inset", [0, fold.content.padding, fold.content.padding], kit(".m-fold .m-body", "padding")],
    ["selection bar", [s.selectionBar.paddingVertical, s.selectionBar.paddingHorizontal, s.selectionBar.borderTopWidth, "solid", s.selectionBar.borderColor], [...kit(".m-selection.m-pinned", "padding"), ...kit(".m-selection.m-pinned", "border-top")]],
    ["sheet header", [s.sheetHeader.minHeight, s.sheetHeader.paddingVertical, s.sheetHeader.paddingHorizontal], [...kit(".m-sheet-header", "min-height"), ...kit(".m-sheet-header", "padding")]],
    ["Fold sheet header", [fold.sheetHeader.paddingVertical, fold.sheetHeader.paddingHorizontal], kit(".m-fold .m-sheet-header", "padding")],
    ["drag handle", [s.sheetHandle.marginTop, "auto", s.sheetHandle.marginBottom + s.sheetGrabber.paddingBottom], kit(".m-handle", "margin")],
    ["menu sheet", [s.sheetMenu.paddingVertical, 0], kit(".m-sheet-menu", "padding")],
    ["card", [s.card.paddingVertical, s.card.paddingHorizontal, s.card.borderRadius, s.card.gap], [...kit(".m-card", "padding"), ...kit(".m-card", "border-radius"), ...kit(".m-card", "gap")]],
    ["conflict choice", [s.card.paddingVertical, s.card.paddingHorizontal, s.card.borderRadius, s.conflictChoice.gap, s.conflictChoice.borderWidth, "solid", s.conflictChoice.borderColor], [...kit(".m-choice", "padding"), ...kit(".m-choice", "border-radius"), ...kit(".m-choice", "gap"), ...kit(".m-choice", "border")]],
    ["setup display title", [s.displayTitle.fontSize, s.displayTitle.lineHeight, s.displayTitle.letterSpacing, Number(s.displayTitle.fontFamily.match(/_(\d+)/)[1])], [...kit(".m-display", "font-size"), ...kit(".m-display", "line-height"), ...kit(".m-display", "letter-spacing"), ...kit(".m-display", "font-weight")]],
    ["header Back", [s.button.minHeight, s.button.gap, c.ink, s.buttonLabel.fontSize, s.buttonLabel.lineHeight, s.headerBack.marginLeft, 0, s.button.paddingHorizontal], [...kit(".m-back", "min-height"), ...kit(".m-back", "gap"), ...kit(".m-back", "color"), ...kit(".m-back", "font-size"), ...kit(".m-back", "line-height"), ...kit(".m-header .m-back", "margin-left"), ...kit(".m-header .m-back", "padding")]],
    ["field inset", [0, s.inputShell.paddingHorizontal, s.input.paddingHorizontal], [...kit(".m-field", "padding"), kit(".m-field", "padding")[1]]],
    ["switch in its target", [s.switchTarget.minWidth, s.switchTarget.minHeight, s.switchTarget.alignItems, s.switchTarget.justifyContent], [...kit(".m-switch-target", "min-width"), ...kit(".m-switch-target", "min-height"), ...kit(".m-switch-target", "justify-content"), ...kit(".m-switch-target", "align-items")]],
    ["onboarding feature tile", [s.tileLarge.width, s.tileLarge.borderRadius], [...kit(".m-tile.m-large", "width"), ...kit(".m-tile.m-large", "border-radius")]],
    ["Up next pane", [fold.nowQueue.width, fold.nowQueue.backgroundColor], [...kit(".m-np-queue", "width"), ...kit(".m-np-queue", "background")]],
    ["mini player", [s.miniPlayer.paddingVertical, s.miniPlayer.paddingHorizontal, s.miniPlayer.gap, s.miniControl.width, s.miniControl.height], [...kit(".m-player", "padding"), ...kit(".m-player-controls", "gap"), ...kit(".m-player-control", "width"), ...kit(".m-player-control", "height")]],
    ["Now playing inset", [s.nowPage.paddingTop, s.nowPage.paddingHorizontal, 0], kit(".m-np-stage", "padding")],
    ["Now playing rhythm", [s.nowPage.gap, s.nowPage.gap, s.nowPage.gap, s.nowPage.gap, s.nowPage.paddingHorizontal, 0], [...kit(".m-np-meta", "margin-top"), ...kit(".m-np-scrub", "margin-top"), ...kit(".m-np-transport", "margin-top"), ...kit(".m-np-next", "margin")]],
    ["Now playing sides", [0, s.nowPage.paddingHorizontal, 0, s.nowPage.paddingHorizontal, 0, s.nowPage.paddingHorizontal], [...kit(".m-np-meta", "padding"), ...kit(".m-np-scrub", "padding"), ...kit(".m-np-transport", "padding")]],
    ["Now playing title and links", [s.nowPlayingText.alignItems, s.stack.gap, s.nowLinks.alignItems, s.nowLinks.gap, "column"], [...kit(".m-np-meta", "align-items"), ...kit(".m-np-meta", "gap"), ...kit(".m-np-links", "align-items"), ...kit(".m-np-links", "gap"), ...kit(".m-np-links", "flex-direction")]],
    ["Up next row", [s.nowUpNext.minHeight, s.nowUpNext.gap, s.nowUpNext.backgroundColor, s.nowUpNext.borderRadius], [...kit(".m-np-next", "min-height"), ...kit(".m-np-next", "gap"), ...kit(".m-np-next", "background"), ...kit(".m-np-next", "border-radius")]],
    ["subtitle cue radius", [s.videoCue.borderRadius], kit(".m-video-cue", "border-radius")],
    ["Fold header tile", [g.detailTile, fold.detailTile.borderRadius], [...kit(".m-tile.m-detail", "width"), ...kit(".m-tile.m-detail", "border-radius")]],
    ["search photo thumbnails gap", [s.searchThumbs.gap], kit(".m-srch-photos", "gap")],
    ["file menu padding", [s.fileActionMenu.paddingVertical, 0, s.fileActionMenu.borderRadius], [...kit(".m-popover", "padding"), ...kit(".m-popover", "border-radius")]],
    ["Now playing header", [s.nowHeader.paddingVertical, s.nowHeader.paddingHorizontal, s.nowHeader.gap, s.nowHeader.alignItems, s.nowFrom.alignItems, s.nowFrom.flex], [...kit(".m-np-top", "padding"), ...kit(".m-np-top", "gap"), ...kit(".m-np-top", "align-items"), ...kit(".m-np-from", "align-items"), ...kit(".m-np-from", "flex")]],
    ["Now playing cover radius", [s.musicCover.borderRadius], kit(".m-np-cover", "border-radius")],
    ["search sections", [s.searchSections.paddingHorizontal, s.searchSections.gap, s.section.gap], [kit(".m-body", "padding")[1], ...kit(".m-body", "gap"), ...kit(".m-section", "gap")]],
    ["search result card", [s.group.backgroundColor, s.group.borderWidth, "solid", s.group.borderColor, s.group.borderRadius, s.group.overflow, s.separator.borderTopWidth, "solid", s.separator.borderColor], [...kit(".m-group", "background"), ...kit(".m-group", "border"), ...kit(".m-group", "border-radius"), ...kit(".m-group", "overflow"), ...kit(".m-group > .m-row + .m-row", "border-top")]],
    ["search result row", [s.folderRow.minHeight, s.folderRow.paddingVertical, s.folderRow.paddingHorizontal, s.folderRow.gap, s.groupedFolderRow.borderRadius], [...kit(".m-row", "min-height"), ...kit(".m-row", "padding"), ...kit(".m-row", "gap"), ...kit(".m-group .m-row", "border-radius")]],
    ["Fold search result row", [s.folderRow.minHeight, s.folderRow.paddingVertical, s.folderRow.paddingHorizontal, s.folderRow.gap, s.folderRow.borderRadius], [...kit(".m-srch-hit", "min-height"), ...kit(".m-srch-hit", "padding"), ...kit(".m-srch-hit", "gap"), ...kit(".m-srch-hit", "border-radius")]],
    ["rail", [fold.navigation.width, fold.navigation.paddingTop, fold.navigation.paddingHorizontal, fold.navigation.padding], [...kit(".m-sidebar.m-compact", "width"), ...kit(".m-sidebar.m-compact", "padding")]],
  ];
  for (const [name, app, drawn] of pairs) assert.deepEqual(drawn, app, name);
  assert.deepEqual(
    rivals(),
    [
      ".m-labelled .m-nav-item also sets gap of .m-nav-item",
      ".m-nav-item also sets padding of .m-labelled .m-nav-item",
      ".m-player .m-cover also sets width of .m-album-head .m-cover",
      ".m-srch-hit .m-cover also sets width of .m-album-head .m-cover",
      ".m-player .m-cover also sets width of .m-fold .m-album-head .m-cover",
      ".m-srch-hit .m-cover also sets width of .m-fold .m-album-head .m-cover",
      ".m-actions-row also sets margin-top of .m-album-head .m-actions-row",
      ".m-fp-pane > .m-group also sets background of .m-group",
      ".m-fp-pane > .m-group also sets border of .m-group",
      ".m-fp-pane > .m-group also sets border-radius of .m-group",
      ".m-row also sets border-radius of .m-group .m-row",
    ],
    "no other kit rule sets a compared property on the same class, beyond these that target other elements or a base the compared rule overrides",
  );
});

test("the decided phone geometry: display headline, 64 dp Now playing header, flat cover, grouped 74 dp search rows", async () => {
  const { s, g } = await phoneStyles();
  const { s: fold } = await phoneStyles(1, true, true);
  const css = fs.readFileSync(new URL("../design/mobile.css", import.meta.url), "utf8");
  const page = fs.readFileSync(new URL("../design/mobile.html", import.meta.url), "utf8");
  assert.deepEqual([s.displayTitle.fontSize, s.displayTitle.lineHeight, s.displayTitle.fontFamily], [g.touchDisplayFont, g.touchDisplayLine, "Manrope_700Bold"]);
  assert.deepEqual([g.touchDisplayFont, g.touchDisplayLine], [28, 34]);
  assert.match(css, /\.m-display \{\s+font-size: var\(--m-touch-display-font\);\s+line-height: var\(--m-touch-display-line\);/);
  assert.equal(s.searchThumbs.gap, 4);
  assert.equal(s.fileActionMenu.paddingVertical, 8);
  for (const styles of [s, fold]) {
    assert.equal(2 * styles.nowHeader.paddingVertical + styles.viewerIconButtonDark.height, 64);
    assert.equal(styles.nowHeader.minHeight, undefined);
    assert.equal(styles.nowHeader.paddingHorizontal, 12);
    assert.equal(styles.nowFrom.gap, undefined);
  }
  assert.doesNotMatch(css, /\.m-np-from \{[^}]*gap:/);
  assert.match(read("NowPlayingPage.jsx"), /<View style=\{s\.nowHeader\} \{\.\.\.swipe\.panHandlers\}>\s+<Pressable accessibilityRole="button" accessibilityLabel="Close now playing" onPress=\{onClose\} style=\{s\.viewerIconButtonDark\}>[\s\S]+?<\/Pressable>\s+<View style=\{s\.nowFrom\}>\s+<Eyebrow>Playing from<\/Eyebrow>\s+<Text numberOfLines=\{1\} style=\{s\.rowTitle\}>[\s\S]+?<\/View>\s+\{!!state\?\.id && <SleepButton sleep=\{sleep\} podcast=\{podcast\} onPress=\{\(\) => setSleepOpen\(true\)\} \/>\}\s+<\/View>/);
  assert.equal(s.musicCover.borderRadius, g.controlRadius);
  assert.equal(s.musicCover.shadowColor, undefined);
  assert.doesNotMatch(css, /\.m-np-cover \{[^}]*shadow/);
  assert.equal(s.searchRow, undefined);
  assert.equal(s.folderRow.minHeight, 74);
  const search = read("GlobalSearch.jsx");
  assert.match(search, /style=\{\[s\.folderRow, grouped && s\.groupedFolderRow, divider && s\.separator, active && s\.historyRowChosen\]\}/);
  assert.match(search, /const grouped = !twoPane;/);
  assert.match(search, /const rows = entries\.map\(\(entry, at\) => render\(entry, grouped && at > 0\)\);\s+return grouped && rows\.length \? <View style=\{s\.group\}>\{rows\}<\/View> : rows;/);
  assert.match(search, /const section = twoPane \? s\.searchGroup : s\.section;/);
  assert.match(search, /contentContainerStyle=\{twoPane \? s\.searchBody : s\.searchSections\}/);
  assert.match(search, /\{trailing === undefined \? <Icon name="chevron" size=\{20\} color=\{c\.mute\} \/> : trailing\}/);
  assert.match(search, /<Icon name="play" size=\{twoPane \? 16 : 20\} color=\{c\.accent\} \/>/);
  assert.match(search, /\{surface\(cells\.length \? lines : \[\.\.\.lines, \.\.\.paging\], resultRow\)\}\s+\{!!cells\.length && \(\s+<View style=\{\[s\.searchThumbs, twoPane && s\.searchThumbsFlat\]\}>[\s\S]+?\{!!cells\.length && surface\(paging, resultRow\)\}/);
  assert.equal((search.match(/\bsurface\(/g) || []).length, 5);
  const screens = page.slice(page.indexOf("<h2>Search <span>"));
  const phone = screens.slice(0, screens.indexOf('class="m-device m-fold"'));
  assert.ok((phone.match(/data-icon="chevron-right" data-size="20"/g) || []).length > 0);
  assert.doesNotMatch(phone, /data-icon="chevron-right" data-size="(?!20)\d+"/);
  assert.doesNotMatch(phone, /class="m-srch-hit/);
  const searching = page.split("\n").filter((line) => line.includes("m-srch")).join("\n");
  const led = '<div class="m-setting m-line"><div class="m-tile"><span data-icon="[a-z0-9-]+" data-size="16"><\\/span><\\/div><div class="m-stack m-grow"><span class="m-row-title">';
  assert.equal(searching.split('<div class="m-setting m-line">').length - 1, 9);
  assert.equal((searching.match(new RegExp(led, "g")) || []).length, 9, "a recent search, an action and Show all lead with the app's tile and row title");
  assert.match(search, /<View style=\{\[s\.tile, item\.type === "artist" && s\.searchCoverRound\]\}>\s+<Icon name=\{[^}]+\} size=\{16\} color=\{c\.accent\} \/>/);
  const { kit } = await kitRules();
  assert.deepEqual(kit(".m-srch-sel", "background"), [s.historyRowChosen.backgroundColor], "the Fold's chosen result is filled as the app fills it");
  for (const hit of phone.match(/<div class="m-row">.*?<div class="m-row-action">/g) || []) assert.match(hit, /<div class="m-stack"><span class="m-row-title">[^<]+<\/span><span class="m-caption">/);
});

test("the Fold's header tile and the rail keep the geometry the spec states", async () => {
  const { s, g } = await phoneStyles(1, true, true);
  assert.equal(s.detailTile.borderRadius, g.tileRadiusLarge);
  assert.equal(s.detailTile.borderRadius, Math.round(g.detailTile * 0.225));
  assert.equal(s.navigation.width - 2 * s.navigation.paddingHorizontal, 60);
  const { s: wide } = await phoneStyles(1, true, false);
  assert.equal(wide.navigation.paddingHorizontal, wide.navigation.padding);
});

test("the kit's mini player and Now playing follow the app's structure", async () => {
  const { s } = await phoneStyles();
  const { raw } = await kitRules();
  const page = fs.readFileSync(new URL("../design/mobile.html", import.meta.url), "utf8");
  const players = page.match(/<div class="m-player-controls">.*?<\/div>/g);
  assert.ok(players.length > 0);
  for (const player of players) assert.match(player, /^<div class="m-player-controls">(<span class="m-player-control"><span data-icon="[\w-]+" data-size="22"><\/span><\/span>){2}<\/div>$/);
  assert.equal((read("MusicLibrary.jsx").match(/style=\{s\.miniControl\}/g) || []).length, 2);
  const links = page.match(/<div class="m-np-links">.*?<\/div>/g);
  assert.ok(links.length > 0);
  for (const link of links) assert.match(link, /^<div class="m-np-links">(<span class="m-np-link">[^<]+<\/span>){1,2}<\/div>$/);
  assert.match(read("NowPlayingPage.jsx"), /<View style=\{\[s\.stack, s\.nowPlayingText\]\}>\s+<Text numberOfLines=\{2\} style=\{\[s\.title, s\.centerText\]\}>/);
  assert.equal(raw(".m-np-meta", "text-align"), "center");
  const cover = read("NowPlayingPage.jsx").match(/size=\{twoPane \? (\d+) : Math\.min\(width - (\d+), (\d+)\)\}/);
  assert.equal(cover[1], cover[3]);
  assert.equal(raw(".m-np-cover", "width"), `min(100% - ${Number(cover[2]) - 2 * s.nowPage.paddingHorizontal}px, ${cover[3]}px)`);
});

test("small icons in pills, tags and chips leave whole-pixel insets", async () => {
  const { g } = await phoneStyles();
  for (const box of [g.pillLine, g.pillLine + 2 * g.pillY, g.tagHeight - 2 * g.tagY - 2, g.touchCaptionLine]) assert.equal((box - g.pillIcon) % 2, 0, `${g.pillIcon} in ${box}`);
  assert.equal((g.buttonSmallHeight - g.chipIcon) % 2, 0);
  assert.match(read("NowPlayingPage.jsx"), /<Icon name="moon" size=\{g\.chipIcon\}/);
  assert.match(read("components.jsx"), /<Icon name="shield-check" size=\{g\.pillIcon\}/);
});
