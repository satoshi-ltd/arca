import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { Replica, CHUNK } from "../apps/mobile/src/replica.js";
import { ReplicaStore } from "../apps/mobile/src/replica-store.js";
import {
  gallerySettingsChanged,
  parseGallery,
  sourceAlbums,
} from "../apps/mobile/src/validation.js";
import { galleryConfig } from "../apps/mobile/src/gallery.js";
import { offlineFileHistory } from "../apps/mobile/src/file-history.js";
import { folderIgnored, withLocalOnly } from "../apps/mobile/src/hub-gallery.js";
import { viewKey, warmViews } from "../apps/mobile/src/remote-views.js";
import { scopedActivity } from "../packages/core/scoped-activity.js";
import { TransferSession, shouldStopSync } from "../apps/mobile/src/transfer-session.js";
import { createClient } from "../apps/mobile/src/client.js";
import { init } from "../packages/daemon/storage.js";
import { start } from "../packages/daemon/server.js";

async function fixture(t, { timeout } = {}) {
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
  const yielded =
    (work) =>
    async (...args) => {
      await new Promise((resolve) => setImmediate(resolve));
      return work(...args);
    };
  const store = new ReplicaStore({
    execAsync: yielded((s) => db.exec(s)),
    runAsync: yielded((s, ...v) => db.prepare(s).run(...v)),
    getFirstAsync: yielded((s, ...v) => db.prepare(s).get(...v)),
    getAllAsync: yielded((s, ...v) => db.prepare(s).all(...v)),
  });
  let saved = null,
    cached = null,
    online = true;
  let stalled = null;
  const ranges = [];
  const requests = [];
  const client = createClient({
    timeout,
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
    fetcher: async (url, options) => {
      requests.push(new URL(url).pathname);
      if (!online) throw new TypeError("Network request failed");
      if (stalled) return stalled(url, options);
      if (options.headers.Range) ranges.push(options.headers.Range);
      const target = url.replace("https://fixture.invalid", base);
      const readable =
        !options.method || ["GET", "HEAD"].includes(options.method);
      for (let attempt = 0; ; attempt++) {
        try {
          return await fetch(target, options);
        } catch (error) {
          if (!readable || attempt) throw error;
        }
      }
    },
  });
  const local = path.join(root, "mobile");
  const files = {
    destroy: async () => fs.rmSync(local, { recursive: true, force: true }),
    folder: (s, v) => path.join(local, s, "folders", v),
    work: (s, v, p) => path.join(local, s, "folders", v, p),
    object: (s, h) => path.join(local, s, "objects", h),
    partial: (s, h) => path.join(local, s, "partial", h),
    parent: path.dirname,
    mkdir: async (p) => fs.mkdirSync(p, { recursive: true }),
    exists: async (p) => fs.existsSync(p),
    listNames: async (p) => fs.readdirSync(p),
    stat: async (p) =>
      fs.existsSync(p)
        ? {
            size: fs.statSync(p).isDirectory() ? 0 : fs.statSync(p).size,
            directory: fs.statSync(p).isDirectory(),
          }
        : null,
    free: async () => 1e12,
    removeDirectory: async (p) => fs.rmdirSync(p),
    remove: async (p) => fs.rmSync(p, { force: true }),
    removeFolder: async (s, v) =>
      fs.rmSync(path.join(local, s, "folders", v), {
        recursive: true,
        force: true,
      }),
    copy: async (a, b) => fs.copyFileSync(a, b),
    clearStaged: async (p) => {
      if (fs.existsSync(p))
        for (const name of fs.readdirSync(p))
          if (name.startsWith(".arca-copy-")) fs.rmSync(path.join(p, name), { force: true });
    },
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
        if (e.isDirectory()) {
          yield { path: prefix + e.name, uri: p, size: 0, directory: true };
          yield* this.walk(p, prefix + e.name + "/");
        } else
          yield { path: prefix + e.name, uri: p, size: fs.statSync(p).size };
      }
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
    requests,
    stall: (handler) => {
      stalled = handler;
    },
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
  assert.equal(replica.error, "Network request failed");
  assert.equal(replica.hubUnavailable, true);
  assert.equal(replica.syncingVolume, null);
  assert.equal(replica.busy, false);
  assert.equal(fs.readFileSync(local, "utf8"), "mobile edit");
  f.online();
  await sync(f);
  assert.equal(replica.hubUnavailable, false);
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

test("mobile honors synchronized ignore rules while syncing local edits", async (t) => {
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
  fs.writeFileSync(files.work(replica.scope, volume.id, "note.txt"), "edited");
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
  assert.match(replica.error, /Network request failed/);
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

test("incoming workout files are transient until saved to a nested selected folder", async (t) => {
  const { stageIncoming, IncomingSession, incomingDestination } =
    await import("../apps/mobile/src/incoming-files.js");
  const f = await fixture(t),
    r = f.replica;
  f.files.incoming = (key) => path.join(f.root, "incoming", key);
  const source = path.join(f.root, "workout #1%.fit");
  const workout = crypto.randomBytes(2048);
  fs.writeFileSync(source, workout);
  const stat = f.files.stat,
    copy = f.files.copy;
  f.files.stat = (uri) =>
    stat(uri.startsWith("file:") ? fileURLToPath(uri) : uri);
  f.files.copy = (a, b) =>
    copy(a.startsWith("file:") ? fileURLToPath(a) : a, b);
  const queued = await stageIncoming(
    r,
    [
      {
        shareType: "file",
        contentUri: pathToFileURL(source).href,
        originalName: "workout.fit",
      },
    ],
    "batch",
  );
  assert.equal((await f.store.get("incomingFiles", [])).length, 0);
  assert.deepEqual(fs.readFileSync(queued[0].uri), workout);
  assert.equal(fs.existsSync(path.join(f.volume.path, "workouts")), false);
  await assert.rejects(
    stageIncoming(
      r,
      [
        {
          shareType: "file",
          contentUri: pathToFileURL(source).href,
          originalName: "../escape.fit",
        },
      ],
      "unsafe",
    ),
  );
  assert.equal((await f.store.get("incomingFiles", [])).length, 0);
  const payload = {
    shareType: "file",
    contentUri: pathToFileURL(source).href.replace("file://", "file:"),
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
      [
        payload,
        { ...payload, contentUri: pathToFileURL(`${source}.missing`).href },
      ],
      "rollback",
    ),
  );
  assert.equal(fs.existsSync(f.files.incoming("rollback-0")), false);
  assert.equal((await f.store.get("incomingFiles", [])).length, 0);
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
  const session = new IncomingSession(r);
  session.items = queued;
  await session.saved(queued[0]);
  assert.equal((await f.store.get("incomingFiles", [])).length, 0);
  assert.equal(fs.existsSync(source), true);
  assert.equal(fs.existsSync(path.join(f.volume.path, "workouts")), false);
  await r.pause(false);
  await sync(f);
  assert.deepEqual(
    fs.readFileSync(path.join(f.volume.path, "workouts/2026/workout.fit")),
    workout,
  );
});

test("confirmed mobile removal discards offline changes even after the hub share is gone", async (t) => {
  const f = await fixture(t);
  const { replica, volume, files, store, daemon } = f;
  fs.writeFileSync(path.join(volume.path, "saved.txt"), "original");
  await daemon.engine.cycle();
  await replica.select(volume);
  await sync(f);
  await replica.pause(true);
  fs.writeFileSync(
    files.work(replica.scope, volume.id, "saved.txt"),
    "offline edit",
  );
  await store.queue(replica.scope, {
    volume: volume.id,
    path: "saved.txt",
    hash: "f".repeat(64),
    size: 1,
    base: 1,
  });
  daemon.engine.store.forgetVolume(volume.id);
  await f.client.refresh();
  f.offline();
  f.requests.length = 0;
  await replica.unselect(volume.id);
  assert.equal(fs.existsSync(files.folder(replica.scope, volume.id)), false);
  assert.equal(await store.folder(replica.scope, volume.id), undefined);
  assert.deepEqual(await store.pending(replica.scope, volume.id), []);
  assert.equal(
    fs.readFileSync(path.join(volume.path, "saved.txt"), "utf8"),
    "original",
  );
  assert.equal(replica.paused, true);
  assert.deepEqual(f.requests, []);
});

test("mobile unsync retries failed cleanup and retains other folders' files", async (t) => {
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
  const orphan = files.object(replica.scope, "a".repeat(64));
  fs.writeFileSync(orphan, "unused");
  const remove = files.removeFolder;
  files.removeFolder = async () => {
    throw new Error("disk error");
  };
  await assert.rejects(replica.unselect(volume.id), /disk error/);
  assert.equal((await store.folder(replica.scope, volume.id)).selected, 1);
  assert.match(
    (await store.folder(replica.scope, volume.id)).issue,
    /removal incomplete/,
  );
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
  assert.equal(
    fs.readFileSync(files.work(replica.scope, "other", "saved.txt"), "utf8"),
    "other copy",
  );
});

test("Finder metadata never enters hub or mobile sync without an ignore file", async (t) => {
  const f = await fixture(t),
    { replica, volume, files, daemon } = f;
  const excluded = [
    ".DS_Store",
    ".localized",
    "vault/.obsidian/plugins/plugin/main.js",
  ];
  for (const name of excluded) {
    fs.mkdirSync(path.dirname(path.join(volume.path, name)), {
      recursive: true,
    });
    fs.writeFileSync(path.join(volume.path, name), "hub metadata");
  }
  fs.writeFileSync(path.join(volume.path, "note.txt"), "content");
  await daemon.engine.cycle();
  await f.client.refresh();
  await replica.select(f.client.state().catalog.volumes[0]);
  await sync(f);
  const root = files.folder(replica.scope, volume.id);
  for (const name of excluded) {
    assert.equal(fs.existsSync(path.join(root, name)), false);
    const local = path.join(root, "nested", name);
    fs.mkdirSync(path.dirname(local), { recursive: true });
    fs.writeFileSync(local, "mobile metadata");
  }
  fs.mkdirSync(path.join(root, "nested"), { recursive: true });
  fs.writeFileSync(path.join(root, "nested", ".DS_Store"), "mobile metadata");
  await sync(f);
  assert.equal(
    fs.existsSync(path.join(volume.path, "nested", ".DS_Store")),
    false,
  );
  assert.equal(fs.readFileSync(path.join(root, "note.txt"), "utf8"), "content");
  for (const name of excluded) {
    assert.equal(fs.existsSync(path.join(volume.path, "nested", name)), false);
    assert.equal(
      fs.readFileSync(path.join(volume.path, name), "utf8"),
      "hub metadata",
    );
    assert.equal(
      fs.readFileSync(path.join(root, "nested", name), "utf8"),
      "mobile metadata",
    );
  }
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
  client.state = () => ({
    ...state(),
    catalog: { ...state().catalog, volumes: [] },
  });
  await replica.sync();
  const folder = await store.folder(replica.scope, volume.id);
  assert.equal(folder.selected, 1);
  assert.match(folder.issue, /no longer shared/);
  assert.equal(
    (await store.current(replica.scope, volume.id, "saved.txt")).hash,
    before.hash,
  );
  assert.equal(
    fs.readFileSync(files.work(replica.scope, volume.id, "saved.txt"), "utf8"),
    "saved content",
  );
  // The hub's removal must not prevent confirmed local cleanup, even offline.
  await store.setGallery(replica.scope, volume.id, {
    mode: "source",
    enabled: true,
  });
  const original = path.join(f.root, "system-gallery-original.jpg");
  fs.writeFileSync(original, "phone original");
  f.offline();
  const requestCount = f.requests.length;
  await replica.unselect(volume.id);
  assert.ok(!(await store.folder(replica.scope, volume.id)));
  assert.equal(await store.gallery(replica.scope, volume.id), null);
  assert.equal(fs.existsSync(files.folder(replica.scope, volume.id)), false);
  assert.equal(fs.readFileSync(original, "utf8"), "phone original");
  assert.equal(
    f.requests.length,
    requestCount,
    "unlink does not require the deleted hub share",
  );
});

test("mobile synchronizes empty directories both ways", async (t) => {
  const f = await fixture(t);
  const hubRoot = f.daemon.engine.store.volume(f.volume.id).path;
  fs.mkdirSync(path.join(hubRoot, "doc/Coros"), { recursive: true });
  fs.writeFileSync(path.join(hubRoot, "doc/Coros/.DS_Store"), "excluded");
  await f.daemon.engine.cycle();
  await f.replica.select(f.volume);
  await sync(f);
  const localRoot = f.files.folder(f.replica.scope, f.volume.id);
  assert.deepEqual(fs.readdirSync(path.join(localRoot, "doc/Coros")), []);
  fs.mkdirSync(path.join(localRoot, "new/deep/empty"), { recursive: true });
  await sync(f);
  assert.ok(fs.statSync(path.join(hubRoot, "new/deep/empty")).isDirectory());
  fs.rmSync(path.join(hubRoot, "new"), { recursive: true });
  await f.daemon.engine.cycle();
  await sync(f);
  assert.equal(fs.existsSync(path.join(localRoot, "new")), false);
});

test("mobile renames its own device, persists offline edits and reports them on reconnect", async (t) => {
  const f = await fixture(t);
  const id = f.client.state().connection.id;
  const report = () =>
    JSON.parse(
      f.daemon.engine.store.db
        .prepare("SELECT report FROM machine_reports WHERE device=?")
        .get(id).report,
    );
  assert.equal(await f.replica.rename("  My phone  "), true);
  assert.equal(await f.store.get("name"), "My phone");
  assert.equal(report().name, "My phone");
  f.replica.syncAbort = new AbortController();
  f.replica.syncAbort.abort(new Error("Sync cancelled"));
  assert.equal(
    await f.replica.rename("My phone"),
    true,
    "manual rename must not inherit sync cancellation",
  );
  f.replica.syncAbort = null;
  for (const invalid of ["   ", "x".repeat(101), "bad\nname"])
    await assert.rejects(f.replica.rename(invalid), /device name/);
  assert.equal(await f.store.get("name"), "My phone");
  f.offline();
  assert.equal(await f.replica.rename("Travel phone"), false);
  assert.ok(f.replica.nameReportError);
  assert.equal(await f.store.get("name"), "Travel phone");
  assert.equal(report().name, "My phone");
  f.online();
  await sync(f);
  assert.equal(report().name, "Travel phone");
  assert.equal(f.client.state().connection.id, id);
});

test("mobile file deletion preserves unsynced content and propagates a restorable deletion", async (t) => {
  const f = await fixture(t);
  const v = f.volume;
  fs.writeFileSync(
    path.join(f.daemon.engine.store.volume(v.id).path, "delete.txt"),
    "retained",
  );
  await f.daemon.engine.exclusive(() => f.daemon.engine.cycle());
  await f.replica.select(v);
  await sync(f);
  const file = f.files.work(f.replica.scope, v.id, "delete.txt");
  await f.files.write(file, Buffer.from("unsynced"));
  await assert.rejects(f.replica.removeFile(v.id, "delete.txt"), /changed/);
  assert.equal(await f.files.text(file), "unsynced");
  await sync(f);
  const previous = f.daemon.engine.store.current(v.id, "delete.txt");
  f.offline();
  await f.replica.removeFile(v.id, "delete.txt");
  f.online();
  await sync(f);
  assert.equal(f.daemon.engine.store.current(v.id, "delete.txt").deleted, 1);
  await f.daemon.engine.exclusive(() =>
    f.daemon.engine.restore(v.id, "delete.txt", previous.rev),
  );
  await sync(f);
  assert.equal(await f.files.text(file), "unsynced");
});

test("mobile sync with no selected folders never downloads hub content or runs backup", async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(
    path.join(f.daemon.engine.store.volume(f.volume.id).path, "hub-only.txt"),
    "keep on hub",
  );
  await f.daemon.engine.cycle();
  f.requests.length = 0;
  await sync(f);
  assert.deepEqual(await f.store.folders(f.replica.scope), []);
  assert.equal(
    fs.existsSync(f.files.folder(f.replica.scope, f.volume.id)),
    false,
  );
  assert.equal(
    f.requests.some((route) =>
      /^\/v1\/(archive|backup-ack|blobs|snapshot|changes)(\/|$)/.test(route),
    ),
    false,
  );
  const response = await f.client.api("/v1/machines");
  const self = response.machines.find(
    (machine) =>
      machine.id === f.client.state().connection.id ||
      machine.credentialId === f.client.state().connection.id,
  );
  assert.equal(self.role, "replica");
});

test("shared binary with a non-portable name imports after renaming and syncs byte-for-byte", async (t) => {
  const { stageIncoming, incomingDestination } =
    await import("../apps/mobile/src/incoming-files.js");
  const f = await fixture(t);
  await f.replica.select(f.volume);
  await sync(f);
  const data = crypto.randomBytes(4096);
  const source = path.join(f.root, "activity #1%.fit");
  fs.writeFileSync(source, data);
  f.files.incoming = (key) => path.join(f.root, "incoming", key);
  const stat = f.files.stat,
    copy = f.files.copy;
  f.files.stat = (uri) =>
    stat(uri.startsWith("file:") ? fileURLToPath(uri) : uri);
  f.files.copy = (from, to) =>
    copy(from.startsWith("file:") ? fileURLToPath(from) : from, to);
  const [item] = await stageIncoming(
    f.replica,
    [
      {
        shareType: "file",
        originalName: "Activity 07:35.fit",
        contentUri: pathToFileURL(source).href,
        contentSize: data.length,
      },
    ],
    "binary",
  );
  assert.equal(item.renameRequired, true);
  assert.throws(() => incomingDestination("", item.name), /Rename/);
  const destination = incomingDestination("", "Activity 07-35.fit");
  await f.replica.importFile(f.volume.id, destination, item.uri);
  await sync(f);
  assert.deepEqual(
    fs.readFileSync(path.join(f.volume.path, destination)),
    data,
  );
  assert.deepEqual(fs.readFileSync(source), data);
});

test("mobile continues healthy folders after another folder fails verification", async (t) => {
  const f = await fixture(t),
    s = f.daemon.engine.store;
  const beta = s.addVolume("Zeta");
  await f.replica.select(f.volume);
  await f.replica.select(beta);
  await sync(f);
  fs.writeFileSync(path.join(f.volume.path, "bad.txt"), "correct");
  fs.writeFileSync(path.join(beta.path, "good.txt"), "healthy");
  await f.daemon.engine.cycle();
  const row = s.current(f.volume.id, "bad.txt");
  fs.writeFileSync(s.blob(row.hash), "damaged");
  await f.replica.sync();
  assert.match(f.replica.error, /verification/);
  assert.equal(
    fs.readFileSync(f.files.work(f.replica.scope, beta.id, "good.txt"), "utf8"),
    "healthy",
  );
  assert.equal((await f.store.folder(f.replica.scope, beta.id)).issue, null);
});

test("mobile replaces stale queued deletion when a local file is recreated", async (t) => {
  const f = await fixture(t);
  const r = f.replica;
  fs.writeFileSync(path.join(f.volume.path, "note"), "initial");
  await f.daemon.engine.cycle();
  await r.select(f.volume);
  await sync(f);
  const name = f.files.work(r.scope, f.volume.id, "note");
  fs.unlinkSync(name);
  await r.scan(await f.store.folder(r.scope, f.volume.id));
  assert.equal((await f.store.pending(r.scope, f.volume.id)).length, 1);
  fs.writeFileSync(name, "recreated");
  await sync(f);
  assert.equal(
    fs.readFileSync(path.join(f.volume.path, "note"), "utf8"),
    "recreated",
  );
  assert.equal(fs.readFileSync(name, "utf8"), "recreated");
});

test("mobile discards a queued deletion even when recreated bytes match the previous revision", async (t) => {
  const f = await fixture(t),
    r = f.replica;
  fs.writeFileSync(path.join(f.volume.path, "note"), "same");
  await f.daemon.engine.cycle();
  await r.select(f.volume);
  await sync(f);
  const name = f.files.work(r.scope, f.volume.id, "note");
  fs.unlinkSync(name);
  await r.scan(await f.store.folder(r.scope, f.volume.id));
  fs.writeFileSync(name, "same");
  await sync(f);
  assert.equal(fs.readFileSync(name, "utf8"), "same");
  assert.equal(f.daemon.engine.store.current(f.volume.id, "note").deleted, 0);
});

for (const origin of ["hub", "mobile"])
  test(`mobile file/directory transitions and case rename (${origin})`, async (t) => {
    const f = await fixture(t),
      r = f.replica;
    fs.writeFileSync(path.join(f.volume.path, "item"), "file");
    await f.daemon.engine.cycle();
    await r.select(f.volume);
    await sync(f);
    const root =
      origin === "hub" ? f.volume.path : f.files.folder(r.scope, f.volume.id);
    fs.unlinkSync(path.join(root, "item"));
    fs.mkdirSync(path.join(root, "item"));
    fs.writeFileSync(path.join(root, "item", "child"), "nested");
    if (origin === "hub") await f.daemon.engine.cycle();
    await sync(f);
    assert.equal(
      fs.readFileSync(path.join(f.volume.path, "item", "child"), "utf8"),
      "nested",
    );
    assert.equal(
      fs.readFileSync(f.files.work(r.scope, f.volume.id, "item/child"), "utf8"),
      "nested",
    );
    fs.rmSync(path.join(root, "item"), { recursive: true });
    fs.writeFileSync(path.join(root, "item"), "last");
    if (origin === "hub") await f.daemon.engine.cycle();
    await sync(f);
    assert.equal(
      fs.readFileSync(f.files.work(r.scope, f.volume.id, "item"), "utf8"),
      "last",
    );
    fs.renameSync(path.join(root, "item"), path.join(root, "Item"));
    if (origin === "hub") await f.daemon.engine.cycle();
    await sync(f);
    assert.ok(
      fs.readdirSync(f.files.folder(r.scope, f.volume.id)).includes("Item"),
    );
    assert.ok(fs.readdirSync(f.volume.path).includes("Item"));
  });

test("mobile receives removed ignore policy before scanning newly included content", async (t) => {
  const f = await fixture(t),
    r = f.replica;
  await r.select(f.volume);
  await sync(f);
  fs.writeFileSync(path.join(f.volume.path, ".arcaignore"), "hidden/\n");
  await f.daemon.engine.cycle();
  await sync(f);
  fs.mkdirSync(path.join(f.volume.path, "hidden"));
  fs.writeFileSync(path.join(f.volume.path, "hidden", "a"), "included");
  fs.unlinkSync(path.join(f.volume.path, ".arcaignore"));
  await f.daemon.engine.cycle();
  await sync(f);
  assert.equal(
    fs.readFileSync(f.files.work(r.scope, f.volume.id, "hidden/a"), "utf8"),
    "included",
  );
  assert.equal(
    fs.existsSync(f.files.work(r.scope, f.volume.id, ".arcaignore")),
    false,
  );
});

test("mobile forgets newly excluded rows and keeps their local copies", async (t) => {
  const f = await fixture(t),
    r = f.replica;
  fs.mkdirSync(path.join(f.volume.path, "drafts"));
  fs.writeFileSync(path.join(f.volume.path, "drafts", "a.txt"), "draft");
  await f.daemon.engine.cycle();
  await r.select(f.volume);
  await sync(f);
  assert.ok(await f.store.current(r.scope, f.volume.id, "drafts/a.txt"));
  fs.writeFileSync(path.join(f.volume.path, ".arcaignore"), "drafts/\n");
  await f.daemon.engine.cycle();
  await sync(f);
  assert.equal(
    await f.store.current(r.scope, f.volume.id, "drafts/a.txt"),
    null,
  );
  assert.equal(
    fs.readFileSync(f.files.work(r.scope, f.volume.id, "drafts/a.txt"), "utf8"),
    "draft",
  );
  assert.equal(
    f.daemon.engine.store.current(f.volume.id, "drafts/a.txt"),
    undefined,
  );
  assert.equal(
    fs.readFileSync(path.join(f.volume.path, "drafts", "a.txt"), "utf8"),
    "draft",
  );
});

test("destroy mobile replica removes all private copies and hub registration, preserves hub content and resets pairing", async (t) => {
  const f = await fixture(t);
  const { replica, volume, files, client, store, daemon } = f;
  fs.writeFileSync(path.join(volume.path, "kept.txt"), "hub content");
  await daemon.engine.scanHub();
  await replica.select(volume);
  await sync(f);
  const local = files.folder(replica.scope, volume.id);
  fs.writeFileSync(path.join(local, "unsynced.txt"), "local only");
  const device = client.state().connection.id;
  await assert.rejects(replica.destroy(), /Confirm/);
  assert.ok(fs.existsSync(local));
  await replica.destroy(true);
  assert.equal(fs.existsSync(local), false);
  assert.equal(
    fs.readFileSync(path.join(volume.path, "kept.txt"), "utf8"),
    "hub content",
  );
  assert.equal(
    daemon.engine.store.db
      .prepare("SELECT id FROM devices WHERE id=?")
      .get(device),
    undefined,
  );
  assert.deepEqual(client.state(), { connection: null, catalog: null });
  assert.equal(await store.get("scope"), null);
  assert.equal(replica.scope, null);
});

test("mobile destruction works offline and preserves hub content", async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.volume.path, "kept.txt"), "hub copy");
  await f.daemon.engine.scanHub();
  await f.replica.select(f.volume);
  await sync(f);
  const local = f.files.folder(f.replica.scope, f.volume.id);
  f.offline();
  await f.replica.destroy(true);
  assert.equal(fs.existsSync(local), false);
  assert.deepEqual(f.client.state(), { connection: null, catalog: null });
  assert.equal(await f.store.get("destroyPending"), null);
  assert.equal(
    fs.readFileSync(path.join(f.volume.path, "kept.txt"), "utf8"),
    "hub copy",
  );
});

