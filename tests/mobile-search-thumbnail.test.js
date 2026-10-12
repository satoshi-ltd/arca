import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { canonicalFileUri, searchIo, searchPreview, searchThumbnail } from "../apps/mobile/src/search-thumbnail.js";

const read = (file) => fs.readFileSync(new URL(`../apps/mobile/src/${file}`, import.meta.url), "utf8");
const photo = { volume: "v", path: "Camera/big.heic", kind: "image", size: 9, hash: "h" };
const deps = (extra = {}) => {
  const calls = [];
  return {
    calls,
    uri: (item) => `file:///work/${item.path}`,
    stat: async () => ({ size: 10, mtime: 5 }),
    render: async (entry, size) => {
      calls.push(["render", entry.uri, size, entry.mtime]);
      return `file:///cache/${size}.jpg`;
    },
    poster: async (entry) => {
      calls.push(["poster", entry.uri]);
      return "file:///cache/poster.jpg";
    },
    ...extra,
  };
};

test("search photo tiles render the thumb variant and never hand the original to Image", async () => {
  const d = deps();
  assert.equal(await searchThumbnail(photo, d), "file:///cache/thumb.jpg");
  assert.deepEqual(d.calls, [["render", "file:///work/Camera/big.heic", "thumb", 5]]);
});

test("search video tiles use the poster path", async () => {
  const d = deps();
  assert.equal(await searchThumbnail({ ...photo, path: "a.mp4", kind: "video" }, d), "file:///cache/poster.jpg");
  assert.deepEqual(d.calls.map((call) => call[0]), ["poster"]);
});

test("a photo not on this phone or not renderable gives no thumbnail", async () => {
  assert.equal(await searchThumbnail(photo, deps({ uri: () => null })), null);
  assert.equal(await searchThumbnail(photo, deps({ stat: async () => null })), null);
  await assert.rejects(searchThumbnail(photo, deps({ render: async () => { throw new Error("no"); } })));
});

test("the search pane previews a large derivative, even for a jpeg, and falls back to the original only when it can be decoded", async () => {
  const d = deps();
  assert.equal(await searchPreview({ ...photo, path: "a.jpg" }, d), "file:///cache/large.jpg");
  const failing = deps({ render: async () => { throw new Error("no"); } });
  assert.equal(await searchPreview({ ...photo, path: "a.jpg" }, failing), "file:///work/a.jpg");
  assert.equal(await searchPreview(photo, failing), null);
  assert.equal(await searchPreview({ ...photo, kind: "video", path: "a.mp4" }, d), null);
});

test("global search wires photo cells through the thumbnail pipeline, not the work path", () => {
  const search = read("GlobalSearch.jsx");
  assert.doesNotMatch(search, /const source = uri\(item\)/);
  assert.match(search, /<SearchThumb item=\{item\} thumbnail=\{thumbnail\} \/>/);
  assert.match(search, /<PanePreview item=\{shown\} preview=\{preview\}/);
  const app = read("App.jsx");
  assert.match(app, /thumbnail=\{\(r\) => searchThumbnail\(r, searchPhotoDeps\(\)\)\}/);
  assert.match(app, /\.\.\.searchIo\(thumbnailFiles\)/);
});

const folder = "file:///data/user/0/app/files/arca/s1/folders/v1/";
const androidUri = (directory, relative) =>
  directory +
  relative
    .split("/")
    .map((segment) =>
      [...Buffer.from(segment)]
        .map((byte) => {
          const char = String.fromCharCode(byte);
          return /[A-Za-z0-9_\-!.~'()*]/.test(char) ? char : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
        })
        .join(""),
    )
    .join("/");
const strictUri = /^file:\/\/\/(?:[A-Za-z0-9._~!'()*\/-]|%[0-9A-F]{2})*$/;

test("search builds the canonical file URI the wall's directory listing yields, for awkward names", async () => {
  const names = ["IMG 1.heic", "a\u00f1o/mar.jpg", "a#b.jpg", "100%.jpg", "what?.jpg", "x[1]+&=,;@$|^.jpg", "caf\u00e9 \u65e5\u672c/p q.jpg"];
  for (const name of names) {
    const uri = canonicalFileUri(folder, name);
    assert.equal(uri, androidUri(folder, name), name);
    assert.match(uri, strictUri, name);
    assert.equal(decodeURIComponent(new URL(uri).pathname), new URL(folder).pathname + name, name);
    const d = deps({ uri: (item) => canonicalFileUri(folder, item.path) });
    await searchThumbnail({ ...photo, path: name }, d);
    assert.equal(d.calls[0][1], androidUri(folder, name));
    assert.match(d.calls[0][1], strictUri);
  }
  assert.equal(canonicalFileUri(folder.slice(0, -1), "a b.jpg"), `${folder}a%20b.jpg`);
});

test("search renders run in the background so they never starve the wall's urgent renders", async () => {
  const seen = [];
  const io = searchIo({
    render: async (entry, size, background) => (seen.push(["render", size, background]), "r"),
    poster: async (entry, background) => (seen.push(["poster", background]), "p"),
  });
  await io.render({}, "thumb");
  await io.render({}, "large");
  await io.poster({});
  assert.deepEqual(seen, [["render", "thumb", true], ["render", "large", true], ["poster", true]]);
});

test("the preview keeps the original file name as its accessibility label", () => {
  assert.match(read("FilePreview.jsx"), /accessibilityLabel=\{label \|\| entry\.path\.split\("\/"\)\.pop\(\)\}/);
  assert.match(read("GlobalSearch.jsx"), /label=\{item\.path\.split\("\/"\)\.pop\(\)\}/);
  assert.doesNotMatch(read("GlobalSearch.jsx"), /replace\(\/\\\.\[\^\.\/\]\+\$\//);
  assert.match(read("App.jsx"), /canonicalFileUri\(e\.files\.folder\(e\.scope, r\.volume\), r\.path\)/);
});
