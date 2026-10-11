import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const source = (file) => fs.readFileSync(new URL(`../apps/mobile/src/${file}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("the phone names its own state with the desktop card's words", async () => {
  const { deviceStatus } = await import("../apps/mobile/src/home-data.js");
  const when = (value) => `at ${value}`;
  const linked = { connected: true, last: "10:12" };
  assert.deepEqual(deviceStatus(linked, when), { word: "Up to date", tone: null, last: "Last sync at 10:12" });
  assert.deepEqual(deviceStatus({ ...linked, busy: true }, when), { word: "Syncing", tone: null, last: "Last sync at 10:12" });
  assert.deepEqual(deviceStatus({ ...linked, checking: true }, when), { word: "Checking hub…", tone: null, last: "Last sync at 10:12" });
  assert.deepEqual(deviceStatus({ ...linked, checking: true, offline: true }, when), { word: "Offline", tone: "warning", last: "Last sync at 10:12" });
  assert.deepEqual(deviceStatus({ ...linked, busy: true, offline: true }, when), { word: "Offline", tone: "warning", last: "Last sync at 10:12" });
  assert.deepEqual(deviceStatus({ ...linked, offline: true, paused: true }, when), { word: "Paused", tone: "warning", last: "Last sync at 10:12" });
  assert.deepEqual(deviceStatus({ ...linked, error: "disk full" }, when), { word: "Needs attention", tone: "danger", last: "Last sync at 10:12" });
  assert.deepEqual(deviceStatus({ connected: true }, when), { word: "Not synced yet", tone: null, last: "" });
  assert.deepEqual(deviceStatus({ connected: false, last: "10:12" }, when), { word: "Disconnected", tone: "warning", last: "Last sync at 10:12" });
});

test("Settings opens with This device and Local synchronization no longer lists the last sync", () => {
  const app = source("App.jsx");
  const settings = app.slice(app.indexOf('{screen === "Settings" && ('));
  const order = ["THIS DEVICE", "<DeviceRow name={name} device={device} />", 'label="Device name"', "HUB CONNECTION", "LOCAL SYNCHRONIZATION", "MOBILE PREFERENCES"].map((needle) => settings.indexOf(needle));
  assert.ok(order.every((at) => at >= 0), String(order));
  assert.deepEqual([...order].sort((a, b) => a - b), order, "This device leads Settings, its row above the Device name field");
  assert.doesNotMatch(app, /Last completed sync/);
  const components = source("components.jsx");
  const row = components.slice(components.indexOf("export function DeviceRow("), components.indexOf("export function MachineRow("));
  assert.match(row, /<Icon name="phone" \/>/);
  assert.match(row, /style=\{\[s\.caption, s\.roleWord\]\}>Replica</);
  assert.match(row, /<StateWord device=\{device\} \/>\s*\{device\.last \? ` · \$\{device\.last\}` : ""\}/);
});

test("the Fold navigation ends with the device status block and its rail with the phone glyph and dot", () => {
  const components = source("components.jsx");
  const nav = components.slice(components.indexOf("export function Navigation("), components.indexOf("function StateWord("));
  assert.doesNotMatch(nav, /s\.identity|navFooter|Hub connected/, "no identity card at the top and no separate footer");
  assert.match(nav, /\{wide && device && \(compact \? <DeviceGlyph name=\{name\} device=\{device\} \/> : <DeviceStatus name=\{name\} device=\{device\} \/>\)\}\s*<\/Container>/);
  const block = components.slice(components.indexOf("export function DeviceStatus("), components.indexOf("function DeviceGlyph("));
  assert.match(block, /Replica · <StateWord device=\{device\} \/>/, "the role opens the state line");
  assert.match(block, /\{!!device\.last && \(/);
  const glyph = components.slice(components.indexOf("function DeviceGlyph("), components.indexOf("export function DeviceRow("));
  assert.match(glyph, /s\.favoriteDot, s\.deviceGlyphDot, !!device\.tone && s\.favoriteDotWarning/);
  const drawer = source("Favorites.jsx");
  assert.match(drawer, /\{!!device && <DeviceStatus name=\{name\} device=\{device\} \/>\}\s*<\/SafeAreaView>/);
  const theme = source("theme.js");
  assert.doesNotMatch(theme, /\bidentity: \{|navFooter/);
  assert.match(theme, /deviceStatus: \{\s*marginTop: "auto",/);
  const app = source("App.jsx");
  assert.match(app, /const device = deviceStatus\(\{ \.\.\.status, connected \}, relative\);/);
  assert.equal(app.match(/device=\{device\}/g).length, 3, "wide navigation, Favorites drawer and Settings share one status");
});

test("the device row and the Fold block read the last sync to screen readers", async () => {
  const { deviceLabel } = await import("../apps/mobile/src/home-data.js");
  assert.equal(deviceLabel("Pixel", { word: "Offline", last: "Last sync at 10:12" }), "Pixel, Replica, Offline, Last sync at 10:12");
  assert.equal(deviceLabel("Pixel", { word: "Not synced yet", last: "" }), "Pixel, Replica, Not synced yet");
  const components = source("components.jsx");
  assert.match(components, /import \{ deviceLabel, folderState, machineTone \} from "\.\/home-data\.js";/);
  for (const name of ["export function DeviceStatus(", "export function DeviceRow("]) {
    const block = components.slice(components.indexOf(name));
    assert.match(block.slice(0, 200), /accessibilityLabel=\{deviceLabel\(name, device\)\}/, name);
  }
});

test("the phone shows the launch check apart from syncing and restarts its event wait when the hub returns", () => {
  const app = source("App.jsx");
  assert.match(app, /busy: r\.activity,\s*checking: hubChecking\(r\),/);
  assert.match(app, /if \(!pulling \|\| pullHeld\(status\)\) return;/);
  assert.match(app, /import \{ deviceStatus, folderSections, historyTone, hubChecking, pullHeld \} from "\.\/home-data";/);
  assert.doesNotMatch(app, /checking: r\.checking/);
  assert.match(app, /\}, \[connected, connection\?\.hubId, catalog\?\.changeEvents, status\.offline\]\);/);
});

test("Checking hub… lasts only while a cycle runs, so a cycle that ended never holds the word or the pull", async () => {
  const { hubChecking, pullHeld, deviceStatus } = await import("../apps/mobile/src/home-data.js");
  const ended = { checking: true, busy: false };
  assert.equal(hubChecking(ended), false, "the replica's getter can stay true after the cycle; the snapshot does not");
  assert.equal(hubChecking({ checking: true, busy: true }), true);
  assert.equal(hubChecking({ checking: false, busy: true }), false);
  const snapshot = { busy: false, checking: hubChecking(ended) };
  assert.equal(pullHeld(snapshot), false, "pull-to-refresh releases once nothing runs");
  assert.equal(pullHeld({ busy: false, checking: true }), true);
  assert.equal(pullHeld({ busy: true, checking: false }), true);
  assert.notEqual(deviceStatus({ connected: true, last: "10:12", ...snapshot }, (v) => v).word, "Checking hub…");
});
