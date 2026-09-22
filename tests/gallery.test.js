import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { init, digest } from "../packages/daemon/storage.js";
import { start } from "../packages/daemon/server.js";
import { Gallery } from "../packages/daemon/gallery.js";

async function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-gallery-"));
  init(home, { port: 0, name: "Gallery hub" });
  const daemon = await start(home, { timer: false });
  t.after(async () => {
    await daemon.engine.gallery?.background;
    await daemon.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const s = daemon.engine.store;
  const v = s.addVolume("Camera");
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
  async function photo(name, captured, color = "red") {
    const buffer = await sharp({
      create: { width: 1000, height: 500, channels: 3, background: color },
    })
      .jpeg()
      .toBuffer();
    const hash = digest(buffer);
    // Content-addressed objects are immutable and may already be open by Sharp.
    // Reuse identical bytes instead of truncating a live reader's file on Windows.
    if (!fs.existsSync(s.blob(hash))) fs.writeFileSync(s.blob(hash), buffer);
    await api("/v1/propose", {
      volume: v.id,
      path: name,
      hash,
      size: buffer.length,
      ...(captured ? { captured } : {}),
    });
    return { hash, buffer };
  }
  const route = "/v1/gallery?volume=" + v.id;
  const preview = (name, hash) =>
    "/v1/gallery/preview?" +
    new URLSearchParams({ volume: v.id, path: name, hash });
  return { home, daemon, s, v, api, photo, route, preview };
}

test("accepted photos prepare persistent bounded thumbnails and preserve originals", async (t) => {
  const f = await fixture(t);
  const { hash, buffer } = await f.photo("one.jpg", "2025-01-02T03:04:05.000Z");
  await f.daemon.engine.gallery.background;
  assert.ok(fs.existsSync(path.join(f.home, "previews", hash + "-thumb.jpg")));
  assert.equal(digest(fs.readFileSync(f.s.blob(hash))), digest(buffer));
  const thumbnail = await f.api(f.preview("one.jpg", hash));
  const meta = await sharp(
    Buffer.from(thumbnail.data.split(",")[1], "base64"),
  ).metadata();
  assert.equal(meta.width, 360);
  assert.equal(meta.height, 180);
  f.daemon.engine.gallery = new Gallery(f.s);
  assert.deepEqual(await f.api(f.preview("one.jpg", hash)), thumbnail);
  await assert.rejects(
    f.api(f.preview("one.jpg", hash), undefined, "invalid"),
    { status: 401 },
  );
  await assert.rejects(f.api(f.preview("other.jpg", hash)), { status: 404 });
});

test("gallery is explicit, chronological, scoped and respects exclusions even for cached previews", async (t) => {
  const f = await fixture(t);
  await f.api("/v1/gallery/link", { volume: f.v.id });
  assert.equal((await f.api("/v1/catalog")).volumes[0].gallery, true);
  assert.equal(f.daemon.engine.status().volumes[0].gallery, true);
  const older = await f.photo("older.jpg", "2020-03-04T12:00:00.000Z");
  await f.photo("newer.jpg", "2026-04-05T12:00:00.000Z", "blue");
  await f.photo("unknown.jpg", null, "green");
  const data = await f.api(f.route);
  assert.deepEqual(
    data.items.map((row) => row.path),
    ["unknown.jpg", "newer.jpg", "older.jpg"],
  );
  assert.equal(data.items[0].captured, null);
  assert.equal(data.items[0].dateSource, "date added");
  const rest = await f.api(
    f.route + "&after=" + encodeURIComponent(data.items[0].cursor),
  );
  assert.deepEqual(
    rest.items.map((row) => row.path),
    ["newer.jpg", "older.jpg"],
  );
  await f.daemon.engine.gallery.background;
  fs.writeFileSync(path.join(f.v.path, ".arcaignore"), "older.jpg\n");
  assert.equal(
    (await f.api(f.route)).items.some((row) => row.path === "older.jpg"),
    false,
  );
  await assert.rejects(f.api(f.preview("older.jpg", older.hash)), {
    status: 404,
  });
  await assert.rejects(f.api("/v1/gallery?volume=missing"), { status: 404 });
});

test("old photos use EXIF capture date and unsupported media keep a usable listing", async (t) => {
  const f = await fixture(t);
  const image = await sharp({
    create: { width: 20, height: 30, channels: 3, background: "red" },
  })
    .withExif({ IFD2: { DateTimeOriginal: "2018:07:09 10:11:12" } })
    .jpeg()
    .toBuffer();
  fs.writeFileSync(path.join(f.v.path, "old.jpg"), image);
  fs.writeFileSync(
    path.join(f.v.path, "broken.heic"),
    "unsupported test image",
  );
  fs.writeFileSync(path.join(f.v.path, "clip.mov"), "video");
  fs.writeFileSync(path.join(f.v.path, "notes.txt"), "not an image");
  await f.daemon.engine.cycle();
  await f.api(f.route);
  await f.daemon.engine.gallery.index(f.v.id);
  const data = await f.api(f.route);
  assert.equal(data.items.length, 3);
  assert.equal(
    data.items.find((row) => row.path === "old.jpg").captured,
    "2018-07-09T10:11:12",
  );
  assert.equal(data.items.find((row) => row.path === "clip.mov").kind, "video");
  const clipHash = data.items.find((row) => row.path === "clip.mov").hash;
  assert.equal(
    f.s.db
      .prepare("SELECT date_checked FROM gallery_metadata WHERE hash=?")
      .get(clipHash).date_checked,
    2,
  );
  assert.equal(await f.daemon.engine.gallery.index(f.v.id), false);

  const broken = data.items.find((row) => row.path === "broken.heic");
  assert.deepEqual(await f.api(f.preview(broken.path, broken.hash)), {
    unavailable: true,
  });
});

test("replicas render selected local previews without hub requests and fall back for missing content", async (t) => {
  const f = await fixture(t);
  await f.api("/v1/gallery/link", { volume: f.v.id });
  const { hash } = await f.photo("photo.jpg", "2026-01-01T00:00:00.000Z");
  const home = path.join(f.home, "replica");
  init(home, { port: 0, name: "Viewer", role: "replica" });
  const replica = await start(home, { timer: false });
  const call = async (route, body) => {
    const response = await fetch(`http://127.0.0.1:${replica.port}${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${replica.engine.config.adminToken}`,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json();
    if (!response.ok)
      throw Object.assign(new Error(data.error), { status: response.status });
    return data;
  };
  try {
    const invite = await f.api("/v1/devices", {
      name: "Viewer",
      role: "replica",
    });
    await call("/v1/connect", {
      url: `http://127.0.0.1:${f.daemon.port}`,
      token: invite.token,
    });
    await call("/v1/select", { id: f.v.id });
    await replica.engine.cycle();
    assert.equal(replica.engine.status().volumes[0].gallery, true);
    assert.equal((await call(f.route)).items[0].path, "photo.jpg");
    await replica.engine.gallery.background;
    assert.ok(
      fs.existsSync(path.join(home, "previews", `${hash}-large.jpg`)),
      "sync prepares large previews without opening the viewer",
    );
    const remote = replica.engine.json.bind(replica.engine);
    let previewRequests = 0;
    replica.engine.json = async (route, ...args) => {
      if (route.startsWith("/v1/gallery/preview?")) {
        previewRequests++;
        throw new Error("Hub unavailable");
      }
      return remote(route, ...args);
    };
    const onlineRequest = replica.engine.request.bind(replica.engine);
    replica.engine.request = async () => {
      throw new Error("Hub offline");
    };
    assert.equal((await call(f.route)).items[0].path, "photo.jpg");
    assert.equal((await call("/v1/remote")).volumes[0].id, f.v.id);
    const info = await call(
      "/v1/gallery/info?" +
        new URLSearchParams({ volume: f.v.id, path: "photo.jpg", hash }),
    );
    assert.ok(info);
    replica.engine.request = onlineRequest;
    assert.match(
      (await call(f.preview("photo.jpg", hash))).data,
      /^data:image\/jpeg;base64,/,
    );
    assert.match(
      (await call(f.preview("photo.jpg", hash) + "&size=large")).data,
      /^data:image\/jpeg;base64,/,
    );
    assert.equal(
      previewRequests,
      0,
      "local thumbnails and full previews never contact the hub",
    );
    const binary = await call(
      f.preview("photo.jpg", hash).replace("/preview?", "/preview-url?"),
    );
    assert.equal(binary.data, undefined);
    const image = await fetch(binary.url);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get("content-type"), "image/jpeg");
    assert.ok((await image.arrayBuffer()).byteLength > 0);
    assert.equal(previewRequests, 0);
    const localFolder = replica.engine.store.volume(f.v.id);
    fs.writeFileSync(path.join(localFolder.path, ".arcaignore"), "photo.jpg\n");
    await assert.rejects(call(f.preview("photo.jpg", hash)), { status: 404 });
    assert.equal(
      previewRequests,
      0,
      "exclusions still protect cached local previews",
    );
    fs.unlinkSync(path.join(localFolder.path, ".arcaignore"));
    const blob = replica.engine.store.blob(hash);
    const original = fs.readFileSync(blob);
    fs.unlinkSync(blob);
    replica.engine.json = async (route, ...args) => {
      if (route.startsWith("/v1/gallery/preview?")) previewRequests++;
      return remote(route, ...args);
    };
    assert.match(
      (await call(f.preview("photo.jpg", hash))).data,
      /^data:image\/jpeg;base64,/,
    );
    assert.equal(
      previewRequests,
      1,
      "missing local content falls back to the hub",
    );
    fs.writeFileSync(blob, original);
    await assert.rejects(call(f.preview("photo.jpg", "0".repeat(64))), {
      status: 404,
    });
    replica.engine.store.db
      .prepare("UPDATE files SET deleted=1 WHERE volume=? AND path=?")
      .run(f.v.id, "photo.jpg");
    // Cached local derivatives must not bypass the current remote deletion check.
    await f.api("/v1/delete-file", {
      volume: f.v.id,
      path: "photo.jpg",
      rev: f.s.current(f.v.id, "photo.jpg").rev,
    });
    await assert.rejects(call(f.preview("photo.jpg", hash)), { status: 404 });
    replica.engine.store.db
      .prepare("UPDATE volumes SET selected=0 WHERE id=?")
      .run(f.v.id);
    await assert.rejects(call(f.route), { status: 403 });
    await assert.rejects(call(f.preview("photo.jpg", hash)), { status: 403 });
  } finally {
    await replica.close();
  }
});

test("gallery pages remain bounded and traverse all same-date paths without duplicates", async (t) => {
  const f = await fixture(t);
  await f.photo("source.jpg", "2026-01-01T00:00:00.000Z");
  const source = f.s.current(f.v.id, "source.jpg");
  for (let i = 0; i < 130; i++)
    f.s.setFile({ ...source, path: `photo-${i}.jpg` });
  const names = [];
  let after = "";
  do {
    const data = await f.api(f.route + "&after=" + encodeURIComponent(after));
    assert.ok(data.items.length <= 60);
    names.push(...data.items.map((row) => row.path));
    after = data.next;
  } while (after);
  assert.equal(names.length, 131);
  assert.equal(new Set(names).size, 131);
});

test("filename and album dates preserve precision, and timeline seeks unloaded months", async (t) => {
  const f = await fixture(t);
  await f.photo("Screenshot 2022-03-04 image.jpg", null);
  await f.photo("Phone-abcd/2021/06/photo.jpg", null, "blue");
  const data = await f.api(f.route);
  assert.equal(data.items[0].date, "2022-03-04");
  assert.equal(data.items[1].date, "2021-06");
  assert.deepEqual(
    data.timeline.map((row) => row.month),
    ["2022-03", "2021-06"],
  );
  const jump = await f.api(f.route + "&month=2021-06");
  assert.equal(jump.items[0].date, "2021-06");
  await assert.rejects(f.api(f.route + "&month=2021-99"), { status: 400 });
});

test("folder retention requires hub admin, confirms changes and persists its policy", async (t) => {
  const f = await fixture(t);
  const file = path.join(f.v.path, "version.txt");
  for (const content of ["first", "second"]) {
    fs.writeFileSync(file, content);
    f.s.scanHub();
  }
  const invite = await f.api("/v1/devices", {
    name: "Replica",
    role: "replica",
  });
  await assert.rejects(
    f.api("/v1/folder-retention", { id: f.v.id, mode: "off" }, invite.token),
    (error) => error.status === 403,
  );
  const preview = await f.api("/v1/folder-retention", {
    id: f.v.id,
    mode: "off",
  });
  assert.equal(preview.remove, 1);
  await assert.rejects(
    f.api("/v1/folder-retention", {
      id: f.v.id,
      mode: "off",
      apply: true,
      confirmation: "stale",
    }),
    (error) => error.status === 409,
  );
  assert.equal(f.s.history(f.v.id, "version.txt").length, 2);
  await f.api("/v1/folder-retention", {
    id: f.v.id,
    mode: "off",
    apply: true,
    confirmation: preview.confirmation,
  });
  assert.equal(f.s.history(f.v.id, "version.txt").length, 1);
  assert.equal((await f.api("/v1/status")).folderRetention[f.v.id], "off");
  assert.equal(fs.readFileSync(file, "utf8"), "second");
});

test("gallery original download authenticates and rejects stale or deleted photos", async (t) => {
  const f = await fixture(t);
  const { hash, buffer } = await f.photo(
    "original.jpg",
    "2026-08-15T12:00:00.000Z",
  );
  const url =
    `http://127.0.0.1:${f.daemon.port}/v1/gallery/download?` +
    new URLSearchParams({ volume: f.v.id, path: "original.jpg", hash });
  const headers = {
    Authorization: `Bearer ${f.daemon.engine.config.adminToken}`,
  };
  assert.notEqual((await fetch(url)).status, 200);
  const response = await fetch(url, { headers });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-disposition"), /attachment/);
  assert.equal(
    digest(Buffer.from(await response.arrayBuffer())),
    digest(buffer),
  );
  assert.equal(
    (await fetch(url.replace(hash, "0".repeat(64)), { headers })).status,
    404,
  );
  await f.api("/v1/delete-file", {
    volume: f.v.id,
    path: "original.jpg",
    rev: f.s.current(f.v.id, "original.jpg").rev,
  });
  assert.equal((await fetch(url, { headers })).status, 404);
});

test("photo info reads original EXIF and rejects stale or hidden files", async (t) => {
  const f = await fixture(t);
  const buffer = await sharp({
    create: { width: 800, height: 600, channels: 3, background: "blue" },
  })
    .withExif({
      IFD0: { Make: "Test camera", Model: "Model One", Orientation: "6" },
      IFD2: {
        DateTimeOriginal: "2024:06:15 12:34:56",
        OffsetTimeOriginal: "+07:00",
        LensModel: "Prime 35",
        FNumber: "28/10",
        ExposureTime: "1/125",
        ISOSpeedRatings: "200",
        FocalLength: "35/1",
      },
      IFD3: {
        GPSLatitudeRef: "N",
        GPSLatitude: "13/1 45/1 0/1",
        GPSLongitudeRef: "E",
        GPSLongitude: "100/1 30/1 0/1",
      },
    })
    .jpeg()
    .toBuffer();
  const hash = digest(buffer);
  fs.writeFileSync(f.s.blob(hash), buffer);
  await f.api("/v1/propose", {
    volume: f.v.id,
    path: "exif.jpg",
    hash,
    size: buffer.length,
  });
  const route =
    "/v1/gallery/info?" +
    new URLSearchParams({ volume: f.v.id, path: "exif.jpg", hash });
  const info = await f.api(route);
  assert.equal(info.make, "Test camera");
  assert.equal(info.model, "Model One");
  assert.equal(info.lens, "Prime 35");
  assert.equal(info.aperture, 2.8);
  assert.equal(info.exposure, 1 / 125);
  assert.equal(info.iso, 200);
  assert.equal(info.focalLength, 35);
  assert.equal(info.captured, "2024-06-15T12:34:56");
  assert.equal(info.offset, "+07:00");
  assert.deepEqual(info.location, { latitude: 13.75, longitude: 100.5 });
  assert.equal(info.width * info.height, 480000);
  await assert.rejects(f.api(route, undefined, "invalid"), { status: 401 });
  await assert.rejects(f.api(route.replace(hash, "a".repeat(64))), {
    status: 404,
  });
  const plain = await f.photo("plain.jpg");
  const plainInfo = await f.api(
    "/v1/gallery/info?" +
      new URLSearchParams({
        volume: f.v.id,
        path: "plain.jpg",
        hash: plain.hash,
      }),
  );
  assert.equal(plainInfo.width, 1000);
  assert.equal(plainInfo.height, 500);
  assert.equal(plainInfo.format, "JPEG");
  assert.equal(plainInfo.hasHistory, false);
  assert.ok(plainInfo.accepted.date);
  await f.api("/v1/propose", {
    volume: f.v.id,
    path: "plain.jpg",
    hash,
    size: buffer.length,
    base: f.s.current(f.v.id, "plain.jpg").rev,
  });
  const revised = await f.api(
    "/v1/gallery/info?" +
      new URLSearchParams({ volume: f.v.id, path: "plain.jpg", hash }),
  );
  assert.equal(revised.hasHistory, true);
  await f.api("/v1/delete-file", {
    volume: f.v.id,
    path: "exif.jpg",
    rev: f.s.current(f.v.id, "exif.jpg").rev,
  });
  await assert.rejects(f.api(route), { status: 404 });
});

test("existing videos are reindexed by capture date and interleave with photos", async (t) => {
  const { default: ffmpeg } = await import("ffmpeg-static");
  const { execFileSync } = await import("node:child_process");
  const f = await fixture(t);
  const clip = path.join(f.home, "dated.mp4");
  execFileSync(ffmpeg, [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=32x32:d=0.1",
    "-c:v",
    "mpeg4",
    "-metadata",
    "creation_time=2025-09-10T12:00:00Z",
    "-y",
    clip,
  ]);
  const original = fs.readFileSync(clip);
  const hash = digest(original);
  fs.writeFileSync(f.s.blob(hash), original);
  await f.api("/v1/propose", {
    volume: f.v.id,
    path: "random-id.mp4",
    hash,
    size: original.length,
  });
  await f.photo("newer.jpg", "2025-09-11T12:00:00.000Z", "red");
  await f.photo("older.jpg", "2025-09-09T12:00:00.000Z", "green");
  await f.daemon.engine.gallery.background;
  // Simulate an existing index from the version that only read image EXIF.
  f.s.db
    .prepare(
      "UPDATE gallery_metadata SET captured=NULL,date_checked=1 WHERE hash=?",
    )
    .run(hash);
  const pending = await f.api(f.route);
  assert.equal(pending.indexing, true);
  await f.daemon.engine.gallery.background;
  const page = await f.api(f.route);
  assert.equal(page.indexing, false);
  assert.deepEqual(
    page.items.map((item) => item.path),
    ["newer.jpg", "random-id.mp4", "older.jpg"],
  );
  assert.equal(page.items[1].date, "2025-09-10T12:00:00.000Z");
  assert.equal(page.items[1].dateSource, "metadata");
  assert.deepEqual(
    page.timeline.map((item) => item.month),
    ["2025-09"],
  );
  const after = await f.api(
    f.route + "&after=" + encodeURIComponent(page.items[0].cursor),
  );
  assert.deepEqual(
    after.items.map((item) => item.path),
    ["random-id.mp4", "older.jpg"],
  );
  assert.equal(digest(fs.readFileSync(f.s.blob(hash))), hash);
  // A timestamp supplied by the phone remains authoritative.
  f.s.db
    .prepare(
      "UPDATE gallery_metadata SET captured=?,date_checked=0 WHERE hash=?",
    )
    .run("2025-09-08T00:00:00.000Z", hash);
  await f.daemon.engine.gallery.index(f.v.id);
  assert.equal(
    (await f.api(f.route)).items.at(-1).captured,
    "2025-09-08T00:00:00.000Z",
  );
});

test("videos have cached JPEG posters without changing their originals", async (t) => {
  const { default: ffmpeg } = await import("ffmpeg-static");
  const { execFileSync } = await import("node:child_process");
  const f = await fixture(t);
  const clip = path.join(f.home, "sample.mp4");
  execFileSync(ffmpeg, [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=320x180:d=0.1",
    "-c:v",
    "mpeg4",
    "-y",
    clip,
  ]);
  const original = fs.readFileSync(clip);
  const hash = digest(original);
  fs.writeFileSync(f.s.blob(hash), original);
  await f.api("/v1/propose", {
    volume: f.v.id,
    path: "clip.mp4",
    hash,
    size: original.length,
  });
  const poster = await f.api(f.preview("clip.mp4", hash));
  assert.match(poster.data, /^data:image\/jpeg;base64,/);
  const dimensions = await sharp(
    Buffer.from(poster.data.split(",")[1], "base64"),
  ).metadata();
  assert.ok(dimensions.width <= 360 && dimensions.height <= 360);
  assert.equal(digest(fs.readFileSync(f.s.blob(hash))), hash);
  f.daemon.engine.gallery = new Gallery(f.s);
  assert.deepEqual(await f.api(f.preview("clip.mp4", hash)), poster);
  await assert.rejects(f.api(f.preview("clip.mp4", "0".repeat(64))), {
    status: 404,
  });
});

test(
  "gallery lists files while metadata indexing is stalled",
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t);
    await f.photo("pending.jpg", null);
    const gallery = f.daemon.engine.gallery;
    await gallery.background;
    f.s.db.prepare("DELETE FROM gallery_metadata").run();
    let release;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    gallery.indexing.set(f.v.id, pending);
    try {
      const data = await f.api(f.route);
      assert.equal(data.indexing, true);
      assert.equal(data.items[0].path, "pending.jpg");
      assert.ok(await f.api("/v1/status"));
    } finally {
      release();
      gallery.indexing.delete(f.v.id);
    }
  },
);

