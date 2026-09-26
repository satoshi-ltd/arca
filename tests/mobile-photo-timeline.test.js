import test from "node:test";
import assert from "node:assert/strict";
import {
  dateLabel,
  groupByMonth,
  isGalleryVideo,
  mediaDate,
  mergeTimeline,
  photoCount,
  uploadStatus,
} from "../apps/mobile/src/gallery-timeline.js";
import {
  clampOffset,
  clampScale,
  toggleZoom,
  zoomAround,
} from "../apps/mobile/src/viewer-gestures.js";
import { hubGallery } from "../apps/mobile/src/hub-gallery.js";
import { prepareThumbnails } from "../apps/mobile/src/thumbnail-cache.js";
import { galleryDate, mediaKind } from "../packages/core/gallery-date.js";

test("timeline orders newest first from hub dates, fills local copies and leads with pending uploads", () => {
  const index = [
    {
      path: "Machine-a/2026/09/IMG_1.jpg",
      hash: "h1",
      size: 10,
      date: "2026-09-20T10:00:00",
      kind: "image",
    },
    {
      path: "Machine-b/2026/08/clip.mov",
      hash: "h2",
      size: 20,
      date: "2026-08-02",
      kind: "video",
    },
    { path: "notes.txt", hash: "h3", size: 1, date: "2026-09-21" },
  ];
  const entries = [
    {
      path: "Machine-a/2026/09/IMG_1.jpg",
      uri: "file:///a.jpg",
      size: 10,
      mtime: 5,
    },
    {
      path: "Machine-b/2026/09/IMG_20260915_120000.jpg",
      uri: "file:///b.jpg",
      size: 7,
      mtime: 9,
    },
    { path: "album", directory: true },
    { path: "readme.md", uri: "file:///r.md", size: 3 },
    {
      path: "loose.png",
      uri: "file:///c.png",
      size: 4,
      mtime: Date.UTC(2025, 0, 2),
    },
  ];
  const uploads = [
    {
      id: "u1",
      state: "uploading",
      uri: "file:///u1.jpg",
      creationTime: 1,
      filename: "one.jpg",
    },
    { id: "u2", state: "failed", uri: null, creationTime: 2, video: true },
    { id: "u3", state: "accepted", uri: "file:///u3.jpg", creationTime: 3 },
  ];
  const items = mergeTimeline({ index, entries, uploads });
  assert.deepEqual(
    items.map((item) => item.path),
    [
      "upload:u2",
      "upload:u1",
      "Machine-a/2026/09/IMG_1.jpg",
      "Machine-b/2026/09/IMG_20260915_120000.jpg",
      "Machine-b/2026/08/clip.mov",
      "loose.png",
    ],
  );
  assert.equal(items[0].upload, "failed");
  assert.equal(items[0].kind, "video");
  assert.equal(items[2].uri, "file:///a.jpg");
  assert.equal(items[2].hash, "h1");
  assert.equal(items[2].signature, "10:5");
  assert.equal(items[3].date, "2026-09-15");
  assert.equal(items[4].uri, null);
  assert.equal(items[4].signature, "h2");
  assert.equal(items[5].date, "2025-01-02");
  assert.equal(photoCount(items), 4);
  assert.equal(isGalleryVideo(items[4]), true);
  assert.deepEqual(mergeTimeline({}), []);
  assert.equal(mediaDate("Machine-ab12/2024/03/x.jpg"), "2024-03");
  assert.equal(mediaDate("x.jpg"), null);
});

test("timeline groups by month with readable labels", () => {
  const groups = groupByMonth([
    { path: "upload:1", upload: "uploading" },
    { path: "a.jpg", date: "2026-09-20T10:00:00" },
    { path: "b.jpg", date: "2026-09-01" },
    { path: "c.jpg", date: "2026-08" },
    { path: "d.jpg", date: null },
  ]);
  assert.deepEqual(
    groups.map((group) => [group.month, group.label, group.items.length]),
    [
      ["uploading", "Uploading", 1],
      ["2026-09", "September 2026", 2],
      ["2026-08", "August 2026", 1],
      ["undated", "Undated", 1],
    ],
  );
  assert.equal(dateLabel("2026-08"), "August 2026");
  assert.match(dateLabel("2026-09-15"), /Sep 15, 2026/);
  assert.match(dateLabel("2026-09-15T10:12:00"), /Sep 15, 2026/);
  assert.match(dateLabel("2026-09-15T10:12:00"), /10:12/);
  assert.equal(dateLabel(""), "");
  assert.equal(dateLabel("garbage"), "");
});