test("mobile destruction resumes interrupted local cleanup while offline", async (t) => {
  const f = await fixture(t);
  await f.replica.select(f.volume);
  const local = f.files.folder(f.replica.scope, f.volume.id);
  f.offline();
  const remove = f.files.destroy;
  f.files.destroy = async () => {
    throw new Error("storage unavailable");
  };
  await assert.rejects(f.replica.destroy(true), /storage unavailable/);
  assert.equal(await f.store.get("destroyPending"), true);
  assert.ok(f.client.state().catalog);
  await assert.rejects(f.replica.select(f.volume), /Erasing this device is pending/);
  f.files.destroy = remove;
  await f.replica.load();
  assert.equal(fs.existsSync(local), false);
  assert.equal(await f.store.get("destroyPending"), null);
  assert.deepEqual(f.client.state(), { connection: null, catalog: null });
});

test("mobile onboarding downloads only explicitly chosen folders and preflights space", async (t) => {
  const { selectFirstFolders } =
    await import("../apps/mobile/src/onboarding.js");
  const f = await fixture(t);
  await f.store.set("onboarding", "folders");
  fs.writeFileSync(path.join(f.volume.path, "first.txt"), "first download");
  await f.daemon.engine.scanHub();
  await f.client.refresh();
  await f.replica.sync();
  assert.equal((await f.store.folders(f.replica.scope)).length, 0);
  const free = f.files.free;
  f.files.free = async () => 0;
  await assert.rejects(
    selectFirstFolders(f.replica, f.client.state().catalog, [f.volume.id]),
    /storage/,
  );
  assert.equal((await f.store.folders(f.replica.scope)).length, 0);
  f.files.free = free;
  await selectFirstFolders(f.replica, f.client.state().catalog, [f.volume.id]);
  assert.equal(await f.store.get("onboarding"), null);
  await sync(f);
  assert.equal(
    fs.readFileSync(
      f.files.work(f.replica.scope, f.volume.id, "first.txt"),
      "utf8",
    ),
    "first download",
  );
});

async function galleryFixture(
  t,
  assets = [
    { id: "photo-1", filename: "IMG_1234.HEIC", creationTime: 1750000000000 },
  ],
) {
  const f = await fixture(t);
  const { replica: r, files, store } = f;
  files.galleryStage = (s, v) =>
    path.join(f.root, "mobile", s, "gallery-stage", v);
  files.clearGalleryStage = async (s, v) =>
    fs.rmSync(files.galleryStage(s, v), { recursive: true, force: true });
  files.picked = (s, v, k) => {
    for (const part of [s, v, k])
      if (typeof part !== "string" || !/^[a-zA-Z0-9-]+$/.test(part)) throw new Error("Invalid folder identity");
    return path.join(f.root, "mobile", s, "picked", v, k);
  };
  files.discardPicked = async () => {};
  const data = new Map(
    assets.map((a) => [a.id, Buffer.from(`original ${a.id}`)]),
  );
  const exports = [];
  const media = {
    permission: async () => ({ granted: true, accessPrivileges: "all" }),
    albums: async () => [
      { id: "camera", title: "Camera", assetCount: assets.length },
    ],
    page: async (source) => {
      const after = Number(source.after || 0);
      return {
        assets: assets.slice(after, after + 100),
        hasNextPage: after + 100 < assets.length,
        endCursor: String(after + 100),
      };
    },
    export: async (id, destination) => {
      exports.push(id);
      if (!data.has(id)) throw new Error("Photo no longer accessible");
      fs.mkdirSync(destination, { recursive: true });
      const uri = path.join(destination, "original");
      fs.writeFileSync(uri, data.get(id));
      return [
        {
          key: "original",
          name: assets.find((a) => a.id === id).filename,
          uri,
        },
      ];
    },
  };
  r.gallery.media = media;
  await r.select(f.client.state().catalog.volumes[0]);
  await sync(f);
  const enable = () =>
    r.gallery.configure(
      f.volume.id,
      { albums: [{ id: "camera", title: "Camera" }], videos: true },
      true,
    );
  const uploaded = async () =>
    (await store.galleryAsset(r.scope, f.volume.id, assets[0].id))
      ?.resources?.[0];
  return { ...f, assets, data, media, exports, enable, uploaded };
}

test("linked album uploads originals and keeps the complete shared folder locally", async (t) => {
  const f = await galleryFixture(t),
    { replica: r, volume, store, files } = f;
  await f.enable();
  assert.equal(fs.existsSync(files.folder(r.scope, volume.id)), true);
  await sync(f);
  const roster = await f.client.api("/v1/machines");
  const source = roster.machines.find((m) => !m.isHub);
  assert.deepEqual(source.albumFolderIds, [volume.id]);
  await assert.rejects(
    f.client.api("/v1/machine-report", {
      ...source,
      albumFolderIds: ["invalid"],
    }),
    /albumFolderIds/,
  );
  assert.deepEqual(source.folderIds, [volume.id]);
  assert.equal(
    source.selectedFolders,
    1,
    "linked albums also hold complete local copies",
  );
  const item = await f.uploaded();
  assert.equal(
    (await store.galleryNativeAsset(r.scope, volume.id, item.path, item.hash))
      ?.id,
    "photo-1",
  );
  assert.equal(
    await store.galleryNativeAsset(r.scope, volume.id, item.path, "wrong-hash"),
    null,
  );

  assert.deepEqual(
    fs.readFileSync(path.join(volume.path, item.path)),
    f.data.get("photo-1"),
  );
  assert.equal(fs.existsSync(files.galleryStage(r.scope, volume.id)), false);
  assert.deepEqual(
    fs.readFileSync(files.work(r.scope, volume.id, item.path)),
    f.data.get("photo-1"),
  );
  assert.equal((await store.gallerySummary(r.scope, volume.id)).accepted, 1);
  f.data.delete("photo-1");
  await sync(f);
  assert.ok(fs.existsSync(path.join(volume.path, item.path)));
  fs.rmSync(path.join(volume.path, item.path));
  await f.daemon.engine.cycle();
  f.data.set("photo-1", Buffer.from("edited after acceptance"));
  await sync(f);
  assert.equal(fs.existsSync(path.join(volume.path, item.path)), false);
  assert.equal(f.exports.length, 1);
  await r.gallery.setEnabled(volume.id, false);
  f.assets.push({ id: "photo-2", filename: "next.jpg" });
  f.data.set("photo-2", Buffer.from("new"));
  await sync(f);
  assert.equal(await store.galleryAsset(r.scope, volume.id, "photo-2"), null);
  await r.gallery.setEnabled(volume.id, true);
  await sync(f);
  const second = await store.galleryAsset(r.scope, volume.id, "photo-2");
  assert.equal(second.state, "accepted");
  fs.writeFileSync(
    path.join(volume.path, "from-desktop.txt"),
    "remote content",
  );
  await f.daemon.engine.cycle();
  await sync(f);
  assert.equal(fs.existsSync(files.folder(r.scope, volume.id)), true);
  const localReport = (await f.client.api("/v1/machines")).machines.find(
    (m) => !m.isHub,
  );
  assert.deepEqual(localReport.albumFolderIds, [volume.id]);
  assert.deepEqual(localReport.folderIds, [volume.id]);
  assert.equal(
    fs.readFileSync(files.work(r.scope, volume.id, "from-desktop.txt"), "utf8"),
    "remote content",
  );
  await f.enable();
  await sync(f);
  assert.equal(
    f.exports.length,
    2,
    "reconfiguring uploads preserves accepted assets",
  );
});

test("linking an album preserves excluded files and synchronizes existing local edits", async (t) => {
  const f = await galleryFixture(t),
    { replica: r, volume, files } = f;
  fs.writeFileSync(files.work(r.scope, volume.id, "note.txt"), "unsynced edit");
  fs.writeFileSync(files.work(r.scope, volume.id, ".DS_Store"), "excluded");
  await f.enable();
  await sync(f);
  assert.equal(
    fs.readFileSync(files.work(r.scope, volume.id, ".DS_Store"), "utf8"),
    "excluded",
  );
  assert.equal(
    fs.readFileSync(path.join(volume.path, "note.txt"), "utf8"),
    "unsynced edit",
  );
  assert.equal(
    fs.readFileSync(files.work(r.scope, volume.id, "note.txt"), "utf8"),
    "unsynced edit",
  );
});

test("an existing upload-only phone downloads all pages and continues with uploads disabled", async (t) => {
  const f = await galleryFixture(t),
    { replica: r, volume, files, store } = f;
  await f.enable();
  // Reproduce the persisted state of a phone configured by the previous build.
  await files.removeFolder(r.scope, volume.id);
  await store.resetCursor(r.scope, volume.id);
  await store.db.runAsync(
    "DELETE FROM files WHERE scope=? AND volume=?",
    r.scope,
    volume.id,
  );
  for (let n = 0; n < 510; n++)
    fs.writeFileSync(
      path.join(volume.path, `other-machine-${n}.jpg`),
      `photo ${n}`,
    );
  await f.daemon.engine.cycle();
  await sync(f);
  for (let n = 0; n < 510; n++)
    assert.equal(
      fs.readFileSync(
        files.work(r.scope, volume.id, `other-machine-${n}.jpg`),
        "utf8",
      ),
      `photo ${n}`,
    );
  await r.gallery.setEnabled(volume.id, false);
  fs.writeFileSync(path.join(volume.path, "second-phone.jpg"), "second phone");
  await f.daemon.engine.cycle();
  await sync(f);
  assert.equal(
    fs.readFileSync(files.work(r.scope, volume.id, "second-phone.jpg"), "utf8"),
    "second phone",
  );
  assert.equal(
    fs.readFileSync(
      files.work(r.scope, volume.id, "other-machine-509.jpg"),
      "utf8",
    ),
    "photo 509",
  );
});

test("interrupted old album conversion restores missing files without publishing deletions", async (t) => {
  const f = await galleryFixture(t),
    { replica: r, store, files, volume } = f;
  fs.writeFileSync(path.join(volume.path, "keep.jpg"), "keep");
  await f.daemon.engine.cycle();
  await sync(f);
  await f.enable();
  await store.setGallery(r.scope, volume.id, {
    ...(await store.gallery(r.scope, volume.id)),
    mode: "converting",
  });
  await files.removeFolder(r.scope, volume.id);
  await sync(f);
  assert.equal(
    fs.readFileSync(path.join(volume.path, "keep.jpg"), "utf8"),
    "keep",
  );
  assert.equal(
    fs.readFileSync(files.work(r.scope, volume.id, "keep.jpg"), "utf8"),
    "keep",
  );
  assert.equal((await store.gallery(r.scope, volume.id)).mode, "source");
});

test("gallery records that are not valid settings read as damaged", () => {
  assert.equal(parseGallery(null), null);
  assert.deepEqual(parseGallery('{"mode":"source","prefix":"Machine-a"}'), {
    mode: "source",
    prefix: "Machine-a",
  });
  for (const value of ['{"mode":"conv', "[]", '"source"', "{}", '{"mode":"other"}'])
    assert.equal(parseGallery(value).mode, "damaged");
  assert.equal(galleryConfig({ gallery: '{"mode":"local"}' }), null);
  assert.equal(galleryConfig({ gallery: "{" }).mode, "damaged");
  assert.equal(
    parseGallery('{"mode":"source","prefix":123}').mode,
    "damaged",
  );
  assert.equal(gallerySettingsChanged(parseGallery("{"), null, false), true);
  assert.equal(
    gallerySettingsChanged({ mode: "source", albums: [], videos: false }, [], false),
    false,
  );
  const two = { mode: "source", albums: [{ id: "b", title: "B" }, { id: "a", title: "A" }], videos: false };
  assert.equal(gallerySettingsChanged(two, ["a", "b"], false), false, "the order of the albums is not a change");
  assert.equal(gallerySettingsChanged(two, ["a"], false), true);
  assert.equal(gallerySettingsChanged(two, ["a", "b", "c"], false), true);
  assert.equal(gallerySettingsChanged(two, [], false), true, "all photos is not the same as two albums");
  assert.equal(
    gallerySettingsChanged({ mode: "source", albumId: "a", albumName: "A", videos: false }, ["a"], false),
    false,
    "a source saved with one album keeps its selection",
  );
  assert.deepEqual(sourceAlbums({ albumId: "a", albumName: "A" }), [{ id: "a", title: "A" }]);
  assert.deepEqual(sourceAlbums({ albumId: null }), []);
});

test("a damaged album record blocks its folder without publishing deletions until the album is linked again", async (t) => {
  const f = await galleryFixture(t),
    { replica: r, store, files, volume } = f;
  fs.writeFileSync(path.join(volume.path, "keep.jpg"), "keep");
  fs.writeFileSync(path.join(volume.path, "other.jpg"), "other");
  await f.daemon.engine.cycle();
  await sync(f);
  f.data.delete("photo-1");
  await f.enable();
  await r.sync();
  assert.equal((await store.gallerySummary(r.scope, volume.id)).pending, 1);
  f.data.set("photo-1", Buffer.from("original photo-1"));
  fs.rmSync(files.work(r.scope, volume.id, "keep.jpg"));
  const corrupt = '{"mode":"conv';
  await store.db.runAsync(
    "UPDATE gallery_sources SET config=? WHERE scope=? AND volume=?",
    corrupt,
    r.scope,
    volume.id,
  );
  const raw = async () =>
    (
      await store.db.getFirstAsync(
        "SELECT config FROM gallery_sources WHERE scope=? AND volume=?",
        r.scope,
        volume.id,
      )
    ).config;

  await r.load();
  await r.sync();
  assert.match(r.error, /Photo uploads settings are damaged/);
  assert.match(
    (await store.folder(r.scope, volume.id)).issue,
    /Photo uploads settings are damaged/,
  );
  assert.equal((await store.gallery(r.scope, volume.id)).mode, "damaged");
  await assert.rejects(
    r.gallery.addPhotos(volume.id, [{ assetId: "photo-1" }]),
    /unavailable/,
  );
  await assert.rejects(r.removeFile(volume.id, "other.jpg"), /damaged/);
  await assert.rejects(
    r.renameFile(volume.id, "other.jpg", "renamed.jpg"),
    /damaged/,
  );
  assert.equal(await raw(), corrupt);
  await f.daemon.engine.cycle();
  assert.equal(
    fs.readFileSync(path.join(volume.path, "keep.jpg"), "utf8"),
    "keep",
  );

  await r.gallery.configure(volume.id, {}, true);
  await sync(f);
  const repaired = await store.gallery(r.scope, volume.id);
  assert.equal(repaired.mode, "source");
  assert.deepEqual(repaired.albums, []);
  assert.equal((await store.folder(r.scope, volume.id)).issue, null);
  assert.equal(
    fs.readFileSync(files.work(r.scope, volume.id, "keep.jpg"), "utf8"),
    "keep",
  );
  await f.daemon.engine.cycle();
  for (const [name, text] of [
    ["keep.jpg", "keep"],
    ["other.jpg", "other"],
  ])
    assert.equal(fs.readFileSync(path.join(volume.path, name), "utf8"), text);
  assert.equal((await store.gallerySummary(r.scope, volume.id)).accepted, 1);
});

test("gallery retries lost acceptance after remote deletion without reacquiring the deleted original", async (t) => {
  const f = await galleryFixture(t),
    { replica: r, volume, client, store } = f;
  await f.enable();
  const api = client.api;
  let lost = false;
  client.api = async (route, body) => {
    const result = await api(route, body);
    if (route === "/v1/propose" && body.hash && !lost) {
      lost = true;
      throw new Error("reply lost");
    }
    return result;
  };
  await r.sync();
  assert.equal(r.error, null);
  assert.match((await f.store.gallery(r.scope, volume.id)).issue, /reply lost/);
  const resource = await f.uploaded();
  assert.ok(fs.existsSync(path.join(volume.path, resource.path)));
  fs.rmSync(path.join(volume.path, resource.path));
  await f.daemon.engine.cycle();
  f.data.clear();
  await r.sync(true);
  assert.equal(r.error, null);
  assert.equal((await store.gallerySummary(r.scope, volume.id)).accepted, 1);
  assert.equal(f.exports.length, 1);
  assert.equal(fs.existsSync(path.join(volume.path, resource.path)), false);
});

test("gallery pauses, resumes a partial upload, cleans staging and does not block healthy folders", async (t) => {
  const f = await galleryFixture(t),
    { replica: r, client, files, volume } = f;
  f.data.set("photo-1", crypto.randomBytes(CHUNK * 2 + 23));
  await f.enable();
  const raw = client.raw;
  let first = true;
  client.raw = async (route, options) => {
    const response = await raw(route, options);
    if (route.startsWith("/v1/uploads/") && first) {
      first = false;
      r.stop();
    }
    return response;
  };
  await r.sync();
  assert.equal(r.error, null);
  assert.equal(fs.existsSync(files.galleryStage(r.scope, volume.id)), false);
  await sync(f);
  const resource = await f.uploaded();
  assert.deepEqual(
    fs.readFileSync(path.join(volume.path, resource.path)),
    f.data.get("photo-1"),
  );
  await r.pause(true);
  const count = f.exports.length;
  await r.sync();
  assert.equal(f.exports.length, count);
  await r.pause(false);
  const healthy = f.daemon.engine.store.addVolume("Healthy");
  fs.writeFileSync(path.join(healthy.path, "safe.txt"), "safe");
  await f.daemon.engine.cycle();
  await client.refresh();
  await r.select(
    client.state().catalog.volumes.find((v) => v.id === healthy.id),
  );
  f.media.permission = async () => ({
    granted: false,
    accessPrivileges: "none",
  });
  await r.sync();
  assert.match(r.error, /photo library access/);
  assert.equal(
    fs.readFileSync(files.work(r.scope, healthy.id, "safe.txt"), "utf8"),
    "safe",
  );
});

test("gallery excludes ignored paths, retries them after policy removal and handles unavailable albums", async (t) => {
  const f = await galleryFixture(t),
    { replica: r, volume } = f;
  await f.enable();
  fs.writeFileSync(path.join(volume.path, ".arcaignore"), "*.HEIC\n");
  await f.daemon.engine.cycle();
  await r.sync();
  assert.equal(r.error, null);
  assert.match((await f.store.gallery(r.scope, volume.id)).issue, /Excluded by/);
  assert.equal((await f.store.gallerySummary(r.scope, volume.id)).accepted, 0);
  fs.rmSync(path.join(volume.path, ".arcaignore"));
  await f.daemon.engine.cycle();
  await r.sync(true);
  assert.equal(r.error, null);
  f.media.albums = async () => [];
  await r.sync();
  assert.equal(r.error, null);
  assert.equal(r.hubUnavailable, false);
  assert.match(
    (await f.store.gallery(r.scope, volume.id)).issue,
    /album is unavailable/,
  );
  assert.equal((await f.store.folder(r.scope, volume.id)).issue, null);
  const source = await f.store.gallery(r.scope, volume.id);
  await f.store.issue(r.scope, volume.id, source.issue);
  await r.load();
  await r.sync();
  assert.equal(r.error, null);
  assert.equal((await f.store.folder(r.scope, volume.id)).issue, null);
  const after = await f.store.gallery(r.scope, volume.id);
  assert.equal(after.issue, source.issue);
  assert.deepEqual(after.albums, source.albums);
  fs.writeFileSync(
    path.join(volume.path, "from-another-device.jpg"),
    "shared photo",
  );
  await f.daemon.engine.cycle();
  await sync(f);
  assert.equal(
    fs.readFileSync(
      f.files.work(r.scope, volume.id, "from-another-device.jpg"),
      "utf8",
    ),
    "shared photo",
  );
  assert.ok(fs.existsSync(path.join(volume.path, (await f.uploaded()).path)));
});

test("album uploads get their turn before the download and a yield there still lets the download run", async (t) => {
  const f = await galleryFixture(t),
    { replica: r } = f;
  await f.enable();
  const order = [];
  const cycle = r.gallery.cycle.bind(r.gallery);
  let yielded = false;
  r.gallery.cycle = async (folder) => {
    order.push("uploads");
    if (!yielded) {
      yielded = true;
      throw Object.assign(new Error("Continuing next turn"), { code: "SYNC_YIELD" });
    }
    return cycle(folder);
  };
  const pull = r.pull.bind(r);
  r.pull = async (folder) => {
    order.push("download");
    return pull(folder);
  };
  await r.sync();
  assert.deepEqual(order.slice(0, 2), ["uploads", "download"]);
  assert.equal(r.error, null);
});

test("a failing album upload pass still downloads the shared folder and reports the upload failure", async (t) => {
  const f = await galleryFixture(t),
    { replica: r } = f;
  await f.enable();
  fs.writeFileSync(path.join(f.volume.path, "from-hub.txt"), "hub");
  await f.daemon.engine.cycle();
  r.gallery.cycle = async () => {
    throw new Error("Photo library changed unexpectedly");
  };
  const pull = r.pull.bind(r);
  let pulls = 0,
    issueWhileDownloading;
  r.pull = async (folder) => {
    if (++pulls === 1)
      throw Object.assign(new Error("Continuing next turn"), { code: "SYNC_YIELD" });
    issueWhileDownloading = (await f.store.folder(r.scope, f.volume.id)).issue;
    return pull(folder);
  };
  await r.sync();
  assert.match(issueWhileDownloading, /Photo library changed unexpectedly/);
  assert.equal(
    fs.readFileSync(f.files.work(r.scope, f.volume.id, "from-hub.txt"), "utf8"),
    "hub",
  );
  assert.match(r.error, /Photo library changed unexpectedly/);
});

test("gallery pagination remains bounded, counts only accepted items and survives restart", async (t) => {
  const assets = Array.from({ length: 1103 }, (_, i) => ({
    id: `asset-${i}`,
    filename: "IMG_0001.jpg",
    creationTime: 1750000000000,
  }));
  const f = await galleryFixture(t, assets),
    { replica: r, volume, store } = f;
  await f.enable();
  await sync(f);
  let summary = await store.gallerySummary(r.scope, volume.id);
  assert.equal(summary.discovered, 400);
  assert.equal(summary.accepted, 3);
  await r.load();
  await sync(f);
  await sync(f);
  summary = await store.gallerySummary(r.scope, volume.id);
  assert.equal(summary.discovered, 1103);
  assert.equal(summary.accepted, 9);
  assert.equal(new Set(f.exports).size, 9);
  assert.deepEqual((await store.gallery(r.scope, volume.id)).cursors, {}, "a finished scan keeps no cursor");
});

test("gallery preserves all resources of a Live Photo and resumes without reuploading accepted resources", async (t) => {
  const f = await galleryFixture(t),
    { replica: r, volume } = f;
  f.media.export = async (id, destination) => {
    fs.mkdirSync(destination, { recursive: true });
    return ["HEIC", "MOV"].map((ext, i) => {
      const uri = path.join(destination, ext);
      fs.writeFileSync(uri, `${ext} original`);
      return { key: `resource-${i}`, name: `IMG_1234.${ext}`, uri };
    });
  };
  await f.enable();
  await sync(f);
  const asset = await f.store.galleryAsset(r.scope, volume.id, "photo-1");
  assert.equal(asset.resources.length, 2);
  assert.ok(asset.resources.every((v) => v.accepted));
  for (const resource of asset.resources)
    assert.ok(fs.existsSync(path.join(volume.path, resource.path)));
  await r.unselect(volume.id);
  assert.equal(await f.store.gallery(r.scope, volume.id), null);
  assert.equal(await f.store.galleryAsset(r.scope, volume.id, "photo-1"), null);
  for (const resource of asset.resources)
    assert.ok(fs.existsSync(path.join(volume.path, resource.path)));
});

test("gallery recovers a lost conflict receipt after the hub deletes that conflict copy", async (t) => {
  const f = await galleryFixture(t),
    { replica: r, volume, client } = f;
  await f.enable();
  const api = client.api;
  let conflictPath;
  client.api = async (route, body) => {
    if (route === "/v1/propose" && body.hash && !conflictPath) {
      fs.mkdirSync(path.dirname(path.join(volume.path, body.path)), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(volume.path, body.path),
        "concurrent desktop file",
      );
      await f.daemon.engine.cycle();
      const result = await api(route, body);
      conflictPath = result.conflictPath;
      assert.ok(conflictPath);
      throw new Error("conflict reply lost");
    }
    return api(route, body);
  };
  await r.sync();
  assert.equal(r.error, null);
  assert.match((await f.store.gallery(r.scope, volume.id)).issue, /reply lost/);
  fs.rmSync(path.join(volume.path, conflictPath));
  await f.daemon.engine.cycle();
  f.data.clear();
  await r.sync(true);
  assert.equal(r.error, null);
  assert.equal((await f.store.gallerySummary(r.scope, volume.id)).accepted, 1);
  assert.equal(fs.existsSync(path.join(volume.path, conflictPath)), false);
  assert.equal(f.exports.length, 1);
});

