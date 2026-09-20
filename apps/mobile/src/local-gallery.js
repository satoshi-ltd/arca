export function isGalleryVideo(item) {
  return /\.(mp4|mov|m4v|webm)$/i.test(item.path);
}
// Retain existing positions as downloads arrive; new media append without a scroll jump.
export function reconcileLocalGallery(previous, entries) {
  const available = new Map(
    entries
      .filter(
        (item) =>
          !item.directory &&
          /\.(jpe?g|png|webp|avif|heic|heif|gif|tiff?|mp4|mov|m4v|webm)$/i.test(
            item.path,
          ),
      )
      .map((item) => [item.path, item]),
  );
  const result = [];
  for (const item of previous) {
    if (available.has(item.path)) {
      result.push(available.get(item.path));
      available.delete(item.path);
    }
  }
  return result.concat([...available.values()]);
}
