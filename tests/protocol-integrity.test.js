import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import http from "node:http";
import path from "node:path";
import { init, digest, Store } from "../packages/daemon/storage.js";
import { start } from "../packages/daemon/server.js";

async function setup(t, options = { timer: false }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arca-test-"));
  const nodes = [];
  t.after(async () => {
    for (const n of nodes.reverse()) await n.close();
    fs.rmSync(root, { recursive: true, force: true });
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
  const volume = await hub.api("/v1/volumes", {
    name: "Documents",
    createIgnore: false,
  });
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
    await r.sync();
    const names = fs.readdirSync(location);
    assert.equal(
      names.some((x) => x.includes("conflict")),
      true,
    );
    assert.equal(fs.existsSync(path.join(location, "note.txt")), false);
  });
test("SYNC-02 backup recovery ignore", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arca-audit-backup-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "source"),
    targetHome = path.join(root, "target");
  init(home, { role: "backup" });
  const s = new Store(home);
  const v = s.addVolume("Docs");
  const names = [
    "app/index.js",
    "app/.git/HEAD",
    "app/.git/config",
    "app/node_modules/a",
    "app/node_modules/b",
    "app/.cache/x",
    "notes/.venv/pyvenv.cfg",
  ];
  for (const [i, name] of names.entries()) {
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
    assert.equal(result.revisions, 7);
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
  write(r, volume, "docs/.DS_Store", "metadata");
  fs.rmSync(localPath(hub, volume, "docs"), { recursive: true });
  await hub.sync();
  await assert.rejects(r.sync(), /not empty|ENOTEMPTY/i);
  write(hub, beta, "fresh.txt", "new");
  await hub.sync();
  await assert.rejects(r.sync(), /not empty|ENOTEMPTY/i);

  assert.equal(fs.existsSync(localPath(r, beta, "fresh.txt")), true);
  assert.equal(r.engine.phase, "error");
  assert.equal(r.engine.folderStates.get(beta.id).state, "synced");
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
    fs.rmSync(root, { recursive: true, force: true });
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
test("SYNC-13 decomposed path", async (t) => {
  const { hub, volume } = await setup(t);
  write(hub, volume, "cafe\u0301.txt", "data");
  await assert.rejects(hub.sync(), /cafe.*NFC/);
});
test("hub reselection does not apply directory tombstones to retained local files", async (t) => {
  const { hub, volume } = await setup(t);
  write(hub, volume, "docs/note.txt", "old");
  await hub.sync();
  fs.rmSync(localPath(hub, volume, "docs"), { recursive: true });
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
  const v = s.addVolume("Docs", null, undefined, false);
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
    fs.rmSync(root, { recursive: true, force: true });
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
      fs.rmSync(localPath(n, volume, "item"), { recursive: true });
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
    fs.rmSync(root, { recursive: true, force: true });
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

test("conflict copy is flushed before removing the edited original", async (t) => {
  const { hub, volume } = await setup(t),
    s = hub.engine.store;
  write(hub, volume, "note", "original");
  await hub.sync();
  const old = s.current(volume.id, "note");
  write(hub, volume, "note", "edited");
  const open = fs.openSync,
    flush = fs.fsyncSync,
    unlink = fs.unlinkSync;
  const handles = new Map();
  let durable = false,
    removed = false;
  fs.openSync = (name, ...args) => {
    const fd = open(name, ...args);
    handles.set(fd, String(name));
    return fd;
  };
  fs.fsyncSync = (fd) => {
    flush(fd);
    if (handles.get(fd)?.includes("conflict-local")) durable = true;
  };
  fs.unlinkSync = (name) => {
    if (name === path.join(volume.path, "note")) {
      assert.equal(durable, true);
      removed = true;
    }
    return unlink(name);
  };
  try {
    s.commit(volume.id, "note", null, hub.engine.config.id, true, old.hash);
  } finally {
    fs.openSync = open;
    fs.fsyncSync = flush;
    fs.unlinkSync = unlink;
  }
  assert.equal(removed, true);
  const kept = fs
    .readdirSync(volume.path)
    .find((n) => n.includes("conflict-local"));
  assert.equal(read(hub, volume, kept), "edited");
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
