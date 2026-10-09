import { noticeMetrics } from "../apps/desktop/src/notice-contract.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { coalescedRun } from "../apps/mobile/src/folder-listing.js";
import { browseEntries } from "../apps/mobile/src/browse.js";
import { sidebarLayout, fileMenuPosition } from "../apps/mobile/src/layout.js";
import { icons, iconNames } from "../apps/mobile/src/icons.js";
import { musicSheet } from "../apps/mobile/src/music-library.js";

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
    control: "control",
    segmentTrack: "segmentTrack",
    segmentSelected: "segmentSelected",
    divider: "div",
    accent: "green",
    onAccent: "onGreen",
    tint: "tint",
    okFg: "okFg",
    hover: "hover",
    placeholder: "placeholder",
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
      assert.equal(s.statValue.fontSize, geometry.touchRowFont, "summary values read like row titles, not headings");
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

test("mobile folder refresh retains its cached files and never paints an older folder read", async () => {
  const source = fs.readFileSync(
    new URL("../apps/mobile/src/App.jsx", import.meta.url),
    "utf8",
  );
  const method = source.slice(
    source.indexOf("  function listFiles("),
    source.indexOf("  const notices ="),
  );
  let entries, release;
  const painted = [];
  const persisted = [];
  const cache = new Map([["hub:A", [{ path: "last-known.jpg", size: 20 }]]]);
  const context = {
    engine: {
      current: {
        scope: "hub",
        store: {
          get: async (key, fallback) =>
            key === "gallery-list:hub:B"
              ? [{ path: "disk-cached.jpg" }]
              : fallback,
          set: async (key, value) => {
            persisted.push({ key, value });
          },
        },
        files: {
          folder: (scope, id) => id,
          exists: async () => true,
          walk: async function* (id) {
            if (id === "A")
              await new Promise((resolve) => {
                release = resolve;
              });
            yield { path: `${id}.jpg`, size: 30 };
          },
        },
      },
    },
    mounted: { current: true },
    listing: { current: new Map() },
    shownFolder: { current: "hub:A" },
    coalescedRun,
    folderLists: { current: cache },
    setEntries: (value) => {
      entries = value;
      painted.push(value);
    },
    setFilesLoading: () => {},
  };
  vm.createContext(context);
  vm.runInContext(method + "\nthis.readFolder = listFiles;", context);
  const oldRead = context.readFolder("A");
  assert.equal(entries[0].path, "last-known.jpg");
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  context.shownFolder.current = "hub:B";
  const newRead = context.readFolder("B");
  assert.equal(
    entries.length,
    0,
    "a new folder must not show the previous folder's files",
  );
  await newRead;
  assert.ok(
    painted.some((rows) => rows[0]?.path === "disk-cached.jpg"),
    "saved entries paint before the filesystem scan finishes",
  );
  assert.equal(persisted[0].key, "gallery-list:hub:B");
  release();
  await oldRead;
  assert.equal(entries[0].path, "B.jpg", "the older folder's walk never paints over the shown folder");
  assert.equal(cache.get("hub:A")[0].path, "A.jpg", "the finished walk is kept for when that folder opens again");
  const repeat = context.readFolder("B");
  assert.equal(entries[0].path, "B.jpg");
  await repeat;
});

test("file dropdown stays inside narrow screens and aligns below its trigger", () => {
  for (const width of [320, 390, 768]) {
    for (const x of [0, width - 44]) {
      const menu = fileMenuPosition(x, 80, 44, 44, width);
      assert.ok(menu.left >= 16);
      assert.ok(menu.left + menu.width <= width - 16);
      assert.equal(menu.top, 130);
    }
  }
});

test("app text size scales typography without zooming layout or icons", async () => {
  const { geometry } = await import("../apps/mobile/src/design-tokens.js");
  const { palettes } = await import("../apps/mobile/src/palette.js");
  const { textSizes, textScale } =
    await import("../apps/mobile/src/text-size.js");
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
    StyleSheet: { create: (v) => v, absoluteFillObject: {} },
  };
  vm.runInNewContext(source + ";this.makeStyles = styles;", context);
  for (const wide of [false, true]) {
    const base = context.makeStyles(palettes.light, wide, false, 1);
    for (const { value } of textSizes) {
      const scaled = context.makeStyles(palettes.light, wide, false, 1, value);
      assert.equal(scaled.title.fontSize, base.title.fontSize * value);
      assert.equal(scaled.caption.lineHeight, base.caption.lineHeight * value);
      assert.equal(
        scaled.buttonLabel.fontSize,
        base.buttonLabel.fontSize * value,
      );
      assert.equal(scaled.iconButton.width, base.iconButton.width);
      assert.equal(scaled.detailTile.width, base.detailTile.width);
      assert.equal(scaled.content.padding, base.content.padding);
      assert.ok(scaled.input.height >= 26 * value + 18);
    }
  }
  for (const invalid of [null, undefined, "garbage", -1, 2, Infinity])
    assert.equal(textScale(invalid), 1);
  assert.equal(textScale("1.15"), 1.15);
});


