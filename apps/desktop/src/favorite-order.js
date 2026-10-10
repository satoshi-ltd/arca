const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });

export const nameOrder = (a, b) => collator.compare(a, b);

export const folderKindRank = (volume) => (volume?.gallery ? 1 : volume?.music ? 2 : 0);

export function favoriteOrder(items, volumes) {
  const byId = new Map(volumes.map((volume) => [volume.id, volume]));
  return items
    .map((item, index) => {
      const volume = byId.get(item.folder);
      return { index, rank: folderKindRank(volume), name: item.kind === "folder" ? (volume?.name ?? item.label) : item.label };
    })
    .sort((a, b) => a.rank - b.rank || nameOrder(a.name, b.name) || a.index - b.index)
    .map((entry) => entry.index);
}
