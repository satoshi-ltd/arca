import { renamedPath } from "../core/file-rename.js";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  resetTargets,
  beginInstallationReset,
  finishInstallationReset,
} from "./installation-reset.js";
import { entryKey, directoryItem } from "../core/entries.js";
import {
  IGNORE_FILE,
  DEFAULT_IGNORE,
  MAX_IGNORE_BYTES,
  readIgnore,
} from "./exclusions.js";
import { machineReport } from "./machines.js";
import { cleanupTransfers, applyFolderRetention } from "./maintenance.js";
import { SyncWork, covers } from "./sync-work.js";
import { Scanner } from "./scanner.js";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  Store,
  init,
  digest,
  fail,
  hashFile,
  validPath,
  atomic,
  requireSpace,
  syncDirectory,
} from "./storage.js";

const CHUNK = 1024 * 1024;
export class Engine {
  constructor(home) {
    this.store = new Store(home);
    this.config = this.store.config;
    if (this.config.destroyPending) {
      try {
        this.gallery?.close();
        this.gallery = null;
        finishInstallationReset(this.store);
      } catch {
        /* Keep the journal available for explicit retry. */
      }
    }
    const transition = path.join(this.store.home, "promotion.json");
    if (fs.existsSync(transition)) {
      const journal = JSON.parse(fs.readFileSync(transition, "utf8"));
      if (
        this.store.db
          .prepare("SELECT id FROM transitions WHERE id=?")
          .get(journal.id)
      ) {
        this.store.config = journal.config;
        this.store.saveConfig();
        this.config = journal.config;
      }
      fs.unlinkSync(transition);
    }

    this.scanner = new Scanner(this.store.home);
    this.work = new SyncWork(this.store);
    this.activity = 0;
    this.folderStates = new Map();
    this.progress = null;
    this.phase =
      this.config.role !== "hub" && !this.config.hub ? "unlinked" : "idle";
    this.error = null;
    this.lastSync = null;
    this.paused = Boolean(this.config.paused);
    this.pauseUntil = this.config.pauseUntil || null;
    this.stopVolumes = new Set();
    this.transferred = 0;
    this.tail = Promise.resolve();
    this.requestContext = new AsyncLocalStorage();
    this.store.db.exec(
      "CREATE TABLE IF NOT EXISTS proposals(id TEXT PRIMARY KEY,response TEXT NOT NULL)",
    );
  }
  setPaused(paused, until = null) {
    const previous = {
      paused: this.config.paused,
      pauseUntil: this.config.pauseUntil,
    };
    this.config.paused = Boolean(paused);
    this.config.pauseUntil = paused ? until : null;
    try {
      this.store.saveConfig();
    } catch (error) {
      Object.assign(this.config, previous);
      throw error;
    }
    this.paused = this.config.paused;
    this.pauseUntil = this.config.pauseUntil;
    if (this.paused) this.interruptCycle();
  }
  interruptCycle() {
    this.syncAbort?.abort(
      Object.assign(new Error("Synchronization yielded to a user action"), {
        syncInterrupted: true,
      }),
    );
    this.scanner.interrupt();
    this.backupEngine?.interruptCycle();
  }
  checkSyncInterrupted() {
    if (this.syncAbort?.signal.aborted) throw this.syncAbort.signal.reason;
    if (this.paused || this.stopVolumes.size)
      throw Object.assign(new Error("Synchronization stopped"), {
        syncInterrupted: true,
      });
  }
  exclusive(work) {
    const next = this.tail.then(work);
    this.tail = next.catch(() => {});
    return next;
  }
  status() {
    const s = this.store;
    return {
      protocol: 1,
      platform: process.platform,
      nodeVersion: process.versions.node,
      statePath: s.home,
      port: this.listeningPort || this.config.port,
      id: this.config.id,
      name: this.config.name,
      role: this.config.role,
      phase:
        this.config.role === "hub" && !s.volumes().length
          ? "needs-folder"
          : this.config.role !== "hub" && !this.config.hub
            ? "unlinked"
            : this.paused
              ? "paused"
              : this.phase,
      needsSetup: !!this.config.needsSetup,
      onboarding: !!this.config.onboarding,
      destroyPending: !!this.config.destroyPending,
      setupRequired: this.config.role === "hub" && !s.volumes().length,
      root: this.config.root,
      retention: this.config.retention || { days: 0, versions: 0 },
      folderRetention: this.config.folderRetention || {},
      backup: {
        enabled: false,
        ...this.config.backup,
        error: this.backupError || null,
      },
      error: this.error,
      lastSync: this.lastSync,
      transferred: this.transferred,
      progress: this.progress,
      hub: this.config.hub?.url || null,
      hubId: this.config.hub?.id || null,
      hubName: this.config.hub?.name || null,
      disconnectedHub: this.config.disconnectedHub || null,
      volumes: s.volumes().map((v) => {
        const totals = s.visibleTotals(v.id);
        return {
          ...v,
          historyRetention:
            this.config.role === "hub"
              ? this.config.folderRetention?.[v.id] || "1m"
              : (this.config.catalog?.find((row) => row.id === v.id)
                  ?.historyRetention ?? "1m"),
          gallery:
            this.config.role === "hub"
              ? !!s.db
                  .prepare("SELECT 1 FROM gallery_folders WHERE volume=?")
                  .get(v.id)
              : !!this.config.catalog?.find((row) => row.id === v.id)?.gallery,
          sync: totals.policyError
            ? { state: "error", error: totals.policyError, lastCompleted: null }
            : this.folderStates.get(v.id) || {
                state: v.selected ? "pending" : "unselected",
                lastCompleted: v.last_sync,
              },
          ...totals,
          conflictRevision:
            this.config.role === "hub"
              ? s.conflictRevision(v.id)
              : (this.config.catalog?.find((row) => row.id === v.id)
                  ?.conflictRevision ?? s.conflictRevision(v.id)),
          conflicts:
            this.config.role === "hub"
              ? s.unresolvedConflicts(v.id)
              : (this.config.catalog?.find((row) => row.id === v.id)
                  ?.conflicts ?? s.unresolvedConflicts(v.id)),
        };
      }),
      devices: s.db
        .prepare(
          "SELECT d.id,d.name,d.role,d.revoked,d.last_seen,d.last_address,a.enabled AS backup_enabled,a.revision AS backup_revision,a.updated AS backup_updated FROM devices d LEFT JOIN backup_ack a ON a.device=d.id",
        )
        .all(),
      historyRevisions: Number(
        s.db.prepare("SELECT COUNT(*) AS count FROM revisions").get().count,
      ),
      backupRevisions: Number(
        s.db.prepare("SELECT COUNT(*) AS count FROM backup_history").get()
          .count,
      ),
    };
  }
  async request(route, options = {}) {
    const hub = this.config.hub;
    if (!hub) fail("Connect this node to a hub first");
    const response = await fetch(`${hub.url}${route}`, {
      ...options,
      redirect: "error",
      headers: {
        Authorization: `Bearer ${hub.token}`,
        "X-Arca-Directories": "1",
        "X-Arca-Path-Transitions": "1",
        ...options.headers,
      },
      signal: AbortSignal.any([
        options.signal || AbortSignal.timeout(60000),
        ...(this.requestContext.getStore()
          ? [this.requestContext.getStore().signal]
          : []),
      ]),
    });
    if (!response.ok) {
      if (
        response.status === 401 &&
        this.config.role === "replica" &&
        this.config.hub === hub
      )
        this.clearHubConnection();
      const message = await response.text();
      fail(`Hub ${response.status}: ${message.slice(0, 200)}`, response.status);
    }
    return response;
  }
  async json(route, body) {
    const r = await this.request(
      route,
      body === undefined
        ? {}
        : {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
    );
    return r.json();
  }
  async upload(hash, onProgress) {
    const file = this.store.blob(hash);
    const size = fs.statSync(file).size;
    const progress = (done) => {
      if (onProgress) onProgress(done, size);
      else if (this.progress)
        Object.assign(this.progress, {
          direction: "upload",
          bytesDone: done,
          bytesTotal: size,
        });
    };
    progress(0);
    let { offset, complete, maxChunkBytes } = await this.json(
      `/v1/uploads/${hash}`,
    );
    const chunk =
      Number.isSafeInteger(maxChunkBytes) && maxChunkBytes > 0
        ? Math.min(maxChunkBytes, 8 * CHUNK)
        : CHUNK;
    progress(offset);
    if (complete) {
      progress(size);
      return;
    }
    const fd = fs.openSync(file, "r");
    try {
      do {
        this.checkSyncInterrupted();
        const length = Math.min(chunk, size - offset);
        const buffer = Buffer.alloc(length);
        fs.readSync(fd, buffer, 0, length, offset);
        const r = await this.request(
          `/v1/uploads/${hash}?offset=${offset}&size=${size}`,
          { method: "PUT", body: buffer },
        );
        ({ offset, complete } = await r.json());
        this.transferred += length;
        progress(offset);
      } while (!complete);
    } finally {
      fs.closeSync(fd);
    }
  }
  async download(hash, size) {
    const file = this.store.blob(hash);
    if (fs.existsSync(file)) {
      if (hashFile(file) === hash) return;
      // Keep the damaged object until a verified replacement is ready.
    }
    if (this.progress)
      Object.assign(this.progress, {
        direction: "download",
        bytesDone: 0,
        bytesTotal: size,
      });
    const tmp = path.join(this.store.uploads, `${hash}.download`);
    let offset = fs.existsSync(tmp) ? fs.statSync(tmp).size : 0;
    if (offset > size) {
      fs.unlinkSync(tmp);
      offset = 0;
    }
    if (offset < size || !fs.existsSync(tmp)) {
      requireSpace(this.store.uploads, size - offset);
      const response = await this.request(`/v1/blobs/${hash}`, {
        headers: offset ? { Range: `bytes=${offset}-` } : {},
      });
      if (offset && response.status !== 206)
        fail("Hub did not honor the requested download range", 502);
      const fd = fs.openSync(tmp, offset ? "a" : "w");
      try {
        for await (const chunk of response.body) {
          fs.writeSync(fd, chunk);
          this.transferred += chunk.length;
          if (this.progress)
            this.progress.bytesDone =
              (this.progress.bytesDone || offset) + chunk.length;
        }
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    }
    if (fs.statSync(tmp).size !== size || hashFile(tmp) !== hash) {
      fs.unlinkSync(tmp);
      fail("Downloaded content failed integrity verification", 409);
    }
    fs.renameSync(tmp, file);
    syncDirectory(this.store.objects);
  }
  async propose(body, device) {
    const s = this.store;
    const {
      volume,
      path: requestedPath,
      base = 0,
      hash = null,
      size = 0,
      directory = false,
    } = body;
    if (
      ![false, true, 0, 1].includes(directory) ||
      (directory && (hash !== null || size !== 0))
    )
      fail("Invalid directory metadata");
    const item = directory ? directoryItem() : hash ? { hash, size } : null;
    if (
      !Number.isSafeInteger(base) ||
      base < 0 ||
      !Number.isSafeInteger(size) ||
      size < 0
    )
      fail("Invalid revision or size");
    const v = s.volume(volume);
    const name = validPath(requestedPath);
    if (name === IGNORE_FILE && size > MAX_IGNORE_BYTES)
      fail(".arcaignore exceeds 64 KiB", 409);
    if (
      s.excluded(volume, name, directory || s.current(volume, name)?.directory)
    )
      fail("Path is excluded from synchronization", 409);
    if (v.selected) s.filePath(v, name);
    if (
      hash &&
      (!fs.existsSync(s.blob(hash)) || fs.statSync(s.blob(hash)).size !== size)
    )
      fail("Upload content before proposing", 409);
    await this.scanHub(volume, {
      paths: s.caseAlias(volume, name) ? null : [name, IGNORE_FILE],
    });
    const revision = () =>
      Number(
        s.db
          .prepare(
            "SELECT COALESCE(MAX(rev),0) n FROM revisions WHERE volume=?",
          )
          .get(volume).n,
      );
    const op = digest(
      JSON.stringify([device.id, volume, name, base, hash, directory]),
    );
    const cached = s.db
      .prepare("SELECT response FROM proposals WHERE id=?")
      .get(op);
    if (cached) {
      const saved = JSON.parse(cached.response);
      if (saved.revision === revision()) return saved.result;
    }
    const old = s.pathHead(volume, name);
    let result;
    if (old?.path === name && entryKey(old) === entryKey(item))
      result = { row: old || null, conflict: false };
    else if ((old?.rev ?? 0) !== base && (directory || old?.directory)) {
      if (old?.directory && directory && old.deleted)
        result = {
          row: s.commit(volume, name, item, device.id, true),
          conflict: false,
        };
      else if (old?.directory && !item) result = { row: old, conflict: false };
      else
        fail(
          "Path type changed on the hub; reconcile the local path before retrying",
          409,
        );
    } else if ((old?.rev ?? 0) !== base) {
      if (name === IGNORE_FILE)
        fail(
          "Sync paused: .arcaignore differs between this machine and the hub. Use the same rules on both before retrying.",
          409,
        );
      if (!hash)
        result = {
          row: old,
          conflict: true,
          reason: "Remote edit preserved; stale deletion rejected",
        };
      else {
        const conflictName = `${name}.conflict-${device.id.slice(0, 8)}-${op.slice(0, 8)}-${old?.rev || 0}`;
        const existing = s.current(volume, conflictName);
        const row =
          existing?.hash === hash
            ? existing
            : s.commit(volume, conflictName, { hash, size }, device.id, true);
        result = { row: old || null, conflict: true, conflictPath: row.path };
      }
    } else
      result = {
        row: s.commit(
          volume,
          name,
          item,
          device.id,
          true,
          old?.hash,
          null,
          old?.path !== name ? old?.path : null,
        ),
        conflict: false,
      };
    s.db
      .prepare("INSERT OR REPLACE INTO proposals VALUES(?,?)")
      .run(op, JSON.stringify({ volume, revision: revision(), result }));
    s.db.exec(
      "DELETE FROM proposals WHERE rowid NOT IN (SELECT rowid FROM proposals ORDER BY rowid DESC LIMIT 10000)",
    );
    return result;
  }
  cycle(options = {}) {
    return this.requestContext.run(new AbortController(), () =>
      this.runCycle(options),
    );
  }
  async runCycle({ incremental = false } = {}) {
    if (
      this.destroying ||
      this.config.destroyPending ||
      this.config.needsSetup ||
      this.config.onboarding
    )
      return;
    if (this.paused && this.pauseUntil && Date.now() >= this.pauseUntil) {
      this.setPaused(false);
    }
    if (this.paused) {
      await this.reportMachine();
      return;
    }
    if (this.config.role === "hub" && !this.store.volumes().length) {
      this.phase = "needs-folder";
      return;
    }
    if (this.config.role !== "hub" && !this.config.hub) {
      this.phase = "unlinked";
      return;
    }
    this.phase = "syncing";
    this.syncAbort = this.requestContext.getStore();
    this.error = null;
    try {
      if (!this.lastCleanup || Date.now() - this.lastCleanup > 3600000) {
        cleanupTransfers(this.store);
        if (this.config.role === "hub") applyFolderRetention(this.store);
        this.lastCleanup = Date.now();
      }
      const s = this.store;
      const folderErrors = [];
      if (this.config.role === "hub")
        await this.scanHub(undefined, { incremental });
      else if (this.config.hub) {
        const catalog = await this.json("/v1/catalog");
        if (
          !catalog.directories ||
          !catalog.changes ||
          !catalog.pathTransitions
        )
          fail(
            "Hub does not support the current synchronization protocol",
            412,
          );
        if (catalog.id !== this.config.hub.id)
          fail("Hub identity changed; reconnect explicitly", 409);
        this.config.hub.name = catalog.name;
        this.config.catalog = catalog.volumes.map((v) => ({
          id: v.id,
          name: v.name,
          gallery: !!v.gallery,
          historyRetention:
            v.historyRetention ??
            this.config.catalog?.find((saved) => saved.id === v.id)
              ?.historyRetention ??
            "1m",
          conflictRevision: v.conflictRevision,
          conflicts: Number.isSafeInteger(v.conflicts)
            ? v.conflicts
            : undefined,
        }));
        this.store.saveConfig();
        if (this.config.role === "backup")
          for (const v of catalog.volumes)
            if (!s.volumes().some((local) => local.id === v.id))
              s.addVolume(v.name, null, v.id);
        for (const remote of catalog.volumes)
          s.db
            .prepare("UPDATE volumes SET name=? WHERE id=?")
            .run(remote.name, remote.id);
        const activeIds = new Set(catalog.volumes.map((v) => v.id));
        if (this.config.role === "replica") {
          for (const local of s.volumes()) {
            if (!activeIds.has(local.id)) {
              s.forgetVolume(local.id);
              this.folderStates.delete(local.id);
            }
          }
        }
        for (const v of s
          .volumes()
          .filter((v) => v.selected && activeIds.has(v.id))) {
          try {
            this.folderStates.set(v.id, {
              state: "syncing",
              lastCompleted: v.last_sync,
            });
            this.progress = { volume: v.id, path: null };
            s.recover(v.id);
            if (catalog.volumes.find((row) => row.id === v.id)?.policyError)
              fail(
                catalog.volumes.find((row) => row.id === v.id)?.policyError,
                409,
              );
            if (this.config.role !== "backup") await this.syncIgnore(v);
            const policy = digest(readIgnore(v.path));
            if (this.work.state(v.id).policy !== policy) {
              this.work.mark(v.id);
              this.work.cursor(v.id, 0);
            }
            const plan = this.work.plan(
              v,
              incremental && this.config.role !== "backup",
            );
            const disk =
              plan.paths?.length === 0
                ? new Map()
                : await this.scanner.scan(v, plan.paths);
            if (this.config.role !== "backup") {
              const known = new Map(
                s.rowsInScope(v.id, plan.paths).map((r) => [r.path, r]),
              );
              const diskNames = new Set(
                [...disk.keys()].map((name) => name.toLowerCase()),
              );
              const changed = [...disk]
                .sort(([a], [b]) =>
                  a === IGNORE_FILE ? -1 : b === IGNORE_FILE ? 1 : 0,
                )
                .filter(([name, item]) => {
                  const old = known.get(name);
                  return (
                    !old || old.deleted || entryKey(old) !== entryKey(item)
                  );
                });
              Object.assign(this.progress, {
                stage: "upload",
                filesDone: 0,
                filesTotal: changed.length,
              });
              for (const row of [...known.values()].sort((a, b) =>
                b.path.localeCompare(a.path),
              ))
                if (
                  !row.deleted &&
                  covers(plan.paths, row.path) &&
                  !s.excluded(v.id, row.path, row.directory) &&
                  !disk.has(row.path) &&
                  !diskNames.has(row.path.toLowerCase())
                )
                  await this.json("/v1/propose", {
                    volume: v.id,
                    path: row.path,
                    base: row.rev,
                    hash: null,
                  });
              for (let cursor = 0; cursor < changed.length;) {
                this.checkSyncInterrupted();
                // Keep policy, directories and empty files ordered. Only stage file bytes concurrently.
                const batch = [changed[cursor++]];
                const parallel = ([name, item]) =>
                  name !== IGNORE_FILE && item.hash && item.size > 0;
                if (parallel(batch[0]))
                  while (
                    batch.length < 3 &&
                    cursor < changed.length &&
                    parallel(changed[cursor])
                  )
                    batch.push(changed[cursor++]);
                const pending = batch.filter(([name, item]) => {
                  if (s.excluded(v.id, name, item.directory)) return false;
                  const old = s.pathHead(v.id, name);
                  return (
                    !old ||
                    old.path !== name ||
                    old.deleted ||
                    entryKey(old) !== entryKey(item)
                  );
                });
                const uploads = new Map();
                for (const [name, item] of pending)
                  if (item.hash && !uploads.has(item.hash))
                    uploads.set(item.hash, { name, size: item.size, done: 0 });
                const update = () => {
                  Object.assign(this.progress, {
                    direction: "upload",
                    path: pending.length === 1 ? pending[0][0] : null,
                    bytesDone: [...uploads.values()].reduce(
                      (sum, item) => sum + item.done,
                      0,
                    ),
                    bytesTotal: [...uploads.values()].reduce(
                      (sum, item) => sum + item.size,
                      0,
                    ),
                  });
                };
                update();
                const results = await Promise.allSettled(
                  [...uploads].map(([hash, item]) =>
                    this.upload(hash, (done) => {
                      item.done = done;
                      update();
                    }),
                  ),
                );
                const failed = results.find(
                  (result) => result.status === "rejected",
                );
                if (failed) throw failed.reason;
                for (const [name, item] of pending) {
                  this.checkSyncInterrupted();
                  const old = s.pathHead(v.id, name);
                  await this.json("/v1/propose", {
                    volume: v.id,
                    path: name,
                    base: old?.rev ?? 0,
                    ...item,
                  });
                  this.progress.filesDone++;
                }
              }
            }
            Object.assign(this.progress, {
              stage: "receive",
              filesDone: 0,
              filesTotal: null,
              path: null,
              bytesDone: 0,
              bytesTotal: 0,
            });
            this.checkSyncInterrupted();
            const useChanges = incremental && this.config.role !== "backup";
            let cursor = plan.full ? 0 : this.work.state(v.id).cursor;
            let through;
            const directoryDeletes = [];
            const deferredFiles = [];
            let page,
              session,
              after = "";
            do {
              try {
                page = await this.json(
                  useChanges
                    ? `/v1/changes?volume=${encodeURIComponent(v.id)}&after=${cursor}${through === undefined ? "" : `&through=${through}`}`
                    : `/v1/snapshot?volume=${encodeURIComponent(v.id)}&limit=500${session ? `&session=${encodeURIComponent(session)}&after=${encodeURIComponent(after)}` : ""}`,
                );
              } catch (e) {
                if (useChanges && /409/.test(e.message)) {
                  this.work.cursor(v.id, 0);
                  this.work.mark(v.id);
                }
                throw e;
              }
              if (useChanges) {
                through = page.through;
                cursor = page.next ?? through;
              }
              if (page.files.length) this.activity++;
              // A missed local event must never let a remote change overwrite an
              // unsubmitted edit. Inspect only incoming paths outside this scan.
              if (plan.paths !== null) {
                const paths = page.files
                  .filter(
                    (r) =>
                      !s.excluded(v.id, r.path) && !covers(plan.paths, r.path),
                  )
                  .map((r) => r.path);
                const incomingDisk = paths.length
                  ? await this.scanner.scan(v, paths)
                  : new Map();
                for (const name of paths) {
                  const local = incomingDisk.get(name),
                    known = s.current(v.id, name);
                  if (entryKey(local) !== entryKey(known)) {
                    this.work.mark(v.id, name);
                    throw Object.assign(
                      new Error("Local edits need synchronization"),
                      { syncInterrupted: true },
                    );
                  }
                  if (local) disk.set(name, local);
                }
              }
              this.progress.filesTotal = page.total ?? null;
              session = page.session;
              after = page.next;
              for (const row of page.files) {
                this.checkSyncInterrupted();
                if (
                  useChanges &&
                  row.path === IGNORE_FILE &&
                  !row.deleted &&
                  row.hash !== digest(readIgnore(v.path))
                ) {
                  this.work.mark(v.id);
                  throw Object.assign(
                    new Error("Exclusions changed during synchronization"),
                    { syncInterrupted: true },
                  );
                }
                if (
                  this.config.role !== "backup" &&
                  s.excluded(v.id, row.path, row.directory)
                ) {
                  this.progress.filesDone++;
                  continue;
                }
                this.progress.path = row.path;
                Object.assign(this.progress, {
                  direction: "download",
                  bytesDone: 0,
                  bytesTotal: 0,
                });
                const local = disk.get(row.path);
                if (row.hash && !row.deleted)
                  await this.download(row.hash, row.size);
                if (row.directory && row.deleted) {
                  directoryDeletes.push(row);
                  continue;
                }
                const target = path.join(v.path, row.path);
                if (
                  !row.deleted &&
                  !row.directory &&
                  fs.existsSync(target) &&
                  fs.lstatSync(target).isDirectory()
                ) {
                  deferredFiles.push(row);
                  continue;
                }
                this.checkSyncInterrupted();
                if (
                  (row.deleted && !local) ||
                  (!row.deleted && entryKey(local) === entryKey(row))
                ) {
                  const indexed = s.current(v.id, row.path);
                  if (
                    !indexed ||
                    indexed.rev !== row.rev ||
                    indexed.hash !== row.hash ||
                    indexed.deleted !== row.deleted ||
                    indexed.size !== row.size ||
                    indexed.directory !== row.directory
                  )
                    s.setFile(row);
                } else {
                  s.queue(row, local?.hash);
                  s.materialize(row, local?.hash);
                }
                this.progress.filesDone++;
              }
            } while (after);
            for (const row of directoryDeletes.sort((a, b) =>
              b.path.localeCompare(a.path),
            )) {
              s.queue(row);
              s.materialize(row);
            }
            for (const row of deferredFiles) {
              s.queue(row);
              s.materialize(row);
            }
            if (session) await this.json("/v1/snapshot-release", { session });
            if (useChanges) this.work.cursor(v.id, through);
            this.work.complete(v, plan);
            s.db
              .prepare(
                "INSERT INTO sync_state(volume,policy) VALUES(?,?) ON CONFLICT(volume) DO UPDATE SET policy=excluded.policy",
              )
              .run(v.id, digest(readIgnore(v.path)));
            s.db
              .prepare("UPDATE volumes SET last_sync=? WHERE id=?")
              .run(new Date().toISOString(), v.id);
            this.folderStates.set(v.id, {
              state: "synced",
              lastCompleted: new Date().toISOString(),
            });
          } catch (e) {
            if (this.syncAbort.signal.aborted)
              throw this.syncAbort.signal.reason;
            if (e.syncInterrupted) throw e;
            this.folderStates.set(v.id, {
              state: "error",
              error: e.message,
              lastCompleted: v.last_sync,
            });
            folderErrors.push(`${v.name}: ${e.message}`);
          }
        }
        if (this.config.role === "backup" && folderErrors.length)
          fail(folderErrors.join("; "), 409);
        if (this.config.role === "backup") {
          let after = s.db
              .prepare("SELECT COALESCE(MAX(rev),0) AS n FROM backup_history")
              .get().n,
            through,
            page;
          do {
            page = await this.json(
              `/v1/archive?limit=500&after=${after}${through !== undefined ? `&through=${through}` : ""}`,
            );
            through = page.through;
            for (const v of page.volumes || [])
              if (!s.volumes().some((local) => local.id === v.id))
                s.addVolume(v.name, null, v.id);
            for (const row of page.revisions) {
              if (row.hash) await this.download(row.hash, row.size);
              s.db
                .prepare("INSERT OR REPLACE INTO backup_history VALUES(?,?)")
                .run(row.rev, JSON.stringify(row));
            }
            after = page.next;
          } while (after);
          if (through !== undefined)
            await this.json("/v1/backup-ack", {
              enabled: true,
              revision: through,
            });
        }
      }
      if (this.config.role === "replica" && this.config.backup?.enabled) {
        try {
          const backup = this.openBackup();
          await backup.cycle();
          this.config.backup.lastSync = backup.lastSync;
          this.config.backup.revisions = backup.status().backupRevisions;
          this.config.backup.folders = backup.store.volumes().length;
          this.config.backup.contentBytes = Number(
            backup.store.db
              .prepare(
                `
            SELECT COALESCE(SUM(size), 0) AS bytes FROM (
              SELECT json_extract(row, '$.hash') AS hash,
                     MAX(json_extract(row, '$.size')) AS size
              FROM backup_history
              WHERE json_extract(row, '$.hash') IS NOT NULL
              GROUP BY json_extract(row, '$.hash')
            )
          `,
              )
              .get().bytes,
          );
          this.store.saveConfig();
          this.backupError = null;
        } catch (e) {
          if (this.syncAbort.signal.aborted) throw this.syncAbort.signal.reason;
          this.backupError = e.message;
        }
      }
      if (folderErrors.length) {
        this.progress = null;
        fail(folderErrors.join("; "), 409);
      }
      this.lastSync = new Date().toISOString();
      this.phase = "idle";
      this.progress = null;
    } catch (e) {
      if (this.syncAbort.signal.aborted) e = this.syncAbort.signal.reason;
      if (this.config.role === "replica" && !this.config.hub) return;
      if (e.syncInterrupted) {
        if (this.progress?.volume)
          this.folderStates.set(this.progress.volume, { state: "pending" });
        this.progress = null;
        this.phase = "idle";
        this.error = null;
        return;
      }
      if (this.progress?.volume)
        this.folderStates.set(this.progress.volume, {
          state: "error",
          error: e.message,
        });
      this.progress = null;
      this.phase = "error";
      this.error = e.message;
      throw e;
    } finally {
      if (!this.syncAbort.signal.aborted) await this.reportMachine();
      this.syncAbort = null;
    }
  }
  async reportMachine(force = false) {
    if (this.config.role === "hub" || !this.config.hub) return;
    if (!force && this.lastReport && Date.now() - this.lastReport < 15000)
      return;
    try {
      await this.json("/v1/machine-report", machineReport(this));
      this.lastReport = Date.now();
    } catch {
      // A failed presence report must not prevent durable file synchronization.
    }
  }
  promotionPlan() {
    if (this.config.role !== "replica")
      fail("Only a replica can become a replacement hub", 409);
    const catalog = this.config.catalog || [];
    const localVolumes = this.store.volumes();
    const folders = catalog.map((v) => {
      const local = localVolumes.find((item) => item.id === v.id);
      const state = this.folderStates.get(v.id);
      const pending = this.store.db
        .prepare("SELECT 1 FROM pending WHERE volume=? LIMIT 1")
        .get(v.id);
      let reason = null;
      if (!local?.selected) reason = "Select a complete local copy first.";
      else if (!local.last_sync) reason = "No completed synchronization yet.";
      else if (pending) reason = "Finish pending file transfers first.";
      else if (state && state.state !== "synced")
        reason =
          state.state === "error"
            ? "Resolve this folder’s synchronization error first."
            : "Wait for this folder’s synchronization to finish.";
      else {
        try {
          if (!fs.statSync(local.path).isDirectory())
            reason = "Local folder is unavailable.";
        } catch {
          reason = "Local folder is unavailable.";
        }
      }
      return {
        ...v,
        selected: Boolean(local?.selected),
        lastSync: local?.last_sync || null,
        reason,
      };
    });
    const missing = folders.filter((v) => v.reason);
    const backupEnabled = Boolean(this.config.backup?.enabled);
    return {
      ready:
        Boolean(this.config.hub) &&
        catalog.length > 0 &&
        !missing.length &&
        !backupEnabled,
      backupEnabled,
      missing,
      catalog: folders,
      lastSync: this.lastSync,
      warning:
        "The old hub must remain stopped. This device becomes a new hub identity; other devices must reconnect. Only current local files are retained here; old hub history is not reconstructed.",
    };
  }
  async promote(confirmed) {
    const plan = this.promotionPlan();
    if (plan.backupEnabled) fail("Disable hub backup before promotion.", 409);
    if (!confirmed || !plan.ready)
      fail(
        "Confirm recovery and obtain complete copies of every known folder first",
        409,
      );
    let reachable = false;
    try {
      const r = await fetch(`${this.config.hub.url}/.well-known/arca`, {
        signal: AbortSignal.timeout(3000),
      });
      reachable = true;
      await r.body?.cancel();
    } catch {}
    if (reachable)
      fail(
        "The old hub is reachable. Stop it before promoting this device.",
        409,
      );
    this.store.recover();
    const scans = [];
    for (const v of this.store.volumes().filter((v) => v.selected))
      scans.push([v, await this.scanner.scan(v)]);
    this.closeBackup();
    const next = {
      ...this.config,
      role: "hub",
      hub: null,
      backup: { ...this.config.backup, enabled: false },
    };
    const id = crypto.randomUUID(),
      journal = path.join(this.store.home, "promotion.json");
    const checkpoint = path.join(
      this.store.home,
      `before-promotion-${id}.sqlite`,
    );
    this.store.db.exec(`VACUUM INTO '${checkpoint.replaceAll("'", "''")}'`);
    fs.chmodSync(checkpoint, 0o600);
    atomic(journal, JSON.stringify({ id, config: next }));
    const db = this.store.db;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(
        "DELETE FROM files; DELETE FROM revisions; DELETE FROM pending; DELETE FROM proposals; DELETE FROM devices; DELETE FROM machine_reports; DELETE FROM backup_ack; DELETE FROM pairing; DELETE FROM snapshot_files; DELETE FROM snapshot_sessions;",
      );
      const add = db.prepare(
        "INSERT INTO revisions(volume,path,hash,size,deleted,author,created,directory) VALUES(?,?,?,?,0,?,?,?)",
      );
      for (const [v, disk] of scans)
        for (const [name, item] of disk) {
          const result = add.run(
            v.id,
            name,
            item.hash,
            item.size,
            this.config.id,
            new Date().toISOString(),
            item.directory ? 1 : 0,
          );
          this.store.setFile({
            volume: v.id,
            path: name,
            ...item,
            deleted: 0,
            rev: Number(result.lastInsertRowid),
          });
        }
      db.prepare("INSERT INTO transitions VALUES(?)").run(id);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    Object.assign(this.config, next);
    this.store.saveConfig();
    fs.unlinkSync(journal);
    this.error = null;
    this.phase = "idle";
    this.lastSync = new Date().toISOString();
    return {
      promoted: true,
      id: this.config.id,
      checkpoint,
      folders: scans.length,
    };
  }
  async configureBackup(enabled, location) {
    if (this.config.role !== "replica" || !this.config.hub)
      fail("Connect a replica to a hub before enabling backup", 409);
    if (typeof enabled !== "boolean") fail("Choose whether backup is enabled");
    if (!enabled) {
      this.closeBackup();
      this.config.backup = { ...this.config.backup, enabled: false };
      this.store.saveConfig();
      try {
        await this.json("/v1/backup-ack", { enabled: false, revision: 0 });
        this.backupError = null;
      } catch (e) {
        this.backupError =
          "Backup stopped locally; hub acknowledgement pending: " + e.message;
      }
      return this.status().backup;
    }
    const destination = this.store.resolveLocation(
      location || this.config.backup?.path || "",
    );
    if (this.config.backup?.path && this.config.backup.path !== destination)
      fail(
        "Changing an existing backup location requires a separate migration",
        409,
      );
    for (const forbidden of [
      this.store.home,
      this.config.root,
      ...this.store.volumes().map((v) => v.path),
    ].filter(Boolean))
      if (
        destination === forbidden ||
        destination.startsWith(forbidden + path.sep) ||
        forbidden.startsWith(destination + path.sep)
      )
        fail(
          "Backup location must be outside synchronized folders and daemon state",
          409,
        );
    if (!this.config.backup?.path) {
      if (fs.existsSync(destination))
        fail("Choose a new dedicated backup directory", 409);
      const state = path.join(destination, "state");
      init(state, {
        role: "backup",
        name: `${this.config.name} backup`,
        root: path.join(destination, "files"),
        port: 0,
      });
      const child = new Store(state);
      child.config.hub = { ...this.config.hub };
      child.saveConfig();
      child.close();
    }
    this.config.backup = {
      ...this.config.backup,
      path: destination,
      enabled: true,
    };
    this.store.saveConfig();
    await this.json("/v1/backup-ack", { enabled: true, revision: 0 });
    return this.status().backup;
  }
  openBackup() {
    if (this.backupEngine) return this.backupEngine;
    const home = path.join(this.config.backup.path, "state");
    const lock = path.join(home, "daemon.lock");
    if (fs.existsSync(lock)) {
      const pid = Number(fs.readFileSync(lock, "utf8"));
      try {
        process.kill(pid, 0);
        fail("Backup directory is in use", 409);
      } catch (e) {
        if (e.code !== "ESRCH") throw e;
      }
      fs.unlinkSync(lock);
    }
    fs.writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
    try {
      const child = new Engine(home);
      if (
        child.config.role !== "backup" ||
        child.config.hub?.id !== this.config.hub.id
      ) {
        child.close();
        fail("Backup belongs to another hub", 409);
      }
      child.config.hub = { ...this.config.hub };
      child.store.saveConfig();
      this.backupEngine = child;
      this.backupLock = lock;
      return child;
    } catch (e) {
      fs.unlinkSync(lock);
      throw e;
    }
  }
  closeBackup() {
    this.backupEngine?.close();
    this.backupEngine = null;
    if (this.backupLock) fs.unlinkSync(this.backupLock);
    this.backupLock = null;
  }
  async scanHub(volume, { incremental = false, paths } = {}) {
    const s = this.store;
    const errors = [];
    const checkpoint = () => {
      // Release the current cycle for queued destructive controls, even when
      // they target a different folder. Never commit a partial scan as deletions.
      this.checkSyncInterrupted();
    };
    for (const v of s
      .volumes()
      .filter((v) => v.selected && (!volume || v.id === volume))) {
      checkpoint();
      const plan = this.work.plan(v, incremental, paths);
      if (plan.paths?.length === 0) continue;
      this.folderStates.set(v.id, {
        state: "scanning",
        lastCompleted: v.last_sync,
      });
      try {
        s.recover(v.id);
        const disk = await this.scanner.scan(v, plan.paths);
        checkpoint();
        const known = s.rowsInScope(v.id, plan.paths);
        const diskNames = new Set(
          [...disk.keys()].map((name) => name.toLowerCase()),
        );
        for (const row of known.sort((a, b) => b.path.localeCompare(a.path))) {
          await new Promise((resolve) => setImmediate(resolve));
          checkpoint();
          if (
            !row.deleted &&
            covers(plan.paths, row.path) &&
            !s.excluded(v.id, row.path, row.directory) &&
            !disk.has(row.path) &&
            !diskNames.has(row.path.toLowerCase())
          )
            s.commit(v.id, row.path, null, this.config.id);
        }
        for (const [name, item] of disk) {
          // Let status and control requests run between durable file commits.
          await new Promise((resolve) => setImmediate(resolve));
          checkpoint();
          const old = s.current(v.id, name);
          if (!old || old.deleted || entryKey(old) !== entryKey(item)) {
            s.commit(
              v.id,
              name,
              item,
              this.config.id,
              false,
              null,
              null,
              s.caseAlias(v.id, name)?.path,
            );
            this.activity++;
          }
        }
        this.work.complete(v, plan);
        const time = new Date().toISOString();
        s.db
          .prepare("UPDATE volumes SET last_sync=? WHERE id=?")
          .run(time, v.id);
        this.folderStates.set(v.id, { state: "synced", lastCompleted: time });
      } catch (e) {
        if (e.syncInterrupted) {
          this.folderStates.set(v.id, {
            state: "pending",
            lastCompleted: v.last_sync,
          });
          throw e;
        }
        this.folderStates.set(v.id, {
          state: "error",
          error: e.message,
          lastCompleted: v.last_sync,
        });
        errors.push(`${v.name}: ${e.message}`);
      }
    }
    if (errors.length) fail(errors.join("; "), 409);
  }
  renameShare(id, name) {
    validPath(name);
    if (name.includes("/")) fail("Folder name must be a single segment");
    this.store.volume(id);
    if (
      this.store
        .volumes()
        .some((v) => v.id !== id && v.name.toLowerCase() === name.toLowerCase())
    )
      fail("Folder name already exists", 409);
    this.store.db.prepare("UPDATE volumes SET name=? WHERE id=?").run(name, id);
    return this.store.volume(id);
  }
  ignorePolicy(id) {
    const s = this.store,
      v = s.volume(id);
    // Edit only an active working copy so the existing policy safety rules apply.
    if (!v.selected)
      fail("Enable the hub's local copy before editing exclusions", 409);
    s.assertVolume(v);
    const text = readIgnore(v.path);
    const exists = fs.existsSync(path.join(v.path, IGNORE_FILE));
    return { text, version: digest(JSON.stringify([exists, text])) };
  }
  saveIgnorePolicy(id, text, version) {
    if (typeof text !== "string" || Buffer.byteLength(text) > MAX_IGNORE_BYTES)
      fail(".arcaignore must be text of at most 64 KiB");
    const current = this.ignorePolicy(id);
    if (version !== current.version)
      fail(
        "The exclusions changed. Reopen the editor before saving again.",
        409,
      );
    const s = this.store,
      v = s.volume(id),
      hash = digest(text);
    const file = path.join(v.path, IGNORE_FILE);
    const expected = fs.existsSync(file) ? digest(current.text) : null;
    if (expected === hash) return { saved: true };
    requireSpace(s.objects, Buffer.byteLength(text));
    atomic(s.blob(hash), text);
    s.commit(
      id,
      IGNORE_FILE,
      { hash, size: Buffer.byteLength(text) },
      this.config.id,
      true,
      expected,
    );
    this.work.mark(id);
    return { saved: true };
  }
  async publish(name, location, createIgnore = false) {
    if (this.config.role !== "hub")
      fail(
        "Only the hub can create shared folders. Choose a shared folder and its local destination on this device.",
        403,
      );
    if (typeof createIgnore !== "boolean") fail("Invalid ignore option");
    const resolved = this.store.resolveLocation(
      location || path.join(this.config.root, name),
    );
    if (createIgnore && fs.existsSync(resolved))
      fail("Default .arcaignore can only be created in a new folder", 400);
    return this.store.addVolume(name, resolved, undefined, createIgnore);
  }
  async syncIgnore(v) {
    const s = this.store;
    s.ignoreRules(v); // Validate the local policy before touching ordinary files.
    const { versions } = await this.json(
      `/v1/history?volume=${encodeURIComponent(v.id)}&path=${IGNORE_FILE}&limit=1`,
    );
    const remote = versions[0];
    if (!remote) return;
    if (remote.deleted) {
      const known = s.current(v.id, IGNORE_FILE);
      const file = path.join(v.path, IGNORE_FILE);
      if (known && !known.deleted) {
        if (fs.existsSync(file) && digest(readIgnore(v.path)) !== known.hash)
          fail(
            "Sync paused: .arcaignore was edited locally while deleted on the hub. Resolve the policy before retrying.",
            409,
          );
        s.queue(remote, known.hash);
        s.materialize(remote, known.hash);
        this.work.mark(v.id);
        this.work.cursor(v.id, 0);
      }
      return;
    }
    if (remote.size > MAX_IGNORE_BYTES)
      fail("Remote .arcaignore exceeds 64 KiB", 409);
    const localText = readIgnore(v.path);
    const localHash = digest(localText);
    const known = s.current(v.id, IGNORE_FILE);
    if (known?.hash === remote.hash || localHash === remote.hash) {
      if (localHash === remote.hash) s.setFile(remote);
      return;
    }
    // Policy conflicts must stop before scanning or transferring ordinary files.
    if (
      known
        ? localHash !== known.hash
        : localText !== DEFAULT_IGNORE && localText !== ""
    )
      fail(
        "Sync paused: .arcaignore differs between this machine and the hub. Use the same rules on both before retrying.",
        409,
      );
    await this.download(remote.hash, remote.size);
    s.queue(remote, localHash);
    s.materialize(remote, localHash);
  }
  destroyReplica() {
    return this.destroyInstallation("replica");
  }
  destroyHub() {
    return this.destroyInstallation("hub");
  }
  async destroyInstallation(role) {
    if (this.config.role !== role) fail(`Only a ${role} can be destroyed`, 409);
    if (this.destroying) fail("Destruction is already in progress", 409);
    this.destroying = true;
    this.interruptCycle();
    try {
      // Validate every target before removing the registration from the hub.
      if (!this.config.destroyPending) resetTargets(this.store);
      return await this.exclusive(async () => {
        if (
          role === "replica" &&
          !this.config.destroyPending &&
          this.config.hub
        ) {
          try {
            await this.request("/v1/leave", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: "{}",
              signal: AbortSignal.timeout(1000),
            });
          } catch {
            // Remote registration cleanup must not prevent confirmed local deletion.
          }
        }
        await this.scanner.worker?.terminate();
        this.scanner = new Scanner(this.store.home);
        if (!this.config.destroyPending)
          beginInstallationReset(this.store, resetTargets(this.store));
        this.gallery?.close();
        this.gallery = null;
        finishInstallationReset(this.store);
        this.folderStates.clear();
        this.paused = false;
        this.pauseUntil = null;
        this.error = this.progress = this.lastSync = null;
        this.phase = "unlinked";
        return { destroyed: true, needsSetup: true };
      });
    } finally {
      this.destroying = false;
    }
  }
  async disconnect() {
    if (this.config.role !== "replica")
      fail("Only a replica can disconnect from a hub", 409);
    if (!this.config.hub) return { disconnected: true };
    const wasPaused = this.paused;
    const backup = this.backupEngine;
    const backupWasPaused = backup?.paused;
    this.paused = true;
    this.interruptCycle();
    if (this.backupEngine) {
      this.backupEngine.paused = true;
      this.backupEngine.scanner.interrupt();
    }
    try {
      return await this.exclusive(async () => {
        if (!this.config.hub) return { disconnected: true };
        try {
          await this.request("/v1/leave", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
            signal: AbortSignal.timeout(5000),
          });
        } catch (error) {
          if (error.status !== 401)
            fail(
              "Could not disconnect from the hub. Check the connection and retry to complete disconnection.",
              503,
            );
        }
        return this.config.hub
          ? this.clearHubConnection()
          : { disconnected: true, filesRetained: true };
      });
    } finally {
      this.paused = wasPaused;
      if (backup && this.backupEngine === backup)
        backup.paused = backupWasPaused;
    }
  }
  clearHubConnection() {
    this.closeBackup();
    const { id, url } = this.config.hub;
    const backupConfigPath = this.config.backup?.path
      ? path.join(this.config.backup.path, "state", "config.json")
      : null;
    if (backupConfigPath && fs.existsSync(backupConfigPath)) {
      const backupConfig = JSON.parse(
        fs.readFileSync(backupConfigPath, "utf8"),
      );
      backupConfig.hub = { id, url };
      atomic(backupConfigPath, JSON.stringify(backupConfig, null, 2));
    }
    const next = {
      ...this.config,
      hub: null,
      disconnectedHub: { id, url },
      catalog: [],
      backup: { ...this.config.backup, enabled: false },
    };
    // Persist the removed credential before presenting a disconnected state.
    atomic(this.store.configPath, JSON.stringify(next, null, 2));
    Object.assign(this.config, next);
    this.phase = "unlinked";
    this.error = null;
    this.progress = null;
    this.lastSync = null;
    this.folderStates.clear();
    return { disconnected: true, filesRetained: true };
  }
  async select(id, location) {
    const s = this.store;
    const volumes =
      this.config.role === "hub"
        ? s.volumes()
        : (await this.json("/v1/catalog")).volumes;
    const v = volumes.find((v) => v.id === id);
    if (!v) fail("Unknown remote volume", 404);
    const existing = s.volumes().find((v) => v.id === id);
    if (
      existing?.path &&
      location &&
      s.resolveLocation(location) !== existing.path
    )
      fail(
        "This folder already has a local destination. Moving an existing replica requires a separate migration.",
        409,
      );
    if (existing?.selected) return existing;
    let local;
    s.db.exec("BEGIN IMMEDIATE");
    try {
      local = s.addVolume(v.name, existing?.path || location, v.id, false);
      if (this.config.role === "hub")
        for (const row of s.rows(id).filter((row) => !row.deleted))
          s.queue(row, null);
      s.db.exec("COMMIT");
    } catch (e) {
      s.db.exec("ROLLBACK");
      throw e;
    }
    if (this.config.role === "hub") s.recover(id);
    this.work.mark(id);
    await this.reportMachine(true);
    this.lastReport = null;
    return local;
  }
  async renameFile(volume, name, newName, rev) {
    name = validPath(name);
    let destination;
    try {
      destination = renamedPath(name, newName);
    } catch (error) {
      fail(error.message);
    }
    validPath(destination);
    const s = this.store,
      v = s.volume(volume);
    if (this.config.role === "backup") fail("Backup is read-only", 403);
    if (this.config.role !== "hub" && !v.selected)
      fail("Select this folder first", 403);
    if (this.config.role === "hub")
      await this.scanHub(volume, { paths: [name, destination, IGNORE_FILE] });
    const excluded = s.visibleRules(volume);
    if (excluded(name, false) || excluded(destination, false))
      fail("Excluded files cannot be renamed here", 409);
    const current = s.current(volume, name);
    if (!current || current.deleted) fail("File not found", 404);
    if (current.directory) fail("Only files can be renamed here", 409);
    if (current.rev !== Number(rev))
      fail("File changed. Reload before renaming.", 409);
    if (destination === name) return { path: name };
    const collision = [
      s.current(volume, destination),
      s.caseAlias(volume, destination),
    ].find((row) => row && !row.deleted && row.path !== name);
    if (collision) fail("A file or folder with that name already exists", 409);
    if (v.selected) {
      const file = s.filePath(v, name);
      const target = s.filePath(v, destination);
      const siblings = fs.readdirSync(path.dirname(file));
      if (
        siblings.some(
          (entry) =>
            entry.toLowerCase() === newName.toLowerCase() &&
            entry !== path.basename(name),
        )
      )
        fail("A file or folder with that name already exists", 409);
      if (!fs.lstatSync(file).isFile() || hashFile(file) !== current.hash)
        fail("Local file changed. Sync before renaming.", 409);
      if (this.config.role !== "hub") {
        if (name.toLowerCase() === destination.toLowerCase())
          fs.renameSync(file, target);
        else {
          // Creating a hard link fails if another file appears at the destination.
          fs.linkSync(file, target);
          fs.unlinkSync(file);
        }
        syncDirectory(path.dirname(file));
        this.work.mark(volume, name);
        this.work.mark(volume, destination);
        return { path: destination };
      }
    }
    return s.renameFile(current, destination, this.config.id);
  }
  async deleteFile(volume, name, rev) {
    validPath(name);
    const v = this.store.volume(volume);
    if (this.config.role === "backup") fail("Backup is read-only", 403);
    if (this.config.role !== "hub" && !v.selected)
      fail("Select this folder first", 403);
    if (this.store.excluded(volume, name))
      fail("Excluded files cannot be deleted here", 409);
    if (this.config.role === "hub")
      await this.scanHub(volume, { paths: [name, IGNORE_FILE] });
    const current = this.store.current(volume, name);
    if (!current || current.deleted) fail("File not found", 404);
    if (current.directory) fail("Use file deletion only for files", 409);
    if (current.rev !== Number(rev))
      fail("File changed. Reload before deleting.", 409);
    if (this.config.role === "hub")
      return this.store.commit(
        volume,
        name,
        null,
        this.config.id,
        true,
        current.hash,
      );
    const file = this.store.filePath(v, name);
    if (!fs.lstatSync(file).isFile() || hashFile(file) !== current.hash)
      fail("Local file changed. Sync before deleting.", 409);
    fs.unlinkSync(file);
    this.work.mark(volume, name);
    return { deleted: true };
  }
  async restore(volume, name, rev) {
    if (this.config.role !== "hub")
      return this.json("/v1/restore", { volume, path: name, rev });
    await this.scanHub(volume, { paths: [name, IGNORE_FILE] });
    const version = this.store
      .history(volume, name)
      .find((r) => r.rev === Number(rev));
    if (!version || version.deleted) fail("Restorable version not found", 404);
    const old = this.store.current(volume, name);
    return this.store.commit(
      volume,
      name,
      version,
      this.config.id,
      true,
      old?.hash,
    );
  }
  close() {
    this.gallery?.close();
    this.closeBackup();
    this.scanner.close();
    this.store.close();
  }
}
