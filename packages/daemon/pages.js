import { fail } from "./storage.js";
export function listPage(store, volume, query, name) {
  const limit = Number(query.get("limit") || 100),
    history = name !== undefined;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
    fail("Page limit must be between 1 and 1000");
  let rows;
  if (history) {
    const before = Number(query.get("before") || Number.MAX_SAFE_INTEGER);
    if (!Number.isSafeInteger(before) || before < 1)
      fail("Invalid history cursor");
    rows = store.db
      .prepare(
        "SELECT * FROM revisions WHERE volume=? AND path=? AND rev<? ORDER BY rev DESC LIMIT ?",
      )
      .all(volume, name, before, limit + 1);
  } else
    rows = store.db
      .prepare(
        "SELECT * FROM files WHERE volume=? AND path>? ORDER BY path LIMIT ?",
      )
      .all(volume, query.get("after") || "", limit + 1);
  return {
    [history ? "versions" : "files"]: rows.slice(0, limit),
    next:
      rows.length > limit
        ? history
          ? rows[limit - 1].rev
          : rows[limit - 1].path
        : null,
  };
}
