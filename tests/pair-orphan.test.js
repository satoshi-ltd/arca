import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { init } from "../packages/daemon/storage.js";
import { start } from "../packages/daemon/server.js";

test("a pairing the hub accepted survives a failed catalog request, and the retry needs no new code", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arca-pair-orphan-"));
  const nodes = [];
  t.after(async () => {
    for (const n of nodes.reverse()) await n.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const node = async (name, role) => {
    init(path.join(root, name), { name, role, port: 0 });
    const n = await start(path.join(root, name), { timer: false });
    nodes.push(n);
    n.call = async (route, data) => {
      const r = await fetch(`http://127.0.0.1:${n.port}${route}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${n.engine.config.adminToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    };
    return n;
  };
  const hub = await node("hub", "hub");
  const replica = await node("desk", "replica");
  const { code } = (await hub.call("/v1/pairing", { name: "desk" })).body;
  const url = `http://127.0.0.1:${hub.port}`;
  const real = globalThis.fetch;
  let failed = false;
  globalThis.fetch = (target, options) => {
    if (!failed && String(target) === `${url}/v1/catalog`) {
      failed = true;
      return Promise.reject(new TypeError("fetch failed"));
    }
    return real(target, options);
  };
  t.after(() => (globalThis.fetch = real));
  const first = await replica.call("/v1/connect", { url, code });
  assert.ok(failed, "the catalog request failed once");
  assert.notEqual(first.status, 200);
  const retry = await replica.call("/v1/connect", { url, code });
  assert.equal(retry.status, 200, retry.body.error);
  assert.equal(replica.engine.config.hub?.id, hub.engine.config.id);
  assert.equal(replica.engine.config.pendingPairing, undefined);
  const devices = hub.engine.store.db.prepare("SELECT count(*) AS n FROM devices WHERE revoked=0").get().n;
  assert.equal(devices, 1, "the hub keeps one registration, not an orphan beside a second one");
});

test("a saved pairing the hub has since removed does not spend the new code's first attempt", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arca-pair-stale-"));
  const nodes = [];
  t.after(async () => {
    for (const n of nodes.reverse()) await n.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const node = async (name, role) => {
    init(path.join(root, name), { name, role, port: 0 });
    const n = await start(path.join(root, name), { timer: false });
    nodes.push(n);
    n.call = async (route, data) => {
      const r = await fetch(`http://127.0.0.1:${n.port}${route}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${n.engine.config.adminToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    };
    return n;
  };
  const hub = await node("hub", "hub");
  const replica = await node("desk", "replica");
  const url = `http://127.0.0.1:${hub.port}`;
  const real = globalThis.fetch;
  let failed = false;
  globalThis.fetch = (target, options) => {
    if (!failed && String(target) === `${url}/v1/catalog`) {
      failed = true;
      return Promise.reject(new TypeError("fetch failed"));
    }
    return real(target, options);
  };
  t.after(() => (globalThis.fetch = real));
  const first = (await hub.call("/v1/pairing", { name: "desk" })).body.code;
  await replica.call("/v1/connect", { url, code: first });
  assert.ok(replica.engine.config.pendingPairing);
  const orphan = hub.engine.store.db.prepare("SELECT id FROM devices WHERE revoked=0").get().id;
  assert.equal((await hub.call("/v1/revoke", { id: orphan })).status, 200);
  const second = (await hub.call("/v1/pairing", { name: "desk" })).body.code;
  const answer = await replica.call("/v1/connect", { url, code: second });
  assert.equal(answer.status, 200, answer.body.error);
  assert.equal(replica.engine.config.pendingPairing, undefined);
});
