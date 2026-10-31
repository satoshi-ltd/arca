import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import http from "node:http";
import path from "node:path";
import { init, digest, Store, withinPath, insidePath } from "../packages/daemon/storage.js";
import { start } from "../packages/daemon/server.js";
import { beginInstallationReset, finishInstallationReset, resetTargets } from "../packages/daemon/installation-reset.js";

async function setup(t, options = { timer: false }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arca-test-"));
  const nodes = [];
  t.after(async () => {
    for (const n of nodes.reverse()) await n.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  async function node(name, role) {
    const home = path.join(root, name);
    init(home, { name, role, port: 0 });
    const n = await start(home, options);
    nodes.push(n);
    n.api = async (route, data, credential = n.engine.config.adminToken) => {
      const r = await fetch(`http://127.0.0.1:${n.port}${route}`, {
        method: data === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${credential}`,
          "X-Arca-Directories": "1",
          "X-Arca-Path-Transitions": "1",
          "Content-Type": "application/json",
        },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      });
      const body = await r.json();
      if (!r.ok)
        throw Object.assign(new Error(body.error), { status: r.status });
      return body;
    };
    n.sync = () => n.engine.exclusive(() => n.engine.cycle());
    return n;
  }
  const hub = await node("hub", "hub");
  const volume = await hub.api("/v1/volumes", { name: "Documents" });
  const connect = async (name, role = "replica") => {
    const replica = await node(name, role);
    const invite = await hub.api("/v1/devices", { name, role });
    await replica.api("/v1/connect", {
      url: `http://127.0.0.1:${hub.port}`,
      token: invite.token,
    });
    await replica.api("/v1/select", { id: volume.id });
    replica.invite = invite;
    return replica;
  };
  return { root, hub, volume, connect, node };
}
const write = (n, v, name, content) => {
  const file = path.join(n.engine.store.volume(v.id).path, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};
const read = (n, v, name) =>
  fs.readFileSync(path.join(n.engine.store.volume(v.id).path, name), "utf8");

import { Engine } from "../packages/daemon/engine.js";
import { recoverBackup } from "../packages/daemon/recovery.js";
const localPath = (n, v, p) => path.join(n.engine.store.volume(v.id).path, p);

for (const clear of [false, true])
  test(`SYNC-01 cache reset control=${clear}`, async (t) => {
    const { hub, volume, connect } = await setup(t);
    const r = await connect("r");
    write(r, volume, "note.txt", "same");
    await r.sync();
    fs.unlinkSync(localPath(hub, volume, "note.txt"));
    await hub.sync();
    await r.sync();
    const location = r.engine.store.volume(volume.id).path;
    await r.api("/v1/unselect", { id: volume.id });
    fs.writeFileSync(path.join(location, "note.txt"), "same");
    await r.api("/v1/select", { id: volume.id, path: location });
    if (clear) hub.engine.store.db.exec("DELETE FROM proposals");
    const trashed = [];
    r.engine.moveToTrash = async (files) => {
      for (const file of files) {
        trashed.push(path.basename(file));
        fs.rmSync(file);
      }
    };
    await r.sync();
    const names = fs.readdirSync(location);
    assert.deepEqual(trashed, ["note.txt"], "the stale copy goes to the Trash instead of being proposed");
    assert.equal(names.some((x) => x.includes("conflict")), false);
    assert.equal(fs.existsSync(path.join(location, "note.txt")), false);
    const head = hub.engine.store.current(volume.id, "note.txt");
    assert.ok(!head || head.deleted, "the hub deletion is never replayed away");
  });
test("SYNC-02 backup recovery ignore", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arca-audit-backup-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const home = path.join(root, "source"),
    targetHome = path.join(root, "target");
  init(home, { role: "backup" });
  const s = new Store(home);
  const v = s.addVolume("Docs");
  const names = [
    "app/index.js",
    "app/cache/data",
    "app/build/out.js",
    "app/dist/bundle.js",
    "app/logs/run.log",
    "notes/target/report.txt",
    "vendor/lib.php",
  ];
  const fixed = ["app/node_modules/a", "notes/.venv/pyvenv.cfg"];
  for (const [i, name] of [...names, ...fixed].entries()) {
    const p = path.join(v.path, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "data " + name);
    const item = s.capture(p);
    s.db.prepare("INSERT INTO backup_history VALUES(?,?)").run(
      i + 1,
      JSON.stringify({
        rev: i + 1,
        volume: v.id,
        path: name,
        ...item,
        deleted: 0,
        author: "original",
        created: new Date().toISOString(),
      }),
    );
  }
  s.close();
  const result = recoverBackup(home, targetHome);
  const dest = new Store(targetHome);
  try {
    const present = names.filter((n) =>
      fs.existsSync(path.join(dest.volume(v.id).path, n)),
    );
    assert.equal(present.length, 7);
    assert.equal(result.revisions, 9);
    for (const name of fixed)
      assert.equal(fs.existsSync(path.join(dest.volume(v.id).path, name)), false, name);
  } finally {
    dest.close();
  }
});
test("pending recovery errors stay within their folder", async (t) => {
  const { hub, volume, connect } = await setup(t);
  const beta = await hub.api("/v1/volumes", { name: "Zeta" });
  const r = await connect("r");
  await r.api("/v1/select", { id: beta.id });
  write(hub, volume, "docs/note.txt", "a");
  await hub.sync();
  await r.sync();
  const s = r.engine.store,
    materialize = s.materialize.bind(s);
  s.materialize = (row, expected) => {
    if (row.path === "docs/note.txt")
      throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
    return materialize(row, expected);
  };
  write(hub, volume, "docs/note.txt", "b");
  await hub.sync();
  await assert.rejects(r.sync(), /EBUSY/);
  write(hub, beta, "fresh.txt", "new");
  await hub.sync();
  await assert.rejects(r.sync(), /EBUSY/);

  assert.equal(fs.existsSync(localPath(r, beta, "fresh.txt")), true);
  assert.equal(r.engine.phase, "error");
  assert.equal(r.engine.folderStates.get(beta.id).state, "synced");
  s.materialize = materialize;
  await r.sync();
  assert.equal(fs.readFileSync(localPath(r, volume, "docs/note.txt"), "utf8"), "b");
});
test("SYNC-04 pending revision gap", async (t) => {
  const { hub, volume } = await setup(t);
  const s = hub.engine.store;
  const file = path.join(volume.path, "x");
  fs.writeFileSync(file, "payload");
  const item = s.capture(file);
  fs.unlinkSync(file);
  const original = s.materialize;
  s.materialize = () => {
    throw Error("injected write failure");
  };
  assert.throws(
    () => s.commit(volume.id, "x", item, "author", true),
    /injected/,
  );
  s.materialize = original;
  const before = await hub.api(`/v1/changes?volume=${volume.id}&after=0`);
  s.recover();
  const after = await hub.api(
    `/v1/changes?volume=${volume.id}&after=${before.through}`,
  );
  assert.equal(before.files.length, 0);
  assert.equal(after.files.length, 1);
  assert.ok(s.current(volume.id, "x"));
});
test("SYNC-05 corrupt blob reupload short circuit", async (t) => {
  const { hub, volume } = await setup(t);
  const good = "intact";
  const hash = digest(good);
  const s = hub.engine.store;
  fs.writeFileSync(s.blob(hash), "broken");
  const response = await fetch(
    `http://127.0.0.1:${hub.port}/v1/uploads/${hash}?offset=0&size=${good.length}`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${hub.engine.config.adminToken}` },
      body: good,
    },
  );
  const result = await response.json();
  assert.equal(result.complete, true);
  assert.equal(fs.readFileSync(s.blob(hash), "utf8"), good);
});
test("hub reselection preserves files recreated after a tombstone", async (t) => {
  const { hub, volume } = await setup(t);
  write(hub, volume, "note.txt", "old");
  await hub.sync();
  fs.unlinkSync(localPath(hub, volume, "note.txt"));
  await hub.sync();
  await hub.api("/v1/unselect", { id: volume.id });
  write(hub, volume, "note.txt", "new");
  await hub.api("/v1/select", { id: volume.id });
  let error = null;
  try {
    await hub.sync();
  } catch (e) {
    error = e.message;
  }
  const names = fs.readdirSync(volume.path);
  assert.ok(names.includes("note.txt"));
  assert.equal(read(hub, volume, "note.txt"), "new");
  assert.equal(error, null);
});
for (const origin of ["hub", "replica"])
  test(`SYNC-07 type change origin=${origin}`, async (t) => {
    const { hub, volume, connect } = await setup(t);
    const r = await connect("r");
    write(hub, volume, "x", "old");
    await hub.sync();
    await r.sync();
    const n = origin === "hub" ? hub : r;
    fs.unlinkSync(localPath(n, volume, "x"));
    fs.mkdirSync(localPath(n, volume, "x"));
    write(n, volume, "x/child", "new");
    let error = null;
    try {
      await n.sync();
      await r.sync();
    } catch (e) {
      error = e.message;
    }
    assert.equal(error, null);
  });
test("SYNC-08 case rename", async (t) => {
  const { hub, volume } = await setup(t);
  write(hub, volume, "fotos/a.txt", "a");
  await hub.sync();
  fs.renameSync(
    path.join(volume.path, "fotos"),
    path.join(volume.path, "Fotos"),
  );
  await hub.sync();
  assert.equal(hub.engine.store.current(volume.id, "Fotos/a.txt").deleted, 0);
});
test("malformed policy is reported per folder without breaking administrative APIs", async (t) => {
  const { hub, volume } = await setup(t);
  write(hub, volume, ".arcaignore", "x".repeat(65537));
  const result = {};
  for (const p of ["/v1/catalog", "/v1/status", "/v1/remote"]) {
    try {
      await hub.api(p);
      result[p] = "ok";
    } catch (e) {
      result[p] = { status: e.status, error: e.message };
    }
  }
  assert.equal(result["/v1/catalog"], "ok");
});
test("SYNC-12 pause restart", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arca-audit-pause-"));
  init(root, { port: 0 });
  let d = await start(root, { timer: false });
  t.after(async () => {
    await d.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const res = await fetch(`http://127.0.0.1:${d.port}/v1/pause`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${d.engine.config.adminToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ paused: true }),
  });
  assert.equal(res.status, 200);
  assert.equal(d.engine.paused, true);
  await d.close();
  d = await start(root, { timer: false });
  assert.equal(d.engine.paused, true);
});
test("decomposed accents synchronize without renaming local files or creating duplicate revisions", async (t) => {
  const { hub, volume, connect } = await setup(t);
  const mac = await connect("mac");
  const raw = "cafe\u0301/re\u0301sume\u0301.txt";
  const canonical = raw.normalize("NFC");
  write(hub, volume, raw, "data");
  await hub.sync();
  await mac.sync();
  assert.equal(read(mac, volume, canonical), "data");
  assert.ok(fs.existsSync(localPath(hub, volume, raw)));
  const before = hub.engine.store.current(volume.id, canonical).rev;
  await hub.sync();
  await mac.sync();
  assert.equal(hub.engine.store.current(volume.id, canonical).rev, before);
  write(mac, volume, canonical, "edited");
  await mac.sync();
  await hub.sync();
  assert.equal(read(hub, volume, raw), "edited");
  const scoped = hub.engine.store.scan(hub.engine.store.volume(volume.id), [
    raw,
  ]);
  assert.ok(scoped.has(canonical));
  assert.ok(
    hub.engine.store
      .rowsInScope(volume.id, [raw])
      .some((row) => row.path === canonical),
  );
  fs.unlinkSync(localPath(hub, volume, raw));
  await hub.sync();
  await mac.sync();
  assert.equal(hub.engine.store.current(volume.id, canonical).deleted, 1);
  assert.equal(fs.existsSync(localPath(mac, volume, canonical)), false);
});
test("hub reselection does not apply directory tombstones to retained local files", async (t) => {
  const { hub, volume } = await setup(t);
  write(hub, volume, "docs/note.txt", "old");
  await hub.sync();
  fs.rmSync(localPath(hub, volume, "docs"), { recursive: true, maxRetries: 10, retryDelay: 100 });
  await hub.sync();
  await hub.api("/v1/unselect", { id: volume.id });
  write(hub, volume, "docs/note.txt", "new");
  await hub.api("/v1/select", { id: volume.id });
  await hub.sync();
  const names = fs.readdirSync(localPath(hub, volume, "docs"));
  assert.ok(names.includes("note.txt"));
  assert.equal(read(hub, volume, "docs/note.txt"), "new");
});
test("failed watcher registration uses bounded fallback instead of repeated full scans", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arca-audit-watch-"));
  init(root, { port: 0 });
  const s = new Store(root);
  const v = s.addVolume("Docs");
  s.close();
  const original = fs.watch;
  let attempts = 0;
  fs.watch = function (folder, ...args) {
    if (String(folder) === v.path) {
      attempts++;
      throw Object.assign(Error("injected watcher failure"), {
        code: "ENOSPC",
      });
    }
    return original.call(this, folder, ...args);
  };
  let daemon;
  t.after(async () => {
    if (daemon) await daemon.close();
    fs.watch = original;
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  daemon = await start(root);
  const scan = daemon.engine.scanner.scan.bind(daemon.engine.scanner);
  const visits = [];
  daemon.engine.scanner.scan = (vol, scopes) => {
    visits.push({ at: Date.now(), scopes });
    return scan(vol, scopes);
  };
  await new Promise((r) => setTimeout(r, 3300));
  assert.ok(visits.length <= 1);
  assert.equal(attempts, 1);
});
for (const incremental of [false, true])
  for (const origin of ["hub", "replica"])
    test(`file-directory round trip and case rename converge (${origin}, incremental=${incremental})`, async (t) => {
      const { hub, volume, connect } = await setup(t);
      const r = await connect("r"),
        other = await connect("other");
      write(hub, volume, "item", "first");
      await hub.sync();
      await r.sync();
      await other.sync();
      const n = origin === "hub" ? hub : r;
      fs.unlinkSync(localPath(n, volume, "item"));
      write(n, volume, "item/child", "nested");
      n.engine.work.mark(volume.id);
      await n.engine.cycle({ incremental });
      await r.engine.cycle({ incremental });
      await other.engine.cycle({ incremental });
      assert.equal(read(other, volume, "item/child"), "nested");
      fs.rmSync(localPath(n, volume, "item"), { recursive: true, maxRetries: 10, retryDelay: 100 });
      write(n, volume, "item", "last");
      n.engine.work.mark(volume.id);
      await n.engine.cycle({ incremental });
      await r.engine.cycle({ incremental });
      await other.engine.cycle({ incremental });
      assert.equal(read(other, volume, "item"), "last");
      fs.renameSync(localPath(n, volume, "item"), localPath(n, volume, "Item"));
      n.engine.work.mark(volume.id);
      await n.engine.cycle({ incremental });
      await r.engine.cycle({ incremental });
      await other.engine.cycle({ incremental });
      assert.ok(
        fs
          .readdirSync(other.engine.store.volume(volume.id).path)
          .includes("Item"),
      );
      assert.equal(read(other, volume, "Item"), "last");
    });
test("case-only directory rename preserves excluded contents on receiving copies", async (t) => {
  const { hub, volume, connect } = await setup(t);
  const r = await connect("r");
  write(hub, volume, "fotos/a.txt", "a");
  await hub.sync();
  await r.sync();
  write(r, volume, "fotos/.DS_Store", "metadata");
  fs.renameSync(
    path.join(volume.path, "fotos"),
    path.join(volume.path, "Fotos"),
  );
  await hub.sync();
  await r.sync();
  assert.ok(
    fs.readdirSync(r.engine.store.volume(volume.id).path).includes("Fotos"),
  );
  assert.equal(read(r, volume, "Fotos/.DS_Store"), "metadata");
  assert.equal(read(r, volume, "Fotos/a.txt"), "a");
});
test("hub reselection preserves edits to still-live files as conflicts", async (t) => {
  const { hub, volume } = await setup(t);
  write(hub, volume, "live", "original");
  await hub.sync();
  await hub.api("/v1/unselect", { id: volume.id });
  write(hub, volume, "live", "edited");
  await hub.api("/v1/select", { id: volume.id });
  await hub.sync();
  const conflict = fs
    .readdirSync(volume.path)
    .find((n) => n.startsWith("live.conflict-local-"));
  assert.ok(conflict);
  assert.equal(read(hub, volume, conflict), "edited");
  assert.equal(read(hub, volume, "live"), "original");
});
test("HTTP failure still proves the old hub is reachable during promotion", async (t) => {
  const { hub, volume, connect } = await setup(t);
  const r = await connect("r");
  write(hub, volume, "a", "a");
  await hub.sync();
  await r.sync();
  const server = http.createServer((req, res) => {
    res.writeHead(500);
    res.end("unavailable");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  r.engine.config.hub.url = `http://127.0.0.1:${server.address().port}`;
  await assert.rejects(r.engine.promote(true), /reachable/);
  assert.equal(r.engine.config.role, "replica");
});
test("removing a remote ignore policy reconciles previously excluded files immediately", async (t) => {
  const { hub, volume, connect } = await setup(t);
  const r = await connect("r");
  write(hub, volume, "hidden/a", "original");
  await hub.sync();
  await r.sync();
  write(hub, volume, ".arcaignore", "hidden/\n");
  await hub.sync();
  await r.sync();
  write(hub, volume, "hidden/new", "included after removal");
  fs.unlinkSync(localPath(hub, volume, ".arcaignore"));
  await hub.sync();
  await r.engine.cycle({ incremental: true });
  assert.equal(fs.existsSync(localPath(r, volume, ".arcaignore")), false);
  assert.equal(read(r, volume, "hidden/new"), "included after removal");
});
test("moving a folder preserves custom exclusions and retains the original", async (t) => {
  const { hub, volume, root } = await setup(t);
  write(hub, volume, ".arcaignore", "private/\n");
  write(hub, volume, "visible", "a");
  write(hub, volume, "private/secret", "fixture");
  await hub.sync();
  const { moveFolder } = await import("../packages/daemon/maintenance.js");
  const destination = path.join(root, "moved");
  moveFolder(hub.engine, volume.id, destination);
  assert.equal(
    fs.readFileSync(path.join(destination, ".arcaignore"), "utf8"),
    "private/\n",
  );
  assert.equal(
    fs.readFileSync(path.join(destination, "private/secret"), "utf8"),
    "fixture",
  );
  assert.ok(fs.existsSync(path.join(volume.path, "visible")));
});
test("failed relocation leaves no destination and keeps the original mapping", async (t) => {
  const { hub, volume, root } = await setup(t);
  write(hub, volume, "a", "before");
  await hub.sync();
  const { moveFolder } = await import("../packages/daemon/maintenance.js");
  const original = fs.cpSync;
  fs.cpSync = (...args) => {
    original(...args);
    fs.writeFileSync(path.join(volume.path, "a"), "changed");
  };
  try {
    assert.throws(
      () => moveFolder(hub.engine, volume.id, path.join(root, "moved")),
      /changed during relocation/,
    );
  } finally {
    fs.cpSync = original;
  }
  assert.equal(hub.engine.store.volume(volume.id).path, volume.path);
  assert.equal(fs.existsSync(path.join(root, "moved")), false);
  assert.equal(
    fs.readdirSync(root).some((n) => n.startsWith(".arca-move-")),
    false,
  );
});

test("timed pause persists its deadline and expires durably after restart", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arca-pause-timed-"));
  init(root, { port: 0 });
  let d = await start(root, { timer: false });
  t.after(async () => {
    await d.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  d.engine.setPaused(true, Date.now() + 1000);
  const deadline = d.engine.pauseUntil;
  await d.close();
  d = await start(root, { timer: false });
  assert.equal(d.engine.pauseUntil, deadline);
  assert.equal(d.engine.paused, true);
  const now = Date.now;
  Date.now = () => deadline + 1;
  try {
    await d.engine.cycle();
  } finally {
    Date.now = now;
  }
  assert.equal(d.engine.paused, false);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(root, "config.json"))).paused,
    false,
  );
  const save = d.engine.store.saveConfig;
  d.engine.store.saveConfig = () => {
    throw Error("write failed");
  };
  try {
    assert.throws(() => d.engine.setPaused(true), /write failed/);
  } finally {
    d.engine.store.saveConfig = save;
  }
  assert.equal(d.engine.paused, false);
  assert.equal(d.engine.config.paused, false);
});

test("pending case rename hides its tombstone until the complete revision is materialized", async (t) => {
  const { hub, volume } = await setup(t),
    s = hub.engine.store;
  write(hub, volume, "name", "old");
  await hub.sync();
  const old = s.current(volume.id, "name");
  const materialize = s.materialize;
  s.materialize = () => {
    throw Error("interrupted");
  };
  try {
    assert.throws(
      () =>
        s.commit(
          volume.id,
          "Name",
          { hash: old.hash, size: old.size },
          hub.engine.config.id,
          true,
          old.hash,
          null,
          "name",
        ),
      /interrupted/,
    );
  } finally {
    s.materialize = materialize;
  }
  const blocked = await hub.api(
    `/v1/changes?volume=${volume.id}&after=${old.rev}`,
  );
  assert.equal(blocked.through, old.rev);
  assert.equal(blocked.files.length, 0);
  s.recover(volume.id);
  const ready = await hub.api(
    `/v1/changes?volume=${volume.id}&after=${old.rev}`,
  );
  assert.equal(
    ready.files.find((row) => row.path === "name").replacementPath,
    "Name",
  );
  assert.equal(read(hub, volume, "Name"), "old");
});

test("a file edited while its deletion is applied stays at its path and is rescanned", async (t) => {
  const { hub, volume } = await setup(t),
    s = hub.engine.store;
  write(hub, volume, "note", "original");
  await hub.sync();
  const old = s.current(volume.id, "note");
  write(hub, volume, "note", "edited");
  s.commit(volume.id, "note", null, hub.engine.config.id, true, old.hash);
  assert.equal(read(hub, volume, "note"), "edited");
  assert.equal(
    fs.readdirSync(volume.path).some((n) => n.includes("conflict-local")),
    false,
  );
  assert.ok(
    s.db
      .prepare("SELECT 1 FROM sync_dirty WHERE volume=? AND path='note'")
      .get(volume.id),
  );
  await hub.engine.exclusive(() => hub.engine.cycle({ incremental: true }));
  const revived = s.current(volume.id, "note");
  assert.equal(revived.deleted, 0);
  assert.equal(fs.readFileSync(s.blob(revived.hash), "utf8"), "edited");
});

test("repeated case-only renames converge without reviving earlier spellings", async (t) => {
  const { hub, volume, connect } = await setup(t);
  const r = await connect("r");
  write(hub, volume, "a/file", "data");
  await hub.sync();
  await r.sync();
  for (const [from, to] of [
    ["a", "A"],
    ["A", "a"],
    ["a", "A"],
  ]) {
    fs.renameSync(localPath(r, volume, from), localPath(r, volume, to));
    await r.sync();
    await hub.sync();
    await r.sync();
    assert.ok(fs.readdirSync(volume.path).includes(to));
    assert.equal(read(hub, volume, `${to}/file`), "data");
  }
});

test("directory-capable clients must also support safe path transitions", async (t) => {
  const { hub, volume, connect } = await setup(t);
  const r = await connect("r");
  const response = await fetch(
    `http://127.0.0.1:${hub.port}/v1/changes?volume=${volume.id}`,
    {
      headers: {
        Authorization: `Bearer ${r.invite.token}`,
        "X-Arca-Directories": "1",
      },
    },
  );
  assert.equal(response.status, 412);
  assert.match((await response.json()).error, /Update this client/);
});

test("destroy replica requires confirmation, removes local data and hub registration, and supports new setup", async (t) => {
  const f = await setup(t);
  const r = await f.connect("destroy-me");
  const v = r.engine.store.volumes()[0];
  fs.writeFileSync(path.join(v.path, "unsynced.txt"), "local only");
  fs.writeFileSync(path.join(f.volume.path, "hub.txt"), "keep");
  const previews = path.join(r.engine.store.home, "previews");
  fs.mkdirSync(previews, { recursive: true });
  fs.writeFileSync(path.join(previews, "cached.jpg"), "private derivative");
  const oldToken = r.engine.config.adminToken;
  const oldId = r.engine.config.id;
  await assert.rejects(r.api("/v1/destroy-replica", {}), /Confirm/);
  await assert.rejects(
    f.hub.api("/v1/destroy-replica", { confirmed: true }),
    /Only a device/,
  );
  assert.ok(fs.existsSync(v.path));
  await r.api("/v1/destroy-replica", { confirmed: true });
  assert.equal(fs.existsSync(v.path), false);
  assert.equal(fs.existsSync(previews), false);
  assert.equal(
    fs.readFileSync(path.join(f.volume.path, "hub.txt"), "utf8"),
    "keep",
  );
  assert.equal(
    f.hub.engine.store.db
      .prepare("SELECT id FROM devices WHERE id=?")
      .get(r.invite.id),
    undefined,
  );
  assert.notEqual(r.engine.config.id, oldId);
  await assert.rejects(
    r.api("/v1/status", undefined, oldToken),
    /Unauthorized/,
  );
  assert.equal((await r.api("/v1/status")).needsSetup, true);
  assert.equal(r.engine.store.volumes().length, 0);
  await r.api("/v1/setup", {
    role: "replica",
    name: "Fresh replica",
    root: r.engine.config.root,
  });
  const invite = await f.hub.api("/v1/devices", {
    name: "Fresh replica",
    role: "replica",
  });
  await r.api("/v1/connect", {
    url: `http://127.0.0.1:${f.hub.port}`,
    token: invite.token,
  });
  await r.api("/v1/select", { id: f.volume.id });
  await r.sync();
  assert.equal(
    fs.readFileSync(
      path.join(r.engine.store.volumes()[0].path, "hub.txt"),
      "utf8",
    ),
    "keep",
  );
});

test("desktop destruction can resume after filesystem failure and rejects swapped folder paths", async (t) => {
  const f = await setup(t);
  const r = await f.connect("retry-destroy");
  const folder = r.engine.store.volumes()[0].path;
  const original = fs.rmSync;
  fs.rmSync = (location, ...args) => {
    if (location === folder) throw new Error("disk busy");
    return original(location, ...args);
  };
  try {
    await assert.rejects(
      r.api("/v1/destroy-replica", { confirmed: true }),
      /Internal error/,
    );
  } finally {
    fs.rmSync = original;
  }
  assert.ok(r.engine.config.destroyPending);
  assert.ok(fs.existsSync(folder));
  await assert.rejects(r.api("/v1/sync", {}), /requires setup or retrying the erase/);
  const moved = folder + "-original";
  fs.renameSync(folder, moved);
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, "unrelated.txt"), "keep");
  await assert.rejects(
    r.api("/v1/destroy-replica", { confirmed: true }),
    /changed during destruction/,
  );
  assert.equal(
    fs.readFileSync(path.join(folder, "unrelated.txt"), "utf8"),
    "keep",
  );
  fs.renameSync(folder, folder + "-unrelated");
  fs.renameSync(moved, folder);
  await r.api("/v1/destroy-replica", { confirmed: true });
  assert.equal(fs.existsSync(folder), false);
  assert.equal(r.engine.config.needsSetup, true);
});

test("destroy after disconnect deletes replica folders and configured backup but leaves unrelated root files", async (t) => {
  const f = await setup(t);
  const r = await f.connect("disconnected-destroy");
  const folder = r.engine.store.volumes()[0].path;
  const unrelated = path.join(r.engine.config.root, "unrelated.txt");
  fs.writeFileSync(unrelated, "keep");
  const backup = path.join(r.engine.store.home, "backup-copy");
  fs.mkdirSync(backup);
  fs.writeFileSync(path.join(backup, "archive"), "copy");
  fs.mkdirSync(path.join(backup, "state"));
  fs.writeFileSync(path.join(backup, "state", "config.json"), JSON.stringify({ role: "backup" }));
  r.engine.config.backup = { path: backup, enabled: false };
  r.engine.store.saveConfig();
  await r.api("/v1/disconnect", { confirmed: true });
  assert.ok(fs.existsSync(folder));
  await r.api("/v1/destroy-replica", { confirmed: true });
  assert.equal(fs.existsSync(folder), false);
  assert.equal(fs.existsSync(backup), false);
  assert.equal(fs.readFileSync(unrelated, "utf8"), "keep");
});

test("a restarted daemon resumes its durable replica destruction before allowing setup", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arca-destroy-restart-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  init(root, { role: "replica", port: 0 });
  const first = new Engine(root);
  const folder = first.store.addVolume("Saved");
  fs.writeFileSync(path.join(folder.path, "unsynced.txt"), "remove");
  const remove = fs.rmSync;
  fs.rmSync = (location, ...args) => {
    if (location === folder.path) throw new Error("interrupted deletion");
    return remove(location, ...args);
  };
  try {
    await assert.rejects(first.destroyReplica(), /interrupted deletion/);
  } finally {
    fs.rmSync = remove;
    first.close();
  }
  const second = new Engine(root);
  try {
    assert.equal(second.config.needsSetup, true);
    assert.equal(second.config.destroyPending, undefined);
    assert.equal(second.store.volumes().length, 0);
    assert.equal(fs.existsSync(folder.path), false);
  } finally {
    second.close();
  }
});

