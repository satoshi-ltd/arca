import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  compileIgnore,
  ensureIgnore,
  readIgnore,
  DEFAULT_IGNORE,
} from "../packages/daemon/exclusions.js";

test("root rules support gitignore patterns and parent-directory negation", () => {
  const excluded = compileIgnore(
    "# comment\n/root.txt\n*.tmp\n**/logs/\ncache/*\n!cache/keep.txt\nfile[0-9]?.bak\n\\#literal\n",
  );
  for (const name of [
    "root.txt",
    "a/file.tmp",
    "x/logs/file",
    "cache/drop",
    "file1a.bak",
    "#literal",
  ])
    assert.equal(excluded(name), true, name);
  for (const name of ["a/root.txt", "cache/keep.txt", "filex.bak", "notes.md"])
    assert.equal(excluded(name), false, name);
  assert.equal(
    compileIgnore("cache/\n!cache/keep.txt")("cache/keep.txt"),
    true,
  );
  assert.equal(compileIgnore("cache/")("cache", true), true);
  assert.equal(compileIgnore("cache/")("cache", false), false);
  assert.equal(compileIgnore("*\n!.arca-volume")(".arcaignore"), false);
  assert.equal(compileIgnore("*\n!.arca-volume")(".arca-volume"), true);
});

test("template seeds once; empty custom rules, legacy exceptions and safe file reads", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arca-ignore-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  ensureIgnore(root, ["cache"]);
  assert.equal(compileIgnore(readIgnore(root))("cache/keep"), false);
  assert.equal(compileIgnore(readIgnore(root))("node_modules/package"), true);
  fs.writeFileSync(path.join(root, ".arcaignore"), "");
  ensureIgnore(root);
  assert.equal(readIgnore(root), "");
  assert.equal(compileIgnore(DEFAULT_IGNORE)("nested/.git/config"), true);
  fs.unlinkSync(path.join(root, ".arcaignore"));
  fs.symlinkSync("/missing", path.join(root, ".arcaignore"));
  assert.throws(() => readIgnore(root));
});
