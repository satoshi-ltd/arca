import { native } from "./private-network";
import { File, Directory, Paths } from "expo-file-system";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { validPath, CHUNK } from "./replica";
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
function id(value) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9-]+$/.test(value))
    throw new Error("Invalid folder identity");
  return value;
}
const root = new Directory(Paths.document, "arca");
export const files = {
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
  partial: (scope, hash) => new File(root, id(scope), "partial", id(hash)).uri,

  parent: (uri) => Paths.dirname(uri),
  async mkdir(uri) {
    new Directory(uri).create({ intermediates: true, idempotent: true });
  },
  async exists(uri) {
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
    const directory = new Directory(this.folder(scope, volume));
    if (directory.exists) directory.delete();
  },
  async removeDirectory(uri) {
    native.removeEmptyDirectory(uri);
  },
  async remove(uri) {
    if (new File(uri).exists) new File(uri).delete();
  },
  async copy(from, to) {
    if (new File(to).exists) new File(to).delete();
    new File(from).copy(new File(to));
  },
  async move(from, to) {
    if (Paths.info(from).isDirectory)
      new Directory(from).move(new Directory(to));
    else new File(from).move(new File(to));
  },
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
  async *walk(uri, prefix = "") {
    for (const entry of new Directory(uri).list()) {
      if (entry.name.startsWith(".arca-")) continue;
      const path = prefix + entry.name;
      if (entry instanceof Directory) {
        yield { path, uri: entry.uri, size: 0, directory: true };
        yield* this.walk(entry.uri, path + "/");
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
