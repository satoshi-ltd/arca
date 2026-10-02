import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bump, targets } from "../scripts/bump-version.js";
import { cleanCopy, gitFreeEnv } from "../scripts/validate-local.js";
import { testConcurrency } from "../scripts/test-concurrency.js";
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
  const git = (...args) => execFileSync("git", args, { cwd: source, stdio: "pipe", env: gitFreeEnv() });
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

test("every workflow uses the same checkout and setup-node majors and closes its shell conditionals at their own indentation", () => {
  const directory = new URL("../.github/workflows/", import.meta.url);
  const workflows = fs.readdirSync(directory).filter((name) => name.endsWith(".yml"));
  assert.ok(workflows.length >= 4);
  const versions = { checkout: new Set(), "setup-node": new Set() };
  for (const name of workflows) {
    const lines = fs.readFileSync(new URL(name, directory), "utf8").replace(/\r\n/g, "\n").split("\n");
    const open = [];
    lines.forEach((line, index) => {
      const use = line.match(/uses:\s*actions\/(checkout|setup-node)@(v\d+)/);
      if (use) versions[use[1]].add(use[2]);
      if (/^\s*if\b.*;\s*then\s*$/.test(line)) open.push(line.search(/\S/));
      if (/^\s*fi\s*$/.test(line))
        assert.equal(line.search(/\S/), open.pop(), `${name}:${index + 1} closes its if at another indentation`);
    });
    assert.deepEqual(open, [], `${name} leaves an if without fi`);
  }
  assert.equal(versions.checkout.size, 1, `one actions/checkout major, found ${[...versions.checkout]}`);
  assert.equal(versions["setup-node"].size, 1, `one actions/setup-node major, found ${[...versions["setup-node"]]}`);
});

test("the clean copy ignores git variables exported by hooks and never touches the caller's repository", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arca-hook-env-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const destination = path.join(root, "destination");
  const foreign = path.join(root, "foreign.git");
  fs.mkdirSync(source);
  fs.mkdirSync(destination);
  fs.mkdirSync(foreign);
  fs.writeFileSync(path.join(source, "file.txt"), "content");
  execFileSync("git", ["init", "-q"], { cwd: source, stdio: "pipe", env: gitFreeEnv() });
  const saved = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
  process.env.GIT_DIR = foreign;
  process.env.GIT_WORK_TREE = foreign;
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  cleanCopy(source, destination);
  assert.equal(fs.readFileSync(path.join(destination, "file.txt"), "utf8"), "content");
  assert.deepEqual(fs.readdirSync(foreign), []);
  assert.equal(fs.existsSync(path.join(destination, ".git")), true);
});

test("local full runs cap test parallelism while CI keeps the default", () => {
  assert.equal(testConcurrency({}, 14), 7);
  assert.equal(testConcurrency({}, 8), 4);
  assert.equal(testConcurrency({}, 3), 1);
  assert.equal(testConcurrency({}, 1), 1, "never below one");
  assert.equal(testConcurrency({ ARCA_TEST_CONCURRENCY: "3" }, 14), 3, "the maintainer can override it");
  for (const bad of ["0", "-2", "1.5", "abc", "", "0x10", "1e1", " 3 "])
    assert.equal(testConcurrency({ ARCA_TEST_CONCURRENCY: bad }, 14), 7, `"${bad}" falls back to half the cores`);
  const printed = execFileSync(process.execPath, [path.join(repository, "scripts", "test-concurrency.js")], {
    encoding: "utf8",
    env: { ...process.env, ARCA_TEST_CONCURRENCY: "2" },
  });
  assert.equal(printed.trim(), "2", "the hook reads the number from this script");
  if (process.platform !== "win32") {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "arca-concurrency-link-"));
    try {
      fs.symlinkSync(path.join(repository, "scripts"), path.join(root, "scripts"));
      const linked = execFileSync(process.execPath, [path.join(root, "scripts", "test-concurrency.js")], {
        encoding: "utf8",
        env: { ...process.env, ARCA_TEST_CONCURRENCY: "2" },
      });
      assert.equal(linked.trim(), "2", "a symlinked checkout still prints the number");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
  const read = (file) => fs.readFileSync(path.join(repository, file), "utf8").replace(/\r\n/g, "\n");
  assert.match(read(".githooks/pre-push"), /node --test --test-concurrency="\$\(node scripts\/test-concurrency\.js\)" /);
  assert.match(read("scripts/validate-local.js"), /`--test-concurrency=\$\{testConcurrency\(\)\}`/);
  for (const workflow of fs.readdirSync(path.join(repository, ".github", "workflows")))
    assert.doesNotMatch(read(path.join(".github", "workflows", workflow)), /test-concurrency/, `${workflow} keeps Node's default`);
});

test("the Docker workflow builds and tags the commit of the release that triggered it", () => {
  const read = (file) => fs.readFileSync(path.join(repository, file), "utf8").replace(/\r\n/g, "\n");
  const docker = read(".github/workflows/publish-docker.yml");
  const ref = "ref: ${{ github.event.workflow_run.head_sha || github.sha }}";
  const checkouts = [...docker.matchAll(/- uses: actions\/checkout@v5\n((?: {8}.+\n)+)/g)];
  assert.equal(checkouts.length, 2, "the gate and the build both check out the repository");
  for (const [, options] of checkouts) assert.ok(options.includes(ref), `a checkout lacks ${ref}`);
  assert.match(docker, /RELEASE_SHA: \$\{\{ github\.event\.workflow_run\.head_sha \|\| github\.sha \}\}/);
  assert.match(docker, /-f sha="\$RELEASE_SHA"/);
  assert.doesNotMatch(docker, /GITHUB_SHA|github\.sha(?! \}\}\n)/, "the tag never records the branch head");
  const gate = docker.slice(docker.indexOf("  gate:"), docker.indexOf("    runs-on:", docker.indexOf("  gate:")));
  for (const condition of [
    "github.event.workflow_run.conclusion == 'success'",
    "github.event.workflow_run.head_branch == 'main'",
    "github.event.workflow_run.head_repository.full_name == github.repository",
    "github.event.workflow_run.event == 'push'",
  ])
    assert.ok(gate.includes(condition), `the gate lacks ${condition}: fork code must never reach the publish path`);
  assert.ok(read(".github/workflows/publish-site.yml").includes(ref), "publish-site pins the same commit");
});