test("closing folder actions retain their title after local removal without rendering stale actions", () => {
  const app = fs.readFileSync(new URL("../apps/mobile/src/App.jsx", import.meta.url), "utf8");
  const header = app.slice(app.indexOf("{shownSheet && (")).match(/\{\.\.\.(\(shownSheet\.kind === "rename-file"[\s\S]*?\))\}\s+busy=/)[1];
  const actions = app.match(/\{(shownSheet.kind === "folder-actions"[^{]*?) && \(/)[1];
  const volume = { id: "removed-share", name: "photos-demo", selected: 1 };
  assert.match(app, /setSheet\(\{\s*kind: "folder-actions",\s*volume: folder,?\s*\}\)/);
  const shownSheet = { kind: "folder-actions", volume };
  const shown = vm.runInNewContext(header, {
    shownSheet,
    folder: null,
    photoFolder: false,
    musicFolder: false,
    folderSubtitle: "",
    bytes: () => "",
  });
  assert.equal(shown.title, "photos-demo");
  assert.equal(shown.menu, true, "folder actions are a compact menu");
  assert.equal(shown.icon, "folder");
  assert.equal(
    vm.runInNewContext(header, { shownSheet, folder: null, photoFolder: false, musicFolder: true, folderSubtitle: "", bytes: () => "" }).icon,
    "music",
  );
  assert.equal(vm.runInNewContext(actions, { shownSheet, folder: volume }), true);
  assert.equal(vm.runInNewContext(actions, { shownSheet, folder: null }), false);
  assert.equal(vm.runInNewContext(actions, { shownSheet, folder: { id: "other" } }), false);
});

test("sheets share the desktop dialog header anatomy and menus stay compact", () => {
  const components = fs.readFileSync(new URL("../apps/mobile/src/components.jsx", import.meta.url), "utf8");
  const theme = fs.readFileSync(new URL("../apps/mobile/src/theme.js", import.meta.url), "utf8");
  const sheet = components.slice(components.indexOf("export function Sheet("), components.indexOf("export function ConfirmDialog("));
  assert.match(sheet, /\{!dialog && <View style=\{s\.sheetHandle\} \/>\}/, "every bottom sheet shows its handle");
  assert.match(sheet, /<View style=\{s\.tile\}>\s*<Icon name=\{icon\}/);
  assert.match(sheet, /\{!!subtitle && \(/);
  assert.match(sheet, /\{subtitle\}[\s\S]*?<Button\s+label="Close"/, "every titled sheet, menus included, has an explicit Close like desktop dialogs");
  assert.doesNotMatch(sheet, /!menu && \(\s*<Button/);
  assert.match(sheet, /contentContainerStyle=\{menu \? s\.sheetMenu : s\.content\}/);
  assert.match(theme, /sheetHeader: \{[^}]*paddingHorizontal: wide \? g\.workspaceInset : 16,[^}]*borderBottomWidth: 1/);
  assert.match(theme, /actionRow: \{[^}]*minHeight: g\.touchControlHeight,[^}]*paddingHorizontal: wide \? g\.workspaceInset : 16,/, "action rows align with the sheet title");
  const app = fs.readFileSync(new URL("../apps/mobile/src/App.jsx", import.meta.url), "utf8");
  const header = app.slice(app.indexOf("{shownSheet && (")).match(/\{\.\.\.(\(shownSheet\.kind === "rename-file"[\s\S]*?\))\}\s+busy=/)[1];
  for (const kind of ["rename-file", "gallery", "history-filter", "folder-actions", "select", "conflict"]) {
    const shown = vm.runInNewContext(header, {
      shownSheet: { kind, path: "a/b.jpg", volume: { name: "photos", bytes: 1 }, original: { path: "a/c.jpg" } },
      folder: { name: "photos" },
      photoFolder: true,
      folderSubtitle: "3598 photos · 13 GB local",
      bytes: () => "1 B",
      folderSize: () => "1 file · 1 B",
    });
    assert.ok(shown.title && shown.icon, kind);
  }
  for (const kind of ["track-actions", "add-to-playlist", "new-playlist", "playlist-actions", "rename-playlist"]) {
    const shown = vm.runInNewContext(header, {
      shownSheet: { kind, track: { title: "So What", artist: "Miles Davis", album: "Kind of Blue" }, playlist: { name: "Road trip", tracks: [], duration: 0 } },
      musicSheet,
    });
    assert.ok(shown.title && shown.icon, kind);
  }
});

test("local Open and Share stay available while hub-bound actions hold the action lock", () => {
  const app = fs.readFileSync(new URL("../apps/mobile/src/App.jsx", import.meta.url), "utf8");
  const open = app.slice(app.indexOf('label="Open"'), app.indexOf("/>", app.indexOf('label="Open"')));
  assert.match(open, /onPress=\{\(\) => runLocal\(openCurrentFile\)\}/);
  assert.doesNotMatch(open, /actionLocked/);
  const share = app.slice(app.indexOf('label="Share"'), app.indexOf("/>", app.indexOf('label="Share"')));
  assert.match(share, /runLocal\(shareCurrentFile\)/);
  assert.match(
    app.slice(app.indexOf("async function runLocal"), app.indexOf("async function run(")),
    /retryAction\.current = \(\) => runLocal\(work\)/,
    "a failed local action retries itself, never an older action",
  );
  assert.doesNotMatch(share, /actionLocked|\brun\(/);
  const exporting = app.slice(app.indexOf('label="Export folder…"'), app.indexOf("/>", app.indexOf('label="Export folder…"')));
  assert.match(exporting, /disabled=\{actionLocked\}/);
  assert.doesNotMatch(exporting, /status\.busy|\blocked\b/);
  assert.match(exporting, /await engine\.current\.settle\(\);/);
  const restoreSelected = app.slice(app.indexOf('label="Restore selected"'), app.indexOf("/>", app.indexOf('label="Restore selected"')));
  assert.match(restoreSelected, /status\.offline/);
  const history = fs.readFileSync(new URL("../apps/mobile/src/FileHistory.jsx", import.meta.url), "utf8");
  assert.equal((history.match(/!reachable/g) || []).length, 2);
  assert.match(app, /offline=\{status\.offline \|\| !!fileHistory\.offline\}/);
});

test("sheets close only through their parent and never become invisible touch traps", () => {
  const components = fs.readFileSync(new URL("../apps/mobile/src/components.jsx", import.meta.url), "utf8");
  const sheet = components.slice(components.indexOf("export function Sheet("), components.indexOf("export function ConfirmDialog("));
  const dismiss = sheet.slice(sheet.indexOf("const dismiss = () => {"), sheet.indexOf("};", sheet.indexOf("const dismiss = () => {")));
  assert.match(dismiss, /if \(busy \|\| leaving\.current\) return;/);
  assert.doesNotMatch(dismiss, /animate\(/);
  assert.match(sheet, /pointerEvents=\{closing \? "none" : "auto"\}/);
  assert.match(sheet, /disabled=\{busy\}\s+onPress=\{dismiss\}/);
  assert.match(sheet, /else if \(leaving\.current\) \{\s+leaving\.current = false;\s+animate\(1, motion\.enter\);/);
  const approval = components.slice(components.indexOf("export function ApprovalSheet("));
  assert.match(approval, /closing=\{closing\}\s+onExited=\{onExited\}/);
  assert.match(approval, /String\(request\.reference \|\| ""\)/);
  const app = fs.readFileSync(new URL("../apps/mobile/src/App.jsx", import.meta.url), "utf8");
  assert.match(app, /useRetained\(approvalRequest\)/);
  assert.match(app, /closing=\{!approvalRequest\}\s+onExited=\{releaseApproval\}/);
});

test("the mobile root renders behind a self-contained error boundary", () => {
  const index = fs.readFileSync(new URL("../apps/mobile/index.js", import.meta.url), "utf8");
  assert.match(index, /React\.createElement\(ErrorBoundary, null, React\.createElement\(App\)\)/);
  const boundary = fs.readFileSync(new URL("../apps/mobile/src/ErrorBoundary.jsx", import.meta.url), "utf8");
  assert.match(boundary, /static getDerivedStateFromError/);
  assert.match(boundary, /SplashScreen\.hideAsync\(\)/);
  assert.match(boundary, /safeDetails\(/);
  assert.doesNotMatch(boundary, /from "\.\/components"|useDesign|Design\b/);
});

test("cancelling a stalled share frees later shares and a superseded read never clears them", () => {
  const share = fs.readFileSync(new URL("../apps/mobile/src/IncomingShare.jsx", import.meta.url), "utf8");
  const receive = share.slice(share.indexOf("async function receive()"), share.indexOf("receive();"));
  assert.match(receive, /const current = \+\+attempt\.current;/);
  assert.match(receive, /if \(superseded\(\)\) return;\s+Sharing\.clearSharedPayloads\(\);/);
  assert.match(receive, /finally \{\s+if \(!superseded\(\)\) \{/);
  const discard = share.slice(share.indexOf("async function discard()"), share.indexOf("const destinations"));
  assert.match(discard, /attempt\.current\+\+;\s+receiving\.current = false;\s+setPreparing\(false\);/);
});

test("offline onboarding selects from the saved catalog and Folders never shows an endless skeleton offline", () => {
  const app = fs.readFileSync(new URL("../apps/mobile/src/App.jsx", import.meta.url), "utf8");
  const download = app.slice(app.indexOf("await client.refresh().catch((error) => {"), app.indexOf("await selectFirstFolders("));
  assert.match(download, /!client\.state\(\)\.catalog \|\|\s+!isHubUnreachable\(error\)/);
  assert.match(app, /connected && !catalog && !status\.offline && \(\s+<Scaffold dashed label="Loading shared folders" \/>/);
});

test("folder problems use notices that reappear when the folder opens, not inline captions", () => {
  const app = fs.readFileSync(new URL("../apps/mobile/src/App.jsx", import.meta.url), "utf8");
  const caption = app.slice(app.indexOf("const timelineNotice"), app.indexOf("const timeline ="));
  assert.doesNotMatch(caption, /Folder synchronization:|Photo uploads:/);
  assert.match(caption, /Photo uploads are disabled for this album\./);
  assert.match(app, /for \(const kind of \["folder", "photo-uploads"\]\)\s+notices\.clear\(`status:\$\{kind\}:\$\{folder\.id\}`\);/);
  assert.match(app, /\}, \[error, status\.error, locals, state\.catalog, notices, folder\?\.id\]\);/);
});

test("the gallery windows rows over the whole timeline and only ever loads by scrolling", () => {
  const app = fs.readFileSync(new URL("../apps/mobile/src/App.jsx", import.meta.url), "utf8");
  const gallery = fs.readFileSync(new URL("../apps/mobile/src/FolderGallery.jsx", import.meta.url), "utf8");
  const rail = fs.readFileSync(new URL("../apps/mobile/src/GalleryDateRail.jsx", import.meta.url), "utf8");
  assert.match(app, /<FolderGallery[^>]*columns=\{wide \? 6 : 4\}/);
  assert.match(gallery, /const density = levelColumns\(level, columns\);/);
  assert.doesNotMatch(gallery, /useState\(columns\)/);
  assert.match(gallery, /galleryWindow\(layout, range\.top, range\.bottom\)/);
  assert.doesNotMatch(gallery, /Show more|Load more|setLimit/);
  assert.doesNotMatch(app, /timelineDemand|nearEnd/);
  assert.doesNotMatch(rail, /dateRailTick/);
  assert.doesNotMatch(rail, /scrollY\.interpolate/, "the thumb follows the finger, not the native scroll value");
  assert.match(app, /<FolderGallery[^>]*offline=\{!!status\.offline\}/, "paired is not online: the gallery needs the offline state");
  assert.match(gallery, /const linked = connected && !offline;/);
  assert.match(gallery, /const base = gallery && \(online \|\| !local\.total\) \? gallery : local;/);
  assert.match(gallery, /base\.local \? base : withLocalOnly\(base, entries, known, ignored\)/, "photos only on the phone join the hub index");
  assert.match(gallery, /builtinExcluded\(path\) \|\| \(online && !!ignored\?\.\(path\)\)/, "ignored photos get no preview work while the hub index is shown");
  assert.match(app, /photoFolder \|\| fileView === "gallery"/, "ordinary folders' Gallery tab reads the policy too");
  assert.match(app, /stat\.size <= 65536/, "a policy the sync engine would refuse is not applied");
  assert.match(app, /ignoreText=\{ignorePolicy\.id === folder\.id \? ignorePolicy\.text : ""\}/, "another folder's policy is never applied");
  assert.match(gallery, /online\s*\?\s*NO_LOCAL_GALLERY\s*:\s*localGallery\(entries, \{ cached: gallery, rows: known \}\)/, "offline photos keep the cached dates and the phone index revisions, and online never builds the local gallery");
  assert.doesNotMatch(gallery, /current\.source !== current\.gallery/, "a merged source is a new object; remote mode is online with a hub gallery");
  assert.match(gallery, /neededMonth\(\s*current\.layout,\s*current\.source\.months/, "paging reads the merged months so local-only months never ask the hub");
  assert.match(gallery, /!current\.online \|\|/);
  assert.match(gallery, /\[\s*onRail,\s*railShape,/, "the rail model republishes on shape changes, not on every loaded page");
  assert.match(rail, /onResponderMove[\s\S]*place\(next\)[\s\S]*requestAnimationFrame/);
});

test("every gallery surface shares one placeholder: the token fill and a soft image or play glyph", () => {
  const read = (file) => fs.readFileSync(new URL(`../apps/${file}`, import.meta.url), "utf8");
  const theme = read("mobile/src/theme.js");
  const components = read("mobile/src/components.jsx");
  const css = read("desktop/src/style.css");
  for (const file of ["FolderGallery.jsx", "GalleryYear.jsx", "GallerySource.jsx"]) {
    const source = read(`mobile/src/${file}`);
    assert.match(source, /<MediaPlaceholder/, file);
    assert.doesNotMatch(source, /galleryPlaceholder/, file);
  }
  assert.match(components, /size >= PLACEHOLDER_GLYPH_MIN[\s\S]*video \? "play" : "image"[\s\S]*color=\{c\.line\}/);
  for (const name of ["photoTile", "yearTile", "mediaPlaceholder"])
    assert.match(theme, new RegExp(`${name}: \\{[^}]*backgroundColor: c\\.placeholder`), name);
  assert.match(css, /\.photo-thumb \{[^}]*background: var\(--placeholder\);/);
  assert.match(css, /\.photo-open \{[^}]*background: var\(--placeholder\);\s*color: var\(--line\);/);
});

test("folder rows show the gallery icon the hub assigns and selection states the space it needs", () => {
  const app = fs.readFileSync(new URL("../apps/mobile/src/App.jsx", import.meta.url), "utf8");
  const selected = app.slice(app.indexOf("{locals.map((f) => ("), app.indexOf("description={`${f.files} files"));
  assert.match(selected, /galleryConfig\(f\) \|\|\s*f\.gallery \|\|\s*catalog\?\.volumes\?\.find\(/);
  assert.match(app, /available\s+icon=\{v\.gallery \? "gallery" : v\.music && catalog\?\.music \? "music" : "folders"\}/);
  assert.match(app, /`Needs \$\{bytes\(shownSheet\.volume\.bytes\)\} · `/);
  assert.match(app, /shownSheet\.kind === "select"\s*\?\s*\{\s*title: shownSheet\.volume\.name,\s*icon: shownSheet\.volume\.gallery \? "gallery" : shownSheet\.volume\.music && catalog\?\.music \? "music" : "folder",/);
  assert.doesNotMatch(app, /free here/);
});

test("the mobile gallery renders from local files first and asks the hub only for photos on the phone that fail", () => {
  const gallery = fs.readFileSync(new URL("../apps/mobile/src/FolderGallery.jsx", import.meta.url), "utf8");
  assert.doesNotMatch(gallery, /hub-previews|hubPreview\(/, "the removed browsing previews stay removed");
  assert.match(gallery, /render: withHub\(\(item\) =>\s*item\.kind === "video"\s*\? thumbnailFiles\.poster\(item\)\s*: displayRef\.current\(item\),\s*\),/);
  assert.match(gallery, /hashOf: \(item, large\) =>\s*accepted\(hubContext\.current\.known, item, large\),/, "hub previews verify the local content through the memo");
  assert.match(gallery, /createAccepted\(\{ hashFile: \(uri\) => files\.hash\(uri\) \}\)/);
  assert.match(gallery, /previews\.clear\(\);\s+accepted\.clear\(\);/, "forgetting refusals forgets verifications");
  assert.match(gallery, /busy: \(error\) => \[409, 429\]\.includes\(error\.status\),/);
  assert.match(gallery, /linked: hubContext\.current\.linked,/);
  assert.match(gallery, /const online = linked && failures < 2;/);
  assert.match(gallery, /setGallery\(fresh\);\s*setFailures\(0\);/);
  assert.match(gallery, /setFailures\(\(count\) => count \+ 1\);\s*setError\(e\.message\);/);
  assert.equal(fs.existsSync(new URL("../apps/mobile/src/hub-previews.js", import.meta.url)), false);
  const thumbnails = fs.readFileSync(new URL("../apps/mobile/src/gallery-thumbnails.js", import.meta.url), "utf8");
  assert.match(thumbnails, /fromHub\(entry, variant, load\) \{/);
  assert.match(thumbnails, /toByteArray\(await hubLimiter\.run\(load\)\)/);
  assert.match(gallery, /if \(state === "active"\) \{\s+previews\.clear\(\);\s+accepted\.clear\(\);\s+\}/);
  assert.match(gallery, /thumbnailFiles\.retry\(\);\s*previews\.clear\(\);/);
});

test("recent versions wait for the replica runtime before loading", () => {
  const app = fs.readFileSync(new URL("../apps/mobile/src/App.jsx", import.meta.url), "utf8");
  const start = app.indexOf("<FolderRecent");
  const recent = app.slice(start, app.indexOf("/>", start));
  assert.match(recent, /connected=\{connected && !!replica\}/);
  assert.match(recent, /load=\{\(route\) => replica\.remoteView\(route\)\}/);
  assert.doesNotMatch(recent, /engine\.current/);
  const component = fs.readFileSync(new URL("../apps/mobile/src/FolderRecent.jsx", import.meta.url), "utf8");
  assert.match(component, /if \(connected\)\s+load\(/);
});

test("mobile machine view waits for runtime and ignores responses after effect cleanup", async () => {
  const app = fs.readFileSync(new URL("../apps/mobile/src/App.jsx", import.meta.url), "utf8");
  const start = app.indexOf("  useEffect(() => {\n    let cancelled = false;");
  const effect = app.slice(start).match(/useEffect\(\(\) => \{([\s\S]*?)\n  \}, \[([^\]]+)\]\);/);
  assert.ok(effect, "machine view effect is present");
  assert.match(effect[2], /\breplica\b/, "runtime readiness retriggers the effect even with an unchanged cached connection");
  assert.match(effect[2], /status\.offline/, "the hub coming back reloads the machines");
  assert.match(app, /engine\.current = await runtime\(\);\s*if \(!mounted\.current\) return;\s*setReplica\(engine\.current\);/);
  let shown = "old", saved = "old", loaded = "old", requests = 0, finish;
  const context = {
    screen: "Folders", connected: true, replica: null, engine: { current: null },
    setMachines: (value) => { shown = value; },
    setMachinesSaved: (value) => { saved = value; },
    setMachinesLoaded: (value) => { loaded = value; },
  };
  const run = () => vm.runInNewContext(`(() => {${effect[1]}\n})()`, context);
  assert.doesNotThrow(run, "cached linked state can precede the async runtime");
  assert.equal(shown, null);
  assert.equal(loaded, false, "no answer yet, so no empty frame");
  context.replica = { remoteView: () => { requests++; return new Promise((resolve) => { finish = resolve; }); } };
  const cleanup = run();
  assert.equal(requests, 1);
  finish({ machines: ["Fold"], offline: true });
  await new Promise(setImmediate);
  assert.deepEqual(shown, ["Fold"]);
  assert.equal(loaded, true, "an answer, even an empty one, lets the empty frame show");
  assert.equal(saved, true, "the saved-data label follows the response's own flag");
  const again = run();
  finish({ machines: ["Fold"] });
  await new Promise(setImmediate);
  assert.equal(saved, false, "a live answer clears the saved-data label");
  again();
  cleanup();
  const cancelled = run();
  cancelled();
  finish({ machines: ["stale"] });
  await new Promise(setImmediate);
  assert.deepEqual(shown, ["Fold"]);
});

test("video posters are prepared after photos and never retried for an unchanged file", () => {
  const gallery = fs.readFileSync(new URL("../apps/mobile/src/FolderGallery.jsx", import.meta.url), "utf8");
  const thumbnails = fs.readFileSync(new URL("../apps/mobile/src/gallery-thumbnails.js", import.meta.url), "utf8");
  assert.match(gallery, /\.map\(withNative\)\s*\.sort\(\(a, b\) => \(a\.kind === "video"\) - \(b\.kind === "video"\)\)/);
  assert.match(thumbnails, /return posterAttempt\(`\$\{uri\}:\$\{item\.size\}:\$\{item\.mtime\}`,/);
  assert.match(thumbnails, /if \(state === "active"\) \{\s+posterAttempt\.clear\(\);\s+renderAttempt\.clear\(\);\s+\}/);
});

test("opening a video in the viewer starts local playback without a second tap", () => {
  const video = fs.readFileSync(new URL("../apps/mobile/src/GalleryVideo.jsx", import.meta.url), "utf8");
  assert.match(video, /if \(active && video\)\s*resolveVideo\(item\)/);
  assert.match(video, /\{active && video && !error \? \(\s*<Busy/);
  assert.doesNotMatch(video, /active && attempt|setAttempt\(0\)/);
  assert.match(video, /\}, \[active, attempt, item\.path, item\.hash\]\);/);
  const viewer = fs.readFileSync(new URL("../apps/mobile/src/PhotoViewer.jsx", import.meta.url), "utf8");
  assert.match(viewer, /active=\{visible && position === index\}\s*held=\{infoOpen\}/, "Info holds playback instead of unmounting it");
  assert.match(video, /holdVideoPlayback\(player, held, hold\.current\);/);
  assert.match(video, /setLoadError,\s*\(\) => heldRef\.current,/);
});

test("phone hub-only actions say why they are unavailable offline and use the hub-only notice wording", () => {
  const read = (file) => fs.readFileSync(new URL(`../apps/mobile/src/${file}`, import.meta.url), "utf8");
  const app = read("App.jsx");
  const gallery = read("FolderGallery.jsx");
  const viewer = read("PhotoViewer.jsx");
  const components = read("components.jsx");
  assert.match(gallery, /deletable=\{!!remove && linked\}/);
  assert.match(gallery, /deleteReason=\{linked \? undefined : HUB_ONLY_REASON\}/);
  assert.match(gallery, /label=\{`Delete \$\{selection\.length\} selected…`\}\s+danger\s+disabled=\{!linked\}/);
  assert.match(gallery, /<\/View>\s+\{!linked && <Text style=\{s\.caption\}>\{HUB_ONLY_REASON\}<\/Text>\}\s+<\/View>\s+\)\}/, "the reason sits under the button row, never inside it");
  assert.match(components, /accessibilityHint=\{note\}/);
  assert.match(viewer, /deleteReason \|\|\s+"Available after the hub confirms the photo/);
  assert.match(app, /note=\{!source && status\.offline \? HUB_ONLY_REASON : undefined\}/);
  assert.match(components, /note \? \(\s+<View style=\{s\.flex\}>[\s\S]*?<Text style=\{s\.caption\}>\{note\}<\/Text>/);
  for (const marker of [
    /\{ success: "Photos deleted", hubOnly: true \}/,
    /\}, \{ hubOnly: true \}\),\s+"Restore",/,
    /retry=\{\(\) => run\(\(\) => client\.refresh\(\), \{ hubOnly: true \}\)\}/,
    /\{ hubOnly: true \},\s+\)\s+\}\s+loadMore/,
    /label: "Restoring selected version…",\s+hubOnly: true,/,
    /setView\("Folders"\);\s+\}, \{ hubOnly: true \}\)/,
    /label: source \? "Saving changes…" : "Enabling uploads…",\s+hubOnly: true,/,
  ])
    assert.match(app, marker);
  assert.match(app, /errorCode\.current = \{ message, code: e\.code, hubOnly: !!options\.hubOnly \}/);
  assert.match(app, /hubOnly:\s+errorCode\.current\.message === error && !!errorCode\.current\.hubOnly/);
  assert.match(app, /title: "Disconnect pending"/);
  assert.match(app, /title: "Name saved on this device"/);
  assert.match(app, /It is used when this phone connects to a hub\./);
  assert.doesNotMatch(app, /Connect to the hub and try again\./, "an offline rename is confirmed, not reported as an error");
});

test("offline file detail leads with the phone's own row and an empty saved window says so", () => {
  const read = (file) => fs.readFileSync(new URL(`../apps/mobile/src/${file}`, import.meta.url), "utf8");
  const app = read("App.jsx");
  const detail = read("FileHistory.jsx");
  assert.match(app, /offlineFileHistory\(page, saved, localEntry\)/);
  assert.match(app, /currentRev: more \? target\.currentRev : own\.currentRev/);
  assert.match(detail, /title="No saved versions for this file"/);
  assert.match(detail, /!current\.local &&\s+!current\.deleted/);
  assert.match(detail, /current\.local\s+\? "Local copy"/);
  assert.match(detail, /row\.created \? date\(row\.created\) : "This device"/);
});

test("views reload when the hub comes back and an open file detail refreshes quietly", () => {
  const app = fs.readFileSync(new URL("../apps/mobile/src/App.jsx", import.meta.url), "utf8");
  const recent = fs.readFileSync(new URL("../apps/mobile/src/FolderRecent.jsx", import.meta.url), "utf8");
  assert.match(app, /updated=\{status\.last\}\s+offline=\{status\.offline\}/);
  assert.match(recent, /\}, \[key, connected, updated, offline, attempt, onLoading\]\);/);
  assert.match(app, /async function getHistory\(target = null, more = false, quiet = false\)/);
  assert.match(app, /if \(!quiet\) \{\s+setFileHistory\(\{ versions: \[\], next: null \}\);\s+setSheet\(target\);\s+\}/);
  assert.match(app, /if \(quiet && !sameDetail\(openSheet\.current, target\)\) return;/);
  assert.match(app, /openSheet\.current = sheet;/);
  const effect = app.match(/useEffect\(\(\) => \{\s+if \(\s+sheet\?\.kind === "history" &&[\s\S]*?\}, \[([^\]]+)\]\);/);
  assert.ok(effect, "the reconnect refresh of an open file detail exists");
  assert.match(effect[0], /!status\.offline &&\s+fileHistory\.offline/);
  assert.match(effect[0], /false,\s+true,\s+\)\.catch/);
  assert.match(effect[1], /status\.offline/);
  for (const dependency of ["sheet?.kind", "sheet?.path", "fileHistory.offline"])
    assert.ok(effect[1].includes(dependency), `${dependency} retriggers the refresh`);
  assert.match(app, /machinesSaved && !!machines\?\.length/);
});

test("an open file detail refreshes only when the hub is back and its saved data is showing", async () => {
  const app = fs.readFileSync(new URL("../apps/mobile/src/App.jsx", import.meta.url), "utf8");
  const effect = app.match(/useEffect\(\(\) => \{(\s+if \(\s+sheet\?\.kind === "history" &&[\s\S]*?)\}, \[[^\]]+\]\);/);
  assert.ok(effect);
  const calls = [];
  const base = {
    sheet: { kind: "history", volume: "v", path: "a.txt", originEntry: { path: "a.txt" }, localEntry: null },
    connected: true,
    replica: {},
    status: { offline: false },
    fileHistory: { offline: true, versions: [] },
    getHistory: (...args) => {
      calls.push(args);
      return Promise.resolve();
    },
    setDetailError: () => {},
  };
  const run = (overrides) => vm.runInNewContext(`(() => {${effect[1]}\n})()`, { ...base, ...overrides });
  run({ status: { offline: true } });
  run({ fileHistory: { offline: false, versions: [] } });
  run({ connected: false });
  run({ replica: null });
  run({ sheet: { kind: "select" } });
  assert.equal(calls.length, 0, "nothing reloads while offline, when the data is live or without a file detail");
  run({});
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(1), [false, true], "the refresh is quiet: no reset of the open detail");
  assert.deepEqual(
    { volume: calls[0][0].volume, path: calls[0][0].path },
    { volume: "v", path: "a.txt" },
  );
});

test("offline empty states say nothing is saved, end in Retry that probes the hub, and never show a bare raw error", () => {
  const read = (file) => fs.readFileSync(new URL(`../apps/mobile/src/${file}`, import.meta.url), "utf8");
  const app = read("App.jsx");
  const card = read("components.jsx").match(/export function OfflineEmpty\(\{ icon, title, text, retry \}\) \{[\s\S]*?\n\}\n/);
  assert.ok(card, "one shared card");
  assert.match(card[0], /<EmptyState\s+icon=\{icon\}\s+title=\{title\}\s+text=\{text\}/);
  assert.match(card[0], /action=\{<Button label="Retry" icon="refresh" onPress=\{retry\} \/>\}/);
  assert.match(app, /function reconnect\(\) \{\s+if \(status\.offline\) startSync\(\);\s+\}/);
  assert.match(app.match(/<FolderGallery[\s\S]*?\n +\/>/)[0], /reconnect=\{reconnect\}/);
  assert.match(app.match(/<FolderRecent[\s\S]*?\n +\/>/)[0], /reconnect=\{reconnect\}/);
  assert.match(app, /retry=\{\(\) => \{\s+reconnect\(\);\s+getHistory\(sheet\)/);

  const gallery = read("FolderGallery.jsx");
  assert.match(gallery, /\{!!error && linked && !sections\.length && \(/, "a raw error shows only while the hub is reachable, with Retry");
  assert.match(gallery, /!\(error && linked\) &&/, "no empty copy under an error with Retry");
  assert.match(gallery, /!sections\.length &&\s+!pendingItems\.length &&\s+!\(error && linked\)/, "no empty copy beside the pending uploads strip");
  const offline = gallery.match(/connected && offline \? \(\s+<OfflineEmpty([\s\S]*?)\/>/);
  assert.ok(offline, "a folder without local photos offline gets the card");
  assert.match(offline[1], /title="Nothing saved on this phone"/);
  assert.match(offline[1], /text="You are offline\. Photos from this folder appear here once they have downloaded\."/);
  assert.match(offline[1], /reconnect\?\.\(\);\s+setError\(""\);\s+setRetry\(\(value\) => value \+ 1\);/);
  assert.match(gallery, /<EmptyState\s+icon="image"\s+title="No photos yet"/, "a hub that answered empty keeps its own copy");

  const recent = read("FolderRecent.jsx");
  const empty = recent.match(/if \(!page\.versions\.length && unreachable\)\s+return \(\s+<OfflineEmpty([\s\S]*?)\/>/);
  assert.ok(empty, "Recent without saved revisions offline gets the card");
  assert.match(recent, /const unreachable = !!page\.offline \|\| !!offline;/, "a hub error is not an offline verdict");
  assert.match(empty[1], /title="No saved versions"/);
  assert.match(empty[1], /text="You are offline\. Versions appear here once the hub is reachable\."/);
  assert.match(empty[1], /reconnect\?\.\(\);\s+retry\(\(n\) => n \+ 1\);/);
  assert.match(recent, /<EmptyState\s+icon="history"\s+title="No versions yet"/);

  const detail = read("FileHistory.jsx");
  const file = detail.match(/\(offline && !error \? \(\s+<OfflineEmpty([\s\S]*?)\/>\s+\) : \(\s+!error && \(\s+<EmptyState\s+icon="history"\s+title="No retained versions"/);
  assert.ok(file, "file detail offline gets the card, a hub that answered empty keeps its caption");
  assert.match(file[1], /text="You are offline\. Versions appear here once the hub is reachable\."/);
  assert.match(file[1], /retry=\{retry\}/);
});

test("every empty list on the phone uses the one EmptyState: icon, heading, one line and an optional action", async () => {
  const read = (file) => fs.readFileSync(new URL(`../apps/mobile/src/${file}`, import.meta.url), "utf8");
  const components = read("components.jsx");
  const state = components.match(/export function EmptyState\(\{ icon, title, text, action \}\) \{[\s\S]*?\n\}\n/);
  assert.ok(state, "one shared component");
  assert.match(state[0], /<View style=\{s\.empty\}>/);
  assert.match(state[0], /<Icon name=\{icon\} size=\{24\} color=\{c\.mute\} \/>/);
  assert.match(state[0], /\{action\}/);
  const sites = {
    "App.jsx": ["No folders yet", "No matching files", "This folder is empty", "No local files yet", "No saved devices"],
    "FolderRecent.jsx": ["No versions yet", "No saved versions"],
    "FileHistory.jsx": ["No retained versions", "No saved versions for this file"],
    "FolderGallery.jsx": ["No photos yet", "Nothing saved on this phone"],
  };
  for (const [file, titles] of Object.entries(sites)) {
    const source = read(file);
    for (const title of titles) assert.ok(source.includes(`"${title}"`), `${file} draws "${title}"`);
    assert.doesNotMatch(source, /explorerEmpty/, `${file} has no private empty layout`);
  }
  const app = read("App.jsx");
  assert.match(app, /<EmptyState\s+icon="folder-open"\s+title="No folders yet"/);
  assert.match(app, /<\/View>\s+\{!filesLoading &&\s+!visibleEntries\.length && \(\s+<EmptyState\s+icon="folders"\s+title=\{/, "Files draws its frame under the bordered breadcrumb group, never inside it");
  assert.match(app, /<EmptyState\s+\{\.\.\.historyEmpty\(\{\s+offline: history\.offline,\s+filter: historyFilter,\s+hasFolder: !!historyVolume,/);
  assert.match(app, /machinesLoaded && \(\s+<EmptyState/, "Machines waits for its answer before saying nothing is saved");
  assert.match(read("FolderRecent.jsx"), /\{!!page\.versions\.length && \(\s+<View style=\{s\.group\}>/, "no bordered box without rows");
  assert.match(state[0], /<Text style=\{\[s\.heading, s\.centerText\]\}>\{title\}<\/Text>/);
  for (const file of Object.keys(sites))
    for (const call of read(file).matchAll(/<OfflineEmpty\s+([^>]*?)title=/g)) assert.match(call[1], /icon="/, `${file} gives every offline empty state an icon`);
  const kit = fs.readFileSync(new URL("../design/mobile.html", import.meta.url), "utf8");
  assert.match(kit, /<h2>Empty states /);
  for (const title of Object.values(sites).flat()) assert.ok(kit.includes(`>${title}<`), `design/mobile.html draws "${title}"`);
  assert.match(read("App.jsx"), /<EmptyState\s+icon="devices"\s+title="No saved devices"/);
  assert.doesNotMatch(read("App.jsx"), /<Card title="No folders yet">|No saved device information/);
  assert.doesNotMatch(read("FolderRecent.jsx"), /No versions yet\./);
  const styles = fs.readFileSync(new URL("../apps/mobile/src/theme.js", import.meta.url), "utf8");
  assert.match(styles, /empty: \{[^}]*borderStyle: "dashed"[^}]*borderColor: c\.line[^}]*borderRadius: g\.cardRadius/s);
  assert.doesNotMatch(styles, /explorerEmpty/);
  assert.equal(iconNames["folder-open"], "FolderOpen");
});

test("the mobile welcome says where the hub comes from instead of a bare caption", () => {
  const onboarding = fs.readFileSync(new URL("../apps/mobile/src/Onboarding.jsx", import.meta.url), "utf8");
  const welcome = onboarding.slice(onboarding.indexOf('if (step === "welcome")'), onboarding.indexOf('if (step === "pair")')).replace(/\s+/g, " ");
  assert.match(
    welcome,
    /<Card title="You need a hub first"> <Text style=\{s\.text\}> Install Arca on a computer or a server and make it the hub\. Then open Devices → Pair a device there to get a code\. <\/Text> <\/Card>/,
  );
  assert.ok(welcome.indexOf("You need a hub first") > welcome.indexOf("FeatureRow"), "the card follows the feature rows");
  assert.ok(welcome.indexOf("You need a hub first") < welcome.indexOf('label="Get started"'), "and leads to the action");
  assert.doesNotMatch(welcome, /You will need a hub and a pairing code/);
  assert.match(welcome, /label="Get started"[\s\S]*onPress=\{start\}/, "Get started still starts pairing");
});

test("the mobile pairing form says where the hub shows its details, asks in the hub's order and serves both entry points", () => {
  const read = (file) => fs.readFileSync(new URL(`../apps/mobile/src/${file}`, import.meta.url), "utf8");
  const pair = read("PairingForm.jsx").replace(/\s+/g, " ");
  const onboarding = read("Onboarding.jsx");
  const step = onboarding.slice(onboarding.indexOf('if (step === "pair")'), onboarding.indexOf("const folders = catalog")).replace(/\s+/g, " ");
  const app = read("App.jsx").replace(/\s+/g, " ");
  assert.match(pair, /On the hub, open Devices → Pair a device\. It shows the address and a single-use code\./);
  assert.doesNotMatch(pair, /Connect with a single-use code from your hub/);
  const order = ['label="Hub address"', "Use HTTPS or Tailscale", 'label="Pairing code"', "Single use · valid ten minutes", "label={`Name this ${device}`}", "label={`Pair this ${device}`}"].map((marker) => pair.indexOf(marker));
  assert.ok(order.every((at) => at > 0), "every element of the form is there");
  assert.deepEqual(order, [...order].sort((a, b) => a - b), "address and its transport note, code and expiry hint, name, then the action");
  assert.match(pair, /placeholder="https:\/\/arca\.your-network"/);
  assert.match(pair, /<Icon name="clock" size=\{16\} \/>/);
  assert.match(pair, /disabled=\{ blocked \|\| !name\.trim\(\) \|\| !address\.trim\(\) \|\| code\.length !== 6 \}/, "the same validation guards Pair");
  assert.match(pair, /label=\{`Name this \$\{device\}`\} icon="phone" value=\{name\} onChangeText=\{setName\}/, "the name keeps its state and its default");
  assert.match(step, /<PairingForm [^>]*pair=\{pair\} \/> <StepIndicator step=\{1\} \/>/, "Onboarding draws the form then the progress dots");
  assert.match(app, /<PairingForm [^>]*blocked=\{!engine\.current\}/, "Devices without a hub draws the same form");
  for (const old of ["Pair this device", "Name this device", "http://192.168.1.10:17831", "Use HTTPS or Tailscale"])
    assert.equal(app.includes(old), false, `Devices no longer carries its own ${old}`);
});

test("an open photo folder prepares every local preview in the background and says what it is doing", () => {
  const read = (file) => fs.readFileSync(new URL(`../apps/mobile/src/${file}`, import.meta.url), "utf8");
  const gallery = read("FolderGallery.jsx").replace(/\s+/g, " ");
  const thumbnails = read("gallery-thumbnails.js");
  const components = read("components.jsx");
  const has = (source, ...pieces) => pieces.forEach((piece) => assert.ok(source.includes(piece), piece));
  has(gallery, "const candidates = useMemo(", "(path) => builtinExcluded(path) || (online && !!ignored?.(path))");
  has(gallery, "await prepareThumbnails( candidates, thumbnailProgress.current.value, backgroundIo,", "candidates, 3, (entry) => { if (active) { failedPaths.current.add(entry.path); queueFlush(); } }, true, );");
  assert.match(gallery, /\}, \[candidateKey, store, scope, volume, density, attempt, knownLoaded, online\]\);/, "a scroll never restarts the background pass, and it waits for the phone index");
  has(gallery, "if (density === \"years\" || !candidates.length || !knownLoaded) {");
  has(gallery, 'render: withHub((item) => item.kind === "video" ? thumbnailFiles.poster(item, true) : thumbnailFiles.render(item, false, true), ),');
  assert.match(gallery, /\}, \[visibleKey, store, scope, volume, io, density\]\);/, "the visible pass keeps its own dependencies");
  has(gallery, "(delta) => { if (!active) return; commit(key, delta); },", "} finally { if (active) setPreparing(false); }", "if (completeRef.current && !loadingRef.current) { const kept = pruneSaved(", "if (!dirty.current || loadingRef.current) return Promise.resolve();", "else if (flusher.current.pending) flusher.current.now();");
  has(gallery, 'AppState.addEventListener("change", (state) => { if (state === "active") { previews.clear(); accepted.clear(); } if (state === "active" && failedPaths.current.size) setAttempt((value) => value + 1); });', "queueFlush(seen ? 250 : 2000);");
  has(gallery, 'preparing && progress.waiting > 0 && ( <StatusRow busy title="Preparing previews"', '${progress.done.toLocaleString("en")} of ${progress.total.toLocaleString("en")}');
  has(gallery, 'progress.failed > 0 && ( <StatusRow icon="image"', "could not be made", 'caption="The photos are on this phone."', '<Button label="Retry" icon="refresh" onPress={retryPreviews} />');
  has(gallery, "const retryPreviews = () => { thumbnailFiles.retry(); previews.clear(); accepted.clear(); failedPaths.current = new Set(); setFailedCount(0); setAttempt((value) => value + 1); };");
  has(thumbnails, "const limiter = createLimiter(3, 30000);", "limiter.run(() => produce(target), !background)", "const hubLimiter = createLimiter(2, 60000);");
  assert.match(thumbnails, /retry\(\) \{\s+posterAttempt\.clear\(\);\s+renderAttempt\.clear\(\);\s+\},/);
  assert.match(components, /export function StatusRow\([\s\S]*?<View style=\{\[s\.card, s\.folderRow\]\}/);
});

test("the viewer's large preview falls back to the hub through the same module and the grid path is untouched", () => {
  const gallery = fs.readFileSync(new URL("../apps/mobile/src/FolderGallery.jsx", import.meta.url), "utf8").replace(/\s+/g, " ");
  assert.ok(gallery.includes("const renderLocal = (item, large = false, fallback = false) => galleryDisplay(item, {"));
  assert.ok(gallery.includes("const display = (item, large = false, fallback = false) => large ? withHub(renderLocal, true)(item, true, fallback) : renderLocal(item, false, fallback);"));
  assert.ok(gallery.includes("resolveLarge={(item, fallback = false) => display(item, true, fallback)}"));
  assert.ok(gallery.includes("const displayRef = useRef(display); displayRef.current = display;"));
  assert.ok(gallery.indexOf("const display = (item") > gallery.indexOf("const withHub = useMemo("), "display is defined after the hub fallback it uses");
});

test("the gallery api forwards the request options so slow hub previews get their own timeout", () => {
  const app = fs.readFileSync(new URL("../apps/mobile/src/App.jsx", import.meta.url), "utf8");
  assert.match(app, /function galleryAPI\(route, body, options\) \{\s+return client\.api\(route, body, options\);\s+\}/);
});

test("the photo-uploads screen names what All photos uploads, confirms the switch and offers Open settings only when access is refused", () => {
  const read = (file) => fs.readFileSync(new URL(`../apps/mobile/src/${file}`, import.meta.url), "utf8");
  const picker = read("GallerySource.jsx");
  const app = read("App.jsx");
  assert.match(picker, /name=\{allLabel\}\s+description=\{allNote\}/, "the All photos row carries the note");
  assert.match(picker, /!albums\.length\s+\? allNote/, "the summary row carries it too");
  assert.match(picker, /setLibrary\(\{ count: page\.totalCount \?\? null, videos \}\)/, "the count comes from the preview query");
  assert.match(picker, /\{denied && \(\s+<Button label="Open settings"/);
  assert.match(picker, /setDenied\(error\.code === "PHOTO_PERMISSION"\)/);
  assert.match(picker, /enable\(\{ albums, videos \}, \{ count: libraryCount, limited \}\)/);
  assert.match(app, /const switchedToAll = all && !!source && sourceAlbums\(source\)\.length > 0;/);
  assert.match(app, /source && source\.mode !== "damaged" && !switchedToAll/, "switching a saved selection to All photos asks first");
  assert.match(app, /const upgrade = all && !!source;/, "only a saved selection switching to All photos gets the upgrade wording");
  assert.match(app, /upgrade \? "Upload every photo\?" : "Enable photo uploads\?"/);
  assert.match(picker, /library\?\.videos === videos \? library\.count : null/, "a count for photos is never shown for photos and videos");
  assert.match(app, /"Uploads this album"/);
  assert.match(app, /"Uploads these albums"/);
});

test("phone buttons, rows, tabs and photo tiles show a pressed state", () => {
  const read = (file) => fs.readFileSync(new URL(`../apps/mobile/src/${file}`, import.meta.url), "utf8");
  const components = read("components.jsx");
  assert.match(read("theme.js"), /pressed: \{ backgroundColor: c\.hover \},\s+pressedFade: \{ opacity: 0\.85 \},/);
  assert.match(components, /pressed && !disabled && !busy && \(primary \? s\.pressedFade : s\.pressed\)/, "primary buttons fade, the others fill");
  assert.match(components, /pressed && !disabled && s\.pressed,\s+!disabled && pressScale\(pressed, reduce\),\s+disabled && s\.disabled/, "action rows fill");
  assert.match(components, /divider && s\.separator,\s+pressed && !disabled && s\.pressed,/, "folder rows fill");
  assert.match(components, /pressed && s\.pressed,\s+view === tab && !box && s\.navSelected/, "tabs fill without hiding the selection");
  assert.match(read("FolderGallery.jsx"), /pressed && s\.pressedFade,/, "photo tiles fade");
});

test("the phone's selected segment and floating panel follow the same dark depth as the desktop", async () => {
  const { palettes } = await import("../apps/mobile/src/palette.js");
  const theme = fs.readFileSync(new URL("../apps/mobile/src/theme.js", import.meta.url), "utf8");
  assert.match(theme, /segments: \{[^}]*backgroundColor: c\.segmentTrack,/);
  assert.match(theme, /segmentSelected: \{\s+backgroundColor: c\.segmentSelected,/);
  assert.match(theme, /modalPanel: \{[^}]*backgroundColor: c\.raised,\s+borderWidth: 1,\s+borderColor: c\.raisedEdge,/);
  const luminance = (hex) => {
    const [r, g, b] = [1, 3, 5].map((at) => {
      const value = parseInt(hex.slice(at, at + 2), 16) / 255;
      return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  for (const name of ["light", "dark"])
    assert.ok(luminance(palettes[name].segmentSelected) > luminance(palettes[name].segmentTrack), `${name}: the selected segment is lighter than its track`);
  const tokens = fs.readFileSync(new URL("../apps/desktop/src/tokens.css", import.meta.url), "utf8");
  const dark = tokens.split(/^\[data-theme="dark"\] \{/m)[1];
  assert.equal(palettes.dark.raised, dark.match(/--notice-surface:\s*(#[\da-f]{6})/)[1], "the phone's dark sheet is the desktop's floating surface");
  assert.equal(palettes.dark.raisedEdge, dark.match(/--line:\s*(#[\da-f]{6})/)[1], "and its edge is the desktop's line");
  assert.equal(palettes.light.raised, palettes.light.paper, "light sheets are unchanged");
  assert.equal(palettes.light.raisedEdge, "transparent");
  assert.ok(luminance(palettes.dark.raised) > luminance(palettes.dark.paper), "a dark sheet is lighter than the page");
});
