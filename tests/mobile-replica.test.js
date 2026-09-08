import { writePortableBackup } from "../apps/mobile/src/portable-backup.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Replica, CHUNK } from "../apps/mobile/src/replica.js";
import { ReplicaStore } from "../apps/mobile/src/replica-store.js";
import { createClient } from "../apps/mobile/src/client.js";
import { recoverBackup } from "../packages/daemon/recovery.js";
import { init } from "../packages/daemon/storage.js";
import { start } from "../packages/daemon/server.js";

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arca-mobile-sync-")),
    home = path.join(root, "hub");
  init(home, { port: 0 });
  const daemon = await start(home, { timer: false });
  const base = `http://127.0.0.1:${daemon.port}`;
  const db = new DatabaseSync(path.join(root, "mobile.sqlite"));
  t.after(async () => {
    await daemon.close();
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const store = new ReplicaStore({
    execAsync: (s) => db.exec(s),
    runAsync: (s, ...v) => db.prepare(s).run(...v),
    getFirstAsync: (s, ...v) => db.prepare(s).get(...v),
    getAllAsync: (s, ...v) => db.prepare(s).all(...v),
  });
  let saved = null,
    cached = null,
    online = true;
  const ranges = [];
  const client = createClient({
    secrets: {
      read: async () => saved,
      write: async (v) => {
        saved = v;
      },
      clear: async () => {
        saved = null;
      },
    },
    cache: {
      read: async () => cached,
      write: async (v) => {
        cached = v;
      },
    },
    fetcher: (url, options) => {
      if (!online) throw new Error("offline");
      if (options.headers.Range) ranges.push(options.headers.Range);
      return fetch(url.replace("https://fixture.invalid", base), options);
    },
  });
  const local = path.join(root, "mobile");
  const files = {
    scope: (s) => path.join(local, s),
    folder: (s, v) => path.join(local, s, "folders", v),
    work: (s, v, p) => path.join(local, s, "folders", v, p),
    object: (s, h) => path.join(local, s, "objects", h),
    partial: (s, h) => path.join(local, s, "partial", h),
    backup: (s) => path.join(local, s, "backup"),
    backupObject: (s, h) => path.join(local, s, "backup", "objects", h),
    parent: path.dirname,
    mkdir: async (p) => fs.mkdirSync(p, { recursive: true }),
    exists: async (p) => fs.existsSync(p),
    stat: async (p) =>
      fs.existsSync(p) ? { size: fs.statSync(p).size } : null,
    free: async () => 1e12,
    remove: async (p) => fs.rmSync(p, { force: true }),
    removeFolder: async (s, v) =>
      fs.rmSync(path.join(local, s, "folders", v), {
        recursive: true,
        force: true,
      }),
    copy: async (a, b) => fs.copyFileSync(a, b),
    move: async (a, b) => fs.renameSync(a, b),
    replace: async (a, b) => fs.renameSync(a, b),
    text: async (p) => fs.readFileSync(p, "utf8"),
    hash: async (p) =>
      crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex"),
    write: async (p, b, offset = 0) => {
      const fd = fs.openSync(p, fs.existsSync(p) ? "r+" : "w");
      try {
        fs.writeSync(fd, b, 0, b.length, offset);
      } finally {
        fs.closeSync(fd);
      }
    },
    read: async (p, o, l) => fs.readFileSync(p).subarray(o, o + l),
    async *walk(root, prefix = "") {
      for (const e of fs.readdirSync(root, { withFileTypes: true })) {
        if (e.name.startsWith(".arca-")) continue;
        const p = path.join(root, e.name);
        if (e.isDirectory()) yield* this.walk(p, prefix + e.name + "/");
        else yield { path: prefix + e.name, uri: p, size: fs.statSync(p).size };
      }
    },
    async used(p) {
      let n = 0;
      for await (const e of this.walk(p)) n += e.size;
      return n;
    },
    exportBackup(s, store, through) {
      return writePortableBackup(this, s, store, through);
    },
  };
  const replica = new Replica({ store, files, client, platform: "ios" });
  await replica.load();
  await client.load();
  const volume = daemon.engine.store.addVolume("Documents");
  const invite = await (
    await fetch(base + "/v1/pairing", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${daemon.engine.config.adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "Mobile" }),
    })
  ).json();
  await client.pair("https://fixture.invalid", invite.code);
  await replica.sync();
  return {
    root,
    daemon,
    volume,
    replica,
    store,
    files,
    client,
    ranges,
    offline: () => {
      online = false;
    },
    online: () => {
      online = true;
    },
  };
}
async function sync(f) {
  await f.replica.sync();
  assert.equal(f.replica.error, null);
}

