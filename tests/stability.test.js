import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { init, Store } from "../packages/daemon/storage.js";
import { Engine } from "../packages/daemon/engine.js";
import {
  moveFolder,
  retentionPlan,
  applyRetention,
} from "../packages/daemon/maintenance.js";
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-stability-"));
  init(home);
  const engine = new Engine(home);
  t.after(() => {
    engine.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const v = engine.store.addVolume("Docs");
  return { home, engine, s: engine.store, v };
}
test("incremental scan reuses unchanged capture; changed metadata invalidates cache", (t) => {
  const { s, v } = fixture(t),
    file = path.join(v.path, "a");
  fs.writeFileSync(file, "one");
  const first = s.scan(v).get("a");
  const verified = s.db
    .prepare("SELECT verified FROM scan_cache WHERE path=?")
    .get(file).verified;
  assert.equal(s.scan(v).get("a").hash, first.hash);
  assert.equal(
    s.db.prepare("SELECT verified FROM scan_cache WHERE path=?").get(file)
      .verified,
    verified,
  );
  fs.writeFileSync(file, "two");
  assert.notEqual(s.scan(v).get("a").hash, first.hash);
});
test("relocation verifies copies and retains originals; rejects nesting", (t) => {
  const { s, v, engine, home } = fixture(t);
  fs.writeFileSync(path.join(v.path, "a"), "original");
  s.scanHub();
  assert.throws(
    () => moveFolder(engine, v.id, path.join(v.path, "nested")),
    /overlap/,
  );
  const target = path.join(home, "files", "Relocated");
  const result = moveFolder(engine, v.id, target);
  assert.equal(result.id, v.id);
  assert.equal(
    fs.readFileSync(path.join(result.path, "a"), "utf8"),
    "original",
  );
  assert.equal(fs.readFileSync(path.join(v.path, "a"), "utf8"), "original");
  assert.equal(s.history(v.id, "a").length, 1);
});
test("retention preserves current revisions and versions not yet acknowledged by backup", (t) => {
  const { s, v } = fixture(t);
  for (const text of ["one", "two", "three"]) {
    fs.writeFileSync(path.join(v.path, "a"), text);
    s.scanHub();
  }
  s.db
    .prepare("INSERT INTO devices(id,name,token_hash,role) VALUES(?,?,?,?)")
    .run("backup", "backup", "unused", "replica");
  s.db
    .prepare("INSERT INTO backup_ack(device,revision) VALUES(?,?)")
    .run("backup", 0);
  assert.equal(retentionPlan(s, { versions: 1 }).remove.length, 0);
  s.db.prepare("UPDATE backup_ack SET revision=3").run();
  assert.equal(retentionPlan(s, { versions: 1 }).remove.length, 2);
  assert.equal(applyRetention(s, { versions: 1 }).removed, 2);
  assert.equal(s.history(v.id, "a").length, 1);
  assert.equal(s.current(v.id, "a").rev, 4);
});
test("ENOSPC during materialization keeps journal and preserves the original", (t) => {
  const { s, v } = fixture(t);
  const file = path.join(v.path, "a");
  fs.writeFileSync(file, "old");
  s.scanHub();
  const staging = path.join(s.config.root, "new-content");
  fs.writeFileSync(staging, "new");
  const item = s.capture(staging),
    old = s.current(v.id, "a");
  const original = fs.copyFileSync;
  fs.copyFileSync = (source, destination, ...args) => {
    if (source === s.blob(item.hash))
      throw Object.assign(new Error("Disk full"), { code: "ENOSPC" });
    return original(source, destination, ...args);
  };
  try {
    assert.throws(
      () => s.commit(v.id, "a", item, "test", true, old.hash),
      /Disk full/,
    );
  } finally {
    fs.copyFileSync = original;
  }
  assert.equal(fs.readFileSync(file, "utf8"), "old");
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM pending").get().n, 1);
  s.recover();
  assert.equal(fs.readFileSync(file, "utf8"), "new");
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM pending").get().n, 0);
});
test("SIGKILL after durable journal commit recovers accepted content", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-kill-"));
  init(home);
  const s = new Store(home),
    v = s.addVolume("Docs");
  fs.writeFileSync(path.join(v.path, "a"), "old");
  s.scanHub();
  s.close();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const module = new URL("../packages/daemon/storage.js", import.meta.url).href;
  const script = `import fs from 'node:fs';import{Store}from ${JSON.stringify(module)};const s=new Store(${JSON.stringify(home)});const v=s.volume(${JSON.stringify(v.id)});fs.writeFileSync(s.config.root+'/new','new');const item=s.capture(s.config.root+'/new');s.materialize=()=>{process.stdout.write('journal-ready\\n');setInterval(()=>{},1000);};s.commit(v.id,'a',item,'test',true,s.current(v.id,'a').hash);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    let text = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(Error("Child timeout"));
    }, 10000);
    child.stdout.on("data", (d) => {
      text += d;
      if (text.includes("journal-ready")) {
        clearTimeout(timer);
        child.kill("SIGKILL");
      }
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      if (signal === "SIGKILL" && text.includes("journal-ready")) resolve();
      else reject(Error("Unexpected child exit"));
    });
  });
  const reopened = new Store(home);
  try {
    reopened.recover();
    assert.equal(fs.readFileSync(path.join(v.path, "a"), "utf8"), "new");
  } finally {
    reopened.close();
  }
});

test("snapshot pages remain stable through hub edits and cannot be read by another device", async (t) => {
  const { s, v } = fixture(t);
  for (const name of ["a", "b", "c"])
    fs.writeFileSync(path.join(v.path, name), name);
  s.scanHub();
  const { snapshotPage } = await import("../packages/daemon/snapshots.js");
  const first = snapshotPage(s, "device", v.id, { limit: 2 });
  assert.deepEqual(
    first.files.map((f) => f.path),
    [".arcaignore", "a"],
  );
  fs.writeFileSync(path.join(v.path, "b"), "changed");
  s.scanHub();
  const second = snapshotPage(s, "device", v.id, {
    session: first.session,
    after: first.next,
    limit: 1,
  });
  assert.equal(second.files[0].path, "b");
  assert.notEqual(second.files[0].hash, s.current(v.id, "b").hash);
  assert.throws(
    () =>
      snapshotPage(s, "intruder", v.id, {
        session: first.session,
        after: first.next,
        limit: 1,
      }),
    /expired/,
  );
});

test("administrative pages do not skip repeated timestamp revisions", async (t) => {
  const { s, v } = fixture(t);
  const { listPage } = await import("../packages/daemon/pages.js");
  for (const name of ["a", "b", "c"]) {
    fs.writeFileSync(path.join(v.path, name), name);
    s.scanHub();
  }
  const first = listPage(s, v.id, new URLSearchParams({ limit: "2" }));
  assert.deepEqual(
    first.files.map((f) => f.path),
    [".arcaignore", "a"],
  );
  assert.deepEqual(
    listPage(
      s,
      v.id,
      new URLSearchParams({ limit: "2", after: first.next }),
    ).files.map((f) => f.path),
    ["b", "c"],
  );
  for (const text of ["v2", "v3"]) {
    fs.writeFileSync(path.join(v.path, "a"), text);
    s.scanHub();
  }
  const history = listPage(s, v.id, new URLSearchParams({ limit: "1" }), "a");
  const older = listPage(
    s,
    v.id,
    new URLSearchParams({ limit: "1", before: String(history.next) }),
    "a",
  );
  assert.ok(older.versions[0].rev < history.versions[0].rev);
  assert.throws(
    () => listPage(s, v.id, new URLSearchParams({ limit: "999999" })),
    /Page limit/,
  );
});

test("cleanup removes only abandoned partial transfers", async (t) => {
  const { s } = fixture(t);
  const { cleanupTransfers } =
    await import("../packages/daemon/maintenance.js");
  const names = [
    "device-deadbeef.part",
    "a".repeat(64) + ".download",
    "important.txt",
    "fresh.part",
  ];
  for (const name of names) {
    const file = path.join(s.uploads, name);
    fs.writeFileSync(file, "partial");
    if (name !== "fresh.part") fs.utimesSync(file, new Date(0), new Date(0));
  }
  assert.equal(cleanupTransfers(s), 2);
  assert.deepEqual(fs.readdirSync(s.uploads).sort(), [
    "fresh.part",
    "important.txt",
  ]);
});

test("low free space is rejected before changing a destination", async (t) => {
  const { s, v } = fixture(t);
  const { requireSpace } = await import("../packages/daemon/storage.js");
  const original = fs.statfsSync;
  fs.statfsSync = () => ({ bavail: 0n, bsize: 4096n });
  try {
    assert.throws(
      () => requireSpace(v.path, 1),
      (e) => e.status === 507,
    );
  } finally {
    fs.statfsSync = original;
  }
});

test("adopting an existing folder preserves files and never mkdirs that folder", (t) => {
  const { engine: e } = fixture(t);
  const target = path.join(e.store.home, "..", `arca-existing-${Date.now()}`);
  fs.mkdirSync(target);
  t.after(() => fs.rmSync(target, { recursive: true, force: true }));
  fs.writeFileSync(path.join(target, "keep.txt"), "existing content");
  const mkdir = fs.mkdirSync;
  fs.mkdirSync = (location, ...args) => {
    assert.notEqual(
      path.resolve(location),
      path.resolve(target),
      "Existing folder must not be created again",
    );
    return mkdir(location, ...args);
  };
  try {
    const v = e.store.addVolume("Existing", target);
    assert.equal(v.path, fs.realpathSync(target));
    assert.equal(
      fs.readFileSync(path.join(target, "keep.txt"), "utf8"),
      "existing content",
    );
  } finally {
    fs.mkdirSync = mkdir;
  }
});
