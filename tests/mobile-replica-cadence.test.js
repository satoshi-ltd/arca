import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Replica, CHUNK, PROGRESS_MS } from "../apps/mobile/src/replica.js";
import { ReplicaStore, TOTALS_WRITE } from "../apps/mobile/src/replica-store.js";
import { createClient } from "../apps/mobile/src/client.js";
import { init } from "../packages/daemon/storage.js";
import { start } from "../packages/daemon/server.js";

const FOLDERS_SQL = "FROM folders f LEFT JOIN gallery_sources g";

async function phone(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arca-mobile-cadence-"));
  const home = path.join(root, "hub");
  init(home, { port: 0 });
  const daemon = await start(home, { timer: false });
  const base = `http://127.0.0.1:${daemon.port}`;
  const db = new DatabaseSync(path.join(root, "mobile.sqlite"));
  t.after(async () => {
    await daemon.close();
    db.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const yielded =
    (work) =>
    async (...args) => {
      await new Promise((resolve) => setImmediate(resolve));
      return work(...args);
    };
  const queries = [];
  const store = new ReplicaStore({
    execAsync: yielded((s) => db.exec(s)),
    runAsync: yielded((s, ...v) => db.prepare(s).run(...v)),
    getFirstAsync: yielded((s, ...v) => db.prepare(s).get(...v)),
    getAllAsync: yielded((s, ...v) => {
      queries.push(s);
      return db.prepare(s).all(...v);
    }),
  });
  let saved = null;
  let cached = null;
  const net = { online: true, failBlocks: 0, log: [] };
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
    fetcher: async (url, options) => {
      const route = new URL(url).pathname;
      net.log.push(route);
      if (!net.online) throw new TypeError("Network request failed");
      if (options.headers.Range && net.failBlocks > 0) {
        net.failBlocks--;
        if (!net.failBlocks) net.online = false;
      }
      return fetch(url.replace("https://fixture.invalid", base), options);
    },
  });
  const local = path.join(root, "mobile");
  const hashes = [];
  const files = {
    destroy: async () => fs.rmSync(local, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
    folder: (s, v) => path.join(local, s, "folders", v),
    work: (s, v, p) => path.join(local, s, "folders", v, ...p.split("/")),
    object: (s, h) => path.join(local, s, "objects", h),
    partial: (s, h) => path.join(local, s, "partial", h),
    parent: path.dirname,
    child: path.join,
    mkdir: async (p) => fs.mkdirSync(p, { recursive: true }),
    exists: async (p) => fs.existsSync(p),
    listNames: async (p) => fs.readdirSync(p),
    stat: async (p) => {
      if (!fs.existsSync(p)) return null;
      const s = fs.statSync(p);
      return s.isDirectory()
        ? { directory: true, size: 0 }
        : { size: s.size, mtime: s.mtimeMs };
    },
    free: async () => 1e12,
    removeDirectory: async (p) => fs.rmdirSync(p),
    remove: async (p) => fs.rmSync(p, { force: true }),
    removeFolder: async (s, v) =>
      fs.rmSync(path.join(local, s, "folders", v), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
    copy: async (a, b) => fs.copyFileSync(a, b),
    clearStaged: async () => {},
    move: async (a, b) => fs.renameSync(a, b),
    replace: async (a, b) => fs.renameSync(a, b),
    text: async (p) => fs.readFileSync(p, "utf8"),
    hash: async (p) => {
      hashes.push(p);
      return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
    },
    write: async (p, b, offset = 0) => {
      const fd = fs.openSync(p, fs.existsSync(p) ? "r+" : "w");
      try {
        fs.writeSync(fd, b, 0, b.length, offset);
      } finally {
        fs.closeSync(fd);
      }
    },
    read: async (p, o, l) => fs.readFileSync(p).subarray(o, o + l),
    async *walk(dir, prefix = "") {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name.startsWith(".arca-")) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          yield { path: prefix + e.name, uri: p, size: 0, directory: true };
          yield* this.walk(p, prefix + e.name + "/");
        } else {
          const s = fs.statSync(p);
          yield { path: prefix + e.name, uri: p, size: s.size, mtime: s.mtimeMs };
        }
      }
    },
  };
  const replica = new Replica({ store, files, client, platform: "android" });
  await replica.load();
  await client.load();
  const volume = daemon.engine.store.addVolume("Podcasts");
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
  const work = (name) => files.work(replica.scope, volume.id, name);
  const hashed = (prefix) =>
    hashes.filter((p) => p.startsWith(files.folder(replica.scope, volume.id)) && path.basename(p).startsWith(prefix));
  const select = async () => {
    await daemon.engine.cycle();
    await client.refresh();
    await replica.select(client.state().catalog.volumes.find((v) => v.id === volume.id));
  };
  return { daemon, volume, replica, store, files, client, net, hashes, hashed, queries, work, select };
}

const yieldEvery = (replica, blocks) => {
  let count = 0;
  replica.checkTransferTurn = () => {
    replica.check();
    if (++count % blocks === 0)
      throw Object.assign(new Error("Continuing next turn"), { code: "SYNC_YIELD" });
  };
};

const allDue = (f) =>
  f.store.db.runAsync("UPDATE scan_cache SET row=json_set(row,'$.due',0)");

test("a downloaded file is trusted by the next scan instead of being hashed again", async (t) => {
  const f = await phone(t);
  for (let i = 0; i < 20; i++)
    fs.writeFileSync(path.join(f.volume.path, `IMG_${i}.jpg`), crypto.randomBytes(512));
  await f.select();
  await f.replica.sync();
  assert.equal(f.replica.error, null);
  f.hashes.length = 0;
  await f.replica.sync();
  assert.equal(f.replica.error, null);
  assert.deepEqual(f.hashed("IMG_"), [], "a file the phone verified while downloading is not read again");
});