test("mobile downloads verified blocks, sends edits, resumes offline edits and removes only local files after unsync", async (t) => {
  const f = await fixture(t),
    { volume, replica, files, daemon } = f;
  const initialFiles = fs
    .readdirSync(volume.path)
    .filter((name) => name !== ".arca-volume")
    .map((name) => fs.statSync(path.join(volume.path, name)))
    .filter((stat) => stat.isFile());
  const initialBytes = initialFiles.reduce((sum, stat) => sum + stat.size, 0);
  const data = crypto.randomBytes(CHUNK * 2 + 51);
  fs.writeFileSync(path.join(volume.path, "large.bin"), data);
  await daemon.engine.cycle();
  await f.client.refresh();
  await replica.select(f.client.state().catalog.volumes[0]);
  await sync(f);
  const local = files.work(replica.scope, volume.id, "large.bin");
  assert.deepEqual(fs.readFileSync(local), data);
  const summary = (await f.store.folders(replica.scope))[0];
  assert.equal(summary.files, initialFiles.length + 1);
  assert.equal(summary.bytes, initialBytes + data.length);
  assert.ok(f.ranges.length >= 3);
  assert.ok(f.ranges.includes(`bytes=0-${CHUNK - 1}`));
  fs.writeFileSync(local, "mobile edit");
  f.offline();
  await replica.sync();
  assert.equal(replica.error, "offline");
  assert.equal(fs.readFileSync(local, "utf8"), "mobile edit");
  f.online();
  await sync(f);
  assert.equal(
    fs.readFileSync(path.join(volume.path, "large.bin"), "utf8"),
    "mobile edit",
  );
  fs.unlinkSync(local);
  await sync(f);
  assert.equal(fs.existsSync(path.join(volume.path, "large.bin")), false);
  const empty = (await f.store.folders(replica.scope))[0];
  assert.equal(empty.files, initialFiles.length);
  assert.equal(empty.bytes, initialBytes);
  fs.writeFileSync(path.join(volume.path, "keep.txt"), "keep");
  await daemon.engine.cycle();
  await sync(f);
  await replica.unselect(volume.id);
  assert.equal(fs.existsSync(files.folder(replica.scope, volume.id)), false);
  assert.equal(await f.store.folder(replica.scope, volume.id), undefined);
  assert.equal(
    fs.readFileSync(path.join(volume.path, "keep.txt"), "utf8"),
    "keep",
  );
  await replica.select(f.client.state().catalog.volumes[0]);
  await sync(f);
  assert.equal(
    fs.readFileSync(files.work(replica.scope, volume.id, "keep.txt"), "utf8"),
    "keep",
  );
});

test("mobile preserves concurrent hub/local edits and replays an interrupted replacement before scanning", async (t) => {
  const f = await fixture(t),
    { replica, volume, files, daemon, store } = f;
  fs.writeFileSync(path.join(volume.path, "note.txt"), "original");
  await daemon.engine.cycle();
  await f.client.refresh();
  await replica.select(f.client.state().catalog.volumes[0]);
  await sync(f);
  const local = files.work(replica.scope, volume.id, "note.txt");
  fs.writeFileSync(local, "mobile");
  fs.writeFileSync(path.join(volume.path, "note.txt"), "hub");
  await daemon.engine.cycle();
  await sync(f);
  assert.equal(fs.readFileSync(local, "utf8"), "hub");
  assert.ok(fs.readdirSync(volume.path).some((n) => n.includes(".conflict-")));
  fs.writeFileSync(path.join(volume.path, "note.txt"), "after crash");
  await daemon.engine.cycle();
  const original = files.replace;
  let crashed = false;
  files.replace = async (a, b) => {
    if (!crashed) {
      crashed = true;
      fs.rmSync(b, { force: true });
      throw new Error("simulated process interruption");
    }
    return original(a, b);
  };
  await replica.sync();
  assert.match(replica.error, /interruption/);
  assert.equal((await store.applying(replica.scope, volume.id)).length, 1);
  await sync(f);
  assert.equal(fs.readFileSync(local, "utf8"), "after crash");
  assert.equal(
    fs.readFileSync(path.join(volume.path, "note.txt"), "utf8"),
    "after crash",
  );
});

