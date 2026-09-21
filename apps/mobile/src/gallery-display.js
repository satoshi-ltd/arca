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
          item.sourcePath || item.path,
          item.sourceHash || item.hash,
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

export async function galleryDisplay(
  item,
  { large = false, fallback = false, nativeSource, localPreview, hubPreview },
) {
  const native =
    !fallback && (item.upload ? item.uri : await nativeSource?.(item));
  if (native) {
    if (large) return native;
    try {
      return await localPreview({ ...item, uri: native }, false);
    } catch {
      /* Try the already cached/hub derivative below. */
    }
  }
  // Decode local HEIC when supported; use the hub derivative as a fallback.
  if (item.uri && !fallback) {
    if (large && !/\.hei[cf]$/i.test(item.path)) return item.uri;
    try {
      return await localPreview(item, large);
    } catch {
      /* The hub can still supply a compatible derivative. */
    }
  }
  if (item.hash) return hubPreview(item, large);
  // Pending local uploads have no hub resource yet. Decode a disposable copy
  // locally when native display failed, never replace the Photos original.
  if (item.uri) return localPreview(item, large);
  throw new Error(
    "Photo unavailable locally. Connect to the hub to load its preview.",
  );
}
