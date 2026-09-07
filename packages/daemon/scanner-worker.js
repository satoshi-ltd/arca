import { parentPort, workerData } from "node:worker_threads";
import { Store } from "./storage.js";
parentPort.on("message", ({ id, volume, paths, cancellation }) => {
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
