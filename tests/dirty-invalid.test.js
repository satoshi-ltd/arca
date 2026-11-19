import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { init } from "../packages/daemon/storage.js";
import { start } from "../packages/daemon/server.js";

async function hub(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-dirty-invalid-"));
  init(home, { name: "hub", role: "hub", port: 0 });
  const daemon = await start(home, { timer: false });
  t.after(async () => {
    await daemon.close();
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const engine = daemon.engine;
  const v = engine.store.addVolume("Documents");
  await engine.exclusive(() => engine.cycle());
  const incremental = () => engine.exclusive(() => engine.cycle({ incremental: true }));
  const state = () => engine.status().volumes.find((row) => row.id === v.id).sync;
  return { engine, v, incremental, state };
}

test("a dirty path with an invalid name that no longer exists is dropped, and the folder syncs on the next incremental cycle", async (t) => {
  const { engine, v, incremental, state } = await hub(t);
  fs.writeFileSync(path.join(v.path, "Why not.docx"), "renamed");
  engine.work.mark(v.id, "Why not?.docx");
  engine.work.mark(v.id, "Why not.docx");
  await incremental();
  assert.equal(state().state, "synced");
  assert.equal(engine.store.current(v.id, "Why not.docx")?.deleted, 0);
  assert.equal(engine.store.db.prepare("SELECT count(*) AS n FROM sync_dirty WHERE volume=?").get(v.id).n, 0);
});

test("a dirty path with an invalid name that still exists stops the incremental scan", { skip: process.platform === "win32" ? "Windows cannot create the name" : false }, async (t) => {
  const { engine, v, incremental, state } = await hub(t);
  fs.writeFileSync(path.join(v.path, "Why not?.docx"), "still here");
  engine.work.mark(v.id, "Why not?.docx");
  await incremental().catch(() => {});
  assert.equal(state().state, "error");
  assert.match(state().error, /Unsupported file path/);
});

test("on the hub, an invalid name that was the only dirty path clears its error and leaves no work once it is gone", async (t) => {
  const { engine, v, incremental, state } = await hub(t);
  engine.work.mark(v.id, "Why not?.docx");
  engine.folderStates.set(v.id, { state: "error", error: 'Unsupported file path: "Why not?.docx"' });
  await incremental();
  assert.equal(state().state, "synced");
  assert.equal(engine.store.db.prepare("SELECT count(*) AS n FROM sync_dirty WHERE volume=?").get(v.id).n, 0);
});
