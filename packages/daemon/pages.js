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
        `SELECT * FROM ${store.fileSource()} WHERE volume=? AND path>? ORDER BY path LIMIT ?`,
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

// Browse the index plus this replica's own scanned changes, never arbitrary paths on the host filesystem.
export function browsePage(store, volume, query) {
  const prefix = query.get("prefix") || "";
  const after = query.get("after") || "";
  const limit = Number(query.get("limit") || 100);
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 200 ||
    prefix.length > 1024
  )
    fail("Invalid browse request");
  const base = prefix ? prefix.replace(/\/$/, "") + "/" : "";
  const rows = store.db
    .prepare(
      `
    WITH source AS (
      SELECT *, substr(path, ?) AS relative FROM ${store.fileSource()}
      WHERE volume=? AND deleted=0 ${base ? "AND path>=? AND path<?" : ""}
    ), entries AS (
      SELECT CASE WHEN instr(relative,'/')>0
        THEN substr(relative,1,instr(relative,'/')-1) ELSE relative END AS name,
        CASE WHEN directory=1 OR instr(relative,'/')>0 THEN 1 ELSE 0 END AS directory,
        CASE WHEN directory=1 THEN 0 ELSE 1 END AS file_count, size, rev, hash
      FROM source WHERE relative<>''
    )
    SELECT name, directory, sum(file_count) AS files, sum(size) AS size, max(rev) AS rev, max(hash) AS hash
    FROM entries GROUP BY name, directory
    HAVING (CASE WHEN directory=1 THEN '0:' ELSE '1:' END || name)>?
    ORDER BY directory DESC, name LIMIT ?
  `,
    )
    .all(
      Array.from(base).length + 1,
      volume,
      ...(base ? [base, base.slice(0, -1) + "0"] : []),
      after,
      limit + 1,
    );
  return {
    entries: rows
      .slice(0, limit)
      .map(({ hash, ...row }) => ({
        ...row,
        ...(row.directory ? {} : { hash }),
        path: base + row.name,
      })),
    next:
      rows.length > limit
        ? `${rows[limit - 1].directory ? "0:" : "1:"}${rows[limit - 1].name}`
        : null,
  };
}
