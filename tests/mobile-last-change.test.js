import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  cachedChange,
  knownRecent,
  newestChange,
  readLastChange,
  rememberRecent,
  shortName,
  seededChange,
  failedChange,
} from "../apps/mobile/src/recent-cache.js";

const row = {
  rev: 9,
  path: "notes/brief.md",
  created: "2026-10-02T10:00:00.000Z",
  author: "fold",
  deleted: 0,
};

test("the newest accepted version becomes the folder's last change", () => {
  assert.deepEqual(newestChange({ versions: [row, { ...row, rev: 8 }] }), {
    created: row.created,
    path: row.path,
    author: "fold",
  });
  assert.equal(newestChange({ versions: [] }), null);
  assert.equal(newestChange(undefined), null);
});

test("online it asks the hub for the same page Recent reads, offline it reads the saved view", async () => {
  const routes = [];
  const online = await readLastChange({
    key: "scope:docs",
    volume: "docs",
    load: async (route) => {
      routes.push(route);
      return { versions: [row], next: null };
    },
  });
  assert.deepEqual(routes, ["/v1/activity?volume=docs&limit=4"]);
  assert.equal(online.change.path, "notes/brief.md");
  assert.equal(online.saved, false);
  const offline = await readLastChange({
    key: "scope:docs",
    volume: "docs",
    load: async () => ({ offline: true, versions: [row] }),
  });
  assert.equal(offline.saved, true);
  assert.equal(offline.change.author, "fold");
});

test("a folder with no accepted versions has no change, online or saved", async () => {
  const none = await readLastChange({
    key: "scope:empty",
    volume: "empty",
    load: async () => ({ versions: [], next: null }),
  });
  assert.deepEqual(none, { change: null, saved: false });
  const saved = await readLastChange({
    key: "scope:empty",
    volume: "empty",
    load: async () => ({ offline: true, versions: [] }),
  });
  assert.deepEqual(saved, { change: null, saved: true });
});

test("the Recent cache answers at once and covers a failed read, and a failure with nothing cached surfaces", async () => {
  knownRecent.clear();
  assert.equal(cachedChange("scope:docs"), null);
  rememberRecent("scope:docs", { versions: [row, row], offline: true });
  assert.deepEqual(cachedChange("scope:docs"), {
    change: newestChange({ versions: [row] }),
    saved: true,
  });
  const covered = await readLastChange({
    key: "scope:docs",
    volume: "docs",
    load: async () => {
      throw new Error("hub unreachable");
    },
  });
  assert.equal(covered.change.path, "notes/brief.md");
  assert.equal(
    covered.saved,
    true,
    "a value kept through a failed read is marked last known",
  );
  await assert.rejects(
    readLastChange({
      key: "scope:other",
      volume: "other",
      load: async () => {
        throw new Error("hub unreachable");
      },
    }),
    /hub unreachable/,
  );
  rememberRecent("scope:empty", { versions: [] });
  assert.equal(
    cachedChange("scope:empty"),
    null,
    "an empty page is not an answer",
  );
});

test("a long file name is shortened so the device stays visible", () => {
  assert.equal(shortName("notes/brief.md"), "brief.md");
  assert.equal(shortName("a".repeat(40)), `${"a".repeat(13)}…`);
  assert.equal(shortName("deep/path/" + "b".repeat(26)).length, 14);
});

test("a successful read is remembered so re-entering a folder shows it at once", async () => {
  knownRecent.clear();
  await readLastChange({
    key: "scope:docs",
    volume: "docs",
    load: async () => ({ versions: [row] }),
  });
  assert.equal(cachedChange("scope:docs").change.path, "notes/brief.md");
  assert.equal(
    seededChange({ key: "scope:other", value: null }, "scope:docs").value.change
      .path,
    "notes/brief.md",
  );
  assert.equal(
    seededChange({ key: "scope:docs", value: null }, "scope:docs").value,
    null,
    "the same folder keeps its state",
  );
  assert.equal(seededChange(undefined, "scope:nothing").value, undefined);
});

test("a failed read keeps the value the same folder already shows and only otherwise says not available", () => {
  const shown = {
    key: "scope:docs",
    value: { change: newestChange({ versions: [row] }), saved: false },
  };
  assert.equal(failedChange(shown, "scope:docs"), shown);
  assert.deepEqual(failedChange(shown, "scope:other"), {
    key: "scope:other",
    value: null,
  });
  assert.deepEqual(
    failedChange({ key: "scope:docs", value: undefined }, "scope:docs"),
    { key: "scope:docs", value: null },
  );
  assert.deepEqual(failedChange(undefined, "scope:docs"), {
    key: "scope:docs",
    value: null,
  });
});

test("the Recent cache stays bounded", () => {
  knownRecent.clear();
  for (let i = 0; i < 60; i++)
    rememberRecent(`scope:${i}`, { versions: [row] });
  assert.equal(knownRecent.size, 40);
  assert.equal(knownRecent.has("scope:0"), false);
  assert.equal(knownRecent.has("scope:59"), true);
});

test("the phone's folder summary shows Status, Last change and Version history and no Files cell", () => {
  const read = (file) =>
    fs.readFileSync(
      new URL(`../apps/mobile/src/${file}`, import.meta.url),
      "utf8",
    );
  const app = read("App.jsx");
  const block = app.slice(
    app.indexOf("s.statsGrid"),
    app.indexOf("s.statsGrid") + 4200,
  );
  assert.match(block, /"Status",/);
  assert.match(
    block,
    /"Last change",\s+relative\(shownChange\.change\.created\)/,
  );
  assert.match(block, /"No changes yet"/);
  assert.match(
    block,
    /"No saved versions",\s+"Connect to the hub for the newest"/,
  );
  assert.match(
    block,
    /machinesLoaded \|\| shownChange\.change\.author === connection\?\.id/,
  );
  assert.match(block, /"Version history",\s+retentionLabel/);
  assert.doesNotMatch(block, /"Files",|"Last completed",/);
  assert.match(block, /Completed \$\{relative\(currentFolder\.completed\)\}/);
  assert.match(
    block,
    /s\.statCellThird,\s+!wide && index === 2 && s\.statCellWide/,
  );
  assert.doesNotMatch(block, /deleted/);
  assert.match(
    app,
    /readLastChange\(\{\s+key,\s+volume: folder\.id,\s+load: \(route\) => replica\.remoteView\(route\)/,
  );
  assert.match(
    read("FolderRecent.jsx"),
    /import \{ knownRecent, rememberRecent \} from "\.\/recent-cache";/,
  );
  const theme = read("theme.js");
  assert.match(
    theme,
    /statCell: \{ width: wide \? "25%" : "50%"/,
    "the file detail keeps its four cells",
  );
  assert.match(theme, /statCellThird: \{ width: wide \? "33\.333%" : "50%"/);
  assert.match(read("FileHistory.jsx"), /s\.statCell,/);
  assert.match(theme, /statCellWide: \{ width: "100%" \}/);
});
