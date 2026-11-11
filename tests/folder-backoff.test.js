import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { init } from "../packages/daemon/storage.js";
import { start } from "../packages/daemon/server.js";
import { ACTIVE_POLL_MS, FolderBackoff, RETRY_MAX_MS, deviceWide } from "../packages/daemon/sync-work.js";
import { canWatchDirectory, withWatchEvent } from "./watch-support.js";

async function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arca-folder-backoff-"));
  const nodes = [];
  t.after(async () => {
    for (const n of nodes.reverse()) await n.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  async function node(name, role, options = { timer: false }) {
    const home = path.join(root, name);
    init(home, { name, role, port: 0 });
    const n = await start(home, options);
    nodes.push(n);
    n.api = async (route, data) => {
      const r = await fetch(`http://127.0.0.1:${n.port}${route}`, {
        method: data === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${n.engine.config.adminToken}`,
          "X-Arca-Directories": "1",
          "X-Arca-Path-Transitions": "1",
          "Content-Type": "application/json",
        },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      });
      const body = await r.json();
      if (!r.ok) throw Object.assign(new Error(body.error), { status: r.status });
      return body;
    };
    n.sync = () => n.engine.exclusive(() => n.engine.cycle());
    return n;
  }
  return { root, node };
}
const write = (n, v, name, content) => fs.writeFileSync(path.join(n.engine.store.volume(v.id).path, name), content);
async function waitFor(check, ms = 10000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail("the condition was not met in time");
}

async function pair(t, { timer }) {
  const { node } = await setup(t);
  const hub = await node("hub", "hub");
  const broken = await hub.api("/v1/volumes", { name: "Broken" });
  const healthy = await hub.api("/v1/volumes", { name: "Healthy" });
  write(hub, broken, "a.txt", "a");
  write(hub, healthy, "b.txt", "b");
  await hub.sync();
  const replica = await node("replica", "replica", timer ? { timer: true, eventRetryMs: 100 } : { timer: false });
  const invite = await hub.api("/v1/devices", { name: "replica", role: "replica" });
  await replica.api("/v1/connect", { url: `http://127.0.0.1:${hub.port}`, token: invite.token });
  for (const v of [broken, healthy]) await replica.api("/v1/select", { id: v.id });
  return { hub, replica, broken, healthy };
}
const breakFolder = (engine, method, id, error = () => new Error("Reserved name: CON")) => {
  const original = engine[method].bind(engine);
  const state = { broken: true, attempts: 0 };
  engine[method] = async (v, ...rest) => {
    if (v?.id === id && state.broken) {
      state.attempts++;
      throw error();
    }
    return original(v, ...rest);
  };
  return state;
};

test("one folder's backoff grows and caps like the device's, and only folder errors back off per folder", () => {
  const backoff = new FolderBackoff();
  const now = 1000;
  assert.equal(backoff.failed("x", new Error("Reserved name"), undefined, now), true);
  assert.equal(backoff.waiting("x", now).at, now + ACTIVE_POLL_MS * 2);
  for (let i = 0; i < 9; i++) backoff.failed("x", new Error("Reserved name"), undefined, now);
  assert.equal(backoff.waiting("x", now).at, now + RETRY_MAX_MS, "it stops growing at five minutes");
  assert.equal(backoff.waiting("x", now + RETRY_MAX_MS), null, "and is due again after it");
  assert.equal(backoff.due(["x", "y"], now), now + RETRY_MAX_MS);
  assert.equal(backoff.due(["y"], now), 0, "a folder no longer selected sets no retry");
  backoff.succeeded("x");
  assert.equal(backoff.waiting("x", now), null);
  for (const error of [
    Object.assign(new Error("Hub unavailable"), { hubUnavailable: true }),
    Object.assign(new Error("Credential revoked"), { status: 401 }),
    Object.assign(new Error("Forbidden"), { status: 403 }),
    Object.assign(new Error("Protocol"), { status: 412 }),
    Object.assign(new Error("No space left on device"), { code: "ENOSPC" }),
  ]) {
    assert.equal(deviceWide(error), true, error.message);
    assert.equal(backoff.failed("y", error, undefined, now), false);
    assert.equal(backoff.waiting("y", now), null, `${error.message} keeps the device-wide backoff`);
  }
});

test("a replica cycle whose only failures are folder errors says so, and a device-wide one does not", async (t) => {
  const { replica, broken, healthy } = await pair(t, { timer: false });
  await replica.sync();
  const folder = breakFolder(replica.engine, "syncIgnore", broken.id);
  await assert.rejects(replica.sync(), (error) => error.folderOnly === true && /Broken: Reserved name/.test(error.message));
  await assert.rejects(replica.engine.exclusive(() => replica.engine.cycle({ incremental: true })), (error) => error.folderOnly === true);
  assert.equal(folder.attempts, 1, "a cycle started by events skips the folder while it backs off");
  await assert.rejects(replica.sync());
  assert.equal(folder.attempts, 2, "Sync now tries it again");
  assert.equal(replica.engine.status().phase, "error", "the device still says a folder needs attention");
  assert.equal(replica.engine.folderStates.get(broken.id).state, "error");
  assert.equal(replica.engine.folderStates.get(healthy.id).state, "synced");
  breakFolder(replica.engine, "syncIgnore", healthy.id, () => Object.assign(new Error("Credential revoked"), { status: 401 }));
  await assert.rejects(replica.sync(), (error) => error.folderOnly === false);
  assert.equal(replica.engine.folderBackoff.waiting(healthy.id), null);
});

test("with one replica folder failing every cycle, an edit in another reaches the hub within the event latency", async (t) => {
  if (!(await canWatchDirectory(2))) return t.skip("the operating system cannot deliver folder watcher events here");
  const { hub, replica, broken, healthy } = await pair(t, { timer: true });
  await waitFor(() => replica.engine.folderStates.get(healthy.id)?.state === "synced", 20000);
  const folder = breakFolder(replica.engine, "syncIgnore", broken.id);
  await replica.api("/v1/sync", { background: true });
  await waitFor(() => folder.attempts > 0 && replica.engine.status().phase === "error", 20000);
  const attempts = folder.attempts;
  const edited = await withWatchEvent(t, replica.engine.store.volume(healthy.id).path, "edit.txt", async () => {
    write(replica, healthy, "edit.txt", "made on the replica");
  }, async () => {
    await waitFor(() => hub.engine.store.current(healthy.id, "edit.txt"), 8000);
  });
  if (!edited) return;
  assert.equal(folder.attempts, attempts, "the failing folder waits out its own backoff");
  assert.ok(replica.engine.folderBackoff.waiting(broken.id));
  await waitFor(() => replica.engine.status().phase === "error");
  assert.match(replica.engine.error, /Broken: Reserved name/, "the device still names the folder that needs attention");
  folder.broken = false;
  await replica.api("/v1/sync", { background: true });
  await waitFor(() => replica.engine.folderStates.get(broken.id)?.state === "synced", 20000);
  assert.equal(replica.engine.folderBackoff.waiting(broken.id), null, "a folder that recovers backs off no more");
  await waitFor(() => replica.engine.status().phase === "idle", 20000);
});

test("with one replica folder failing every cycle, a hub edit in another folder arrives through the event stream at once", async (t) => {
  const { hub, replica, broken, healthy } = await pair(t, { timer: true });
  await waitFor(() => replica.engine.folderStates.get(healthy.id)?.state === "synced", 20000);
  const folder = breakFolder(replica.engine, "syncIgnore", broken.id);
  await replica.api("/v1/sync", { background: true });
  await waitFor(() => folder.attempts > 0 && replica.engine.status().phase === "error", 20000);
  const attempts = folder.attempts;
  write(hub, healthy, "from-hub.txt", "made on the hub");
  await hub.sync();
  const local = path.join(replica.engine.store.volume(healthy.id).path, "from-hub.txt");
  await waitFor(() => fs.existsSync(local), 8000);
  assert.equal(fs.readFileSync(local, "utf8"), "made on the hub");
  assert.equal(folder.attempts, attempts, "the failing folder is not tried again meanwhile");
  await waitFor(() => replica.engine.status().phase === "error");
  assert.equal(replica.engine.folderStates.get(broken.id).state, "error");
});

test("with one hub folder failing every scan, an edit in another is committed within the event latency", async (t) => {
  if (!(await canWatchDirectory(2))) return t.skip("the operating system cannot deliver folder watcher events here");
  const { node } = await setup(t);
  const hub = await node("hub", "hub", { timer: true });
  const broken = await hub.api("/v1/volumes", { name: "Broken" });
  const healthy = await hub.api("/v1/volumes", { name: "Healthy" });
  await waitFor(() => hub.engine.folderStates.get(healthy.id)?.state === "synced", 20000);
  const folder = breakFolder(hub.engine.scanner, "scan", broken.id);
  await hub.api("/v1/sync", { background: true });
  await waitFor(() => folder.attempts > 0 && hub.engine.status().phase === "error", 20000);
  const attempts = folder.attempts;
  const edited = await withWatchEvent(t, hub.engine.store.volume(healthy.id).path, "edit.txt", async () => {
    write(hub, healthy, "edit.txt", "made on the hub");
  }, async () => {
    await waitFor(() => hub.engine.store.current(healthy.id, "edit.txt"), 8000);
  });
  if (!edited) return;
  assert.equal(folder.attempts, attempts);
  assert.equal(hub.engine.folderStates.get(broken.id).state, "error");
});

test("a narrow hub scan for one file keeps a failing folder's backoff; only a whole-folder pass clears it", async (t) => {
  const { node } = await setup(t);
  const hub = await node("hub", "hub");
  const broken = await hub.api("/v1/volumes", { name: "Broken" });
  write(hub, broken, "ok.txt", "fine");
  await hub.sync();
  const scan = hub.engine.scanner.scan.bind(hub.engine.scanner);
  let attempts = 0;
  hub.engine.scanner.scan = async (v, paths) => {
    if (v.id === broken.id && !paths?.length) {
      attempts++;
      throw new Error("Symlink requires attention: album");
    }
    return scan(v, paths);
  };
  await assert.rejects(hub.sync(), (error) => error.folderOnly === true);
  const before = hub.engine.folderBackoff.waiting(broken.id);
  assert.ok(before);
  write(hub, broken, "ok.txt", "uploaded by a phone");
  await hub.engine.scanHub(broken.id, { paths: ["ok.txt"] });
  assert.equal(hub.engine.store.current(broken.id, "ok.txt").size, "uploaded by a phone".length, "the narrow scan still commits the file");
  assert.deepEqual(hub.engine.folderBackoff.waiting(broken.id), before, "the folder keeps waiting with the same failure count");
  assert.equal(attempts, 1);
});

test("a hub folder whose retry is due and has nothing left to scan forgets its old failures", async (t) => {
  const { node } = await setup(t);
  const hub = await node("hub", "hub");
  const folder = await hub.api("/v1/volumes", { name: "Notes" });
  await hub.sync();
  hub.engine.folderBackoff.failed(folder.id, new Error("Could not write 1 file"), undefined, Date.now() - RETRY_MAX_MS);
  assert.equal(hub.engine.folderBackoff.waiting(folder.id), null, "its retry is due");
  await hub.engine.exclusive(() => hub.engine.cycle({ incremental: true }));
  assert.equal(hub.engine.folderBackoff.folders.has(folder.id), false);
});

test("a folder waiting out its backoff with changes pending does not make the device cycle every second", async (t) => {
  const { replica, broken } = await pair(t, { timer: true });
  await waitFor(() => replica.engine.status().phase === "idle" && replica.engine.lastSync, 20000);
  const folder = breakFolder(replica.engine, "syncIgnore", broken.id);
  replica.engine.work.mark(broken.id);
  await replica.api("/v1/sync", { background: true });
  await waitFor(() => folder.attempts > 0 && replica.engine.status().phase === "error", 20000);
  await waitFor(() => replica.engine.status().phase !== "syncing");
  assert.ok(replica.engine.store.db.prepare("SELECT 1 FROM sync_dirty WHERE volume=?").get(broken.id), "its changes stay pending");
  const runCycle = replica.engine.runCycle.bind(replica.engine);
  let cycles = 0;
  replica.engine.runCycle = (...args) => {
    cycles++;
    return runCycle(...args);
  };
  await new Promise((resolve) => setTimeout(resolve, 3000));
  assert.ok(cycles <= 1, `${cycles} cycles in three seconds`);
});

test("a folder whose retry comes due is tried again on its own, without Sync now", async (t) => {
  const { hub, replica, broken, healthy } = await pair(t, { timer: true });
  await waitFor(() => replica.engine.status().phase === "idle" && replica.engine.lastSync, 20000);
  const folder = breakFolder(replica.engine, "syncIgnore", broken.id);
  const runCycle = replica.engine.runCycle.bind(replica.engine);
  let started = Date.now();
  replica.engine.runCycle = (...args) => {
    started = Date.now();
    return runCycle(...args);
  };
  const syncIgnore = replica.engine.syncIgnore;
  const retried = [];
  replica.engine.syncIgnore = async (v, ...rest) => {
    if (v?.id === broken.id && !folder.broken) retried.push(started);
    return syncIgnore(v, ...rest);
  };
  await replica.api("/v1/sync", { background: true });
  await waitFor(() => folder.attempts > 0 && replica.engine.status().phase === "error", 20000);
  folder.broken = false;
  write(replica, broken, "later.txt", "made while it waited");
  replica.engine.work.mark(broken.id);
  await waitFor(() => Date.now() - started >= 2500 && replica.engine.status().phase !== "syncing", 20000);
  assert.deepEqual(retried, [], "the cycles that followed the edit skipped the folder");
  const at = Date.now() + 2500;
  replica.engine.folderBackoff.folders.get(broken.id).at = at;
  write(hub, healthy, "nudge.txt", "starts an event-driven cycle");
  await hub.sync();
  await waitFor(() => hub.engine.store.current(broken.id, "later.txt"), 10000);
  assert.ok(retried[0] >= at, "the retry ran in a cycle scheduled for the folder's retry time");
  assert.equal(replica.engine.folderBackoff.waiting(broken.id), null);
});
