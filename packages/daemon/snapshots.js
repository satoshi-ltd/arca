import crypto from "node:crypto";
import { fail } from "./storage.js";
export function snapshotRows(db, volume) {
  // Revision-range scans here become quadratic with the number of tombstones.
  return db
    .prepare(
      `SELECT path,hash,json_object('volume',volume,'path',path,'hash',hash,'size',size,'deleted',deleted,'rev',rev,'directory',directory,'replacementPath',(SELECT next.path FROM files next INDEXED BY files_volume_path_key WHERE files.deleted=1 AND next.volume=files.volume AND next.path_key=files.path_key AND next.path<>files.path AND next.deleted=0 AND next.rev>files.rev LIMIT 1)) AS row FROM files WHERE volume=?`,
    )
    .all(volume);
}
export async function snapshotPage(
  store,
  owner,
  volume,
  {
    session,
    after = "",
    limit = 500,
    readRows = () => snapshotRows(store.db, volume),
    signal,
  },
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
    // Reserve capacity before yielding, including concurrent initial requests.
    db.prepare(
      "INSERT INTO snapshot_sessions(id,owner,volume,expires) VALUES(?,?,?,?)",
    ).run(session, owner, volume, Date.now() + 600000);
    store.snapshotBuilds = (store.snapshotBuilds || 0) + 1;
    try {
      const rows = await readRows();
      if (signal?.aborted) throw new Error("Snapshot request cancelled");
      const batchSize = 2000;
      const insertBatch = (count) =>
        db.prepare(
          `INSERT INTO snapshot_files VALUES ${Array(count).fill("(?,?,?,?)").join(",")}`,
        );
      const insert = insertBatch(batchSize);
      for (let offset = 0; offset < rows.length; offset += batchSize) {
        if (signal?.aborted) throw new Error("Snapshot request cancelled");
        if (
          !db
            .prepare("SELECT 1 FROM snapshot_sessions WHERE id=? AND expires>?")
            .get(session, Date.now())
        )
          fail("Snapshot expired. Restart synchronization.", 409);
        // Each short transaction finishes before yielding. Other handlers must
        // never accidentally join a snapshot's transaction on this connection.
        db.exec("BEGIN IMMEDIATE");
        try {
          const batch = rows.slice(offset, offset + batchSize);
          const statement =
            batch.length === batchSize ? insert : insertBatch(batch.length);
          statement.run(
            ...batch.flatMap((row) => [session, row.path, row.hash, row.row]),
          );
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
      if (signal?.aborted) throw new Error("Snapshot request cancelled");
      db.prepare("UPDATE snapshot_sessions SET total=? WHERE id=?").run(
        rows.length,
        session,
      );
    } catch (e) {
      db.prepare("DELETE FROM snapshot_files WHERE session=?").run(session);
      db.prepare("DELETE FROM snapshot_sessions WHERE id=?").run(session);
      throw e;
    } finally {
      store.snapshotBuilds--;
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
  // The immutable count belongs to the lease; recounting each page is quadratic.
  const total = active.total;
  return { files, next, session, total };
}