test("Sync now scans for changes without re-hashing every file", async (t) => {
  const f = await phone(t);
  for (let i = 0; i < 10; i++)
    fs.writeFileSync(path.join(f.volume.path, `ep${i}.mp3`), crypto.randomBytes(256));
  await f.select();
  await f.replica.sync();
  f.hashes.length = 0;
  fs.writeFileSync(f.work("ep3.mp3"), "a longer local edit that changes the size");
  await f.replica.sync(true);
  assert.equal(f.replica.error, null);
  assert.deepEqual([...new Set(f.hashed("ep").map((p) => path.basename(p)))], ["ep3.mp3"], "only the edited file is read");
  assert.equal(fs.readFileSync(path.join(f.volume.path, "ep3.mp3"), "utf8"), "a longer local edit that changes the size");
});

test("an interrupted verification resumes where it stopped and re-hashes each file once", async (t) => {
  const f = await phone(t);
  for (let i = 0; i < 30; i++)
    fs.writeFileSync(path.join(f.volume.path, `IMG_${i}.jpg`), crypto.randomBytes(256));
  await f.select();
  await f.replica.sync();
  await allDue(f);
  f.hashes.length = 0;
  const hash = f.files.hash;
  let reads = 0;
  f.files.hash = async (p) => {
    if (++reads === 10) f.replica.stop();
    return hash(p);
  };
  await f.replica.sync(false, { scheduled: true });
  const first = f.hashed("IMG_");
  assert.ok(first.length >= 9 && first.length <= 10, `the backgrounded run verified ${first.length} files`);
  f.files.hash = hash;
  await f.replica.sync(false, { scheduled: true });
  await f.replica.sync(false, { scheduled: true });
  const all = f.hashed("IMG_");
  assert.equal(new Set(all).size, 30, "every file is verified");
  assert.equal(all.length, 30, "no file is verified twice");
  f.hashes.length = 0;
  await f.replica.sync(true);
  assert.deepEqual(f.hashed("IMG_"), [], "verified files are not due again for at least a week");
});

test("a local error while verifying stored copies is a folder issue, not a hub failure", async (t) => {
  const f = await phone(t);
  fs.writeFileSync(path.join(f.volume.path, "notes.txt"), "original bytes");
  await f.select();
  await f.replica.sync();
  await allDue(f);
  f.store.dueHashes = async () => {
    throw new Error("Storage is not readable");
  };
  await f.replica.sync(false, { scheduled: true });
  assert.equal(f.replica.error, null, "the hub is not reported as failing");
  assert.equal(f.replica.hubUnavailable, false);
  const folder = (await f.store.folders(f.replica.scope)).find((row) => row.id === f.volume.id);
  assert.match(folder.issue, /Storage is not readable/);
});

test("a launch drops stored file checks that verification can never reach", async (t) => {
  const f = await phone(t);
  fs.writeFileSync(path.join(f.volume.path, "notes.txt"), "original bytes");
  await f.select();
  await f.replica.sync();
  const keys = async () => (await f.store.db.getAllAsync("SELECT uri FROM scan_cache ORDER BY uri")).map((row) => row.uri);
  const kept = await keys();
  assert.deepEqual(kept, [f.work("notes.txt")]);
  const record = { size: 1, mtime: 1, hash: "a".repeat(64), due: 0 };
  await f.store.cacheHash("content://media/1", record);
  await f.store.cacheHash("old-scope", { ...record, scope: "another-hub", volume: f.volume.id, path: "a.txt", uri: "old-scope" });
  await f.store.cacheHash("gone-folder", { ...record, scope: f.replica.scope, volume: "removed", path: "a.txt", uri: "gone-folder" });
  f.replica.hashesPruned = null;
  await f.replica.sync();
  assert.equal(f.replica.error, null);
  assert.deepEqual(await keys(), kept);
});

test("an upgraded phone reuses its earlier file checks instead of hashing every file again", async (t) => {
  const f = await phone(t);
  fs.writeFileSync(path.join(f.volume.path, "notes.txt"), "original bytes");
  await f.select();
  await f.replica.sync();
  const target = f.work("notes.txt");
  const current = await f.store.cachedHash(target);
  await f.store.db.runAsync("DELETE FROM scan_cache");
  await f.store.cacheHash(target, { size: current.size, mtime: current.mtime, hash: current.hash });
  f.replica.hashCache.clear();
  f.replica.hashesPruned = null;
  f.replica.lastInventory.clear();
  f.hashes.length = 0;
  await f.replica.sync();
  assert.equal(f.replica.error, null);
  assert.deepEqual(f.hashed("notes"), [], "the earlier check is trusted");
  const upgraded = await f.store.cachedHash(target);
  assert.equal(upgraded.hash, current.hash);
  assert.equal(upgraded.scope, f.replica.scope);
  assert.equal(upgraded.volume, f.volume.id);
  assert.equal(upgraded.path, "notes.txt");
  assert.ok(upgraded.due > Date.now());
});

