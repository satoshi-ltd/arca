// Bounded metadata only. A saved view is never authority to restore a revision.
export function cachedActivity(store, hub, query) {
  const filter = query.get("filter") || "revisions";
  const saved = store.db
    .prepare(
      "SELECT value,updated FROM history_views WHERE hub=? AND volume=? AND filter=?",
    )
    .get(hub, query.get("volume"), filter);
  if (!saved) return { versions: [], next: null };
  const before = Number(query.get("before") || Number.MAX_SAFE_INTEGER);
  const limit = Number(query.get("limit") || 50);
  const rows = JSON.parse(saved.value).versions.filter(
    (row) => row.rev < before,
  );
  return {
    savedAt: saved.updated,
    versions: rows.slice(0, limit),
    next: rows.length > limit ? rows[limit - 1].rev : null,
  };
}

// A file's rows live in two windows (its content and its deletions); only their shared range, at one folder version, is hole-free.
export function cachedFileHistory(
  store,
  hub,
  volume,
  path,
  before = Number.MAX_SAFE_INTEGER,
) {
  const saved = store.db
    .prepare(
      "SELECT filter,version,value,updated FROM history_views WHERE hub=? AND volume=?",
    )
    .all(hub, volume)
    .map((view) => ({ ...view, page: JSON.parse(view.value) }));
  const savedAt = Math.max(0, ...saved.map((view) => view.updated));
  const unusable = { savedAt, versions: [], truncated: saved.length > 0 };
  const conflict = path.includes(".conflict-");
  const windows = [conflict ? "conflicts" : "revisions", "deleted"].map((kind) =>
    saved.find((entry) => entry.filter === kind),
  );
  if (windows.some((view) => !view) || windows[0].version !== windows[1].version)
    return unusable;
  let floor = 0;
  let partial = false;
  for (const view of windows)
    if (view.page.next !== null) {
      partial = true;
      floor = Math.max(floor, view.page.versions.at(-1)?.rev ?? Infinity);
    }
  const rows = new Map();
  for (const view of windows)
    for (const row of view.page.versions)
      if (row.path === path && row.rev >= floor && row.rev < before)
        rows.set(row.rev, row);
  const versions = [...rows.values()].sort((a, b) => b.rev - a.rev);
  if (conflict && versions[0]?.deleted) return unusable;
  return { savedAt, versions, truncated: partial };
}

export async function warmHistory(engine) {
  const { store, config } = engine;
  if (config.role !== "replica" || !config.hub) return;
  const hub = config.hub.id;
  const folders = store
    .volumes()
    .filter((v) => v.selected && config.catalog?.some((r) => r.id === v.id));
  // One shared deadline bounds optional work across every folder and filter.
  const signal = AbortSignal.any([
    engine.syncAbort.signal,
    AbortSignal.timeout(3000),
  ]);
  store.db
    .prepare(
      "DELETE FROM history_views WHERE hub<>? OR volume NOT IN (SELECT id FROM volumes WHERE selected=1)",
    )
    .run(hub);
  for (const folder of folders) {
    const remote = config.catalog.find((v) => v.id === folder.id);
    const generation =
      store.db
        .prepare("SELECT generation FROM file_generations WHERE volume=?")
        .get(folder.id)?.generation || 0;
    const version = JSON.stringify([
      generation,
      remote.historyRetention,
      remote.conflictRevision,
    ]);
    const pages = [];
    for (const filter of ["revisions", "deleted", "conflicts"]) {
      const saved = store.db
        .prepare(
          "SELECT version,updated FROM history_views WHERE hub=? AND volume=? AND filter=?",
        )
        .get(hub, folder.id, filter);
      if (saved?.version === version && Date.now() - saved.updated < 3600000)
        continue;
      try {
        const query = new URLSearchParams({
          volume: folder.id,
          filter,
          limit: "50",
        });
        const response = await engine.request(`/v1/activity?${query}`, {
          signal,
          trackConnection: false,
        });
        pages.push([filter, JSON.stringify(await response.json())]);
      } catch {
        return;
      } // Optional history must not fail a completed file sync.
    }
    if (!pages.length || signal.aborted || config.hub?.id !== hub) return;
    const write = store.db.prepare(
      "INSERT OR REPLACE INTO history_views VALUES(?,?,?,?,?,?)",
    );
    try {
      store.db.exec("BEGIN IMMEDIATE");
      for (const [filter, value] of pages)
        write.run(hub, folder.id, filter, version, Date.now(), value);
      store.db.exec("COMMIT");
    } catch {
      try {
        store.db.exec("ROLLBACK");
      } catch {
        /* No transaction to roll back when BEGIN itself failed. */
      }
    }
  }
}