test("mobile full backup contains archived objects independently from working selection", async (t) => {
  const f = await fixture(t),
    { replica, volume, files, daemon, store } = f;
  fs.writeFileSync(path.join(volume.path, "a.txt"), "one");
  await daemon.engine.cycle();
  fs.writeFileSync(path.join(volume.path, "a.txt"), "two");
  await daemon.engine.cycle();
  await replica.enableBackup(true);
  await sync(f);
  const rows = await store.archiveRows(replica.scope);
  assert.equal(rows.filter((r) => r.path === "a.txt").length, 2);
  for (const row of rows)
    assert.equal(
      await files.hash(files.backupObject(replica.scope, row.hash)),
      row.hash,
    );
  assert.equal((await store.folders(replica.scope)).length, 0);
  assert.ok((await store.get(`backup:${replica.scope}`)).completed);
  const recovered = recoverBackup(
    files.backup(replica.scope),
    path.join(f.root, "recovered"),
  );
  assert.equal(recovered.revisions, rows.length);
  const object = files.backupObject(replica.scope, rows[0].hash);
  fs.writeFileSync(object, "corrupt");
  assert.throws(
    () =>
      recoverBackup(files.backup(replica.scope), path.join(f.root, "rejected")),
    /corrupt/,
  );
  assert.equal(fs.existsSync(path.join(f.root, "rejected")), false);
});

test("mobile resumes a partial download, rejects corruption, and applies storage limits before selection", async (t) => {
  const f = await fixture(t),
    { replica, volume, files, daemon } = f;
  const data = crypto.randomBytes(CHUNK + 97);
  fs.writeFileSync(path.join(volume.path, "resume.bin"), data);
  await daemon.engine.cycle();
  await f.client.refresh();
  const realFree = files.free;
  files.free = async () => 0;
  await assert.rejects(
    replica.select(f.client.state().catalog.volumes[0]),
    /storage/,
  );
  assert.equal((await f.store.folders(replica.scope)).length, 0);
  files.free = realFree;
  const hash = crypto.createHash("sha256").update(data).digest("hex"),
    partial = files.partial(replica.scope, hash);
  await files.mkdir(files.parent(partial));
  await files.write(partial, data.subarray(0, CHUNK));
  await replica.select(f.client.state().catalog.volumes[0]);
  await sync(f);
  assert.ok(f.ranges.includes(`bytes=${CHUNK}-${data.length - 1}`));
  fs.writeFileSync(files.object(replica.scope, hash), "corrupt");
  await replica.download(hash, data.length);
  assert.equal(await files.hash(files.object(replica.scope, hash)), hash);
});

test("mobile honors synchronized ignore rules and protects edits against stale editor saves", async (t) => {
  const f = await fixture(t),
    { replica, volume, files, daemon } = f;
  fs.writeFileSync(path.join(volume.path, ".arcaignore"), "private/\n");
  fs.writeFileSync(path.join(volume.path, "note.txt"), "initial");
  await daemon.engine.cycle();
  await f.client.refresh();
  await replica.select(f.client.state().catalog.volumes[0]);
  await sync(f);
  const folder = files.folder(replica.scope, volume.id);
  fs.mkdirSync(path.join(folder, "private"));
  fs.writeFileSync(
    path.join(folder, "private", "secret.txt"),
    "fixture secret",
  );
  await sync(f);
  assert.equal(
    fs.existsSync(path.join(volume.path, "private", "secret.txt")),
    false,
  );
  const local = files.work(replica.scope, volume.id, "note.txt"),
    baseline = await files.hash(local);
  await replica.saveText(volume.id, "note.txt", "edited", baseline);
  await assert.rejects(
    replica.saveText(volume.id, "note.txt", "stale", baseline),
    /changed/,
  );
  await sync(f);
  assert.equal(
    fs.readFileSync(path.join(volume.path, "note.txt"), "utf8"),
    "edited",
  );
  fs.writeFileSync(path.join(folder, ".arcaignore"), "other/\n");
  fs.writeFileSync(path.join(volume.path, ".arcaignore"), "different/\n");
  await daemon.engine.cycle();
  await replica.sync();
  assert.match(replica.error, /arcaignore differs/);
});

