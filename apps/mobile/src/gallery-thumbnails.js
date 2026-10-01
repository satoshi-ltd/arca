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
import { isFlatCacheFile, nativeFirst } from "./thumbnail-cache";
const video = requireOptionalNativeModule("ExpoVideo")
  ? require("expo-video")
  : null;
const arca = requireOptionalNativeModule("ArcaNetwork");
const nativeThumbnail =
  typeof arca?.thumbnail === "function"
    ? (...args) => arca.thumbnail(...args)
    : null;
const onDisk = (uri) => !!uri?.startsWith("file://");
const root = new Directory(Paths.cache, "arca-gallery");
const jobs = new Map();
const posterAttempt = rememberFailures();
const renderAttempt = rememberFailures(4096, "Thumbnail unavailable");
AppState.addEventListener("change", (state) => {
  if (state === "active") {
    posterAttempt.clear();
    renderAttempt.clear();
  }
});
const budgets = [
  ["large-", 256 * 1024 ** 2],
  ["", 512 * 1024 ** 2],
];
let rendered = 0;
// Derivatives are regenerable and flat; originals live elsewhere, so nested directories are disposable.
function pruneCache(directory, keep) {
  const entries = directory.list();
  for (const entry of entries)
    if (entry instanceof Directory)
      try {
        entry.delete();
      } catch {
        /* A concurrent pass already removed it. */
      }
  const files = entries
    .filter((file) => file instanceof File && !file.name.endsWith(".part"))
    .sort((a, b) => (a.modificationTime || 0) - (b.modificationTime || 0));
  for (const [prefix, limit] of budgets) {
    const group = files.filter(
      (file) => file.name.startsWith("large-") === (prefix === "large-"),
    );
    let size = group.reduce((sum, file) => sum + file.size, 0);
    for (const file of group) {
      if (size <= limit) break;
      if (file.uri === keep) continue;
      size -= file.size;
      file.delete();
    }
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
  const target = new File(
    root,
    `${variant === "large" ? "large-" : ""}${key}.jpg`,
  );
  if (target.exists) return Promise.resolve(target.uri);
  if (jobs.has(key)) return jobs.get(key);
  const job = (async () => {
    root.create({ intermediates: true, idempotent: true });
    const produced = await produce(target);
    if (produced) {
      const temporary = new File(produced);
      try {
        if (!new File(entry.uri).exists)
          throw new Error("Original no longer available");
        await temporary.copy(target);
      } finally {
        if (temporary.exists) temporary.delete();
      }
    } else if (!target.exists) throw new Error("Thumbnail unavailable");
    if (rendered++ % 24 === 0) pruneCache(root, target.uri);
    return target.uri;
  })().finally(() => jobs.delete(key));
  jobs.set(key, job);
  return job;
}
export const thumbnailFiles = {
  async exists(uri) {
    return isFlatCacheFile(uri, root.uri) && new File(uri).exists;
  },
  render(entry, large = false) {
    const produce = () =>
      cachedDerivative(entry, large ? "large" : "thumb", (target) =>
        nativeFirst(
          nativeThumbnail &&
            onDisk(entry.uri) &&
            (() =>
              nativeThumbnail(
                entry.uri,
                target.uri,
                large ? 2048 : 360,
                !large,
                false,
              )),
          async () => {
            const result = await manipulateAsync(
              entry.uri,
              [{ resize: { width: large ? 2048 : 360 } }],
              { compress: large ? 0.85 : 0.75, format: SaveFormat.JPEG },
            );
            return result.uri;
          },
        ),
      );
    return large
      ? produce()
      : renderAttempt(`${entry.uri}:${entry.size}:${entry.mtime}`, produce);
  },
  async poster(item) {
    const uri = videoPosterSource(item);
    if (!uri || (!nativeThumbnail && !video))
      throw new Error("Video thumbnail unavailable");
    return posterAttempt(`${uri}:${item.size}:${item.mtime}`, () =>
      cachedDerivative({ ...item, uri }, "poster", (target) =>
        nativeFirst(
          nativeThumbnail &&
            onDisk(uri) &&
            (() => nativeThumbnail(uri, target.uri, 360, true, true)),
          () => {
            if (!video) throw new Error("Video thumbnail unavailable");
            return renderVideoPoster(uri, {
              createPlayer: video.createVideoPlayer,
              manipulate: (source) => ImageManipulator.manipulate(source),
              platform: Platform.OS,
              format: SaveFormat.JPEG,
            });
          },
        ),
      ),
    );
  },
};
