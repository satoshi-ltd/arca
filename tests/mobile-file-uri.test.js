import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const source = fs
  .readFileSync(new URL("../apps/mobile/src/files.js", import.meta.url), "utf8")
  .replace(/^import .*;\r?$/gm, "")
  .replace("export const files", "const files");
const expoSegment = (segment) =>
  segment.replace(/%/g, "%25").replace(/\\/g, "%5C").replace(/ /g, "%20").replace(/\?/g, "%3F").replace(/#/g, "%23");
const made = [];
const files = vm.runInNewContext(source + "\nfiles;", {
  Directory: class {
    constructor(...parts) {
      this.uri = parts.map((part) => part.uri || part).join("/") + "/";
    }
  },
  File: class {
    constructor(uri) {
      this.uri = uri;
      made.push(uri);
      this.exists = false;
    }
    async copy(target) {
      throw Object.assign(new Error("stop"), { staged: target.uri });
    }
  },
  native: {},
  Paths: {
    document: { uri: "file:///data/user/0/com.satoshilimited.arca/files" },
    join(first, ...rest) {
      const url = new URL(first);
      url.pathname = path.posix.join(url.pathname, ...rest.map(expoSegment));
      return url.toString();
    },
    dirname(uri) {
      const url = new URL(uri);
      url.pathname = path.posix.dirname(decodeURIComponent(url.pathname)).split("/").map(expoSegment).join("/");
      return url.toString();
    },
  },
  validPath: (value) => value,
  DOWNLOAD_NAME: /^$/,
  setTimeout,
});
const javaLegal = /^file:\/\/[A-Za-z0-9\-._~:/@!$&'()*+,;=%]*$/;

test("a working file whose name has brackets, pipes or carets gets a URI Android accepts and decodes to the same name", () => {
  const scope = "e21c3851-2366-43d4-a9ba-db410dea31d7";
  const volume = "b63dfe48-8d9a-4fd5-a12f-0bc02846cae2";
  for (const name of [
    "Rise Against/Long Forgotten Songs (2013)/06 Everchanging [Acoustic].mp3",
    "Live | Unplugged/^intro {take 2}.mp3",
    "Café #1/100% & more; a=b, c+d@e$.flac",
  ]) {
    const uri = files.work(scope, volume, name);
    const tail = new URL(uri).pathname.split(`/folders/${volume}/`)[1];
    assert.match(uri, javaLegal, uri);
    assert.equal(decodeURIComponent(tail), name);
  }
});

test("a working file name that already worked keeps the same URI, so its cached hash is still found", () => {
  const uri = files.work("s", "v", "Rise Against/06 Everchanging (Acoustic).mp3");
  assert.equal(uri, "file:///data/user/0/com.satoshilimited.arca/files/arca/s/folders/v/Rise%20Against/06%20Everchanging%20(Acoustic).mp3");
});

test("the parent folder and the staging copy beside a bracketed file stay URIs Android accepts", () => {
  const uri = files.work("s", "v", "Live [2019]/01 Intro.mp3");
  for (const derived of [files.parent(uri), files.staged(uri)]) {
    assert.match(derived, javaLegal, derived);
    assert.ok(decodeURIComponent(derived).includes("/Live [2019]"));
  }
});

test("a child of a listed folder and the staging file of a copy into a bracketed folder are URIs Android accepts", async () => {
  const folder = files.parent(files.work("s", "v", "Live [2019]/01 Intro.mp3"));
  const child = files.child(folder, "._01 Intro [demo].mp3");
  assert.match(child, javaLegal, child);
  assert.ok(decodeURIComponent(child).endsWith("/Live [2019]/._01 Intro [demo].mp3"));
  made.length = 0;
  await assert.rejects(files.copy("file:///source.mp3", files.work("s", "v", "Live [2019]/01 Intro.mp3")), /stop/);
  const staged = made.find((uri) => uri.includes(".arca-copy-"));
  assert.match(staged, javaLegal, staged);
});