test("failed destruction journal write preserves files and permits a durable retry", async (t) => {
  const f = await setup(t);
  const r = await f.connect("journal-destroy");
  await r.api("/v1/disconnect", { confirmed: true });
  const folder = r.engine.store.volumes()[0].path;
  const save = r.engine.store.saveConfig.bind(r.engine.store);
  r.engine.store.saveConfig = () => {
    throw new Error("configuration disk full");
  };
  await assert.rejects(
    r.api("/v1/destroy-replica", { confirmed: true }),
    /Internal error/,
  );
  assert.equal(r.engine.config.destroyPending, undefined);
  assert.ok(fs.existsSync(folder));
  r.engine.store.saveConfig = save;
  await r.api("/v1/destroy-replica", { confirmed: true });
  assert.equal(fs.existsSync(folder), false);
});

test("confirmed desktop destruction works with an unreachable hub and preserves hub files", async (t) => {
  const f = await setup(t);
  const replica = await f.connect("offline-destroy");
  const folder = replica.engine.store.volumes()[0].path;
  fs.writeFileSync(
    path.join(folder, "local-only.txt"),
    "delete only on confirmation",
  );
  fs.writeFileSync(path.join(f.volume.path, "hub.txt"), "retained");
  const db = replica.engine.store.db;
  const marker = "old-device-private-history";
  db.exec("PRAGMA secure_delete=OFF; CREATE TABLE erase_probe (value TEXT)");
  db.prepare("INSERT INTO erase_probe VALUES (?)").run(marker.repeat(500));
  db.exec("DELETE FROM erase_probe; PRAGMA wal_checkpoint(TRUNCATE)");
  const databaseFile = db.prepare("PRAGMA database_list").get().file;
  assert.ok(fs.readFileSync(databaseFile).includes(Buffer.from(marker)));
  const home = replica.engine.store.home;
  const residue = [
    "daemon.log",
    "service.log",
    "update-watch.log",
    "config.json.12345678-1234-1234-1234-123456789abc.tmp",
  ];
  for (const name of residue)
    fs.writeFileSync(path.join(home, name), "private-old-device-marker");
  const log = fs.openSync(path.join(home, "daemon.log"), "a");
  t.after(() => fs.closeSync(log));
  fs.writeFileSync(path.join(home, "unrelated.tmp"), "keep");
  replica.engine.config.hub.url = "http://127.0.0.1:1";
  await replica.api("/v1/destroy-replica", { confirmed: true });
  assert.equal(
    fs.readFileSync(databaseFile).includes(Buffer.from(marker)),
    false,
    "historical database pages erased",
  );
  for (const name of residue)
    if (name.endsWith(".log"))
      assert.equal(fs.readFileSync(path.join(home, name), "utf8"), "");
    else
      assert.equal(
        fs.existsSync(path.join(home, name)),
        false,
        `${name} is erased`,
      );
  fs.writeSync(log, "fresh installation");
  assert.equal(
    fs.readFileSync(path.join(home, "daemon.log"), "utf8"),
    "fresh installation",
  );
  assert.equal(
    fs.readFileSync(path.join(home, "unrelated.tmp"), "utf8"),
    "keep",
  );
  assert.equal(fs.existsSync(folder), false);
  assert.equal(replica.engine.config.needsSetup, true);
  assert.equal(
    fs.readFileSync(path.join(f.volume.path, "hub.txt"), "utf8"),
    "retained",
  );
});

