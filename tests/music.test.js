import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import sharp from "sharp";
import ffmpeg from "ffmpeg-static";
import { init, digest, Store } from "../packages/daemon/storage.js";
import { start } from "../packages/daemon/server.js";
import { audioType, coverRank } from "../packages/daemon/music.js";

async function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-music-"));
  init(home, { port: 0, name: "Music hub" });
  const daemon = await start(home, { timer: false });
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "arca-music-src-"));
  t.after(async () => {
    await daemon.engine.music?.background;
    await daemon.close();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
  });
  const s = daemon.engine.store;
  const v = s.addVolume("Music");
  async function api(route, body, token = daemon.engine.config.adminToken) {
    const response = await fetch(`http://127.0.0.1:${daemon.port}${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-Arca-Directories": "1",
        "X-Arca-Path-Transitions": "1",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json();
    if (!response.ok)
      throw Object.assign(new Error(value.error), { status: response.status });
    return value;
  }
  async function propose(name, buffer, volume = v.id) {
    const hash = digest(buffer);
    if (!fs.existsSync(s.blob(hash))) fs.writeFileSync(s.blob(hash), buffer);
    await api("/v1/propose", {
      volume,
      path: name,
      hash,
      size: buffer.length,
      base: s.current(volume, name)?.rev || 0,
    });
    return hash;
  }
  let made = 0;
  async function track(name, tags = {}, { cover = null, seconds = 0.4 } = {}) {
    const extension = name.slice(name.lastIndexOf(".") + 1);
    const output = path.join(scratch, `${made++}.${extension}`);
    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=${300 + made * 40}:duration=${seconds}`,
    ];
    if (cover) {
      const image = path.join(scratch, `${made}-cover.jpg`);
      fs.writeFileSync(image, cover);
      args.push("-i", image, "-map", "0:a", "-map", "1:v", "-disposition:v:0", "attached_pic");
    }
    for (const [key, value] of Object.entries(tags))
      args.push("-metadata", `${key}=${value}`);
    if (extension === "mp3") args.push("-id3v2_version", "3");
    if (extension === "m4a") args.push("-c:a", "aac", ...(cover ? ["-c:v", "mjpeg"] : []));
    args.push(output);
    execFileSync(ffmpeg, args);
    const buffer = fs.readFileSync(output);
    return { hash: await propose(name, buffer), buffer };
  }
  const image = (color, size = 600) =>
    sharp({ create: { width: size, height: size, channels: 3, background: color } })
      .jpeg()
      .toBuffer();
  const library = (query = "") => api(`/v1/music/library?volume=${v.id}${query}`);
  async function indexed() {
    for (let i = 0; i < 50; i++) {
      await daemon.engine.music?.background;
      const value = await library();
      if (!value.indexing) return value;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("Music index did not finish");
  }
  return { home, daemon, s, v, api, propose, track, image, library, indexed };
}

test("audio and cover names are recognised by extension and rank", () => {
  assert.equal(audioType("A/b.MP3"), "audio/mpeg");
  assert.equal(audioType("song.flac"), "audio/flac");
  assert.equal(audioType("song.opus"), "audio/ogg");
  assert.equal(audioType("notes.txt"), null);
  assert.equal(audioType("mp3"), null);
  assert.ok(coverRank("Album/cover.jpg") < coverRank("Album/folder.png"));
  assert.ok(coverRank("Album/Folder.JPG") >= 0);
  assert.equal(coverRank("Album/back.jpg"), -1);
  assert.equal(coverRank("Album/cover.gif"), -1);
});

test("only the hub's administrator marks a music folder; a folder is a gallery or a music library, never both", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.library(), { status: 404 }, "an ordinary folder has no library");
  const invite = await f.api("/v1/devices", { name: "Phone", role: "replica" });
  await assert.rejects(f.api("/v1/music/mark", { volume: f.v.id }, invite.token), { status: 403 });
  await f.api("/v1/music/mark", { volume: f.v.id });
  await f.api("/v1/music/mark", { volume: f.v.id });
  const catalog = await f.api("/v1/catalog", undefined, invite.token);
  assert.equal(catalog.music, true);
  assert.equal(catalog.volumes[0].music, true);
  assert.equal(catalog.volumes[0].gallery, false);
  assert.equal(f.daemon.engine.status().volumes[0].music, true);
  assert.equal((await f.api("/v1/remote")).volumes[0].music, true);
  await assert.rejects(f.api("/v1/gallery/link", { volume: f.v.id }), {
    status: 409,
    message: /music library/,
  });
  const photos = f.s.addVolume("Photos");
  await f.api("/v1/gallery/link", { volume: photos.id });
  await assert.rejects(f.api("/v1/music/mark", { volume: photos.id }), {
    status: 409,
    message: /gallery/,
  });
  await assert.rejects(f.api("/v1/music/mark", { volume: "missing" }), { status: 404 });
  await f.api("/v1/delete-share", { id: f.v.id, confirmedName: "Music" });
  assert.equal(f.s.db.prepare("SELECT COUNT(*) n FROM music_folders").get().n, 0);
});

test("the library lists each track's tags with embedded or folder covers, newest additions dated", async (t) => {
  const f = await fixture(t);
  await f.api("/v1/music/mark", { volume: f.v.id });
  const embedded = await f.image("red");
  await f.track(
    "Miles Davis/Kind of Blue/02 So What.mp3",
    { title: "So What", artist: "Miles Davis", album_artist: "Miles Davis", album: "Kind of Blue", track: "2/5", disc: "1/1", date: "1959", genre: "Jazz" },
    { cover: embedded },
  );
  const folderCover = await f.propose("Coltrane/Blue Train/cover.jpg", await f.image("blue"));
  await f.track("Coltrane/Blue Train/CD1/01 Blue Train.flac", { title: "Blue Train", artist: "John Coltrane", album: "Blue Train", track: "1" });
  await f.track("Loose/untagged.ogg");
  await f.propose("Loose/notes.txt", Buffer.from("not music"));
  const library = await f.indexed();
  assert.equal(library.indexing, false);
  assert.deepEqual(
    library.tracks.map((row) => row.path),
    ["Coltrane/Blue Train/CD1/01 Blue Train.flac", "Loose/untagged.ogg", "Miles Davis/Kind of Blue/02 So What.mp3"],
  );
  const so = library.tracks.at(-1);
  assert.equal(so.title, "So What");
  assert.equal(so.artist, "Miles Davis");
  assert.equal(so.albumArtist, "Miles Davis");
  assert.equal(so.album, "Kind of Blue");
  assert.equal(so.track, 2);
  assert.equal(so.disc, 1);
  assert.equal(so.year, 1959);
  assert.equal(so.genre, "Jazz");
  assert.ok(so.duration > 0.2 && so.duration < 1);
  assert.match(so.codec, /MPEG/);
  assert.match(so.cover, /^[a-f0-9]{64}$/);
  assert.ok(Date.parse(so.added) > 0);
  const blue = library.tracks[0];
  assert.equal(blue.cover, folderCover, "a disc folder falls back to the album folder's cover.jpg");
  const loose = library.tracks[1];
  assert.equal(loose.title, null);
  assert.equal(loose.cover, null);
  const wide = await f.propose("Wide/cover.png", await sharp({ create: { width: 900, height: 500, channels: 3, background: "green" } }).png().toBuffer());
  await f.track("Wide/01 Wide.mp3", { title: "Wide" });
  const widened = (await f.indexed()).tracks.find((row) => row.title === "Wide");
  assert.equal(widened.cover, wide);
  for (const [key, size, pixels] of [
    [so.cover, "small", 360],
    [so.cover, "large", 600],
    [blue.cover, "small", 360],
    [wide, "small", 360],
    [wide, "large", 500],
  ]) {
    const cover = await f.api(`/v1/music/cover?${new URLSearchParams({ volume: f.v.id, key, size })}`);
    const meta = await sharp(Buffer.from(cover.data.split(",")[1], "base64")).metadata();
    assert.equal(meta.format, "jpeg");
    assert.equal(meta.width, pixels);
    assert.equal(meta.height, pixels);
  }
  const latest = await f.library();
  assert.notEqual(latest.version, library.version, "a new track changes the version");
  const unchanged = await f.library(`&version=${latest.version}`);
  assert.deepEqual(unchanged, { version: latest.version, indexing: false, unchanged: true });
});

