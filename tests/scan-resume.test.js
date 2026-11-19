import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { init, Store } from "../packages/daemon/storage.js";
import { Scanner } from "../packages/daemon/scanner.js";

test("a scan interrupted part way keeps the hashes it computed and the next scan re-hashes none of them", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-scan-resume-"));
  init(home, { name: "replica", role: "replica", port: 0 });
  const store = new Store(home);
  const scanner = new Scanner(home);
  const db = new DatabaseSync(path.join(home, "index.sqlite"), { readOnly: true });
  t.after(() => {
    db.close();
    scanner.close();
    store.close();
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const v = store.addVolume("Documents");
  for (let i = 0; i < 3000; i++) fs.writeFileSync(path.join(v.path, `file-${i}.txt`), `content ${i}`);
  const cached = () => db.prepare("SELECT path,verified FROM scan_cache").all();
  let settled = false;
  const scan = scanner.scan(v).finally(() => (settled = true));
  while (!settled && cached().length < 256) await new Promise((resolve) => setTimeout(resolve, 2));
  scanner.interrupt();
  await assert.rejects(scan, (error) => error.syncInterrupted);
  const kept = cached();
  assert.ok(kept.length >= 256, `${kept.length} hashes kept`);
  const disk = await scanner.scan(v);
  assert.equal(disk.size, 3000);
  const after = new Map(cached().map((row) => [row.path, row.verified]));
  assert.equal(after.size, 3000);
  assert.deepEqual(
    kept.filter((row) => after.get(row.path) !== row.verified).map((row) => row.path),
    [],
    "no kept hash was computed again",
  );
});

test("a batch the scan cache cannot write yet stays queued, and the scan goes on", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-scan-busy-"));
  init(home, { name: "replica", role: "replica", port: 0 });
  const store = new Store(home);
  t.after(() => {
    store.close();
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const v = store.addVolume("Documents");
  for (let i = 0; i < 300; i++) fs.writeFileSync(path.join(v.path, `file-${i}.txt`), `content ${i}`);
  store.scanCacheWrites = [];
  const write = store.writeScanCache.bind(store);
  let busy = true;
  store.writeScanCache = (entries) => {
    if (busy && entries.length) {
      busy = false;
      throw Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR", errcode: 5 });
    }
    return write(entries);
  };
  assert.equal(store.scan(v).size, 300);
  store.flushScanCache();
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM scan_cache").get().n, 300);
});