test("desktop erase refuses hardlinked logs without changing external files", async (t) => {
  const f = await setup(t);
  const replica = await f.connect("hardlinked-log");
  const home = replica.engine.store.home;
  const external = path.join(f.volume.path, "external-log.txt");
  const logfile = path.join(home, "daemon.log");
  fs.writeFileSync(external, "keep outside Arca state");
  fs.linkSync(external, logfile);
  await assert.rejects(replica.api("/v1/destroy-replica", { confirmed: true }), /Log location changed/);
  assert.equal(fs.readFileSync(external, "utf8"), "keep outside Arca state");
  assert.ok(replica.engine.config.destroyPending);
  fs.unlinkSync(logfile);
  await replica.api("/v1/destroy-replica", { confirmed: true });
  assert.equal(replica.engine.config.needsSetup, true);
  assert.equal(fs.readFileSync(external, "utf8"), "keep outside Arca state");
});

test("destroy hub deletes its files/history and returns to setup without deleting replica copies", async (t) => {
  const { hub, volume, connect } = await setup(t);
  fs.writeFileSync(path.join(volume.path, "kept.txt"), "original");
  await hub.sync();
  fs.writeFileSync(path.join(volume.path, "kept.txt"), "latest");
  await hub.sync();
  const first = await connect("first-copy");
  const second = await connect("second-copy");
  await first.sync();
  await second.sync();
  const oldId = hub.engine.config.id;
  const oldAdmin = hub.engine.config.adminToken;
  await assert.rejects(hub.api("/v1/destroy-hub", {}), /Confirm/);
  await assert.rejects(
    hub.api("/v1/destroy-hub", { confirmed: true }, first.invite.token),
    { status: 403 },
  );
  await assert.rejects(
    first.api("/v1/destroy-hub", { confirmed: true }),
    /Only a hub/,
  );
  assert.ok(fs.existsSync(volume.path));
  const covers = path.join(hub.engine.store.home, "music-covers");
  fs.mkdirSync(covers, { recursive: true });
  fs.writeFileSync(path.join(covers, `${"a".repeat(64)}-360.jpg`), "cover");
  const downloads = path.join(hub.engine.store.home, "video-downloads");
  fs.mkdirSync(downloads, { recursive: true });
  fs.writeFileSync(path.join(downloads, `${"b".repeat(32)}.mkv`), "film");
  await hub.api("/v1/destroy-hub", { confirmed: true });
  assert.equal(fs.existsSync(downloads), false, "erasing removes downloaded videos");
  assert.equal(fs.existsSync(volume.path), false);
  assert.equal(fs.existsSync(path.join(covers, `${"a".repeat(64)}-360.jpg`)), false, "erasing the hub removes music covers");
  assert.equal(
    hub.engine.store.db.prepare("SELECT count(*) AS n FROM revisions").get().n,
    0,
  );
  assert.equal(
    hub.engine.store.db.prepare("SELECT count(*) AS n FROM devices").get().n,
    0,
  );
  assert.notEqual(hub.engine.config.id, oldId);
  assert.notEqual(hub.engine.config.adminToken, oldAdmin);
  assert.equal(hub.engine.config.needsSetup, true);
  assert.equal(hub.engine.config.role, "replica");
  for (const replica of [first, second]) {
    await replica.sync();
    assert.equal(replica.engine.config.hub, null);
    assert.equal(
      fs.readFileSync(
        path.join(replica.engine.store.volume(volume.id).path, "kept.txt"),
        "utf8",
      ),
      "latest",
    );
  }
  assert.equal((await hub.api("/v1/status")).needsSetup, true);
});

