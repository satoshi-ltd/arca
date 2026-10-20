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
    { indexedDB, galleryEpoch: 0 },
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
  await next.clearStoredGallery(true);
  assert.equal(await next.storedGallery("thumb:129"), null);
});

test("gallery erase waits for transactions and rejects unavailable persistent storage", async () => {
  const broken = {
    open() {
      throw new Error("storage unavailable");
    },
  };
  await assert.rejects(
    cache(broken).clearStoredGallery(true),
    /storage unavailable/,
  );
  await cache(broken).clearStoredGallery();
});

for (const kind of ["page", "thumbnail"]) {
  test(`erase invalidates a pending ${kind} read`, async () => {
    let release;
    const context = vm.createContext({
      galleryEpoch: 0,
      status: { id: "old-device" },
      galleryPages: new Map(),
      photoRequests: new Map(),
      photoCaches: { thumb: { entries: new Map(), bytes: 0 } },
      URLSearchParams,
      storedGallery: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
      api: () => {
        throw new Error("Unexpected request after invalidation");
      },
      visibleGalleryPage: (_route, data) => data,
    });
    const methods = source.slice(
      source.indexOf("async function galleryPage("),
      source.indexOf("function dropCachedPhoto("),
    );
    const reader = vm.runInContext(
      `${methods}\n${kind === "page" ? "galleryPage" : "cachedPhoto"}`,
      context,
    );
    const pending = reader("/gallery/preview?size=thumb");
    context.galleryEpoch++;
    release(
      kind === "page"
        ? { data: { items: [{ path: "private.jpg" }] } }
        : { data: "private image" },
    );
    if (kind === "page") await assert.rejects(pending, /Gallery view changed/);
    else assert.equal((await pending).data, undefined);
  });
}

for (const kind of ["page", "thumbnail"]) {
  test(`erase discards a late ${kind} API response`, async () => {
    let release;
    const context = vm.createContext({
      galleryEpoch: 0,
      status: { id: "old-device" },
      galleryPages: new Map(),
      photoRequests: new Map(),
      photoCaches: { thumb: { entries: new Map(), bytes: 0 } },
      URLSearchParams,
      storedGallery: async () => null,
      api: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
      visibleGalleryPage: (_route, data) => data,
    });
    const methods = source.slice(
      source.indexOf("async function galleryPage("),
      source.indexOf("function dropCachedPhoto("),
    );
    const reader = vm.runInContext(
      `${methods}\n${kind === "page" ? "galleryPage" : "cachedPhoto"}`,
      context,
    );
    const pending = reader("/gallery/preview?size=thumb");
    await new Promise((resolve) => setImmediate(resolve));
    context.galleryEpoch++;
    context.photoRequests.clear();
    release(
      kind === "page"
        ? { items: [{ path: "private.jpg" }] }
        : { data: "private image" },
    );
    if (kind === "page") await assert.rejects(pending, /Gallery view changed/);
    else assert.equal((await pending).data, undefined);
    assert.equal(context.galleryPages.size, 0);
    assert.equal(context.photoCaches.thumb.entries.size, 0);
  });
}

test("boot retries interrupted interface erasure before reading device state", async () => {
  let release,
    reads = 0;
  const context = vm.createContext({
    native: false,
    localStorage: { getItem: () => "true" },
    eraseInterfaceData: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
    refresh: async () => {
      reads++;
    },
  });
  const boot = vm.runInContext(
    `${source.slice(source.indexOf("async function boot()"), source.indexOf("const DAEMON_GRACE_MS"))}\nboot`,
    context,
  );
  const pending = boot();
  assert.equal(reads, 0);
  assert.equal(typeof release, "function");
  release();
  await pending;
  assert.equal(reads, 1);
});

test("erase retries opening gallery storage after a transient failure", async () => {
  const factory = new IDBFactory();
  let attempts = 0;
  const disk = cache({
    open(...args) {
      if (attempts++ === 0) throw new Error("storage temporarily unavailable");
      return factory.open(...args);
    },
  });
  await assert.rejects(disk.clearStoredGallery(true), /storage temporarily unavailable/);
  await disk.clearStoredGallery(true);
  assert.equal(attempts, 2);
});
