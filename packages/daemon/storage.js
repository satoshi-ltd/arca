import { entryKey, directoryItem } from "../core/entries.js";
import { mediaKind } from "../core/gallery-date.js";
import { disposableMetadata } from "../core/builtin-exclusions.js";
import { readIgnore, compileIgnore, IGNORE_FILE } from "./exclusions.js";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";

export const TRANSFER_TEMP =
  /^\.arca-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sweepTemp = (file, olderThan) => {
  try {
    if (olderThan <= 0) return fs.unlinkSync(file);
    const stat = fs.statSync(file);
    if (Date.now() - Math.max(stat.mtimeMs, stat.ctimeMs) >= olderThan)
      fs.unlinkSync(file);
  } catch {
    /* A vanished or locked temporary is retried by the next sweep. */
  }
};
export const digest = (data) =>
  crypto.createHash("sha256").update(data).digest("hex");
export const token = () => crypto.randomBytes(32).toString("hex");
export function fail(message, status = 400, code) {
  throw Object.assign(new Error(message), { status, ...(code && { code }) });
}
const foldCase = (location) =>
  process.platform === "darwin" || process.platform === "win32"
    ? location.toLowerCase()
    : location;
export function insidePath(child, parent, strict = false) {
  const a = foldCase(path.resolve(child)),
    b = foldCase(path.resolve(parent));
  return (!strict && a === b) || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}
export function withinPath(child, parent) {
  if (insidePath(child, parent)) return true;
  let target;
  try {
    target = fs.statSync(parent, { bigint: true });
  } catch {
    return false;
  }
  if (!target.ino) return false;
  for (let current = path.resolve(child); ; current = path.dirname(current)) {
    try {
      const stat = fs.statSync(current, { bigint: true });
      if (stat.dev === target.dev && stat.ino === target.ino) return true;
    } catch {}
    if (path.dirname(current) === current) return false;
  }
}
export const overlapPath = (a, b) => withinPath(a, b) || withinPath(b, a);
export const stateOverlap = (home, root, location) =>
  withinPath(home, location) ||
  (withinPath(location, home) &&
    !(withinPath(location, root) && !withinPath(root, location)));
