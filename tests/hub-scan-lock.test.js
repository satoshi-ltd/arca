import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { init } from "../packages/daemon/storage.js";
import { start } from "../packages/daemon/server.js";

async function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arca-hub-lock-"));
  const nodes = [];
  t.after(async () => {
    for (const n of nodes.reverse()) await n.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  async function node(name, role) {
    const home = path.join(root, name);
    init(home, { name, role, port: 0 });
    const n = await start(home, { timer: false });
    nodes.push(n);
    n.api = async (route, data) => {
      const r = await fetch(`http://127.0.0.1:${n.port}${route}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${n.engine.config.adminToken}`,
          "X-Arca-Directories": "1",
          "X-Arca-Path-Transitions": "1",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(data),
      });
      const body = await r.json();
      if (!r.ok) throw Object.assign(new Error(body.error), { status: r.status });
      return body;
    };
    n.sync = () => n.engine.exclusive(() => n.engine.cycle());
    return n;
  }
  const hub = await node("hub", "hub");
  const busy = await hub.api("/v1/volumes", { name: "Photos" });
  const other = await hub.api("/v1/volumes", { name: "Documents" });
  const replica = await node("desk", "replica");
  const invite = await hub.api("/v1/devices", { name: "desk", role: "replica" });
  await replica.api("/v1/connect", { url: `http://127.0.0.1:${hub.port}`, token: invite.token });
  await replica.api("/v1/select", { id: other.id });
  await replica.sync();
  return { hub, replica, busy, other };
}

