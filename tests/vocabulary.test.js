import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const sources = [
  "apps/desktop/src/app.js",
  "apps/desktop/src/tray.js",
  "apps/desktop/src/index.html",
  "site/index.html",
  "design/desktop.html",
  "design/mobile.html",
  "design/index.html",
  ...fs
    .readdirSync(path.join(root, "apps/mobile/src"))
    .filter((name) => /\.jsx?$/.test(name) && name !== "icons.js")
    .map((name) => `apps/mobile/src/${name}`),
];
const retired = [
  "Pair a machine",
  "This machine",
  "THIS MACHINE",
  "Machine name",
  "Open Machines",
  "No saved machines",
  "Keep a local copy",
  "Revision history",
  "Older revisions",
  "Destroy this",
  "Destroy hub",
  "Destroy replica",
  "Unlink",
  "Disable local sync",
  "A replica",
  "Select…",
  "Connect to view recent revisions",
];

test("the words the interface retired do not come back in the apps, the kit or the site", () => {
  for (const file of sources) {
    const text = fs
      .readFileSync(path.join(root, file), "utf8")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    for (const word of retired)
      assert.equal(text.includes(word), false, `${file} still says "${word}"`);
  }
});

test("the tabs and navigation say Devices on the phone and the desktop", () => {
  const mobile = fs.readFileSync(path.join(root, "apps/mobile/src/App.jsx"), "utf8");
  const components = fs.readFileSync(path.join(root, "apps/mobile/src/components.jsx"), "utf8");
  const desktop = fs.readFileSync(path.join(root, "apps/desktop/src/index.html"), "utf8");
  assert.match(mobile, /const tabs = \["Folders", "Devices", "History", "Settings"\];/);
  assert.match(components, /\["Folders", "Devices", "History", "Settings"\]/);
  assert.match(desktop, /<span data-icon="monitor-smartphone"><\/span>Devices/);
});

test("the daemon and the notices speak of devices where a person reads them", () => {
  const files = [
    "apps/desktop/src/notice-contract.js",
    ...fs
      .readdirSync(path.join(root, "packages/daemon"))
      .filter((name) => name.endsWith(".js"))
      .map((name) => `packages/daemon/${name}`),
  ];
  const phrases = [
    "Machine name",
    "this machine",
    "This machine",
    "two machines",
    "paired machine",
    "linked machine",
    "destruction first",
  ];
  for (const file of files) {
    const text = fs
      .readFileSync(path.join(root, file), "utf8")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    for (const phrase of phrases)
      assert.equal(text.includes(phrase), false, `${file} still says "${phrase}"`);
  }
});

