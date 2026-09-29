import test from "node:test";
import assert from "node:assert/strict";
import {
  dateLabel,
  isGalleryVideo,
  mediaDate,
  mergeTimeline,
  monthLabel,
  uploadStatus,
} from "../apps/mobile/src/gallery-timeline.js";
import {
  clampOffset,
  clampScale,
  toggleZoom,
  zoomAround,
} from "../apps/mobile/src/viewer-gestures.js";
import { hubGallery, localGallery } from "../apps/mobile/src/hub-gallery.js";
import {
  galleryLayout,
  galleryWindow,
  itemOffset,
  keptOffset,
  neededMonth,
  scrubYears,
  sectionAt,
} from "../apps/mobile/src/gallery-layout.js";
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
  assert.equal(isGalleryVideo(items[4]), true);
  assert.deepEqual(mergeTimeline({}), []);
  assert.equal(mediaDate("Machine-ab12/2024/03/x.jpg"), "2024-03");
  assert.equal(mediaDate("x.jpg"), null);
});

test("month and date labels stay readable for undated photos", () => {
  assert.equal(monthLabel("2026-09"), "September 2026");
  assert.equal(monthLabel("undated"), "Undated");
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

function fakeHub(rows, size = 3) {
  const calls = [];
  let inflight = 0;
  const cursor = (row) => `${row.date || ""}|${row.path}`;
  const api = async (route) => {
    const query = new URL("http://hub" + route).searchParams;
    calls.push(Object.fromEntries(query));
    inflight++;
    api.overlap = Math.max(api.overlap || 0, inflight);
    await new Promise((resolve) => setTimeout(resolve, 1));
    inflight--;
    if (api.fail) throw new TypeError("Network request failed");
    const after =
      query.get("after") || (query.get("month") ? `${query.get("month")}~` : "");
    const list = [...rows]
      .sort((a, b) => (cursor(a) < cursor(b) ? 1 : -1))
      .filter((row) => !after || cursor(row) < after);
    const page = list.slice(0, size);
    const months = new Map();
    for (const row of rows)
      if (row.date) {
        const month = months.get(row.date.slice(0, 7)) || { count: 0, rev: 0 };
        months.set(row.date.slice(0, 7), { count: month.count + 1, rev: Math.max(month.rev, row.rev || 0) });
      }
    return {
      items: page.map((row) => ({ kind: "image", size: 1, ...row })),
      next: list.length > size ? cursor(page[page.length - 1]) : null,
      timeline: [...months]
        .map(([month, value]) => ({ month, ...value }))
        .sort((a, b) => b.month.localeCompare(a.month)),
    };
  };
  return { api, calls };
}
function memoryStore() {
  const saved = {};
  return {
    saved,
    get: async (key, fallback) => saved[key] ?? fallback,
    set: async (key, value) => {
      saved[key] = value;
    },
  };
}
const paths = (entry) => entry.items.map((item) => item.path);

test("the first page fills the newest months and a month continues from its own cursor", async () => {
  const rows = [
    { path: "u.jpg", hash: "u", date: null },
    { path: "a.jpg", hash: "a", date: "2026-09-03", rev: 9 },
    { path: "b.jpg", hash: "b", date: "2026-09-02" },
    { path: "c.jpg", hash: "c", date: "2026-09-01" },
    { path: "d.jpg", hash: "d", date: "2026-08-15" },
  ];
  const { api, calls } = fakeHub(rows);
  const store = memoryStore();
  const gallery = hubGallery({ api, store, scope: "s", volume: "v" });
  assert.equal(await gallery.cached(), null);
  const first = await gallery.refresh();
  assert.deepEqual(calls[0], { volume: "v" });
  assert.equal(first.total, 4);
  assert.deepEqual(paths(first.months.undated), ["u.jpg"]);
  assert.equal(first.months.undated.complete, true);
  assert.deepEqual(paths(first.months["2026-09"]), ["a.jpg", "b.jpg"]);
  assert.equal(first.months["2026-09"].complete, false);
  assert.equal(first.months["2026-09"].items[0].rev, 9);
  assert.equal(first.months["2026-08"], undefined);
  const more = await gallery.load("2026-09");
  assert.deepEqual(calls[1], { volume: "v", after: "2026-09-02|b.jpg" });
  assert.deepEqual(paths(more.months["2026-09"]), ["a.jpg", "b.jpg", "c.jpg"]);
  assert.equal(more.months["2026-09"].complete, true);
  assert.deepEqual(paths(more.months["2026-08"]), ["d.jpg"]);
  assert.equal(more.months["2026-08"].complete, true);
  assert.equal(await gallery.load("2026-09"), more);
  assert.equal(calls.length, 2);
  const reopened = hubGallery({ api, store, scope: "s", volume: "v" });
  assert.deepEqual(paths((await reopened.cached()).months["2026-08"]), ["d.jpg"]);
});

test("an old month loads from its own top without claiming the newer months", async () => {
  const rows = [
    ...Array.from({ length: 5 }, (_, n) => ({ path: `new-${n}.jpg`, date: "2026-09-10" })),
    { path: "old.jpg", date: "2014-05-01" },
  ];
  const { api, calls } = fakeHub(rows);
  const gallery = hubGallery({ api, store: memoryStore(), scope: "s", volume: "v" });
  const state = await gallery.load("2014-05");
  assert.deepEqual(calls, [{ volume: "v", month: "2014-05" }]);
  assert.deepEqual(paths(state.months["2014-05"]), ["old.jpg"]);
  assert.equal(state.months["2014-05"].complete, true);
  assert.equal(state.months["2026-09"], undefined);
  assert.equal(state.months.undated, undefined);
  await assert.rejects(gallery.load("2014-99"), /Invalid gallery month/);
});

test("a month whose count changes reloads while unchanged months keep their rows", async () => {
  const rows = [
    { path: "a.jpg", date: "2026-09-03" },
    { path: "b.jpg", date: "2026-08-03" },
    { path: "c.jpg", date: "2026-08-02" },
  ];
  const { api } = fakeHub(rows, 2);
  const gallery = hubGallery({ api, store: memoryStore(), scope: "s", volume: "v" });
  const before = await gallery.refresh();
  assert.equal(await gallery.refresh(), before);
  rows.push({ path: "d.jpg", date: "2026-08-01" });
  const after = await gallery.refresh();
  assert.equal(after.months["2026-09"], before.months["2026-09"]);
  assert.deepEqual(paths(after.months["2026-08"]), ["b.jpg"]);
  assert.equal(after.months["2026-08"].complete, false);
  const reloaded = await gallery.load("2026-08");
  assert.deepEqual(paths(reloaded.months["2026-08"]), ["b.jpg", "c.jpg", "d.jpg"]);
  assert.equal(reloaded.months["2026-08"].complete, true);
});

test("a continuation into a month that changed restarts it from its new top", async () => {
  const rows = Array.from({ length: 5 }, (_, n) => ({
    path: `${n}.jpg`,
    date: `2026-09-0${5 - n}`,
  }));
  const { api, calls } = fakeHub(rows);
  const gallery = hubGallery({ api, store: memoryStore(), scope: "s", volume: "v" });
  await gallery.refresh();
  rows.push({ path: "newest.jpg", date: "2026-09-09" });
  const discarded = await gallery.load("2026-09");
  assert.deepEqual(paths(discarded.months["2026-09"]), ["0.jpg", "1.jpg", "2.jpg"], "stale rows stay visible");
  assert.equal(discarded.months["2026-09"].fresh, 0);
  const restarted = await gallery.load("2026-09");
  assert.deepEqual(calls.at(-1), { volume: "v", month: "2026-09" });
  assert.deepEqual(paths(restarted.months["2026-09"]), ["newest.jpg", "0.jpg", "1.jpg", "2.jpg"]);
  assert.equal(restarted.months["2026-09"].fresh, 3, "the unverified tail stays visible after the fresh prefix");
});

test("a page replaces edited, deleted and renamed rows across the range it covers", async () => {
  const rows = [
    { path: "a.jpg", hash: "h1", rev: 1, date: "2026-09-03" },
    { path: "b.jpg", hash: "h2", rev: 2, date: "2026-09-02" },
    { path: "u.jpg", hash: "u1", rev: 3, date: null },
  ];
  const { api } = fakeHub(rows, 10);
  const gallery = hubGallery({ api, store: memoryStore(), scope: "s", volume: "v" });
  await gallery.refresh();
  rows[0] = { path: "a.jpg", hash: "h9", rev: 9, date: "2026-09-03" };
  rows[1] = { path: "c.jpg", hash: "h3", rev: 10, date: "2026-09-01" };
  rows.pop();
  const state = await gallery.refresh();
  assert.deepEqual(
    state.months["2026-09"].items.map((item) => [item.path, item.hash, item.rev]),
    [
      ["a.jpg", "h9", 9],
      ["c.jpg", "h3", 10],
    ],
  );
  assert.deepEqual(state.months.undated.items, []);
});

test("a changed month deeper than the first page stays visible until its fresh rows arrive", async () => {
  const rows = [
    { path: "new.jpg", rev: 1, date: "2026-09-03" },
    { path: "old-a.jpg", hash: "h1", rev: 2, date: "2019-05-03" },
    { path: "old-b.jpg", rev: 3, date: "2019-05-02" },
  ];
  const { api } = fakeHub(rows, 1);
  const gallery = hubGallery({ api, store: memoryStore(), scope: "s", volume: "v" });
  await gallery.refresh();
  await gallery.load("2019-05");
  const before = await gallery.load("2019-05");
  assert.equal(before.months["2019-05"].complete, true);
  rows[1] = { path: "old-a.jpg", hash: "h7", rev: 7, date: "2019-05-03" };
  const stale = await gallery.refresh();
  assert.deepEqual(paths(stale.months["2019-05"]), ["old-a.jpg", "old-b.jpg"]);
  assert.equal(stale.months["2019-05"].fresh, 0);
  assert.equal(stale.months["2019-05"].complete, false);
  const fresh = await gallery.load("2019-05");
  assert.deepEqual(
    fresh.months["2019-05"].items.map((item) => [item.path, item.hash]),
    [
      ["old-a.jpg", "h7"],
      ["old-b.jpg", undefined],
    ],
  );
  assert.equal(fresh.months["2019-05"].fresh, 1);
});

test("an unchanged refresh keeps a fully loaded newest month and the same state", async () => {
  const rows = Array.from({ length: 130 }, (_, n) => ({
    path: `${String(n).padStart(3, "0")}.jpg`,
    rev: n + 1,
    date: "2026-09-01",
  }));
  const { api, calls } = fakeHub(rows, 60);
  const gallery = hubGallery({ api, store: memoryStore(), scope: "s", volume: "v" });
  await gallery.refresh();
  await gallery.load("2026-09");
  const loaded = await gallery.load("2026-09");
  assert.equal(loaded.months["2026-09"].fresh, 130);
  assert.equal(loaded.months["2026-09"].complete, true);
  const requests = calls.length;
  assert.equal(await gallery.refresh(), loaded);
  assert.equal(calls.length, requests + 1, "a refresh reads one page");
});

test("the offline cache keeps a bounded prefix that resumes from its last kept row", async () => {
  const rows = Array.from({ length: 700 }, (_, n) => ({
    path: `${String(n).padStart(3, "0")}.jpg`,
    date: "2026-09-01",
  }));
  const { api, calls } = fakeHub(rows, 1000);
  const store = memoryStore();
  const gallery = hubGallery({ api, store, scope: "s", volume: "v" });
  assert.equal((await gallery.refresh()).months["2026-09"].items.length, 700);
  const reopened = hubGallery({ api, store, scope: "s", volume: "v" });
  const cached = (await reopened.cached()).months["2026-09"];
  assert.equal(cached.items.length, 600);
  assert.equal(cached.complete, false);
  const complete = await reopened.load("2026-09");
  assert.deepEqual(calls.at(-1), { volume: "v", after: `2026-09-01|${cached.items[599].path}` });
  assert.equal(new Set(paths(complete.months["2026-09"])).size, 700);
  assert.equal(complete.months["2026-09"].complete, true);
});

test("revisions survive the offline cache and forgetting a photo shrinks its month", async () => {
  const rows = [{ path: "phone/a.heic", hash: "cached", rev: 42, date: "2026-09-01" }];
  const { api } = fakeHub(rows);
  const store = memoryStore();
  const gallery = hubGallery({ api, store, scope: "s", volume: "v" });
  await gallery.refresh();
  const reopened = hubGallery({ api, store, scope: "s", volume: "v" });
  assert.equal((await reopened.cached()).months["2026-09"].items[0].rev, 42);
  const forgotten = await gallery.forget("phone/a.heic");
  assert.deepEqual(forgotten.months["2026-09"].items, []);
  assert.deepEqual(forgotten.timeline, []);
  assert.equal(forgotten.total, 0);
  const afterDeletion = hubGallery({ api, store, scope: "s", volume: "v" });
  assert.deepEqual((await afterDeletion.cached()).timeline, []);
});

test("loads and refreshes never overlap and a failing hub keeps the cached gallery", async () => {
  const rows = Array.from({ length: 7 }, (_, n) => ({ path: `${n}.jpg`, date: "2026-09-01" }));
  const { api } = fakeHub(rows);
  const store = memoryStore();
  const gallery = hubGallery({ api, store, scope: "s", volume: "v" });
  await Promise.all([gallery.refresh(), gallery.load("2026-09"), gallery.refresh()]);
  assert.equal(api.overlap, 1);
  api.fail = true;
  const offline = hubGallery({ api, store, scope: "s", volume: "v" });
  await assert.rejects(offline.refresh(), /Network request failed/);
  assert.ok((await offline.cached()).months["2026-09"].items.length >= 3);
});

test("without a hub index the phone's own files form a complete local gallery", () => {
  const day = (value) => Date.parse(`${value}T12:00:00Z`);
  const state = localGallery([
    { path: "a.jpg", uri: "file:a", size: 1, mtime: day("2026-09-10") },
    { path: "b.jpg", uri: "file:b", size: 1, mtime: day("2026-08-10") },
    { path: "notes.txt", size: 1, mtime: day("2026-08-10") },
    { path: "album", directory: true },
  ]);
  assert.equal(state.local, true);
  assert.deepEqual(state.timeline, [
    { month: "2026-09", count: 1 },
    { month: "2026-08", count: 1 },
  ]);
  assert.equal(state.months["2026-09"].complete, true);
  assert.equal(state.months["2026-09"].items[0].uri, "file:a");
  assert.equal(state.total, 2);
});

test("the gallery layout places every month by its count and windows only nearby rows", () => {
  const layout = galleryLayout(
    [
      { month: "2026-09", count: 10 },
      { month: "2026-08", count: 4 },
    ],
    400,
    4,
  );
  assert.equal(layout.step, 101);
  const [september, august] = layout.sections;
  assert.equal(september.rows, 3);
  assert.equal(september.gridTop, 30);
  assert.equal(september.height, 30 + 3 * 101 - 4);
  assert.equal(august.top, september.height + 20);
  assert.equal(layout.height, august.top + august.height);
  assert.equal(sectionAt(layout, -50), 0);
  assert.equal(sectionAt(layout, august.top - 1), 0);
  assert.equal(sectionAt(layout, august.top), 1);
  assert.deepEqual(
    galleryWindow(layout, 140, 200).map(({ section, header, first, last }) => [
      section.month,
      header,
      first,
      last,
    ]),
    [["2026-09", false, 1, 1]],
  );
  assert.deepEqual(
    galleryWindow(layout, 0, layout.height).map(({ section, first, last }) => [section.month, first, last]),
    [
      ["2026-09", 0, 2],
      ["2026-08", 0, 0],
    ],
  );
  assert.equal(itemOffset(layout, "2026-08", 5), august.gridTop + 101);
  assert.equal(itemOffset(layout, "1999-01", 0), null);
  assert.deepEqual(galleryLayout([], 400, 4).height, 0);
});

test("new rows above the viewport keep the photos on screen in place", () => {
  const before = galleryLayout(
    [
      { month: "2026-09", count: 4 },
      { month: "2019-05", count: 8 },
    ],
    400,
    4,
  );
  const after = galleryLayout(
    [
      { month: "2026-09", count: 12 },
      { month: "2019-05", count: 8 },
    ],
    400,
    4,
  );
  const view = before.sections[1].top + 50;
  assert.equal(keptOffset(before, after, view), after.sections[1].top + 50);
  assert.equal(keptOffset(before, after, view) - view, 2 * 101);
  assert.equal(keptOffset(before, after, 0), null, "at the top new photos appear above");
  assert.equal(keptOffset(before, galleryLayout([{ month: "2026-09", count: 12 }], 400, 4), view), null);
  assert.equal(keptOffset(before, galleryLayout([{ month: "2019-05", count: 8 }], 400, 10), view), null);
});

test("visible months load first and complete or sufficiently loaded months are skipped", () => {
  const layout = galleryLayout(
    [
      { month: "2026-09", count: 8 },
      { month: "2026-08", count: 8 },
    ],
    400,
    4,
  );
  const august = layout.sections[1];
  const eight = Array.from({ length: 8 }, () => ({}));
  const loaded = (fresh) => ({ items: eight, fresh, complete: false });
  assert.equal(
    neededMonth(layout, { "2026-09": loaded(0) }, 0, layout.height, august.top, august.top + 50),
    "2026-08",
  );
  assert.equal(neededMonth(layout, { "2026-09": loaded(8) }, 0, layout.height, 0, 50), "2026-08");
  assert.equal(
    neededMonth(
      layout,
      { "2026-09": loaded(8), "2026-08": { items: [], fresh: 0, complete: true } },
      0,
      layout.height,
      0,
      50,
    ),
    null,
  );
  assert.equal(neededMonth(layout, { "2026-09": loaded(4) }, 0, 60, 0, 60), null);
  assert.equal(
    neededMonth(layout, { "2026-09": loaded(0) }, 0, 60, 0, 60),
    "2026-09",
    "stale rows on screen are verified again",
  );
});

test("the scrubber shows sparse years and keeps the older one when two collide", () => {
  const sections = [
    { key: "2026-09", year: "2026", offset: 100 },
    { key: "2026-01", year: "2026", offset: 300 },
    { key: "2025-06", year: "2025", offset: 310 },
    { key: "2024-02", year: "2024", offset: 320 },
    { key: "undated", year: "", offset: 900 },
    { key: "2014-05", year: "2014", offset: 1100 },
  ];
  const years = scrubYears(sections, 100, 1100, 500);
  assert.deepEqual(
    years.map((year) => year.year),
    ["2026", "2024", "2014"],
  );
  assert.equal(years[0].top, 24);
  assert.equal(years[2].top, 524);
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

test("mobile gallery retains the hub revision when a deleted local copy disappears or is restored", () => {
  const photo = { path: "a.heic", hash: "same-bytes", rev: 42 };
  const local = { path: photo.path, uri: "file:a.heic", size: 100, mtime: 1 };
  const [before] = mergeTimeline({ index: [photo], entries: [local] });
  const [stale] = mergeTimeline({ index: [photo] });
  const [restored] = mergeTimeline({ index: [{ ...photo, rev: 44 }] });
  assert.equal(before.rev, stale.rev);
  assert.ok(restored.rev > before.rev);
});

test("thumbnail progress is visible before eight images finish, even if refresh interrupts", async () => {
  const entries = Array.from({ length: 12 }, (_, n) => ({
    path: `${n}.jpg`,
    signature: `${n}`,
  }));
  let active = true,
    renders = 0,
    visible = {};
  const result = await prepareThumbnails(
    entries,
    {},
    {
      exists: async () => false,
      render: async (item) => {
        if (++renders === 6) active = false;
        return `cache://${item.path}`;
      },
    },
    () => active,
    (value) => {
      visible = value;
    },
  );
  assert.equal(result, null);
  assert.equal(Object.keys(visible).length, 5);
});

test("pinching moves between base, compact and years levels, sized by the current layout", async () => {
  const { pinchLevel, levelColumns, galleryTileSize } =
    await import("../apps/mobile/src/gallery-scale.js");
  assert.equal(pinchLevel("base", 0.7), "compact");
  assert.equal(pinchLevel("compact", 0.5), "years");
  assert.equal(pinchLevel("years", 0.5), "years");
  assert.equal(pinchLevel("years", 1.4), "compact");
  assert.equal(pinchLevel("compact", 1.4), "base");
  assert.equal(pinchLevel("base", 2), "base");
  assert.equal(pinchLevel("base", 1.1), "base");
  assert.equal(levelColumns("base", 4), 4);
  assert.equal(levelColumns("compact", 4), 10);
  assert.equal(levelColumns("base", 6), 6);
  assert.equal(levelColumns("compact", 6), 12);
  assert.equal(levelColumns("years", 6), "years");
  assert.equal(galleryTileSize(0, 4).size, 0);
  for (const [width, columns] of [[320, 10], [400, 10], [800, 12]]) {
    const { size, gap } = galleryTileSize(width, columns);
    assert.ok(size > 0 && size < width / columns);
    assert.ok(size * columns + gap * (columns - 1) <= width);
  }
});

test("a pinch below the last year still anchors to a year so Years can zoom back", async () => {
  const { pinchGroup } = await import("../apps/mobile/src/gallery-scale.js");
  const years = [{ month: "2026-09" }, { month: "2025-12" }];
  const positions = new Map([
    ["2026-09", { top: 0, height: 300 }],
    ["2025-12", { top: 300, height: 300 }],
  ]);
  assert.equal(pinchGroup(years, positions, 120).month, "2026-09");
  assert.equal(pinchGroup(years, positions, 450).month, "2025-12");
  assert.equal(pinchGroup(years, positions, 1400).month, "2025-12");
  assert.equal(pinchGroup(years, new Map(), 50).month, "2026-09");
  assert.equal(pinchGroup([], new Map(), 50), null);
});

test("a grid pinch below a month's last row anchors to a tile that exists", async () => {
  const { pinchCell } = await import("../apps/mobile/src/gallery-scale.js");
  assert.deepEqual(pinchCell(10, 4, 100, 150, 120), { row: 1, index: 5 });
  assert.deepEqual(pinchCell(10, 4, 100, 350, 5000), { row: 2, index: 9 });
  assert.deepEqual(pinchCell(10, 4, 100, 50, 5000), { row: 2, index: 8 });
  assert.deepEqual(pinchCell(10, 4, 100, -20, -40), { row: 0, index: 0 });
});

test("pending uploads separate waiting photos from failed ones", async () => {
  const { pendingUploadLabel } = await import("../apps/mobile/src/gallery-timeline.js");
  assert.equal(pendingUploadLabel([{ upload: "failed" }], { pending: 1, failed: 1 }), "1 needs attention");
  assert.equal(pendingUploadLabel([{ upload: "pending" }], { pending: 3, failed: 0 }), "3 remaining");
  assert.equal(
    pendingUploadLabel([{ upload: "pending" }, { upload: "failed" }], { pending: 5, failed: 2 }),
    "3 remaining · 2 need attention",
  );
});

test("the rail labels undated photos instead of an invalid date", async () => {
  const { railMonthLabel } = await import("../apps/mobile/src/gallery-timeline.js");
  assert.equal(railMonthLabel("undated"), "Undated");
  assert.match(railMonthLabel("2026-09"), /2026/);
  assert.doesNotMatch(railMonthLabel("2026-09"), /Invalid/);
});

test("year mosaics aggregate the full timeline and open the newest populated month", async () => {
  const { galleryYears } = await import("../apps/mobile/src/gallery-scale.js");
  assert.deepEqual(
    galleryYears([
      { month: "2024-02", count: 7 },
      { month: "2026-09", count: 200 },
      { month: "2024-11", count: 3 },
    ]),
    [
      { year: "2026", month: "2026-09", count: 200, annual: true },
      { year: "2024", month: "2024-11", count: 10, annual: true },
    ],
  );
  assert.deepEqual(galleryYears([]), []);
});
