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
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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
    ["/v1/rename-file", "POST", { volume: volume.id, path: "a.jpg", name: "b.jpg", rev: 1 }],
    ["/v1/restore", "POST", { volume: volume.id, path: "a.jpg", rev: 1 }],
    ["/v1/delete-share", "POST", { id: volume.id, confirmedName: "Photos" }],
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

test("a blob answers suffix and bounded ranges and refuses ones past its end", async (t) => {
  const { d, pair } = await hub(t);
  const replica = await (await pair({ name: "phone" })).json();
  const player = await (await pair({ kind: "player", name: "salon-tv" })).json();
  const data = Buffer.from("abcdefghijklmnop");
  const hash = digest(data);
  await fetch(`http://127.0.0.1:${d.port}/v1/uploads/${hash}?offset=0&size=${data.length}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${replica.token}` },
    body: data,
  });
  const get = (range) => fetch(`http://127.0.0.1:${d.port}/v1/blobs/${hash}`, { headers: { Authorization: `Bearer ${player.token}`, Range: range } });
  const tail = await get("bytes=-4");
  assert.equal(tail.status, 206);
  assert.equal(tail.headers.get("content-range"), "bytes 12-15/16");
  assert.equal(await tail.text(), "mnop");
  const middle = await get("bytes=2-5");
  assert.equal(await middle.text(), "cdef");
  assert.equal((await get("bytes=16-")).status, 416);
  assert.equal((await get("bytes=-")).status, 416);
});

