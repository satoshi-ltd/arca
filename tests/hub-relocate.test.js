import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { init } from "../packages/daemon/storage.js";
import { start } from "../packages/daemon/server.js";

async function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arca-relocate-"));
  const nodes = new Set();
  t.after(async () => {
    for (const n of [...nodes].reverse()) await n.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const run = async (home) => {
    const n = await start(home, { timer: false });
    nodes.add(n);
    n.home = home;
    n.url = `http://127.0.0.1:${n.port}`;
    n.api = async (route, data, credential = n.engine.config.adminToken) => {
      const r = await fetch(`${n.url}${route}`, {
        method: data === undefined ? "GET" : "POST",
        headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      });
      const body = await r.json();
      if (!r.ok) throw Object.assign(new Error(body.error), { status: r.status });
      return body;
    };
    n.sync = () => n.engine.exclusive(() => n.engine.cycle());
    n.stop = async () => {
      await n.close();
      nodes.delete(n);
    };
    return n;
  };
  const node = async (name, role) => {
    const home = path.join(root, name);
    init(home, { name, role, port: 0 });
    return run(home);
  };
  const copy = async (from, name) => {
    const source = fs.realpathSync(from.home);
    fs.cpSync(source, path.join(root, name), { recursive: true });
    const home = fs.realpathSync(path.join(root, name));
    const moved = (value) => (value.startsWith(source + path.sep) ? home + value.slice(source.length) : value);
    const configPath = path.join(home, "config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    fs.writeFileSync(configPath, JSON.stringify({ ...config, root: moved(config.root) }, null, 2));
    const db = new DatabaseSync(path.join(home, "index.sqlite"));
    for (const { id, path: location } of db.prepare("SELECT id,path FROM volumes").all())
      db.prepare("UPDATE volumes SET path=? WHERE id=?").run(moved(location), id);
    db.close();
    return run(home);
  };
  const hub = await node("atlas", "hub");
  const volume = await hub.api("/v1/volumes", { name: "Documents" });
  const replica = await node("mac", "replica");
  const invite = await hub.api("/v1/devices", { name: "mac", role: "replica" });
  await replica.api("/v1/connect", { url: hub.url, token: invite.token });
  await replica.api("/v1/select", { id: volume.id });
  const folder = () => replica.engine.store.volume(volume.id).path;
  fs.writeFileSync(path.join(folder(), "notes.txt"), "before the move");
  await replica.sync();
  return { root, hub, volume, replica, invite, node, copy, folder };
}

const counts = (n) =>
  Object.fromEntries(["files", "local_files", "scan_cache", "sync_state"].map((table) => [table, n.engine.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n]));
const scanRow = (n, name) => n.engine.store.db.prepare("SELECT * FROM scan_cache WHERE path LIKE ?").get(`%${name}`);
const devices = (n) => n.engine.store.db.prepare("SELECT id FROM devices ORDER BY id").all().map((row) => row.id);

test("a replica follows the same hub to its new address without re-pairing, re-reading files or a new registration", async (t) => {
  const f = await setup(t);
  await f.hub.stop();
  const helios = await f.copy(f.hub, "helios");
  const before = counts(f.replica);
  const scanned = scanRow(f.replica, "notes.txt");
  const cursor = f.replica.engine.work.state(f.volume.id).cursor;
  const token = f.replica.engine.config.hub.token;
  const roster = devices(helios);
  const moved = await f.replica.api("/v1/hub-url", { url: helios.url, confirmed: true });
  assert.deepEqual(moved, { relocated: true, url: helios.url, name: "atlas" });
  assert.equal(f.replica.engine.config.hub.url, helios.url);
  assert.equal(f.replica.engine.config.hub.token, token, "the credential is kept");
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.replica.home, "config.json"), "utf8")).hub.url, helios.url, "the address is saved");
  assert.deepEqual(counts(f.replica), before, "no index row changes");
  assert.deepEqual(scanRow(f.replica, "notes.txt"), scanned, "the unchanged file keeps its recorded hash");
  assert.equal(f.replica.engine.work.state(f.volume.id).cursor, cursor, "the change cursor is kept");
  assert.deepEqual(devices(helios), roster, "the hub gets no new registration");
  fs.writeFileSync(path.join(f.folder(), "after.txt"), "made after the move");
  await f.replica.sync();
  assert.equal(f.replica.engine.error, null);
  assert.equal(fs.readFileSync(path.join(helios.engine.store.volume(f.volume.id).path, "after.txt"), "utf8"), "made after the move", "sync resumes against the new address");
});

test("an edit made while the hub was away reaches it at its new address", async (t) => {
  const f = await setup(t);
  await f.hub.stop();
  fs.writeFileSync(path.join(f.folder(), "notes.txt"), "edited offline");
  await f.replica.sync().catch(() => {});
  assert.equal(f.replica.engine.hubUnavailable, true);
  const helios = await f.copy(f.hub, "helios");
  await f.replica.api("/v1/hub-url", { url: helios.url, confirmed: true });
  assert.equal(f.replica.engine.hubUnavailable, false);
  await f.replica.sync();
  assert.equal(fs.readFileSync(path.join(helios.engine.store.volume(f.volume.id).path, "notes.txt"), "utf8"), "edited offline");
});

