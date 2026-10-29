import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { digest, quickHashFile } from "../packages/daemon/storage.js";
import { clip, hub } from "./video-support.js";

test("a hub video folder reads its files in place: no object copy, still indexed and streamed", async (t) => {
  const f = await hub(t);
  await f.call("/v1/video/mark", { volume: f.v.id });
  const film = clip({ seconds: 1 });
  fs.mkdirSync(path.join(f.v.path, "movies"), { recursive: true });
  fs.writeFileSync(path.join(f.v.path, "movies", "Heat (1995).mp4"), film);
  fs.writeFileSync(path.join(f.v.path, "movies", "Heat (1995).en.srt"), "1\n00:00:01,000 --> 00:00:02,000\nHello\n");
  await f.daemon.engine.cycle();
  const hash = quickHashFile(path.join(f.v.path, "movies", "Heat (1995).mp4"));
  assert.notEqual(hash, digest(film), "a video's identity comes from its size and ends, not a full read");
  assert.equal(f.s.current(f.v.id, "movies/Heat (1995).mp4")?.hash, hash, "the file is a revision like any other");
  assert.equal(fs.existsSync(f.s.blob(hash)), false, "but the hub keeps no second copy in its objects");
  const value = await f.settled();
  const movie = value.movies[0] || value.other[0];
  assert.equal(movie.hash, hash);
  assert.ok(movie.duration > 0, "the probe read the file in place");
  const media = await fetch(`http://127.0.0.1:${f.daemon.port}/v1/video/media?${new URLSearchParams({ volume: f.v.id, path: movie.path, hash })}`, {
    headers: { Authorization: `Bearer ${f.daemon.engine.config.adminToken}`, Range: "bytes=0-9" },
  });
  assert.equal(media.status, 206);
  assert.deepEqual(Buffer.from(await media.arrayBuffer()), film.subarray(0, 10));
  const subtitles = await f.call(`/v1/video/subtitles?${new URLSearchParams({ volume: f.v.id, path: "movies/Heat (1995).en.srt", format: "json" })}`);
  assert.match(subtitles.text, /Hello/);

  const other = f.s.addVolume("Documents");
  fs.writeFileSync(path.join(other.path, "note.txt"), "keep me");
  await f.daemon.engine.cycle();
  assert.equal(fs.existsSync(f.s.blob(digest(Buffer.from("keep me")))), true, "other folders keep their objects");
});

test("a video folder's leftover objects are collected, it keeps no history, and backups skip it", async (t) => {
  const { applyFolderRetention } = await import("../packages/daemon/maintenance.js");
  const f = await hub(t);
  const film = clip({ seconds: 1, tone: 520 });
  const hash = await f.propose("Heat (1995).mp4", film);
  await f.call("/v1/video/mark", { volume: f.v.id });
  const shared = Buffer.from("shared bytes");
  await f.propose("shared.txt", shared);
  const docs = f.s.addVolume("Documents");
  fs.writeFileSync(path.join(docs.path, "shared.txt"), shared);
  await f.daemon.engine.cycle();
  const old = new Date(Date.now() - 48 * 3600000);
  for (const object of [f.s.blob(hash), f.s.blob(digest(shared))]) fs.utimesSync(object, old, old);
  applyFolderRetention(f.s);
  assert.equal(fs.existsSync(f.s.blob(hash)), false, "the object a video folder no longer needs is freed");
  assert.equal(fs.existsSync(f.s.blob(digest(shared))), true, "a hash another folder still uses stays");
  const quick = f.s.current(f.v.id, "Heat (1995).mp4").hash;
  assert.equal(quick, quickHashFile(path.join(f.v.path, "Heat (1995).mp4")), "marking the folder gave the film its quick identity");
  const media = await fetch(`http://127.0.0.1:${f.daemon.port}/v1/video/media?${new URLSearchParams({ volume: f.v.id, path: "Heat (1995).mp4", hash: quick })}`, {
    headers: { Authorization: `Bearer ${f.daemon.engine.config.adminToken}` },
  });
  assert.equal(media.status, 200, "and the film still plays from the folder");

  await assert.rejects(f.call("/v1/folder-retention", { id: f.v.id, mode: "forever" }), { status: 409 });
  const rev = f.s.current(f.v.id, "Heat (1995).mp4").rev;
  await assert.rejects(f.call("/v1/restore", { volume: f.v.id, path: "Heat (1995).mp4", rev }), { status: 409 });
  const archive = await f.call("/v1/archive?limit=1000&after=0");
  assert.equal(archive.revisions.some((row) => row.volume === f.v.id), false, "backups never ask for a video folder's content");
  assert.ok(archive.revisions.some((row) => row.volume === docs.id));
});

