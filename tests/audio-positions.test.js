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
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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
  assert.deepEqual((await api("/v1/audio-positions")).body, { positions: [], finished: [] });
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
  const at = Date.now();
  assert.deepEqual((await api("/v1/audio-position", long(volume, { position: 18580, at }))).body, { kept: false, cleared: true });
  assert.deepEqual((await api("/v1/audio-positions")).body, {
    positions: [],
    finished: [{ volume: volume.id, path: "Show/2026-10-06 Episode.mp3", hash: "h1", updated: at }],
  });
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
  assert.deepEqual((await api("/v1/audio-positions")).body.positions, []);
  assert.deepEqual((await api("/v1/audio-positions")).body.finished.map((row) => row.updated), [now - 1000]);
  await api("/v1/audio-position", long(volume, { position: 700, at: now }));
  assert.equal((await api("/v1/audio-positions")).body.positions[0].position, 700);
  assert.deepEqual((await api("/v1/audio-positions")).body.finished, [], "a newer listen is no longer finished");
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

test("a replica lists finished episodes from the hub and its own queue, never as resumable positions", async () => {
  const { mergePositions } = await import("../packages/daemon/audio-positions.js");
  const row = (path, position, updated) => ({ volume: "v", path, hash: "h", position, duration: 3600, updated });
  const merged = mergePositions(
    { positions: [row("a.mp3", 900, 1), row("d.mp3", 900, 9)], finished: [{ volume: "v", path: "b.mp3", hash: "h", updated: 5 }, { volume: "v", path: "d.mp3", hash: "h", updated: 2 }] },
    [row("a.mp3", 3590, 6), row("b.mp3", 1200, 3), row("c.mp3", 3599, 4)],
  );
  assert.deepEqual(merged.positions.map((item) => [item.path, item.position]), [["d.mp3", 900]], "a newer listen outranks an older finished mark");
  assert.deepEqual(merged.finished, [
    { volume: "v", path: "a.mp3", hash: "h", updated: 6 },
    { volume: "v", path: "b.mp3", hash: "h", updated: 5 },
    { volume: "v", path: "c.mp3", hash: "h", updated: 4 },
  ]);
});

test("clearing a position removes it from Continue, survives an older save and yields to a newer listen", async (t) => {
  const { volume, api } = await hub(t);
  const now = Date.now();
  await api("/v1/audio-position", long(volume, { position: 5000, at: now - 3000 }));
  const target = { volume: volume.id, path: "Show/2026-10-06 Episode.mp3", hash: "h1" };
  assert.deepEqual((await api("/v1/audio-position/clear", { ...target, at: now - 1000 })).body, { cleared: true });
  assert.deepEqual((await api("/v1/audio-positions")).body, { positions: [], finished: [{ ...target, updated: now - 1000 }] });
  assert.deepEqual((await api("/v1/audio-position", long(volume, { position: 9000, at: now - 2000 }))).body, { kept: false });
  assert.deepEqual((await api("/v1/audio-positions")).body.positions, []);
  assert.deepEqual((await api("/v1/audio-position/clear", { ...target, at: now - 2000 })).body, { cleared: false });
  await api("/v1/audio-position", long(volume, { position: 700, at: now }));
  assert.equal((await api("/v1/audio-positions")).body.positions[0].position, 700);
});

test("clearing needs a known folder and a hash", async (t) => {
  const { volume, api } = await hub(t);
  assert.equal((await api("/v1/audio-position/clear", { volume: volume.id, path: "a.mp3" })).status, 400);
  assert.notEqual((await api("/v1/audio-position/clear", { volume: "nope", path: "a.mp3", hash: "h" })).status, 200);
});

test("a replica queues a clear in the outbox like a save, forwards it and lists it as finished", async (t) => {
  const { daemon, volume } = await hub(t);
  const engine = daemon.engine;
  const sent = [];
  const replica = {
    store: engine.store,
    config: { role: "replica", hub: "http://hub", id: "replica", name: "Replica" },
    hubUnavailable: true,
    json: async (route, body) => {
      sent.push([route, body.clear === true]);
      return {};
    },
    flushPositions: engine.flushPositions,
    queuedPositions: engine.queuedPositions,
  };
  await engine.audioPosition.call(replica, long(volume));
  await engine.clearAudioPosition.call(replica, { volume: volume.id, path: "Show/2026-10-06 Episode.mp3", hash: "h1" });
  assert.equal(engine.store.db.prepare("SELECT COUNT(*) AS n FROM audio_outbox").get().n, 1, "a clear replaces the queued save");
  const { mergePositions } = await import("../packages/daemon/audio-positions.js");
  assert.deepEqual(mergePositions({ positions: [] }, engine.queuedPositions.call(replica)).positions, []);
  assert.equal(mergePositions({ positions: [] }, engine.queuedPositions.call(replica)).finished.length, 1);
  replica.hubUnavailable = false;
  await engine.flushPositions.call(replica);
  assert.deepEqual(sent, [["/v1/audio-position/clear", true]]);
  assert.equal(engine.store.db.prepare("SELECT COUNT(*) AS n FROM audio_outbox").get().n, 0);
});

test("a linked device clears under its own name, a far-future at is capped and a malformed at falls back to now", async (t) => {
  const { daemon, volume, api } = await hub(t);
  const invite = (await api("/v1/devices", { name: "Phone", role: "replica" })).body;
  const as = async (route, body) => {
    const response = await fetch(`http://127.0.0.1:${daemon.port}${route}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${invite.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const target = { volume: volume.id, path: "Show/2026-10-06 Episode.mp3", hash: "h1" };
  const before = Date.now();
  assert.deepEqual((await as("/v1/audio-position/clear", { ...target, at: before + 10 * 86400000 })).body, { cleared: true });
  const row = daemon.engine.store.db.prepare("SELECT device,name,updated FROM audio_positions").get();
  assert.equal(row.name, "Phone");
  assert.notEqual(row.device, daemon.engine.config.id);
  assert.ok(row.updated <= Date.now() + 60000 && row.updated > before + 30000, "the future at is capped at the hub's clock plus 60 s");
  await api("/v1/audio-position", long(volume, { position: 5000, at: Date.now() + 120000 }));
  assert.equal((await as("/v1/audio-position/clear", { ...target, path: "b.mp3", at: "garbage" })).body.cleared, true);
  const other = daemon.engine.store.db.prepare("SELECT updated FROM audio_positions WHERE path='b.mp3'").get();
  assert.ok(Math.abs(other.updated - Date.now()) < 5000, "a malformed at means now");
  assert.equal((await as("/v1/audio-position/clear", { ...target, hash: "" })).status, 400);
});

test("a replica's route queues the clear for the hub instead of writing it", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-resume-replica-"));
  init(home, { port: 0, role: "replica", name: "Replica" });
  const daemon = await start(home, { timer: false });
  t.after(async () => {
    await daemon.close();
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const response = await fetch(`http://127.0.0.1:${daemon.port}/v1/audio-position/clear`, {
    method: "POST",
    headers: { Authorization: `Bearer ${daemon.engine.config.adminToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ volume: "v", path: "a.mp3", hash: "h" }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { cleared: true });
  const queued = daemon.engine.store.db.prepare("SELECT body FROM audio_outbox").all().map((r) => JSON.parse(r.body));
  assert.deepEqual(queued.map((r) => [r.clear, r.path, r.hash]), [[true, "a.mp3", "h"]]);
  assert.equal(daemon.engine.store.db.prepare("SELECT COUNT(*) AS n FROM audio_positions").get().n, 0);
});