test("the phone confirmation keeps its destructive style for Erase this device", () => {
  const app = fs.readFileSync(path.join(root, "apps/mobile/src/App.jsx"), "utf8");
  const match = app.match(/destructive=\{(\/[^/]+\/i)\.test\(/);
  assert.ok(match, "the destructive flag is derived from the label");
  const destructive = new RegExp(match[1].slice(1, -2), "i");
  for (const label of ["Erase this device", "Stop syncing", "Remove device", "Delete"])
    assert.equal(destructive.test(label), true, label);
  assert.equal(destructive.test("Restore"), false);
});

test("cold dialogs and Settings use plain wording the copy review asked for", () => {
  const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
  const app = read("apps/desktop/src/app.js");
  const design = read("design/desktop.html");
  for (const phrase of [
    '"Erase this hub?"',
    "The reply is JSON",
    "and copy the code value from the reply",
    "The daemon must support file browsing",
    "Files and credentials are not encrypted",
    "On the new desktop, open Devices",
  ]) {
    assert.equal(app.includes(phrase), false, `app still says ${phrase}`);
    assert.equal(design.includes(phrase), false, `design still says ${phrase}`);
  }
  for (const phrase of [
    "Erase this hub and all its folders?",
    "The command prints a result that includes a six-digit code. Enter that code below.",
    "Arca could not list this folder’s files.",
    "Anyone on that network could read your files and sign-in details",
    "On the new device, open Arca and choose Pair with your hub. A computer picks Another device first; one already set up uses Connect to hub.",
  ])
    assert.equal(app.includes(phrase), true, `app lacks ${phrase}`);
  assert.match(
    app,
    /On the server, run <code>docker exec &lt;container&gt; node packages\/cli\/arca\.js web-code<\/code> if Arca runs in Docker, or <code>arca web-code<\/code> if it is installed directly\./,
  );
  assert.ok(design.includes("On the new device, open Arca and choose Pair with your hub. A computer picks Another device first"));
  assert.equal(design.includes("On the new device, open Devices"), false);
  assert.ok(design.includes("The command prints a result that includes a six-digit code. Enter that code below."));
});

test("the UX review's wording and tones hold across desktop, phone and site", () => {
  const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
  const desktop = read("apps/desktop/src/app.js");
  const mobile = read("apps/mobile/src/App.jsx");
  const components = read("apps/mobile/src/components.jsx");
  const gallery = read("apps/mobile/src/FolderGallery.jsx");
  const site = read("site/index.html");
  for (const phrase of ["Daemon stopped", "Start the local daemon", "managing this daemon", "Daemon is still starting", "No visible copy selected", "in catalog`", 'pill("Revoked"', '"unlink")', "Cancel selection"])
    assert.equal(desktop.includes(phrase) || mobile.includes(phrase) || gallery.includes(phrase), false, `still says ${phrase}`);
  assert.match(desktop, /\["Paused", "id", "pause"\]/);
  assert.match(desktop, /pill\("Disconnected", "id", "unplug"\)/);
  assert.match(desktop, /pill\("Removed", "er", "unplug"\)/);
  assert.match(mobile, /`Stop syncing “\$\{target\.name\}”\?`/, "the phone names the folder it stops syncing");
  assert.match(mobile, /"Stop syncing and delete",\n\s+\);/, "the phone button says the copy is deleted");
  assert.doesNotMatch(mobile, /credentials, selections, index, queues and caches/);
  assert.match(mobile, /state=\{m\.revoked \? "Removed" : "Linked"\}/);
  assert.match(components, /\["Needs attention", "Removed"\]/);
  assert.match(gallery, /label="Clear selection"/);
  assert.match(gallery, /accessibilityActions=\{\s*onLongPress\s*\?\s*\[\{ name: "longpress", label: selected \? "Deselect" : "Select" \}\]/, "a screen reader can select a tile");
  assert.match(gallery, /item\.kind === "video" \? "Video" : "Photo"/, "a tile announces its kind");
  assert.equal(site.includes("Your machines"), false);
  assert.equal(/daemon/i.test(read("apps/desktop/src/index.html")), false, "the first paint never says daemon");
  const theme = read("apps/mobile/src/theme.js");
  for (const style of ["inputShell", "codeCell", "button", "input"])
    assert.match(theme, new RegExp(`\\n    ${style}: \\{[^}]*borderColor: c\\.control,`), `${style} draws the control border`);
  assert.match(mobile, /\/stop syncing\/i\.test\(shownConfirmation\.label\)\s+\? "unlink"/, "Stop syncing and delete keeps the unlink icon");
  assert.match(site, /<title>Arca — Your files\. Your devices\.<\/title>/);
});

test("every phone tab has its own icon", () => {
  const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
  const icons = read("apps/mobile/src/icons.js");
  const tabs = read("apps/mobile/src/App.jsx").match(/const tabs = \[([^\]]+)\];/)[1].match(/"(\w+)"/g).map((name) => name.slice(1, -1).toLowerCase());
  for (const tab of tabs) {
    assert.match(icons, new RegExp(`\\n  ${tab}: "`), `${tab} has a Lucide name`);
    assert.match(icons, new RegExp(`\\n  ${tab}: \\[`), `${tab} has its drawing`);
  }
});

test("every literal icon name used by the phone screens resolves", () => {
  const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
  const icons = read("apps/mobile/src/icons.js");
  for (const file of ["apps/mobile/src/App.jsx", "apps/mobile/src/components.jsx"])
    for (const [, name] of read(file).matchAll(/\bicon="([\w-]+)"/g))
      if (name !== "arca")
        assert.match(icons, new RegExp(`\\n  (?:"${name}"|${name}): "`), `${file} uses icon "${name}" with no Lucide name`);
});

test("History explains why it is empty, on desktop and on the phone", async () => {
  const source = fs.readFileSync(path.join(root, "apps/desktop/src/app.js"), "utf8");
  assert.match(source, /\n      : historyEmpty\(\)\);/, "renderHistory draws it when there are no rows");
  const code = source.slice(source.indexOf("function historyEmpty()"), source.indexOf("function empty("));
  const run = (historyFilter, historyVolume) =>
    vm.runInNewContext(`${code}\nhistoryEmpty()`, {
      historyFilter,
      historyVolume,
      empty: (heading, text, control, symbol) => ({ heading, text, symbol }),
    });
  assert.deepEqual(run("conflicts", ""), { heading: "No conflicts", text: "Clear Conflicts to see every change.", symbol: "triangle-alert" });
  assert.deepEqual(run("deleted", "docs"), { heading: "No deleted files", text: "Clear Deleted to see every change.", symbol: "trash-2" });
  assert.deepEqual(run("revisions", "docs"), { heading: "No changes in this folder", text: "Set Shared folder to All to see every change.", symbol: "history" });
  assert.deepEqual(run("revisions", ""), { heading: "No history yet", text: "Changes to your files appear here.", symbol: "arca" });
  const { historyEmpty } = await import("../apps/mobile/src/history-empty.js");
  const titles = [
    historyEmpty({ offline: true, filter: "revisions", hasFolder: false }),
    historyEmpty({ offline: false, filter: "conflicts", hasFolder: false }),
    historyEmpty({ offline: false, filter: "deleted", hasFolder: true }),
    historyEmpty({ offline: false, filter: "revisions", hasFolder: true }),
    historyEmpty({ offline: false, filter: "revisions", hasFolder: false }),
  ];
  assert.equal(new Set(titles.map((state) => state.text)).size, titles.length, "no two phone states share a line");
  assert.deepEqual(titles.map((state) => state.icon), ["wifi-off", "conflict", "trash", "history", "arca"]);
  assert.equal(titles[1].title, "No conflicts");
  assert.equal(titles[0].text, "Connect to the hub to load history.");
  for (const [filter, volume, hasFolder] of [["conflicts", "", false], ["deleted", "docs", true], ["revisions", "docs", true], ["revisions", "", false]]) {
    const desktopState = run(filter, volume);
    const phoneState = historyEmpty({ offline: false, filter, hasFolder });
    assert.equal(phoneState.title, desktopState.heading, `${filter}/${volume} title`);
    assert.equal(phoneState.text, desktopState.text, `${filter}/${volume} text`);
  }
  const phoneSource = (file) => fs.readFileSync(path.join(root, "apps", "mobile", "src", file), "utf8");
  assert.ok(phoneSource("FolderGallery.jsx").includes('"Photos added to this folder appear here."'));
  assert.ok(source.split('"Photos added to this folder appear here."').length === 3, "desktop gallery empties use it twice");
  assert.ok(phoneSource("FolderRecent.jsx").includes('text="History appears after the first sync."'));
  assert.ok(source.includes('empty("No versions yet", "History appears after the first sync.")'));
});