test("gallery conflict receipt recovery keeps a paused first-download lease", async (t) => {
  const f = await galleryFixture(t),
    { replica: r, volume, client, store } = f;
  await f.enable();
  const api = client.api;
  let conflictPath;
  client.api = async (route, body) => {
    if (route === "/v1/propose" && body.hash && !conflictPath) {
      fs.mkdirSync(path.dirname(path.join(volume.path, body.path)), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(volume.path, body.path),
        "concurrent desktop file",
      );
      await f.daemon.engine.cycle();
      const result = await api(route, body);
      conflictPath = result.conflictPath;
      throw new Error("conflict reply lost");
    }
    return api(route, body);
  };
  await r.sync();
  assert.match((await store.gallery(r.scope, volume.id)).issue, /reply lost/);
  const resource = { ...(await f.uploaded()) };
  assert.equal(resource.attempted, true);

  for (const name of ["a.txt", "b.txt", "c.txt"])
    fs.writeFileSync(path.join(volume.path, name), `hub ${name}`);
  await f.daemon.engine.cycle();
  await store.resetCursor(r.scope, volume.id);
  const check = r.checkTransferTurn.bind(r);
  let transfers = 0;
  r.checkTransferTurn = () => {
    if (++transfers === 2)
      throw Object.assign(new Error("Continuing next turn"), {
        code: "SYNC_YIELD",
      });
    return check();
  };
  await assert.rejects(
    r.pull(await store.folder(r.scope, volume.id)),
    (error) => error.code === "SYNC_YIELD",
  );
  r.checkTransferTurn = check;
  const saved = await store.snapshotCursor(r.scope, volume.id);
  assert.ok(saved?.session);

  const calls = [];
  client.api = (route, ...rest) => {
    calls.push(route);
    return api(route, ...rest);
  };
  assert.equal(await r.gallery.acknowledged(volume.id, resource), true);
  assert.equal(resource.path, conflictPath);
  assert.equal(calls.filter((route) => route.startsWith("/v1/snapshot?")).length, 0);

  calls.length = 0;
  await r.pull(await store.folder(r.scope, volume.id));
  const snapshots = calls.filter((route) => route.startsWith("/v1/snapshot?"));
  assert.ok(snapshots.length);
  assert.ok(snapshots.every((route) => route.includes(`session=${saved.session}`)));
  for (const name of ["a.txt", "b.txt", "c.txt"])
    assert.equal(
      fs.readFileSync(f.files.work(r.scope, volume.id, name), "utf8"),
      `hub ${name}`,
    );
});

test("gallery handles limited access, low storage, changed originals and destroyed state without touching Photos", async (t) => {
  const f = await galleryFixture(t),
    { replica: r, files, store, volume } = f;
  f.media.permission = async () => ({
    granted: true,
    accessPrivileges: "limited",
  });
  await f.enable();
  files.free = async () => 0;
  await r.sync();
  assert.equal(r.error, null);
  assert.match((await f.store.gallery(r.scope, volume.id)).issue, /storage/);
  assert.equal(f.exports.length, 0);
  files.free = async () => 1e12;
  const raw = f.client.raw;
  f.client.raw = async (route, options) => {
    if (route.startsWith("/v1/uploads/")) throw new Error("network lost");
    return raw(route, options);
  };
  await r.sync(true);
  assert.equal(r.error, null);
  assert.match((await f.store.gallery(r.scope, volume.id)).issue, /network lost/);
  f.client.raw = raw;
  f.data.set("photo-1", Buffer.from("new original"));
  await r.sync(true);
  assert.equal(r.error, null);
  assert.match((await f.store.gallery(r.scope, volume.id)).issue, /Original changed/);
  assert.equal((await store.gallery(r.scope, volume.id)).limited, true);
  assert.equal(fs.existsSync(files.galleryStage(r.scope, volume.id)), false);
  await r.destroy(true);
  assert.equal((await store.gallerySummary(null, volume.id)).discovered, 0);
  assert.equal(f.data.get("photo-1").toString(), "new original");
});

test("gallery preview reads are bounded, folder-scoped and separate pending from recent receipts", async (t) => {
  const f = await galleryFixture(t),
    { store, replica: r, volume } = f;
  for (let i = 0; i < 30; i++) {
    await store.putGalleryAsset(r.scope, volume.id, {
      id: `done-${i}`,
      name: `${i}.jpg`,
      state: "accepted",
      acceptedAt: i + 1,
    });
    await store.putGalleryAsset(r.scope, volume.id, {
      id: `pending-${i}`,
      name: `${i}.jpg`,
      state: i === 29 ? "failed" : "pending",
    });
  }
  await store.putGalleryAsset(r.scope, "another-folder", {
    id: "foreign",
    state: "accepted",
    acceptedAt: 9999,
  });
  const recent = await store.galleryPreview(r.scope, volume.id, true, 12);
  assert.equal(recent.length, 12);
  assert.equal(recent[0].id, "done-29");
  assert.ok(
    recent.every((item) => item.state === "accepted" && item.id !== "foreign"),
  );
  const pending = await store.galleryPreview(r.scope, volume.id, false, 6);
  assert.equal(pending.length, 6);
  assert.equal(pending[0].id, "pending-29");
  assert.ok(pending.every((item) => item.state !== "accepted"));
  assert.equal(
    (await store.galleryPreview(r.scope, volume.id, true, 10000)).length,
    24,
  );
});

test("manual gallery picks share receipts with automatic album uploads", async (t) => {
  const f = await galleryFixture(t);
  const r = f.replica;
  await f.enable();
  await r.gallery.addPhotos(f.volume.id, [
    { assetId: "photo-1", fileName: "IMG_1234.HEIC" },
  ]);
  const first = await f.uploaded();
  assert.ok(first.accepted);
  const exports = f.exports.length;
  await sync(f);
  await r.gallery.addPhotos(f.volume.id, [{ assetId: "photo-1" }]);
  assert.equal(f.exports.length, exports);
  assert.equal(
    (await f.store.gallerySummary(r.scope, f.volume.id)).accepted,
    1,
  );
  assert.equal(
    await f.files.exists(f.files.folder(r.scope, f.volume.id)),
    true,
  );
});

test("Add photos while the hub is unreachable keeps the picks pending and uploads them after reconnecting", async (t) => {
  const f = await galleryFixture(t);
  const r = f.replica;
  await f.enable();
  const uri = path.join(f.root, "offline-pick.jpg");
  fs.writeFileSync(uri, "picked while offline");
  const before = await f.store.gallerySummary(r.scope, f.volume.id);
  f.offline();
  await assert.rejects(r.gallery.addPhotos(f.volume.id, [{ uri, fileName: "offline-pick.jpg" }]));
  const pending = await f.store.gallerySummary(r.scope, f.volume.id);
  assert.equal(pending.pending, before.pending + 1, "the pick is journaled before the hub is needed");
  assert.equal(pending.accepted, before.accepted);
  f.online();
  await sync(f);
  assert.equal((await f.store.gallerySummary(r.scope, f.volume.id)).pending, 0);
  const accepted = await f.store.galleryPreview(r.scope, f.volume.id, true, 10);
  assert.ok(accepted.some((item) => item.name === "offline-pick.jpg"));
});

test("a pick made offline on a source with automatic uploads off still uploads after reconnecting", async (t) => {
  const f = await galleryFixture(t);
  const r = f.replica;
  await f.enable();
  await r.gallery.setEnabled(f.volume.id, false);
  const uri = path.join(f.root, "manual-pick.jpg");
  fs.writeFileSync(uri, "picked with uploads off");
  f.offline();
  await assert.rejects(r.gallery.addPhotos(f.volume.id, [{ uri, fileName: "manual-pick.jpg" }]));
  f.online();
  await sync(f);
  assert.equal((await f.store.gallerySummary(r.scope, f.volume.id)).pending, 0);
  const accepted = await f.store.galleryPreview(r.scope, f.volume.id, true, 10);
  assert.ok(accepted.some((item) => item.name === "manual-pick.jpg"));
});

test("with automatic uploads off, manual picks upload past a backlog of library rows and clear a stale issue, with or without an asset id", async (t) => {
  const f = await galleryFixture(t);
  const r = f.replica;
  await f.enable();
  await r.gallery.setEnabled(f.volume.id, false);
  for (let i = 0; i < 25; i++)
    await f.store.putGalleryAsset(r.scope, f.volume.id, {
      id: `a-backlog-${String(i).padStart(2, "0")}`,
      name: `${i}.jpg`,
      state: "pending",
      retryAt: 0,
    });
  const uri = path.join(f.root, "behind-backlog.jpg");
  fs.writeFileSync(uri, "picked behind a backlog");
  f.offline();
  await assert.rejects(
    r.gallery.addPhotos(f.volume.id, [
      { uri, fileName: "behind-backlog.jpg" },
      { assetId: "photo-1", fileName: "IMG_1234.HEIC" },
    ]),
  );
  const source = await f.store.gallery(r.scope, f.volume.id);
  source.issue = "Some photos could not be uploaded. Retry to continue.";
  await f.store.setGallery(r.scope, f.volume.id, source);
  f.online();
  await sync(f);
  const accepted = await f.store.galleryPreview(r.scope, f.volume.id, true, 10);
  assert.ok(accepted.some((item) => item.name === "behind-backlog.jpg"));
  assert.ok((await f.uploaded())?.accepted);
  assert.equal((await f.store.gallery(r.scope, f.volume.id)).issue, null);
});

test("a pick is copied into app storage when journaled, so the picker's temporary file can vanish and it still uploads", async (t) => {
  const f = await galleryFixture(t);
  const r = f.replica;
  await f.enable();
  const uri = path.join(f.root, "vanishing.jpg");
  fs.writeFileSync(uri, "soon gone");
  f.offline();
  await assert.rejects(r.gallery.addPhotos(f.volume.id, [{ uri, fileName: "vanishing.jpg" }]));
  const [pending] = await f.store.galleryPreview(r.scope, f.volume.id, false, 24);
  const copy = f.files.picked(r.scope, f.volume.id, pending.id);
  assert.ok(copy.startsWith(path.join(f.root, "mobile", r.scope, "picked")), "the copy lives in app-owned storage");
  assert.equal(pending.picked.uri, undefined, "the journal keeps the key, never an absolute path");
  assert.equal(fs.readFileSync(copy, "utf8"), "soon gone");
  fs.rmSync(uri);
  f.online();
  await r.sync();
  const summary = await f.store.gallerySummary(r.scope, f.volume.id);
  assert.equal(summary.failed, 0);
  assert.equal((await f.store.galleryAsset(r.scope, f.volume.id, pending.id)).state, "accepted");
  assert.equal(fs.existsSync(copy), false, "the copy goes once the hub has the photo");
});

test("picks upload even when library permission is revoked or the linked album is gone", async (t) => {
  for (const loss of ["permission", "album"]) {
    const f = await galleryFixture(t);
    const r = f.replica;
    await f.enable();
    const uri = path.join(f.root, `${loss}.jpg`);
    fs.writeFileSync(uri, `picked while ${loss} is lost`);
    f.offline();
    await assert.rejects(r.gallery.addPhotos(f.volume.id, [{ uri, fileName: `${loss}.jpg` }]));
    if (loss === "permission") f.media.permission = async () => ({ granted: false, accessPrivileges: "none" });
    else f.media.albums = async () => [];
    f.online();
    await r.sync(true).catch(() => {});
    const accepted = await f.store.galleryPreview(r.scope, f.volume.id, true, 10);
    assert.ok(accepted.some((item) => item.name === `${loss}.jpg`), `${loss}: the pick was uploaded`);
  }
});

test("Sync now retries failed manual picks at once while automatic uploads are off", async (t) => {
  const f = await galleryFixture(t);
  const r = f.replica;
  await f.enable();
  await r.gallery.setEnabled(f.volume.id, false);
  const uri = path.join(f.root, "retry-now.jpg");
  fs.writeFileSync(uri, "retry me");
  f.offline();
  await assert.rejects(r.gallery.addPhotos(f.volume.id, [{ uri, fileName: "retry-now.jpg" }]));
  const [pending] = await f.store.galleryPreview(r.scope, f.volume.id, false, 24);
  await f.store.putGalleryAsset(r.scope, f.volume.id, { ...pending, state: "failed", issue: "Temporary failure", retryAt: Date.now() + 3600000 });
  f.online();
  await sync(f);
  assert.equal((await f.store.galleryAsset(r.scope, f.volume.id, pending.id)).state, "failed", "a scheduled sync waits for the retry time");
  await r.sync(true);
  assert.equal((await f.store.galleryAsset(r.scope, f.volume.id, pending.id)).state, "accepted", "Sync now retries it");
});

test("several selected albums are scanned one by one, a photo in two albums counts once, and an album that disappears is named while the others keep uploading", async (t) => {
  const photos = [
    { id: "a-1", filename: "A1.jpg", creationTime: 1750000000000 },
    { id: "shared", filename: "S.jpg", creationTime: 1750000001000 },
    { id: "b-1", filename: "B1.jpg", creationTime: 1750000002000 },
    { id: "other-1", filename: "O1.jpg", creationTime: 1750000003000 },
  ];
  const membership = { a: ["a-1", "shared"], b: ["b-1", "shared"], other: ["other-1"] };
  const f = await galleryFixture(t, photos);
  const { replica: r, store, volume } = f;
  const pages = [];
  f.media.albums = async () => [
    { id: "a", title: "Family" },
    { id: "b", title: "Trips" },
    { id: "other", title: "Screenshots" },
  ];
  f.media.page = async (source) => {
    pages.push(source.albumId ?? "all");
    const ids = source.albumId ? membership[source.albumId] : photos.map((p) => p.id);
    return { assets: photos.filter((p) => ids.includes(p.id)), hasNextPage: false, endCursor: "0" };
  };
  await r.gallery.configure(
    volume.id,
    { albums: [{ id: "a", title: "Family" }, { id: "b", title: "Trips" }], videos: false },
    true,
  );
  const saved = await store.gallery(r.scope, volume.id);
  assert.deepEqual(saved.albums.map((album) => album.id), ["a", "b"]);
  assert.equal(saved.albumId, undefined, "the single-album fields are gone");
  await r.sync(true);
  assert.deepEqual([...new Set(pages)].sort(), ["a", "b"], "each selected album is scanned and no other");
  assert.equal(pages.includes("other"), false);
  assert.equal(pages.includes("all"), false);
  const state = async (id) => (await store.galleryAsset(r.scope, volume.id, id))?.state;
  assert.equal(await state("a-1"), "accepted");
  assert.equal(await state("b-1"), "accepted");
  assert.equal(await state("shared"), "accepted");
  assert.equal(await state("other-1"), undefined, "a photo only in an unselected album is never discovered");
  assert.equal((await store.gallerySummary(r.scope, volume.id)).discovered, 3, "the shared photo counts once");
  assert.deepEqual((await store.gallery(r.scope, volume.id)).cursors, {}, "a finished pass leaves no cursor behind");

  pages.length = 0;
  f.media.albums = async () => [{ id: "a", title: "Family" }];
  f.assets.push({ id: "a-2", filename: "A2.jpg", creationTime: 1750000004000 });
  membership.a.push("a-2");
  f.data.set("a-2", Buffer.from("original a-2"));
  photos.push({ id: "a-2", filename: "A2.jpg", creationTime: 1750000004000 });
  await r.sync(true).catch(() => {});
  assert.deepEqual([...new Set(pages)], ["a"], "only the album that is still there is scanned");
  assert.equal(await state("a-2"), "accepted", "the other album keeps uploading");
  assert.match((await store.gallery(r.scope, volume.id)).issue, /Trips is unavailable/);

  f.media.albums = async () => [];
  await r.sync(true).catch(() => {});
  assert.match((await store.gallery(r.scope, volume.id)).issue, /The selected albums are unavailable/);
});

test("a multi-album pass interrupted mid-album finishes after another album disappears", async (t) => {
  const small = [{ id: "s-1", filename: "S1.jpg", creationTime: 1750000000000 }];
  const big = Array.from({ length: 501 }, (_, i) => ({ id: `big-${i}`, filename: `B${i}.jpg`, creationTime: 1750000001000 + i }));
  const f = await galleryFixture(t, [...small, ...big]);
  const { replica: r, store, volume } = f;
  const albums = { small, big };
  f.media.albums = async () => [{ id: "small", title: "Small" }, { id: "big", title: "Big" }];
  f.media.page = async (source) => {
    const list = albums[source.albumId];
    const after = Number(source.after || 0);
    return { assets: list.slice(after, after + 100), hasNextPage: after + 100 < list.length, endCursor: String(after + 100) };
  };
  await r.gallery.configure(volume.id, { albums: [{ id: "small", title: "Small" }, { id: "big", title: "Big" }], videos: false }, true);
  await r.sync(true).catch(() => {});
  const mid = await store.gallery(r.scope, volume.id);
  assert.equal(mid.cursors.small, null, "the small album finished");
  assert.ok(mid.cursors.big, "the big album is mid-pass");
  f.media.albums = async () => [{ id: "small", title: "Small" }];
  await r.sync(true).catch(() => {});
  const after = await store.gallery(r.scope, volume.id);
  assert.deepEqual(after.cursors, {}, "a stale cursor of a disappeared album never keeps the pass open");
  assert.ok(after.scannedAt, "the pass is complete");
});

test("a source saved with one album keeps scanning that album after the upgrade", async (t) => {
  const f = await galleryFixture(t);
  const { replica: r, store, volume } = f;
  await f.enable();
  const source = await store.gallery(r.scope, volume.id);
  const { albums, ...legacy } = source;
  await store.setGallery(r.scope, volume.id, { ...legacy, albumId: "camera", albumName: "Camera", albums: undefined, cursors: undefined });
  const pages = [];
  const page = f.media.page;
  f.media.page = async (arg) => {
    pages.push(arg.albumId ?? "all");
    return page(arg);
  };
  await r.sync(true);
  assert.deepEqual([...new Set(pages)], ["camera"]);
});

test("a corrupt gallery asset row is set aside: startup, queries and other assets carry on and nothing is deleted", async (t) => {
  const f = await galleryFixture(
    t,
    [
      { id: "photo-1", filename: "IMG_1.HEIC", creationTime: 1750000000000 },
      { id: "photo-2", filename: "IMG_2.HEIC", creationTime: 1750000001000 },
    ],
  );
  const { replica: r, store, volume } = f;
  await f.enable();
  await r.sync(true);
  assert.equal((await store.gallerySummary(r.scope, volume.id)).accepted, 2);
  const deleted = () => f.daemon.engine.store.db.prepare("SELECT COUNT(*) AS n FROM revisions WHERE deleted=1").get().n;
  const before = deleted();
  const insert = (asset, state, row) =>
    store.db.runAsync("INSERT INTO gallery_assets VALUES(?,?,?,?,?,?)", r.scope, volume.id, asset, state, 0, row);
  await insert("broken-text", "failed", "{not json");
  await insert("broken-shape", "accepted", '"just a string"');
  await insert("broken-pending", "pending", "[1,2]");
  await store.clearInterrupted(r.scope);
  const corrupt = await store.db.getAllAsync("SELECT asset FROM gallery_corrupt WHERE scope=? ORDER BY asset", r.scope);
  assert.deepEqual(corrupt.map((row) => row.asset), ["broken-pending", "broken-shape", "broken-text"]);
  assert.equal(await store.galleryAsset(r.scope, volume.id, "broken-text"), null);
  assert.equal((await store.gallerySummary(r.scope, volume.id)).accepted, 2);
  assert.deepEqual(await store.galleryManual(r.scope, volume.id, Date.now(), 24), []);
  assert.deepEqual(await store.unregisteredGalleryAssets(r.scope, volume.id), []);

  f.assets.push({ id: "photo-3", filename: "IMG_3.HEIC", creationTime: 1750000002000 });
  f.data.set("photo-3", Buffer.from("original photo-3"));
  await r.sync(true);
  assert.equal((await store.galleryAsset(r.scope, volume.id, "photo-3")).state, "accepted", "other assets are not blocked");
  assert.equal(deleted(), before, "a corrupt row never publishes a deletion");
  await insert("one-row", "pending", '{"id":"one-row"}');
  await store.quarantineGalleryRow(r.scope, volume.id, "one-row");
  assert.equal(await store.galleryAsset(r.scope, volume.id, "one-row"), null, "a single row can be set aside by key");
  assert.equal((await store.db.getFirstAsync("SELECT COUNT(*) AS n FROM gallery_corrupt WHERE asset='one-row'")).n, 1);
});

test("rows with the wrong shape are set aside too, and a corrupt pick whose app copy exists is queued again", async (t) => {
  const f = await galleryFixture(t);
  const { replica: r, store, volume } = f;
  await f.enable();
  const insert = (asset, state, row) =>
    store.db.runAsync("INSERT INTO gallery_assets VALUES(?,?,?,?,?,?)", r.scope, volume.id, asset, state, 0, row);
  await insert("bad-string", "accepted", '{"id":"x","resources":"abc"}');
  await insert("bad-member", "accepted", '{"id":"y","resources":["abc"]}');
  await insert("bad-object", "accepted", '{"id":"z","resources":{"a":"x"}}');
  await insert("fine", "removed", '{"id":"fine","state":"removed","resources":[{"key":"original","accepted":true}]}');
  await store.clearInterrupted(r.scope);
  assert.deepEqual(
    (await store.db.getAllAsync("SELECT asset FROM gallery_corrupt WHERE scope=? ORDER BY asset", r.scope)).map((row) => row.asset),
    ["bad-member", "bad-object", "bad-string"],
  );
  assert.ok(await store.galleryAsset(r.scope, volume.id, "fine"));
  await store.gallerySummary(r.scope, volume.id);
  await store.galleryReceipt(r.scope, volume.id, "hash", 1, false);

  const uri = path.join(f.root, "pick.jpg");
  fs.writeFileSync(uri, "pick bytes");
  f.offline();
  await assert.rejects(r.gallery.addPhotos(volume.id, [{ uri, fileName: "pick.jpg" }]));
  const pending = (await store.galleryPreview(r.scope, volume.id, false, 24)).find((item) => item.picked);
  await store.db.runAsync("UPDATE gallery_assets SET row=? WHERE asset=?", "{broken", pending.id);
  await store.clearInterrupted(r.scope);
  assert.equal(await store.galleryAsset(r.scope, volume.id, pending.id), null);
  f.online();
  await r.sync(true);
  const recovered = await store.galleryAsset(r.scope, volume.id, pending.id);
  assert.equal(recovered.state, "accepted", "the kept copy of the pick uploads again");
  assert.deepEqual(await store.corruptPicks(r.scope, volume.id), []);
});

test("a library photo deleted from the phone leaves the upload queue even when the existence lookup cannot say so", async (t) => {
  const nativeError = () =>
    new Error(
      "Call to function 'ArcaNetwork.exportGalleryAsset' has been rejected.\n→ Caused by: java.lang.IllegalStateException: Photo is no longer accessible. Check photo permissions.",
    );
  for (const lookup of ["throws", "says it exists"]) {
    const f = await galleryFixture(t, twoPhotos.map((a) => ({ ...a })));
    const { replica: r, store, volume } = f;
    await f.enable();
    f.media.export = async () => {
      throw nativeError();
    };
    f.media.exists = async () => {
      if (lookup === "throws") throw new Error("Could not get asset");
      return true;
    };
    await r.sync(true);
    for (const id of ["photo-1", "photo-2"]) {
      const row = await store.galleryAsset(r.scope, volume.id, id);
      assert.equal(row.state, "unavailable", `${lookup}: ${id} is released, not left failed`);
    }
    assert.equal((await store.gallerySummary(r.scope, volume.id)).failed, 0);
    assert.equal((await store.gallery(r.scope, volume.id)).issue, null);
  }
});

test("a manual pick of a library photo deleted from the phone is released too, and a null-cursor answer is not proof", async (t) => {
  const f = await galleryFixture(t, twoPhotos.map((a) => ({ ...a })));
  const { replica: r, store, volume } = f;
  await f.enable();
  await r.gallery.setEnabled(volume.id, false);
  f.offline();
  await assert.rejects(r.gallery.addPhotos(volume.id, [{ assetId: "photo-1", fileName: "IMG_1234.HEIC" }]));
  f.media.exists = async () => {
    throw new Error("Could not get asset");
  };
  f.media.export = async () => {
    throw new Error("Photo is no longer accessible");
  };
  f.online();
  await r.sync(true).catch(() => {});
  assert.equal((await store.galleryAsset(r.scope, volume.id, "photo-1")).state, "failed", "the provider-unreachable answer is not a deletion");
  f.media.export = async () => {
    throw new Error("Call to function 'ArcaNetwork.exportGalleryAsset' has been rejected.\n→ Caused by: java.lang.IllegalStateException: Photo is no longer accessible. Check photo permissions.");
  };
  await store.retryGallery(r.scope, volume.id);
  await r.sync(true).catch(() => {});
  const released = await store.galleryAsset(r.scope, volume.id, "photo-1");
  assert.equal(released.state, "unavailable");
  assert.equal((await store.gallerySummary(r.scope, volume.id)).failed, 0);
});

test("a different export failure keeps the photo failed, and restricted access never releases it", async (t) => {
  const f = await galleryFixture(t, twoPhotos.map((a) => ({ ...a })));
  const { replica: r, store, volume } = f;
  await f.enable();
  f.media.export = async () => {
    throw new Error("Only photos and videos can be uploaded");
  };
  f.media.exists = async () => true;
  await r.sync(true).catch(() => {});
  assert.equal((await store.galleryAsset(r.scope, volume.id, "photo-1")).state, "failed");
  f.media.export = async () => {
    throw new Error("Photo is no longer accessible. Check photo permissions.");
  };
  f.media.permission = async () => ({ granted: true, accessPrivileges: "limited" });
  await store.retryGallery(r.scope, volume.id);
  await r.sync(true).catch(() => {});
  assert.equal((await store.galleryAsset(r.scope, volume.id, "photo-1")).state, "failed", "limited access cannot tell deleted from not shared");
});