test("interrupted hub destruction blocks catalog reads until a safe retry", async (t) => {
  const { hub, volume } = await setup(t);
  fs.writeFileSync(path.join(volume.path, "kept.txt"), "not yet removed");
  const remove = fs.rmSync;
  fs.rmSync = (target, ...args) => {
    if (target === volume.path) throw new Error("disk unavailable");
    return remove(target, ...args);
  };
  try {
    await assert.rejects(
      hub.api("/v1/destroy-hub", { confirmed: true }),
      /Internal error/,
    );
    assert.ok(hub.engine.config.destroyPending);
    await assert.rejects(hub.api("/v1/catalog"), { status: 409 });
    assert.ok(fs.existsSync(volume.path));
  } finally {
    fs.rmSync = remove;
  }
  await hub.api("/v1/destroy-hub", { confirmed: true });
  assert.equal(fs.existsSync(volume.path), false);
  assert.equal(hub.engine.config.needsSetup, true);
});

test("canonically equivalent local names never overwrite one another", async (t) => {
  const { hub, volume } = await setup(t);
  const composed = "café.txt",
    decomposed = "cafe\u0301.txt";
  write(hub, volume, composed, "first");
  write(hub, volume, decomposed, "second");
  const entries = fs.readdirSync(hub.engine.store.volume(volume.id).path);
  if (!entries.includes(composed) || !entries.includes(decomposed)) {
    t.skip("Filesystem treats equivalent Unicode names as the same entry");
    return;
  }
  await assert.rejects(
    hub.sync(),
    /equivalent Unicode names|Multiple Unicode spellings/,
  );
  assert.equal(read(hub, volume, composed), "first");
  assert.equal(read(hub, volume, decomposed), "second");
  assert.equal(hub.engine.store.current(volume.id, composed), undefined);
});