test("verification finds a same-size edit that kept its timestamp and uploads it", async (t) => {
  const f = await phone(t);
  fs.writeFileSync(path.join(f.volume.path, "notes.txt"), "original bytes");
  await f.select();
  await f.replica.sync();
  const target = f.work("notes.txt");
  const { atime, mtime } = fs.statSync(target);
  fs.writeFileSync(target, "ORIGINAL BYTES");
  fs.utimesSync(target, atime, mtime);
  await f.replica.sync(false, { scheduled: true });
  assert.equal(fs.readFileSync(path.join(f.volume.path, "notes.txt"), "utf8"), "original bytes", "a scan alone cannot see the edit");
  await allDue(f);
  await f.replica.sync(false, { scheduled: true });
  assert.equal(f.replica.error, null);
  assert.equal(fs.readFileSync(path.join(f.volume.path, "notes.txt"), "utf8"), "ORIGINAL BYTES");
});

test("continuation turns of one run reuse the inventory instead of walking the folder again", async (t) => {
  const f = await phone(t);
  for (let i = 0; i < 3; i++)
    fs.writeFileSync(path.join(f.volume.path, `ep${i}.mp3`), crypto.randomBytes(CHUNK * 2 + 7));
  await f.select();
  yieldEvery(f.replica, 2);
  const scan = f.replica.scan.bind(f.replica);
  let scans = 0;
  f.replica.scan = async (folder) => {
    scans++;
    return scan(folder);
  };
  const cycle = f.replica.cycle.bind(f.replica);
  let turns = 0;
  f.replica.cycle = async () => {
    turns++;
    return cycle();
  };
  await f.replica.sync();
  assert.equal(f.replica.error, null);
  assert.ok(turns > 2, `the download took ${turns} turns`);
  assert.equal(scans, 1, "one inventory per run");
  for (let i = 0; i < 3; i++)
    assert.deepEqual(fs.readFileSync(f.work(`ep${i}.mp3`)), fs.readFileSync(path.join(f.volume.path, `ep${i}.mp3`)));
});

test("a yielded download resumes after local changes are pushed and keeps its baseline safe", async (t) => {
  const f = await phone(t);
  fs.writeFileSync(path.join(f.volume.path, "episode.mp3"), "first version");
  fs.writeFileSync(path.join(f.volume.path, "keep.txt"), "kept");
  await f.select();
  await f.replica.sync();
  const update = crypto.randomBytes(CHUNK * 4 + 3);
  fs.writeFileSync(path.join(f.volume.path, "episode.mp3"), update);
  await f.daemon.engine.cycle();
  const check = f.replica.checkTransferTurn.bind(f.replica);
  yieldEvery(f.replica, 2);
  await f.replica.cycle();
  assert.equal((await f.store.applying(f.replica.scope, f.volume.id)).length, 1, "the replacement is journaled mid-download");
  assert.equal(fs.readFileSync(f.work("episode.mp3"), "utf8"), "first version");
  f.replica.checkTransferTurn = check;
  fs.writeFileSync(f.work("new.txt"), "made on the phone");
  f.net.log.length = 0;
  await f.replica.sync();
  assert.equal(f.replica.error, null);
  const propose = f.net.log.indexOf("/v1/propose");
  const block = f.net.log.findIndex((route) => route.startsWith("/v1/blobs/"));
  assert.ok(propose >= 0 && block > propose, "the phone's change reaches the hub before the download continues");
  assert.deepEqual(fs.readFileSync(f.work("episode.mp3")), update);
  assert.equal(fs.readFileSync(path.join(f.volume.path, "keep.txt"), "utf8"), "kept", "nothing was proposed as deleted");
  assert.deepEqual(fs.readFileSync(path.join(f.volume.path, "episode.mp3")), update, "the old bytes were never proposed as an edit");
  assert.equal(fs.readFileSync(path.join(f.volume.path, "new.txt"), "utf8"), "made on the phone");
  assert.deepEqual(await f.store.applying(f.replica.scope, f.volume.id), []);
});

test("a yielded download whose file was edited meanwhile keeps the edit as a conflict copy", async (t) => {
  const f = await phone(t);
  fs.writeFileSync(path.join(f.volume.path, "episode.mp3"), "first version");
  await f.select();
  await f.replica.sync();
  const update = crypto.randomBytes(CHUNK * 4 + 3);
  fs.writeFileSync(path.join(f.volume.path, "episode.mp3"), update);
  await f.daemon.engine.cycle();
  const check = f.replica.checkTransferTurn.bind(f.replica);
  yieldEvery(f.replica, 2);
  await f.replica.cycle();
  f.replica.checkTransferTurn = check;
  fs.writeFileSync(f.work("episode.mp3"), "edited on the phone meanwhile");
  await f.replica.sync();
  await f.replica.sync();
  assert.equal(f.replica.error, null);
  const names = fs.readdirSync(path.dirname(f.work("episode.mp3")));
  const conflict = names.find((name) => name.startsWith("episode.mp3.conflict-mobile-"));
  assert.ok(conflict, "the phone's edit is preserved");
  assert.equal(fs.readFileSync(path.join(path.dirname(f.work("episode.mp3")), conflict), "utf8"), "edited on the phone meanwhile");
  assert.deepEqual(fs.readFileSync(f.work("episode.mp3")), update);
});

function session() {
  const events = [];
  return {
    events,
    active: false,
    async begin() {
      if (this.active) return true;
      this.active = true;
      events.push("begin");
      return true;
    },
    async end() {
      if (!this.active) return;
      this.active = false;
      events.push("end");
    },
  };
}

