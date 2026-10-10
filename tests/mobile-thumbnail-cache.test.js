import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { mergeTimeline, timelineItem } from "../apps/mobile/src/gallery-timeline.js";
import {
  createFlusher,
  createLimiter,
  createPreviewQueue,
  localPreviewIo,
  prepareThumbnails,
  previewProgress,
  pruneSaved,
  savedThumbnail,
  stillDownloading,
} from "../apps/mobile/src/thumbnail-cache.js";
import { previewCandidates } from "../apps/mobile/src/gallery-timeline.js";
import { rememberFailures } from "../apps/mobile/src/video-playback.js";

test("mobile thumbnail cache reuses unchanged images, regenerates changed or evicted copies and drops deletions", async () => {
  const entries = [
    { path: "a.jpg", uri: "file:///a", size: 20, mtime: 1 },
    { path: "b.jpg", uri: "file:///b", size: 30, mtime: 1 },
  ];
  let renders = 0;
  const io = {
    exists: async () => true,
    render: async (entry) => {
      renders++;
      return `cache://${entry.path}-${entry.mtime}`;
    },
  };
  const first = await prepareThumbnails(entries, {}, io);
  assert.equal(renders, 2);
  const updates = [];
  assert.deepEqual(
    await prepareThumbnails(
      entries,
      first,
      io,
      () => true,
      (value) => updates.push(value),
    ),
    first,
  );
  assert.equal(renders, 2);
  assert.equal(updates.length, 0);
  const next = await prepareThumbnails(
    [{ ...entries[0], mtime: 2 }],
    first,
    io,
  );
  assert.deepEqual(Object.keys(next), ["a.jpg"]);
  assert.equal(renders, 3);
  await prepareThumbnails(entries.slice(0, 1), first, {
    ...io,
    exists: async () => false,
  });
  assert.equal(renders, 4);
  assert.equal(await prepareThumbnails(entries, first, io, () => false), null);
  const failed = await prepareThumbnails(
    entries,
    {},
    {
      exists: async () => false,
      render: async () => {
        throw new Error("unsupported");
      },
    },
  );
  assert.deepEqual(failed, {});
});

test("a saved thumbnail is found by path and signature and an item without a signature never throws", () => {
  const saved = { "a.jpg": { signature: "20:1", uri: "cache://a" } };
  assert.equal(savedThumbnail(saved, { path: "a.jpg", signature: "20:1" }), "cache://a");
  assert.equal(savedThumbnail(saved, { path: "a.jpg", signature: "20:2" }), null, "a changed file is regenerated");
  assert.equal(savedThumbnail(saved, { path: "c.jpg", signature: "9:9" }), null);
  const pending = mergeTimeline({ uploads: [{ id: 1, state: "pending", uri: "file:///x.jpg", filename: "x.jpg" }] })[0];
  assert.equal(pending.signature, undefined);
  assert.equal(savedThumbnail(saved, pending), null, "a pending upload has no signature and no saved thumbnail");
  const unhashed = timelineItem({ path: "d.jpg", size: 1, date: "2026-09-01", kind: "image" });
  assert.equal(unhashed.signature, undefined);
  assert.equal(savedThumbnail(saved, unhashed), null, "a hub row without a hash has no signature");
  assert.equal(savedThumbnail({}, pending), null);
});

test("the gallery resolves saved thumbnails through savedThumbnail", () => {
  const gallery = fs.readFileSync(new URL("../apps/mobile/src/FolderGallery.jsx", import.meta.url), "utf8");
  assert.match(gallery, /savedThumbnail\(thumbnails, item\)/);
  assert.doesNotMatch(gallery, /thumbnails\[item\.path\]\?\.signature === item\.signature/);
});

test("a photo whose preview cannot be made is attempted once across preparation passes until it changes or the app returns", async () => {
  const entry = { path: "a.heic", uri: "file:///a", size: 20, mtime: 1 };
  const good = { path: "b.jpg", uri: "file:///b", size: 30, mtime: 1 };
  const attempt = rememberFailures(4096, "Thumbnail unavailable");
  const calls = [];
  const io = {
    exists: async () => true,
    render: (item) =>
      attempt(`${item.uri}:${item.size}:${item.mtime}`, async () => {
        calls.push(item.path);
        if (item.path === "a.heic") throw new Error("Unsupported image");
        return `cache://${item.path}`;
      }),
  };
  let saved = await prepareThumbnails([entry, good], {}, io);
  saved = await prepareThumbnails([entry, good], saved, io);
  saved = await prepareThumbnails([entry, good], saved, io);
  assert.deepEqual(calls, ["a.heic", "b.jpg"], "the unreadable photo is tried once, the readable one is kept");
  assert.deepEqual(Object.keys(saved), ["b.jpg"]);
  await prepareThumbnails([{ ...entry, mtime: 2 }], saved, io);
  assert.equal(calls.filter((path) => path === "a.heic").length, 2, "an edited file is tried again");
  attempt.clear();
  await prepareThumbnails([entry], saved, io);
  assert.equal(calls.filter((path) => path === "a.heic").length, 3, "and so is everything after the app returns");
  await assert.rejects(attempt("k", async () => { throw new Error("x"); }), /x/);
  await assert.rejects(attempt("k", async () => "never"), /^Error: Thumbnail unavailable$/);
});

