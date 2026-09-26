const images = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".avif",
  ".heic",
  ".heif",
  ".tif",
  ".tiff",
  ".gif",
]);
const videos = new Set([".mp4", ".mov", ".m4v", ".webm"]);
const extension = (name) => {
  const base = name.split("/").pop();
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot).toLowerCase() : "";
};
export function mediaKind(name) {
  const suffix = extension(name);
  return images.has(suffix) ? "image" : videos.has(suffix) ? "video" : null;
}
// File names retain dates for screenshots whose original format has no EXIF.
export function galleryDate(name, captured, added, modified = null) {
  if (captured) return { date: captured, source: "metadata" };
  const filename = name.split("/").pop();
  const match = filename.match(
    /^(?:Screenshot[ _-]?|IMG[_-]?|VID[_-]?|PXL[_-]?)(\d{4})[-_]?([01]\d)[-_]?([0-3]\d)/i,
  );
  if (match) {
    const day = `${match[1]}-${match[2]}-${match[3]}`;
    const date = new Date(day);
    if (
      Number.isFinite(date.getTime()) &&
      date.toISOString().slice(0, 10) === day
    )
      return { date: day, source: "filename" };
  }
  const month = name.match(
    /^(?:Phone|Machine)-[a-f0-9]+\/(\d{4})\/(0[1-9]|1[0-2])\//,
  );
  if (month) return { date: `${month[1]}-${month[2]}`, source: "album folder" };
  // A copy written after the file was added (a download elsewhere) carries no original date.
  if (modified && (!added || modified < added))
    return { date: modified, source: "file date" };
  return { date: added, source: "date added" };
}