const loseNextProposeReply = (replica) => {
  const json = replica.engine.json.bind(replica.engine);
  let lost = false;
  replica.engine.json = async (route, body, options) => {
    const result = await json(route, body, options);
    if (route === "/v1/propose" && body?.hash && !lost) {
      lost = true;
      throw new Error("Proposal reply lost");
    }
    return result;
  };
};
const conflicts = (n, v) =>
  fs
    .readdirSync(n.engine.store.volume(v.id).path)
    .filter((name) => name.includes(".conflict-"));

test("a device's edit after its own lost proposal reply is not a conflict", async (t) => {
  const { hub, volume, connect } = await setup(t);
  write(hub, volume, "note.txt", "original");
  await hub.sync();
  const phone = await connect("phone");
  await phone.sync();
  loseNextProposeReply(phone);
  write(phone, volume, "note.txt", "first edit");
  await assert.rejects(phone.sync(), /reply lost/);
  assert.equal(read(hub, volume, "note.txt"), "first edit");
  write(phone, volume, "note.txt", "second edit");
  await phone.sync();
  assert.equal(read(hub, volume, "note.txt"), "second edit");
  assert.equal(read(phone, volume, "note.txt"), "second edit");
  assert.deepEqual(conflicts(hub, volume), []);
  assert.deepEqual(conflicts(phone, volume), []);

  loseNextProposeReply(phone);
  write(phone, volume, "note.txt", "third edit");
  await assert.rejects(phone.sync(), /reply lost/);
  fs.unlinkSync(localPath(phone, volume, "note.txt"));
  await phone.sync();
  assert.equal(hub.engine.store.current(volume.id, "note.txt").deleted, 1);
  assert.equal(fs.existsSync(localPath(phone, volume, "note.txt")), false);
  assert.deepEqual(conflicts(hub, volume), []);
});

