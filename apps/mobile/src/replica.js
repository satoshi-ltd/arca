import { GalleryDeletions } from "./gallery-deletions.js";
import { remoteView, warmViews } from "./remote-views.js";
import { abortRequest, abortable } from "./request-control.js";
import { renamedPath } from "../../../packages/core/file-rename.js";
import { DAMAGED_GALLERY, validPath, validRow } from "./validation.js";
import { Gallery, galleryConfig } from "./gallery.js";
import {
  folderExclusion,
  isMusicFolder,
  publishMusic,
  refreshMusic,
} from "./music-sync.js";
import * as playlists from "../../../packages/core/playlist.js";
import {
  conditionNotices,
  isHubUnreachable,
} from "../../desktop/src/notice-contract.js";
import { entryKey, directoryItem } from "../../../packages/core/entries.js";
import {
  builtinExcluded,
  FIXED_POLICY,
} from "../../../packages/core/builtin-exclusions.js";
import ignore from "../../../packages/vendor/ignore/index.cjs";
export const CHUNK = 1024 * 1024;
export const HEADROOM = 256 * 1024 * 1024;
export { validPath, validRow } from "./validation.js";
export const VERIFY_MS = 3000;
export const OFFLINE_HOLD_MS = 5 * 60000;
export const PROGRESS_MS = 1000;
const WEEK = 7 * 86400000;
export const reverifyAfter = (hash) =>
  WEEK + ((parseInt(String(hash).slice(0, 8), 16) || 0) % WEEK);
const blockTimeout = (length) => 15000 + Math.ceil(length / 32768) * 1000;
const transientSnapshot = (error) =>
  ["SNAPSHOT_BUSY", "SNAPSHOT_EXPIRED"].includes(error?.code);

