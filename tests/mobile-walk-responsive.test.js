import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
test("mobile directory scans yield to UI timers while preserving all entries", async () => {
  const source = fs
    .readFileSync(
      new URL("../apps/mobile/src/files.js", import.meta.url),
      "utf8",
    )
    .replace(/^import .*;\r?$/gm, "")
    .replace("export const files", "const files");
  class Directory {
    constructor(uri) {
      this.uri = uri;
    }
    list() {
      return Array.from({ length: 100 }, (_, i) => ({
        name: `file-${i}.txt`,
        uri: `root/file-${i}.txt`,
        size: i,
        modificationTime: 1,
      }));
    }
  }
  let turns = 0;
  const files = vm.runInNewContext(source + "\nfiles;", {
    Directory,
    Paths: { document: "root" },
    setTimeout(fn, ms) {
      return setTimeout(() => {
        turns++;
        fn();
      }, ms);
    },
  });
  const entries = [];
  for await (const entry of files.walk("root")) entries.push(entry);
  assert.equal(entries.length, 100);
  assert.equal(new Set(entries.map((e) => e.path)).size, 100);
  assert.ok(turns >= 4, "Directory entry and each batch give timers a turn");
  assert.equal(entries[99].size, 99);
});