test("a pick whose app copy is gone can be dismissed instead of staying failed, and picking it again queues it", async (t) => {
  const f = await galleryFixture(t);
  const r = f.replica;
  await f.enable();
  const uri = path.join(f.root, "lost.jpg");
  fs.writeFileSync(uri, "lost soon");
  f.offline();
  await assert.rejects(r.gallery.addPhotos(f.volume.id, [{ uri, fileName: "lost.jpg" }]));
  const [pending] = await f.store.galleryPreview(r.scope, f.volume.id, false, 24);
  fs.rmSync(f.files.picked(r.scope, f.volume.id, pending.id));
  f.online();
  await r.sync();
  const [failed] = await f.store.galleryPreview(r.scope, f.volume.id, false, 24);
  assert.equal(failed.state, "failed");
  assert.equal(failed.lost, true);
  assert.match(failed.issue, /Pick it again or dismiss it/);
  assert.match((await f.store.gallery(r.scope, f.volume.id)).issue, /Pick it again or dismiss it/);
  await r.gallery.dismissLost(f.volume.id);
  const dismissed = await f.store.galleryAsset(r.scope, f.volume.id, failed.id);
  assert.equal(dismissed.state, "unavailable");
  assert.equal(dismissed.picked, undefined);
  assert.equal((await f.store.gallerySummary(r.scope, f.volume.id)).failed, 0);
  assert.equal((await f.store.gallery(r.scope, f.volume.id)).issue, null);
  await r.sync(true);
  assert.equal((await f.store.galleryAsset(r.scope, f.volume.id, failed.id)).state, "unavailable", "a retry does not revive it");
  fs.writeFileSync(uri, "lost soon");
  f.offline();
  await assert.rejects(r.gallery.addPhotos(f.volume.id, [{ uri, fileName: "lost.jpg" }]));
  assert.equal((await f.store.galleryAsset(r.scope, f.volume.id, failed.id)).state, "pending");
});

test("an Add photos failure after the picks were journaled says so, so Retry can sync instead of reopening the picker", async (t) => {
  const f = await galleryFixture(t);
  const r = f.replica;
  await f.enable();
  const uri = path.join(f.root, "journaled.jpg");
  fs.writeFileSync(uri, "journaled bytes");
  f.offline();
  const error = await r.gallery.addPhotos(f.volume.id, [{ uri, fileName: "journaled.jpg" }]).catch((e) => e);
  assert.equal(error.journaled, true);
  const none = await r.gallery.addPhotos(f.volume.id, [{ uri: path.join(f.root, "nothing.jpg"), fileName: "nothing.jpg" }]).catch((e) => e);
  assert.ok(none instanceof Error);
  assert.equal(none.journaled, undefined, "nothing was journaled, so picking again is the right retry");
  f.online();
  await r.sync();
  const accepted = await f.store.galleryPreview(r.scope, f.volume.id, true, 10);
  assert.ok(accepted.some((item) => item.name === "journaled.jpg"), "a sync uploads the journaled pick");
});

test("Add photos failures a sync cannot recover do not offer a sync as the retry", async (t) => {
  const f = await galleryFixture(t);
  const r = f.replica;
  await f.enable();
  const good = path.join(f.root, "good.jpg");
  fs.writeFileSync(good, "good bytes");
  const upload = r.upload.bind(r);
  r.upload = async () => {
    throw new Error("Upload refused");
  };
  const refused = await r.gallery.addPhotos(f.volume.id, [{ uri: good, fileName: "good.jpg" }]).catch((e) => e);
  assert.match(refused.message, /Upload refused/);
  assert.equal(refused.journaled, undefined, "a refused upload waits for its retry time, so a plain sync would do nothing");
  r.upload = upload;
  const unreadable = await r.gallery
    .addPhotos(f.volume.id, [
      { uri: path.join(f.root, "gone.jpg"), fileName: "gone.jpg" },
      { uri: good, fileName: "good.jpg" },
    ])
    .catch((e) => e);
  assert.ok(unreadable instanceof Error);
  assert.equal(unreadable.journaled, undefined, "an unreadable pick can only be recovered by picking it again");
});

test("a pick that still has its app copy is never dismissed", async (t) => {
  const f = await galleryFixture(t);
  const r = f.replica;
  await f.enable();
  const uri = path.join(f.root, "kept.jpg");
  fs.writeFileSync(uri, "kept");
  f.offline();
  await assert.rejects(r.gallery.addPhotos(f.volume.id, [{ uri, fileName: "kept.jpg" }]));
  const [pending] = await f.store.galleryPreview(r.scope, f.volume.id, false, 24);
  await f.store.putGalleryAsset(r.scope, f.volume.id, { ...pending, state: "failed", lost: true });
  await r.gallery.dismissLost(f.volume.id);
  assert.equal((await f.store.galleryAsset(r.scope, f.volume.id, pending.id)).state, "failed");
  assert.equal(fs.existsSync(f.files.picked(r.scope, f.volume.id, pending.id)), true);
});

test("a pick survives a change of the app container path because only its key is journaled", async (t) => {
  const f = await galleryFixture(t);
  const r = f.replica;
  await f.enable();
  const uri = path.join(f.root, "moved.jpg");
  fs.writeFileSync(uri, "container moves");
  f.offline();
  await assert.rejects(r.gallery.addPhotos(f.volume.id, [{ uri, fileName: "moved.jpg" }]));
  const [pending] = await f.store.galleryPreview(r.scope, f.volume.id, false, 24);
  const before = f.files.picked(r.scope, f.volume.id, pending.id);
  const moved = path.join(f.root, "new-container", path.basename(before));
  fs.mkdirSync(path.dirname(moved), { recursive: true });
  fs.renameSync(before, moved);
  f.files.picked = () => moved;
  f.online();
  await r.sync();
  assert.equal((await f.store.galleryAsset(r.scope, f.volume.id, pending.id)).state, "accepted");
});

test("picking the same photo again keeps its copy, and one unreadable pick does not stop the others being journaled", async (t) => {
  const f = await galleryFixture(t);
  const r = f.replica;
  await f.enable();
  const uri = path.join(f.root, "twice.jpg");
  fs.writeFileSync(uri, "same bytes");
  f.offline();
  await assert.rejects(r.gallery.addPhotos(f.volume.id, [{ uri, fileName: "twice.jpg" }]));
  const [pending] = await f.store.galleryPreview(r.scope, f.volume.id, false, 24);
  const copy = f.files.picked(r.scope, f.volume.id, pending.id);
  const copies = [];
  const copyFile = f.files.copy;
  f.files.copy = async (a, b) => {
    copies.push(b);
    if (copies.length > 1) throw new Error("No space left on device");
    return copyFile(a, b);
  };
  await assert.rejects(r.gallery.addPhotos(f.volume.id, [{ uri, fileName: "twice.jpg" }]));
  assert.deepEqual(copies, [], "an existing identical copy is not copied again");
  assert.equal(fs.readFileSync(copy, "utf8"), "same bytes");
  const missing = path.join(f.root, "missing.jpg");
  const second = path.join(f.root, "second.jpg");
  fs.writeFileSync(second, "second pick");
  await assert.rejects(
    r.gallery.addPhotos(f.volume.id, [
      { uri: missing, fileName: "missing.jpg" },
      { uri: second, fileName: "second.jpg" },
    ]),
  );
  const names = (await f.store.galleryPreview(r.scope, f.volume.id, false, 24)).map((item) => item.name).sort();
  assert.deepEqual(names, ["second.jpg", "twice.jpg"], "the readable pick was journaled despite the unreadable one");
});

test("picker-only photos upload without asking for library access", async (t) => {
  const f = await galleryFixture(t);
  const r = f.replica;
  await f.enable();
  const uri = path.join(f.root, "picked.jpg");
  fs.writeFileSync(uri, "picked photo");
  f.media.export = async () => {
    throw new Error("No library access");
  };
  await r.gallery.addPhotos(f.volume.id, [{ uri, fileName: "picked.jpg" }]);
  await r.gallery.addPhotos(f.volume.id, [{ uri, fileName: "picked.jpg" }]);
  assert.equal(
    (await f.store.gallerySummary(r.scope, f.volume.id)).accepted,
    1,
  );
  assert.equal(
    await f.files.exists(f.files.folder(r.scope, f.volume.id)),
    true,
  );
});

test("picker-only receipt deduplicates identical bytes found later in the album", async (t) => {
  const f = await galleryFixture(t);
  const r = f.replica;
  await f.enable();
  const uri = path.join(f.root, "picked.jpg");
  fs.writeFileSync(uri, f.data.get("photo-1"));
  await r.gallery.addPhotos(f.volume.id, [{ uri, fileName: "picked.jpg" }]);
  const before = await f.store.galleryPreview(r.scope, f.volume.id, true);
  await sync(f);
  const after = await f.uploaded();
  assert.equal(after.path, before[0].resources[0].path);
  assert.ok(after.accepted);
});

test("returning from a picker cannot start sync during a three-photo import", async (t) => {
  const f = await galleryFixture(t);
  const r = f.replica;
  const cycle = r.cycle.bind(r);
  let cycles = 0;
  r.cycle = async () => {
    cycles++;
    return cycle();
  };
  await r.withImportPicker(async () => {
    // Native picker background/foreground transition, followed by timer ticks.
    r.stop();
    await r.sync();
    for (let i = 0; i < 3; i++) {
      const uri = path.join(f.root, `picked-${i}.jpg`);
      fs.writeFileSync(uri, `photo ${i}`);
      await r.importFile(f.volume.id, `picked-${i}.jpg`, uri);
      await r.sync();
    }
    assert.equal(cycles, 0);
  });
  await sync(f);
  assert.equal(cycles, 1);
  for (let i = 0; i < 3; i++) {
    const row = await f.store.current(r.scope, f.volume.id, `picked-${i}.jpg`);
    assert.ok(row.hash);
  }
  assert.equal(r.picking, false);
});

test("picker cancellation and failure release sync reservation", async (t) => {
  const f = await galleryFixture(t);
  const r = f.replica;
  await r.withImportPicker(async () => {});
  assert.equal(r.picking, false);
  await assert.rejects(
    r.withImportPicker(async () => {
      throw new Error("Picker failed");
    }),
    /Picker failed/,
  );
  assert.equal(r.picking, false);
  await sync(f);
  assert.equal(r.error, null);
});

test("manual gallery batch records every pick and continues after one export fails", async (t) => {
  const assets = [1, 2, 3].map((i) => ({
    id: `photo-${i}`,
    filename: `photo-${i}.jpg`,
    creationTime: 1750000000000,
  }));
  const f = await galleryFixture(t, assets);
  await f.enable();
  const originalExport = f.media.export;
  f.media.export = async (...args) => {
    if (args[0] === "photo-1") throw new Error("Photo unavailable");
    return originalExport(...args);
  };
  await assert.rejects(
    f.replica.gallery.addPhotos(
      f.volume.id,
      assets.map((a) => ({ assetId: a.id, fileName: a.filename })),
    ),
    /Photo unavailable/,
  );
  const summary = await f.store.gallerySummary(f.replica.scope, f.volume.id);
  assert.equal(summary.discovered, 3);
  assert.equal(summary.accepted, 2);
  assert.equal(summary.failed, 1);
  assert.equal(f.replica.busy, false);
  f.media.export = originalExport;
  await f.store.retryGallery(f.replica.scope, f.volume.id);
  await sync(f);
  assert.equal(
    (await f.store.gallerySummary(f.replica.scope, f.volume.id)).accepted,
    3,
  );
});

test("changing gallery settings preserves disabled uploads", async (t) => {
  const f = await galleryFixture(t);
  await f.enable();
  await f.replica.gallery.setEnabled(f.volume.id, false);
  await f.replica.gallery.configure(
    f.volume.id,
    { albums: [], videos: false },
    true,
  );
  assert.equal(
    (await f.store.gallery(f.replica.scope, f.volume.id)).enabled,
    false,
  );
  await sync(f);
  assert.equal(f.exports.length, 0);
});

test("manual gallery summary write failure cannot leave the replica busy", async (t) => {
  const f = await galleryFixture(t);
  await f.enable();
  const original = f.store.setGallery;
  f.store.setGallery = async () => {
    throw new Error("Disk full");
  };
  await assert.rejects(
    f.replica.gallery.addPhotos(f.volume.id, [{ assetId: "photo-1" }]),
    /Disk full/,
  );
  assert.equal(f.replica.busy, false);
  assert.equal(f.replica.importing, false);
  f.store.setGallery = original;
});

test("disable uploads interrupts an active gallery cycle without losing its pending item", async (t) => {
  const f = await galleryFixture(t);
  await f.enable();
  let release, entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const wait = new Promise((resolve) => {
    release = resolve;
  });
  const original = f.media.export;
  f.media.export = async (...args) => {
    entered();
    await wait;
    return original(...args);
  };
  const active = f.replica.sync();
  await started;
  const disable = f.replica.gallery.setEnabled(f.volume.id, false);
  release();
  await Promise.all([active, disable]);
  assert.equal(
    (await f.store.gallery(f.replica.scope, f.volume.id)).enabled,
    false,
  );
  assert.equal(
    (await f.store.gallerySummary(f.replica.scope, f.volume.id)).pending,
    1,
  );
  assert.equal(f.replica.busy, false);
});

test("gallery size counts accepted resources once and excludes pending bytes", async (t) => {
  const f = await galleryFixture(t);
  const scope = f.replica.scope,
    volume = f.volume.id;
  const resource = {
    path: "photo.jpg",
    hash: "a".repeat(64),
    size: 120,
    accepted: true,
  };
  await f.store.putGalleryAsset(scope, volume, {
    id: "original",
    state: "accepted",
    resources: [resource],
  });
  await f.store.putGalleryAsset(scope, volume, {
    id: "alias",
    state: "accepted",
    resources: [resource],
  });
  await f.store.putGalleryAsset(scope, volume, {
    id: "live",
    state: "uploading",
    resources: [
      { ...resource, path: "live.jpg", size: 80 },
      { ...resource, path: "live.mov", size: 900, accepted: false },
    ],
  });
  const summary = await f.store.gallerySummary(scope, volume);
  assert.equal(summary.bytes, 200);
  assert.equal(summary.accepted, 2);
  assert.equal(summary.pending, 1);
});

test("gallery edits create revisions at the same Machine path, including reverting an edit", async (t) => {
  const f = await galleryFixture(t, [
    {
      id: "edit-photo",
      filename: "photo.jpg",
      creationTime: 1750000000000,
      modificationTime: 1,
    },
  ]);
  await f.enable();
  await f.replica.sync({ force: true });
  const first = await f.uploaded();
  assert.match(first.path, /^Machine-/);
  const original = f.data.get("edit-photo");
  f.data.set("edit-photo", Buffer.from("edited photo"));
  f.assets[0].modificationTime = 2;
  await f.replica.sync({ force: true });
  const edited = await f.uploaded();
  assert.equal(edited.path, first.path);
  assert.ok(edited.rev > first.rev);
  assert.equal(
    fs.readFileSync(path.join(f.volume.path, first.path), "utf8"),
    "edited photo",
  );
  f.data.set("edit-photo", original);
  f.assets[0].modificationTime = 3;
  await f.replica.sync({ force: true });
  const reverted = await f.uploaded();
  assert.ok(reverted.rev > edited.rev);
  const history = await f.client.api(
    `/v1/history?${new URLSearchParams({ volume: f.volume.id, path: first.path })}`,
  );
  assert.equal(history.versions.filter((row) => !row.deleted).length, 3);
  fs.rmSync(path.join(f.volume.path, first.path));
  await f.daemon.engine.cycle();
  f.data.set("edit-photo", Buffer.from("edit after hub deletion"));
  f.assets[0].modificationTime = 4;
  await f.replica.sync({ force: true });
  assert.equal(fs.existsSync(path.join(f.volume.path, first.path)), false);
});

function recordedSession(f) {
  const events = [];
  const session = {
    active: false,
    async begin() {
      events.push({ event: "begin", requests: f.requests.length });
      this.active = true;
    },
    async end() {
      if (!this.active) return;
      events.push({ event: "end", requests: f.requests.length });
      this.active = false;
    },
  };
  return { events, session };
}

test("a cycle whose last verdict was offline never raises the foreground session", async (t) => {
  const f = await fixture(t);
  const { replica } = f;
  await replica.select(f.client.state().catalog.volumes[0]);
  const { events, session } = recordedSession(f);
  replica.transfer = session;
  await sync(f);
  assert.deepEqual(events.map((e) => e.event), ["begin", "end"], "an online cycle acquires and releases once");
  f.offline();
  await replica.sync();
  assert.equal(replica.hubUnavailable, true);
  assert.deepEqual(events.map((e) => e.event), ["begin", "end", "begin", "end"], "the first failure still acquired, and released at once");
  const before = events.length;
  await replica.sync();
  await replica.sync();
  assert.equal(events.length, before, "later offline cycles neither acquire nor release");
});

test("the first cycle against an unreachable hub acquires the session and releases it when the refresh fails", async (t) => {
  const f = await fixture(t);
  await f.replica.select(f.client.state().catalog.volumes[0]);
  await sync(f);
  const reopened = new Replica({ store: f.store, files: f.files, client: f.client });
  await reopened.load();
  assert.equal(reopened.connectionChecked, false);
  const { events, session } = recordedSession(f);
  reopened.transfer = session;
  f.offline();
  await reopened.sync();
  assert.deepEqual(events.map((e) => e.event), ["begin", "end"]);
  assert.equal(session.active, false);
});

test("when the hub answers again the session is acquired after the probe and before any transfer", async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.volume.path, "back.txt"), "came back");
  await f.daemon.engine.cycle();
  await f.replica.select(f.client.state().catalog.volumes[0]);
  const { events, session } = recordedSession(f);
  f.replica.transfer = session;
  f.offline();
  await f.replica.sync();
  await f.replica.sync();
  assert.equal(f.replica.hubUnavailable, true);
  events.length = 0;
  f.online();
  const mark = f.requests.length;
  await sync(f);
  assert.deepEqual(events.map((e) => e.event), ["begin", "end"]);
  const first = f.requests.slice(mark);
  assert.equal(first[0], "/v1/catalog", "the probe is the first request of the cycle");
  assert.ok(events[0].requests > mark, "the session starts after the catalog answered");
  assert.ok(events[0].requests <= mark + first.indexOf("/v1/blobs/" + crypto.createHash("sha256").update("came back").digest("hex")) || !first.some((route) => route.startsWith("/v1/blobs/")), "and before the first file transfer");
  assert.equal(fs.readFileSync(f.files.work(f.replica.scope, f.volume.id, "back.txt"), "utf8"), "came back");
});

test("a forced follow-up cycle after a failed refresh does not keep the session the failed cycle took", async (t) => {
  const f = await fixture(t);
  await f.replica.select(f.client.state().catalog.volumes[0]);
  await sync(f);
  const reopened = new Replica({ store: f.store, files: f.files, client: f.client });
  await reopened.load();
  assert.equal(reopened.connectionChecked, false);
  let probes = 0;
  const refresh = reopened.refreshCatalog.bind(reopened);
  reopened.refreshCatalog = (...args) => {
    probes++;
    return refresh(...args);
  };
  const events = [];
  reopened.transfer = {
    active: false,
    async begin() {
      this.active = true;
      events.push(`begin@${probes}`);
    },
    async end() {
      if (!this.active) return;
      this.active = false;
      events.push(`end@${probes}`);
    },
  };
  f.offline();
  const run = reopened.sync();
  reopened.sync(true);
  await run;
  assert.equal(probes, 2, "the forced follow-up cycle ran");
  assert.deepEqual(events, ["begin@0", "end@1"], "the lease is released before the follow-up cycle, which skips it");
});

test("a native failure while releasing the session does not hide that the hub is unreachable", async (t) => {
  const f = await fixture(t);
  await f.replica.select(f.client.state().catalog.volumes[0]);
  await sync(f);
  const reopened = new Replica({ store: f.store, files: f.files, client: f.client });
  await reopened.load();
  reopened.transfer = {
    active: false,
    async begin() {
      this.active = true;
    },
    async end() {
      throw new Error("native stop failed");
    },
  };
  f.offline();
  await reopened.sync().catch(() => {});
  assert.equal(reopened.hubUnavailable, true);
  assert.doesNotMatch(reopened.error || "", /native stop failed/);
});

test("warming saved views gives every folder a revisions page within the shared deadline on a slow hub", async (t) => {
  const f = await fixture(t);
  const { replica, daemon } = f;
  for (const name of ["Two", "Three", "Four"]) daemon.engine.store.addVolume(name);
  await daemon.engine.cycle();
  await f.client.refresh();
  for (const volume of f.client.state().catalog.volumes) await replica.select(volume);
  await sync(f);
  await f.store.db.runAsync("DELETE FROM view_cache WHERE scope=?", replica.scope);
  const folders = (await f.store.folders(replica.scope)).filter((folder) => folder.selected);
  assert.equal(folders.length, 4);
  f.stall(async (url, options) => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    return fetch(url.replace("https://fixture.invalid", `http://127.0.0.1:${daemon.port}`), options);
  });
  await warmViews(replica, folders);
  f.stall(null);
  const saved = (await f.store.db.getAllAsync("SELECT route FROM view_cache WHERE scope=?", replica.scope)).map((row) => row.route);
  for (const folder of folders)
    assert.ok(
      saved.some((route) => route.includes(`volume=${folder.id}`) && route.includes("filter=revisions")),
      `${folder.name} has a saved revisions page after one warm-up`,
    );
});

test("warming saved views starts with machines, then missing and stalest revisions pages, skips fresh pages and keeps four requests in flight", async (t) => {
  const f = await fixture(t);
  const { replica, daemon } = f;
  for (const name of ["Two", "Three", "Four", "Five"]) daemon.engine.store.addVolume(name);
  await daemon.engine.cycle();
  await f.client.refresh();
  for (const volume of f.client.state().catalog.volumes) await replica.select(volume);
  await sync(f);
  const folders = (await f.store.folders(replica.scope)).filter((folder) => folder.selected);
  assert.equal(folders.length, 5);
  const [current, fresh, stale, staler, missing] = folders;
  const route = (folder, filter = "revisions") =>
    `/v1/activity?${new URLSearchParams({ volume: folder.id, filter, limit: "50" })}`;
  await f.store.db.runAsync("DELETE FROM view_cache WHERE scope=?", replica.scope);
  const now = Date.now();
  for (const [folder, age] of [[current, 10000], [fresh, 61000], [stale, 120000], [staler, 600000]])
    await f.store.db.runAsync(
      "INSERT INTO view_cache VALUES(?,?,?,?)",
      replica.scope,
      viewKey(route(folder)),
      now - age,
      JSON.stringify({ versions: [], next: null }),
    );
  const started = [];
  let inFlight = 0;
  let peak = 0;
  f.stall(async (url, options) => {
    const asked = new URL(url);
    started.push(asked.pathname + asked.search);
    peak = Math.max(peak, ++inFlight);
    await new Promise((resolve) => setTimeout(resolve, 60));
    inFlight--;
    return fetch(url.replace("https://fixture.invalid", `http://127.0.0.1:${daemon.port}`), options);
  });
  await warmViews(replica, folders);
  f.stall(null);
  const volumeOf = (entry) => new URLSearchParams(entry.split("?")[1]).get("volume");
  assert.equal(started[0], "/v1/machines", "machines is never starved behind the revisions pages");
  assert.deepEqual(
    started.slice(1, 5).map(volumeOf),
    [missing.id, staler.id, stale.id, fresh.id],
    "a missing page first, then the stalest, then fresher ones",
  );
  assert.equal(
    started.filter((entry) => entry.includes(`volume=${current.id}`) && entry.includes("filter=revisions")).length,
    0,
    "a page younger than a minute is not requested again",
  );
  assert.equal(peak, 4, "four requests overlap and never more");
});

test("a failing view stops the whole warm-up instead of leaving workers running", async (t) => {
  const f = await fixture(t);
  const { replica, daemon } = f;
  for (const name of ["Two", "Three", "Four"]) daemon.engine.store.addVolume(name);
  await daemon.engine.cycle();
  await f.client.refresh();
  for (const volume of f.client.state().catalog.volumes) await replica.select(volume);
  await sync(f);
  await f.store.db.runAsync("DELETE FROM view_cache WHERE scope=?", replica.scope);
  const folders = (await f.store.folders(replica.scope)).filter((folder) => folder.selected);
  let asked = 0;
  f.stall(async (url, options) => {
    if (asked++ === 0) return new Response(JSON.stringify({ error: "boom" }), { status: 500, headers: { "content-type": "application/json" } });
    await new Promise((resolve) => setTimeout(resolve, 80));
    return fetch(url.replace("https://fixture.invalid", `http://127.0.0.1:${daemon.port}`), options);
  });
  await warmViews(replica, folders);
  const settled = asked;
  await new Promise((resolve) => setTimeout(resolve, 600));
  f.stall(null);
  assert.equal(asked, settled, "no request starts after warmViews returned");
  assert.ok(settled < 13, "the remaining routes were not all requested");
});

test("an active native transfer drains multiple gallery batches and releases on completion", async (t) => {
  const assets = Array.from({ length: 8 }, (_, i) => ({
    id: "foreground-" + i,
    filename: "photo.jpg",
    creationTime: 1750000000000,
  }));
  const f = await galleryFixture(t, assets),
    r = f.replica;
  await f.enable();
  let stopped = 0;
  r.transfer = {
    active: false,
    async begin() {
      this.active = true;
    },
    async end() {
      this.active = false;
      stopped++;
    },
  };
  await sync(f);
  assert.equal(
    (await f.store.gallerySummary(r.scope, f.volume.id)).accepted,
    8,
  );
  assert.equal(stopped, 1);
  assert.equal(r.transfer.active, false);
});

