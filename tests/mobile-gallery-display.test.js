import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  galleryDisplay,
  nativeGallerySources,
} from "../apps/mobile/src/gallery-display.js";

test("replicas show only files on this phone, falling back to a local derivative, never the hub", async () => {
  const photo = {
    path: "Camera/photo.heic",
    hash: "current",
    uri: "file:replica.heic",
  };
  const calls = [];
  const options = {
    large: true,
    localPreview: async (item, large) => {
      calls.push(`${item.uri}:${large ? "large" : "thumb"}`);
      return "file:local.jpg";
    },
  };
  assert.equal(
    await galleryDisplay(photo, {
      ...options,
      nativeSource: async () => "content:native",
    }),
    "file:local.jpg",
  );
  assert.deepEqual(calls, ["file:replica.heic:large"]);
  const jpeg = { path: "Camera/photo.jpg", hash: "h", uri: "file:photo.jpg" };
  assert.equal(await galleryDisplay(jpeg, options), "file:photo.jpg");
  assert.equal(
    await galleryDisplay(jpeg, { ...options, fallback: true }),
    "file:local.jpg",
    "a file the viewer cannot show is decoded locally",
  );
  assert.equal(
    await galleryDisplay(
      { path: "upload:1", uri: "content:pending", upload: "pending" },
      options,
    ),
    "content:pending",
  );
  await assert.rejects(
    galleryDisplay({ path: "hub-only.jpg", hash: "h" }, options),
    /not on this phone yet/,
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

test("a failing local decode falls back to this phone's library asset, then reports the local error", async () => {
  const item = { path: "a.heic", hash: "h", uri: "file:a.heic" };
  const before = { ...item };
  const decoded = [];
  const options = {
    nativeSource: async () => "content:original",
    localPreview: async (entry) => {
      decoded.push(entry.uri);
      if (entry.uri === "file:a.heic") throw new Error("No native decoder");
      return "file:from-library.jpg";
    },
  };
  assert.equal(await galleryDisplay(item, options), "file:from-library.jpg");
  assert.deepEqual(decoded, ["file:a.heic", "content:original"]);
  await assert.rejects(
    galleryDisplay(item, { ...options, nativeSource: undefined }),
    /No native decoder/,
  );
  assert.deepEqual(item, before);
});

test("a downloaded image opens offline without consulting the native library or hub", async () => {
  const unavailable = async () => {
    throw new Error("offline");
  };
  assert.equal(
    await galleryDisplay(
      {
        path: "other-phone.jpg",
        hash: "hash",
        uri: "file:///arca/other-phone.jpg",
      },
      {
        large: true,
        nativeSource: unavailable,
        localPreview: unavailable,
        hubPreview: unavailable,
      },
    ),
    "file:///arca/other-phone.jpg",
  );
});

test("the pending uploads header carries one Dismiss action for photos whose app copy is gone", () => {
  const read = (file) =>
    fs.readFileSync(new URL(`../apps/mobile/src/${file}`, import.meta.url), "utf8");
  const gallery = read("FolderGallery.jsx");
  assert.match(
    gallery,
    /<Text style=\{s\.caption\}>\s+\{pendingUploadLabel\(pendingItems, uploads\?\.summary\)\}\s+<\/Text>\s+\{!!uploads\?\.dismissLost && !!lostCount && \(\s+<Pressable[\s\S]{0,260}onPress=\{uploads\.dismissLost\}[\s\S]{0,220}Dismiss \{lostCount\}/,
    "the action sits in the section header, after the progress label",
  );
  assert.doesNotMatch(gallery, /label="Dismiss unavailable photos"/, "the full-width button is gone");
  assert.match(gallery, /no longer on this phone/);
  assert.match(gallery, /hitSlop=\{\{ top: 11, bottom: 11, left: 8, right: 8 \}\}/, "the link keeps a 44 dp target");
  assert.match(gallery, /item\.upload && item\.upload !== "lost" \? item\.uri : null/, "a lost tile never loads its missing file");
  assert.match(read("PhotoViewer.jsx"), /lost: "No longer on this phone"/, "the viewer names a lost photo instead of calling it Uploading");
  assert.match(gallery, /item\.upload !== "lost"/, "a lost tile shows the placeholder, not an alert badge");
  assert.match(
    read("App.jsx"),
    /dismissLost: \(\) =>\s+run\(\(\) => engine\.current\.gallery\.dismissLost\(folder\.id\)\)/,
  );
});

test("a failed Add photos whose picks are journaled retries by syncing, not by reopening the picker", () => {
  const app = fs.readFileSync(new URL("../apps/mobile/src/App.jsx", import.meta.url), "utf8");
  assert.match(
    app,
    /retryAction\.current = e\.journaled\s+\? \(\) => \{\s+if \(engine\.current\?\.paused\) return;\s+setError\(""\);\s+startSync\(\);\s+\}\s+: \(\) => run\(work, options\);/,
  );
});
