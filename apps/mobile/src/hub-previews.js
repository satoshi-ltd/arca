import { File, Directory, Paths } from "expo-file-system";
import { toByteArray } from "base64-js";
import { pruneCache } from "./gallery-thumbnails";
const root = new Directory(Paths.cache, "arca-gallery", "hub");
const jobs = new Map();
// Hub derivatives are a bounded view cache, never a working copy of the folder.
export function hubPreviewFiles(api, volume) {
  const fetchInto = (item, large) => {
    const name = `${item.hash}-${large ? "large" : "thumb"}`;
    const target = new File(root, `${name}.jpg`);
    if (target.exists) return Promise.resolve(target.uri);
    if (jobs.has(target.uri)) return jobs.get(target.uri);
    const job = (async () => {
      const result = await api(
        `/v1/gallery/preview?${new URLSearchParams({
          volume,
          path: item.path,
          hash: item.hash,
          ...(large ? { size: "large" } : {}),
        })}`,
      );
      const data = result?.data?.split(",")[1];
      if (!data) throw new Error("Preview unavailable");
      root.create({ intermediates: true, idempotent: true });
      const temporary = new File(root, `${name}.${Date.now()}.tmp`);
      temporary.write(toByteArray(data));
      if (target.exists) temporary.delete();
      else temporary.move(target);
      pruneCache(root, 192 * 1024 ** 2, target.uri);
      return target.uri;
    })().finally(() => jobs.delete(target.uri));
    jobs.set(target.uri, job);
    return job;
  };
  return {
    thumbnail: (item) => fetchInto(item, false),
    large: (item) => fetchInto(item, true),
  };
}
