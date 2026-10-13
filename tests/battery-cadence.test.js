import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  INVENTORY_MS,
  DISCOVERY_MS,
  FULL_SCAN_MS,
  NO_PROGRESS_MS,
  INACTIVE_RESCAN_MS,
  FOREGROUND_DISCOVERY_MS,
} from "../apps/mobile/src/sync-cadence.js";
import { ACTIVE_POLL_MS, IDLE_POLL_MS, IDLE_AFTER_MS, SAFETY_POLL_MS, EVENTS_FRESH_MS, normalDelay } from "../packages/daemon/sync-work.js";

const read = (...parts) => fs.readFileSync(path.join(import.meta.dirname, "..", ...parts), "utf8");

test("the phone's cadence is event-driven: long inventories, a short discovery and a bounded run", () => {
  assert.equal(INVENTORY_MS, 6 * 3600000, "a scheduled cycle re-walks a folder only every six hours");
  assert.equal(DISCOVERY_MS, 15 * 60000, "the photo library is discovered every fifteen minutes at most");
  assert.equal(FULL_SCAN_MS, 24 * 3600000, "full reconciliation is a daily safety net");
  assert.equal(NO_PROGRESS_MS, 10 * 60000);
  assert.equal(INACTIVE_RESCAN_MS, 10 * 60000, "entering the app after ten idle minutes scans again");
  const app = read("apps/mobile/src/App.jsx");
  assert.match(app, /if \(leftAt !== null && Date\.now\(\) - leftAt >= INACTIVE_RESCAN_MS\)\s+engine\.current\?\.lastInventory\.clear\(\);/);
  assert.match(app, /leftAt \?\?= Date\.now\(\);/);
  const runtime = read("apps/mobile/src/runtime.js");
  assert.match(runtime, /await replica\.sync\(false, \{ scheduled: true \}\);/, "the OS background task is a cheap scheduled cycle");
  assert.match(runtime, /currentReplica\.sync\(false, \{ scheduled: true \}\)/, "pending gallery work continues without walking every folder");
});

test("the transfer service holds its wake lock on a ten-minute lease renewed by progress updates", () => {
  const service = read("apps/mobile/modules/arca-network/android/src/main/java/expo/modules/arcanetwork/TransferService.kt");
  assert.match(service, /const val LEASE_MS = 10 \* 60 \* 1000L/);
  assert.match(service, /"arca:sync"\)\.apply \{ setReferenceCounted\(false\) \}\s+lock\?\.acquire\(LEASE_MS\)/);
  assert.match(service, /lastUpdate = now\s+lock\?\.acquire\(LEASE_MS\)/, "each progress update renews the lease");
  assert.doesNotMatch(service, /6 \* 60 \* 60/);
});

test("a replica whose events answer polls the hub only as a ten-minute safety net", () => {
  assert.equal(SAFETY_POLL_MS, 10 * 60 * 1000);
  assert.equal(EVENTS_FRESH_MS, 30000);
  assert.ok(SAFETY_POLL_MS > IDLE_POLL_MS && IDLE_POLL_MS > ACTIVE_POLL_MS);
  const now = 10 * 3600000;
  const base = { role: "replica", now, eventsAnsweredAt: now - 5000, unwatched: false, lastActivity: now - 1000 };
  assert.equal(normalDelay(base), SAFETY_POLL_MS, "events answering: the cycle is a safety net");
  assert.equal(normalDelay({ ...base, unwatched: true }), ACTIVE_POLL_MS, "a folder without a live watcher keeps the short cadence so it is retried and rescanned");
  assert.equal(normalDelay({ ...base, eventsAnsweredAt: now - EVENTS_FRESH_MS - 1 }), ACTIVE_POLL_MS, "stale events fall back to polling");
  assert.equal(normalDelay({ ...base, eventsAnsweredAt: 0, lastActivity: now - IDLE_AFTER_MS }), IDLE_POLL_MS, "idle replicas without events poll every minute");
  assert.equal(normalDelay({ ...base, role: "hub" }), IDLE_POLL_MS, "the hub never uses the replica's safety net");
  const server = read("packages/daemon/server.js");
  assert.match(server, /if \(!probing\) eventsAnsweredAt = Date\.now\(\);/, "a probe while offline never counts as healthy events");
  assert.match(server, /\.some\(\(v\) => v\.selected && v\.path && !watchers\.has\(v\.path\)\)/);
  assert.match(server, /changedTimer = setTimeout\(tick, 1000\);/, "local changes still run within a second");
});

test("the phone launches with an inventory, rediscovers photos fast in the foreground and slowly elsewhere", () => {
  const app = read("apps/mobile/src/App.jsx");
  assert.match(app, /engine\.current\.discoveryMs = FOREGROUND_DISCOVERY_MS;\s+engine\.current\.sync\(\);/, "a launch is an unscheduled run, so it inventories");
  assert.match(app, /value === "active" \? FOREGROUND_DISCOVERY_MS : DISCOVERY_MS/);
  const gallery = read("apps/mobile/src/gallery.js");
  assert.match(gallery, />= r\.discoveryMs;/);
  assert.equal(FOREGROUND_DISCOVERY_MS, 60000);
});
