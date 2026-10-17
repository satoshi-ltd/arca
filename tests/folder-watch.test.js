import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { watchTree } from "../packages/daemon/folder-watch.js";
import { compileIgnore } from "../packages/daemon/exclusions.js";
import { canWatchDirectory, withWatchEvent } from "./watch-support.js";

const until = async (check) => {
  for (let i = 0; i < 250 && !check(); i++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(check());
};

test("the tree watcher skips excluded directories and follows new, re-included and removed ones", async (t) => {
  if (!(await canWatchDirectory(8))) {
    t.skip("the operating system cannot deliver folder watcher events here");
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arca-watch-"));
  for (const dir of ["src/lib", "repos/big/deep", "node_modules/pkg/lib", ".git/objects", "cache"])
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  let rules = compileIgnore("repos/\n");
  const seen = [];
  const w = watchTree(root, (name, directory) => rules(name, directory), (name) => seen.push(name));
  t.after(() => {
    w.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  assert.deepEqual(w.watched().sort(), ["", "cache", "src", "src/lib"]);
  if (!(await withWatchEvent(t, path.join(root, "src"), "ready.txt", async () => {
    fs.writeFileSync(path.join(root, "src/ready.txt"), String(Date.now()));
  }, async () => {
    await until(() => {
      fs.writeFileSync(path.join(root, "src/ready.txt"), String(Date.now()));
      return seen.includes("src/ready.txt");
    });
  }))) return;
  if (!(await withWatchEvent(t, path.join(root, "src"), "new", async () => {
    fs.mkdirSync(path.join(root, "src/new"));
  }, async () => {
    await until(() => w.watched().includes("src/new"));
  }))) return;
  if (!(await withWatchEvent(t, path.join(root, "src/new"), "file.txt", async () => {
    fs.writeFileSync(path.join(root, "src/new/file.txt"), String(Date.now()));
  }, async () => {
    await until(() => {
      fs.writeFileSync(path.join(root, "src/new/file.txt"), String(Date.now()));
      return seen.includes("src/new/file.txt");
    });
  }))) return;
  rules = compileIgnore("cache/\n");
  w.refresh();
  assert.deepEqual(w.watched().sort(), ["", "repos", "repos/big", "repos/big/deep", "src", "src/lib", "src/new"]);
  if (process.platform !== "win32") {
    // refresh() replaces every watcher; wait for the new parent watcher to
    // receive events before performing the one-shot directory deletion.
    if (!(await withWatchEvent(t, path.join(root, "src"), "after-refresh.txt", async () => {
      fs.writeFileSync(path.join(root, "src/after-refresh.txt"), String(Date.now()));
    }, async () => {
      await until(() => {
        fs.writeFileSync(path.join(root, "src/after-refresh.txt"), String(Date.now()));
        return seen.includes("src/after-refresh.txt");
      });
    }))) return;
    await withWatchEvent(t, path.join(root, "src"), "new", async () => {
      fs.rmSync(path.join(root, "src/new"), { recursive: true });
    }, async () => {
      await until(() => !w.watched().includes("src/new"));
    });
  }
});

test("an asynchronous error of an existing watcher reaches the daemon's handler instead of silently dropping the watch", async (t) => {
  if (!(await canWatchDirectory(3))) {
    t.skip("the operating system cannot deliver folder watcher events here");
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arca-watch-error-"));
  fs.mkdirSync(path.join(root, "src/nested"), { recursive: true });
  const seen = [];
  const w = watchTree(root, () => false, (name) => seen.push(name));
  t.after(() => {
    w.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  assert.deepEqual(w.watched().sort(), ["", "src", "src/nested"]);
  const errors = [];
  w.on("error", (error) => errors.push(error.message));
  w.dirs.get("src/nested").emit("error", new Error("inotify limit reached"));
  assert.deepEqual(errors, ["inotify limit reached"], "the failure is reported to whoever owns the watcher");
  assert.equal(w.watched().includes("src/nested"), false, "the failed directory is no longer considered watched");
  w.dirs.get("src").emit("error", new Error("again"));
  assert.equal(errors.length, 2);
  w.close();
  assert.deepEqual(w.watched(), []);
  assert.equal(w.dirs.size, 0, "a closed watcher keeps nothing");
});

test("a watcher error with no listener, or after close, never throws", async (t) => {
  if (!(await canWatchDirectory(2))) {
    t.skip("the operating system cannot deliver folder watcher events here");
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arca-watch-quiet-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  const w = watchTree(root, () => false, () => {});
  t.after(() => {
    w.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const watcher = w.dirs.get("src");
  assert.doesNotThrow(() => watcher.emit("error", new Error("no listener")));
  const closing = w.dirs.get("");
  w.on("error", () => assert.fail("a closed watcher stays silent"));
  w.close();
  assert.doesNotThrow(() => closing.emit("error", new Error("after close")));
});

test("the daemon answers a watcher error by scanning the folder in full, dropping the watcher and retrying only after a pause", () => {
  const server = fs.readFileSync(new URL("../packages/daemon/server.js", import.meta.url), "utf8");
  const handler = server.slice(server.indexOf('w.on("error", () => {'), server.indexOf("watchers.set(folder, w);"));
  assert.match(handler, /engine\.work\.mark\(volume\.id\);/, "the folder is marked for a full scan");
  assert.match(handler, /schedule\(1000\);/, "the scan starts within a second");
  assert.match(handler, /w\.close\(\);\s+watchers\.delete\(folder\);/, "no stale watcher suppresses the retry");
  assert.match(handler, /watcherRetry\.set\(folder, Date\.now\(\) \+ IDLE_POLL_MS\);/, "a persistent failure waits instead of looping");
  assert.match(server, /watcherRetry\.set\(folder, Date\.now\(\) \+ IDLE_POLL_MS\);\s+engine\.work\.mark\(volume\.id\);/, "creating a watcher also arms the pause");
});