test("mobile persists ignore reconciliation when snapshot download is interrupted", async (t) => {
  const f = await fixture(t);
  const { replica, store, volume, files } = f;
  await f.client.refresh();
  await replica.select(f.client.state().catalog.volumes[0]);
  await sync(f);
  const policy = files.work(replica.scope, volume.id, ".arcaignore");
  fs.writeFileSync(policy, "private/\n");
  const originalPull = replica.pull.bind(replica);
  replica.pull = async () => {
    throw new Error("interrupted snapshot");
  };
  await replica.sync();
  assert.match(replica.error, /interrupted snapshot/);
  assert.equal((await store.folder(replica.scope, volume.id)).initialized, 0);
  // A restarted engine must still request a full snapshot with the saved policy.
  replica.pull = originalPull;
  await sync(f);
  assert.equal((await store.folder(replica.scope, volume.id)).initialized, 1);

  await store.queue(replica.scope, {
    volume: volume.id,
    path: "private/queued.txt",
    base: null,
    hash: "a".repeat(64),
    size: 10,
  });
  await sync(f);
  assert.deepEqual(await store.pending(replica.scope, volume.id), []);
  assert.equal(
    fs.existsSync(path.join(volume.path, "private/queued.txt")),
    false,
  );
});

test("interrupted portable backup publication preserves the completed backup", async (t) => {
  const f = await fixture(t);
  const { replica, volume, files, daemon, store } = f;
  fs.writeFileSync(path.join(volume.path, "saved.txt"), "completed content");
  await daemon.engine.cycle();
  await replica.enableBackup(true);
  await sync(f);
  const saved = await store.get(`backup:${replica.scope}`);
  const source = files.backup(replica.scope);
  const manifest = fs.readFileSync(path.join(source, "manifest.json"));
  const replace = files.replace;
  files.replace = async (from, to) => {
    if (from.endsWith(".arca-history")) throw new Error("interrupted write");
    await replace(from, to);
  };
  await assert.rejects(
    files.exportBackup(replica.scope, store, saved.revision),
    /interrupted write/,
  );
  assert.deepEqual(
    fs.readFileSync(path.join(source, "manifest.json")),
    manifest,
  );
  assert.ok(
    recoverBackup(source, path.join(f.root, "still-recoverable")).revisions > 0,
  );
  assert.equal(fs.existsSync(path.join(source, ".arca-history")), false);
});

test("failed system notification does not reject sync or hide its connection error", async (t) => {
  const f = await fixture(t);
  const replica = new Replica({
    store: f.store,
    files: f.files,
    client: f.client,
    notify: async () => {
      throw new Error("OS notifications unavailable");
    },
  });
  await replica.load();
  f.offline();
  await assert.doesNotReject(replica.sync());
  assert.match(replica.error, /offline/);
  assert.equal(replica.busy, false);
  f.online();
  await replica.sync();
  assert.equal(replica.error, null);
  assert.ok(await f.store.get(`lastSync:${replica.scope}`));
});

test("stopping a mobile download is resumable without a false synchronization error", async (t) => {
  const f = await fixture(t);
  const data = crypto.randomBytes(CHUNK * 2 + 17);
  fs.writeFileSync(path.join(f.volume.path, "resume.bin"), data);
  await f.daemon.engine.cycle();
  await f.client.refresh();
  await f.replica.select(f.client.state().catalog.volumes[0]);
  const write = f.files.write;
  let stopped = false;
  f.files.write = async (...args) => {
    await write(...args);
    if (!stopped) {
      stopped = true;
      f.replica.stop();
    }
  };
  await f.replica.sync();
  assert.equal(stopped, true);
  assert.equal(f.replica.error, null);
  const interrupted = await f.store.folder(f.replica.scope, f.volume.id);
  assert.equal(interrupted.issue, null);
  assert.equal(interrupted.completed, null);
  await sync(f);
  assert.deepEqual(
    fs.readFileSync(f.files.work(f.replica.scope, f.volume.id, "resume.bin")),
    data,
  );
  assert.ok((await f.store.folder(f.replica.scope, f.volume.id)).completed);
});