test("upload status mirrors the retired source card", () => {
  const flags = { connected: true, paused: false, busy: false };
  const ready = { enabled: true, scannedAt: 1, summary: { pending: 0 } };
  assert.equal(uploadStatus(ready, flags), "Up to date");
  assert.equal(
    uploadStatus({ ...ready, summary: { pending: 3 } }, flags),
    "Incomplete",
  );
  assert.equal(uploadStatus(ready, { ...flags, busy: true }), "Syncing");
  assert.equal(
    uploadStatus(ready, { ...flags, connected: false }),
    "Needs attention",
  );
  assert.equal(uploadStatus(ready, { ...flags, paused: true }), "Paused");
  assert.equal(uploadStatus({ ...ready, enabled: false }, flags), "Disabled");
  assert.equal(
    uploadStatus({ ...ready, mode: "converting" }, flags),
    "Incomplete",
  );
});

test("shared gallery date and media kind match the hub", () => {
  assert.equal(mediaKind("a/b.HEIC"), "image");
  assert.equal(mediaKind("clip.webm"), "video");
  assert.equal(mediaKind("notes.txt"), null);
  assert.equal(mediaKind(".hidden"), null);
  assert.deepEqual(galleryDate("x.jpg", "2026-01-01T00:00:00", "added"), {
    date: "2026-01-01T00:00:00",
    source: "metadata",
  });
  assert.deepEqual(galleryDate("Screenshot_2026-02-30.png", null, "added"), {
    date: "added",
    source: "date added",
  });
  assert.deepEqual(galleryDate("PXL_20260301_1.jpg", null, null), {
    date: "2026-03-01",
    source: "filename",
  });
});

test("viewer zoom keeps the focal point fixed and clamps offsets to the page", () => {
  const viewport = { width: 400, height: 800 };
  assert.equal(clampScale(0.5), 1);
  assert.equal(clampScale(9), 4);
  const zoomed = zoomAround(
    { scale: 1, x: 0, y: 0 },
    2,
    { x: 100, y: -200 },
    viewport,
  );
  assert.equal(zoomed.scale, 2);
  const content = (state, focal) => ({
    x: (focal.x - state.x) / state.scale,
    y: (focal.y - state.y) / state.scale,
  });
  assert.deepEqual(content(zoomed, { x: 100, y: -200 }), { x: 100, y: -200 });
  assert.deepEqual(clampOffset({ x: 500, y: -900 }, 2, viewport), {
    x: 200,
    y: -400,
  });
  assert.deepEqual(clampOffset({ x: 30, y: 30 }, 1, viewport), { x: 0, y: 0 });
  const doubled = toggleZoom(
    { scale: 1, x: 0, y: 0 },
    { x: 0, y: 0 },
    viewport,
  );
  assert.equal(doubled.scale, 2.5);
  assert.deepEqual(toggleZoom(doubled, { x: 50, y: 50 }, viewport), {
    scale: 1,
    x: 0,
    y: 0,
  });
});

