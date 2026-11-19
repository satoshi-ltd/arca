import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { init } from "../packages/daemon/storage.js";
import { start } from "../packages/daemon/server.js";

async function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arca-stage-"));
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
    n.state = async () => (await n.engine.status()).volumes.find((row) => row.id === volume.id).sync;
    return n;
  }
  const hub = await node("hub", "hub");
  const volume = await hub.api("/v1/volumes", { name: "Photos" });
  const connect = async (name, location) => {
    const replica = await node(name, "replica");
    const invite = await hub.api("/v1/devices", { name, role: "replica" });
    await replica.api("/v1/connect", { url: `http://127.0.0.1:${hub.port}`, token: invite.token });
    // Stubs of fs in this thread must reach the scan, which otherwise runs in a worker.
    replica.engine.scanner.scan = async (v, paths = null, skipUnreadable = false) =>
      replica.engine.store.scan(v, paths, () => {}, skipUnreadable);
    await replica.api("/v1/select", { id: volume.id, ...(location && { path: location }) });
    return replica;
  };
  const dir = (n) => n.engine.store.volume(volume.id).path;
  const objectCopies = (n) => {
    const copies = [];
    const copy = fs.copyFileSync;
    fs.copyFileSync = (from, to) => {
      if (String(to).startsWith(n.engine.store.objects)) copies.push(String(from));
      return copy(from, to);
    };
    t.after(() => (fs.copyFileSync = copy));
    return copies;
  };
  return { root, hub, volume, connect, dir, objectCopies };
}

test("a replica with room for one file beside its folder uploads its new files one by one in a single sync", async (t) => {
  const { hub, volume, connect, dir } = await setup(t);
  const replica = await connect("tight");
  await replica.sync();
  const names = Array.from({ length: 7 }, (_, i) => `photo-${i}.jpg`);
  for (const [i, name] of names.entries()) fs.writeFileSync(path.join(dir(replica), name), String(i).repeat(1000));
  const s = replica.engine.store;
  const roots = [s.objects, s.uploads, dir(replica)];
  const used = () =>
    roots
      .flatMap((root) => fs.readdirSync(root, { recursive: true }).map((name) => path.join(root, name)))
      .filter((file) => fs.statSync(file).isFile())
      .reduce((total, file) => total + fs.statSync(file).size, 0);
  const capacity = used() + 16 * 1024 * 1024 + 1500;
  const statfs = fs.statfsSync;
  t.after(() => (fs.statfsSync = statfs));
  fs.statfsSync = (where, options) =>
    roots.some((root) => String(where).startsWith(root))
      ? { ...statfs(where, options), bavail: BigInt(Math.max(0, capacity - used())), bsize: 1n }
      : statfs(where, options);
  await replica.sync();
  assert.equal((await replica.state()).state, "synced");
  for (const [i, name] of names.entries())
    assert.equal(fs.readFileSync(hub.engine.store.blob(hub.engine.store.current(volume.id, name).hash), "utf8"), String(i).repeat(1000));
  assert.deepEqual(fs.readdirSync(s.objects).filter((name) => /^[a-f0-9]{64}$/.test(name)), []);
});

test("a replica that links a folder identical to the hub's, or relinks after losing its index, copies nothing into its objects", async (t) => {
  const { root, hub, volume, connect, dir, objectCopies } = await setup(t);
  for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(dir(hub), `doc-${i}.txt`), `document ${i}`);
  await hub.sync();
  const location = path.join(root, "existing");
  fs.cpSync(dir(hub), location, { recursive: true });
  const replica = await connect("linked", location);
  const watched = objectCopies(replica);
  await replica.sync();
  assert.equal((await replica.state()).state, "synced");
  assert.equal(replica.engine.store.current(volume.id, "doc-3.txt").hash, hub.engine.store.current(volume.id, "doc-3.txt").hash);
  assert.deepEqual(watched, [], "a first link stages nothing the hub already has");
  replica.engine.store.forgetIndex(volume.id);
  replica.engine.store.db.prepare("DELETE FROM scan_cache").run();
  replica.engine.work.mark(volume.id);
  await replica.sync();
  assert.equal((await replica.state()).state, "synced");
  assert.deepEqual(watched, [], "a relink stages nothing the hub already has");
  fs.writeFileSync(path.join(location, "new.txt"), "new");
  await replica.sync();
  assert.equal(watched.length, 1, "only content the hub lacks is staged");
  assert.equal(fs.readFileSync(hub.engine.store.blob(hub.engine.store.current(volume.id, "new.txt").hash), "utf8"), "new");
});

test("a new file removed between the scan and its upload is retried alone while the rest of the folder uploads", async (t) => {
  const { hub, volume, connect, dir } = await setup(t);
  const replica = await connect("editor");
  await replica.sync();
  fs.writeFileSync(path.join(dir(replica), "a.txt"), "saved and replaced");
  fs.writeFileSync(path.join(dir(replica), "b.txt"), "kept");
  const scan = replica.engine.scanner.scan;
  replica.engine.scanner.scan = async (...args) => {
    const disk = await scan(...args);
    fs.rmSync(path.join(dir(replica), "a.txt"), { force: true });
    return disk;
  };
  await assert.rejects(replica.sync(), /a\.txt: File changed while it was read/);
  replica.engine.scanner.scan = scan;
  assert.equal(hub.engine.store.current(volume.id, "b.txt")?.deleted, 0);
  await replica.sync();
  assert.equal((await replica.state()).state, "synced");
  assert.equal(hub.engine.store.current(volume.id, "a.txt"), undefined);
});

test("a disk that fills up while a file is staged reports the space it needs, not a failed read", async (t) => {
  const { volume, connect, dir } = await setup(t);
  const replica = await connect("full");
  await replica.sync();
  fs.writeFileSync(path.join(dir(replica), "a.txt"), "a".repeat(100));
  const s = replica.engine.store;
  const v = s.volume(volume.id);
  const hash = s.scan(v).get("a.txt").hash;
  const copy = fs.copyFileSync;
  t.after(() => (fs.copyFileSync = copy));
  fs.copyFileSync = () => {
    throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
  };
  assert.throws(() => s.stage(v, "a.txt", hash), (error) => error.status === 507 && error.bytes === 100 && error.location === s.objects);
});