test("photo thumbnails remember failures like video posters and forget them when the app returns", () => {
  const source = fs.readFileSync(new URL("../apps/mobile/src/gallery-thumbnails.js", import.meta.url), "utf8");
  assert.match(source, /const renderAttempt = rememberFailures\(4096, "Thumbnail unavailable"\);/);
  assert.match(source, /if \(state === "active"\) \{\s+posterAttempt\.clear\(\);\s+renderAttempt\.clear\(\);\s+\}/);
  assert.match(source, /return large\s+\? produce\(\)\s+: renderAttempt\(`\$\{entry\.uri\}:\$\{entry\.size\}:\$\{entry\.mtime\}`, produce\);/, "only grid thumbnails are remembered; the viewer's large preview is retried on each open");
});

test("the limiter runs three renders at a time, serves visible work before background work and survives failures", async () => {
  const limiter = createLimiter(3);
  let running = 0;
  let peak = 0;
  const order = [];
  const gates = [];
  const task = (name, fail = false) => () =>
    new Promise((resolve, reject) => {
      running++;
      peak = Math.max(peak, running);
      order.push(name);
      gates.push(() => {
        running--;
        if (fail) reject(new Error(name));
        else resolve(name);
      });
    });
  const background = ["b1", "b2", "b3", "b4"].map((name) => limiter.run(task(name), false));
  const visible = ["v1", "v2"].map((name) => limiter.run(task(name, name === "v1"), true));
  const settled = Promise.allSettled([...background, ...visible]);
  await new Promise(setImmediate);
  assert.deepEqual(order, ["b1", "b2", "b3"], "the first three start at once");
  while (gates.length) {
    gates.shift()();
    await new Promise(setImmediate);
  }
  const results = await settled;
  assert.equal(peak, 3);
  assert.deepEqual(order, ["b1", "b2", "b3", "v1", "v2", "b4"], "visible work jumps the background queue");
  assert.equal(results[4].status, "rejected", "a failing render rejects its caller");
  assert.equal(results[5].status, "fulfilled", "and frees its slot for the next");
  assert.equal(await limiter.run(async () => "after", false), "after");
});

test("preparation keeps the caller's order, reports each failure and counts done, failed and waiting", async () => {
  const entries = ["new.jpg", "mid.heic", "old.jpg"].map((path, index) => ({ path, uri: `file:///${path}`, size: 10, mtime: 3 - index }));
  const rendered = [];
  const failures = [];
  const io = {
    exists: async () => true,
    render: async (entry) => {
      rendered.push(entry.path);
      if (entry.path.endsWith(".heic")) throw new Error("Unsupported image");
      return `cache://${entry.path}`;
    },
  };
  const saved = await prepareThumbnails(entries, {}, io, () => true, () => {}, entries, 1, (entry, error) => failures.push([entry.path, error.message]));
  assert.deepEqual(rendered, ["new.jpg", "mid.heic", "old.jpg"], "newest first");
  assert.deepEqual(failures, [["mid.heic", "Unsupported image"]]);
  const candidates = entries.map((entry) => ({ ...entry, signature: `${entry.size}:${entry.mtime}` }));
  assert.deepEqual(previewProgress(candidates, saved, new Set(["mid.heic"])), { total: 3, done: 2, failed: 1, waiting: 0 });
  assert.deepEqual(previewProgress(candidates, { "new.jpg": saved["new.jpg"] }, new Set()), { total: 3, done: 1, failed: 0, waiting: 2 });
  assert.deepEqual(previewProgress(candidates, saved, new Set(["gone.jpg"])), { total: 3, done: 2, failed: 0, waiting: 1 }, "a failure for a file that left the folder is not counted");
  assert.deepEqual(previewProgress([], {}, new Set()), { total: 0, done: 0, failed: 0, waiting: 0 });
});

test("a render that never settles frees its slot after the limiter's timeout", async () => {
  const limiter = createLimiter(1, 20);
  const stuck = limiter.run(() => new Promise(() => {}), true);
  const next = limiter.run(async () => "after", false);
  await assert.rejects(stuck, /timed out/);
  assert.equal(await next, "after");
});

