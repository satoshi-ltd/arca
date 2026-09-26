import test from "node:test";
import assert from "node:assert/strict";
import {
  galleryDisplay,
  nativeGallerySources,
} from "../apps/mobile/src/gallery-display.js";

test("source phone displays its accepted native original; replicas prefer local HEIC previews", async () => {
  const photo = {
    path: "Camera/photo.heic",
    hash: "current",
    uri: "file:replica.heic",
  };
  const calls = [];
  const options = {
    large: true,
    localPreview: async () => {
      calls.push("local");
      return "file:local.jpg";
    },
    hubPreview: async () => {
      calls.push("hub");
      return "file:cached-hub.jpg";
    },
  };
  assert.equal(
    await galleryDisplay(photo, {
      ...options,
      nativeSource: async () => "content:native",
    }),
    "content:native",
  );
  assert.deepEqual(calls, []);
  assert.equal(await galleryDisplay(photo, options), "file:local.jpg");
  assert.deepEqual(calls, ["local"]);
  assert.equal(
    await galleryDisplay(photo, {
      ...options,
      nativeSource: async () => "content:native",
      fallback: true,
    }),
    "file:cached-hub.jpg",
  );
  assert.equal(
    await galleryDisplay(
      { path: "upload:1", uri: "content:pending", upload: "pending" },
      options,
    ),
    "content:pending",
  );
});

test("native resolution uses scoped receipts, deduplicates reads and rejects changed or missing originals", async () => {
  let reads = 0;
  const store = {
    galleryNativeAsset: async (...args) => {
      reads++;
      assert.deepEqual(args, ["scope", "volume", "a.heic", "hash"]);
      return { id: "native-id", modificationTime: 10 };
    },
  };
  const item = { path: "a.heic", hash: "hash" };
  const resolver = (preview) =>
    nativeGallerySources({
      store,
      media: { preview },
      scope: "scope",
      volume: "volume",
    });
  const source = resolver(async () => ({
    uri: "content:photo",
    modificationTime: 10,
  }));
  assert.deepEqual(await Promise.all([source(item), source(item)]), [
    "content:photo",
    "content:photo",
  ]);
  assert.equal(reads, 1);
  assert.equal(
    await resolver(async () => ({
      uri: "content:edited",
      modificationTime: 11,
    }))(item),
    null,
  );
  assert.equal(
    await resolver(async () => {
      throw new Error("Permission revoked");
    })(item),
    null,
  );
  const foreign = nativeGallerySources({
    store: { galleryNativeAsset: async () => null },
    media: {
      preview: () => assert.fail("Foreign photo must not access Photos"),
    },
    scope: "s",
    volume: "v",
  });
  assert.equal(await foreign(item), null);
});

test("thumbnail failures use hub cache; offline errors do not change originals", async () => {
  const item = { path: "a.heic", hash: "h" };
  const before = { ...item };
  const options = {
    nativeSource: async () => "content:original",
    localPreview: async () => {
      throw new Error("No native decoder");
    },
    hubPreview: async () => "file:cached.jpg",
  };
  assert.equal(await galleryDisplay(item, options), "file:cached.jpg");
  await assert.rejects(
    galleryDisplay(item, {
      ...options,
      nativeSource: undefined,
      hubPreview: async () => {
        throw new TypeError("Network request failed");
      },
    }),
    /Network request failed/,
  );
  assert.deepEqual(item, before);
});
