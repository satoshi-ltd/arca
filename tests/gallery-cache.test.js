import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { IDBFactory } from "fake-indexeddb";
import { prepareThumbnails } from "../apps/mobile/src/thumbnail-cache.js";

const source = fs.readFileSync(
  new URL("../apps/desktop/src/app.js", import.meta.url),
  "utf8",
);
const cacheSource = source.slice(
  source.indexOf("let galleryDatabase;"),
  source.indexOf("// Content-addressed session cache"),
);
function cache(indexedDB) {
  return vm.runInNewContext(
    `${cacheSource}\n({storedGallery, galleryDisk, clearStoredGallery})`,
    { indexedDB },
  );
}
test("gallery disk cache survives a new renderer, isolates keys and bounds retained data", async () => {
  const indexedDB = new IDBFactory();
  const first = cache(indexedDB);
  await first.storedGallery("page:hub-a:photos", {
    items: [{ path: "one.jpg" }],
  });
  const next = cache(indexedDB);
  assert.equal(
    (await next.storedGallery("page:hub-a:photos")).items[0].path,
    "one.jpg",
  );
  assert.equal(await next.storedGallery("page:hub-b:photos"), null);
  await next.storedGallery("oversize", { data: "x".repeat(300001) });
  assert.equal(await next.storedGallery("oversize"), null);
  for (let i = 0; i < 130; i++)
    await next.storedGallery(`thumb:${i}`, { data: `image-${i}` });
  assert.equal(await next.storedGallery("page:hub-a:photos"), null);
  assert.equal((await next.storedGallery("thumb:129")).data, "image-129");
  next.clearStoredGallery();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await next.storedGallery("thumb:129"), null);
});
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