export function validPath(value) {
  if (typeof value !== "string" || !value || value.length > 1024)
    fail(`Invalid file path: ${JSON.stringify(value)}`);
  for (const part of value.split("/")) {
    if (Buffer.byteLength(part.normalize("NFC")) > 255)
      fail(`Unsupported file path: ${JSON.stringify(value)}. A name can hold at most 255 bytes.`);
    if (
      !part ||
      part === "." ||
      part === ".." ||
      /[\\<>:"|?*\x00-\x1f]/.test(part) ||
      /[. ]$/.test(part) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(part) ||
      part.startsWith(".arca-")
    )
      fail(
        `Unsupported file path: ${JSON.stringify(value)}. Remove reserved characters or trailing spaces/dots.`,
      );
  }
  return value.normalize("NFC");
}
const QUICK_PART = 4 * 1024 * 1024;
export function quickHashFile(file) {
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
  );
  try {
    const size = fs.fstatSync(fd).size;
    const hash = crypto.createHash("sha256").update(`arca-quick-1\0${size}\0`);
    const buffer = Buffer.alloc(Math.min(size, QUICK_PART));
    const part = (length, position) => {
      let read = 0;
      while (read < length) {
        const count = fs.readSync(fd, buffer, read, length - read, position + read);
        if (!count) break;
        read += count;
      }
      return buffer.subarray(0, read);
    };
    hash.update(part(buffer.length, 0));
    if (size > QUICK_PART) {
      const tail = Math.min(QUICK_PART, size - QUICK_PART);
      hash.update(part(tail, size - tail));
    }
    return hash.digest("hex");
  } finally {
    fs.closeSync(fd);
  }
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
// Transfer verification runs on the event loop; stream reads yield between chunks.
export async function hashFileAsync(file) {
  const hash = crypto.createHash("sha256");
  const input = fs.createReadStream(file, {
    flags: fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
    highWaterMark: 1024 * 1024,
  });
  for await (const chunk of input) hash.update(chunk);
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
const WEEK = 7 * 86400000;
const reverifyAfter = (hash) => WEEK + (parseInt(hash.slice(0, 8), 16) % WEEK);
export function fileSignature(file) {
  const stat = fs.lstatSync(file, { bigint: true, throwIfNoEntry: false });
  return stat?.isFile()
    ? [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":")
    : null;
}
export function onContainerMount(location, mountinfo) {
  return mountinfo
    .split("\n")
    .map((line) => line.split(" ")[4])
    .filter(Boolean)
    .map((point) =>
      point.replace(/\\([0-7]{3})/g, (_, code) =>
        String.fromCharCode(parseInt(code, 8)),
      ),
    )
    .some(
      (point) =>
        point !== "/" &&
        (location === point || location.startsWith(point + "/")),
    );
}
export function requirePersistentBackup(location) {
  if (
    fs.existsSync("/.dockerenv") &&
    !onContainerMount(location, fs.readFileSync("/proc/self/mountinfo", "utf8"))
  )
    fail(
      `In Docker, back up to a mounted folder. ${location} is inside the container and is lost whenever the container is recreated.`,
      409,
    );
}
function countFiles(directory) {
  let count = 0,
    entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries)
    count += entry.isDirectory()
      ? countFiles(path.join(directory, entry.name))
      : 1;
  return count;
}
// Runs after the folder is unlinked, so a partial failure only leaves files on disk.
export async function deleteSyncedCopy({ root, files, directories }) {
  let deleted = 0,
    bytes = 0;
  for (const [index, item] of files.entries()) {
    if (index % 50 === 0) await new Promise((r) => setImmediate(r));
    try {
      const before = fileSignature(item.file);
      if (
        !before ||
        fs.statSync(item.file).size !== item.size ||
        fs.realpathSync(path.dirname(item.file)) !== path.dirname(item.file) ||
        (await hashFileAsync(item.file)) !== item.hash ||
        fileSignature(item.file) !== before
      )
        continue;
      fs.unlinkSync(item.file);
      deleted++;
      bytes += item.size;
    } catch {
      /* A file that cannot be verified or removed stays on disk. */
    }
  }
  const inPlace = (directory) =>
    fs.lstatSync(directory).isDirectory() &&
    fs.realpathSync(directory) === directory;
  for (const directory of [...directories].sort((a, b) => b.length - a.length))
    try {
      if (!inPlace(directory)) continue;
      const entries = fs.readdirSync(directory, { withFileTypes: true });
      if (
        !entries.every(
          (entry) => entry.isFile() && disposableMetadata(entry.name),
        )
      )
        continue;
      if (!inPlace(directory)) continue;
      for (const entry of entries)
        fs.unlinkSync(path.join(directory, entry.name));
      fs.rmdirSync(directory);
    } catch {
      /* A directory that changed meanwhile stays. */
    }
  return {
    deleted,
    deletedBytes: bytes,
    kept: fs.existsSync(root) ? countFiles(root) : 0,
  };
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

export const SCHEMA_VERSION = 2;
export function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(directory, 0o700);
    } catch {}
  }
}
export function init(home, options = {}) {
  home = path.resolve(home);
  privateDirectory(home);
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
    port: Number(options.port ?? 17831),
    adminToken: token(),
    hub: null,
    ...(options.onboarding ? { onboarding: true } : {}),
  };
  fs.mkdirSync(config.root, { recursive: true });
  config.root = fs.realpathSync(config.root);
  if (withinPath(home, config.root))
    fail("State must be outside synchronized folders");
  atomic(path.join(home, "config.json"), JSON.stringify(config, null, 2));
  return config;
}
export class Store {
  constructor(home) {
    this.home = fs.realpathSync(path.resolve(home));
    privateDirectory(this.home);
    this.configPath = path.join(this.home, "config.json");
    this.config = JSON.parse(fs.readFileSync(this.configPath));
    this.objects = path.join(this.home, "objects");
    this.uploads = path.join(this.home, "uploads");
    fs.mkdirSync(this.objects, { recursive: true });
    fs.mkdirSync(this.uploads, { recursive: true });
    this.db = new DatabaseSync(path.join(this.home, "index.sqlite"));
    this.db.exec("PRAGMA busy_timeout=5000");
    const schema = this.db.prepare("PRAGMA user_version").get().user_version;
    if (schema > SCHEMA_VERSION) {
      this.db.close();
      fail("This index was written by a newer version. Update before opening it.", 409);
    }
    if (schema < SCHEMA_VERSION) this.db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS gallery_derivatives(key TEXT PRIMARY KEY,size INTEGER NOT NULL,used INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS gallery_folders(volume TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS music_folders(volume TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS video_folders(volume TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS video_items(hash TEXT PRIMARY KEY,duration REAL,width INTEGER,height INTEGER,video_codec TEXT,audio_codec TEXT,container TEXT,checked INTEGER NOT NULL,retry INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS video_meta(key TEXT PRIMARY KEY,data TEXT,fetched INTEGER,error INTEGER);
      CREATE TABLE IF NOT EXISTS video_overrides(volume TEXT NOT NULL,key TEXT NOT NULL,tmdb TEXT,kind TEXT,kids INTEGER,PRIMARY KEY(volume,key));
      CREATE TABLE IF NOT EXISTS video_positions(volume TEXT NOT NULL,path TEXT NOT NULL,hash TEXT NOT NULL,position REAL NOT NULL,duration REAL NOT NULL,device TEXT NOT NULL,name TEXT NOT NULL,updated INTEGER NOT NULL,PRIMARY KEY(volume,path));
      CREATE TABLE IF NOT EXISTS video_watched(volume TEXT NOT NULL,path TEXT NOT NULL,updated INTEGER NOT NULL,PRIMARY KEY(volume,path));
      CREATE TABLE IF NOT EXISTS video_hidden(volume TEXT NOT NULL,id TEXT NOT NULL,since INTEGER NOT NULL,PRIMARY KEY(volume,id));
      CREATE TABLE IF NOT EXISTS audio_positions(volume TEXT NOT NULL,path TEXT NOT NULL,hash TEXT NOT NULL,position REAL NOT NULL,duration REAL NOT NULL,device TEXT NOT NULL,name TEXT NOT NULL,updated INTEGER NOT NULL,PRIMARY KEY(volume,path));
      CREATE TABLE IF NOT EXISTS audio_outbox(volume TEXT NOT NULL,path TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(volume,path));
      CREATE TABLE IF NOT EXISTS music_tracks(hash TEXT PRIMARY KEY,title TEXT,artist TEXT,album_artist TEXT,album TEXT,track INTEGER,disc INTEGER,year INTEGER,genre TEXT,duration REAL,codec TEXT,cover TEXT,checked INTEGER NOT NULL,retry INTEGER NOT NULL DEFAULT 0,release TEXT);
      CREATE INDEX IF NOT EXISTS music_tracks_cover ON music_tracks(cover);
      CREATE TABLE IF NOT EXISTS gallery_assets(volume TEXT,source TEXT,asset TEXT,resources TEXT NOT NULL,deleted INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(volume,source,asset));
      CREATE TABLE IF NOT EXISTS gallery_members(volume TEXT,path TEXT,source TEXT,asset TEXT,PRIMARY KEY(volume,path));
      CREATE TABLE IF NOT EXISTS gallery_deletions(seq INTEGER PRIMARY KEY AUTOINCREMENT,author TEXT,id TEXT,volume TEXT,request TEXT,result TEXT,source TEXT,asset TEXT,created INTEGER,UNIQUE(author,id));
      CREATE INDEX IF NOT EXISTS gallery_deletions_source ON gallery_deletions(volume,source);
      CREATE TABLE IF NOT EXISTS accepted_proposals(id TEXT PRIMARY KEY,volume TEXT NOT NULL,device TEXT NOT NULL,base INTEGER NOT NULL,revision INTEGER);
      CREATE INDEX IF NOT EXISTS accepted_proposals_revision ON accepted_proposals(revision);
      CREATE INDEX IF NOT EXISTS accepted_proposals_volume ON accepted_proposals(volume);
      CREATE TABLE IF NOT EXISTS gallery_metadata(hash TEXT PRIMARY KEY,captured TEXT);
      CREATE TABLE IF NOT EXISTS volumes(id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, selected INTEGER NOT NULL DEFAULT 1,last_sync TEXT);
      CREATE TABLE IF NOT EXISTS media_modes(volume TEXT PRIMARY KEY,mode TEXT NOT NULL CHECK(mode IN ('stream','keep')));
      CREATE TABLE IF NOT EXISTS revisions(rev INTEGER PRIMARY KEY AUTOINCREMENT, volume TEXT NOT NULL, path TEXT NOT NULL, hash TEXT, size INTEGER NOT NULL, deleted INTEGER NOT NULL, author TEXT NOT NULL, created TEXT NOT NULL,directory INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS files(volume TEXT NOT NULL,path TEXT NOT NULL,hash TEXT,size INTEGER NOT NULL,deleted INTEGER NOT NULL,rev INTEGER NOT NULL,directory INTEGER NOT NULL DEFAULT 0,path_key TEXT NOT NULL,PRIMARY KEY(volume,path));
      CREATE TABLE IF NOT EXISTS history_views(hub TEXT,volume TEXT,filter TEXT,version TEXT,updated INTEGER,value TEXT,PRIMARY KEY(hub,volume,filter));
      CREATE TABLE IF NOT EXISTS file_generations(volume TEXT PRIMARY KEY,generation INTEGER NOT NULL);
      CREATE TRIGGER IF NOT EXISTS files_generation_insert AFTER INSERT ON files BEGIN
        INSERT INTO file_generations(volume,generation) VALUES(NEW.volume,1) ON CONFLICT(volume) DO UPDATE SET generation=generation+1;
      END;
      CREATE TRIGGER IF NOT EXISTS files_generation_update AFTER UPDATE ON files BEGIN
        INSERT INTO file_generations(volume,generation) VALUES(OLD.volume,1) ON CONFLICT(volume) DO UPDATE SET generation=generation+1;
        INSERT INTO file_generations(volume,generation) SELECT NEW.volume,1 WHERE NEW.volume<>OLD.volume ON CONFLICT(volume) DO UPDATE SET generation=generation+1;
      END;
      CREATE TRIGGER IF NOT EXISTS files_generation_delete AFTER DELETE ON files BEGIN
        INSERT INTO file_generations(volume,generation) VALUES(OLD.volume,1) ON CONFLICT(volume) DO UPDATE SET generation=generation+1;
      END;
      CREATE TABLE IF NOT EXISTS local_files(volume TEXT NOT NULL,path TEXT NOT NULL,hash TEXT,size INTEGER NOT NULL,deleted INTEGER NOT NULL,rev INTEGER NOT NULL,directory INTEGER NOT NULL DEFAULT 0,path_key TEXT NOT NULL,PRIMARY KEY(volume,path));
      CREATE VIEW IF NOT EXISTS files_view AS
        SELECT f.volume,f.path,f.hash,f.size,f.deleted,f.rev,f.directory,f.path_key FROM files f
          WHERE NOT EXISTS (SELECT 1 FROM local_files l WHERE l.volume=f.volume AND l.path=f.path)
        UNION ALL SELECT volume,path,hash,size,deleted,rev,directory,path_key FROM local_files;
      CREATE TRIGGER IF NOT EXISTS local_generation_insert AFTER INSERT ON local_files BEGIN
        INSERT INTO file_generations(volume,generation) VALUES(NEW.volume,1) ON CONFLICT(volume) DO UPDATE SET generation=generation+1;
      END;
      CREATE TRIGGER IF NOT EXISTS local_generation_update AFTER UPDATE ON local_files BEGIN
        INSERT INTO file_generations(volume,generation) VALUES(OLD.volume,1) ON CONFLICT(volume) DO UPDATE SET generation=generation+1;
      END;
      CREATE TRIGGER IF NOT EXISTS local_generation_delete AFTER DELETE ON local_files BEGIN
        INSERT INTO file_generations(volume,generation) VALUES(OLD.volume,1) ON CONFLICT(volume) DO UPDATE SET generation=generation+1;
      END;
      CREATE TABLE IF NOT EXISTS pending(volume TEXT NOT NULL,path TEXT NOT NULL,row TEXT NOT NULL,expected TEXT,failures INTEGER NOT NULL DEFAULT 0,side TEXT,PRIMARY KEY(volume,path));
      CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY,name TEXT NOT NULL,token_hash TEXT NOT NULL,role TEXT NOT NULL,revoked INTEGER NOT NULL DEFAULT 0,last_seen TEXT,last_address TEXT);
      CREATE TABLE IF NOT EXISTS conflict_resolutions(volume TEXT NOT NULL,path TEXT NOT NULL,conflict_rev INTEGER NOT NULL,resolution_rev INTEGER NOT NULL,choice TEXT NOT NULL,PRIMARY KEY(volume,path));
      CREATE TABLE IF NOT EXISTS transitions(id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS snapshot_sessions(id TEXT PRIMARY KEY,owner TEXT NOT NULL,volume TEXT NOT NULL,expires INTEGER NOT NULL,total INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS snapshot_files(session TEXT NOT NULL,path TEXT NOT NULL,hash TEXT,row TEXT NOT NULL,PRIMARY KEY(session,path));
      CREATE INDEX IF NOT EXISTS revisions_volume_path ON revisions(volume,path,rev);
      CREATE TABLE IF NOT EXISTS machine_reports(device TEXT PRIMARY KEY,report TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS auth_failures(purpose TEXT PRIMARY KEY,failures INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS pairing(code_hash TEXT PRIMARY KEY,name TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS backup_ack(device TEXT PRIMARY KEY,revision INTEGER NOT NULL DEFAULT 0,enabled INTEGER NOT NULL DEFAULT 1,updated TEXT);
      CREATE TABLE IF NOT EXISTS sync_dirty(seq INTEGER PRIMARY KEY AUTOINCREMENT,volume TEXT NOT NULL,path TEXT NOT NULL,UNIQUE(volume,path));
      CREATE TABLE IF NOT EXISTS sync_state(volume TEXT PRIMARY KEY,cursor INTEGER NOT NULL DEFAULT 0,full_at INTEGER NOT NULL DEFAULT 0,policy TEXT);
      CREATE TABLE IF NOT EXISTS forgotten(volume TEXT,path TEXT,at INTEGER NOT NULL,PRIMARY KEY(volume,path));
      CREATE INDEX IF NOT EXISTS files_volume_rev ON files(volume,rev);
      CREATE INDEX IF NOT EXISTS files_visible_totals ON files(volume,path,size) WHERE deleted=0 AND directory=0;
      CREATE INDEX IF NOT EXISTS files_conflict_rev ON files(volume,rev) WHERE instr(path,'.conflict-')>0;
      CREATE TABLE IF NOT EXISTS scan_cache(path TEXT PRIMARY KEY,signature TEXT NOT NULL,hash TEXT NOT NULL,size INTEGER NOT NULL,verified INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS backup_history(rev INTEGER PRIMARY KEY,row TEXT NOT NULL);
    `);
    if (
      !this.db
        .prepare("PRAGMA table_info(gallery_metadata)")
        .all()
        .some((column) => column.name === "date_checked")
    )
      this.db.exec(
        "ALTER TABLE gallery_metadata ADD COLUMN date_checked INTEGER NOT NULL DEFAULT 0",
      );
    if (
      !this.db
        .prepare("PRAGMA table_info(gallery_metadata)")
        .all()
        .some((column) => column.name === "modified")
    )
      this.db.exec("ALTER TABLE gallery_metadata ADD COLUMN modified TEXT");
    if (
      !this.db
        .prepare("PRAGMA table_info(sync_state)")
        .all()
        .some((column) => column.name === "dates")
    )
      this.db.exec(
        "ALTER TABLE sync_state ADD COLUMN dates INTEGER NOT NULL DEFAULT 0",
      );
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS added_dates(volume TEXT NOT NULL,path TEXT NOT NULL,hash TEXT NOT NULL,added TEXT NOT NULL,PRIMARY KEY(volume,path))",
    );
    if (
      !this.db
        .prepare("PRAGMA table_info(music_tracks)")
        .all()
        .some((column) => column.name === "retry")
    )
      this.db.exec(
        "ALTER TABLE music_tracks ADD COLUMN retry INTEGER NOT NULL DEFAULT 0",
      );
    if (
      !this.db
        .prepare("PRAGMA table_info(music_tracks)")
        .all()
        .some((column) => column.name === "release")
    )
      this.db.exec("ALTER TABLE music_tracks ADD COLUMN release TEXT");
    for (const column of ["audio_tracks", "subtitle_streams"])
      if (
        !this.db
          .prepare("PRAGMA table_info(video_items)")
          .all()
          .some((row) => row.name === column)
      )
        this.db.exec(`ALTER TABLE video_items ADD COLUMN ${column} TEXT`);
    if (
      !this.db
        .prepare("PRAGMA table_info(snapshot_sessions)")
        .all()
        .some((column) => column.name === "total")
    ) {
      this.db
        .exec(`ALTER TABLE snapshot_sessions ADD COLUMN total INTEGER NOT NULL DEFAULT 0;
        UPDATE snapshot_sessions SET total=(SELECT COUNT(*) FROM snapshot_files WHERE session=snapshot_sessions.id);`);
    }
    if (
      !this.db
        .prepare("PRAGMA table_info(pending)")
        .all()
        .some((column) => column.name === "failures")
    )
      this.db.exec(
        "ALTER TABLE pending ADD COLUMN failures INTEGER NOT NULL DEFAULT 0",
      );
    if (
      !this.db
        .prepare("PRAGMA table_info(pending)")
        .all()
        .some((column) => column.name === "side")
    )
      this.db.exec("ALTER TABLE pending ADD COLUMN side TEXT");
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
  mediaMode(id) {
    return this.db.prepare("SELECT mode FROM media_modes WHERE volume=?").get(id)?.mode || null;
  }
  mediaModes() {
    return Object.fromEntries(this.db.prepare("SELECT volume,mode FROM media_modes ORDER BY volume").all().map((row) => [row.volume, row.mode]));
  }
  volume(id) {
    const v = this.db.prepare("SELECT * FROM volumes WHERE id=?").get(id);
    if (!v) fail("Unknown volume", 404);
    return v;
  }
  syncedCopyPlan(id) {
    const v = this.volume(id);
    this.assertVolume(v);
    const excluded = this.ignoreRules(v);
    const files = [],
      directories = new Set([v.path]);
    for (const row of this.db
      .prepare(
        "SELECT path,hash,size,directory FROM files WHERE volume=? AND deleted=0",
      )
      .all(id)) {
      if (excluded(row.path, !!row.directory)) continue;
      let file;
      try {
        file = this.filePath(v, row.path);
      } catch {
        continue;
      }
      if (row.directory) directories.add(file);
      else if (row.hash) files.push({ file, hash: row.hash, size: row.size });
      for (
        let parent = path.dirname(file);
        parent.startsWith(v.path + path.sep);
        parent = path.dirname(parent)
      )
        directories.add(parent);
    }
    return { root: v.path, files, directories };
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
        "gallery_assets",
        "gallery_members",
        "gallery_deletions",
        "accepted_proposals",
        "history_views",
        "snapshot_sessions",
        "sync_dirty",
        "forgotten",
        "sync_state",
        "pending",
        "files",
        "local_files",
        "revisions",
        "added_dates",
        "audio_positions",
        "audio_outbox",
        "video_overrides",
        "video_positions",
        "video_watched",
        "video_hidden",
        "media_modes",
      ])
        this.db.prepare(`DELETE FROM ${table} WHERE volume=?`).run(id);
      this.db
        .prepare(
          "DELETE FROM proposals WHERE json_extract(response, '$.volume')=?",
        )
        .run(id);
      this.db.prepare("DELETE FROM gallery_folders WHERE volume=?").run(id);
      this.db.prepare("DELETE FROM music_folders WHERE volume=?").run(id);
      this.db.prepare("DELETE FROM video_folders WHERE volume=?").run(id);
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
  addVolume(name, location, id = crypto.randomUUID(), checkOnly = false) {
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
    if (stateOverlap(this.home, this.config.root, location))
      fail("State and volume paths overlap", 409);
    const backupPath = this.config.backup?.path;
    if (backupPath && overlapPath(location, backupPath))
      fail("Synchronized folders cannot overlap the backup location", 409);
    for (const v of this.volumes())
      if (v.id !== id && (insidePath(v.path, location) || insidePath(location, v.path)))
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
        const actual = fs
          .readdirSync(current)
          .find((entry) => entry.normalize("NFC") === part.normalize("NFC"));
        if (!actual) return false;
        current = path.join(current, actual);
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
  rememberFileDate(hash, modified) {
    if (
      !hash ||
      typeof modified !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(modified) ||
      !Number.isFinite(Date.parse(modified))
    )
      return;
    this.db
      .prepare(
        "INSERT INTO gallery_metadata(hash,modified) VALUES(?,?) ON CONFLICT(hash) DO UPDATE SET modified=min(coalesce(gallery_metadata.modified,excluded.modified),excluded.modified)",
      )
      .run(hash, modified);
  }
  rememberAddedDate(volume, name, hash, added) {
    if (
      !hash ||
      typeof added !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(added) ||
      !Number.isFinite(Date.parse(added))
    )
      return;
    this.db
      .prepare(
        "INSERT INTO added_dates(volume,path,hash,added) VALUES(?,?,?,?) ON CONFLICT(volume,path) DO UPDATE SET hash=excluded.hash,added=excluded.added",
      )
      .run(volume, name, hash, added);
  }
  withFileDates(rows) {
    const media = rows.filter(
      (row) => row.hash && !row.deleted && mediaKind(row.path),
    );
    if (!media.length) return rows;
    const marks = [...new Set(media.map((row) => row.hash))];
    const dates = new Map(
      this.db
        .prepare(
          `SELECT hash,modified FROM gallery_metadata WHERE modified IS NOT NULL AND hash IN (${marks.map(() => "?").join(",")})`,
        )
        .all(...marks)
        .map((row) => [row.hash, row.modified]),
    );
    const first = this.db.prepare(
      "SELECT min(created) AS added FROM revisions WHERE volume=? AND path=? AND hash=?",
    );
    const attached = new Map(
      media.map((row) => [
        row,
        {
          ...row,
          ...(dates.has(row.hash) ? { modified: dates.get(row.hash) } : {}),
          ...(() => {
            const added = first.get(row.volume, row.path, row.hash)?.added;
            return added ? { added } : {};
          })(),
        },
      ]),
    );
    return rows.map((row) => attached.get(row) || row);
  }
  syncRow(row) {
    if (!row.deleted) return row;
    const next = this.caseAlias(row.volume, row.path);
    return next && !next.deleted && next.rev > row.rev
      ? { ...row, replacementPath: next.path }
      : row;
  }
  filePath(v, relative) {
    relative = validPath(relative);
    this.assertVolume(v);
    let current = v.path;
    const parts = relative.split("/");
    for (const [index, part] of parts.entries()) {
      let next = path.join(current, part);
      try {
        if (/[^\x00-\x7f]/.test(part)) {
          const aliases = fs
            .readdirSync(current)
            .filter((entry) => entry.normalize("NFC") === part);
          if (aliases.length > 1)
            fail(
              `Multiple Unicode spellings exist for "${relative}". Rename one before retrying.`,
              409,
            );
          if (aliases.length) next = path.join(current, aliases[0]);
        }
        const stat = fs.lstatSync(next);
        if (stat.isSymbolicLink())
          fail(`Symlinks are not supported: ${relative}`, 409);
        if (index < parts.length - 1 && !stat.isDirectory())
          fail(`Parent path is not a directory: ${relative}`, 409);
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
      current = next;
    }
    return current;
  }
  blob(hash) {
    if (!/^[a-f0-9]{64}$/.test(hash || "")) fail("Invalid content hash");
    return path.join(this.objects, hash);
  }
  streamOnly(id) {
    return (
      this.config.role === "hub" &&
      !!this.db.prepare("SELECT 1 FROM video_folders WHERE volume=?").get(id)
    );
  }
  contentHash(volume, file) {
    return this.streamOnly(volume) ? quickHashFile(file) : hashFile(file);
  }
  async holds(volume, file, hash) {
    if (this.streamOnly(volume) && quickHashFile(file) === hash) return true;
    return (await hashFileAsync(file)) === hash;
  }
  capture(file, accepted = null, inPlace = false) {
    const hashOf = inPlace ? quickHashFile : hashFile;
    const signature = () => {
      const s = fs.statSync(file, { bigint: true });
      return [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(":");
    };
    const before = signature();
    const cached = this.db
      .prepare("SELECT * FROM scan_cache WHERE path=?")
      .get(file);
    const record = (entry) => {
      if (this.scanCacheWrites) this.scanCacheWrites.push(entry);
      else
        this.db
          .prepare("INSERT OR REPLACE INTO scan_cache(path,signature,hash,size,verified) VALUES(?,?,?,?,?)")
          .run(...entry);
    };
    if (
      cached &&
      cached.signature === before &&
      (inPlace ||
        cached.hash === accepted ||
        fs.existsSync(this.blob(cached.hash)))
    ) {
      // Coarse-timestamp filesystems can hide a same-size rewrite, so trusted content is re-hashed every one to two weeks.
      if (Date.now() - cached.verified < reverifyAfter(cached.hash))
        return { hash: cached.hash, size: cached.size };
      const object = this.blob(cached.hash);
      if (
        (hashOf(file) === cached.hash || (inPlace && hashFile(file) === cached.hash)) &&
        signature() === before &&
        (inPlace || !fs.existsSync(object) || hashFile(object) === cached.hash)
      ) {
        record([file, before, cached.hash, cached.size, Date.now()]);
        return { hash: cached.hash, size: cached.size };
      }
    }
    if (inPlace) {
      const hash = quickHashFile(file);
      const size = fs.statSync(file).size;
      if (before !== signature())
        fail("File changed during scan; retrying", 409);
      record([file, before, hash, size, Date.now()]);
      return { hash, size };
    }
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
      record([file, before, hash, size, Date.now()]);
      return { hash, size };
    } finally {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    }
  }
  ignoreRules(v) {
    const stat = fs.lstatSync(path.join(v.path, IGNORE_FILE), {
      bigint: true,
      throwIfNoEntry: false,
    });
    if (!stat) return (this.emptyIgnore ||= compileIgnore(""));
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
    const hash = policy && !policy.deleted ? policy.hash : null;
    this.remoteIgnoreCache ||= new Map();
    const cached = this.remoteIgnoreCache.get(volume);
    if (cached?.hash === hash) return cached.match;
    const match = compileIgnore(
      hash ? fs.readFileSync(this.blob(hash), "utf8") : "",
    );
    this.remoteIgnoreCache.set(volume, { hash, match });
    return match;
  }
  visibleTotals(volume) {
    try {
      this.visibleRules(volume);
    } catch (error) {
      return { files: null, bytes: null, policyError: error.message };
    }
    const { files, bytes } = this.db
      .prepare(
        `SELECT count(*) AS files, coalesce(sum(size),0) AS bytes FROM ${this.fileSource()} WHERE volume=? AND deleted=0 AND directory=0`,
      )
      .get(volume);
    return { files, bytes };
  }
  async allVisibleTotals() {
    return new Map(
      this.volumes().map((volume) => [
        volume.id,
        this.visibleTotals(volume.id),
      ]),
    );
  }
  forgetExcluded(volume) {
    const excluded = this.visibleRules(volume);
    const paths = this.db
      .prepare("SELECT path,directory FROM files WHERE volume=?")
      .all(volume)
      .filter((row) => excluded(row.path, !!row.directory))
      .map((row) => row.path);
    if (!paths.length) return 0;
    const forget = this.db.prepare(
      "DELETE FROM files WHERE volume=? AND path=?",
    );
    const remember = this.db.prepare(
      "INSERT INTO forgotten(volume,path,at) SELECT volume,path,? FROM revisions WHERE volume=? AND path=? LIMIT 1 ON CONFLICT(volume,path) DO UPDATE SET at=excluded.at",
    );
    const at = Date.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const name of paths) {
        forget.run(volume, name);
        remember.run(at, volume, name);
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return paths.length;
  }
  excluded(volume, name, directory = this.current(volume, name)?.directory) {
    return this.visibleRules(volume)(name, !!directory);
  }
  scan(v, scopes = null, checkpoint = () => {}) {
    this.assertVolume(v);
    const inPlace = this.streamOnly(v.id);
    const result = new Map();
    const excluded = this.ignoreRules(v);
    const names = new Map();
    const unicodeNames = new Map();
    // Include indexed names outside a partial scan to detect portable collisions.
    if (scopes !== null)
      for (const row of this.db
        .prepare("SELECT path FROM files WHERE volume=? AND deleted=0")
        .all(v.id)) {
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
      const original = name;
      name = validPath(name);
      const previous = unicodeNames.get(name);
      if (previous && previous !== original)
        fail(
          `Folder scan stopped: "${previous}" and "${original}" are equivalent Unicode names. Rename one before retrying. Files have not been changed.`,
          409,
        );
      unicodeNames.set(name, original);
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
      } else if (entry.isFile()) {
        const known =
          this.config.role === "hub" ? null : this.current(v.id, name);
        result.set(
          name,
          this.capture(
            this.filePath(v, name),
            known && !known.deleted ? known.hash : null,
            inPlace,
          ),
        );
      } else fail(`Unsupported file: ${name}`, 409);
    };
    const walk = (relative) => {
      const directory = relative ? this.filePath(v, relative) : v.path;
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        // A concurrent materialization may still own a young temporary.
        if (scopes === null && entry.isFile() && TRANSFER_TEMP.test(entry.name))
          sweepTemp(path.join(directory, entry.name), 3600000);
        visit(relative ? `${relative}/${entry.name}` : entry.name, entry);
      }
    };
    if (scopes === null) walk("");
    else
      for (const requested of scopes) {
        const name = validPath(requested);
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
    for (const requested of scopes) {
      const scope = validPath(requested);
      const prefix = scope.replace(/[!%_]/g, (c) => "!" + c) + "/%";
      for (const row of query.all(id, scope, prefix)) result.set(row.path, row);
    }
    return [...result.values()];
  }
  current(id, name) {
    return this.db
      .prepare("SELECT * FROM files WHERE volume=? AND path=?")
      .get(id, name.normalize("NFC"));
  }
  fileSource() {
    return this.db.prepare("SELECT 1 FROM local_files LIMIT 1").get()
      ? "files_view"
      : "files";
  }
  viewCurrent(id, name) {
    return this.db
      .prepare(`SELECT * FROM ${this.fileSource()} WHERE volume=? AND path=?`)
      .get(id, name.normalize("NFC"));
  }
  replaceLocal(v, scopes, disk) {
    const known = new Map(this.rowsInScope(v.id, scopes).map((row) => [row.path, row]));
    const rows = [];
    for (const [name, item] of disk) {
      const old = known.get(name);
      if (this.excluded(v.id, name, !!item.directory)) continue;
      if (!old || old.deleted || entryKey(old) !== entryKey(item))
        rows.push({
          path: name,
          hash: item.directory ? null : item.hash,
          size: item.directory ? 0 : item.size || 0,
          deleted: 0,
          rev: old?.rev ?? 0,
          directory: Number(!!item.directory),
        });
    }
    for (const old of known.values())
      if (
        !old.deleted &&
        !disk.has(old.path) &&
        !this.excluded(v.id, old.path, !!old.directory)
      )
        rows.push({ ...old, deleted: 1 });
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.clearLocal(v.id, scopes);
      const insert = this.db.prepare(
        "INSERT OR REPLACE INTO local_files(volume,path,hash,size,deleted,rev,directory,path_key) VALUES(?,?,?,?,?,?,?,?)",
      );
      for (const row of rows)
        insert.run(v.id, row.path, row.hash ?? null, row.size, row.deleted, row.rev, row.directory ? 1 : 0, row.path.toLowerCase());
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  clearLocal(id, scopes = null) {
    if (scopes === null) {
      this.db.prepare("DELETE FROM local_files WHERE volume=?").run(id);
      return;
    }
    const remove = this.db.prepare(
      "DELETE FROM local_files WHERE volume=? AND (path=? COLLATE NOCASE OR path LIKE ? ESCAPE '!')",
    );
    for (const requested of scopes) {
      const scope = validPath(requested);
      remove.run(id, scope, scope.replace(/[!%_]/g, (c) => "!" + c) + "/%");
    }
  }
  setFile(row) {
    this.db.prepare("DELETE FROM local_files WHERE volume=? AND path=?").run(row.volume, row.path);
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
      .prepare(
        "INSERT INTO pending(volume,path,row,expected) VALUES(?,?,?,?) ON CONFLICT(volume,path) DO UPDATE SET row=excluded.row,expected=excluded.expected,failures=CASE WHEN json_extract(pending.row,'$.rev') IS json_extract(excluded.row,'$.rev') THEN pending.failures ELSE 0 END",
      )
      .run(row.volume, row.path, JSON.stringify(row), expected ?? null);
  }
  markDirty(volume, name) {
    this.db
      .prepare("INSERT OR REPLACE INTO sync_dirty(volume,path) VALUES(?,?)")
      .run(volume, name);
  }
  knownContent(row, actual, expected) {
    if (!actual) return false;
    if (actual === expected || actual === row.hash) return true;
    return Boolean(
      row.reselected &&
        this.db
          .prepare(
            "SELECT 1 FROM revisions WHERE volume=? AND path=? AND hash=? LIMIT 1",
          )
          .get(row.volume, row.path, actual),
    );
  }
  displace(file, row) {
    const suffix = `.conflict-local-${crypto.randomUUID().slice(0, 8)}`;
    this.db
      .prepare("UPDATE pending SET side=? WHERE volume=? AND path=?")
      .run(suffix, row.volume, row.path);
    fs.renameSync(file, file + suffix);
    return file + suffix;
  }
  restoreDisplaced(row, file, known) {
    const suffix = this.db
      .prepare("SELECT side FROM pending WHERE volume=? AND path=?")
      .get(row.volume, row.path)?.side;
    if (!suffix) return;
    const side = file + suffix;
    if (fs.existsSync(side)) {
      if (!fs.existsSync(file)) {
        fs.renameSync(side, file);
        syncDirectory(path.dirname(file));
      } else if (this.settle(side, known, row.volume))
        this.markDirty(row.volume, row.path + suffix);
    }
    this.db
      .prepare("UPDATE pending SET side=NULL WHERE volume=? AND path=?")
      .run(row.volume, row.path);
  }
  settle(side, known, volume = null) {
    let actual = null;
    try {
      actual = volume ? this.contentHash(volume, side) : hashFile(side);
      if (volume && !known(actual) && this.streamOnly(volume)) actual = hashFile(side);
    } catch {
      actual = null;
    }
    if (known(actual)) {
      fs.unlinkSync(side);
      return null;
    }
    syncDirectory(path.dirname(side));
    return side;
  }
  removeDirectoryEntry(file) {
    const entries = fs.readdirSync(file, { withFileTypes: true });
    if (
      entries.every(
        (entry) =>
          entry.isFile() &&
          (disposableMetadata(entry.name) ||
            TRANSFER_TEMP.test(entry.name)),
      )
    )
      for (const entry of entries) fs.rmSync(path.join(file, entry.name), { force: true });
    try {
      fs.rmdirSync(file);
      return true;
    } catch (error) {
      if (["ENOTEMPTY", "EEXIST"].includes(error.code)) return false;
      throw error;
    }
  }
  sweepTemps(directory, olderThan = 0) {
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries)
      if (entry.isFile() && TRANSFER_TEMP.test(entry.name))
        sweepTemp(path.join(directory, entry.name), olderThan);
  }
  materialize(row, expected = null) {
    try {
      return this.materializeRow(row, expected);
    } catch (error) {
      this.db
        .prepare(
          "UPDATE pending SET failures=failures+1 WHERE volume=? AND path=?",
        )
        .run(row.volume, row.path);
      throw error;
    }
  }
  materializeRow(row, expected = null) {
    validPath(row.path);
    const v = this.volume(row.volume);
    const file = this.filePath(v, row.path);
    const previous = this.current(row.volume, row.path);
    const keep = (side) => {
      if (side) this.markDirty(row.volume, row.path + side.slice(file.length));
    };
    this.restoreDisplaced(
      row,
      file,
      (actual) =>
        (actual && actual === previous?.hash) ||
        this.knownContent(row, actual, expected),
    );
    if (this.ignoreRules(v)(row.path, !!row.directory)) {
      this.db
        .prepare("DELETE FROM pending WHERE volume=? AND path=?")
        .run(row.volume, row.path);
      return;
    }
    // A renamed file must exist at its destination before removing its source,
    // including when recovery otherwise processes deletions first.
    if (row.deleted && row.renameDestination) {
      const pending = this.db
        .prepare("SELECT row,expected FROM pending WHERE volume=? AND path=?")
        .get(row.volume, row.renameDestination);
      if (pending) this.materialize(JSON.parse(pending.row), pending.expected);
    }
    // A case-only rename keeps the physical entry until its new spelling arrives.
    let absent = false;
    if (row.deleted) {
      try {
        absent = !fs.lstatSync(this.filePath(v, row.path), {
          throwIfNoEntry: false,
        });
      } catch (error) {
        if (error.code !== "ENOTDIR") throw error;
        absent = true;
      }
    }
    if (row.deleted && (row.replacementPath || absent)) {
      this.complete(row);
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
      else
        keep(
          this.settle(
            this.displace(file, row),
            (actual) =>
              actual === previous.hash || this.knownContent(row, actual, expected),
            row.volume,
          ),
        );
      syncDirectory(path.dirname(file));
    }
    if (row.directory) {
      if (fs.existsSync(file) && !fs.lstatSync(file).isDirectory())
        fail(`Directory conflicts with a local file: ${row.path}`, 409);
      if (row.deleted) {
        // Never recursively remove a directory: local/new/excluded content survives.
        if (fs.existsSync(file) && !this.removeDirectoryEntry(file))
          this.markDirty(row.volume, row.path);
      } else fs.mkdirSync(file, { recursive: true });
    } else {
      if (!row.deleted) requireSpace(path.dirname(file), row.size);
      if (!row.deleted && hashFile(this.blob(row.hash)) !== row.hash)
        fail("Historical object corruption detected", 409);
      if (fs.existsSync(file) && !fs.lstatSync(file).isFile())
        fail(`Path is not a regular file: ${row.path}`, 409);
      const known = (actual) => this.knownContent(row, actual, expected);
      if (row.deleted) {
        if (fs.existsSync(file)) {
          const side = this.settle(this.displace(file, row), known, row.volume);
          if (side && !fs.existsSync(file)) {
            fs.renameSync(side, file);
            this.markDirty(row.volume, row.path);
          } else keep(side);
        }
      } else {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = path.join(
          path.dirname(file),
          `.arca-${crypto.randomUUID()}`,
        );
        try {
          fs.copyFileSync(this.blob(row.hash), tmp);
          fs.chmodSync(tmp, fs.statSync(tmp).mode | 0o200);
          const fd = fs.openSync(tmp, "r+");
          try {
            fs.fsyncSync(fd);
          } finally {
            fs.closeSync(fd);
          }
          const side = fs.existsSync(file) ? this.displace(file, row) : null;
          try {
            fs.renameSync(tmp, file);
          } catch (error) {
            if (side && !fs.existsSync(file)) fs.renameSync(side, file);
            throw error;
          }
          if (side) keep(this.settle(side, known, row.volume));
        } finally {
          fs.rmSync(tmp, { force: true });
        }
      }
    }
    if (fs.existsSync(path.dirname(file))) syncDirectory(path.dirname(file));
    this.complete(
      row,
      file,
      !row.deleted && !row.directory && fileSignature(file),
    );
  }
  complete(row, file = null, written = false) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const parked =
        this.config.role === "hub" &&
        !row.pendingFrom &&
        this.db
          .prepare(
            "SELECT failures FROM pending WHERE volume=? AND path=? AND json_extract(row,'$.rev')=?",
          )
          .get(row.volume, row.path, row.rev)?.failures >= 3;
      // A parked row was skipped by the change feed, so it is published again under a new revision.
      if (parked)
        row = {
          ...row,
          rev: Number(
            this.db
              .prepare(
                "INSERT INTO revisions(volume,path,hash,size,deleted,author,created,directory) VALUES(?,?,?,?,?,?,?,?)",
              )
              .run(
                row.volume,
                row.path,
                row.hash ?? null,
                row.size ?? 0,
                row.deleted ? 1 : 0,
                row.author || this.config.id,
                new Date().toISOString(),
                row.directory ? 1 : 0,
              ).lastInsertRowid,
          ),
        };
      this.setFile(row);
      this.db
        .prepare("DELETE FROM pending WHERE volume=? AND path=?")
        .run(row.volume, row.path);
      const quick = written && !row.deleted && !row.directory && this.streamOnly(row.volume);
      if (written)
        this.db
          .prepare("INSERT OR REPLACE INTO scan_cache(path,signature,hash,size,verified) VALUES(?,?,?,?,?)")
          .run(file, written, quick ? quickHashFile(file) : row.hash, row.size, Date.now());
      this.db.exec("COMMIT");
      if (quick) this.markDirty(row.volume, row.path);
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  // A replica's content lives in its working copy; its object store only holds transfers in flight.
  releaseObject(hash) {
    if (
      this.config.role !== "replica" ||
      this.db
        .prepare(
          "SELECT 1 FROM pending WHERE json_extract(row, '$.hash')=? LIMIT 1",
        )
        .get(hash)
    )
      return;
    try {
      fs.rmSync(this.blob(hash), { force: true });
    } catch {
      /* A locked object is collected after the cycle. */
    }
  }
  localContent(volume, name, hash) {
    const object = this.blob(hash);
    if (fs.existsSync(object)) return object;
    const v = this.volume(volume);
    if (this.config.role === "hub" ? !this.streamOnly(volume) : !v.selected)
      return null;
    const file = this.filePath(v, name);
    const signature = fileSignature(file);
    if (!signature) return null;
    const cached = this.db
      .prepare("SELECT signature,hash FROM scan_cache WHERE path=?")
      .get(file);
    return cached?.signature === signature && cached.hash === hash
      ? file
      : null;
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
    const failures = [];
    const swept = new Set();
    for (const p of rows) {
      const current = this.current(p.row.volume, p.row.path);
      if (current && current.rev > p.row.rev) {
        try {
          this.restoreDisplaced(
            p.row,
            this.filePath(this.volume(p.row.volume), p.row.path),
            (actual) =>
              !!actual && (actual === current.hash || actual === p.row.hash),
          );
          this.db
            .prepare(
              "DELETE FROM pending WHERE volume=? AND path=? AND json_extract(row,'$.rev')=?",
            )
            .run(p.row.volume, p.row.path, p.row.rev);
        } catch (error) {
          failures.push({ path: p.row.path, volume: p.row.volume, error });
        }
        continue;
      }
      try {
        const v = this.volume(p.row.volume);
        const parent = path.dirname(this.filePath(v, p.row.path));
        if (!swept.has(parent)) {
          swept.add(parent);
          this.sweepTemps(parent);
        }
        this.materialize(p.row, p.expected);
      } catch (error) {
        failures.push({ path: p.row.path, volume: p.row.volume, error });
      }
    }
    if (failures.length)
      throw Object.assign(failures[0].error, { failures });
  }
  unresolvedConflicts(volume) {
    return this.db
      .prepare(
        "SELECT count(*) AS n FROM files f LEFT JOIN conflict_resolutions c ON c.volume=f.volume AND c.path=f.path WHERE f.volume=? AND f.deleted=0 AND instr(f.path,'.conflict-')>0 AND (c.conflict_rev IS NULL OR c.conflict_rev<f.rev)",
      )
      .get(volume).n;
  }
  conflictRevision(volume) {
    return this.db
      .prepare(
        "SELECT COALESCE(MAX(rev),0) AS rev FROM files WHERE volume=? AND instr(path,'.conflict-')>0",
      )
      .get(volume).rev;
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
    name = validPath(name);
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
    if (
      !item &&
      this.current(volume, name)?.directory &&
      this.liveDescendant(volume, name)
    )
      fail(
        "Directory contains synchronized entries; synchronize their removal first",
        409,
      );
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
    const revived = [];
    if (item)
      for (let length = 1; length < key.split("/").length; length++) {
        const ancestor = name.split("/").slice(0, length).join("/");
        const head = this.pathHead(volume, ancestor);
        if (head?.deleted && head.directory && head.path === ancestor)
          revived.push(ancestor);
      }
    this.db.exec("BEGIN IMMEDIATE");
    let row, pendingFrom;
    const ancestors = [];
    try {
      for (const ancestor of revived) {
        const added = this.db
          .prepare(
            "INSERT INTO revisions(volume,path,hash,size,deleted,author,created,directory) VALUES(?,?,NULL,0,0,?,?,1)",
          )
          .run(volume, ancestor, author, created);
        const live = {
          volume,
          path: ancestor,
          hash: null,
          size: 0,
          deleted: 0,
          author,
          created,
          directory: 1,
          rev: Number(added.lastInsertRowid),
        };
        ancestors.push(live);
        if (write) this.queue(live, null);
        else this.setFile(live);
      }
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
    if (write) {
      for (const ancestor of ancestors) this.materialize(ancestor, null);
      this.materialize(row, expected);
    }
    return row;
  }
  liveDescendant(volume, name) {
    return Boolean(
      this.db
        .prepare(
          "SELECT 1 FROM files WHERE volume=? AND deleted=0 AND path_key>=? AND path_key<? LIMIT 1",
        )
        .get(volume, name.toLowerCase() + "/", name.toLowerCase() + "0"),
    );
  }
  renameFile(current, destination, author) {
    const volume = current.volume;
    const selected = this.volume(volume).selected;
    // Reuse the existing atomic case-transition contract and recovery path.
    if (current.path.toLowerCase() === destination.toLowerCase())
      return this.commit(
        volume,
        destination,
        current,
        author,
        true,
        current.hash,
        null,
        current.path,
      );
    const created = new Date().toISOString();
    const insert = this.db.prepare(
      "INSERT INTO revisions(volume,path,hash,size,deleted,author,created,directory) VALUES(?,?,?,?,?,?,?,0)",
    );
    let renamed, removed;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const added = insert.run(
        volume,
        destination,
        current.hash,
        current.size,
        0,
        author,
        created,
      );
      renamed = {
        ...current,
        path: destination,
        rev: Number(added.lastInsertRowid),
        author,
        created,
      };
      const deleted = insert.run(
        volume,
        current.path,
        null,
        0,
        1,
        author,
        created,
      );
      removed = {
        ...current,
        hash: null,
        size: 0,
        deleted: 1,
        rev: Number(deleted.lastInsertRowid),
        author,
        created,
      };
      if (selected) {
        // Hide both revisions from readers until physical work is complete.
        this.queue({ ...renamed, pendingFrom: renamed.rev }, null);
        this.queue(
          {
            ...removed,
            pendingFrom: renamed.rev,
            renameDestination: destination,
          },
          current.hash,
        );
      } else {
        this.setFile(renamed);
        this.setFile(removed);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    if (selected) {
      this.materialize(renamed, null);
      this.materialize(removed, current.hash);
    }
    return renamed;
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
