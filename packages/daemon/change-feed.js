// One sampler per daemon, regardless of how many clients are waiting.
export class ChangeFeed {
  constructor(read) {
    this.read = read;
    this.waiters = new Map();
  }
  wait(after, signal, duration = 10000, moved = () => false) {
    const current = this.read();
    if (current !== after || moved() || signal.aborted) return Promise.resolve(current);
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
      this.waiters.set(finish, { current, moved });
      signal.addEventListener("abort", cancel, { once: true });
      timer = setTimeout(() => finish(this.read()), duration);
      if (!this.timer)
        this.timer = setInterval(() => {
          const next = this.read();
          for (const [done, waiter] of [...this.waiters])
            if (next !== waiter.current || waiter.moved()) done(next);
        }, 500);
    });
  }
  close() {
    for (const finish of [...this.waiters.keys()]) finish(null);
  }
}