test("hub index pages through the gallery, caches a bounded copy and works from cache offline", async () => {
  const calls = [];
  const pages = {
    "": {
      items: [
        {
          path: "a.jpg",
          hash: "h1",
          size: 1,
          date: "2026-09-02",
          kind: "image",
          rev: 9,
          cursor: "x",
        },
      ],
      next: "c1",
      timeline: [
        { month: "2026-09", count: 2 },
        { month: "2026-08", count: 1 },
      ],
      indexing: true,
    },
    c1: {
      items: [
        {
          path: "b.jpg",
          hash: "h2",
          size: 2,
          date: "2026-09-01",
          kind: "image",
        },
      ],
      next: null,
      timeline: [],
    },
  };
  const saved = {};
  const store = {
    get: async (key, fallback) => saved[key] ?? fallback,
    set: async (key, value) => {
      saved[key] = value;
    },
  };
  const api = async (route) => {
    calls.push(route);
    const after = new URL("http://h" + route).searchParams.get("after") || "";
    return pages[after];
  };
  const gallery = hubGallery({ api, store, scope: "s", volume: "v" });
  assert.equal(await gallery.cached(), null);
  const first = await gallery.first();
  assert.equal(calls[0], "/v1/gallery?volume=v");
  assert.deepEqual(first, {
    items: [
      {
        path: "a.jpg",
        hash: "h1",
        size: 1,
        date: "2026-09-02",
        kind: "image",
        rev: 9,
      },
    ],
    next: "c1",
    total: 3,
    indexing: true,
  });
  const more = await gallery.more(first);
  assert.equal(calls[1], "/v1/gallery?volume=v&after=c1");
  assert.equal(more.items.length, 2);
  assert.equal(more.next, null);
  assert.equal(await gallery.more(more), more);
  assert.deepEqual(await gallery.cached(), more);
  const failing = hubGallery({
    api: async () => {
      throw new TypeError("Network request failed");
    },
    store,
    scope: "s",
    volume: "v",
  });
  await assert.rejects(failing.first(), /Network request failed/);
  assert.equal((await failing.cached()).items.length, 2);
});

test("thumbnail preparation renders only the shown slice and keeps cached items still in the timeline", async () => {
  const rendered = [];
  const io = {
    exists: async () => true,
    render: async (item) => {
      rendered.push(item.path);
      return `cache://${item.path}`;
    },
  };
  const all = [
    { path: "a.jpg", signature: "h1" },
    { path: "b.jpg", signature: "h2" },
    { path: "c.mov", signature: "h3" },
    { path: "notes.txt", signature: "h4" },
  ];
  const previous = {
    "b.jpg": { signature: "h2", uri: "cache://b.jpg" },
    "gone.jpg": { signature: "x", uri: "cache://gone" },
  };
  const next = await prepareThumbnails(
    all.slice(0, 1),
    previous,
    io,
    () => true,
    () => {},
    all,
  );
  assert.deepEqual(rendered, ["a.jpg"]);
  assert.deepEqual(Object.keys(next).sort(), ["a.jpg", "b.jpg"]);
  const posters = await prepareThumbnails(all.slice(2), {}, io);
  assert.deepEqual(Object.keys(posters), ["c.mov"]);
});

test("photo info mirrors the desktop Info panel and degrades without hub metadata", async () => {
  const { photoInfo, photoDate } =
    await import("../apps/mobile/src/photo-info.js");
  const { bytes } = await import("../apps/mobile/src/format.js");
  const item = {
    path: "Machine-a8bc/2026/08/20260830_073054-aa8d.jpg",
    size: 6800000,
    date: "2026-08-30T07:30:54",
    hash: "h1",
  };
  const meta = {
    width: 4000,
    height: 3000,
    format: "JPEG",
    make: "samsung",
    model: "Galaxy Z Fold8",
    lens: "Galaxy Z Fold8 Wide-angle lens 5.400mm f/1.80",
    aperture: 1.8,
    exposure: 1 / 871,
    iso: 25,
    focalLength: 5.4,
    captured: "2026-08-30T07:30:54",
    offset: "+07:00",
    location: { latitude: 12.5225221, longitude: 99.9820919 },
    accepted: { date: "2026-08-30T01:00:00Z", machine: "Casa", revision: 12 },
    hasHistory: true,
  };
  const info = photoInfo(item, meta, "photos-demo");
  assert.equal(info.name, "20260830_073054-aa8d.jpg");
  assert.equal(info.summary, `${bytes(6800000)} · 4000 × 3000 · 12 MP · JPEG`);
  assert.deepEqual(
    info.capture.map((row) => [row.icon, row.label, row.detail]),
    [
      ["calendar", "Taken", "UTC+07:00"],
      ["camera", "Camera", "Galaxy Z Fold8 Wide-angle lens 5.400mm f/1.80"],
    ],
  );
  assert.match(info.capture[0].value, /August 30, 2026/);
  assert.match(info.capture[0].value, /07:30/);
  assert.equal(info.capture[1].value, "samsung Galaxy Z Fold8");
  assert.deepEqual(info.metrics, [
    ["Aperture", "f/1.8"],
    ["Shutter", "1/871 s"],
    ["ISO", "25"],
    ["Focal", "5.4 mm"],
  ]);
  assert.equal(info.location.text, "12.522522, 99.982092");
  assert.equal(
    info.location.url,
    "https://maps.google.com/?q=12.522522%2C%2099.982092",
  );
  assert.equal(
    info.arca[0].value,
    "photos-demo/Machine-a8bc/2026/08/20260830_073054-aa8d.jpg",
  );
  assert.equal(info.arca[1].detail, "From Casa · rev 12");
  assert.equal(info.hasHistory, true);
  assert.equal(
    photoInfo(item, { make: "Apple", model: "Apple iPhone" }).capture[1].value,
    "Apple iPhone",
  );
  const bare = photoInfo({ path: "loose.png", size: 0, date: "2026-09" }, null);
  assert.equal(bare.summary, "");
  assert.deepEqual(
    bare.capture.map((row) => [row.label, row.value]),
    [["Date", "September 2026"]],
  );
  assert.deepEqual(bare.metrics, []);
  assert.equal(bare.location, null);
  assert.deepEqual(
    bare.arca.map((row) => row.value),
    ["loose.png"],
  );
  assert.equal(bare.hasHistory, false);
  assert.equal(photoDate("2026-09-15"), "September 15, 2026");
  assert.equal(photoDate("garbage"), "garbage");
  assert.equal(photoDate(""), "");
});

