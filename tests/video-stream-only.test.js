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

test("a video folder's leftover objects are collected, a deletion through Arca keeps a version under the folder's retention, and backups skip it", async (t) => {
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
  const current = f.s.current(f.v.id, "Heat (1995).mp4");
  assert.equal(current.hash, quickHashFile(path.join(f.v.path, "Heat (1995).mp4")), "marking the folder gave the film its quick identity");
  const media = await fetch(`http://127.0.0.1:${f.daemon.port}/v1/video/media?${new URLSearchParams({ volume: f.v.id, path: "Heat (1995).mp4", hash: current.hash })}`, {
    headers: { Authorization: `Bearer ${f.daemon.engine.config.adminToken}` },
  });
  assert.equal(media.status, 200, "and the film still plays from the folder");

  await f.call("/v1/delete-file", { volume: f.v.id, path: "Heat (1995).mp4", rev: current.rev });
  const version = path.join(f.v.path, ".arca-versions", current.hash);
  assert.deepEqual(fs.readFileSync(version), film, "the deleted film moves beside the folder as a version");
  assert.equal(fs.existsSync(f.s.blob(current.hash)), false, "never into the hub's objects");
  assert.ok(Date.now() - fs.statSync(version).mtimeMs < 60000, "dated now, so cleanup gives it its grace period");
  applyFolderRetention(f.s);
  assert.ok(fs.existsSync(version), "a fresh version survives cleanup");
  fs.utimesSync(version, old, old);
  applyFolderRetention(f.s);
  assert.ok(fs.existsSync(version), "the folder's retention keeps it like any version");
  const history = await f.call(`/v1/history?${new URLSearchParams({ volume: f.v.id, path: "Heat (1995).mp4" })}`);
  assert.equal(history.versions.find((row) => row.rev === current.rev).kept, true);
  await f.call("/v1/restore", { volume: f.v.id, path: "Heat (1995).mp4", rev: current.rev });
  assert.deepEqual(fs.readFileSync(path.join(f.v.path, "Heat (1995).mp4")), film, "and restoring puts it back");
  assert.equal(fs.existsSync(version), false, "by moving it, not copying it");
  const library = await f.settled();
  assert.equal([...library.movies, ...library.other].length, 1, "the versions folder never reaches the library");
  const archive = await f.call("/v1/archive?limit=1000&after=0");
  assert.equal(archive.revisions.some((row) => row.volume === f.v.id), false, "backups never ask for a video folder's content");
  assert.ok(archive.revisions.some((row) => row.volume === docs.id));
});

