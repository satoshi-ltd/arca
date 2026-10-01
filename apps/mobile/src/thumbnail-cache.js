import { mediaKind } from "../../../packages/core/gallery-date.js";
// Cancellable preparation with bounded parallelism. A failed derivative never replaces an original.
export async function prepareThumbnails(
  entries,
  previous,
  io,
  active = () => true,
  changed = () => {},
  keep = entries,
  concurrency = 1,
) {
  const paths = new Set(keep.map((entry) => entry.path));
  const next = Object.fromEntries(
    Object.entries(previous).filter(([path]) => paths.has(path)),
  );
  const queue = entries.filter(
    (entry) => !entry.directory && mediaKind(entry.path),
  );
  let stopped = false;
  const work = async () => {
    while (queue.length && !stopped) {
      if (!active()) {
        stopped = true;
        return;
      }
      const entry = queue.shift();
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
      if (!active()) {
        stopped = true;
        return;
      }
      if (uri) next[entry.path] = { signature, uri };
      else delete next[entry.path];
      if (uri !== old?.uri || signature !== old?.signature) {
        changed({ ...next });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, work));
  if (stopped) return null;
  if (JSON.stringify(next) !== JSON.stringify(previous)) changed(next);
  return next;
}

export function savedThumbnail(saved, item) {
  const found = saved[item.path];
  return found && found.signature === item.signature ? found.uri : null;
}

export function isFlatCacheFile(uri, directory) {
  const prefix = directory.endsWith("/") ? directory : `${directory}/`;
  return (
    !!uri && uri.startsWith(prefix) && !uri.slice(prefix.length).includes("/")
  );
}

export async function nativeFirst(native, fallback) {
  if (native)
    try {
      await native();
      return null;
    } catch {
      /* Older binaries and unsupported sources use the portable renderer. */
    }
  return fallback();
}
