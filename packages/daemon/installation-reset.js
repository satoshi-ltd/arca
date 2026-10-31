import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { atomic, fail, token, withinPath } from "./storage.js";

const readSmall = (file) => {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  return stat?.isFile() && stat.size <= 64 * 1024 ? fs.readFileSync(file, "utf8") : null;
};
const owned = (target, owner) => {
  try {
    if (owner.volume) return readSmall(path.join(target, ".arca-volume")) === owner.volume;
    return JSON.parse(readSmall(path.join(target, "state", "config.json"))).role === "backup";
  } catch {
    return false;
  }
};
export function resetTargets(store) {
  const owners = new Map();
  for (const v of store.volumes())
    if (v.path) owners.set(path.resolve(v.path), { volume: v.id });
  if (store.config.backup?.path) owners.set(path.resolve(store.config.backup.path), { backup: true });
  return [...owners].map(([target, owner]) => {
    if (
      target === path.parse(target).root ||
      withinPath(store.home, target)
    )
      fail(
        "Folder data overlaps the state directory; resolve its location before erasing",
        409,
      );
    if (!fs.existsSync(target)) return { path: target, missing: true };
    const stat = fs.lstatSync(target);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      fs.realpathSync(target) !== target
    )
      fail(`Folder location changed: ${target}`, 409);
    if (!owned(target, owner)) return { path: target, skipped: true };
    return { path: target, dev: stat.dev, ino: stat.ino, born: stat.birthtimeMs };
  });
}
export function finishInstallationReset(store) {
  const journal = store.config.destroyPending;
  if (!journal) return;
  for (const target of journal.targets) {
    if (target.skipped || !fs.existsSync(target.path)) continue;
    const stat = fs.lstatSync(target.path);
    if (
      target.missing ||
      withinPath(store.home, target.path) ||
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      fs.realpathSync(target.path) !== target.path ||
      stat.dev !== target.dev ||
      stat.ino !== target.ino ||
      (target.born && stat.birthtimeMs && stat.birthtimeMs !== target.born)
    )
      fail(
        `Folder changed during destruction: ${target.path}. Restore its original location and retry.`,
        409,
      );
    fs.rmSync(target.path, { recursive: true });
  }
  // Keep service-owned open descriptors valid, including on Windows.
  for (const name of ["daemon.log", "service.log", "update-watch.log"]) {
    const location = path.join(store.home, name);
    let stat;
    try {
      stat = fs.lstatSync(location);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      fs.unlinkSync(location);
      continue;
    }
    if (!stat.isFile() || stat.nlink !== 1)
      fail(`Log location changed: ${location}`, 409);
    const fd = fs.openSync(
      location,
      fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0),
    );
    try {
      const current = fs.fstatSync(fd);
      if (current.dev !== stat.dev || current.ino !== stat.ino || current.nlink !== 1)
        fail(`Log location changed: ${location}`, 409);
      fs.ftruncateSync(fd, 0);
    } finally {
      fs.closeSync(fd);
    }
  }
  for (const name of fs.readdirSync(store.home)) {
    if (
      [
        "objects",
        "uploads",
        "previews",
        "music-covers",
        "video-art",
        "video-subtitles",
        "video-downloads",
        "music-downloads",
        "transcodes",
        "web-code.json",
        "promotion.json",
      ].includes(name) ||
      /^before-(promotion|reconnect)-[a-f0-9-]+\.sqlite$/.test(name) ||
      /^config\.json\.[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.tmp$/.test(
        name,
      ) ||
      /^config\.before-[a-z0-9-]+\.json$/.test(name) ||
      name === "pre-onboarding-config.json"
    )
      fs.rmSync(path.join(store.home, name), { recursive: true, force: true });
  }
  store.db.exec("PRAGMA secure_delete=ON; BEGIN IMMEDIATE");
  try {
    for (const { name } of store.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      )
      .all())
      store.db.exec(`DELETE FROM "${name.replaceAll('"', '""')}"`);
    store.db.exec("DELETE FROM sqlite_sequence; COMMIT");
  } catch (error) {
    store.db.exec("ROLLBACK");
    throw error;
  }
  store.db.exec("VACUUM; PRAGMA wal_checkpoint(TRUNCATE)");
  const old = store.config;
  const next = {
    protocol: 1,
    installation: old.installation,
    role: "replica",
    id: journal.id,
    name: "My Arca",
    root: old.root,
    host: old.host,
    port: old.port,
    ...(old.webOrigin ? { webOrigin: old.webOrigin } : {}),
    adminToken: journal.adminToken,
    hub: null,
    needsSetup: true,
  };
  fs.mkdirSync(store.objects, { recursive: true });
  fs.mkdirSync(store.uploads, { recursive: true });
  atomic(store.configPath, JSON.stringify(next, null, 2));
  for (const key of Object.keys(old)) delete old[key];
  Object.assign(old, next);
}
// A durable journal keeps interrupted deletion retryable without re-pairing.
export function beginInstallationReset(store, targets) {
  store.config.destroyPending = {
    targets,
    id: crypto.randomUUID(),
    adminToken: token(),
  };
  try {
    store.saveConfig();
  } catch (error) {
    delete store.config.destroyPending;
    throw error;
  }
}
