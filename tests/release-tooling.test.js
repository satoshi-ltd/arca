import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bump, targets } from "../scripts/bump-version.js";
import { cleanCopy } from "../scripts/validate-local.js";
import { manifests } from "../scripts/release-manifests.js";
import { execFileSync, spawnSync } from "node:child_process";

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

test("check-release verifies every location bump-version writes, whatever the line endings", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arca-check-release-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = new Set([
    ...manifests.map(([file]) => file),
    "CHANGELOG.md",
    path.join("scripts", "check-release.js"),
    path.join("scripts", "release-manifests.js"),
  ]);
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.copyFileSync(path.join(repository, file), path.join(root, file));
  }
  const check = () =>
    spawnSync(process.execPath, [path.join(root, "scripts", "check-release.js")], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_OUTPUT: "" },
    });
  const agrees = () => {
    const result = check();
    assert.equal(result.status, 0, result.stderr);
  };
  agrees();
  const lock = path.join(root, "apps", "desktop", "src-tauri", "Cargo.lock");
  fs.writeFileSync(lock, fs.readFileSync(lock, "utf8").replace(/\r?\n/g, "\r\n"));
  agrees();
  const current = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  for (const [file, template, expected] of manifests) {
    const target = path.join(root, file);
    const original = fs.readFileSync(target, "utf8");
    const text = original.replace(/\r\n/g, "\n");
    const before = template.replace("{version}", current);
    let at = -1;
    for (let n = 0; n < expected; n++) at = text.indexOf(before, at + 1);
    assert.ok(at >= 0, `${file} carries ${before}`);
    fs.writeFileSync(
      target,
      text.slice(0, at) + template.replace("{version}", `${current}-rc.1`) + text.slice(at + before.length),
    );
    const drift = check();
    assert.equal(drift.status, 1, `${file}: ${template}`);
    assert.match(
      drift.stderr,
      file === "package.json" ? /x\.y\.z release version/ : new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
    fs.writeFileSync(target, original);
  }
  const { to } = bump(root);
  assert.match(check().stderr, /missing from CHANGELOG/);
  const changelog = path.join(root, "CHANGELOG.md");
  fs.writeFileSync(
    changelog,
    fs.readFileSync(changelog, "utf8").replace(/# Changelog\r?\n/, `# Changelog\n\n## ${to} — 2026-01-01\n`),
  );
  agrees();
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

test("every Node pin follows .node-version", () => {
  const read = (file) =>
    fs.readFileSync(path.join(repository, file), "utf8").replace(/\r\n/g, "\n");
  const version = read(".node-version").trim();
  assert.match(version, /^\d+\.\d+\.\d+$/);
  const workflows = path.join(".github", "workflows");
  for (const workflow of fs.readdirSync(path.join(repository, workflows))) {
    if (!/\.ya?ml$/.test(workflow)) continue;
    const text = read(path.join(workflows, workflow));
    for (const step of text.split(/\n(?= +- )/).filter((step) => /uses: actions\/setup-node@/.test(step)))
      assert.match(step, /\n +node-version-file: \.node-version(\n|$)/, workflow);
    assert.doesNotMatch(text, /node-version:/, workflow);
  }
  const images = [...read(path.join("deploy", "Dockerfile")).matchAll(/^FROM node:(\S+?)-/gm)].map((m) => m[1]);
  assert.ok(images.length);
  assert.deepEqual([...new Set(images)], [version]);
  const { build } = JSON.parse(read(path.join("apps", "mobile", "eas.json")));
  const node = (name) => build[name].node ?? (build[name].extends ? node(build[name].extends) : undefined);
  for (const profile of Object.keys(build)) assert.equal(node(profile), version, `EAS ${profile}`);
  for (const script of ["stage-runtime.js", "validate-local.js"]) {
    const text = read(path.join("scripts", script));
    assert.match(text, /\.node-version/, script);
    assert.doesNotMatch(text, /\d+\.\d+\.\d+/, script);
  }
});
