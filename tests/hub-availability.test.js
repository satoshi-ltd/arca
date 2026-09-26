import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import http from "node:http";
import path from "node:path";
import { init, digest } from "../packages/daemon/storage.js";
import { start } from "../packages/daemon/server.js";

async function setup(t, options = { timer: false }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arca-availability-"));
  const nodes = [];
  t.after(async () => {
    for (const n of nodes.reverse()) await n.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  async function node(name, role, extra = {}) {
    const home = path.join(root, name);
    init(home, { name, role, port: 0 });
    const n = await start(home, { ...options, ...extra });
    nodes.push(n);
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
      if (!r.ok)
        throw Object.assign(new Error(body.error), {
          status: r.status,
          code: body.code,
        });
      return body;
    };
    n.sync = () => n.engine.exclusive(() => n.engine.cycle());
    return n;
  }
  const hub = await node("hub", "hub");
  const volume = await hub.api("/v1/volumes", { name: "Documents" });
  const connect = async (name, extra) => {
    const replica = await node(name, "replica", extra);
    const invite = await hub.api("/v1/devices", { name, role: "replica" });
    await replica.api("/v1/connect", {
      url: `http://127.0.0.1:${hub.port}`,
      token: invite.token,
    });
    await replica.api("/v1/select", { id: volume.id });
    replica.invite = invite;
    return replica;
  };
  return { root, hub, volume, connect, node };
}
const write = (n, v, name, content) => {
  const file = path.join(n.engine.store.volume(v.id).path, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};
const read = (n, v, name) =>
  fs.readFileSync(path.join(n.engine.store.volume(v.id).path, name), "utf8");
async function listen(t, server) {
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const drop = () => {
    for (const socket of sockets) socket.destroy();
  };
  t.after(
    () =>
      new Promise((resolve) => {
        drop();
        server.close(resolve);
      }),
  );
  return { url: `http://127.0.0.1:${server.address().port}`, drop };
}
const silent = async (t) => {
  let connections = 0;
  const control = await listen(
    t,
    net.createServer(() => {
      connections++;
    }),
  );
  return Object.assign(control, { connections: () => connections });
};
function throttle(from, to, rate) {
  from.on("data", (chunk) => {
    to.write(chunk);
    if (!rate) return;
    from.pause();
    setTimeout(() => from.resume(), (chunk.length / rate) * 1000);
  });
  from.on("end", () => to.end());
  from.on("error", () => to.destroy());
}
async function relay(t, target, control = {}) {
  const server = http.createServer((req, res) => {
    if (control.refuse) return req.socket.destroy();
    const upstream = http.request(
      new URL(req.url, target),
      { method: req.method, headers: req.headers },
      (answer) => {
        res.writeHead(answer.statusCode, answer.headers);
        if (control.cut?.(req))
          return answer.once("data", (chunk) => {
            res.write(chunk.subarray(0, 16), () => res.socket.destroy());
            answer.destroy();
          });
        throttle(answer, res, control.down);
      },
    );
    upstream.on("error", () => res.socket?.destroy());
    res.on("close", () => upstream.destroy());
    throttle(req, upstream, control.up);
  });
  control.url = (await listen(t, server)).url;
  return control;
}
// Stalled hub requests only time out after 10–25 s; a few seconds proves an action never waited behind one.
const within = async (limit, work) => {
  const started = Date.now();
  const result = await work();
  assert.ok(Date.now() - started < limit, `took ${Date.now() - started} ms`);
  return result;
};
const waitFor = async (condition, limit = 5000) => {
  const started = Date.now();
  while (!(await condition())) {
    if (Date.now() - started > limit) assert.fail("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

test("hub-only actions answer at once while the hub is known to be unavailable", async (t) => {
  const { root, hub, volume, connect } = await setup(t);
  write(hub, volume, "note.txt", "one");
  await hub.sync();
  const replica = await connect("fail-fast");
  await replica.sync();
  const rev = replica.engine.store.current(volume.id, "note.txt").rev;
  replica.engine.config.hub.url = "http://127.0.0.1:1";
  await assert.rejects(replica.sync());
  assert.equal(replica.engine.hubUnavailable, true);
  replica.engine.config.hub.url = (await silent(t)).url;
  for (const [route, body] of [
    ["/v1/restore", { volume: volume.id, path: "note.txt", rev }],
    ["/v1/select", { id: volume.id }],
    [
      "/v1/conflict-choice",
      {
        volume: volume.id,
        path: "note.txt.conflict-x",
        choice: "original",
        originalRev: rev,
        conflictRev: rev,
      },
    ],
    ["/v1/gallery/link", { volume: volume.id }],
  ])
    await within(3000, () =>
      assert.rejects(replica.api(route, body), {
        status: 503,
        message: "Hub unavailable. Try again when it is reachable.",
      }),
    );
  await within(3000, () => replica.api("/v1/settings", { name: "Renamed" }));
  const backup = await within(3000, () =>
    replica.api("/v1/backup", {
      enabled: true,
      path: path.join(root, "backup"),
    }),
  );
  assert.equal(backup.enabled, true);
  assert.equal(
    backup.error,
    "Backup enabled; waiting for the hub to acknowledge",
  );
  assert.equal(replica.engine.config.backup.enabled, true);
});

test("local file actions never queue behind a pending hub action or a paused report", async (t) => {
  const { hub, volume, connect } = await setup(t);
  write(hub, volume, "a.txt", "a");
  write(hub, volume, "b.txt", "b");
  await hub.sync();
  const replica = await connect("responsive");
  await replica.sync();
  const url = replica.engine.config.hub.url;
  const stalled = await silent(t);
  replica.engine.config.hub.url = stalled.url;
  const rev = (name) => replica.engine.store.current(volume.id, name).rev;
  const restore = replica
    .api("/v1/restore", { volume: volume.id, path: "a.txt", rev: rev("a.txt") })
    .catch((error) => error);
  await waitFor(() => stalled.connections() > 0);
  await within(3000, () =>
    replica.api("/v1/rename-file", {
      volume: volume.id,
      path: "b.txt",
      name: "c.txt",
      rev: rev("b.txt"),
    }),
  );
  assert.equal(read(replica, volume, "c.txt"), "b");
  replica.engine.config.hub.url = "http://127.0.0.1:1";
  await assert.rejects(replica.sync());
  replica.engine.config.hub.url = (await silent(t)).url;
  replica.engine.setPaused(true);
  replica.engine.lastReport = null;
  const paused = replica.sync();
  await within(3000, () =>
    replica.api("/v1/delete-file", {
      volume: volume.id,
      path: "a.txt",
      rev: rev("a.txt"),
    }),
  );
  await paused;
  replica.engine.config.hub.url = url;
  stalled.drop();
  assert.ok((await restore) instanceof Error);
});

test("a gateway error or a lost body marks the hub offline instead of failing the folder", async (t) => {
  const { hub, volume, connect } = await setup(t);
  write(hub, volume, "a.txt", "first");
  await hub.sync();
  const replica = await connect("gateway");
  await replica.sync();
  const machines = await replica.api("/v1/machines");
  const url = replica.engine.config.hub.url;
  const gateway = await listen(
    t,
    http.createServer((req, res) => {
      res.writeHead(502);
      res.end("Bad gateway");
    }),
  );
  replica.engine.config.hub.url = gateway.url;
  await assert.rejects(replica.sync(), (error) => error.hubUnavailable);
  assert.equal(replica.engine.status().phase, "offline");
  assert.equal(replica.engine.status().volumes[0].sync.state, "pending");
  const saved = await replica.api("/v1/machines");
  assert.equal(saved.offline, true);
  assert.deepEqual(saved.machines, machines.machines);
  await assert.rejects(replica.sync());
  assert.equal(replica.engine.status().phase, "offline");

  replica.engine.config.hub.url = url;
  write(hub, volume, "large.bin", crypto.randomBytes(512 * 1024));
  await hub.sync();
  const cut = await relay(t, url, {
    cut: (req) => req.url.startsWith("/v1/blobs/"),
  });
  replica.engine.config.hub.url = cut.url;
  await assert.rejects(replica.sync(), (error) => error.hubUnavailable);
  assert.equal(replica.engine.status().phase, "offline");
  assert.notEqual(replica.engine.status().volumes[0].sync.state, "error");
  replica.engine.config.hub.url = url;
  await replica.sync();
  assert.equal(replica.engine.status().phase, "idle");
  assert.equal(
    fs.statSync(
      path.join(replica.engine.store.volume(volume.id).path, "large.bin"),
    ).size,
    512 * 1024,
  );
});

test("a slow optional view keeps the replica online", async (t) => {
  const { hub, connect } = await setup(t);
  const replica = await connect("slow-view");
  await replica.sync();
  const fetcher = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (url, options) =>
    url === `http://127.0.0.1:${hub.port}/v1/machines`
      ? Promise.reject(new DOMException("View timed out", "TimeoutError"))
      : fetcher(url, options),
  );
  assert.equal((await replica.api("/v1/machines")).offline, true);
  assert.equal(replica.engine.status().phase, "idle");
  assert.equal(replica.engine.hubUnavailable, false);
});

test("slow links upload in smaller blocks and download without a total deadline", async (t) => {
  const { hub, volume, connect } = await setup(t);
  const replica = await connect("slow-link", { transferIdleMs: 600 });
  await replica.sync();
  const url = replica.engine.config.hub.url;
  const upload = crypto.randomBytes(2 * 1024 * 1024);
  write(replica, volume, "upload.bin", upload);
  const slowUp = await relay(t, url, { up: 2 * 1024 * 1024 });
  replica.engine.config.hub.url = slowUp.url;
  const phases = new Set();
  const sample = setInterval(
    () => phases.add(replica.engine.status().phase),
    25,
  );
  try {
    await replica.sync();
  } finally {
    clearInterval(sample);
  }
  assert.equal(replica.engine.error, null);
  assert.equal(phases.has("offline"), false);
  assert.ok(replica.engine.uploadChunk < upload.length);
  assert.equal(
    hub.engine.store.current(volume.id, "upload.bin").hash,
    digest(upload),
  );

  replica.engine.config.hub.url = url;
  const download = crypto.randomBytes(1024 * 1024);
  write(hub, volume, "download.bin", download);
  await hub.sync();
  const slowDown = await relay(t, url, { down: 768 * 1024 });
  replica.engine.transferIdleMs = 400;
  replica.engine.config.hub.url = slowDown.url;
  await replica.sync();
  assert.equal(replica.engine.error, null);
  assert.equal(
    digest(
      fs.readFileSync(
        path.join(replica.engine.store.volume(volume.id).path, "download.bin"),
      ),
    ),
    digest(download),
  );
});

test("a successful event poll ends the offline backoff at once", async (t) => {
  const { hub, volume, connect } = await setup(t);
  const replica = await connect("returning", {
    timer: true,
    eventRetryMs: 100,
  });
  const link = await relay(t, replica.engine.config.hub.url);
  replica.engine.config.hub.url = link.url;
  await replica.api("/v1/sync", { background: true });
  await waitFor(
    () => replica.engine.status().phase === "idle" && replica.engine.lastSync,
  );
  link.refuse = true;
  await replica.api("/v1/sync", { background: true });
  await waitFor(() => replica.engine.status().phase === "offline");
  write(replica, volume, "offline-edit.txt", "made offline");
  replica.engine.work.mark(volume.id);
  link.refuse = false;
  write(hub, volume, "hub-edit.txt", "changes the event cursor");
  await hub.sync();
  await waitFor(
    () => hub.engine.store.current(volume.id, "offline-edit.txt"),
    10000,
  );
  assert.equal(read(hub, volume, "offline-edit.txt"), "made offline");
});

test("interrupted desktop snapshots release their hub leases", async (t) => {
  const { hub, volume, connect } = await setup(t);
  for (let i = 0; i < 3; i++) write(hub, volume, `file-${i}.txt`, String(i));
  await hub.sync();
  const replica = await connect("lease-release");
  const download = replica.engine.download.bind(replica.engine);
  let failures = 9;
  replica.engine.download = async (...args) => {
    if (failures-- > 0) throw new Error("Local disk refused the file");
    return download(...args);
  };
  for (let i = 0; i < 9; i++) await assert.rejects(replica.sync());
  const sessions = () =>
    hub.engine.store.db
      .prepare("SELECT COUNT(*) AS n FROM snapshot_sessions WHERE owner=?")
      .get(replica.invite.id).n;
  assert.equal(sessions(), 0);
  await replica.sync();
  assert.equal(replica.engine.error, null);
  assert.equal(read(replica, volume, "file-2.txt"), "2");
});

test("a snapshot request abandoned during the hub scan leaves no lease", async (t) => {
  const { hub, volume, connect } = await setup(t);
  write(hub, volume, "a.txt", "a");
  await hub.sync();
  const replica = await connect("abandoned");
  const scan = hub.engine.scanHub.bind(hub.engine);
  let entered, release;
  const started = new Promise((resolve) => (entered = resolve));
  const gate = new Promise((resolve) => (release = resolve));
  t.mock.method(hub.engine, "scanHub", async (...args) => {
    entered();
    await gate;
    return scan(...args);
  });
  const controller = new AbortController();
  const pending = fetch(
    `http://127.0.0.1:${hub.port}/v1/snapshot?volume=${volume.id}`,
    {
      headers: {
        Authorization: `Bearer ${replica.invite.token}`,
        "X-Arca-Directories": "1",
        "X-Arca-Path-Transitions": "1",
      },
      signal: controller.signal,
    },
  ).catch(() => null);
  await started;
  controller.abort();
  await pending;
  await new Promise((resolve) => setTimeout(resolve, 50));
  release();
  await hub.engine.tail;
  await waitFor(
    () =>
      hub.engine.store.db
        .prepare("SELECT COUNT(*) AS n FROM snapshot_sessions")
        .get().n === 0,
  );
});

test("offline file pages use the newer local revision and missing files answer clearly", async (t) => {
  const { hub, volume, connect } = await setup(t);
  write(hub, volume, "page.txt", "one");
  await hub.sync();
  const replica = await connect("offline-page");
  await replica.sync();
  const route = `/v1/history?volume=${volume.id}&path=page.txt&limit=50`;
  await replica.api(route);
  write(hub, volume, "page.txt", "two");
  await hub.sync();
  await replica.sync();
  const current = replica.engine.store.current(volume.id, "page.txt");
  replica.engine.config.hub.url = "http://127.0.0.1:1";
  await assert.rejects(replica.sync());
  const saved = await replica.api(route);
  assert.equal(saved.offline, true);
  assert.equal(saved.versions[0].rev, current.rev);
  await replica.api("/v1/rename-file", {
    volume: volume.id,
    path: "page.txt",
    name: "renamed.txt",
    rev: saved.versions[0].rev,
  });
  for (const [route, body] of [
    ["/v1/rename-file", { name: "again.txt" }],
    ["/v1/delete-file", {}],
  ])
    await assert.rejects(
      replica.api(route, {
        volume: volume.id,
        path: "page.txt",
        rev: current.rev,
        ...body,
      }),
      (error) =>
        error.status === 409 &&
        error.message ===
          "This file is no longer in the local copy. The list updates after the next sync.",
    );
});

test("a crash-interrupted remote change is completed before the hub answers", async (t) => {
  const { hub, volume, connect } = await setup(t);
  write(hub, volume, "journal.txt", "base");
  await hub.sync();
  const replica = await connect("journal");
  await replica.sync();
  write(hub, volume, "journal.txt", "newer");
  await hub.sync();
  const row = hub.engine.store.current(volume.id, "journal.txt");
  fs.copyFileSync(
    hub.engine.store.blob(row.hash),
    replica.engine.store.blob(row.hash),
  );
  const local = replica.engine.store.current(volume.id, "journal.txt");
  replica.engine.store.queue(row, local.hash);
  replica.engine.config.hub.url = "http://127.0.0.1:1";
  await assert.rejects(replica.sync());
  assert.equal(read(replica, volume, "journal.txt"), "newer");
  assert.equal(
    replica.engine.store.db.prepare("SELECT COUNT(*) AS n FROM pending").get()
      .n,
    0,
  );
});

test("a finished upload is verified from the bytes the hub stored, after a restart or corruption", async (t) => {
  const { hub, connect } = await setup(t);
  const replica = await connect("stored-hash");
  const put = (hash, size, offset, content) =>
    fetch(
      `http://127.0.0.1:${hub.port}/v1/uploads/${hash}?offset=${offset}&size=${size}`,
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${replica.invite.token}` },
        body: content,
      },
    ).then(async (r) => ({ status: r.status, ...(await r.json()) }));
  const part = (hash) => path.join(hub.engine.store.uploads, `${replica.invite.id}-${hash}.part`);
  const data = crypto.randomBytes(3000);
  const hash = digest(data);
  assert.equal((await put(hash, data.length, 0, data.subarray(0, 1000))).offset, 1000);
  assert.equal((await put(hash, data.length, 1000, data.subarray(1000))).complete, true);
  assert.deepEqual(fs.readFileSync(hub.engine.store.blob(hash)), data);

  const resumed = crypto.randomBytes(2000);
  const resumedHash = digest(resumed);
  fs.writeFileSync(part(resumedHash), resumed.subarray(0, 1000));
  assert.equal((await put(resumedHash, resumed.length, 1000, resumed.subarray(1000))).complete, true, "a part left by a restart resumes");
  assert.deepEqual(fs.readFileSync(hub.engine.store.blob(resumedHash)), resumed);

  const stored = Buffer.from("abcdef");
  const storedHash = digest(stored);
  assert.equal((await put(storedHash, 6, 0, stored.subarray(0, 3))).status, 200);
  fs.writeFileSync(part(storedHash), "BAD");
  const corrupt = await put(storedHash, 6, 3, stored.subarray(3));
  assert.equal(corrupt.status, 409, "bytes damaged on disk between blocks are never accepted");
  assert.match(corrupt.error, /hash mismatch/);
  assert.equal(fs.existsSync(hub.engine.store.blob(storedHash)), false);

  const wrong = crypto.randomBytes(1000);
  const expected = digest(crypto.randomBytes(1000));
  const rejected = await put(expected, wrong.length, 0, wrong);
  assert.match(rejected.error, /hash mismatch/);
  assert.equal(fs.existsSync(hub.engine.store.blob(expected)), false);
});

test("an event wait refused by a LAN policy change answers 412 like other LAN requests", async (t) => {
  const { hub, volume } = await setup(t);
  hub.engine.config.network = { allowLanHttp: true };
  const invite = await hub.api("/v1/devices", { name: "lan", role: "replica" });
  const lan = http.createServer((req, res) => {
    Object.defineProperty(req.socket, "remoteAddress", {
      value: "192.168.1.50",
      configurable: true,
    });
    hub.network.apiHandler(req, res);
  });
  const { url } = await listen(t, lan);
  const events = (after) =>
    fetch(`${url}/v1/events${after ? `?after=${after}` : ""}`, {
      headers: { Authorization: `Bearer ${invite.token}` },
    });
  const { cursor } = await (await events()).json();
  const waiting = events(cursor);
  await new Promise((resolve) => setTimeout(resolve, 50));
  hub.engine.config.network = { allowLanHttp: false };
  hub.engine.renameShare(volume.id, "Renamed");
  const refused = await waiting;
  assert.equal(refused.status, 412);
  assert.equal((await refused.json()).error, "LAN access disabled");
});

test("linking a gallery from a replica saves the folder's gallery flag", async (t) => {
  const { hub, volume, connect } = await setup(t);
  const replica = await connect("gallery-link");
  await replica.sync();
  assert.deepEqual(
    await replica.api("/v1/gallery/link", { volume: volume.id }),
    {
      ok: true,
    },
  );
  const saved = JSON.parse(
    fs.readFileSync(replica.engine.store.configPath, "utf8"),
  );
  assert.equal(
    saved.catalog.find((folder) => folder.id === volume.id).gallery,
    true,
  );
  assert.ok(
    hub.engine.store.db
      .prepare("SELECT 1 FROM gallery_folders WHERE volume=?")
      .get(volume.id),
  );
});

test("an interrupted push never proposes again what the hub already accepted", async (t) => {
  const { hub, volume, connect } = await setup(t);
  const mac = await connect("mac");
  await mac.sync();
  for (let i = 0; i < 6; i++) write(mac, volume, `photos/${i}.jpg`, `photo ${i}`);
  const json = mac.engine.json.bind(mac.engine);
  const proposed = [];
  let allowed = 4;
  mac.engine.json = async (route, body, ...rest) => {
    if (route === "/v1/propose") {
      if (!allowed--) throw new Error("Hub 500: interrupted");
      proposed.push(body.path);
    }
    return json(route, body, ...rest);
  };
  await assert.rejects(mac.sync(), /interrupted/);
  const accepted = proposed.splice(0);
  assert.equal(accepted.length, 4);
  allowed = Infinity;
  await mac.sync();
  assert.equal(mac.engine.error, null);
  const all = ["photos", ...[0, 1, 2, 3, 4, 5].map((i) => `photos/${i}.jpg`)];
  assert.deepEqual(
    proposed.sort(),
    all.filter((name) => !accepted.includes(name)).sort(),
    "accepted proposals are recorded before the cycle completes",
  );
  for (let i = 0; i < 6; i++)
    assert.equal(
      hub.engine.store.current(volume.id, `photos/${i}.jpg`).hash,
      digest(`photo ${i}`),
    );
});

test("a desktop replica sends each photo's file date so undated photos keep their original month", async (t) => {
  const { hub, volume, connect } = await setup(t);
  const mac = await connect("mac");
  await mac.sync();
  write(mac, volume, "immich/uuid.jpg", "not really a jpeg");
  write(mac, volume, "notes.txt", "text");
  const file = path.join(mac.engine.store.volume(volume.id).path, "immich/uuid.jpg");
  const original = new Date("2023-03-19T00:21:52.000Z");
  fs.utimesSync(file, original, original);
  const json = mac.engine.json.bind(mac.engine);
  const bodies = [];
  mac.engine.json = async (route, body, ...rest) => {
    if (route === "/v1/propose") bodies.push(body);
    return json(route, body, ...rest);
  };
  await mac.sync();
  assert.equal(
    bodies.find((body) => body.path === "immich/uuid.jpg").modified,
    "2023-03-19T00:21:52.000Z",
  );
  assert.equal(bodies.find((body) => body.path === "notes.txt").modified, undefined);
  assert.equal(
    hub.engine.store.db
      .prepare("SELECT modified FROM gallery_metadata WHERE hash=?")
      .get(digest("not really a jpeg")).modified,
    "2023-03-19T00:21:52.000Z",
  );
  const other = await connect("other");
  await other.sync();
  const localDate = (replica) =>
    replica.engine.store.db
      .prepare("SELECT modified FROM gallery_metadata WHERE hash=?")
      .get(digest("not really a jpeg"))?.modified;
  assert.equal(localDate(mac), "2023-03-19T00:21:52.000Z", "the source replica keeps the date it sent");
  assert.equal(localDate(other), "2023-03-19T00:21:52.000Z", "another replica receives the hub's date");
  other.engine.config.hub.url = "http://127.0.0.1:1";
  const { galleryDate } = await import("../packages/core/gallery-date.js");
  assert.equal(galleryDate("immich/uuid.jpg", null, null, localDate(other)).date, "2023-03-19T00:21:52.000Z", "the date is stored locally, so it holds offline");
});
