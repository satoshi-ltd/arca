import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { init } from "../packages/daemon/storage.js";
import { start } from "../packages/daemon/server.js";
import { inspectSetupRoot } from "../packages/daemon/setup.js";

function state() {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "arca-onboarding-")),
  );
  return root;
}
async function post(node, route, body) {
  return fetch(`http://127.0.0.1:${node.port}${route}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${node.engine.config.adminToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}
test("setup root inspection is read-only, checks existing ancestors, rejects nonempty roots and state overlap", (t) => {
  const root = state(),
    home = path.join(root, "state"),
    destination = path.join(root, "new", "folders");
  fs.mkdirSync(home);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const info = inspectSetupRoot(destination, home);
  assert.equal(info.root, destination);
  assert.ok(info.freeBytes > 0);
  assert.equal(fs.existsSync(destination), false);
  assert.throws(() => inspectSetupRoot(root, home), /state directory/);
  const occupied = path.join(root, "occupied");
  fs.mkdirSync(occupied);
  fs.writeFileSync(path.join(occupied, "keep"), "kept");
  assert.throws(() => inspectSetupRoot(occupied, home), /empty or new/);
  assert.equal(fs.readFileSync(path.join(occupied, "keep"), "utf8"), "kept");
});
test("desktop saves accepted pairing before catalog failure and completes root setup without reusing a code", async (t) => {
  const root = state(),
    home = path.join(root, "state");
  let pairs = 0,
    healthy = false;
  const token = "a".repeat(64);
  const hub = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/pair") {
      pairs++;
      res.end(JSON.stringify({ id: "replica", hubId: "hub", token }));
    } else if (!healthy) {
      res.statusCode = 503;
      res.end(JSON.stringify({ error: "Temporarily unavailable" }));
    } else
      res.end(
        JSON.stringify({
          id: "hub",
          name: "Test hub",
          protocol: 1,
          volumes: [],
        }),
      );
  });
  await new Promise((resolve) => hub.listen(0, "127.0.0.1", resolve));
  init(home, { role: "replica", port: 0, onboarding: true });
  const replica = await start(home, { timer: false });
  t.after(async () => {
    await replica.close();
    await new Promise((resolve) => hub.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const response = await post(replica, "/v1/connect", {
    url: `http://127.0.0.1:${hub.address().port}`,
    code: "001002",
  });
  assert.equal(response.status, 401);
  const saved = JSON.parse(
    fs.readFileSync(path.join(home, "config.json"), "utf8"),
  );
  assert.equal(saved.hub.token, token);
  assert.equal(saved.onboarding, true);
  await replica.engine.cycle();
  assert.equal(replica.engine.store.volumes().length, 0);
  healthy = true;
  assert.equal((await replica.engine.json("/v1/catalog")).name, "Test hub");
  const destination = path.join(root, "chosen");
  const result = await post(replica, "/v1/setup", {
    name: "Laptop",
    role: "replica",
    root: destination,
  });
  assert.equal(result.status, 200);
  assert.equal(replica.engine.config.onboarding, false);
  assert.equal(replica.engine.config.root, destination);
  assert.equal(pairs, 1);
  assert.equal(
    (
      await post(replica, "/v1/setup", {
        name: "again",
        role: "hub",
        root: destination,
      })
    ).status,
    409,
  );
});
test("pairing expires and concurrent redemption issues only one credential", async (t) => {
  const root = state();
  init(root, { port: 0 });
  const hub = await start(root, { timer: false });
  t.after(async () => {
    await hub.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const expired = await (
    await post(hub, "/v1/pairing", { name: "Phone" })
  ).json();
  hub.engine.store.db
    .prepare("UPDATE pairing SET expires=?")
    .run(Date.now() - 1);
  assert.equal((await post(hub, "/pair", { code: expired.code })).status, 401);
  const invite = await (
    await post(hub, "/v1/pairing", { name: "Phone" })
  ).json();
  const replies = await Promise.all([
    post(hub, "/pair", { code: invite.code, name: "My phone" }),
    post(hub, "/pair", { code: invite.code }),
  ]);
  assert.deepEqual(replies.map((r) => r.status).sort(), [201, 401]);
  assert.equal(
    hub.engine.store.db.prepare("SELECT COUNT(*) AS n FROM devices").get().n,
    1,
  );
});