test("a transient outage mid-download keeps the transfer session and finishes in the same run", async (t) => {
  const f = await phone(t);
  const data = crypto.randomBytes(CHUNK * 4 + 1);
  fs.writeFileSync(path.join(f.volume.path, "episode.mp3"), data);
  await f.select();
  const lease = session();
  f.replica.transfer = lease;
  f.replica.offlineHoldMs = 2000;
  let retries = 0;
  f.replica.retryDelay = () => {
    retries++;
    f.net.online = true;
    return 10;
  };
  f.net.failBlocks = 2;
  await f.replica.sync();
  assert.equal(retries, 1, "the run waited out exactly one outage");
  assert.equal(f.replica.error, null);
  assert.deepEqual(lease.events, ["begin", "end"], "the session is held across the outage and released once");
  assert.deepEqual(fs.readFileSync(f.work("episode.mp3")), data);
});

test("a sustained outage releases the transfer session after the hold expires", async (t) => {
  const f = await phone(t);
  fs.writeFileSync(path.join(f.volume.path, "episode.mp3"), crypto.randomBytes(CHUNK * 3));
  await f.select();
  const lease = session();
  f.replica.transfer = lease;
  f.replica.retryDelay = () => 20;
  f.replica.offlineHoldMs = 120;
  f.net.failBlocks = 1;
  const started = Date.now();
  await f.replica.sync();
  assert.equal(f.replica.hubUnavailable, true);
  assert.deepEqual(lease.events, ["begin", "end"]);
  assert.ok(Date.now() - started < 5000);
  f.net.online = true;
});

test("pausing during the outage hold ends the run at once", async (t) => {
  const f = await phone(t);
  fs.writeFileSync(path.join(f.volume.path, "episode.mp3"), crypto.randomBytes(CHUNK * 3));
  await f.select();
  const lease = session();
  f.replica.transfer = lease;
  f.replica.retryDelay = () => 60000;
  f.net.failBlocks = 1;
  const run = f.replica.sync();
  for (let waited = 0; !f.replica.retryNow && waited < 3000; waited += 5)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(f.replica.retryNow, "the run is holding through the outage");
  const started = Date.now();
  await f.replica.pause(true);
  await run;
  assert.ok(Date.now() - started < 2000);
  assert.deepEqual(lease.events, ["begin", "end"]);
});

test("download progress refreshes the folder totals about once a second, not once per block", async (t) => {
  const f = await phone(t);
  fs.writeFileSync(path.join(f.volume.path, "episode.mp3"), crypto.randomBytes(CHUNK * 16));
  await f.select();
  let changes = 0;
  f.replica.changed = () => {
    changes++;
    void f.store.folders(f.replica.scope);
  };
  f.queries.length = 0;
  await f.replica.sync();
  assert.equal(f.replica.error, null);
  const totals = f.queries.filter((sql) => sql.includes(FOLDERS_SQL)).length;
  assert.ok(changes < 16, `${changes} screen refreshes for 16 blocks`);
  assert.ok(totals < 10, `${totals} folder total queries for 16 blocks`);
});

test("folder totals are cached until the store changes", async (t) => {
  const f = await phone(t);
  await f.select();
  f.queries.length = 0;
  const first = await f.store.folders(f.replica.scope);
  first[0].name = "mutated by a caller";
  const second = await f.store.folders(f.replica.scope);
  assert.equal(f.queries.filter((sql) => sql.includes(FOLDERS_SQL)).length, 1);
  assert.equal(second[0].name, "Podcasts");
  await f.store.issue(f.replica.scope, f.volume.id, "Something changed");
  const third = await f.store.folders(f.replica.scope);
  assert.equal(third[0].issue, "Something changed");
  assert.equal(f.queries.filter((sql) => sql.includes(FOLDERS_SQL)).length, 2);
});

test("a scheduled cycle with nothing due skips every folder scan and leaves the library discovery alone", async (t) => {
  const f = await phone(t);
  fs.writeFileSync(path.join(f.volume.path, "a.txt"), "a");
  await f.select();
  await f.replica.sync(true);
  const scans = [];
  const scan = f.replica.scan.bind(f.replica);
  f.replica.scan = async (folder) => {
    scans.push(folder.id);
    return scan(folder);
  };
  for (const id of [...f.replica.lastInventory.keys()]) f.replica.lastInventory.set(id, Date.now() - 2 * 3600000);
  await f.replica.sync(false, { scheduled: true });
  assert.deepEqual(scans, [], "a scheduled cycle two hours after the last inventory scans nothing");
  f.replica.lastInventory.clear();
  await f.replica.sync(false, { scheduled: true });
  assert.ok(scans.length > 0, "after a long absence the next cycle scans again");
});

test("a run that shows no progress for ten minutes gives up and frees the transfer", async (t) => {
  const f = await phone(t);
  await f.select();
  const { NO_PROGRESS_MS } = await import("../apps/mobile/src/sync-cadence.js");
  assert.equal(NO_PROGRESS_MS, 10 * 60000);
  const intervals = [];
  const realSet = globalThis.setInterval;
  const realClear = globalThis.clearInterval;
  globalThis.setInterval = (fn, ms) => (intervals.push({ fn, ms }), intervals.length);
  globalThis.clearInterval = () => {};
  t.after(() => {
    globalThis.setInterval = realSet;
    globalThis.clearInterval = realClear;
  });
  let stopped = 0;
  f.replica.suspend = () => stopped++;
  const run = f.replica.sync(true);
  await run;
  const watchdog = intervals.find((entry) => entry.ms === 30000);
  assert.ok(watchdog, "every run arms a 30 s watchdog");
  f.replica.lastChangeAt = Date.now() - NO_PROGRESS_MS - 1000;
  f.replica.changed();
  watchdog.fn();
  assert.equal(stopped, 1, "ten idle minutes suspend the run, however often the state is announced");
  f.replica.lastChangeAt = Date.now() - NO_PROGRESS_MS - 1000;
  f.replica.check();
  watchdog.fn();
  assert.equal(stopped, 1, "a run that keeps stepping through files and pages is alive");
  f.replica.lastChangeAt = Date.now() - NO_PROGRESS_MS - 1000;
  f.replica.reportProgress({ direction: "download", bytesDone: 1, bytesTotal: 10 });
  watchdog.fn();
  assert.equal(stopped, 1, "real transfer progress keeps it going");
});

