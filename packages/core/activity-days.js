export function parseActivityDays(params) {
  const days = Number(params.get("days") || 30);
  const offset = Number(params.get("offset") || 0);
  const since = params.get("since");
  if (
    !Number.isSafeInteger(days) ||
    days < 1 ||
    days > 90 ||
    !Number.isSafeInteger(offset) ||
    Math.abs(offset) > 840 ||
    (since !== null && Number.isNaN(Date.parse(since)))
  )
    throw Object.assign(new Error("Invalid activity range"), { status: 400 });
  return {
    days,
    offset,
    since: since === null ? null : new Date(since).toISOString(),
  };
}

export function activityDays(db, volumes, { days, offset, since }, now = Date.now()) {
  if (!volumes.length) return { days: [], ...(since ? { since: { changes: 0, devices: {} } } : {}) };
  const marks = volumes.map(() => "?").join(",");
  const shift = `${-offset >= 0 ? "+" : "-"}${Math.abs(offset)} minutes`;
  const first = new Date(now - (days + 1) * 86400000).toISOString();
  const rows = db
    .prepare(
      `SELECT date(created,?) AS day, author, deleted, instr(path,'.conflict-')>0 AS conflict, COUNT(*) AS n FROM revisions WHERE directory=0 AND volume IN (${marks}) AND created>=? GROUP BY day, author, deleted, conflict`,
    )
    .all(shift, ...volumes, first);
  const today = new Date(now - offset * 60000).toISOString().slice(0, 10);
  const oldest = new Date(Date.parse(today) - (days - 1) * 86400000)
    .toISOString()
    .slice(0, 10);
  const byDay = new Map();
  for (const row of rows) {
    if (row.day < oldest || row.day > today) continue;
    const entry = byDay.get(row.day) || { day: row.day, changes: 0, deleted: 0, conflicts: 0, devices: {} };
    entry.changes += row.n;
    if (row.deleted) entry.deleted += row.n;
    if (row.conflict) entry.conflicts += row.n;
    entry.devices[row.author] = (entry.devices[row.author] || 0) + row.n;
    byDay.set(row.day, entry);
  }
  const result = { days: [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1)) };
  if (since) {
    const devices = {};
    let changes = 0;
    for (const row of db
      .prepare(
        `SELECT author, COUNT(*) AS n FROM revisions WHERE directory=0 AND volume IN (${marks}) AND created>? GROUP BY author`,
      )
      .all(...volumes, since)) {
      devices[row.author] = row.n;
      changes += row.n;
    }
    result.since = { changes, devices };
  }
  return result;
}
