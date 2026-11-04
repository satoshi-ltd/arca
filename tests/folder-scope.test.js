import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { init } from "../packages/daemon/storage.js";
import { start } from "../packages/daemon/server.js";
import { UNREPORTED_FOLDER, machineReport } from "../packages/daemon/machines.js";

async function hub(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-folder-scope-"));
  init(home, { port: 0 });
  const d = await start(home, { timer: false });
  t.after(async () => {
    await d.close();
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const call = async (route, body, token = d.engine.config.adminToken) => {
    const response = await fetch(`http://127.0.0.1:${d.port}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  const device = async (kind) => {
    const { code } = (await call("/v1/pairing", { name: kind })).body;
    const response = await fetch(`http://127.0.0.1:${d.port}/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, name: kind, ...(kind === "player" ? { kind } : {}) }),
    });
    return response.json();
  };
  const report = (paired, fields) =>
    call(
      "/v1/machine-report",
      {
        machineId: paired.id,
        name: "Desk",
        platform: "darwin",
        arch: "",
        kernelRelease: "",
        phase: "idle",
        uptimeSeconds: 0,
        selectedFolders: 0,
        indexedFiles: 0,
        indexedBytes: 0,
        lastSync: null,
        folderIds: [],
        ...fields,
      },
      paired.token,
    );
  return { d, call, device, report };
}

const refused = (answer) => answer.status === 409 && answer.body.error === UNREPORTED_FOLDER;

test("a replica acts only on folders it reports, streamed libraries count for Watch next, and the administrator and players keep every folder", async (t) => {
  const { d, call, device, report } = await hub(t);
  const notes = d.engine.store.addVolume("Notes");
  fs.writeFileSync(path.join(notes.path, "a.txt"), "a");
  await d.engine.cycle();
  const replica = await device("replica");
  const rev = d.engine.store.current(notes.id, "a.txt").rev;
  const routes = [
    ["/v1/restore", { volume: notes.id, path: "a.txt", rev }],
    ["/v1/gallery/delete", { volume: notes.id, paths: ["a.txt"] }],
    ["/v1/gallery/link", { volume: notes.id }],
    ["/v1/video/watch-next/remove", { volume: notes.id, id: "m:heat" }],
    ["/v1/video/watch-next/restore", { volume: notes.id, id: "m:heat" }],
  ];
  await report(replica, {});
  for (const [route, body] of routes) assert.ok(refused(await call(route, body, replica.token)), `${route} refuses an unreported folder`);
  await report(replica, { streamedFolderIds: [notes.id] });
  for (const [route, body] of routes.slice(0, 3)) assert.ok(refused(await call(route, body, replica.token)), `${route} needs a synced copy, not a stream`);
  for (const [route, body] of routes.slice(3)) assert.equal(refused(await call(route, body, replica.token)), false, `${route} follows a streamed library`);
  await report(replica, { folderIds: [notes.id], selectedFolders: 1 });
  for (const [route, body] of routes) assert.equal(refused(await call(route, body, replica.token)), false, `${route} accepts a reported folder`);
  for (const [route, body] of routes) assert.equal(refused(await call(route, body)), false, `the administrator keeps ${route}`);
  const player = await device("player");
  for (const [route, body] of routes.slice(3)) assert.equal(refused(await call(route, body, player.token)), false, `a player keeps ${route}`);
});

test("a desktop replica reports the libraries it streams", async (t) => {
  const { d } = await hub(t);
  d.engine.status = () => ({ id: "x", name: "Desk", volumes: [], media: { a: "stream", b: "keep" }, phase: "idle", lastSync: null });
  assert.deepEqual(machineReport(d.engine).streamedFolderIds, ["a"]);
});
