import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { watchTree } from "../packages/daemon/folder-watch.js";
import { compileIgnore } from "../packages/daemon/exclusions.js";

const until = async (check) => {
  for (let i = 0; i < 250 && !check(); i++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(check());
};

test("the tree watcher skips excluded directories and follows new, re-included and removed ones", async (t) => {
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
  await until(() => {
    fs.writeFileSync(path.join(root, "src/ready.txt"), String(Date.now()));
    return seen.includes("src/ready.txt");
  });
  fs.mkdirSync(path.join(root, "src/new"));
  await until(() => w.watched().includes("src/new"));
  await until(() => {
    fs.writeFileSync(path.join(root, "src/new/file.txt"), String(Date.now()));
    return seen.includes("src/new/file.txt");
  });
  rules = compileIgnore("cache/\n");
  w.refresh();
  assert.deepEqual(w.watched().sort(), ["", "repos", "repos/big", "repos/big/deep", "src", "src/lib", "src/new"]);
  if (process.platform !== "win32") {
    // refresh() replaces every watcher; wait for the new parent watcher to
    // receive events before performing the one-shot directory deletion.
    await until(() => {
      fs.writeFileSync(path.join(root, "src/after-refresh.txt"), String(Date.now()));
      return seen.includes("src/after-refresh.txt");
    });
    fs.rmSync(path.join(root, "src/new"), { recursive: true });
    await until(() => !w.watched().includes("src/new"));
  }
});
