import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { init } from "../packages/daemon/storage.js";
import { start } from "../packages/daemon/server.js";

async function daemon(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-favorites-"));
  init(home, { port: 0, name: "Casa" });
  const d = await start(home, { timer: false });
  t.after(async () => {
    await d.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const call = async (route, body, token = d.engine.config.adminToken) => {
    const response = await fetch(`http://127.0.0.1:${d.port}${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json();
    if (!response.ok) throw Object.assign(new Error(value.error), { status: response.status });
    return value;
  };
  return { d, home, call, store: d.engine.store };
}

test("only what the person pins is a favorite: syncing a folder adds nothing and stopping it drops its pins", async (t) => {
  const { call, store, home, d } = await daemon(t);
  const docs = store.addVolume("documents");
  const photos = store.addVolume("photos");
  assert.deepEqual((await call("/v1/favorites")).favorites, [], "synced folders are not favorites until pinned");
  store.addVolume("music");
  assert.deepEqual((await call("/v1/favorites")).favorites, [], "a folder that starts syncing is not added");
  await call("/v1/favorites", {
    favorites: [
      { folder: photos.id, kind: "folder", target: "", label: "photos" },
      { folder: docs.id, kind: "album", target: "album:x", label: "X" },
    ],
  });
  await call("/v1/unselect", { id: photos.id });
  assert.deepEqual((await call("/v1/favorites")).favorites.map((item) => item.label), ["X"]);
  store.db.prepare("UPDATE volumes SET selected=1 WHERE id=?").run(photos.id);
  assert.deepEqual((await call("/v1/favorites")).favorites.map((item) => item.label), ["X"], "syncing it again does not bring it back");
  const saved = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8")).favorites;
  assert.deepEqual(Object.keys(saved), ["items"], "favorites live in this device's own config with no folder bookkeeping");
  d.engine.config.favorites = { ...saved, known: [docs.id, photos.id, "gone"] };
  assert.deepEqual((await call("/v1/favorites")).favorites.map((item) => item.label), ["X"]);
  assert.equal(d.engine.config.favorites.known, undefined, "a stored known list is ignored and not written back");
});

test("favorites save the person's order, removals and pins, refuse duplicates and need the local administrator", async (t) => {
  const { call, store, d } = await daemon(t);
  const docs = store.addVolume("documents");
  const music = store.addVolume("music");
  const pins = [
    { folder: music.id, kind: "album", target: "album:kind of blue", label: "Kind of Blue" },
    { folder: docs.id, kind: "folder", target: "", label: "documents" },
  ];
  const saved = await call("/v1/favorites", { favorites: pins });
  assert.deepEqual(saved.favorites.map((item) => item.label), ["Kind of Blue", "documents"]);
  assert.deepEqual((await call("/v1/favorites")).favorites.map((item) => item.label), ["Kind of Blue", "documents"], "a removed folder favorite stays removed");
  await assert.rejects(call("/v1/favorites", { favorites: [...pins, pins[0]] }), { status: 409, message: "Already in Favorites" });
  for (const bad of [
    { folder: docs.id, kind: "path", target: "../outside", label: "x" },
    { folder: docs.id, kind: "path", target: "/abs", label: "x" },
    { folder: docs.id, kind: "path", target: "a\\b", label: "x" },
    { folder: docs.id, kind: "folder", target: "sub", label: "x" },
    { folder: docs.id, kind: "search", target: "q", label: "x" },
  ])
    await assert.rejects(call("/v1/favorites", { favorites: [bad] }), { status: 400 }, JSON.stringify(bad));
  await assert.rejects(call("/v1/favorites", { favorites: [{ folder: "missing", kind: "folder", target: "", label: "x" }] }), { status: 404 });
  const token = "replica-token";
  d.engine.store.db
    .prepare("INSERT INTO devices(id,name,role,token_hash) VALUES(?,?,?,?)")
    .run("phone", "phone", "replica", (await import("node:crypto")).createHash("sha256").update(token).digest("hex"));
  await assert.rejects(call("/v1/favorites", undefined, token), { status: 403 });
});

test("a pinned sub-folder is removed when its last file disappears from the index", async (t) => {
  const { call, store } = await daemon(t);
  const docs = store.addVolume("documents");
  const row = (name, deleted = 0) =>
    store.db
      .prepare("INSERT OR REPLACE INTO files(volume,path,hash,size,rev,deleted,directory,path_key) VALUES(?,?,?,?,?,?,0,?)")
      .run(docs.id, name, deleted ? null : "h", 1, 1, deleted, name.toLowerCase());
  row("clients/acme/invoices/2026.pdf");
  row("notes.md");
  await call("/v1/favorites");
  const pinned = await call("/v1/favorites", {
    favorites: [
      { folder: docs.id, kind: "folder", target: "", label: "documents" },
      { folder: docs.id, kind: "path", target: "clients/acme/invoices", label: "invoices" },
      { folder: docs.id, kind: "path", target: "clients/acme/invoices-old", label: "old" },
    ],
  });
  assert.deepEqual(pinned.favorites.map((item) => item.label), ["documents", "invoices"], "a target that is not in the folder is never kept");
  row("clients/acme/invoices/2026.pdf", 1);
  assert.deepEqual((await call("/v1/favorites")).favorites.map((item) => item.label), ["documents"]);
});

test("a replica keeps a pinned path until its folder has finished a first synchronization", async (t) => {
  const { call, store } = await daemon(t);
  const docs = store.addVolume("documents");
  store.db
    .prepare("INSERT INTO files(volume,path,hash,size,rev,deleted,directory,path_key) VALUES(?,?,?,?,?,0,0,?)")
    .run(docs.id, "notes.md", "h", 1, 1, "notes.md");
  store.config.role = "replica";
  const pin = { folder: docs.id, kind: "path", target: "clients/acme", label: "acme" };
  assert.deepEqual((await call("/v1/favorites", { favorites: [pin] })).favorites.map((item) => item.label), ["acme"]);
  assert.deepEqual((await call("/v1/favorites")).favorites.map((item) => item.label), ["acme"], "files not indexed yet never remove a pin");
  assert.deepEqual(store.config.favorites.items.map((item) => item.label), ["acme"]);
  store.db.prepare("UPDATE volumes SET last_sync=? WHERE id=?").run(new Date().toISOString(), docs.id);
  assert.deepEqual((await call("/v1/favorites")).favorites, [], "once the folder is in sync a missing path is gone");
});
