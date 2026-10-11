import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { init } from "../packages/daemon/storage.js";
import { start } from "../packages/daemon/server.js";

async function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arca-races-"));
  const nodes = [];
  t.after(async () => {
    for (const n of nodes.reverse()) await n.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  async function node(name, role) {
    const home = path.join(root, name);
    init(home, { name, role, port: 0 });
    const n = await start(home, { timer: false });
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
      if (!r.ok) throw Object.assign(new Error(body.error), { status: r.status });
      return body;
    };
    n.sync = () => n.engine.exclusive(() => n.engine.cycle());
    n.incremental = () =>
      n.engine.exclusive(() => n.engine.cycle({ incremental: true }));
    return n;
  }
  const hub = await node("hub", "hub");
  const volume = await hub.api("/v1/volumes", { name: "Documents" });
  const connect = async (name) => {
    const replica = await node(name, "replica");
    const invite = await hub.api("/v1/devices", { name, role: "replica" });
    await replica.api("/v1/connect", {
      url: `http://127.0.0.1:${hub.port}`,
      token: invite.token,
    });
    await replica.api("/v1/select", { id: volume.id });
    return replica;
  };
  const dir = (n) => n.engine.store.volume(volume.id).path;
  const file = (n, name) => path.join(dir(n), ...name.split("/"));
  const write = (n, name, content) => {
    fs.mkdirSync(path.dirname(file(n, name)), { recursive: true });
    fs.writeFileSync(file(n, name), content);
  };
  const read = (n, name) =>
    fs.existsSync(file(n, name)) ? fs.readFileSync(file(n, name), "utf8") : null;
  const list = (n) => {
    const out = [];
    const walk = (relative) => {
      for (const entry of fs.readdirSync(path.join(dir(n), ...relative.split("/").filter(Boolean)), { withFileTypes: true })) {
        if (entry.name === ".arca-volume" || entry.name === ".arcaignore") continue;
        const name = relative ? `${relative}/${entry.name}` : entry.name;
        out.push(entry.isDirectory() ? `${name}/` : name);
        if (entry.isDirectory()) walk(name);
      }
    };
    walk("");
    return out.sort();
  };
  const head = (name) => hub.engine.store.current(volume.id, name);
  return { hub, volume, connect, dir, file, write, read, list, head };
}

test("D10 a remote directory deletion removes Finder metadata instead of freezing the folder", async (t) => {
  const { hub, connect, file, write, read, list, head } = await setup(t);
  const mac = await connect("mac"),
    other = await connect("other");
  write(hub, "album/a.jpg", "a");
  await hub.sync();
  await mac.sync();
  await other.sync();
  write(mac, "album/.DS_Store", "finder");
  fs.rmSync(file(other, "album"), { recursive: true });
  await other.sync();
  assert.equal(head("album").deleted, 1);
  await mac.sync();
  assert.equal(fs.existsSync(file(mac, "album")), false);
  write(hub, "later.txt", "later");
  await hub.sync();
  write(mac, "mac-new.txt", "from mac");
  await mac.sync();
  assert.equal(read(mac, "later.txt"), "later");
  assert.equal(head("mac-new.txt").deleted, 0);
  assert.deepEqual(
    mac.engine.store.db.prepare("SELECT path FROM pending").all(),
    [],
  );
  assert.deepEqual(list(mac), ["later.txt", "mac-new.txt"]);
});

test("D12 an orphan transfer temporary never blocks a remote directory deletion", async (t) => {
  const { hub, connect, file, write, list } = await setup(t);
  const a = await connect("a"),
    b = await connect("b");
  write(hub, "d/f.txt", "f");
  await hub.sync();
  await a.sync();
  await b.sync();
  write(a, "d/.arca-00000000-0000-0000-0000-000000000000", "partial");
  fs.rmSync(file(b, "d"), { recursive: true });
  await b.sync();
  await a.sync();
  await a.sync();
  assert.deepEqual(list(a), []);
});

test("D15 the hub accepts a directory deletion when its own copy only holds OS metadata", async (t) => {
  const { hub, connect, file, write, list, head } = await setup(t);
  const a = await connect("a");
  write(hub, "album/a.jpg", "a");
  await hub.sync();
  await a.sync();
  write(hub, "album/.DS_Store", "finder");
  fs.rmSync(file(a, "album"), { recursive: true });
  write(a, "unrelated.txt", "new");
  await a.sync();
  await a.sync();
  assert.equal(head("album").deleted, 1);
  assert.equal(head("unrelated.txt").deleted, 0);
  assert.equal(fs.existsSync(file(hub, "album")), false);
  assert.deepEqual(list(a), ["unrelated.txt"]);
});

