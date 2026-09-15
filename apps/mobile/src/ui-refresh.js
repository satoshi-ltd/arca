// Coalesce progress events without overlapping storage reads or starving updates.
export function coalescedRefresh(read) {
  let active = null;
  let pending = false;
  return () => {
    pending = true;
    if (!active) {
      active = (async () => {
        do {
          pending = false;
          await read();
        } while (pending);
      })().finally(() => {
        active = null;
      });
    }
    return active;
  };
}

// Native/runtime objects may be mutated in place; retain an independent snapshot.
export function retainSnapshot(previous, next) {
  const encoded = JSON.stringify(next);
  return JSON.stringify(previous) === encoded ? previous : JSON.parse(encoded);
}
