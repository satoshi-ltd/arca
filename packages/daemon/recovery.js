import fs from "node:fs";
import path from "node:path";
import { Store, init, hashFile, fail, validPath } from "./storage.js";

// Operates offline and creates a NEW hub. Never edits the backup or existing hub.
export function recoverBackup(sourceHome, targetHome) {
  if (fs.existsSync(path.join(sourceHome, "daemon.lock")))
    fail("Stop the backup daemon before recovering");
  if (fs.existsSync(targetHome)) fail("Recovery target must not exist");
  const portablePath = path.join(sourceHome, "manifest.json");
  const source = fs.existsSync(portablePath)
    ? portableBackup(sourceHome)
    : new Store(sourceHome);
  let target;
  try {
    if (source.config.role !== "backup") fail("Source is not a backup");
    const history = source.db
      .prepare("SELECT row FROM backup_history ORDER BY rev")
      .all()
      .map((r) => JSON.parse(r.row));
    if (!history.length) fail("Backup has no archived revisions");
    for (const row of history)
      if (
        row.hash &&
        (!fs.existsSync(source.blob(row.hash)) ||
          hashFile(source.blob(row.hash)) !== row.hash)
      )
        fail("Backup object missing or corrupt");
    init(targetHome, { role: "hub", name: "Recovered Arca" });
    target = new Store(targetHome);
    for (const v of source.volumes()) target.addVolume(v.name, null, v.id);
    for (const row of history) {
      if (row.hash && !fs.existsSync(target.blob(row.hash)))
        fs.copyFileSync(source.blob(row.hash), target.blob(row.hash));
      target.db
        .prepare(
          "INSERT INTO revisions(rev,volume,path,hash,size,deleted,author,created) VALUES(?,?,?,?,?,?,?,?)",
        )
        .run(
          row.rev,
          row.volume,
          row.path,
          row.hash,
          row.size,
          row.deleted,
          row.author,
          row.created,
        );
      target.setFile(row);
    }
    for (const v of target.volumes())
      for (const row of target.rows(v.id)) {
        target.queue(row, null);
        target.materialize(row, null);
      }
    return {
      home: path.resolve(targetHome),
      revisions: history.length,
      volumes: target.volumes().length,
      note: "New hub identity. Connect fresh replica state directories; old copies are untouched.",
    };
  } finally {
    source.close();
    target?.close();
  }
}

// Mobile exports retained history and immutable objects without depending on a
// platform-specific SQLite layout. Validate the whole archive before init.
function portableBackup(home) {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(home, "manifest.json"), "utf8"),
  );
  if (
    manifest.format !== "arca-portable-backup" ||
    manifest.version !== 1 ||
    !Number.isSafeInteger(manifest.through) ||
    manifest.through < 0 ||
    manifest.history !== `revisions-${manifest.through}.ndjson` ||
    !Array.isArray(manifest.volumes)
  )
    fail("Invalid portable backup manifest");
  const ids = new Set();
  for (const volume of manifest.volumes) {
    if (
      !/^[a-f0-9-]{36}$/.test(volume.id) ||
      ids.has(volume.id) ||
      typeof volume.name !== "string" ||
      !volume.name.trim()
    )
      fail("Invalid backup folder");
    ids.add(volume.id);
  }
  const rows = fs
    .readFileSync(path.join(home, manifest.history), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  let previous = 0;
  for (const row of rows) {
    validPath(row.path);
    if (
      !ids.has(row.volume) ||
      !Number.isSafeInteger(row.rev) ||
      row.rev <= previous ||
      row.rev > manifest.through ||
      !Number.isSafeInteger(row.size) ||
      row.size < 0 ||
      ![0, 1].includes(row.deleted) ||
      (row.hash !== null && !/^[a-f0-9]{64}$/.test(row.hash)) ||
      (!row.deleted && !row.hash) ||
      typeof row.author !== "string" ||
      typeof row.created !== "string" ||
      !Number.isFinite(Date.parse(row.created))
    )
      fail("Invalid portable backup revision");
    previous = row.rev;
  }
  return {
    config: { role: "backup" },
    db: {
      prepare: () => ({
        all: () => rows.map((row) => ({ row: JSON.stringify(row) })),
      }),
    },
    volumes: () => manifest.volumes,
    blob: (hash) => path.join(home, "objects", hash),
    close() {},
  };
}
