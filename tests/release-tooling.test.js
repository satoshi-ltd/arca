import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bump, targets } from "../scripts/bump-version.js";
import { cleanCopy, gitFreeEnv } from "../scripts/validate-local.js";
import { testConcurrency } from "../scripts/test-concurrency.js";
import { fingerprint, stampMatches, stampPath, writeStamp } from "../scripts/validated-stamp.js";
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
  const colored = execFileSync(process.execPath, [path.join(repository, "scripts", "test-concurrency.js")], {
    encoding: "utf8",
    env: { ...process.env, ARCA_TEST_CONCURRENCY: "2", FORCE_COLOR: "1" },
  });
  assert.equal(colored.trim(), "2", "a colour-forcing environment never wraps the number in escape codes");
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
  assert.equal(checkouts.length, 3, "the gate, the build and the tag job check out the repository");
  for (const [, options] of checkouts) assert.ok(options.includes(ref), `a checkout lacks ${ref}`);
  assert.match(docker, /RELEASE_SHA: \$\{\{ github\.event\.workflow_run\.head_sha \|\| github\.sha \}\}/);
  assert.match(read("scripts/record-docker-tag.sh"), /-f sha="\$RELEASE_SHA"/, "the tag records the released commit");
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

test("a validation stamp matches only the exact files it was written for", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arca-stamp-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe", env: gitFreeEnv() });
  git("init", "-q");
  fs.writeFileSync(path.join(root, ".gitignore"), "ignored.txt\nnode_modules\n");
  fs.writeFileSync(path.join(root, ".node-version"), "24.21.0\n");
  fs.writeFileSync(path.join(root, "tracked.txt"), "one");
  git("add", "-A");
  const run = (fn) => {
    const saved = Object.fromEntries(Object.keys(process.env).filter((key) => key.startsWith("GIT_")).map((key) => [key, process.env[key]]));
    for (const key of Object.keys(saved)) delete process.env[key];
    try {
      return fn();
    } finally {
      Object.assign(process.env, saved);
    }
  };
  run(() => {
    assert.equal(stampMatches(root), false, "no stamp yet");
    const first = fingerprint(root);
    writeStamp(root, first);
    assert.equal(stampMatches(root), true);
    assert.ok(stampPath(root).includes(".git"), "the stamp lives in the git directory, never in the tree");
    assert.equal(git("status", "--porcelain").toString().includes("arca-validated"), false);
    fs.writeFileSync(path.join(root, "ignored.txt"), "never counted");
    fs.mkdirSync(path.join(root, "node_modules"));
    fs.writeFileSync(path.join(root, "node_modules", "dependency.js"), "ignored");
    assert.equal(stampMatches(root), true, "ignored files do not matter");
    git("-c", "user.email=a@b.c", "-c", "user.name=t", "commit", "-qm", "init", "--no-verify");
    assert.equal(stampMatches(root), true, "committing the same files keeps the stamp");
    fs.writeFileSync(path.join(root, "tracked.txt"), "two");
    assert.equal(stampMatches(root), false, "a changed file invalidates it");
    fs.writeFileSync(path.join(root, "tracked.txt"), "one");
    assert.equal(stampMatches(root), true, "restoring the content restores the match");
    fs.writeFileSync(path.join(root, "new-untracked.txt"), "x");
    assert.equal(stampMatches(root), false, "a new untracked file invalidates it");
    fs.rmSync(path.join(root, "new-untracked.txt"));
    fs.writeFileSync(path.join(root, ".node-version"), "24.22.0\n");
    assert.equal(stampMatches(root), false, "a different Node pin invalidates it");
    fs.rmSync(path.join(root, "tracked.txt"));
    assert.equal(stampMatches(root), false, "a deleted file invalidates it");
  });
});

test("the pre-push hook still checks the release and skips the suite only on a matching stamp", () => {
  const read = (file) => fs.readFileSync(path.join(repository, file), "utf8").replace(/\r\n/g, "\n");
  const hook = read(".githooks/pre-push");
  assert.ok(hook.indexOf("node scripts/check-release.js") < hook.indexOf("validated-stamp.js check"), "the version check always runs first");
  assert.match(hook, /if node scripts\/validated-stamp\.js check; then exit 0; fi\n/);
  assert.ok(hook.indexOf("validated-stamp.js check") < hook.indexOf("node --test"), "the suite runs when there is no stamp");
  const validate = read("scripts/validate-local.js");
  assert.match(validate, /const validated = fingerprint\(repository\);/);
  assert.match(validate, /if \(copied && fingerprint\(repository\) === validated\) writeStamp\(repository, validated\);/, "files edited while validating never get a stamp");
  assert.match(validate, /const copied = fingerprint\(clean\) === validated;/, "the stamp covers what was copied and tested");
});

