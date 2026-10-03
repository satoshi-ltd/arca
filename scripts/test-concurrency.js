import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

export function testConcurrency(env = process.env, cores = os.availableParallelism()) {
  const requested = /^\d+$/.test(env.ARCA_TEST_CONCURRENCY ?? "")
    ? Number(env.ARCA_TEST_CONCURRENCY)
    : 0;
  if (requested >= 1) return requested;
  return Math.max(1, Math.floor(cores / 2));
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)))
  console.log(String(testConcurrency()));