test(
  "destroy cancels a stalled mobile sync before deleting local copies",
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t);
    await f.replica.select(f.volume);
    const local = f.files.folder(f.replica.scope, f.volume.id);
    let entered;
    const started = new Promise((resolve) => {
      entered = resolve;
    });
    f.stall(() => {
      entered();
      return new Promise(() => {});
    });
    const active = f.replica.sync();
    await started;
    f.offline();
    await f.replica.destroy(true);
    await active;
    assert.equal(fs.existsSync(local), false);
    assert.equal(f.replica.active, null);
    assert.equal(f.replica.error, null);
    assert.deepEqual(f.client.state(), { connection: null, catalog: null });
  },
);

test("mobile publishes a pending name before starting folder transfers", async (t) => {
  const f = await fixture(t);
  await f.replica.select(f.client.state().catalog.volumes[0]);
  await sync(f);
  f.offline();
  assert.equal(await f.replica.rename("emulator-android"), false);
  f.online();
  let checked = false;
  const scan = f.replica.scan.bind(f.replica);
  f.replica.scan = async (...args) => {
    const device = f.daemon.engine.store.db
      .prepare("SELECT name FROM devices WHERE id=?")
      .get(f.client.state().connection.id);
    assert.equal(device.name, "emulator-android");
    checked = true;
    return scan(...args);
  };
  await sync(f);
  assert.equal(checked, true);
});

test("mobile renames synced files offline, rejects collisions and propagates ordinary and case-only names", async (t) => {
  const f = await fixture(t),
    v = f.volume;
  const root = f.daemon.engine.store.volume(v.id).path;
  fs.mkdirSync(path.join(root, "nested"));
  fs.writeFileSync(path.join(root, "nested/original.txt"), "retained");
  fs.writeFileSync(path.join(root, "nested/taken.txt"), "keep");
  fs.writeFileSync(path.join(root, ".arcaignore"), "*.private\n");
  await f.daemon.engine.exclusive(() => f.daemon.engine.cycle());
  await f.replica.select(v);
  await sync(f);
  const row = await f.store.current(
    f.replica.scope,
    v.id,
    "nested/original.txt",
  );
  for (const name of [
    "../escape",
    "a/b",
    "CON.txt",
    "taken.txt",
    "TAKEN.TXT",
    "secret.private",
  ])
    await assert.rejects(f.replica.renameFile(v.id, row.path, name, row.rev));
  await assert.rejects(
    f.replica.renameFile(v.id, row.path, "new.txt", row.rev - 1),
    /changed/,
  );
  const file = f.files.work(f.replica.scope, v.id, row.path);
  fs.writeFileSync(file, "unsynced");
  await assert.rejects(
    f.replica.renameFile(v.id, row.path, "new.txt", row.rev),
    /changed/,
  );
  fs.writeFileSync(file, "retained");
  f.offline();
  await f.replica.renameFile(v.id, row.path, "renamed.txt", row.rev);
  assert.equal(fs.existsSync(file), false);
  f.online();
  await sync(f);
  assert.equal(
    fs.readFileSync(path.join(root, "nested/renamed.txt"), "utf8"),
    "retained",
  );
  const next = await f.store.current(
    f.replica.scope,
    v.id,
    "nested/renamed.txt",
  );
  await f.replica.renameFile(v.id, next.path, "RENAMED.txt", next.rev);
  await sync(f);
  assert.equal(
    fs.readFileSync(path.join(root, "nested/RENAMED.txt"), "utf8"),
    "retained",
  );
  assert.ok(
    f.daemon.engine.store
      .history(v.id, row.path)
      .some((r) => r.hash === row.hash),
  );
});

test("mobile sync and rename accept accented Unicode filenames", async (t) => {
  const f = await fixture(t),
    v = f.volume;
  const source = "re\u0301sume\u0301.txt";
  fs.writeFileSync(path.join(v.path, source), "accented");
  await f.daemon.engine.cycle();
  await f.replica.select(v);
  await sync(f);
  const row = await f.store.current(
    f.replica.scope,
    v.id,
    source.normalize("NFC"),
  );
  assert.ok(row);
  await f.replica.renameFile(v.id, row.path, "vacacio\u0301n.txt", row.rev);
  await sync(f);
  assert.equal(
    fs.readFileSync(path.join(v.path, "vacación.txt"), "utf8"),
    "accented",
  );
});

for (const operation of ["rename", "delete", "import", "pause"]) {
  test(
    `mobile ${operation} interrupts a stalled cycle, keeps its catalog request and records the verdict when it settles`,
    { timeout: 5000 },
    async (t) => {
      const f = await fixture(t);
      fs.writeFileSync(path.join(f.volume.path, "action.txt"), "original");
      await f.daemon.engine.cycle();
      await f.replica.select(f.volume);
      await sync(f);
      const current = await f.store.current(
        f.replica.scope,
        f.volume.id,
        "action.txt",
      );
      let entered, fail;
      const started = new Promise((resolve) => {
        entered = resolve;
      });
      f.stall(() => {
        entered();
        return new Promise((_, reject) => {
          fail = () => reject(new TypeError("Network request failed"));
        });
      });
      const active = f.replica.sync();
      await started;
      if (operation === "rename")
        await f.replica.renameFile(
          f.volume.id,
          "action.txt",
          "renamed.txt",
          current.rev,
        );
      else if (operation === "delete")
        await f.replica.removeFile(f.volume.id, "action.txt");
      else if (operation === "pause") await f.replica.pause(true);
      else
        await f.replica.withImportPicker(() =>
          f.replica.importFile(
            f.volume.id,
            "imported.txt",
            path.join(f.volume.path, "action.txt"),
          ),
        );
      await active;
      const expected =
        operation === "rename"
          ? "renamed.txt"
          : operation === "import"
            ? "imported.txt"
            : "action.txt";
      assert.equal(
        fs.existsSync(f.files.work(f.replica.scope, f.volume.id, expected)),
        operation !== "delete",
      );
      assert.equal(f.replica.busy, false);
      assert.equal(f.replica.error, null);
      assert.equal(f.replica.hubUnavailable, false, "the verdict is still pending");
      fail();
      for (let i = 0; !f.replica.hubUnavailable && i < 100; i++)
        await new Promise((resolve) => setImmediate(resolve));
      assert.equal(f.replica.hubUnavailable, true, "the abandoned request's failure is recorded");
      f.stall(null);
      if (operation === "pause") await f.replica.pause(false);
      await sync(f);
      assert.equal(f.replica.hubUnavailable, false);
    },
  );
}

test("backgrounding cancels the catalog request so resuming starts a fresh one", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  await f.daemon.engine.cycle();
  await f.replica.select(f.client.state().catalog.volumes[0]);
  await sync(f);
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  f.stall((url, options) => {
    entered();
    return new Promise((resolve, reject) =>
      options.signal.addEventListener("abort", () => reject(options.signal.reason)),
    );
  });
  const active = f.replica.sync();
  await started;
  f.replica.suspend();
  await active;
  assert.equal(f.replica.hubUnavailable, false);
  f.stall(null);
  await sync(f);
  assert.equal(f.replica.hubUnavailable, false);
});

test("the first cycle against a silent hub reports it offline at the client deadline, and a hub that answers in time stays online", async (t) => {
  const f = await fixture(t, { timeout: 1000 });
  await f.daemon.engine.cycle();
  await f.replica.select(f.client.state().catalog.volumes[0]);
  await sync(f);
  const reopened = new Replica({ store: f.store, files: f.files, client: f.client });
  await reopened.load();
  assert.equal(reopened.connectionChecked, false);
  f.stall(() => new Promise(() => {}));
  const started = Date.now();
  await reopened.sync();
  assert.ok(Date.now() - started < 3000, "detection follows the client's metadata deadline");
  assert.equal(reopened.connectionChecked, true);
  assert.equal(reopened.hubUnavailable, true);
  f.stall(async (url, options) => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    return fetch(url.replace("https://fixture.invalid", `http://127.0.0.1:${f.daemon.port}`), options);
  });
  await reopened.sync();
  assert.equal(reopened.hubUnavailable, false);
  assert.equal(reopened.error, null);
});

test("History over several folders waits on a silent hub once, not once per folder", { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  await f.daemon.engine.cycle();
  await f.replica.select(f.client.state().catalog.volumes[0]);
  await sync(f);
  f.stall(() => new Promise(() => {}));
  const started = Date.now();
  const page = await scopedActivity(
    (query) => f.replica.remoteView(`/v1/activity?${query}`),
    ["a", "b", "c"],
    new URLSearchParams({ limit: "50" }),
  );
  assert.ok(Date.now() - started < 5000, "three folders share one 3-second deadline");
  assert.equal(page.offline, true);
});

test("mobile cold start reuses verified hashes and preserves last success across interruptions", async (t) => {
  const f = await fixture(t);
  const stat = f.files.stat;
  f.files.stat = async (uri) => {
    const value = await stat(uri);
    return value ? { ...value, mtime: fs.statSync(uri).mtimeMs } : null;
  };
  await f.replica.select(f.client.state().catalog.volumes[0]);
  await sync(f);
  const folder = await f.store.folder(f.replica.scope, f.volume.id);
  const uri = f.files.work(f.replica.scope, f.volume.id, "hello.txt");
  fs.writeFileSync(uri, "cached local bytes");
  await sync(f);
  await sync(f);
  const originalHash = f.files.hash;
  let reads = 0;
  f.files.hash = async (...args) => {
    reads++;
    return originalHash(...args);
  };
  const reopened = new Replica({
    store: f.store,
    files: f.files,
    client: f.client,
  });
  await reopened.load();
  reopened.force = false;
  await reopened.localHash(uri);
  assert.equal(reads, 0, "a new engine reuses the persisted verification");
  fs.writeFileSync(uri, "new bytes with another size");
  await reopened.localHash(uri);
  assert.equal(reads, 1, "modified files are rehashed");
  const completed = (await f.store.folder(f.replica.scope, f.volume.id))
    .completed;
  await f.store.issue(f.replica.scope, f.volume.id, "Request cancelled");
  await reopened.load();
  const recovered = await f.store.folder(f.replica.scope, f.volume.id);
  assert.equal(recovered.issue, null);
  assert.equal(recovered.completed, completed);
  assert.ok(folder.completed);
});

test("mobile transfer turns yield without persisting a synchronization error", async (t) => {
  const f = await fixture(t);
  await f.replica.select(f.client.state().catalog.volumes[0]);
  const push = f.replica.push.bind(f.replica);
  let turns = 0;
  f.replica.push = async (folder) => {
    if (++turns === 1) {
      f.replica.turnTransferred = true;
      f.replica.turnDeadline = Date.now() - 1;
      f.replica.checkTransferTurn();
    }
    return push(folder);
  };
  await sync(f);
  assert.equal(turns, 2);
  assert.equal(
    (await f.store.folder(f.replica.scope, f.volume.id)).issue,
    null,
  );
});

test("forced verification survives a yielded folder with a recent inventory and cached hash", async (t) => {
  const f = await fixture(t);
  const r = f.replica;
  fs.writeFileSync(path.join(f.volume.path, "hello.txt"), "verified bytes");
  await f.daemon.engine.cycle();
  await r.select(f.client.state().catalog.volumes[0]);
  await sync(f);
  const stat = f.files.stat;
  f.files.stat = async (uri) => {
    const value = await stat(uri);
    return value ? { ...value, mtime: fs.statSync(uri).mtimeMs } : null;
  };
  const uri = f.files.work(r.scope, f.volume.id, "hello.txt");
  await r.localHash(uri);
  const previousScan = r.lastFullScan;
  r.lastInventory.set(f.volume.id, Date.now());
  const syncIgnore = r.syncIgnore.bind(r);
  let turns = 0;
  r.syncIgnore = async (folder) => {
    if (++turns === 1) {
      r.turnTransferred = true;
      r.turnDeadline = Date.now() - 1;
      r.checkTransferTurn();
    }
    assert.equal(await f.store.get(`fullScan:${r.scope}`), previousScan);
    return syncIgnore(folder);
  };
  const hash = f.files.hash;
  let rehashed = 0;
  f.files.hash = async (file) => {
    if (file === uri) rehashed++;
    return hash(file);
  };
  const scan = r.scan.bind(r);
  let scans = 0;
  r.scan = async (folder) => {
    scans++;
    return scan(folder);
  };
  await r.sync(true, { scheduled: true });
  assert.equal(r.error, null);
  assert.equal(turns, 2);
  assert.equal(scans, 1);
  assert.ok(rehashed > 0, "continuation must bypass the verified hash cache");
  assert.equal(r.fullScanPending.size, 0);
  assert.equal(await f.store.get(`fullScan:${r.scope}`), r.lastFullScan);
});

test("the phone's own photos that the synchronized .arcaignore excludes stay out of the online gallery", async (t) => {
  const f = await fixture(t);
  const r = f.replica;
  fs.writeFileSync(path.join(f.volume.path, ".arcaignore"), "private/\n*.tmp.jpg\n");
  fs.writeFileSync(path.join(f.volume.path, "hub-photo.jpg"), "from the hub");
  await f.daemon.engine.cycle();
  await r.select(f.client.state().catalog.volumes[0]);
  await sync(f);
  const work = (name) => f.files.work(r.scope, f.volume.id, name);
  assert.equal(fs.existsSync(work(".arcaignore")), true, "the policy file reached the phone");
  const text = await f.files.text(work(".arcaignore"));
  const mtime = Date.now();
  const entries = ["keep.jpg", "private/secret.jpg", "edit.tmp.jpg", "hub-photo.jpg"].map((name) => ({
    path: name,
    uri: `file:///${name}`,
    size: 1,
    mtime,
  }));
  const hub = { timeline: [], total: 0, months: {}, indexing: false };
  const known = new Set(["hub-photo.jpg"]);
  const shown = (state) => Object.values(state.months).flatMap((month) => month.items.map((item) => item.path)).sort();
  assert.deepEqual(shown(withLocalOnly(hub, entries, known, folderIgnored(text))), ["keep.jpg"]);
  assert.deepEqual(shown(withLocalOnly(hub, entries, known, null)), ["edit.tmp.jpg", "keep.jpg", "private/secret.jpg"], "without the policy the phone-only photos would all appear");
});

test("a folder that fails every cycle does not keep scheduled cycles forcing full verification", async (t) => {
  const f = await fixture(t);
  const r = f.replica;
  const healthy = f.volume;
  const broken = f.daemon.engine.store.addVolume("Broken");
  fs.writeFileSync(path.join(healthy.path, "ok.txt"), "healthy bytes");
  await f.daemon.engine.cycle();
  await f.client.refresh();
  for (const volume of f.client.state().catalog.volumes) await r.select(volume);
  await sync(f);
  const scan = r.scan.bind(r);
  const scans = [];
  r.scan = async (folder) => {
    scans.push(folder.id);
    if (folder.id === broken.id) throw new Error("Disk error");
    return scan(folder);
  };
  const before = r.lastFullScan;
  await r.sync(true);
  assert.match((await f.store.folder(r.scope, broken.id)).issue, /Disk error/);
  assert.ok(scans.includes(healthy.id), "Sync now verifies the healthy folder");
  assert.ok(r.lastFullScan > before, "the failing folder does not hold the verification time back");
  assert.equal(await f.store.get(`fullScan:${r.scope}`), r.lastFullScan);
  r.lastFullScan = Date.now() - 2 * 3600000;
  scans.length = 0;
  r.lastInventory.set(healthy.id, Date.now());
  await r.sync(false, { scheduled: true });
  assert.ok(scans.includes(healthy.id), "an hour later a scheduled cycle verifies the healthy folder once");
  assert.ok(Date.now() - r.lastFullScan < 60000, "and the failing folder does not hold that back");
  scans.length = 0;
  r.lastInventory.set(healthy.id, Date.now());
  await r.sync(false, { scheduled: true });
  assert.equal(scans.includes(healthy.id), false, "the next scheduled cycle no longer re-verifies the healthy folder");
});

test("gallery connection loss stops the batch without failing every photo and resumes online", async (t) => {
  const f = await galleryFixture(
    t,
    [1, 2, 3].map((id) => ({
      id: `photo-${id}`,
      filename: `${id}.jpg`,
      creationTime: 1750000000000,
    })),
  );
  await f.enable();
  const r = f.replica;
  const upload = r.upload.bind(r);
  let attempts = 0;
  r.upload = async () => {
    attempts++;
    throw new Error("Network request failed");
  };
  await r.sync();
  assert.equal(attempts, 1);
  assert.equal(r.hubUnavailable, true);
  assert.equal((await f.store.gallerySummary(r.scope, f.volume.id)).failed, 0);
  r.upload = upload;
  await sync(f);
  assert.equal(r.hubUnavailable, false);
  assert.equal(
    (await f.store.gallerySummary(r.scope, f.volume.id)).accepted,
    3,
  );
});

test("native file transfer adapter resumes ranges and never returns payload bytes through JS", async (t) => {
  const f = await fixture(t);
  const data = crypto.randomBytes(CHUNK * 2 + 53);
  fs.writeFileSync(path.join(f.volume.path, "native.bin"), data);
  await f.daemon.engine.cycle();
  await f.client.refresh();
  await f.replica.select(f.client.state().catalog.volumes[0]);
  const raw = f.replica.client.raw;
  let downloads = 0,
    uploads = 0;
  f.replica.client.fileTransfers = true;
  f.replica.client.raw = async (route, options) => {
    const transfer = options?.transfer;
    if (!transfer) return raw(route, options);
    const offset = Number(transfer.offset),
      length = Number(transfer.length);
    if (transfer.source) {
      uploads++;
      return raw(route, {
        ...options,
        body: fs
          .readFileSync(transfer.source)
          .subarray(offset, offset + length),
      });
    }
    downloads++;
    const response = await raw(route, options);
    assert.equal(response.headers.get("content-range"), transfer.range);
    const bytes = new Uint8Array(await response.arrayBuffer());
    assert.equal(bytes.length, length);
    await f.files.write(transfer.destination, bytes, offset);
    return {
      ...response,
      bytesWritten: bytes.length,
      arrayBuffer() {
        throw new Error("Payload crossed JS bridge");
      },
    };
  };
  await sync(f);
  const local = f.files.work(f.replica.scope, f.volume.id, "native.bin");
  assert.deepEqual(fs.readFileSync(local), data);
  const changed = crypto.randomBytes(CHUNK + 29);
  fs.writeFileSync(local, changed);
  await sync(f);
  assert.deepEqual(
    fs.readFileSync(path.join(f.volume.path, "native.bin")),
    changed,
  );
  assert.ok(downloads >= 3 && uploads >= 2);
});

test("mobile cold start preserves Machines and recent History offline without repeated requests", async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.volume.path, "hello.txt"), "offline content");
  await f.daemon.engine.cycle();
  await f.replica.select(f.client.state().catalog.volumes[0]);
  await sync(f);
  const reopened = new Replica({
    store: f.store,
    files: f.files,
    client: f.client,
  });
  await reopened.load();
  f.stall(() => {
    throw new Error(
      "Cannot reach the hub over the local network. Connect this device to the hub’s Wi-Fi or Ethernet network and try again.",
    );
  });
  await reopened.sync();
  assert.equal(reopened.hubUnavailable, true);
  const requests = f.requests.length;
  const machines = await reopened.remoteView("/v1/machines");
  assert.equal(machines.offline, true);
  assert.ok(machines.machines.some((m) => m.isHub));
  const history = await reopened.remoteView(
    `/v1/activity?limit=49&volume=${f.volume.id}&filter=revisions`,
  );
  assert.equal(history.offline, true);
  assert.ok(history.versions.some((r) => r.path === "hello.txt"));
  const file = await reopened.remoteView(
    `/v1/history?volume=${f.volume.id}&path=hello.txt&limit=50`,
  );
  assert.ok(file.versions.every((r) => r.path === "hello.txt"));
  assert.ok(file.versions.length);
  assert.equal(
    f.requests.length,
    requests,
    "offline navigation reads SQLite immediately",
  );
  f.stall(null);
  await reopened.sync();
  assert.equal(reopened.hubUnavailable, false);
  assert.ok(!(await reopened.remoteView("/v1/machines")).offline);
  const api = f.client.api;
  let rejectOld;
  f.client.api = (route, ...args) =>
    route === "/v1/machines"
      ? new Promise((_, reject) => {
          rejectOld = reject;
        })
      : api(route, ...args);
  const oldView = reopened.remoteView("/v1/machines");
  await reopened.sync();
  rejectOld(new Error("Network request failed"));
  assert.equal((await oldView).offline, true);
  assert.equal(
    reopened.hubUnavailable,
    false,
    "an older view failure cannot override a fresh successful sync",
  );
  f.client.api = api;
  await reopened.unselect(f.volume.id);
  assert.equal(
    (
      await f.store.db.getAllAsync(
        "SELECT route FROM view_cache WHERE scope=?",
        reopened.scope,
      )
    ).some(
      (v) =>
        new URLSearchParams(v.route.split("?")[1]).get("volume") ===
        f.volume.id,
    ),
    false,
  );
  t.mock.method(f.client, "api", async () => {
    throw new Error("401 Unauthorized");
  });
  await assert.rejects(reopened.remoteView("/v1/machines"), /401/);
});

