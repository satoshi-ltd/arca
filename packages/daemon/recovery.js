import fs from "node:fs";
import path from "node:path";
import { Store, init, hashFile, fail } from "./storage.js";

// Operates offline and creates a NEW hub. Never edits the backup or existing hub.
export function recoverBackup(sourceHome, targetHome) {
  if (fs.existsSync(path.join(sourceHome, "daemon.lock")))
    fail("Stop the backup daemon before recovering");
  if (fs.existsSync(targetHome)) fail("Recovery target must not exist");
  const source = new Store(sourceHome);
  let target;
  try {
    if (source.config.role !== "backup") fail("Source is not a backup");
    const history = source.db
      .prepare("SELECT row FROM backup_history ORDER BY rev")
      .all()
      .map((r) => JSON.parse(r.row));
    if (!history.length) fail("Backup has no archived versions");
    const latest = new Map();
    const rows = [
      ...history.map((row) => ({ row, damaged: false })),
      ...source.db
        .prepare("SELECT row FROM backup_damaged")
        .all()
        .map((r) => ({ row: JSON.parse(r.row), damaged: true })),
    ];
    for (const entry of rows) {
      const key = JSON.stringify([entry.row.volume, entry.row.path]);
      if (!latest.has(key) || latest.get(key).row.rev < entry.row.rev) latest.set(key, entry);
    }
    const lost = [...latest.values()].filter((entry) => entry.damaged && !entry.row.deleted && entry.row.hash);
    const lostHashes = [...new Set(lost.map((entry) => entry.row.hash.slice(0, 12)))].sort();
    if (lost.length)
      fail(
        `The latest version of ${lost.length === 1 ? "1 file" : `${lost.length} files`} is damaged or missing in this backup (${lostHashes.slice(0, 3).join(", ")}${lostHashes.length > 3 ? ", …" : ""}); recovering would bring back older versions.`,
      );
    const skipped = [
      ...new Set(rows.filter((entry) => entry.damaged && entry.row.hash).map((entry) => entry.row.hash.slice(0, 12))),
    ].sort();
    init(targetHome, { role: "hub", name: "Recovered Arca" });
    target = new Store(targetHome);
    const names = new Set();
    for (const v of source.volumes()) {
      const name = names.has(v.name.toLowerCase())
        ? `${v.name} (${v.id.slice(0, 8)})`
        : v.name;
      names.add(name.toLowerCase());
      target.addVolume(name, null, v.id);
    }
    for (const row of history) {
      if (row.hash && !fs.existsSync(target.blob(row.hash)))
        fs.copyFileSync(source.blob(row.hash), target.blob(row.hash));
      target.db
        .prepare(
          "INSERT INTO revisions(rev,volume,path,hash,size,deleted,author,created,directory) VALUES(?,?,?,?,?,?,?,?,?)",
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
          Number(!!row.directory),
        );
      target.setFile(row);
    }
    for (const v of target.volumes())
      for (const row of target.rows(v.id).filter((r) => !r.deleted)) {
        target.queue(row, null);
        target.materialize(row, null);
      }
    return {
      home: path.resolve(targetHome),
      revisions: history.length,
      volumes: target.volumes().length,
      damagedOlderVersions: skipped,
      note: "New hub identity. Connect fresh replica state directories; old copies are untouched.",
    };
  } finally {
    source.close();
    target?.close();
  }
}
