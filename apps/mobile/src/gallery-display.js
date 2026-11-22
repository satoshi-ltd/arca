// Resolve only an accepted resource belonging to this phone's linked library.
// Never derive an asset ID from a filename or fetch an iCloud original to browse.
export function nativeGallerySources({ store, media, scope, volume }) {
  const cache = new Map();
  return (item) => {
    if (!item.hash) return Promise.resolve(null);
    const key = `${item.path}:${item.hash}`;
    if (!cache.has(key)) {
      const job = (async () => {
        const asset = await store.galleryNativeAsset(
          scope,
          volume,
          item.path,
          item.hash,
        );
        if (!asset || asset.id.startsWith("picked-")) return null;
        const native = await media.preview(asset.id);
        if (
          !native?.uri ||
          (Number.isFinite(asset.modificationTime) &&
            native.modificationTime !== asset.modificationTime)
        )
          return null;
        return native.uri;
      })().catch(() => null);
      cache.set(key, job);
      if (cache.size > 256) cache.delete(cache.keys().next().value);
    }
    return cache.get(key);
  };
}

// A replica shows only what this phone holds: its synchronized file or its own library asset.
export async function galleryDisplay(
  item,
  { size = "thumb", fallback = false, nativeSource, localPreview },
) {
  const local = item.uri && !item.nativeSource && !item.upload;
  let failure = null;
  if (local) {
    if (size === "large" && !fallback && !/\.hei[cf]$/i.test(item.path))
      return item.uri;
    try {
      return await localPreview(item, size);
    } catch (error) {
      failure = error;
    }
  }
  const native = item.upload ? item.uri : await nativeSource?.(item);
  if (native) {
    if (size === "large" && !fallback) return native;
    return localPreview({ ...item, uri: native }, size);
  }
  throw (
    failure ||
    new Error(
      "This photo is not on this phone yet. It appears once synchronization downloads it.",
    )
  );
}
export const hidePhotos = (hidden, photos) =>
  new Map([...hidden, ...photos.map((photo) => [photo.path, photo.rev])]);
export function settleHiddenPhotos(hidden, photos, deleted, pending) {
  const next = new Map(hidden);
  for (const photo of photos) {
    const row = (deleted || []).find((item) => item.path === photo.path);
    if (row) next.set(photo.path, row.rev);
    else if (!pending.has(photo.path) && next.get(photo.path) === photo.rev)
      next.delete(photo.path);
  }
  for (const row of deleted || []) next.set(row.path, row.rev);
  return next;
}
export function viewerWithout(viewer, photos) {
  if (!viewer) return null;
  const remaining = viewer.items.filter(
    (photo) => !photos.some((gone) => gone.path === photo.path),
  );
  return remaining.length
    ? { items: remaining, index: Math.min(viewer.index, remaining.length - 1) }
    : null;
}
