import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { init, fileSignature, CONTENT_DAMAGED } from "../packages/daemon/storage.js";
import { start } from "../packages/daemon/server.js";

async function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arca-rot-"));
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
  const volume = await hub.api("/v1/volumes", { name: "Documents" });
  const connect = async (name) => {
    const replica = await node(name, "replica");
    const invite = await hub.api("/v1/devices", { name, role: "replica" });
    await replica.api("/v1/connect", { url: `http://127.0.0.1:${hub.port}`, token: invite.token });
    await replica.api("/v1/select", { id: volume.id });
    return replica;
  };
  const file = (n, name) => path.join(n.engine.store.volume(volume.id).path, name);
  const read = (n, name) => fs.readFileSync(file(n, name), "utf8");
  const precise = (n, name) => BigInt(fileSignature(file(n, name)).split(":")[4]) % 1000000n !== 0n;
  const rot = async (n, name, content) => {
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(file(n, name), content);
      if (precise(n, name)) break;
      await new Promise((resolve) => setTimeout(resolve, 3));
    }
    n.engine.store.db
      .prepare("UPDATE scan_cache SET signature=?, verified=0 WHERE path=?")
      .run(fileSignature(file(n, name)), file(n, name));
  };
  const revisions = (name) =>
    hub.engine.store.db.prepare("SELECT COUNT(*) AS n FROM revisions WHERE volume=? AND path=?").get(volume.id, name).n;
  const sides = (n, name) =>
    fs.readdirSync(path.dirname(file(n, name))).filter((entry) => entry.startsWith(`${name}.conflict-local-`));
  const folder = (n) => n.engine.status().volumes.find((v) => v.id === volume.id).sync;
  return { hub, volume, connect, file, read, rot, revisions, sides, folder };
}

test("content that changes under an unchanged stat on the hub is restored, not committed", async (t) => {
  const { hub, file, read, rot, revisions, sides, folder } = await setup(t);
  fs.writeFileSync(file(hub, "notes.txt"), "original");
  await hub.sync();
  await rot(hub, "notes.txt", "garbage!");
  await hub.sync();
  assert.equal(read(hub, "notes.txt"), "original");
  assert.equal(revisions("notes.txt"), 1);
  const [side] = sides(hub, "notes.txt");
  assert.equal(fs.readFileSync(path.join(path.dirname(file(hub, "notes.txt")), side), "utf8"), "garbage!");
  assert.equal(folder(hub).error, undefined);
  await hub.sync();
  assert.equal(revisions("notes.txt"), 1);
  assert.equal(revisions(side), 1, "the damaged bytes are kept as their own file");
});

test("a replica restores damaged content from the hub without proposing it", async (t) => {
  const { hub, connect, file, read, rot, revisions, sides } = await setup(t);
  const a = await connect("a");
  fs.writeFileSync(file(hub, "notes.txt"), "original");
  await hub.sync();
  await a.sync();
  assert.equal(read(a, "notes.txt"), "original");
  await rot(a, "notes.txt", "garbage!");
  await a.sync();
  assert.equal(read(a, "notes.txt"), "original");
  assert.equal(read(hub, "notes.txt"), "original");
  assert.equal(revisions("notes.txt"), 1);
  assert.equal(sides(a, "notes.txt").length, 1);
});

test("damaged content with no good copy is named on the folder and never synced", async (t) => {
  const { hub, connect, file, read, rot, revisions, folder } = await setup(t);
  const a = await connect("a");
  fs.writeFileSync(file(hub, "notes.txt"), "original");
  await hub.sync();
  await a.sync();
  const { hash } = hub.engine.store.current(hub.engine.store.volumes()[0].id, "notes.txt");
  fs.rmSync(hub.engine.store.blob(hash));
  await rot(a, "notes.txt", "garbage!");
  await assert.rejects(a.sync(), (error) => error.message.includes(`notes.txt: ${CONTENT_DAMAGED}`));
  assert.equal(read(a, "notes.txt"), "garbage!");
  assert.equal(revisions("notes.txt"), 1);
  assert.ok(folder(a).error.includes(`notes.txt: ${CONTENT_DAMAGED}`), folder(a).error);
});

test("a filesystem without sub-millisecond change times keeps treating changed content as an edit", async (t) => {
  const { hub, volume, file, rot } = await setup(t);
  fs.writeFileSync(file(hub, "notes.txt"), "original");
  await hub.sync();
  const statSync = fs.statSync;
  const coarse = (stat) =>
    stat && typeof stat.ctimeNs === "bigint"
      ? Object.assign(stat, { ctimeNs: (stat.ctimeNs / 1000000n) * 1000000n })
      : stat;
  fs.statSync = (...args) => coarse(statSync(...args));
  t.after(() => (fs.statSync = statSync));
  await rot(hub, "notes.txt", "garbage!");
  const s = hub.engine.store;
  const parts = fileSignature(file(hub, "notes.txt")).split(":");
  parts[4] = String((BigInt(parts[4]) / 1000000n) * 1000000n);
  s.db.prepare("UPDATE scan_cache SET signature=? WHERE path=?").run(parts.join(":"), file(hub, "notes.txt"));
  const disk = s.scan(s.volume(volume.id), ["notes.txt"], () => {}, true);
  assert.equal(disk.unreadable.size, 0);
  assert.notEqual(disk.get("notes.txt").hash, s.current(volume.id, "notes.txt").hash);
});