test("the inventory time survives a cold start and a manual call joining a scheduled run asks for a scan", async (t) => {
  const f = await phone(t);
  fs.writeFileSync(path.join(f.volume.path, "a.txt"), "a");
  await f.select();
  await f.replica.sync(true);
  const id = f.volume.id;
  const key = f.replica.inventoryKey(id);
  const saved = await f.store.get(key, 0);
  assert.ok(saved > 0, "a scan records its time durably");
  f.replica.lastInventory.clear();
  await f.replica.load();
  assert.equal(f.replica.lastInventory.get(id), saved, "a new process starts from the saved time, so a background cycle does not walk the folder again");
  f.replica.forceNext = false;
  f.replica.active = new Promise(() => {});
  f.replica.stopped = false;
  void f.replica.sync();
  assert.equal(f.replica.forceNext, true, "an unscheduled call that finds a run asks the run for one more full inventory");
  f.replica.forceNext = false;
  void f.replica.sync(false, { scheduled: true });
  assert.equal(f.replica.forceNext, false, "a scheduled call does not");
  f.replica.active = null;
  await f.replica.unselect(id);
  assert.equal(f.replica.lastInventory.has(id), false, "stopping a folder forgets its inventory time");
  assert.equal(await f.store.get(key, 0), 0, "and the saved one, so selecting it again scans at once");
});

test("a file check stored under an earlier form of the file's URI is dropped instead of verifying the file twice", async (t) => {
  const f = await phone(t);
  fs.writeFileSync(path.join(f.volume.path, "notes.txt"), "original bytes");
  await f.select();
  await f.replica.sync();
  const keys = async () => (await f.store.db.getAllAsync("SELECT uri FROM scan_cache ORDER BY uri")).map((row) => row.uri);
  const [current] = await keys();
  const row = JSON.parse((await f.store.db.getFirstAsync("SELECT row FROM scan_cache WHERE uri=?", current)).row);
  await f.store.cacheHash(current + "-earlier-form", row);
  await allDue(f);
  f.hashes.length = 0;
  await f.replica.sync(false, { scheduled: true });
  assert.equal(f.replica.error, null);
  assert.deepEqual(await keys(), [current]);
  assert.ok(f.hashed("notes").length <= 1, "the file is verified once");
});

test("the phone lists, for each kept folder, its cursor and the newest revision it recorded, for a hub address change to check", async (t) => {
  const f = await phone(t);
  fs.writeFileSync(path.join(f.volume.path, "a.txt"), "first");
  fs.writeFileSync(path.join(f.volume.path, "b.txt"), "second");
  await f.select();
  await f.replica.sync();
  const [check] = await f.replica.relocationChecks();
  const folder = (await f.store.folders(f.replica.scope)).find((row) => row.id === f.volume.id);
  assert.equal(check.volume, f.volume.id);
  assert.equal(check.cursor, folder.cursor);
  assert.ok(check.cursor > 0);
  const newest = f.daemon.engine.store.db.prepare("SELECT path,hash,rev FROM files WHERE volume=? AND rev<=? ORDER BY rev DESC LIMIT 1").get(f.volume.id, check.cursor);
  assert.deepEqual(check.last, { path: newest.path, hash: newest.hash, deleted: false, rev: newest.rev });
});

const coldStart = async (f) => {
  const replica = new Replica({ store: f.store, files: f.files, client: f.client, platform: "android" });
  await replica.load();
  return replica;
};

test("a file saved on the phone uploads on the next scheduled cycle after the run that followed it was cut short", async (t) => {
  const f = await phone(t);
  fs.writeFileSync(path.join(f.volume.path, "a.txt"), "a");
  await f.select();
  await f.replica.sync(true);
  const source = path.join(path.dirname(f.volume.path), "incoming.bin");
  fs.writeFileSync(source, "shared from another app");
  await f.replica.importFile(f.volume.id, "shared.txt", source);
  const scan = f.replica.scan.bind(f.replica);
  f.replica.scan = async (folder) => {
    f.replica.suspend();
    return scan(folder);
  };
  await f.replica.sync();
  assert.equal((await f.store.pending(f.replica.scope, f.volume.id)).length, 0, "the cut run queued nothing");
  const next = await coldStart(f);
  await next.sync(false, { scheduled: true });
  await f.daemon.engine.cycle();
  assert.equal(next.error, null);
  assert.equal(fs.readFileSync(path.join(f.volume.path, "shared.txt"), "utf8"), "shared from another app");
});

const reachesHub = async (t, change, expected) => {
  const f = await phone(t);
  for (const name of ["a.txt", "b.txt"]) fs.writeFileSync(path.join(f.volume.path, name), name);
  await f.select();
  await f.replica.sync(true);
  await change(f);
  const next = await coldStart(f);
  await next.sync(false, { scheduled: true });
  await f.daemon.engine.cycle();
  assert.equal(next.error, null);
  assert.deepEqual(
    fs.readdirSync(f.volume.path).filter((name) => /\.txt$/.test(name)).sort(),
    expected,
  );
};

