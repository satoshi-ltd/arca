import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { digest, init } from "../packages/daemon/storage.js";
import { start } from "../packages/daemon/server.js";
import { playerRoute } from "../packages/daemon/machines.js";

async function hub(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-player-"));
  init(home, { port: 0 });
  const d = await start(home, { timer: false });
  t.after(async () => {
    await d.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const call = (route, { method = "POST", body, token = d.engine.config.adminToken } = {}) =>
    fetch(`http://127.0.0.1:${d.port}${route}`, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const pair = async (body) => {
    const { code } = await (await call("/v1/pairing", { body: { name: "TV" } })).json();
    return call("/pair", { body: { code, ...body } });
  };
  return { d, call, pair };
}

test("a device that pairs as a player is stored as one, and an unknown kind is refused before the code is spent", async (t) => {
  const { d, call, pair } = await hub(t);
  const { code } = await (await call("/v1/pairing", { body: { name: "TV" } })).json();
  assert.equal((await call("/pair", { body: { code, kind: "screen" } })).status, 400);
  const paired = await call("/pair", { body: { code, kind: "player", name: "salon-tv" } });
  assert.equal(paired.status, 201, "the refused kind did not spend the code");
  const answer = await paired.json();
  const role = (deviceId) => d.engine.store.db.prepare("SELECT role FROM devices WHERE id=?").get(deviceId).role;
  assert.equal(role(answer.id), "player");
  assert.equal(answer.role, "player", "the reply names the role, so a client never assumes one an older hub ignored");
  const replica = await (await pair({ name: "phone" })).json();
  assert.equal(role(replica.id), "replica", "a device that says nothing pairs as a replica");
  assert.equal(replica.role, "replica");
});

test("a player streams and reports, and every other route answers 403", async (t) => {
  const { call, pair } = await hub(t);
  const volume = await (await call("/v1/volumes", { body: { name: "Photos" } })).json();
  const { id, token } = await (await pair({ kind: "player", name: "salon-tv" })).json();
  const as = (route, options = {}) => call(route, { ...options, token });
  assert.equal((await as("/v1/catalog", { method: "GET" })).status, 200);
  const report = {
    machineId: id,
    name: "salon-tv",
    platform: "android",
    app: "Arca TV",
    version: "1.0.0",
    arch: "",
    kernelRelease: "",
    phase: "idle",
    uptimeSeconds: 0,
    selectedFolders: 1,
    indexedFiles: 0,
    indexedBytes: 0,
    lastSync: null,
    folderIds: [volume.id],
  };
  assert.equal((await as("/v1/machine-report", { body: report })).status, 200);
  const machine = (await (await call("/v1/machines", { method: "GET" })).json()).machines.find((m) => m.credentialId === id);
  assert.equal(machine.role, "player");
  assert.equal(machine.app, "Arca TV");
  assert.equal(machine.version, "1.0.0");
  assert.deepEqual(machine.folderIds, [volume.id]);
  for (const [route, method, body] of [
    ["/v1/volumes", "POST", { name: "Mine" }],
    ["/v1/devices", "POST", { name: "other" }],
    ["/v1/pairing", "POST", { name: "other" }],
    ["/v1/conflict", "POST", { volume: volume.id, path: "a.conflict-x.txt", choice: "original" }],
    ["/v1/gallery/register", "POST", { volume: volume.id }],
    ["/v1/gallery/delete", "POST", { volume: volume.id }],
    ["/v1/audio-position", "POST", {}],
    ["/v1/backup-ack", "POST", { enabled: false }],
    ["/v1/machines", "GET"],
    ["/v1/activity", "GET"],
    [`/v1/changes?volume=${volume.id}&after=0`, "GET"],
    ["/v1/uploads/0000", "PUT"],
    ["/v1/blobs/0000", "PUT"],
  ])
    assert.equal((await as(route, { method, body })).status, 403, `${method} ${route}`);
  assert.equal(
    (await call("/v1/web-approvers", { body: { id, enabled: true } })).status,
    400,
    "a player never approves web sign-ins",
  );
});

test("a player streams a blob with a range, as arca TV plays audio", async (t) => {
  const { d, call, pair } = await hub(t);
  const replica = await (await pair({ name: "phone" })).json();
  const player = await (await pair({ kind: "player", name: "salon-tv" })).json();
  const data = Buffer.from("abcdefghijklmnop");
  const hash = digest(data);
  const put = await fetch(`http://127.0.0.1:${d.port}/v1/uploads/${hash}?offset=0&size=${data.length}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${replica.token}` },
    body: data,
  });
  assert.equal(put.status, 200);
  const r = await fetch(`http://127.0.0.1:${d.port}/v1/blobs/${hash}`, { headers: { Authorization: `Bearer ${player.token}`, Range: "bytes=5-" } });
  assert.equal(r.status, 206);
  assert.equal(await r.text(), "fghijklmnop");
  for (const route of ["/v1/gallery?volume=x", "/v1/music/library?volume=x"])
    assert.notEqual((await call(route, { method: "GET", token: player.token })).status, 403, route);
});

test("a player leaves the hub with its own credential and its row is gone", async (t) => {
  const { d, call, pair } = await hub(t);
  const keep = await (await pair({ kind: "player", name: "bedroom-tv" })).json();
  const leaving = await (await pair({ kind: "player", name: "salon-tv" })).json();
  const count = (id) => d.engine.store.db.prepare("SELECT count(*) AS n FROM devices WHERE id=?").get(id).n;
  assert.equal(count(leaving.id), 1);
  const left = await call("/v1/leave", { body: { id: keep.id }, token: leaving.token });
  assert.equal(left.status, 200);
  assert.equal(count(leaving.id), 0, "it deleted its own credential");
  assert.equal(count(keep.id), 1, "a body naming another device changes nothing");
  assert.equal((await call("/v1/catalog", { method: "GET", token: leaving.token })).status, 401, "the credential no longer works");
});

test("the player allow-list holds only reads, its own report and leaving", () => {
  for (const route of ["/v1/catalog", "/v1/gallery", "/v1/gallery/preview", "/v1/music/library", "/v1/music/cover", "/v1/blobs/abc"])
    assert.equal(playerRoute("GET", route), true, route);
  assert.equal(playerRoute("POST", "/v1/machine-report"), true);
  assert.equal(playerRoute("POST", "/v1/leave"), true);
  assert.equal(playerRoute("GET", "/v1/leave"), false);
  for (const [method, route] of [["GET", "/v1/search"], ["GET", "/v1/gallery/info"], ["POST", "/v1/catalog"], ["PUT", "/v1/blobs/abc"], ["GET", "/v1/machines"], ["GET", "/v1/history"], ["DELETE", "/v1/blobs/abc"], ["GET", "/v1/machine-report"]])
    assert.equal(playerRoute(method, route), false, `${method} ${route}`);
});
