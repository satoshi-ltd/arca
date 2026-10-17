import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { EventEmitter } from "node:events";

async function probe(deliver) {
  const watchers = new Map();
  const opened = [];
  const io = {
    mkdtempSync: () => path.join("temporary", "probe"),
    mkdirSync() {}, rmSync() {},
    watch(folder) {
      const watcher = new EventEmitter();
      watcher.generation = Math.floor(opened.length / 2);
      watcher.closed = false;
      watcher.close = () => { watcher.closed = true; };
      watchers.set(folder, watcher);
      opened.push(watcher);
      return watcher;
    },
    writeFileSync(file) {
      const watcher = watchers.get(path.dirname(file));
      queueMicrotask(() => {
        if (deliver(watcher.generation, path.basename(file)))
          watcher.emit("change", "change", path.basename(file));
      });
    },
  };
  const timers = new Map();
  let clock = 0, nextTimer = 0;
  const context = vm.createContext({ fs: io, path, process: { platform: process.platform }, os: { tmpdir: () => "temporary" },
    setTimeout: (callback, delay) => {
      const id = ++nextTimer;
      timers.set(id, { callback, at: clock + delay });
      return id;
    }, clearTimeout: (id) => timers.delete(id) });
  const source = fs.readFileSync(new URL("./watch-support.js", import.meta.url), "utf8");
  vm.runInContext(source.replace(/^import .*;\n/gm, "").replaceAll("export async function", "async function") + "\nthis.probe = canWatchDirectory;", context);
  let result;
  const pending = context.probe(2).then((value) => { result = value; });
  for (let turn = 0; result === undefined && turn < 100; turn++) {
    await new Promise(setImmediate);
    if (result !== undefined) break;
    const [id, timer] = [...timers].sort((a, b) => a[1].at - b[1].at)[0] || [];
    assert.ok(timer, "an unfinished probe has a deadline or next pulse");
    timers.delete(id);
    clock = timer.at;
    timer.callback();
  }
  assert.notEqual(result, undefined, "the probe settles");
  await pending;
  assert.equal(timers.size, 0, "no probe timers remain");
  assert.ok(opened.every((watcher) => watcher.closed), "every probe watcher is closed");
  return { result, opened: opened.length };
}

test("watcher capability requires delivery beyond the initial event", async () => {
  assert.equal((await probe((generation, name) => !name.includes("1"))).result, false);
});

test("watcher capability also checks delivery after closing and reopening streams", async () => {
  assert.equal((await probe((generation) => generation === 0)).result, false);
});

test("healthy watcher streams deliver both pulses in every generation", async () => {
  assert.deepEqual(await probe(() => true), { result: true, opened: 6 });
});

for (const observed of [false, true])
  test(`a native-event failure is classified using an independent observer, observed=${observed}`, async (t) => {
    const { withWatchEvent } = await import("./watch-support.js");
    const watcher = new EventEmitter();
    let closed = false;
    watcher.close = () => { closed = true; };
    t.mock.method(fs, "watch", (_directory, _options, callback) => {
      watcher.on("change", callback);
      return watcher;
    });
    const skips = [];
    const failure = new assert.AssertionError({ message: "Arca did not process the event" });
    const run = () => withWatchEvent({ skip: (reason) => skips.push(reason) }, "folder", "file.txt", async () => {
      watcher.emit("change", "change", observed ? "file.txt" : "unrelated.txt");
    }, async () => {
      throw failure;
    });
    if (observed) {
      await assert.rejects(run(), (error) => error === failure);
      assert.equal(skips.length, 0, "an Arca failure remains a failure when native events arrived");
    } else {
      assert.equal(await run(), false);
      assert.equal(skips.length, 1, "missing native delivery is reported as unavailable");
    }
    assert.equal(closed, true);
  });

test("the independent native observer closes after a successful assertion", async (t) => {
  const { withWatchEvent } = await import("./watch-support.js");
  const watcher = new EventEmitter();
  let closed = false;
  watcher.close = () => { closed = true; };
  t.mock.method(fs, "watch", (_directory, _options, callback) => {
    watcher.on("change", callback);
    return watcher;
  });
  assert.equal(await withWatchEvent({ skip: () => assert.fail("must not skip") }, "folder", "file.txt", async () => {
    watcher.emit("change", "change", "file.txt");
  }, async () => {}), true);
  assert.equal(closed, true);
});

for (const source of ["trigger", "observer", "assertion"]) {
  test(`native event classification preserves ${source} errors`, async (t) => {
    const { withWatchEvent } = await import("./watch-support.js");
    const watcher = new EventEmitter();
    let closed = false;
    watcher.close = () => { closed = true; };
    t.mock.method(fs, "watch", () => watcher);
    const failure = Object.assign(new Error("permission refused"), { code: "EACCES" });
    await assert.rejects(withWatchEvent({ skip: () => assert.fail("must not skip") }, "folder", "file.txt", async () => {
      if (source === "trigger") throw failure;
      if (source === "observer") watcher.emit("error", failure);
    }, async () => {
      if (source === "assertion") throw failure;
      assert.fail("event absent");
    }), (error) => error === failure);
    assert.equal(closed, true);
  });
}
