import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".github", "workflows");
const names = fs.readdirSync(directory).filter((name) => /\.ya?ml$/.test(name));
const source = (name) => fs.readFileSync(path.join(directory, name), "utf8").replace(/\r\n/g, "\n");

function readWorkflow(text, name) {
  const lines = text.split("\n");
  let at = 0;
  const fail = (why) => {
    throw new Error(`${name}:${at + 1}: ${why}: ${JSON.stringify(lines[at] ?? "")}`);
  };
  const indentOf = (line) => line.search(/\S/);
  const skipBlank = () => {
    while (at < lines.length && /^ *(#.*)?$/.test(lines[at])) at++;
    if (at < lines.length && /^ *\t/.test(lines[at])) fail("tab indentation");
  };
  const scalar = (value) => {
    if (/^"[^"\\]*"$/.test(value) || /^'[^']*'$/.test(value)) return value.slice(1, -1);
    if (/^\[[^[\]{}"',]+(,[^[\]{}"',]+)*\]$/.test(value))
      return value.slice(1, -1).split(",").map((item) => item.trim());
    if (/^["'[{&*!|>%@`]/.test(value) || /\s#/.test(value)) fail("unsupported value");
    return value;
  };
  const value = (rest, indent) => {
    if (rest === "") {
      skipBlank();
      return at < lines.length && indentOf(lines[at]) > indent ? node(indentOf(lines[at])) : null;
    }
    if (!/^[|>][+-]?$/.test(rest)) return scalar(rest);
    const body = [];
    while (at < lines.length && (lines[at].trim() === "" || indentOf(lines[at]) > indent)) body.push(lines[at++]);
    return body.join("\n");
  };
  const mapping = (indent) => {
    const map = {};
    for (;;) {
      skipBlank();
      if (at >= lines.length || indentOf(lines[at]) < indent) return map;
      const entry = /^([A-Za-z_][\w.-]*):(?: +(.*))?$/.exec(lines[at].slice(indent).trimEnd());
      if (!entry) fail("expected a key at this indentation");
      if (Object.hasOwn(map, entry[1])) fail("duplicate key");
      at++;
      map[entry[1]] = value(entry[2] ?? "", indent);
    }
  };
  const sequence = (indent) => {
    const list = [];
    for (;;) {
      skipBlank();
      if (at >= lines.length || indentOf(lines[at]) < indent) return list;
      const item = /^- (\S.*)$/.exec(lines[at].slice(indent).trimEnd());
      if (!item) fail("expected a list item at this indentation");
      if (/^[A-Za-z_][\w.-]*:( |$)/.test(item[1])) {
        lines[at] = " ".repeat(indent + 2) + item[1];
        list.push(mapping(indent + 2));
      } else {
        at++;
        list.push(scalar(item[1]));
      }
    }
  };
  const node = (indent) => (lines[at].slice(indent).startsWith("-") ? sequence(indent) : mapping(indent));
  return mapping(0);
}

const TOOLS = /\b(npm|npx|yarn|pnpm|bun|corepack|cargo|rustup|make|pip3?|gradle|git +clone|docker +(?:build|buildx|run|compose|push|pull|login))\b/;
const SCRIPT = /(?:^|[\s;&|(])(?:node|bash|sh)\s+(\S+)|(?:^|[\s;&|(])\.\/(\S+)/g;
const WRITE_SCRIPTS = new Set(["scripts/check-release.js", "scripts/prepare-release.js", "scripts/updater-manifest.js", "scripts/record-docker-tag.sh", "scripts/prune-actions.js"]);
const WRITE_ACTIONS = /^actions\/(checkout|setup-node|download-artifact|github-script)@/;

function unsafeInWriteJob(step) {
  if (typeof step.uses === "string") {
    if (!WRITE_ACTIONS.test(step.uses)) return step.uses;
    if (/^actions\/setup-node@/.test(step.uses) && step.with?.cache) return `${step.uses} with a dependency cache`;
    if (/^actions\/github-script@/.test(step.uses) && TOOLS.test(step.with?.script || "")) return `${step.uses} running ${TOOLS.exec(step.with.script)[0]}`;
    return null;
  }
  const tool = TOOLS.exec(step.run);
  if (tool) return tool[0];
  for (const [, script, local] of step.run.matchAll(SCRIPT)) {
    const name = script || local;
    if (name.startsWith("-")) continue;
    if (!WRITE_SCRIPTS.has(name.replace(/^\.\//, ""))) return name;
  }
  return null;
}

function writeScopes(permissions, where) {
  if (permissions === "write-all") return ["write-all"];
  if (permissions === "read-all") return [];
  if (permissions === null || typeof permissions !== "object" || Array.isArray(permissions))
    throw new Error(`${where}: unsupported permissions ${JSON.stringify(permissions)}`);
  for (const [scope, level] of Object.entries(permissions))
    if (!["read", "write", "none"].includes(level)) throw new Error(`${where}: unsupported ${scope}: ${level}`);
  return Object.keys(permissions).filter((scope) => permissions[scope] === "write");
}

function audit(text, name) {
  const workflow = readWorkflow(text, name);
  const problems = [];
  const seen = { uses: 0, run: 0 };
  if (workflow.permissions === undefined) problems.push("the workflow declares no permissions");
  else if (JSON.stringify(workflow.permissions) !== '{"contents":"read"}')
    problems.push(`the workflow grants ${JSON.stringify(workflow.permissions)} to every job instead of contents: read`);
  if (workflow.jobs === null || typeof workflow.jobs !== "object") throw new Error(`${name}: no jobs`);
  for (const [id, job] of Object.entries(workflow.jobs)) {
    if (!Array.isArray(job?.steps)) throw new Error(`${name}: job ${id} has no steps this test can read`);
    if ("permissions" in job && job.permissions === null) throw new Error(`${name}: job ${id} has an empty permissions key`);
    const granted = writeScopes(job.permissions ?? workflow.permissions ?? "write-all", `${name} ${id}`);
    for (const step of job.steps) {
      const uses = typeof step?.uses === "string";
      const run = typeof step?.run === "string";
      if (uses === run) throw new Error(`${name}: job ${id} has a step that is neither uses nor run`);
      if (uses && !/^[\w.-]+\/[\w./-]+@[\w.-]+$/.test(step.uses))
        throw new Error(`${name}: job ${id} uses ${step.uses}, which this test cannot inspect`);
      seen[uses ? "uses" : "run"]++;
      if (uses && /^actions\/checkout@/.test(step.uses) && step.with?.["persist-credentials"] !== "false")
        problems.push(`job ${id} checks out without persist-credentials: false`);
      const build = granted.length && unsafeInWriteJob(step);
      if (build)
        problems.push(`job ${id} holds ${granted.join(", ")} and runs ${build}`);
    }
  }
  return { problems, seen, workflow };
}

test("no workflow persists checkout credentials or gives a write token to a job that installs or builds", () => {
  assert.ok(names.length >= 4);
  const found = [];
  for (const name of names) {
    const text = source(name);
    const { problems, seen } = audit(text, name);
    found.push(...problems.map((problem) => `${name}: ${problem}`));
    assert.deepEqual(
      seen,
      { uses: text.match(/^ +(- )?uses: \S/gm).length, run: text.match(/^ +(- )?run: \S/gm).length },
      `${name}: every step was read`,
    );
  }
  assert.deepEqual(found, []);
});

test("the workflow audit names each unsafe shape and refuses what it cannot read", () => {
  const workflow = ({ top = "permissions:\n  contents: read\n", job = "", checkout = "\n        with:\n          persist-credentials: false", step = "- run: node scripts/check-release.js" } = {}) =>
    `name: sample\non:\n  push:\n    branches: [main]\n${top}jobs:\n  build:\n    runs-on: ubuntu-24.04\n${job}    steps:\n      - uses: actions/checkout@v5${checkout}\n      ${step}\n`;
  const problems = (options) => audit(workflow(options), "sample.yml").problems;
  const write = "    permissions:\n      contents: write\n";
  assert.deepEqual(problems(), []);
  assert.deepEqual(problems({ job: write }), [], "a write job that only runs repository scripts is fine");
  assert.deepEqual(problems({ step: "- run: npm ci" }), [], "a read job may install");
  assert.deepEqual(problems({ checkout: "" }), ["job build checks out without persist-credentials: false"]);
  assert.deepEqual(problems({ checkout: "\n        with:\n          persist-credentials: true" }), [
    "job build checks out without persist-credentials: false",
  ]);
  assert.deepEqual(problems({ checkout: "\n        with:\n          fetch-depth: 0" }), [
    "job build checks out without persist-credentials: false",
  ]);
  for (const [step, command] of [
    ["- run: npm ci", "npm"],
    ["- run: npm install --no-save wrangler@4", "npm"],
    ["- run: npm run release --prefix apps/desktop", "npm"],
    ["- run: npm --prefix apps/desktop ci", "npm"],
    ["- run: npx --no-install wrangler pages deploy", "npx"],
    ["- run: bun install", "bun"],
    ["- run: corepack enable", "corepack"],
    ["- run: make release", "make"],
    ["- run: git clone https://example.com/x.git", "git clone"],
    ["- run: node scripts/build-release.js", "scripts/build-release.js"],
    ["- run: ./build.sh", "build.sh"],
    ["- run: bash scripts/other.sh", "scripts/other.sh"],
    ["- name: Tests\n        run: |\n          set -euo pipefail\n          cargo test --locked\n", "cargo"],
    ["- name: Split\n        run: |\n          npm \\\n            ci\n", "npm"],
    ["- run: docker build -t arca .", "docker build"],
    ["- uses: docker/build-push-action@v6\n        with:\n          push: true", "docker/build-push-action@v6"],
    ["- uses: swatinem/rust-cache@v2", "swatinem/rust-cache@v2"],
    ["- uses: actions/setup-node@v5\n        with:\n          cache: npm", "actions/setup-node@v5 with a dependency cache"],
    ["- uses: actions/github-script@v8\n        with:\n          script: require('child_process').execSync('npm ci')", "actions/github-script@v8 running npm"],
  ])
    assert.deepEqual(problems({ job: write, step }), [`job build holds contents and runs ${command}`], step);
  assert.deepEqual(problems({ job: "    permissions:\n      packages: write\n      contents: read\n", step: "- run: npm ci" }), [
    "job build holds packages and runs npm",
  ]);
  assert.deepEqual(problems({ top: "permissions:\n  contents: write\n", step: "- run: npm ci" }), [
    'the workflow grants {"contents":"write"} to every job instead of contents: read',
    "job build holds contents and runs npm",
  ]);
  assert.deepEqual(problems({ top: "permissions: write-all\n", step: "- run: npm ci" }), [
    'the workflow grants "write-all" to every job instead of contents: read',
    "job build holds write-all and runs npm",
  ]);
  assert.deepEqual(problems({ top: "", step: "- run: npm ci" }), [
    "the workflow declares no permissions",
    "job build holds write-all and runs npm",
  ]);
  assert.deepEqual(problems({ top: "permissions:\n  actions: write\n  contents: read\n" }), [
    'the workflow grants {"actions":"write","contents":"read"} to every job instead of contents: read',
  ]);
  for (const [label, text] of [
    ["a tab", workflow().replace("    steps:", "\tsteps:")],
    ["an anchor", workflow({ step: "- run: &install npm ci" })],
    ["a flow mapping", workflow({ step: "- with: { persist-credentials: true }\n        uses: actions/checkout@v5" })],
    ["an inline comment", workflow({ step: "- run: npm ci # install" })],
    ["a quoted escape", workflow({ step: '- run: "npm ci \\"x\\""' })],
    ["a reusable workflow", workflow().replace(/    steps:[\s\S]*$/, "    uses: ./.github/workflows/other.yml\n")],
    ["a local action", workflow({ step: "- uses: ./.github/actions/build" })],
    ["a step without a command", workflow({ step: "- name: nothing" })],
    ["an empty job permissions key", workflow({ job: "    permissions:\n" })],
    ["a duplicate key", workflow({ job: write + write })],
    ["an unknown permission level", workflow({ job: "    permissions:\n      contents: admin\n" })],
    ["a list where a job is expected", workflow().replace("  build:\n", "  - build\n")],
    ["a continued plain value", workflow({ step: "- run: npm\n          ci" })],
  ])
    assert.throws(() => audit(text, "sample.yml"), /sample\.yml/, label);
});

test("desktop builds hand their installers to one upload job that alone writes them to the release", () => {
  const { jobs } = audit(source("publish.yml"), "publish.yml").workflow;
  const publishing = "needs.prepare.outputs.publish == 'true'";
  assert.deepEqual(jobs.desktop.permissions, { contents: "read" });
  assert.doesNotMatch(JSON.stringify(jobs.desktop), /github\.token|GITHUB_TOKEN|GH_TOKEN|gh release/);
  const handOff = jobs.desktop.steps.findIndex((step) => /^actions\/upload-artifact@/.test(step.uses ?? ""));
  assert.equal(handOff, jobs.desktop.steps.findIndex((step) => step.name === "Collect installers") + 1);
  assert.ok(handOff > jobs.desktop.steps.findLastIndex((step) => /^(Verify|Install Windows package)/.test(step.name ?? "")));
  assert.equal(jobs.desktop.steps[handOff].if, publishing);
  assert.deepEqual(jobs.desktop.steps[handOff].with, {
    name: "desktop-${{ matrix.name }}",
    path: "release-assets",
    "if-no-files-found": "error",
    overwrite: "true",
    "retention-days": "1",
    "compression-level": "0",
  });
  assert.deepEqual(
    { ...jobs.upload, steps: jobs.upload.steps.length },
    { if: publishing, needs: ["prepare", "desktop"], "runs-on": "ubuntu-24.04", permissions: { contents: "write" }, steps: 2 },
  );
  assert.deepEqual(jobs.upload.steps[0], {
    uses: jobs.desktop.steps[handOff].uses.replace("upload", "download"),
    with: { pattern: "desktop-*", path: "release-assets", "merge-multiple": "true" },
  });
  assert.equal(jobs.upload.steps[1].run, 'gh release upload "$TAG" release-assets/* --repo "$GITHUB_REPOSITORY" --clobber');
  assert.deepEqual(jobs.upload.steps[1].env, { GH_TOKEN: "${{ github.token }}", TAG: "${{ needs.prepare.outputs.tag }}" });
  assert.deepEqual(jobs.publish.needs, ["prepare", "upload"], "the release is published only after every installer was uploaded");
  assert.deepEqual(jobs.updater.needs, ["prepare", "publish"], "the updater manifest follows the published release");
  const docker = audit(source("publish-docker.yml"), "publish-docker.yml").workflow.jobs;
  assert.deepEqual(docker.docker.permissions, { contents: "read" });
  assert.deepEqual(docker.record.permissions, { contents: "write" });
});
