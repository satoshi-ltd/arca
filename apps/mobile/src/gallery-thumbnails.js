import { AppState, Platform } from "react-native";
import { requireOptionalNativeModule } from "expo";
import { File, Directory, Paths } from "expo-file-system";
import {
  ImageManipulator,
  manipulateAsync,
  SaveFormat,
} from "expo-image-manipulator";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  rememberFailures,
  renderVideoPoster,
  videoPosterSource,
} from "./video-playback";
const video = requireOptionalNativeModule("ExpoVideo")
  ? require("expo-video")
  : null;
const root = new Directory(Paths.cache, "arca-gallery");
const jobs = new Map();
const posterAttempt = rememberFailures();
AppState.addEventListener("change", (state) => {
  if (state === "active") posterAttempt.clear();
});
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
function cachedDerivative(entry, variant, produce) {
  const key = bytesToHex(
    sha256(
      new TextEncoder().encode(
        `${entry.uri}:${entry.size}:${entry.mtime}:${variant}`,
      ),
    ),
  );
  const target = new File(root, `${key}.jpg`);
  if (target.exists) return Promise.resolve(target.uri);
  if (jobs.has(key)) return jobs.get(key);
  const job = (async () => {
    root.create({ intermediates: true, idempotent: true });
    const temporary = new File(await produce());
    try {
      if (!new File(entry.uri).exists)
        throw new Error("Original no longer available");
      await temporary.copy(target);
    } finally {
      if (temporary.exists) temporary.delete();
    }
    pruneCache(root, 128 * 1024 ** 2, target.uri);
    return target.uri;
  })().finally(() => jobs.delete(key));
  jobs.set(key, job);
  return job;
}
export const thumbnailFiles = {
  async exists(uri) {
    return !!uri && new File(uri).exists;
  },
  render(entry, large = false) {
    return cachedDerivative(entry, large ? "large" : "thumb", async () => {
      const result = await manipulateAsync(
        entry.uri,
        [{ resize: { width: large ? 2048 : 360 } }],
        { compress: large ? 0.85 : 0.75, format: SaveFormat.JPEG },
      );
      return result.uri;
    });
  },
  async poster(item) {
    const uri = videoPosterSource(item);
    if (!uri || !video) throw new Error("Video thumbnail unavailable");
    return posterAttempt(`${uri}:${item.size}:${item.mtime}`, () =>
      cachedDerivative({ ...item, uri }, "poster", () =>
        renderVideoPoster(uri, {
          createPlayer: video.createVideoPlayer,
          manipulate: (source) => ImageManipulator.manipulate(source),
          platform: Platform.OS,
          format: SaveFormat.JPEG,
        }),
      ),
    );
  },
};
