export const HEADROOM = 256 * 1024 ** 2;
export function neededBytes(volume, folders, volumes) {
  const catalog = new Map(volumes.map((folder) => [folder.id, folder]));
  const local = folders.find((folder) => folder.id === volume.id);
  let required = Math.max(0, volume.bytes - (local?.bytes || 0));
  for (const folder of folders) {
    if (!folder.selected || folder.id === volume.id) continue;
    const remote = catalog.get(folder.id);
    if (remote) required += Math.max(0, remote.bytes - folder.bytes);
  }
  return required;
}
export const spaceShort = (needed, free) =>
  Number.isFinite(needed) && Number.isFinite(free) && needed + HEADROOM > free;