test("D20 an edit made while an incoming version is written is kept as a conflict copy", async (t) => {
  const { hub, connect, dir, write, read, list } = await setup(t);
  const a = await connect("a");
  write(hub, "big.bin", "base");
  await hub.sync();
  await a.sync();
  write(hub, "big.bin", "hub-v2");
  await hub.sync();
  const copy = fs.copyFileSync;
  let edited = false;
  t.mock.method(fs, "copyFileSync", (from, to, ...rest) => {
    const result = copy(from, to, ...rest);
    if (!edited && path.basename(to).startsWith(".arca-") && path.dirname(to) === dir(a)) {
      edited = true;
      fs.writeFileSync(path.join(dir(a), "big.bin"), "USER-EDIT-DURING-APPLY");
    }
    return result;
  });
  await a.sync();
  t.mock.restoreAll();
  assert.ok(edited);
  assert.equal(read(a, "big.bin"), "hub-v2");
  const kept = list(a).filter((name) => name.startsWith("big.bin.conflict-"));
  assert.equal(kept.length, 1);
  assert.equal(read(a, kept[0]), "USER-EDIT-DURING-APPLY");
  await a.sync();
  assert.equal(read(hub, kept[0]), "USER-EDIT-DURING-APPLY");
});

test("D21 deleting a directory that gained a file elsewhere answers a conflict and the deleting replica pulls the file", async (t) => {
  const { hub, connect, file, write, read, head } = await setup(t);
  const a = await connect("a"),
    b = await connect("b");
  write(hub, "proj/one.txt", "1");
  await hub.sync();
  await a.sync();
  await b.sync();
  write(b, "proj/new.txt", "from-b");
  await b.sync();
  fs.rmSync(file(a, "proj"), { recursive: true });
  write(a, "a-new.txt", "a");
  await a.sync();
  await a.sync();
  assert.equal(head("proj").deleted, 0);
  assert.equal(head("proj/one.txt").deleted, 1);
  assert.equal(head("a-new.txt").deleted, 0);
  assert.equal(read(a, "proj/new.txt"), "from-b");
  assert.equal(a.engine.error, null);
});

test("D5b a file added under a directory deleted elsewhere revives the directory on the hub", async (t) => {
  const { hub, volume, connect, file, write, read, head } = await setup(t);
  const a = await connect("a"),
    b = await connect("b");
  write(hub, "proj/one.txt", "1");
  await hub.sync();
  await a.sync();
  await b.sync();
  await a.incremental();
  await b.incremental();
  fs.rmSync(file(a, "proj"), { recursive: true });
  a.engine.work.mark(volume.id, "proj");
  await a.incremental();
  write(b, "proj/new.txt", "new-from-b");
  b.engine.work.mark(volume.id, "proj/new.txt");
  await b.incremental();
  assert.equal(head("proj").deleted, 0);
  assert.ok(head("proj").rev < head("proj/new.txt").rev);
  await b.incremental();
  await b.sync();
  await a.incremental();
  assert.equal(read(b, "proj/new.txt"), "new-from-b");
  assert.equal(read(a, "proj/new.txt"), "new-from-b");
  assert.deepEqual(b.engine.store.db.prepare("SELECT path FROM pending").all(), []);
});

test("H1 hub Stop syncing here then re-select removes stale copies instead of reviving them", async (t) => {
  const { hub, volume, connect, file, write, read, list, head } = await setup(t);
  const a = await connect("a");
  write(hub, "keep.txt", "v1");
  write(hub, "remove.txt", "r");
  write(hub, "sub/x.txt", "x");
  write(hub, "edited.txt", "e1");
  await hub.sync();
  await a.sync();
  await hub.api("/v1/unselect", { id: volume.id });
  write(a, "keep.txt", "v2-from-a");
  fs.unlinkSync(file(a, "remove.txt"));
  fs.unlinkSync(file(a, "edited.txt"));
  fs.rmSync(file(a, "sub"), { recursive: true });
  write(a, "added.txt", "added");
  await a.sync();
  write(hub, "edited.txt", "edited on the hub while unselected");
  await hub.api("/v1/select", { id: volume.id });
  await hub.sync();
  assert.equal(head("remove.txt").deleted, 1);
  assert.equal(head("sub/x.txt").deleted, 1);
  assert.equal(head("sub").deleted, 1);
  assert.equal(read(hub, "keep.txt"), "v2-from-a");
  assert.equal(read(hub, "edited.txt"), "edited on the hub while unselected");
  assert.equal(head("edited.txt").deleted, 0, "an edit made on the hub's disk outlives the deletion");
  assert.deepEqual(list(hub), ["added.txt", "edited.txt", "keep.txt"]);
  await a.sync();
  assert.deepEqual(list(a), ["added.txt", "edited.txt", "keep.txt"]);
});