test("with history off, a video deleted through Arca leaves nothing behind", async (t) => {
  const f = await hub(t);
  await f.call("/v1/video/mark", { volume: f.v.id });
  fs.writeFileSync(path.join(f.v.path, "Heat.mp4"), clip({ seconds: 1, tone: 530 }));
  await f.daemon.engine.cycle();
  const objects = () => fs.readdirSync(f.s.objects).filter((name) => /^[a-f0-9]{64}$/.test(name));
  assert.deepEqual(objects(), [], "a current video never has a second copy");
  const preview = await f.call("/v1/folder-retention", { id: f.v.id, mode: "off" });
  await f.call("/v1/folder-retention", { id: f.v.id, mode: "off", apply: true, confirmation: preview.confirmation });
  const row = f.s.current(f.v.id, "Heat.mp4");
  await f.call("/v1/delete-file", { volume: f.v.id, path: "Heat.mp4", rev: row.rev });
  assert.equal(fs.existsSync(path.join(f.v.path, "Heat.mp4")), false);
  assert.deepEqual(objects(), [], "no version is kept");
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

test("renaming or stopping a video folder on the hub is refused, and the web downloads the file in place", async (t) => {
  const f = await hub(t);
  await f.call("/v1/video/mark", { volume: f.v.id });
  const film = clip({ seconds: 1, tone: 700 });
  fs.writeFileSync(path.join(f.v.path, "Heat.mp4"), film);
  await f.daemon.engine.cycle();
  const row = f.s.current(f.v.id, "Heat.mp4");
  await assert.rejects(f.call("/v1/rename-file", { volume: f.v.id, path: "Heat.mp4", name: "Heat (1995).mp4", rev: row.rev }), { status: 409 });
  await assert.rejects(f.call("/v1/unselect", { id: f.v.id }), { status: 409 });
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

test("devices read a video folder's changes and snapshot, and it never moves through Change location", async (t) => {
  const f = await hub(t);
  await f.call("/v1/video/mark", { volume: f.v.id });
  const phone = await f.call("/v1/devices", { name: "Phone", role: "replica" });
  for (const route of [`/v1/changes?volume=${f.v.id}&after=0`, `/v1/snapshot?volume=${f.v.id}`])
    assert.ok(await f.call(route, undefined, phone.token), route);
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

test("a version whose content is gone is marked and refused, never half restored", async (t) => {
  const f = await hub(t);
  await f.call("/v1/video/mark", { volume: f.v.id });
  const file = path.join(f.v.path, "Heat.mp4");
  fs.writeFileSync(file, clip({ seconds: 1, tone: 540 }));
  await f.daemon.engine.cycle();
  const first = f.s.current(f.v.id, "Heat.mp4");
  fs.writeFileSync(file, clip({ seconds: 1, tone: 550 }));
  await f.daemon.engine.cycle();
  const history = await f.call(`/v1/history?${new URLSearchParams({ volume: f.v.id, path: "Heat.mp4" })}`);
  assert.equal(history.versions.find((row) => row.rev === first.rev).kept, false, "a change made on the hub's disk keeps no version");
  await assert.rejects(f.call("/v1/restore", { volume: f.v.id, path: "Heat.mp4", rev: first.rev }), { status: 409, message: "This version is no longer kept" });
  assert.equal(f.s.db.prepare("SELECT count(*) AS n FROM pending").get().n, 0, "nothing is left pending");
  await f.daemon.engine.cycle();
  assert.equal(f.s.current(f.v.id, "Heat.mp4").hash, quickHashFile(file), "the folder stays healthy");
});

test("a version matched by its full hash is kept under that hash, so its revision still protects it", async (t) => {
  const { applyFolderRetention } = await import("../packages/daemon/maintenance.js");
  const f = await hub(t);
  const film = clip({ seconds: 1, tone: 560 });
  const full = await f.propose("Heat.mp4", film);
  await f.daemon.engine.cycle();
  f.s.db.prepare("INSERT INTO video_folders VALUES(?)").run(f.v.id);
  const row = f.s.current(f.v.id, "Heat.mp4");
  assert.equal(row.hash, full);
  await f.call("/v1/delete-file", { volume: f.v.id, path: "Heat.mp4", rev: row.rev });
  const version = path.join(f.v.path, ".arca-versions", full);
  assert.deepEqual(fs.readFileSync(version), film);
  const old = new Date(Date.now() - 48 * 3600000);
  fs.utimesSync(version, old, old);
  applyFolderRetention(f.s);
  assert.ok(fs.existsSync(version), "its revision protects it");
});

test("a version that cannot be moved beside its file refuses the change instead of copying it", async (t) => {
  const f = await hub(t);
  await f.call("/v1/video/mark", { volume: f.v.id });
  const file = path.join(f.v.path, "Heat.mp4");
  fs.writeFileSync(file, clip({ seconds: 1, tone: 570 }));
  await f.daemon.engine.cycle();
  const row = f.s.current(f.v.id, "Heat.mp4");
  const rename = fs.renameSync;
  const copy = fs.copyFileSync;
  const copies = [];
  t.after(() => {
    fs.renameSync = rename;
    fs.copyFileSync = copy;
  });
  fs.renameSync = (from, to) => {
    if (String(to).includes(".arca-versions")) throw Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" });
    return rename(from, to);
  };
  fs.copyFileSync = (from, to) => {
    copies.push(to);
    return copy(from, to);
  };
  await assert.rejects(f.call("/v1/delete-file", { volume: f.v.id, path: "Heat.mp4", rev: row.rev }), { status: 409 });
  fs.renameSync = rename;
  fs.copyFileSync = copy;
  assert.deepEqual(copies, [], "nothing is copied");
  assert.ok(fs.existsSync(file), "the film stays in place");
  assert.equal(f.s.current(f.v.id, "Heat.mp4").deleted, 0, "and the deletion was never recorded");
  assert.equal(f.s.db.prepare("SELECT count(*) AS n FROM pending").get().n, 0);
});

async function retiredFilm(t, tone) {
  const f = await hub(t);
  await f.call("/v1/video/mark", { volume: f.v.id });
  const film = clip({ seconds: 1, tone });
  const file = path.join(f.v.path, "Heat.mp4");
  fs.writeFileSync(file, film);
  await f.daemon.engine.cycle();
  const row = f.s.current(f.v.id, "Heat.mp4");
  await f.call("/v1/delete-file", { volume: f.v.id, path: "Heat.mp4", rev: row.rev });
  return { f, film, file, row, version: path.join(f.v.path, ".arca-versions", row.hash) };
}

test("Delete shared folder on a video library removes the versions it kept beside the files", async (t) => {
  const { f, version } = await retiredFilm(t, 580);
  assert.ok(fs.existsSync(version));
  fs.writeFileSync(path.join(f.v.path, "own.txt"), "mine");
  await f.call("/v1/delete-share", { id: f.v.id, confirmedName: f.v.name });
  assert.equal(fs.existsSync(path.join(f.v.path, ".arca-versions")), false, "Arca's history goes with the share");
  assert.equal(fs.readFileSync(path.join(f.v.path, "own.txt"), "utf8"), "mine", "the person's files stay");
});

test("restoring a version moves it straight into place, never through a temporary a recovery would sweep, and needs no free space", async (t) => {
  const { f, film, file, row, version } = await retiredFilm(t, 590);
  const renames = [];
  const rename = fs.renameSync;
  const statfs = fs.statfsSync;
  t.after(() => {
    fs.renameSync = rename;
    fs.statfsSync = statfs;
  });
  fs.renameSync = (from, to) => {
    renames.push([String(from), String(to)]);
    return rename(from, to);
  };
  fs.statfsSync = (where, options) => ({ ...statfs(where, options), bavail: 0n });
  await f.call("/v1/restore", { volume: f.v.id, path: "Heat.mp4", rev: row.rev });
  fs.renameSync = rename;
  fs.statfsSync = statfs;
  assert.deepEqual(fs.readFileSync(file), film);
  assert.deepEqual(renames.filter(([from]) => from === version), [[version, file]]);
});

test("a stale probe left in the versions folder is cleaned up", async (t) => {
  const { applyFolderRetention } = await import("../packages/daemon/maintenance.js");
  const { f } = await retiredFilm(t, 600);
  const probe = path.join(f.v.path, ".arca-versions", `.arca-${"1".repeat(8)}-1111-1111-1111-${"1".repeat(12)}`);
  fs.writeFileSync(probe, "");
  const old = new Date(Date.now() - 120000);
  fs.utimesSync(probe, old, old);
  applyFolderRetention(f.s);
  assert.equal(fs.existsSync(probe), false);
});