test("incoming workout files persist before confirmation and save to a nested selected folder", async (t) => {
  const { stageIncoming, forgetIncoming, incomingDestination } =
    await import("../apps/mobile/src/incoming-files.js");
  const f = await fixture(t),
    r = f.replica;
  f.files.incoming = (key) => path.join(f.root, "incoming", key);
  const source = path.join(f.root, "workout.fit");
  const workout = crypto.randomBytes(2048);
  fs.writeFileSync(source, workout);
  const stat = f.files.stat,
    copy = f.files.copy;
  f.files.stat = (uri) => stat(uri.replace(/^file:\/\//, ""));
  f.files.copy = (a, b) => copy(a.replace(/^file:\/\//, ""), b);
  const queued = await stageIncoming(
    r,
    [
      {
        shareType: "file",
        contentUri: `file://${source}`,
        originalName: "workout.fit",
      },
    ],
    "batch",
  );
  assert.equal((await f.store.get("incomingFiles")).length, 1);
  assert.deepEqual(fs.readFileSync(queued[0].uri), workout);
  assert.equal(fs.existsSync(path.join(f.volume.path, "workouts")), false);
  await assert.rejects(
    stageIncoming(
      r,
      [
        {
          shareType: "file",
          contentUri: `file://${source}`,
          originalName: "../escape.fit",
        },
      ],
      "unsafe",
    ),
  );
  assert.equal((await f.store.get("incomingFiles")).length, 1);
  const payload = {
    shareType: "file",
    contentUri: `file:${source}`,
    originalName: "workout.fit",
    contentSize: workout.length,
  };
  await assert.rejects(
    stageIncoming(r, [payload, payload], "duplicate"),
    /same temporary name/,
  );
  await assert.rejects(
    stageIncoming(r, [{ ...payload, contentSize: 1 }], "incomplete"),
    /incomplete/,
  );
  await assert.rejects(
    stageIncoming(
      r,
      [payload, { ...payload, contentUri: `file://${source}.missing` }],
      "rollback",
    ),
  );
  assert.equal(fs.existsSync(f.files.incoming("rollback-0")), false);
  assert.equal((await f.store.get("incomingFiles")).length, 1);
  assert.deepEqual(fs.readFileSync(queued[0].uri), workout);
  await f.client.refresh();
  await r.select(f.client.state().catalog.volumes[0]);
  await sync(f);
  await r.pause(true);
  await r.importFile(
    f.volume.id,
    incomingDestination("workouts/2026", queued[0].name),
    queued[0].uri,
  );
  await forgetIncoming(r, queued[0]);
  assert.equal((await f.store.get("incomingFiles")).length, 0);
  assert.equal(fs.existsSync(source), true);
  assert.equal(fs.existsSync(path.join(f.volume.path, "workouts")), false);
  await r.pause(false);
  await sync(f);
  assert.deepEqual(
    fs.readFileSync(path.join(f.volume.path, "workouts/2026/workout.fit")),
    workout,
  );
});

test("mobile unsync protects unqueued edits, new files, deletes and queued uploads", async (t) => {
  const f = await fixture(t);
  const { replica, volume, files, store, daemon } = f;
  fs.writeFileSync(path.join(volume.path, "saved.txt"), "original");
  await daemon.engine.cycle();
  await f.client.refresh();
  await replica.select(f.client.state().catalog.volumes[0]);
  await sync(f);
  await replica.pause(true);
  const local = files.work(replica.scope, volume.id, "saved.txt");
  fs.writeFileSync(local, "offline edit");
  await assert.rejects(replica.unselect(volume.id), /local changes/);
  assert.equal(fs.readFileSync(local, "utf8"), "offline edit");
  assert.equal((await store.folder(replica.scope, volume.id)).selected, 1);
  fs.writeFileSync(local, "original");
  const added = files.work(replica.scope, volume.id, "new.txt");
  fs.writeFileSync(added, "not on hub");
  await assert.rejects(replica.unselect(volume.id), /local changes/);
  fs.unlinkSync(added);
  fs.unlinkSync(local);
  await assert.rejects(replica.unselect(volume.id), /local deletions/);
  fs.writeFileSync(local, "original");
  await store.queue(replica.scope, {
    volume: volume.id,
    path: "saved.txt",
    hash: "f".repeat(64),
    size: 1,
    base: 1,
  });
  await assert.rejects(replica.unselect(volume.id), /Finish syncing/);
  assert.equal((await store.pending(replica.scope, volume.id)).length, 1);
  assert.equal(replica.paused, true);
});

test("mobile unsync retries failed cleanup and retains other folders and backup objects", async (t) => {
  const f = await fixture(t);
  const { replica, volume, files, store, daemon } = f;
  fs.writeFileSync(path.join(volume.path, "saved.txt"), "original");
  await daemon.engine.cycle();
  await f.client.refresh();
  await replica.select(f.client.state().catalog.volumes[0]);
  await sync(f);
  const row = await store.current(replica.scope, volume.id, "saved.txt");
  await store.select(replica.scope, { id: "other", name: "Other" });
  await store.put(replica.scope, { ...row, volume: "other" });
  await files.mkdir(files.folder(replica.scope, "other"));
  fs.writeFileSync(
    files.work(replica.scope, "other", "saved.txt"),
    "other copy",
  );
  const backup = files.backupObject(replica.scope, row.hash);
  await files.mkdir(path.dirname(backup));
  fs.writeFileSync(backup, "backup");
  const orphan = files.object(replica.scope, "a".repeat(64));
  fs.writeFileSync(orphan, "unused");
  const remove = files.removeFolder;
  files.removeFolder = async () => {
    throw new Error("disk error");
  };
  await assert.rejects(replica.unselect(volume.id), /disk error/);
  assert.equal((await store.folder(replica.scope, volume.id)).selected, 1);
  assert.match((await store.folder(replica.scope, volume.id)).issue, /removal incomplete/);
  assert.ok(await store.get(`removing:${replica.scope}:${volume.id}`));
  await assert.rejects(
    replica.select({ id: volume.id, bytes: 0 }),
    /remaining local copy/,
  );
  files.removeFolder = remove;
  await replica.unselect(volume.id);
  assert.equal(await store.folder(replica.scope, volume.id), undefined);
  assert.equal(fs.existsSync(files.folder(replica.scope, volume.id)), false);
  assert.equal(fs.existsSync(orphan), false);
  assert.equal(fs.existsSync(files.object(replica.scope, row.hash)), true);
  assert.equal(fs.readFileSync(backup, "utf8"), "backup");
  assert.equal(
    fs.readFileSync(files.work(replica.scope, "other", "saved.txt"), "utf8"),
    "other copy",
  );
});

test("Finder metadata never enters hub or mobile sync without an ignore file", async (t) => {
  const f = await fixture(t),
    { replica, volume, files, daemon } = f;
  fs.writeFileSync(path.join(volume.path, ".DS_Store"), "hub metadata");
  fs.writeFileSync(path.join(volume.path, "note.txt"), "content");
  await daemon.engine.cycle();
  await f.client.refresh();
  await replica.select(f.client.state().catalog.volumes[0]);
  await sync(f);
  const root = files.folder(replica.scope, volume.id);
  assert.equal(fs.existsSync(path.join(root, ".DS_Store")), false);
  fs.mkdirSync(path.join(root, "nested"), { recursive: true });
  fs.writeFileSync(path.join(root, "nested", ".DS_Store"), "mobile metadata");
  await sync(f);
  assert.equal(
    fs.existsSync(path.join(volume.path, "nested", ".DS_Store")),
    false,
  );
  assert.equal(fs.readFileSync(path.join(root, "note.txt"), "utf8"), "content");
  assert.equal(fs.existsSync(path.join(volume.path, ".DS_Store")), true);
});

test("a missing hub share retains the mobile index and reports an actionable issue", async (t) => {
  const f = await fixture(t);
  const { replica, volume, store, files, daemon, client } = f;
  fs.writeFileSync(path.join(volume.path, "saved.txt"), "saved content");
  await daemon.engine.cycle();
  await client.refresh();
  await replica.select(client.state().catalog.volumes[0]);
  await sync(f);
  const before = await store.current(replica.scope, volume.id, "saved.txt");
  const state = client.state;
  client.state = () => ({ ...state(), catalog: { ...state().catalog, volumes: [] } });
  await replica.sync();
  const folder = await store.folder(replica.scope, volume.id);
  assert.equal(folder.selected, 1);
  assert.match(folder.issue, /no longer shared/);
  assert.equal((await store.current(replica.scope, volume.id, "saved.txt")).hash, before.hash);
  assert.equal(fs.readFileSync(files.work(replica.scope, volume.id, "saved.txt"), "utf8"), "saved content");
});
