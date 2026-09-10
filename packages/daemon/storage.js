import { entryKey, directoryItem } from "../core/entries.js";
import {
  ensureIgnore,
  readIgnore,
  compileIgnore,
  IGNORE_FILE,
} from "./exclusions.js";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";

export const digest = (data) =>
  crypto.createHash("sha256").update(data).digest("hex");
export const token = () => crypto.randomBytes(32).toString("hex");
export function fail(message, status = 400) {
  throw Object.assign(new Error(message), { status });
}
export function validPath(value) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 1024 ||
    value !== value.normalize("NFC")
  )
    fail("Invalid file path");
  for (const part of value.split("/")) {
    if (
      !part ||
      part === "." ||
      part === ".." ||
      /[\\<>:"|?*\x00-\x1f]/.test(part) ||
      /[. ]$/.test(part) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(part) ||
      part.startsWith(".arca-")
    )
      fail("Unsupported file path");
  }
  return value;
}
export function hashFile(file) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
  );
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    let count;
    while ((count = fs.readSync(fd, buffer)) > 0)
      hash.update(buffer.subarray(0, count));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}
export function requireSpace(location, additionalBytes) {
  let directory = location;
  while (!fs.existsSync(directory)) {
    const parent = path.dirname(directory);
    if (parent === directory) fail("Storage location is unavailable", 507);
    directory = parent;
  }
  const disk = fs.statfsSync(directory, { bigint: true });
  const required = BigInt(Math.max(0, additionalBytes)) + 16n * 1024n * 1024n;
  if (disk.bavail * disk.bsize < required)
    fail(
      "Insufficient free disk space; synchronization will retry when space is available",
      507,
    );
}
export function syncDirectory(directory) {
  if (process.platform === "win32") return;
  const fd = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
export function atomic(file, data, mode = 0o600) {
  if (!fs.existsSync(path.dirname(file)))
    fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(tmp, "wx", mode);
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  syncDirectory(path.dirname(file));
}
export const runtimeInstallation =
  JSON.parse(
    fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ).arcaInstallation || "server";

export function init(home, options = {}) {
  home = path.resolve(home);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  home = fs.realpathSync(home);
  if (fs.existsSync(path.join(home, "config.json")))
    fail("Node already initialized");
  const installation =
    runtimeInstallation === "desktop"
      ? "desktop"
      : options.installation || "server";
  if (!["desktop", "server"].includes(installation))
    fail("Invalid installation");
  const role = options.role || "hub";
  if (!["hub", "replica", "backup"].includes(role)) fail("Invalid role");
  const config = {
    protocol: 1,
    installation,
    id: crypto.randomUUID(),
    name: options.name || "My Arca",
    role,
    root: path.resolve(options.root || path.join(home, "files")),
    host: options.host || "127.0.0.1",
    port: Number(options.port ?? 47831),
    adminToken: token(),
    hub: null,
    ...(options.onboarding ? { onboarding: true } : {}),
  };
  fs.mkdirSync(config.root, { recursive: true });
  config.root = fs.realpathSync(config.root);
  if (config.root === home || home.startsWith(config.root + path.sep))
    fail("State must be outside synchronized folders");
  atomic(path.join(home, "config.json"), JSON.stringify(config, null, 2));
  return config;
}
export class Store {
  constructor(home) {
    this.home = fs.realpathSync(path.resolve(home));
    this.configPath = path.join(this.home, "config.json");
    this.config = JSON.parse(fs.readFileSync(this.configPath));
    this.objects = path.join(this.home, "objects");
    this.uploads = path.join(this.home, "uploads");
    fs.mkdirSync(this.objects, { recursive: true });
    fs.mkdirSync(this.uploads, { recursive: true });
    this.db = new DatabaseSync(path.join(this.home, "index.sqlite"));
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS volumes(id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, selected INTEGER NOT NULL DEFAULT 1,last_sync TEXT);
      CREATE TABLE IF NOT EXISTS revisions(rev INTEGER PRIMARY KEY AUTOINCREMENT, volume TEXT NOT NULL, path TEXT NOT NULL, hash TEXT, size INTEGER NOT NULL, deleted INTEGER NOT NULL, author TEXT NOT NULL, created TEXT NOT NULL,directory INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS files(volume TEXT NOT NULL,path TEXT NOT NULL,hash TEXT,size INTEGER NOT NULL,deleted INTEGER NOT NULL,rev INTEGER NOT NULL,directory INTEGER NOT NULL DEFAULT 0,path_key TEXT NOT NULL,PRIMARY KEY(volume,path));
      CREATE TABLE IF NOT EXISTS pending(volume TEXT NOT NULL,path TEXT NOT NULL,row TEXT NOT NULL,expected TEXT,PRIMARY KEY(volume,path));
      CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY,name TEXT NOT NULL,token_hash TEXT NOT NULL,role TEXT NOT NULL,revoked INTEGER NOT NULL DEFAULT 0,last_seen TEXT,last_address TEXT);
      CREATE TABLE IF NOT EXISTS conflict_resolutions(volume TEXT NOT NULL,path TEXT NOT NULL,conflict_rev INTEGER NOT NULL,resolution_rev INTEGER NOT NULL,choice TEXT NOT NULL,PRIMARY KEY(volume,path));
      CREATE TABLE IF NOT EXISTS transitions(id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS snapshot_sessions(id TEXT PRIMARY KEY,owner TEXT NOT NULL,volume TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS snapshot_files(session TEXT NOT NULL,path TEXT NOT NULL,hash TEXT,row TEXT NOT NULL,PRIMARY KEY(session,path));
      CREATE INDEX IF NOT EXISTS revisions_volume_path ON revisions(volume,path,rev);
      CREATE TABLE IF NOT EXISTS machine_reports(device TEXT PRIMARY KEY,report TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS auth_failures(purpose TEXT PRIMARY KEY,failures INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS pairing(code_hash TEXT PRIMARY KEY,name TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS backup_ack(device TEXT PRIMARY KEY,revision INTEGER NOT NULL DEFAULT 0,enabled INTEGER NOT NULL DEFAULT 1,updated TEXT);
      CREATE TABLE IF NOT EXISTS sync_dirty(seq INTEGER PRIMARY KEY AUTOINCREMENT,volume TEXT NOT NULL,path TEXT NOT NULL,UNIQUE(volume,path));
      CREATE TABLE IF NOT EXISTS sync_state(volume TEXT PRIMARY KEY,cursor INTEGER NOT NULL DEFAULT 0,full_at INTEGER NOT NULL DEFAULT 0,policy TEXT);
      CREATE INDEX IF NOT EXISTS files_volume_rev ON files(volume,rev);
      CREATE TABLE IF NOT EXISTS scan_cache(path TEXT PRIMARY KEY,signature TEXT NOT NULL,hash TEXT NOT NULL,size INTEGER NOT NULL,verified INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS backup_history(rev INTEGER PRIMARY KEY,row TEXT NOT NULL);
    `);
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS files_volume_path_key ON files(volume,path_key)",
    );
  }
  forgetDevice(id) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          "DELETE FROM snapshot_files WHERE session IN (SELECT id FROM snapshot_sessions WHERE owner=?)",
        )
        .run(id);
      this.db.prepare("DELETE FROM snapshot_sessions WHERE owner=?").run(id);
      this.db.prepare("DELETE FROM machine_reports WHERE device=?").run(id);
      this.db.prepare("DELETE FROM backup_ack WHERE device=?").run(id);
      this.db.prepare("DELETE FROM devices WHERE id=?").run(id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    for (const name of fs.readdirSync(this.uploads)) {
      if (
        name.startsWith(`${id}-`) &&
        /^[a-f0-9]{64}\.part$/.test(name.slice(id.length + 1))
      )
        fs.rmSync(path.join(this.uploads, name), { force: true });
    }
  }
  saveConfig() {
    atomic(this.configPath, JSON.stringify(this.config, null, 2));
  }
  volumes() {
    return this.db.prepare("SELECT * FROM volumes ORDER BY name").all();
  }
  volume(id) {
    const v = this.db.prepare("SELECT * FROM volumes WHERE id=?").get(id);
    if (!v) fail("Unknown volume", 404);
    return v;
  }
  forgetVolume(id) {
    const v = this.volume(id);
    // Remove only Arca's matching marker; never remove user files.
    const marker = path.join(v.path, ".arca-volume");
    const removeMarker =
      fs.existsSync(v.path) &&
      !fs.lstatSync(v.path).isSymbolicLink() &&
      fs.realpathSync(v.path) === v.path &&
      fs.existsSync(marker) &&
      !fs.lstatSync(marker).isSymbolicLink() &&
      fs.readFileSync(marker, "utf8") === id;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          "DELETE FROM snapshot_files WHERE session IN (SELECT id FROM snapshot_sessions WHERE volume=?)",
        )
        .run(id);
      for (const table of [
        "snapshot_sessions",
        "sync_dirty",
        "sync_state",
        "pending",
        "files",
        "revisions",
      ])
        this.db.prepare(`DELETE FROM ${table} WHERE volume=?`).run(id);
      this.db
        .prepare(
          "DELETE FROM proposals WHERE json_extract(response, '$.volume')=?",
        )
        .run(id);
      this.db.prepare("DELETE FROM volumes WHERE id=?").run(id);
      if (removeMarker) fs.unlinkSync(marker);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { deleted: true, filesRetained: true };
  }
  resolveLocation(location) {
    if (typeof location !== "string" || !location.trim())
      fail("Choose a local folder path");
    if (location === "~" || location.startsWith("~/")) {
      if (fs.existsSync("/.dockerenv"))
        fail(
          "In Docker, use the absolute path of a mounted folder. ~ refers to the container user, not your SSH user.",
        );
      location = path.join(os.homedir(), location.slice(2));
    }
    if (!path.isAbsolute(location)) fail("Folder paths must be absolute");
    location = path.resolve(location);
    if (fs.existsSync(location) && fs.lstatSync(location).isSymbolicLink())
      fail("Symlink volume paths are not supported");
    const missing = [];
    let ancestor = location;
    while (!fs.existsSync(ancestor)) {
      missing.unshift(path.basename(ancestor));
      ancestor = path.dirname(ancestor);
    }
    return path.join(fs.realpathSync(ancestor), ...missing);
  }
  addVolume(
    name,
    location,
    id = crypto.randomUUID(),
    createIgnore = true,
    checkOnly = false,
  ) {
    validPath(name);
    if (name.includes("/")) fail("Folder name must be a single segment");
    if (
      this.volumes().some(
        (v) => v.name.toLowerCase() === name.toLowerCase() && v.id !== id,
      )
    )
      fail("Folder name already exists");
    location = this.resolveLocation(
      location || path.join(this.config.root, name),
    );
    if (
      this.home === location ||
      this.home.startsWith(location + path.sep) ||
      (location.startsWith(this.home + path.sep) &&
        !location.startsWith(this.config.root + path.sep))
    )
      fail("State and volume paths overlap");
    const backupPath = this.config.backup?.path;
    if (
      backupPath &&
      (location === backupPath ||
        location.startsWith(backupPath + path.sep) ||
        backupPath.startsWith(location + path.sep))
    )
      fail("Synchronized folders cannot overlap the backup location", 409);
    for (const v of this.volumes())
      if (
        v.id !== id &&
        (v.path === location ||
          v.path.startsWith(location + path.sep) ||
          location.startsWith(v.path + path.sep))
      )
        fail(
          `This path overlaps shared folder "${v.name}" (${v.path}). Choose another location.`,
          409,
        );
    if (fs.existsSync(location)) {
      if (!fs.statSync(location).isDirectory())
        fail("The selected path is not a directory");
      fs.accessSync(
        location,
        fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK,
      );
    } else if (!checkOnly) {
      fs.mkdirSync(location, { recursive: true });
    }
    if (checkOnly) return { id, name, path: location };
    if (fs.lstatSync(location).isSymbolicLink())
      fail("Symlink volume paths are not supported");
    location = fs.realpathSync(location);
    const marker = path.join(location, ".arca-volume");
    if (fs.existsSync(marker) && fs.readFileSync(marker, "utf8") !== id)
      fail("Directory belongs to another volume");
    if (createIgnore && this.config.role !== "backup") ensureIgnore(location);
    atomic(marker, id);
    this.db
      .prepare(
        "INSERT INTO volumes(id,name,path) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET selected=1,path=excluded.path",
      )
      .run(id, name, location);
    return this.volume(id);
  }
  assertVolume(v) {
    if (
      fs.realpathSync(v.path) !== v.path ||
      fs.readFileSync(path.join(v.path, ".arca-volume"), "utf8") !== v.id
    )
      fail(
        "Volume unavailable or marker missing; synchronization stopped",
        409,
      );
  }
  hasExactPath(v, name) {
    let current = v.path;
    for (const part of name.split("/")) {
      try {
        if (!fs.readdirSync(current).includes(part)) return false;
        current = path.join(current, part);
        if (fs.lstatSync(current).isSymbolicLink()) return false;
      } catch (e) {
        if (["ENOENT", "ENOTDIR"].includes(e.code)) return false;
        throw e;
      }
    }
    return true;
  }
  caseAlias(volume, name) {
    return this.db
      .prepare(
        "SELECT * FROM files WHERE volume=? AND path_key=? AND path<>? ORDER BY deleted, rev DESC LIMIT 1",
      )
      .get(volume, name.toLowerCase(), name);
  }
  pathHead(volume, name) {
    return this.db
      .prepare(
        "SELECT * FROM files WHERE volume=? AND path_key=? ORDER BY deleted, rev DESC LIMIT 1",
      )
      .get(volume, name.toLowerCase());
  }
  syncRow(row) {
    if (!row.deleted) return row;
    const next = this.caseAlias(row.volume, row.path);
    return next && !next.deleted && next.rev > row.rev
      ? { ...row, replacementPath: next.path }
      : row;
  }
  filePath(v, relative) {
    validPath(relative);
    this.assertVolume(v);
    let current = v.path;
    for (const part of relative.split("/")) {
      current = path.join(current, part);
      try {
        const stat = fs.lstatSync(current);
        if (stat.isSymbolicLink()) fail("Symlinks are not supported", 409);
        if (current !== path.join(v.path, relative) && !stat.isDirectory())
          fail("Parent path is not a directory", 409);
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
    }
    return current;
  }
  blob(hash) {
    if (!/^[a-f0-9]{64}$/.test(hash || "")) fail("Invalid content hash");
    return path.join(this.objects, hash);
  }
  capture(file) {
    const signature = () => {
      const s = fs.statSync(file, { bigint: true });
      return [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(":");
    };
    const before = signature();
    const cached = this.db
      .prepare("SELECT * FROM scan_cache WHERE path=?")
      .get(file);
    if (
      cached &&
      cached.signature === before &&
      Date.now() - cached.verified < 600000 &&
      fs.existsSync(this.blob(cached.hash))
    )
      return { hash: cached.hash, size: cached.size };
    requireSpace(this.objects, fs.statSync(file).size);
    const tmp = path.join(this.objects, `${crypto.randomUUID()}.tmp`);
    try {
      fs.copyFileSync(file, tmp);
      // Only the owned temporary copy needs write access for Windows flushing.
      fs.chmodSync(tmp, fs.statSync(tmp).mode | 0o200);
      if (before !== signature())
        fail("File changed during scan; retrying", 409);
      const hash = hashFile(tmp),
        size = fs.statSync(tmp).size;
      const object = this.blob(hash);
      if (!fs.existsSync(object) || hashFile(object) !== hash) {
        const fd = fs.openSync(tmp, "r+");
        try {
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        fs.renameSync(tmp, object);
        syncDirectory(this.objects);
      }
      const entry = [file, before, hash, size, Date.now()];
      if (this.scanCacheWrites) this.scanCacheWrites.push(entry);
      else
        this.db
          .prepare("INSERT OR REPLACE INTO scan_cache VALUES(?,?,?,?,?)")
          .run(...entry);
      return { hash, size };
    } finally {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    }
  }
  ignoreRules(v) {
    if (this.config.role === "backup") return compileIgnore("");
    const stat = fs.lstatSync(path.join(v.path, IGNORE_FILE), {
      bigint: true,
      throwIfNoEntry: false,
    });
    if (!stat) return compileIgnore("");
    const stamp = `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    this.ignoreCache ||= new Map();
    const old = this.ignoreCache.get(v.id);
    if (old?.stamp === stamp) return old.match;
    const text = readIgnore(v.path);
    const match = compileIgnore(text);
    this.ignoreCache.set(v.id, { stamp, match });
    return match;
  }
  visibleRules(volume) {
    const v = this.volume(volume);
    if (v.selected) return this.ignoreRules(v);
    const policy = this.current(volume, IGNORE_FILE);
    return compileIgnore(
      policy && !policy.deleted && policy.hash
        ? fs.readFileSync(this.blob(policy.hash), "utf8")
        : "",
    );
  }
  visibleTotals(volume) {
    let excluded;
    try {
      excluded = this.visibleRules(volume);
    } catch (error) {
      return { files: null, bytes: null, policyError: error.message };
    }
    return this.rows(volume).reduce(
      (totals, row) => {
        if (!row.deleted && !row.directory && !excluded(row.path, false)) {
          totals.files++;
          totals.bytes += row.size;
        }
        return totals;
      },
      { files: 0, bytes: 0 },
    );
  }
  excluded(volume, name, directory = this.current(volume, name)?.directory) {
    return this.ignoreRules(this.volume(volume))(name, !!directory);
  }
  scan(v, scopes = null, checkpoint = () => {}) {
    this.assertVolume(v);
    const result = new Map();
    const excluded = this.ignoreRules(v);
    const names = new Map();
    // Include indexed names outside a partial scan to detect portable collisions.
    if (scopes !== null)
      for (const row of this.rows(v.id).filter((r) => !r.deleted)) {
        const parts = row.path.split("/");
        for (let i = 1; i <= parts.length; i++) {
          const name = parts.slice(0, i).join("/");
          names.set(name.toLowerCase(), name);
        }
      }
    const visit = (name, entry) => {
      checkpoint();
      if (excluded(name, entry.isDirectory())) return;
      // Unix sockets are process endpoints, not portable file content.
      // Never interpret a previously synced file replaced by a socket as deletion.
      if (entry.isSocket()) {
        const known = this.current(v.id, name);
        if (known && !known.deleted)
          fail(
            `A synced file was replaced by a local socket: ${name}. Move the socket or restore the file, then retry.`,
            409,
          );
        return;
      }
      try {
        validPath(name);
      } catch {
        fail(
          `Folder scan stopped: "${name}" is not a portable NFC path. Rename it using a composed Unicode name without reserved characters, then retry. Files have not been changed.`,
          409,
        );
      }
      const folded = name.toLowerCase();
      if (
        names.has(folded) &&
        names.get(folded) !== name &&
        this.hasExactPath(v, names.get(folded))
      )
        fail(
          `Folder scan stopped: "${names.get(folded)}" and "${name}" differ only by letter case. These names cannot coexist on a case-insensitive disk. Rename one of them to a distinct name, then retry. Files have not been changed.`,
          409,
        );
      names.set(folded, name);
      if (entry.isSymbolicLink())
        fail(`Symlink requires attention: ${name}`, 409);
      if (entry.isDirectory()) {
        result.set(name, directoryItem());
        walk(name);
      } else if (entry.isFile())
        result.set(name, this.capture(this.filePath(v, name)));
      else fail(`Unsupported file: ${name}`, 409);
    };
    const walk = (relative) => {
      for (const entry of fs.readdirSync(path.join(v.path, relative), {
        withFileTypes: true,
      }))
        visit(relative ? `${relative}/${entry.name}` : entry.name, entry);
    };
    if (scopes === null) walk("");
    else
      for (const name of scopes) {
        validPath(name);
        const parts = name.split("/");
        if (
          parts.some((_, i) =>
            excluded(parts.slice(0, i + 1).join("/"), i < parts.length - 1),
          )
        )
          continue;
        if (!this.hasExactPath(v, name)) continue;
        const file = this.filePath(v, name);
        let stat;
        try {
          stat = fs.lstatSync(file);
        } catch (e) {
          if (e.code === "ENOENT") continue;
          throw e;
        }
        visit(name, stat);
      }
    return result;
  }
  rows(id) {
    return this.db
      .prepare("SELECT * FROM files WHERE volume=? ORDER BY path")
      .all(id);
  }
  rowsInScope(id, scopes) {
    if (scopes === null) return this.rows(id);
    const result = new Map();
    const query = this.db.prepare(
      "SELECT * FROM files WHERE volume=? AND (path=? COLLATE NOCASE OR path LIKE ? ESCAPE '!')",
    );
    for (const scope of scopes) {
      const prefix = scope.replace(/[!%_]/g, (c) => "!" + c) + "/%";
      for (const row of query.all(id, scope, prefix)) result.set(row.path, row);
    }
    return [...result.values()];
  }
  current(id, name) {
    return this.db
      .prepare("SELECT * FROM files WHERE volume=? AND path=?")
      .get(id, name);
  }
  setFile(row) {
    this.db
      .prepare(
        "INSERT INTO files(volume,path,hash,size,deleted,rev,directory,path_key) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(volume,path) DO UPDATE SET hash=excluded.hash,size=excluded.size,deleted=excluded.deleted,rev=excluded.rev,directory=excluded.directory,path_key=excluded.path_key",
      )
      .run(
        row.volume,
        row.path,
        row.hash,
        row.size,
        row.deleted,
        row.rev,
        Number(!!row.directory),
        row.path.toLowerCase(),
      );
  }
  queue(row, expected) {
    this.db
      .prepare("INSERT OR REPLACE INTO pending VALUES(?,?,?,?)")
      .run(row.volume, row.path, JSON.stringify(row), expected ?? null);
  }
  preserveFile(file) {
    const kept = `${file}.conflict-local-${crypto.randomUUID().slice(0, 8)}`;
    fs.copyFileSync(file, kept);
    fs.chmodSync(kept, fs.statSync(kept).mode | 0o200);
    const fd = fs.openSync(kept, "r+");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    syncDirectory(path.dirname(kept));
    return kept;
  }
  materialize(row, expected = null) {
    validPath(row.path);
    const v = this.volume(row.volume);
    if (this.ignoreRules(v)(row.path, !!row.directory)) {
      this.db
        .prepare("DELETE FROM pending WHERE volume=? AND path=?")
        .run(row.volume, row.path);
      return;
    }
    // A case-only rename keeps the physical entry until its new spelling arrives.
    let absent = false;
    if (row.deleted) {
      try {
        absent = !fs.lstatSync(path.join(v.path, row.path), {
          throwIfNoEntry: false,
        });
      } catch (error) {
        if (error.code !== "ENOTDIR") throw error;
        absent = true;
      }
    }
    if (row.deleted && (row.replacementPath || absent)) {
      this.setFile(row);
      this.db
        .prepare("DELETE FROM pending WHERE volume=? AND path=?")
        .run(row.volume, row.path);
      return;
    }
    if (!row.deleted) {
      const alias = this.caseAlias(row.volume, row.path);
      if (alias && this.hasExactPath(v, alias.path)) {
        if (this.hasExactPath(v, row.path))
          fail(
            `Both spellings exist: ${alias.path} and ${row.path}. Rename one before retrying.`,
            409,
          );
        const source = this.filePath(v, alias.path);
        const destination = this.filePath(v, row.path);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.renameSync(source, destination);
        syncDirectory(path.dirname(destination));
      }
    }
    const file = this.filePath(v, row.path);
    const previous = this.current(row.volume, row.path);
    if (
      !row.deleted &&
      fs.existsSync(file) &&
      !!row.directory !== fs.lstatSync(file).isDirectory()
    ) {
      if (
        !previous ||
        previous.deleted ||
        !!previous.directory === !!row.directory
      )
        fail(`Path type conflicts with local content: ${row.path}`, 409);
      if (previous.directory) fs.rmdirSync(file);
      else {
        const actual = hashFile(file);
        if (actual !== expected && actual !== previous.hash)
          this.preserveFile(file);
        fs.unlinkSync(file);
      }
      syncDirectory(path.dirname(file));
    }
    if (row.directory) {
      if (fs.existsSync(file) && !fs.lstatSync(file).isDirectory())
        fail(`Directory conflicts with a local file: ${row.path}`, 409);
      if (row.deleted) {
        // Never recursively remove a directory: local/new/excluded content survives.
        if (fs.existsSync(file)) fs.rmdirSync(file);
      } else fs.mkdirSync(file, { recursive: true });
    } else {
      if (!row.deleted) requireSpace(path.dirname(file), row.size);
      if (!row.deleted && hashFile(this.blob(row.hash)) !== row.hash)
        fail("Historical object corruption detected", 409);
      if (fs.existsSync(file)) {
        if (!fs.lstatSync(file).isFile())
          fail(`Path is not a regular file: ${row.path}`, 409);
        const actual = hashFile(file);
        if (actual !== expected && actual !== row.hash) {
          // Preserve edits made by another process since the scan (also on crash recovery).
          this.preserveFile(file);
        }
      }
      if (row.deleted) {
        if (fs.existsSync(file)) fs.unlinkSync(file);
      } else {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = path.join(
          path.dirname(file),
          `.arca-${crypto.randomUUID()}`,
        );
        fs.copyFileSync(this.blob(row.hash), tmp);
        fs.chmodSync(tmp, fs.statSync(tmp).mode | 0o200);
        const fd = fs.openSync(tmp, "r+");
        try {
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        fs.renameSync(tmp, file);
      }
    }
    if (fs.existsSync(path.dirname(file))) syncDirectory(path.dirname(file));
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.setFile(row);
      this.db
        .prepare("DELETE FROM pending WHERE volume=? AND path=?")
        .run(row.volume, row.path);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  recover(volume) {
    const rows = this.db
      .prepare("SELECT * FROM pending WHERE (? IS NULL OR volume=?)")
      .all(volume ?? null, volume ?? null)
      .map((p) => ({ row: JSON.parse(p.row), expected: p.expected }));
    rows.sort((a, b) => {
      if (!!a.row.deleted !== !!b.row.deleted) return a.row.deleted ? -1 : 1;
      if (a.row.deleted) return b.row.path.localeCompare(a.row.path);
      if (!!a.row.directory !== !!b.row.directory)
        return a.row.directory ? -1 : 1;
      return a.row.path.localeCompare(b.row.path);
    });
    for (const p of rows) this.materialize(p.row, p.expected);
  }
  unresolvedConflicts(volume) {
    return this.db
      .prepare(
        "SELECT count(*) AS n FROM files f LEFT JOIN conflict_resolutions c ON c.volume=f.volume AND c.path=f.path WHERE f.volume=? AND f.deleted=0 AND instr(f.path,'.conflict-')>0 AND (c.conflict_rev IS NULL OR c.conflict_rev<f.rev)",
      )
      .get(volume).n;
  }
  conflictStatus(row) {
    const resolution = this.db
      .prepare(
        "SELECT conflict_rev,resolution_rev,choice FROM conflict_resolutions WHERE volume=? AND path=?",
      )
      .get(row.volume, row.path);
    return {
      ...row,
      resolved: !!resolution && row.rev <= resolution.conflict_rev,
      resolutionRev: resolution?.resolution_rev || null,
    };
  }
  commit(
    volume,
    name,
    item,
    author,
    write = false,
    expected = null,
    resolution = null,
    renameFrom = null,
  ) {
    validPath(name);
    write = write && Boolean(this.volume(volume).selected);
    if (write) {
      const file = this.filePath(this.volume(volume), name);
      if (
        fs.existsSync(file) &&
        !((item ? item.directory : this.current(volume, name)?.directory)
          ? fs.lstatSync(file).isDirectory()
          : fs.lstatSync(file).isFile())
      )
        if (
          !item ||
          !this.current(volume, name) ||
          this.current(volume, name).deleted ||
          !!this.current(volume, name).directory === !!item.directory
        )
          fail("Target type differs; synchronize its removal first", 409);
    }
    if (!item && this.current(volume, name)?.directory) {
      if (
        this.db
          .prepare(
            "SELECT 1 FROM files WHERE volume=? AND deleted=0 AND path_key>=? AND path_key<? LIMIT 1",
          )
          .get(volume, name.toLowerCase() + "/", name.toLowerCase() + "0")
      )
        fail(
          "Directory contains synchronized entries; synchronize their removal first",
          409,
        );
      if (write) {
        const target = this.filePath(this.volume(volume), name);
        if (fs.existsSync(target) && fs.readdirSync(target).length)
          fail("Directory is not empty; local contents were preserved", 409);
      }
    }
    const key = name.toLowerCase();
    const alias = this.caseAlias(volume, name);
    if (alias && !alias.deleted && (!item || renameFrom !== alias.path))
      fail("Case-insensitive path collision", 409);
    if (item) {
      if (
        !item.directory &&
        this.db
          .prepare(
            "SELECT 1 FROM files WHERE volume=? AND deleted=0 AND path_key>=? AND path_key<? LIMIT 1",
          )
          .get(volume, key + "/", key + "0")
      )
        fail("Case-insensitive path collision", 409);
      const parts = key.split("/");
      for (let length = 1; length < parts.length; length++) {
        if (
          this.db
            .prepare(
              "SELECT 1 FROM files WHERE volume=? AND path_key=? AND deleted=0 AND directory=0 LIMIT 1",
            )
            .get(volume, parts.slice(0, length).join("/"))
        )
          fail("Case-insensitive path collision", 409);
      }
    }
    const created = new Date().toISOString();
    const values = {
      volume,
      path: name,
      hash: item?.hash ?? null,
      size: item?.size ?? 0,
      deleted: item ? 0 : 1,
      author,
      created,
      directory: Number(
        !!(item?.directory || (!item && this.current(volume, name)?.directory)),
      ),
    };
    this.db.exec("BEGIN IMMEDIATE");
    let row, pendingFrom;
    try {
      if (item && alias && !alias.deleted) {
        const removed = this.db
          .prepare(
            "INSERT INTO revisions(volume,path,hash,size,deleted,author,created,directory) VALUES(?,?,NULL,0,1,?,?,?)",
          )
          .run(volume, alias.path, author, created, alias.directory);
        pendingFrom = Number(removed.lastInsertRowid);
        this.setFile({
          ...alias,
          hash: null,
          size: 0,
          deleted: 1,
          rev: Number(removed.lastInsertRowid),
        });
      }
      const result = this.db
        .prepare(
          "INSERT INTO revisions(volume,path,hash,size,deleted,author,created,directory) VALUES(?,?,?,?,?,?,?,?)",
        )
        .run(
          volume,
          name,
          values.hash,
          values.size,
          values.deleted,
          author,
          created,
          values.directory,
        );
      row = { ...values, rev: Number(result.lastInsertRowid) };
      if (resolution)
        this.db
          .prepare(
            "INSERT INTO conflict_resolutions(volume,path,conflict_rev,resolution_rev,choice) VALUES(?,?,?,?,?) ON CONFLICT(volume,path) DO UPDATE SET conflict_rev=excluded.conflict_rev,resolution_rev=excluded.resolution_rev,choice=excluded.choice",
          )
          .run(
            volume,
            resolution.path,
            resolution.rev,
            row.rev,
            resolution.choice,
          );
      if (write)
        this.queue(
          { ...row, ...(pendingFrom ? { pendingFrom } : {}) },
          expected,
        );
      else this.setFile(row);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    if (write) this.materialize(row, expected);
    return row;
  }
  scanHub() {
    this.recover();
    for (const v of this.volumes().filter((v) => v.selected)) {
      const disk = this.scan(v);
      const known = this.rows(v.id);
      for (const [name, item] of disk) {
        const old = this.current(v.id, name);
        if (!old || old.deleted || entryKey(old) !== entryKey(item))
          this.commit(v.id, name, item, this.config.id);
      }
      for (const row of known.sort((a, b) => b.path.localeCompare(a.path)))
        if (
          !row.deleted &&
          !this.excluded(v.id, row.path) &&
          !disk.has(row.path)
        )
          this.commit(v.id, row.path, null, this.config.id);
      this.db
        .prepare("UPDATE volumes SET last_sync=? WHERE id=?")
        .run(new Date().toISOString(), v.id);
    }
  }
  history(volume, name) {
    return this.db
      .prepare(
        "SELECT * FROM revisions WHERE volume=? AND path=? ORDER BY rev DESC",
      )
      .all(volume, name);
  }
  close() {
    this.db.close();
  }
}