const within = (promise, ms, what) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} still waiting after ${ms} ms`)), ms)),
  ]);

test("a full hub scan held open does not hold back another folder's upload and proposal", async (t) => {
  const { hub, replica, busy, other } = await setup(t);
  let release, started;
  const held = new Promise((resolve) => (release = resolve));
  const scanning = new Promise((resolve) => (started = resolve));
  const scan = hub.engine.scanner.scan.bind(hub.engine.scanner);
  hub.engine.scanner.scan = (v, paths, ...rest) => {
    if (v.id !== busy.id || paths !== null) return scan(v, paths, ...rest);
    started();
    return held.then(() => scan(v, paths, ...rest));
  };
  t.after(() => release());
  await hub.api("/v1/sync", { background: true });
  await within(scanning, 10000, "the hub scan");
  const local = path.join(replica.engine.store.volume(other.id).path, "report.txt");
  fs.writeFileSync(local, "written while the hub scans another folder");
  await within(replica.sync(), 10000, "the replica's upload and proposal");
  const row = hub.engine.store.current(other.id, "report.txt");
  assert.equal(row?.deleted, 0);
  assert.equal(fs.readFileSync(hub.engine.store.blob(row.hash), "utf8"), "written while the hub scans another folder");
  release();
  await within(hub.engine.exclusive(() => {}), 10000, "the held scan");
});

test("a phone's gallery request for the folder being scanned waits for it without holding back another folder's proposal", async (t) => {
  const { hub, replica, busy, other } = await setup(t);
  let release, started;
  const held = new Promise((resolve) => (release = resolve));
  const scanning = new Promise((resolve) => (started = resolve));
  const scan = hub.engine.scanner.scan.bind(hub.engine.scanner);
  hub.engine.scanner.scan = (v, paths, ...rest) => {
    if (v.id !== busy.id || paths !== null) return scan(v, paths, ...rest);
    started();
    return held.then(() => scan(v, paths, ...rest));
  };
  t.after(() => release());
  await hub.api("/v1/sync", { background: true });
  await within(scanning, 10000, "the hub scan");
  let answered = false;
  const gallery = hub.api("/v1/gallery/removals", { volume: busy.id, after: 0 }).then(
    () => (answered = true),
    () => (answered = true),
  );
  await new Promise((resolve) => setTimeout(resolve, 1500));
  fs.writeFileSync(path.join(replica.engine.store.volume(other.id).path, "late.txt"), "after a gallery request");
  await within(replica.sync(), 10000, "the replica's upload and proposal");
  assert.equal(hub.engine.store.current(other.id, "late.txt")?.deleted, 0);
  assert.equal(answered, false, "the gallery request waits for its own folder's scan");
  release();
  await within(gallery, 10000, "the gallery request");
});

test("steady folder work does not starve a queued control", async (t) => {
  const { hub, busy, other } = await setup(t);
  let stop = false;
  const traffic = (key) =>
    (async () => {
      while (!stop) await hub.engine.folderWork(key, () => new Promise((resolve) => setTimeout(resolve, 40)));
    })();
  const streams = [traffic(busy.id)];
  await new Promise((resolve) => setTimeout(resolve, 20));
  streams.push(traffic(other.id));
  await new Promise((resolve) => setTimeout(resolve, 30));
  const control = hub.engine.exclusive(() => true);
  try {
    assert.equal(await within(control, 5000, "the queued control"), true);
  } finally {
    stop = true;
    await Promise.all(streams);
  }
});

test("an interrupted hub cycle waiting for a folder does not start that folder's full scan", async (t) => {
  const { hub } = await setup(t);
  const [busy, other] = hub.engine.store.volumes().filter((v) => v.selected);
  const fullScans = [];
  let releaseScan, started;
  const heldScan = new Promise((resolve) => (releaseScan = resolve));
  const scanning = new Promise((resolve) => (started = resolve));
  const scan = hub.engine.scanner.scan.bind(hub.engine.scanner);
  hub.engine.scanner.scan = (v, paths, ...rest) => {
    if (paths === null) fullScans.push(v.id);
    if (v.id !== busy.id || paths !== null) return scan(v, paths, ...rest);
    started();
    return heldScan.then(() => scan(v, paths, ...rest));
  };
  t.after(() => releaseScan());
  const cycle = hub.engine.cycle({ incremental: false });
  await within(scanning, 10000, "the first folder's scan");
  let releaseFolder;
  const lock = hub.engine.folderWork(other.id, () => new Promise((resolve) => (releaseFolder = resolve)));
  const mine = hub.engine.folderTails.get(other.id);
  releaseScan();
  for (let i = 0; i < 2000 && hub.engine.folderTails.get(other.id) === mine; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.notEqual(hub.engine.folderTails.get(other.id), mine, "the cycle waits for the folder");
  hub.engine.interruptCycle();
  releaseFolder();
  await lock;
  await cycle.catch(() => {});
  assert.equal(fullScans.includes(other.id), false, "the folder the cycle waited for is not scanned after the interruption");
});

test("a replica's sync is not refused because an unrelated hub cycle was interrupted", async (t) => {
  const { hub, replica, other } = await setup(t);
  const unwinding = new AbortController();
  unwinding.abort(Object.assign(new Error("Synchronization yielded to a user action"), { syncInterrupted: true }));
  hub.engine.syncAbort = unwinding;
  t.after(() => (hub.engine.syncAbort = null));
  fs.writeFileSync(path.join(replica.engine.store.volume(other.id).path, "kept.txt"), "proposed while another cycle unwinds");
  await replica.sync();
  assert.equal(hub.engine.store.current(other.id, "kept.txt")?.deleted, 0);
});

test("closing the daemon waits for folder work still running", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arca-hub-close-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  init(root, { name: "hub", role: "hub", port: 0 });
  const daemon = await start(root, { timer: false });
  let finished = false;
  const work = daemon.engine.folderWork("folder", async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    daemon.engine.store.db.prepare("SELECT 1").get();
    finished = true;
  });
  await daemon.close();
  await work;
  assert.equal(finished, true);
});

test("folder work that waited for one control never runs beside the next one", async (t) => {
  const { hub, other } = await setup(t);
  let active = 0,
    overlapped = false;
  const tracked = (work) => async () => {
    active++;
    if (active > 1) overlapped = true;
    try {
      return await work();
    } finally {
      active--;
    }
  };
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let entered;
  const running = new Promise((resolve) => (entered = resolve));
  const first = hub.engine.exclusive(tracked(async () => {
    entered();
    await pause(50);
  }));
  await running;
  const keyed = hub.engine.folderWork(other.id, tracked(() => pause(50)));
  const second = hub.engine.exclusive(tracked(() => pause(10)));
  await Promise.all([first, keyed, second]);
  assert.equal(overlapped, false);
});
