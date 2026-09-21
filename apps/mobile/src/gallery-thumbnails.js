import { File, Directory, Paths } from "expo-file-system";
import { manipulateAsync, SaveFormat } from "expo-image-manipulator";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
const root = new Directory(Paths.cache, "arca-gallery");
const jobs = new Map();
// Cache files are regenerable; originals live in a different directory.
export function pruneCache(directory, limit, keep) {
  const files = directory
    .list()
    .filter((file) => file instanceof File)
    .sort((a, b) => (a.modificationTime || 0) - (b.modificationTime || 0));
  let size = files.reduce((sum, file) => sum + file.size, 0);
  for (const file of files) {
    if (size <= limit) break;
    if (file.uri === keep) continue;
    size -= file.size;
    file.delete();
  }
}
export const thumbnailFiles = {
  async exists(uri) {
    return !!uri && new File(uri).exists;
  },
  async render(entry) {
    const key = bytesToHex(
      sha256(
        new TextEncoder().encode(`${entry.uri}:${entry.size}:${entry.mtime}`),
      ),
    );
    const target = new File(root, `${key}.jpg`);
    if (target.exists) return target.uri;
    if (jobs.has(key)) return jobs.get(key);
    const job = (async () => {
      root.create({ intermediates: true, idempotent: true });
      const result = await manipulateAsync(
        entry.uri,
        [{ resize: { width: 360 } }],
        { compress: 0.75, format: SaveFormat.JPEG },
      );
      const temporary = new File(result.uri);
      try {
        if (!new File(entry.uri).exists)
          throw new Error("Original no longer available");
        temporary.copy(target);
      } finally {
        if (temporary.exists) temporary.delete();
      }
      pruneCache(root, 128 * 1024 ** 2, target.uri);
      return target.uri;
    })().finally(() => jobs.delete(key));
    jobs.set(key, job);
    return job;
  },
};
