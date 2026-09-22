import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { init, Store, digest } from "../packages/daemon/storage.js";
import { snapshotPage, snapshotRows } from "../packages/daemon/snapshots.js";
import {
  applyRetention,
  applyFolderRetention,
} from "../packages/daemon/maintenance.js";

test("large snapshots resolve tombstones by path without revision-range scans", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-snapshot-plan-"));
  init(home, { role: "hub" });
  const store = new Store(home);
  t.after(() => {
    store.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const volume = store.addVolume("Documents").id;
  const put = (name, deleted, rev, directory = false) =>
    store.setFile({
      volume,
      path: name,
      deleted,
      rev,
      directory,
      hash: null,
      size: 0,
    });
  store.db.exec("BEGIN");
  for (let i = 0; i < 4000; i++) {
    const suffix = String(i).padStart(4, "0");
    put(`entry-${suffix}`, 1, i + 1);
    put(`ENTRY-${suffix}`, 0, i + 4001, true);
  }
  put("removed", 1, 9000);
  put("older", 1, 9001);
  put("OLDER", 0, 8999);
  store.db.exec("COMMIT");

  const prepare = store.db.prepare.bind(store.db);
  let replacementPlan;
  t.mock.method(store.db, "prepare", (sql) => {
    assert.doesNotMatch(sql, /COUNT\(\*\).*snapshot_files/i);
    if (sql.startsWith("SELECT path,hash,json_object")) {
      replacementPlan = prepare(`EXPLAIN QUERY PLAN ${sql}`).all(volume);
      // Check the access pattern, not wall-clock time, so this regression is
      // deterministic on all three CI operating systems and slower machines.
      const lookup = replacementPlan.find((row) =>
        row.detail.includes("SEARCH next"),
      );
      assert.match(lookup?.detail || "", /volume=\? AND path_key=\?/);
    }
    return prepare(sql);
  });

  const first = await snapshotPage(store, "replica", volume, { limit: 500 });
  assert.ok(replacementPlan);
  assert.equal(first.total, 8003);
  const rows = [...first.files];
  let next = first.next;
  while (next) {
    const page = await snapshotPage(store, "replica", volume, {
      session: first.session,
      after: next,
      limit: 1000,
    });
    rows.push(...page.files);
    next = page.next;
  }
  assert.equal(rows.length, first.total);
  for (const row of rows) {
    if (row.path.startsWith("entry-"))
      assert.equal(row.replacementPath, row.path.toUpperCase());
    else assert.equal(row.replacementPath, null);
  }
  assert.ok(rows.find((row) => row.path === "ENTRY-0000").directory);
});

test("snapshot batches yield, retain captured revisions and clean up cancellation", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-snapshot-batches-"));
  init(home, { role: "hub" });
  const store = new Store(home);
  t.after(() => {
    store.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const volume = store.addVolume("Documents").id;
  store.db.exec("BEGIN");
  for (let i = 0; i < 1500; i++)
    store.setFile({
      volume,
      path: `file-${i}`,
      hash: null,
      size: 0,
      deleted: 0,
      rev: i + 1,
    });
  store.db.exec("COMMIT");
  let yielded = false;
  const pending = snapshotPage(store, "replica", volume, { limit: 1000 });
  setImmediate(() => {
    yielded = true;
    store.setFile({
      volume,
      path: "file-0",
      hash: null,
      size: 0,
      deleted: 1,
      rev: 2000,
    });
  });
  const page = await pending;
  assert.equal(yielded, true);
  assert.equal(page.files.find((row) => row.path === "file-0").deleted, 0);
  assert.equal(store.current(volume, "file-0").deleted, 1);

  const controller = new AbortController();
  const cancelled = snapshotPage(store, "cancelled-owner", volume, {
    signal: controller.signal,
  });
  setImmediate(() => controller.abort());
  await assert.rejects(cancelled, /cancelled/);
  assert.equal(
    store.db
      .prepare("SELECT count(*) n FROM snapshot_sessions WHERE owner=?")
      .get("cancelled-owner").n,
    0,
  );
  assert.equal(
    store.db
      .prepare(
        "SELECT count(*) n FROM snapshot_files WHERE session NOT IN (SELECT id FROM snapshot_sessions)",
      )
      .get().n,
    0,
  );

  await assert.rejects(
    snapshotPage(store, "revoked-owner", volume, {
      readRows: () => {
        const rows = snapshotRows(store.db, volume);
        store.db
          .prepare("DELETE FROM snapshot_sessions WHERE owner=?")
          .run("revoked-owner");
        return rows;
      },
    }),
    /expired/,
  );
  assert.equal(
    store.db
      .prepare(
        "SELECT count(*) n FROM snapshot_files WHERE session NOT IN (SELECT id FROM snapshot_sessions)",
      )
      .get().n,
    0,
  );
});

test("conflict summaries only visit conflict entries and keep resolution semantics", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-conflict-index-"));
  init(home, { role: "hub" });
  const store = new Store(home);
  t.after(() => {
    store.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const volume = store.addVolume("Documents").id;
  const put = (name, rev, deleted = 0) =>
    store.setFile({ volume, path: name, hash: null, size: 0, deleted, rev });
  store.db.exec("BEGIN");
  for (let i = 0; i < 4000; i++) put(`ordinary-${i}`, i + 1);
  const name = "note.conflict-device.txt";
  put(name, 4001);
  store.db.exec("COMMIT");
  const prepare = store.db.prepare.bind(store.db);
  t.mock.method(store.db, "prepare", (sql) => {
    if (sql.includes("instr(") && /SELECT (count|COALESCE)/i.test(sql))
      assert.ok(
        prepare(`EXPLAIN QUERY PLAN ${sql}`)
          .all(volume)
          .some((row) => row.detail.includes("files_conflict_rev")),
      );
    return prepare(sql);
  });
  assert.equal(store.unresolvedConflicts(volume), 1);
  assert.equal(store.conflictRevision(volume), 4001);
  prepare("INSERT INTO conflict_resolutions VALUES(?,?,?,?,?)").run(
    volume,
    name,
    4001,
    4002,
    "keep",
  );
  assert.equal(store.unresolvedConflicts(volume), 0);
  put(name, 4003);
  assert.equal(store.unresolvedConflicts(volume), 1);
  put(name, 4004, 1);
  assert.equal(store.unresolvedConflicts(volume), 0);
  assert.equal(store.conflictRevision(volume), 4004);
});

test("retention preserves captured content until asynchronous snapshot pins are durable", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-snapshot-gc-"));
  init(home, { role: "hub" });
  const store = new Store(home);
  t.after(() => {
    store.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const volume = store.addVolume("Documents").id;
  const hash = digest("captured bytes");
  const object = store.blob(hash);
  fs.writeFileSync(object, "captured bytes");
  const old = new Date(Date.now() - 48 * 3600000);
  fs.utimesSync(object, old, old);
  store.setFile({
    volume,
    path: "old.txt",
    hash,
    size: 14,
    deleted: 0,
    rev: 1,
  });
  const page = await snapshotPage(store, "device", volume, {
    readRows: () => {
      const rows = snapshotRows(store.db, volume);
      store.db.prepare("DELETE FROM files WHERE volume=?").run(volume);
      assert.equal(applyRetention(store, { versions: 1 }).objectsRemoved, 0);
      assert.ok(
        fs.existsSync(object),
        "GC must preserve hashes not pinned yet",
      );
      return rows;
    },
  });
  assert.equal(store.snapshotBuilds, 0);
  assert.equal(page.files[0].hash, hash);
  assert.equal(applyRetention(store, { versions: 1 }).objectsRemoved, 0);
  store.db
    .prepare("DELETE FROM snapshot_files WHERE session=?")
    .run(page.session);
  store.db
    .prepare("DELETE FROM snapshot_sessions WHERE id=?")
    .run(page.session);
  assert.equal(applyRetention(store, { versions: 1 }).objectsRemoved, 1);
});

test("cold folder totals yield and invalidate captured counts after concurrent edits", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-totals-yield-"));
  init(home, { role: "hub" });
  const store = new Store(home);
  t.after(() => {
    store.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const volume = store.addVolume("Documents");
  const plan = store.db
    .prepare(
      "EXPLAIN QUERY PLAN SELECT path,size FROM files WHERE volume=? AND deleted=0 AND directory=0",
    )
    .all(volume.id);
  assert.ok(plan.some((row) => row.detail.includes("files_visible_totals")));
  fs.writeFileSync(path.join(volume.path, ".arcaignore"), "hidden*\n");
  const put = (name, deleted = 0) =>
    store.setFile({
      volume: volume.id,
      path: name,
      hash: null,
      size: 1,
      deleted,
      rev: 1,
    });
  store.db.exec("BEGIN");
  for (let i = 0; i < 1500; i++) put(`visible-${i}`);
  put("hidden-file");
  put(".obsidian/cache");
  store.db.exec("COMMIT");
  let yielded = false;
  const first = store.allVisibleTotals();
  setImmediate(() => {
    yielded = true;
    put("visible-0", 1);
  });
  assert.deepEqual((await first).get(volume.id), { files: 1500, bytes: 1500 });
  assert.equal(yielded, true);
  assert.deepEqual((await store.allVisibleTotals()).get(volume.id), {
    files: 1499,
    bytes: 1499,
  });
  fs.writeFileSync(path.join(volume.path, ".arcaignore"), "");
  assert.deepEqual((await store.allVisibleTotals()).get(volume.id), {
    files: 1500,
    bytes: 1500,
  });
});

test("retention changes preserve sync tombstones and snapshot counts across restart", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-retention-counts-"));
  init(home, { role: "hub" });
  let store = new Store(home);
  t.after(() => {
    store.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const folder = store.addVolume("Short history", undefined, undefined, false);
  const other = store.addVolume("Forever", undefined, undefined, false);
  for (const text of ["old", "new"]) {
    for (const v of [folder, other])
      fs.writeFileSync(path.join(v.path, "file"), text);
    store.scanHub();
  }
  fs.unlinkSync(path.join(folder.path, "file"));
  store.scanHub();
  const tombstone = store.current(folder.id, "file");
  const first = await snapshotPage(store, "replica", folder.id, {});
  assert.equal(first.total, 1, "history versions are not sync entries");
  assert.equal(first.files[0].deleted, 1);
  assert.deepEqual(store.visibleTotals(folder.id), { files: 0, bytes: 0 });
  assert.deepEqual(store.visibleTotals(other.id), { files: 1, bytes: 3 });
  store.config.folderRetention = { [folder.id]: "off", [other.id]: "forever" };
  applyFolderRetention(store);
  assert.equal(store.history(folder.id, "file").length, 1);
  assert.equal(store.history(other.id, "file").length, 2);
  assert.deepEqual(store.current(folder.id, "file"), tombstone);
  store.config.folderRetention[folder.id] = "forever";
  applyFolderRetention(store);
  assert.equal(
    store.history(folder.id, "file").length,
    1,
    "Forever cannot resurrect pruned history",
  );
  store.close();
  store = new Store(home);
  const prepare = store.db.prepare.bind(store.db);
  t.mock.method(store.db, "prepare", (sql) => {
    assert.doesNotMatch(
      sql,
      /COUNT\(\*\).*snapshot_files/i,
      "pagination must not recount the snapshot",
    );
    return prepare(sql);
  });
  const page = await snapshotPage(store, "replica", folder.id, {
    session: first.session,
  });
  assert.deepEqual(page, first);
  assert.deepEqual((await store.allVisibleTotals()).get(folder.id), {
    files: 0,
    bytes: 0,
  });
});

test("existing snapshot leases gain durable counts when the store upgrades", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-snapshot-upgrade-"));
  init(home, { role: "hub" });
  let store = new Store(home);
  t.after(() => {
    store.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const volume = store.addVolume("Documents").id;
  store.setFile({
    volume,
    path: "deleted",
    hash: null,
    size: 0,
    deleted: 1,
    rev: 1,
  });
  const first = await snapshotPage(store, "replica", volume, {});
  store.db.exec("ALTER TABLE snapshot_sessions DROP COLUMN total");
  store.close();
  store = new Store(home);
  assert.deepEqual(
    await snapshotPage(store, "replica", volume, { session: first.session }),
    first,
  );
});


test("snapshot worker releases SQLite before reporting completion", async (t) => {
  const { Scanner } = await import("../packages/daemon/scanner.js");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-snapshot-handles-"));
  init(home, { role: "hub" });
  const store = new Store(home);
  const scanner = new Scanner(home);
  let closed = false;
  t.after(() => {
    scanner.close();
    if (!closed) store.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const volume = store.addVolume("Documents").id;
  store.setFile({ volume, path: "entry", hash: null, size: 0, deleted: 1, rev: 1 });
  assert.equal((await scanner.snapshot(volume)).length, 1);
  store.close();
  closed = true;
  // No delay/retry: Windows must allow moving the index as soon as work completes.
  fs.renameSync(path.join(home, "index.sqlite"), path.join(home, "moved.sqlite"));
  assert.ok(fs.existsSync(path.join(home, "moved.sqlite")));
});
