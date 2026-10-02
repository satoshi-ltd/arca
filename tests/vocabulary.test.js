import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
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
