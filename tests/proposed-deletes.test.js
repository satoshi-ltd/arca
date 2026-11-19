import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { init } from "../packages/daemon/storage.js";
import { start } from "../packages/daemon/server.js";
import { DELETION_HELD } from "../packages/daemon/engine.js";

async function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arca-held-"));
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
  const many = (n, prefix, count) =>
    Array.from({ length: count }, (_, i) => {
      const name = `${prefix}${i}.jpg`;
      fs.mkdirSync(path.dirname(file(n, name)), { recursive: true });
      fs.writeFileSync(file(n, name), name);
      return name;
    });
  const live = (name) => hub.engine.store.current(volume.id, name)?.deleted === 0;
  const held = () => hub.engine.status().volumes.find((v) => v.id === volume.id).sync.held;
  const propose = (n, name) =>
    n.engine.json("/v1/propose", {
      volume: volume.id,
      path: name,
      base: hub.engine.store.current(volume.id, name).rev,
      hash: null,
    });
  return { hub, volume, connect, dir, file, many, live, held, propose };
}

test("deletions a device sends without its own check are held on the hub once they reach the mass-deletion rule", async (t) => {
  const { hub, connect, file, many, live, held, propose } = await setup(t);
  const album = many(hub, "album/", 100);
  many(hub, "kept/", 20);
  await hub.sync();
  const phone = await connect("phone");
  await phone.sync();
  const answers = [];
  for (const name of album) answers.push(await propose(phone, name));
  assert.equal(answers.filter((a) => !a.conflict).length, 49);
  assert.ok(answers.slice(49).every((a) => a.conflict && a.reason === DELETION_HELD && !a.row.deleted));
  assert.ok(album.slice(49).every((name) => live(name) && fs.existsSync(file(hub, name))));
  assert.equal(held().files, 51);
  assert.deepEqual(held().from, ["phone"]);
  await hub.sync();
  assert.equal(held().files, 51, "a hub scan keeps a device's holds although the files are on its disk");
});

test("a replica that skips its own check gets the held files back, and Keep releases the hold", async (t) => {
  const { hub, volume, connect, file, many, live, held } = await setup(t);
  const album = many(hub, "album/", 100);
  many(hub, "kept/", 20);
  await hub.sync();
  const old = await connect("old");
  await old.sync();
  old.engine.holdDeletions = () => () => false;
  const json = old.engine.json.bind(old.engine);
  old.engine.json = (route, body, ...rest) => {
    if (route === "/v1/propose" && body) delete body.checked;
    return json(route, body, ...rest);
  };
  fs.rmSync(file(old, "album"), { recursive: true });
  await old.sync().catch(() => {});
  await old.sync().catch(() => {});
  assert.equal(album.filter((name) => live(name)).length, 51);
  assert.equal(album.filter((name) => fs.existsSync(file(old, name))).length, 51, "the device restores what the hub kept");
  assert.equal(held().files, 51);
  await hub.api("/v1/review-deletions", { id: volume.id, confirm: false });
  assert.equal(held(), undefined);
  assert.equal(album.filter((name) => live(name)).length, 51);
});

test("Delete from every device commits a device's held deletions on the hub", async (t) => {
  const { hub, volume, connect, file, many, live, held, propose } = await setup(t);
  const album = many(hub, "album/", 100);
  many(hub, "kept/", 20);
  await hub.sync();
  const phone = await connect("phone");
  const other = await connect("other");
  await phone.sync();
  await other.sync();
  for (const name of album) await propose(phone, name);
  await hub.api("/v1/review-deletions", { id: volume.id, confirm: true, token: held().token });
  assert.equal(held(), undefined);
  assert.ok(album.every((name) => !live(name) && !fs.existsSync(file(hub, name))));
  await other.sync();
  assert.ok(album.every((name) => !fs.existsSync(file(other, name))));
  assert.ok(fs.existsSync(file(other, "kept/0.jpg")));
});

test("a current replica's checked deletions, such as renaming a large folder, are never held by the hub", async (t) => {
  const { hub, connect, file, many, live, held } = await setup(t);
  const album = many(hub, "album/", 100);
  many(hub, "kept/", 20);
  await hub.sync();
  const desk = await connect("desk");
  await desk.sync();
  fs.renameSync(file(desk, "album"), file(desk, "renamed"));
  await desk.sync();
  assert.equal(held(), undefined);
  assert.ok(album.every((name) => !live(name)));
  assert.ok(live("renamed/0.jpg") && fs.existsSync(file(hub, "renamed/99.jpg")));
});

test("a folder the hub does not sync itself never holds a device's deletions it could not show", async (t) => {
  const { hub, volume, connect, many, live, held, propose } = await setup(t);
  const album = many(hub, "album/", 100);
  many(hub, "kept/", 20);
  await hub.sync();
  const phone = await connect("phone");
  await phone.sync();
  await hub.api("/v1/unselect", { id: volume.id });
  for (const name of album) assert.equal((await propose(phone, name)).conflict, false);
  assert.ok(album.every((name) => !live(name)));
  assert.equal(held(), undefined);
});

test("another device's edit of a held file, based on the revision before the hold, lands without a conflict copy", async (t) => {
  const { hub, volume, connect, file, many, held, propose } = await setup(t);
  const album = many(hub, "album/", 100);
  many(hub, "kept/", 20);
  await hub.sync();
  const phone = await connect("phone");
  const desk = await connect("desk");
  await phone.sync();
  await desk.sync();
  const base = hub.engine.store.current(volume.id, "album/90.jpg").rev;
  for (const name of album) await propose(phone, name);
  const kept = hub.engine.store.current(volume.id, "album/90.jpg").rev;
  assert.ok(kept > base);
  assert.equal((await phone.engine.json("/v1/propose", { volume: volume.id, path: "album/90.jpg", base, hash: null })).conflict, true);
  assert.equal(hub.engine.store.current(volume.id, "album/90.jpg").rev, kept, "a repeated held deletion publishes nothing more");
  fs.writeFileSync(file(desk, "album/90.jpg"), "edited on the desk");
  await desk.sync();
  assert.equal(fs.readFileSync(file(hub, "album/90.jpg"), "utf8"), "edited on the desk");
  assert.deepEqual(fs.readdirSync(path.join(file(hub, "album"))).filter((name) => name.includes(".conflict-")), []);
  await hub.sync();
  assert.equal(held().files, 50);
});

test("after Keep files, an edit based on the revision before the hold still lands without a conflict copy", async (t) => {
  const { hub, volume, connect, file, many, propose } = await setup(t);
  const album = many(hub, "album/", 100);
  many(hub, "kept/", 20);
  await hub.sync();
  const phone = await connect("phone");
  const desk = await connect("desk");
  await phone.sync();
  await desk.sync();
  for (const name of album) await propose(phone, name);
  await hub.api("/v1/review-deletions", { id: volume.id, confirm: false });
  fs.writeFileSync(file(desk, "album/90.jpg"), "edited after keep");
  await desk.sync();
  assert.equal(fs.readFileSync(file(hub, "album/90.jpg"), "utf8"), "edited after keep");
  assert.deepEqual(fs.readdirSync(file(hub, "album")).filter((name) => name.includes(".conflict-")), []);
});
