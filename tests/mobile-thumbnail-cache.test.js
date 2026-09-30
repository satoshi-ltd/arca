import test from "node:test";
import assert from "node:assert/strict";
import { prepareThumbnails } from "../apps/mobile/src/thumbnail-cache.js";

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
