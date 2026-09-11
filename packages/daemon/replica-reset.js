import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { atomic, fail, token } from "./storage.js";

// A durable journal keeps interrupted deletion retryable without re-pairing.
export function resetTargets(store) {
  const paths = [
    ...store.volumes().map((v) => v.path),
    store.config.backup?.path,
  ].filter(Boolean);
  return [...new Set(paths)].map((location) => {
    const target = path.resolve(location);
    if (
      target === path.parse(target).root ||
      target === store.home ||
      store.home.startsWith(target + path.sep)
    )
      fail(
        "Replica data overlaps the state directory; resolve its location before destroying",
        409,
      );
    if (!fs.existsSync(target)) return { path: target, missing: true };
    const stat = fs.lstatSync(target);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      fs.realpathSync(target) !== target
    )
      fail(`Replica folder location changed: ${target}`, 409);
    return { path: target, dev: stat.dev, ino: stat.ino };
  });
}
export function finishReplicaReset(store) {
  const journal = store.config.destroyPending;
  if (!journal) return;
  for (const target of journal.targets) {
    if (!fs.existsSync(target.path)) continue;
    const stat = fs.lstatSync(target.path);
    if (
      target.missing ||
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      fs.realpathSync(target.path) !== target.path ||
      stat.dev !== target.dev ||
      stat.ino !== target.ino
    )
      fail(
        `Replica folder changed during destruction: ${target.path}. Restore its original location and retry.`,
        409,
      );
    fs.rmSync(target.path, { recursive: true });
  }
  for (const name of fs.readdirSync(store.home)) {
    if (
      [
        "objects",
        "uploads",
        "previews",
        "web-code.json",
        "promotion.json",
      ].includes(name) ||
      /^before-(promotion|reconnect)-[a-f0-9-]+\.sqlite$/.test(name)
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
  store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
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
export function beginReplicaReset(store, targets) {
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