const tiff = (little, fields) => {
  const order = little ? "II" : "MM";
  const entries = { ifd0: [], exif: [], gps: [] };
  const blobs = [];
  let blobOffset = 0;
  const heap = (bytes) => {
    const at = blobOffset;
    blobs.push(bytes);
    blobOffset += bytes.length + (bytes.length % 2);
    return at;
  };
  const number = (value, size) => {
    const out = new Uint8Array(size);
    const view = new DataView(out.buffer);
    if (size === 2) view.setUint16(0, value, little);
    else view.setUint32(0, value >>> 0, little);
    return out;
  };
  const rational = (values) =>
    values.flatMap(([n, d]) => [...number(n, 4), ...number(d, 4)]);
  const ascii = (text) => [...new TextEncoder().encode(text + "\0")];
  for (const [table, tag, type, payload] of fields)
    entries[table].push({ tag, type, payload: new Uint8Array(payload) });
  const layout = () => {
    const header = 8;
    const size = (list) => 2 + list.length * 12 + 4;
    const ifd0At = header;
    const exifAt = ifd0At + size(entries.ifd0) + 24;
    const gpsAt = exifAt + size(entries.exif);
    const dataAt = gpsAt + size(entries.gps);
    return { ifd0At, exifAt, gpsAt, dataAt };
  };
  const { ifd0At, exifAt, gpsAt, dataAt } = layout();
  const counts = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 10: 8 };
  const encode = (list, extra = []) => {
    const rows = [...list, ...extra].sort((a, b) => a.tag - b.tag);
    const out = [...number(rows.length, 2)];
    for (const row of rows) {
      const count = row.payload.length / counts[row.type];
      out.push(
        ...number(row.tag, 2),
        ...number(row.type, 2),
        ...number(count, 4),
      );
      if (row.payload.length <= 4) {
        const cell = new Uint8Array(4);
        cell.set(row.payload);
        out.push(...cell);
      } else out.push(...number(dataAt + heap(row.payload), 4));
    }
    out.push(...number(0, 4));
    return out;
  };
  const ifd0 = encode(entries.ifd0, [
    { tag: 0x8769, type: 4, payload: number(exifAt, 4) },
    { tag: 0x8825, type: 4, payload: number(gpsAt, 4) },
  ]);
  const exif = encode(entries.exif);
  const gps = encode(entries.gps);
  const pad = new Uint8Array(exifAt - ifd0At - ifd0.length);
  const body = [
    ...new TextEncoder().encode(order),
    ...number(42, 2),
    ...number(ifd0At, 4),
    ...ifd0,
    ...pad,
    ...exif,
    ...gps,
  ];
  for (const blob of blobs) {
    body.push(...blob);
    if (blob.length % 2) body.push(0);
  }
  return { bytes: new Uint8Array(body), rational, ascii };
};
const jpeg = (exif) => {
  const segment = (marker, payload) => [
    0xff,
    marker,
    ...[(payload.length + 2) >> 8, (payload.length + 2) & 0xff],
    ...payload,
  ];
  const app1 = [...new TextEncoder().encode("Exif\0\0"), ...exif];
  return new Uint8Array([
    0xff,
    0xd8,
    ...segment(0xe0, [
      ...new TextEncoder().encode("JFIF\0"),
      1,
      1,
      0,
      0,
      1,
      0,
      1,
      0,
      0,
    ]),
    ...segment(0xe1, app1),
    ...segment(0xdb, new Array(67).fill(1)),
    ...segment(0xda, [1, 1, 0, 0, 63, 0]),
    0x12,
    0x34,
    0xff,
    0xd9,
  ]);
};

