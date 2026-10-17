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
  createUndecodable,
  isFlatCacheFile,
  isHeic,
  nativeFirst,
  renderLocal,
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
const hubLimiter = createLimiter(3, 60000);
const backgroundHubLimiter = createLimiter(2, 60000);
const posterAttempt = rememberFailures();
const renderAttempt = rememberFailures(4096, "Thumbnail unavailable");
const undecodable = createUndecodable();
AppState.addEventListener("change", (state) => {
  if (state === "active") {
    posterAttempt.clear();
    renderAttempt.clear();
  }
});
let rendered = 0;
let pruning = null;
let prunePending = null;
const activeDerivatives = new Map();
const cachePause = () => new Promise((resolve) => setTimeout(resolve, 0));
const activeDerivative = (uri) =>
  activeDerivatives.has(uri.endsWith(".part") ? uri.slice(0, -5) : uri);
// Derivatives are regenerable and flat; originals live elsewhere, so nested directories are disposable.
async function pruneCache(directory, keep) {
  const entries = directory.list();
  const files = [];
  for (let index = 0; index < entries.length; index++) {
    if (index % 32 === 0) await cachePause();
    const entry = entries[index];
    if (activeDerivative(entry.uri)) continue;
    try {
      if (entry instanceof Directory) {
        entry.delete();
        continue;
      }
      if (!(entry instanceof File)) continue;
      const modified = entry.modificationTime || 0;
      if (entry.name.endsWith(".part")) {
        if (Date.now() - modified > 600000) entry.delete();
      } else {
        files.push({
          file: entry,
          name: entry.name,
          uri: entry.uri,
          size: entry.size,
          modified,
        });
      }
    } catch {
      /* A concurrent renderer may have replaced or removed the file. */
    }
  }
  files.sort((a, b) => a.modified - b.modified);
  const evictions = cacheEvictions(files, keep);
  for (let index = 0; index < evictions.length; index++) {
    if (index % 32 === 0) await cachePause();
    const entry = evictions[index];
    if (activeDerivative(entry.uri)) continue;
    try {
      if (
        entry.file.modificationTime !== entry.modified ||
        entry.file.size !== entry.size
      ) continue;
      entry.file.delete();
    } catch {
      /* The disposable file may already be gone. */
    }
  }
}
function queuePrune(keep) {
  if (pruning) {
    if (pruning === "running") prunePending = keep;
    return;
  }
  pruning = "queued";
  setTimeout(() => {
    pruning = "running";
    void pruneCache(root, keep)
      .catch(() => {})
      .finally(() => {
        pruning = null;
        if (prunePending) {
          const next = prunePending;
          prunePending = null;
          queuePrune(next);
        }
      });
  }, 0);
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
    const render = async () => {
      if (target.exists) return;
      activeDerivatives.set(
        target.uri,
        (activeDerivatives.get(target.uri) || 0) + 1,
      );
      try {
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
      } finally {
        const remaining = activeDerivatives.get(target.uri) - 1;
        if (remaining) activeDerivatives.set(target.uri, remaining);
        else activeDerivatives.delete(target.uri);
      }
    };
    await (unlimited ? render() : limiter.run(render, !background));
    if (rendered++ % 200 === 0) queuePrune(target.uri);
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
    const fileKey = `${entry.uri}:${entry.size}:${entry.mtime}`;
    const heic = Platform.OS === "android" && isHeic(entry.uri) && !!nativeThumbnail;
    const produce = () =>
      cachedDerivative(
        entry,
        size,
        (target) =>
          renderLocal({
            native:
              onDisk(entry.uri) &&
              (() =>
                nativeThumbnail(
                  entry.uri,
                  target.uri,
                  width,
                  size !== "large",
                  false,
                )),
            heic,
            key: fileKey,
            undecodable,
            fallback: async () => {
              const result = await manipulateAsync(
                entry.uri,
                [{ resize: { width } }],
                { compress: quality, format: SaveFormat.JPEG },
              );
              return result.uri;
            },
          }),
        background,
        heic && undecodable.has(fileKey),
      );
    return size === "thumb"
      ? renderAttempt(fileKey, produce)
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
  fromHub(entry, variant, load, background = false) {
    return cachedDerivative(
      entry,
      variant,
      async (target) => {
        const bytes = toByteArray(
          await (background ? backgroundHubLimiter : hubLimiter).run(load),
        );
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
