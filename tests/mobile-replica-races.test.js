import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Replica } from "../apps/mobile/src/replica.js";
import { ReplicaStore } from "../apps/mobile/src/replica-store.js";
import { createClient } from "../apps/mobile/src/client.js";
import { TransferSession, shouldStopSync } from "../apps/mobile/src/transfer-session.js";
import { init } from "../packages/daemon/storage.js";
import { start } from "../packages/daemon/server.js";

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arca-mobile-races-")),
    home = path.join(root, "hub");
  init(home, { port: 0 });
  const daemon = await start(home, { timer: false });
  const base = `http://127.0.0.1:${daemon.port}`;
  const db = new DatabaseSync(path.join(root, "mobile.sqlite"));
  const desktops = [];
  t.after(async () => {
    for (const n of desktops) await n.close();
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
    cached = null;
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
    fetcher: (url, options) =>
      fetch(url.replace("https://fixture.invalid", base), options),
  });
  const local = path.join(root, "mobile");
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
      fs.rmSync(path.join(local, s, "folders", v), { recursive: true, force: true }),
    copy: async (a, b) => fs.copyFileSync(a, b),
    clearStaged: async () => {},
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
    async *walk(root, prefix = "", includePrivate = false) {
      for (const e of fs.readdirSync(root, { withFileTypes: true })) {
        if (!includePrivate && e.name.startsWith(".arca-")) continue;
        const p = path.join(root, e.name);
        if (e.isDirectory()) {
          yield { path: prefix + e.name, uri: p, size: 0, directory: true };
          yield* this.walk(p, prefix + e.name + "/", includePrivate);
        } else yield { path: prefix + e.name, uri: p, size: fs.statSync(p).size };
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
  const phone = (name) => files.work(replica.scope, volume.id, name);
  const hubFile = (name) => path.join(volume.path, ...name.split("/"));
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  const list = (directory) => {
    const out = [];
    const walk = (relative) => {
      for (const e of fs.readdirSync(path.join(directory, ...relative.split("/").filter(Boolean)), { withFileTypes: true })) {
        if (e.name === ".arca-volume") continue;
        const name = relative ? `${relative}/${e.name}` : e.name;
        out.push(e.isDirectory() ? `${name}/` : name);
        if (e.isDirectory()) walk(name);
      }
    };
    if (fs.existsSync(directory)) walk("");
    return out.sort();
  };
  return {
    daemon,
    volume,
    replica,
    store,
    files,
    phone,
    hubFile,
    write,
    phoneList: () => list(files.folder(replica.scope, volume.id)),
    hubRow: (name) => daemon.engine.store.current(volume.id, name),
    async selectAll() {
      await daemon.engine.cycle();
      await client.refresh();
      await replica.select(client.state().catalog.volumes[0]);
      await replica.sync();
      assert.equal(replica.error, null);
    },
    async sync() {
      await replica.sync();
      return replica.error;
    },
    async desktop(name) {
      const dhome = path.join(root, name);
      init(dhome, { name, role: "replica", port: 0 });
      const n = await start(dhome, { timer: false });
      desktops.push(n);
      const api = async (port, route, data, credential) => {
        const r = await fetch(`http://127.0.0.1:${port}${route}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${credential}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(data),
        });
        const body = await r.json();
        if (!r.ok) throw new Error(body.error);
        return body;
      };
      const added = await api(daemon.port, "/v1/devices", { name, role: "replica" }, daemon.engine.config.adminToken);
      await api(n.port, "/v1/connect", { url: base, token: added.token }, n.engine.config.adminToken);
      await api(n.port, "/v1/select", { id: volume.id }, n.engine.config.adminToken);
      n.sync = () => n.engine.exclusive(() => n.engine.cycle());
      n.file = (relative) => path.join(n.engine.store.volume(volume.id).path, ...relative.split("/"));
      return n;
    },
  };
}

test("M4 a file the phone adds under a directory deleted elsewhere revives it instead of freezing the folder", async (t) => {
  const f = await fixture(t);
  f.write(f.hubFile("proj/one.txt"), "1");
  await f.selectAll();
  const desk = await f.desktop("desk");
  await desk.sync();
  fs.rmSync(desk.file("proj"), { recursive: true });
  await desk.sync();
  f.write(f.phone("proj/new.txt"), "phone-new");
  assert.equal(await f.sync(), null);
  assert.equal(f.hubRow("proj").deleted, 0);
  assert.equal(f.hubRow("proj/new.txt").deleted, 0);
  f.write(f.hubFile("later.txt"), "later");
  await f.daemon.engine.cycle();
  assert.equal(await f.sync(), null);
  assert.deepEqual(f.phoneList(), ["later.txt", "proj/", "proj/new.txt"]);
  assert.deepEqual(await f.store.applying(f.replica.scope, f.volume.id), []);
  await desk.sync();
  assert.equal(fs.readFileSync(desk.file("proj/new.txt"), "utf8"), "phone-new");
});

test("M11 a remote directory deletion clears OS metadata and transfer leftovers on the phone", async (t) => {
  const f = await fixture(t);
  f.write(f.hubFile("album/a.jpg"), "a");
  await f.selectAll();
  const desk = await f.desktop("desk");
  await desk.sync();
  f.write(f.phone("album/.DS_Store"), "x");
  f.write(f.phone("album/.arca-transfer-0000"), "partial");
  fs.rmSync(desk.file("album"), { recursive: true });
  await desk.sync();
  assert.equal(await f.sync(), null);
  assert.equal(await f.sync(), null);
  assert.deepEqual(f.phoneList(), []);
});

test("M11 a directory holding only excluded content stays as unmanaged local content", async (t) => {
  const f = await fixture(t);
  f.write(f.hubFile("proj/a.txt"), "a");
  await f.selectAll();
  f.write(f.phone("proj/node_modules/x.js"), "excluded");
  fs.rmSync(f.hubFile("proj"), { recursive: true });
  await f.daemon.engine.cycle();
  assert.equal(await f.sync(), null);
  assert.equal(await f.sync(), null);
  assert.equal(fs.readFileSync(f.phone("proj/node_modules/x.js"), "utf8"), "excluded");
  assert.equal(f.hubRow("proj").deleted, 1, "leftovers never revive the directory");
});

test("M12 an edit made while the phone downloads a replacement is kept as a conflict copy", async (t) => {
  const f = await fixture(t);
  f.write(f.hubFile("note.txt"), "base");
  await f.selectAll();
  f.write(f.hubFile("note.txt"), "hub-v2");
  await f.daemon.engine.cycle();
  const download = f.replica.download.bind(f.replica);
  f.replica.download = async (hash, size) => {
    const object = await download(hash, size);
    fs.writeFileSync(f.phone("note.txt"), "PHONE-EDIT-DURING-DOWNLOAD");
    return object;
  };
  await f.sync();
  f.replica.download = download;
  assert.equal(fs.readFileSync(f.phone("note.txt"), "utf8"), "hub-v2");
  const kept = f.phoneList().filter((name) => name.startsWith("note.txt.conflict-"));
  assert.equal(kept.length, 1);
  assert.equal(fs.readFileSync(f.phone(kept[0]), "utf8"), "PHONE-EDIT-DURING-DOWNLOAD");
  assert.equal(await f.sync(), null);
  assert.equal(fs.readFileSync(f.hubFile(kept[0]), "utf8"), "PHONE-EDIT-DURING-DOWNLOAD");
});

test("M13 the phone deleting a directory that gained a file elsewhere gets a conflict and pulls the file", async (t) => {
  const f = await fixture(t);
  f.write(f.hubFile("proj/one.txt"), "1");
  await f.selectAll();
  const desk = await f.desktop("desk");
  await desk.sync();
  f.write(desk.file("proj/new.txt"), "desk-new");
  await desk.sync();
  fs.rmSync(f.phone("proj"), { recursive: true });
  f.write(f.hubFile("other.txt"), "unrelated hub change");
  await f.daemon.engine.cycle();
  assert.equal(await f.sync(), null);
  assert.equal(await f.sync(), null);
  assert.equal(f.hubRow("proj").deleted, 0);
  assert.equal(f.hubRow("proj/one.txt").deleted, 1);
  assert.deepEqual(f.phoneList(), ["other.txt", "proj/", "proj/new.txt"]);
});

test("R2 the phone's edit wins over a deletion made first on another device", async (t) => {
  const f = await fixture(t);
  f.write(f.hubFile("note.txt"), "base");
  await f.selectAll();
  const desk = await f.desktop("desk");
  await desk.sync();
  fs.unlinkSync(desk.file("note.txt"));
  await desk.sync();
  f.write(f.phone("note.txt"), "phone-edit");
  assert.equal(await f.sync(), null);
  assert.equal(await f.sync(), null);
  assert.equal(f.hubRow("note.txt").deleted, 0);
  assert.deepEqual(f.phoneList(), ["note.txt"]);
  await desk.sync();
  assert.equal(fs.readFileSync(desk.file("note.txt"), "utf8"), "phone-edit");
});

test("R3 a phone case-only rename racing a desktop edit keeps the edit without a conflict copy", async (t) => {
  const f = await fixture(t);
  f.write(f.hubFile("Note.txt"), "base");
  await f.selectAll();
  const desk = await f.desktop("desk");
  await desk.sync();
  const moved = path.join(path.dirname(f.phone("Note.txt")), "moving");
  fs.renameSync(f.phone("Note.txt"), moved);
  fs.renameSync(moved, f.phone("note.txt"));
  f.write(desk.file("Note.txt"), "desk-edit");
  await desk.sync();
  assert.equal(await f.sync(), null);
  assert.equal(await f.sync(), null);
  await desk.sync();
  assert.deepEqual(f.phoneList(), ["note.txt"]);
  assert.equal(fs.readFileSync(f.phone("note.txt"), "utf8"), "desk-edit");
  assert.equal(
    f.daemon.engine.store.rows(f.volume.id).filter((row) => row.path.includes(".conflict-")).length,
    0,
  );
});

test("R1 one row the phone cannot write leaves the rest of the folder syncing and retries", async (t) => {
  const f = await fixture(t);
  f.write(f.hubFile("locked.txt"), "v1");
  f.write(f.hubFile("free.txt"), "v1");
  await f.selectAll();
  f.write(f.hubFile("locked.txt"), "v2");
  f.write(f.hubFile("free.txt"), "v2");
  await f.daemon.engine.cycle();
  const replace = f.files.replace;
  f.files.replace = async (from, to) => {
    if (to === f.phone("locked.txt")) throw new Error("File is locked");
    return replace(from, to);
  };
  assert.match(await f.sync(), /locked\.txt: File is locked/);
  assert.equal(fs.readFileSync(f.phone("free.txt"), "utf8"), "v2");
  f.files.replace = replace;
  assert.equal(await f.sync(), null);
  assert.equal(fs.readFileSync(f.phone("locked.txt"), "utf8"), "v2");
  assert.deepEqual(await f.store.applying(f.replica.scope, f.volume.id), []);
});

test("F2 a journaled row superseded by a newer head is discarded instead of replayed", async (t) => {
  const f = await fixture(t);
  f.write(f.hubFile("note.txt"), "v1");
  await f.selectAll();
  const current = await f.store.current(f.replica.scope, f.volume.id, "note.txt");
  await f.store.journal(f.replica.scope, { ...current, rev: current.rev - 1, hash: "0".repeat(64) });
  assert.equal(await f.sync(), null);
  assert.deepEqual(await f.store.applying(f.replica.scope, f.volume.id), []);
  assert.equal(fs.readFileSync(f.phone("note.txt"), "utf8"), "v1");
});

test("F6 a forced scan sweeps orphan transfer temporaries from the phone's folder", async (t) => {
  const f = await fixture(t);
  f.write(f.hubFile("note.txt"), "v1");
  await f.selectAll();
  const orphan = path.join(path.dirname(f.phone("note.txt")), `.arca-transfer-${"a".repeat(64)}`);
  fs.writeFileSync(orphan, "partial");
  await f.replica.sync(true);
  assert.equal(f.replica.error, null);
  assert.equal(fs.existsSync(orphan), false);
});

test("M11 a remote directory deletion keeps phone .arca- files that are not transfer temporaries", async (t) => {
  const f = await fixture(t);
  f.write(f.hubFile("album/a.jpg"), "a");
  await f.selectAll();
  f.write(f.phone("album/.arca-notes"), "mine");
  fs.rmSync(f.hubFile("album"), { recursive: true });
  await f.daemon.engine.cycle();
  await f.sync();
  await f.sync();
  assert.equal(fs.readFileSync(f.phone("album/.arca-notes"), "utf8"), "mine");
  assert.equal(fs.existsSync(f.phone("album/a.jpg")), false);
});

test("M14 a cycle suspended by backgrounding before its lease runs again when the app returns", async (t) => {
  const f = await fixture(t);
  f.write(f.hubFile("first.txt"), "1");
  await f.selectAll();
  let visible = true,
    leases = 0;
  f.replica.transfer = new TransferSession({
    start: async () => {
      leases++;
    },
    stop: async () => {},
    update: async () => {},
    visible: () => visible,
  });
  f.write(f.hubFile("later.txt"), "later");
  await f.daemon.engine.cycle();
  const refresh = f.replica.refreshCatalog.bind(f.replica);
  let backgrounded = false;
  f.replica.refreshCatalog = async () => {
    const answer = await refresh();
    if (!backgrounded) {
      backgrounded = true;
      visible = false;
      if (shouldStopSync("background", f.replica.transfer.active)) f.replica.suspend();
    }
    return answer;
  };
  const suspended = f.replica.sync(false, { scheduled: true });
  while (!backgrounded) await new Promise((resolve) => setImmediate(resolve));
  visible = true;
  const resumed = f.replica.sync(false, { scheduled: true });
  await suspended;
  await resumed;
  assert.equal(leases, 1);
  assert.equal(fs.readFileSync(f.phone("later.txt"), "utf8"), "later");
  assert.equal(f.replica.error, null);
});

test("M15 a cycle whose end-of-cycle notice fails still tells the UI it is no longer busy", async (t) => {
  const f = await fixture(t);
  await f.selectAll();
  const seen = [];
  f.replica.changed = () => seen.push(f.replica.busy);
  f.replica.notify = async () => {
    throw new Error("notification failed");
  };
  await f.replica.sync().catch(() => {});
  assert.ok(seen.length > 1);
  assert.equal(seen.at(-1), false);
});

test("M16 a cycle cut short before the hub answered stops reporting checking once it ends", async (t) => {
  const f = await fixture(t);
  await f.selectAll();
  let release, ended = false;
  const gate = new Promise((resolve) => (release = resolve));
  f.replica.transfer = {
    active: false,
    begin: async () => false,
    end: async () => {
      if (f.replica.busy) return;
      ended = true;
      await gate;
    },
  };
  f.replica.connectionChecked = false;
  f.replica.refreshCatalog = async () => {
    throw Object.assign(new Error("Another request is running"), { code: "CLIENT_BUSY" });
  };
  const run = f.replica.sync().catch(() => {});
  while (!ended) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.replica.checking, false);
  release();
  await run;
});

test("selecting a folder needs its size plus headroom free, not twice its size", async () => {
  const GB = 1024 ** 3;
  const selected = [];
  const phone = (free) => ({
    scope: "hub",
    files: { free: async () => free, mkdir: async () => {}, folder: () => "/f" },
    store: { get: async () => false, select: async (scope, volume) => selected.push(volume.id) },
    requireActiveReplica: async () => {},
    space: Replica.prototype.space,
    changed() {},
  });
  await Replica.prototype.select.call(phone(40 * GB), { id: "photos", bytes: 26 * GB });
  assert.deepEqual(selected, ["photos"], "26 GB of photos fit in 40 GB free");
  await assert.rejects(
    Replica.prototype.select.call(phone(26 * GB + 128 * 1024 ** 2), { id: "big", bytes: 26 * GB }),
    /Not enough storage/,
    "a folder that does not fit with headroom is still refused",
  );
});