test("delta preparation reports only what changed, and null for a preview that could not be made", async () => {
  const entries = ["a.jpg", "b.heic"].map((path) => ({ path, uri: `file:///${path}`, size: 1, mtime: 1 }));
  const previous = { "b.heic": { signature: "stale", uri: "cache://old" } };
  const io = {
    exists: async () => true,
    render: async (entry) => {
      if (entry.path.endsWith(".heic")) throw new Error("Unsupported image");
      return `cache://${entry.path}`;
    },
  };
  const deltas = [];
  await prepareThumbnails(entries, previous, io, () => true, (delta) => deltas.push(delta), entries, 1, undefined, true);
  assert.deepEqual(deltas, [{ "a.jpg": { signature: "1:1", uri: "cache://a.jpg" } }, { "b.heic": null }]);
});

test("the saved map keeps only paths that still exist", () => {
  const saved = { "a.jpg": { signature: "1:1", uri: "x" }, "gone.jpg": { signature: "1:1", uri: "y" } };
  assert.deepEqual(pruneSaved(saved, new Set(["a.jpg"])), { "a.jpg": saved["a.jpg"] });
  assert.deepEqual(saved["gone.jpg"], { signature: "1:1", uri: "y" }, "the original map is untouched");
});

test("preview candidates are local media newest first, photos before videos, without excluded names and capped", () => {
  const entry = (path, mtime, extra = {}) => ({ path, uri: `file:///${path}`, size: 10, mtime, ...extra });
  const entries = [
    entry("old.jpg", Date.UTC(2020, 0, 1)),
    entry("clip.mp4", Date.UTC(2026, 5, 1)),
    entry("new.jpg", Date.UTC(2026, 8, 1)),
    entry(".DS_Store", Date.UTC(2026, 8, 2)),
    entry("notes.txt", Date.UTC(2026, 8, 3)),
    entry("folder", 0, { directory: true }),
    entry("mid.jpg", Date.UTC(2024, 0, 1)),
  ];
  const excluded = (path) => path === ".DS_Store";
  assert.deepEqual(previewCandidates(entries, excluded).map((item) => item.path), ["new.jpg", "mid.jpg", "old.jpg", "clip.mp4"]);
  const many = Array.from({ length: 6000 }, (_, i) => entry(`p${String(i).padStart(4, "0")}.jpg`, Date.UTC(2026, 0, 1) + i * 1000));
  const capped = previewCandidates(many, () => false);
  assert.equal(capped.length, 5000);
  assert.equal(capped[0].path, "p5999.jpg", "the cap keeps the newest");
});