test("local EXIF reader decodes the hub's tag set in both byte orders and agrees with exifr", async () => {
  const { readExif, parseTiff } = await import("../apps/mobile/src/exif.js");
  const exifr = (await import("exifr")).default;
  for (const little of [true, false]) {
    const helpers = tiff(little, []);
    const { bytes } = tiff(little, [
      ["ifd0", 0x010f, 2, helpers.ascii("samsung")],
      ["ifd0", 0x0110, 2, helpers.ascii("Galaxy Z Fold8")],
      ["ifd0", 0x0112, 3, [...(little ? [6, 0] : [0, 6])]],
      ["exif", 0x829d, 5, helpers.rational([[18, 10]])],
      ["exif", 0x829a, 5, helpers.rational([[1, 871]])],
      ["exif", 0x8827, 3, [...(little ? [25, 0] : [0, 25])]],
      ["exif", 0x920a, 5, helpers.rational([[54, 10]])],
      ["exif", 0x9003, 2, helpers.ascii("2026:08:30 07:30:54")],
      ["exif", 0x9011, 2, helpers.ascii("+07:00")],
      ["exif", 0xa434, 2, helpers.ascii("Wide-angle lens 5.400mm f/1.80")],
      ["gps", 0x0001, 2, helpers.ascii("N")],
      [
        "gps",
        0x0002,
        5,
        helpers.rational([
          [12, 1],
          [31, 1],
          [2108, 100],
        ]),
      ],
      ["gps", 0x0003, 2, helpers.ascii("W")],
      [
        "gps",
        0x0004,
        5,
        helpers.rational([
          [99, 1],
          [58, 1],
          [5553, 100],
        ]),
      ],
    ]);
    const parsed = parseTiff(bytes);
    assert.equal(parsed.make, "samsung");
    assert.equal(parsed.model, "Galaxy Z Fold8");
    assert.equal(parsed.orientation, 6);
    assert.equal(parsed.lens, "Wide-angle lens 5.400mm f/1.80");
    assert.equal(parsed.aperture, 1.8);
    assert.ok(Math.abs(parsed.exposure - 1 / 871) < 1e-9);
    assert.equal(parsed.iso, 25);
    assert.equal(parsed.focalLength, 5.4);
    assert.equal(parsed.captured, "2026-08-30T07:30:54");
    assert.equal(parsed.offset, "+07:00");
    assert.ok(Math.abs(parsed.location.latitude - 12.522522) < 1e-6);
    assert.ok(Math.abs(parsed.location.longitude + 99.982092) < 1e-6);
    const file = jpeg(bytes);
    const reference = await exifr.parse(file, {
      pick: [
        "Make",
        "Model",
        "FNumber",
        "ExposureTime",
        "ISO",
        "FocalLength",
        "DateTimeOriginal",
        "GPSLatitude",
      ],
      reviveValues: false,
    });
    assert.equal(reference.Make, "samsung");
    assert.equal(reference.FNumber, 1.8);
    assert.equal(reference.ISO, 25);
    assert.equal(reference.FocalLength, 5.4);
    assert.equal(reference.DateTimeOriginal, "2026:08:30 07:30:54");
    const reads = [];
    const chunked = await readExif(async (offset, length) => {
      reads.push([offset, length]);
      return file.subarray(
        offset,
        Math.min(file.length, offset + Math.min(length, 16)),
      );
    });
    assert.deepEqual(chunked, parsed);
    assert.ok(reads.length > 3);
    assert.deepEqual(
      await readExif(async (offset, length) =>
        file.subarray(offset, offset + length),
      ),
      parsed,
    );
  }
  assert.equal(
    await readExif(async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47])),
    null,
  );
  const plain = jpeg(new Uint8Array(0));
  assert.equal(
    await readExif(async (offset, length) =>
      plain.subarray(offset, offset + length),
    ),
    null,
  );
  assert.equal(
    parseTiff(new Uint8Array([0x49, 0x49, 43, 0, 8, 0, 0, 0])),
    null,
  );
  assert.deepEqual(
    parseTiff(
      tiff(true, [["exif", 0x9003, 2, tiff(true, []).ascii("garbage")]]).bytes,
    ),
    {},
  );
});