test("a new address is refused and nothing changes for another hub, a refused credential, an older copy, an unreachable or unverified address", async (t) => {
  const f = await setup(t);
  const stale = await (async () => {
    await f.hub.stop();
    const copy = await f.copy(f.hub, "stale");
    await copy.stop();
    return copy.home;
  })();
  const atlas = await f.copy({ home: f.hub.home }, "atlas-again");
  await f.replica.api("/v1/hub-url", { url: atlas.url, confirmed: true });
  fs.writeFileSync(path.join(f.folder(), "newer.txt"), "only on the newer hub");
  await f.replica.sync();
  const saved = () => JSON.parse(fs.readFileSync(path.join(f.replica.home, "config.json"), "utf8")).hub;
  const before = saved();
  const unchanged = () => {
    assert.deepEqual(saved(), before);
    assert.equal(f.replica.engine.config.hub.url, atlas.url);
  };
  const other = await f.node("other", "hub");
  await assert.rejects(f.replica.api("/v1/hub-url", { url: other.url, confirmed: true }), { status: 409, message: /different hub/ });
  unchanged();
  const older = await f.copy({ home: stale }, "older");
  await assert.rejects(f.replica.api("/v1/hub-url", { url: older.url, confirmed: true }), { status: 409, message: /latest copy/ });
  unchanged();
  const revoked = await f.copy({ home: stale }, "revoked");
  await revoked.api("/v1/revoke", { id: f.invite.id });
  await assert.rejects(f.replica.api("/v1/hub-url", { url: revoked.url, confirmed: true }), { status: 401, message: /Pair this device again/ });
  unchanged();
  await assert.rejects(f.replica.api("/v1/hub-url", { url: "http://127.0.0.1:1", confirmed: true }), { status: 503, message: /Could not reach/ });
  unchanged();
  await assert.rejects(f.replica.api("/v1/hub-url", { url: "http://192.0.2.10:17831", confirmed: true }));
  unchanged();
  await assert.rejects(f.replica.api("/v1/hub-url", { url: "ftp://atlas", confirmed: true }), { status: 400 });
  await assert.rejects(f.replica.api("/v1/hub-url", { url: atlas.url }), { status: 400, message: /Confirm/ });
  await assert.rejects(atlas.api("/v1/hub-url", { url: atlas.url, confirmed: true }), { status: 409 }, "a hub has no hub address");
  unchanged();
});

test("a full backup's own configuration follows the new address", async (t) => {
  const f = await setup(t);
  const backup = path.join(f.root, "backup");
  await f.replica.api("/v1/backup", { enabled: true, path: backup });
  await f.replica.sync();
  assert.ok(f.replica.engine.backupEngine, "the backup is open before the move");
  fs.rmSync(f.replica.engine.backupLock, { force: true });
  await f.hub.stop();
  const helios = await f.copy(f.hub, "helios");
  await f.replica.api("/v1/hub-url", { url: helios.url, confirmed: true });
  await f.replica.sync();
  assert.equal(f.replica.engine.backupEngine?.config.hub.url, helios.url, "the open backup follows the new address too");
  assert.equal(f.replica.engine.status().backup?.waiting ?? false, false, "and is not left waiting for the old hub");
  const backupConfig = JSON.parse(fs.readFileSync(path.join(backup, "state", "config.json"), "utf8"));
  assert.equal(backupConfig.hub.url, helios.url);
  assert.equal(backupConfig.hub.id, f.replica.engine.config.hub.id);
  assert.equal(f.replica.engine.config.backup.enabled, true, "backup stays on");
});

test("Disconnect with the hub away fails unless forced, and forcing it keeps the files", async (t) => {
  const f = await setup(t);
  await f.hub.stop();
  await assert.rejects(f.replica.api("/v1/disconnect", { confirmed: true }), { status: 503 });
  assert.ok(f.replica.engine.config.hub, "still connected");
  const result = await f.replica.api("/v1/disconnect", { confirmed: true, force: true });
  assert.deepEqual(result, { disconnected: true, filesRetained: true });
  assert.equal(f.replica.engine.config.hub, null);
  assert.equal(f.replica.engine.config.disconnectedHub.url, f.hub.url);
  assert.equal(fs.readFileSync(path.join(f.folder(), "notes.txt"), "utf8"), "before the move");
});

test("a copy that diverged from what this device last saw is refused, even when its revision count caught up", async (t) => {
  const f = await setup(t);
  await f.hub.stop();
  const fork = await f.copy(f.hub, "fork");
  const atlas = await f.copy(f.hub, "atlas-again");
  await f.replica.api("/v1/hub-url", { url: atlas.url, confirmed: true });
  fs.writeFileSync(path.join(f.folder(), "seen.txt"), "only atlas has this");
  await f.replica.sync();
  const forkFolder = fork.engine.store.volume(f.volume.id).path;
  for (let i = 0; i < 4; i++) {
    fs.writeFileSync(path.join(forkFolder, `fork-${i}.txt`), `fork ${i}`);
    await fork.engine.exclusive(() => fork.engine.scanHub(f.volume.id));
  }
  const cursor = f.replica.engine.work.state(f.volume.id).cursor;
  assert.ok(fork.engine.store.db.prepare("SELECT MAX(rev) AS rev FROM files").get().rev >= cursor, "the fork's revisions reach this device's cursor");
  await assert.rejects(f.replica.api("/v1/hub-url", { url: fork.url, confirmed: true }), { status: 409, message: /latest copy/ });
  assert.equal(f.replica.engine.config.hub.url, atlas.url);
});
