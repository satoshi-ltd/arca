import { writePortableBackup } from "./portable-backup";
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
  incoming: (key) => new File(root, "incoming", id(key)).uri,
  scope: (scope) => new Directory(root, id(scope)).uri,
  folder: (scope, volume) =>
    new Directory(root, id(scope), "folders", id(volume)).uri,
  work(scope, volume, path) {
    return new File(this.folder(scope, volume), ...validPath(path).split("/"))
      .uri;
  },
  object: (scope, hash) => new File(root, id(scope), "objects", id(hash)).uri,
  partial: (scope, hash) => new File(root, id(scope), "partial", id(hash)).uri,
  backup: (scope) => new Directory(root, id(scope), "backup").uri,
  backupObject(scope, hash) {
    return new File(this.backup(scope), "objects", id(hash)).uri;
  },
  parent: (uri) => new File(uri).parentDirectory.uri,
  async mkdir(uri) {
    new Directory(uri).create({ intermediates: true, idempotent: true });
  },
  async exists(uri) {
    return new File(uri).exists || new Directory(uri).exists;
  },
  async stat(uri) {
    const f = new File(uri);
    return f.exists ? { size: f.size, mtime: f.modificationTime } : null;
  },
  async free() {
    return Paths.availableDiskSpace;
  },
  async removeFolder(scope, volume) {
    const directory = new Directory(this.folder(scope, volume));
    if (directory.exists) directory.delete();
  },
  async remove(uri) {
    if (new File(uri).exists) new File(uri).delete();
  },
  async copy(from, to) {
    if (new File(to).exists) new File(to).delete();
    new File(from).copy(new File(to));
  },
  async move(from, to) {
    new File(from).move(new File(to));
  },
  // Callers journal replacements before entering this operation.
  async replace(from, to) {
    if (!native)
      throw new Error("Install the Arca native build to save files.");
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
      if (entry instanceof Directory) yield* this.walk(entry.uri, path + "/");
      else
        yield {
          path,
          uri: entry.uri,
          size: entry.size,
          mtime: entry.modificationTime,
        };
    }
  },
  async used(uri) {
    let total = 0;
    if (!new Directory(uri).exists) return 0;
    for await (const entry of this.walk(uri)) total += entry.size;
    return total;
  },
  async exportDirectory(source, name) {
    if (!native)
      throw new Error("Install the Arca native build to export files.");
    const destination = await Directory.pickDirectoryAsync();
    return native.exportDirectory(
      source,
      destination.uri,
      name + "-" + Date.now(),
    );
  },
  exportBackup(scope, store, through) {
    return writePortableBackup(this, scope, store, through);
  },
};
