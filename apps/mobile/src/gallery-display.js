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
  { large = false, fallback = false, nativeSource, localPreview },
) {
  const local = item.uri && !item.nativeSource && !item.upload;
  let failure = null;
  if (local) {
    if (large && !fallback && !/\.hei[cf]$/i.test(item.path)) return item.uri;
    try {
      return await localPreview(item, large);
    } catch (error) {
      failure = error;
    }
  }
  const native = item.upload ? item.uri : await nativeSource?.(item);
  if (native) {
    if (large && !fallback) return native;
    return localPreview({ ...item, uri: native }, large);
  }
  throw (
    failure ||
    new Error(
      "This photo is not on this phone yet. It appears once synchronization downloads it.",
    )
  );
}
