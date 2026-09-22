// One sampler per daemon, regardless of how many clients are waiting.
export class ChangeFeed {
  constructor(read) {
    this.read = read;
    this.waiters = new Set();
  }
  wait(after, signal, duration = 10000) {
    const current = this.read();
    if (current !== after || signal.aborted) return Promise.resolve(current);
    return new Promise((resolve) => {
      let timer;
      const finish = (value) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
        this.waiters.delete(finish);
        if (!this.waiters.size) {
          clearInterval(this.timer);
          this.timer = null;
        }
        resolve(value);
      };
      const cancel = () => finish(current);
      this.waiters.add(finish);
      signal.addEventListener("abort", cancel, { once: true });
      timer = setTimeout(() => finish(this.read()), duration);
      if (!this.timer)
        this.timer = setInterval(() => {
          const next = this.read();
          if (next !== current)
            for (const done of [...this.waiters]) done(next);
        }, 500);
    });
  }
  close() {
    for (const finish of [...this.waiters]) finish(null);
  }
}
