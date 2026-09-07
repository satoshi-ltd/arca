// Persistent local work is acknowledged only after a successful synchronization.
export const RECONCILE_MS = 6 * 60 * 60 * 1000;
export const ACTIVE_POLL_MS = 15000;
export const IDLE_POLL_MS = 60000;
export const IDLE_AFTER_MS = 5 * 60 * 1000;
export function covers(paths, name) {
  return (
    paths === null ||
    paths.some((p) => {
      const a = p.toLowerCase(),
        b = name.toLowerCase();
      return b === a || b.startsWith(a + "/");
    })
  );
}
export class SyncWork {
  constructor(store) {
    this.store = store;
  }
  mark(volume, name = "") {
    // Missing filenames and policy changes require a complete reconciliation.
    if (
      !name ||
      name === ".arcaignore" ||
      name.split("/").some((p) => p === ".." || p === ".")
    )
      name = "";
    if (name.split("/").some((p) => p.startsWith(".arca-"))) return;
    const db = this.store.db;
    if (
      !db.prepare("SELECT 1 FROM volumes WHERE id=? AND selected=1").get(volume)
    )
      return;
    if (
      name &&
      db
        .prepare("SELECT 1 FROM sync_dirty WHERE volume=? AND path='' ")
        .get(volume)
    )
      name = "";
    if (!name) db.prepare("DELETE FROM sync_dirty WHERE volume=?").run(volume);
    db.prepare(
      "INSERT OR REPLACE INTO sync_dirty(volume,path) VALUES(?,?)",
    ).run(volume, name);
    if (
      db.prepare("SELECT COUNT(*) n FROM sync_dirty WHERE volume=?").get(volume)
        .n > 2048
    )
      this.mark(volume);
  }
  state(volume) {
    return (
      this.store.db
        .prepare("SELECT * FROM sync_state WHERE volume=?")
        .get(volume) || { cursor: 0, full_at: 0, policy: null }
    );
  }
  plan(v, incremental = false, paths) {
    const entries = this.store.db
      .prepare("SELECT seq,path FROM sync_dirty WHERE volume=? ORDER BY seq")
      .all(v.id);
    const cutoff = entries.at(-1)?.seq || 0;
    const state = this.state(v.id);
    const full =
      !incremental ||
      !state.full_at ||
      Date.now() - state.full_at >= RECONCILE_MS ||
      entries.some((e) => e.path === "");
    let scope = paths ?? (full ? null : entries.map((e) => e.path));
    if (scope)
      scope = scope.filter(
        (p, i) =>
          !scope.some(
            (other, j) =>
              j !== i && (p.startsWith(other + "/") || (other === p && j < i)),
          ),
      );
    return {
      paths: scope,
      cutoff,
      acknowledge: paths === undefined,
      full: scope === null,
    };
  }
  complete(v, plan) {
    if (!plan.acknowledge) return;
    const db = this.store.db;
    db.prepare("DELETE FROM sync_dirty WHERE volume=? AND seq<=?").run(
      v.id,
      plan.cutoff,
    );
    if (plan.full)
      db.prepare(
        "INSERT INTO sync_state(volume,full_at) VALUES(?,?) ON CONFLICT(volume) DO UPDATE SET full_at=excluded.full_at",
      ).run(v.id, Date.now());
  }
  cursor(volume, cursor) {
    this.store.db
      .prepare(
        "INSERT INTO sync_state(volume,cursor) VALUES(?,?) ON CONFLICT(volume) DO UPDATE SET cursor=excluded.cursor",
      )
      .run(volume, cursor);
  }
}