export class Replica {
  constructor({
    store,
    files,
    client,
    notify = async () => {},
    changed = () => {},
    platform = "mobile",
    media = null,
    player = null,
    transfer = { begin: async () => false, end: async () => {} },
  }) {
    Object.assign(this, { store, files, changed, platform, transfer, player });
    this.interactiveClient = client;
    // Only replica work inherits this cancellation scope; UI uses the original client.
    this.client = {
      ...client,
      state: () => client.state(),
      raw: (route, options = {}) =>
        client.raw(route, { ...options, signal: this.syncAbort?.signal }),
      api: (route, body) =>
        client.api(route, body, { signal: this.syncAbort?.signal }),
      refresh: () => client.refresh({ signal: this.syncAbort?.signal }),
    };
    // OS notification delivery must never prevent durable sync acknowledgement.
    this.notify = async (...args) => {
      try {
        await notify(...args);
      } catch {
        /* The in-app error remains visible. */
      }
    };
    this.gallery = new Gallery(this, media);
    this.galleryDeletions = new GalleryDeletions(this);
    this.busy = false;
    this.folderChanges = new Map();
    this.stopped = false;
    this.progress = null;
    this.scope = null;
    this.error = null;
    this.connectionChecked = false;
    this.connectionEpoch = 0;
    this.active = null;
    this.forceNext = false;
    this.hashCache = new Map();
    this.journalCut = new Map();
    this.verified = new Set();
    this.lastInventory = new Map();
    this.lastFullScan = 0;
    this.offlineHoldMs = OFFLINE_HOLD_MS;
    this.retryDelay = (attempt) => Math.min(30000, 2000 * 2 ** attempt);
    this.progressAt = 0;
  }
  reportProgress(progress) {
    this.progress = progress;
    if (
      progress.bytesDone < progress.bytesTotal &&
      Date.now() - this.progressAt < PROGRESS_MS
    )
      return;
    this.progressAt = Date.now();
    this.changed();
  }
  remoteView(route, options) {
    return remoteView(this, route, options);
  }
  async load() {
    await this.store.init();
    if (await this.store.get("destroyPending", false)) {
      try {
        await this.finishDestroy();
      } catch (error) {
        this.error = `Erasing this device is incomplete. Retry Erase this device. ${error.message}`;
      }
    }
    this.scope = await this.store.get("scope");
    await this.store.clearInterrupted(this.scope);
    if (this.files.clearGalleryStage && this.scope)
      for (const folder of await this.store.folders(this.scope))
        if (galleryConfig(folder)) {
          await this.files.clearGalleryStage(this.scope, folder.id);
          const source = galleryConfig(folder);
          if (source.mode === "damaged") continue;
          if (/^(Request cancelled|Sync paused)$/.test(source.issue || ""))
            source.issue = null;
          source.summary = await this.store.gallerySummary(
            this.scope,
            folder.id,
          );
          await this.store.setGallery(this.scope, folder.id, source);
        }
    this.paused = await this.store.get("paused", false);
    this.lastFullScan = await this.store.get(`fullScan:${this.scope}`, 0);
  }
  async requireActiveReplica() {
    if (await this.store.get("destroyPending", false))
      throw new Error(
        "Erasing this device is pending. Retry Erase this device before continuing.",
      );
  }
  async finishDestroy() {
    await this.files.destroy();
    await this.client.destroy();
    await this.store.reset();
    this.scope = null;
    await this.musicPublishing?.catch(() => {});
    await this.musicHistoryWriting?.catch(() => {});
    for (const target of [this.files.musicLibrary?.(), this.files.musicHistory?.()])
      if (target) await this.files.remove(target).catch(() => {});
    this.publishedMusic = null;
    this.journalCut = new Map();
    try {
      await this.player?.reload?.();
    } catch {}
    this.paused = false;
    this.error = this.progress = null;
    this.hashCache.clear();
    this.verified.clear();
    this.lastFullScan = 0;
  }
  async destroy(confirmed = false) {
    if (!confirmed)
      throw new Error("Confirm erasing this device first");
    if (this.removing || this.importing || this.renaming)
      throw new Error("Wait for the current operation to finish.");
    this.removing = true;
    this.stop();
    try {
      if (this.active) await this.active;
      await this.store.set("destroyPending", true);
      await this.finishDestroy();
    } finally {
      this.removing = false;
      this.changed();
    }
  }
  check() {
    if (this.stopped || this.paused) {
      const error = new Error("Sync paused");
      error.code = "SYNC_INTERRUPTED";
      throw error;
    }
  }
  async pause(value) {
    await this.requireActiveReplica();
    this.paused = value;
    this.stopped = value;
    if (value) this.stop();
    await this.store.set("paused", value);
    this.changed();
  }
  stop() {
    this.stopped = true;
    if (this.syncAbort)
      abortRequest(
        this.syncAbort,
        Object.assign(new Error("Sync paused"), { code: "SYNC_INTERRUPTED" }),
      );
  }
  waitToRetry(ms) {
    const signal = this.syncAbort?.signal;
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        this.retryNow = null;
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal?.addEventListener("abort", done);
      this.retryNow = done;
    });
  }
  suspend() {
    this.stop();
    this.interactiveClient.cancelRefresh("sync");
  }
  async settle() {
    this.stop();
    if (this.active) await this.active;
  }
  releaseSnapshot(session) {
    void this.interactiveClient
      .api("/v1/snapshot-release", { session }, { timeout: 3000 })
      .catch(() => {});
  }
  checkTransferTurn() {
    this.check();
    // Slow local preparation must not consume the next network transfer's turn.
    if (this.turnDeadline && !this.turnTransferred)
      this.turnDeadline = Date.now() + 10000;
    this.turnTransferred = true;
    if (this.turnDeadline && Date.now() >= this.turnDeadline)
      throw Object.assign(new Error("Continuing next turn"), {
        code: "SYNC_YIELD",
      });
  }
  async space(bytes) {
    if ((await this.files.free()) < bytes + HEADROOM)
      throw new Error("Not enough storage. Free space to continue.");
  }
  async select(volume) {
    await this.requireActiveReplica();
    if (!this.scope) throw new Error("Connect to a hub first");
    if (await this.store.get(`removing:${this.scope}:${volume.id}`, false))
      throw new Error(
        "Remove the remaining local copy before selecting this folder again.",
      );
    await this.space(volume.bytes * 2);
    await this.files.mkdir(this.files.folder(this.scope, volume.id));
    await this.store.select(this.scope, volume);
    this.changed();
  }
  async unselect(id) {
    await this.requireActiveReplica();
    if (this.removing || this.importing)
      throw new Error("Wait for the current operation to finish.");
    this.removing = true;
    try {
      this.stop();
      if (this.active) await this.active;
      this.busy = true;
      const scope = this.scope;
      const folder = await this.store.folder(scope, id);
      if (!folder) return;
      const removalKey = `removing:${scope}:${id}`;
      // The UI confirms permanent local removal, including unsynced changes.
      // Persist before deletion so interruption can be retried safely.
      await this.store.set(removalKey, true);
      const removedHashes = new Set(
        (await this.store.rows(scope, id)).map((row) => row.hash),
      );
      if (this.files.clearGalleryStage)
        await this.files.clearGalleryStage(scope, id);
      await this.files.removeFolder(scope, id);
      await this.store.forgetFolder(scope, id);
      await this.store.set(`journal:${scope}:${id}`, []);
      await this.store.set(removalKey, false);
      this.hashCache.clear();
      await this.cleanTransferObjects(scope, removedHashes);
      await publishMusic(this).catch(() => {});
    } catch (error) {
      if (await this.store.get(`removing:${this.scope}:${id}`, false))
        await this.store.issue(
          this.scope,
          id,
          "Local removal incomplete. Retry removing this folder.",
        );
      throw error;
    } finally {
      this.busy = false;
      this.removing = false;
      this.changed();
    }
  }
  // Working copies hold every file once; objects exist only while a transfer still needs them.
  async cleanTransferObjects(scope, removedHashes = new Set()) {
    const retained = new Set(await this.store.transferHashes(scope));
    for (const location of ["object", "partial"]) {
      const root = this.files.parent(
        this.files[location](scope, "0".repeat(64)),
      );
      if (!(await this.files.exists(root))) continue;
      for await (const entry of this.files.walk(root)) {
        if (
          /^[a-f0-9]{64}$/.test(entry.path) &&
          !retained.has(entry.path) &&
          (location === "object" || removedHashes.has(entry.path))
        ) {
          this.verified.delete(entry.uri);
          await this.files.remove(entry.uri);
        }
      }
    }
  }
  async download(hash, size) {
    if (!this.client.state().catalog?.blobRanges)
      throw new Error(
        "Update your hub to a release with mobile transfer support before downloading files.",
      );
    const object = this.files.object(this.scope, hash);
    if (await this.files.exists(object)) {
      if ((await this.files.hash(object)) === hash) return object;
      this.verified.delete(object);
      await this.files.remove(object);
    }
    const tmp = this.files.partial(this.scope, hash);
    await this.files.mkdir(this.files.parent(tmp));
    let offset = (await this.files.stat(tmp))?.size || 0;
    if (offset > size) {
      await this.files.remove(tmp);
      offset = 0;
    }
    await this.space(size - offset);
    if (!(await this.files.exists(tmp)))
      await this.files.write(tmp, new Uint8Array());
    while (offset < size) {
      this.checkTransferTurn();
      const end = Math.min(offset + CHUNK, size) - 1;
      const response = await this.client.raw(`/v1/blobs/${hash}`, {
        timeout: blockTimeout(end - offset + 1),
        headers: { Range: `bytes=${offset}-${end}` },
        ...(this.client.fileTransfers
          ? {
              transfer: {
                destination: tmp,
                offset: String(offset),
                length: String(end - offset + 1),
                range: `bytes ${offset}-${end}/${size}`,
              },
            }
          : {}),
      });
      if (
        response.status !== 206 ||
        response.headers.get("content-range") !==
          `bytes ${offset}-${end}/${size}`
      )
        throw new Error("The hub did not return the requested file block");
      const data = this.client.fileTransfers
        ? null
        : new Uint8Array(await response.arrayBuffer());
      if ((data?.length ?? response.bytesWritten) !== end - offset + 1)
        throw new Error("Incomplete download block");
      if (data) await this.files.write(tmp, data, offset);
      offset = end + 1;
      this.reportProgress({
        direction: "download",
        bytesDone: offset,
        bytesTotal: size,
      });
    }
    if ((await this.files.hash(tmp)) !== hash) {
      await this.files.remove(tmp);
      throw new Error("File verification failed. Retry to download it again.");
    }
    await this.files.mkdir(this.files.parent(object));
    await this.files.move(tmp, object);
    return object;
  }
  async snapshotLocal(volume, path, file, base) {
    const hash = await this.files.hash(file),
      size = (await this.files.stat(file)).size;
    this.check();
    const object = this.files.object(this.scope, hash);
    await this.space(size);
    if (!(await this.files.exists(object))) {
      await this.files.mkdir(this.files.parent(object));
      await this.files.copy(file, object);
      this.check();
    }
    if ((await this.files.hash(object)) !== hash)
      throw new Error("File changed while reading. Retry synchronization.");
    this.verified.add(object);
    this.pulling?.retained.add(hash);
    await this.store.queue(this.scope, { volume, path, base, hash, size });
  }
  async syncIgnore(folder) {
    const { versions } = await this.client.api(
      `/v1/history?volume=${folder.id}&path=.arcaignore&limit=1`,
    );
    const remote = versions[0],
      file = this.files.work(this.scope, folder.id, ".arcaignore");
    const present = await this.files.exists(file),
      local = present ? await this.files.hash(file) : null;
    if (present && (await this.files.stat(file)).size > 65536)
      throw new Error(".arcaignore exceeds 64 KiB");
    const known = await this.store.current(
      this.scope,
      folder.id,
      ".arcaignore",
    );
    if (remote?.deleted && known && !known.deleted) {
      if (present && local !== known.hash)
        throw new Error(
          ".arcaignore was edited locally while deleted on the hub. Resolve the policy before retrying.",
        );
      await this.apply(validRow(remote, folder.id));
    }
    if (
      remote &&
      !remote.deleted &&
      remote.hash !== local &&
      remote.hash !== known?.hash
    ) {
      if (remote.size > 65536)
        throw new Error("Remote .arcaignore exceeds 64 KiB");
      if (
        present &&
        (known ? local !== known.hash : (await this.files.stat(file)).size > 0)
      )
        throw new Error(
          ".arcaignore differs from the hub. Use the same rules before syncing.",
        );
      await this.apply(validRow(remote, folder.id));
    }
    const exists = await this.files.exists(file);
    const text = exists ? await this.files.text(file) : "";
    this.policy = ignore({ ignorecase: true }).add(text);
    const policy = `${FIXED_POLICY}\n${exists ? await this.files.hash(file) : ""}`;
    const key = `policy:${this.scope}:${folder.id}`;
    if ((await this.store.get(key)) !== policy) {
      // Persist reconciliation before accepting the policy, including across crashes.
      await this.store.forgetExcluded(
        this.scope,
        folder.id,
        (name, directory) =>
          builtinExcluded(name) ||
          (name !== ".arcaignore" &&
            this.policy.ignores(name + (directory ? "/" : ""))),
      );
      await this.store.resetCursor(this.scope, folder.id);
      folder.initialized = 0;
      folder.cursor = 0;
      await this.store.set(key, policy);
    }
  }
  hashKey(uri, volume, path) {
    return volume && path ? this.files.work(this.scope, volume, path) : uri;
  }
  async cachedRecord(key) {
    return this.hashCache.get(key) || (await this.store.cachedHash(key));
  }
  async rememberHash(key, uri, stat, hash, volume = null, path = null, due) {
    const record = {
      size: stat.size,
      mtime: stat.mtime,
      hash,
      due: due ?? Date.now() + reverifyAfter(hash),
      ...(volume && path ? { scope: this.scope, volume, path, uri } : {}),
    };
    this.hashCache.set(key, record);
    await this.store.cacheHash(key, record);
  }
  async forgetHash(key) {
    this.hashCache.delete(key);
    await this.store.forgetHash(key);
  }
  async localHash(uri, volume = null, path = null) {
    const stat = await this.files.stat(uri);
    const key = this.hashKey(uri, volume, path);
    const fresh = (record) =>
      stat?.mtime != null &&
      record?.size === stat.size &&
      record.mtime === stat.mtime;
    const cached = await this.cachedRecord(key);
    if (fresh(cached)) {
      if (volume && path && (!cached.due || cached.uri !== uri))
        await this.rememberHash(key, uri, stat, cached.hash, volume, path, cached.due);
      return cached.hash;
    }
    if (stat?.directory) return "directory";
    const hash = await this.files.hash(uri);
    const after = await this.files.stat(uri);
    if (!after || after.size !== stat.size || after.mtime !== stat.mtime)
      throw new Error("File changed while being checked. Sync will retry.");
    await this.rememberHash(key, uri, stat, hash, volume, path);
    return hash;
  }
  async verifyHashes(folders, deadline) {
    let changed = false;
    for (const folder of folders)
      try {
        while (Date.now() < deadline) {
          const due = await this.store.dueHashes(
            this.scope,
            folder.id,
            Date.now(),
            32,
          );
          if (!due.length) break;
          for (const { key, record } of due) {
            this.check();
            if (Date.now() >= deadline) return changed;
            if (!(await this.verifyHash(key, record))) {
              this.lastInventory.delete(folder.id);
              changed = true;
            }
          }
        }
      } catch (error) {
        if (error.code === "SYNC_INTERRUPTED") throw error;
        await this.store
          .issue(this.scope, folder.id, `Could not check local files: ${error.message}`)
          .catch(() => {});
      }
    return changed;
  }
  async verifyHash(key, record) {
    const uri = record.uri || key;
    const stat = await this.files.stat(uri);
    if (
      !stat ||
      stat.directory ||
      stat.size !== record.size ||
      stat.mtime !== record.mtime
    ) {
      await this.forgetHash(key);
      return false;
    }
    let hash;
    try {
      hash = await this.files.hash(uri);
    } catch {
      await this.forgetHash(key);
      return false;
    }
    const after = await this.files.stat(uri);
    if (!after || after.size !== stat.size || after.mtime !== stat.mtime) {
      await this.forgetHash(key);
      return false;
    }
    await this.rememberHash(key, uri, stat, hash, record.volume, record.path);
    return hash === record.hash;
  }
  async scan(folder) {
    const root = this.files.folder(this.scope, folder.id);
    const rows = await this.store.rows(this.scope, folder.id);
    const names = new Set();
    const foldedNames = new Set();
    const heads = new Map();
    for (const row of [...rows].sort(
      (a, b) => b.deleted - a.deleted || a.rev - b.rev,
    ))
      heads.set(row.path.toLowerCase(), row);
    const queued = new Set();
    const waiting = new Map(
      (await this.store.pending(this.scope, folder.id)).map((op) => [
        op.path,
        op,
      ]),
    );
    const policyPath = this.files.work(this.scope, folder.id, ".arcaignore");
    const policy = ignore().add(
      (await this.files.exists(policyPath))
        ? await this.files.text(policyPath)
        : "",
    );
    const excluded = (name) =>
      builtinExcluded(name) || (name !== ".arcaignore" && policy.ignores(name));
    // A missing root is not a deletion of every file.
    if (!(await this.files.exists(root)))
      throw new Error("Local folder is unavailable");
    for await (const entry of this.files.walk(root)) {
      this.check();
      try {
        entry.path = validPath(entry.path);
      } catch {
        throw new Error(
          `Rename "${entry.path}" without reserved characters or trailing spaces/dots, then retry.`,
        );
      }
      if (names.has(entry.path))
        throw new Error(
          `Multiple Unicode spellings exist for "${entry.path}". Rename one before retrying.`,
        );
      names.add(entry.path);
      foldedNames.add(entry.path.toLowerCase());
      if (excluded(entry.path + (entry.directory ? "/" : ""))) continue;
      const previous = heads.get(entry.path.toLowerCase());
      if (previous?.unapplied) continue;
      const hash = entry.directory
        ? "directory"
        : await this.localHash(entry.uri, folder.id, entry.path);
      if (entry.directory) {
        if (
          previous?.path !== entry.path ||
          entryKey(previous) !== "directory"
        ) {
          queued.add(entry.path);
          await this.store.queue(this.scope, {
            volume: folder.id,
            path: entry.path,
            base: previous?.rev || 0,
            ...directoryItem(),
          });
        }
      } else if (
        !previous ||
        previous.path !== entry.path ||
        previous.deleted ||
        previous.hash !== hash
      ) {
        queued.add(entry.path);
        const op = waiting.get(entry.path);
        if (
          op?.hash === hash &&
          op.base === (previous?.rev || 0) &&
          (await this.files.exists(this.files.object(this.scope, hash)))
        )
          continue;
        await this.snapshotLocal(
          folder.id,
          entry.path,
          entry.uri,
          previous?.rev || 0,
        );
      }
    }
    for (const row of rows.sort((a, b) => b.path.localeCompare(a.path)))
      if (
        !row.deleted &&
        !row.unapplied &&
        !excluded(row.path + (row.directory ? "/" : "")) &&
        !names.has(row.path) &&
        !foldedNames.has(row.path.toLowerCase())
      ) {
        queued.add(row.path);
        await this.store.queue(this.scope, {
          volume: folder.id,
          path: row.path,
          base: row.rev,
          hash: null,
          size: 0,
        });
      }
    // Only discard superseded operations after a complete successful inventory.
    for (const op of await this.store.pending(this.scope, folder.id))
      if (!queued.has(op.path))
        await this.store.dequeue(this.scope, folder.id, op.path);
  }
  async upload(op, source = null, verifiedOriginal = false) {
    const object = source || this.files.object(this.scope, op.hash);
    if (!(verifiedOriginal && source) && !this.verified.has(object)) {
      if ((await this.files.hash(object)) !== op.hash)
        throw new Error("Queued upload failed verification");
      if (!source) this.verified.add(object);
    }
    let { offset, complete } = await this.client.api(`/v1/uploads/${op.hash}`);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > op.size)
      throw new Error("Invalid upload offset");
    while (!complete) {
      this.checkTransferTurn();
      const data = this.client.fileTransfers
        ? null
        : await this.files.read(
            object,
            offset,
            Math.min(CHUNK, op.size - offset),
          );
      const response = await this.client.raw(
        `/v1/uploads/${op.hash}?offset=${offset}&size=${op.size}`,
        {
          method: "PUT",
          timeout: blockTimeout(Math.min(CHUNK, op.size - offset)),
          ...(this.client.fileTransfers
            ? {
                transfer: {
                  source: object,
                  offset: String(offset),
                  length: String(Math.min(CHUNK, op.size - offset)),
                },
              }
            : { body: data }),
        },
      );
      const next = await response.json();
      if (!next.complete && (next.offset <= offset || next.offset > op.size))
        throw new Error("Invalid upload progress");
      offset = next.offset;
      complete = next.complete;
      this.reportProgress({
        direction: "upload",
        bytesDone: offset,
        bytesTotal: op.size,
      });
    }
  }
  async push(folder) {
    for (const op of (await this.store.pending(this.scope, folder.id)).sort(
      (a, b) => {
        const da = !a.hash && !a.directory,
          db = !b.hash && !b.directory;
        return da !== db
          ? Number(db) - Number(da)
          : da
            ? b.path.localeCompare(a.path)
            : a.path.localeCompare(b.path);
      },
    )) {
      this.check();
      if (
        builtinExcluded(op.path) ||
        (op.path !== ".arcaignore" && this.policy?.ignores(op.path))
      ) {
        await this.store.dequeue(this.scope, folder.id, op.path);
        continue;
      }
      if (op.hash)
        await this.upload(op).catch((error) => {
          if (
            !isHubUnreachable(error) &&
            !["SYNC_INTERRUPTED", "SYNC_YIELD"].includes(error.code)
          )
            this.verified.delete(this.files.object(this.scope, op.hash));
          throw error;
        });
      const result = await this.client.api("/v1/propose", op);
      // The acknowledged source hash is the baseline for safe materialization.
      if (result.row)
        await this.store.put(this.scope, {
          ...result.row,
          localHash: op.hash,
          ...(result.conflict && { unapplied: true }),
        });
      await this.store.dequeue(this.scope, folder.id, op.path);
    }
  }
  async apply(row, recovering = false, aliases = null) {
    if (builtinExcluded(row.path)) return;
    if (
      !recovering &&
      row.path !== ".arcaignore" &&
      this.policy?.ignores(row.path + (row.directory ? "/" : ""))
    )
      return;
    const current = await this.store.current(this.scope, row.volume, row.path);
    // Resumed snapshots predate rows pushed since; the change feed after `through` delivers them.
    if (!recovering && current && row.rev < current.rev) return;
    const target = this.files.work(this.scope, row.volume, row.path);
    if (row.deleted && row.replacementPath) {
      await this.store.applied(this.scope, row);
      return;
    }
    if (!row.deleted) {
      const alias = (
        aliases || (await this.store.rows(this.scope, row.volume))
      ).find(
        (r) =>
          r.path !== row.path &&
          r.path.toLowerCase() === row.path.toLowerCase(),
      );
      if (alias) {
        const source = this.files.work(this.scope, row.volume, alias.path);
        if (await this.files.exists(source)) {
          const root = this.files.folder(this.scope, row.volume);
          let oldExact = false,
            newExact = false;
          for await (const entry of this.files.walk(root)) {
            oldExact ||= entry.path === alias.path;
            newExact ||= entry.path === row.path;
          }
          if (oldExact && newExact)
            throw new Error(
              `Both spellings exist: ${alias.path} and ${row.path}. Rename one before retrying.`,
            );
          if (oldExact) {
            await this.files.mkdir(this.files.parent(target));
            await this.files.move(source, target);
            this.touch(row.volume);
          }
        }
      }
    }
    let exists = await this.files.exists(target);
    let info = exists ? await this.files.stat(target) : null;
    if (!row.deleted && exists && !!row.directory !== !!info?.directory) {
      if (
        !current ||
        current.deleted ||
        !!current.directory === !!row.directory
      )
        throw new Error(`Path type conflicts with local content: ${row.path}`);
      if (info.directory) await this.files.removeDirectory(target);
      else {
        const actual = await this.files.hash(target);
        if (actual !== (current.localHash ?? current.hash)) {
          const conflict = `${row.path}.conflict-mobile-${actual.slice(0, 12)}`;
          const kept = this.files.work(this.scope, row.volume, conflict);
          await this.files.copy(target, kept);
          await this.snapshotLocal(row.volume, conflict, kept, 0);
        }
        await this.files.remove(target);
      }
      exists = false;
      info = null;
    }
    if (row.directory) {
      if (exists && !info?.directory)
        throw new Error(
          "Directory conflicts with a local file; reconcile it first.",
        );
      await this.store.journal(this.scope, row);
      if (row.deleted) {
        if (exists) {
          await this.files.removeDirectory(target);
          this.touch(row.volume);
        }
      } else {
        await this.files.mkdir(target);
        if (!exists) this.touch(row.volume);
      }
      await this.store.applied(this.scope, row);
      return;
    }
    if (info?.directory)
      throw new Error(
        "File conflicts with a local directory; reconcile it first.",
      );
    let actual = exists
      ? await this.localHash(target, row.volume, row.path)
      : null;
    // Recovery must rewrite its journal even when revision and bytes already match.
    if (
      !recovering &&
      !row.deleted &&
      current?.rev === row.rev &&
      current.hash === row.hash &&
      actual === row.hash
    ) {
      if (current.unapplied) await this.store.put(this.scope, row);
      return;
    }
    // A size/mtime cache hit cannot prove a file is unedited before it is replaced or removed.
    if (
      exists &&
      actual !== row.hash &&
      actual === (current?.localHash ?? current?.hash)
    )
      actual = await this.files.hash(target);
    if (
      actual &&
      actual !== row.hash &&
      actual !== (current?.localHash ?? current?.hash)
    ) {
      // An edit made after scanning remains a separate local file, including after crashes.
      const conflict = `${row.path}.conflict-mobile-${actual.slice(0, 12)}`;
      const kept = this.files.work(this.scope, row.volume, conflict);
      if (!(await this.files.exists(kept))) await this.files.copy(target, kept);
      await this.snapshotLocal(row.volume, conflict, kept, 0);
    }
    await this.store.journal(this.scope, row);
    if (row.deleted) {
      if (exists) {
        await this.files.remove(target);
        this.touch(row.volume);
      }
    } else if (actual !== row.hash) {
      const pulling = this.pulling;
      await this.files.mkdir(this.files.parent(target));
      const temp = this.files.parent(target) + "/.arca-transfer-" + row.hash;
      await this.files.remove(temp);
      const placed = pulling?.placed.get(row.hash);
      const source =
        placed &&
        placed !== target &&
        (await this.files.exists(placed)) &&
        (await this.files.hash(placed)) === row.hash
          ? placed
          : null;
      const object = source ?? (await this.download(row.hash, row.size));
      if (pulling && !source && !pulling.retained.has(row.hash)) {
        this.verified.delete(object);
        await this.files.move(object, temp);
        pulling.placed.set(row.hash, target);
      } else {
        await this.space(row.size);
        await this.files.copy(object, temp);
      }
      await this.files.replace(temp, target);
      this.touch(row.volume);
      const landed = await this.files.stat(target);
      if (landed?.mtime != null)
        await this.rememberHash(target, target, landed, row.hash, row.volume, row.path);
    }
    await this.store.applied(this.scope, row);
  }
  async recoverApplying(volume) {
    const journaled = (await this.store.applying(this.scope, volume)).sort(
      (a, b) => b.path.localeCompare(a.path),
    );
    if (!journaled.length) return false;
    const rows = await this.store.rows(this.scope, volume);
    let awaiting = false;
    for (const row of journaled)
      if (await this.awaitsDownload(row, rows)) awaiting = true;
      else await this.apply(row, true);
    return awaiting;
  }
  // Defer only when the working file still holds its acknowledged baseline, or is absent with no live row, so scan cannot propose an edit or deletion.
  async awaitsDownload(row, rows) {
    if (row.deleted || row.directory || builtinExcluded(row.path)) return false;
    const folded = row.path.toLowerCase();
    if (
      rows.some(
        (other) =>
          other.path !== row.path && other.path.toLowerCase() === folded,
      )
    )
      return false;
    const target = this.files.work(this.scope, row.volume, row.path);
    const info = await this.files.stat(target);
    const current = rows.find((other) => other.path === row.path);
    if (!info) return !current || !!current.deleted;
    if (info.directory || !current || current.deleted || current.directory)
      return false;
    const actual = await this.localHash(target, row.volume, row.path);
    return (
      actual !== row.hash && actual === (current.localHash ?? current.hash)
    );
  }
  touch(volume) {
    this.folderChanges.set(volume, (this.folderChanges.get(volume) || 0) + 1);
  }
  async pull(folder) {
    this.pulling = {
      retained: new Set(await this.store.transferHashes(this.scope)),
      placed: new Map(),
    };
    try {
      return await this.pullFolder(folder);
    } finally {
      this.pulling = null;
    }
  }
  async pullFolder(folder) {
    let through;
    let directoryDeletes = [];
    let deferredFiles = [];
    // Tombstones stay in the alias index; apply() has always matched case aliases against them.
    let aliases = null;
    const remember = (row) => {
      const key = row.path.toLowerCase();
      const paths = aliases.get(key) || [];
      if (!paths.some((entry) => entry.path === row.path))
        paths.push({ path: row.path });
      paths.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      aliases.set(key, paths);
    };
    const materialize = async (row) => {
      if (!aliases) {
        aliases = new Map();
        for (const known of await this.store.rows(this.scope, folder.id))
          remember(known);
      }
      await this.apply(row, false, aliases.get(row.path.toLowerCase()) || []);
      remember(row);
    };
    const defer = (list, row) => {
      const index = list.findIndex((entry) => entry.path === row.path);
      if (index < 0) list.push(row);
      else list[index] = row;
    };
    const apply = async (row) => {
      validRow(row, folder.id);
      if (row.directory && row.deleted) defer(directoryDeletes, row);
      else if (
        !row.deleted &&
        !row.directory &&
        (
          await this.files.stat(
            this.files.work(this.scope, row.volume, row.path),
          )
        )?.directory
      )
        defer(deferredFiles, row);
      else await materialize(row);
    };
    if (!folder.initialized) {
      const saved = await this.store.snapshotCursor(this.scope, folder.id);
      for (let restarted = false; ; restarted = true) {
        const resume = !restarted && saved?.session ? saved : null;
        let session = resume?.session || null,
          after = resume?.after || "",
          paused = false;
        if (resume) {
          through = resume.through;
          directoryDeletes = resume.directoryDeletes || [];
          deferredFiles = resume.deferredFiles || [];
        } else {
          through = (
            await this.client.api(`/v1/changes?volume=${folder.id}&after=0`)
          ).through;
          directoryDeletes = [];
          deferredFiles = [];
        }
        try {
          do {
            this.check();
            const q = new URLSearchParams({
              volume: folder.id,
              limit: "250",
              ...(session ? { session, after } : {}),
            });
            const page = await this.client.api(`/v1/snapshot?${q}`);
            session = page.session;
            for (const row of page.files) {
              this.check();
              await apply(row);
            }
            after = page.next;
          } while (after);
          await this.store.saveSnapshotCursor(this.scope, folder.id, null);
          break;
        } catch (error) {
          if (
            session &&
            (["SYNC_YIELD", "SYNC_INTERRUPTED"].includes(error?.code) ||
              isHubUnreachable(error))
          ) {
            await this.store.saveSnapshotCursor(this.scope, folder.id, {
              session,
              after,
              through,
              directoryDeletes,
              deferredFiles,
            });
            paused = true;
            throw error;
          }
          if (restarted || error?.status !== 409 || !transientSnapshot(error)) {
            await this.store.saveSnapshotCursor(this.scope, folder.id, null);
            throw error;
          }
          session = null;
        } finally {
          if (session && !paused) this.releaseSnapshot(session);
        }
      }
    } else {
      let after = folder.cursor;
      do {
        this.check();
        const q = new URLSearchParams({
          volume: folder.id,
          after: String(after),
          ...(through === undefined ? {} : { through: String(through) }),
        });
        const page = await this.client.api(`/v1/changes?${q}`);
        through = page.through;
        for (const row of page.files) {
          this.check();
          await apply(row);
        }
        after = page.next;
      } while (after !== null);
    }
    for (const row of directoryDeletes.sort((a, b) =>
      b.path.localeCompare(a.path),
    ))
      await materialize(row);
    for (const row of deferredFiles) await materialize(row);
    if (!Number.isSafeInteger(through) || through < 0)
      throw new Error("Invalid synchronization cursor");
    if ((await this.store.pending(this.scope, folder.id)).length)
      throw new Error(
        "Local changes are waiting to upload. Sync again to finish.",
      );
    await this.store.complete(this.scope, folder.id, through);
  }
  async rename(name) {
    await this.requireActiveReplica();
    name = typeof name === "string" ? name.trim() : "";
    if (!name || name.length > 100 || /[\x00-\x1f\x7f]/.test(name))
      throw new Error("Enter a device name between 1 and 100 characters.");
    this.nameReportError = null;
    await this.store.set("name", name);
    this.changed();
    try {
      if (!this.client.state().connection || this.hubUnavailable) return false;
      await this.report(this.interactiveClient, { timeout: 5000 });
      this.nameReportError = null;
      return true;
    } catch (error) {
      this.nameReportError = error.message;
      // The saved name is sent again with the next machine report.
      return false;
    }
  }
  async report(client = this.client, options) {
    const selected = (await this.store.folders(this.scope)).filter(
      (f) => f.selected,
    );
    const folders = selected;
    const albumFolderIds = selected
      .filter((f) => galleryConfig(f))
      .map((f) => f.id);

    const name = await this.store.get(
      "name",
      this.platform === "ios" ? "iPhone" : "Android",
    );
    await client.api("/v1/machine-report", {
      machineId: this.client.state().connection.id,
      name,
      platform: this.platform,
      arch: "",
      kernelRelease: "",
      uptimeSeconds: 0,
      phase: this.paused ? "paused" : this.error ? "error" : "idle",
      lastSync: await this.store.get(`lastSync:${this.scope}`),
      selectedFolders: folders.length,
      folderIds: folders.map((f) => f.id),
      albumFolderIds,
      indexedFiles: folders.reduce((n, f) => n + f.files, 0),
      indexedBytes: folders.reduce((n, f) => n + f.bytes, 0),
    }, options);
  }
  sync(force = false, { scheduled = false } = {}) {
    if (this.picking || this.importing || this.removing || this.renaming)
      return Promise.resolve();
    if (this.active) {
      if (this.stopped && !this.paused)
        return this.active.then(() => this.sync(force, { scheduled }));
      if (force) {
        this.forceNext = true;
        this.retryNow?.();
      }
      return this.active;
    }
    this.lastScheduledAt = Date.now();
    this.scheduled = scheduled;
    this.continuing = false;
    this.force =
      force || this.forceNext || Date.now() - this.lastFullScan > 3600000;
    this.forceNext = false;
    this.syncAbort = new AbortController();
    this.active = (async () => {
      let offlineSince = 0;
      let attempt = 0;
      try {
        for (;;) {
          this.holdingOffline = !!offlineSince;
          await this.cycle();
          // Continuation turns reuse the 60 s inventory; a Sync now tap mid-run queues one scan of every folder.
          this.continuing = true;
          this.force = this.forceNext;
          this.forceNext = false;
          if (this.stopped || this.paused) break;
          if (
            this.hubUnavailable &&
            this.transfer.active &&
            (this.cycleAnswered || offlineSince)
          ) {
            offlineSince ||= Date.now();
            if (Date.now() - offlineSince >= this.offlineHoldMs) break;
            await this.waitToRetry(this.retryDelay(attempt++));
            continue;
          }
          offlineSince = 0;
          attempt = 0;
          if (
            !this.force &&
            !(this.transfer.active && this.moreGalleryWork && !this.error) &&
            !this.moreFolderWork
          )
            break;
        }
      } finally {
        await this.transfer.end();
      }
    })().finally(() => {
      this.active = null;
      this.syncAbort = null;
    });
    return this.active;
  }
  hubAnswered() {
    this.connectionEpoch++;
    this.hubUnavailable = false;
    this.error = null;
    this.connectionChecked = true;
  }
  hubFailed(error) {
    if (["SYNC_INTERRUPTED", "CLIENT_BUSY", "REQUEST_CANCELLED"].includes(error.code))
      return;
    this.connectionChecked = true;
    this.hubUnavailable = isHubUnreachable(error);
    this.error = error.message;
  }
  async refreshCatalog() {
    const pending = this.interactiveClient.refresh({ owner: "sync" });
    const signal = this.syncAbort?.signal;
    try {
      return await (signal ? abortable(() => pending, signal) : pending);
    } catch (error) {
      // A cycle stopped by a local action still learns what the hub answered.
      if (signal?.aborted)
        pending.then(
          () => this.hubAnswered(),
          (failure) => this.hubFailed(failure),
        ).finally(() => this.changed());
      throw error;
    }
  }
  async cycle() {
    if (
      (await this.store.get("destroyPending", false)) ||
      (await this.store.get("onboarding"))
    )
      return;
    this.busy = true;
    this.stopped = false;
    this.moreGalleryWork = false;
    this.moreFolderWork = false;
    this.cycleAnswered = false;
    if (!this.hubUnavailable) this.error = null;
    this.changed();
    try {
      // Acquire before file transfers; after an offline verdict only once the probe succeeds.
      const acquire = async () => {
        if (
          !this.paused &&
          this.client.state().connection?.linked &&
          (await this.store.folders(this.scope)).some(
            (folder) => folder.selected,
          )
        ) {
          await this.transfer.begin();
          this.check();
        }
      };
      const offline = this.connectionChecked && this.hubUnavailable;
      if (!offline) await acquire();
      try {
        await this.refreshCatalog();
      } catch (error) {
        if (!this.holdingOffline) await this.transfer.end().catch(() => {});
        throw error;
      }
      this.hubAnswered();
      this.cycleAnswered = true;
      if (offline) await acquire();
      const connection = this.client.state().connection;
      if (!connection?.linked) return;
      if (this.scope !== connection.hubId) {
        this.scope = connection.hubId;
        await this.store.set("scope", this.scope);
      }
      if (this.hashesPruned !== this.scope) {
        this.hashCache.clear();
        await this.store.pruneHashes(
          this.scope,
          (await this.store.folders(this.scope)).map((folder) =>
            this.files.folder(this.scope, folder.id),
          ),
        );
        this.hashesPruned = this.scope;
      }
      // Publish identity before potentially long file/photo transfers.
      await this.report();
      if (this.paused) return;
      const catalog = this.client.state().catalog;
      if (!catalog.directories || !catalog.pathTransitions)
        throw new Error(
          "Update the hub to synchronize directories and path changes safely.",
        );
      const errors = [];
      const settled = new Set();
      let deferred = false;
      const folders = (await this.store.folders(this.scope))
        .filter((f) => f.selected)
        .sort((a, b) => Number(!!b.initialized) - Number(!!a.initialized));
      if (this.force) {
        this.lastFullScan = Date.now();
        await this.store.set(`fullScan:${this.scope}`, this.lastFullScan);
      }
      for (const folder of folders) {
        this.check();
        if (await this.store.get(`removing:${this.scope}:${folder.id}`, false)) {
          settled.add(folder.id);
          continue;
        }
        if (!catalog.volumes.some((v) => v.id === folder.id)) {
          settled.add(folder.id);
          await this.store.issue(
            this.scope,
            folder.id,
            "This folder is no longer shared by the hub. Export local changes before removing it.",
          );
          continue;
        }
        this.syncingVolume = folder.id;
        this.changed();
        let galleryError = null;
        try {
          this.turnDeadline = Date.now() + 10000;
          this.turnTransferred = false;
          const remote = catalog.volumes.find((v) => v.id === folder.id);
          if (remote.policyError) throw new Error(remote.policyError);
          const album = galleryConfig(folder);
          if (album?.mode === "damaged") throw new Error(album.issue);
          if (album && (!folder.initialized || album.mode === "converting"))
            await this.files.mkdir(this.files.folder(this.scope, folder.id));
          if (album?.mode === "converting") {
            // Recover an interrupted removal from the previous build before scanning:
            // missing working files must not be proposed as shared deletions.
            for (const row of await this.store.rows(this.scope, folder.id))
              if (
                !row.deleted &&
                !(await this.files.exists(
                  this.files.work(this.scope, folder.id, row.path),
                ))
              )
                await this.apply(row, true);
            await this.store.setGallery(this.scope, folder.id, {
              ...album,
              mode: "source",
            });
          }
          this.policy = null;
          const awaiting = await this.recoverApplying(folder.id);
          await this.syncIgnore(folder);
          const journal = (await this.store.get(this.journalKey(folder.id), [])) || [];
          let scanned = false;
          if (
            (!this.scheduled && !this.continuing) ||
            this.force ||
            Date.now() - (this.lastInventory.get(folder.id) || 0) >= 60000 ||
            (await this.store.pending(this.scope, folder.id)).length
          ) {
            await this.scan(folder);
            scanned = true;
            this.lastInventory.set(folder.id, Date.now());
          }
          this.turnDeadline = Date.now() + 10000;
          await this.push(folder);
          // Album uploads run before the download so a large first download cannot starve them.
          if (galleryConfig(folder)) {
            this.turnDeadline = Date.now() + 10000;
            this.turnTransferred = false;
            try {
              await this.gallery.cycle(folder);
            } catch (error) {
              if (error.code === "SYNC_YIELD") this.moreFolderWork = true;
              else if (
                error.code === "SYNC_INTERRUPTED" ||
                isHubUnreachable(error)
              )
                throw error;
              else galleryError = error;
            }
          }
          this.turnDeadline = Date.now() + 10000;
          this.turnTransferred = false;
          if (awaiting) {
            for (const row of (
              await this.store.applying(this.scope, folder.id)
            ).sort((a, b) => b.path.localeCompare(a.path)))
              await this.apply(row, true);
            this.turnDeadline = Date.now() + 10000;
            this.turnTransferred = false;
          }
          await this.pull(await this.store.folder(this.scope, folder.id));
          if (scanned && journal.length)
            if (isMusicFolder(catalog, folder.id))
              this.journalCut.set(folder.id, journal.at(-1).seq);
            else await this.forgetLocal(folder.id, journal.at(-1).seq);
          if (galleryError) throw galleryError;
        } catch (e) {
          if (e.code === "SYNC_YIELD") {
            this.moreFolderWork = true;
            if (galleryError)
              await this.store.issue(this.scope, folder.id, galleryError.message);
            continue;
          }
          if (this.syncAbort?.signal.aborted) this.check();
          if (isHubUnreachable(e)) throw e;
          if (transientSnapshot(e)) {
            deferred = true;
            continue;
          }
          if (e.code !== "SYNC_INTERRUPTED")
            await this.store.issue(this.scope, folder.id, e.message);
          if (e.code === "SYNC_INTERRUPTED") throw e;
          settled.add(folder.id);
          errors.push(`${folder.name}: ${e.message}`);
        } finally {
          this.turnDeadline = null;
          this.syncingVolume = null;
          this.changed();
        }
      }
      await this.cleanTransferObjects(this.scope).catch(() => {});
      const complete = !errors.length && !this.moreFolderWork && !deferred;
      await refreshMusic(this, { covers: complete });
      if (errors.length) {
        this.error = errors.join("; ");
        await this.report();
        throw new Error(this.error);
      }
      if (!complete) return;
      await warmViews(this, folders);
      await this.store.set(`lastSync:${this.scope}`, new Date().toISOString());
      await this.report();
      try {
        if (
          await this.verifyHashes(
            folders.filter((folder) => !settled.has(folder.id)),
            Date.now() + VERIFY_MS,
          )
        )
          this.moreFolderWork = true;
      } catch (error) {
        if (error.code !== "SYNC_INTERRUPTED") throw error;
      }
    } catch (e) {
      this.hubFailed(e);
    } finally {
      this.syncingVolume = null;
      this.busy = false;
      this.progress = null;
      if (!this.stopped && !this.paused) {
        const conditions = conditionNotices({
          error: this.error,
          hubName: this.client.state().catalog?.name,
          catalog: this.client.state().catalog,
          volumes: await Promise.resolve()
            .then(() => this.store.folders(this.scope))
            .catch(() => []),
        });
        await this.notify(null, null, { conditions });
      }
      this.changed();
    }
  }
  async withImportPicker(work) {
    if (this.picking) throw new Error("A file selection is already open.");
    // Returning from the native picker emits AppState.active. Reserve the
    // complete selection/import batch so foreground and background sync wait.
    this.picking = true;
    this.changed();
    try {
      if (this.active) this.stop();
      return await work();
    } finally {
      this.picking = false;
      this.changed();
    }
  }
  async importFile(volume, name, source) {
    await this.requireActiveReplica();
    validPath(name);
    if (builtinExcluded(name))
      throw new Error("Arca always excludes this kind of file from sync.");
    // Callers hold picking/importing, so no cycle restarts before the copy lands.
    if (this.active) {
      this.stop();
      await this.active;
    }
    const folder = await this.store.folder(this.scope, volume);
    if (!folder?.selected) throw new Error("Start syncing this folder first");
    const size = (await this.files.stat(source)).size;
    await this.space(size * 2);
    const incoming = await this.files.hash(source);
    const conflict = `${name}.conflict-import-${incoming.slice(0, 12)}`;
    const candidates = [
      name,
      conflict,
      ...Array.from({ length: 98 }, (_, n) => `${conflict}-${n + 2}`),
    ];
    let destination = null;
    for (const candidate of candidates) {
      const target = this.files.work(this.scope, volume, candidate);
      const present = await this.files.stat(target);
      if (!present) {
        destination = target;
        break;
      }
      if (
        !present.directory &&
        present.size === size &&
        (await this.files.hash(target)) === incoming
      )
        return;
    }
    if (!destination)
      throw new Error("Too many conflicting copies of this file already exist.");
    await this.files.clearStaged(this.files.parent(destination));
    await this.files.mkdir(this.files.parent(destination));
    await this.files.copy(source, destination);
    this.changed();
  }
  async renameFile(volume, name, newName, rev) {
    if (this.renaming || this.removing || this.importing || this.picking)
      throw new Error("Wait for the current operation to finish.");
    this.renaming = true;
    let result;
    try {
      if (this.active) {
        this.stop();
        await this.active;
      }
      await this.requireActiveReplica();
      result = await this.moveFile(volume, name, newName, { rev });
    } finally {
      this.renaming = false;
    }
    await publishMusic(this).catch(() => {});
    this.musicTick = (this.musicTick || 0) + 1;
    this.changed();
    return result;
  }
  async moveFile(volume, name, newName, { rev, rewrites = false } = {}) {
    validPath(name);
    const destination = validPath(renamedPath(name, newName));
    const folder = await this.store.folder(this.scope, volume);
    if (!folder?.selected) throw new Error("Start syncing this folder first");
    if (galleryConfig(folder)?.mode === "damaged")
      throw new Error(DAMAGED_GALLERY);
    const row = await this.store.current(this.scope, volume, name);
    const file = this.files.work(this.scope, volume, name);
    const info = await this.files.stat(file);
    if (!info || info.directory || row?.directory)
      throw new Error("Only synced files can be renamed here.");
    if (row && !row.deleted) {
      if (rev != null && row.rev !== Number(rev))
        throw new Error("File changed. Reload before renaming.");
      if (!rewrites && (await this.localHash(file, volume, name)) !== row.hash)
        throw new Error("Local file changed. Sync before renaming.");
    }
    if ([name, destination].some(await folderExclusion(this, volume)))
      throw new Error("Excluded files cannot be renamed here.");
    if (destination === name) return { path: name };
    const rows = await this.store.rows(this.scope, volume);
    if (
      rows.some(
        (other) =>
          !other.deleted &&
          other.path !== name &&
          other.path.toLowerCase() === destination.toLowerCase(),
      )
    )
      throw new Error("A file or folder with that name already exists.");
    const parent = this.files.parent(file);
    // Include unsynced and excluded siblings in collision checks.
    const siblings = await this.files.listNames(parent);
    if (
      siblings.some(
        (entry) =>
          entry !== name.split("/").at(-1) &&
          entry.toLowerCase() === newName.toLowerCase(),
      )
    )
      throw new Error("A file or folder with that name already exists.");
    await this.files.move(
      file,
      this.files.work(this.scope, volume, destination),
    );
    this.hashCache.delete(file);
    await this.noteLocal(volume, { kind: "rename", from: name, to: destination }).catch(() => {});
    await this.retargetPlaylists(volume, name, destination);
    this.changed();
    return { path: destination };
  }
  async retargetPlaylists(volume, from, to) {
    if (!isMusicFolder(this.client.state().catalog, volume)) return;
    const directory = this.files.work(this.scope, volume, playlists.PLAYLIST_DIRECTORY);
    if (!(await this.files.exists(directory))) return;
    const excluded = await folderExclusion(this, volume);
    for (const name of await this.files.listNames(directory)) {
      const path = `${playlists.PLAYLIST_DIRECTORY}/${name.normalize("NFC")}`;
      if (!playlists.isEditablePlaylist(path) || excluded(path)) continue;
      let text;
      try {
        text = await this.readPlaylist(this.files.work(this.scope, volume, path));
      } catch {
        continue;
      }
      const next = playlists.moveTrack(text, path, from, to);
      if (next !== null) await this.writePlaylist(volume, path, next);
    }
  }
  async readPlaylist(uri) {
    const info = await this.files.stat(uri);
    if (info?.size > playlists.PLAYLIST_BYTES)
      throw new Error("This playlist is too large to change here.");
    return playlists.editableText(await this.files.text(uri));
  }
  async writePlaylist(volume, path, text) {
    const target = this.files.work(this.scope, volume, path);
    const staged = this.files.staged(target);
    await this.files.mkdir(this.files.parent(target));
    try {
      await this.files.write(staged, new TextEncoder().encode(text));
      await this.files.replace(staged, target);
    } catch (error) {
      await this.files.remove(staged).catch(() => {});
      throw error;
    }
    // A same-size edit within one mtime tick would otherwise reuse the stale cached hash and never sync.
    const stat = await this.files.stat(target);
    await this.rememberHash(target, target, stat, await this.files.hash(target), volume, path);
  }
  async playlistEdit(volume, path, work) {
    if (this.renaming || this.removing || this.importing || this.picking)
      throw new Error("Wait for the current operation to finish.");
    this.renaming = true;
    try {
      if (this.active) {
        this.stop();
        await this.active;
      }
      await this.requireActiveReplica();
      const folder = await this.store.folder(this.scope, volume);
      if (!folder?.selected) throw new Error("Start syncing this folder first");
      if (!isMusicFolder(this.client.state().catalog, volume))
        throw new Error("Playlists belong to music folders.");
      if ((await folderExclusion(this, volume))(path))
        throw new Error("Excluded files cannot be edited here.");
      const result = await work();
      this.changed();
      return result;
    } finally {
      this.renaming = false;
    }
  }
  async editPlaylist(volume, path, edit) {
    if (!playlists.isEditablePlaylist(path))
      throw new Error("Only .m3u8 playlists in Playlists/ can be changed here.");
    return this.playlistEdit(volume, path, async () => {
      const next = edit(await this.localPlaylist(volume, path));
      if (next === null)
        throw new Error("This playlist changed. Try again.");
      await this.writePlaylist(volume, path, next);
      return { path };
    });
  }
  async localPlaylist(volume, path) {
    const file = this.files.work(this.scope, volume, path);
    if (!(await this.files.exists(file)))
      throw new Error("This playlist is not on this phone yet. Sync and try again.");
    return this.readPlaylist(file);
  }
  async addToPlaylist(volume, path, track) {
    validPath(track);
    return this.editPlaylist(volume, path, (text) =>
      playlists.appendEntry(text, path, track),
    );
  }
  async removeFromPlaylist(volume, path, position, track) {
    return this.editPlaylist(volume, path, (text) =>
      playlists.removeEntry(text, path, position, track),
    );
  }
  async createPlaylist(volume, name, track) {
    validPath(track);
    const path = validPath(playlists.playlistPath(name));
    return this.playlistEdit(volume, path, async () => {
      const file = this.files.work(this.scope, volume, path);
      const directory = this.files.parent(file);
      const taken = [
        ...(await this.store.rows(this.scope, volume))
          .filter((row) => !row.deleted)
          .map((row) => row.path),
        ...((await this.files.exists(directory))
          ? (await this.files.listNames(directory)).map(
              (entry) => `${playlists.PLAYLIST_DIRECTORY}/${entry}`,
            )
          : []),
      ];
      if (taken.some((entry) => entry.normalize("NFC").toLowerCase() === path.toLowerCase()))
        throw new Error("A playlist with that name already exists.");
      await this.writePlaylist(
        volume,
        path,
        playlists.createPlaylist(name, path, [track]),
      );
      return { path };
    });
  }
  async renamePlaylist(volume, path, name) {
    if (!playlists.isEditablePlaylist(path))
      throw new Error("Only .m3u8 playlists in Playlists/ can be changed here.");
    const target = validPath(playlists.playlistPath(name));
    return this.playlistEdit(volume, path, async () => {
      const next = playlists.renamePlaylist(await this.localPlaylist(volume, path), name);
      const renamed =
        target === path
          ? path
          : (await this.moveFile(volume, path, target.split("/").at(-1), { rewrites: true })).path;
      await this.writePlaylist(volume, renamed, next);
      return { path: renamed };
    });
  }
  async removeFile(volume, name) {
    validPath(name);
    if (this.renaming || this.removing || this.importing || this.picking)
      throw new Error("Wait for the current operation to finish.");
    this.removing = true;
    try {
      if (this.active) {
        this.stop();
        await this.active;
      }
      await this.requireActiveReplica();
      const folder = await this.store.folder(this.scope, volume);
      if (!folder?.selected) throw new Error("Start syncing this folder first");
      if (galleryConfig(folder)?.mode === "damaged")
        throw new Error(DAMAGED_GALLERY);
      const row = await this.store.current(this.scope, volume, name);
      const file = this.files.work(this.scope, volume, name);
      const info = await this.files.stat(file);
      if (!info || info.directory || row?.directory)
        throw new Error("This file is not on this phone.");
      await this.files.remove(file);
      await this.noteLocal(volume, { kind: "remove", path: name });
      this.changed();
    } finally {
      this.removing = false;
    }
    await publishMusic(this).catch(() => {});
    this.musicTick = (this.musicTick || 0) + 1;
    this.changed();
  }
  async hasUnsyncedContent(volume, name) {
    validPath(name);
    const file = this.files.work(this.scope, volume, name);
    const info = await this.files.stat(file);
    if (!info || info.directory) return false;
    const hash = await this.localHash(file, volume, name);
    return !(await this.store.rows(this.scope, volume)).some(
      (row) => !row.deleted && !row.directory && row.hash === hash,
    );
  }
  journalKey(volume) {
    return `journal:${this.scope}:${volume}`;
  }
  async noteLocal(volume, op) {
    const key = this.journalKey(volume);
    const entries = (await this.store.get(key, [])) || [];
    await this.store.set(key, [
      ...entries,
      { ...op, seq: Math.max(Date.now(), (entries.at(-1)?.seq || 0) + 1) },
    ]);
  }
  async forgetLocal(volume, seq) {
    const key = this.journalKey(volume);
    const entries = (await this.store.get(key, [])) || [];
    if (entries.some((entry) => entry.seq <= seq))
      await this.store.set(key, entries.filter((entry) => entry.seq > seq));
  }
}
