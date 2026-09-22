import { parentPort, workerData } from "node:worker_threads";
import { Store } from "./storage.js";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { snapshotRows } from "./snapshots.js";
parentPort.on("message", ({ id, operation, volume, paths, cancellation }) => {
  if (operation === "snapshot") {
    let db, result;
    try {
      // A read-only connection captures one consistent SQLite read snapshot.
      // Never hold a write lock in this worker: HTTP handlers also use SQLite.
      db = new DatabaseSync(path.join(workerData.home, "index.sqlite"), {
        readOnly: true,
      });
      result = { id, rows: snapshotRows(db, volume) };
    } catch (error) {
      result = { id, error: error.message, status: error.status };
    } finally {
      db?.close();
    }
    // Completion must mean the SQLite handle is closed, including on Windows.
    parentPort.postMessage(result);
    return;
  }
  let store, result;
  try {
    store = new Store(workerData.home);
    store.scanCacheWrites = [];
    const checkpoint = () => {
      if (cancellation && Atomics.load(cancellation, 0))
        throw Object.assign(new Error("Synchronization stopped"), {
          syncInterrupted: true,
        });
    };
    checkpoint();
    result = { id, entries: [...store.scan(volume, paths, checkpoint)] };
    checkpoint();
    store.db.exec("BEGIN IMMEDIATE");
    try {
      const insert = store.db.prepare(
        "INSERT OR REPLACE INTO scan_cache VALUES(?,?,?,?,?)",
      );
      for (const entry of store.scanCacheWrites) insert.run(...entry);
      store.db.exec("COMMIT");
    } catch (e) {
      store.db.exec("ROLLBACK");
      throw e;
    }
  } catch (e) {
    result = {
      id,
      error: e.message,
      status: e.status,
      code: e.code,
      syncInterrupted: e.syncInterrupted,
    };
  } finally {
    store?.close();
  }
  parentPort.postMessage(result);
});
