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
    createIgnore: true,
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

test("full files, edits in both directions, deletion and historical restore", async (t) => {
  const { hub, volume, connect } = await setup(t);
  const mac = await connect("mac");
  write(hub, volume, "nested/note.txt", "one");
  await hub.sync();
  await mac.sync();
  assert.equal(read(mac, volume, "nested/note.txt"), "one");
  write(mac, volume, "nested/note.txt", "two");
  await mac.sync();
  assert.equal(read(hub, volume, "nested/note.txt"), "two");
  const versions = hub.engine.store.history(volume.id, "nested/note.txt");
  assert.equal(versions.length, 2);
  fs.unlinkSync(
    path.join(mac.engine.store.volume(volume.id).path, "nested/note.txt"),
  );
  await mac.sync();
  assert.equal(
    hub.engine.store.current(volume.id, "nested/note.txt").deleted,
    1,
  );
  await mac.api("/v1/restore", {
    volume: volume.id,
    path: "nested/note.txt",
    rev: versions[1].rev,
  });
  await mac.sync();
  assert.equal(read(mac, volume, "nested/note.txt"), "one");
});

test("concurrent offline edits preserve both versions and stale deletion preserves edit", async (t) => {
  const { hub, volume, connect } = await setup(t);
  const a = await connect("a");
  const b = await connect("b");
  write(hub, volume, "note.txt", "base");
  await hub.sync();
  await a.sync();
  await b.sync();
  write(a, volume, "note.txt", "alice");
  write(b, volume, "note.txt", "bob");
  await a.sync();
  await b.sync();
  assert.equal(read(b, volume, "note.txt"), "alice");
  const conflict = hub.engine.store
    .rows(volume.id)
    .find((r) => r.path.includes(".conflict-"));
  assert.ok(conflict);
  assert.equal(read(hub, volume, conflict.path), "bob");
  fs.unlinkSync(path.join(a.engine.store.volume(volume.id).path, "note.txt"));
  write(hub, volume, "note.txt", "hub-new");
  await hub.sync();
  await a.sync();
  assert.equal(read(a, volume, "note.txt"), "hub-new");
});

test("selection is complete and unselection retains disk", async (t) => {
  const { hub, volume, connect } = await setup(t);
  const a = await connect("a");
  write(hub, volume, "a", "old");
  await hub.sync();
  write(hub, volume, "a", "new");
  await hub.sync();
  await a.sync();
  const oldPath = a.engine.store.volume(volume.id).path;
  await a.api("/v1/unselect", { id: volume.id });
  assert.equal(
    a.engine.store.volumes().some((v) => v.id === volume.id),
    false,
  );
  assert.equal(fs.existsSync(path.join(oldPath, ".arca-volume")), false);
  write(hub, volume, "a", "latest");
  await hub.sync();
  await a.sync();
  assert.equal(fs.readFileSync(path.join(oldPath, "a"), "utf8"), "new");
  await a.api("/v1/select", { id: volume.id, path: oldPath + "-relinked" });
  await a.sync();
  assert.equal(read(a, volume, "a"), "latest");
});

test("authentication, role permissions, revocation and unsafe paths", async (t) => {
  const { hub, volume, connect } = await setup(t);
  const a = await connect("a");
  await assert.rejects(hub.api("/v1/status", undefined, "wrong"), {
    status: 401,
  });
  await assert.rejects(
    hub.api("/v1/devices", { name: "intruder" }, a.invite.token),
    { status: 403 },
  );
  await assert.rejects(
    hub.api(
      "/v1/propose",
      { volume: volume.id, path: "../escape", base: 0 },
      a.invite.token,
    ),
    { status: 400 },
  );
  await assert.rejects(
    hub.api("/v1/devices", { name: "obsolete", role: "backup" }),
    { status: 400 },
  );
  await hub.api("/v1/revoke", { id: a.invite.id });
  await a.sync();
  assert.equal(a.engine.config.hub, null);
});

test("resumable upload verifies hashes and range downloads", async (t) => {
  const { hub, connect } = await setup(t);
  const a = await connect("a");
  const data = Buffer.from("abcdefghijklmnop");
  const hash = digest(data);
  const put = (offset, content) =>
    fetch(
      `http://127.0.0.1:${hub.port}/v1/uploads/${hash}?offset=${offset}&size=${data.length}`,
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${a.invite.token}` },
        body: content,
      },
    );
  assert.equal((await put(0, data.subarray(0, 5))).status, 200);
  assert.equal(
    (await hub.api(`/v1/uploads/${hash}`, undefined, a.invite.token)).offset,
    5,
  );
  assert.equal((await put(0, data)).status, 409);
  assert.equal((await put(5, data.subarray(5))).status, 200);
  const r = await fetch(`http://127.0.0.1:${hub.port}/v1/blobs/${hash}`, {
    headers: { Authorization: `Bearer ${a.invite.token}`, Range: "bytes=5-" },
  });
  assert.equal(r.status, 206);
  assert.equal(await r.text(), "fghijklmnop");
});

test("missing marker or symlink stops scan without publishing deletions", async (t) => {
  const { hub, volume, root } = await setup(t);
  write(hub, volume, "a", "safe");
  await hub.sync();
  fs.unlinkSync(path.join(volume.path, ".arca-volume"));
  await assert.rejects(hub.sync());
  assert.equal(hub.engine.store.current(volume.id, "a").deleted, 0);
  fs.writeFileSync(path.join(volume.path, ".arca-volume"), volume.id);
  fs.symlinkSync(root, path.join(volume.path, "outside"));
  await assert.rejects(hub.sync(), /Symlink/);
});

test("pending write recovery preserves external edit and restores intended revision", async (t) => {
  const { hub, volume } = await setup(t);
  write(hub, volume, "a", "base");
  await hub.sync();
  const base = hub.engine.store.current(volume.id, "a");
  const object = hub.engine.store.capture(path.join(volume.path, "a"));
  write(hub, volume, "a", "external");
  const pending = { ...base, hash: object.hash, rev: base.rev };
  hub.engine.store.queue(pending, "not-the-current-hash");
  hub.engine.store.recover();
  assert.equal(read(hub, volume, "a"), "base");
  const alternative = fs
    .readdirSync(volume.path)
    .find((n) => n.includes(".conflict-local-"));
  assert.equal(read(hub, volume, alternative), "external");
});

test("empty files and resumed partial download finish as full verified files", async (t) => {
  const { hub, volume, connect } = await setup(t);
  const a = await connect("a");
  write(hub, volume, "empty", "");
  write(hub, volume, "large", "0123456789".repeat(150000));
  await hub.sync();
  const row = hub.engine.store.current(volume.id, "large");
  fs.writeFileSync(
    path.join(a.engine.store.uploads, `${row.hash}.download`),
    Buffer.from("0123456789".repeat(1000)),
  );
  await a.sync();
  assert.equal(read(a, volume, "empty"), "");
  assert.equal(read(a, volume, "large").length, 1500000);
});

test("proposal retries are idempotent; directory collision does not poison pending writes", async (t) => {
  const { hub, volume, connect } = await setup(t);
  const a = await connect("a");
  write(a, volume, "a", "new");
  await a.sync();
  const row = hub.engine.store.current(volume.id, "a");
  const before = hub.engine.store.history(volume.id, "a").length;
  await hub.api(
    "/v1/propose",
    { volume: volume.id, path: "a", base: 0, hash: row.hash, size: row.size },
    a.invite.token,
  );
  assert.equal(hub.engine.store.history(volume.id, "a").length, before);
  fs.mkdirSync(path.join(volume.path, "directory"));
  await assert.rejects(
    hub.api(
      "/v1/propose",
      {
        volume: volume.id,
        path: "directory",
        base: 0,
        hash: row.hash,
        size: row.size,
      },
      a.invite.token,
    ),
    { status: 409 },
  );
  assert.equal(
    hub.engine.store.db.prepare("SELECT COUNT(*) AS count FROM pending").get()
      .count,
    0,
  );
});

test("only the hub creates shares; replicas choose existing destinations and sync both ways", async (t) => {
  const { root, hub, connect } = await setup(t);
  const a = await connect("mac"),
    b = await connect("second");
  await assert.rejects(
    a.api("/v1/volumes", {
      name: "Forbidden",
      path: path.join(root, "forbidden"),
    }),
    /Only the hub/,
  );
  assert.equal(fs.existsSync(path.join(root, "forbidden")), false);
  const source = path.join(root, "hub-external");
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, "hub.txt"), "hub content");
  const v = await hub.api("/v1/volumes", { name: "Workspace", path: source });
  const dest = path.join(root, "mac-documents");
  fs.mkdirSync(dest);
  fs.writeFileSync(path.join(dest, "mac.txt"), "mac content");
  await a.api("/v1/select", { id: v.id, path: dest });
  await a.sync();
  assert.equal(read(a, v, "hub.txt"), "hub content");
  assert.equal(read(hub, v, "mac.txt"), "mac content");
  await b.api("/v1/select", {
    id: v.id,
    path: path.join(root, "different-name"),
  });
  await b.sync();
  assert.equal(read(b, v, "mac.txt"), "mac content");
  await assert.rejects(
    a.api("/v1/select", { id: v.id, path: path.join(root, "move") }),
    /separate migration/,
  );
  await assert.rejects(
    hub.api("/v1/volumes", { name: "Relative", path: "relative/path" }),
    /absolute/,
  );
  await assert.rejects(
    hub.api("/v1/volumes", {
      name: "Overlap",
      path: path.join(source, "nested"),
    }),
    /overlap/,
  );
  if (fs.existsSync("/.dockerenv"))
    assert.throws(
      () => a.engine.store.resolveLocation("~/Documents/arca-alpi"),
      /absolute path of a mounted folder/,
    );
  else
    assert.equal(
      a.engine.store.resolveLocation("~/Documents/arca-alpi"),
      path.join(fs.realpathSync(os.homedir()), "Documents/arca-alpi"),
    );
});