test("deleted, ignored and foreign files never reach the library or its covers", async (t) => {
  const f = await fixture(t);
  await f.api("/v1/music/mark", { volume: f.v.id });
  const art = await f.image("green");
  await f.track("Keep/song.mp3", { title: "Keep" }, { cover: art });
  await f.track("Hide/secret.mp3", { title: "Secret" }, { cover: await f.image("purple") });
  await f.track("Gone/old.mp3", { title: "Old" });
  await f.api("/v1/propose", { volume: f.v.id, path: "Gone/old.mp3", hash: null, size: 0, base: f.s.current(f.v.id, "Gone/old.mp3").rev });
  let library = await f.indexed();
  const secret = library.tracks.find((row) => row.path === "Hide/secret.mp3");
  assert.ok(secret.cover);
  fs.writeFileSync(path.join(f.v.path, ".arcaignore"), "Hide/\n");
  library = await f.indexed();
  assert.deepEqual(library.tracks.map((row) => row.path), ["Keep/song.mp3"]);
  await assert.rejects(
    f.api(`/v1/music/cover?${new URLSearchParams({ volume: f.v.id, key: secret.cover })}`),
    { status: 404 },
  );
  await assert.rejects(
    f.api(`/v1/music/cover?${new URLSearchParams({ volume: f.v.id, key: "../../config" })}`),
    { status: 400 },
  );
  const other = f.s.addVolume("Other");
  await f.api("/v1/music/mark", { volume: other.id });
  const cover = library.tracks[0].cover;
  await assert.rejects(
    f.api(`/v1/music/cover?${new URLSearchParams({ volume: other.id, key: cover })}`),
    { status: 404 },
    "a cover is served only through a library that holds it",
  );
});

test("a renamed track keeps its tags without being read again, and a removed cover file is rendered again", async (t) => {
  const f = await fixture(t);
  await f.api("/v1/music/mark", { volume: f.v.id });
  const { hash, buffer } = await f.track("a.mp3", { title: "Same" }, { cover: await f.image("orange") });
  let library = await f.indexed();
  const cover = library.tracks[0].cover;
  const checked = f.s.db.prepare("SELECT * FROM music_tracks WHERE hash=?").get(hash);
  await f.propose("b/renamed.mp3", buffer);
  await f.api("/v1/propose", { volume: f.v.id, path: "a.mp3", hash: null, size: 0, base: f.s.current(f.v.id, "a.mp3").rev });
  library = await f.library();
  assert.equal(library.indexing, false);
  assert.deepEqual(library.tracks.map((row) => [row.path, row.title]), [["b/renamed.mp3", "Same"]]);
  assert.deepEqual(f.s.db.prepare("SELECT * FROM music_tracks WHERE hash=?").get(hash), checked);
  for (const name of fs.readdirSync(path.join(f.home, "music-covers")))
    fs.rmSync(path.join(f.home, "music-covers", name));
  const again = await f.api(`/v1/music/cover?${new URLSearchParams({ volume: f.v.id, key: cover })}`);
  assert.match(again.data, /^data:image\/jpeg;base64,/);
});

