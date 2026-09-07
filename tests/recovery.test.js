import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { init, Store } from "../packages/daemon/storage.js";
import { recoverBackup } from "../packages/daemon/recovery.js";
import { start } from "../packages/daemon/server.js";

test("restore a fresh hub and its history from an offline backup", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arca-recover-"));
  const sourceHome = path.join(root, "backup");
  const targetHome = path.join(root, "recovered");
  init(sourceHome, { role: "backup" });
  const source = new Store(sourceHome);
  const volume = source.addVolume("Docs");
  fs.writeFileSync(path.join(volume.path, "a"), "archived");
  const item = source.capture(path.join(volume.path, "a"));
  source.db.prepare("INSERT INTO backup_history VALUES(?,?)").run(
    1,
    JSON.stringify({
      rev: 1,
      volume: volume.id,
      path: "a",
      ...item,
      deleted: 0,
      author: "original",
      created: new Date().toISOString(),
    }),
  );
  source.close();
  try {
    const result = recoverBackup(sourceHome, targetHome);
    assert.equal(result.revisions, 1);
    const target = new Store(targetHome);
    assert.equal(
      fs.readFileSync(path.join(target.volume(volume.id).path, "a"), "utf8"),
      "archived",
    );
    assert.equal(target.history(volume.id, "a").length, 1);
    target.close();
    assert.throws(
      () => recoverBackup(sourceHome, targetHome),
      /must not exist/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("restart persists identity and revisions; second daemon refuses the state lock", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-restart-"));
  init(home, { port: 0 });
  let daemon = await start(home, { timer: false });
  try {
    const v = daemon.engine.store.addVolume("Docs");
    fs.writeFileSync(path.join(v.path, "a"), "first");
    await daemon.engine.cycle();
    const id = daemon.engine.config.id;
    await assert.rejects(start(home, { timer: false }), /already owns/);
    await daemon.close();
    daemon = await start(home, { timer: false });
    assert.equal(daemon.engine.config.id, id);
    assert.equal(daemon.engine.store.history(v.id, "a").length, 1);
    await daemon.engine.cycle();
    assert.equal(daemon.engine.store.history(v.id, "a").length, 1);
  } finally {
    await daemon.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("filesystem events detect edits before the periodic fallback deadline", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-watch-"));
  init(home, { port: 0 });
  const s = new Store(home);
  s.config.interval = 60000;
  s.saveConfig();
  const v = s.addVolume("Docs");
  s.close();
  const daemon = await start(home);
  t.after(async () => {
    await daemon.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  for (let i = 0; i < 100 && !daemon.engine.lastSync; i++)
    await new Promise((r) => setTimeout(r, 20));
  assert.ok(daemon.engine.lastSync);
  fs.writeFileSync(path.join(v.path, "watched.txt"), "event");
  for (
    let i = 0;
    i < 200 && !daemon.engine.store.current(v.id, "watched.txt");
    i++
  )
    await new Promise((r) => setTimeout(r, 20));
  assert.ok(daemon.engine.store.current(v.id, "watched.txt"));
});

test("promotion survives configuration-write failure after committed history transition", async () => {
  const { Engine } = await import("../packages/daemon/engine.js");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-promotion-crash-"));
  init(home, { role: "replica", port: 0 });
  let engine = new Engine(home);
  try {
    const v = engine.store.addVolume("Docs");
    fs.writeFileSync(path.join(v.path, "a"), "retained");
    engine.config.hub = {
      id: "lost-hub",
      url: "http://127.0.0.1:1",
      token: "unused",
    };
    engine.config.catalog = [{ id: v.id, name: v.name }];
    engine.store.saveConfig();
    engine.store.db
      .prepare("UPDATE volumes SET last_sync=? WHERE id=?")
      .run(new Date().toISOString(), v.id);
    engine.store.saveConfig = () => {
      throw Error("Injected config write failure");
    };
    await assert.rejects(engine.promote(true), /Injected config write failure/);
    engine.close();
    engine = new Engine(home);
    assert.equal(engine.config.role, "hub");
    assert.equal(engine.config.hub, null);
    assert.equal(engine.store.history(v.id, "a").length, 1);
    assert.equal(fs.readFileSync(path.join(v.path, "a"), "utf8"), "retained");
    assert.equal(fs.existsSync(path.join(home, "promotion.json")), false);
  } finally {
    engine.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("promotion rejects active backup and stale success with errors or pending transfers", async () => {
  const { Engine } = await import("../packages/daemon/engine.js");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-promotion-guards-"));
  init(home, { role: "replica", port: 0 });
  const engine = new Engine(home);
  try {
    const v = engine.store.addVolume("Docs");
    const file = path.join(v.path, "keep.txt");
    fs.writeFileSync(file, "preserve me");
    engine.config.hub = {
      id: "lost",
      url: "http://127.0.0.1:1",
      token: "unused",
    };
    engine.config.catalog = [{ id: v.id, name: v.name }];
    engine.store.db
      .prepare("UPDATE volumes SET last_sync=? WHERE id=?")
      .run("2020-01-01T00:00:00.000Z", v.id);
    assert.equal(
      engine.promotionPlan().catalog[0].lastSync,
      "2020-01-01T00:00:00.000Z",
    );
    engine.config.backup = { enabled: true };
    assert.equal(engine.promotionPlan().ready, false);
    await assert.rejects(engine.promote(true), /Disable hub backup/);
    assert.equal(engine.config.backup.enabled, true);
    engine.config.backup.enabled = false;
    engine.folderStates.set(v.id, { state: "error", error: "Read failed" });
    assert.equal(engine.promotionPlan().ready, false);
    await assert.rejects(engine.promote(true), /complete copies/);
    engine.folderStates.set(v.id, { state: "synced" });
    engine.store.db
      .prepare("INSERT INTO pending(volume,path,row) VALUES(?,?,?)")
      .run(v.id, "keep.txt", "{}");
    assert.equal(engine.promotionPlan().ready, false);
    await assert.rejects(engine.promote(true), /complete copies/);
    assert.equal(engine.config.role, "replica");
    assert.equal(fs.existsSync(path.join(home, "promotion.json")), false);
    assert.equal(fs.readFileSync(file, "utf8"), "preserve me");
    engine.store.db.prepare("DELETE FROM pending").run();
    assert.equal(engine.promotionPlan().ready, true);
  } finally {
    engine.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