test("R2 an edit always wins over a deletion, whichever reaches the hub first", async (t) => {
  const { hub, connect, file, write, read, list, head } = await setup(t);
  const a = await connect("a"),
    b = await connect("b");
  write(hub, "first.txt", "base");
  write(hub, "second.txt", "base");
  await hub.sync();
  await a.sync();
  await b.sync();
  fs.unlinkSync(file(a, "first.txt"));
  write(b, "first.txt", "bob-edit");
  write(b, "second.txt", "bob-edit");
  fs.unlinkSync(file(a, "second.txt"));
  await a.sync();
  await b.sync();
  await a.sync();
  for (const name of ["first.txt", "second.txt"]) {
    assert.equal(head(name).deleted, 0, name);
    assert.equal(read(a, name), "bob-edit");
    assert.equal(read(b, name), "bob-edit");
  }
  assert.deepEqual(list(a), ["first.txt", "second.txt"]);
  assert.deepEqual(list(b), ["first.txt", "second.txt"]);
});

test("R2 an edit to a file renamed elsewhere follows the rename", async (t) => {
  const { hub, connect, file, write, list, read, head } = await setup(t);
  const a = await connect("a"),
    b = await connect("b");
  write(hub, "old.txt", "base");
  await hub.sync();
  await a.sync();
  await b.sync();
  fs.renameSync(file(a, "old.txt"), file(a, "new.txt"));
  write(b, "old.txt", "bob-edit");
  await a.sync();
  await b.sync();
  await a.sync();
  assert.equal(head("old.txt").deleted, 1);
  assert.equal(read(hub, "new.txt"), "bob-edit");
  assert.deepEqual(list(a), ["new.txt"]);
  assert.deepEqual(list(b), ["new.txt"]);
  assert.equal(read(a, "new.txt"), "bob-edit");
});

test("R3 a case-only rename racing an edit leaves no duplicate conflict copies", async (t) => {
  const { hub, connect, file, write, list, read } = await setup(t);
  const a = await connect("a"),
    b = await connect("b");
  write(hub, "Note.txt", "base");
  await hub.sync();
  await a.sync();
  await b.sync();
  fs.renameSync(file(a, "Note.txt"), file(a, "note.txt"));
  write(b, "Note.txt", "bob-edit");
  await a.sync();
  await b.sync();
  await b.sync();
  await a.sync();
  for (const n of [a, b]) {
    assert.deepEqual(list(n), ["note.txt"]);
    assert.equal(read(n, "note.txt"), "bob-edit");
  }
  assert.equal(
    hub.engine.store.rows(hub.engine.store.volumes()[0].id).filter((row) => row.path.includes(".conflict-")).length,
    0,
  );
});

test("R5 a full cycle leaves the change cursor at the snapshot it applied", async (t) => {
  const { hub, volume, connect, write, read } = await setup(t);
  const a = await connect("a");
  for (let i = 0; i < 5; i++) write(hub, `f${i}.txt`, String(i));
  await hub.sync();
  await a.sync();
  const cursor = a.engine.work.state(volume.id).cursor;
  assert.ok(cursor >= hub.engine.store.current(volume.id, "f4.txt").rev);
  const pages = [];
  const metadata = a.engine.metadata.bind(a.engine);
  a.engine.metadata = (route) => {
    if (route.startsWith("/v1/changes")) pages.push(route);
    return metadata(route);
  };
  write(hub, "f9.txt", "9");
  await hub.sync();
  await a.incremental();
  assert.equal(read(a, "f9.txt"), "9");
  assert.ok(pages.every((route) => route.includes(`after=${cursor}`)));
});

