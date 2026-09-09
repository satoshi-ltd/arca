import crypto from "node:crypto";
import { fail } from "./storage.js";
export function snapshotPage(
  store,
  owner,
  volume,
  { session, after = "", limit = 500 },
) {
  const db = store.db;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
    fail("Page limit must be between 1 and 1000");
  if (!session) {
    db.prepare(
      "DELETE FROM snapshot_files WHERE session IN (SELECT id FROM snapshot_sessions WHERE expires<?)",
    ).run(Date.now());
    db.prepare("DELETE FROM snapshot_sessions WHERE expires<?").run(Date.now());
    if (
      db
        .prepare("SELECT COUNT(*) AS n FROM snapshot_sessions WHERE owner=?")
        .get(owner).n >= 8
    )
      fail("Too many active snapshots; retry after snapshots expire", 429);
    session = crypto.randomUUID();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("INSERT INTO snapshot_sessions VALUES(?,?,?,?)").run(
        session,
        owner,
        volume,
        Date.now() + 600000,
      );
      db.prepare(
        `INSERT INTO snapshot_files(session,path,hash,row) SELECT ?,path,hash,json_object('volume',volume,'path',path,'hash',hash,'size',size,'deleted',deleted,'rev',rev,'directory',directory,'replacementPath',(SELECT next.path FROM files next WHERE files.deleted=1 AND next.volume=files.volume AND next.path_key=files.path_key AND next.path<>files.path AND next.deleted=0 AND next.rev>files.rev LIMIT 1)) FROM files WHERE volume=?`,
      ).run(session, volume);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  const active = db
    .prepare(
      "SELECT * FROM snapshot_sessions WHERE id=? AND owner=? AND volume=? AND expires>?",
    )
    .get(session, owner, volume, Date.now());
  if (!active) fail("Snapshot expired. Restart synchronization.", 409);
  const rows = db
    .prepare(
      "SELECT path,row FROM snapshot_files WHERE session=? AND path>? ORDER BY path LIMIT ?",
    )
    .all(session, after, limit + 1);
  const files = rows.slice(0, limit).map((r) => JSON.parse(r.row)),
    next = rows.length > limit ? rows[limit - 1].path : null;
  // Keep the lease until expiry, including after the final page, to support retry and content downloads.
  const total = db
    .prepare("SELECT COUNT(*) AS n FROM snapshot_files WHERE session=?")
    .get(session).n;
  return { files, next, session, total };
}
