// Isolated repeatable scale check. Never uses the user's Arca configuration.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { init } from "../packages/daemon/storage.js";
import { start } from "../packages/daemon/server.js";
const count = Number(process.env.ARCA_TEST_FILES || 1000);
if (!Number.isSafeInteger(count) || count < 1 || count > 10000)
  throw Error("Use 1–10000 files");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "arca-scale-"));
let hub, replica;
try {
  for (const [name, role] of [
    ["hub", "hub"],
    ["replica", "replica"],
  ])
    init(path.join(root, name), { name, role, port: 0 });
  hub = await start(path.join(root, "hub"), { timer: false });
  replica = await start(path.join(root, "replica"), { timer: false });
  const api = async (node, route, body) => {
    const response = await fetch(`http://127.0.0.1:${node.port}${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${node.engine.config.adminToken}`,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json();
    if (!response.ok) throw Error(result.error);
    return result;
  };
  const volume = await api(hub, "/v1/volumes", { name: "Scale" });
  const credential = await api(hub, "/v1/devices", {
    name: "replica",
    role: "replica",
  });
  await api(replica, "/v1/connect", {
    url: `http://127.0.0.1:${hub.port}`,
    token: credential.token,
  });
  await api(replica, "/v1/select", { id: volume.id });
  for (let i = 0; i < count; i++)
    fs.writeFileSync(
      path.join(volume.path, `file-${i}.txt`),
      `${i}:` + "x".repeat(4096),
    );
  const scanStart = performance.now();
  await hub.engine.exclusive(() => hub.engine.cycle());
  const initialScanMs = performance.now() - scanStart;
  const syncStart = performance.now();
  await replica.engine.exclusive(() => replica.engine.cycle());
  const initialSyncMs = performance.now() - syncStart;
  const destination = replica.engine.store.volume(volume.id).path;
  for (let i = 0; i < count; i++)
    assert.equal(
      fs.readFileSync(path.join(destination, `file-${i}.txt`), "utf8"),
      `${i}:` + "x".repeat(4096),
    );
  const repeatStart = performance.now();
  await replica.engine.exclusive(() => replica.engine.cycle());
  const unchangedCycleMs = performance.now() - repeatStart;
  assert.equal(
    replica.engine.store.rows(volume.id).filter((row) => row.path !== ".arcaignore").length,
    count,
  );
  assert.equal(
    hub.engine.store.db
      .prepare("SELECT COUNT(*) AS n FROM snapshot_sessions")
      .get().n,
    0,
  );
  console.log(
    JSON.stringify({
      files: count,
      initialScanMs: Math.round(initialScanMs),
      initialSyncMs: Math.round(initialSyncMs),
      unchangedCycleMs: Math.round(unchangedCycleMs),
      verified: true,
    }),
  );
} finally {
  await replica?.close();
  await hub?.close();
  fs.rmSync(root, { recursive: true, force: true });
}