test("R4 relinking keeps an edit made while unlinked as a visible conflict copy", async (t) => {
  const { hub, volume, connect, dir, write, read, list, head } = await setup(t);
  const a = await connect("a");
  const trashed = [];
  a.engine.moveToTrash = async (files) => {
    for (const name of files) {
      trashed.push(path.basename(name));
      fs.unlinkSync(name);
    }
  };
  write(hub, "doc.txt", "v1");
  write(hub, "old.txt", "o1");
  await hub.sync();
  await a.sync();
  write(hub, "old.txt", "o2");
  await hub.sync();
  const local = dir(a);
  await a.api("/v1/unselect", { id: volume.id, deleteFiles: false });
  fs.writeFileSync(path.join(local, "doc.txt"), "edited-while-unlinked");
  fs.writeFileSync(path.join(local, "fresh.txt"), "new-while-unlinked");
  await a.api("/v1/select", { id: volume.id, path: local });
  await a.sync();
  assert.deepEqual(trashed, ["old.txt"], "an outdated copy of a hub version still goes to the Trash");
  const kept = list(a).find((name) => name.startsWith("doc.txt.conflict-"));
  assert.ok(kept);
  assert.equal(read(a, kept), "edited-while-unlinked");
  assert.equal(read(a, "doc.txt"), "v1");
  assert.equal(read(a, "old.txt"), "o2");
  assert.equal(head(kept).deleted, 0);
  assert.equal(head("fresh.txt").deleted, 0);
  assert.ok((await hub.api("/v1/status")).volumes[0].conflicts >= 1);
});

