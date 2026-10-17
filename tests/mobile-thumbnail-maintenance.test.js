import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { cacheEvictions, cacheName, createLimiter, PREVIEW_VARIANTS } from "../apps/mobile/src/thumbnail-cache.js";

function cacheHarness(limiter = { run: (task) => task() }) {
  const disk = new Map();
  const timers = [];
  let lists = 0, metadata = 0;
  class File {
    constructor(parent, name) {
      this.uri = name ? `${parent.uri}/${name}` : parent;
      this.name = this.uri.split("/").at(-1);
    }
    get exists() { return disk.has(this.uri); }
    get size() { metadata++; return disk.get(this.uri)?.size || 0; }
    get modificationTime() { metadata++; return disk.get(this.uri)?.mtime || 0; }
    delete() { disk.delete(this.uri); }
    copy(target) { disk.set(target.uri, { ...disk.get(this.uri) }); }
  }
  class Directory {
    constructor(uri) { this.uri = uri; }
    create() {}
    list() {
      lists++;
      return [...disk.keys()].filter((uri) => uri.startsWith(`${this.uri}/`)).map((uri) => new File(uri));
    }
  }
  const root = new Directory("file:///cache");
  const context = vm.createContext({
    root, File, Directory, jobs: new Map(),
    limiter, cacheName, cacheEvictions,
    TextEncoder, sha256: (bytes) => bytes, bytesToHex: (bytes) => Buffer.from(bytes).toString("hex"),
    setTimeout: (task) => { timers.push(task); return timers.length; },
  });
  const source = fs.readFileSync(new URL("../apps/mobile/src/gallery-thumbnails.js", import.meta.url), "utf8");
  vm.runInContext(source.slice(source.indexOf("let rendered = 0;"), source.indexOf("export const thumbnailFiles")) + "\nthis.render = cachedDerivative;", context);
  return {
    disk, timers, render: context.render,
    counts: () => ({ lists, metadata }),
    async drain(turn = () => {}) {
      let turns = 0;
      while (timers.length || vm.runInContext("typeof pruning !== 'undefined' && pruning", context)) {
        assert.ok(turns++ < 5000, "maintenance eventually finishes");
        turn();
        timers.shift()?.();
        await new Promise(setImmediate);
      }
    },
  };
}

test("the first new thumbnail returns before a large cache is scanned and maintenance yields between metadata batches", async () => {
  const cache = cacheHarness();
  for (let index = 0; index < 20000; index++)
    cache.disk.set(`file:///cache/${index}.jpg`, { size: 32768, mtime: index + 1 });
  cache.disk.set("file:///original.jpg", { size: 1000, mtime: 1 });
  const uri = await cache.render({ uri: "file:///original.jpg", size: 1000, mtime: 1 }, "thumb", (target) => {
    cache.disk.set(target.uri, { size: 100, mtime: Date.now() });
    return null;
  });
  assert.equal(cache.counts().lists, 0, "delivering a visible thumbnail does not enumerate the cache");
  assert.equal(cache.counts().metadata, 0);
  assert.ok(cache.disk.has(uri));
  for (let index = 0; index < 205; index++)
    await cache.render({ uri: `file:///new-${index}.jpg`, size: 1, mtime: 1 }, "thumb", (target) => {
      cache.disk.set(target.uri, { size: 100, mtime: Date.now() });
      return null;
    });
  assert.equal(cache.timers.length, 1, "a burst crossing two maintenance intervals schedules only one pass");
  cache.timers.shift()();
  assert.equal(cache.counts().lists, 1);
  assert.ok(cache.counts().metadata <= 64, "the first maintenance turn reads at most 32 entries");
  await cache.drain();
  assert.equal(cache.counts().lists, 1, "one coalesced pass handles the cache");
  assert.ok(cache.counts().metadata <= 80824, "metadata reads stay linear, including rechecks before deletion");
  assert.ok(cache.disk.has(uri), "the thumbnail just delivered is retained");
  const total = [...cache.disk].filter(([key]) => key.startsWith("file:///cache/")).reduce((sum, [, row]) => sum + row.size, 0);
  assert.ok(total <= PREVIEW_VARIANTS.thumb.budget);
  assert.ok(cache.disk.has("file:///original.jpg"), "maintenance touches derivatives only");
});