test("gallery video playback streams ranges and scopes native access to a current original", async (t) => {
  const f = await fixture(t);
  const buffer = Buffer.from("0123456789-video-fixture");
  const hash = digest(buffer);
  fs.writeFileSync(f.s.blob(hash), buffer);
  await f.api("/v1/propose", {
    volume: f.v.id,
    path: "clip.mp4",
    hash,
    size: buffer.length,
  });
  const query = new URLSearchParams({ volume: f.v.id, path: "clip.mp4", hash });
  const { url } = await f.api("/v1/gallery/playback?" + query);
  assert.ok(!url.includes(f.daemon.engine.config.adminToken));
  let r = await fetch(url, { headers: { Range: "bytes=2-5" } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get("content-range"), `bytes 2-5/${buffer.length}`);
  assert.equal(await r.text(), "2345");
  r = await fetch(url, { method: "HEAD" });
  assert.equal(r.status, 200);
  assert.equal(Number(r.headers.get("content-length")), buffer.length);
  assert.equal(await r.text(), "");
  r = await fetch(url, { headers: { Range: "bytes=-7" } });
  assert.equal(await r.text(), "fixture");
  assert.equal(
    (await fetch(url, { headers: { Range: "bytes=999-" } })).status,
    416,
  );
  assert.equal(
    (await fetch(url, { headers: { Origin: "https://evil.example" } })).status,
    401,
  );
  const direct = `http://127.0.0.1:${f.daemon.port}/v1/gallery/media?${query}`;
  assert.equal((await fetch(direct)).status, 401);
  assert.equal(
    (await fetch(url.replace(/ticket=.*/, "ticket=wrong"))).status,
    401,
  );
  f.s.db
    .prepare("UPDATE files SET deleted=1 WHERE volume=? AND path=?")
    .run(f.v.id, "clip.mp4");
  assert.equal((await fetch(url)).status, 404);
});

test("marking an existing gallery prepares both preview sizes without requests and reuses them after restart", async (t) => {
  const f = await fixture(t);
  // More than the old queue limit, with distinct originals and no gallery page calls.
  for (let i = 0; i < 260; i++) {
    const buffer = await sharp({
      create: {
        width: 2,
        height: 2,
        channels: 3,
        background: { r: i % 256, g: Math.floor(i / 256), b: 0 },
      },
    })
      .png()
      .toBuffer();
    const hash = digest(buffer);
    fs.writeFileSync(f.s.blob(hash), buffer);
    f.s.db
      .prepare(
        "INSERT INTO files(volume,path,hash,size,deleted,rev,path_key) VALUES(?,?,?,?,0,?,?)",
      )
      .run(f.v.id, `${i}.png`, hash, buffer.length, i + 1, `${i}.png`);
  }
  f.daemon.engine.gallery.mark(f.v.id);
  await f.daemon.engine.gallery.background;
  assert.equal(
    f.s.db.prepare("SELECT count(*) n FROM gallery_prepared").get().n,
    260,
  );
  assert.equal(
    f.s.db.prepare("SELECT count(*) n FROM gallery_derivatives").get().n,
    520,
  );
  f.daemon.engine.gallery.close();
  const next = new Gallery(f.s);
  f.daemon.engine.gallery = next;
  next.render = () => {
    throw new Error("Must reuse persistent thumbnails");
  };
  next.resume();
  await next.background;
  const row = f.s.current(f.v.id, "0.png");
  assert.match(
    (await next.preview(f.v.id, "0.png", row.hash)).data,
    /^data:image\/jpeg/,
  );
  assert.ok(
    (await next.derivative(f.v.id, "0.png", row.hash, true)).bytes.length,
  );
});

test("web video ranges require an active browser session, including after logout", async (t) => {
  const f = await fixture(t);
  const { issueWebCode } = await import("../packages/daemon/web.js");
  const buffer = Buffer.from("0123456789"),
    hash = digest(buffer);
  fs.writeFileSync(f.s.blob(hash), buffer);
  await f.api("/v1/propose", {
    volume: f.v.id,
    path: "clip.mp4",
    hash,
    size: buffer.length,
  });
  const base = `http://127.0.0.1:${f.daemon.port}`;
  const login = await fetch(base + "/auth/login", {
    method: "POST",
    headers: { Origin: base, "Content-Type": "application/json" },
    body: JSON.stringify({ code: issueWebCode(f.home).code }),
  });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const response = await fetch(
    base +
      "/v1/gallery/playback?" +
      new URLSearchParams({ volume: f.v.id, path: "clip.mp4", hash }),
    { headers: { Cookie: cookie } },
  );
  const playback = await response.json();
  assert.ok(playback.url.startsWith("/v1/gallery/media?"));
  assert.ok(!playback.url.includes("ticket="));
  const r = await fetch(base + playback.url, {
    headers: { Cookie: cookie, Range: "bytes=4-7" },
  });
  assert.equal(r.status, 206);
  assert.equal(await r.text(), "4567");
  await fetch(base + "/auth/logout", {
    method: "POST",
    headers: { Cookie: cookie, Origin: base },
  });
  assert.equal(
    (
      await fetch(base + playback.url, {
        headers: { Cookie: cookie, Range: "bytes=4-7" },
      })
    ).status,
    401,
  );
});

test("binary photo previews are prepared before opening and keep native tickets scoped", async (t) => {
  const f = await fixture(t);
  await f.api("/v1/gallery/link", { volume: f.v.id });
  const { hash, buffer } = await f.photo("one.jpg", "2026-01-01T00:00:00.000Z");
  await f.daemon.engine.gallery.background;
  const disk = path.join(f.home, "previews", `${hash}-large.jpg`);
  assert.ok(fs.existsSync(disk));
  assert.deepEqual(fs.readFileSync(f.s.blob(hash)), buffer);
  const descriptor = await f.api(
    f.preview("one.jpg", hash).replace("/preview?", "/preview-url?"),
  );
  assert.equal(descriptor.data, undefined);
  assert.ok(descriptor.url.includes("ticket="));
  const response = await fetch(descriptor.url, {
    headers: { Origin: "http://tauri.localhost" },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/jpeg");
  assert.deepEqual(
    Buffer.from(await response.arrayBuffer()),
    fs.readFileSync(disk),
  );
  assert.equal(
    (await fetch(descriptor.url.replace("preview-image", "media"))).status,
    401,
  );
  assert.equal(
    (
      await fetch(descriptor.url, {
        headers: { Origin: "https://untrusted.example" },
      })
    ).status,
    401,
  );
  const head = await fetch(descriptor.url, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  fs.writeFileSync(path.join(f.v.path, ".arcaignore"), "one.jpg\n");
  assert.equal((await fetch(descriptor.url)).status, 404);
  fs.unlinkSync(path.join(f.v.path, ".arcaignore"));
  await f.api("/v1/delete-file", {
    volume: f.v.id,
    path: "one.jpg",
    rev: f.s.current(f.v.id, "one.jpg").rev,
  });
  assert.equal((await fetch(descriptor.url)).status, 404);
});

test("binary web previews require the browser session on every image request", async (t) => {
  const f = await fixture(t);
  const { issueWebCode } = await import("../packages/daemon/web.js");
  const { hash } = await f.photo("one.jpg", "2026-01-01T00:00:00.000Z");
  const base = `http://127.0.0.1:${f.daemon.port}`;
  const login = await fetch(base + "/auth/login", {
    method: "POST",
    headers: { Origin: base, "Content-Type": "application/json" },
    body: JSON.stringify({ code: issueWebCode(f.home).code }),
  });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const descriptor = await (
    await fetch(
      base + f.preview("one.jpg", hash).replace("/preview?", "/preview-url?"),
      { headers: { Cookie: cookie } },
    )
  ).json();
  assert.ok(descriptor.url.startsWith("/v1/gallery/preview-image?"));
  assert.ok(!descriptor.url.includes("ticket="));
  assert.equal((await fetch(base + descriptor.url)).status, 401);
  const image = await fetch(base + descriptor.url, {
    headers: { Cookie: cookie },
  });
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("content-type"), "image/jpeg");
  await image.arrayBuffer();
  await fetch(base + "/auth/logout", {
    method: "POST",
    headers: { Cookie: cookie, Origin: base },
  });
  assert.equal(
    (await fetch(base + descriptor.url, { headers: { Cookie: cookie } }))
      .status,
    401,
  );
});

test("HEIC originals produce cached JPEG previews without changing synchronized bytes", async (t) => {
  const f = await fixture(t);
  const original = fs.readFileSync(
    new URL("./fixtures/gallery.heic", import.meta.url),
  );
  const name = "20260921_144956-3a0b1cb3045c204758a9ae81.heic";
  fs.writeFileSync(path.join(f.v.path, name), original);
  await f.daemon.engine.cycle();
  const row = f.s.current(f.v.id, name);
  assert.equal(row.hash, digest(original));
  let responsive = false;
  const timer = setTimeout(() => {
    responsive = true;
  }, 0);
  t.after(() => clearTimeout(timer));
  const thumbnail = await f.api(f.preview(name, row.hash));
  assert.ok(responsive, "decoding allows the event loop to serve other work");
  for (const data of [
    thumbnail,
    await f.api(f.preview(name, row.hash) + "&size=large"),
  ]) {
    const jpeg = Buffer.from(data.data.split(",")[1], "base64");
    const meta = await sharp(jpeg).metadata();
    assert.equal(meta.format, "jpeg");
    assert.equal(meta.width, 80);
    assert.equal(meta.height, 60);
    const { data: pixel } = await sharp(jpeg)
      .resize(1, 1)
      .raw()
      .toBuffer({ resolveWithObject: true });
    assert.ok(
      pixel[0] > pixel[1] && pixel[1] > pixel[2],
      "decoded colors are retained",
    );
  }
  assert.deepEqual(fs.readFileSync(path.join(f.v.path, name)), original);
  assert.deepEqual(fs.readFileSync(f.s.blob(row.hash)), original);
  assert.deepEqual(await f.api(f.preview(name, row.hash)), thumbnail);
  const info = await f.api(
    "/v1/gallery/info?" +
      new URLSearchParams({ volume: f.v.id, path: name, hash: row.hash }),
  );
  assert.equal(info.width, 80);
  assert.equal(info.height, 60);
});

test("hub image inventory is scoped and preview regeneration preserves original bytes", async (t) => {
  const f = await fixture(t);
  await f.api("/v1/gallery/link", { volume: f.v.id, enabled: true });
  const { hash, buffer } = await f.photo("one.jpg");
  await f.daemon.engine.gallery.background;
  const inventory = await f.api("/v1/images");
  assert.equal(inventory.folders[0].photos, 1);
  assert.equal(inventory.folders[0].jpeg, 1);
  await f.api("/v1/images", { action: "regenerate" });
  let status;
  for (let i = 0; i < 200; i++) {
    status = await f.api("/v1/images");
    if (status.job.state !== "running") break;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(status.job.state, "complete");
  assert.equal(status.job.changed, 1);
  assert.deepEqual(fs.readFileSync(f.s.blob(hash)), buffer);
  await assert.rejects(
    f.api("/v1/images", { action: "optimize", confirmation: "invented" }),
    /Analyze/,
  );
  const device = await f.api("/v1/devices", {
    name: "Reader",
    role: "replica",
  });
  await assert.rejects(
    f.api("/v1/images", undefined, device.token),
    /administrator/,
  );
  await assert.rejects(
    f.api("/v1/images", { action: "regenerate" }, device.token),
    /administrator/,
  );
  // Unauthenticated callers cannot inspect library statistics or start jobs.
  await assert.rejects(f.api("/v1/images", undefined, "invalid"));
});

test("image conversion requires analysis, journals both paths, retains history and skips stale photos", async (t) => {
  const { ImageMaintenance } =
    await import("../packages/daemon/image-maintenance.js");
  const f = await fixture(t);
  await f.api("/v1/gallery/link", { volume: f.v.id, enabled: true });
  const original = await f.photo("one.jpg", "2020-01-02T00:00:00.000Z");
  const encoder = async (_, destination) => {
    fs.copyFileSync(
      new URL("./fixtures/gallery.heic", import.meta.url),
      destination,
    );
    return fs.statSync(destination).size;
  };
  const manager = new ImageMaintenance(f.daemon.engine, encoder);
  t.after(() => manager.close());
  manager.start("analyze");
  await manager.task;
  assert.equal(f.s.current(f.v.id, "one.jpg").deleted, 0);
  assert.ok(manager.job.confirmation);
  manager.start("optimize", manager.job.confirmation);
  await manager.task;
  assert.equal(manager.job.changed, 1, JSON.stringify(manager.job));
  assert.equal(f.s.current(f.v.id, "one.jpg").deleted, 1);
  assert.equal(f.s.current(f.v.id, "one.heic").deleted, 0);
  assert.deepEqual(fs.readFileSync(f.s.blob(original.hash)), original.buffer);
  assert.ok(
    f.s.history(f.v.id, "one.jpg").some((r) => r.hash === original.hash),
  );
  const listing = await f.api(f.route);
  assert.equal(listing.items[0].sourcePath, "one.jpg");
  assert.equal(listing.items[0].sourceHash, original.hash);
  await f.photo("changed.jpg");
  manager.start("analyze");
  await manager.task;
  const confirmation = manager.job.confirmation;
  const revised = await f.photo("other.jpg", null, "blue");
  f.s.commit(
    f.v.id,
    "changed.jpg",
    { hash: revised.hash, size: revised.buffer.length },
    f.s.config.id,
    true,
    f.s.current(f.v.id, "changed.jpg").hash,
  );
  manager.start("optimize", confirmation);
  await manager.task;
  assert.equal(manager.job.changed, 0);
  assert.match(manager.job.errors[0].error, /changed/);
  assert.equal(f.s.current(f.v.id, "changed.jpg").deleted, 0);
});

test("converted path recovery materializes HEIC before removing JPEG after an interrupted write", async (t) => {
  const f = await fixture(t);
  const original = await f.photo("recover.jpg");
  const replacement = f.s.capture(
    fileURLToPath(new URL("./fixtures/gallery.heic", import.meta.url)),
  );
  const current = f.s.current(f.v.id, "recover.jpg");
  const materialize = f.s.materialize.bind(f.s);
  f.s.materialize = () => {
    throw new Error("interrupted conversion");
  };
  assert.throws(
    () => f.s.renameFile(current, "recover.heic", f.s.config.id, replacement),
    /interrupted/,
  );
  assert.deepEqual(
    fs.readFileSync(path.join(f.v.path, "recover.jpg")),
    original.buffer,
  );
  f.s.materialize = (row, expected) => {
    if (row.deleted && row.path === "recover.jpg") {
      // Recovery may visit the deletion first; its renameDestination dependency
      // must materialize the new file before the actual removal.
      materialize(row, expected);
      assert.deepEqual(
        fs.readFileSync(path.join(f.v.path, "recover.heic")),
        fs.readFileSync(f.s.blob(replacement.hash)),
      );
      return;
    }
    return materialize(row, expected);
  };
  f.s.recover();
  assert.equal(fs.existsSync(path.join(f.v.path, "recover.jpg")), false);
  assert.deepEqual(fs.readFileSync(f.s.blob(original.hash)), original.buffer);
});

test("an unprofitable sample does not block optimization of untested new photos", async (t) => {
  const { ImageMaintenance } =
    await import("../packages/daemon/image-maintenance.js");
  const f = await fixture(t);
  await f.api("/v1/gallery/link", { volume: f.v.id, enabled: true });
  let eligible;
  for (let i = 0; i < 11; i++) {
    const photo = await f.photo(
      String(i).padStart(2, "0") + ".jpg",
      null,
      i === 1 ? "blue" : "red",
    );
    if (i === 1) eligible = photo;
  }
  const manager = new ImageMaintenance(
    f.daemon.engine,
    async (source, destination) => {
      if (source !== f.s.blob(eligible.hash)) return Number.MAX_SAFE_INTEGER;
      fs.copyFileSync(
        new URL("./fixtures/gallery.heic", import.meta.url),
        destination,
      );
      return fs.statSync(destination).size;
    },
  );
  t.after(() => manager.close());
  manager.start("analyze");
  await manager.task;
  assert.equal(manager.job.changed, 0);
  assert.ok(manager.job.confirmation);
  manager.start("optimize", manager.job.confirmation);
  await manager.task;
  assert.equal(manager.job.changed, 1);
  assert.equal(f.s.current(f.v.id, "01.heic").deleted, 0);
});