test("a delete made on the phone reaches the hub on the next scheduled cycle after a cold start", (t) =>
  reachesHub(t, (f) => f.replica.removeFile(f.volume.id, "a.txt"), ["b.txt"]));

test("a rename made on the phone reaches the hub on the next scheduled cycle after a cold start", (t) =>
  reachesHub(t, (f) => f.replica.renameFile(f.volume.id, "b.txt", "c.txt"), ["a.txt", "c.txt"]));

test("a playlist written on the phone makes its folder's inventory due, in memory and in the saved time a cold start reads", async (t) => {
  const f = await phone(t);
  fs.writeFileSync(path.join(f.volume.path, "a.txt"), "a");
  await f.select();
  await f.replica.sync(true);
  const key = f.replica.inventoryKey(f.volume.id);
  assert.ok((await f.store.get(key, 0)) > 0);
  f.files.staged = (target) => path.join(path.dirname(target), `.arca-copy-${crypto.randomUUID()}`);
  await f.replica.writePlaylist(f.volume.id, "Playlists/Road.m3u8", "#EXTM3U\n");
  assert.equal(f.replica.lastInventory.has(f.volume.id), false);
  assert.equal(await f.store.get(key, 0), 0);
});

const hubFiles = (f) =>
  fs.readdirSync(f.volume.path).filter((name) => !name.startsWith(".arca")).sort();

const vanished = async (t) => {
  const f = await phone(t);
  for (const name of ["a.txt", "b.txt", "c.txt"]) fs.writeFileSync(path.join(f.volume.path, name), name);
  await f.select();
  await f.replica.sync(true);
  assert.equal(f.replica.error, null);
  const root = f.files.folder(f.replica.scope, f.volume.id);
  fs.rmSync(root, { recursive: true, force: true });
  return { f, root };
};

test("a folder whose directory vanished stops with its reason instead of pulling into a new one and deleting the rest", async (t) => {
  const { f, root } = await vanished(t);
  fs.writeFileSync(path.join(f.volume.path, "new.txt"), "new");
  await f.daemon.engine.cycle();
  await f.replica.sync(false, { scheduled: true });
  assert.match(f.replica.error, /Local folder is unavailable/);
  assert.equal(fs.existsSync(root), false, "the pull did not recreate the directory");
  await f.replica.sync(true);
  await f.daemon.engine.cycle();
  assert.match(f.replica.error, /Local folder is unavailable/);
  assert.equal(fs.existsSync(root), false);
  assert.deepEqual(hubFiles(f), ["a.txt", "b.txt", "c.txt", "new.txt"]);
});

test("saving a file into a folder whose directory vanished is refused and deletes nothing on the hub", async (t) => {
  const { f, root } = await vanished(t);
  const source = path.join(path.dirname(f.volume.path), "incoming.bin");
  fs.writeFileSync(source, "shared from another app");
  await assert.rejects(f.replica.importFile(f.volume.id, "shared.txt", source), /Local folder is unavailable/);
  assert.equal(fs.existsSync(root), false);
  await f.replica.sync(true);
  await f.daemon.engine.cycle();
  assert.deepEqual(hubFiles(f), ["a.txt", "b.txt", "c.txt"]);
});

test("a playlist edit in a folder whose directory vanished is refused and deletes nothing on the hub", async (t) => {
  const { f, root } = await vanished(t);
  await fetch(`http://127.0.0.1:${f.daemon.port}/v1/music/mark`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${f.daemon.engine.config.adminToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ volume: f.volume.id }),
  });
  await f.client.refresh();
  f.files.staged = (target) => path.join(path.dirname(target), `.arca-copy-${crypto.randomUUID()}`);
  await assert.rejects(f.replica.createPlaylist(f.volume.id, "Road trip", "a.txt"), /Local folder is unavailable/);
  assert.equal(fs.existsSync(root), false);
  await f.replica.sync(true);
  await f.daemon.engine.cycle();
  assert.deepEqual(hubFiles(f), ["a.txt", "b.txt", "c.txt"]);
});

test("a folder that holds no files yet gets its missing directory back and syncs", async (t) => {
  const f = await phone(t);
  await f.select();
  await f.replica.sync(true);
  const root = f.files.folder(f.replica.scope, f.volume.id);
  fs.rmSync(root, { recursive: true, force: true });
  fs.writeFileSync(path.join(f.volume.path, "first.txt"), "first");
  await f.daemon.engine.cycle();
  await f.replica.sync(true);
  assert.equal(f.replica.error, null);
  assert.equal(fs.readFileSync(f.work("first.txt"), "utf8"), "first");
});

test("a directory that vanishes in the middle of a pull is not recreated by the files that follow", async (t) => {
  const f = await phone(t);
  for (const name of ["a.txt", "b.txt", "c.txt"]) fs.writeFileSync(path.join(f.volume.path, name), name);
  await f.select();
  await f.replica.sync(true);
  const root = f.files.folder(f.replica.scope, f.volume.id);
  fs.writeFileSync(path.join(f.volume.path, "new1.txt"), "new one");
  fs.writeFileSync(path.join(f.volume.path, "new2.txt"), "new two");
  await f.daemon.engine.cycle();
  const download = f.replica.download.bind(f.replica);
  let removed = false;
  f.replica.download = async (...args) => {
    const object = await download(...args);
    if (!removed) {
      removed = true;
      fs.rmSync(root, { recursive: true, force: true });
    }
    return object;
  };
  await f.replica.sync(false, { scheduled: true });
  assert.equal(removed, true);
  assert.match(f.replica.error, /Local folder is unavailable/);
  assert.doesNotMatch(f.replica.error, /Could not sync/, "the folder stops as a whole, not file by file");
  assert.equal(fs.existsSync(root), false);
  await f.replica.sync(true);
  await f.daemon.engine.cycle();
  assert.equal(fs.existsSync(root), false);
  assert.deepEqual(hubFiles(f), ["a.txt", "b.txt", "c.txt", "new1.txt", "new2.txt"]);
});

