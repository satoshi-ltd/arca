export function browseEntries(entries, directory, search) {
  if (search)
    return entries
      .filter((e) => e.path.startsWith(directory) && e.path.slice(directory.length).toLowerCase().includes(search.toLowerCase()))
      .map((e) => ({ ...e, label: e.path }));
  const result = new Map();
  for (const entry of entries) {
    if (!entry.path.startsWith(directory)) continue;
    const name = entry.path.slice(directory.length),
      slash = name.indexOf("/");
    if (slash < 0) result.set(entry.path, { ...entry, label: name });
    else {
      const path = directory + name.slice(0, slash),
        previous = result.get(path);
      result.set(path, {
        path,
        label: name.slice(0, slash),
        directory: true,
        count: (previous?.count || 0) + 1,
        size: (previous?.size || 0) + (entry.size || 0),
      });
    }
  }
  return [...result.values()].sort(
    (a, b) =>
      Number(!!b.directory) - Number(!!a.directory) ||
      a.label.localeCompare(b.label),
  );
}
