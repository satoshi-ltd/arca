const compact = (item) => ({
  path: item.path,
  hash: item.hash,
  ...(item.rev != null ? { rev: item.rev } : {}),
  size: item.size,
  date: item.date,
  kind: item.kind,
});
// The phone keeps dates and hashes for ordering; photo bytes stay on the hub or in the working copy.
export function hubGallery({ api, store, scope, volume }) {
  const key = `gallery-index:${scope}:${volume}`;
  let current = null;
  let month = "";
  let queue = Promise.resolve();
  const serial = (work) => {
    const result = queue.then(work);
    queue = result.catch(() => {});
    return result;
  };
  const remember = async (state) => {
    current = state;
    // Keep a complete page boundary: truncating rows would skip photos on resume.
    if (month || state.items.length > 2000) return state;
    await store.set(key, state).catch(() => {});
    return state;
  };
  const page = (after) =>
    api(
      `/v1/gallery?${new URLSearchParams({ volume, ...(after ? { after } : month ? { month } : {}) })}`,
    );
  const first = async () => {
    const target = current?.items.length || 0;
    const data = await page();
    const state = {
      items: data.items.map(compact),
      next: data.next,
      total: (data.timeline || []).reduce((sum, month) => sum + month.count, 0),
      indexing: !!data.indexing,
      month,
      timeline: data.timeline || [],
    };
    while (state.next && state.items.length < target) {
      const next = await page(state.next);
      state.items.push(...next.items.map(compact));
      state.next = next.next;
    }
    return remember(state);
  };
  const apiClient = {
    cached: () =>
      serial(async () => {
        if (!current) current = await store.get(key, null).catch(() => null);
        return current;
      }),
    seek: (value) =>
      serial(async () => {
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value))
          throw new Error("Invalid gallery month");
        month = value;
        current = null;
        return first();
      }),
    first: () => serial(first),
    forget: (path) =>
      serial(async () => {
        const state = current || (await store.get(key, null).catch(() => null));
        if (!state) return;
        const items = state.items.filter((item) => item.path !== path);
        return remember({
          ...state,
          items,
          total: Math.max(
            0,
            (state.total || 0) - (state.items.length - items.length),
          ),
        });
      }),
    more: (previous) =>
      serial(async () => {
        const state = current || previous;
        if (!state?.next) return state;
        const data = await page(state.next);
        return remember({
          ...state,
          items: state.items.concat(data.items.map(compact)),
          next: data.next,
        });
      }),
  };
  return apiClient;
}
