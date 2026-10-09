import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { init } from "../packages/daemon/storage.js";
import { start } from "../packages/daemon/server.js";

async function hub(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-resume-"));
  init(home, { port: 0, name: "Resume hub" });
  const daemon = await start(home, { timer: false });
  t.after(async () => {
    await daemon.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const volume = daemon.engine.store.addVolume("Podcasts");
  const api = async (route, body) => {
    const response = await fetch(`http://127.0.0.1:${daemon.port}${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${daemon.engine.config.adminToken}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  return { daemon, volume, api };
}
const long = (volume, extra = {}) => ({ volume: volume.id, path: "Show/2026-10-06 Episode.mp3", hash: "h1", position: 3730, duration: 18612, ...extra });

test("a long track keeps its position on the hub with the device that played it", async (t) => {
  const { volume, api } = await hub(t);
  assert.deepEqual((await api("/v1/audio-position", long(volume))).body, { kept: true });
  const { positions } = (await api("/v1/audio-positions")).body;
  assert.equal(positions.length, 1);
  assert.deepEqual(
    [positions[0].path, positions[0].position, positions[0].duration, positions[0].name],
    ["Show/2026-10-06 Episode.mp3", 3730, 18612, "Resume hub"],
  );
});

test("music-length tracks keep no position", async (t) => {
  const { volume, api } = await hub(t);
  assert.deepEqual((await api("/v1/audio-position", long(volume, { duration: 400, position: 200 }))).body, { kept: false });
  assert.deepEqual((await api("/v1/audio-positions")).body, { positions: [] });
});

test("the newest update wins and an older one never overwrites it", async (t) => {
  const { volume, api } = await hub(t);
  const now = Date.now();
  await api("/v1/audio-position", long(volume, { position: 5000, at: now }));
  assert.deepEqual((await api("/v1/audio-position", long(volume, { position: 100, at: now - 5000 }))).body, { kept: false });
  assert.equal((await api("/v1/audio-positions")).body.positions[0].position, 5000);
  await api("/v1/audio-position", long(volume, { position: 6000, at: now + 1000 }));
  assert.equal((await api("/v1/audio-positions")).body.positions[0].position, 6000);
});

test("finishing a track clears its position and the first seconds keep none", async (t) => {
  const { volume, api } = await hub(t);
  await api("/v1/audio-position", long(volume, { at: Date.now() - 2000 }));
  assert.deepEqual((await api("/v1/audio-position", long(volume, { position: 18580, at: Date.now() }))).body, { kept: false, cleared: true });
  assert.deepEqual((await api("/v1/audio-positions")).body, { positions: [] });
  await api("/v1/audio-position", long(volume, { position: 3730 }));
  assert.deepEqual((await api("/v1/audio-position", long(volume, { position: 4 }))).body, { kept: false });
  assert.equal((await api("/v1/audio-positions")).body.positions.length, 1, "a save from the first seconds never erases a saved place");
});

test("an invalid position or an unknown folder is refused", async (t) => {
  const { volume, api } = await hub(t);
  assert.equal((await api("/v1/audio-position", long(volume, { position: "x" }))).status, 400);
  assert.notEqual((await api("/v1/audio-position", { ...long(volume), volume: "nope" })).status, 200);
});

test("a finished track stays finished when an older save arrives later, and a newer listen brings it back", async (t) => {
  const { volume, api } = await hub(t);
  const now = Date.now();
  await api("/v1/audio-position", long(volume, { position: 5000, at: now - 3000 }));
  await api("/v1/audio-position", long(volume, { position: 18580, at: now - 1000 }));
  assert.deepEqual((await api("/v1/audio-position", long(volume, { position: 9000, at: now - 2000 }))).body, { kept: false });
  assert.deepEqual((await api("/v1/audio-positions")).body, { positions: [] });
  await api("/v1/audio-position", long(volume, { position: 700, at: now }));
  assert.equal((await api("/v1/audio-positions")).body.positions[0].position, 700);
});

test("a queued position the hub refuses is dropped and the rest of the queue still reaches it", async (t) => {
  const { daemon } = await hub(t);
  const engine = daemon.engine;
  const insert = engine.store.db.prepare("INSERT INTO audio_outbox VALUES(?,?,?)");
  insert.run("gone", "a.mp3", JSON.stringify({ volume: "gone", path: "a.mp3" }));
  insert.run("kept", "b.mp3", JSON.stringify({ volume: "kept", path: "b.mp3" }));
  insert.run("later", "c.mp3", JSON.stringify({ volume: "later", path: "c.mp3" }));
  const sent = [];
  const replica = {
    store: engine.store,
    config: { role: "replica", hub: "http://hub" },
    hubUnavailable: false,
    json: async (route, body) => {
      sent.push(body.volume);
      if (body.volume === "gone") throw Object.assign(new Error("Hub 404: Unknown volume"), { status: 404 });
      if (body.volume === "later") throw Object.assign(new Error("Hub 503"), { status: 503, hubUnavailable: true });
      return { kept: true };
    },
  };
  await engine.flushPositions.call(replica);
  assert.deepEqual(sent, ["gone", "kept", "later"]);
  assert.deepEqual(engine.store.db.prepare("SELECT volume FROM audio_outbox").all().map((row) => row.volume), ["later"]);
});

test("forgetting a folder forgets its positions and queued saves", async (t) => {
  const { daemon, volume, api } = await hub(t);
  await api("/v1/audio-position", long(volume));
  daemon.engine.store.db.prepare("INSERT INTO audio_outbox VALUES(?,?,?)").run(volume.id, "x.mp3", "{}");
  daemon.engine.store.forgetVolume(volume.id);
  assert.equal(daemon.engine.store.db.prepare("SELECT COUNT(*) AS n FROM audio_positions").get().n, 0);
  assert.equal(daemon.engine.store.db.prepare("SELECT COUNT(*) AS n FROM audio_outbox").get().n, 0);
});

test("a replica never lists a queued save from the first seconds or the last minute", async () => {
  const { mergePositions } = await import("../packages/daemon/audio-positions.js");
  const row = (path, position, updated) => ({ volume: "v", path, hash: "h", position, duration: 3600, updated });
  const merged = mergePositions({ positions: [row("a.mp3", 900, 1)] }, [row("a.mp3", 3590, 2), row("b.mp3", 4, 3), row("c.mp3", 1200, 4)]);
  assert.deepEqual(merged.positions.map((item) => item.path), ["c.mp3"]);
});
