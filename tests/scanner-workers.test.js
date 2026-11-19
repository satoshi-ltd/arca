import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { init, Store } from "../packages/daemon/storage.js";
import { Scanner } from "../packages/daemon/scanner.js";

test("a scoped scan does not queue behind another folder's full scan", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-scanner-workers-"));
  init(home, { name: "desk", role: "replica", port: 0 });
  const store = new Store(home);
  const scanner = new Scanner(home);
  t.after(() => {
    scanner.close();
    store.close();
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const large = store.addVolume("Photos");
  const small = store.addVolume("Documents");
  for (let i = 0; i < 4000; i++) fs.writeFileSync(path.join(large.path, `photo-${i}.txt`), `photo ${i}`);
  fs.writeFileSync(path.join(small.path, "note.txt"), "note");
  const order = [];
  const full = scanner.scan(large).then(() => order.push("full"));
  const scoped = scanner.scan(small, ["note.txt"]).then(() => order.push("scoped"));
  await Promise.all([full, scoped]);
  assert.deepEqual(order, ["scoped", "full"]);
});
