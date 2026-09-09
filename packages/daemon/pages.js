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
    [history ? "versions" : "files"]: history
      ? rows.slice(0, limit).map((row) => store.conflictStatus(row))
      : rows.slice(0, limit),
    next:
      rows.length > limit
        ? history
          ? rows[limit - 1].rev
          : rows[limit - 1].path
        : null,
  };
}

// Browse the accepted index, never arbitrary paths on the host filesystem.
export function browsePage(store, volume, query) {
  const prefix = query.get("prefix") || "";
  const search = query.get("search") || "";
  const after = query.get("after") || "";
  const limit = Number(query.get("limit") || 100);
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 200 ||
    prefix.length > 1024 ||
    search.length > 256
  )
    fail("Invalid browse request");
  const base = prefix ? prefix.replace(/\/$/, "") + "/" : "";
  const excluded = store.visibleRules?.(volume) || (() => false);
  store.db.function("arca_browse_included", (path, directory) =>
    excluded(path, !!directory) ? 0 : 1,
  );
  const rows = store.db
    .prepare(
      `
    WITH source AS (
      SELECT *, substr(path, ?) AS relative FROM files
      WHERE volume=? AND deleted=0 AND arca_browse_included(path,directory)=1 AND substr(path, 1, ?)=?
    ), entries AS (
      SELECT CASE WHEN ?='' AND instr(relative,'/')>0
        THEN substr(relative,1,instr(relative,'/')-1) ELSE relative END AS name,
        CASE WHEN directory=1 OR (?='' AND instr(relative,'/')>0) THEN 1 ELSE 0 END AS directory,
        CASE WHEN directory=1 THEN 0 ELSE 1 END AS file_count, size, rev
      FROM source WHERE relative<>'' AND (?='' OR instr(lower(relative),lower(?))>0)
    )
    SELECT name, directory, sum(file_count) AS files, sum(size) AS size, max(rev) AS rev
    FROM entries GROUP BY name, directory
    HAVING (CASE WHEN directory=1 THEN '0:' ELSE '1:' END || name)>?
    ORDER BY directory DESC, name LIMIT ?
  `,
    )
    .all(
      Array.from(base).length + 1,
      volume,
      Array.from(base).length,
      base,
      search,
      search,
      search,
      search,
      after,
      limit + 1,
    );
  return {
    entries: rows
      .slice(0, limit)
      .map((row) => ({ ...row, path: base + row.name })),
    next:
      rows.length > limit
        ? `${rows[limit - 1].directory ? "0:" : "1:"}${rows[limit - 1].name}`
        : null,
  };
}
