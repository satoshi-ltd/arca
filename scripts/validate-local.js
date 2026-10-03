import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { testConcurrency } from "./test-concurrency.js";
import { fingerprint, writeStamp } from "./validated-stamp.js";

const repository = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

export const gitFreeEnv = () =>
  Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));

export function cleanCopy(source, destination) {
  const env = gitFreeEnv();
  execFileSync("git", ["init", "-q"], { cwd: destination, env });
  const listed = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: source,
    env,
    maxBuffer: 1 << 30,
  });
  for (const file of new Set(listed.toString().split("\0").filter(Boolean))) {
    const from = path.join(source, file);
    const stat = fs.lstatSync(from, { throwIfNoEntry: false });
    if (!stat) continue;
    const to = path.join(destination, file);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (stat.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(from), to);
    else if (stat.isFile()) fs.copyFileSync(from, to);
  }
}

function main() {
  const required = fs.readFileSync(path.join(repository, ".node-version"), "utf8").trim();
  if (process.version !== `v${required}`) {
    console.error(`CI runs Node ${required}; this is ${process.version}. Run: npx -y node@${required} scripts/validate-local.js`);
    process.exit(1);
  }
  const validated = fingerprint(repository);
  const clean = fs.mkdtempSync(path.join(os.tmpdir(), "arca-validate-"));
  cleanCopy(repository, clean);
  const copied = fingerprint(clean) === validated;
  const shell = process.platform === "win32";
  const run = (command, args) => {
    const result = spawnSync(command, args, { cwd: clean, encoding: "utf8", shell, maxBuffer: 1 << 30, env: gitFreeEnv() });
    return { ok: result.status === 0, output: `${result.stdout}${result.stderr}` };
  };
  const step = (label, command, args) => {
    const result = run(command, args);
    if (!result.ok) {
      console.error(`${label} failed in ${clean}\n${result.output.slice(-4000)}`);
      process.exit(1);
    }
    return result.output;
  };
  step("npm ci", "npm", ["ci", "--no-audit", "--no-fund"]);
  console.log(step("Version agreement", "node", ["scripts/check-release.js"]).trim());
  const tests = fs
    .readdirSync(path.join(clean, "tests"))
    .filter((name) => name.endsWith(".test.js"))
    .map((name) => path.join("tests", name));
  const mobileTooling = fs
    .readdirSync(path.join(clean, "apps/mobile/scripts"))
    .filter((name) => name.endsWith(".test.mjs"))
    .map((name) => path.join("apps/mobile/scripts", name));
  const suites = [
    ["CI suite", tests.filter((name) => process.platform === "linux" || !path.basename(name).startsWith("mobile-"))],
    ...(process.platform === "linux" ? [] : [["Mobile source suite", tests.filter((name) => path.basename(name).startsWith("mobile-"))]]),
    ["Mobile build tooling", mobileTooling],
  ];
  let failed = false;
  for (const [label, files] of suites) {
    const result = run("node", ["--test", `--test-concurrency=${testConcurrency()}`, "--test-reporter=tap", "--test-timeout=120000", ...files]);
    const summary = result.output.match(/^# (tests|pass|fail|cancelled|skipped) \d+$/gm) || [];
    console.log(`${label}: ${summary.map((line) => line.slice(2)).join(", ")}`);
    if (!result.ok) {
      failed = true;
      console.error(result.output.split("\n").filter((line) => /^not ok|^\s+(error|location):/.test(line)).join("\n"));
    }
  }
  if (failed) {
    console.error(`Failures kept in ${clean}`);
    process.exit(1);
  }
  fs.rmSync(clean, { recursive: true, force: true });
  if (copied && fingerprint(repository) === validated) writeStamp(repository, validated);
  else console.error("Files changed while validating, so no stamp was written; the next push runs the suite.");
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) main();
