// Stop waiting without letting a late native response resume cancelled work.
export function abortable(work, signal) {
  if (signal.aborted) return Promise.reject(signal.reason || new Error("Request cancelled"));
  return new Promise((resolve, reject) => {
    const cancel = () => reject(signal.reason || new Error("Request cancelled"));
    signal.addEventListener("abort", cancel, { once: true });
    Promise.resolve().then(work).then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
  });
}
