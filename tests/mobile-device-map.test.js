import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { deviceNodes } from "../apps/mobile/src/device-map.js";
import { icons } from "../apps/mobile/src/icons.js";

const now = Date.parse("2026-10-09T12:00:00Z");
const at = (ms) => new Date(now - ms).toISOString();
const roster = [
  { name: "Casa", isHub: true },
  { name: "phone", credentialId: "me", reportedAt: at(60000), platform: "android" },
  { name: "macbook", credentialId: "mac", reportedAt: at(5 * 3600000), platform: "darwin" },
  { name: "tablet", credentialId: "tab", platform: "ios" },
  { name: "gone", credentialId: "gone", revoked: true, reportedAt: at(1000) },
];

test("the phone's device map encodes report freshness and never says synced", () => {
  const nodes = deviceNodes(roster, { selfId: "me", now });
  assert.deepEqual(nodes.map((n) => n.machine.name), ["phone", "macbook", "tablet"], "this device first, hub and removed devices left out");
  assert.deepEqual(nodes.map((n) => n.line), ["solid", "dashed", "none"]);
  assert.deepEqual(nodes.map((n) => n.report.text), ["Reported 1 min ago", "Reported 5 h ago", "No report yet"]);
  assert.deepEqual(nodes.map((n) => n.report.tone), ["ok", "warning", "mute"]);
  assert.ok(nodes[0].self);
  for (const n of nodes) assert.doesNotMatch(n.report.text, /synced|up to date/i);
});

test("with the hub away no line is drawn and reports read as last known", () => {
  const nodes = deviceNodes(roster, { selfId: "me", hubAway: true, now });
  assert.deepEqual(nodes.map((n) => n.line), ["none", "none", "none"]);
  assert.deepEqual(nodes.map((n) => n.report.text), ["Offline", "Last report 5 h ago", "No report yet"]);
});

test("the five-minute limit and an unreadable report time", () => {
  const edge = deviceNodes([{ name: "a", credentialId: "a", reportedAt: at(299000) }, { name: "b", credentialId: "b", reportedAt: at(301000) }, { name: "c", credentialId: "c", reportedAt: "nonsense" }], { now });
  assert.deepEqual(edge.map((n) => n.state), ["fresh", "stale", "none"]);
  assert.deepEqual(deviceNodes(null, { now }), []);
});

test("the Devices screen draws the map on the phone and beside the list on wide screens", () => {
  const app = fs.readFileSync(new URL("../apps/mobile/src/App.jsx", import.meta.url), "utf8");
  assert.match(app, /deviceNodes\(machines,/);
  assert.match(app, /tree \? "NETWORK" : "HUB CONNECTION"/);
  assert.match(app, /<DeviceMapSide/);
  assert.match(app, /Solid line: report under 5 min/);
  assert.match(app, /chosen=\{pickedDevice === m\.credentialId\}/);
});

test("every report icon the map uses exists in the phone's icon set, and the tree keeps this phone's state", () => {
  const nodes = deviceNodes(roster, { selfId: "me", now });
  for (const n of [...nodes, ...deviceNodes(roster, { selfId: "me", hubAway: true, now })]) assert.ok(icons[n.report.icon], n.report.icon);
  const app = fs.readFileSync(new URL("../apps/mobile/src/App.jsx", import.meta.url), "utf8");
  assert.match(app, /state=\{node\.self \? selfState : undefined\}/);
  assert.match(app, /chosen=\{!!connection\?\.id && pickedDevice === connection\.id\}/);
});