test("replica can independently back up all folders and history while continuing to edit", async (t) => {
  const { root, hub, volume, connect } = await setup(t);
  const mac = await connect("dual-purpose");
  const other = await hub.api("/v1/volumes", { name: "Not selected" });
  write(hub, volume, "note", "old");
  write(hub, other, "secret", "backup only");
  await hub.sync();
  await mac.sync();
  const backupPath = path.join(root, "dedicated-backup");
  await assert.rejects(
    mac.api("/v1/backup", {
      enabled: true,
      path: mac.engine.store.volume(volume.id).path,
    }),
    /outside/,
  );
  await mac.api("/v1/backup", { enabled: true, path: backupPath });
  write(mac, volume, "note", "edited on Mac");
  await mac.sync();
  assert.equal(read(hub, volume, "note"), "edited on Mac");
  assert.equal(mac.engine.config.role, "replica");
  assert.equal(mac.engine.store.volumes().length, 1);
  assert.equal(mac.engine.status().backup.folders, 2);
  assert.equal(mac.engine.status().backup.error, null);
  assert.equal(
    fs.readFileSync(
      path.join(backupPath, "files", "Not selected", "secret"),
      "utf8",
    ),
    "backup only",
  );
  await assert.rejects(
    mac.api("/v1/select", {
      id: other.id,
      path: path.join(backupPath, "nested"),
    }),
    /overlap/,
  );
  fs.unlinkSync(path.join(mac.engine.store.volume(volume.id).path, "note"));
  await mac.sync();
  assert.equal(hub.engine.store.current(volume.id, "note").deleted, 1);
  await mac.api("/v1/backup", { enabled: false });
  const { recoverBackup } = await import("../packages/daemon/recovery.js");
  const recoveredPath = path.join(root, "restored-hub");
  recoverBackup(path.join(backupPath, "state"), recoveredPath);
  const { Store } = await import("../packages/daemon/storage.js");
  const recovered = new Store(recoveredPath);
  try {
    assert.equal(recovered.history(volume.id, "note").length, 3);
    assert.equal(
      fs.readFileSync(
        path.join(recovered.volume(other.id).path, "secret"),
        "utf8",
      ),
      "backup only",
    );
  } finally {
    recovered.close();
  }
  write(mac, volume, "later", "sync remains active");
  await mac.sync();
  assert.equal(read(hub, volume, "later"), "sync remains active");
  await mac.api("/v1/backup", { enabled: true });
  await mac.sync();
  assert.equal(mac.engine.status().backup.enabled, true);
  const cycle = mac.engine.backupEngine.cycle;
  mac.engine.backupEngine.cycle = async () => {
    throw new Error("Backup disk unavailable");
  };
  write(mac, volume, "independent", "still syncing");
  await mac.sync();
  assert.equal(read(hub, volume, "independent"), "still syncing");
  assert.equal(mac.engine.status().backup.error, "Backup disk unavailable");
  assert.equal(mac.engine.status().error, null);
  mac.engine.backupEngine.cycle = cycle;
  await mac.sync();
  assert.equal(mac.engine.status().backup.error, null);
});

test("one-time pairing connects a replica and rejects reuse", async (t) => {
  const { hub, node } = await setup(t),
    mac = await node("paired", "replica");
  const invitation = await hub.api("/v1/pairing", { name: "Paired Mac" });
  await mac.api("/v1/connect", {
    url: `http://127.0.0.1:${hub.port}`,
    code: invitation.code,
  });
  assert.equal(mac.engine.config.hub.id, hub.engine.config.id);
  const other = await node("other-pair", "replica");
  await assert.rejects(
    other.api("/v1/connect", {
      url: `http://127.0.0.1:${hub.port}`,
      code: invitation.code,
    }),
    /expired/,
  );
});

test("replica promotion preserves files and reconnects another replica with divergent edits", async (t) => {
  const { hub, volume, connect } = await setup(t);
  const mac = await connect("new-hub"),
    other = await connect("other");
  write(hub, volume, "note", "original");
  await hub.sync();
  await mac.sync();
  await other.sync();
  assert.equal((await mac.api("/v1/promotion-plan")).ready, true);
  await assert.rejects(
    mac.api("/v1/promote", { confirmed: true }),
    /reachable/,
  );
  // Simulate the old hub being unavailable without closing the fixture twice.
  mac.engine.config.hub.url = "http://127.0.0.1:1";
  const result = await mac.api("/v1/promote", { confirmed: true });
  assert.equal(result.promoted, true);
  assert.equal(read(mac, volume, "note"), "original");
  assert.notEqual(mac.engine.config.id, hub.engine.config.id);
  write(mac, volume, "note", "new hub edit");
  await mac.sync();
  write(other, volume, "note", "offline other edit");
  const invite = await mac.api("/v1/devices", {
    name: "other",
    role: "replica",
  });
  await other.api("/v1/connect", {
    url: `http://127.0.0.1:${mac.port}`,
    token: invite.token,
    reconcile: true,
  });
  await other.sync();
  assert.equal(read(other, volume, "note"), "new hub edit");
  const files = fs.readdirSync(other.engine.store.volume(volume.id).path);
  assert.ok(
    files.some(
      (f) =>
        f.includes("conflict") &&
        read(other, volume, f) === "offline other edit",
    ),
  );
});

test("an unavailable folder does not block a different healthy folder", async (t) => {
  const { hub, volume, connect } = await setup(t);
  const mac = await connect("mac");
  const missing = await hub.api("/v1/volumes", { name: "Unavailable" });
  fs.unlinkSync(path.join(missing.path, ".arca-volume"));
  write(hub, volume, "healthy", "still syncs");
  await mac.sync();
  assert.equal(read(mac, volume, "healthy"), "still syncs");
});

test("machine roster is read-only for replicas and excludes credentials and filesystem paths", async (t) => {
  const { hub, volume, connect } = await setup(t);
  const mac = await connect("Report Mac");
  write(hub, volume, "report.txt", "content");
  await hub.sync();
  await mac.sync();
  const roster = await mac.api("/v1/machines");
  const reported = roster.machines.find(
    (m) => m.machineId === mac.engine.config.id,
  );
  assert.equal(reported.freshness, "recent");
  assert.equal(reported.selectedFolders, 1);
  assert.equal(reported.indexedFiles, 2);
  assert.equal(reported.linkState, "authenticated");
  const serialized = JSON.stringify(roster);
  assert.equal(serialized.includes(mac.invite.token), false);
  assert.equal(serialized.includes(hub.engine.config.adminToken), false);
  assert.equal(serialized.includes(hub.engine.config.root), false);
  await assert.rejects(
    hub.api("/v1/pairing", { name: "Forbidden" }, mac.invite.token),
    (e) => e.status === 403,
  );
  await hub.api("/v1/revoke", { id: mac.invite.id });
  await assert.rejects(mac.api("/v1/machines"), (e) => e.status === 401);
});

test("case-colliding names identify both paths without changing files or accepted history", async (t) => {
  const { hub, volume } = await setup(t);
  write(hub, volume, "keep.txt", "retained");
  await hub.sync();
  fs.mkdirSync(path.join(volume.path, "BACK"));
  if (fs.existsSync(path.join(volume.path, "back"))) {
    t.skip("Requires a case-sensitive filesystem; verified on Linux");
    return;
  }
  fs.mkdirSync(path.join(volume.path, "back"));
  await assert.rejects(
    hub.sync(),
    /"BACK" and "back" differ only by letter case/,
  );
  assert.equal(read(hub, volume, "keep.txt"), "retained");
  assert.equal(hub.engine.store.current(volume.id, "keep.txt").deleted, 0);
  assert.ok(fs.existsSync(path.join(volume.path, "BACK")));
  assert.ok(fs.existsSync(path.join(volume.path, "back")));
});

test(
  "local sockets are skipped without blocking files or overwriting endpoints",
  { skip: process.platform === "win32" && "Requires filesystem Unix sockets" },
  async (t) => {
    const { hub, connect } = await setup(t);
    const root = fs.mkdtempSync("/tmp/arca-socket-");
    const servers = [];
    t.after(async () => {
      for (const server of servers)
        await new Promise((resolve) => server.close(resolve));
      fs.rmSync(root, { recursive: true, force: true });
    });
    const v = await hub.api("/v1/volumes", {
      name: "Runtime",
      path: path.join(root, "hub"),
    });
    const mac = await connect("mac");
    await mac.api("/v1/select", { id: v.id, path: path.join(root, "mac") });
    const socket = async (machine, name) => {
      const file = path.join(machine.engine.store.volume(v.id).path, name);
      const server = net.createServer();
      servers.push(server);
      await new Promise((resolve, reject) =>
        server.once("error", reject).listen(file, resolve),
      );
      return file;
    };
    const hubSocket = await socket(hub, "hub.sock");
    const macSocket = await socket(mac, "local.sock");
    write(hub, v, "ordinary.sock", "A regular file, despite its extension");
    write(mac, v, "note.txt", "local data");
    await hub.sync();
    await mac.sync();
    assert.equal(read(hub, v, "note.txt"), "local data");
    assert.equal(
      read(mac, v, "ordinary.sock"),
      "A regular file, despite its extension",
    );
    assert.equal(hub.engine.store.current(v.id, "hub.sock"), undefined);
    assert.equal(hub.engine.store.current(v.id, "local.sock"), undefined);
    assert.ok(fs.lstatSync(hubSocket).isSocket());
    assert.ok(fs.lstatSync(macSocket).isSocket());
    write(hub, v, "local.sock", "remote content");
    await hub.sync();
    await assert.rejects(mac.sync(), /not a regular file/);
    assert.ok(fs.lstatSync(macSocket).isSocket());
  },
);

test(
  "a synced file replaced by a socket does not publish a deletion",
  { skip: process.platform === "win32" && "Requires filesystem Unix sockets" },
  async (t) => {
    const { hub } = await setup(t);
    const root = fs.mkdtempSync("/tmp/arca-socket-");
    const v = await hub.api("/v1/volumes", { name: "Runtime", path: root });
    write(hub, v, "endpoint", "retained data");
    await hub.sync();
    const before = hub.engine.store.current(v.id, "endpoint");
    fs.unlinkSync(path.join(root, "endpoint"));
    const server = net.createServer();
    t.after(async () => {
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(root, { recursive: true, force: true });
    });
    await new Promise((resolve, reject) =>
      server.once("error", reject).listen(path.join(root, "endpoint"), resolve),
    );
    await assert.rejects(hub.sync(), /replaced by a local socket/);
    assert.deepEqual(hub.engine.store.current(v.id, "endpoint"), before);
    assert.ok(fs.lstatSync(path.join(root, "endpoint")).isSocket());
  },
);

test("machine renames reach hub records while paused and reports survive scan errors", async (t) => {
  const { hub, volume, connect } = await setup(t);
  const mac = await connect("Old name");
  mac.engine.paused = true;
  await mac.api("/v1/settings", { name: "macbook-pro" });
  assert.equal(hub.engine.status().devices[0].name, "macbook-pro");
  mac.engine.paused = false;
  fs.symlinkSync(
    "missing",
    path.join(mac.engine.store.volume(volume.id).path, "link"),
  );
  mac.engine.config.name = "Renamed offline";
  mac.engine.lastReport = null;
  await assert.rejects(mac.sync(), /Symlink/);
  assert.equal(hub.engine.status().devices[0].name, "Renamed offline");
  const roster = await hub.api("/v1/machines");
  const report = roster.machines.find(
    (m) => m.machineId === mac.engine.config.id,
  );
  assert.equal(report.name, "Renamed offline");
  assert.equal(report.phase, "error");
});