test("an old request repeated after newer edits by the same device never changes later content", async (t) => {
  const { hub, volume, connect } = await setup(t);
  const mac = await connect("replay");
  write(mac, volume, "note.txt", "first");
  await mac.sync();
  const base = hub.engine.store.current(volume.id, "note.txt").rev;
  const deletion = { volume: volume.id, path: "note.txt", base, hash: null };
  await hub.api("/v1/propose", deletion, mac.invite.token);
  await mac.sync();
  write(mac, volume, "note.txt", "recreated");
  await mac.sync();
  const advance = async (content) => {
    write(mac, volume, "unrelated.txt", content);
    await mac.sync();
  };
  for (const content of ["one", "two"]) {
    await hub.api("/v1/propose", deletion, mac.invite.token);
    assert.equal(hub.engine.store.current(volume.id, "note.txt").deleted, 0, "a repeated deletion never removes the recreated file");
    await advance(content);
  }
  assert.equal(read(hub, volume, "note.txt"), "recreated");
  const older = Buffer.from("older content");
  const olderHash = digest(older);
  fs.writeFileSync(hub.engine.store.blob(olderHash), older);
  const current = hub.engine.store.current(volume.id, "note.txt").rev;
  const write1 = { volume: volume.id, path: "note.txt", base: current, hash: olderHash, size: older.length };
  await hub.api("/v1/propose", write1, mac.invite.token);
  write(mac, volume, "note.txt", "newest");
  await mac.sync();
  await mac.sync();
  for (const content of ["three", "four"]) {
    await hub.api("/v1/propose", write1, mac.invite.token);
    assert.equal(read(hub, volume, "note.txt"), "newest", "a repeated write never overwrites a later edit");
    await advance(content);
  }
});

test("another author's revision after a lost proposal reply still produces a conflict", async (t) => {
  const { hub, volume, connect } = await setup(t);
  write(hub, volume, "note.txt", "original");
  write(hub, volume, "hub.txt", "original");
  await hub.sync();
  const phone = await connect("phone");
  const laptop = await connect("laptop");
  await phone.sync();
  await laptop.sync();
  loseNextProposeReply(phone);
  write(phone, volume, "note.txt", "phone first");
  await assert.rejects(phone.sync(), /reply lost/);
  await laptop.sync();
  write(laptop, volume, "note.txt", "laptop edit");
  await laptop.sync();
  write(phone, volume, "note.txt", "phone second");
  await phone.sync();
  assert.equal(read(hub, volume, "note.txt"), "laptop edit");
  assert.equal(conflicts(hub, volume).length, 1);
  assert.equal(read(hub, volume, conflicts(hub, volume)[0]), "phone second");

  loseNextProposeReply(phone);
  write(phone, volume, "hub.txt", "phone first");
  await assert.rejects(phone.sync(), /reply lost/);
  write(hub, volume, "hub.txt", "hub edit");
  await hub.sync();
  write(phone, volume, "hub.txt", "phone second");
  await phone.sync();
  assert.equal(read(hub, volume, "hub.txt"), "hub edit");
  assert.equal(conflicts(hub, volume).length, 2);
});