test("a derivative replaced while maintenance yields is not evicted using its old metadata", async () => {
  const cache = cacheHarness();
  for (let index = 0; index < 600; index++)
    cache.disk.set(`file:///cache/old-${index}.jpg`, { size: 1024 ** 2, mtime: index + 1 });
  await cache.render({ uri: "file:///new.jpg", size: 1, mtime: 1 }, "thumb", (target) => {
    cache.disk.set(target.uri, { size: 100, mtime: Date.now() });
    return null;
  });
  let replaced = false;
  await cache.drain(() => {
    if (!replaced && cache.counts().metadata >= 1202) {
      replaced = true;
      cache.disk.set("file:///cache/old-0.jpg", { size: 1024 ** 2, mtime: Date.now() });
    }
  });
  assert.ok(replaced, "the old metadata was read before the replacement");
  assert.ok(cache.disk.has("file:///cache/old-0.jpg"), "a newly completed derivative is retained");
});

test("cache maintenance protects outputs and partial files after the renderer's caller times out", async () => {
  const cache = cacheHarness(createLimiter(1, 5));
  for (let index = 0; index < 600; index++)
    cache.disk.set(`file:///cache/old-${index}.jpg`, { size: 1024 ** 2, mtime: index + 1 });
  let release, activeUri;
  const gate = new Promise((resolve) => { release = resolve; });
  const active = cache.render({ uri: "file:///active.jpg", size: 1, mtime: 1 }, "thumb", async (target) => {
    activeUri = target.uri;
    cache.disk.set(activeUri, { size: 1024 ** 2, mtime: 0 });
    cache.disk.set(`${activeUri}.part`, { size: 10, mtime: 1 });
    await gate;
    return null;
  });
  try {
    await assert.rejects(active, /Render timed out/);
    cache.disk.set("file:///cache/abandoned.part", { size: 10, mtime: 1 });
    await cache.render({ uri: "file:///ready.jpg", size: 1, mtime: 1 }, "thumb", (target) => {
      cache.disk.set(target.uri, { size: 100, mtime: Date.now() });
      return null;
    }, false, true);
    await cache.drain();
    assert.ok(cache.disk.has(activeUri), "an old active output is not evicted");
    assert.ok(cache.disk.has(`${activeUri}.part`), "a slow active renderer keeps its partial file");
    assert.equal(cache.disk.has("file:///cache/abandoned.part"), false);
  } finally {
    release();
    await new Promise(setImmediate);
    await cache.drain();
  }
});

test("a burst arriving during maintenance triggers one follow-up pass", async () => {
  const cache = cacheHarness();
  for (let index = 0; index < 600; index++)
    cache.disk.set(`file:///cache/old-${index}.jpg`, { size: 1024 ** 2, mtime: index + 1 });
  await cache.render({ uri: "file:///first.jpg", size: 1, mtime: 1 }, "thumb", (target) => {
    cache.disk.set(target.uri, { size: 100, mtime: Date.now() });
    return null;
  });
  let burst;
  await cache.drain(() => {
    if (burst || !cache.counts().lists) return;
    burst = Promise.all(Array.from({ length: 205 }, (_, index) =>
      cache.render({ uri: `file:///burst-${index}.jpg`, size: 1, mtime: 1 }, "thumb", (target) => {
        cache.disk.set(target.uri, { size: 1024 ** 2, mtime: Date.now() });
        return null;
      }),
    ));
  });
  await burst;
  assert.equal(cache.counts().lists, 2, "a request during the pass is not lost or multiplied per thumbnail");
  const total = [...cache.disk.values()].reduce((sum, row) => sum + row.size, 0);
  assert.ok(total <= PREVIEW_VARIANTS.thumb.budget, "the follow-up pass includes the burst's new derivatives");
});

test("a retry after timeout reuses the completed output and temporary files are cleaned", async () => {
  for (const temporary of [false, true]) {
    const cache = cacheHarness(createLimiter(1, 10));
    const entry = { uri: "file:///slow.jpg", size: 1, mtime: 1 };
    cache.disk.set(entry.uri, { size: 1, mtime: 1 });
    let release, renders = 0;
    const gate = new Promise((resolve) => { release = resolve; });
    const produce = async (target) => {
      renders++;
      await gate;
      cache.disk.set(temporary ? "file:///temporary.jpg" : target.uri, { size: 100, mtime: 1 });
      return temporary ? "file:///temporary.jpg" : null;
    };
    const first = cache.render(entry, "thumb", produce);
    try {
      await assert.rejects(first, /Render timed out/);
      const retry = cache.render(entry, "thumb", produce);
      release();
      const uri = await retry;
      assert.equal(renders, 1, "a queued retry rechecks the completed derivative");
      assert.ok(cache.disk.has(uri));
      assert.equal(cache.disk.has("file:///temporary.jpg"), false);
      await cache.drain();
    } finally { release(); }
  }
});
