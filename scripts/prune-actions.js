import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

const DAY = 86400000;

export class GhError extends Error {}

function realGh(args) {
  try {
    return execFileSync("gh", ["api", ...args], {
      encoding: "utf8",
      maxBuffer: 1 << 28,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new GhError(String(error.stderr || error.message).trim());
  }
}

const started = (run) => Date.parse(run.run_started_at || run.created_at);

export function selectRuns(runs, keep, minAgeDays, now) {
  const cutoff = now - minAgeDays * DAY;
  const byWorkflow = new Map();
  for (const run of runs) {
    if (!byWorkflow.has(run.workflow_id)) byWorkflow.set(run.workflow_id, []);
    byWorkflow.get(run.workflow_id).push(run);
  }
  const doomed = [];
  for (const rows of byWorkflow.values()) {
    rows.sort((a, b) => started(b) - started(a));
    for (const run of rows.slice(keep))
      if (run.status === "completed" && started(run) < cutoff) doomed.push(run.id);
  }
  return doomed;
}

export function selectArtifacts(artifacts, minAgeDays, now) {
  const cutoff = now - minAgeDays * DAY;
  return artifacts
    .filter((item) => Date.parse(item.created_at) < cutoff)
    .map((item) => item.id);
}

function listItems(gh, path, collection, fields) {
  const output = gh([
    "--paginate",
    `${path}?per_page=100`,
    "--jq",
    `.${collection}[] | {${fields}} | tojson`,
  ]);
  return output
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function remove(gh, path, error) {
  try {
    gh(["-X", "DELETE", path]);
  } catch (failure) {
    if (failure.message.includes("HTTP 404")) return true;
    error(`cannot delete ${path}: ${failure.message}`);
    return false;
  }
  return true;
}

function resolveRepository(explicit) {
  const repository = explicit || process.env.GITHUB_REPOSITORY;
  if (repository) return repository;
  try {
    return execFileSync("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], {
      encoding: "utf8",
    }).trim();
  } catch {
    throw new Error("cannot resolve the repository: pass --repo owner/name");
  }
}

export function main(
  argv = process.argv.slice(2),
  { gh = realGh, now = Date.now(), log = console.log, error = console.error } = {},
) {
  const { values } = parseArgs({
    args: argv,
    options: {
      repo: { type: "string" },
      keep: { type: "string", default: "10" },
      "min-age-days": { type: "string", default: "7" },
      apply: { type: "boolean", default: false },
    },
  });
  if (!/^\d+$/.test(values.keep))
    throw new Error("--keep must be a non-negative integer");
  if (!/^\d+(\.\d+)?$/.test(values["min-age-days"]))
    throw new Error("--min-age-days must be a non-negative number");
  const keep = Number(values.keep);
  const minAge = Number(values["min-age-days"]);

  const base = `repos/${resolveRepository(values.repo)}/actions`;
  const runs = listItems(gh, `${base}/runs`, "workflow_runs", "id, workflow_id, status, created_at, run_started_at");
  const artifacts = listItems(gh, `${base}/artifacts`, "artifacts", "id, created_at");
  const doomedRuns = selectRuns(runs, keep, minAge, now);
  const doomedArtifacts = selectArtifacts(artifacts, minAge, now);

  let deletedRuns = 0;
  let deletedArtifacts = 0;
  if (values.apply) {
    deletedRuns = doomedRuns.filter((id) => remove(gh, `${base}/runs/${id}`, error)).length;
    deletedArtifacts = doomedArtifacts.filter((id) => remove(gh, `${base}/artifacts/${id}`, error)).length;
  }
  const mode = values.apply ? "deleted" : "would delete";
  log(`runs: ${mode} ${values.apply ? deletedRuns : doomedRuns.length} of ${runs.length}`);
  log(`artifacts: ${mode} ${values.apply ? deletedArtifacts : doomedArtifacts.length} of ${artifacts.length}`);
  const failed = doomedRuns.length - deletedRuns + doomedArtifacts.length - deletedArtifacts;
  return values.apply && failed ? 1 : 0;
}

const entry = process.argv[1] && fs.realpathSync(process.argv[1]);
if (entry && import.meta.url === pathToFileURL(entry).href) {
  try {
    process.exitCode = main();
  } catch (failure) {
    console.error(failure.message);
    process.exitCode = 2;
  }
}