test("default exclusions skip caches before symlinks and preserve indexed history and disk copies", async (t) => {
  const { hub, volume, connect } = await setup(t);
  const replica = await connect("exclusions");
  write(hub, volume, "keep.txt", "shared");
  write(hub, volume, "cache/legacy.txt", "old cache");
  const store = hub.engine.store;
  const cached = store.capture(
    path.join(store.volume(volume.id).path, "cache/legacy.txt"),
  );
  store.commit(volume.id, "cache/legacy.txt", cached, store.config.id);
  const old = store.current(volume.id, "cache/legacy.txt");
  for (const name of [
    ".DS_Store",
    ".localized",
    "vault/.obsidian/workspace.json",
    "Thumbs.db",
    "desktop.ini",
    ".Trashes/file",
    "nested/.cache/file",
    "node_modules/file",
    ".venv/file",
  ])
    write(hub, volume, name, "local only");
  fs.symlinkSync(
    "/does-not-exist",
    path.join(store.volume(volume.id).path, "cache/model-link"),
  );
  write(replica, volume, "cache/legacy.txt", "replica cache");
  write(replica, volume, "node_modules/local.txt", "replica dependencies");
  await hub.sync();
  await replica.sync();
  assert.equal(read(replica, volume, "keep.txt"), "shared");
  assert.equal(read(replica, volume, "cache/legacy.txt"), "replica cache");
  assert.deepEqual(store.current(volume.id, "cache/legacy.txt"), old);
  assert.equal(store.history(volume.id, "cache/legacy.txt").length, 1);
  assert.equal(store.current(volume.id, "node_modules/local.txt"), undefined);
  assert.equal(
    replica.engine.store.current(volume.id, "cache/legacy.txt"),
    undefined,
  );
  store.queue({ ...old, deleted: 1 }, old.hash);
  store.recover();
  assert.equal(read(hub, volume, "cache/legacy.txt"), "old cache");
  assert.deepEqual(store.current(volume.id, "cache/legacy.txt"), old);
});

test("folder progress advances across empty files and snapshot totals are reported", async (t) => {
  const { hub, volume, connect } = await setup(t);
  const replica = await connect("progress");
  for (const name of ["a", "b", "c"]) write(replica, volume, name, "");
  const observed = [];
  const upload = replica.engine.upload.bind(replica.engine);
  replica.engine.upload = async (hash) => {
    observed.push({ ...replica.engine.progress });
    return upload(hash);
  };
  await replica.sync();
  assert.deepEqual(
    observed.map((p) => p.filesDone),
    [0, 1, 2],
  );
  assert.ok(observed.every((p) => p.filesTotal === 3 && p.stage === "upload"));
  const snapshot = await hub.api(`/v1/snapshot?volume=${volume.id}&limit=500`);
  assert.equal(snapshot.total, 4);
});

test("unlink interrupts an active upload before publishing and retains local files", async (t) => {
  const { hub, volume, connect } = await setup(t);
  const replica = await connect("unlink-active");
  write(replica, volume, "keep.txt", "local content");
  let release, entered;
  const gate = new Promise((r) => {
    release = r;
  });
  const started = new Promise((r) => {
    entered = r;
  });
  replica.engine.upload = async () => {
    entered();
    await gate;
  };
  const localPath = replica.engine.store.volume(volume.id).path;
  const cycle = replica.sync();
  await started;
  const unlink = replica.api("/v1/unselect", { id: volume.id });
  for (let i = 0; i < 100 && !replica.engine.stopVolumes.has(volume.id); i++)
    await new Promise((r) => setTimeout(r, 5));
  assert.equal(replica.engine.stopVolumes.has(volume.id), true);
  release();
  await cycle;
  await unlink;
  assert.equal(
    replica.engine.store.volumes().some((v) => v.id === volume.id),
    false,
  );
  assert.equal(fs.existsSync(path.join(localPath, ".arca-volume")), false);
  assert.equal(
    fs.readFileSync(path.join(localPath, "keep.txt"), "utf8"),
    "local content",
  );
  assert.equal(hub.engine.store.current(volume.id, "keep.txt"), undefined);
  assert.equal(replica.engine.error, null);
});

test("arcaignore rules arrive before scanning and ignored tracked files never become deletions", async (t) => {
  const { hub, volume, connect } = await setup(t);
  write(hub, volume, ".arcaignore", "private/\n*.tmp\n");
  write(hub, volume, "keep.txt", "kept");
  await hub.sync();
  const replica = await connect("rules-first");
  write(replica, volume, "private/token", "must stay local");
  fs.symlinkSync(
    "/missing",
    path.join(replica.engine.store.volume(volume.id).path, "private/link"),
  );
  await replica.sync();
  assert.equal(replica.engine.error, null);
  assert.equal(hub.engine.store.current(volume.id, "private/token"), undefined);
  assert.equal(read(replica, volume, ".arcaignore"), "private/\n*.tmp\n");
  assert.equal(read(replica, volume, "keep.txt"), "kept");
  write(replica, volume, "report.txt", "local report");
  await replica.sync();
  const prior = hub.engine.store.current(volume.id, "report.txt");
  write(hub, volume, ".arcaignore", "private/\n*.tmp\nreport.txt\n");
  await hub.sync();
  await replica.sync();
  fs.unlinkSync(
    path.join(replica.engine.store.volume(volume.id).path, "report.txt"),
  );
  await replica.sync();
  assert.equal(replica.engine.error, null);
  assert.deepEqual(hub.engine.store.current(volume.id, "report.txt"), prior);
  assert.equal(read(hub, volume, "report.txt"), "local report");
});

test("empty arcaignore removes default cache exclusions and rule edits synchronize", async (t) => {
  const { hub, volume, connect } = await setup(t);
  const replica = await connect("editable-rules");
  await hub.sync();
  await replica.sync();
  write(replica, volume, ".arcaignore", "");
  write(replica, volume, "cache/wanted.txt", "intentional content");
  await replica.sync();
  assert.equal(replica.engine.error, null);
  assert.equal(read(hub, volume, ".arcaignore"), "");
  assert.equal(read(hub, volume, "cache/wanted.txt"), "intentional content");
});

test("divergent initial ignore rules stop transfers and preserve local exclusions across retries", async (t) => {
  const { hub, volume, connect } = await setup(t);
  await hub.sync();
  const replica = await connect("custom-policy");
  const rules = ".env\nalp/\n";
  write(replica, volume, ".arcaignore", rules);
  write(replica, volume, ".env", "private test fixture");
  write(replica, volume, "public.txt", "also waits for policy");
  for (let i = 0; i < 2; i++) {
    await assert.rejects(replica.sync(), /arcaignore differs/);
    assert.match(replica.engine.error, /arcaignore differs/);
    assert.equal(read(replica, volume, ".arcaignore"), rules);
    assert.equal(hub.engine.store.current(volume.id, ".env"), undefined);
    assert.equal(hub.engine.store.current(volume.id, "public.txt"), undefined);
    assert.equal(
      hub.engine.store
        .rows(volume.id)
        .some((r) => r.path.includes(".conflict-")),
      false,
    );
  }
  write(hub, volume, ".arcaignore", rules);
  await hub.sync();
  await replica.sync();
  assert.equal(replica.engine.error, null);
  assert.equal(read(hub, volume, "public.txt"), "also waits for policy");
  assert.equal(hub.engine.store.current(volume.id, ".env"), undefined);
});

test("stale ignore proposals are rejected without creating conflict files", async (t) => {
  const { hub, volume, connect } = await setup(t);
  const replica = await connect("policy-race");
  await hub.sync();
  await replica.sync();
  const old = hub.engine.store.current(volume.id, ".arcaignore");
  write(hub, volume, ".arcaignore", "private/\n");
  await hub.sync();
  const hash = hub.engine.store.current(volume.id, ".arcaignore").hash;
  await assert.rejects(
    hub.engine.propose(
      {
        volume: volume.id,
        path: ".arcaignore",
        base: old.rev,
        hash: old.hash,
        size: old.size,
      },
      { id: "race" },
    ),
    /arcaignore differs/,
  );
  assert.equal(hub.engine.store.current(volume.id, ".arcaignore").hash, hash);
  assert.equal(
    hub.engine.store.rows(volume.id).some((r) => r.path.includes(".conflict-")),
    false,
  );
});

test("hub deletion removes only its catalog, preserves files and lets replicas detach and reuse destinations", async (t) => {
  const { hub, volume, connect } = await setup(t);
  write(hub, volume, "keep.txt", "original");
  await hub.sync();
  const replica = await connect("delete-share-client");
  await replica.sync();
  const localPath = replica.engine.store.volume(volume.id).path;
  write(replica, volume, "offline.txt", "offline edit retained");
  const other = await hub.api("/v1/volumes", { name: "Other" });
  await assert.rejects(
    replica.api("/v1/delete-share", {
      id: volume.id,
      confirmedName: volume.name,
    }),
    /hub/i,
  );
  await assert.rejects(
    hub.api("/v1/delete-share", { id: volume.id, confirmedName: "wrong" }),
    /confirm/i,
  );
  assert.ok(hub.engine.store.volume(volume.id));
  const location = hub.engine.store.volume(volume.id).path;
  await hub.api("/v1/delete-share", {
    id: volume.id,
    confirmedName: volume.name,
  });
  assert.equal(
    hub.engine.store.db
      .prepare("SELECT count(*) n FROM revisions WHERE volume=?")
      .get(volume.id).n,
    0,
  );
  assert.ok(hub.engine.store.volume(other.id));
  assert.equal(
    fs.readFileSync(path.join(location, "keep.txt"), "utf8"),
    "original",
  );
  assert.equal(fs.existsSync(path.join(location, ".arca-volume")), false);
  await replica.sync();
  assert.equal(
    replica.engine.store.volumes().some((v) => v.id === volume.id),
    false,
  );
  assert.equal(
    fs.readFileSync(path.join(localPath, "offline.txt"), "utf8"),
    "offline edit retained",
  );
  assert.equal(fs.existsSync(path.join(localPath, ".arca-volume")), false);
  const replacement = await hub.api("/v1/volumes", {
    name: volume.name,
    path: location,
  });
  assert.notEqual(replacement.id, volume.id);
  await replica.api("/v1/select", { id: replacement.id, path: localPath });
  assert.equal(replica.engine.store.volume(replacement.id).path, localPath);
});

test("hub ignore template is opt-in for new directories only and stays absent through scans", async (t) => {
  const { hub, connect } = await setup(t);
  const plain = await hub.api("/v1/volumes", { name: "Plain" });
  await hub.sync();
  await hub.sync();
  assert.equal(fs.existsSync(path.join(plain.path, ".arcaignore")), false);
  const replica = await connect("no-template");
  await replica.api("/v1/select", { id: plain.id });
  await replica.sync();
  await hub.sync();
  assert.equal(fs.existsSync(path.join(plain.path, ".arcaignore")), false);
  const seeded = await hub.api("/v1/volumes", {
    name: "Seeded",
    createIgnore: true,
  });
  assert.ok(fs.existsSync(path.join(seeded.path, ".arcaignore")));
  const existing = path.join(hub.engine.config.root, "existing");
  fs.mkdirSync(existing);
  await assert.rejects(
    hub.api("/v1/volumes", {
      name: "Existing",
      path: existing,
      createIgnore: true,
    }),
    /new folder/,
  );
  await hub.api("/v1/volumes", { name: "Existing", path: existing });
  await hub.sync();
  assert.equal(fs.existsSync(path.join(existing, ".arcaignore")), false);
});

