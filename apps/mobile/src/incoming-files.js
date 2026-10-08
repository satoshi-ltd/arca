import { validPath } from "./validation.js";

export function incomingName(payload, index) {
  const name = (payload.originalName || `shared-file-${index + 1}`).normalize(
    "NFC",
  );
  // A sender supplies a filename, never a destination path.
  if (name.includes("/") || name.includes("\\"))
    throw new Error(
      "The shared filename contains a path. Rename it in the source app.",
    );
  return name;
}
export function incomingFilenameError(name) {
  if (!name) return "Enter a file name.";
  if (name.includes("/") || name.includes("\\"))
    return "Enter a file name, not a path.";
  if (new TextEncoder().encode(name).length > 255)
    return "Use a shorter file name.";
  try {
    validPath(name.normalize("NFC"));
    return "";
  } catch {
    return 'Rename this file: avoid : * ? " < > |, reserved names and trailing dots or spaces.';
  }
}
export function incomingDestination(directory, name) {
  const prefix = directory.trim().normalize("NFC").replace(/\/$/, "");
  const error = incomingFilenameError(name);
  if (error) throw new Error(error);
  return validPath((prefix ? `${prefix}/${name}` : name).normalize("NFC"));
}
export async function resolveShared(r, receive, raw, id) {
  if (!raw.length || raw.length > 20)
    throw new Error("Share between 1 and 20 files at a time.");
  if (
    raw.some((p) => !["file", "image", "audio", "video"].includes(p.shareType))
  )
    throw new Error("Share the exported file, rather than a link or text.");
  const staged = [];
  try {
    const payloads = [];
    for (const [index, p] of raw.entries()) {
      const destination = r.files.incoming(`${id}-${index}`);
      staged.push(destination);
      const received = await receive(p.value, destination);
      await r.space(0);
      payloads.push({
        shareType: p.shareType,
        staged: true,
        contentUri: destination,
        originalName: received.name,
        contentSize: received.size,
      });
    }
    return payloads;
  } catch (error) {
    for (const uri of staged) await r.files.remove(uri);
    throw error;
  }
}
export async function copyPicked(r, receive, assets, id) {
  const staged = [];
  try {
    const copies = [];
    for (const [index, asset] of assets.entries()) {
      const destination = r.files.incoming(`${id}-${index}`);
      staged.push(destination);
      const received = await receive(asset.uri, destination);
      copies.push({ name: asset.name || received.name, uri: destination });
    }
    return copies;
  } catch (error) {
    for (const uri of staged) await r.files.remove(uri).catch(() => {});
    throw error;
  }
}
export async function stageIncoming(r, payloads, id) {
  const copied = payloads.filter((p) => p.staged).map((p) => p.contentUri);
  try {
    if (!payloads.length || payloads.length > 20)
      throw new Error("Share between 1 and 20 files at a time.");
    const items = payloads.map((p, index) => {
      if (
        !["file", "image", "audio", "video"].includes(p.shareType) ||
        (!p.staged && !/^(file:\/|content:\/\/)/.test(p.contentUri || ""))
      )
        throw new Error("Share the exported file, rather than a link or text.");
      const key = `${id}-${index}`;
      return {
        id: key,
        name: incomingName(p, index),
        staged: !!p.staged,
        source: p.staged ? null : new URL(p.contentUri).href,
        expectedSize: p.contentSize,
        uri: p.staged ? p.contentUri : r.files.incoming(key),
      };
    });
    const sources = items
      .filter((item) => item.source)
      .map((item) => item.source);
    if (new Set(sources).size !== sources.length)
      throw new Error(
        "These shared files use the same temporary name. Share them one at a time.",
      );
    for (const item of items) {
      const stat = await r.files.stat(item.staged ? item.uri : item.source);
      if (!stat || stat.directory)
        throw new Error(
          "The shared file is no longer available. Share it again.",
        );
      if (
        Number.isFinite(item.expectedSize) &&
        item.expectedSize >= 0 &&
        stat.size !== item.expectedSize
      )
        throw new Error(
          "The shared file is incomplete. Export and share it again.",
        );
      if (!item.staged) {
        await r.space(stat.size);
        await r.files.mkdir(r.files.parent(item.uri));
        copied.push(item.uri);
        await r.files.copy(item.source, item.uri);
      }
      item.size = stat.size;
      item.renameRequired = !!incomingFilenameError(item.name);
      delete item.staged;
      delete item.source;
      delete item.expectedSize;
    }
    return items;
  } catch (error) {
    for (const uri of copied) await r.files.remove(uri);
    throw error;
  }
}
// A share is one transient operation. Disk copies only bridge temporary sender
// permissions; they are never restored as a pending inbox on the next launch.
export class IncomingSession {
  constructor(runtime) {
    this.runtime = runtime;
    this.items = [];
    this.generation = 0;
  }
  async receive(payloads, id) {
    const cleanup = this.cancel();
    const generation = this.generation;
    await cleanup;
    if (generation !== this.generation) return null;
    try {
      const resolved =
        typeof payloads === "function" ? await payloads() : payloads;
      if (generation !== this.generation) {
        await Promise.all(
          resolved
            .filter((p) => p.staged)
            .map((p) => this.runtime.files.remove(p.contentUri)),
        );
        return null;
      }
      const items = await stageIncoming(this.runtime, resolved, id);
      if (generation !== this.generation) {
        await Promise.all(
          items.map((item) => this.runtime.files.remove(item.uri)),
        );
        return null;
      }
      this.items = items;
      return items;
    } catch (error) {
      if (generation !== this.generation) return null;
      throw error;
    }
  }
  async saved(item) {
    this.items = this.items.filter((i) => i.id !== item.id);
    await this.runtime.files.remove(item.uri);
    return this.items;
  }
  async cancel() {
    this.generation++;
    const items = this.items;
    this.items = [];
    const results = await Promise.allSettled(
      items.map((item) => this.runtime.files.remove(item.uri)),
    );
    const failed = results.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
  }
}

export async function clearIncoming(runtime) {
  await runtime.files.clearIncoming();
}
