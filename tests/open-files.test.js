import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileHeld, holdingProcess } from "../packages/daemon/open-files.js";

const execute = promisify(execFile);

test("a process keeps its file held until it has exited, not just until its promise settles", async () => {
  const file = path.join(os.tmpdir(), "arca-held-by-a-process.mkv");
  const controller = new AbortController();
  const script = "process.on('SIGTERM', () => {}); setTimeout(() => {}, 400);";
  const running = holdingProcess(file, () => execute(process.execPath, ["-e", script], { signal: controller.signal }));
  assert.equal(fileHeld(file), true);
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(running);
  if (process.platform !== "win32") assert.equal(fileHeld(file), true, "the aborted process is still running and still holds it");
  for (let wait = 0; wait < 100 && fileHeld(file); wait++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fileHeld(file), false, "it is released once the process exits");
});

test("a process that cannot start releases its file at once", async () => {
  const file = path.join(os.tmpdir(), "arca-never-opened.mkv");
  await assert.rejects(holdingProcess(file, () => execute(path.join(os.tmpdir(), "arca-missing-binary"), [])));
  assert.equal(fileHeld(file), false);
});