test("hub serves status while a large scan is committing files", async (t) => {
  const { hub, volume } = await setup(t);
  const folder = hub.engine.store.volume(volume.id).path;
  for (let i = 0; i < 100; i++)
    fs.writeFileSync(path.join(folder, `entry-${i}.txt`), "content");
  const commit = hub.engine.store.commit.bind(hub.engine.store);
  let response,
    commits = 0,
    observed;
  hub.engine.store.commit = (...args) => {
    const result = commit(...args);
    commits++;
    if (!response)
      response = hub.api("/v1/status").then(() => {
        observed = commits;
      });
    return result;
  };
  await hub.sync();
  await response;
  assert.ok(observed < commits, `status returned after all ${commits} commits`);
});

test("snapshot reads do not wait behind an active hub cycle", async (t) => {
  const { hub, volume } = await setup(t);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const held = hub.engine.exclusive(async () => {
    hub.engine.phase = "syncing";
    await gate;
  });
  await new Promise((resolve) => setImmediate(resolve));
  try {
    const response = await fetch(
      `http://127.0.0.1:${hub.port}/v1/snapshot?volume=${volume.id}&limit=10`,
      {
        headers: { Authorization: `Bearer ${hub.engine.config.adminToken}` },
        signal: AbortSignal.timeout(1000),
      },
    );
    assert.equal(response.status, 200);
    assert.ok((await response.json()).session);
  } finally {
    release();
    await held;
    hub.engine.phase = "idle";
  }
});

test("hub rename propagates by ID without moving either working copy", async (t) => {
  const { hub, volume, connect } = await setup(t);
  const mac = await connect("Rename Mac");
  write(hub, volume, "keep.txt", "preserved");
  await hub.sync();
  await mac.sync();
  const localPath = mac.engine.store.volume(volume.id).path;
  await assert.rejects(
    hub.api(
      "/v1/rename-share",
      { id: volume.id, name: "Forbidden" },
      mac.invite.token,
    ),
    (e) => e.status === 403,
  );
  await assert.rejects(
    mac.api("/v1/rename-share", { id: volume.id, name: "Forbidden" }),
    (e) => e.status === 409,
  );
  await hub.api("/v1/volumes", { name: "Taken" });
  await assert.rejects(
    hub.api("/v1/rename-share", { id: volume.id, name: "taken" }),
  );
  await assert.rejects(
    hub.api("/v1/rename-share", { id: volume.id, name: "../unsafe" }),
  );
  await hub.api("/v1/rename-share", { id: volume.id, name: "Renamed" });
  await mac.sync();
  assert.equal(mac.engine.store.volume(volume.id).name, "Renamed");
  assert.equal(mac.engine.store.volume(volume.id).path, localPath);
  assert.equal(hub.engine.store.volume(volume.id).path, volume.path);
  assert.equal(read(mac, volume, "keep.txt"), "preserved");
});

test("hub ignore editor versions rules, rejects stale edits and preserves excluded files", async (t) => {
  const { hub, volume, connect } = await setup(t);
  const mac = await connect("Rules Mac");
  write(hub, volume, "keep.txt", "preserved");
  await hub.sync();
  await mac.sync();
  const route = `/v1/ignore-policy?id=${volume.id}`;
  await assert.rejects(
    hub.api(route, undefined, mac.invite.token),
    (e) => e.status === 403,
  );
  const policy = await hub.api(route);
  await hub.api("/v1/ignore-policy", {
    id: volume.id,
    text: "keep.txt\n",
    version: policy.version,
  });
  await assert.rejects(
    hub.api("/v1/ignore-policy", {
      id: volume.id,
      text: "",
      version: policy.version,
    }),
    (e) => e.status === 409,
  );
  await mac.sync();
  assert.equal(read(mac, volume, ".arcaignore"), "keep.txt\n");
  assert.equal(read(mac, volume, "keep.txt"), "preserved");
  assert.ok(!hub.engine.store.current(volume.id, "keep.txt").deleted);
  const current = await hub.api(route);
  await assert.rejects(
    hub.api("/v1/ignore-policy", {
      id: volume.id,
      text: "x".repeat(65537),
      version: current.version,
    }),
  );
  write(hub, volume, ".arcaignore", "external\n");
  await assert.rejects(
    hub.api("/v1/ignore-policy", {
      id: volume.id,
      text: "",
      version: current.version,
    }),
    (e) => e.status === 409,
  );
  assert.equal(read(hub, volume, ".arcaignore"), "external\n");
  const fresh = await hub.api(route);
  await hub.api("/v1/ignore-policy", {
    id: volume.id,
    text: "",
    version: fresh.version,
  });
  assert.equal(read(hub, volume, ".arcaignore"), "");
});

test("copy reports agree through the hub and update selection while paused", async (t) => {
  const { hub, volume, connect } = await setup(t);
  const mac = await connect("Copies Mac");
  const find = (roster) =>
    roster.machines.find((m) => m.machineId === mac.engine.config.id);
  assert.deepEqual(find(await hub.api("/v1/machines")).folderIds, [volume.id]);
  assert.deepEqual(find(await mac.api("/v1/machines")).folderIds, [volume.id]);
  await mac.api("/v1/pause", { paused: true });
  await mac.api("/v1/unselect", { id: volume.id });
  assert.deepEqual(find(await hub.api("/v1/machines")).folderIds, []);
  assert.equal(mac.engine.paused, true);
  await mac.api("/v1/select", { id: volume.id });
  assert.deepEqual(find(await hub.api("/v1/machines")).folderIds, [volume.id]);
});

test("hub scan releases the operation queue for a pending deletion without deleting unscanned files", async (t) => {
  const { hub, volume } = await setup(t);
  const other = await hub.api("/v1/volumes", { name: "Other" });
  write(hub, volume, "keep.txt", "existing");
  write(hub, other, "retain.txt", "retained on disk");
  await hub.sync();
  for (let i = 0; i < 12; i++) write(hub, volume, `new-${i}.txt`, "new");
  const store = hub.engine.store;
  const location = store.volume(other.id).path;
  const original = store.commit.bind(store);
  let commits = 0,
    deletion;
  store.commit = (...args) => {
    const result = original(...args);
    if (++commits === 1) {
      // Same stop flag and serialized mutation as the delete endpoint, targeting
      // another folder while this one is midway through durable commits.
      hub.engine.stopVolumes.add(other.id);
      deletion = hub.engine
        .exclusive(() => store.forgetVolume(other.id))
        .finally(() => hub.engine.stopVolumes.delete(other.id));
    }
    return result;
  };
  await hub.sync();
  await deletion;
  store.commit = original;
  assert.equal(
    commits,
    1,
    "the scan yields before processing the remaining files",
  );
  assert.equal(hub.engine.error, null);
  assert.equal(store.current(volume.id, "keep.txt").deleted, 0);
  assert.equal(
    fs.readFileSync(path.join(location, "retain.txt"), "utf8"),
    "retained on disk",
  );
  assert.equal(
    store.volumes().some((v) => v.id === other.id),
    false,
  );
  await hub.sync();
  assert.ok(
    store.current(volume.id, "new-11.txt"),
    "next cycle completes remaining work",
  );
});

test("incremental synchronization visits dirty paths only and receives changes with durable cursors", async (t) => {
  const { hub, volume, connect } = await setup(t);
  write(hub, volume, "first.txt", "one");
  write(hub, volume, "untouched.txt", "keep");
  await hub.sync();
  const mac = await connect("incremental");
  const incremental = (n) =>
    n.engine.exclusive(() => n.engine.cycle({ incremental: true }));
  await incremental(mac);
  assert.equal(read(mac, volume, "first.txt"), "one");
  const scan = mac.engine.scanner.scan.bind(mac.engine.scanner);
  const calls = [];
  mac.engine.scanner.scan = (v, paths) => {
    calls.push(paths);
    return scan(v, paths);
  };
  await incremental(mac);
  assert.equal(calls.length, 0, "an empty remote check does not scan files");
  write(mac, volume, "first.txt", "two");
  mac.engine.work.mark(volume.id, "first.txt");
  await incremental(mac);
  assert.equal(read(hub, volume, "first.txt"), "two");
  assert.equal(read(mac, volume, "untouched.txt"), "keep");
  assert.deepEqual(calls[0], ["first.txt"]);
  const cursor = mac.engine.work.state(volume.id).cursor;
  assert.ok(cursor > 0);
  const empty = await hub.api(
    `/v1/changes?volume=${volume.id}&after=${cursor}`,
  );
  assert.equal(empty.files.length, 0);
  write(hub, volume, "untouched.txt", "remote");
  hub.engine.work.mark(volume.id, "untouched.txt");
  await incremental(hub);
  await incremental(mac);
  assert.equal(read(mac, volume, "untouched.txt"), "remote");
  assert.ok(mac.engine.work.state(volume.id).cursor > cursor);
  assert.ok(
    calls.every((paths) => paths !== null),
    "no full scan after initial reconciliation",
  );
});

test("incremental delete and directory rename preserve unrelated files", async (t) => {
  const { hub, volume, connect } = await setup(t);
  write(hub, volume, "old/child.txt", "child");
  write(hub, volume, "keep.txt", "keep");
  await hub.sync();
  const mac = await connect("incremental-move");
  const incremental = (n) =>
    n.engine.exclusive(() => n.engine.cycle({ incremental: true }));
  await incremental(mac);
  const root = mac.engine.store.volume(volume.id).path;
  fs.renameSync(path.join(root, "old"), path.join(root, "new"));
  mac.engine.work.mark(volume.id, "old");
  mac.engine.work.mark(volume.id, "new");
  await incremental(mac);
  assert.equal(read(hub, volume, "new/child.txt"), "child");
  assert.equal(hub.engine.store.current(volume.id, "old/child.txt").deleted, 1);
  assert.equal(read(hub, volume, "keep.txt"), "keep");
});

test("missed local events cannot be overwritten by incremental remote changes", async (t) => {
  const { hub, volume, connect } = await setup(t);
  write(hub, volume, "note.txt", "base");
  await hub.sync();
  const mac = await connect("incremental-conflict");
  const incremental = (n) =>
    n.engine.exclusive(() => n.engine.cycle({ incremental: true }));
  await incremental(mac);
  const cursor = mac.engine.work.state(volume.id).cursor;
  write(mac, volume, "note.txt", "offline"); // Deliberately omit the watcher event.
  write(hub, volume, "note.txt", "remote");
  hub.engine.work.mark(volume.id, "note.txt");
  await incremental(hub);
  await incremental(mac);
  assert.equal(read(mac, volume, "note.txt"), "offline");
  assert.equal(
    mac.engine.work.state(volume.id).cursor,
    cursor,
    "interrupted work does not acknowledge remote changes",
  );
  await incremental(mac);
  const rows = mac.engine.store.rows(volume.id).filter((r) => !r.deleted);
  const contents = rows
    .filter((r) => r.path.startsWith("note.txt"))
    .map((r) => read(mac, volume, r.path));
  assert.ok(contents.includes("offline"));
  assert.ok(contents.includes("remote"));
});

