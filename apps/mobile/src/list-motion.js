export const RISE_LIMIT = 6;

export function createListMotion() {
  let seen = null;
  let signature = null;
  const pending = new Map();
  return {
    note(ids) {
      const key = ids.join("\u0000");
      if (key === signature) return;
      signature = key;
      if (!ids.length) return;
      if (!seen) {
        ids.slice(0, RISE_LIMIT).forEach((id, index) => pending.set(id, { mode: "cascade", index }));
      } else {
        const fresh = ids.filter((id) => !seen.has(id));
        if (fresh.length && fresh.length <= RISE_LIMIT)
          fresh.forEach((id) => pending.set(id, { mode: "arrival", index: 0 }));
      }
      seen = new Set(ids);
    },
    take(id) {
      const entry = pending.get(id);
      pending.delete(id);
      return entry;
    },
  };
}
