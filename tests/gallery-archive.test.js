import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { init, digest } from "../packages/daemon/storage.js";
import { issueWebCode } from "../packages/daemon/web.js";
import { start } from "../packages/daemon/server.js";
import { centralHeader, endRecords, localHeader } from "../packages/daemon/zip.js";

async function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-archive-"));
  init(home, { port: 0, name: "Archive hub" });
  const daemon = await start(home, { timer: false });
  t.after(async () => {
    await daemon.engine.gallery?.background;
    await daemon.close();
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const s = daemon.engine.store;
  const admin = daemon.engine.config.adminToken;
  const base = `http://127.0.0.1:${daemon.port}`;
  const request = (route, body, token = admin) =>
    fetch(base + route, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-Arca-Directories": "1",
        "X-Arca-Path-Transitions": "1",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  async function api(route, body, token) {
    const response = await request(route, body, token);
    const value = await response.json();
    if (!response.ok)
      throw Object.assign(new Error(value.error), { status: response.status });
    return value;
  }
  async function put(volume, name, text) {
    const buffer = Buffer.from(text);
    const hash = digest(buffer);
    if (!fs.existsSync(s.blob(hash))) fs.writeFileSync(s.blob(hash), buffer);
    await api("/v1/propose", { volume: volume.id, path: name, hash, size: buffer.length });
    return { path: name, hash, buffer };
  }
  return { home, daemon, s, api, request, put, base };
}

function unzip(buffer) {
  const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0);
  const count = buffer.readUInt16LE(eocd + 10);
  let cursor = buffer.readUInt32LE(eocd + 16);
  const files = [];
  for (let index = 0; index < count; index++) {
    assert.equal(buffer.readUInt32LE(cursor), 0x02014b50);
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const crc = buffer.readUInt32LE(cursor + 16);
    const size = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const offset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString("utf8", cursor + 46, cursor + 46 + nameLength);
    assert.equal(buffer.readUInt32LE(offset), 0x04034b50);
    assert.equal(buffer.readUInt16LE(offset + 6), flags);
    assert.equal(buffer.readUInt32LE(offset + 14), crc);
    const local = buffer.toString("utf8", offset + 30, offset + 30 + buffer.readUInt16LE(offset + 26));
    assert.equal(local, name);
    const data = offset + 30 + buffer.readUInt16LE(offset + 26) + buffer.readUInt16LE(offset + 28);
    const content = buffer.subarray(data, data + size);
    assert.equal(zlib.crc32(content), crc);
    files.push({ name, flags, method, content });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  assert.equal(buffer.readUInt32LE(cursor), 0x06054b50);
  return files;
}

test("a selection downloads as one streamed store-only ZIP named after the folder", async (t) => {
  const f = await fixture(t);
  const camera = f.s.addVolume("Café ☀");
  const one = await f.put(camera, "IMG_1.jpg", "first original");
  const two = await f.put(camera, "Viaje/Señal ☀.jpg", "second original");
  const empty = await f.put(camera, "empty.jpg", "");
  const ticket = await f.api("/v1/gallery/archive", {
    volume: camera.id,
    items: [one, two, empty, one].map(({ path: name, hash }) => ({ path: name, hash })),
  });
  assert.match(ticket.url, /^\/v1\/gallery\/archive\?ticket=/);
  const response = await f.request(ticket.url);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/zip");
  assert.equal(response.headers.get("content-length"), null);
  assert.equal(
    response.headers.get("content-disposition"),
    `attachment; filename*=UTF-8''${encodeURIComponent("Café ☀.zip")}`,
  );
  const files = unzip(Buffer.from(await response.arrayBuffer()));
  assert.deepEqual(
    files.map((file) => [file.name, file.method, file.flags & 0x0800, file.content.toString()]),
    [
      ["IMG_1.jpg", 0, 0x0800, "first original"],
      ["Viaje/Señal ☀.jpg", 0, 0x0800, "second original"],
      ["empty.jpg", 0, 0x0800, ""],
    ],
  );
  assert.equal((await f.request(ticket.url)).status, 410);
});

test("an archive request validates every path against the folder and the caller", async (t) => {
  const f = await fixture(t);
  const camera = f.s.addVolume("Camera");
  const other = f.s.addVolume("Other");
  const one = await f.put(camera, "one.jpg", "one");
  const elsewhere = await f.put(other, "secret.jpg", "secret");
  const archive = (items, token) =>
    f.api("/v1/gallery/archive", { volume: camera.id, items }, token);
  await assert.rejects(archive([{ path: "../Other/secret.jpg", hash: elsewhere.hash }]), (error) => error.status === 400);
  await assert.rejects(archive([{ path: "/etc/passwd", hash: one.hash }]), (error) => error.status === 400);
  await assert.rejects(archive([{ path: "secret.jpg", hash: elsewhere.hash }]), (error) => error.status === 404);
  await assert.rejects(archive([{ path: "one.jpg", hash: "0".repeat(64) }]), (error) => error.status === 404);
  await assert.rejects(archive([]), (error) => error.status === 400);
  await assert.rejects(archive([{ path: 7 }]), (error) => error.status === 400);
  const replica = await f.api("/v1/devices", { name: "Replica", role: "replica" });
  await assert.rejects(archive([{ path: "one.jpg", hash: one.hash }], replica.token), (error) => error.status === 403);
  const ticket = await archive([{ path: "one.jpg", hash: one.hash }]);
  assert.equal((await f.request(ticket.url, undefined, replica.token)).status, 403);
  assert.equal((await f.request(ticket.url)).status, 200);
  assert.equal((await f.request("/v1/gallery/archive?ticket=forged")).status, 410);
});

test("an archive answers a clean error when its first file changed, and stops mid-stream for a later one", async (t) => {
  const f = await fixture(t);
  const camera = f.s.addVolume("Camera");
  const one = await f.put(camera, "one.jpg", "one original");
  const two = await f.put(camera, "two.jpg", "two original");
  const items = [one, two].map(({ path: name, hash }) => ({ path: name, hash }));
  const first = await f.api("/v1/gallery/archive", { volume: camera.id, items });
  fs.writeFileSync(f.s.blob(one.hash), "tampered!!!!");
  const refused = await f.request(first.url);
  assert.equal(refused.status, 409);
  assert.deepEqual(await refused.json(), { error: "File changed. Sync before downloading." });
  fs.writeFileSync(f.s.blob(one.hash), "one original");
  const later = await f.api("/v1/gallery/archive", { volume: camera.id, items });
  fs.writeFileSync(f.s.blob(two.hash), "tampered!!!!");
  await assert.rejects(f.request(later.url).then((response) => response.arrayBuffer()));
});

test("an archive ticket serves only its own session, once, within five minutes", async (t) => {
  const f = await fixture(t);
  const camera = f.s.addVolume("Camera");
  const one = await f.put(camera, "one.jpg", "one");
  const items = [{ path: one.path, hash: one.hash }];
  const signIn = async () => {
    const { code } = issueWebCode(f.home);
    const response = await fetch(f.base + "/auth/login", {
      method: "POST",
      headers: { Origin: f.base, "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    assert.equal(response.status, 200);
    return response.headers.get("set-cookie").split(";")[0];
  };
  const first = await signIn();
  const second = await signIn();
  const ticket = await (
    await fetch(f.base + "/v1/gallery/archive", {
      method: "POST",
      headers: { Cookie: first, Origin: f.base, "Content-Type": "application/json" },
      body: JSON.stringify({ volume: camera.id, items }),
    })
  ).json();
  assert.equal((await fetch(f.base + ticket.url, { headers: { Cookie: second } })).status, 410);
  assert.equal((await f.request(ticket.url)).status, 410);
  const own = await fetch(f.base + ticket.url, { headers: { Cookie: first } });
  assert.equal(own.status, 200);
  await own.arrayBuffer();
  assert.equal((await fetch(f.base + ticket.url, { headers: { Cookie: first } })).status, 410);
  const late = await f.api("/v1/gallery/archive", { volume: camera.id, items });
  const now = Date.now;
  Date.now = () => now() + 5 * 60000 + 1000;
  try {
    assert.equal((await f.request(late.url)).status, 410);
  } finally {
    Date.now = now;
  }
});

test("an archive refuses a path the folder's .arcaignore excludes", async (t) => {
  const f = await fixture(t);
  const camera = f.s.addVolume("Camera");
  const hidden = await f.put(camera, "private/secret.jpg", "secret");
  fs.writeFileSync(path.join(camera.path, ".arcaignore"), "private/\n");
  await assert.rejects(
    f.api("/v1/gallery/archive", { volume: camera.id, items: [{ path: hidden.path, hash: hidden.hash }] }),
    (error) => error.status === 404,
  );
});

test("an archive request takes a large selection and refuses more than 10,000 photos with a sentence", async (t) => {
  const f = await fixture(t);
  const camera = f.s.addVolume("Camera");
  const one = await f.put(camera, "one.jpg", "one");
  const repeat = (count) => Array.from({ length: count }, () => ({ path: one.path, hash: one.hash }));
  const large = repeat(25000);
  assert.ok(JSON.stringify(large).length > 2 * 1024 * 1024);
  const ticket = await f.api("/v1/gallery/archive", { volume: camera.id, items: large });
  assert.match(ticket.url, /ticket=/);
  const distinct = Array.from({ length: 10001 }, (_, i) => ({ path: `p/${i}.jpg`, hash: one.hash }));
  await assert.rejects(
    f.api("/v1/gallery/archive", { volume: camera.id, items: distinct }),
    (error) => error.status === 413 && error.message === "Too many photos to download at once. Select fewer and try again.",
  );
});

test("ZIP64 records carry sizes and offsets beyond 4 GiB", () => {
  const size = 2 ** 32 + 5;
  const offset = 2 ** 32 + 100;
  const entry = { name: "clip.mov", size, crc: 7, mtime: new Date(2026, 0, 2, 3, 4, 6) };
  const local = localHeader(entry);
  assert.equal(local.readUInt16LE(4), 45);
  assert.equal(local.readUInt32LE(18), 0xffffffff);
  assert.equal(local.readUInt16LE(30 + 8), 0x0001);
  assert.equal(local.readBigUInt64LE(30 + 8 + 4), BigInt(size));
  const central = centralHeader(entry, offset);
  assert.equal(central.readUInt32LE(42), 0xffffffff);
  assert.equal(central.readUInt16LE(30), 4 + 24);
  assert.equal(central.readBigUInt64LE(46 + 8 + 4), BigInt(size));
  assert.equal(central.readBigUInt64LE(46 + 8 + 20), BigInt(offset));
  const end = endRecords(1, offset + size, central.length);
  assert.equal(end.readUInt32LE(0), 0x06064b50);
  assert.equal(end.readBigUInt64LE(48), BigInt(offset + size));
  assert.equal(end.readUInt32LE(56), 0x07064b50);
  assert.equal(end.readBigUInt64LE(56 + 8), BigInt(offset + size + central.length));
  assert.equal(end.readUInt32LE(76), 0x06054b50);
  assert.equal(end.readUInt32LE(76 + 16), 0xffffffff);
  const small = centralHeader({ ...entry, size: 3 }, 10);
  assert.equal(small.readUInt16LE(30), 0);
  assert.equal(endRecords(1, 10, 50).length, 22);
});

test("the app refuses an oversized selection before asking, with the daemon's limit and words", () => {
  const read = (file) => fs.readFileSync(path.join(import.meta.dirname, "..", file), "utf8");
  const limit = (source) => Number(/const ARCHIVE_ITEMS = (\d+);/.exec(source)?.[1]);
  const app = read("apps/desktop/src/app.js");
  assert.equal(limit(app), limit(read("packages/daemon/server.js")));
  assert.match(app, /if \(items\.length > ARCHIVE_ITEMS\)\s+throw new Error\("Too many photos to download at once\. Select fewer and try again\."\);/);
});