test("hub refresh retains loaded pages and serializes pagination against refresh", async () => {
  const store = { get: async () => null, set: async () => {} };
  let generation = 0;
  const gallery = hubGallery({
    store,
    scope: "s",
    volume: "v",
    api: async (route) => {
      const after = new URL(route, "http://hub").searchParams.get("after");
      return {
        items: [{ path: `${after || "first"}-${generation}.jpg` }],
        next: after ? null : "second",
      };
    },
  });
  const first = await gallery.first();
  await gallery.more(first);
  generation = 1;
  const [fresh, more] = await Promise.all([
    gallery.first(),
    gallery.more(first),
  ]);
  assert.deepEqual(
    fresh.items.map((item) => item.path),
    ["first-1.jpg", "second-1.jpg"],
  );
  assert.deepEqual(more, fresh);
});

test("bounded hub cache keeps its matching cursor instead of truncating a page", async () => {
  let saved;
  const store = {
    get: async () => saved,
    set: async (_, value) => {
      saved = value;
    },
  };
  const api = async (route) => {
    const after = new URL(route, "http://hub").searchParams.get("after");
    const start = after ? 1500 : 0;
    return {
      items: Array.from({ length: 1500 }, (_, i) => ({
        path: `${start + i}.jpg`,
      })),
      next: after ? null : "page2",
    };
  };
  const gallery = hubGallery({ api, store, scope: "s", volume: "v" });
  const first = await gallery.first();
  assert.equal((await gallery.more(first)).items.length, 3000);
  const reopened = hubGallery({ api, store, scope: "s", volume: "v" });
  const cached = await reopened.cached();
  assert.equal(cached.items.length, 1500);
  assert.equal(cached.next, "page2");
  const complete = await reopened.more(cached);
  assert.equal(new Set(complete.items.map((item) => item.path)).size, 3000);
});

test("gallery revisions survive refresh and offline cache", async () => {
  let saved;
  const store = {
    get: async () => saved,
    set: async (_, state) => {
      saved = state;
    },
  };
  const photo = {
    path: "phone/a.heic",
    hash: "cached",
    rev: 42,
  };
  const api = async () => ({ items: [photo], next: null });
  const gallery = hubGallery({ api, store, scope: "s", volume: "v" });
  await gallery.first();
  const reopened = hubGallery({ api, store, scope: "s", volume: "v" });
  const [item] = (await reopened.cached()).items;
  assert.equal(item.rev, 42);
  await gallery.forget(photo.path);
  const afterDeletion = hubGallery({ api, store, scope: "s", volume: "v" });
  assert.deepEqual((await afterDeletion.cached()).items, []);
});

test("mobile gallery retains the hub revision when a deleted local copy disappears or is restored", () => {
  const photo = { path: "a.heic", hash: "same-bytes", rev: 42 };
  const local = { path: photo.path, uri: "file:a.heic", size: 100, mtime: 1 };
  const [before] = mergeTimeline({ index: [photo], entries: [local] });
  const [stale] = mergeTimeline({ index: [photo] });
  const [restored] = mergeTimeline({ index: [{ ...photo, rev: 44 }] });
  assert.equal(before.rev, stale.rev);
  assert.ok(restored.rev > before.rev);
});
