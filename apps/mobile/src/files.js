import { native } from "./private-network";
import { File, Directory, Paths } from "expo-file-system";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { toByteArray } from "base64-js";
import { validPath, CHUNK } from "./replica";
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
function id(value) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9-]+$/.test(value))
    throw new Error("Invalid folder identity");
  return value;
}
const root = new Directory(Paths.document, "arca");
export const files = {
  async destroy() {
    if (root.exists) root.delete();
    await this.clearIncoming();
    this.clearGalleryCache();
  },
  clearGalleryCache() {
    const directory = new Directory(Paths.cache, "arca-gallery");
    if (directory.exists) directory.delete();
  },
  galleryStage: (scope, volume) =>
    new Directory(root, id(scope), "gallery-stage", id(volume)).uri,
  async clearGalleryStage(scope, volume) {
    const directory = new Directory(this.galleryStage(scope, volume));
    if (directory.exists) directory.delete();
  },
  picked: (scope, volume, key) =>
    new File(root, id(scope), "picked", id(volume), id(key)).uri,
  incoming: (key) => new File(Paths.cache, "arca-incoming", id(key)).uri,
  async clearIncoming() {
    const directory = new Directory(Paths.cache, "arca-incoming");
    if (directory.exists) directory.delete();
  },
  folder: (scope, volume) =>
    new Directory(root, id(scope), "folders", id(volume)).uri,
  work(scope, volume, path) {
    return Paths.join(
      this.folder(scope, volume),
      ...validPath(path).split("/"),
    );
  },
  object: (scope, hash) => new File(root, id(scope), "objects", id(hash)).uri,
  musicLibrary: () => new File(root, "music-library.json").uri,
  musicHistory: () => new File(root, "music-history.json").uri,
  musicCovers: (scope) => new Directory(root, id(scope), "music-covers").uri,
  musicCover(scope, key, size) {
    if (!/^[a-f0-9]{64}$/.test(key) || !["small", "large"].includes(size))
      throw new Error("Invalid cover");
    return new File(root, id(scope), "music-covers", `${key}-${size}.jpg`).uri;
  },
  partial: (scope, hash) => new File(root, id(scope), "partial", id(hash)).uri,

  parent: (uri) => Paths.dirname(uri),
  async mkdir(uri) {
    new Directory(uri).create({ intermediates: true, idempotent: true });
  },
  async listNames(uri) {
    return new Directory(uri).list().map((entry) => entry.name);
  },
  async exists(uri) {
    return Paths.info(uri).exists;
  },
  present(uri) {
    return Paths.info(uri).exists;
  },
  async stat(uri) {
    const info = Paths.info(uri);
    if (!info.exists) return null;
    if (info.isDirectory) return { directory: true, size: 0 };
    const f = new File(uri);
    return { size: f.size, mtime: f.modificationTime };
  },
  async free() {
    return Paths.availableDiskSpace;
  },
  async removeFolder(scope, volume) {
    this.clearGalleryCache();
    const directory = new Directory(this.folder(scope, volume));
    if (directory.exists) directory.delete();
    const picked = new Directory(root, id(scope), "picked", id(volume));
    if (picked.exists) picked.delete();
  },
  async removeDirectory(uri) {
    native.removeEmptyDirectory(uri);
  },
  async remove(uri) {
    if (new File(uri).exists) new File(uri).delete();
  },
  // Picker copies live in the app cache; never delete a provider or library URI.
  async discardPicked(uri) {
    if (
      typeof uri === "string" &&
      uri.startsWith(Paths.cache.uri) &&
      !uri.startsWith(new Directory(Paths.cache, "arca-incoming").uri) &&
      new File(uri).exists
    )
      new File(uri).delete();
  },
  async clearStaged(uri) {
    const directory = new Directory(uri);
    if (!directory.exists) return;
    for (const entry of directory.list())
      if (entry.name.startsWith(".arca-copy-")) entry.delete();
  },
  async copy(from, to) {
    const staged = new File(
      Paths.join(
        Paths.dirname(to),
        `.arca-copy-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
      ),
    );
    try {
      await new File(from).copy(staged);
      if (to.startsWith(root.uri)) native.replaceFile(staged.uri, to);
      else {
        if (new File(to).exists) new File(to).delete();
        await staged.move(new File(to));
      }
    } catch (error) {
      if (staged.exists) staged.delete();
      throw error;
    }
  },
  async move(from, to) {
    if (Paths.info(from).isDirectory)
      await new Directory(from).move(new Directory(to));
    else await new File(from).move(new File(to));
  },
  staged: (uri) =>
    Paths.join(
      Paths.dirname(uri),
      `.arca-copy-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
    ),
  // Callers journal replacements before entering this operation.
  async replace(from, to) {
    native.replaceFile(from, to);
  },
  async write(uri, data, offset = 0) {
    const f = new File(uri);
    if (!f.exists) f.create({ intermediates: true });
    const h = f.open();
    try {
      h.offset = offset;
      h.writeBytes(data);
    } finally {
      h.close();
    }
  },
  async writeBase64(uri, data) {
    await this.write(uri, toByteArray(data));
  },
  async read(uri, offset, length) {
    const h = new File(uri).open();
    try {
      h.offset = offset;
      return h.readBytes(length);
    } finally {
      h.close();
    }
  },
  async text(uri) {
    return new File(uri).text();
  },
  async hash(uri) {
    if (
      native.hashFile &&
      (uri.startsWith(Paths.document.uri) || uri.startsWith(Paths.cache.uri))
    )
      return native.hashFile(uri);
    const h = new File(uri).open(),
      digest = sha256.create();
    try {
      while (h.offset < h.size) {
        digest.update(h.readBytes(CHUNK));
        await tick();
      }
      return bytesToHex(digest.digest());
    } finally {
      h.close();
    }
  },
  async *walk(uri, prefix = "", includePrivate = false) {
    await tick();
    let visited = 0;
    for (const entry of new Directory(uri).list()) {
      if (++visited % 32 === 0) await tick();
      if (!includePrivate && entry.name.startsWith(".arca-")) continue;
      const path = prefix + entry.name;
      if (entry instanceof Directory) {
        yield { path, uri: entry.uri, size: 0, directory: true };
        yield* this.walk(entry.uri, path + "/", includePrivate);
      } else
        yield {
          path,
          uri: entry.uri,
          size: entry.size,
          mtime: entry.modificationTime,
        };
    }
  },
  async exportDirectory(source, name) {
    const destination = await Directory.pickDirectoryAsync();
    return native.exportDirectory(
      source,
      destination.uri,
      name + "-" + Date.now(),
    );
  },
};