test("a player reads an empty blob as an empty 200", async (t) => {
  const { d, pair } = await hub(t);
  const replica = await (await pair({ name: "phone" })).json();
  const player = await (await pair({ kind: "player", name: "salon-tv" })).json();
  const hash = digest(Buffer.alloc(0));
  await fetch(`http://127.0.0.1:${d.port}/v1/uploads/${hash}?offset=0&size=0`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${replica.token}` },
    body: Buffer.alloc(0),
  });
  const r = await fetch(`http://127.0.0.1:${d.port}/v1/blobs/${hash}`, { headers: { Authorization: `Bearer ${player.token}` } });
  assert.equal(r.status, 200);
  assert.equal((await r.arrayBuffer()).byteLength, 0);
});

test("a device's last contact is written once per refresh window, not on every request", async (t) => {
  const { d, call, pair } = await hub(t);
  const player = await (await pair({ kind: "player", name: "salon-tv" })).json();
  const seen = () => d.engine.store.db.prepare("SELECT last_seen FROM devices WHERE id=?").get(player.id).last_seen;
  await call("/v1/catalog", { method: "GET", token: player.token });
  const first = seen();
  assert.ok(first);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await call("/v1/catalog", { method: "GET", token: player.token });
  assert.equal(seen(), first);
  d.engine.store.db.prepare("UPDATE devices SET last_seen=? WHERE id=?").run(new Date(Date.now() - 60000).toISOString(), player.id);
  await call("/v1/catalog", { method: "GET", token: player.token });
  assert.ok(Date.parse(seen()) > Date.now() - 5000);
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

test("a player deletes a file on the hub and the deletion is a revision every copy follows", async (t) => {
  const { d, call, pair } = await hub(t);
  const volume = await (await call("/v1/volumes", { body: { name: "Movies" } })).json();
  const plain = await (await call("/v1/volumes", { body: { name: "Documents" } })).json();
  fs.writeFileSync(path.join(d.engine.store.volume(plain.id).path, "taxes.pdf"), "secret");
  await d.engine.cycle();
  const taxes = d.engine.store.current(plain.id, "taxes.pdf");
  assert.equal((await call("/v1/video/mark", { body: { volume: volume.id } })).status, 200);
  const folder = d.engine.store.volume(volume.id).path;
  fs.writeFileSync(path.join(folder, "Heat.mp4"), "film");
  fs.writeFileSync(path.join(folder, "Up.mp4"), "film two");
  await d.engine.cycle();
  const { token } = await (await pair({ kind: "player", name: "salon-tv" })).json();
  const as = (body) => call("/v1/delete-file", { body, token });
  assert.equal((await as({ volume: plain.id, path: "taxes.pdf", rev: taxes.rev })).status, 403, "a TV deletes only in video and audio libraries");
  assert.equal(fs.existsSync(path.join(d.engine.store.volume(plain.id).path, "taxes.pdf")), true);
  const heat = d.engine.store.current(volume.id, "Heat.mp4");
  assert.equal((await as({ volume: volume.id, path: "Heat.mp4", rev: heat.rev + 1 })).status, 409, "a stale view deletes nothing");
  assert.equal(fs.existsSync(path.join(folder, "Heat.mp4")), true);
  assert.equal((await as({ volume: volume.id, path: "Heat.mp4", rev: heat.rev })).status, 200);
  assert.equal(fs.existsSync(path.join(folder, "Heat.mp4")), false);
  assert.equal(d.engine.store.current(volume.id, "Heat.mp4").deleted, 1);
  assert.equal(fs.existsSync(path.join(folder, "Up.mp4")), true, "only the chosen file goes");
  assert.equal((await as({ volume: volume.id, path: "../Up.mp4", rev: 1 })).status, 400);
  assert.equal((await as({ volume: volume.id })).status, 400, "a missing path is a bad request, never a stack trace");
  assert.equal((await as({ volume: volume.id, path: 5, rev: 1 })).status, 400);
  fs.writeFileSync(path.join(folder, ".arcaignore"), "secret/\n");
  await d.engine.cycle();
  const rules = d.engine.store.current(volume.id, ".arcaignore");
  assert.equal((await as({ volume: volume.id, path: ".arcaignore", rev: rules.rev })).status, 403, "a TV never changes what the folder shares");
  assert.equal((await as({ volume: volume.id, path: ".ArcaIgnore", rev: rules.rev })).status, 403, "nor through another casing on a case-insensitive disk");
  assert.equal(fs.existsSync(path.join(folder, ".arcaignore")), true);
});

test("a player's music library carries the rev a deletion needs", async (t) => {
  const { d, call, pair } = await hub(t);
  const volume = await (await call("/v1/volumes", { body: { name: "Music" } })).json();
  assert.equal((await call("/v1/music/mark", { body: { volume: volume.id } })).status, 200);
  fs.writeFileSync(path.join(d.engine.store.volume(volume.id).path, "song.mp3"), "not really audio");
  await d.engine.cycle();
  const { token } = await (await pair({ kind: "player", name: "salon-tv" })).json();
  const library = await (await call(`/v1/music/library?volume=${volume.id}`, { method: "GET", token })).json();
  const track = library.tracks.find((row) => row.path === "song.mp3");
  assert.equal(track.rev, d.engine.store.current(volume.id, "song.mp3").rev);
  assert.equal((await call("/v1/delete-file", { body: { volume: volume.id, path: track.path, rev: track.rev }, token })).status, 200);
});

test("a linked phone or desktop replica deletes through the hub only in a video or audio library", async (t) => {
  const { d, call, pair } = await hub(t);
  const movies = await (await call("/v1/volumes", { body: { name: "Movies" } })).json();
  const songs = await (await call("/v1/volumes", { body: { name: "Songs" } })).json();
  const docs = await (await call("/v1/volumes", { body: { name: "Docs" } })).json();
  assert.equal((await call("/v1/video/mark", { body: { volume: movies.id } })).status, 200);
  assert.equal((await call("/v1/music/mark", { body: { volume: songs.id } })).status, 200);
  for (const [volume, name] of [[movies, "Heat.mp4"], [songs, "song.mp3"], [docs, "note.txt"]])
    fs.writeFileSync(path.join(d.engine.store.volume(volume.id).path, name), `content of ${name}`);
  await d.engine.cycle();
  const { id, token } = await (await pair({ name: "phone" })).json();
  const as = (volume, file, extra = {}) =>
    call("/v1/delete-file", { body: { volume: volume.id, path: file, rev: d.engine.store.current(volume.id, file)?.rev, ...extra }, token });
  assert.equal((await as(songs, "song.mp3", { rev: 999 })).status, 409, "a stale rev deletes no track");
  assert.equal((await as(songs, "song.mp3")).status, 200, "a replica that streams an audio library deletes through the hub");
  assert.equal(d.engine.store.current(songs.id, "song.mp3").deleted, 1);
  assert.equal((await as(docs, "note.txt")).status, 403, "a synced folder deletes through sync");
  assert.equal((await as(movies, ".arcaignore")).status, 403);
  assert.equal((await as(movies, "Heat.mp4", { rev: 999 })).status, 409, "a stale rev deletes nothing");
  assert.equal(fs.existsSync(path.join(d.engine.store.volume(movies.id).path, "Heat.mp4")), true);
  assert.equal((await as(movies, "Heat.mp4")).status, 200);
  assert.equal(fs.existsSync(path.join(d.engine.store.volume(movies.id).path, "Heat.mp4")), false);
  const head = d.engine.store.db.prepare("SELECT author FROM revisions WHERE volume=? AND path=? ORDER BY rev DESC LIMIT 1").get(movies.id, "Heat.mp4");
  assert.equal(head.author, id, "History names the phone");
});

test("a player deletes a gallery photo through the shared gallery deletion", async (t) => {
  const { d, call, pair } = await hub(t);
  const volume = await (await call("/v1/volumes", { body: { name: "Photos" } })).json();
  assert.equal((await call("/v1/gallery/link", { body: { volume: volume.id } })).status, 200);
  const folder = d.engine.store.volume(volume.id).path;
  fs.writeFileSync(path.join(folder, "beach.jpg"), "photo");
  await d.engine.cycle();
  const { token } = await (await pair({ kind: "player", name: "salon-tv" })).json();
  const body = { id: "tv-delete-0000000001", volume: volume.id, path: "beach.jpg", rev: d.engine.store.current(volume.id, "beach.jpg").rev };
  const remove = () => call("/v1/gallery/delete", { body, token });
  const rev = body.rev;
  assert.equal((await call("/v1/delete-file", { body: { volume: volume.id, path: "beach.jpg", rev }, token })).status, 409, "a gallery photo goes through the gallery deletion, so phones stop uploading it");
  assert.equal((await remove()).status, 200);
  assert.equal(fs.existsSync(path.join(folder, "beach.jpg")), false);
  const deletions = () => d.engine.store.db.prepare("SELECT COUNT(*) AS n FROM revisions WHERE volume=? AND path=? AND deleted=1").get(volume.id, "beach.jpg").n;
  assert.equal(deletions(), 1);
  assert.equal((await remove()).status, 200, "a retried request is the same deletion");
  assert.equal(deletions(), 1);
});

test("the player allow-list holds reads, its own report, leaving and the hub's two deletions", () => {
  for (const route of ["/v1/catalog", "/v1/gallery", "/v1/gallery/preview", "/v1/music/library", "/v1/music/cover", "/v1/blobs/abc"])
    assert.equal(playerRoute("GET", route), true, route);
  assert.equal(playerRoute("POST", "/v1/machine-report"), true);
  assert.equal(playerRoute("POST", "/v1/leave"), true);
  assert.equal(playerRoute("GET", "/v1/leave"), false);
  assert.equal(playerRoute("POST", "/v1/delete-file"), true);
  assert.equal(playerRoute("POST", "/v1/gallery/delete"), true);
  for (const [method, route] of [["GET", "/v1/search"], ["GET", "/v1/gallery/info"], ["POST", "/v1/catalog"], ["PUT", "/v1/blobs/abc"], ["GET", "/v1/machines"], ["GET", "/v1/history"], ["DELETE", "/v1/blobs/abc"], ["GET", "/v1/machine-report"], ["POST", "/v1/rename-file"], ["POST", "/v1/restore"], ["POST", "/v1/delete-share"], ["POST", "/v1/gallery/removals"]])
    assert.equal(playerRoute(method, route), false, `${method} ${route}`);
});
