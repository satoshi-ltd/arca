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

test("template seeds once; empty custom rules and safe file reads", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arca-ignore-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  ensureIgnore(root);
  assert.equal(compileIgnore(readIgnore(root))("cache/keep"), true);
  assert.equal(compileIgnore(readIgnore(root))("node_modules/package"), true);
  fs.writeFileSync(path.join(root, ".arcaignore"), "");
  ensureIgnore(root);
  assert.equal(readIgnore(root), "");
  assert.equal(compileIgnore(DEFAULT_IGNORE)("nested/.git/config"), true);
});

test("ignore reads reject a dangling symlink", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arca-ignore-link-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  try {
    fs.symlinkSync(
      path.join(root, "missing"),
      path.join(root, ".arcaignore"),
      "file",
    );
  } catch (error) {
    if (process.platform === "win32" && error.code === "EPERM") {
      t.skip("Creating symlinks requires Windows privileges");
      return;
    }
    throw error;
  }
  assert.throws(() => readIgnore(root));
});

test("Finder metadata is always excluded, without user rules or despite negation", () => {
  for (const text of [
    "",
    "!.DS_Store\n!**/.DS_Store\n!Thumbs.db\n!desktop.ini\n",
  ]) {
    const excluded = compileIgnore(text);
    for (const name of [
      ".DS_Store",
      "photos/.DS_Store",
      "photos/.ds_store",
      "Thumbs.db",
      "photos/THUMBS.DB",
      "desktop.ini",
      "nested/Desktop.ini",
    ])
      assert.equal(excluded(name), true, name);
    for (const name of [
      ".env",
      "notes/.DS_Store.txt",
      "node_modules/package.json",
      ".arcaignore",
    ])
      assert.equal(excluded(name), false, name);
  }
});
