import { Worker } from "node:worker_threads";
export class Scanner {
  constructor(home) {
    this.home = home;
    this.sequence = 0;
    this.pending = new Map();
  }
  scan(volume, paths = null) {
    if (!this.worker) {
      const worker = new Worker(
        new URL("./scanner-worker.js", import.meta.url),
        { workerData: { home: this.home }, execArgv: [] },
      );
      this.worker = worker;
      worker.on("message", (m) => {
        const job = this.pending.get(m.id);
        if (!job) return;
        this.pending.delete(m.id);
        if (!this.pending.size) worker.unref();
        if (m.error)
          job.reject(
            Object.assign(new Error(m.error), {
              status: m.status,
              code: m.code,
              syncInterrupted: m.syncInterrupted,
            }),
          );
        else job.resolve(new Map(m.entries));
      });
      const failed = (e) => {
        if (this.worker !== worker) return;
        for (const p of this.pending.values()) p.reject(e);
        this.pending.clear();
        this.worker = null;
      };
      worker.on("error", failed);
      worker.on("exit", (code) =>
        failed(new Error(`Scanner exited (${code})`)),
      );
    }
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const cancellation = new Int32Array(new SharedArrayBuffer(4));
      this.pending.set(id, { resolve, reject, cancellation });
      this.worker.ref();
      this.worker.postMessage({ id, volume, paths, cancellation });
    });
  }
  interrupt() {
    for (const job of this.pending.values())
      Atomics.store(job.cancellation, 0, 1);
  }
  close() {
    this.worker?.terminate();
    this.worker = null;
  }
}