test("a video folder whose disk is missing is unavailable, never emptied", async (t) => {
  const f = await hub(t);
  await f.call("/v1/video/mark", { volume: f.v.id });
  fs.writeFileSync(path.join(f.v.path, "Heat (1995).mp4"), clip({ seconds: 1, tone: 610 }));
  await f.daemon.engine.cycle();
  const before = f.s.current(f.v.id, "Heat (1995).mp4");
  assert.ok(before && !before.deleted);
  for (const name of fs.readdirSync(f.v.path)) fs.rmSync(path.join(f.v.path, name), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  await assert.rejects(f.daemon.engine.cycle(), /marker|ENOENT|unavailable/i);
  const after = f.s.current(f.v.id, "Heat (1995).mp4");
  assert.equal(after.deleted, before.deleted, "an unmounted disk records no deletions");
  assert.equal(after.rev, before.rev);
});

test("edits that would need a second copy are refused in a video folder, and the web downloads the file in place", async (t) => {
  const f = await hub(t);
  await f.call("/v1/video/mark", { volume: f.v.id });
  const film = clip({ seconds: 1, tone: 700 });
  fs.writeFileSync(path.join(f.v.path, "Heat.mp4"), film);
  await f.daemon.engine.cycle();
  const row = f.s.current(f.v.id, "Heat.mp4");
  await assert.rejects(f.call("/v1/rename-file", { volume: f.v.id, path: "Heat.mp4", name: "Heat (1995).mp4", rev: row.rev }), { status: 409 });
  await assert.rejects(f.call("/v1/unselect", { id: f.v.id }), { status: 409 });
  await assert.rejects(f.call("/v1/conflict-choice", { volume: f.v.id, path: "Heat.mp4", choice: "original" }), { status: 409 });
  assert.equal(f.s.db.prepare("SELECT count(*) AS n FROM pending").get().n, 0, "nothing is left half done");
  assert.ok(fs.existsSync(path.join(f.v.path, "Heat.mp4")));
  const download = await fetch(`http://127.0.0.1:${f.daemon.port}/v1/gallery/download?${new URLSearchParams({ volume: f.v.id, path: "Heat.mp4", hash: row.hash })}`, {
    headers: { Authorization: `Bearer ${f.daemon.engine.config.adminToken}` },
  });
  assert.equal(download.status, 200);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), film);
});