test("R4 relinking checks outdated local copies against history a few requests at a time", async (t) => {
  const { hub, volume, connect, dir, write, read } = await setup(t);
  const a = await connect("a");
  a.engine.moveToTrash = async (files) => {
    for (const name of files) fs.unlinkSync(name);
  };
  const names = Array.from({ length: 20 }, (_, i) => `old-${i}.txt`);
  for (const name of names) write(hub, name, "o1");
  await hub.sync();
  await a.sync();
  for (const name of names) write(hub, name, "o2");
  await hub.sync();
  const local = dir(a);
  await a.api("/v1/unselect", { id: volume.id, deleteFiles: false });
  await a.api("/v1/select", { id: volume.id, path: local });
  const metadata = a.engine.metadata.bind(a.engine);
  let active = 0,
    peak = 0,
    requests = 0;
  a.engine.metadata = async (route, ...rest) => {
    if (!route.startsWith("/v1/history?") || !route.includes("path=old-"))
      return metadata(route, ...rest);
    requests++;
    peak = Math.max(peak, ++active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    try {
      return await metadata(route, ...rest);
    } finally {
      active--;
    }
  };
  await a.sync();
  assert.equal(requests, names.length);
  assert.ok(peak > 1 && peak <= 8, `peak ${peak}`);
  for (const name of names) assert.equal(read(a, name), "o2");
});

test("F6 a failed write leaves no transfer temporary behind and a later edit is preserved", async (t) => {
  const { hub, connect, dir, write, read, list } = await setup(t);
  const a = await connect("a");
  write(hub, "n.txt", "base");
  await hub.sync();
  await a.sync();
  write(hub, "n.txt", "hub-v2");
  await hub.sync();
  const rename = fs.renameSync;
  let failed = false;
  t.mock.method(fs, "renameSync", (from, to) => {
    if (!failed && path.basename(from).startsWith(".arca-") && to.endsWith("n.txt")) {
      failed = true;
      throw new Error("simulated crash before rename");
    }
    return rename(from, to);
  });
  await assert.rejects(a.sync(), /n\.txt: simulated crash/);
  t.mock.restoreAll();
  assert.deepEqual(
    fs.readdirSync(dir(a)).filter((name) => name.startsWith(".arca-") && name !== ".arca-volume"),
    [],
  );
  fs.writeFileSync(path.join(dir(a), ".arca-00000000-0000-0000-0000-000000000000"), "orphan");
  write(a, "n.txt", "user-edit-before-restart");
  await a.sync();
  assert.equal(read(a, "n.txt"), "hub-v2");
  const kept = list(a).filter((name) => name.startsWith("n.txt.conflict-"));
  assert.equal(kept.length, 1);
  assert.equal(read(a, kept[0]), "user-edit-before-restart");
  assert.deepEqual(
    fs.readdirSync(dir(a)).filter((name) => name.startsWith(".arca-") && name !== ".arca-volume"),
    [],
  );
});

test("R1 one file that cannot be written leaves the rest of the folder syncing", async (t) => {
  const { hub, volume, connect, write, read } = await setup(t);
  const a = await connect("a");
  write(hub, "locked.txt", "v1");
  write(hub, "free.txt", "v1");
  await hub.sync();
  await a.sync();
  write(hub, "locked.txt", "v2");
  write(hub, "free.txt", "v2");
  await hub.sync();
  const s = a.engine.store,
    materialize = s.materialize.bind(s);
  s.materialize = (row, expected) => {
    if (row.path === "locked.txt")
      throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
    return materialize(row, expected);
  };
  await assert.rejects(a.sync(), /locked\.txt: EBUSY/);
  assert.equal(read(a, "free.txt"), "v2");
  write(a, "local.txt", "from a");
  await assert.rejects(a.sync(), /locked\.txt/);
  assert.equal(hub.engine.store.current(volume.id, "local.txt").deleted, 0);
  assert.equal(a.engine.folderStates.get(volume.id).state, "error");
  s.materialize = materialize;
  await a.sync();
  assert.equal(read(a, "locked.txt"), "v2");
  assert.equal(a.engine.folderStates.get(volume.id).state, "synced");
});

test("R1 a hub row that keeps failing stops pinning the change feed and is republished once written", async (t) => {
  const { hub, volume, connect, write, read, head } = await setup(t);
  const a = await connect("a"),
    b = await connect("b");
  write(hub, "stuck.txt", "v1");
  await hub.sync();
  await a.sync();
  await b.sync();
  const s = hub.engine.store,
    materializeRow = s.materializeRow.bind(s);
  let locked = true;
  s.materializeRow = (row, expected) => {
    if (locked && row.path === "stuck.txt" && !row.deleted)
      throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
    return materializeRow(row, expected);
  };
  write(a, "stuck.txt", "v2 from a");
  await assert.rejects(a.sync(), /stuck\.txt/);
  const parkedRev = JSON.parse(
    s.db.prepare("SELECT row FROM pending WHERE path='stuck.txt'").get().row,
  ).rev;
  for (let i = 0; i < 3; i++) await hub.sync();
  assert.ok(
    s.db.prepare("SELECT failures FROM pending WHERE path='stuck.txt'").get().failures >= 3,
  );
  write(hub, "other.txt", "after the stuck row");
  await hub.sync();
  const changes = await b.engine.metadata(`/v1/changes?volume=${volume.id}&after=0`);
  assert.ok(changes.through >= head("other.txt").rev);
  await b.incremental();
  assert.equal(read(b, "other.txt"), "after the stuck row");
  assert.match(hub.engine.folderStates.get(volume.id).error, /stuck\.txt/);
  locked = false;
  await hub.sync();
  assert.equal(read(hub, "stuck.txt"), "v2 from a");
  assert.ok(head("stuck.txt").rev > head("other.txt").rev);
  assert.ok(head("stuck.txt").rev > parkedRev);
  await b.incremental();
  assert.equal(read(b, "stuck.txt"), "v2 from a");
});

test("R1 a parked hub deletion that completes because the file is gone is republished", async (t) => {
  const { hub, volume, connect, file, write, read, head } = await setup(t);
  const b = await connect("b");
  write(hub, "x.txt", "x");
  await hub.sync();
  await b.sync();
  await b.incremental();
  const s = hub.engine.store,
    materializeRow = s.materializeRow.bind(s);
  let locked = true;
  s.materializeRow = (row, expected) => {
    if (locked && row.path === "x.txt" && row.deleted && fs.existsSync(file(hub, "x.txt")))
      throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
    return materializeRow(row, expected);
  };
  await hub
    .api("/v1/delete-file", { volume: volume.id, path: "x.txt", rev: head("x.txt").rev })
    .catch(() => {});
  for (let i = 0; i < 3; i++) await hub.sync();
  assert.ok(
    s.db.prepare("SELECT failures FROM pending WHERE path='x.txt'").get().failures >= 3,
  );
  write(hub, "other.txt", "o");
  await hub.sync();
  await b.incremental();
  assert.equal(read(b, "other.txt"), "o");
  locked = false;
  fs.unlinkSync(file(hub, "x.txt"));
  await hub.sync();
  assert.equal(head("x.txt").deleted, 1);
  assert.ok(head("x.txt").rev > head("other.txt").rev);
  await b.incremental();
  assert.equal(read(b, "x.txt"), null);
});

test("R1 a new revision replacing a parked row starts with a clean failure count", async (t) => {
  const { hub, volume } = await setup(t);
  const s = hub.engine.store;
  const row = { volume: volume.id, path: "p.txt", hash: null, size: 0, deleted: 1, rev: 7 };
  s.queue(row, null);
  s.db.prepare("UPDATE pending SET failures=3").run();
  s.queue(row, null);
  assert.equal(s.db.prepare("SELECT failures FROM pending").get().failures, 3);
  s.queue({ ...row, rev: 8 }, null);
  assert.equal(s.db.prepare("SELECT failures FROM pending").get().failures, 0);
});

for (const kind of ["edit", "deletion"])
  test(`F7 a crash between setting the old copy aside and the ${kind} leaves no conflict copy`, async (t) => {
    const { hub, connect, file, write, read, list } = await setup(t);
    const a = await connect("a");
    write(hub, "doc.txt", "v1");
    await hub.sync();
    await a.sync();
    if (kind === "edit") write(hub, "doc.txt", "v2");
    else fs.unlinkSync(file(hub, "doc.txt"));
    await hub.sync();
    const s = a.engine.store,
      displace = s.displace.bind(s);
    s.displace = (target, row) => {
      displace(target, row);
      throw new Error("simulated crash after setting aside");
    };
    await assert.rejects(a.sync(), /simulated crash/);
    s.displace = displace;
    await a.sync();
    await hub.sync();
    assert.equal(read(a, "doc.txt"), kind === "edit" ? "v2" : null);
    assert.deepEqual(list(a), kind === "edit" ? ["doc.txt"] : []);
    assert.deepEqual(list(hub), kind === "edit" ? ["doc.txt"] : []);
  });

test("D22 a remote directory deletion keeps local .arca- files that are not transfer temporaries", async (t) => {
  const { hub, connect, file, write, read } = await setup(t);
  const a = await connect("a"),
    b = await connect("b");
  write(hub, "d/f.txt", "f");
  await hub.sync();
  await a.sync();
  await b.sync();
  write(a, "d/.arca-notes", "mine");
  fs.rmSync(file(b, "d"), { recursive: true });
  await b.sync();
  await a.sync();
  assert.equal(read(a, "d/.arca-notes"), "mine");
  assert.equal(read(a, "d/f.txt"), null);
});

test("R1 a folder that ends a cycle with isolated issues keeps its last completed sync", async (t) => {
  const { hub, volume, connect, write } = await setup(t);
  const a = await connect("a");
  write(hub, "locked.txt", "v1");
  await hub.sync();
  await a.sync();
  const lock = (n, name) => {
    const s = n.engine.store,
      materializeRow = s.materializeRow.bind(s);
    s.materializeRow = (row, expected) => {
      if (row.path === name && !row.deleted)
        throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
      return materializeRow(row, expected);
    };
  };
  const pause = () => new Promise((resolve) => setTimeout(resolve, 5));
  lock(hub, "locked.txt");
  lock(a, "incoming.txt");
  write(a, "locked.txt", "v2 from a");
  await assert.rejects(a.sync(), /locked\.txt/);
  const hubBefore = hub.engine.store.volume(volume.id).last_sync;
  assert.ok(hubBefore);
  await pause();
  await hub.sync();
  assert.match(hub.engine.folderStates.get(volume.id).error, /locked\.txt/);
  assert.equal(hub.engine.store.volume(volume.id).last_sync, hubBefore);
  assert.equal(hub.engine.folderStates.get(volume.id).lastCompleted, hubBefore);
  write(hub, "incoming.txt", "new");
  await hub.sync();
  const aBefore = a.engine.store.volume(volume.id).last_sync;
  assert.ok(aBefore);
  await pause();
  await assert.rejects(a.sync(), /incoming\.txt/);
  assert.match(a.engine.folderStates.get(volume.id).error, /incoming\.txt/);
  assert.equal(a.engine.store.volume(volume.id).last_sync, aBefore);
  assert.equal(a.engine.folderStates.get(volume.id).lastCompleted, aBefore);
});

for (const edited of [false, true])
  test(`F7 a crash after the new version is in place settles the ${edited ? "edited" : "unchanged"} old copy on the next attempt`, async (t) => {
    const { hub, connect, write, read, list } = await setup(t);
    const a = await connect("a");
    write(hub, "doc.txt", "v1");
    await hub.sync();
    await a.sync();
    write(hub, "doc.txt", "v2");
    await hub.sync();
    const s = a.engine.store,
      settle = s.settle.bind(s);
    let crashed = false;
    s.settle = (...args) => {
      if (!crashed) {
        crashed = true;
        if (edited) fs.writeFileSync(args[0], "edited on a");
        throw new Error("simulated crash after the rename");
      }
      return settle(...args);
    };
    await assert.rejects(a.sync(), /simulated crash/);
    assert.equal(read(a, "doc.txt"), "v2");
    assert.equal(list(a).filter((name) => name.includes(".conflict-local-")).length, 1);
    await a.sync();
    await a.sync();
    await hub.sync();
    const kept = list(a).filter((name) => name.includes(".conflict-local-"));
    assert.equal(read(a, "doc.txt"), "v2");
    if (edited) {
      assert.equal(kept.length, 1);
      assert.equal(read(a, kept[0]), "edited on a");
      assert.deepEqual(list(hub), list(a));
    } else {
      assert.deepEqual(list(a), ["doc.txt"]);
      assert.deepEqual(list(hub), ["doc.txt"]);
    }
  });

test("F7 a crash after setting aside a file the folder's rules now ignore puts it back instead of uploading it", async (t) => {
  const { hub, connect, write, read, list } = await setup(t);
  const a = await connect("a");
  write(hub, "doc.txt", "v1");
  await hub.sync();
  await a.sync();
  write(hub, "doc.txt", "v2");
  await hub.sync();
  const s = a.engine.store,
    displace = s.displace.bind(s);
  s.displace = (target, row) => {
    displace(target, row);
    throw new Error("simulated crash after setting aside");
  };
  await assert.rejects(a.sync(), /simulated crash/);
  s.displace = displace;
  write(a, ".arcaignore", "doc.txt\n");
  await a.sync();
  await hub.sync();
  assert.equal(read(a, "doc.txt"), "v1");
  assert.deepEqual(list(a).filter((name) => name.includes(".conflict-")), []);
  assert.deepEqual(list(hub).filter((name) => name.includes(".conflict-")), []);
});

test("F7 recovery settles a set-aside copy before dropping a row a newer head superseded", async (t) => {
  const { hub, volume, connect, file, write, read, list } = await setup(t);
  const a = await connect("a");
  write(hub, "doc.txt", "v1");
  await hub.sync();
  await a.sync();
  write(hub, "doc.txt", "v2");
  await hub.sync();
  const s = a.engine.store,
    displace = s.displace.bind(s);
  s.displace = (target, row) => {
    displace(target, row);
    throw new Error("simulated crash after setting aside");
  };
  await assert.rejects(a.sync(), /simulated crash/);
  s.displace = displace;
  assert.equal(fs.existsSync(file(a, "doc.txt")), false);
  const pending = JSON.parse(s.db.prepare("SELECT row FROM pending WHERE path='doc.txt'").get().row);
  s.setFile({ ...pending, rev: pending.rev + 100 });
  s.recover(volume.id);
  assert.equal(s.db.prepare("SELECT 1 FROM pending WHERE path='doc.txt'").get(), undefined);
  assert.equal(read(a, "doc.txt"), "v1");
  assert.deepEqual(list(a), ["doc.txt"]);
});

test("R1 a hub cycle that ends with an isolated issue keeps the hub's last sync", async (t) => {
  const { hub, volume, connect, write } = await setup(t);
  const a = await connect("a");
  write(hub, "locked.txt", "v1");
  await hub.sync();
  await a.sync();
  const s = hub.engine.store,
    materializeRow = s.materializeRow.bind(s);
  s.materializeRow = (row, expected) => {
    if (row.path === "locked.txt" && !row.deleted)
      throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
    return materializeRow(row, expected);
  };
  write(a, "locked.txt", "v2 from a");
  await assert.rejects(a.sync(), /locked\.txt/);
  await hub.sync();
  const before = hub.engine.status().lastSync;
  await new Promise((resolve) => setTimeout(resolve, 5));
  await hub.sync();
  assert.match(hub.engine.folderStates.get(volume.id).error, /locked\.txt/);
  assert.equal(hub.engine.status().lastSync, before);
});