test("the import picker opens without waiting for a settling cycle and the copy waits for it", async (t) => {
  const f = await fixture(t);
  await f.replica.select(f.volume);
  await sync(f);
  const work = f.files.work(f.replica.scope, f.volume.id, "local.txt");
  fs.writeFileSync(work, "local");
  const hash = f.files.hash;
  let entered, release;
  const hashing = new Promise((resolve) => {
    entered = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  f.files.hash = async (p) => {
    if (p === work) {
      entered();
      await gate;
    }
    return hash(p);
  };
  const active = f.replica.sync(true);
  await hashing;
  const source = path.join(f.root, "picked.txt");
  fs.writeFileSync(source, "picked");
  await f.replica.withImportPicker(async () => {
    assert.ok(
      f.replica.active,
      "the picker opens while the cycle is still settling",
    );
    assert.equal(await f.replica.sync(), undefined);
    const importing = f.replica.importFile(f.volume.id, "picked.txt", source);
    release();
    await importing;
    assert.equal(f.replica.active, null);
  });
  await active;
  f.files.hash = hash;
  assert.equal(
    fs.readFileSync(
      f.files.work(f.replica.scope, f.volume.id, "picked.txt"),
      "utf8",
    ),
    "picked",
  );
  await sync(f);
  assert.ok(f.daemon.engine.store.current(f.volume.id, "picked.txt"));
});

test("settle waits for the active cycle before local export work", async (t) => {
  const f = await fixture(t);
  await f.replica.select(f.volume);
  await sync(f);
  fs.writeFileSync(
    f.files.work(f.replica.scope, f.volume.id, "local.txt"),
    "local",
  );
  const hash = f.files.hash;
  let entered, release;
  const hashing = new Promise((resolve) => {
    entered = resolve;
  });
  f.files.hash = async (p) => {
    entered();
    await new Promise((resolve) => {
      release = resolve;
    });
    f.files.hash = hash;
    return hash(p);
  };
  const active = f.replica.sync(true);
  await hashing;
  let settled = false;
  const settling = f.replica.settle().then(() => {
    settled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  release();
  await settling;
  assert.equal(f.replica.active, null);
  await active;
});

test("a device rename while the hub is known offline is saved without a request", async (t) => {
  const f = await fixture(t);
  f.replica.hubUnavailable = true;
  const requests = f.requests.length;
  assert.equal(await f.replica.rename("Travel phone"), false);
  assert.equal(f.requests.length, requests);
  assert.equal(await f.store.get("name"), "Travel phone");
  f.replica.hubUnavailable = false;
  await sync(f);
  const report = JSON.parse(
    f.daemon.engine.store.db
      .prepare("SELECT report FROM machine_reports WHERE device=?")
      .get(f.client.state().connection.id).report,
  );
  assert.equal(report.name, "Travel phone");
});

test("stopping an initial snapshot keeps its hub lease for the next sync and releases it once complete", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 3; i++)
    fs.writeFileSync(path.join(f.volume.path, `file-${i}.txt`), `file ${i}`);
  await f.daemon.engine.cycle();
  const sessions = () =>
    f.daemon.engine.store.db
      .prepare("SELECT id FROM snapshot_sessions")
      .all()
      .map((row) => row.id);
  await f.replica.select(f.volume);
  const replace = f.files.replace;
  f.files.replace = async (...args) => {
    f.files.replace = replace;
    assert.equal(sessions().length, 1);
    f.replica.stop();
    return replace(...args);
  };
  await f.replica.sync();
  const saved = await f.store.snapshotCursor(f.replica.scope, f.volume.id);
  assert.deepEqual(sessions(), [saved.session]);
  await sync(f);
  assert.ok((await f.store.folder(f.replica.scope, f.volume.id)).initialized);
  for (let i = 0; i < 200 && sessions().length; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(sessions(), []);
});

test("a busy snapshot capacity is a retryable wait, not a stored folder failure", async (t) => {
  const f = await fixture(t);
  const other = f.daemon.engine.store.addVolume("Other");
  fs.writeFileSync(path.join(other.path, "other.txt"), "other");
  await f.daemon.engine.cycle();
  await f.client.refresh();
  await f.replica.select(f.volume);
  await sync(f);
  await f.replica.select(
    f.client.state().catalog.volumes.find((v) => v.id === other.id),
  );
  const seed = f.daemon.engine.store.db.prepare(
    "INSERT INTO snapshot_sessions(id,owner,volume,expires) VALUES(?,?,?,?)",
  );
  for (let i = 0; i < 8; i++)
    seed.run(
      `seeded-${i}`,
      f.client.state().connection.id,
      `elsewhere-${i}`,
      Date.now() + 600000,
    );
  fs.writeFileSync(
    f.files.work(f.replica.scope, f.volume.id, "edit.txt"),
    "edit",
  );
  await f.replica.sync();
  assert.equal(f.replica.error, null);
  assert.equal(f.replica.hubUnavailable, false);
  assert.equal((await f.store.folder(f.replica.scope, other.id)).issue, null);
  assert.ok(f.daemon.engine.store.current(f.volume.id, "edit.txt"));
  f.daemon.engine.store.db
    .prepare("DELETE FROM snapshot_sessions WHERE id LIKE 'seeded-%'")
    .run();
  await sync(f);
  assert.ok((await f.store.folder(f.replica.scope, other.id)).initialized);
});

test("a file added and renamed offline reaches the hub only under its new name", async (t) => {
  const f = await fixture(t);
  await f.replica.select(f.volume);
  await sync(f);
  f.offline();
  const source = path.join(f.root, "wrong-name.txt");
  fs.writeFileSync(source, "content");
  await f.replica.withImportPicker(() =>
    f.replica.importFile(f.volume.id, "wrong-name.txt", source),
  );
  await f.replica.sync();
  assert.equal(f.replica.hubUnavailable, true);
  await f.replica.renameFile(f.volume.id, "wrong-name.txt", "right-name.txt");
  f.online();
  await sync(f);
  assert.equal(
    f.daemon.engine.store.current(f.volume.id, "right-name.txt").hash,
    crypto.createHash("sha256").update("content").digest("hex"),
  );
  assert.equal(
    f.daemon.engine.store.current(f.volume.id, "wrong-name.txt"),
    undefined,
  );
});

test("a retried upload does not hash the pending file again", async (t) => {
  const f = await fixture(t);
  const stat = f.files.stat;
  f.files.stat = async (p) => {
    const info = await stat(p);
    return info && { ...info, mtime: fs.statSync(p).mtimeMs };
  };
  await f.replica.select(f.volume);
  await sync(f);
  const work = f.files.work(f.replica.scope, f.volume.id, "video.bin");
  fs.writeFileSync(work, crypto.randomBytes(CHUNK + 10));
  const hash = f.files.hash;
  let hashes = 0;
  f.files.hash = async (p) => {
    if (!p.endsWith(".arcaignore")) hashes++;
    return hash(p);
  };
  const base = `http://127.0.0.1:${f.daemon.port}`;
  f.stall((url, options) => {
    if (options.method === "PUT") throw new Error("Network request failed");
    return fetch(url.replace("https://fixture.invalid", base), options);
  });
  await f.replica.sync();
  assert.equal(f.replica.hubUnavailable, true);
  assert.equal((await f.store.pending(f.replica.scope, f.volume.id)).length, 1);
  hashes = 0;
  await f.replica.sync();
  assert.equal(hashes, 0, "retry reuses the verified queued object");
  f.stall(null);
  await sync(f);
  assert.equal(
    f.daemon.engine.store.current(f.volume.id, "video.bin").hash,
    await hash(work),
  );
});

test("a slow optional view serves saved data without marking the hub offline", async (t) => {
  const f = await fixture(t);
  await f.replica.remoteView("/v1/machines");
  const api = f.client.api;
  f.client.api = (route, body, options) =>
    route === "/v1/machines"
      ? new Promise((_, reject) =>
          options.signal.addEventListener("abort", () =>
            reject(options.signal.reason),
          ),
        )
      : api(route, body, options);
  const view = await f.replica.remoteView("/v1/machines");
  f.client.api = api;
  assert.equal(view.offline, true);
  assert.equal(f.replica.hubUnavailable, false);
  assert.ok(!(await f.replica.remoteView("/v1/machines")).offline);
});

test("a Tailscale route failure is an outage with saved views, and a lost chunk keeps the queue without a folder issue", async (t) => {
  const f = await fixture(t);
  await f.replica.select(f.volume);
  await sync(f);
  await f.replica.remoteView("/v1/machines");
  f.stall(() => {
    throw Object.assign(
      new Error(
        "Cannot connect using this address. For local Wi-Fi, enter the hub’s private IP address. To use a Tailscale name or address, connect Tailscale on this device and the hub.",
      ),
      { code: "HUB_UNREACHABLE" },
    );
  });
  await f.replica.sync();
  assert.equal(f.replica.hubUnavailable, true);
  assert.equal((await f.replica.remoteView("/v1/machines")).offline, true);
  const base = `http://127.0.0.1:${f.daemon.port}`;
  let puts = 0;
  f.stall((url, options) => {
    if (options.method === "PUT" && ++puts === 2)
      throw Object.assign(
        new Error(
          "The connection to the hub was interrupted. Check the connection and try again.",
        ),
        { code: "CONNECTION_LOST" },
      );
    return fetch(url.replace("https://fixture.invalid", base), options);
  });
  fs.writeFileSync(
    f.files.work(f.replica.scope, f.volume.id, "large.bin"),
    crypto.randomBytes(CHUNK * 2 + 5),
  );
  await f.replica.sync();
  assert.equal(f.replica.hubUnavailable, true);
  assert.equal(
    (await f.store.folder(f.replica.scope, f.volume.id)).issue,
    null,
  );
  assert.equal((await f.store.pending(f.replica.scope, f.volume.id)).length, 1);
  f.stall(null);
  await sync(f);
  assert.ok(f.daemon.engine.store.current(f.volume.id, "large.bin"));
});

test("a photo export timeout fails that photo only and never marks the hub offline", async (t) => {
  const f = await galleryFixture(
    t,
    [1, 2].map((id) => ({
      id: `photo-${id}`,
      filename: `${id}.jpg`,
      creationTime: 1750000000000,
    })),
  );
  const zeta = f.daemon.engine.store.addVolume("Zeta");
  await f.daemon.engine.cycle();
  await f.client.refresh();
  await f.replica.select(
    f.client.state().catalog.volumes.find((v) => v.id === zeta.id),
  );
  await sync(f);
  await f.enable();
  const exporter = f.media.export;
  f.media.export = async (id, ...args) => {
    if (id === "photo-1")
      throw new Error("Original download timed out. Keep Arca open and retry.");
    return exporter(id, ...args);
  };
  fs.writeFileSync(f.files.work(f.replica.scope, zeta.id, "z.txt"), "zeta");
  await f.replica.sync();
  assert.equal(f.replica.hubUnavailable, false);
  const summary = await f.store.gallerySummary(f.replica.scope, f.volume.id);
  assert.equal(summary.failed, 1);
  assert.equal(summary.accepted, 1);
  assert.ok(f.daemon.engine.store.current(zeta.id, "z.txt"));
});

test("changing the album of an existing gallery source works while the hub is offline", async (t) => {
  const f = await galleryFixture(t);
  await f.enable();
  await sync(f);
  f.offline();
  await f.replica.gallery.configure(
    f.volume.id,
    { albums: [], videos: true },
    true,
  );
  const source = await f.store.gallery(f.replica.scope, f.volume.id);
  assert.deepEqual(source.albums, []);
  assert.equal(source.mode, "source");
});

test("a queued object the hub rejects is verified again before the next attempt", async (t) => {
  const f = await fixture(t);
  await f.replica.select(f.volume);
  await sync(f);
  const work = f.files.work(f.replica.scope, f.volume.id, "doc.bin");
  fs.writeFileSync(work, crypto.randomBytes(2048));
  const base = `http://127.0.0.1:${f.daemon.port}`;
  f.stall((url, options) => {
    if (options.method === "PUT")
      return Response.json(
        { error: "Upload verification failed" },
        { status: 409 },
      );
    return fetch(url.replace("https://fixture.invalid", base), options);
  });
  await f.replica.sync();
  assert.match(f.replica.error, /Upload verification failed/);
  const object = f.files.object(f.replica.scope, await f.files.hash(work));
  assert.equal(f.replica.verified.has(object), false);
  f.stall(null);
  await sync(f);
  assert.ok(f.daemon.engine.store.current(f.volume.id, "doc.bin"));
});

test("shared gallery deletion fails offline without queuing, suppresses rescans and preserves phone originals", async (t) => {
  const f = await galleryFixture(t),
    r = f.replica;
  await f.enable();
  await sync(f);
  const uploaded = await f.uploaded();
  await r.pause(true);
  f.offline();
  await assert.rejects(r.galleryDeletions.delete(f.volume.id, uploaded));
  // A saved request from an older build is inert: no hidden background deletion.
  await r.store.set(`gallery-deletions:${r.scope}:${f.volume.id}:requests`, [
    {
      id: "old_request_000001",
      volume: f.volume.id,
      path: uploaded.path,
      rev: uploaded.rev,
    },
  ]);
  await r.load();
  assert.equal(
    f.daemon.engine.store.current(f.volume.id, uploaded.path).deleted,
    0,
  );
  f.online();
  await r.pause(false);
  await sync(f);
  assert.equal(
    f.daemon.engine.store.current(f.volume.id, uploaded.path).deleted,
    0,
  );
  const removed = await r.galleryDeletions.delete(f.volume.id, uploaded);
  assert.ok(removed.some((row) => row.path === uploaded.path));
  await sync(f);
  assert.equal(
    (await f.store.galleryAsset(r.scope, f.volume.id, "photo-1")).state,
    "removed",
  );
  assert.equal(
    f.daemon.engine.store.current(f.volume.id, uploaded.path).deleted,
    1,
  );
  assert.ok(f.data.has("photo-1"));
  // Lose the local upload ledger: the hub still suppresses the same native asset.
  await f.store.db.runAsync(
    "DELETE FROM gallery_assets WHERE scope=? AND volume=?",
    r.scope,
    f.volume.id,
  );
  await r.sync(true);
  assert.equal(r.error, null);
  assert.equal(
    (await f.store.galleryAsset(r.scope, f.volume.id, "photo-1")).state,
    "removed",
  );
  assert.equal(
    f.daemon.engine.store.current(f.volume.id, uploaded.path).deleted,
    1,
  );
});

test("another replica can delete a source photo without hub administration and without any download", async (t) => {
  const f = await galleryFixture(t),
    r = f.replica;
  await f.enable();
  await sync(f);
  const uploaded = await f.uploaded();
  const token = "another-replica-token";
  f.daemon.engine.store.db
    .prepare(
      "INSERT INTO devices(id,name,token_hash,role) VALUES(?,?,?,'replica')",
    )
    .run(
      "other-device",
      "Other device",
      crypto.createHash("sha256").update(token).digest("hex"),
    );
  const request = async (route) =>
    fetch(`http://127.0.0.1:${f.daemon.port}${route}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: "other_device_delete_0001",
        volume: f.volume.id,
        path: uploaded.path,
        rev: uploaded.rev,
      }),
    });
  assert.equal((await request("/v1/delete-file")).status, 403);
  assert.equal((await request("/v1/gallery/delete")).status, 200);
  await sync(f);
  assert.equal(
    (await f.store.galleryAsset(r.scope, f.volume.id, "photo-1")).state,
    "removed",
  );
  assert.ok(f.data.has("photo-1"));
});

test("direct gallery deletion rejects stale selections and never deletes later content", async (t) => {
  const f = await galleryFixture(t),
    r = f.replica;
  await f.enable();
  await sync(f);
  const uploaded = await f.uploaded();
  fs.writeFileSync(
    path.join(f.volume.path, uploaded.path),
    "a newer desktop edit",
  );
  await f.daemon.engine.cycle();
  await assert.rejects(
    r.galleryDeletions.delete(f.volume.id, uploaded),
    /changed/,
  );
  assert.equal(r.importing, false);
  await sync(f);
  assert.equal(
    fs.readFileSync(path.join(f.volume.path, uploaded.path), "utf8"),
    "a newer desktop edit",
  );
  assert.ok(f.data.has("photo-1"));
});

test("direct gallery deletion reports partial successes and does not retry failed items during sync", async (t) => {
  const f = await galleryFixture(t),
    r = f.replica;
  await f.enable();
  await sync(f);
  const uploaded = await f.uploaded();
  await assert.rejects(
    r.galleryDeletions.delete(f.volume.id, [
      uploaded,
      { path: "missing.jpg", rev: uploaded.rev },
    ]),
    (error) => {
      assert.equal(error.status, 409);
      assert.deepEqual(
        error.deletedRows.map((row) => row.path),
        [uploaded.path],
      );
      return true;
    },
  );
  assert.equal(r.importing, false);
  await sync(f);
  assert.equal(r.error, null);
  assert.ok(f.data.has("photo-1"));
});

test("unverifiable historical gallery registration keeps originals without blocking new uploads", async (t) => {
  const f = await galleryFixture(t),
    r = f.replica;
  await f.enable();
  await sync(f);
  const item = await f.store.galleryAsset(r.scope, f.volume.id, "photo-1");
  item.registered = false;
  await f.store.putGalleryAsset(r.scope, f.volume.id, item);
  f.daemon.engine.store.db.exec(
    "DELETE FROM gallery_members; DELETE FROM gallery_assets;",
  );
  fs.rmSync(path.join(f.volume.path, item.resources[0].path));
  await f.daemon.engine.cycle();
  f.assets.push({
    id: "photo-new",
    filename: "new.jpg",
    creationTime: 1750000002000,
  });
  f.data.set("photo-new", Buffer.from("new original"));
  await r.sync(true);
  assert.equal(r.error, null);
  assert.equal(
    (await f.store.galleryAsset(r.scope, f.volume.id, "photo-new")).state,
    "accepted",
  );
  assert.ok(
    (await f.store.galleryAsset(r.scope, f.volume.id, "photo-1"))
      .registrationIssue,
  );
  assert.ok(f.data.has("photo-1"));
});

test("an incoming change keeps a local edit that the size and mtime cache cannot see", async (t) => {
  const f = await fixture(t),
    r = f.replica;
  fs.writeFileSync(path.join(f.volume.path, "note.txt"), "hub v1");
  await f.daemon.engine.cycle();
  await r.select(f.volume);
  await sync(f);
  r.force = false;
  const stat = f.files.stat;
  f.files.stat = async (file) => {
    const value = await stat(file);
    return value && { ...value, mtime: 1 };
  };
  const target = f.files.work(r.scope, f.volume.id, "note.txt");
  await r.localHash(target);
  fs.writeFileSync(target, "HUB V1");
  fs.writeFileSync(path.join(f.volume.path, "note.txt"), "hub v2 is longer");
  await f.daemon.engine.cycle();
  await r
    .pull(await f.store.folder(r.scope, f.volume.id))
    .catch((error) => assert.match(error.message, /Local changes are waiting/));
  const conflict = fs
    .readdirSync(path.dirname(target))
    .find((name) => name.startsWith("note.txt.conflict-mobile-"));
  assert.ok(conflict, "the hidden local edit is kept as a conflict copy");
  assert.equal(
    fs.readFileSync(path.join(path.dirname(target), conflict), "utf8"),
    "HUB V1",
  );
});

test("a remote deletion keeps a local edit that the size and mtime cache cannot see", async (t) => {
  const f = await fixture(t),
    r = f.replica;
  fs.writeFileSync(path.join(f.volume.path, "note.txt"), "hub v1");
  await f.daemon.engine.cycle();
  await r.select(f.volume);
  await sync(f);
  r.force = false;
  const stat = f.files.stat;
  f.files.stat = async (file) => {
    const value = await stat(file);
    return value && { ...value, mtime: 1 };
  };
  const target = f.files.work(r.scope, f.volume.id, "note.txt");
  await r.localHash(target);
  fs.writeFileSync(target, "HUB V1");
  fs.rmSync(path.join(f.volume.path, "note.txt"));
  await f.daemon.engine.cycle();
  await r
    .pull(await f.store.folder(r.scope, f.volume.id))
    .catch((error) => assert.match(error.message, /Local changes are waiting/));
  const conflict = fs
    .readdirSync(path.dirname(target))
    .find((name) => name.startsWith("note.txt.conflict-mobile-"));
  assert.ok(conflict, "the hidden local edit survives the remote deletion");
  assert.equal(
    fs.readFileSync(path.join(path.dirname(target), conflict), "utf8"),
    "HUB V1",
  );
});

test("an initial snapshot resumes its lease and position after a yielded turn", async (t) => {
  const f = await fixture(t),
    r = f.replica;
  for (const name of ["a.txt", "b.txt"])
    fs.writeFileSync(path.join(f.volume.path, name), `hub ${name}`);
  await f.daemon.engine.cycle();
  await r.select(f.volume);
  await sync(f);
  for (const name of ["c.txt", "d.txt", "e.txt"])
    fs.writeFileSync(path.join(f.volume.path, name), `hub ${name}`);
  await f.daemon.engine.cycle();
  await f.store.resetCursor(r.scope, f.volume.id);
  const calls = [];
  const api = r.client.api.bind(r.client);
  r.client.api = (route, ...rest) => {
    calls.push(route);
    return api(route, ...rest);
  };
  const check = r.checkTransferTurn.bind(r);
  let transfers = 0;
  r.checkTransferTurn = () => {
    if (++transfers === 2)
      throw Object.assign(new Error("Continuing next turn"), { code: "SYNC_YIELD" });
    return check();
  };
  await assert.rejects(
    r.pull(await f.store.folder(r.scope, f.volume.id)),
    (error) => error.code === "SYNC_YIELD",
  );
  const saved = await f.store.snapshotCursor(r.scope, f.volume.id);
  assert.ok(saved?.session);
  const resumedAt = calls.length;
  await r.pull(await f.store.folder(r.scope, f.volume.id));
  const snapshots = calls.slice(resumedAt).filter((route) => route.startsWith("/v1/snapshot?"));
  assert.match(snapshots[0], new RegExp(`session=${saved.session}`));
  assert.equal(calls.filter((route) => /\/v1\/changes\?.*after=0/.test(route)).length, 1);
  for (const name of ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt"])
    assert.equal(fs.readFileSync(f.files.work(r.scope, f.volume.id, name), "utf8"), `hub ${name}`);
  assert.equal(await f.store.snapshotCursor(r.scope, f.volume.id), null);
  await f.store.saveSnapshotCursor(r.scope, f.volume.id, saved);
  await f.store.resetCursor(r.scope, f.volume.id);
  assert.equal(await f.store.snapshotCursor(r.scope, f.volume.id), null);
});

test("a resumed snapshot never rolls back an edit this phone pushed between turns", async (t) => {
  const f = await fixture(t),
    r = f.replica;
  fs.writeFileSync(path.join(f.volume.path, "a.txt"), "hub a");
  await f.daemon.engine.cycle();
  await r.select(f.volume);
  await sync(f);
  for (const name of ["c.txt", "d.txt"])
    fs.writeFileSync(path.join(f.volume.path, name), `hub ${name}`);
  await f.daemon.engine.cycle();
  await f.store.resetCursor(r.scope, f.volume.id);
  const check = r.checkTransferTurn.bind(r);
  let transfers = 0;
  r.checkTransferTurn = () => {
    if (++transfers === 2)
      throw Object.assign(new Error("Continuing next turn"), { code: "SYNC_YIELD" });
    return check();
  };
  await assert.rejects(
    r.pull(await f.store.folder(r.scope, f.volume.id)),
    (error) => error.code === "SYNC_YIELD",
  );
  const target = f.files.work(r.scope, f.volume.id, "a.txt");
  fs.writeFileSync(target, "phone edit");
  const folder = await f.store.folder(r.scope, f.volume.id);
  await r.scan(folder);
  await r.push(folder);
  await r.pull(await f.store.folder(r.scope, f.volume.id));
  assert.equal(fs.readFileSync(target, "utf8"), "phone edit");
  assert.equal(fs.readFileSync(f.files.work(r.scope, f.volume.id, "d.txt"), "utf8"), "hub d.txt");
  await r.pull(await f.store.folder(r.scope, f.volume.id));
  assert.equal(fs.readFileSync(target, "utf8"), "phone edit");
});

test("an interrupted initial snapshot keeps its lease while a failed one drops its saved position", async (t) => {
  const f = await fixture(t),
    r = f.replica;
  await r.select(f.volume);
  await sync(f);
  for (const name of ["c.txt", "d.txt"])
    fs.writeFileSync(path.join(f.volume.path, name), `hub ${name}`);
  await f.daemon.engine.cycle();
  await f.store.resetCursor(r.scope, f.volume.id);
  const released = [];
  const api = r.interactiveClient.api.bind(r.interactiveClient);
  r.interactiveClient.api = (route, body, ...rest) => {
    if (route === "/v1/snapshot-release") released.push(body.session);
    return api(route, body, ...rest);
  };
  const check = r.checkTransferTurn.bind(r);
  let failure = null;
  r.checkTransferTurn = () => {
    const error = failure;
    failure = null;
    if (error) throw error;
    return check();
  };
  failure = Object.assign(new Error("Cannot reach the hub"), { code: "HUB_UNREACHABLE" });
  await assert.rejects(
    r.pull(await f.store.folder(r.scope, f.volume.id)),
    (error) => error.code === "HUB_UNREACHABLE",
  );
  const saved = await f.store.snapshotCursor(r.scope, f.volume.id);
  assert.ok(saved?.session);
  assert.deepEqual(released, []);
  failure = new Error("Disk failure");
  await assert.rejects(r.pull(await f.store.folder(r.scope, f.volume.id)), /Disk failure/);
  assert.equal(await f.store.snapshotCursor(r.scope, f.volume.id), null);
  assert.deepEqual(released, [saved.session]);
});

test("a snapshot whose listing finished drops its saved position before deferred rows apply", async (t) => {
  const f = await fixture(t),
    r = f.replica;
  fs.mkdirSync(path.join(f.volume.path, "a-dir"));
  fs.writeFileSync(path.join(f.volume.path, "a-dir", "x.txt"), "x");
  await f.daemon.engine.cycle();
  await r.select(f.volume);
  await sync(f);
  fs.rmSync(path.join(f.volume.path, "a-dir"), { recursive: true });
  fs.writeFileSync(path.join(f.volume.path, "b.txt"), "hub b.txt");
  await f.daemon.engine.cycle();
  await f.store.resetCursor(r.scope, f.volume.id);
  await f.store.saveSnapshotCursor(r.scope, f.volume.id, { session: "stale", after: "", through: 0 });
  const apply = r.apply.bind(r);
  let yielded = false;
  r.apply = async (row, ...rest) => {
    if (row.path === "a-dir" && !yielded) {
      yielded = true;
      throw Object.assign(new Error("Continuing next turn"), { code: "SYNC_YIELD" });
    }
    return apply(row, ...rest);
  };
  await assert.rejects(
    r.pull(await f.store.folder(r.scope, f.volume.id)),
    (error) => error.code === "SYNC_YIELD",
  );
  assert.equal(await f.store.snapshotCursor(r.scope, f.volume.id), null);
  await r.pull(await f.store.folder(r.scope, f.volume.id));
  assert.equal(fs.existsSync(f.files.work(r.scope, f.volume.id, "a-dir")), false);
});

test("resuming a snapshot twice keeps one copy of each deferred directory deletion", async (t) => {
  const f = await fixture(t),
    r = f.replica;
  fs.mkdirSync(path.join(f.volume.path, "a-dir"));
  fs.writeFileSync(path.join(f.volume.path, "a-dir", "x.txt"), "x");
  await f.daemon.engine.cycle();
  await r.select(f.volume);
  await sync(f);
  fs.rmSync(path.join(f.volume.path, "a-dir"), { recursive: true });
  for (const name of ["b.txt", "c.txt"])
    fs.writeFileSync(path.join(f.volume.path, name), `hub ${name}`);
  await f.daemon.engine.cycle();
  await f.store.resetCursor(r.scope, f.volume.id);
  const check = r.checkTransferTurn.bind(r);
  let transfers = 0;
  r.checkTransferTurn = () => {
    if ([2, 3].includes(++transfers))
      throw Object.assign(new Error("Continuing next turn"), { code: "SYNC_YIELD" });
    return check();
  };
  for (let turn = 0; turn < 2; turn++)
    await assert.rejects(
      r.pull(await f.store.folder(r.scope, f.volume.id)),
      (error) => error.code === "SYNC_YIELD",
    );
  const saved = await f.store.snapshotCursor(r.scope, f.volume.id);
  assert.deepEqual(saved.directoryDeletes.map((row) => row.path), ["a-dir"]);
  await r.pull(await f.store.folder(r.scope, f.volume.id));
  assert.equal(fs.existsSync(f.files.work(r.scope, f.volume.id, "a-dir")), false);
  assert.equal(fs.readFileSync(f.files.work(r.scope, f.volume.id, "c.txt"), "utf8"), "hub c.txt");
});

test("restarting an initial snapshot reuses verified local files and still preserves new edits", async (t) => {
  const f = await fixture(t),
    r = f.replica;
  fs.writeFileSync(
    path.join(f.volume.path, "large.bin"),
    Buffer.alloc(2 * 1024 * 1024, 7),
  );
  await f.daemon.engine.cycle();
  await r.select(f.volume);
  await sync(f);
  r.force = false;
  const stat = f.files.stat;
  f.files.stat = async (file) => {
    const value = await stat(file);
    return value && { ...value, mtime: fs.statSync(file).mtimeMs };
  };
  const target = f.files.work(r.scope, f.volume.id, "large.bin");
  await r.localHash(target);
  const originalHash = f.files.hash;
  let rereads = 0;
  f.files.hash = async (file) => {
    if (file === target) rereads++;
    return originalHash(file);
  };
  await f.store.resetCursor(r.scope, f.volume.id);
  await r.pull(await f.store.folder(r.scope, f.volume.id));
  assert.equal(
    rereads,
    0,
    "replayed snapshot must reuse unchanged local verification",
  );
  fs.writeFileSync(target, "new unsynchronized edit");
  await f.store.resetCursor(r.scope, f.volume.id);
  await assert.rejects(
    r.pull(await f.store.folder(r.scope, f.volume.id)),
    /Local changes are waiting/,
  );
  assert.ok(rereads > 0, "changed local content must be checked");
  const files = fs.readdirSync(path.dirname(target));
  const conflict = files.find((name) =>
    name.startsWith("large.bin.conflict-mobile-"),
  );
  assert.ok(conflict);
  assert.equal(
    fs.readFileSync(path.join(path.dirname(target), conflict), "utf8"),
    "new unsynchronized edit",
  );
});

function syncService(replica, options = {}) {
  const state = { visible: true, starts: 0, stops: 0 };
  replica.transfer = new TransferSession({
    visible: () => state.visible,
    start: async () => { state.starts++; await options.start?.(); },
    stop: async () => { state.stops++; },
    update: async () => {},
  });
  state.background = () => {
    state.visible = false;
    if (shouldStopSync('background', replica.transfer.active || !!replica.transfer.starting)) replica.stop();
  };
  return state;
}

test('ordinary initial downloads retain the Android service across screen-off and continuation turns', async (t) => {
  const f = await fixture(t), r = f.replica;
  const content = crypto.randomBytes(CHUNK * 2 + 11);
  fs.writeFileSync(path.join(f.volume.path, 'remote.bin'), content);
  await f.daemon.engine.cycle();
  await r.select(f.volume);
  const service = syncService(r);
  let writes = 0, yielded = false;
  const write = f.files.write;
  f.files.write = async (...args) => {
    assert.equal(r.transfer.active, true);
    if (++writes === 1) service.background();
    return write(...args);
  };
  const check = r.checkTransferTurn.bind(r);
  r.checkTransferTurn = () => {
    if (writes && !yielded) {
      yielded = true;
      throw Object.assign(new Error('Next turn'), { code: 'SYNC_YIELD' });
    }
    check();
  };
  await sync(f);
  assert.equal(yielded, true);
  assert.equal(service.visible, false);
  assert.equal(service.starts, 1);
  assert.equal(service.stops, 1);
  assert.equal(r.transfer.active, false);
  assert.deepEqual(fs.readFileSync(f.files.work(r.scope, f.volume.id, 'remote.bin')), content);
  assert.ok((await f.store.folder(r.scope, f.volume.id)).completed);
});

test('pausing a screen-off download releases its service and later resumes the verified copy', async (t) => {
  const f = await fixture(t), r = f.replica;
  const content = crypto.randomBytes(CHUNK + 11);
  fs.writeFileSync(path.join(f.volume.path, 'remote.bin'), content);
  await f.daemon.engine.cycle();
  await r.select(f.volume);
  const service = syncService(r);
  const write = f.files.write;
  let interrupted = false;
  f.files.write = async (...args) => {
    await write(...args);
    if (!interrupted) {
      interrupted = true;
      service.background();
      await r.pause(true);
    }
  };
  await r.sync();
  assert.equal(r.paused, true);
  assert.equal(service.stops, 1);
  assert.equal(r.transfer.active, false);
  service.visible = true;
  await r.pause(false);
  await sync(f);
  assert.equal(service.starts, 2);
  assert.equal(service.stops, 2);
  assert.deepEqual(fs.readFileSync(f.files.work(r.scope, f.volume.id, 'remote.bin')), content);
});

test('service refusal is reported before transfers and a foreground retry can recover', async (t) => {
  const f = await fixture(t), r = f.replica;
  await r.select(f.volume);
  let refuse = true;
  const service = syncService(r, { start: async () => { if (refuse) throw new Error('Background service unavailable'); } });
  await r.sync();
  assert.match(r.error, /Background service unavailable/);
  assert.equal(r.transfer.active, false);
  assert.equal(service.stops, 0);
  refuse = false;
  await sync(f);
  assert.equal(service.starts, 2);
  assert.equal(service.stops, 1);
  f.offline();
  await r.sync();
  assert.ok(r.error);
  assert.equal(service.stops, 2);
  assert.equal(r.transfer.active, false);
});

test('paused and OS-background synchronization do not start a foreground service', async (t) => {
  const f = await fixture(t), r = f.replica;
  await r.select(f.volume);
  const service = syncService(r);
  await r.pause(true);
  await r.sync();
  assert.equal(service.starts, 0);
  await r.pause(false);
  service.visible = false;
  await sync(f);
  assert.equal(service.starts, 0);
  assert.equal(service.stops, 0);
});

test('ordinary uploads keep the transfer service when the screen turns off', async (t) => {
  const f = await fixture(t), r = f.replica;
  await r.select(f.volume);
  const content = crypto.randomBytes(CHUNK + 3);
  const target = f.files.work(r.scope, f.volume.id, 'document.bin');
  fs.writeFileSync(target, content);
  const service = syncService(r);
  const read = f.files.read;
  let reads = 0;
  f.files.read = async (...args) => {
    assert.equal(r.transfer.active, true);
    if (++reads === 1) service.background();
    return read(...args);
  };
  await sync(f);
  assert.ok(reads > 0);
  assert.equal(service.starts, 1);
  assert.equal(service.stops, 1);
  assert.deepEqual(fs.readFileSync(path.join(f.volume.path, 'document.bin')), content);
});

test("photo export storage failures remain local to uploads across cold starts and do not block shared downloads", async (t) => {
  const f = await galleryFixture(t), { replica: r, store, volume } = f;
  await f.enable();
  f.assets.push({ id: "photo-2", filename: "second.jpg", creationTime: 1750000000000 });
  let attempts = 0;
  f.media.export = async () => {
    attempts++;
    throw new Error("Call to function 'ArcaNetwork.exportGalleryAsset' has been rejected: Not enough storage for temporary photo transfer");
  };
  await r.sync();
  assert.equal(attempts, 1);
  assert.equal(r.moreGalleryWork, false);
  assert.equal(r.error, null);
  const issue = (await store.gallery(r.scope, volume.id)).issue;
  assert.match(issue, /Not enough storage/);
  await store.issue(r.scope, volume.id, issue);
  await r.load();
  fs.writeFileSync(path.join(volume.path, "another-device.txt"), "shared data");
  await f.daemon.engine.cycle();
  await sync(f);
  assert.equal(r.error, null);
  assert.equal((await store.folder(r.scope, volume.id)).issue, null);
  const latestIssue = (await store.gallery(r.scope, volume.id)).issue;
  assert.match(latestIssue, /Not enough storage/);
  const stale = await store.gallery(r.scope, volume.id);
  await store.setGallery(r.scope, volume.id, {
    ...stale,
    issue: "The selected album is unavailable. Choose an accessible album in Photo uploads.",
  });
  await r.load();
  await r.sync();
  const current = (await store.gallery(r.scope, volume.id)).issue;
  assert.match(current, /Not enough storage/);
  assert.doesNotMatch(current, /album is unavailable/);
  assert.equal(fs.readFileSync(f.files.work(r.scope, volume.id, "another-device.txt"), "utf8"), "shared data");
});

test("mobile pulls a large folder without reloading its full index for each file", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 96; i++)
    fs.writeFileSync(path.join(f.volume.path, `photo-${i}.jpg`), `photo ${i}`);
  await f.daemon.engine.cycle();
  await f.client.refresh();
  await f.replica.select(f.client.state().catalog.volumes[0]);
  await sync(f);
  const rows = f.store.rows.bind(f.store);
  let reads = 0, repeatedWrites = 0;
  const journal = f.store.journal.bind(f.store);
  f.store.journal = async (...args) => {
    if (!args[1].directory && !args[1].deleted) repeatedWrites++;
    return journal(...args);
  };
  f.store.rows = async (...args) => { reads++; return rows(...args); };
  await f.store.resetCursor(f.replica.scope, f.volume.id);
  await f.replica.pull(await f.store.folder(f.replica.scope, f.volume.id));
  assert.equal(reads, 1, "read the local alias index once per pull, not once per file");
  assert.equal(repeatedWrites, 0, "unchanged verified rows need no new write journal");
  for (let i = 0; i < 96; i++)
    assert.equal(fs.readFileSync(f.files.work(f.replica.scope, f.volume.id, `photo-${i}.jpg`), "utf8"), `photo ${i}`);
  assert.equal((await f.store.folder(f.replica.scope, f.volume.id)).initialized, 1);
});

test("mobile keeps each synchronized file once and objects only while a transfer needs them", async (t) => {
  const f = await fixture(t);
  const { replica, volume, files, store, daemon } = f;
  const objects = () =>
    fs.existsSync(files.parent(files.object(replica.scope, "0".repeat(64))))
      ? fs.readdirSync(files.parent(files.object(replica.scope, "0".repeat(64))))
      : [];
  fs.writeFileSync(path.join(volume.path, "photo.jpg"), crypto.randomBytes(4096));
  fs.writeFileSync(path.join(volume.path, "same.jpg"), fs.readFileSync(path.join(volume.path, "photo.jpg")));
  await daemon.engine.cycle();
  await f.client.refresh();
  await replica.select(f.client.state().catalog.volumes[0]);
  await sync(f);
  assert.equal(
    await files.hash(files.work(replica.scope, volume.id, "photo.jpg")),
    await files.hash(path.join(volume.path, "photo.jpg")),
  );
  assert.ok(fs.existsSync(files.work(replica.scope, volume.id, "same.jpg")));
  assert.deepEqual(objects(), [], "downloaded files are not kept a second time as objects");
  const leftover = crypto.randomBytes(1024);
  const stale = crypto.createHash("sha256").update(leftover).digest("hex");
  fs.writeFileSync(files.object(replica.scope, stale), leftover);
  fs.writeFileSync(files.work(replica.scope, volume.id, "local.bin"), crypto.randomBytes(2048));
  const hold = f.stall;
  let captured = null;
  hold((url, options) => {
    if (options.method === "PUT") {
      captured = objects();
      throw new TypeError("Network request failed");
    }
    return fetch(url.replace("https://fixture.invalid", `http://127.0.0.1:${daemon.port}`), options);
  });
  await replica.sync();
  const pendingHash = (await store.pending(replica.scope, volume.id)).find((op) => op.path === "local.bin")?.hash;
  assert.ok(pendingHash, "the local edit waits for the hub");
  assert.ok(captured.includes(pendingHash), "an upload in flight keeps its captured object");
  hold(null);
  await sync(f);
  assert.ok(daemon.engine.store.current(volume.id, "local.bin"));
  assert.deepEqual(objects(), [], "accepted uploads and unreferenced leftovers are collected");
});

test("a folder that fails still lets the cycle free objects no transfer needs", async (t) => {
  const f = await fixture(t);
  const { replica, volume, files, daemon } = f;
  fs.writeFileSync(path.join(volume.path, "a.txt"), "a");
  await daemon.engine.cycle();
  await f.client.refresh();
  await replica.select(f.client.state().catalog.volumes[0]);
  await sync(f);
  const leftover = files.object(replica.scope, "b".repeat(64));
  fs.writeFileSync(leftover, "stale duplicate");
  const walk = files.walk;
  files.walk = async function* (root, ...rest) {
    if (root.startsWith(files.folder(replica.scope, volume.id))) throw new Error("disk error");
    yield* walk.call(this, root, ...rest);
  };
  try {
    await replica.sync(true);
  } finally {
    files.walk = walk;
  }
  assert.match(replica.error || "", /disk error/);
  assert.equal(fs.existsSync(leftover), false);
});

test("the phone index tells synced files from ones imported and not yet synced", async (t) => {
  const f = await fixture(t);
  const { replica, volume, daemon } = f;
  fs.writeFileSync(path.join(volume.path, "synced.jpg"), "synced photo");
  await daemon.engine.cycle();
  await f.client.refresh();
  await replica.select(f.client.state().catalog.volumes[0]);
  await sync(f);
  let known = await f.store.knownFiles(replica.scope, volume.id);
  assert.ok(known.has("synced.jpg"));
  assert.ok(Number.isSafeInteger(known.get("synced.jpg").rev), "the phone index carries the revision");
  assert.match(known.get("synced.jpg").hash, /^[0-9a-f]{64}$/, "and the hash");
  assert.equal(known.get("synced.jpg").size, "synced photo".length, "and the accepted size");
  const source = path.join(f.root, "imported.jpg");
  fs.writeFileSync(source, "imported photo");
  await replica.importFile(volume.id, "imported.jpg", source);
  known = await f.store.knownFiles(replica.scope, volume.id);
  assert.equal(known.has("imported.jpg"), false, "an imported file has no row until it is pushed");
  await sync(f);
  known = await f.store.knownFiles(replica.scope, volume.id);
  assert.ok(known.has("imported.jpg"), "after the push it is a known file");
});

test("applying a downloaded file moves the verified object instead of keeping two copies", async (t) => {
  const f = await fixture(t);
  const { replica, volume, daemon, files } = f;
  fs.writeFileSync(path.join(volume.path, "unique.bin"), "only one row needs these bytes");
  await daemon.engine.cycle();
  await f.client.refresh();
  await replica.select(f.client.state().catalog.volumes[0]);
  const copies = [];
  const copy = files.copy;
  files.copy = async (from, to) => {
    copies.push(from);
    return copy.call(files, from, to);
  };
  let objectAtReplace = null;
  const replace = files.replace;
  files.replace = async (from, to) => {
    if (to.endsWith("unique.bin")) {
      const hash = crypto.createHash("sha256").update("only one row needs these bytes").digest("hex");
      objectAtReplace = fs.existsSync(files.object(replica.scope, hash));
    }
    return replace.call(files, from, to);
  };
  await sync(f);
  files.copy = copy;
  files.replace = replace;
  assert.equal(fs.readFileSync(files.work(replica.scope, volume.id, "unique.bin"), "utf8"), "only one row needs these bytes");
  assert.equal(objectAtReplace, false, "the object was moved into place, so one copy exists while applying");
  assert.deepEqual(copies.filter((from) => from.includes(`${path.sep}objects${path.sep}`)), []);
});

test("a file edited after it was placed is not used as the source for a later identical row", async (t) => {
  const f = await fixture(t);
  const { replica, volume, daemon, files } = f;
  const same = "bytes shared by two files";
  const hash = crypto.createHash("sha256").update(same).digest("hex");
  fs.writeFileSync(path.join(volume.path, "a-first.txt"), same);
  fs.writeFileSync(path.join(volume.path, "z-later.txt"), same);
  for (let i = 0; i < 260; i++)
    fs.writeFileSync(path.join(volume.path, `m-${String(i).padStart(3, "0")}.txt`), `filler ${i}`);
  await daemon.engine.cycle();
  await f.client.refresh();
  await replica.select(f.client.state().catalog.volumes[0]);
  const api = f.client.api;
  f.client.api = async (route, ...args) => {
    if (route.startsWith("/v1/snapshot") && route.includes("after="))
      fs.writeFileSync(files.work(replica.scope, volume.id, "a-first.txt"), "edited on the phone");
    return api.call(f.client, route, ...args);
  };
  await sync(f);
  f.client.api = api;
  assert.equal(fs.readFileSync(files.work(replica.scope, volume.id, "z-later.txt"), "utf8"), same);
  assert.equal(f.requests.filter((route) => route === `/v1/blobs/${hash}`).length, 2, "the edited copy is never taken for the shared bytes");
});

test("moving a verified object survives a leftover temporary file and a crash before it is replaced", async (t) => {
  const f = await fixture(t);
  const { replica, volume, daemon, files } = f;
  const text = "bytes that must reach the folder";
  const hash = crypto.createHash("sha256").update(text).digest("hex");
  fs.writeFileSync(path.join(volume.path, "survivor.bin"), text);
  await daemon.engine.cycle();
  await f.client.refresh();
  await replica.select(f.client.state().catalog.volumes[0]);
  const move = files.move;
  files.move = async (from, to) => {
    if (fs.existsSync(to)) throw new Error("DestinationAlreadyExists");
    return move.call(files, from, to);
  };
  const folder = files.folder(replica.scope, volume.id);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, `.arca-transfer-${hash}`), "stale half file");
  const replace = files.replace;
  let crashes = 1;
  files.replace = async (from, to) => {
    if (to.endsWith("survivor.bin") && crashes-- > 0) throw new Error("killed before replace");
    return replace.call(files, from, to);
  };
  await replica.sync();
  assert.match(replica.error || "", /killed before replace/);
  await sync(f);
  files.move = move;
  files.replace = replace;
  assert.equal(fs.readFileSync(files.work(replica.scope, volume.id, "survivor.bin"), "utf8"), text);
});