test("a hub repair that fails leaves no journal row behind and makes no revision", async (t) => {
  const { hub, volume, connect, file, read, rot, revisions, folder } = await setup(t);
  const a = await connect("a");
  fs.writeFileSync(file(hub, "notes.txt"), "original");
  fs.writeFileSync(file(hub, "other.txt"), "other");
  await hub.sync();
  await a.sync();
  fs.writeFileSync(hub.engine.store.blob(hub.engine.store.current(volume.id, "notes.txt").hash), "corrupt!");
  await rot(hub, "notes.txt", "garbage!");
  for (let i = 0; i < 4; i++) await hub.sync().catch(() => {});
  assert.equal(read(hub, "notes.txt"), "garbage!");
  assert.equal(hub.engine.store.db.prepare("SELECT COUNT(*) AS n FROM pending").get().n, 0);
  assert.equal(revisions("notes.txt"), 1);
  assert.ok(folder(hub).error.includes(`notes.txt: ${CONTENT_DAMAGED}`), folder(hub).error);
  fs.writeFileSync(file(hub, "other.txt"), "other, edited");
  await hub.sync().catch(() => {});
  await a.engine.exclusive(() => a.engine.cycle({ incremental: true }));
  assert.equal(read(a, "other.txt"), "other, edited");
});

test("the damaged verdict is remembered until the file changes, and its bytes are never served as the synced version", async (t) => {
  const { hub, volume, connect, file, rot } = await setup(t);
  const a = await connect("a");
  fs.writeFileSync(file(hub, "notes.txt"), "original");
  await hub.sync();
  await a.sync();
  const { hash } = hub.engine.store.current(volume.id, "notes.txt");
  a.engine.download = async () => {
    throw Object.assign(new Error("Object not found"), { status: 404 });
  };
  await rot(a, "notes.txt", "garbage!");
  await a.sync().catch(() => {});
  const s = a.engine.store;
  const row = () => s.db.prepare("SELECT hash,verified FROM scan_cache WHERE path=?").get(file(a, "notes.txt"));
  assert.deepEqual({ ...row() }, { hash, verified: -1 });
  assert.equal(s.localContent(volume.id, "notes.txt", hash), null);
  await a.sync().catch(() => {});
  assert.equal(row().verified, -1);
  fs.writeFileSync(file(a, "notes.txt"), "rewritten by the user");
  await a.sync();
  assert.equal(fs.readFileSync(file(hub, "notes.txt"), "utf8"), "rewritten by the user");
});

test("a replica never repairs a file whose last recorded version is a local edit the hub has not accepted", async (t) => {
  const { hub, volume, connect, file, read, rot } = await setup(t);
  const a = await connect("a");
  fs.writeFileSync(file(hub, "notes.txt"), "original");
  await hub.sync();
  await a.sync();
  fs.writeFileSync(file(a, "notes.txt"), "edited!!");
  const s = a.engine.store;
  s.scan(s.volume(volume.id), ["notes.txt"], () => {}, true);
  await rot(a, "notes.txt", "garbage!");
  await assert.rejects(a.sync(), (error) => error.message.includes(`notes.txt: ${CONTENT_DAMAGED}`));
  assert.equal(read(a, "notes.txt"), "garbage!");
  assert.equal(read(hub, "notes.txt"), "original");
});

test("a hub repair leaves a path alone while an accepted write for it is still pending", async (t) => {
  const { hub, volume, file, read, rot } = await setup(t);
  fs.writeFileSync(file(hub, "notes.txt"), "original");
  await hub.sync();
  const s = hub.engine.store;
  const waiting = { ...s.current(volume.id, "notes.txt"), hash: "f".repeat(64), rev: 99 };
  s.queue(waiting, null);
  await rot(hub, "notes.txt", "garbage!");
  await hub.sync().catch(() => {});
  assert.equal(read(hub, "notes.txt"), "garbage!");
  assert.equal(JSON.parse(s.db.prepare("SELECT row FROM pending WHERE path=?").get("notes.txt").row).rev, 99);
});

test("a hub that lost its own copy still never commits damaged content, and does not copy it again", async (t) => {
  const { hub, volume, file, read, rot, revisions, folder } = await setup(t);
  fs.writeFileSync(file(hub, "notes.txt"), "original");
  await hub.sync();
  const s = hub.engine.store;
  fs.rmSync(s.blob(s.current(volume.id, "notes.txt").hash));
  await rot(hub, "notes.txt", "garbage!");
  await hub.sync().catch(() => {});
  assert.equal(read(hub, "notes.txt"), "garbage!");
  assert.equal(revisions("notes.txt"), 1);
  assert.ok(folder(hub).error.includes(`notes.txt: ${CONTENT_DAMAGED}`), folder(hub).error);
  const copyFileSync = fs.copyFileSync;
  let copies = 0;
  fs.copyFileSync = (source, ...rest) => {
    if (source === file(hub, "notes.txt")) copies++;
    return copyFileSync(source, ...rest);
  };
  t.after(() => (fs.copyFileSync = copyFileSync));
  const disk = s.scan(s.volume(volume.id), ["notes.txt"], () => {}, true);
  assert.equal(disk.unreadable.get("notes.txt"), CONTENT_DAMAGED);
  assert.equal(copies, 0);
});
