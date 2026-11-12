import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { init } from "../packages/daemon/storage.js";
import { start } from "../packages/daemon/server.js";

async function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arca-mass-"));
  const nodes = new Set();
  t.after(async () => {
    for (const n of [...nodes].reverse()) await n.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  async function open(home) {
    const n = await start(home, { timer: false });
    nodes.add(n);
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
    n.incremental = () => n.engine.exclusive(() => n.engine.cycle({ incremental: true }));
    n.restart = async () => {
      await n.close();
      nodes.delete(n);
      return open(home);
    };
    return n;
  }
  async function node(name, role) {
    const home = path.join(root, name);
    init(home, { name, role, port: 0 });
    return open(home);
  }
  const hub = await node("hub", "hub");
  const volume = await hub.api("/v1/volumes", { name: "Photos" });
  const connect = async (name) => {
    const replica = await node(name, "replica");
    const invite = await hub.api("/v1/devices", { name, role: "replica" });
    await replica.api("/v1/connect", { url: `http://127.0.0.1:${hub.port}`, token: invite.token });
    await replica.api("/v1/select", { id: volume.id });
    return replica;
  };
  const dir = (n) => n.engine.store.volume(volume.id).path;
  const file = (n, name) => path.join(dir(n), ...name.split("/"));
  const write = (n, name, content = name) => {
    fs.mkdirSync(path.dirname(file(n, name)), { recursive: true });
    fs.writeFileSync(file(n, name), content);
  };
  const read = (n, name) => (fs.existsSync(file(n, name)) ? fs.readFileSync(file(n, name), "utf8") : null);
  const many = (n, prefix, count) => {
    const names = Array.from({ length: count }, (_, i) => `${prefix}${i}.jpg`);
    for (const name of names) write(n, name);
    return names;
  };
  const live = (n, name) => n.engine.store.current(volume.id, name)?.deleted === 0;
  const tombstones = () =>
    hub.engine.store.db.prepare("SELECT COUNT(*) AS n FROM revisions WHERE volume=? AND deleted=1").get(volume.id).n;
  const folder = (n) => n.engine.status().volumes.find((v) => v.id === volume.id).sync;
  return { hub, volume, connect, dir, file, write, read, many, live, tombstones, folder };
}

test("a hub scan that would delete at least 50 files and more than a quarter of the folder holds them all", async (t) => {
  const { hub, volume, connect, file, write, read, many, live, tombstones, folder } = await setup(t);
  const a = await connect("a");
  const names = many(hub, "album/", 60);
  many(hub, "kept/", 20);
  await hub.sync();
  await a.sync();
  fs.rmSync(file(hub, "album"), { recursive: true });
  write(hub, "new-on-hub.txt");
  write(a, "new-on-a.txt");
  await hub.sync();
  assert.equal(tombstones(), 0);
  assert.ok(names.every((name) => live(hub, name)) && live(hub, "album"));
  const { token, ...held } = folder(hub).held;
  assert.equal(folder(hub).state, "synced", "the folder keeps its own state");
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.deepEqual(held, { files: 60, directories: [file(hub, "album")], more: 0 });
  await a.sync();
  assert.equal(read(a, "album/0.jpg"), "album/0.jpg");
  assert.equal(read(a, "new-on-hub.txt"), "new-on-hub.txt");
  assert.equal(read(hub, "new-on-a.txt"), "new-on-a.txt");
  await hub.sync();
  assert.equal(tombstones(), 0, "a later full scan keeps holding them");
  assert.equal(folder(hub).held.files, 60);
  assert.equal(hub.engine.folderBackoff.waiting(volume.id), null);
});

test("fewer than 50 deletions propagate", async (t) => {
  const { hub, file, many, live, folder } = await setup(t);
  const few = many(hub, "few/", 49);
  many(hub, "rest/", 20);
  await hub.sync();
  fs.rmSync(file(hub, "few"), { recursive: true });
  await hub.sync();
  assert.ok(few.every((name) => !live(hub, name)));
  assert.equal(folder(hub).held, undefined);
});

test("50 or more deletions that are not over a quarter of the folder propagate", async (t) => {
  const { hub, file, many, live, folder } = await setup(t);
  const big = many(hub, "big/", 50);
  many(hub, "rest/", 150);
  await hub.sync();
  fs.rmSync(file(hub, "big"), { recursive: true });
  await hub.sync();
  assert.ok(big.every((name) => !live(hub, name)), "50 of 200 files is not over a quarter");
  assert.equal(folder(hub).held, undefined);
});

test("a scoped hub scan holds a mass disappearance and the files coming back clear it", async (t) => {
  const { hub, volume, file, write, read, many, live, tombstones, folder } = await setup(t);
  const names = many(hub, "album/", 60);
  await hub.sync();
  const saved = names.map((name) => [name, read(hub, name)]);
  fs.rmSync(file(hub, "album"), { recursive: true });
  await hub.engine.scanHub(volume.id, { paths: ["album"] });
  assert.equal(tombstones(), 0);
  assert.equal(folder(hub).held.files, 60);
  for (const [name, content] of saved) write(hub, name, content);
  await hub.engine.scanHub(volume.id, { paths: ["album"] });
  assert.equal(folder(hub).held, undefined);
  assert.equal(folder(hub).state, "synced");
  assert.equal(hub.engine.store.db.prepare("SELECT COUNT(*) AS n FROM deletion_holds").get().n, 0);
  fs.rmSync(file(hub, "album/0.jpg"));
  await hub.sync();
  assert.equal(live(hub, "album/0.jpg"), false, "a later single deletion propagates as usual");
});

test("confirming deletes exactly the held files, not one that came back changed, and survives a restart", async (t) => {
  const setupResult = await setup(t);
  const { volume, connect, file, write, read, many, live, folder } = setupResult;
  let { hub } = setupResult;
  const a = await connect("a");
  const names = many(hub, "album/", 60);
  await hub.sync();
  await a.sync();
  fs.rmSync(file(hub, "album"), { recursive: true });
  await hub.sync();
  hub = await hub.restart();
  a.engine.config.hub.url = `http://127.0.0.1:${hub.port}`;
  assert.equal(folder(hub).held.files, 60, "the hold survives a restart");
  await hub.sync();
  assert.ok(names.every((name) => live(hub, name)));
  write(hub, "album/7.jpg", "edited and put back");
  await assert.rejects(
    hub.api("/v1/review-deletions", { id: volume.id, confirm: true, token: folder(hub).held.token }, a.engine.config.hub.token),
    (error) => error.status === 403,
  );
  await hub.api("/v1/review-deletions", { id: volume.id, confirm: true, token: folder(hub).held.token });
  await hub.sync();
  assert.equal(live(hub, "album/7.jpg"), true);
  assert.ok(names.filter((name) => name !== "album/7.jpg").every((name) => !live(hub, name)));
  assert.equal(folder(hub).state, "synced");
  await a.sync();
  assert.equal(read(a, "album/0.jpg"), null);
  assert.equal(read(a, "album/7.jpg"), "edited and put back");
});

test("a replica holds a mass disappearance, keeps syncing everything else and confirms through its local administrator", async (t) => {
  const { hub, volume, connect, file, write, read, many, live, tombstones, folder } = await setup(t);
  const a = await connect("a");
  const names = many(hub, "album/", 60);
  await hub.sync();
  await a.sync();
  await a.incremental();
  fs.rmSync(file(a, "album"), { recursive: true });
  write(a, "from-a.txt");
  a.engine.work.mark(volume.id, "album");
  a.engine.work.mark(volume.id, "from-a.txt");
  await a.incremental();
  assert.equal(tombstones(), 0);
  assert.equal(read(hub, "from-a.txt"), "from-a.txt");
  assert.equal(folder(a).held.files, 60);
  write(hub, "album/1.jpg", "edited on the hub");
  write(hub, "from-hub.txt");
  await hub.sync();
  await a.incremental();
  await a.incremental();
  assert.equal(read(a, "from-hub.txt"), "from-hub.txt");
  assert.equal(read(a, "album/1.jpg"), null, "a held path receives nothing");
  const restarted = await a.restart();
  assert.equal(folder(restarted).held.files, 60);
  await restarted.sync();
  assert.equal(tombstones(), 0);
  await restarted.api("/v1/review-deletions", { id: volume.id, confirm: true, token: folder(restarted).held.token });
  await restarted.sync();
  assert.ok(names.filter((name) => name !== "album/1.jpg").every((name) => !live(hub, name)));
  assert.equal(folder(restarted).state, "synced");
});

test("a replica's files coming back clear its hold and bring in what changed meanwhile", async (t) => {
  const { hub, volume, connect, file, write, read, many, folder } = await setup(t);
  const a = await connect("a");
  const names = many(hub, "album/", 60);
  await hub.sync();
  await a.sync();
  const saved = names.map((name) => [name, read(a, name)]);
  fs.rmSync(file(a, "album"), { recursive: true });
  await a.sync();
  assert.equal(folder(a).held.files, 60);
  write(hub, "album/3.jpg", "newer");
  await hub.sync();
  await a.sync();
  for (const [name, content] of saved) write(a, name, content);
  await a.api("/v1/review-deletions", { id: volume.id, confirm: false });
  await a.sync();
  assert.equal(folder(a).state, "synced");
  assert.equal(read(a, "album/3.jpg"), "newer");
  assert.equal(read(hub, "album/0.jpg"), "album/0.jpg");
});

for (const role of ["hub", "replica"])
  test(`the ${role} holds everything under a directory whose own disk is gone, and deletes on a disk still there`, async (t) => {
    const { hub, volume, connect, file, many, live, tombstones, folder } = await setup(t);
    const a = await connect("a");
    many(hub, "", 20);
    const mounted = many(hub, "disk/", 3);
    await hub.sync();
    await a.sync();
    const n = role === "hub" ? hub : a;
    const s = n.engine.store;
    const away = "4242";
    const readFromDisk = () => {
      for (const name of mounted) {
        const key = file(n, name);
        const cached = s.db.prepare("SELECT signature FROM scan_cache WHERE path=?").get(key);
        if (cached)
          s.db.prepare("UPDATE scan_cache SET signature=? WHERE path=?").run([away, ...cached.signature.split(":").slice(1)].join(":"), key);
      }
    };
    readFromDisk();
    const device = s.deviceOf.bind(s);
    let plugged = true;
    s.deviceOf = (target) => (plugged && target === file(n, "disk") ? away : device(target));
    fs.rmSync(file(n, "disk/0.jpg"));
    await n.sync();
    if (role === "replica") await hub.sync();
    assert.equal(live(hub, "disk/0.jpg"), false, "a deletion on a disk that is still there propagates");
    plugged = false;
    readFromDisk();
    for (const name of mounted.slice(1)) fs.rmSync(file(n, name));
    await n.sync();
    assert.equal(tombstones(), 1);
    assert.ok(live(hub, "disk/1.jpg") && live(hub, "disk/2.jpg"));
    const { token, ...held } = folder(n).held;
    assert.deepEqual(held, { files: 2, directories: [file(n, "disk")], more: 0 });
    assert.equal(n.engine.folderBackoff.waiting(volume.id), null);
  });

test("Delete from every device confirms only the holds that were shown: a later disappearance answers 409", async (t) => {
  const { hub, volume, file, many, live, tombstones, folder } = await setup(t);
  many(hub, "a/", 80);
  const later = many(hub, "b/", 200);
  many(hub, "c/", 20);
  await hub.sync();
  fs.rmSync(file(hub, "a"), { recursive: true });
  await hub.sync();
  const shown = folder(hub).held;
  assert.equal(shown.files, 80);
  fs.rmSync(file(hub, "b"), { recursive: true });
  await hub.engine.scanHub(volume.id, { paths: ["b"] });
  assert.equal(folder(hub).held.files, 280);
  await assert.rejects(
    hub.api("/v1/review-deletions", { id: volume.id, confirm: true, token: shown.token }),
    (error) => error.status === 409 && error.message === "The missing files changed. Review them again.",
  );
  await hub.sync();
  assert.equal(tombstones(), 0);
  await hub.api("/v1/review-deletions", { id: volume.id, confirm: true, token: folder(hub).held.token });
  await hub.sync();
  assert.ok(later.every((name) => !live(hub, name)));
  assert.equal(folder(hub).held, undefined);
});

test("renaming a large directory is a move, not a disappearance: nothing is held", async (t) => {
  const { hub, volume, connect, file, read, many, live, folder } = await setup(t);
  const a = await connect("a");
  const names = many(hub, "Trip/", 60);
  many(hub, "x/", 60);
  await hub.sync();
  await a.sync();
  fs.renameSync(file(hub, "Trip"), file(hub, "Trip 2024"));
  await hub.engine.scanHub(volume.id, { paths: ["Trip", "Trip 2024"] });
  assert.equal(folder(hub).held, undefined);
  assert.ok(names.every((name) => !live(hub, name)));
  assert.ok(live(hub, "Trip 2024/0.jpg"));
  fs.renameSync(file(a, "x"), file(a, "y"));
  await a.sync();
  assert.equal(folder(a).held, undefined);
  assert.equal(read(a, "Trip/0.jpg"), null);
  assert.equal(read(a, "Trip 2024/0.jpg"), "Trip/0.jpg");
  assert.equal(live(hub, "x/0.jpg"), false);
  assert.ok(live(hub, "y/0.jpg"));
});

for (const size of [60, 40])
  test(`deletions split across scans in batches of ${size} are counted together and held once they pass the threshold`, async (t) => {
    const { hub, volume, file, many, live, folder } = await setup(t);
    const names = many(hub, "f/", 400);
    await hub.sync();
    for (let i = 0; i < 400; i += size) {
      const batch = names.slice(i, i + size);
      for (const name of batch) fs.rmSync(file(hub, name));
      await hub.engine.scanHub(volume.id, { paths: batch });
    }
    const gone = names.filter((name) => !live(hub, name)).length;
    assert.ok(gone <= 100, `${gone} deletions went out`);
    assert.equal(folder(hub).held.files, 400 - gone, "every later batch joins the hold");
  });

test("a directory hold whose files were all deleted elsewhere is released", async (t) => {
  const { hub, volume, file, many, live, folder } = await setup(t);
  const names = many(hub, "album/", 60);
  many(hub, "x/", 20);
  await hub.sync();
  fs.rmSync(file(hub, "album"), { recursive: true });
  await hub.sync();
  assert.equal(folder(hub).held.files, 60);
  for (const name of names) hub.engine.store.commit(volume.id, name, null, "phone");
  await hub.sync();
  assert.equal(hub.engine.store.db.prepare("SELECT COUNT(*) AS n FROM deletion_holds").get().n, 0);
  assert.equal(live(hub, "album"), false);
});

test("a held folder keeps its own error beside the hold", async (t) => {
  const { hub, volume, file, many, folder } = await setup(t);
  many(hub, "album/", 60);
  many(hub, "x/", 20);
  await hub.sync();
  fs.rmSync(file(hub, "album"), { recursive: true });
  await hub.sync();
  const s = hub.engine.store,
    capture = s.capture.bind(s);
  s.capture = (target, ...rest) => {
    if (target === file(hub, "x/0.jpg")) throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
    return capture(target, ...rest);
  };
  hub.engine.scanner.scan = async (v, paths = null, skipUnreadable = false) => s.scan(v, paths, () => {}, skipUnreadable);
  await hub.sync();
  const state = folder(hub);
  assert.equal(state.state, "error");
  assert.match(state.error, /^Could not read 1 file in this folder: x\/0\.jpg/);
  assert.equal(state.held.files, 60);
});

test("one new empty file never excuses the disappearance of many empty files", async (t) => {
  const { hub, volume, file, write, many, tombstones, folder } = await setup(t);
  const names = Array.from({ length: 100 }, (_, i) => `empty/${i}.txt`);
  for (const name of names) write(hub, name, "");
  many(hub, "x/", 20);
  await hub.sync();
  fs.rmSync(file(hub, "empty"), { recursive: true });
  write(hub, "new/blank.txt", "");
  await hub.engine.scanHub(volume.id, { paths: ["empty", "new"] });
  assert.equal(tombstones(), 0);
  assert.equal(folder(hub).held.files, 100);
});

test("one copy elsewhere excuses one of many identical files, not all of them", async (t) => {
  const { hub, volume, file, write, many, folder } = await setup(t);
  for (let i = 0; i < 100; i++) write(hub, `same/${i}.jpg`, "identical photo");
  many(hub, "x/", 20);
  await hub.sync();
  fs.rmSync(file(hub, "same"), { recursive: true });
  write(hub, "elsewhere/copy.jpg", "identical photo");
  await hub.engine.scanHub(volume.id, { paths: ["same", "elsewhere"] });
  assert.equal(folder(hub).held.files, 99);
});

test("a full scan between batches of 49 does not restart the count: the rolling hour holds them", async (t) => {
  const { hub, volume, file, many, live, folder } = await setup(t);
  const names = many(hub, "f/", 400);
  await hub.sync();
  for (let i = 0; i < 400; i += 49) {
    const batch = names.slice(i, i + 49);
    for (const name of batch) fs.rmSync(file(hub, name));
    await hub.engine.scanHub(volume.id, { paths: batch });
    await hub.sync();
  }
  const gone = names.filter((name) => !live(hub, name)).length;
  assert.ok(gone <= 100, `${gone} deletions went out`);
  assert.equal(folder(hub).held.files, 400 - gone);
});