test("a change queued while applying keeps its object out of the move", async (t) => {
  const f = await fixture(t);
  const { replica, volume, daemon, files } = f;
  fs.writeFileSync(path.join(volume.path, "seed.txt"), "seed");
  await daemon.engine.cycle();
  await f.client.refresh();
  await replica.select(f.client.state().catalog.volumes[0]);
  await sync(f);
  const local = path.join(f.root, "edited.txt");
  fs.writeFileSync(local, "queued bytes");
  const hash = crypto.createHash("sha256").update("queued bytes").digest("hex");
  replica.pulling = { retained: new Set(), placed: new Map() };
  await replica.snapshotLocal(volume.id, "edited.txt", local, 0);
  assert.ok(replica.pulling.retained.has(hash), "a hash queued during the pull is never moved away");
  replica.pulling = null;
});

test("changes-feed rows are moved into place too", async (t) => {
  const f = await fixture(t);
  const { replica, volume, daemon, files } = f;
  fs.writeFileSync(path.join(volume.path, "first.txt"), "first");
  await daemon.engine.cycle();
  await f.client.refresh();
  await replica.select(f.client.state().catalog.volumes[0]);
  await sync(f);
  const text = "arrives through the changes feed";
  const hash = crypto.createHash("sha256").update(text).digest("hex");
  fs.writeFileSync(path.join(volume.path, "later.bin"), text);
  await daemon.engine.cycle();
  let objectAtReplace = null;
  const replace = files.replace;
  files.replace = async (from, to) => {
    if (to.endsWith("later.bin")) objectAtReplace = fs.existsSync(files.object(replica.scope, hash));
    return replace.call(files, from, to);
  };
  await sync(f);
  files.replace = replace;
  assert.equal(fs.readFileSync(files.work(replica.scope, volume.id, "later.bin"), "utf8"), text);
  assert.equal(objectAtReplace, false);
});

for (const [name, names] of [
  ["in one snapshot page", ["a-first.txt", "a-second.txt"]],
  ["across snapshot pages after the first copy moved into place", ["a-first.txt", "z-later.txt"]],
]) {
  test(`identical files materialize from one download ${name}`, async (t) => {
    const f = await fixture(t);
    const { replica, volume, daemon, files } = f;
    const same = "identical bytes in two folders";
    const hash = crypto.createHash("sha256").update(same).digest("hex");
    for (const file of names) fs.writeFileSync(path.join(volume.path, file), same);
    for (let i = 0; i < 260; i++)
      fs.writeFileSync(path.join(volume.path, `m-${String(i).padStart(3, "0")}.txt`), `filler ${i}`);
    await daemon.engine.cycle();
    await f.client.refresh();
    await replica.select(f.client.state().catalog.volumes[0]);
    await sync(f);
    for (const file of names)
      assert.equal(fs.readFileSync(files.work(replica.scope, volume.id, file), "utf8"), same, file);
    assert.equal(f.requests.filter((route) => route === `/v1/blobs/${hash}`).length, 1, "the shared bytes came from the hub once");
  });
}

test("offline file detail puts the phone's own row first when the saved history lacks it or is older", async (t) => {
  const f = await fixture(t);
  const { replica, volume, daemon } = f;
  fs.writeFileSync(path.join(volume.path, "newer.txt"), "one");
  await daemon.engine.cycle();
  await f.client.refresh();
  await replica.select(f.client.state().catalog.volumes[0]);
  await sync(f);
  const first = (await f.store.current(replica.scope, volume.id, "newer.txt")).rev;
  fs.writeFileSync(path.join(volume.path, "newer.txt"), "two");
  fs.writeFileSync(path.join(volume.path, "outside.txt"), "new file");
  await daemon.engine.cycle();
  await sync(f);
  f.offline();
  const entry = (name) => ({ path: name, size: 3, mtime: Date.UTC(2026, 8, 30, 10) });
  const history = (name) =>
    replica.remoteView(`/v1/history?volume=${volume.id}&path=${name}&limit=50`);
  const outside = await history("outside.txt");
  assert.equal(outside.offline, true);
  assert.deepEqual(outside.versions, [], "the saved window never saw this file");
  const outsideRow = await f.store.current(replica.scope, volume.id, "outside.txt");
  const led = offlineFileHistory(outside, outsideRow, entry("outside.txt"));
  assert.equal(led.versions[0].local, true);
  assert.equal(led.versions[0].rev, outsideRow.rev);
  assert.equal(led.currentRev, outsideRow.rev, "the local revision is the current one");
  const older = await history("newer.txt");
  assert.equal(older.versions[0].rev, first, "the saved window stops at the first revision");
  const newerRow = await f.store.current(replica.scope, volume.id, "newer.txt");
  assert.ok(newerRow.rev > first, "the phone applied the second revision");
  const newer = offlineFileHistory(older, newerRow, entry("newer.txt"));
  assert.deepEqual(newer.versions.map((row) => row.rev), [newerRow.rev, first], "a newer local revision leads the saved window");
  assert.equal(newer.versions[0].local, true);
  assert.equal(newer.currentRev, newerRow.rev);
});

test("mobile relists a folder when a directory appears or disappears or a name changes only in case", async (t) => {
  const f = await fixture(t);
  const { replica, volume, daemon } = f;
  fs.writeFileSync(path.join(volume.path, "one.txt"), "1");
  await daemon.engine.cycle();
  await f.client.refresh();
  await replica.select(f.client.state().catalog.volumes[0]);
  await sync(f);
  let seen = replica.folderChanges.get(volume.id);
  fs.mkdirSync(path.join(volume.path, "album"));
  await daemon.engine.cycle();
  await sync(f);
  assert.ok(replica.folderChanges.get(volume.id) > seen, "a new directory relists");
  seen = replica.folderChanges.get(volume.id);
  fs.rmdirSync(path.join(volume.path, "album"));
  await daemon.engine.cycle();
  await sync(f);
  assert.ok(replica.folderChanges.get(volume.id) > seen, "a removed directory relists");
  seen = replica.folderChanges.get(volume.id);
  fs.renameSync(path.join(volume.path, "one.txt"), path.join(volume.path, "tmp-one.txt"));
  fs.renameSync(path.join(volume.path, "tmp-one.txt"), path.join(volume.path, "ONE.txt"));
  await daemon.engine.cycle();
  await sync(f);
  assert.ok(replica.folderChanges.get(volume.id) > seen, "a case-only rename relists");
  assert.ok(fs.readdirSync(replica.files.folder(replica.scope, volume.id)).includes("ONE.txt"));
});

test("mobile counts a folder's applied changes so views relist only when its files changed", async (t) => {
  const f = await fixture(t);
  const { replica, volume, daemon } = f;
  fs.writeFileSync(path.join(volume.path, "one.txt"), "1");
  await daemon.engine.cycle();
  await f.client.refresh();
  await replica.select(f.client.state().catalog.volumes[0]);
  await sync(f);
  const first = replica.folderChanges.get(volume.id);
  assert.ok(first > 0);
  await sync(f);
  assert.equal(replica.folderChanges.get(volume.id), first, "an idle cycle changes nothing");
  fs.renameSync(path.join(volume.path, "one.txt"), path.join(volume.path, "two.txt"));
  await daemon.engine.cycle();
  await sync(f);
  assert.ok(replica.folderChanges.get(volume.id) > first, "a remote rename relists");
});

const twoPhotos = [
  { id: "photo-1", filename: "IMG_1234.HEIC", creationTime: 1750000000000, modificationTime: 1 },
  { id: "photo-2", filename: "IMG_5678.HEIC", creationTime: 1750000001000, modificationTime: 1 },
];
const listed = (dir) =>
  fs.existsSync(dir)
    ? fs.readdirSync(dir, { recursive: true }).map((name) => String(name))
    : [];

test("a photo deleted from the library before it uploads leaves the pending counts, is never retried and touches no hub copy", async (t) => {
  const f = await galleryFixture(t, twoPhotos.map((a) => ({ ...a })));
  const { replica: r, store, volume } = f;
  f.media.exists = async (id) => f.data.has(id);
  const routes = [];
  const api = f.client.api.bind(f.client);
  f.client.api = (route, body, options) => {
    routes.push(route);
    return api(route, body, options);
  };
  f.data.delete("photo-1");
  await f.enable();
  await r.sync();
  const gone = await store.galleryAsset(r.scope, volume.id, "photo-1");
  assert.equal(gone.state, "unavailable");
  assert.equal(gone.issue, null);
  const summary = await store.gallerySummary(r.scope, volume.id);
  assert.equal(summary.pending, 0);
  assert.equal(summary.failed, 0);
  assert.equal(summary.accepted, 1, "the other photo still uploads in the same run");
  assert.equal((await store.gallery(r.scope, volume.id)).issue, null, "no failure is left on the album");
  assert.equal((await store.galleryPreview(r.scope, volume.id, false)).length, 0, "the Pending uploads row is empty");
  assert.equal(listed(volume.path).some((name) => name.includes("IMG_1234")), false, "nothing of it reached the hub");
  assert.equal(listed(volume.path).some((name) => name.includes("IMG_5678")), true);
  const attempts = f.exports.filter((id) => id === "photo-1").length;
  f.assets.splice(0, 1);
  await r.sync(true);
  await r.sync(true);
  assert.equal(f.exports.filter((id) => id === "photo-1").length, attempts, "it is not exported again");
  assert.equal((await store.galleryAsset(r.scope, volume.id, "photo-1")).state, "unavailable", "the row stays");
  assert.equal(routes.some((route) => /gallery\/(delete|remove)/.test(route)), false, "a library deletion is never published");
  assert.equal(r.error, null);
});

