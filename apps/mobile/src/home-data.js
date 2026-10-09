export const ARRIVALS = 3;

export function homeFromActivity(rows, selected) {
  const allowed = new Set(selected);
  const fresh = (rows || []).filter((row) => !row.deleted && allowed.has(row.volume));
  return {
    arrivals: fresh.slice(0, ARRIVALS).map(({ volume, path, rev, created, author }) => ({
      volume,
      path,
      rev,
      created,
      author,
    })),
  };
}