test("accepted requests survive response-cache eviction, restart and repeated conflicts", async (t) => {
  const { hub, volume, connect } = await setup(t);
  const mac = await connect("durable-replay");
  write(mac, volume, "note.txt", "first");
  await mac.sync();
  const deletion = { volume: volume.id, path: "note.txt", base: hub.engine.store.current(volume.id, "note.txt").rev, hash: null };
  await hub.api("/v1/propose", deletion, mac.invite.token);
  await mac.sync();
  write(mac, volume, "note.txt", "recreated");
  await mac.sync();
  const oldWrite = { volume: volume.id, path: "note.txt", base: hub.engine.store.current(volume.id, "note.txt").rev, hash: digest("older"), size: 5 };
  fs.writeFileSync(hub.engine.store.blob(oldWrite.hash), "older");
  await hub.api("/v1/propose", oldWrite, mac.invite.token);
  await mac.sync();
  write(mac, volume, "note.txt", "newest");
  await mac.sync();
  const op = (body) => digest(JSON.stringify([mac.invite.id, volume.id, body.path, body.base, body.hash, false]));
  const db = hub.engine.store.db;
  const fill = db.prepare("INSERT OR REPLACE INTO proposals VALUES(?,?)");
  db.exec("BEGIN");
  for (let i = 0; i < 10001; i++) fill.run(`eviction-fixture-${i}`, "{}");
  db.exec("COMMIT");
  write(mac, volume, "other.txt", "trigger normal cache cleanup");
  await mac.sync();
  for (const body of [deletion, oldWrite])
    assert.equal(db.prepare("SELECT 1 FROM proposals WHERE id=?").get(op(body)), undefined);
  const reopened = new Engine(hub.engine.store.home);
  try {
    for (const body of [deletion, oldWrite, deletion, oldWrite]) {
      const result = await reopened.propose(body, { id: mac.invite.id, role: "replica" });
      assert.equal(result.conflict, true);
      assert.equal(read(hub, volume, "note.txt"), "newest");
      // Force every attempt to consult durable receipts instead of the response cache.
      db.exec("DELETE FROM proposals");
    }
  } finally {
    reopened.close();
  }
  await hub.api("/v1/delete-share", { id: volume.id, confirmedName: volume.name });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM accepted_proposals WHERE volume=?").get(volume.id).n, 0);
});

test("pruned foreign edits cannot be mistaken for a lost reply from the same replica", async (t) => {
  const { hub, volume, connect } = await setup(t);
  const mac = await connect("pruned-replay");
  write(mac, volume, "note.txt", "first");
  await mac.sync();
  const base = hub.engine.store.current(volume.id, "note.txt").rev;
  write(hub, volume, "note.txt", "hub edit");
  await hub.sync();
  await mac.sync();
  write(mac, volume, "note.txt", "newest");
  await mac.sync();
  const { applyRetention } = await import("../packages/daemon/maintenance.js");
  applyRetention(hub.engine.store, { versions: 1 }, false);
  assert.equal(hub.engine.store.db.prepare("SELECT 1 FROM revisions WHERE rev=?").get(base), undefined);
  const hash = digest("stale");
  fs.writeFileSync(hub.engine.store.blob(hash), "stale");
  const result = await hub.api("/v1/propose", { volume: volume.id, path: "note.txt", base, hash, size: 5 }, mac.invite.token);
  assert.equal(result.conflict, true);
  assert.equal(read(hub, volume, "note.txt"), "newest");
});

for (const prune of [false, true])
  for (const initial of [false, true])
  test(`an accepted edit replayed after a newer edit on the same base is acknowledged without a self-conflict, pruned=${prune}, initial=${initial}`, async (t) => {
    const { hub, volume, connect } = await setup(t);
    if (initial) write(hub, volume, "note.txt", "original");
    await hub.sync();
    const phone = await connect("same-base-replay");
    await phone.sync();
    const base = hub.engine.store.current(volume.id, "note.txt")?.rev ?? 0;
    const proposal = (text) => {
      const hash = digest(text);
      fs.writeFileSync(hub.engine.store.blob(hash), text);
      return { volume: volume.id, path: "note.txt", base, hash, size: Buffer.byteLength(text) };
    };
    const first = proposal("first edit");
    const later = proposal("later edit");
    const accepted = await hub.api("/v1/propose", first, phone.invite.token);
    const newer = await hub.api("/v1/propose", later, phone.invite.token);
    assert.equal(newer.conflict, false);
    const db = hub.engine.store.db;
    if (prune) {
      const { applyRetention } = await import("../packages/daemon/maintenance.js");
      applyRetention(hub.engine.store, { versions: 1 }, false);
      assert.equal(db.prepare("SELECT 1 FROM revisions WHERE rev=?").get(accepted.row.rev), undefined);
    }
    const revision = db.prepare("SELECT MAX(rev) AS n FROM revisions").get().n;
    db.exec("DELETE FROM proposals");
    const reopened = new Engine(hub.engine.store.home);
    try {
      const result = await reopened.propose(first, { id: phone.invite.id, role: "replica" });
      assert.equal(result.conflict, false, "the receipt acknowledges the previously accepted edit");
      assert.equal(result.row.rev, accepted.row.rev);
      assert.equal(result.row.hash, first.hash);
      assert.equal(db.prepare("SELECT MAX(rev) AS n FROM revisions").get().n, revision);
    } finally { reopened.close(); }
    const cached = await hub.api("/v1/propose", first, phone.invite.token);
    assert.equal(cached.conflict, false);
    assert.equal(cached.row.rev, accepted.row.rev);
    assert.equal(cached.row.hash, first.hash);
    assert.equal(hub.engine.store.current(volume.id, "note.txt").rev, newer.row.rev);
    assert.equal(read(hub, volume, "note.txt"), "later edit");
    assert.deepEqual(conflicts(hub, volume), []);
    write(phone, volume, "note.txt", "first edit");
    db.exec("DELETE FROM proposals");
    await phone.sync();
    assert.equal(read(phone, volume, "note.txt"), "later edit", "the original acknowledgment is a safe baseline for the pull");
    assert.deepEqual(conflicts(phone, volume), []);
    assert.deepEqual(conflicts(hub, volume), []);
    const op = digest(JSON.stringify([phone.invite.id, volume.id, first.path, base, first.hash, false]));
    const receipt = db.prepare("SELECT revision,volume,device,base FROM accepted_proposals WHERE id=?").get(op);
    for (const invalid of [{ revision: null }, { revision: base }, { device: "another-device" }, { volume: "another-folder" }, { base: base + 1 }]) {
      const row = { ...receipt, ...invalid };
      db.prepare("UPDATE accepted_proposals SET revision=?,volume=?,device=?,base=? WHERE id=?")
        .run(row.revision, row.volume, row.device, row.base, op);
      db.exec("DELETE FROM proposals");
      const result = await hub.api("/v1/propose", first, phone.invite.token);
      assert.equal(result.conflict, true, "an incomplete receipt never bypasses conflict preservation");
      assert.equal(read(hub, volume, "note.txt"), "later edit");
    }
    const restored = await hub.api("/v1/propose", { ...first, base: newer.row.rev }, phone.invite.token);
    assert.equal(restored.conflict, false, "an intentional edit using the current base still applies");
    assert.ok(restored.row.rev > newer.row.rev);
    assert.equal(read(hub, volume, "note.txt"), "first edit");
  });

