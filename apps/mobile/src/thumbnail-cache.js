import { mediaKind } from "../../../packages/core/gallery-date.js";
// Sequential, cancellable preparation. A failed derivative never replaces an original.
export async function prepareThumbnails(
  entries,
  previous,
  io,
  active = () => true,
  changed = () => {},
  keep = entries,
) {
  const paths = new Set(keep.map((entry) => entry.path));
  const next = Object.fromEntries(
    Object.entries(previous).filter(([path]) => paths.has(path)),
  );
  let dirty = 0;
  for (const entry of entries) {
    if (!active()) return null;
    if (entry.directory || !mediaKind(entry.path)) continue;
    const signature = entry.signature || `${entry.size}:${entry.mtime}`;
    const old = previous[entry.path];
    let uri =
      old?.signature === signature && (await io.exists(old.uri))
        ? old.uri
        : null;
    if (!uri) {
      try {
        uri = await io.render(entry);
      } catch {
        /* Keep the original available. */
      }
    }
    if (!active()) return null;
    if (uri) next[entry.path] = { signature, uri };
    else delete next[entry.path];
    if (uri !== old?.uri || signature !== old?.signature) {
      if (++dirty % 8 === 0) changed({ ...next });
    }
  }
  if (JSON.stringify(next) !== JSON.stringify(previous)) changed(next);
  return next;
}
