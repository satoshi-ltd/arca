import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { IDBFactory } from "fake-indexeddb";

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
