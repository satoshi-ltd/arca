// Receipts survive phone deletions; this grid only shows accessible local media.
export async function recentGalleryPreviews(
  store,
  media,
  scope,
  volume,
  active = () => true,
) {
  const result = [];
  for (let offset = 0; active() && result.length < 16; offset += 16) {
    const rows = await store.galleryPreview(scope, volume, true, 16, offset);
    const previews = await Promise.all(
      rows.map(async (item) => {
        try {
          const preview = await media.preview(item.id);
          return preview?.uri ? { ...item, ...preview } : null;
        } catch {
          return null;
        }
      }),
    );
    result.push(...previews.filter(Boolean));
    if (rows.length < 16) break;
  }
  return result.slice(0, 16);
}
