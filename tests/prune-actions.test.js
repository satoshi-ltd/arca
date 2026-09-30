import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GhError, main, selectArtifacts, selectRuns } from "../scripts/prune-actions.js";

const repository = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const NOW = Date.UTC(2026, 8, 30, 12);
const stamp = (daysAgo) => new Date(NOW - daysAgo * 86400000).toISOString();
const run = (id, workflow, daysAgo, status = "completed") => ({
  id,
  workflow_id: workflow,
  status,
  created_at: stamp(daysAgo),
});
const sorted = (values) => [...values].sort((a, b) => a - b);

test("runs keep the newest per workflow and anything younger than the age floor", () => {
  const runs = [
    ...Array.from({ length: 15 }, (_, i) => run(i + 1, 1, i + 1)),
    ...Array.from({ length: 3 }, (_, i) => run(101 + i, 2, i + 1)),
  ];
  assert.deepEqual(sorted(selectRuns(runs, 10, 7, NOW)), [11, 12, 13, 14, 15]);
});

test("selection does not depend on the order of the listing", () => {
  const runs = Array.from({ length: 15 }, (_, i) => run(i + 1, 1, i + 1));
  const shuffled = [...runs.slice(7), ...runs.slice(0, 7).reverse()];
  assert.deepEqual(sorted(selectRuns(shuffled, 10, 7, NOW)), [11, 12, 13, 14, 15]);
});

test("a run exactly at the age floor is kept", () => {
  assert.deepEqual(selectRuns([run(1, 1, 1), run(2, 1, 7)], 1, 7, NOW), []);
});

test("a rerun counts from when it started again", () => {
  const old = run(1, 1, 30);
  old.run_started_at = stamp(1);
  assert.deepEqual(selectRuns([run(2, 1, 0.5), old], 1, 7, NOW), []);
});

test("old runs inside the newest ten survive, and so do young runs beyond them", () => {
  assert.deepEqual(selectRuns(Array.from({ length: 5 }, (_, i) => run(i + 1, 1, 30 + i)), 10, 7, NOW), []);
  assert.deepEqual(selectRuns(Array.from({ length: 15 }, (_, i) => run(i + 1, 1, (i + 1) / 10)), 10, 7, NOW), []);
});

test("runs that are still going are never selected", () => {
  const runs = [run(1, 1, 1), ...[2, 3, 4, 5].map((id) => run(id, 1, 20 + id, "in_progress"))];
  assert.deepEqual(selectRuns(runs, 1, 7, NOW), []);
});

test("artifacts older than the age floor are selected", () => {
  const artifacts = [
    { id: 1, created_at: stamp(1) },
    { id: 2, created_at: stamp(6.9) },
    { id: 3, created_at: stamp(7.1) },
    { id: 4, created_at: stamp(90) },
  ];
  assert.deepEqual(selectArtifacts(artifacts, 7, NOW), [3, 4]);
});

function fakeGh({ runs, artifacts, missing = [], broken = [] }) {
  const gh = (args) => {
    if (args[0] === "-X") {
      const target = args[2];
      if (missing.includes(target)) throw new GhError("gh: Not Found (HTTP 404)");
      if (broken.includes(target)) throw new GhError("gh: Forbidden (HTTP 403)");
      gh.deleted.push(target);
      return "";
    }
    const rows = args[1].includes("/runs?") ? runs : artifacts;
    return rows.map((row) => JSON.stringify(row)).join("\n");
  };
  gh.deleted = [];
  return gh;
}

function fleet() {
  return fakeGh({
    runs: Array.from({ length: 14 }, (_, i) => run(i + 1, 1, i + 1)),
    artifacts: [
      { id: 7, created_at: stamp(30) },
      { id: 8, created_at: stamp(2) },
    ],
  });
}

function capture() {
  const out = [];
  const err = [];
  return { out, err, log: (line) => out.push(line), error: (line) => err.push(line) };
}

test("the default is a dry run that deletes nothing", () => {
  const gh = fleet();
  const io = capture();
  assert.equal(main(["--repo", "o/r"], { gh, now: NOW, ...io }), 0);
  assert.deepEqual(gh.deleted, []);
  assert.deepEqual(io.out, ["runs: would delete 4 of 14", "artifacts: would delete 1 of 2"]);
});

