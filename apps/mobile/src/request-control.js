// React Native implementations may omit AbortSignal.reason.
const reasons = new WeakMap();
export function abortRequest(controller, reason) {
  if (controller.signal.aborted) return;
  reasons.set(controller.signal, reason);
  controller.abort(reason);
}
export function cancellationReason(signal) {
  return (
    reasons.get(signal) ||
    signal.reason ||
    Object.assign(new Error("Request cancelled"), { code: "REQUEST_CANCELLED" })
  );
}
// Stop waiting without letting a late native response resume cancelled work.
export function abortable(work, signal) {
  if (signal.aborted) return Promise.reject(cancellationReason(signal));
  return new Promise((resolve, reject) => {
    const cancel = () => reject(cancellationReason(signal));
    signal.addEventListener("abort", cancel, { once: true });
    Promise.resolve()
      .then(work)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", cancel));
  });
}
