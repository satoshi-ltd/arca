import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { init } from "../packages/daemon/storage.js";
import { start } from "../packages/daemon/server.js";

async function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-file-preview-"));
  init(home, { port: 0, name: "Preview hub" });
  const daemon = await start(home, { timer: false });
  t.after(async () => {
    await daemon.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const v = daemon.engine.store.addVolume("Docs");
  const api = async (route, token = daemon.engine.config.adminToken, body) => {
    const response = await fetch(`http://127.0.0.1:${daemon.port}${route}`, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const value = await response.json();
    if (!response.ok) throw Object.assign(new Error(value.error), { status: response.status });
    return value;
  };
  const add = async (name, content) => {
    fs.mkdirSync(path.dirname(path.join(v.path, name)), { recursive: true });
    fs.writeFileSync(path.join(v.path, name), content);
    await daemon.engine.cycle();
    return daemon.engine.store.current(v.id, name);
  };
  const preview = (name, hash) => api(`/v1/file-preview?${new URLSearchParams({ volume: v.id, path: name, hash })}`);
  return { daemon, v, api, add, preview };
}

test("a text file previews its first lines, other types and binary files preview nothing", async (t) => {
  const f = await fixture(t);
  const long = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n");
  const md = await f.add("notes/brief.md", "# Brief\r\nBudget approved\nThird");
  const big = await f.add("long.txt", long);
  const bin = await f.add("data.json", Buffer.from([123, 0, 1, 2, 125]));
  const img = await f.add("photo.png", "not really an image");
  const exact = await f.add("exact.txt", Array.from({ length: 24 }, (_, i) => `l${i + 1}`).join("\n") + "\n");
  const cr = await f.add("mac.txt", "a\rb\rc");
  const utf = await f.add("utf.txt", "é".repeat(2100));
  const dot = await f.add(".gitignore", "node_modules\n");
  const small = await f.preview("notes/brief.md", md.hash);
  assert.deepEqual(small, { kind: "text", lines: ["# Brief", "Budget approved", "Third"], truncated: false, size: md.size });
  const cut = await f.preview("long.txt", big.hash);
  assert.equal(cut.lines.length, 24);
  assert.equal(cut.truncated, true);
  assert.equal(cut.lines[0], "line 1");
  const edge = await f.preview("exact.txt", exact.hash);
  assert.equal(edge.lines.length, 24);
  assert.equal(edge.truncated, false, "exactly 24 lines with a trailing newline is not truncated");
  assert.deepEqual((await f.preview("mac.txt", cr.hash)).lines, ["a", "b", "c"], "a lone carriage return ends a line");
  const wide = await f.preview("utf.txt", utf.hash);
  assert.equal(wide.truncated, true);
  assert.ok(!wide.lines[0].includes("\uFFFD"), "a cut inside a multi-byte character leaves no replacement character");
  assert.deepEqual((await f.preview(".gitignore", dot.hash)).lines, ["node_modules"], "a dotfile previews as text");
  assert.deepEqual(await f.preview("data.json", bin.hash), { kind: "none" }, "a NUL byte means binary");
  assert.deepEqual(await f.preview("photo.png", img.hash), { kind: "none" }, "images preview through the gallery route");
});

test("a preview refuses a stale hash, a missing or ignored file and a replica credential", async (t) => {
  const f = await fixture(t);
  const file = await f.add("a.txt", "one");
  await assert.rejects(f.preview("a.txt", "0".repeat(64)), (error) => error.status === 404, "the hash must be the current one");
  await assert.rejects(f.preview("missing.txt", file.hash), (error) => error.status === 404);
  const invite = await f.api("/v1/devices", undefined, { name: "phone", role: "replica" });
  await assert.rejects(
    f.api(`/v1/file-preview?${new URLSearchParams({ volume: f.v.id, path: "a.txt", hash: file.hash })}`, invite.token),
    (error) => error.status === 401 || error.status === 403,
    "a replica credential does not read previews from the hub",
  );
  fs.writeFileSync(path.join(f.v.path, ".arcaignore"), "secret.txt\n");
  await f.add("secret.txt", "hidden");
  await f.daemon.engine.cycle();
  const hidden = f.daemon.engine.store.current(f.v.id, "secret.txt");
  assert.equal(hidden, undefined, "an ignored file never enters the index");
  await assert.rejects(f.preview("secret.txt", "1".repeat(64)), (error) => error.status === 404, "an ignored file has no preview");
});

test("search ranks names across folders, skips deleted, ignored and unmatched files and validates input", async (t) => {
  const f = await fixture(t);
  const other = f.daemon.engine.store.addVolume("Holiday photos");
  const put = async (volume, name, content = "x") => {
    fs.mkdirSync(path.dirname(path.join(volume.path, name)), { recursive: true });
    fs.writeFileSync(path.join(volume.path, name), content);
  };
  await put(f.v, "plans/site-plan.pdf");
  await put(f.v, "plans/plan.txt");
  await put(f.v, "old/planet.md");
  await put(f.v, "deep/folder/unplanned.txt");
  await put(f.v, "gone-plan.txt");
  await put(other, "2026/plan-b.jpg", "jpeg");
  await put(other, "tracks/Planet Earth.mp3", "mp3");
  fs.writeFileSync(path.join(f.v.path, ".arcaignore"), "secret-plan.txt\n");
  await put(f.v, "secret-plan.txt");
  await f.daemon.engine.cycle();
  fs.rmSync(path.join(f.v.path, "gone-plan.txt"));
  await f.daemon.engine.cycle();
  const search = (query, extra = {}) => f.api(`/v1/search?${new URLSearchParams({ q: query, ...extra })}`);
  const group = (data, type) => data.groups.find((entry) => entry.type === type);
  const all = await search("plan", { limit: "6" });
  assert.deepEqual(all.groups.map((entry) => entry.type), ["photos", "files"], "groups come in their fixed order and only when non-empty");
  assert.deepEqual(group(all, "files").rows.map((r) => r.name), ["plan.txt", "Planet Earth.mp3", "planet.md", "site-plan.pdf", "unplanned.txt"], "exact name first, then prefix, then contains; audio outside an audio library is a file");
  assert.deepEqual(group(all, "photos").rows.map((r) => r.name), ["plan-b.jpg"]);
  assert.equal(group(all, "photos").rows[0].folder, "Holiday photos");
  assert.equal(group(all, "files").count, 5);
  assert.ok(!JSON.stringify(all).includes("gone-plan"), "deleted files never match");
  assert.ok(!JSON.stringify(all).includes("secret-plan"), "ignored files never match");
  assert.deepEqual(group(await search("holiday"), "folders").rows.map((r) => r.name), ["Holiday photos"]);
  const narrowed = await search("plan", { type: "files", limit: "2" });
  assert.deepEqual(narrowed.groups.map((entry) => entry.type), ["files"], "a type narrows the search to that group");
  assert.equal(narrowed.groups[0].rows.length, 2);
  assert.equal(narrowed.groups[0].count, 5, "counts report every match");
  assert.deepEqual((await search("plan", { type: "files", limit: "2", offset: "2" })).groups[0].rows.map((r) => r.name), ["planet.md", "site-plan.pdf"], "Show all pages with an offset");
  assert.equal(group(await search("plan"), "files").rows.length, 3, "three rows per group by default");
  assert.deepEqual(group(await search("site pla"), "files").rows.map((r) => r.name), ["site-plan.pdf"], "every word must match");
  assert.deepEqual((await search("zzzz")).groups, []);
  for (const bad of ["q=", "q=x&type=music", "q=x&limit=0", "q=x&limit=99", "q=x&offset=-1", `q=${"a".repeat(101)}`])
    await assert.rejects(f.api(`/v1/search?${bad}`), (error) => error.status === 400, bad);
  const invite = await f.api("/v1/devices", undefined, { name: "phone", role: "replica" });
  await assert.rejects(f.api("/v1/search?q=plan", invite.token), (error) => error.status === 401 || error.status === 403);
});

test("search returns typed library groups with the ids each view needs, splits podcasts like the clients and finds photos by date", async (t) => {
  const f = await fixture(t);
  const s = f.daemon.engine.store;
  const music = s.addVolume("music");
  const photos = s.addVolume("photos");
  const put = (volume, name, content) => {
    fs.mkdirSync(path.dirname(path.join(volume.path, name)), { recursive: true });
    fs.writeFileSync(path.join(volume.path, name), content);
  };
  put(music, "Miles Davis/Kind of Blue/03 Blue in Green.mp3", "a");
  put(music, "Miles Davis/Kind of Blue/01 So What.mp3", "b");
  put(music, "Blue Mitchell/Blue's Moods/01 I'll Close My Eyes.mp3", "c");
  put(music, "Podcasts/The Wild Project/2026-09-01 Blue zones.mp3", "d");
  put(music, "Playlists/Blue mood.m3u8", "#EXTM3U\n../Miles Davis/Kind of Blue/03 Blue in Green.mp3\n");
  put(photos, "2025/09/blue-door.jpg", "e");
  put(photos, "2025/09/sea.jpg", "f");
  put(photos, "2024/01/old.jpg", "g");
  await f.daemon.engine.cycle();
  s.db.prepare("INSERT INTO music_folders VALUES(?)").run(music.id);
  s.db.prepare("INSERT INTO gallery_folders VALUES(?)").run(photos.id);
  const tag = s.db.prepare(
    "INSERT OR REPLACE INTO music_tracks(hash,title,artist,album_artist,album,track,disc,year,genre,duration,codec,cover,checked,retry) VALUES(?,?,?,?,?,?,NULL,?,?,?,NULL,NULL,2,0)",
  );
  const hash = (volume, name) => s.current(volume.id, name).hash;
  tag.run(hash(music, "Miles Davis/Kind of Blue/03 Blue in Green.mp3"), "Blue in Green", "Miles Davis", "Miles Davis", "Kind of Blue", 3, 1959, "Jazz", 337);
  tag.run(hash(music, "Miles Davis/Kind of Blue/01 So What.mp3"), "So What", "Miles Davis", "Miles Davis", "Kind of Blue", 1, 1959, "Jazz", 562);
  tag.run(hash(music, "Blue Mitchell/Blue's Moods/01 I'll Close My Eyes.mp3"), "I'll Close My Eyes", "Blue Mitchell", "Blue Mitchell", "Blue's Moods", 1, 1960, "Jazz", 300);
  tag.run(hash(music, "Podcasts/The Wild Project/2026-09-01 Blue zones.mp3"), "Blue zones", null, null, "The Wild Project", null, null, "Podcast", 3600);
  const meta = s.db.prepare("INSERT OR REPLACE INTO gallery_metadata(hash,captured,date_checked) VALUES(?,?,2)");
  meta.run(hash(photos, "2025/09/blue-door.jpg"), "2025-09-14T10:00:00");
  meta.run(hash(photos, "2025/09/sea.jpg"), "2025-09-21T10:00:00");
  meta.run(hash(photos, "2024/01/old.jpg"), "2024-01-02T10:00:00");
  const search = (q, extra = {}) => f.api(`/v1/search?${new URLSearchParams({ q, ...extra })}`);
  const blue = await search("blue");
  assert.deepEqual(
    blue.groups.map((entry) => entry.type),
    ["songs", "albums", "artists", "episodes", "playlists", "photos"],
    "songs, albums, artists, episodes and playlists come in the board's order",
  );
  const group = (data, type) => data.groups.find((entry) => entry.type === type);
  const song = group(blue, "songs").rows[0];
  assert.deepEqual(
    { title: song.title, artist: song.artist, album: song.album, volume: song.volume, folder: song.folder, path: song.path },
    { title: "Blue in Green", artist: "Miles Davis", album: "Kind of Blue", volume: music.id, folder: "music", path: "Miles Davis/Kind of Blue/03 Blue in Green.mp3" },
  );
  assert.equal(group(blue, "songs").count, 3, "a song matches by its title, artist or album tag");
  const album = group(blue, "albums").rows.find((row) => row.title === "Kind of Blue");
  assert.equal(song.albumId, album.id, "a song carries the album id its library view opens");
  assert.equal(album.songs, 2);
  assert.deepEqual(group(blue, "artists").rows.map((row) => [row.name, row.albums, row.songs]), [["Blue Mitchell", 1, 1]]);
  const episode = group(blue, "episodes").rows[0];
  assert.deepEqual([episode.title, episode.show, episode.showId.startsWith("show:")], ["Blue zones", "The Wild Project", true], "a podcast is an episode, never a song");
  assert.ok(!group(blue, "songs").rows.some((row) => row.title === "Blue zones"));
  assert.deepEqual(group(blue, "playlists").rows.map((row) => [row.name, row.songs, row.id]), [["Blue mood", 1, "Playlists/Blue mood.m3u8"]]);
  assert.deepEqual(group(blue, "photos").rows.map((row) => row.name), ["blue-door.jpg"]);
  assert.equal(group(blue, "files"), undefined, "audio and playlists in an audio library are songs, episodes and playlists, not files");
  assert.deepEqual(group(await search("wild"), "shows").rows.map((row) => [row.name, row.episodes]), [["The Wild Project", 1]]);
  for (const q of ["September 2025", "sep 2025", "2025-09", "2025 september"]) {
    const dated = group(await search(q, { limit: "4" }), "photos");
    assert.equal(dated.count, 2, q);
    assert.equal(dated.label, "September 2025", q);
    assert.deepEqual(dated.rows.map((row) => row.name), ["sea.jpg", "blue-door.jpg"], `${q}: newest capture first`);
    assert.deepEqual(dated.periods.map((row) => [row.folder, row.count, row.cursor]), [["photos", 2, "2025-09-21T10:00:00|2025/09/sea.jpg"]], q);
    assert.equal(dated.rows[1].cursor, "2025-09-14T10:00:00|2025/09/blue-door.jpg", "a photo carries the gallery cursor its viewer opens at");
  }
  assert.equal(group(await search("2024"), "photos").count, 1, "a year matches capture dates");
  assert.equal(group(await search("january"), "photos").label, "January", "a month name matches every year");
  assert.equal(group(await search("mar"), "photos"), undefined, "a month abbreviation with no photos adds nothing");
});

test("date search skips epoch-zeroed captures and an undated photo carries the gallery's undated cursor", async (t) => {
  const f = await fixture(t);
  const s = f.daemon.engine.store;
  const photos = s.addVolume("photos");
  for (const [name, content] of [["epoch.jpg", "a"], ["summer.jpg", "b"], ["lost-pic.jpg", "c"], ["dated-pic.jpg", "d"]])
    fs.writeFileSync(path.join(photos.path, name), content);
  await f.daemon.engine.cycle();
  s.db.prepare("INSERT INTO gallery_folders VALUES(?)").run(photos.id);
  const hash = (name) => s.current(photos.id, name).hash;
  const meta = s.db.prepare("INSERT OR REPLACE INTO gallery_metadata(hash,captured,date_checked) VALUES(?,?,2)");
  meta.run(hash("epoch.jpg"), "1970-01-01T00:00:00");
  meta.run(hash("summer.jpg"), "1970-06-01T10:00:00");
  meta.run(hash("lost-pic.jpg"), null);
  meta.run(hash("dated-pic.jpg"), "2025-03-01T10:00:00");
  s.db.prepare("UPDATE revisions SET created='1970-01-01T00:00:00.000Z' WHERE volume=? AND path=?").run(photos.id, "lost-pic.jpg");
  const search = (q, extra = {}) => f.api(`/v1/search?${new URLSearchParams({ q, ...extra })}`);
  const group = (data, type) => data.groups.find((entry) => entry.type === type);
  const year = group(await search("1970", { type: "photos", limit: "10" }), "photos");
  assert.deepEqual(year.rows.map((row) => row.name), ["summer.jpg"], "an epoch-zeroed capture is no 1970 photo");
  const lost = group(await search("pic", { type: "photos", limit: "10" }), "photos").rows.find((row) => row.name === "lost-pic.jpg");
  assert.equal(lost.date, null);
  assert.equal(lost.cursor, "!|lost-pic.jpg");
  const page = await f.api(`/v1/gallery?${new URLSearchParams({ volume: photos.id, from: lost.cursor })}`);
  assert.equal(page.items[0].path, "lost-pic.jpg", "the viewer opens on the undated photo, in the undated tail");
});

test("search folds case for any script, ranks an older exact name above newer partial ones and survives an unreadable ignore file", async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.v.path, "Ñandú.txt"), "x");
  await f.daemon.engine.cycle();
  const files = async (q) => (await f.api(`/v1/search?${new URLSearchParams({ q, type: "files" })}`)).groups[0]?.rows || [];
  const search = async (q) => ({ files: await files(q) });
  assert.deepEqual((await search("ñandú")).files.map((r) => r.name), ["Ñandú.txt"], "an uppercase non-ASCII letter matches a lowercase query");
  assert.deepEqual((await search("ÑANDÚ")).files.map((r) => r.name), ["Ñandú.txt"]);
  assert.deepEqual((await search("nandu")).files.map((r) => r.name), ["Ñandú.txt"], "accents fold away");
  fs.writeFileSync(path.join(f.v.path, "report.pdf"), "x");
  await f.daemon.engine.cycle();
  for (let i = 0; i < 4; i++) fs.writeFileSync(path.join(f.v.path, `quarterly-report-${i}.pdf`), String(i));
  await f.daemon.engine.cycle();
  const found = await search("report");
  assert.equal(found.files[0].name, "report.pdf", "the exact name, extension aside, ranks first");
  const store = f.daemon.engine.store;
  const original = store.visibleRules.bind(store);
  store.visibleRules = () => { throw new Error("broken ignore policy"); };
  assert.deepEqual((await search("report")).files, [], "a volume with an unreadable ignore file is skipped instead of failing the search");
  store.visibleRules = original;
});