test("an album-linked folder that never finished its first sync does not get a vanished directory back while it holds files", async (t) => {
  const { f, root } = await vanished(t);
  await f.store.setGallery(f.replica.scope, f.volume.id, { mode: "source", enabled: false, albums: [] });
  await f.store.db.runAsync("UPDATE folders SET initialized=0 WHERE id=?", f.volume.id);
  await f.replica.sync(true);
  await f.daemon.engine.cycle();
  assert.match(f.replica.error, /Local folder is unavailable/);
  assert.equal(fs.existsSync(root), false);
  assert.deepEqual(hubFiles(f), ["a.txt", "b.txt", "c.txt"]);
});

test("selecting again a folder whose directory vanished is refused, and Stop syncing then Start syncing downloads it again", async (t) => {
  const { f, root } = await vanished(t);
  const offered = () => f.client.state().catalog.volumes.find((v) => v.id === f.volume.id);
  await assert.rejects(f.replica.select(offered()), /Local folder is unavailable/);
  assert.equal(fs.existsSync(root), false);
  await f.replica.unselect(f.volume.id);
  await f.replica.select(offered());
  await f.replica.sync(true);
  await f.daemon.engine.cycle();
  assert.equal(f.replica.error, null);
  assert.deepEqual(fs.readdirSync(root).filter((name) => /\.txt$/.test(name)).sort(), ["a.txt", "b.txt", "c.txt"]);
  assert.deepEqual(hubFiles(f), ["a.txt", "b.txt", "c.txt"]);
});

test("a folder whose directory vanished does not stop another folder from syncing", async (t) => {
  const { f } = await vanished(t);
  const other = f.daemon.engine.store.addVolume("Notes");
  fs.writeFileSync(path.join(other.path, "note.txt"), "note");
  await f.daemon.engine.cycle();
  await f.client.refresh();
  await f.replica.select(f.client.state().catalog.volumes.find((v) => v.id === other.id));
  await f.replica.sync(true);
  assert.match(f.replica.error, /Local folder is unavailable/);
  assert.equal(fs.readFileSync(f.files.work(f.replica.scope, other.id, "note.txt"), "utf8"), "note");
});

test("a directory that vanishes between a file's check and its own subdirectory is not recreated by that file", async (t) => {
  const f = await phone(t);
  for (const name of ["a.txt", "b.txt", "c.txt"]) fs.writeFileSync(path.join(f.volume.path, name), name);
  await f.select();
  await f.replica.sync(true);
  const root = f.files.folder(f.replica.scope, f.volume.id);
  fs.mkdirSync(path.join(f.volume.path, "sub"));
  fs.writeFileSync(path.join(f.volume.path, "sub", "deep.txt"), "deep");
  await f.daemon.engine.cycle();
  const current = f.store.current.bind(f.store);
  f.store.current = async (scope, volume, name) => {
    if (name === "sub/deep.txt") fs.rmSync(root, { recursive: true, force: true });
    return current(scope, volume, name);
  };
  await f.replica.sync(false, { scheduled: true });
  f.store.current = current;
  assert.match(f.replica.error, /Local folder is unavailable/);
  assert.equal(fs.existsSync(root), false);
  await f.replica.sync(true);
  await f.daemon.engine.cycle();
  assert.equal(fs.existsSync(root), false);
  assert.deepEqual(hubFiles(f), ["a.txt", "b.txt", "c.txt", "sub"]);
});

test("a folder whose index holds only its .arcaignore still stops when its directory vanished", async (t) => {
  const f = await phone(t);
  fs.writeFileSync(path.join(f.volume.path, ".arcaignore"), "*.tmp\n");
  await f.select();
  await f.replica.sync(true);
  assert.equal(f.replica.error, null);
  const root = f.files.folder(f.replica.scope, f.volume.id);
  fs.rmSync(root, { recursive: true, force: true });
  await f.replica.sync(true);
  await f.daemon.engine.cycle();
  assert.match(f.replica.error, /Local folder is unavailable/);
  assert.equal(fs.existsSync(root), false);
  assert.equal(fs.readFileSync(path.join(f.volume.path, ".arcaignore"), "utf8"), "*.tmp\n");
});

test("fifty files finishing within a second refresh the screen twice at most, and the last one is always shown", async (t) => {
  const f = await phone(t);
  let changes = 0;
  f.replica.changed = () => changes++;
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  f.replica.progressAt = 0;
  for (let n = 1; n <= 50; n++)
    f.replica.reportProgress({ direction: "download", path: `file-${n}.txt`, bytesDone: 10, bytesTotal: 10 });
  assert.equal(changes, 1, "the first tick shows at once");
  assert.equal(f.replica.progress.path, "file-50.txt");
  t.mock.timers.tick(PROGRESS_MS - 1);
  assert.equal(changes, 1, "nothing more inside the second");
  t.mock.timers.tick(1);
  assert.equal(changes, 2, "one more refresh brings the last tick");
  f.replica.reportProgress({ direction: "download", path: "next.txt", bytesDone: 1, bytesTotal: 10 });
  assert.equal(changes, 2, "a tick inside the next second waits too");
  t.mock.timers.tick(PROGRESS_MS);
  assert.equal(changes, 3);
  assert.equal(f.replica.progress.path, "next.txt");
  t.mock.timers.setTime(Date.now() - 3600000);
  f.replica.reportProgress({ direction: "download", path: "after-clock-change.txt", bytesDone: 1, bytesTotal: 10 });
  t.mock.timers.tick(PROGRESS_MS);
  assert.equal(changes, 4, "a clock set back delays a refresh by a second at most");
});