test("the check command exits 0 only for a stamp that matches the files", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arca-stamp-cli-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = gitFreeEnv();
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe", env });
  git("init", "-q");
  fs.writeFileSync(path.join(root, "file.txt"), "content");
  const check = () =>
    spawnSync(process.execPath, [path.join(repository, "scripts", "validated-stamp.js"), "check", root], { encoding: "utf8", env });
  assert.equal(check().status, 1, "no stamp means the suite runs");
  const saved = process.env;
  process.env = env;
  try {
    writeStamp(root, fingerprint(root));
  } finally {
    process.env = saved;
  }
  const match = check();
  assert.equal(match.status, 0);
  assert.match(match.stdout, /skipping the suite/);
  fs.writeFileSync(path.join(root, "file.txt"), "changed");
  assert.equal(check().status, 1, "a changed file means the suite runs");
  const unreadable = spawnSync(process.execPath, [path.join(repository, "scripts", "validated-stamp.js"), "check", path.join(root, "missing")], { encoding: "utf8", env });
  assert.equal(unreadable.status, 1, "anything unreadable means the suite runs");
});

test("the Docker workflow records its tag with retries, and a version already on Docker Hub only needs the tag", () => {
  const read = (file) => fs.readFileSync(path.join(repository, file), "utf8").replace(/\r\n/g, "\n");
  const docker = read(".github/workflows/publish-docker.yml");
  assert.equal(docker.match(/bash scripts\/record-docker-tag\.sh/g).length, 1, "one job records the tag");
  assert.doesNotMatch(docker, /gh api/, "no step calls the refs API without the retry");
  assert.match(docker, /https:\/\/hub\.docker\.com\/v2\/repositories\/satoshiltd\/arca\/tags\/\$version/);
  assert.match(docker, /echo 'record=true' >> "\$GITHUB_OUTPUT"/);
  assert.match(docker, /\n  record:\n    needs: \[gate, docker\]\n    if: >-\n      always\(\) &&\n      \(needs\.gate\.outputs\.record == 'true' \|\|\n       \(needs\.gate\.outputs\.publish == 'true' && needs\.docker\.result == 'success'\)\)\n/, "a failed tag step re-runs alone, after a successful publish");
  const record = docker.slice(docker.indexOf("\n  record:\n"));
  assert.match(record, /permissions:\n      contents: write/);
  const buildJob = docker.slice(docker.indexOf("\n  docker:\n"), docker.indexOf("\n  record:\n"));
  assert.doesNotMatch(buildJob, /record-docker-tag/, "the tag step is not part of the job that publishes");
  const hubCheck = docker.indexOf("hub.docker.com");
  assert.ok(hubCheck > docker.indexOf("git ls-remote") && hubCheck < docker.indexOf("Publishing satoshiltd/arca"), "the Hub check sits between the tag check and the publish decision");
  assert.ok(docker.indexOf('"$FORCE" != true') < docker.indexOf("git ls-remote"), "a forced run skips both checks and still republishes");
  assert.match(docker, /-m 20 --retry 3/, "the Hub check is bounded");
  assert.match(docker, /\[\[ "\$hub" == 200 \|\| "\$hub" == 404 \]\] \|\| \{[^}]*exit 1; \}/, "any other Hub answer stops the run instead of publishing");
  const script = read("scripts/record-docker-tag.sh");
  assert.match(script, /for attempt in 1 2 3 4/);
  assert.match(script, /Reference already exists/);
  assert.match(script, /Run: gh api repos\/\$GITHUB_REPOSITORY\/git\/refs -f ref=refs\/tags\/\$TAG -f sha=\$RELEASE_SHA/);
});

test("the tag script retries, treats an existing tag as done and names the manual command when it gives up", { skip: process.platform === "win32" }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arca-tag-script-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  const log = path.join(root, "calls");
  const fake = (body) => {
    fs.writeFileSync(path.join(bin, "gh"), `#!/usr/bin/env bash\necho call >> "${log}"\n${body}\n`, { mode: 0o755 });
    fs.rmSync(log, { force: true });
  };
  const run = () =>
    spawnSync("bash", [path.join(repository, "scripts", "record-docker-tag.sh")], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, TAG: "docker-v9.9.9", RELEASE_SHA: "abc123", GITHUB_REPOSITORY: "owner/repo", RECORD_RETRY_DELAY: "0" },
    });
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").length : 0);
  fake("exit 0");
  assert.equal(run().status, 0);
  assert.equal(calls(), 1, "a first success makes one call");
  fake(`count=$(wc -l < "${log}"); if [ "$count" -lt 3 ]; then echo "Resource not accessible by integration (HTTP 403)" >&2; exit 1; fi`);
  const retried = run();
  assert.equal(retried.status, 0, retried.stdout);
  assert.equal(calls(), 3, "two 403 answers are retried");
  fake('echo "Reference already exists (HTTP 422)" >&2; exit 1');
  assert.equal(run().status, 0, "an existing tag counts as recorded");
  assert.equal(calls(), 1);
  fake('echo "Resource not accessible by integration (HTTP 403)" >&2; exit 1');
  const failed = run();
  assert.equal(failed.status, 1);
  assert.equal(calls(), 4, "it gives up after four attempts");
  assert.match(failed.stdout, /Run: gh api repos\/owner\/repo\/git\/refs -f ref=refs\/tags\/docker-v9\.9\.9 -f sha=abc123/);
});
