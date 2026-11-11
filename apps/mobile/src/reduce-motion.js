export function createReduceMotion(info) {
  let value = false;
  let ready = false;
  let heard = false;
  let priming = null;
  const listeners = new Set();
  const notify = () => listeners.forEach((listener) => listener());
  return {
    get: () => value,
    ready: () => ready,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    prime() {
      priming ||= (async () => {
        info.addEventListener("reduceMotionChanged", (next) => {
          heard = true;
          value = !!next;
          notify();
        });
        const first = await Promise.resolve()
          .then(() => info.isReduceMotionEnabled())
          .catch(() => false);
        if (!heard) value = !!first;
        ready = true;
        notify();
      })();
      return priming;
    },
  };
}
