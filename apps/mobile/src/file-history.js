export function offlineFileHistory(page, saved, localEntry) {
  const versions = page.versions || [];
  const own = saved && !saved.deleted ? saved : null;
  if (!page.offline || !own || !localEntry || versions[0]?.rev >= own.rev)
    return { versions, currentRev: own ? own.rev : versions[0]?.rev };
  return {
    versions: [
      {
        rev: own.rev,
        size: localEntry.size ?? own.size,
        created: localEntry.mtime
          ? new Date(localEntry.mtime).toISOString()
          : null,
        deleted: false,
        local: true,
      },
      ...versions,
    ],
    currentRev: own.rev,
  };
}