for (const head of ["deleted", "another-device"])
  test(`an accepted replay preserves a newer ${head} head`, async (t) => {
    const { hub, volume, connect } = await setup(t);
    write(hub, volume, "note.txt", "original");
    await hub.sync();
    const replica = await connect("replay-edge");
    await replica.sync();
    const base = hub.engine.store.current(volume.id, "note.txt").rev;
    const first = { volume: volume.id, path: "note.txt", base, hash: digest("first edit"), size: 10 };
    fs.writeFileSync(hub.engine.store.blob(first.hash), "first edit");
    const accepted = await hub.api("/v1/propose", first, replica.invite.token);
    let newer;
    if (head === "deleted") {
      newer = await hub.api("/v1/propose", { volume: volume.id, path: "note.txt", base }, replica.invite.token);
      assert.equal(newer.row.deleted, 1);
    } else {
      const other = await connect("other-author");
      const hash = digest("other edit");
      fs.writeFileSync(hub.engine.store.blob(hash), "other edit");
      newer = await hub.api("/v1/propose", { ...first, base: accepted.row.rev, hash }, other.invite.token);
    }
    assert.equal(newer.conflict, false);
    hub.engine.store.db.exec("DELETE FROM proposals");
    const replay = await hub.api("/v1/propose", first, replica.invite.token);
    assert.equal(replay.conflict, head !== "deleted");
    assert.equal(hub.engine.store.current(volume.id, "note.txt").rev, newer.row.rev);
    if (head === "deleted") {
      assert.equal(replay.row.rev, accepted.row.rev);
      write(replica, volume, "note.txt", "first edit");
      await replica.sync();
      assert.equal(fs.existsSync(path.join(replica.engine.store.volume(volume.id).path, "note.txt")), false);
      assert.deepEqual(conflicts(replica, volume), []);
      assert.deepEqual(conflicts(hub, volume), []);
    } else {
      assert.equal(read(hub, volume, "note.txt"), "other edit");
      assert.ok(conflicts(hub, volume).length > 0);
    }
  });

test("Erase and folder placement never reach the state directory, inside it or above it, in any spelling", async (t) => {
  const f = await setup(t);
  const r = await f.connect("case-erase");
  const home = r.engine.store.home;
  const ancestor = path.dirname(home);
  assert.equal(withinPath(home, home), true);
  assert.equal(withinPath(home, ancestor), true);
  assert.equal(withinPath(path.join(home, "objects", "missing"), home), true, "a missing tail is judged by its existing ancestors");
  assert.equal(withinPath(home, f.root + "-missing"), false);
  assert.equal(insidePath(path.join(home, "x"), home, true), true);
  assert.equal(insidePath(home, home, true), false);
  const stat = fs.statSync;
  fs.statSync = (location, options) => Object.assign(stat(location, options), { ino: options?.bigint ? 0n : 0 });
  try {
    assert.equal(withinPath(path.join(f.root, "a"), path.join(f.root, "b")), false, "a filesystem without inode numbers falls back to paths");
  } finally {
    fs.statSync = stat;
  }
  const other = await f.hub.api("/v1/volumes", { name: "Other" });
  await r.engine.cycle().catch(() => {});
  await assert.rejects(r.api("/v1/select", { id: other.id, path: path.join(home, "objects") }), { status: 409, message: /State and volume paths overlap/ });
  await assert.rejects(r.api("/v1/path-check", { id: other.id, path: path.join(home, "objects") }), { status: 409, message: /State and volume paths overlap/ });
  r.engine.store.db.prepare("UPDATE volumes SET path=? WHERE id=?").run(ancestor, f.volume.id);
  await assert.rejects(r.api("/v1/destroy-replica", { confirmed: true }), /overlaps the state directory/);
  r.engine.config.destroyPending = { targets: [{ path: ancestor, dev: fs.statSync(ancestor).dev, ino: fs.statSync(ancestor).ino }] };
  assert.throws(() => finishInstallationReset(r.engine.store), /changed during destruction/, "a journal naming an ancestor is refused when it runs");
  delete r.engine.config.destroyPending;
  assert.ok(fs.existsSync(home), "the state directory survives");
  const swapped = ancestor.replace(/[a-z]/gi, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));
  if (!fs.existsSync(swapped)) return;
  assert.equal(withinPath(home, swapped), true, "a case-insensitive disk compares without case");
  await assert.rejects(r.api("/v1/select", { id: other.id, path: swapped }), { status: 409, message: /State and volume paths overlap/ });
  r.engine.store.db.prepare("UPDATE volumes SET path=? WHERE id=?").run(swapped, f.volume.id);
  await assert.rejects(r.api("/v1/destroy-replica", { confirmed: true }), /overlaps the state directory/);
  assert.ok(fs.existsSync(path.join(ancestor, "hub")), "nothing beside the state directory is touched");
});

test("Erase deletes only directories that still carry Arca's marker or backup state", async (t) => {
  const f = await setup(t);
  const hub = f.hub;
  const folder = hub.engine.store.volume(f.volume.id).path;
  fs.writeFileSync(path.join(folder, "shared.txt"), "synced");
  await hub.sync();
  await hub.api("/v1/unselect", { id: f.volume.id });
  fs.rmSync(folder, { recursive: true });
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, "unrelated.txt"), "someone else's");
  const root = fs.realpathSync(f.root);
  const kept = path.join(root, "Kept");
  const second = await hub.api("/v1/volumes", { name: "Kept", path: kept });
  fs.writeFileSync(path.join(kept, ".arca-volume"), "another-volume-id");
  const backup = path.join(root, "not-a-backup");
  fs.mkdirSync(backup);
  fs.writeFileSync(path.join(backup, "photo.jpg"), "mine");
  hub.engine.config.backup = { path: backup, enabled: false };
  hub.engine.store.saveConfig();
  const marked = await hub.api("/v1/volumes", { name: "Marked" });
  await hub.api("/v1/destroy-hub", { confirmed: true });
  assert.equal(fs.readFileSync(path.join(folder, "unrelated.txt"), "utf8"), "someone else's", "a folder recreated without the marker survives");
  assert.ok(fs.existsSync(kept), "a folder whose marker names another volume survives");
  assert.equal(fs.readFileSync(path.join(backup, "photo.jpg"), "utf8"), "mine", "a backup path without backup state survives");
  assert.equal(fs.existsSync(marked.path), false, "a folder that is still Arca's is erased");
  assert.equal(fs.readFileSync(path.join(kept, ".arca-volume"), "utf8"), "another-volume-id");
  assert.ok(second.id);
});

test("an interrupted erase that already removed a folder's marker still finishes that folder, and a replacement is refused", async (t) => {
  const f = await setup(t);
  const store = f.hub.engine.store;
  const folder = store.volume(f.volume.id).path;
  fs.writeFileSync(path.join(folder, "half.txt"), "left behind");
  beginInstallationReset(store, resetTargets(store));
  fs.rmSync(path.join(folder, ".arca-volume"));
  finishInstallationReset(store);
  assert.equal(fs.existsSync(folder), false, "the retry trusts the journal, not the marker it may have deleted");
  const replaced = await setup(t);
  const other = replaced.hub.engine.store;
  const target = other.volume(replaced.volume.id).path;
  beginInstallationReset(other, resetTargets(other));
  fs.renameSync(target, target + "-moved");
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, "new.txt"), "keep");
  assert.throws(() => finishInstallationReset(other), /changed during destruction/);
  assert.equal(fs.readFileSync(path.join(target, "new.txt"), "utf8"), "keep");
});
