import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { init } from "../packages/daemon/storage.js";
import { start } from "../packages/daemon/server.js";
import { applyRetention } from "../packages/daemon/maintenance.js";

async function hub(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-status-"));
  init(home, { name: "hub", role: "hub", port: 0 });
  const daemon = await start(home, { timer: false });
  t.after(async () => {
    await daemon.close();
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const store = daemon.engine.store;
  const v = store.addVolume("Documents");
  const write = (name, content) => fs.writeFileSync(path.join(v.path, name), content);
  const sync = () => daemon.engine.exclusive(() => daemon.engine.cycle());
  const folder = () => daemon.engine.status().volumes.find((row) => row.id === v.id);
  return { daemon, store, v, write, sync, folder };
}

function statements(t, store) {
  const prepare = store.db.prepare.bind(store.db);
  const seen = [];
  store.db.prepare = (sql) => {
    seen.push(sql);
    return prepare(sql);
  };
  t.after(() => (store.db.prepare = prepare));
  return {
    seen,
    plan: (sql, ...values) => prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...values).map((row) => row.detail),
  };
}

const COUNTING = /count\(\*\) AS files|COUNT\(\*\) FROM revisions|COUNT\(\*\) AS count FROM backup_history/;

test("a second status call with nothing changed counts nothing, and its conflict lookups use the conflict index", async (t) => {
  const f = await hub(t);
  for (const name of ["a.txt", "b.txt", "c.txt"]) f.write(name, name);
  await f.sync();
  assert.deepEqual([f.folder().files, f.folder().bytes], [3, 15]);
  const watch = statements(t, f.store);
  const status = f.daemon.engine.status();
  assert.deepEqual([status.volumes[0].files, status.volumes[0].bytes, status.historyRevisions], [3, 15, 0]);
  assert.deepEqual(watch.seen.filter((sql) => COUNTING.test(sql)), []);
  for (const sql of watch.seen.filter((sql) => /\.conflict-/.test(sql)))
    for (const step of watch.plan(sql, f.v.id)) assert.match(step, /files_conflict_rev|sqlite_autoindex_conflict_resolutions/, `${sql} → ${step}`);
});

test("a commit, an older version and retention each show in the next status", async (t) => {
  const f = await hub(t);
  f.write("a.txt", "one");
  await f.sync();
  assert.deepEqual([f.folder().files, f.folder().bytes, f.daemon.engine.status().historyRevisions], [1, 3, 0]);
  f.write("b.txt", "second");
  await f.sync();
  assert.deepEqual([f.folder().files, f.folder().bytes], [2, 9]);
  f.write("a.txt", "one, edited");
  await f.sync();
  assert.deepEqual([f.folder().files, f.folder().bytes, f.daemon.engine.status().historyRevisions], [2, 17, 1]);
  fs.rmSync(path.join(f.v.path, "b.txt"));
  await f.sync();
  assert.deepEqual([f.folder().files, f.folder().bytes], [1, 11]);
  const before = f.daemon.engine.status().historyRevisions;
  assert.ok(before >= 2);
  applyRetention(f.store, { versions: 1 }, false);
  const kept = f.daemon.engine.status().historyRevisions;
  assert.ok(kept < before, "pruned versions leave the count");
  const rules = f.store.visibleRules;
  f.store.visibleRules = () => (name) => name === "a.txt";
  assert.equal(f.store.forgetExcluded(f.v.id), 1);
  f.store.visibleRules = rules;
  assert.equal(f.daemon.engine.status().historyRevisions, kept + 1, "the last version of a file dropped from the index counts as an older one");
});

test("stopping backup answers with the backup state alone, without building a status", async (t) => {
  const f = await hub(t);
  f.write("a.txt", "one");
  await f.sync();
  const engine = f.daemon.engine;
  Object.assign(engine.config, { role: "replica", hub: "http://127.0.0.1:9" });
  engine.hubAction = async () => {
    throw new Error("offline");
  };
  const watch = statements(t, f.store);
  const answer = await engine.configureBackup(false);
  assert.deepEqual(
    watch.seen.filter((sql) => COUNTING.test(sql) || /FROM (devices|files|files_view|revisions)\b/.test(sql)),
    [],
  );
  assert.deepEqual(answer, engine.status().backup);
  assert.equal(answer.enabled, false);
  assert.match(answer.error, /hub acknowledgement pending: offline/);
});

test("the backup history count follows every row written, replaced and removed, and is not recounted in between", async (t) => {
  const f = await hub(t);
  const truth = () => f.store.db.prepare("SELECT COUNT(*) AS count FROM backup_history").get().count;
  const put = f.store.db.prepare("INSERT OR REPLACE INTO backup_history(rev,row) VALUES(?,?)");
  assert.equal(f.store.backupRevisions(), 0);
  put.run(1, "{}");
  assert.equal(f.store.backupRevisions(), 1);
  put.run(1, '{"again":1}');
  put.run(2, "{}");
  assert.equal(f.store.backupRevisions(), 2);
  const watch = statements(t, f.store);
  assert.equal(f.store.backupRevisions(), 2);
  assert.deepEqual(watch.seen.filter((sql) => COUNTING.test(sql)), []);
  f.store.db.prepare("DELETE FROM backup_history WHERE rev=?").run(1);
  assert.equal(f.store.backupRevisions(), 1);
  f.store.db.exec("DELETE FROM backup_history");
  assert.deepEqual([f.store.backupRevisions(), truth()], [0, 0]);
});

test("an erased installation set up again never shows the erased counts, even with the same folder ID and counters", async (t) => {
  const f = await hub(t);
  const engine = f.daemon.engine;
  for (const content of ["one", "one, edited", "one, edited twice"]) {
    f.write("a.txt", content);
    await f.sync();
  }
  assert.deepEqual([f.folder().files, f.folder().bytes, engine.status().historyRevisions], [1, 17, 2]);
  const counters = ["file_generations", "row_generations"].map((table) => [table, f.store.db.prepare(`SELECT * FROM ${table}`).all()]);
  await engine.destroyHub();
  Object.assign(engine.config, { role: "hub", needsSetup: false, name: "again" });
  f.store.saveConfig();
  const v = f.store.addVolume("Fresh", undefined, f.v.id);
  for (const n of [1, 2, 3]) fs.writeFileSync(path.join(v.path, `new-${n}.txt`), "x".repeat(n));
  await f.sync();
  for (const [table, rows] of counters) {
    f.store.db.exec(`DELETE FROM ${table}`);
    for (const row of rows)
      f.store.db
        .prepare(`INSERT INTO ${table}(${Object.keys(row).join(",")}) VALUES(${Object.keys(row).fill("?").join(",")})`)
        .run(...Object.values(row));
  }
  const status = engine.status();
  const fresh = status.volumes.find((row) => row.id === v.id);
  assert.deepEqual([fresh.files, fresh.bytes, status.historyRevisions], [3, 6, 0]);
});
