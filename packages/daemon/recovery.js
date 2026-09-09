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
      note: "New hub identity. Connect fresh replica state directories; old copies are untouched.",
    };
  } finally {
    source.close();
    target?.close();
  }
}
