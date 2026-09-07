import fs from "node:fs";
import path from "node:path";
import { fail, hashFile, atomic } from "./storage.js";

export function moveFolder(engine, id, location) {
  const s = engine.store,
    v = s.volume(id),
    destination = s.resolveLocation(location);
  if (!v.path) fail("Folder has no local copy", 409);
  s.assertVolume(v);
  if (destination === v.path) return v;
  if (
    destination.startsWith(v.path + path.sep) ||
    v.path.startsWith(destination + path.sep)
  )
    fail("Original and destination folders cannot overlap", 409);
  if (fs.existsSync(destination))
    fail("Destination must be a new directory", 409);
  // Use the normal overlap/ownership validation before copying.
  s.db.exec("BEGIN IMMEDIATE");
  try {
    s.addVolume(v.name, destination, id);
    s.db.exec("ROLLBACK");
  } catch (e) {
    s.db.exec("ROLLBACK");
    throw e;
  }
  const sourceScan = s.scan(v);
  fs.cpSync(v.path, destination, {
    recursive: true,
    errorOnExist: false,
    force: false,
  });
  const target = { ...v, path: destination };
  const copied = s.scan(target),
    after = s.scan(v);
  const same = (a, b) =>
    a.size === b.size &&
    [...a].every(([key, val]) => b.get(key)?.hash === val.hash);
  if (!same(sourceScan, copied) || !same(sourceScan, after))
    fail(
      "Files changed during relocation. Original mapping retained; inspect the destination copy.",
      409,
    );
  s.db.prepare("UPDATE volumes SET path=? WHERE id=?").run(destination, id);
  return { ...s.volume(id), originalRetained: v.path };
}

export function retentionPlan(store, { days = 0, versions = 0 } = {}) {
  if (
    !Number.isSafeInteger(days) ||
    days < 0 ||
    !Number.isSafeInteger(versions) ||
    versions < 0
  )
    fail("Retention values must be non-negative integers");
  const revisions = store.db
    .prepare("SELECT * FROM revisions ORDER BY rev DESC")
    .all();
  const pinned = new Set(
    store.db
      .prepare("SELECT rev FROM files")
      .all()
      .map((r) => r.rev),
  );
  for (const p of store.db.prepare("SELECT row FROM pending").all())
    pinned.add(JSON.parse(p.row).rev);
  const floor = store.db
    .prepare(
      "SELECT MIN(a.revision) AS n FROM backup_ack a JOIN devices d ON d.id=a.device WHERE a.enabled=1 AND d.revoked=0",
    )
    .get().n;
  const counts = new Map(),
    remove = [];
  const cutoff = Date.now() - days * 86400000;
  for (const r of revisions) {
    const key = JSON.stringify([r.volume, r.path]);
    const count = (counts.get(key) || 0) + 1;
    counts.set(key, count);
    if (
      (floor === null || r.rev <= floor) &&
      !pinned.has(r.rev) &&
      (days || versions) &&
      (!days || Date.parse(r.created) < cutoff) &&
      (!versions || count > versions)
    )
      remove.push(r.rev);
  }
  const removed = new Set(remove);
  const folders = store.volumes().map((v) => {
    const rows = revisions.filter((r) => r.volume === v.id);
    return {
      id: v.id,
      name: v.name,
      remove: rows.filter((r) => removed.has(r.rev)).length,
      retained: rows.filter((r) => !removed.has(r.rev)).length,
    };
  });
  return {
    days,
    versions,
    remove,
    retained: revisions.length - remove.length,
    protected: revisions.filter(
      (r) => pinned.has(r.rev) || (floor !== null && r.rev > floor),
    ).length,
    folders,
    hasBackup: floor !== null,
  };
}
export function applyRetention(store, options) {
  const plan = retentionPlan(store, options);
  store.db.exec("BEGIN IMMEDIATE");
  try {
    const remove = store.db.prepare("DELETE FROM revisions WHERE rev=?");
    for (const rev of plan.remove) remove.run(rev);
    store.db.exec("COMMIT");
  } catch (e) {
    store.db.exec("ROLLBACK");
    throw e;
  }
  // Content GC is conservative: preserve current, historical, backup and pending hashes.
  const hashes = new Set(
    store.db
      .prepare(
        "SELECT f.hash FROM snapshot_files f JOIN snapshot_sessions s ON s.id=f.session WHERE s.expires>? AND f.hash IS NOT NULL",
      )
      .all(Date.now())
      .map((r) => r.hash),
  );
  for (const table of ["files", "revisions"])
    for (const r of store.db
      .prepare(`SELECT hash FROM ${table} WHERE hash IS NOT NULL`)
      .all())
      hashes.add(r.hash);
  for (const table of ["pending", "backup_history"])
    for (const r of store.db.prepare(`SELECT row FROM ${table}`).all()) {
      const row = JSON.parse(r.row);
      if (row.hash) hashes.add(row.hash);
    }
  const cutoff = Date.now() - 24 * 3600000;
  let objectsRemoved = 0;
  for (const name of fs.readdirSync(store.objects))
    if (
      /^[a-f0-9]{64}$/.test(name) &&
      !hashes.has(name) &&
      fs.statSync(path.join(store.objects, name)).mtimeMs < cutoff
    ) {
      fs.unlinkSync(path.join(store.objects, name));
      objectsRemoved++;
    }
  store.db.prepare("DELETE FROM scan_cache").run();
  return {
    removed: plan.remove.length,
    retained: plan.retained,
    objectsRemoved,
  };
}

// This runs between sync cycles, never during an active transfer. Incomplete
// transfers can restart from zero; visible files and historical objects are untouched.
export function cleanupTransfers(store, now = Date.now()) {
  let removed = 0;
  for (const entry of fs.readdirSync(store.uploads, { withFileTypes: true })) {
    if (
      !entry.isFile() ||
      !/^([a-zA-Z0-9-]+\.part|[a-f0-9]{64}\.download)$/.test(entry.name)
    )
      continue;
    const file = path.join(store.uploads, entry.name);
    if (fs.statSync(file).mtimeMs < now - 7 * 86400000) {
      fs.unlinkSync(file);
      removed++;
    }
  }
  return removed;
}
