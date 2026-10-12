import { galleryDisplay } from "./gallery-display.js";

export function canonicalFileUri(folderUri, path) {
  const base = folderUri.endsWith("/") ? folderUri : `${folderUri}/`;
  return base + path.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

export function searchIo(thumbnails) {
  return {
    render: (entry, size) => thumbnails.render(entry, size, true),
    poster: (entry) => thumbnails.poster(entry, true),
  };
}

async function localEntry(item, { uri, stat }) {
  const source = uri(item);
  if (!source) return null;
  const info = await stat(source).catch(() => null);
  if (!info || info.directory) return null;
  return { path: item.path, uri: source, size: info.size ?? item.size, mtime: info.mtime, hash: item.hash, kind: item.kind };
}

export async function searchThumbnail(item, deps) {
  const entry = await localEntry(item, deps);
  if (!entry) return null;
  if (entry.kind === "video") return deps.poster(entry);
  return galleryDisplay(entry, { size: "thumb", localPreview: deps.render });
}

export async function searchPreview(item, deps) {
  const entry = await localEntry(item, deps);
  if (!entry || entry.kind === "video") return null;
  try {
    return await galleryDisplay(entry, { size: "large", fallback: true, localPreview: deps.render });
  } catch {
    return /\.(hei[cf]|avif)$/i.test(entry.path) ? null : entry.uri;
  }
}
