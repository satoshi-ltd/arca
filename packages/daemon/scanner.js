import { Worker } from "node:worker_threads";
export class Scanner {
  constructor(home) {
    this.home = home;
    this.sequence = 0;
    this.pending = new Map();
    this.workers = { full: null, scoped: null };
  }
  scan(volume, paths = null, skipUnreadable = false, staged = false) {
    return this.request({ volume, paths, skipUnreadable, staged });
  }
  snapshot(volume) {
    return this.request({ operation: "snapshot", volume });
  }
  request(message) {
    // Full scans get their own worker so a scoped scan, such as a proposal's, never waits behind one.
    const slot = !message.operation && message.paths === null ? "full" : "scoped";
    if (!this.workers[slot]) {
      const worker = new Worker(
        new URL("./scanner-worker.js", import.meta.url),
        { workerData: { home: this.home }, execArgv: [] },
      );
      this.workers[slot] = worker;
      worker.on("message", (m) => {
        const job = this.pending.get(m.id);
        if (!job) return;
        this.pending.delete(m.id);
        if (![...this.pending.values()].some((p) => p.worker === worker)) worker.unref();
        if (m.error)
          job.reject(
            Object.assign(new Error(m.error), {
              status: m.status,
              code: m.code,
              syncInterrupted: m.syncInterrupted,
            }),
          );
        else if (m.rows) job.resolve(m.rows);
        else
          job.resolve(
            Object.assign(new Map(m.entries), { unreadable: new Map(m.unreadable) }),
          );
      });
      const failed = (e) => {
        if (this.workers[slot] !== worker) return;
        for (const [id, p] of this.pending)
          if (p.worker === worker) {
            p.reject(e);
            this.pending.delete(id);
          }
        this.workers[slot] = null;
      };
      worker.on("error", failed);
      worker.on("exit", (code) =>
        failed(new Error(`Scanner exited (${code})`)),
      );
    }
    const worker = this.workers[slot];
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const cancellation = new Int32Array(new SharedArrayBuffer(4));
      this.pending.set(id, { resolve, reject, cancellation, worker });
      worker.ref();
      worker.postMessage({ id, ...message, cancellation });
    });
  }
  interrupt() {
    for (const job of this.pending.values())
      Atomics.store(job.cancellation, 0, 1);
  }
  close() {
    for (const job of this.pending.values())
      job.reject(new Error("Scanner closed"));
    this.pending.clear();
    for (const slot of Object.keys(this.workers)) {
      this.workers[slot]?.terminate();
      this.workers[slot] = null;
    }
  }
}
