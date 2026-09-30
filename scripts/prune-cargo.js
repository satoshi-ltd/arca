import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const gigabytes = (value) => `${(value / 1024 ** 3).toFixed(1)} GB`;

function bytes(directory) {
  if (process.platform !== "win32") {
    const total = Number(spawnSync("du", ["-sk", directory], { encoding: "utf8" }).stdout?.split(/\s/)[0]);
    return Number.isFinite(total) ? total * 1024 : null;
  }
  let total = 0;
  for (const entry of fs.readdirSync(directory, { recursive: true, withFileTypes: true }))
    if (entry.isFile())
      total += fs.statSync(path.join(entry.parentPath, entry.name), { throwIfNoEntry: false })?.size || 0;
  return total;
}

export function budgetFromEnvironment(value = process.env.ARCA_CARGO_BUDGET_GB) {
  const parsed = Number(value);
  if (value === undefined || value === "") return 10 * 1024 ** 3;
  if (Number.isFinite(parsed) && parsed > 0) return parsed * 1024 ** 3;
  console.warn(`Ignoring ARCA_CARGO_BUDGET_GB=${JSON.stringify(value)}; using 10 GB.`);
  return 10 * 1024 ** 3;
}

// Best effort: a measuring or cleaning failure must never stop a desktop start or build.
export function pruneCargo({
  target = path.join(root, "apps/desktop/src-tauri/target"),
  budget = budgetFromEnvironment(),
} = {}) {
  try {
    if (!fs.existsSync(target)) return "kept";
    const size = bytes(target);
    if (size === null || size <= budget) return "kept";
    for (const profile of fs.readdirSync(target, { withFileTypes: true }))
      if (profile.isDirectory())
        fs.rmSync(path.join(target, profile.name, "incremental"), { recursive: true, force: true });
    const remaining = bytes(target);
    if (remaining !== null && remaining <= budget) {
      console.log(`Cargo cache was ${gigabytes(size)}; dropped incremental caches, now ${gigabytes(remaining)} (budget ${gigabytes(budget)}, ARCA_CARGO_BUDGET_GB).`);
      return "incremental";
    }
    console.log(`Cargo cache is still over the ${gigabytes(budget)} budget (ARCA_CARGO_BUDGET_GB) after dropping incremental caches; removing ${target}.`);
    fs.rmSync(target, { recursive: true, force: true });
    return "cleaned";
  } catch (error) {
    console.warn(`Skipped Cargo cache pruning: ${error.message}`);
    return "skipped";
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) pruneCargo();
