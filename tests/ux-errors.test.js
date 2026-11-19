import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { init } from "../packages/daemon/storage.js";
import { start } from "../packages/daemon/server.js";
import { ACCESS_LOST } from "../packages/daemon/engine.js";
import { errorNotice } from "../apps/desktop/src/notice-contract.js";

async function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arca-ux-errors-"));
  const nodes = [];
  t.after(async () => {
    for (const n of nodes.reverse()) await n.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  async function node(name, role) {
    const home = path.join(root, name);
    init(home, { name, role, port: 0 });
    const n = await start(home, { timer: false });
    nodes.push(n);
    n.call = async (route, data, token = n.engine.config.adminToken) => {
      const r = await fetch(`http://127.0.0.1:${n.port}${route}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Arca-Directories": "1",
          "X-Arca-Path-Transitions": "1",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(data),
      });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    };
    n.api = async (route, data) => {
      const { status, body } = await n.call(route, data);
      if (status >= 400) throw Object.assign(new Error(body.error), { status });
      return body;
    };
    n.sync = () => n.engine.exclusive(() => n.engine.cycle());
    return n;
  }
  const hub = await node("hub", "hub");
  const volume = await hub.api("/v1/volumes", { name: "Documents" });
  const connect = async (name) => {
    const replica = await node(name, "replica");
    const invite = await hub.api("/v1/devices", { name, role: "replica" });
    await replica.api("/v1/connect", { url: `http://127.0.0.1:${hub.port}`, token: invite.token });
    await replica.api("/v1/select", { id: volume.id });
    replica.invite = invite;
    return replica;
  };
  return { root, hub, volume, connect, node };
}

test("a replica whose access is revoked during a scan reports the lost access", async (t) => {
  const { hub, volume, connect } = await setup(t);
  const replica = await connect("desk");
  await replica.sync();
  fs.writeFileSync(path.join(replica.engine.store.volume(volume.id).path, "new.txt"), "new");
  const scan = replica.engine.scanner.scan.bind(replica.engine.scanner);
  replica.engine.scanner.scan = async (...args) => {
    const disk = await scan(...args);
    await hub.api("/v1/revoke", { id: replica.invite.id });
    return disk;
  };
  await replica.sync().catch(() => {});
  const status = replica.engine.status();
  assert.equal(status.phase, "unlinked");
  assert.equal(replica.engine.error, ACCESS_LOST);
  assert.deepEqual(status.volumes.filter((v) => /Hub 401|Cannot read/.test(v.sync?.error || "")), []);
});

test("a replica that loses its access between the catalog and the folder pass reports it instead of a null read", async (t) => {
  const { hub, connect } = await setup(t);
  const replica = await connect("laptop");
  await replica.sync();
  const metadata = replica.engine.metadata.bind(replica.engine);
  replica.engine.metadata = async (route, ...rest) => {
    const answer = await metadata(route, ...rest);
    if (route === "/v1/catalog") {
      await hub.api("/v1/revoke", { id: replica.invite.id });
      replica.engine.clearHubConnection();
    }
    return answer;
  };
  const error = await replica.sync().then(() => null, (error) => error);
  assert.doesNotMatch(String(error?.message ?? ""), /Cannot read properties/);
  assert.equal(replica.engine.error, ACCESS_LOST);
});

test("a hub refusing a pairing code or a credential never answers the browser with its own 401", async (t) => {
  const { hub, node } = await setup(t);
  const replica = await node("server", "replica");
  const url = `http://127.0.0.1:${hub.port}`;
  const code = await replica.call("/v1/connect", { url, code: "P-000000" });
  assert.notEqual(code.status, 401, code.body.error);
  assert.ok(code.status >= 400 && code.status < 500, code.body.error);
  const token = await replica.call("/v1/connect", { url, token: "a".repeat(64) });
  assert.equal(token.status, 409, token.body.error);
  assert.match(token.body.error, /refused this device's credential/);
});

test("a replica deleting on the hub in a plain folder is told which libraries allow it", async (t) => {
  const { hub, volume, connect } = await setup(t);
  const replica = await connect("phone-like");
  fs.writeFileSync(path.join(hub.engine.store.volume(volume.id).path, "a.txt"), "a");
  await hub.sync();
  const answer = await hub.call("/v1/delete-file", { volume: volume.id, path: "a.txt" }, replica.invite.token);
  assert.equal(answer.status, 403);
  assert.match(answer.body.error, /video and audio libraries/);
  assert.equal(hub.engine.store.current(volume.id, "a.txt")?.deleted, 0);
});

test("a revoked replica's own routes that reach the hub never answer the browser with 401", async (t) => {
  const { hub, connect } = await setup(t);
  const replica = await connect("server");
  await replica.sync();
  await hub.api("/v1/revoke", { id: replica.invite.id });
  for (const route of ["/v1/video/art?volume=x&key=y", "/v1/machines"]) {
    const r = await fetch(`http://127.0.0.1:${replica.port}${route}`, {
      headers: { Authorization: `Bearer ${replica.engine.config.adminToken}` },
    });
    assert.notEqual(r.status, 401, route);
  }
});

test("lost access and a refused credential become a revoked-access notice that offers pairing again", () => {
  for (const message of [
    ACCESS_LOST,
    "The hub refused this device's credential. Pair it again with a new code.",
    "The hub at that address does not accept this device: it was removed there. Pair this device again from that hub.",
  ]) {
    const notice = errorNotice(message);
    assert.equal(notice.action, "pair", message);
    assert.match(notice.title, /Hub (access revoked|sign-in required)/, message);
  }
  assert.equal(errorNotice(ACCESS_LOST).title, "Hub access revoked");
});
