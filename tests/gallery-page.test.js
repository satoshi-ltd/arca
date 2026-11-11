import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store, init } from "../packages/daemon/storage.js";
import { start } from "../packages/daemon/server.js";
import { Gallery } from "../packages/daemon/gallery.js";

const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
const query = (values = {}) => new URLSearchParams(values);

function library(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-gallery-page-"));
  init(home, { name: "hub", role: "hub", port: 0 });
  const store = new Store(home);
  const gallery = new Gallery(store);
  gallery.prepare = () => {};
  t.after(() => {
    gallery.close();
    store.close();
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const v = store.addVolume("Camera");
  let rev = 0;
  const add = (name, captured = null, volume = v) => {
    const hash = digest(name);
    store.setFile({ volume: volume.id, path: name, hash, size: 1, deleted: 0, rev: ++rev, directory: 0 });
    store.db
      .prepare("INSERT INTO gallery_metadata(hash,captured,date_checked) VALUES(?,?,2) ON CONFLICT(hash) DO UPDATE SET captured=excluded.captured")
      .run(hash, captured);
    return hash;
  };
  const prepare = store.db.prepare.bind(store.db);
  const seen = [];
  store.db.prepare = (sql) => {
    seen.push(sql);
    return prepare(sql);
  };
  const reads = () => seen.filter((sql) => /WITH media|arca_media_kind/.test(sql)).length;
  const page = (values) => gallery.page(v.id, query(values));
  const names = async (values) => (await page(values)).items.map((row) => row.path);
  return { store, gallery, v, add, reads, page, names };
}

test("an unchanged library is read once for every page, the periods and the memories", async (t) => {
  const f = library(t);
  for (let n = 0; n < 130; n++) f.add(`IMG_${String(n).padStart(4, "0")}.jpg`, `2024-0${1 + (n % 9)}-10T10:00:${String(n % 60).padStart(2, "0")}`);
  const first = await f.page();
  assert.equal(first.items.length, 60);
  assert.equal(first.indexing, false);
  const once = f.reads();
  assert.equal(once, 2, "the capture-date probe and the photo rows");
  const second = await f.page({ after: first.next });
  assert.equal(second.items.length, 60);
  assert.deepEqual((await f.page({ after: second.next })).items.length, 10);
  assert.equal((await f.page({ month: "2024-03" })).items[0].date.slice(0, 7), "2024-03");
  assert.equal(f.gallery.periods(f.v.id, query({ level: "month" })).periods.length, 9);
  assert.equal(f.gallery.memories(f.v.id, query({ day: "03-10", year: "2026" })).memories[0].year, "2024");
  assert.equal(f.reads(), once, "no further read of the library");
  const other = f.store.addVolume("Documents");
  f.store.setFile({ volume: other.id, path: "notes.txt", hash: digest("notes"), size: 5, deleted: 0, rev: 900, directory: 0 });
  f.store.db
    .prepare("INSERT INTO revisions(volume,path,hash,size,deleted,author,created,directory) VALUES(?,?,?,5,0,'hub',?,0)")
    .run(other.id, "notes.txt", digest("notes"), "2026-01-01T00:00:00.000Z");
  await f.page();
  assert.equal(f.reads(), once, "nor after another folder changed");
});

test("the two galleries read last stay in memory", async (t) => {
  const f = library(t);
  const [a, b, c] = [f.v, f.store.addVolume("Second"), f.store.addVolume("Third")];
  for (const [n, volume] of [a, b, c].entries()) f.add(`photo-${n}.jpg`, "2024-01-01T10:00:00", volume);
  const read = async (volume) => {
    const before = f.reads();
    await f.gallery.page(volume.id, query());
    return f.reads() > before;
  };
  assert.deepEqual([await read(a), await read(b), await read(a), await read(c)], [true, true, false, true]);
  assert.equal(await read(a), false, "the gallery read again most recently is kept");
  assert.equal(await read(b), true, "the one read longest ago is not");
});

test("a new photo, a date, a Live Photo pairing, an exclusion and a pruned version each show in the next page", async (t) => {
  const f = library(t);
  f.add("a.jpg", "2024-01-01T10:00:00");
  f.add("a.mov", "2024-01-01T10:00:01");
  assert.deepEqual(await f.names(), ["a.mov", "a.jpg"]);
  let reads = f.reads();
  const reread = async (label) => {
    await f.page();
    assert.ok(f.reads() > reads, label);
    reads = f.reads();
    await f.page();
    assert.equal(f.reads(), reads, `${label}, once`);
  };

  f.add("b.jpg", "2024-02-01T10:00:00");
  assert.deepEqual(await f.names(), ["b.jpg", "a.mov", "a.jpg"]);
  await reread("a new photo");

  f.store.db.prepare("UPDATE gallery_metadata SET captured=? WHERE hash=?").run("2023-06-01T10:00:00", digest("b.jpg"));
  assert.deepEqual(await f.names(), ["a.mov", "a.jpg", "b.jpg"]);
  await reread("a capture date");

  f.store.db
    .prepare("INSERT INTO gallery_assets(volume,source,asset,resources,deleted) VALUES(?,?,?,?,0)")
    .run(f.v.id, "phone", "live", JSON.stringify([{ path: "a.jpg" }, { path: "a.mov" }]));
  await reread("an asset");
  for (const name of ["a.jpg", "a.mov"])
    f.store.db.prepare("INSERT OR REPLACE INTO gallery_members(volume,path,source,asset) VALUES(?,?,?,?)").run(f.v.id, name, "phone", "live");
  assert.deepEqual(await f.names(), ["a.jpg", "b.jpg"], "a Live Photo's video hides behind its photo");
  f.store.db.prepare("UPDATE gallery_assets SET deleted=1 WHERE asset=?").run("live");
  assert.deepEqual(await f.names(), ["a.mov", "a.jpg", "b.jpg"]);
  f.store.db.prepare("UPDATE gallery_assets SET deleted=0 WHERE asset=?").run("live");
  assert.deepEqual(await f.names(), ["a.jpg", "b.jpg"]);
  f.store.db.prepare("DELETE FROM gallery_members WHERE path=?").run("a.mov");
  assert.deepEqual(await f.names(), ["a.mov", "a.jpg", "b.jpg"]);
  f.store.db.prepare("INSERT OR REPLACE INTO gallery_members(volume,path,source,asset) VALUES(?,?,?,?)").run(f.v.id, "a.mov", "phone", "live");
  assert.deepEqual(await f.names(), ["a.jpg", "b.jpg"]);
  f.store.db.prepare("DELETE FROM gallery_assets WHERE asset=?").run("live");
  assert.deepEqual(await f.names(), ["a.mov", "a.jpg", "b.jpg"], "a removed asset pairs nothing");

  f.store.setFile({ volume: f.v.id, path: "raw.jpg", hash: digest("raw.jpg"), size: 1, deleted: 0, rev: 50, directory: 0 });
  assert.deepEqual([(await f.page()).indexing, (await f.page()).undated.count], [true, 1]);
  f.store.db.prepare("INSERT INTO gallery_metadata(hash,captured,date_checked) VALUES(?,?,1)").run(digest("raw.jpg"), "2025-01-01T10:00:00");
  assert.deepEqual([(await f.page()).indexing, (await f.names())[0]], [false, "raw.jpg"], "a first capture date dates it");
  f.store.setFile({ volume: f.v.id, path: "raw.jpg", hash: null, size: 0, deleted: 1, rev: 51, directory: 0 });

  const undated = f.add("scan.png");
  assert.equal((await f.page()).undated.count, 1);
  f.store.rememberAddedDate(f.v.id, "scan.png", undated, "2022-03-04T05:06:07.000Z");
  assert.deepEqual([(await f.page()).undated.count, (await f.names()).at(-1)], [0, "scan.png"], "an added date dates it");
  f.store.rememberAddedDate(f.v.id, "scan.png", undated, "2025-03-04T05:06:07.000Z");
  assert.equal((await f.names())[0], "scan.png", "and a corrected one moves it");
  f.store.db.prepare("DELETE FROM added_dates WHERE path=?").run("scan.png");
  assert.equal((await f.page()).undated.count, 1);
  const { lastInsertRowid } = f.store.db
    .prepare("INSERT INTO revisions(volume,path,hash,size,deleted,author,created,directory) VALUES(?,?,?,1,0,'hub',?,0)")
    .run(f.v.id, "scan.png", undated, "2021-01-02T03:04:05.000Z");
  assert.equal((await f.page()).items.at(-1).date, "2021-01-02T03:04:05.000Z", "its first version dates it");
  f.store.db.prepare("DELETE FROM revisions WHERE rev=?").run(lastInsertRowid);
  assert.equal((await f.page()).undated.count, 1, "and a pruned version stops dating it");

  fs.writeFileSync(path.join(f.v.path, ".arcaignore"), "a.mov\n");
  assert.deepEqual(await f.names(), ["a.jpg", "b.jpg", "scan.png"], "an excluded name leaves");
  f.store.setFile({ volume: f.v.id, path: "a.jpg", hash: null, size: 0, deleted: 1, rev: 99, directory: 0 });
  assert.deepEqual(await f.names(), ["b.jpg", "scan.png"], "a deleted photo leaves");
});

test("pages, month jumps and both directions follow SQLite's byte order of date and name, beyond ASCII and with dates of every length", async (t) => {
  const f = library(t);
  const day = "2024-05-03T10:00:00";
  for (const name of ["～.jpg", "\u{1F600}.jpg", ".jpg", "é.jpg", "z.jpg", "Z.jpg", "~.jpg"]) f.add(name, day);
  for (let n = 0; n < 70; n++) f.add(`Phone-ab12/2024/05/${String(n).padStart(3, "0")}.jpg`);
  for (let n = 0; n < 40; n++) f.add(`IMG_202405${String(1 + (n % 28)).padStart(2, "0")}_${n}.jpg`);
  for (let n = 0; n < 40; n++) f.add(`shot-${n}.jpg`, `2024-0${4 + (n % 3)}-${String(1 + (n % 28)).padStart(2, "0")}T08:00:${String(n).padStart(2, "0")}`);
  for (let n = 0; n < 5; n++) f.add(`undated-${n}.png`);
  const walked = [];
  for (let next = "", guard = 0; guard < 10; guard++) {
    const data = await f.page(next ? { after: next } : {});
    walked.push(...data.items.map((row) => row.cursor));
    if (!(next = data.next)) break;
  }
  assert.equal(walked.length, 162);
  const order = f.store.db
    .prepare("SELECT value FROM json_each(?) ORDER BY value DESC")
    .all(JSON.stringify(walked))
    .map((row) => row.value);
  assert.deepEqual(walked, order, "the walk is SQLite's descending order");
  assert.notDeepEqual(order, [...order].sort().reverse(), "which is not the order of JavaScript strings here");
  assert.equal(new Set(walked).size, walked.length);
  assert.equal(walked.filter((cursor) => cursor.startsWith("!|")).length, 5, "undated photos close the walk");

  for (let at = 0; at < order.length; at++) {
    const cursor = order[at];
    const after = await f.page({ after: cursor });
    assert.deepEqual(after.items.map((row) => row.cursor), order.slice(at + 1, at + 61), `after ${at}`);
    assert.equal(after.next, at + 61 < order.length ? order[at + 60] : null);
    assert.equal(after.previous, null);
    const before = await f.page({ before: cursor });
    assert.deepEqual(before.items.map((row) => row.cursor), order.slice(Math.max(0, at - 60), at), `before ${at}`);
    assert.equal(before.previous, at > 60 ? order[at - 60] : null);
    assert.equal(before.next, null);
    const from = await f.page({ from: cursor });
    assert.deepEqual(from.items.map((row) => row.cursor), order.slice(at, at + 60), `from ${at}`);
    assert.equal(from.previous, at > 0 ? cursor : null);
  }
  const april = await f.page({ month: "2024-04" });
  const start = order.findIndex((cursor) => cursor < "2024-04~");
  assert.deepEqual(april.items.map((row) => row.cursor), order.slice(start, start + 60));
  assert.equal(april.previous, order[start]);

  const months = f.store.db
    .prepare("SELECT substr(value,1,7) AS month,count(*) AS count FROM json_each(?) WHERE value NOT LIKE '!|%' GROUP BY month ORDER BY month DESC")
    .all(JSON.stringify(order));
  assert.deepEqual(april.timeline.map(({ month, count }) => ({ month, count })), months.map((row) => ({ ...row })));
  assert.deepEqual(april.undated, { count: 5, videos: 0, rev: 162 });
});

test("a period's cover is its latest date and then name, and a memory's its earliest, whatever the cursor order says", async (t) => {
  const f = library(t);
  f.add("Phone-ab12/2024/05/z.jpg");
  f.add("a.jpg", "2024-05-01T10:00:00");
  f.add("b.jpg", "2024-05-01T10:00:00");
  f.add("clip.mp4", "2023-05-01T09:00:00");
  f.add("IMG_20230501_1.jpg");
  const cursors = (await f.page()).items.map((row) => row.cursor);
  assert.equal(cursors[0], "2024-05|Phone-ab12/2024/05/z.jpg", "the month-only date sorts first as a cursor");
  const [may, earlier] = f.gallery.periods(f.v.id, query({ level: "month" })).periods;
  assert.deepEqual({ ...may }, { period: "2024-05", latest: "2024-05", count: 3, path: "b.jpg", hash: digest("b.jpg"), rev: 3, kind: "image" });
  assert.deepEqual([earlier.period, earlier.count, earlier.path, earlier.kind], ["2023-05", 2, "clip.mp4", "video"]);
  assert.deepEqual(
    f.gallery.periods(f.v.id, query()).periods.map((row) => [row.period, row.count, row.path]),
    [
      ["2024", 3, "b.jpg"],
      ["2023", 2, "clip.mp4"],
    ],
  );
  const { memories } = f.gallery.memories(f.v.id, query({ day: "05-01", year: "2025" }));
  assert.deepEqual(
    memories.map((row) => [row.year, row.count, row.path, row.cursor, row.kind]),
    [
      ["2024", 2, "a.jpg", "2024-05-01T10:00:00|a.jpg", "image"],
      ["2023", 2, "IMG_20230501_1.jpg", "2023-05-01|IMG_20230501_1.jpg", "image"],
    ],
  );
  assert.deepEqual(f.gallery.memories(f.v.id, query({ day: "05-01", year: "2024" })).memories.map((row) => row.year), ["2023"]);
});

test("the event cursor moves when a folder's index changes without a new version, between syncs and not during one", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-gallery-events-"));
  init(home, { name: "hub", role: "hub", port: 0 });
  const daemon = await start(home, { timer: false });
  t.after(async () => {
    await daemon.close();
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const store = daemon.engine.store;
  const v = store.addVolume("Camera");
  const events = async (after = "none") =>
    (
      await (
        await fetch(`http://127.0.0.1:${daemon.port}/v1/events?after=${after}`, {
          headers: { Authorization: `Bearer ${daemon.engine.config.adminToken}` },
          signal: AbortSignal.timeout(5000),
        })
      ).json()
    ).cursor;
  const local = (name) =>
    store.db
      .prepare("INSERT INTO local_files(volume,path,hash,size,deleted,rev,directory,path_key) VALUES(?,?,?,?,?,?,?,?)")
      .run(v.id, name, digest(name), 3, 0, 0, 0, name);
  const cursor = await events();
  local("new.jpg");
  const moved = await events(cursor);
  assert.notEqual(moved, cursor, "a waiting client is told");
  daemon.engine.phase = "syncing";
  local("during.jpg");
  assert.equal(await events(), moved, "not for every file of a running sync");
  daemon.engine.phase = "idle";
  assert.notEqual(await events(), moved, "once it ends");
});

test("memories stop at twelve years and the timeline counts videos apart", async (t) => {
  const f = library(t);
  for (let year = 2005; year <= 2018; year++) f.add(`clip-${year}.mp4`, `${year}-07-04T10:00:00`);
  f.add("still.jpg", "2018-07-05T10:00:00");
  f.add("undated.mov");
  const { memories } = f.gallery.memories(f.v.id, query({ day: "07-04", year: "2026" }));
  assert.deepEqual(
    memories.map((row) => row.year),
    Array.from({ length: 12 }, (_, n) => String(2018 - n)),
  );
  assert.ok(memories.every((row) => row.kind === "video" && row.count === 1));
  const data = await f.page();
  assert.deepEqual({ ...data.timeline[0] }, { month: "2018-07", count: 2, rev: 15, videos: 1 });
  assert.deepEqual(data.undated, { count: 1, videos: 1, rev: 16 });
});

test("every statement that writes a table the gallery reads has a trigger that moves its counter", (t) => {
  const f = library(t);
  const tables = ["gallery_metadata", "gallery_members", "gallery_assets", "added_dates"];
  const root = new URL("../packages/", import.meta.url);
  const sources = fs
    .readdirSync(root, { recursive: true })
    .filter((name) => name.endsWith(".js") && !name.split(path.sep).includes("node_modules"))
    .map((name) => fs.readFileSync(new URL(name.split(path.sep).join("/"), root), "utf8"));
  const written = new Set();
  for (const source of sources) {
    for (const [, table] of source.matchAll(new RegExp(`DELETE FROM (${tables.join("|")})\\b`, "g"))) written.add(`${table} delete`);
    for (const [, table] of source.matchAll(new RegExp(`UPDATE (${tables.join("|")}) SET`, "g"))) written.add(`${table} update`);
    for (const match of source.matchAll(new RegExp(`INSERT(?: OR \\w+)? INTO (${tables.join("|")})\\b`, "g"))) {
      written.add(`${match[1]} insert`);
      if (/^[^;]*?DO UPDATE/.test(source.slice(match.index, match.index + 400).split(/\.run\(|\.get\(/)[0])) written.add(`${match[1]} update`);
    }
    assert.doesNotMatch(source, /UPDATE revisions\b/, "a version is added or pruned, never rewritten");
  }
  for (const known of ["gallery_metadata insert", "gallery_metadata update", "gallery_members insert", "gallery_members delete", "gallery_assets update", "gallery_assets delete", "added_dates update"])
    assert.ok(written.has(known), `the scan sees ${known}`);
  const triggers = new Set(f.store.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all().map((row) => row.name));
  for (const write of written) assert.ok(triggers.has(write.replace(" ", "_generation_")), `${write} moves the gallery counter`);
  for (const name of ["revisions_folder_insert", "revisions_folder_delete"]) assert.ok(triggers.has(name), name);
});