test("the flusher keeps the earliest deadline, flushes on demand and can be cancelled", () => {
  let clock = 0;
  const timers = new Map();
  let next = 1;
  const schedule = (fn, delay) => {
    timers.set(next, { fn, due: clock + delay });
    return next++;
  };
  const cancel = (id) => timers.delete(id);
  const advance = (ms) => {
    clock += ms;
    for (const [id, timer] of [...timers]) {
      if (timer.due <= clock) {
        timers.delete(id);
        timer.fn();
      }
    }
  };
  let flushes = 0;
  const flusher = createFlusher(() => flushes++, schedule, cancel, () => clock);
  flusher.queue(2000);
  flusher.queue(2000);
  advance(1999);
  assert.equal(flushes, 0);
  advance(1);
  assert.equal(flushes, 1, "two queued flushes become one");
  flusher.queue(2000);
  advance(100);
  flusher.queue(250);
  advance(250);
  assert.equal(flushes, 2, "a sooner deadline replaces a pending slower one");
  assert.equal(timers.size, 0);
  flusher.queue(250);
  flusher.queue(2000);
  advance(250);
  assert.equal(flushes, 3, "a slower request never delays a pending faster one");
  flusher.queue(2000);
  assert.equal(flusher.pending, true);
  flusher.now();
  assert.equal(flushes, 4);
  assert.equal(flusher.pending, false);
  advance(5000);
  assert.equal(flushes, 4, "flushing on demand cancels the timer");
  flusher.queue(250);
  flusher.cancel();
  advance(5000);
  assert.equal(flushes, 4);
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const drain = async (queue) => {
  for (let i = 0; i < 200 && queue.pending; i++) await settle();
};

test("the background preview queue renders each photo once while the listing keeps growing", async () => {
  const rendered = [];
  const saved = {};
  const states = [];
  const queue = createPreviewQueue({
    io: {
      exists: async (uri) => Object.values(saved).some((entry) => entry.uri === uri),
      render: async (entry) => {
        rendered.push(entry.path);
        await settle();
        return `thumb://${entry.path}`;
      },
    },
    saved: () => saved,
    changed: (delta) => Object.assign(saved, delta),
    idle: (idle) => states.push(idle),
  });
  const photo = (n, signature = "s1") => ({ path: `IMG_${n}.jpg`, signature });
  const listing = [];
  queue.start();
  for (let n = 0; n < 40; n++) {
    listing.push(photo(n));
    queue.update([...listing]);
    await settle();
  }
  await drain(queue);
  assert.equal(rendered.length, 40, "a growing listing never restarts preparation");
  assert.equal(new Set(rendered).size, 40);
  assert.equal(states.at(-1), true, "the queue settles once every photo has a preview");
  const current = [...listing.slice(1), photo(0, "s2")];
  queue.update(current);
  await drain(queue);
  assert.deepEqual(rendered.slice(40), ["IMG_0.jpg"], "only a changed photo is prepared again");
  queue.update(current.slice(0, 10));
  queue.update(current);
  await drain(queue);
  assert.equal(rendered.length, 41, "a photo that briefly left the listing reuses its saved preview");
});

test("photos removed from the listing leave the queue and a stopped queue reports nothing", async () => {
  const rendered = [];
  const changes = [];
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const queue = createPreviewQueue({
    io: {
      exists: async () => false,
      render: async (entry) => {
        rendered.push(entry.path);
        await gate;
        return `thumb://${entry.path}`;
      },
    },
    saved: () => ({}),
    changed: (delta) => changes.push(delta),
    concurrency: 1,
  });
  queue.update(["a.jpg", "b.jpg", "c.jpg"].map((path) => ({ path, signature: "1" })));
  queue.start();
  queue.update([{ path: "a.jpg", signature: "1" }]);
  queue.stop();
  release();
  await settle();
  await settle();
  assert.deepEqual(rendered, ["a.jpg"]);
  assert.deepEqual(changes, []);
});

test("a failed background preview is reported once and retried only on request", async () => {
  let attempts = 0;
  const failed = [];
  const queue = createPreviewQueue({
    io: {
      exists: async () => false,
      render: async () => {
        attempts++;
        throw new Error("Thumbnail unavailable");
      },
    },
    saved: () => ({}),
    failed: (entry) => failed.push(entry.path),
  });
  const listing = [{ path: "a.heic", signature: "1" }];
  queue.start();
  queue.update(listing);
  await drain(queue);
  queue.update([...listing, { path: "b.mov", signature: "2" }]);
  await drain(queue);
  assert.equal(attempts, 2);
  assert.deepEqual(failed, ["a.heic", "b.mov"]);
  queue.retry();
  await drain(queue);
  assert.equal(attempts, 4);
});

test("the background pass renders on the phone only and never hashes originals or asks the hub", async () => {
  let hashed = 0;
  let asked = 0;
  const failures = [];
  const local = {
    exists: async () => false,
    render: async () => {
      throw new Error("Thumbnail unavailable");
    },
    poster: async () => {
      throw new Error("Video thumbnail unavailable");
    },
    hash: async () => hashed++,
    fromHub: async () => asked++,
  };
  const queue = createPreviewQueue({
    io: localPreviewIo(local),
    saved: () => ({}),
    failed: (entry) => failures.push(entry.path),
  });
  queue.start();
  queue.update([
    { path: "a.heic", signature: "1", kind: "image", uri: "file:///a.heic" },
    { path: "b.mov", signature: "2", kind: "video", uri: "file:///b.mov" },
  ]);
  await drain(queue);
  assert.deepEqual(failures, ["a.heic", "b.mov"]);
  assert.equal(hashed, 0);
  assert.equal(asked, 0);
  const gallery = fs.readFileSync(new URL("../apps/mobile/src/FolderGallery.jsx", import.meta.url), "utf8");
  assert.match(gallery, /backgroundIo = useMemo\(\(\) => localPreviewIo\(thumbnailFiles\), \[\]\)/, "the gallery's background pass uses the local-only renderer");
});

test("photos the hub holds that have not reached the phone are counted apart from previews", () => {
  const items = [
    { path: "a.jpg", hash: "h1", uri: "file:///a.jpg" },
    { path: "b.jpg", hash: "h2", uri: null },
    { path: "c.jpg", hash: "h3", uri: null },
    { path: "private/d.jpg", hash: "h4", uri: null },
    { path: "e.jpg", hash: null, uri: "file:///e.jpg", upload: "pending" },
  ];
  assert.equal(stillDownloading(items), 3);
  assert.equal(stillDownloading(items, (path) => path.startsWith("private/")), 2);
});
