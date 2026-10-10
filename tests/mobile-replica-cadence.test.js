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
    fs.rmSync(root, { recursive: true, force: true });
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
    destroy: async () => fs.rmSync(local, { recursive: true, force: true }),
    folder: (s, v) => path.join(local, s, "folders", v),
    work: (s, v, p) => path.join(local, s, "folders", v, ...p.split("/")),
    object: (s, h) => path.join(local, s, "objects", h),
    partial: (s, h) => path.join(local, s, "partial", h),
    parent: path.dirname,
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
      fs.rmSync(path.join(local, s, "folders", v), { recursive: true, force: true }),
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
