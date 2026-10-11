import { AppState, Platform } from "react-native";
import { requireOptionalNativeModule } from "expo";
import { File, Directory, Paths } from "expo-file-system";
import {
  ImageManipulator,
  manipulateAsync,
  SaveFormat,
} from "expo-image-manipulator";
import { toByteArray } from "base64-js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  rememberFailures,
  renderVideoPoster,
  videoPosterSource,
} from "./video-playback";
import {
  PREVIEW_VARIANTS,
  THUMB_WIDTH,
  cacheEvictions,
  cacheName,
  createLimiter,
  isFlatCacheFile,
  nativeFirst,
} from "./thumbnail-cache";
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
const limiter = createLimiter(3, 30000);
const hubLimiter = createLimiter(2, 60000);
const posterAttempt = rememberFailures();
const renderAttempt = rememberFailures(4096, "Thumbnail unavailable");
AppState.addEventListener("change", (state) => {
  if (state === "active") {
    posterAttempt.clear();
    renderAttempt.clear();
  }
});
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
  for (const entry of entries)
    if (
      entry instanceof File &&
      entry.name.endsWith(".part") &&
      Date.now() - (entry.modificationTime || 0) > 600000
    )
      try {
        entry.delete();
      } catch {
        /* A concurrent pass already removed it. */
      }
  const files = entries
    .filter((file) => file instanceof File && !file.name.endsWith(".part"))
    .sort((a, b) => (a.modificationTime || 0) - (b.modificationTime || 0));
  for (const file of cacheEvictions(files, keep)) file.delete();
}
function cachedDerivative(
  entry,
  variant,
  produce,
  background = false,
  unlimited = false,
) {
  const key = bytesToHex(
    sha256(
      new TextEncoder().encode(
        `${entry.uri}:${entry.size}:${entry.mtime}:${variant}`,
      ),
    ),
  );
  const target = new File(root, cacheName(variant, key));
  if (target.exists) return Promise.resolve(target.uri);
  if (jobs.has(key)) return jobs.get(key);
  const job = (async () => {
    root.create({ intermediates: true, idempotent: true });
    const produced = await (unlimited
      ? produce(target)
      : limiter.run(() => produce(target), !background));
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
    if (rendered++ % 200 === 0) pruneCache(root, target.uri);
    return target.uri;
  })().finally(() => jobs.delete(key));
  jobs.set(key, job);
  return job;
}
export const thumbnailFiles = {
  async exists(uri) {
    return isFlatCacheFile(uri, root.uri) && new File(uri).exists;
  },
  render(entry, size = "thumb", background = false) {
    const { width, quality } = PREVIEW_VARIANTS[size];
    const produce = () =>
      cachedDerivative(
        entry,
        size,
        (target) =>
          nativeFirst(
            nativeThumbnail &&
              onDisk(entry.uri) &&
              (() =>
                nativeThumbnail(
                  entry.uri,
                  target.uri,
                  width,
                  size !== "large",
                  false,
                )),
            async () => {
              const result = await manipulateAsync(
                entry.uri,
                [{ resize: { width } }],
                { compress: quality, format: SaveFormat.JPEG },
              );
              return result.uri;
            },
          ),
        background,
      );
    return size === "thumb"
      ? renderAttempt(`${entry.uri}:${entry.size}:${entry.mtime}`, produce)
      : produce();
  },
  async poster(item, background = false) {
    const uri = videoPosterSource(item);
    if (!uri || (!nativeThumbnail && !video))
      throw new Error("Video thumbnail unavailable");
    return posterAttempt(`${uri}:${item.size}:${item.mtime}`, () =>
      cachedDerivative(
        { ...item, uri },
        "poster",
        (target) =>
          nativeFirst(
            nativeThumbnail &&
              onDisk(uri) &&
              (() => nativeThumbnail(uri, target.uri, THUMB_WIDTH, true, true)),
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
        background,
      ),
    );
  },
  fromHub(entry, variant, load) {
    return cachedDerivative(
      entry,
      variant,
      async (target) => {
        const bytes = toByteArray(await hubLimiter.run(load));
        const part = new File(`${target.uri}.part`);
        try {
          part.create({ intermediates: true, overwrite: true });
          const handle = part.open();
          try {
            handle.writeBytes(bytes);
          } finally {
            handle.close();
          }
        } catch (error) {
          if (part.exists) part.delete();
          throw error;
        }
        return part.uri;
      },
      false,
      true,
    );
  },
  retry() {
    posterAttempt.clear();
    renderAttempt.clear();
  },
};
