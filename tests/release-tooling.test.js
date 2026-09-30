import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bump, targets } from "../scripts/bump-version.js";
import { cleanCopy } from "../scripts/validate-local.js";
import { execFileSync } from "node:child_process";

const repository = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("bump-version moves every release manifest to the next version together", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arca-bump-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = [...new Set(targets("0", "0").map(([file]) => file))];
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.copyFileSync(path.join(repository, file), path.join(root, file));
  }
  const current = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  const [major, minor, patch] = current.split(".").map(Number);
  const { from, to } = bump(root);
  assert.equal(from, current);
  assert.equal(to, `${major}.${minor}.${patch + 1}`);
  for (const [file, , after] of targets(from, to))
    assert.ok(fs.readFileSync(path.join(root, file), "utf8").includes(after), `${file} carries ${to}`);
  const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
  assert.deepEqual([lock.version, lock.packages[""].version], [to, to]);
  assert.equal(bump(root, "7.0.0").to, "7.0.0", "an explicit version wins");
  assert.throws(() => bump(root, "7.0"), /Invalid version/);
  fs.writeFileSync(path.join(root, "packages/daemon/network.js"), "no version here");
  assert.throws(() => bump(root), /packages\/daemon\/network\.js: expected 1/);
});

test("validation copies the working tree exactly, including case-only renames, deletions and new files", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arca-clean-copy-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const destination = path.join(root, "destination");
  fs.mkdirSync(source);
  fs.mkdirSync(destination);
  const git = (...args) => execFileSync("git", args, { cwd: source, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  fs.writeFileSync(path.join(source, "changelog.md"), "old name");
  fs.writeFileSync(path.join(source, "gone.txt"), "deleted later");
  fs.writeFileSync(path.join(source, ".gitignore"), "ignored.txt\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  git("mv", "changelog.md", "renaming.md");
  git("mv", "renaming.md", "CHANGELOG.md");
  fs.rmSync(path.join(source, "gone.txt"));
  fs.mkdirSync(path.join(source, "nested"));
  fs.writeFileSync(path.join(source, "nested", "new.txt"), "untracked");
  fs.writeFileSync(path.join(source, "ignored.txt"), "never copied");
  cleanCopy(source, destination);
  const copied = fs.readdirSync(destination).filter((name) => name !== ".git").sort();
  assert.deepEqual(copied, [".gitignore", "CHANGELOG.md", "nested"]);
  assert.equal(fs.readFileSync(path.join(destination, "CHANGELOG.md"), "utf8"), "old name");
  assert.equal(fs.readFileSync(path.join(destination, "nested", "new.txt"), "utf8"), "untracked");
});