test("apply deletes the selected runs and artifacts", () => {
  const gh = fleet();
  const io = capture();
  assert.equal(main(["--repo", "o/r", "--apply"], { gh, now: NOW, ...io }), 0);
  assert.deepEqual(
    [...gh.deleted].sort(),
    [
      ...[11, 12, 13, 14].map((id) => `repos/o/r/actions/runs/${id}`),
      "repos/o/r/actions/artifacts/7",
    ].sort(),
  );
  assert.equal(io.out[0], "runs: deleted 4 of 14");
});

test("an item that is already gone counts as done", () => {
  const gh = fakeGh({
    runs: Array.from({ length: 14 }, (_, i) => run(i + 1, 1, i + 1)),
    artifacts: [],
    missing: ["repos/o/r/actions/runs/11"],
  });
  assert.equal(main(["--repo", "o/r", "--apply"], { gh, now: NOW, ...capture() }), 0);
  assert.deepEqual(sorted(gh.deleted.map((target) => Number(target.split("/").at(-1)))), [12, 13, 14]);
});

test("a refused deletion fails the run and is reported", () => {
  const io = capture();
  const gh = fakeGh({
    runs: Array.from({ length: 14 }, (_, i) => run(i + 1, 1, i + 1)),
    artifacts: [{ id: 7, created_at: stamp(30) }],
    broken: ["repos/o/r/actions/runs/12"],
  });
  assert.equal(main(["--repo", "o/r", "--apply"], { gh, now: NOW, ...io }), 1);
  assert.equal(io.out[0], "runs: deleted 3 of 14");
  assert.match(io.err[0], /cannot delete repos\/o\/r\/actions\/runs\/12/);
});

test("negative or malformed limits are refused", () => {
  for (const bad of ["--keep=-1", "--keep=many", "--keep=1.5", "--keep=", "--keep= ", "--min-age-days=-2", "--min-age-days=soon", "--min-age-days=", "--min-age-days= "])
    assert.throws(
      () => main(["--repo", "o/r", bad], { gh: fleet(), now: NOW, ...capture() }),
      /non-negative/,
      bad,
    );
});

test("runs with an unusable date or a status other than completed are never selected", () => {
  const broken = { id: 1, workflow_id: 1, status: "completed", created_at: "not a date" };
  const pending = ["queued", "waiting", "pending", "requested", "action_required"].map((status, i) =>
    run(10 + i, 1, 30 + i, status),
  );
  assert.deepEqual(selectRuns([run(2, 1, 1), broken, ...pending], 1, 7, NOW), []);
});

test("an artifact that cannot be deleted fails the run", () => {
  const gh = fakeGh({
    runs: [],
    artifacts: [{ id: 7, created_at: stamp(30) }],
    broken: ["repos/o/r/actions/artifacts/7"],
  });
  const io = capture();
  assert.equal(main(["--repo", "o/r", "--apply"], { gh, now: NOW, ...io }), 1);
  assert.equal(io.out[1], "artifacts: deleted 0 of 1");
});

test("started from the command line it runs main, also through a symlinked directory", (t) => {
  const script = path.join(repository, "scripts", "prune-actions.js");
  const direct = spawnSync(process.execPath, [script, "--keep=-1"], { encoding: "utf8" });
  assert.equal(direct.status, 2, "a silent no-op would exit 0");
  assert.match(direct.stderr, /non-negative/);
  if (process.platform === "win32") return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arca-prune-link-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.symlinkSync(path.join(repository, "scripts"), path.join(root, "linked"));
  const linked = spawnSync(process.execPath, [path.join(root, "linked", "prune-actions.js"), "--keep=-1"], { encoding: "utf8" });
  assert.equal(linked.status, 2);
  assert.match(linked.stderr, /non-negative/);
});

test("the weekly workflow prunes for real on schedule and only lists on a manual dry run", () => {
  const workflow = fs
    .readFileSync(path.join(repository, ".github", "workflows", "prune-actions.yml"), "utf8")
    .replace(/\r\n/g, "\n");
  assert.match(workflow, /schedule:\n +- cron: "17 3 \* \* 1"/);
  assert.match(workflow, /workflow_dispatch:\n +inputs:\n +dry_run:/);
  assert.match(workflow, /permissions:\n +actions: write\n +contents: read/);
  assert.match(workflow, /DRY_RUN: \$\{\{ inputs\.dry_run \}\}/);
  assert.match(workflow, /flag="--apply"\n +if \[ "\$DRY_RUN" = "true" \]; then flag=""; fi\n +node scripts\/prune-actions\.js \$flag/);
  assert.match(workflow, /cancel-in-progress: false/);
});
