import { validPath, validRow } from "./validation.js";
import { Gallery, galleryConfig } from "./gallery.js";
import { conditionNotices } from "../../desktop/src/notice-contract.js";
import { entryKey, directoryItem } from "../../../packages/core/entries.js";
import { builtinExcluded } from "../../../packages/core/builtin-exclusions.js";
import ignore from "../../../packages/vendor/ignore/index.cjs";
export const CHUNK = 1024 * 1024;
export const HEADROOM = 256 * 1024 * 1024;
export { validPath, validRow } from "./validation.js";

export class Replica {
  constructor({
    store,
    files,
    client,
    notify = async () => {},
    changed = () => {},
    platform = "mobile",
    media = null,
  }) {
    Object.assign(this, { store, files, client, changed, platform });
    // OS notification delivery must never prevent durable sync acknowledgement.
    this.notify = async (...args) => {
      try {
        await notify(...args);
      } catch {
        /* The in-app error remains visible. */
      }
    };
    this.gallery = new Gallery(this, media);
    this.busy = false;
    this.stopped = false;
    this.progress = null;
    this.scope = null;
    this.error = null;
    this.active = null;
    this.hashCache = new Map();
    this.lastFullScan = 0;
  }
  async load() {
    await this.store.init();
    if (await this.store.get("destroyPending", false)) {
      try {
        await this.finishDestroy();
      } catch (error) {
        this.error = `Replica cleanup incomplete. Retry Destroy replica. ${error.message}`;
      }
    }
    this.scope = await this.store.get("scope");
    if (this.files.clearGalleryStage && this.scope)
      for (const folder of await this.store.folders(this.scope))
        if (galleryConfig(folder)) {
          await this.files.clearGalleryStage(this.scope, folder.id);
          const source = galleryConfig(folder);
          source.summary = await this.store.gallerySummary(
            this.scope,
            folder.id,
          );
          await this.store.setGallery(this.scope, folder.id, source);
        }
    this.paused = await this.store.get("paused", false);
  }
  async requireActiveReplica() {
    if (await this.store.get("destroyPending", false))
      throw new Error(
        "Replica cleanup is pending. Retry Destroy replica before continuing.",
      );
  }
  async finishDestroy() {
    await this.files.destroy();
    await this.client.destroy();
    await this.store.reset();
    this.scope = null;
    this.paused = false;
    this.error = this.progress = null;
    this.hashCache.clear();
    this.lastFullScan = 0;
  }
  async destroy(confirmed = false) {
    if (!confirmed)
      throw new Error("Confirm permanent replica destruction first");
    if (this.removing || this.importing)
      throw new Error("Wait for the current operation to finish.");
    this.removing = true;
    this.stop();
    try {
      if (this.active) await this.active;
      await this.client.disconnect();
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
    await this.store.set("paused", value);
    this.changed();
  }
  stop() {
    this.stopped = true;
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
    if (galleryConfig(await this.store.folder(this.scope, volume.id)))
      throw new Error("Use Gallery source settings to download a local copy.");
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
      await this.store.set(removalKey, false);
      this.hashCache.clear();
      await this.cleanTransferObjects(scope, removedHashes);
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
  async cleanTransferObjects(scope, removedHashes) {
    const retained = new Set(await this.store.referencedHashes(scope));
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
        )
          await this.files.remove(entry.uri);
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
      this.check();
      const end = Math.min(offset + CHUNK, size) - 1;
      const response = await this.client.raw(`/v1/blobs/${hash}`, {
        headers: { Range: `bytes=${offset}-${end}` },
      });
      if (
        response.status !== 206 ||
        response.headers.get("content-range") !==
          `bytes ${offset}-${end}/${size}`
      )
        throw new Error("The hub did not return the requested file block");
      const data = new Uint8Array(await response.arrayBuffer());
      if (data.length !== end - offset + 1)
        throw new Error("Incomplete download block");
      await this.files.write(tmp, data, offset);
      offset += data.length;
      this.progress = {
        direction: "download",
        bytesDone: offset,
        bytesTotal: size,
      };
      this.changed();
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
    const object = this.files.object(this.scope, hash);
    await this.space(size);
    if (!(await this.files.exists(object))) {
      await this.files.mkdir(this.files.parent(object));
      await this.files.copy(file, object);
    }
    if ((await this.files.hash(object)) !== hash)
      throw new Error("File changed while reading. Retry synchronization.");
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
    const policy = (await this.files.exists(file))
      ? await this.files.hash(file)
      : "";
    const key = `policy:${this.scope}:${folder.id}`;
    if ((await this.store.get(key)) !== policy) {
      // Persist reconciliation before accepting the policy, including across crashes.
      await this.store.resetCursor(this.scope, folder.id);
      folder.initialized = 0;
      folder.cursor = 0;
      await this.store.set(key, policy);
    }
    const text = (await this.files.exists(file))
      ? await this.files.text(file)
      : "";
    this.policy = ignore({ ignorecase: true }).add(text);
  }
  async localHash(uri) {
    const stat = await this.files.stat(uri),
      cached = this.hashCache.get(uri);
    if (
      !this.force &&
      stat?.mtime != null &&
      cached?.size === stat.size &&
      cached.mtime === stat.mtime
    )
      return cached.hash;
    if (stat?.directory) return "directory";
    const hash = await this.files.hash(uri);
    this.hashCache.set(uri, { ...stat, hash });
    return hash;
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
        validPath(entry.path);
      } catch {
        throw new Error(
          `Rename "${entry.path}" using a portable composed Unicode (NFC) name, then retry.`,
        );
      }
      names.add(entry.path);
      foldedNames.add(entry.path.toLowerCase());
      if (excluded(entry.path + (entry.directory ? "/" : ""))) continue;
      const previous = heads.get(entry.path.toLowerCase());
      const hash = entry.directory
        ? "directory"
        : await this.localHash(entry.uri);
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
  async upload(op, source = null) {
    const object = source || this.files.object(this.scope, op.hash);
    if ((await this.files.hash(object)) !== op.hash)
      throw new Error("Queued upload failed verification");
    let { offset, complete } = await this.client.api(`/v1/uploads/${op.hash}`);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > op.size)
      throw new Error("Invalid upload offset");
    while (!complete) {
      this.check();
      const data = await this.files.read(
        object,
        offset,
        Math.min(CHUNK, op.size - offset),
      );
      const response = await this.client.raw(
        `/v1/uploads/${op.hash}?offset=${offset}&size=${op.size}`,
        { method: "PUT", body: data },
      );
      const next = await response.json();
      if (!next.complete && (next.offset <= offset || next.offset > op.size))
        throw new Error("Invalid upload progress");
      offset = next.offset;
      complete = next.complete;
      this.progress = {
        direction: "upload",
        bytesDone: offset,
        bytesTotal: op.size,
      };
      this.changed();
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
      if (op.hash) await this.upload(op);
      const result = await this.client.api("/v1/propose", op);
      // The acknowledged source hash is the baseline for safe materialization.
      if (result.row)
        await this.store.put(this.scope, { ...result.row, localHash: op.hash });
      await this.store.dequeue(this.scope, folder.id, op.path);
    }
  }
  async apply(row, recovering = false) {
    if (builtinExcluded(row.path)) return;
    if (
      !recovering &&
      row.path !== ".arcaignore" &&
      this.policy?.ignores(row.path + (row.directory ? "/" : ""))
    )
      return;
    const current = await this.store.current(this.scope, row.volume, row.path);
    const target = this.files.work(this.scope, row.volume, row.path);
    if (row.deleted && row.replacementPath) {
      await this.store.applied(this.scope, row);
      return;
    }
    if (!row.deleted) {
      const alias = (await this.store.rows(this.scope, row.volume)).find(
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
        if (exists) await this.files.removeDirectory(target);
      } else await this.files.mkdir(target);
      await this.store.applied(this.scope, row);
      return;
    }
    if (info?.directory)
      throw new Error(
        "File conflicts with a local directory; reconcile it first.",
      );
    const actual = exists ? await this.files.hash(target) : null;
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
      if (exists) await this.files.remove(target);
    } else if (actual !== row.hash) {
      const object = await this.download(row.hash, row.size);
      await this.space(row.size);
      await this.files.mkdir(this.files.parent(target));
      const temp = this.files.parent(target) + "/.arca-transfer-" + row.hash;
      await this.files.copy(object, temp);
      await this.files.replace(temp, target);
    }
    await this.store.applied(this.scope, row);
  }
  async pull(folder) {
    let through;
    const directoryDeletes = [];
    const deferredFiles = [];
    const apply = async (row) => {
      validRow(row, folder.id);
      if (row.directory && row.deleted) directoryDeletes.push(row);
      else if (
        !row.deleted &&
        !row.directory &&
        (
          await this.files.stat(
            this.files.work(this.scope, row.volume, row.path),
          )
        )?.directory
      )
        deferredFiles.push(row);
      else await this.apply(row);
    };
    if (!folder.initialized) {
      through = (
        await this.client.api(`/v1/changes?volume=${folder.id}&after=0`)
      ).through;
      let session = null,
        after = "";
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
      } finally {
        if (session)
          await this.client
            .api("/v1/snapshot-release", { session })
            .catch(() => {});
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
      await this.apply(row);
    for (const row of deferredFiles) await this.apply(row);
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
    await this.store.set("name", name);
    this.changed();
    try {
      if (!this.client.state().connection) return false;
      await this.report();
      return true;
    } catch {
      // The saved name is sent again with the next machine report.
      return false;
    }
  }
  async report() {
    const folders = (await this.store.folders(this.scope)).filter(
      (f) => f.selected && !galleryConfig(f),
    );
    const counts = await Promise.all(
      folders.map((f) => this.store.rows(this.scope, f.id)),
    );
    const rows = counts.flat().filter((r) => !r.deleted && !r.directory);
    const name = await this.store.get(
      "name",
      this.platform === "ios" ? "iPhone" : "Android",
    );
    await this.client.api("/v1/machine-report", {
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
      indexedFiles: rows.length,
      indexedBytes: rows.reduce((n, r) => n + r.size, 0),
    });
  }
  sync(force = false) {
    if (this.picking || this.importing || this.removing)
      return Promise.resolve();
    if (this.active) return this.active;
    this.force = force || Date.now() - this.lastFullScan > 3600000;
    this.active = this.cycle().finally(() => {
      this.active = null;
    });
    return this.active;
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
    this.error = null;
    this.changed();
    try {
      await this.client.refresh();
      const connection = this.client.state().connection;
      if (!connection?.linked) return;
      if (this.scope !== connection.hubId) {
        this.scope = connection.hubId;
        await this.store.set("scope", this.scope);
      }
      if (this.paused) {
        await this.report();
        return;
      }
      const catalog = this.client.state().catalog;
      if (!catalog.directories || !catalog.pathTransitions)
        throw new Error(
          "Update the hub to synchronize directories and path changes safely.",
        );
      const errors = [];
      for (const folder of (await this.store.folders(this.scope)).filter(
        (f) => f.selected,
      )) {
        this.check();
        if (await this.store.get(`removing:${this.scope}:${folder.id}`, false))
          continue;
        if (!catalog.volumes.some((v) => v.id === folder.id)) {
          await this.store.issue(
            this.scope,
            folder.id,
            "This folder is no longer shared by the hub. Export local changes before removing it.",
          );
          continue;
        }
        this.syncingVolume = folder.id;
        this.changed();
        try {
          const remote = catalog.volumes.find((v) => v.id === folder.id);
          if (remote.policyError) throw new Error(remote.policyError);
          if (galleryConfig(folder)) {
            await this.gallery.cycle(folder);
            continue;
          }
          this.policy = null;
          for (const row of (
            await this.store.applying(this.scope, folder.id)
          ).sort((a, b) => b.path.localeCompare(a.path)))
            await this.apply(row, true);
          await this.syncIgnore(folder);
          await this.scan(folder);
          await this.push(folder);
          await this.pull(folder);
        } catch (e) {
          if (e.code !== "SYNC_INTERRUPTED")
            await this.store.issue(this.scope, folder.id, e.message);
          if (e.code === "SYNC_INTERRUPTED") throw e;
          errors.push(`${folder.name}: ${e.message}`);
        } finally {
          this.syncingVolume = null;
          this.changed();
        }
      }
      if (errors.length) {
        this.error = errors.join("; ");
        await this.report();
        throw new Error(this.error);
      }
      if (this.force) this.lastFullScan = Date.now();
      await this.store.set(`lastSync:${this.scope}`, new Date().toISOString());
      await this.report();
    } catch (e) {
      if (e.code === "SYNC_INTERRUPTED") return;
      this.error = e.message;
    } finally {
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
    try {
      if (this.active) await this.active;
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
      throw new Error("System metadata files are not synced.");
    if (this.busy) throw new Error("Wait for synchronization to finish");
    const folder = await this.store.folder(this.scope, volume);
    if (!folder?.selected) throw new Error("Select this folder first");
    if (galleryConfig(folder))
      throw new Error(
        "Gallery sources upload from Photos and do not keep local files.",
      );
    const target = this.files.work(this.scope, volume, name);
    await this.space((await this.files.stat(source)).size * 2);
    if (await this.files.exists(target)) {
      const old = await this.files.hash(target),
        incoming = await this.files.hash(source);
      if (old !== incoming)
        name = `${name}.conflict-import-${incoming.slice(0, 12)}`;
    }
    const destination = this.files.work(this.scope, volume, name);
    await this.files.mkdir(this.files.parent(destination));
    await this.files.copy(source, destination);
    this.changed();
  }
  async removeFile(volume, name) {
    await this.requireActiveReplica();
    validPath(name);
    const folder = await this.store.folder(this.scope, volume);
    if (galleryConfig(folder))
      throw new Error("Gallery originals can only be managed in Photos.");
    if (!folder?.selected) throw new Error("Select this folder first");
    if (this.busy) throw new Error("Wait for synchronization to finish");
    const row = await this.store.current(this.scope, volume, name);
    const file = this.files.work(this.scope, volume, name);
    const info = await this.files.stat(file);
    if (!info || info.directory || !row || row.deleted || row.directory)
      throw new Error("Only synced files can be deleted here.");
    if ((await this.files.hash(file)) !== row.hash)
      throw new Error("Local file changed. Sync before deleting.");
    await this.files.remove(file);
    this.changed();
  }
}
