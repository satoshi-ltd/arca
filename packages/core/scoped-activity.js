// A retained local copy may outlive its share on the hub.
export function historyFolderIds(localFolders, sharedFolders) {
  const shared = new Set(sharedFolders.map((folder) => folder.id));
  return localFolders
    .filter((folder) => folder.selected && shared.has(folder.id))
    .map((folder) => folder.id);
}

// Each source is filtered by the hub before pagination; merge using its global revision cursor.
export async function scopedActivity(fetchPage, selected, query) {
  const ids = [...new Set(selected)];
  const volume = query.get("volume");
  if (volume && !ids.includes(volume))
    throw new Error("Select this folder to view its history.");
  const limit = Number(query.get("limit") || 50);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new Error("Invalid activity limit");
  const pages = [];
  for (const id of volume ? [volume] : ids) {
    const scoped = new URLSearchParams(query);
    scoped.set("volume", id);
    scoped.set("limit", String(limit));
    pages.push(await fetchPage(scoped));
  }
  const rows = pages
    .flatMap((page) => page.versions)
    .sort((a, b) => b.rev - a.rev);
  const versions = rows.slice(0, limit);
  return {
    ...(pages.some((page) => page.offline) ? { offline: true } : {}),
    versions,
    next:
      versions.length &&
      (rows.length > limit || pages.some((page) => page.next))
        ? versions.at(-1).rev
        : null,
  };
}