test("the quick identity reads only the ends of a big video and still tells files apart", async (t) => {
  const os = await import("node:os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arca-quick-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const big = Buffer.alloc(12 * 1024 * 1024, 7);
  const a = path.join(dir, "a.mkv");
  const b = path.join(dir, "b.mkv");
  fs.writeFileSync(a, big);
  const changedEnd = Buffer.from(big);
  changedEnd[changedEnd.length - 1] = 9;
  fs.writeFileSync(b, changedEnd);
  assert.notEqual(quickHashFile(a), quickHashFile(b), "a different last byte is a different file");
  const longer = Buffer.concat([big, Buffer.from([7])]);
  fs.writeFileSync(b, longer);
  assert.notEqual(quickHashFile(a), quickHashFile(b), "so is a different size");
  fs.writeFileSync(b, big);
  assert.equal(quickHashFile(a), quickHashFile(b));
  assert.match(quickHashFile(a), /^[a-f0-9]{64}$/);
});

test("deleting a video from the library removes the file even though its identity is the quick one", async (t) => {
  const f = await hub(t);
  await f.call("/v1/video/mark", { volume: f.v.id });
  fs.writeFileSync(path.join(f.v.path, "Heat.mp4"), clip({ seconds: 1, tone: 800 }));
  await f.daemon.engine.cycle();
  const row = f.s.current(f.v.id, "Heat.mp4");
  await f.call("/v1/delete-file", { volume: f.v.id, path: "Heat.mp4", rev: row.rev });
  assert.equal(fs.existsSync(path.join(f.v.path, "Heat.mp4")), false);
  assert.deepEqual(fs.readdirSync(f.v.path).filter((name) => name.includes("conflict")), [], "no displaced copy is left behind");
  assert.equal(f.s.current(f.v.id, "Heat.mp4").deleted, 1);
});

test("a folder that already held films before it became a library deletes and downloads them, and an uploaded film too", async (t) => {
  const f = await hub(t);
  const before = clip({ seconds: 1, tone: 910 });
  fs.writeFileSync(path.join(f.v.path, "Heat.mp4"), before);
  await f.daemon.engine.cycle();
  await f.call("/v1/video/mark", { volume: f.v.id });
  await f.daemon.engine.cycle();
  const marked = f.s.current(f.v.id, "Heat.mp4");
  assert.equal(marked.hash, quickHashFile(path.join(f.v.path, "Heat.mp4")));
  const uploaded = clip({ seconds: 1, tone: 920 });
  const full = await f.propose("Up.mp4", uploaded);
  await f.daemon.engine.cycle();
  const up = f.s.current(f.v.id, "Up.mp4").hash;
  assert.equal(up, quickHashFile(path.join(f.v.path, "Up.mp4")), "an uploaded film takes its quick identity at the next scan, so one kind of identity holds in the folder");
  fs.rmSync(f.s.blob(full), { force: true });
  const download = await fetch(`http://127.0.0.1:${f.daemon.port}/v1/gallery/download?${new URLSearchParams({ volume: f.v.id, path: "Up.mp4", hash: up })}`, {
    headers: { Authorization: `Bearer ${f.daemon.engine.config.adminToken}` },
  });
  assert.equal(download.status, 200, "an uploaded film downloads after its object is gone");
  await download.arrayBuffer();
  await f.settled();
  await f.call("/v1/delete-file", { volume: f.v.id, path: "Heat.mp4", rev: marked.rev });
  await f.call("/v1/delete-file", { volume: f.v.id, path: "Up.mp4", rev: f.s.current(f.v.id, "Up.mp4").rev });
  assert.deepEqual(fs.readdirSync(f.v.path).filter((name) => name.endsWith(".mp4") || name.includes("conflict")), [], "both are really gone");
  await f.daemon.engine.cycle();
  assert.equal(f.s.current(f.v.id, "Heat.mp4").deleted, 1, "and they do not come back");
});

test("folders marked before quick identities existed get them once at start", async (t) => {
  const f = await hub(t);
  fs.writeFileSync(path.join(f.v.path, "Heat.mp4"), clip({ seconds: 1, tone: 930 }));
  await f.daemon.engine.cycle();
  f.s.db.prepare("INSERT INTO video_folders VALUES(?)").run(f.v.id);
  delete f.s.config.quickVideo;
  f.daemon.engine.video.resume();
  await f.daemon.engine.cycle();
  assert.equal(f.s.current(f.v.id, "Heat.mp4").hash, quickHashFile(path.join(f.v.path, "Heat.mp4")));
  assert.deepEqual(f.s.config.quickVideo, [f.v.id]);
});

test("devices cannot sync a video folder's changes or snapshot, and it never moves through Change location", async (t) => {
  const f = await hub(t);
  await f.call("/v1/video/mark", { volume: f.v.id });
  const phone = await f.call("/v1/devices", { name: "Phone", role: "replica" });
  for (const route of [`/v1/changes?volume=${f.v.id}&after=0`, `/v1/snapshot?volume=${f.v.id}`])
    await assert.rejects(f.call(route, undefined, phone.token), { status: 409 }, route);
  await assert.rejects(f.call("/v1/move-folder", { id: f.v.id, path: path.join(f.home, "elsewhere") }), { status: 409 });
});

test("a player deletes a film with the rev its library gave it, and the deletion is its own", async (t) => {
  const f = await hub(t);
  await f.call("/v1/video/mark", { volume: f.v.id });
  fs.writeFileSync(path.join(f.v.path, "Heat.mp4"), clip({ seconds: 1, tone: 940 }));
  await f.daemon.engine.cycle();
  const { code } = await f.call("/v1/pairing", { name: "TV" });
  const tv = await f.call("/pair", { code, kind: "player", name: "salon-tv" });
  const movie = (await f.settled(tv.token)).other.concat((await f.settled(tv.token)).movies)[0];
  assert.equal(movie.rev, f.s.current(f.v.id, "Heat.mp4").rev, "the library carries the rev a deletion needs");
  await f.call("/v1/delete-file", { volume: f.v.id, path: movie.path, rev: movie.rev }, tv.token);
  assert.equal(fs.existsSync(path.join(f.v.path, "Heat.mp4")), false);
  const head = f.s.db.prepare("SELECT author FROM revisions WHERE volume=? AND path=? ORDER BY rev DESC LIMIT 1").get(f.v.id, "Heat.mp4");
  assert.equal(head.author, tv.id, "History names the TV, not the hub");
  assert.ok((await f.call("/v1/catalog", undefined, tv.token)).devices.some((d) => d.id === tv.id && d.name === "salon-tv"));
});
