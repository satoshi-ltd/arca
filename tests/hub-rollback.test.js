import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { init } from "../packages/daemon/storage.js";
import { start } from "../packages/daemon/server.js";
import { HISTORY_BACK } from "../packages/daemon/engine.js";

async function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arca-rollback-"));
  const nodes = new Set();
  t.after(async () => {
    for (const n of [...nodes].reverse()) await n.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const open = async (home) => {
    const n = await start(home, { timer: false });
    nodes.add(n);
    n.home = home;
    n.api = async (route, data, credential = n.engine.config.adminToken) => {
      const r = await fetch(`http://127.0.0.1:${n.port}${route}`, {
        method: data === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${credential}`,
          "X-Arca-Directories": "1",
          "X-Arca-Path-Transitions": "1",
          "Content-Type": "application/json",
        },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      });
      const body = await r.json();
      if (!r.ok) throw Object.assign(new Error(body.error), { status: r.status });
      return body;
    };
    n.sync = () => n.engine.exclusive(() => n.engine.cycle());
    return n;
  };
  const node = (name, role) => {
    const home = path.join(root, name);
    init(home, { name, role, port: 0 });
    return open(home);
  };
  let hub = await node("hub", "hub");
  const volume = await hub.api("/v1/volumes", { name: "Documents" });
  const mac = await node("mac", "replica");
  const invite = await hub.api("/v1/devices", { name: "mac", role: "replica" });
  await mac.api("/v1/connect", { url: `http://127.0.0.1:${hub.port}`, token: invite.token });
  await mac.api("/v1/select", { id: volume.id });
  const trash = path.join(root, "trash");
  fs.mkdirSync(trash);
  mac.engine.moveToTrash = async (files) => {
    for (const [index, file] of files.entries())
      fs.renameSync(file, path.join(trash, `${Date.now()}-${index}-${path.basename(file)}`));
  };
  const folder = (n) => n.engine.store.volume(volume.id).path;
  const write = (n, name, content) => {
    const file = path.join(folder(n), name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  const read = (n, name) => fs.readFileSync(path.join(folder(n), name), "utf8");
  const names = (n) => fs.readdirSync(folder(n)).filter((name) => !name.startsWith(".arca")).sort();
  const kept = path.join(root, "kept");
  const remember = () => {
    hub.engine.store.historyEpoch({ flush: true });
    fs.mkdirSync(kept);
    hub.engine.store.db.exec(`VACUUM INTO '${path.join(kept, "index.sqlite").replaceAll("'", "''")}'`);
    fs.copyFileSync(path.join(hub.home, "history.json"), path.join(kept, "history.json"));
    fs.cpSync(folder(hub), path.join(kept, "files"), { recursive: true });
  };
  const closeHub = async () => {
    await hub.close();
    nodes.delete(hub);
    return hub.home;
  };
  const restore = async ({ history, files = true }) => {
    const working = folder(hub);
    const home = await closeHub();
    for (const suffix of ["", "-wal", "-shm"])
      fs.rmSync(path.join(home, `index.sqlite${suffix}`), { force: true, maxRetries: 10, retryDelay: 100 });
    fs.copyFileSync(path.join(kept, "index.sqlite"), path.join(home, "index.sqlite"));
    if (history) fs.copyFileSync(path.join(kept, "history.json"), path.join(home, "history.json"));
    if (files) {
      fs.rmSync(working, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      fs.cpSync(path.join(kept, "files"), working, { recursive: true });
    }
    hub = await open(home);
    mac.engine.config.hub.url = `http://127.0.0.1:${hub.port}`;
    mac.engine.store.saveConfig();
    return hub;
  };
  const pastCursor = async () => {
    for (let n = 0; hub.engine.store.revisionHead() <= mac.engine.work.state(volume.id).cursor; n++) {
      write(hub, `later-${n}.txt`, `later ${n}`);
      await hub.sync();
    }
  };
  return { root, volume, mac, write, read, names, remember, restore, closeHub, pastCursor, trash, hub: () => hub };
}

const divergeAfterCheckpoint = async (f) => {
  f.write(f.hub(), "doc.txt", "A");
  f.write(f.hub(), "same.txt", "same");
  await f.hub().sync();
  await f.mac.sync();
  f.remember();
  f.write(f.mac, "doc.txt", "B, written after the checkpoint");
  f.write(f.mac, "new.txt", "made after the checkpoint");
  await f.mac.sync();
  await f.hub().sync();
  assert.equal(f.read(f.hub(), "doc.txt"), "B, written after the checkpoint");
};

const wentBack = new RegExp(HISTORY_BACK.slice(0, 40));
const settlesWithoutLoss = async (f) => {
  await assert.rejects(f.mac.sync(), wentBack);
  assert.equal(f.read(f.mac, "doc.txt"), "B, written after the checkpoint", "nothing is replaced while the folder reports it");
  assert.equal(f.mac.engine.store.volume(f.volume.id).last_sync, null);
  await f.mac.sync();
  await f.hub().sync();
  await f.mac.sync();
  const conflict = f.names(f.mac).find((name) => name.startsWith("doc.txt.conflict-local-"));
  assert.ok(conflict, "the newer content is kept as a conflict copy");
  assert.equal(f.read(f.mac, conflict), "B, written after the checkpoint");
  assert.equal(f.read(f.mac, "doc.txt"), "A");
  assert.equal(f.read(f.mac, "new.txt"), "made after the checkpoint");
  assert.equal(f.read(f.mac, "same.txt"), "same");
  assert.equal(f.read(f.hub(), conflict), "B, written after the checkpoint", "and reaches the hub");
  assert.equal(f.read(f.hub(), "new.txt"), "made after the checkpoint");
  assert.equal(f.mac.engine.folderStates.get(f.volume.id).state, "synced");
  await f.mac.sync();
  assert.deepEqual(f.names(f.mac), f.names(f.hub()), "the report is not repeated and both sides agree");
};

test("a replica ahead of a hub restored whole to an earlier point keeps its newer files instead of reverting them", async (t) => {
  const f = await setup(t);
  await divergeAfterCheckpoint(f);
  const epoch = f.hub().engine.store.historyEpoch().epoch;
  const hub = await f.restore({ history: true });
  assert.equal(hub.engine.store.historyEpoch().epoch, epoch, "the restore brought the epoch file back too");
  assert.ok(f.mac.engine.work.state(f.volume.id).cursor > hub.engine.store.historyEpoch().head);
  await settlesWithoutLoss(f);
});

test("a hub whose index alone went back starts a new history epoch, and replicas reconcile even after it has advanced past them", async (t) => {
  const f = await setup(t);
  await divergeAfterCheckpoint(f);
  const before = f.hub().engine.store.historyEpoch();
  const hub = await f.restore({ history: false });
  const after = hub.engine.store.historyEpoch();
  assert.notEqual(after.epoch, before.epoch);
  assert.ok(after.head < before.head);
  await f.pastCursor();
  await settlesWithoutLoss(f);
});

test("a restarted hub keeps its history epoch and replicas keep syncing without a reconcile", async (t) => {
  const f = await setup(t);
  f.write(f.hub(), "doc.txt", "A");
  await f.hub().sync();
  await f.mac.sync();
  f.remember();
  const epoch = f.hub().engine.store.historyEpoch().epoch;
  const hub = await f.restore({ history: true });
  assert.equal(hub.engine.store.historyEpoch().epoch, epoch);
  f.write(hub, "doc.txt", "A2");
  await hub.sync();
  await f.mac.sync();
  assert.equal(f.read(f.mac, "doc.txt"), "A2");
  assert.equal(f.mac.engine.work.state(f.volume.id).epoch, epoch);
  assert.deepEqual(f.names(f.mac), ["doc.txt"]);
});

test("a hub row older than the revision a replica already accepted stops the pull before anything is replaced", async (t) => {
  const f = await setup(t);
  await divergeAfterCheckpoint(f);
  const hub = await f.restore({ history: true });
  await f.pastCursor();
  assert.equal(f.mac.engine.work.state(f.volume.id).epoch, hub.engine.store.historyEpoch().epoch, "neither the epoch nor the cursor tells");
  await settlesWithoutLoss(f);
});

test("a folder with interrupted writes is not forgotten until they finish", async (t) => {
  const f = await setup(t);
  f.write(f.hub(), "doc.txt", "A");
  await f.hub().sync();
  await f.mac.sync();
  const store = f.mac.engine.store;
  store.queue({ ...store.current(f.volume.id, "doc.txt") }, undefined);
  assert.throws(() => store.forgetIndex(f.volume.id), /interrupted writes must finish before this folder is linked to it again: doc\.txt$/);
  assert.ok(store.current(f.volume.id, "doc.txt"));
});

test("a folder that never completed a sync is protected too", async (t) => {
  const f = await setup(t);
  f.write(f.hub(), "doc.txt", "A");
  f.write(f.hub(), "blocked", "a file on the hub");
  await f.hub().sync();
  f.write(f.mac, "blocked/inner.txt", "a directory here");
  await assert.rejects(f.mac.sync(), /Could not sync/);
  assert.equal(f.mac.engine.store.volume(f.volume.id).last_sync, null);
  assert.equal(f.read(f.mac, "doc.txt"), "A");
  f.remember();
  f.write(f.mac, "doc.txt", "B, written after the checkpoint");
  await assert.rejects(f.mac.sync(), /Could not sync/);
  await f.hub().sync();
  assert.equal(f.read(f.hub(), "doc.txt"), "B, written after the checkpoint");
  await f.restore({ history: true });
  await assert.rejects(f.mac.sync(), wentBack);
  assert.equal(f.read(f.mac, "doc.txt"), "B, written after the checkpoint");
  await f.mac.sync().catch(() => {});
  await f.mac.sync().catch(() => {});
  assert.ok(
    f.names(f.mac).some((name) => name.startsWith("doc.txt") && f.read(f.mac, name) === "B, written after the checkpoint"),
    "the newer content is still on the replica",
  );
});

test("the hub's older exclusion rules are not applied before the folder is known to have gone back", async (t) => {
  const f = await setup(t);
  f.write(f.hub(), "doc.txt", "A");
  await f.hub().sync();
  await f.mac.sync();
  f.remember();
  f.write(f.hub(), ".arcaignore", "*.bak\n");
  await f.hub().sync();
  await f.mac.sync();
  assert.equal(f.read(f.mac, ".arcaignore"), "*.bak\n");
  await f.restore({ history: true });
  await f.pastCursor();
  await assert.rejects(f.mac.sync(), wentBack);
  assert.equal(f.read(f.mac, ".arcaignore"), "*.bak\n", "the replica's newer rules are still in place");
  await assert.rejects(f.mac.sync(), /\.arcaignore differs/, "and the relink stops on the difference instead of syncing under the old rules");
});

test("a hub that does not advertise its history is still caught by the first contradicting row", async (t) => {
  const f = await setup(t);
  await divergeAfterCheckpoint(f);
  const metadata = f.mac.engine.metadata.bind(f.mac.engine);
  f.mac.engine.metadata = async (route, ...rest) => {
    const answer = await metadata(route, ...rest);
    if (route === "/v1/catalog") delete answer.history;
    return answer;
  };
  await f.restore({ history: true });
  await settlesWithoutLoss(f);
});

test("an index restored under a working copy the hub still holds converges without losing anything", async (t) => {
  const f = await setup(t);
  await divergeAfterCheckpoint(f);
  const hub = await f.restore({ history: false, files: false });
  assert.equal(f.read(hub, "doc.txt"), "B, written after the checkpoint");
  await assert.rejects(f.mac.sync(), wentBack);
  for (let round = 0; round < 3; round++) {
    await f.mac.sync();
    await hub.sync();
  }
  for (const n of [f.mac, hub]) {
    assert.equal(f.read(n, "doc.txt"), "B, written after the checkpoint");
    assert.equal(f.read(n, "new.txt"), "made after the checkpoint");
    assert.equal(f.read(n, "same.txt"), "same");
  }
  assert.deepEqual(f.names(f.mac), f.names(hub));
});

test("a history file that cannot be read stops the hub instead of starting a new history", async (t) => {
  const f = await setup(t);
  f.write(f.hub(), "doc.txt", "A");
  await f.hub().sync();
  const store = f.hub().engine.store;
  const file = path.join(f.hub().home, "history.json");
  const { epoch } = store.historyEpoch({ flush: true });
  const text = fs.readFileSync(file, "utf8");
  const readFileSync = fs.readFileSync;
  store.savedHistory = null;
  fs.readFileSync = (target, ...rest) => {
    if (String(target).endsWith("history.json")) throw Object.assign(new Error("EIO: i/o error, read"), { code: "EIO" });
    return readFileSync(target, ...rest);
  };
  try {
    assert.throws(() => store.historyEpoch(), /EIO/);
  } finally {
    fs.readFileSync = readFileSync;
  }
  assert.equal(fs.readFileSync(file, "utf8"), text, "the file is left as it was");
  assert.equal(store.historyEpoch().epoch, epoch, "and the epoch survives once it reads again");
});

test("a hub that cannot read its history file refuses to start, frees its lock and keeps its epoch for the next start", async (t) => {
  const f = await setup(t);
  const home = await f.closeHub();
  const file = path.join(home, "history.json");
  const text = fs.readFileSync(file, "utf8");
  fs.rmSync(file);
  fs.mkdirSync(file);
  await assert.rejects(start(home, { timer: false }), /EISDIR/);
  assert.equal(fs.existsSync(path.join(home, "daemon.lock")), false);
  fs.rmdirSync(file);
  fs.writeFileSync(file, text);
  const again = await start(home, { timer: false });
  try {
    assert.equal(again.engine.store.historyEpoch().epoch, JSON.parse(text).epoch);
  } finally {
    await again.close();
  }
});

test("a head that could not be saved is written by the next flush", async (t) => {
  const f = await setup(t);
  const store = f.hub().engine.store;
  const file = path.join(f.hub().home, "history.json");
  f.write(f.hub(), "doc.txt", "A");
  await f.hub().sync();
  const saved = store.historyEpoch({ flush: true }).head;
  f.write(f.hub(), "more.txt", "more");
  await f.hub().sync();
  const head = store.revisionHead();
  assert.ok(head > saved);
  const renameSync = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (String(to).endsWith("history.json")) throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    return renameSync(from, to);
  };
  try {
    assert.equal(store.historyEpoch({ flush: true }).head, head, "the answer is still the real head");
  } finally {
    fs.renameSync = renameSync;
  }
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).head, saved);
  store.historyEpoch({ flush: true });
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).head, head);
});

test("Erase removes the history file and the next hub starts a new history", async (t) => {
  const f = await setup(t);
  f.write(f.hub(), "doc.txt", "A");
  await f.hub().sync();
  const store = f.hub().engine.store;
  const file = path.join(f.hub().home, "history.json");
  const { epoch } = store.historyEpoch({ flush: true });
  await f.hub().api("/v1/destroy-hub", { confirmed: true });
  assert.equal(fs.existsSync(file), false);
  assert.equal(store.savedHistory, null);
  assert.notEqual(store.historyEpoch().epoch, epoch);
});

test("a folder that never completed a sync reconciles when only the hub's index went back and the hub rewrote the same file", async (t) => {
  const f = await setup(t);
  f.write(f.hub(), "doc.txt", "A");
  f.write(f.hub(), "blocked", "a file on the hub");
  await f.hub().sync();
  f.write(f.mac, "blocked/inner.txt", "a directory here");
  await assert.rejects(f.mac.sync(), /Could not sync/);
  f.remember();
  f.write(f.mac, "doc.txt", "B, written after the checkpoint");
  await assert.rejects(f.mac.sync(), /Could not sync/);
  await f.hub().sync();
  const indexed = f.mac.engine.store.current(f.volume.id, "doc.txt").rev;
  const hub = await f.restore({ history: false });
  for (let n = 0; (hub.engine.store.current(f.volume.id, "doc.txt")?.rev ?? 0) <= indexed; n++) {
    f.write(hub, "doc.txt", `A${n}`);
    await hub.sync();
  }
  assert.equal(f.mac.engine.store.volume(f.volume.id).last_sync, null);
  await assert.rejects(f.mac.sync(), wentBack);
  assert.equal(f.read(f.mac, "doc.txt"), "B, written after the checkpoint");
  await f.mac.sync().catch(() => {});
  await f.mac.sync().catch(() => {});
  assert.ok(
    f.names(f.mac).some((name) => name.startsWith("doc.txt") && f.read(f.mac, name) === "B, written after the checkpoint"),
    "the newer content is still on the replica",
  );
});

test("stopping the hub writes the newest revision to the history file", async (t) => {
  const f = await setup(t);
  f.write(f.hub(), "doc.txt", "A");
  await f.hub().sync();
  const head = f.hub().engine.store.revisionHead();
  const home = await f.closeHub();
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, "history.json"), "utf8")).head, head);
});
