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
        const value = await response.json();
        if (signal.aborted || config.hub?.id !== hub) return;
        store.db
          .prepare("INSERT OR REPLACE INTO history_views VALUES(?,?,?,?,?,?)")
          .run(
            hub,
            folder.id,
            filter,
            version,
            Date.now(),
            JSON.stringify(value),
          );
      } catch {
        return;
      } // Optional history must not fail a completed file sync.
    }
  }
}
