import fs from "node:fs";
import path from "node:path";
import { fail } from "./storage.js";
import { mediaKind } from "./gallery.js";

export function galleryMedia(store, volume, name, hash) {
  const folder = store.volume(volume);
  if (store.config.role !== "hub" && !folder.selected)
    fail("Select this folder first", 403);
  const row = store.current(volume, name);
  if (
    !row ||
    row.deleted ||
    row.hash !== hash ||
    mediaKind(name) !== "video" ||
    store.visibleRules(volume)(name, false)
  )
    fail("Video is no longer available", 404);
  const file = store.blob(hash);
  if (!fs.existsSync(file) || fs.statSync(file).size !== row.size)
    fail("Sync this video before playing it", 409);
  return {
    file,
    size: row.size,
    type:
      path.extname(name).toLowerCase() === ".webm"
        ? "video/webm"
        : path.extname(name).toLowerCase() === ".mov"
          ? "video/quicktime"
          : "video/mp4",
  };
}
export function streamGalleryMedia(req, res, media) {
  let start = 0,
    end = media.size - 1;
  const range = req.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) {
      res.writeHead(416, { "Content-Range": `bytes */${media.size}` });
      res.end();
      return;
    }
    if (!match[1]) start = Math.max(0, media.size - Number(match[2]));
    else {
      start = Number(match[1]);
      if (match[2]) end = Math.min(end, Number(match[2]));
    }
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      start > end ||
      start >= media.size
    ) {
      res.writeHead(416, { "Content-Range": `bytes */${media.size}` });
      res.end();
      return;
    }
  }
  res.writeHead(range ? 206 : 200, {
    "Content-Type": media.type,
    "Content-Length": Math.max(0, end - start + 1),
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    ...(range
      ? { "Content-Range": `bytes ${start}-${end}/${media.size}` }
      : {}),
  });
  if (req.method === "HEAD" || !media.size) {
    res.end();
    return;
  }
  const stream = fs.createReadStream(media.file, { start, end });
  res.on("close", () => stream.destroy());
  stream.on("error", () => res.destroy()).pipe(res);
}