test("an unavailable photo that comes back with the same id uploads again", async (t) => {
  const f = await galleryFixture(t, twoPhotos.map((a) => ({ ...a })));
  const { replica: r, store, volume } = f;
  f.media.exists = async (id) => f.data.has(id);
  f.data.delete("photo-1");
  await f.enable();
  await r.sync();
  assert.equal((await store.galleryAsset(r.scope, volume.id, "photo-1")).state, "unavailable");
  f.data.set("photo-1", Buffer.from("original photo-1"));
  await r.sync(true);
  const back = await store.galleryAsset(r.scope, volume.id, "photo-1");
  assert.equal(back.state, "accepted");
  assert.equal((await store.gallerySummary(r.scope, volume.id)).accepted, 2);
  assert.equal(listed(volume.path).some((name) => name.includes("IMG_1234")), true);
});

test("limited photo access or a failed lookup never turns a missing export into a terminal state", async (t) => {
  const f = await galleryFixture(t, twoPhotos.map((a) => ({ ...a })));
  const { replica: r, store, volume } = f;
  f.data.delete("photo-1");
  f.media.exists = async () => false;
  f.media.permission = async () => ({ granted: true, accessPrivileges: "limited" });
  await f.enable();
  await r.sync();
  let row = await store.galleryAsset(r.scope, volume.id, "photo-1");
  assert.equal(row.state, "failed", "limited access cannot tell a deleted photo from a hidden one");
  assert.equal((await store.gallerySummary(r.scope, volume.id)).failed, 1);
  f.media.permission = async () => ({ granted: false, accessPrivileges: "limited" });
  await r.sync(true);
  assert.equal((await store.galleryAsset(r.scope, volume.id, "photo-1")).state, "failed", "also when the system reports limited as not granted");
  f.media.permission = async () => ({ granted: true, accessPrivileges: "all" });
  f.media.exists = async () => {
    throw new Error("Library unavailable");
  };
  await r.sync(true);
  row = await store.galleryAsset(r.scope, volume.id, "photo-1");
  assert.equal(row.state, "failed", "a lookup that cannot answer keeps the retry");
  assert.equal(r.error, null, "and the failed lookup does not fail the cycle");
  f.media.exists = async (id) => f.data.has(id);
  await r.sync(true);
  assert.equal((await store.galleryAsset(r.scope, volume.id, "photo-1")).state, "unavailable", "a confirmed deletion with full access is terminal");
  assert.equal((await store.gallerySummary(r.scope, volume.id)).failed, 0);
});

test("an accepted photo that was edited and then deleted goes back to accepted with its uploaded resources", async (t) => {
  const f = await galleryFixture(t, twoPhotos.map((a) => ({ ...a })));
  const { replica: r, store, volume } = f;
  f.media.exists = async (id) => f.data.has(id);
  await f.enable();
  await r.sync();
  const before = await store.galleryAsset(r.scope, volume.id, "photo-1");
  assert.equal(before.state, "accepted");
  const uploads = f.exports.filter((id) => id === "photo-1").length;
  f.assets[0].modificationTime = 2;
  f.data.delete("photo-1");
  await r.sync(true);
  const after = await store.galleryAsset(r.scope, volume.id, "photo-1");
  assert.equal(after.state, "accepted");
  assert.deepEqual(after.resources, before.resources, "the hub keeps the revision it accepted");
  assert.equal(after.previousResources, undefined);
  assert.equal(after.issue, null);
  const summary = await store.gallerySummary(r.scope, volume.id);
  assert.equal(summary.pending, 0);
  assert.equal(summary.failed, 0);
  f.assets.splice(0, 1);
  await r.sync(true);
  assert.equal((await store.galleryAsset(r.scope, volume.id, "photo-1")).state, "accepted");
  assert.equal(f.exports.filter((id) => id === "photo-1").length, uploads + 1, "only the attempted re-export of the edit");
});

test("a pick that fails stays failed, an unavailable id picked again leaves the terminal state, and a retry never revives unavailable rows", async (t) => {
  const f = await galleryFixture(t, twoPhotos.map((a) => ({ ...a })));
  const { replica: r, store, volume } = f;
  f.media.exists = async () => false;
  await f.enable();
  const uri = path.join(f.root, "vanishing.jpg");
  fs.writeFileSync(uri, "soon gone");
  f.offline();
  await assert.rejects(r.gallery.addPhotos(volume.id, [{ uri, fileName: "vanishing.jpg" }]));
  const durable = f.files.picked(r.scope, volume.id, (await store.galleryPreview(r.scope, volume.id, false, 24)).find((item) => item.picked).id);
  fs.rmSync(uri);
  fs.rmSync(durable);
  f.online();
  f.data.delete("photo-1");
  await r.sync(true);
  const failed = (await store.galleryPreview(r.scope, volume.id, false, 24)).filter((item) => item.picked);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].state, "failed", "a picked file that is gone is not a library deletion");
  assert.equal((await store.galleryAsset(r.scope, volume.id, "photo-1")).state, "unavailable");
  await store.db.runAsync("UPDATE gallery_assets SET retryAt=999 WHERE asset=?", "photo-1");
  await store.retryGallery(r.scope, volume.id);
  const kept = await store.db.getFirstAsync("SELECT retryAt FROM gallery_assets WHERE asset=?", "photo-1");
  assert.equal(kept.retryAt, 999, "a retry does not revive an unavailable row");
  f.data.set("photo-1", Buffer.from("original photo-1"));
  f.offline();
  await assert.rejects(r.gallery.addPhotos(volume.id, [{ assetId: "photo-1", fileName: "IMG_1234.HEIC" }]));
  assert.equal((await store.galleryAsset(r.scope, volume.id, "photo-1")).state, "pending", "picking it again queues it");
  f.online();
  await r.sync(true);
  assert.equal((await store.galleryAsset(r.scope, volume.id, "photo-1")).state, "accepted");
});

test("an edit that reappears after the photo was gone uploads again, and a partly uploaded edit keeps its accepted resources", async (t) => {
  const f = await galleryFixture(t, twoPhotos.map((a) => ({ ...a })));
  const { replica: r, store, volume } = f;
  f.media.exists = async (id) => f.data.has(id);
  await f.enable();
  await r.sync();
  f.assets[0].modificationTime = 2;
  f.data.delete("photo-1");
  await r.sync(true);
  assert.equal((await store.galleryAsset(r.scope, volume.id, "photo-1")).state, "accepted");
  f.data.set("photo-1", Buffer.from("edited photo-1"));
  await r.sync(true);
  const edited = await store.galleryAsset(r.scope, volume.id, "photo-1");
  assert.equal(edited.state, "accepted");
  assert.equal(edited.modificationTime, 2, "the edit that came back was uploaded");
  const item = {
    id: "x",
    state: "pending",
    previousResources: [
      { key: "a", hash: "old-a", accepted: true },
      { key: "b", hash: "old-b", accepted: true },
    ],
    resources: [
      { key: "a", hash: "new-a", accepted: true },
      { key: "b", hash: "new-b", accepted: false },
    ],
  };
  await r.gallery.release(f.volume, item);
  assert.deepEqual(item.resources.map((resource) => resource.hash), ["new-a", "old-b"], "what the hub accepted wins, the rest keeps the old revision");
  assert.equal(item.state, "accepted");
});


test("manual library picks deleted before upload leave pending even with automatic uploads off", async (t) => {
  const f = await galleryFixture(t, twoPhotos.map((a) => ({ ...a })));
  const { replica: r, store, volume } = f;
  await f.enable();
  await r.gallery.setEnabled(volume.id, false);
  f.offline();
  await assert.rejects(r.gallery.addPhotos(volume.id, [{ assetId: "photo-1", fileName: "IMG_1234.HEIC" }]));
  f.data.delete("photo-1");
  f.media.exists = async (id) => f.data.has(id);
  f.media.permission = async () => ({ granted: true, accessPrivileges: "all" });
  f.online();
  await sync(f);
  assert.equal((await store.galleryAsset(r.scope, volume.id, "photo-1")).state, "unavailable");
  assert.equal((await store.gallerySummary(r.scope, volume.id)).failed, 0);
  assert.equal(f.daemon.engine.store.rows(volume.id).some((row) => row.deleted && row.path.includes("IMG_1234")), false);
});


for (const access of ["limited", "denied", "unavailable"]) {
  test(`manual missing library picks remain retryable when permission is ${access}`, async (t) => {
    const f = await galleryFixture(t, twoPhotos.map((a) => ({ ...a })));
    const { replica: r, store, volume } = f;
    await f.enable();
    await r.gallery.setEnabled(volume.id, false);
    f.offline();
    await assert.rejects(r.gallery.addPhotos(volume.id, [{ assetId: "photo-1", fileName: "IMG_1234.HEIC" }]));
    f.data.delete("photo-1");
    let lookups = 0;
    f.media.exists = async () => { lookups++; return false; };
    f.media.permission = async () => {
      if (access === "unavailable") throw new Error("Permission query failed");
      return { granted: access === "limited", accessPrivileges: access === "limited" ? "limited" : "none" };
    };
    f.online();
    await sync(f);
    assert.equal((await store.galleryAsset(r.scope, volume.id, "photo-1")).state, "failed");
    assert.equal(lookups, 0, "restricted access never proves a deletion");
  });
}

test("refused photo library access carries a code the screen can tell from other errors", async (t) => {
  const f = await galleryFixture(t);
  f.media.permission = async () => ({ granted: false, accessPrivileges: "none" });
  await assert.rejects(f.replica.gallery.options(false), (error) => {
    assert.equal(error.code, "PHOTO_PERMISSION");
    assert.match(error.message, /photo library access/);
    return true;
  });
  f.media.permission = async () => ({ granted: true, accessPrivileges: "limited" });
  f.media.albums = async () => {
    throw new Error("The library is busy");
  };
  await assert.rejects(f.replica.gallery.options(false), (error) => error.code === undefined);
});

test("a pick from before the name was kept beside its copy keeps the name its row carries, or takes its type from its bytes, never a blind photo.jpg", async (t) => {
  const heic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic"), Buffer.alloc(32)]);
  for (const [saved, bytes, expected] of [
    ['{"id":"x","name":"IMG_9.HEIC","resources":"abc"}', Buffer.from("pick bytes"), "IMG_9.HEIC"],
    ["{broken", heic, "photo.heic"],
    ["{broken", Buffer.from("plain bytes"), "photo"],
  ]) {
    const f = await galleryFixture(t);
    const { replica: r, store, volume } = f;
    await f.enable();
    const uri = path.join(f.root, "pick.bin");
    fs.writeFileSync(uri, bytes);
    f.offline();
    await assert.rejects(r.gallery.addPhotos(volume.id, [{ uri, fileName: "pick.bin" }]));
    const pending = (await store.galleryPreview(r.scope, volume.id, false, 24)).find((item) => item.picked);
    await r.files.remove(r.files.picked(r.scope, volume.id, `${pending.id}-name`));
    await store.db.runAsync("UPDATE gallery_assets SET row=? WHERE asset=?", saved, pending.id);
    await store.clearInterrupted(r.scope);
    f.online();
    await r.sync(true);
    const recovered = await store.galleryAsset(r.scope, volume.id, pending.id);
    assert.ok(recovered, `${saved} is recovered`);
    assert.equal(recovered.name, expected);
    assert.equal(recovered.state, "accepted");
  }
  const { pickedExtension, recoveredPick } = await import("../apps/mobile/src/gallery.js");
  assert.equal(pickedExtension(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])), ".jpg");
  assert.equal(pickedExtension(Buffer.concat([Buffer.from([0x89]), Buffer.from("PNG\r\n\x1a\n")])), ".png");
  assert.equal(pickedExtension(Buffer.from("GIF89a")), ".gif");
  assert.equal(pickedExtension(Buffer.from("RIFF\0\0\0\0WEBPVP8 ")), ".webp");
  assert.equal(pickedExtension(Buffer.concat([Buffer.alloc(4), Buffer.from("ftypqt  ")])), ".mov");
  assert.equal(pickedExtension(Buffer.concat([Buffer.alloc(4), Buffer.from("ftypisom")])), ".mp4");
  assert.equal(pickedExtension(Buffer.from("text")), "");
  assert.deepEqual(recoveredPick('{"name":"a.jpg","prefix":"P","creationTime":5,"x":1}'), { name: "a.jpg" });
  assert.deepEqual(recoveredPick("[1]"), {});
  assert.deepEqual(recoveredPick("{broken"), {});
});

test("a corrupt pick is sent again to the very path it was first given, so the hub never gets a second copy", async (t) => {
  const { galleryPath } = await import("../apps/mobile/src/gallery.js");
  const f = await galleryFixture(t);
  const { replica: r, store, volume } = f;
  await f.enable();
  const uri = path.join(f.root, "original.HEIC");
  fs.writeFileSync(uri, Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic"), Buffer.alloc(32)]));
  f.offline();
  await assert.rejects(r.gallery.addPhotos(volume.id, [{ uri, fileName: "original.HEIC" }]));
  const pending = (await store.galleryPreview(r.scope, volume.id, false, 24)).find((item) => item.picked);
  const expected = galleryPath(pending.prefix, pending, { name: pending.name, key: "original" });
  await store.db.runAsync("UPDATE gallery_assets SET row=? WHERE asset=?", "{broken", pending.id);
  await store.clearInterrupted(r.scope);
  f.online();
  await r.sync(true);
  const recovered = await store.galleryAsset(r.scope, volume.id, pending.id);
  assert.equal(recovered.name, "original.HEIC");
  assert.equal(recovered.resources[0].path, expected, "the path does not change");
  assert.equal(
    await r.files.stat(r.files.picked(r.scope, volume.id, `${pending.id}-name`)),
    null,
    "the kept name goes with the kept copy once the photo is accepted",
  );
});

test("the real picked-file helper accepts the name key a pick is stored under", () => {
  const source = fs
    .readFileSync(new URL("../apps/mobile/src/files.js", import.meta.url), "utf8")
    .replace(/^import .*;\r?$/gm, "")
    .replace("export const files", "const files");
  class Directory {
    constructor(parent, ...parts) {
      this.uri = [parent?.uri ?? parent, ...parts].join("/");
    }
  }
  class File extends Directory {}
  const files = vm.runInNewContext(`${source}\nfiles;`, { Directory, File, Paths: { document: "root", join: (...parts) => parts.join("/") } });
  const id = `picked-${"a".repeat(64)}`;
  assert.match(files.picked("scope-1", "volume-1", id), /picked\/volume-1\/picked-a+$/);
  assert.match(files.picked("scope-1", "volume-1", `${id}-name`), /picked-a+-name$/);
  assert.throws(() => files.picked("scope-1", "volume-1", `${id}.name`), /Invalid folder identity/, "a dotted key can never name a picked file");
});

test("a failed write of the kept name never deletes the copy a pending pick already has", async (t) => {
  const f = await galleryFixture(t);
  const { replica: r, store, volume } = f;
  await f.enable();
  const uri = path.join(f.root, "again.jpg");
  fs.writeFileSync(uri, "pick bytes");
  f.offline();
  await assert.rejects(r.gallery.addPhotos(volume.id, [{ uri, fileName: "again.jpg" }]));
  const pending = (await store.galleryPreview(r.scope, volume.id, false, 24)).find((item) => item.picked);
  const copy = r.files.picked(r.scope, volume.id, pending.id);
  const named = r.files.picked(r.scope, volume.id, `${pending.id}-name`);
  assert.ok(await r.files.stat(copy));
  const write = r.files.write;
  r.files.write = async () => {
    throw new Error("No space left on device");
  };
  await r.gallery.addPhotos(volume.id, [{ uri, fileName: "again.jpg" }]).catch(() => {});
  assert.ok(await r.files.stat(copy), "a same-name pick writes nothing and keeps its copy");
  assert.equal((await r.files.text(named)).trim(), "again.jpg");
  await r.files.remove(named);
  await r.gallery.addPhotos(volume.id, [{ uri, fileName: "again.jpg" }]).catch(() => {});
  assert.ok(await r.files.stat(copy), "a failed name write leaves the existing copy alone");
  assert.equal(await r.files.stat(named), null, "and no half-written name file");
  assert.equal((await store.galleryAsset(r.scope, volume.id, pending.id)).state, "pending");
  r.files.write = write;
  await r.files.write(named, new TextEncoder().encode("old.jpg"));
  r.files.write = async (uri, data, offset) => {
    if (uri === named && new TextDecoder().decode(data) !== "old.jpg") throw new Error("No space left on device");
    return write(uri, data, offset);
  };
  await r.gallery.addPhotos(volume.id, [{ uri, fileName: "again.jpg" }]).catch(() => {});
  assert.equal((await r.files.text(named)).trim(), "old.jpg", "a name file that could not be replaced keeps its previous content");
  r.files.write = write;
});

test("importing keeps every byte: edited conflict copies survive a reimport and an identical import changes nothing", async (t) => {
  const f = await fixture(t);
  const { replica: r, volume } = f;
  await f.client.refresh();
  await r.select(f.client.state().catalog.volumes[0]);
  await sync(f);
  await r.pause(true);
  const work = (name) => f.files.work(r.scope, volume.id, name);
  const source = path.join(f.root, "incoming.bin");
  const incoming = Buffer.from("incoming bytes");
  fs.writeFileSync(source, incoming);
  fs.mkdirSync(path.dirname(work("report.txt")), { recursive: true });
  fs.writeFileSync(work("report.txt"), "existing original");
  await r.importFile(volume.id, "report.txt", source);
  const hash = crypto.createHash("sha256").update(incoming).digest("hex").slice(0, 12);
  const conflict = `report.txt.conflict-import-${hash}`;
  assert.equal(fs.readFileSync(work("report.txt"), "utf8"), "existing original", "the original stays");
  assert.deepEqual(fs.readFileSync(work(conflict)), incoming);
  fs.writeFileSync(work(conflict), "my edits to the conflict copy");
  await r.importFile(volume.id, "report.txt", source);
  assert.equal(fs.readFileSync(work(conflict), "utf8"), "my edits to the conflict copy", "the edited conflict copy is never overwritten");
  assert.deepEqual(fs.readFileSync(work(`${conflict}-2`)), incoming, "the incoming bytes get an unused path");
  await r.importFile(volume.id, "report.txt", source);
  assert.deepEqual(
    fs.readdirSync(path.dirname(work("report.txt"))).filter((name) => name.startsWith("report.txt")).sort(),
    ["report.txt", conflict, `${conflict}-2`].sort(),
    "importing the same bytes again adds nothing",
  );
  fs.writeFileSync(work("same.txt"), incoming);
  const before = fs.statSync(work("same.txt")).mtimeMs;
  const copied = [];
  const copy = f.files.copy;
  f.files.copy = async (...args) => {
    copied.push(args[1]);
    return copy(...args);
  };
  await r.importFile(volume.id, "same.txt", source);
  assert.deepEqual(copied, [], "identical bytes are never copied again");
  assert.equal(fs.statSync(work("same.txt")).mtimeMs, before);
});

test("a failed import leaves the existing working file byte-identical and nothing partial behind", async (t) => {
  const f = await fixture(t);
  const { replica: r, volume } = f;
  await f.client.refresh();
  await r.select(f.client.state().catalog.volumes[0]);
  await sync(f);
  await r.pause(true);
  const work = (name) => f.files.work(r.scope, volume.id, name);
  const source = path.join(f.root, "incoming.bin");
  fs.writeFileSync(source, "new bytes");
  fs.mkdirSync(path.dirname(work("keep.txt")), { recursive: true });
  fs.writeFileSync(work("keep.txt"), "precious");
  const copy = f.files.copy;
  f.files.copy = async () => {
    throw new Error("No space left on device");
  };
  const conflict = `keep.txt.conflict-import-${crypto.createHash("sha256").update("new bytes").digest("hex").slice(0, 12)}`;
  await assert.rejects(r.importFile(volume.id, "keep.txt", source), /No space left/);
  assert.equal(fs.readFileSync(work("keep.txt"), "utf8"), "precious");
  assert.equal(fs.existsSync(work(conflict)), false, "no truncated conflict copy appears");
  f.files.copy = copy;
  const low = f.files.free;
  f.files.free = async () => 0;
  await assert.rejects(r.importFile(volume.id, "keep.txt", source));
  assert.equal(fs.readFileSync(work("keep.txt"), "utf8"), "precious", "low storage before copying changes nothing");
  f.files.free = low;
});

test("the production copy stages beside the destination, publishes atomically and never deletes the target on failure", async () => {
  const source = fs
    .readFileSync(new URL("../apps/mobile/src/files.js", import.meta.url), "utf8")
    .replace(/^import .*;\r?$/gm, "")
    .replace("export const files", "const files");
  const disk = new Map([["file:///app/arca/s/folders/v/keep.txt", "precious"], ["file:///cache/source.bin", "new bytes"]]);
  const replaced = [];
  let failCopy = false;
  let failMove = false;
  class File {
    constructor(...parts) {
      this.uri = parts.map((part) => part.uri ?? part).join("/");
    }
    get exists() {
      return disk.has(this.uri);
    }
    delete() {
      disk.delete(this.uri);
    }
    async copy(destination) {
      if (failCopy) {
        disk.set(destination.uri, "trunc");
        throw new Error("No space left on device");
      }
      disk.set(destination.uri, disk.get(this.uri));
    }
    async move(destination) {
      if (failMove) throw new Error("Move failed");
      disk.set(destination.uri, disk.get(this.uri));
      disk.delete(this.uri);
    }
  }
  class Directory {
    constructor(...parts) {
      this.uri = parts.map((part) => part.uri ?? part).join("/");
    }
  }
  const files = vm.runInNewContext(`${source}\nfiles;`, {
    File,
    Directory,
    Paths: { document: "file:///app", dirname: (uri) => uri.slice(0, uri.lastIndexOf("/")), join: (...parts) => parts.join("/") },
    native: {
      replaceFile(from, to) {
        replaced.push([from, to]);
        disk.set(to, disk.get(from));
        disk.delete(from);
      },
    },
    Date,
    Math,
  });
  const target = "file:///app/arca/s/folders/v/keep.txt";
  failCopy = true;
  await assert.rejects(files.copy("file:///cache/source.bin", target), /No space left/);
  assert.equal(disk.get(target), "precious", "a failed copy leaves the target alone");
  assert.deepEqual([...disk.keys()].sort(), [target, "file:///cache/source.bin"].sort(), "the half-written staging file is removed");
  failCopy = false;
  await files.copy("file:///cache/source.bin", target);
  assert.equal(disk.get(target), "new bytes");
  assert.equal(replaced.length, 1);
  assert.match(replaced[0][0], /^file:\/\/\/app\/arca\/s\/folders\/v\/\.arca-copy-/, "staged under a name the scanner skips");
  const outside = "file:///cache/arca-incoming/x";
  await files.copy("file:///cache/source.bin", outside);
  assert.equal(disk.get(outside), "new bytes", "a destination outside the app root is moved into place");
  assert.equal(replaced.length, 1);
  failMove = true;
  await assert.rejects(files.copy("file:///cache/source.bin", outside), /Move failed/, "a failing move is awaited and reported");
  assert.deepEqual([...disk.keys()].filter((uri) => uri.includes(".arca-copy-")), [], "and its staging file is removed");
});

test("importing stops with a clear error when every candidate name is taken, and a leftover staging file is swept", async (t) => {
  const f = await fixture(t);
  const { replica: r, volume } = f;
  await f.client.refresh();
  await r.select(f.client.state().catalog.volumes[0]);
  await sync(f);
  await r.pause(true);
  const work = (name) => f.files.work(r.scope, volume.id, name);
  const source = path.join(f.root, "incoming.bin");
  fs.writeFileSync(source, "incoming");
  const hash = crypto.createHash("sha256").update("incoming").digest("hex").slice(0, 12);
  const conflict = `full.txt.conflict-import-${hash}`;
  fs.mkdirSync(path.dirname(work("full.txt")), { recursive: true });
  fs.writeFileSync(work("full.txt"), "a");
  fs.writeFileSync(work(conflict), "b");
  for (let n = 2; n <= 99; n++) fs.writeFileSync(work(`${conflict}-${n}`), `c${n}`);
  fs.writeFileSync(path.join(path.dirname(work("full.txt")), ".arca-copy-left-behind"), "half");
  await assert.rejects(r.importFile(volume.id, "full.txt", source), /Too many conflicting copies/);
  fs.rmSync(work(`${conflict}-99`));
  await r.importFile(volume.id, "full.txt", source);
  assert.equal(fs.readFileSync(work(`${conflict}-99`), "utf8"), "incoming");
  assert.equal(fs.existsSync(path.join(path.dirname(work("full.txt")), ".arca-copy-left-behind")), false, "an orphaned staging file is removed before the next import");
});
