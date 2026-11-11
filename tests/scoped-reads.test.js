import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store, init } from "../packages/daemon/storage.js";

function folder(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-scoped-"));
  init(home, { name: "hub", role: "hub", port: 0 });
  const store = new Store(home);
  t.after(() => {
    store.close();
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const v = store.addVolume("Documents");
  let rev = 0;
  const index = (name, extra = {}) =>
    store.setFile({ volume: v.id, path: name, hash: "a".repeat(64), size: 1, deleted: 0, rev: ++rev, directory: 0, ...extra });
  return { store, v, index };
}

function watched(store) {
  const prepare = store.db.prepare.bind(store.db);
  const log = [];
  store.db.prepare = (sql) => {
    const statement = prepare(sql);
    const counted = (method, count) => (...args) => {
      const answer = statement[method](...args);
      log.push({ sql, rows: count(answer) });
      return answer;
    };
    return new Proxy(statement, {
      get(target, key) {
        if (key === "all") return counted("all", (rows) => rows.length);
        if (key === "get") return counted("get", (row) => (row ? 1 : 0));
        if (key === "run") return counted("run", () => 0);
        const value = target[key];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
  const onFiles = () => log.filter(({ sql }) => /\b(FROM|INTO) (files|local_files)\b/.test(sql));
  const plans = () =>
    [...new Set(onFiles().map(({ sql }) => sql))].map((sql) => ({
      sql,
      plan: prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all(...Array.from({ length: (sql.match(/\?/g) || []).length }, () => "x"))
        .map((row) => row.detail),
    }));
  return { log, onFiles, plans };
}

test("scoped index reads, a scoped scan's lookups and the local-view delete each search the index by path, never the whole folder", (t) => {
  const { store, v, index } = folder(t);
  fs.mkdirSync(path.join(v.path, "sub"));
  fs.writeFileSync(path.join(v.path, "sub", "one.txt"), "one");
  index("sub/one.txt");
  const seen = watched(store);
  store.rowsInScope(v.id, ["sub"]);
  store.scan(v, ["sub"]);
  store.clearLocal(v.id, ["sub"]);
  const plans = seen.plans();
  const keyed = plans.filter(({ sql }) => sql.includes("path_key"));
  assert.deepEqual(
    keyed.map(({ sql }) => sql.match(/^(SELECT|DELETE)[^?]*?(FROM \w+)/).slice(1).join(" ")).sort(),
    ["DELETE FROM local_files", "DELETE FROM local_files", "SELECT FROM files", "SELECT FROM files", "SELECT FROM files", "SELECT FROM files"],
    "both reads, both name lookups and both deletes ran",
  );
  for (const { sql, plan } of plans) {
    assert.ok(plan.length, sql);
    for (const step of plan)
      assert.match(step, /^SEARCH \w+ USING (COVERING )?INDEX \S+ \(volume=\? AND (path_key|path)[=<>]/, `${sql} → ${step}`);
  }
});

test("a one-path scan in a folder of 5,000 files reads a handful of index rows", (t) => {
  const { store, v, index } = folder(t);
  store.db.exec("BEGIN");
  for (let n = 0; n < 5000; n++) index(`bulk/${String(n).padStart(4, "0")}.txt`);
  store.db.exec("COMMIT");
  fs.mkdirSync(path.join(v.path, "sub"));
  fs.writeFileSync(path.join(v.path, "sub", "one.txt"), "one");
  index("sub", { directory: 1, hash: null, size: 0 });
  index("sub/one.txt");
  const seen = watched(store);
  const known = store.rowsInScope(v.id, ["sub/one.txt"]);
  const disk = store.scan(v, ["sub/one.txt"]);
  assert.deepEqual(known.map((row) => row.path), ["sub/one.txt"]);
  assert.deepEqual([...disk.keys()], ["sub/one.txt"]);
  const rows = seen.onFiles().reduce((sum, entry) => sum + entry.rows, 0);
  assert.ok(rows <= 10, `${rows} index rows read`);
});

test("a scope takes the path and everything below it, whatever its letter case, and nothing beside it", (t) => {
  const { store, v, index } = folder(t);
  for (const name of [
    "Dir",
    "Dir/a.txt",
    "Dir/Deep/b.txt",
    "Dir.txt",
    "Dir0",
    "Dir 2/c.txt",
    "dirt/d.txt",
    "100%/e.txt",
    "100x/f.txt",
    "under_score/g.txt",
    "underXscore/h.txt",
    "Ünïcode/i.txt",
  ])
    index(name);
  const scope = (name) =>
    store
      .rowsInScope(v.id, [name])
      .map((row) => row.path)
      .sort();
  assert.deepEqual(scope("dir"), ["Dir", "Dir/Deep/b.txt", "Dir/a.txt"]);
  assert.deepEqual(scope("DIR/deep"), ["Dir/Deep/b.txt"]);
  assert.deepEqual(scope("100%"), ["100%/e.txt"]);
  assert.deepEqual(scope("under_score"), ["under_score/g.txt"]);
  assert.deepEqual(scope("Ünïcode"), ["Ünïcode/i.txt"]);
  assert.deepEqual(scope("ÜNÏCODE"), [], "only ASCII letters fold, as a scope always matched");
  assert.deepEqual(scope("missing"), []);
  assert.deepEqual(
    store
      .rowsInScope(v.id, ["dir", "Dir/a.txt", "dirt"])
      .map((row) => row.path)
      .sort(),
    ["Dir", "Dir/Deep/b.txt", "Dir/a.txt", "dirt/d.txt"],
    "overlapping scopes give each row once",
  );
});

test("clearing a scope's local view removes the path and what is below it only", (t) => {
  const { store, v } = folder(t);
  const local = store.db.prepare(
    "INSERT INTO local_files(volume,path,hash,size,deleted,rev,directory,path_key) VALUES(?,?,?,?,?,?,?,?)",
  );
  for (const name of ["Dir", "Dir/a.txt", "Dir.txt", "Dir0", "100%/e.txt", "100x/f.txt", "Ünï/g.txt"])
    local.run(v.id, name, null, 0, 0, 0, 0, name.toLowerCase());
  const left = () =>
    store.db
      .prepare("SELECT path FROM local_files WHERE volume=? ORDER BY path")
      .all(v.id)
      .map((row) => row.path);
  store.clearLocal(v.id, ["dir", "100%", "ÜNÏ"]);
  assert.deepEqual(left(), ["100x/f.txt", "Dir.txt", "Dir0", "Ünï/g.txt"]);
  store.clearLocal(v.id);
  assert.deepEqual(left(), []);
});

test("a partial scan still stops on a name that differs only by letter case from one indexed outside it", (t) => {
  const { store, v, index } = folder(t);
  fs.mkdirSync(path.join(v.path, "album"));
  fs.writeFileSync(path.join(v.path, "album", "new.jpg"), "new");
  index("Album/a.jpg");
  store.hasExactPath = () => true;
  assert.throws(() => store.scan(v, ["album"]), /"Album" and "album" differ only by letter case/, "a directory known only through the files below it");
  index("Notes.txt");
  fs.writeFileSync(path.join(v.path, "notes.txt"), "lower");
  assert.throws(() => store.scan(v, ["notes.txt"]), /"Notes\.txt" and "notes\.txt" differ only by letter case/);
  index("Top/Inner/a.jpg");
  fs.mkdirSync(path.join(v.path, "Top", "inner"), { recursive: true });
  assert.throws(() => store.scan(v, ["Top/inner"]), /"Top\/Inner" and "Top\/inner" differ only by letter case/, "a nested name keeps its own depth");
  index("Gone/x.txt", { deleted: 1, hash: null, size: 0 });
  fs.mkdirSync(path.join(v.path, "gone"));
  assert.deepEqual([...store.scan(v, ["gone"]).keys()], ["gone"], "names that live only in tombstones do not collide");
});
