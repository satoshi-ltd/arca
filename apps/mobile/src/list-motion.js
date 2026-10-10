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

export function createLeaving(keyOf) {
  let last = [];
  const gone = new Map();
  return {
    rows(items) {
      const present = new Set(items.map(keyOf));
      if (items !== last) {
        last.forEach((item, index) => {
          const key = keyOf(item);
          if (!present.has(key) && !gone.has(key)) gone.set(key, { item, index });
        });
        last = items;
      }
      for (const key of [...gone.keys()]) if (present.has(key)) gone.delete(key);
      const list = items.map((item) => ({ item, key: keyOf(item), leaving: false }));
      for (const [key, { item, index }] of gone) list.splice(Math.min(index, list.length), 0, { item, key, leaving: true });
      return list;
    },
    left(key) {
      return gone.delete(key);
    },
  };
}
