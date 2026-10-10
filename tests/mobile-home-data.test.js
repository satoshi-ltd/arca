import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("the phone Folders screen has no Just arrived row, type icons, no previews and no last file", () => {
  const app = fs.readFileSync(new URL("../apps/mobile/src/App.jsx", import.meta.url), "utf8");
  const components = fs.readFileSync(new URL("../apps/mobile/src/components.jsx", import.meta.url), "utf8");
  assert.doesNotMatch(app, /ArrivalsStrip|homeFromActivity|arrivals/);
  assert.doesNotMatch(components, /ArrivalsStrip|JUST ARRIVED/);
  assert.doesNotMatch(fs.readFileSync(new URL("../apps/mobile/src/home-data.js", import.meta.url), "utf8"), /arrival/i);
  assert.doesNotMatch(app, /latestLine|homeLatest/);
  assert.doesNotMatch(app, /previews/, "a folder row never shows file content");
  assert.doesNotMatch(components, /homeMosaic|homeStack/);
  assert.doesNotMatch(components, /homeConflict/, "a ring only means sync progress");
  assert.doesNotMatch(fs.readFileSync(new URL("../apps/mobile/src/theme.js", import.meta.url), "utf8"), /homeConflict/);
});

test("a folder row carries its state in the leading tile and the caption's first word", async () => {
  const { folderState, machineTone, historyTone } = await import("../apps/mobile/src/home-data.js");
  assert.deepEqual(folderState({ status: "Up to date", conflict: true }), { tone: "warning", word: "Conflict", icon: "conflict" });
  assert.deepEqual(folderState({ status: "Needs attention", conflict: true }), { tone: "danger", word: "Needs attention", icon: "alert" });
  for (const status of ["Paused", "Offline", "Disconnected"])
    assert.deepEqual(folderState({ status }), { tone: "neutral", word: status, icon: null }, `${status} keeps the kind glyph on a neutral tile`);
  assert.deepEqual(folderState({ status: "Incomplete" }), { tone: null, word: "Incomplete", icon: null });
  assert.deepEqual(folderState({ status: "Up to date" }), { tone: null, word: null, icon: null });
  assert.deepEqual(folderState({ status: "Syncing", conflict: true }), { tone: null, word: null, icon: null }, "syncing keeps the progress ring");
  assert.equal(machineTone("Removed"), "danger");
  assert.equal(machineTone("Offline"), "neutral");
  assert.equal(machineTone("Linked"), null);
  assert.equal(historyTone({ path: "a.conflict-x.md" }), "warning");
  assert.equal(historyTone({ path: "a.conflict-x.md", resolved: true }), null);
  assert.equal(historyTone({ path: "a.md", deleted: true }), "neutral");
  const components = fs.readFileSync(new URL("../apps/mobile/src/components.jsx", import.meta.url), "utf8");
  const row = components.slice(components.indexOf("export function FolderRow("), components.indexOf("const TABS"));
  assert.doesNotMatch(row, /<Badge/, "folder rows show no state chip");
  assert.match(row, /state\.tone === "warning" && s\.tileWarning/);
  assert.match(row, /state\.tone === "danger" && s\.tileDanger/);
  assert.match(row, /state\.tone === "neutral" && s\.tileNeutral/);
  assert.match(row, /name=\{state\.icon \|\| icon\}/);
  const theme = fs.readFileSync(new URL("../apps/mobile/src/theme.js", import.meta.url), "utf8");
  assert.match(theme, /tileWarning: \{ backgroundColor: c\.warningBg \}/);
  assert.match(theme, /tileDanger: \{ backgroundColor: c\.dangerBg \}/);
  assert.match(theme, /tileNeutral: \{ backgroundColor: c\.hover \}/);
  const machine = components.slice(components.indexOf("export function MachineRow("), components.indexOf("export function SettingsGroup("));
  assert.match(machine, /<Badge>\{state\}<\/Badge>/, "devices keep their chip");
  assert.match(machine, /tone === "danger" && s\.tileDanger/);
  const app = fs.readFileSync(new URL("../apps/mobile/src/App.jsx", import.meta.url), "utf8");
  assert.match(app, /historyTone\(row\) === "warning" && s\.tileWarning/, "history conflicts tint their glyph tile");
});