test("every list that grows says Show more", () => {
  const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
  const desktop = read("apps/desktop/src/app.js");
  assert.ok(desktop.includes('button("Show more", "history-page", historyNext, "secondary")'));
  assert.ok(desktop.includes('button("Show more versions", "history-page", data.next, "secondary")'));
  assert.ok(desktop.includes('button("Show more files", "browse-more", String(pages.length), "secondary")'));
  assert.equal(desktop.includes("Load more"), false);
  assert.equal(/section\("Loading", scaffoldRow/.test(desktop), false, "a placeholder row carries no Loading label");
  for (const file of ["apps/mobile/src/App.jsx", "apps/mobile/src/FileHistory.jsx"]) {
    const source = read(file);
    assert.equal(source.includes("Load older versions"), false, `${file} still says Load older versions`);
    assert.ok(source.includes('label="Show more versions"'), `${file} says Show more versions`);
  }
});

test("History heads each day group and tells each row's clock time the same way on desktop and phone", async () => {
  const source = fs.readFileSync(path.join(root, "apps/desktop/src/app.js"), "utf8");
  const code = source.slice(source.indexOf("function dayLabel("), source.indexOf("const icon = (name)"));
  const desktop = vm.runInNewContext(`${code}\n({ dayLabel, clockTime })`, {});
  const phone = await import("../apps/mobile/src/history-days.js");
  const now = new Date(2026, 9, 4, 15, 30);
  const at = (year, month, day, hour = 9, minute = 5) => new Date(year, month, day, hour, minute);
  for (const [value, expected] of [
    [at(2026, 9, 4, 0, 1), "Today"],
    [at(2026, 9, 4, 23, 59), "Today"],
    [at(2026, 9, 3, 23, 59), "Yesterday"],
    [at(2026, 9, 3, 0, 1), "Yesterday"],
    [at(2026, 8, 27), "Sep 27"],
    [at(2025, 11, 31), "Dec 31, 2025"],
  ]) {
    assert.equal(desktop.dayLabel(value, now), expected);
    assert.equal(phone.dayLabel(value, now), expected);
  }
  const first = new Date(2026, 0, 1, 12, 0);
  assert.equal(desktop.dayLabel(new Date(2025, 11, 31, 12, 0), first), "Yesterday", "a year boundary still says Yesterday");
  assert.equal(phone.dayLabel(new Date(2025, 11, 31, 12, 0), first), "Yesterday");
  for (const value of [at(2026, 9, 4, 9, 5), at(2026, 9, 4, 0, 0), at(2026, 9, 4, 23, 59)]) {
    assert.match(desktop.clockTime(value), /^\d{2}:\d{2}$/);
    assert.equal(desktop.clockTime(value), phone.clockTime(value));
  }
  assert.equal(phone.clockTime(at(2026, 9, 4, 9, 5)), "09:05");
  assert.equal(phone.clockTime(at(2026, 9, 4, 0, 0)), "00:00");
  const app = fs.readFileSync(path.join(root, "apps/mobile/src/App.jsx"), "utf8");
  assert.ok(app.includes("const day = dayLabel(row.created);"), "the phone groups by day label");
  assert.ok(app.includes("{clockTime(row.created)}"), "its wide rows show the clock time");
  assert.ok(app.includes("{` · ${clockTime(row.created)}`}"), "and its narrow rows too");
  const theme = fs.readFileSync(path.join(root, "apps", "mobile", "src", "theme.js"), "utf8");
  assert.match(theme, /historyDate: \{ width: 90, fontVariant: \["tabular-nums"\] \}/, "wide times use tabular figures");
  assert.match(theme, /tabularTime: \{ fontVariant: \["tabular-nums"\] \}/, "and so do narrow times");
  assert.ok(app.includes("style={s.tabularTime}"), "the narrow time carries that style");
  assert.ok(source.includes("const day = dayLabel(r.created);"), "the desktop groups by day label");
  assert.ok(source.includes("row-time\">${compact ? relative(v.created) : clockTime(v.created)}<"), "desktop History rows show the clock, Recent keeps relative times");
});

test("a conflict is a triangle-alert on desktop and phone, never a git-branch", async () => {
  const read = (...file) => fs.readFileSync(path.join(root, ...file), "utf8");
  for (const file of [["apps", "desktop", "src", "app.js"], ["apps", "desktop", "src", "notice-contract.js"], ["apps", "mobile", "src", "Notice.jsx"]])
    assert.doesNotMatch(read(...file), /git-branch/, file.join("/"));
  const { iconNames, icons } = await import("../apps/mobile/src/icons.js");
  assert.equal(iconNames.conflict, "TriangleAlert");
  assert.equal(icons.conflict.length, 3);
  assert.match(read("apps", "mobile", "src", "Notice.jsx"), /"triangle-alert": "conflict"/);
  assert.match(read("apps", "desktop", "src", "app.js"), /conflict \? "triangle-alert" : "git-commit-horizontal"/);
});
