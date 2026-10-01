import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { mergeTimeline, timelineItem } from "../apps/mobile/src/gallery-timeline.js";
import { prepareThumbnails, savedThumbnail } from "../apps/mobile/src/thumbnail-cache.js";

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