test("dirty work survives reopening and events during a full scan are not acknowledged", async (t) => {
  const { hub, volume } = await setup(t);
  const { Store } = await import("../packages/daemon/storage.js");
  const { SyncWork } = await import("../packages/daemon/sync-work.js");
  hub.engine.work.mark(volume.id);
  const plan = hub.engine.work.plan(volume, true);
  hub.engine.work.mark(volume.id, "changed-during-scan.txt");
  hub.engine.work.complete(volume, plan);
  assert.equal(hub.engine.work.plan(volume, true).full, true);
  const another = new Store(hub.engine.store.home);
  try {
    assert.equal(new SyncWork(another).plan(volume, true).full, true);
  } finally {
    another.close();
  }
});

test("scanner cancellation discards partial results and leaves files intact", async (t) => {
  const { hub, volume } = await setup(t);
  write(hub, volume, "keep.txt", "keep");
  const pending = hub.engine.scanner.scan(hub.engine.store.volume(volume.id));
  hub.engine.scanner.interrupt();
  await assert.rejects(pending, (e) => e.syncInterrupted === true);
  assert.equal(read(hub, volume, "keep.txt"), "keep");
  const disk = await hub.engine.scanner.scan(
    hub.engine.store.volume(volume.id),
  );
  assert.ok(disk.has("keep.txt"));
});

test("incremental policy changes reconcile newly included history", async (t) => {
  const { hub, volume, connect } = await setup(t);
  write(hub, volume, "hidden.txt", "preserved");
  await hub.sync();
  write(hub, volume, ".arcaignore", "hidden.txt\n");
  await hub.sync();
  const mac = await connect("incremental-policy");
  const incremental = (n) =>
    n.engine.exclusive(() => n.engine.cycle({ incremental: true }));
  await incremental(mac);
  assert.equal(
    fs.existsSync(
      path.join(mac.engine.store.volume(volume.id).path, "hidden.txt"),
    ),
    false,
  );
  write(hub, volume, ".arcaignore", "");
  hub.engine.work.mark(volume.id, ".arcaignore");
  await incremental(hub);
  await incremental(mac);
  assert.equal(read(mac, volume, "hidden.txt"), "preserved");
});

