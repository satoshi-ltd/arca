import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { DatabaseSync } from "node:sqlite";
import { ReplicaStore } from "../apps/mobile/src/replica-store.js";

test("mobile catalog erasure securely deletes rows and truncates its WAL offline", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arca-erase-catalog-"));
  const filename = path.join(root, "arca.sqlite");
  const db = new DatabaseSync(filename);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA secure_delete=OFF");
  t.after(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const adapter = {
    execAsync: async (sql) => db.exec(sql),
    runAsync: async (sql, ...args) => db.prepare(sql).run(...args),
    getFirstAsync: async (sql, ...args) => db.prepare(sql).get(...args),
  };
  const source = fs
    .readFileSync(
      new URL("../apps/mobile/src/persistence.js", import.meta.url),
      "utf8",
    )
    .replace(/^import .*;\n/gm, "")
    .replace("export const client", "const client");
  const client = vm.runInNewContext(`${source}\nclient`, {
    SQLite: { openDatabaseAsync: async () => adapter },
    SecureStore: {},
    resolvePrivateURL() {},
    nativeFetch() {},
    createClient: (options) => options,
  });
  const marker = "private-old-catalog-marker";
  await client.cache.write({ name: marker.repeat(200) });
  assert.ok((await client.cache.read()).name.includes(marker));
  // Simulate free pages left by earlier catalog replacements before erasure.
  await client.cache.write({ name: "current small catalog" });
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  assert.ok(fs.readFileSync(filename).includes(Buffer.from(marker)));
  await client.cache.write(null);
  assert.equal(await client.cache.read(), null);
  assert.equal(db.prepare("SELECT count(*) AS n FROM cache").get().n, 0);
  assert.equal(fs.readFileSync(filename).includes(Buffer.from(marker)), false);
  assert.equal(fs.statSync(`${filename}-wal`).size, 0);
});

test("mobile replica reset removes historical free pages as well as current rows", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arca-erase-store-"));
  const filename = path.join(root, "replica.sqlite");
  const db = new DatabaseSync(filename);
  t.after(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const store = new ReplicaStore({ execAsync: async (sql) => db.exec(sql) });
  await store.init();
  db.exec("PRAGMA secure_delete=OFF");
  const marker = "previous-device-private-history";
  db.prepare("INSERT INTO settings VALUES (?, ?)").run(
    "old",
    marker.repeat(500),
  );
  db.exec("DELETE FROM settings; PRAGMA wal_checkpoint(TRUNCATE)");
  assert.ok(fs.readFileSync(filename).includes(Buffer.from(marker)));
  await store.reset();
  assert.equal(fs.readFileSync(filename).includes(Buffer.from(marker)), false);
});

test("mobile erase keeps its durable journal through database compaction", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arca-erase-journal-"));
  const db = new DatabaseSync(path.join(root, "replica.sqlite"));
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  let compacting = false;
  const store = new ReplicaStore({
    execAsync: async (sql) => {
      if (sql.startsWith("VACUUM")) {
        compacting = true;
        assert.equal(db.prepare("SELECT value FROM settings WHERE key='destroyPending'").get()?.value, "true", "a process exit here must leave a retryable erase");
      }
      db.exec(sql);
    },
  });
  await store.init();
  db.exec("INSERT INTO settings VALUES ('destroyPending','true'); INSERT INTO settings VALUES ('scope','private-hub')");
  await store.reset();
  assert.equal(compacting, true);
  assert.equal(db.prepare("SELECT count(*) AS n FROM settings").get().n, 0);
});