const TOTALS_WRITERS = {
  select: (f, scope) => f.store.select(scope, { id: f.volume.id, name: "Podcasts renamed" }),
  issue: (f, scope) => f.store.issue(scope, f.volume.id, "Something changed"),
  resetCursor: (f, scope) => f.store.resetCursor(scope, f.volume.id),
  complete: (f, scope) => f.store.complete(scope, f.volume.id, 7),
  put: (f, scope) => f.store.put(scope, { volume: f.volume.id, path: "new.txt", hash: "a".repeat(64), size: 7, rev: 99, deleted: false }),
  applied: (f, scope) => f.store.applied(scope, { volume: f.volume.id, path: "applied.txt", hash: "b".repeat(64), size: 3, rev: 100, deleted: false }),
  setGallery: (f, scope) => f.store.setGallery(scope, f.volume.id, { mode: "source", enabled: false, albums: [] }),
  forgetExcluded: (f, scope) => f.store.forgetExcluded(scope, f.volume.id, (name) => name === "new.txt"),
  clearInterrupted: (f, scope) => f.store.clearInterrupted(scope),
  forgetFolder: (f, scope) => f.store.forgetFolder(scope, f.volume.id),
  reset: (f) => f.store.reset(),
};

async function touchCounter(f) {
  await f.store.db.execAsync(
    "CREATE TEMP TABLE touched(n INTEGER NOT NULL); INSERT INTO touched VALUES(0);" +
      ["files", "folders", "gallery_sources"]
        .flatMap((table) => ["INSERT", "UPDATE", "DELETE"].map((event) => `CREATE TEMP TRIGGER touched_${table}_${event} AFTER ${event} ON ${table} BEGIN UPDATE touched SET n=n+1; END;`))
        .join(""),
  );
  return async () => (await f.store.db.getFirstAsync("SELECT n FROM touched")).n;
}

test("folder totals survive writes that cannot change them and are recomputed after every method that can", async (t) => {
  const f = await phone(t);
  await f.select();
  const scope = f.replica.scope;
  const touched = await touchCounter(f);
  const totals = () => f.queries.filter((sql) => sql.includes(FOLDERS_SQL)).length;
  await f.store.folders(scope);
  f.queries.length = 0;
  await f.store.set("some-setting", { any: "value" });
  await f.store.set(f.replica.inventoryKey(f.volume.id), Date.now());
  await f.store.cacheHash("file:///x", { hash: "c".repeat(64), size: 1, mtime: 1 });
  await f.store.folders(scope);
  assert.equal(totals(), 0, "settings and file checks do not recompute the totals");
  let wrote = 0;
  for (const [name, write] of Object.entries(TOTALS_WRITERS)) {
    const before = await touched();
    const queries = totals();
    await write(f, scope);
    if ((await touched()) === before) continue;
    wrote++;
    await f.store.folders(scope);
    await f.store.folders(scope);
    assert.equal(totals(), queries + 1, `${name} recomputes the totals once`);
  }
  assert.ok(wrote >= 9, `${wrote} methods changed files, folders or album sources`);
});

test("every store method that writes files, folders or album sources is in the list the totals test runs", () => {
  const source = fs.readFileSync(new URL("../apps/mobile/src/replica-store.js", import.meta.url), "utf8");
  const methods = [...source.matchAll(/^  (?:async )?([a-zA-Z_]+)\([^)]*\) \{/gm)];
  const writers = methods
    .filter((match, index) => {
      const body = source.slice(match.index, methods[index + 1]?.index ?? source.length);
      return /\b(?:INTO|UPDATE(?: OR \w+)?|DELETE FROM)\s+(?:files|folders|gallery_sources|\$\{table\})\b/.test(body);
    })
    .map((match) => match[1])
    .filter((name) => !["init", "forgetStreamedLibrary"].includes(name));
  assert.ok(writers.length >= 8, `${writers.length} direct writers found`);
  for (const name of writers) assert.ok(name in TOTALS_WRITERS, `${name} writes those tables: add it to TOTALS_WRITERS`);
});

test("a Stop syncing that fails halfway leaves the folder's totals as they were, not as they looked mid-way", async (t) => {
  const f = await phone(t);
  fs.writeFileSync(path.join(f.volume.path, "a.txt"), "a");
  await f.select();
  await f.replica.sync(true);
  const scope = f.replica.scope;
  const before = (await f.store.folders(scope))[0].files;
  assert.equal(before, 1);
  const real = f.store.db;
  let seenMidway = null;
  f.store.db = new Proxy(real, {
    get(target, key) {
      if (key !== "runAsync") return target[key];
      return async (sql, ...values) => {
        if (/DELETE FROM scan_cache/.test(sql)) {
          seenMidway = (await f.store.folders(scope))[0]?.files ?? "gone";
          throw new Error("database or disk is full");
        }
        return target.runAsync(sql, ...values);
      };
    },
  });
  await assert.rejects(f.store.forgetFolder(scope, f.volume.id), /disk is full/);
  f.store.db = real;
  assert.notEqual(seenMidway, null, "the failure happened inside the transaction");
  assert.equal((await f.store.folders(scope))[0].files, 1, "the rollback is what the screen shows");
});