test("a paired phone reads the hub's library and covers with its device credential, and a replica daemon cannot mark a library", async (t) => {
  const f = await fixture(t);
  await f.api("/v1/music/mark", { volume: f.v.id });
  await f.track("x.mp3", { title: "X" }, { cover: await f.image("yellow") });
  await f.indexed();
  const invite = await f.api("/v1/devices", { name: "Phone", role: "replica" });
  const phone = await f.api(`/v1/music/library?volume=${f.v.id}`, undefined, invite.token);
  assert.equal(phone.tracks[0].title, "X");
  const cover = await f.api(`/v1/music/cover?${new URLSearchParams({ volume: f.v.id, key: phone.tracks[0].cover })}`, undefined, invite.token);
  assert.match(cover.data, /^data:image\/jpeg;base64,/);
  await f.api("/v1/revoke", { id: invite.id });
  await assert.rejects(f.api(`/v1/music/library?volume=${f.v.id}`, undefined, invite.token), { status: 401 });

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-music-replica-"));
  init(home, { port: 0, name: "Desk", role: "replica" });
  const replica = await start(home, { timer: false });
  t.after(async () => {
    await replica.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const call = async (route, body) => {
    const response = await fetch(`http://127.0.0.1:${replica.port}${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${replica.engine.config.adminToken}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error), { status: response.status });
    return data;
  };
  const desk = await f.api("/v1/devices", { name: "Desk", role: "replica" });
  await call("/v1/connect", { url: `http://127.0.0.1:${f.daemon.port}`, token: desk.token });
  await call("/v1/select", { id: f.v.id });
  await replica.engine.cycle();
  assert.equal(replica.engine.status().volumes[0].music, true);
  assert.equal(
    JSON.parse(fs.readFileSync(replica.engine.store.configPath, "utf8")).catalog.find((folder) => folder.id === f.v.id).music,
    true,
    "the replica keeps the hub's music flag in its saved catalog",
  );
  await assert.rejects(call("/v1/music/mark", { volume: f.v.id }), { status: 409 });
});

test("unreadable and excluded audio never stall the index, and missing content is retried later", async (t) => {
  const f = await fixture(t);
  await f.propose("Bad/broken.mp3", Buffer.from("not really an mp3 file at all"));
  const hidden = await f.track("Private/secret.mp3", { title: "Secret" });
  fs.writeFileSync(path.join(f.v.path, ".arcaignore"), "Private/\n");
  const late = await f.track("Later/late.mp3", { title: "Late" });
  const missing = late.hash;
  fs.rmSync(f.s.blob(missing));
  await f.api("/v1/music/mark", { volume: f.v.id });
  const library = await f.indexed();
  assert.equal(library.indexing, false);
  const broken = library.tracks.find((row) => row.path === "Bad/broken.mp3");
  assert.equal(broken.title, null, "an unreadable file is listed by name");
  assert.ok(f.s.db.prepare("SELECT checked FROM music_tracks WHERE hash=?").get(broken.hash).checked > 0, "an unreadable file is marked read");
  assert.equal(f.s.db.prepare("SELECT 1 FROM music_tracks WHERE hash=?").get(hidden.hash), undefined, "excluded audio is never read");
  const deferred = f.s.db.prepare("SELECT checked,retry FROM music_tracks WHERE hash=?").get(missing);
  assert.equal(deferred.checked, 0);
  assert.ok(deferred.retry > Date.now(), "content that cannot be read now is retried later");
  fs.writeFileSync(f.s.blob(missing), late.buffer);
  f.s.db.prepare("UPDATE music_tracks SET retry=0 WHERE hash=?").run(missing);
  f.daemon.engine.music.generation++;
  await f.library();
  const again = await f.indexed();
  assert.equal(again.tracks.find((row) => row.path === "Later/late.mp3").title, "Late");
  assert.ok(f.daemon.engine.music.indexed >= 2, "finished passes bump the change feed");
});

test("a moved track keeps the date it was first added, and deleting a library sweeps its tags and covers", async (t) => {
  const f = await fixture(t);
  await f.api("/v1/music/mark", { volume: f.v.id });
  const { hash, buffer } = await f.track("a.mp3", { title: "A" }, { cover: await f.image("pink") });
  fs.writeFileSync(path.join(f.v.path, "cover.jpg"), "placeholder");
  const before = (await f.indexed()).tracks[0];
  await new Promise((resolve) => setTimeout(resolve, 20));
  await f.propose("moved/a.mp3", buffer);
  await f.api("/v1/propose", { volume: f.v.id, path: "a.mp3", hash: null, size: 0, base: f.s.current(f.v.id, "a.mp3").rev });
  const after = (await f.indexed()).tracks[0];
  assert.equal(after.path, "moved/a.mp3");
  assert.equal(after.added, before.added);
  const covers = path.join(f.home, "music-covers");
  assert.ok(fs.readdirSync(covers).length >= 2);
  await f.api("/v1/delete-share", { id: f.v.id, confirmedName: "Music" });
  assert.equal(f.s.db.prepare("SELECT 1 FROM music_tracks WHERE hash=?").get(hash), undefined);
  assert.deepEqual(fs.readdirSync(covers), []);
});

test("an excluded folder cover is neither offered nor served", async (t) => {
  const f = await fixture(t);
  await f.api("/v1/music/mark", { volume: f.v.id });
  const cover = await f.propose("Album/cover.jpg", await f.image("navy"));
  await f.track("Album/01.mp3", { title: "One" });
  assert.equal((await f.indexed()).tracks[0].cover, cover);
  fs.writeFileSync(path.join(f.v.path, ".arcaignore"), "cover.jpg\n");
  assert.equal((await f.library()).tracks[0].cover, null);
  await assert.rejects(f.api(`/v1/music/cover?${new URLSearchParams({ volume: f.v.id, key: cover })}`), { status: 404 });
});

test("a file that vanishes mid-read or a cover that cannot be written is retried instead of read as empty", async (t) => {
  const f = await fixture(t);
  const song = await f.track("a.mp3", { title: "A" }, { cover: await f.image("teal") });
  const { openAsBlob, renameSync } = fs;
  t.after(() => Object.assign(fs, { openAsBlob, renameSync }));
  let aside = null;
  fs.openAsBlob = async (file, options) => {
    const blob = await openAsBlob(file, options);
    if (!aside) renameSync((aside = String(file)), `${aside}.away`);
    return blob;
  };
  const state = () => f.s.db.prepare("SELECT checked,retry FROM music_tracks WHERE hash=?").get(song.hash);
  const again = async () => {
    f.s.db.prepare("UPDATE music_tracks SET retry=0 WHERE hash=?").run(song.hash);
    f.daemon.engine.music.generation++;
    await f.library();
    return f.indexed();
  };
  const indexed = f.daemon.engine.music.indexed;
  await f.api("/v1/music/mark", { volume: f.v.id });
  await f.indexed();
  assert.equal(state().checked, 0, "content that vanished while being read is not marked read");
  assert.ok(state().retry > Date.now());
  assert.equal(f.daemon.engine.music.indexed, indexed, "a pass that read nothing leaves the change feed alone");
  fs.openAsBlob = openAsBlob;
  renameSync(`${aside}.away`, aside);
  fs.renameSync = (from, to) => {
    if (String(to).includes("music-covers")) throw Object.assign(new Error("busy"), { code: "EPERM" });
    return renameSync(from, to);
  };
  const [kept] = (await again()).tracks;
  assert.equal(state().checked, 0, "a cover that could not be written keeps the track due");
  assert.equal(kept.title, "A", "its tags are listed meanwhile");
  assert.equal(kept.cover, null);
  fs.renameSync = renameSync;
  aside = null;
  fs.openAsBlob = async (file, options) => {
    const blob = await openAsBlob(file, options);
    if (!aside) renameSync((aside = String(file)), `${aside}.away`);
    return blob;
  };
  const [still] = (await again()).tracks;
  assert.equal(still.title, "A", "a re-read that fails keeps the tags already read");
  assert.equal(state().checked, 0);
  fs.openAsBlob = openAsBlob;
  renameSync(`${aside}.away`, aside);
  const [track] = (await again()).tracks;
  assert.equal(track.title, "A");
  assert.match(track.cover, /^[a-f0-9]{64}$/);
});

test("only a hub reading a library adds the revision index, and an older tag table gains its retry column", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-music-replica-"));
  init(home, { port: 0, name: "Replica", role: "replica" });
  const replica = await start(home, { timer: false });
  t.after(async () => {
    await replica.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const index = (db) =>
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='music_revision_hash'").get();
  assert.equal(index(replica.engine.store.db), undefined);
  const f = await fixture(t);
  assert.equal(index(f.s.db), undefined);
  await f.api("/v1/music/mark", { volume: f.v.id });
  await f.library();
  assert.ok(index(f.s.db));
  const store = new Store(f.home);
  store.db.exec("DROP TABLE music_tracks");
  store.db.exec(
    "CREATE TABLE music_tracks(hash TEXT PRIMARY KEY,title TEXT,artist TEXT,album_artist TEXT,album TEXT,track INTEGER,disc INTEGER,year INTEGER,genre TEXT,duration REAL,codec TEXT,cover TEXT,checked INTEGER NOT NULL)",
  );
  store.db.prepare("INSERT INTO music_tracks(hash,checked) VALUES('a',1)").run();
  store.close();
  const migrated = new Store(f.home);
  try {
    assert.deepEqual({ ...migrated.db.prepare("SELECT hash,checked,retry FROM music_tracks").get() }, { hash: "a", checked: 1, retry: 0 });
  } finally {
    migrated.close();
  }
});

test("a cover that cannot be removed never fails Delete shared folder or a sweep", async (t) => {
  const f = await fixture(t);
  await f.api("/v1/music/mark", { volume: f.v.id });
  await f.track("a.mp3", { title: "A" }, { cover: await f.image("olive") });
  await f.indexed();
  const { rmSync } = fs;
  t.after(() => {
    fs.rmSync = rmSync;
  });
  fs.rmSync = (target, options) => {
    if (String(target).includes("music-covers")) throw Object.assign(new Error("busy"), { code: "EPERM" });
    return rmSync(target, options);
  };
  await f.api("/v1/delete-share", { id: f.v.id, confirmedName: "Music" });
  assert.doesNotThrow(() => f.daemon.engine.music.sweep(true));
  fs.rmSync = rmSync;
  f.daemon.engine.music.sweep(true);
  assert.deepEqual(fs.readdirSync(path.join(f.home, "music-covers")), []);
});

test("a library deleted while a track is being read keeps neither its tags nor its cover", async (t) => {
  const f = await fixture(t);
  const song = await f.track("a.mp3", { title: "A" }, { cover: await f.image("maroon") });
  const { openAsBlob } = fs;
  t.after(() => {
    fs.openAsBlob = openAsBlob;
  });
  let release, opened;
  const gate = new Promise((resolve) => (release = resolve));
  const reading = new Promise((resolve) => (opened = resolve));
  fs.openAsBlob = async (file, options) => {
    opened();
    await gate;
    return openAsBlob(file, options);
  };
  await f.api("/v1/music/mark", { volume: f.v.id });
  await reading;
  await f.api("/v1/delete-share", { id: f.v.id, confirmedName: "Music" });
  release();
  await f.daemon.engine.music.background;
  assert.equal(f.s.db.prepare("SELECT 1 FROM music_tracks WHERE hash=?").get(song.hash), undefined);
  const covers = path.join(f.home, "music-covers");
  assert.deepEqual(fs.existsSync(covers) ? fs.readdirSync(covers) : [], []);
});

test("a folder cover that cannot be written yet asks the phone to retry instead of hiding it", async (t) => {
  const f = await fixture(t);
  await f.api("/v1/music/mark", { volume: f.v.id });
  const cover = await f.propose("Album/cover.jpg", await f.image("navy"));
  await f.track("Album/01.mp3", { title: "One" });
  await f.indexed();
  const { renameSync } = fs;
  t.after(() => {
    fs.renameSync = renameSync;
  });
  fs.renameSync = (from, to) => {
    if (String(to).includes("music-covers")) throw Object.assign(new Error("busy"), { code: "EBUSY" });
    return renameSync(from, to);
  };
  const query = new URLSearchParams({ volume: f.v.id, key: cover, size: "small" });
  assert.deepEqual(await f.api(`/v1/music/cover?${query}`), { retry: true });
  fs.renameSync = renameSync;
  assert.deepEqual(await f.api(`/v1/music/cover?${query}`), { retry: true }, "the hub waits before rendering it again");
  f.daemon.engine.music.busy.clear();
  assert.match((await f.api(`/v1/music/cover?${query}`)).data, /^data:image\/jpeg;base64,/);
});

test("the hub streams a library's audio with ranges to its desktop app and web session, never other files or callers", async (t) => {
  const f = await fixture(t);
  await f.api("/v1/music/mark", { volume: f.v.id });
  const { hash, buffer } = await f.track("Album/01 One.mp3", { title: "One" });
  const coverHash = await f.propose("Album/cover.jpg", await f.image("red"));
  const playback = (name, digest = hash, token) =>
    f.api(`/v1/music/playback?${new URLSearchParams({ volume: f.v.id, path: name, hash: digest })}`, undefined, token);
  const { url } = await playback("Album/01 One.mp3");
  assert.match(url, new RegExp(`^http://127\\.0\\.0\\.1:${f.daemon.port}/v1/music/media\\?ticket=`));
  assert.ok(!url.includes(f.daemon.engine.config.adminToken));
  let r = await fetch(url, { headers: { Range: "bytes=2-9" } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get("content-range"), `bytes 2-9/${buffer.length}`);
  assert.equal(r.headers.get("content-type"), "audio/mpeg");
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), buffer.subarray(2, 10));
  r = await fetch(url, { method: "HEAD" });
  assert.equal(r.status, 200);
  assert.equal(Number(r.headers.get("content-length")), buffer.length);
  assert.equal((await fetch(url, { headers: { Origin: "https://evil.example" } })).status, 401);
  assert.equal((await fetch(url.replace("/v1/music/media", "/v1/gallery/media"))).status, 401, "a track ticket opens no video route");
  assert.equal((await fetch(url.replace(/ticket=.*/, "ticket=wrong"))).status, 401);
  r = await fetch(url, { headers: { Range: "bytes=-4" } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get("content-range"), `bytes ${buffer.length - 4}-${buffer.length - 1}/${buffer.length}`);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), buffer.subarray(-4));
  r = await fetch(url, { headers: { Range: `bytes=${buffer.length}-` } });
  assert.equal(r.status, 416);
  assert.equal(r.headers.get("content-range"), `bytes */${buffer.length}`);
  const video = Buffer.from("0123456789-video");
  const videoHash = await f.propose("Album/clip.mp4", video);
  const gallery = await f.api(`/v1/gallery/playback?${new URLSearchParams({ volume: f.v.id, path: "Album/clip.mp4", hash: videoHash })}`);
  assert.equal((await fetch(gallery.url)).status, 200);
  assert.equal((await fetch(gallery.url.replace("/v1/gallery/media", "/v1/music/media"))).status, 401, "a video ticket opens no track route");
  const realNow = Date.now;
  Date.now = () => realNow() + 2 * 3600000 + 1000;
  try {
    assert.equal((await fetch(url, { headers: { Range: "bytes=0-1" } })).status, 401, "a track ticket expires after two hours");
  } finally {
    Date.now = realNow;
  }
  const query = new URLSearchParams({ volume: f.v.id, path: "Album/01 One.mp3", hash });
  assert.equal((await fetch(`http://127.0.0.1:${f.daemon.port}/v1/music/media?${query}`)).status, 401);
  await assert.rejects(playback("Album/cover.jpg", coverHash), { status: 404 });
  await assert.rejects(playback("Album/01 One.mp3", coverHash), { status: 404 });
  await assert.rejects(playback("Album/missing.mp3"), { status: 404 });
  const invite = await f.api("/v1/devices", { name: "Phone", role: "replica" });
  await assert.rejects(playback("Album/01 One.mp3", hash, invite.token), { status: 403 });
  const other = f.s.addVolume("Other");
  const loose = await f.propose("loose.mp3", buffer, other.id);
  await assert.rejects(
    f.api(`/v1/music/playback?${new URLSearchParams({ volume: other.id, path: "loose.mp3", hash: loose })}`),
    { status: 404 },
    "audio outside a music library does not play",
  );

  const { issueWebCode } = await import("../packages/daemon/web.js");
  const base = `http://127.0.0.1:${f.daemon.port}`;
  const login = await fetch(base + "/auth/login", {
    method: "POST",
    headers: { Origin: base, "Content-Type": "application/json" },
    body: JSON.stringify({ code: issueWebCode(f.home).code }),
  });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const web = await (await fetch(`${base}/v1/music/playback?${query}`, { headers: { Cookie: cookie } })).json();
  assert.equal(web.url, `/v1/music/media?${query}`);
  r = await fetch(base + web.url, { headers: { Cookie: cookie, Range: "bytes=0-3" } });
  assert.equal(r.status, 206);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), buffer.subarray(0, 4));

  f.s.db.prepare("UPDATE files SET deleted=1 WHERE volume=? AND path=?").run(f.v.id, "Album/01 One.mp3");
  assert.equal((await fetch(url)).status, 404);
});

test("a desktop replica indexes, lists and plays its own copy of a selected music library, offline too", async (t) => {
  const f = await fixture(t);
  await f.api("/v1/music/mark", { volume: f.v.id });
  const { hash, buffer } = await f.track(
    "Miles Davis/Kind of Blue/01 So What.mp3",
    { title: "So What", artist: "Miles Davis", album: "Kind of Blue", track: "1" },
    { cover: await f.image("red") },
  );
  const away = f.s.addVolume("Away");
  await f.api("/v1/music/mark", { volume: away.id });
  await f.indexed();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-music-replica-"));
  init(home, { port: 0, name: "Desk", role: "replica" });
  const replica = await start(home, { timer: false });
  t.after(async () => {
    await replica.engine.music?.background;
    await replica.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const call = async (route, body) => {
    const response = await fetch(`http://127.0.0.1:${replica.port}${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${replica.engine.config.adminToken}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error), { status: response.status });
    return data;
  };
  const desk = await f.api("/v1/devices", { name: "Desk", role: "replica" });
  await call("/v1/connect", { url: `http://127.0.0.1:${f.daemon.port}`, token: desk.token });
  await call("/v1/select", { id: f.v.id });
  await replica.engine.cycle();
  let library;
  for (let i = 0; i < 50; i++) {
    await replica.engine.music?.background;
    library = await call(`/v1/music/library?volume=${f.v.id}`);
    if (!library.indexing) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(library.indexing, false);
  const [track] = library.tracks;
  assert.equal(track.title, "So What");
  assert.equal(track.album, "Kind of Blue");
  assert.equal(track.added, null, "a replica keeps no revision dates");
  assert.match(track.cover, /^[a-f0-9]{64}$/);
  assert.equal(
    replica.engine.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='music_revision_hash'").get(),
    undefined,
  );
  const cover = await call(`/v1/music/cover?${new URLSearchParams({ volume: f.v.id, key: track.cover })}`);
  assert.match(cover.data, /^data:image\/jpeg;base64,/);
  await assert.rejects(call(`/v1/music/library?volume=${away.id}`), { status: 404 }, "only a selected folder has a local library");

  replica.engine.music.sweep(true);
  assert.equal(
    replica.engine.store.db.prepare("SELECT count(*) n FROM music_tracks").get().n,
    1,
    "a replica sweep keeps the tags of its own libraries",
  );
  assert.ok(fs.readdirSync(path.join(home, "music-covers")).some((name) => name.startsWith(track.cover)));

  const second = await f.track("Miles Davis/Kind of Blue/02 Freddie Freeloader.mp3", { title: "Freddie Freeloader", artist: "Miles Davis", album: "Kind of Blue", track: "2" });
  await replica.engine.cycle();
  await replica.engine.music.background;
  assert.equal(
    replica.engine.store.db.prepare("SELECT title FROM music_tracks WHERE hash=? AND checked>0").get(second.hash)?.title,
    "Freddie Freeloader",
    "a completed sync indexes the new track without waiting for a library read",
  );
  let next;
  for (let i = 0; i < 50; i++) {
    await replica.engine.music?.background;
    next = await call(`/v1/music/library?volume=${f.v.id}`);
    if (!next.indexing) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.deepEqual(
    next.tracks.map((row) => row.title),
    ["So What", "Freddie Freeloader"],
    "a track downloaded by a later cycle is read at once from the local copy",
  );

  replica.engine.config.hub.url = "http://127.0.0.1:9";
  replica.engine.hubUnavailable = true;
  const { url } = await call(`/v1/music/playback?${new URLSearchParams({ volume: f.v.id, path: track.path, hash })}`);
  assert.match(url, new RegExp(`^http://127\\.0\\.0\\.1:${replica.port}/v1/music/media\\?ticket=`));
  const r = await fetch(url, { headers: { Range: "bytes=4-11" } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get("content-range"), `bytes 4-11/${buffer.length}`);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), buffer.subarray(4, 12));
  const local = path.join(replica.engine.store.volume(f.v.id).path, "Miles Davis", "Kind of Blue", "01 So What.mp3");
  fs.writeFileSync(local, Buffer.concat([buffer, Buffer.from("edited")]));
  await assert.rejects(
    call(`/v1/music/playback?${new URLSearchParams({ volume: f.v.id, path: track.path, hash })}`),
    { status: 409 },
    "a local copy that no longer matches the synced version does not play",
  );
});

test("a cover rendered for a phone while its library is deleted does not stay behind", async (t) => {
  const f = await fixture(t);
  await f.api("/v1/music/mark", { volume: f.v.id });
  const cover = await f.propose("Album/cover.jpg", await f.image("teal"));
  await f.track("Album/01.mp3", { title: "One" });
  await f.indexed();
  const { readFile } = fs.promises;
  t.after(() => {
    fs.promises.readFile = readFile;
  });
  let release, opened;
  const gate = new Promise((resolve) => (release = resolve));
  const reading = new Promise((resolve) => (opened = resolve));
  fs.promises.readFile = async (...args) => {
    opened();
    await gate;
    return readFile(...args);
  };
  const query = new URLSearchParams({ volume: f.v.id, key: cover, size: "small" });
  const request = f.api(`/v1/music/cover?${query}`).catch((error) => error);
  await reading;
  await f.api("/v1/delete-share", { id: f.v.id, confirmedName: "Music" });
  release();
  await request;
  const covers = path.join(f.home, "music-covers");
  assert.deepEqual(fs.existsSync(covers) ? fs.readdirSync(covers) : [], []);
});

test("a library with nothing new is not scanned again until its files change", async (t) => {
  const f = await fixture(t);
  await f.api("/v1/music/mark", { volume: f.v.id });
  await f.track("a.mp3", { title: "A" });
  await f.indexed();
  const music = f.daemon.engine.music;
  music.prepare(f.v.id);
  await music.background;
  let scans = 0;
  const pending = music.pending.bind(music);
  music.pending = (volume) => {
    scans++;
    return pending(volume);
  };
  music.prepare(f.v.id);
  await music.background;
  music.prepare(f.v.id);
  await music.background;
  assert.equal(scans, 0, "an unchanged library skips the scan");
  await f.track("b.mp3", { title: "B" });
  await music.background;
  assert.ok(scans > 0, "a new file scans again");
  assert.deepEqual((await f.indexed()).tracks.map((row) => row.title), ["A", "B"]);
});

async function settledLibrary(f) {
  const music = f.daemon.engine.music;
  music.prepare(f.v.id);
  await music.background;
  const counter = { scans: 0 };
  const pending = music.pending.bind(music);
  music.pending = (volume) => {
    counter.scans++;
    return pending(volume);
  };
  music.prepare(f.v.id);
  await music.background;
  assert.equal(counter.scans, 0, "an unchanged library skips the scan");
  return counter;
}

test("a skipped library is read again once a retry falls due", async (t) => {
  const f = await fixture(t);
  const late = await f.track("Later/late.mp3", { title: "Late" });
  fs.rmSync(f.s.blob(late.hash));
  await f.api("/v1/music/mark", { volume: f.v.id });
  await f.indexed();
  const counter = await settledLibrary(f);
  fs.writeFileSync(f.s.blob(late.hash), late.buffer);
  const music = f.daemon.engine.music;
  const generation = music.generation;
  const realNow = Date.now;
  Date.now = () => realNow() + 3600000 + 60000;
  try {
    assert.equal(music.generation, generation);
    music.prepare(f.v.id);
    await music.background;
  } finally {
    Date.now = realNow;
  }
  assert.ok(counter.scans > 0);
  assert.equal(f.s.db.prepare("SELECT title FROM music_tracks WHERE hash=? AND checked>0").get(late.hash)?.title, "Late");
});

test("a skipped library is read again when its exclusion rules change on disk", async (t) => {
  const f = await fixture(t);
  const hidden = await f.track("Private/secret.mp3", { title: "Secret" });
  fs.writeFileSync(path.join(f.v.path, ".arcaignore"), "Private/\n");
  await f.api("/v1/music/mark", { volume: f.v.id });
  await f.indexed();
  const counter = await settledLibrary(f);
  assert.equal(f.s.db.prepare("SELECT 1 FROM music_tracks WHERE hash=?").get(hidden.hash), undefined);
  fs.writeFileSync(path.join(f.v.path, ".arcaignore"), "# nothing excluded\n");
  const music = f.daemon.engine.music;
  music.prepare(f.v.id);
  await music.background;
  assert.ok(counter.scans > 0);
  assert.equal(f.s.db.prepare("SELECT title FROM music_tracks WHERE hash=?").get(hidden.hash)?.title, "Secret");
});

test("a sweep that removes tags makes a skipped library read again", async (t) => {
  const f = await fixture(t);
  await f.api("/v1/music/mark", { volume: f.v.id });
  const song = await f.track("a.mp3", { title: "A" });
  await f.indexed();
  await settledLibrary(f);
  const music = f.daemon.engine.music;
  f.s.db.prepare("DELETE FROM music_folders WHERE volume=?").run(f.v.id);
  music.sweep(true);
  assert.equal(f.s.db.prepare("SELECT 1 FROM music_tracks WHERE hash=?").get(song.hash), undefined);
  f.s.db.prepare("INSERT INTO music_folders VALUES(?)").run(f.v.id);
  music.prepare(f.v.id);
  await music.background;
  assert.equal(f.s.db.prepare("SELECT title FROM music_tracks WHERE hash=?").get(song.hash)?.title, "A");
  assert.equal((await f.library()).tracks[0].title, "A");
});

test("a track's MusicBrainz release id reaches the library, and older tags are read again for it", async (t) => {
  const f = await fixture(t);
  await f.api("/v1/music/mark", { volume: f.v.id });
  const tagged = await f.track("A/1.mp3", { title: "One", album: "First", "MusicBrainz Album Id": "8F2C1A5E-6A8E-4D2B-9A43-1D6F3A0E9B10" });
  await f.track("A/2.mp3", { title: "Two", album: "First" });
  await f.track("A/3.mp3", { title: "Three", album: "First", "MusicBrainz Album Id": "unknown" });
  const library = await f.indexed();
  assert.deepEqual(
    library.tracks.map((track) => [track.title, track.release]),
    [["One", "8f2c1a5e-6a8e-4d2b-9a43-1d6f3a0e9b10"], ["Two", null], ["Three", null]],
    "release ids are lowercased, and values that are not ids are dropped",
  );
  f.s.db.prepare("UPDATE music_tracks SET checked=1,release=NULL WHERE hash=?").run(tagged.hash);
  f.daemon.engine.music.generation++;
  await f.library();
  const again = await f.indexed();
  assert.equal(again.tracks[0].release, "8f2c1a5e-6a8e-4d2b-9a43-1d6f3a0e9b10", "rows from the previous index version are read again");
});

test("a re-read that times out keeps the tags read before and tries again later", async (t) => {
  const f = await fixture(t);
  await f.api("/v1/music/mark", { volume: f.v.id });
  const song = await f.track("a.mp3", { title: "Kept", artist: "Ann", album: "First" });
  await f.indexed();
  const { openAsBlob } = fs;
  t.after(() => {
    fs.openAsBlob = openAsBlob;
  });
  fs.openAsBlob = async () => ({
    size: 4096,
    type: "audio/mpeg",
    slice: () => ({
      arrayBuffer: async () => {
        throw new Error("Tag reading took too long");
      },
    }),
  });
  f.s.db.prepare("UPDATE music_tracks SET checked=1 WHERE hash=?").run(song.hash);
  f.daemon.engine.music.generation++;
  await f.library();
  const [track] = (await f.indexed()).tracks;
  assert.equal(track.title, "Kept");
  const row = f.s.db.prepare("SELECT checked,retry FROM music_tracks WHERE hash=?").get(song.hash);
  assert.equal(row.checked, 0);
  assert.ok(row.retry > Date.now());
});

test("a hub whose tag table predates release ids gains the column and reads its tags again", async (t) => {
  const f = await fixture(t);
  await f.api("/v1/music/mark", { volume: f.v.id });
  await f.track("a.mp3", { title: "A", "MusicBrainz Album Id": "8f2c1a5e-6a8e-4d2b-9a43-1d6f3a0e9b10" });
  await f.indexed();
  const old = new Store(f.home);
  old.db.exec("UPDATE music_tracks SET checked=1");
  old.db.exec("ALTER TABLE music_tracks DROP COLUMN release");
  old.close();
  const migrated = new Store(f.home);
  try {
    assert.ok(migrated.db.prepare("PRAGMA table_info(music_tracks)").all().some((column) => column.name === "release"));
    assert.equal(migrated.db.prepare("SELECT release FROM music_tracks").get().release, null);
  } finally {
    migrated.close();
  }
});

test("the library lists playlists in Playlists/ with resolved entries, keeping duplicates and unresolved lines", async (t) => {
  const f = await fixture(t);
  await f.api("/v1/music/mark", { volume: f.v.id });
  await f.track("Album/01 One.mp3", { title: "One" });
  await f.track("Album/02 Two.flac", { title: "Two" });
  await f.propose("Playlists/Road.m3u", Buffer.from("#EXTM3U\r\n#EXTINF:1,One\r\n..\\Album\\01 One.mp3\r\n../Album/missing.mp3\r\nhttp://radio.example/x\r\n../Album/01 One.mp3\r\n"));
  await f.propose("Playlists/Latin.m3u", Buffer.concat([Buffer.from("#PLAYLIST:Caf"), Buffer.from([0xe9]), Buffer.from("\n../Album/02 Two.flac\n")]));
  await f.propose("Playlists/Mix.m3u8", Buffer.from("#EXTM3U\n#PLAYLIST:A mix\n../Album/02 Two.flac\n"));
  await f.propose("Playlists/Nested/Deep.m3u8", Buffer.from("../../Album/01 One.mp3\n"));
  await f.propose("Album/Album.m3u8", Buffer.from("01 One.mp3\n"));
  const library = await f.indexed();
  assert.deepEqual(
    library.playlists.map(({ path, name, editable, entries }) => ({ path, name, editable, entries })),
    [
      { path: "Playlists/Mix.m3u8", name: "A mix", editable: true, entries: ["Album/02 Two.flac"] },
      { path: "Playlists/Latin.m3u", name: "Café", editable: false, entries: ["Album/02 Two.flac"] },
      { path: "Playlists/Road.m3u", name: "Road", editable: false, entries: ["Album/01 One.mp3", "Album/missing.mp3", null, "Album/01 One.mp3"] },
    ],
  );
  assert.equal(library.playlists[0].hash, f.s.current(f.v.id, "Playlists/Mix.m3u8").hash);
  assert.deepEqual(library.tracks.map((row) => row.path), ["Album/01 One.mp3", "Album/02 Two.flac"]);
  await f.propose("Playlists/Mix.m3u8", Buffer.from("#EXTM3U\n#PLAYLIST:A mix\n../Album/01 One.mp3\n"));
  const changed = await f.library();
  assert.notEqual(changed.version, library.version, "a playlist change changes the version");
  assert.deepEqual(changed.playlists[0].entries, ["Album/01 One.mp3"]);
});

test("the hub edits its own playlists through the playlist route, atomically, with stale hashes refused", async (t) => {
  const f = await fixture(t);
  await f.api("/v1/music/mark", { volume: f.v.id });
  await f.track("Album/01 One.mp3", { title: "One" });
  await f.track("Album/02 Two.flac", { title: "Two" });
  await f.indexed();
  const edit = (body) => f.api("/v1/music/playlist", { volume: f.v.id, ...body });
  const file = (name) => path.join(f.v.path, ...name.split("/"));
  const created = await edit({ action: "create", name: "Road trip", track: "Album/01 One.mp3" });
  assert.equal(created.path, "Playlists/Road trip.m3u8");
  assert.equal(fs.readFileSync(file(created.path), "utf8"), "#EXTM3U\n#PLAYLIST:Road trip\n../Album/01 One.mp3\n");
  assert.equal(f.s.current(f.v.id, created.path).hash, created.hash, "the hub commits the edit at once");
  await assert.rejects(edit({ action: "create", name: "Road trip" }), { status: 409 });
  const added = await edit({ action: "add", path: created.path, hash: created.hash, track: "Album/02 Two.flac" });
  assert.equal(fs.readFileSync(file(created.path), "utf8"), "#EXTM3U\n#PLAYLIST:Road trip\n../Album/01 One.mp3\n../Album/02 Two.flac\n");
  await assert.rejects(edit({ action: "add", path: created.path, hash: created.hash, track: "Album/02 Two.flac" }), {
    status: 409,
    message: "This playlist changed. Try again.",
  });
  await assert.rejects(edit({ action: "add", path: created.path, hash: added.hash, track: "Album/none.mp3" }), { status: 404 });
  const listed = (await f.library()).playlists.find((list) => list.path === created.path);
  assert.deepEqual(listed.entries, ["Album/01 One.mp3", "Album/02 Two.flac"]);
  assert.equal(listed.hash, added.hash);
  await assert.rejects(edit({ action: "remove", path: created.path, hash: added.hash, position: 0, track: "Album/02 Two.flac" }), { status: 409 });
  const removed = await edit({ action: "remove", path: created.path, hash: added.hash, position: 0, track: "Album/01 One.mp3" });
  assert.equal(fs.readFileSync(file(created.path), "utf8"), "#EXTM3U\n#PLAYLIST:Road trip\n../Album/02 Two.flac\n");
  const renamed = await edit({ action: "rename", path: created.path, hash: removed.hash, name: "Night drive" });
  assert.equal(renamed.path, "Playlists/Night drive.m3u8");
  assert.equal(fs.existsSync(file(created.path)), false);
  assert.equal(fs.readFileSync(file(renamed.path), "utf8"), "#EXTM3U\n#PLAYLIST:Night drive\n../Album/02 Two.flac\n");
  assert.equal(f.s.current(f.v.id, created.path).deleted, 1);
  await assert.rejects(edit({ action: "add", path: "Album/x.m3u8", hash: "x", track: "Album/02 Two.flac" }), { status: 400 });
  await f.propose("Playlists/Hand.m3u", Buffer.from("../Album/02 Two.flac\n"));
  await assert.rejects(edit({ action: "add", path: "Playlists/Hand.m3u", hash: "x", track: "Album/01 One.mp3" }), { status: 400 });
  await edit({ action: "delete", path: renamed.path, hash: renamed.hash });
  assert.equal(fs.existsSync(file(renamed.path)), false);
  const history = f.s.history(f.v.id, renamed.path);
  assert.ok(history.some((row) => row.deleted) && history.some((row) => !row.deleted), "the deletion stays in history");
});

test("renaming a track through Arca rewrites every editable playlist that names it", async (t) => {
  const f = await fixture(t);
  await f.api("/v1/music/mark", { volume: f.v.id });
  await f.track("Album/01 One.mp3", { title: "One" });
  await f.indexed();
  const list = await f.api("/v1/music/playlist", { volume: f.v.id, action: "create", name: "Mix", track: "Album/01 One.mp3" });
  await f.propose("Playlists/Hand.m3u", Buffer.from("../Album/01 One.mp3\n"));
  const rev = f.s.current(f.v.id, "Album/01 One.mp3").rev;
  await f.api("/v1/rename-file", { volume: f.v.id, path: "Album/01 One.mp3", name: "01 Uno.mp3", rev });
  assert.equal(fs.readFileSync(path.join(f.v.path, "Playlists", "Mix.m3u8"), "utf8"), "#EXTM3U\n#PLAYLIST:Mix\n../Album/01 Uno.mp3\n");
  assert.notEqual(f.s.current(f.v.id, list.path).hash, list.hash, "the rewrite is committed with the rename");
  assert.equal(fs.readFileSync(path.join(f.v.path, "Playlists", "Hand.m3u"), "utf8"), "../Album/01 One.mp3\n", "only .m3u8 files are rewritten");
});

test("a replica edits playlists in its own copy and the file syncs to the hub; without a local copy it refuses", async (t) => {
  const f = await fixture(t);
  await f.api("/v1/music/mark", { volume: f.v.id });
  await f.track("Album/01 One.mp3", { title: "One" });
  await f.indexed();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-music-replica-"));
  init(home, { port: 0, name: "Desk", role: "replica" });
  const replica = await start(home, { timer: false });
  t.after(async () => {
    await replica.engine.music?.background;
    await replica.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const call = async (route, body) => {
    const response = await fetch(`http://127.0.0.1:${replica.port}${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${replica.engine.config.adminToken}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error), { status: response.status });
    return data;
  };
  const desk = await f.api("/v1/devices", { name: "Desk", role: "replica" });
  await call("/v1/connect", { url: `http://127.0.0.1:${f.daemon.port}`, token: desk.token });
  await call("/v1/select", { id: f.v.id });
  await replica.engine.cycle();
  replica.engine.paused = true;
  const created = await call("/v1/music/playlist", { volume: f.v.id, action: "create", name: "Desk mix", track: "Album/01 One.mp3" });
  const local = path.join(replica.engine.store.volume(f.v.id).path, "Playlists", "Desk mix.m3u8");
  assert.equal(fs.readFileSync(local, "utf8"), "#EXTM3U\n#PLAYLIST:Desk mix\n../Album/01 One.mp3\n");
  const unsynced = await call(`/v1/music/library?volume=${f.v.id}`);
  assert.deepEqual(unsynced.playlists.map((list) => [list.path, list.entries]), [[created.path, ["Album/01 One.mp3"]]], "a playlist made here lists before it has synced");
  await assert.rejects(call("/v1/music/playlist", { volume: f.v.id, action: "rename", path: created.path, hash: created.hash, name: "Early" }), { status: 409, message: /not synced yet/ });
  await assert.rejects(call("/v1/music/playlist", { volume: f.v.id, action: "delete", path: created.path, hash: created.hash }), { status: 409, message: /not synced yet/ });
  replica.engine.paused = false;
  await replica.engine.cycle();
  for (let i = 0; i < 100 && f.s.current(f.v.id, created.path)?.hash !== created.hash; i++)
    await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(f.s.current(f.v.id, created.path)?.hash, created.hash, "the playlist syncs to the hub");
  assert.deepEqual((await f.library()).playlists.map((list) => list.name), ["Desk mix"]);
  const added = await call("/v1/music/playlist", { volume: f.v.id, action: "add", path: created.path, hash: created.hash, track: "Album/01 One.mp3" });
  assert.equal(fs.readFileSync(local, "utf8"), "#EXTM3U\n#PLAYLIST:Desk mix\n../Album/01 One.mp3\n../Album/01 One.mp3\n");
  const removed = await call("/v1/music/playlist", { volume: f.v.id, action: "remove", path: created.path, hash: added.hash, position: 1, track: "Album/01 One.mp3" });
  assert.equal(fs.readFileSync(local, "utf8"), "#EXTM3U\n#PLAYLIST:Desk mix\n../Album/01 One.mp3\n");
  assert.equal(removed.path, created.path);
  replica.engine.paused = true;
  const edited = await call("/v1/music/playlist", { volume: f.v.id, action: "add", path: created.path, hash: removed.hash, track: "Album/01 One.mp3" });
  const moved = await call("/v1/music/playlist", { volume: f.v.id, action: "rename", path: created.path, hash: edited.hash, name: "Night mix" });
  const night = path.join(path.dirname(local), "Night mix.m3u8");
  assert.equal(fs.existsSync(local), false);
  assert.equal(fs.readFileSync(night, "utf8"), "#EXTM3U\n#PLAYLIST:Night mix\n../Album/01 One.mp3\n../Album/01 One.mp3\n", "an edit that has not synced yet moves with the rename");
  replica.engine.paused = false;
  await replica.engine.cycle();
  for (let i = 0; i < 100 && f.s.current(f.v.id, moved.path)?.hash !== moved.hash; i++)
    await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(f.s.current(f.v.id, moved.path)?.hash, moved.hash, "the renamed playlist syncs with its edit");
  assert.ok(f.s.current(f.v.id, created.path)?.deleted, "and the old name leaves the hub");
  const track = replica.engine.store.current(f.v.id, "Album/01 One.mp3");
  await call("/v1/rename-file", { volume: f.v.id, path: "Album/01 One.mp3", name: "01 Uno.mp3", rev: track.rev });
  assert.equal(fs.readFileSync(night, "utf8"), "#EXTM3U\n#PLAYLIST:Night mix\n../Album/01 Uno.mp3\n../Album/01 Uno.mp3\n", "a track renamed on a replica rewrites its playlists");
  await call("/v1/unselect", { id: f.v.id, deleteFiles: false });
  await assert.rejects(call("/v1/music/playlist", { volume: f.v.id, action: "create", name: "Other" }), (error) => [404, 409].includes(error.status));
});

test("a playlist name that differs only by case never replaces or deletes the existing one", async (t) => {
  const f = await fixture(t);
  await f.api("/v1/music/mark", { volume: f.v.id });
  await f.track("Album/01 One.mp3", { title: "One" });
  await f.indexed();
  const edit = (body) => f.api("/v1/music/playlist", { volume: f.v.id, ...body });
  const created = await edit({ action: "create", name: "Road trip", track: "Album/01 One.mp3" });
  await assert.rejects(edit({ action: "create", name: "road trip" }), { status: 409 });
  const history = f.s.history(f.v.id, created.path);
  assert.ok(history.every((row) => !row.deleted), "no deletion is committed for the existing playlist");
  assert.equal(f.s.current(f.v.id, created.path).deleted, 0);
  assert.deepEqual(fs.readdirSync(path.join(f.v.path, "Playlists")), ["Road trip.m3u8"]);
});

test("a playlist that is not valid UTF-8 is read but never rewritten, by an edit or by a track rename", async (t) => {
  const f = await fixture(t);
  await f.api("/v1/music/mark", { volume: f.v.id });
  await f.track("Album/01 One.mp3", { title: "One" });
  await f.indexed();
  const bytes = Buffer.concat([Buffer.from("#EXTM3U\n../Album/Caf"), Buffer.from([0xe9]), Buffer.from(".mp3\n../Album/01 One.mp3\n")]);
  await f.propose("Playlists/Latin.m3u8", bytes);
  const disk = path.join(f.v.path, "Playlists", "Latin.m3u8");
  const hash = digest(bytes);
  const edit = (body) => f.api("/v1/music/playlist", { volume: f.v.id, ...body });
  await assert.rejects(edit({ action: "add", path: "Playlists/Latin.m3u8", hash, track: "Album/01 One.mp3" }), { status: 409, message: /not valid UTF-8/ });
  await assert.rejects(edit({ action: "rename", path: "Playlists/Latin.m3u8", hash, name: "Other" }), { status: 409, message: /not valid UTF-8/ });
  const rev = f.s.current(f.v.id, "Album/01 One.mp3").rev;
  await f.api("/v1/rename-file", { volume: f.v.id, path: "Album/01 One.mp3", name: "01 Uno.mp3", rev });
  assert.deepEqual(fs.readFileSync(disk), bytes, "the original bytes stay on disk");
  const deleted = await edit({ action: "delete", path: "Playlists/Latin.m3u8", hash });
  assert.equal(deleted.deleted, true, "a file that cannot be edited can still be deleted");
});

test("a device credential cannot edit playlists", async (t) => {
  const f = await fixture(t);
  await f.api("/v1/music/mark", { volume: f.v.id });
  const invite = await f.api("/v1/devices", { name: "Phone", role: "replica" });
  await assert.rejects(f.api("/v1/music/playlist", { volume: f.v.id, action: "create", name: "Mine" }, invite.token), { status: 403 });
});
