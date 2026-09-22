import fs from "node:fs";
import path from "node:path";
import { fail } from "./storage.js";

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
  // Validate without creating files, then verify a private staging copy.
  s.addVolume(v.name, destination, id, false, true);
  const sourceScan = s.scan(v);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const staging = fs.mkdtempSync(
    path.join(path.dirname(destination), ".arca-move-"),
  );
  try {
    fs.cpSync(v.path, staging, { recursive: true, force: false });
    const copied = s.scan({ ...v, path: fs.realpathSync(staging) });
    const after = s.scan(v);
    const same = (a, b) =>
      a.size === b.size &&
      [...a].every(
        ([key, val]) =>
          b.get(key)?.hash === val.hash &&
          b.get(key)?.directory === val.directory,
      );
    if (!same(sourceScan, copied) || !same(sourceScan, after))
      fail(
        "Files changed during relocation. Original mapping retained; retry the move.",
        409,
      );
    if (fs.existsSync(destination))
      fail(
        "Destination was created during relocation; original mapping retained",
        409,
      );
    fs.renameSync(staging, destination);
  } finally {
    if (fs.existsSync(staging))
      fs.rmSync(staging, { recursive: true, force: true });
  }
  s.db.prepare("UPDATE volumes SET path=? WHERE id=?").run(destination, id);
  return { ...s.volume(id), originalRetained: v.path };
}

export function retentionPlan(
  store,
  { days = 0, versions = 0, volume = null } = {},
) {
  if (volume !== null) store.volume(volume);
  if (
    !Number.isSafeInteger(days) ||
    days < 0 ||
    !Number.isSafeInteger(versions) ||
    versions < 0
  )
    fail("Retention values must be non-negative integers");
  const revisions = volume
    ? store.db.prepare("SELECT rev,volume,path,created FROM revisions WHERE volume=? ORDER BY rev DESC").all(volume)
    : store.db.prepare("SELECT rev,volume,path,created FROM revisions ORDER BY rev DESC").all();
  const pinned = new Set(
    (volume
      ? store.db.prepare("SELECT rev FROM files WHERE volume=?").all(volume)
      : store.db.prepare("SELECT rev FROM files").all())
      .map((r) => r.rev),
  );
  for (const p of store.db.prepare("SELECT row FROM pending").all()) {
    const row = JSON.parse(p.row);
    if (!volume || row.volume === volume) pinned.add(row.rev);
  }
  const floor = store.db
    .prepare(
      "SELECT MIN(a.revision) AS n FROM backup_ack a JOIN devices d ON d.id=a.device WHERE a.enabled=1 AND d.revoked=0",
    )
    .get().n;
  const counts = new Map(),
    newerDates = new Map(),
    remove = [];
  const folders = (volume ? [store.volume(volume)] : store.volumes()).map((v) => ({
    id: v.id, name: v.name, remove: 0, retained: 0,
  }));
  const byFolder = new Map(folders.map((folder) => [folder.id, folder]));
  let protectedCount = 0;
  const cutoff = Date.now() - days * 86400000;
  for (const r of revisions) {
    const key = JSON.stringify([r.volume, r.path]);
    const count = (counts.get(key) || 0) + 1;
    counts.set(key, count);
    const ageFrom = volume ? newerDates.get(key) : r.created;
    newerDates.set(key, r.created);
    const protectedRevision = pinned.has(r.rev) || (floor !== null && r.rev > floor);
    if (protectedRevision) protectedCount++;
    const removable = (
      (!volume || r.volume === volume) &&
      (floor === null || r.rev <= floor) &&
      !pinned.has(r.rev) &&
      (days || versions) &&
      (!days || Date.parse(ageFrom) < cutoff) &&
      (!versions || count > versions)
    );
    if (removable) remove.push(r.rev);
    const folder = byFolder.get(r.volume);
    if (folder) folder[removable ? "remove" : "retained"]++;
  }
  return {
    days,
    versions,
    remove,
    retained: revisions.length - remove.length,
    protected: protectedCount,
    folders,
    hasBackup: floor !== null,
  };
}
export function applyRetention(store, options, collect = true, plan = retentionPlan(store, options)) {
  store.db.exec("BEGIN IMMEDIATE");
  try {
    const remove = store.db.prepare("DELETE FROM revisions WHERE rev=?");
    for (const rev of plan.remove) remove.run(rev);
    store.db.exec("COMMIT");
  } catch (e) {
    store.db.exec("ROLLBACK");
    throw e;
  }
  return {
    removed: plan.remove.length,
    retained: plan.retained,
    objectsRemoved: collect ? collectUnusedObjects(store) : 0,
  };
}

function collectUnusedObjects(store) {
  // A worker may have captured old heads whose snapshot pins are still being
  // persisted. History pruning can continue, but content GC must wait for pins.
  if (store.snapshotBuilds) return 0;
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
  if (objectsRemoved) store.db.prepare("DELETE FROM scan_cache").run();
  return objectsRemoved;
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

export function folderRetentionOptions(volume, mode) {
  if (typeof volume !== "string" || !volume) fail("Folder ID is required");
  const days = { off: 0, "1d": 1, "1w": 7, "1m": 30, forever: 0 };
  if (!Object.hasOwn(days, mode)) fail("Invalid history retention");
  return { volume, days: days[mode], versions: mode === "off" ? 1 : 0 };
}
export function applyFolderRetention(store) {
  for (const volume of store.volumes()) {
    const mode = store.config.folderRetention?.[volume.id] || "1m";
    if (mode !== "forever")
      applyRetention(store, folderRetentionOptions(volume.id, mode), false);
  }
  // Orphans still age out after switching every folder to Forever.
  collectUnusedObjects(store);
}