test("change pagination has a stable upper bound and catches edits made between pages", async (t) => {
  const { hub, volume } = await setup(t);
  const db = hub.engine.store.db;
  db.exec("BEGIN IMMEDIATE");
  try {
    const revision = db.prepare(
      "INSERT INTO revisions(volume,path,hash,size,deleted,author,created) VALUES(?,?,NULL,0,1,?,?)",
    );
    for (let i = 0; i < 1001; i++) {
      const name = `old-${i}.txt`;
      const { lastInsertRowid } = revision.run(
        volume.id,
        name,
        hub.engine.config.id,
        new Date().toISOString(),
      );
      hub.engine.store.setFile({
        volume: volume.id,
        path: name,
        hash: null,
        size: 0,
        deleted: 1,
        rev: Number(lastInsertRowid),
      });
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  let page = await hub.api(`/v1/changes?volume=${volume.id}&after=0`);
  assert.equal(page.files.length, 500);
  const through = page.through;
  const changed = hub.engine.store.commit(
    volume.id,
    "old-999.txt",
    null,
    hub.engine.config.id,
  );
  const seen = page.files.map((r) => r.path);
  while (page.next !== null) {
    page = await hub.api(
      `/v1/changes?volume=${volume.id}&after=${page.next}&through=${through}`,
    );
    seen.push(...page.files.map((r) => r.path));
  }
  assert.equal(new Set(seen).size, seen.length);
  const next = await hub.api(
    `/v1/changes?volume=${volume.id}&after=${through}`,
  );
  assert.ok(next.files.some((r) => r.rev === changed.rev));
  await assert.rejects(
    hub.api(`/v1/changes?volume=${volume.id}&after=${next.through + 1}`),
    /cursor/,
  );
});

test("real watcher debounces local edits into a partial scan and remains quiet afterwards", async (t) => {
  const { hub, volume } = await setup(t, { timer: true });
  write(hub, volume, "node_modules/ignored.txt", "one");
  const waitFor = async (predicate) => {
    const deadline = Date.now() + 10000;
    while (!predicate()) {
      if (Date.now() > deadline) assert.fail("Timed out waiting for watcher");
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  await waitFor(
    () =>
      hub.engine.store.volume(volume.id).last_sync &&
      !hub.engine.store.db.prepare("SELECT 1 FROM sync_dirty LIMIT 1").get(),
  );
  await new Promise((r) => setTimeout(r, 1300));
  const calls = [];
  const scan = hub.engine.scanner.scan.bind(hub.engine.scanner);
  hub.engine.scanner.scan = (v, paths) => {
    calls.push(paths);
    return scan(v, paths);
  };
  write(hub, volume, "node_modules/ignored.txt", "two");
  await new Promise((r) => setTimeout(r, 1300));
  assert.equal(calls.length, 0, "ignored events do not schedule scans");
  write(hub, volume, "event.txt", "one");
  write(hub, volume, "event.txt", "two");
  await waitFor(
    () =>
      hub.engine.store.current(volume.id, "event.txt")?.hash === digest("two"),
  );
  assert.ok(calls.length > 0);
  assert.ok(
    calls.every((paths) => Array.isArray(paths) && paths.includes("event.txt")),
  );
  const count = calls.length;
  await new Promise((r) => setTimeout(r, 1700));
  assert.equal(calls.length, count, "no repeated scan while nothing changes");
});

test("disconnect retains replica files and destinations; fresh pairing reconnects the original hub", async (t) => {
  const { root, hub, volume, connect, node } = await setup(t);
  const mac = await connect("portable");
  write(hub, volume, "note.txt", "before");
  await hub.sync();
  await mac.sync();
  const before = mac.engine.store.volume(volume.id);
  const oldToken = mac.engine.config.hub.token;
  const backupPath = path.join(root, "portable-backup");
  await mac.api("/v1/backup", { enabled: true, path: backupPath });
  await assert.rejects(mac.api("/v1/disconnect", {}), { status: 400 });
  await assert.rejects(hub.api("/v1/disconnect", { confirmed: true }), {
    status: 409,
  });
  await assert.rejects(
    mac.api("/v1/disconnect", { confirmed: true }, oldToken),
    { status: 401 },
  );
  mac.engine.paused = true;
  await mac.api("/v1/disconnect", { confirmed: true });
  assert.equal(
    hub.engine.store.db
      .prepare("SELECT id FROM devices WHERE id=?")
      .get(mac.invite.id),
    undefined,
  );
  assert.equal(mac.engine.paused, true);
  assert.equal(mac.engine.status().phase, "unlinked");
  assert.equal(mac.engine.config.hub, null);
  assert.equal(mac.engine.config.backup.enabled, false);
  assert.equal(
    JSON.parse(
      fs.readFileSync(path.join(backupPath, "state", "config.json"), "utf8"),
    ).hub.token,
    undefined,
  );
  assert.equal(mac.engine.store.volume(volume.id).path, before.path);
  assert.equal(mac.engine.store.volume(volume.id).selected, before.selected);
  assert.equal(read(mac, volume, "note.txt"), "before");
  const persisted = JSON.parse(
    fs.readFileSync(mac.engine.store.configPath, "utf8"),
  );
  assert.equal(persisted.hub, null);
  assert.equal(JSON.stringify(persisted).includes(oldToken), false);
  write(mac, volume, "note.txt", "offline edit");
  mac.engine.paused = false;
  await mac.sync();
  assert.equal(read(hub, volume, "note.txt"), "before");
  const other = await node("other-hub", "hub");
  const otherInvite = await other.api("/v1/devices", {
    name: "portable",
    role: "replica",
  });
  await assert.rejects(
    mac.api("/v1/connect", {
      url: `http://127.0.0.1:${other.port}`,
      token: otherInvite.token,
    }),
    { status: 409 },
  );
  assert.equal(mac.engine.config.hub, null);
  const code = await hub.api("/v1/pairing", {
    name: "portable",
    role: "replica",
  });
  await mac.api("/v1/connect", {
    url: `http://127.0.0.1:${hub.port}`,
    code: code.code,
  });
  assert.equal(mac.engine.config.disconnectedHub, undefined);
  assert.notEqual(mac.engine.config.hub.token, oldToken);
  await mac.sync();
  assert.equal(read(hub, volume, "note.txt"), "offline edit");
  assert.equal(mac.engine.store.volume(volume.id).path, before.path);
});

test("removing a machine deletes registration and reports, rejects an in-flight upload and preserves history", async (t) => {
  const { hub, volume, connect } = await setup(t);
  const mac = await connect("old-machine");
  write(mac, volume, "keep.txt", "retained");
  await mac.sync();
  const store = hub.engine.store;
  const id = mac.invite.id;
  await hub.api(
    "/v1/backup-ack",
    { enabled: true, revision: 1 },
    mac.invite.token,
  );
  await hub.api(
    `/v1/snapshot?volume=${volume.id}&limit=1`,
    undefined,
    mac.invite.token,
  );
  const part = path.join(store.uploads, `${id}-${digest("partial")}.part`);
  fs.writeFileSync(part, "partial");
  const history = store.history(volume.id, "keep.txt");
  const hash = digest("late upload");
  const reached = new Promise((resolve) => hub.server.once("request", resolve));
  let request;
  const response = new Promise((resolve, reject) => {
    request = http.request(
      `http://127.0.0.1:${hub.port}/v1/uploads/${hash}?offset=0&size=11`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${mac.invite.token}`,
          "Content-Length": 11,
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      },
    );
    request.on("error", reject);
    request.flushHeaders();
  });
  await reached;
  await hub.api("/v1/revoke", { id });
  request.end("late upload");
  assert.equal(await response, 401);
  assert.equal(fs.existsSync(part), false);
  assert.equal(fs.existsSync(store.blob(hash)), false);
  for (const [table, column] of [
    ["devices", "id"],
    ["machine_reports", "device"],
    ["backup_ack", "device"],
    ["snapshot_sessions", "owner"],
  ])
    assert.equal(
      store.db
        .prepare(`SELECT COUNT(*) n FROM ${table} WHERE ${column}=?`)
        .get(id).n,
      0,
    );
  assert.equal(
    (await hub.api("/v1/machines")).machines.some((m) => m.credentialId === id),
    false,
  );
  assert.deepEqual(store.history(volume.id, "keep.txt"), history);
  assert.equal(read(hub, volume, "keep.txt"), "retained");
  assert.equal(read(mac, volume, "keep.txt"), "retained");
  await assert.rejects(hub.api("/v1/catalog", undefined, mac.invite.token), {
    status: 401,
  });
});

test("pairing over a verified tailnet address needs no manual HTTP flag", async (t) => {
  const detector = {
    read: async () => ({
      state: "connected",
      self: { addresses: [] },
      peers: [{ addresses: ["100.70.0.2"] }],
    }),
  };
  const { hub, node } = await setup(t, { timer: false, network: { detector } });
  const mac = await node("automatic-network", "replica");
  const originalFetch = globalThis.fetch;
  const forwarded = [];
  globalThis.fetch = (url, options) => {
    const address = String(url);
    if (address.startsWith(`http://100.70.0.2:${hub.port}/`)) {
      forwarded.push({ address, redirect: options.redirect });
      return originalFetch(address.replace("100.70.0.2", "127.0.0.1"), options);
    }
    return originalFetch(url, options);
  };
  try {
    const invitation = await hub.api("/v1/pairing", {
      name: "automatic-network",
    });
    await mac.api("/v1/connect", {
      url: `http://100.70.0.2:${hub.port}`,
      code: invitation.code,
    });
    assert.equal(mac.engine.config.hub.url, `http://100.70.0.2:${hub.port}`);
    assert.equal(forwarded.length, 2);
    assert.ok(forwarded.every((call) => call.redirect === "error"));
    await assert.rejects(
      mac.api("/v1/connect", {
        url: `http://100.70.0.3:${hub.port}`,
        code: "000000",
      }),
      /not verified/,
    );
    assert.equal(forwarded.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("hub disconnect clears the replica credential and preserves local copies on next contact", async (t) => {
  const { hub, volume, connect } = await setup(t);
  const mac = await connect("departing");
  const other = await connect("remaining");
  write(mac, volume, "keep.txt", "keep");
  await mac.sync();
  await assert.rejects(hub.api("/v1/leave", {}), { status: 403 });
  await hub.api("/v1/revoke", { id: mac.invite.id });
  await mac.sync();
  assert.equal(mac.engine.status().phase, "unlinked");
  assert.equal(mac.engine.config.hub, null);
  assert.equal(read(mac, volume, "keep.txt"), "keep");
  await other.sync();
  assert.ok(other.engine.config.hub);
});

test("failed desktop disconnect keeps credentials and pause state so it can be retried", async (t) => {
  const { hub, connect } = await setup(t);
  const mac = await connect("offline");
  const original = mac.engine.config.hub;
  mac.engine.config.hub = { ...original, url: "http://127.0.0.1:1" };
  mac.engine.paused = true;
  await assert.rejects(mac.api("/v1/disconnect", { confirmed: true }), {
    status: 503,
  });
  assert.equal(mac.engine.config.hub.token, original.token);
  assert.equal(mac.engine.paused, true);
  mac.engine.config.hub = original;
  await mac.api("/v1/disconnect", { confirmed: true });
  assert.equal(mac.engine.config.hub, null);
  assert.equal(
    hub.engine.store.db
      .prepare("SELECT id FROM devices WHERE id=?")
      .get(mac.invite.id),
    undefined,
  );
});

test("a machine can disconnect only itself even when another ID is supplied", async (t) => {
  const { hub, connect } = await setup(t);
  const first = await connect("first");
  const second = await connect("second");
  await hub.api("/v1/leave", { id: second.invite.id }, first.invite.token);
  await first.sync();
  assert.equal(first.engine.config.hub, null);
  await second.sync();
  assert.ok(second.engine.config.hub);
});

test("backup size includes retained versions and counts duplicate content once", async (t) => {
  const { root, hub, volume, connect } = await setup(t);
  const mac = await connect("size-check");
  write(hub, volume, "first.txt", "original bytes");
  await hub.sync();
  await mac.api("/v1/backup", {
    enabled: true,
    path: path.join(root, "full-backup"),
  });
  await mac.sync();
  const initial = mac.engine.status().backup.contentBytes;
  assert.ok(initial >= Buffer.byteLength("original bytes"));
  write(hub, volume, "duplicate.txt", "original bytes");
  await hub.sync();
  await mac.sync();
  assert.equal(mac.engine.status().backup.contentBytes, initial);
  write(hub, volume, "first.txt", "new version");
  await hub.sync();
  await mac.sync();
  assert.equal(
    mac.engine.status().backup.contentBytes,
    initial + Buffer.byteLength("new version"),
  );
});

test("content flushes use writable handles for Windows compatibility", async (t) => {
  const open = fs.openSync;
  const flush = fs.fsyncSync;
  const handles = new Map();
  let contentFlushes = 0;
  t.mock.method(fs, "openSync", function (file, flags, ...args) {
    const fd = open.call(this, file, flags, ...args);
    handles.set(fd, flags);
    return fd;
  });
  t.mock.method(fs, "fsyncSync", function (fd) {
    if (fs.fstatSync(fd).isFile()) {
      contentFlushes++;
      if (handles.get(fd) === "r")
        throw Object.assign(new Error("EPERM: read-only file flush"), {
          code: "EPERM",
        });
    }
    return flush.call(this, fd);
  });
  const { hub, volume, connect } = await setup(t);
  const replica = await connect("Windows replica");
  const source = path.join(
    replica.engine.store.volume(volume.id).path,
    "flush.txt",
  );
  fs.writeFileSync(source, "replica upload");
  fs.chmodSync(source, 0o400);
  await replica.sync();
  assert.equal(fs.statSync(source).mode & 0o200, 0);
  fs.chmodSync(source, 0o600);
  await hub.sync();
  const destination = path.join(
    hub.engine.store.volume(volume.id).path,
    "flush.txt",
  );
  assert.equal(fs.readFileSync(destination, "utf8"), "replica upload");
  fs.writeFileSync(destination, "hub update");
  await hub.sync();
  await replica.sync();
  assert.equal(fs.readFileSync(source, "utf8"), "hub update");
  assert.ok(contentFlushes > 0);
});

test("empty directories synchronize bidirectionally, browse and survive restore without metadata files", async (t) => {
  const { hub, volume, connect } = await setup(t);
  const mac = await connect("mac"),
    other = await connect("other");
  const directory = (node, name) =>
    path.join(node.engine.store.volume(volume.id).path, name);
  fs.mkdirSync(directory(hub, "doc/Coros"), { recursive: true });
  fs.writeFileSync(directory(hub, "doc/Coros/.DS_Store"), "excluded");
  await hub.sync();
  await mac.sync();
  assert.deepEqual(fs.readdirSync(directory(mac, "doc/Coros")), []);
  const browse = await hub.api(`/v1/browse?volume=${volume.id}&prefix=doc`);
  assert.equal(browse.entries.find((e) => e.name === "Coros").files, 0);
  assert.equal(browse.entries.find((e) => e.name === "Coros").directory, 1);
  fs.mkdirSync(directory(mac, "workouts/empty"), { recursive: true });
  await mac.sync();
  await other.sync();
  assert.ok(fs.statSync(directory(hub, "workouts/empty")).isDirectory());
  assert.ok(fs.statSync(directory(other, "workouts/empty")).isDirectory());
  const revision = hub.engine.store.current(volume.id, "workouts/empty");
  fs.rmSync(directory(mac, "workouts"), { recursive: true });
  await mac.sync();
  await other.sync();
  assert.equal(fs.existsSync(directory(hub, "workouts")), false);
  assert.equal(fs.existsSync(directory(other, "workouts")), false);
  await hub.engine.restore(volume.id, revision.path, revision.rev);
  await other.sync();
  assert.ok(fs.statSync(directory(other, "workouts/empty")).isDirectory());
  assert.equal(
    hub.engine.store.rows(volume.id).some((r) => r.path.endsWith(".DS_Store")),
    false,
  );
});

test("directory removal preserves unsynchronized local contents and older clients are rejected", async (t) => {
  const { hub, volume, connect } = await setup(t);
  const mac = await connect("mac");
  const root = hub.engine.store.volume(volume.id).path;
  fs.mkdirSync(path.join(root, "empty"));
  await hub.sync();
  await mac.sync();
  const row = hub.engine.store.current(volume.id, "empty");
  fs.writeFileSync(path.join(root, "empty", ".DS_Store"), "keep");
  await assert.rejects(
    hub.engine.propose(
      { volume: volume.id, path: "empty", base: row.rev },
      { id: mac.engine.config.id },
    ),
    /not empty|ENOTEMPTY/,
  );
  assert.equal(
    fs.readFileSync(path.join(root, "empty/.DS_Store"), "utf8"),
    "keep",
  );
  const unsupported = await fetch(
    `http://127.0.0.1:${hub.port}/v1/snapshot?volume=${volume.id}`,
    { headers: { Authorization: `Bearer ${mac.invite.token}` } },
  );
  assert.equal(unsupported.status, 412);
});

test("stale directory deletion preserves a recreated directory and excluded empty directories stay untracked", async (t) => {
  const { hub, volume, connect } = await setup(t);
  const mac = await connect("mac");
  const root = hub.engine.store.volume(volume.id).path;
  fs.mkdirSync(path.join(root, "keep"));
  fs.mkdirSync(path.join(root, "ignored"));
  write(hub, volume, ".arcaignore", "ignored/\n");
  await hub.sync();
  const original = hub.engine.store.current(volume.id, "keep");
  const removed = hub.engine.store.commit(
    volume.id,
    "keep",
    null,
    hub.engine.config.id,
    true,
  );
  const restored = hub.engine.store.commit(
    volume.id,
    "keep",
    { directory: 1, hash: null, size: 0 },
    hub.engine.config.id,
    true,
  );
  const result = await hub.engine.propose(
    { volume: volume.id, path: "keep", base: original.rev },
    { id: mac.engine.config.id },
  );
  assert.equal(result.row.rev, restored.rev);
  assert.ok(fs.statSync(path.join(root, "keep")).isDirectory());
  assert.equal(hub.engine.store.current(volume.id, "ignored"), undefined);
  await mac.sync();
  assert.equal(
    fs.existsSync(
      path.join(mac.engine.store.volume(volume.id).path, "ignored"),
    ),
    false,
  );
  assert.ok(removed.directory);
});

test("indexed path collision checks preserve Unicode, literal prefixes and file/directory boundaries", async (t) => {
  const { hub, volume } = await setup(t),
    s = hub.engine.store;
  const dir = { directory: 1, hash: null, size: 0 },
    file = { hash: digest("fixture"), size: 7 };
  const commit = (name, item) =>
    s.commit(volume.id, name, item, hub.engine.config.id);
  commit("Äpfel", dir);
  assert.throws(() => commit("äPFEL", dir), /collision/);
  commit("über.txt", file);
  assert.throws(() => commit("ÜBER.TXT/child", file), /collision/);
  commit("100%/note", file);
  assert.throws(() => commit("100%", file), /collision/);
  commit("100%", dir);
  commit("100other", file);
  assert.throws(() => commit("100%", null), /contains synchronized/);
  commit("100%/note", null);
  commit("100%", null);
  assert.equal(s.current(volume.id, "100other").deleted, 0);
});

test("file deletion rejects stale content, preserves history and propagates from hub and replica", async (t) => {
  const { hub, volume, connect } = await setup(t);
  write(hub, volume, "delete.txt", "retained");
  await hub.sync();
  const replica = await connect("replica");
  await replica.sync();
  const first = hub.engine.store.current(volume.id, "delete.txt");
  await assert.rejects(
    hub.api("/v1/delete-file", {
      volume: volume.id,
      path: "delete.txt",
      rev: first.rev - 1,
    }),
    /changed/,
  );
  await assert.rejects(
    hub.api(
      "/v1/delete-file",
      { volume: volume.id, path: "delete.txt", rev: first.rev },
      replica.invite.token,
    ),
    /administrator/,
  );
  await hub.api("/v1/delete-file", {
    volume: volume.id,
    path: "delete.txt",
    rev: first.rev,
  });
  await replica.sync();
  assert.equal(
    fs.existsSync(
      path.join(replica.engine.store.volume(volume.id).path, "delete.txt"),
    ),
    false,
  );
  await hub.api("/v1/restore", {
    volume: volume.id,
    path: "delete.txt",
    rev: first.rev,
  });
  await replica.sync();
  assert.equal(read(replica, volume, "delete.txt"), "retained");
  const row = replica.engine.store.current(volume.id, "delete.txt");
  write(replica, volume, "delete.txt", "unsynced");
  await assert.rejects(
    replica.api("/v1/delete-file", {
      volume: volume.id,
      path: "delete.txt",
      rev: row.rev,
    }),
    /changed/,
  );
  await replica.sync();
  const updated = replica.engine.store.current(volume.id, "delete.txt");
  await replica.api("/v1/delete-file", {
    volume: volume.id,
    path: "delete.txt",
    rev: updated.rev,
  });
  await replica.sync();
  assert.equal(hub.engine.store.current(volume.id, "delete.txt").deleted, 1);
});

test("ignore changes hide retained files from browse and totals without deleting history or disk", async (t) => {
  const { hub, volume } = await setup(t);
  write(hub, volume, "smith/repos/core/a.txt", "retained");
  write(hub, volume, "notes/keep.txt", "visible");
  await hub.sync();
  const original = hub.engine.store.current(
    volume.id,
    "smith/repos/core/a.txt",
  );
  write(hub, volume, ".arcaignore", "/smith/repos/*\n");
  await hub.sync();
  for (const endpoint of ["/v1/status", "/v1/catalog", "/v1/remote"]) {
    const data = await hub.api(endpoint);
    const v = data.volumes.find((v) => v.id === volume.id);
    assert.equal(v.files, 2, endpoint);
  }
  const browse = await hub.api(
    `/v1/browse?volume=${volume.id}&prefix=smith/repos`,
  );
  assert.equal(browse.entries.length, 0);
  const search = await hub.api(`/v1/browse?volume=${volume.id}&search=a.txt`);
  assert.equal(search.entries.length, 0);
  assert.equal(read(hub, volume, "smith/repos/core/a.txt"), "retained");
  assert.equal(
    hub.engine.store.current(volume.id, original.path).rev,
    original.rev,
  );
  assert.equal(hub.engine.store.history(volume.id, original.path).length, 1);
  write(hub, volume, ".arcaignore", "");
  await hub.sync();
  assert.equal(
    (await hub.api("/v1/catalog")).volumes.find((v) => v.id === volume.id)
      .files,
    3,
  );
});

test("replica history is restricted to selected folders, including paused selections", async (t) => {
  const { hub, volume, connect } = await setup(t);
  const hidden = await hub.api("/v1/volumes", { name: "Hidden" });
  write(hub, volume, "visible.txt", "visible");
  write(hub, hidden, "private.txt", "hidden");
  await hub.sync();
  const replica = await connect("history-replica");
  await replica.sync();
  const page = await replica.api("/v1/activity?limit=100");
  assert.ok(page.versions.length);
  assert.ok(page.versions.every((r) => r.volume === volume.id));
  await assert.rejects(
    replica.api(`/v1/history?volume=${hidden.id}&path=private.txt&limit=10`),
  );
  await replica.api("/v1/pause", { paused: true });
  assert.ok((await replica.api("/v1/activity?limit=100")).versions.length);
  await replica.api("/v1/unselect", { id: volume.id });
  assert.deepEqual((await replica.api("/v1/activity?limit=100")).versions, []);
  await assert.rejects(
    replica.api(`/v1/history?volume=${volume.id}&path=visible.txt&limit=10`),
    /Select/,
  );
});

test("current contract rejects standalone backups, paginates snapshots and never reseeds ignore rules", async (t) => {
  const { hub, volume, node } = await setup(t);
  await assert.rejects(
    node("standalone-backup", "backup"),
    /Only hub and replica/,
  );
  fs.unlinkSync(path.join(volume.path, ".arcaignore"));
  write(hub, volume, "kept.txt", "current");
  await hub.sync();
  assert.equal(fs.existsSync(path.join(volume.path, ".arcaignore")), false);
  const page = await hub.api(`/v1/snapshot?volume=${volume.id}`);
  assert.equal(typeof page.session, "string");
  assert.equal(page.next, null);
  assert.ok(page.files.some((row) => row.path === "kept.txt"));
  await hub.api("/v1/snapshot-release", { session: page.session });
});

test(
  "file actions interrupt stalled background requests and preserve sync intent",
  { timeout: 10000 },
  async (t) => {
    const { hub, volume, connect } = await setup(t);
    write(hub, volume, "action.txt", "recoverable");
    await hub.sync();
    const replica = await connect("interactive");
    await replica.sync();
    const original = hub.engine.store.current(volume.id, "action.txt");
    const hubURL = replica.engine.config.hub.url;
    for (const operation of ["delete-file", "restore"]) {
      let entered;
      const started = new Promise((resolve) => {
        entered = resolve;
      });
      const slow = http.createServer(() => entered());
      await new Promise((resolve) => slow.listen(0, "127.0.0.1", resolve));
      try {
        replica.engine.config.hub.url = `http://127.0.0.1:${slow.address().port}`;
        const cycle = replica.sync();
        await started;
        replica.engine.config.hub.url = hubURL;
        await replica.api(`/v1/${operation}`, {
          volume: volume.id,
          path: "action.txt",
          rev: original.rev,
        });
        await cycle;
        assert.equal(replica.engine.error, null);
        assert.equal(replica.engine.paused, false);
        await replica.sync();
        assert.equal(
          hub.engine.store.current(volume.id, "action.txt").deleted,
          operation === "delete-file" ? 1 : 0,
        );
      } finally {
        replica.engine.config.hub.url = hubURL;
        slow.closeAllConnections();
        await new Promise((resolve) => slow.close(resolve));
      }
    }
    assert.equal(read(replica, volume, "action.txt"), "recoverable");
  },
);

test("activity separates revisions, pending conflicts and deletions before pagination", async (t) => {
  const { hub, volume, connect } = await setup(t);
  write(hub, volume, "note.md", "first");
  await hub.sync();
  write(hub, volume, "note.md", "second");
  write(hub, volume, "note.md.conflict-test", "conflict");
  write(hub, volume, "removed.md", "retained");
  await hub.sync();
  const s = hub.engine.store;
  await hub.api("/v1/delete-file", {
    volume: volume.id,
    path: "removed.md",
    rev: s.current(volume.id, "removed.md").rev,
  });
  const replica = await connect("history-filters");
  await replica.sync();
  const expected = s.db
    .prepare(
      "SELECT rev FROM revisions WHERE volume=? AND directory=0 AND deleted=0 AND instr(path,'.conflict-')=0 ORDER BY rev DESC",
    )
    .all(volume.id)
    .map((r) => r.rev);
  for (const node of [hub, replica]) {
    const seen = [];
    let before = "";
    do {
      const page = await node.api(
        `/v1/activity?volume=${volume.id}&limit=1${before ? `&before=${before}` : ""}`,
      );
      seen.push(...page.versions.map((r) => r.rev));
      before = page.next;
    } while (before);
    assert.deepEqual(seen, expected);
    const conflicts = await node.api(
      `/v1/activity?volume=${volume.id}&filter=conflicts`,
    );
    assert.deepEqual(
      conflicts.versions.map((r) => r.path),
      ["note.md.conflict-test"],
    );
    const deleted = await node.api(
      `/v1/activity?volume=${volume.id}&filter=deleted`,
    );
    assert.deepEqual(
      deleted.versions.map((r) => r.path),
      ["removed.md"],
    );
    const history = await node.api(
      `/v1/history?volume=${volume.id}&path=removed.md`,
    );
    assert.deepEqual(
      history.versions.map((r) => r.deleted),
      [1, 0],
    );
  }
  const conflict = s.current(volume.id, "note.md.conflict-test");
  const original = s.current(volume.id, "note.md");
  await hub.api("/v1/conflict-choice", {
    volume: volume.id,
    path: conflict.path,
    choice: "original",
    originalRev: original.rev,
    conflictRev: conflict.rev,
  });
  assert.deepEqual(
    (await hub.api(`/v1/activity?volume=${volume.id}&filter=conflicts`))
      .versions,
    [],
  );
  assert.ok(
    (await hub.api(`/v1/history?volume=${volume.id}&path=${conflict.path}`))
      .versions.length,
  );
});

test("folder history policy is hub-owned, reaches replicas and survives saved catalog reads", async (t) => {
  const { hub, volume, connect } = await setup(t);
  const replica = await connect("history-reader");
  await replica.sync();
  assert.equal(
    replica.engine.status().volumes.find((v) => v.id === volume.id)
      .historyRetention,
    "1m",
  );
  for (const mode of ["1d", "1w", "forever", "off"]) {
    const preview = await hub.api("/v1/folder-retention", {
      id: volume.id,
      mode,
    });
    await hub.api("/v1/folder-retention", {
      id: volume.id,
      mode,
      apply: true,
      confirmation: preview.confirmation,
    });
    await replica.sync();
    assert.equal(
      hub.engine.status().volumes.find((v) => v.id === volume.id)
        .historyRetention,
      mode,
    );
    assert.equal(
      replica.engine.status().volumes.find((v) => v.id === volume.id)
        .historyRetention,
      mode,
    );
    assert.equal(
      replica.engine.config.catalog.find((v) => v.id === volume.id)
        .historyRetention,
      mode,
    );
    await assert.rejects(
      replica.api("/v1/folder-retention", { id: volume.id, mode: "forever" }),
      { status: 409 },
    );
  }
  const saved = new Store(replica.engine.store.home);
  try {
    assert.equal(
      saved.config.catalog.find((v) => v.id === volume.id).historyRetention,
      "off",
    );
  } finally {
    saved.close();
  }
});

test("desktop overlaps at most three uploads, negotiates larger blocks and verifies originals", async (t) => {
  const { hub, volume, connect } = await setup(t);
  const replica = await connect("large-gallery");
  for (let i = 0; i < 4; i++) write(replica, volume, `clip-${i}.mp4`, Buffer.alloc(9 * 1024 ** 2, i + 1));
  const request = replica.engine.request.bind(replica.engine);
  let active = 0, maximum = 0;
  const lengths = [];
  replica.engine.request = async (route, options) => {
    if (options?.method !== "PUT" || !route.startsWith("/v1/uploads/")) return request(route, options);
    active++; maximum = Math.max(maximum, active); lengths.push(options.body.length);
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return await request(route, options);
    } finally { active--; }
  };
  await replica.sync();
  assert.equal(replica.engine.error, null);
  assert.equal(maximum, 3);
  assert.equal(lengths.length, 8);
  assert.equal(Math.max(...lengths), 8 * 1024 ** 2);
  for (let i = 0; i < 4; i++) {
    const name = `clip-${i}.mp4`;
    const row = hub.engine.store.current(volume.id, name);
    assert.equal(row.hash, digest(Buffer.alloc(9 * 1024 ** 2, i + 1)));
    assert.equal(fs.statSync(hub.engine.store.blob(row.hash)).size, 9 * 1024 ** 2);
  }
});

test("pausing desktop drains three in-flight uploads without publishing their files", async (t) => {
  const { hub, volume, connect } = await setup(t);
  const replica = await connect("pause-gallery");
  for (let i = 0; i < 3; i++) write(replica, volume, `photo-${i}.jpg`, Buffer.alloc(100, i));
  let release, ready;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { ready = resolve; });
  let active = 0;
  const upload = replica.engine.upload.bind(replica.engine);
  replica.engine.upload = async (...args) => {
    if (++active === 3) ready();
    await gate;
    return upload(...args);
  };
  const syncing = replica.sync();
  await started;
  replica.engine.setPaused(true);
  release();
  await syncing;
  assert.equal(replica.engine.paused, true);
  for (let i = 0; i < 3; i++) assert.equal(hub.engine.store.current(volume.id, `photo-${i}.jpg`), undefined);
  replica.engine.setPaused(false);
  await replica.sync();
  for (let i = 0; i < 3; i++) assert.ok(hub.engine.store.current(volume.id, `photo-${i}.jpg`));
});


test("machine removal interrupts background work without waiting for an offline replica", { timeout: 10000 }, async (t) => {
  const { hub, volume, connect } = await setup(t);
  write(hub, volume, "kept.txt", "retained history");
  await hub.sync();
  const first = await connect("remove-from-hub");
  const second = await connect("leave-from-replica");
  const revision = hub.engine.store.current(volume.id, "kept.txt").rev;
  for (const [replica, route] of [[first, "/v1/revoke"], [second, "/v1/leave"]]) {
    let release;
    let entered;
    const started = new Promise((resolve) => { entered = resolve; });
    const controller = new AbortController();
    const blocked = hub.engine.exclusive(async () => {
      hub.engine.syncAbort = controller;
      await new Promise((resolve) => {
        release = resolve;
        controller.signal.addEventListener("abort", resolve, { once: true });
        entered();
      });
    });
    await started;
    try {
      const response = await fetch(`http://127.0.0.1:${hub.port}${route}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${route === "/v1/revoke" ? hub.engine.config.adminToken : replica.invite.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ id: replica.invite.id }),
        signal: AbortSignal.timeout(1500),
      });
      assert.equal(response.status, 200);
      assert.equal(hub.engine.store.db.prepare("SELECT id FROM devices WHERE id=?").get(replica.invite.id), undefined);
      assert.equal(hub.engine.store.current(volume.id, "kept.txt").rev, revision);
      assert.equal(read(hub, volume, "kept.txt"), "retained history");
      await assert.rejects(hub.api("/v1/catalog", undefined, replica.invite.token), { status: 401 });
    } finally {
      release();
      await blocked;
      hub.engine.syncAbort = null;
    }
  }
});


test("interrupting sync does not abort an independent interface request", { timeout: 6000 }, async (t) => {
  const { connect } = await setup(t);
  const replica = await connect("request-isolation");
  let entered, uiEntered, uiResponse;
  const started = new Promise((resolve) => { entered = resolve; });
  const uiStarted = new Promise((resolve) => { uiEntered = resolve; });
  const remote = http.createServer((req, res) => {
    if (req.url === "/v1/interface") { uiResponse = res; uiEntered(); }
    else entered();
  });
  await new Promise((resolve) => remote.listen(0, "127.0.0.1", resolve));
  const previous = replica.engine.config.hub.url;
  try {
    replica.engine.config.hub.url = `http://127.0.0.1:${remote.address().port}`;
    const cycle = replica.sync();
    await started;
    const interactive = replica.engine.request("/v1/interface");
    await uiStarted;
    replica.engine.interruptCycle();
    await cycle;
    uiResponse.end("interface ready");
    assert.equal(await (await interactive).text(), "interface ready");
    assert.equal(replica.engine.error, null);
  } finally {
    replica.engine.config.hub.url = previous;
    remote.closeAllConnections();
    await new Promise((resolve) => remote.close(resolve));
  }
});

test("file rename validates names and stale revisions, preserves history and syncs from hub and replica", async (t) => {
  const { hub, volume, connect } = await setup(t);
  write(hub, volume, "nested/original.txt", "retained");
  write(hub, volume, "nested/taken.txt", "keep");
  await hub.sync();
  const replica = await connect("rename-replica");
  await replica.sync();
  const first = hub.engine.store.current(volume.id, "nested/original.txt");
  const target = { volume: volume.id, path: first.path, rev: first.rev };
  for (const name of [
    "../escape",
    "a/b",
    "a\\b",
    "",
    "CON.txt",
    "bad.",
    "taken.txt",
    "TAKEN.TXT",
  ])
    await assert.rejects(hub.api("/v1/rename-file", { ...target, name }));
  await assert.rejects(
    hub.api("/v1/rename-file", {
      ...target,
      name: "new.txt",
      rev: first.rev - 1,
    }),
    /changed/,
  );
  await assert.rejects(
    hub.api(
      "/v1/rename-file",
      { ...target, name: "new.txt" },
      replica.invite.token,
    ),
    /administrator/,
  );
  assert.equal(read(hub, volume, first.path), "retained");
  assert.equal(read(hub, volume, "nested/taken.txt"), "keep");
  await hub.api("/v1/rename-file", { ...target, name: "renamed.txt" });
  assert.equal(hub.engine.store.current(volume.id, first.path).deleted, 1);
  assert.ok(
    hub.engine.store
      .history(volume.id, first.path)
      .some((r) => r.rev === first.rev),
  );
  await replica.sync();
  assert.equal(read(replica, volume, "nested/renamed.txt"), "retained");
  const local = replica.engine.store.current(volume.id, "nested/renamed.txt");
  write(replica, volume, local.path, "pending edit");
  await assert.rejects(
    replica.api("/v1/rename-file", {
      volume: volume.id,
      path: local.path,
      rev: local.rev,
      name: "final.txt",
    }),
    /changed/,
  );
  await replica.sync();
  const updated = replica.engine.store.current(volume.id, local.path);
  await replica.api("/v1/rename-file", {
    volume: volume.id,
    path: local.path,
    rev: updated.rev,
    name: "RENAMED.txt",
  });
  await replica.sync();
  assert.equal(read(hub, volume, "nested/RENAMED.txt"), "pending edit");
  const renamed = hub.engine.store.current(volume.id, "nested/RENAMED.txt");
  await hub.api("/v1/rename-file", {
    volume: volume.id,
    path: renamed.path,
    rev: renamed.rev,
    name: "Final.txt",
  });
  await replica.sync();
  assert.equal(read(replica, volume, "nested/Final.txt"), "pending edit");
});

test("catalog-only hub rename keeps content and rejects exclusions and directory targets", async (t) => {
  const { hub, volume, connect } = await setup(t);
  write(hub, volume, "original.txt", "archive");
  write(hub, volume, ".arcaignore", "*.private\n");
  write(hub, volume, "directory/child.txt", "child");
  await hub.sync();
  const replica = await connect("catalog-rename");
  await replica.sync();
  const original = hub.engine.store.current(volume.id, "original.txt");
  await hub.api("/v1/unselect", { id: volume.id });
  for (const name of ["secret.private", ".arcaignore", "directory"])
    await assert.rejects(
      hub.api("/v1/rename-file", {
        volume: volume.id,
        path: original.path,
        rev: original.rev,
        name,
      }),
    );
  await hub.api("/v1/rename-file", {
    volume: volume.id,
    path: original.path,
    rev: original.rev,
    name: "archived.txt",
  });
  await replica.sync();
  assert.equal(read(replica, volume, "archived.txt"), "archive");
  assert.equal(
    read(hub, volume, "original.txt"),
    "archive",
    "unselected disk contents are untouched",
  );
  const current = hub.engine.store.current(volume.id, "archived.txt");
  await hub.api("/v1/rename-file", {
    volume: volume.id,
    path: current.path,
    rev: current.rev,
    name: "Archived.txt",
  });
  await replica.sync();
  assert.equal(read(replica, volume, "Archived.txt"), "archive");
});

test("hub rename journals both paths and recovers after interrupted materialization", async (t) => {
  const { hub, volume } = await setup(t);
  write(hub, volume, "source.txt", "durable");
  await hub.sync();
  const s = hub.engine.store,
    original = s.current(volume.id, "source.txt");
  const materialize = s.materialize.bind(s);
  s.materialize = () => {
    throw new Error("disk unavailable");
  };
  await assert.rejects(
    hub.api("/v1/rename-file", {
      volume: volume.id,
      path: original.path,
      rev: original.rev,
      name: "destination.txt",
    }),
    /disk unavailable/,
  );
  assert.equal(
    s.db
      .prepare("SELECT count(*) AS n FROM pending WHERE volume=?")
      .get(volume.id).n,
    2,
  );
  s.materialize = (row, expected) => {
    if (!row.deleted) throw new Error("disk still unavailable");
    return materialize(row, expected);
  };
  assert.throws(() => s.recover(volume.id), /disk still unavailable/);
  assert.equal(read(hub, volume, "source.txt"), "durable", "recovery keeps the source until the destination can be written");
  s.materialize = materialize;
  s.recover(volume.id);
  assert.equal(read(hub, volume, "destination.txt"), "durable");
  assert.equal(s.current(volume.id, "source.txt").deleted, 1);
  assert.equal(
    s.db
      .prepare("SELECT count(*) AS n FROM pending WHERE volume=?")
      .get(volume.id).n,
    0,
  );
});
