import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { digest, init, token, validPath, Store, SCHEMA_VERSION } from "../packages/daemon/storage.js";
import { start } from "../packages/daemon/server.js";
import { moveToTrash } from "../packages/daemon/trash.js";
import { applyFolderRetention, cleanupTransfers } from "../packages/daemon/maintenance.js";

async function hub(t, { role } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-hardening-"));
  init(home, { port: 0, ...(role ? { role } : {}) });
  const d = await start(home, { timer: false });
  t.after(async () => {
    await d.close();
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const call = (route, { method = "POST", body, token: credential = d.engine.config.adminToken, headers = {}, signal } = {}) =>
    fetch(`http://127.0.0.1:${d.port}${route}`, {
      method,
      signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${credential}`, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const pair = async (body) => {
    const { code } = await (await call("/v1/pairing", { body: { name: "device" } })).json();
    return call("/pair", { body: { code, ...body } });
  };
  return { d, home, call, pair };
}

test("an unexpected error answers Internal error and keeps its text on the hub", async (t) => {
  const { d, call } = await hub(t);
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args.join(" "));
  t.after(() => (console.error = original));
  d.engine.deleteFile = () => {
    throw Object.assign(new Error("ENOENT: no such file or directory, open '/srv/arca/secret/a.txt'"), { code: "ENOENT" });
  };
  const answer = await call("/v1/delete-file", { body: { volume: "x", path: "a.txt", rev: 1 } });
  assert.equal(answer.status, 500);
  assert.deepEqual(await answer.json(), { error: "Internal error" });
  assert.match(logged.join("\n"), /\/srv\/arca\/secret\/a\.txt/);
  const refused = await call("/v1/delete-file", { body: { volume: "missing", path: "a.txt", rev: 1 }, token: "wrong" });
  assert.equal(refused.status, 401, "errors that carry a status keep their message");
});

test("pairing names refuse control characters and paths refuse names over 255 bytes", async (t) => {
  const { call } = await hub(t);
  const { code } = await (await call("/v1/pairing", { body: { name: "TV" } })).json();
  assert.equal((await call("/pair", { body: { code, name: "tv\u0007\nbell" } })).status, 400);
  assert.equal((await call("/pair", { body: { code, name: "salon-tv", kind: "player" } })).status, 201, "the refused name did not spend the code");
  assert.doesNotThrow(() => validPath("a/" + "b".repeat(255)));
  assert.throws(() => validPath("a/" + "b".repeat(256)), /at most 255 bytes/);
  assert.throws(() => validPath("é".repeat(128)), /255 bytes/, "bytes, not characters");
  assert.doesNotThrow(() => validPath("é".repeat(127)));
});

test("connecting refuses a hub catalog with unusable fields", async (t) => {
  const { call } = await hub(t, { role: "replica" });
  let catalog;
  const fake = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(catalog));
  });
  await new Promise((resolve) => fake.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => fake.close(resolve)));
  const connect = () => call("/v1/connect", { body: { url: `http://127.0.0.1:${fake.address().port}`, token: "a".repeat(64) } });
  for (const bad of [
    { protocol: 1, id: "hub", name: "Casa" },
    { protocol: 1, id: "hub", name: "Casa", volumes: "nope" },
    { protocol: 1, id: "hub", name: "Casa\u0000", volumes: [] },
    { protocol: 1, id: "../hub", name: "Casa", volumes: [] },
    { protocol: 1, id: "hub", name: "Casa", volumes: [{ id: "a b", name: "x" }] },
    { protocol: 1, id: "hub", name: "Casa", volumes: [{ id: "abc", name: "x".repeat(300) }] },
    null,
  ]) {
    catalog = bad;
    const answer = await connect();
    assert.ok([400, 502].includes(answer.status), JSON.stringify(bad));
    assert.notEqual(answer.status, 500, JSON.stringify(bad));
  }
});

test("the state directory is private even when it already existed", { skip: process.platform === "win32" }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-mode-"));
  try {
    fs.chmodSync(home, 0o755);
    init(home, { port: 0 });
    assert.equal(fs.statSync(home).mode & 0o777, 0o700);
    fs.chmodSync(home, 0o755);
    new Store(home).db.close();
    assert.equal(fs.statSync(home).mode & 0o777, 0o700, "opening an existing state repairs it too");
  } finally {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("one credential holds at most four waiting requests", async (t) => {
  const { d, call, pair } = await hub(t);
  const { token: replica } = await (await pair({ name: "phone" })).json();
  const controllers = [];
  const waits = [];
  const cursor = (await (await call("/v1/events?after=0", { method: "GET", token: replica, signal: AbortSignal.timeout(2000) })).json()).cursor;
  for (let n = 0; n < 4; n++) {
    const controller = new AbortController();
    controllers.push(controller);
    waits.push(call(`/v1/events?after=${cursor}`, { method: "GET", token: replica, signal: controller.signal }).catch(() => null));
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
  const fifth = await call(`/v1/events?after=${cursor}`, { method: "GET", token: replica, signal: AbortSignal.timeout(3000) });
  assert.equal(fifth.status, 429);
  const other = await (await pair({ name: "other" })).json();
  const mine = new AbortController();
  const separate = call(`/v1/events?after=${cursor}`, { method: "GET", token: other.token, signal: mine.signal }).catch(() => null);
  await new Promise((resolve) => setTimeout(resolve, 200));
  for (const controller of [...controllers, mine]) controller.abort();
  await Promise.all([...waits, separate]);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.notEqual((await call(`/v1/events?after=${cursor}`, { method: "GET", token: replica, signal: AbortSignal.timeout(500) }).catch(() => ({ status: 0 }))).status, 429, "a finished wait frees its place");
});

test("web approvals are capped per address and a session ends with the approver that granted it", async (t) => {
  const { d, call } = await hub(t);
  const base = `http://127.0.0.1:${d.port}`;
  const secret = token();
  d.engine.store.db.prepare("INSERT INTO devices(id,name,token_hash,role) VALUES('mac','Mac',?,'replica')").run(digest(secret));
  assert.equal((await call("/v1/web-approvers", { body: { id: "mac", enabled: true } })).status, 200);
  const auth = (body) =>
    fetch(base + "/auth/approval", {
      method: "POST",
      headers: { Origin: base, "Content-Type": "application/json", "User-Agent": "Test browser" },
      body: JSON.stringify(body),
    });
  const first = await (await auth({ action: "create" })).json();
  await auth({ action: "create" });
  await auth({ action: "create" });
  const capped = await auth({ action: "create" });
  assert.equal(capped.status, 429);
  assert.match((await capped.json()).error, /from this address/);
  assert.equal((await call("/v1/web-approvals", { body: { id: first.id, decision: "allow" }, token: secret })).status, 200);
  const granted = await auth({ ...first, action: "poll" });
  const cookie = granted.headers.get("set-cookie").split(";")[0];
  const status = () => fetch(base + "/v1/status", { headers: { cookie } });
  assert.equal((await status()).status, 200);
  assert.equal((await call("/v1/web-approvers", { body: { id: "mac", enabled: false } })).status, 200);
  assert.equal((await status()).status, 401, "disabling the approver ends the session it granted");
  const again = await (await auth({ action: "create" })).json().catch(() => ({}));
  assert.ok(again.id || again.error);
});

test("revoking a device ends the web sessions it approved, and a code sign-in session survives", async (t) => {
  const { d, call } = await hub(t);
  const base = `http://127.0.0.1:${d.port}`;
  const secret = token();
  d.engine.store.db.prepare("INSERT INTO devices(id,name,token_hash,role) VALUES('mac','Mac',?,'replica')").run(digest(secret));
  await call("/v1/web-approvers", { body: { id: "mac", enabled: true } });
  const auth = (body) =>
    fetch(base + "/auth/approval", { method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const request = await (await auth({ action: "create" })).json();
  await call("/v1/web-approvals", { body: { id: request.id, decision: "allow" }, token: secret });
  const cookie = (await auth({ ...request, action: "poll" })).headers.get("set-cookie").split(";")[0];
  const { issueWebCode } = await import("../packages/daemon/web.js");
  const { code } = issueWebCode(d.engine.store.home);
  const login = await fetch(base + "/auth/login", { method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify({ code }) });
  const typed = login.headers.get("set-cookie").split(";")[0];
  assert.equal((await call("/v1/revoke", { body: { id: "mac" } })).status, 200);
  assert.equal((await fetch(base + "/v1/status", { headers: { cookie } })).status, 401);
  assert.equal((await fetch(base + "/v1/status", { headers: { cookie: typed } })).status, 200);
});

test("a newer index schema is refused and an extra column never breaks an insert", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-schema-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  init(home, { port: 0 });
  const store = new Store(home);
  assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, SCHEMA_VERSION);
  store.db.exec("ALTER TABLE scan_cache ADD COLUMN later TEXT; ALTER TABLE audio_positions ADD COLUMN later TEXT; ALTER TABLE history_views ADD COLUMN later TEXT");
  store.db.prepare("INSERT OR REPLACE INTO scan_cache(path,signature,hash,size,verified) VALUES(?,?,?,?,?)").run("a", "s", "h", 1, 1);
  store.db.close();
  new Store(home).db.close();
  const raw = new DatabaseSync(path.join(home, "index.sqlite"));
  raw.exec(`PRAGMA user_version=${SCHEMA_VERSION + 1}`);
  raw.close();
  assert.throws(() => new Store(home), /newer version/);
});

test("the Windows Recycle Bin batches stay under the environment limit", async () => {
  const sizes = [];
  const execute = async (command, args, options) => sizes.push(JSON.stringify(JSON.parse(options.env.ARCA_TRASH)).length);
  const files = Array.from({ length: 50 }, (_, n) => `C:\\Users\\arca\\${"x".repeat(900)}-${n}`);
  await moveToTrash(files, { platform: "win32", execute });
  assert.ok(sizes.length >= 2, "long paths split into several batches");
  assert.ok(sizes.every((size) => size <= 30000));
  sizes.length = 0;
  await moveToTrash(files.slice(0, 5).map((file) => file.slice(0, 40)), { platform: "win32", execute });
  assert.equal(sizes.length, 1, "short paths stay in one batch");
  await assert.rejects(moveToTrash(["C:\\" + "y".repeat(31000)], { platform: "win32", execute }), /too long/);
});

test("object collection skips an object that is in use", async (t) => {
  const { d } = await hub(t);
  const store = d.engine.store;
  const object = path.join(store.objects, "a".repeat(64));
  fs.writeFileSync(object, "x");
  const old = new Date(Date.now() - 3 * 24 * 3600000);
  fs.utimesSync(object, old, old);
  const unlink = fs.unlinkSync;
  fs.unlinkSync = (file, ...rest) => {
    if (file === object) throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
    return unlink(file, ...rest);
  };
  try {
    assert.doesNotThrow(() => applyFolderRetention(store));
  } finally {
    fs.unlinkSync = unlink;
  }
  assert.equal(fs.existsSync(object), true, "the busy object stays for the next pass");
  applyFolderRetention(store);
  assert.equal(fs.existsSync(object), false, "and is collected once free");
});

test("an object is hashed once per signature, so status polls never re-read it", async (t) => {
  const { d, call } = await hub(t);
  const content = Buffer.from("object ".repeat(1000));
  const hash = digest(content);
  const file = d.engine.store.blob(hash);
  fs.writeFileSync(file, content);
  let reads = 0;
  const open = fs.createReadStream;
  fs.createReadStream = (target, ...rest) => {
    if (target === file) reads++;
    return open(target, ...rest);
  };
  t.after(() => (fs.createReadStream = open));
  const status = async () => (await (await call(`/v1/uploads/${hash}`, { method: "GET" })).json()).complete;
  assert.equal(await status(), true);
  assert.equal(await status(), true);
  assert.equal(await status(), true);
  assert.equal(reads, 1, "three polls read the object once");
  fs.writeFileSync(file, Buffer.from("damaged".repeat(1000)).subarray(0, content.length));
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(file, later, later);
  assert.equal(await status(), false, "a changed object is verified again and found damaged");
  assert.equal(reads, 2);
});

test("transfer cleanup skips a partial upload that is in use", async (t) => {
  const { d } = await hub(t);
  const store = d.engine.store;
  const part = path.join(store.uploads, "device-1.part");
  fs.writeFileSync(part, "x");
  const old = new Date(Date.now() - 9 * 24 * 3600000);
  fs.utimesSync(part, old, old);
  const unlink = fs.unlinkSync;
  fs.unlinkSync = (file, ...rest) => {
    if (file === part) throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
    return unlink(file, ...rest);
  };
  try {
    assert.equal(cleanupTransfers(store), 0);
  } finally {
    fs.unlinkSync = unlink;
  }
  assert.equal(cleanupTransfers(store), 1);
});

test("a player asking about a volume that does not exist still gets 404", async (t) => {
  const { call, pair } = await hub(t);
  const { token: player } = await (await pair({ kind: "player", name: "salon-tv" })).json();
  assert.equal((await call("/v1/delete-file", { body: { volume: "missing", path: "a.mp4", rev: 1 }, token: player })).status, 404);
});
