import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
const source = readFileSync(
  new URL("../apps/desktop/src/app.js", import.meta.url),
  "utf8",
);
const declaration =
  "function viewRefreshSignature" +
  source.split("function viewRefreshSignature")[1].split("\n}\n")[0] +
  "\n}";
const signature = vm.runInNewContext(`(${declaration})`);
test("folder detail ignores unrelated sync updates but reacts to its own changes", () => {
  const status = {
    phase: "syncing",
    volumes: [
      { id: "a", files: 1 },
      { id: "b", files: 2 },
    ],
    backup: { revision: 1 },
  };
  const detail = signature(status, "folders", "a");
  const list = signature(status, "folders", null);
  status.volumes[1].files++;
  status.backup.revision++;
  assert.equal(signature(status, "folders", "a"), detail);
  assert.notEqual(signature(status, "folders", null), list);
  status.volumes[0].sync = { state: "error", error: "Disk full" };
  assert.notEqual(signature(status, "folders", "a"), detail);
});
test("machines still refreshes backup and device reports; pause updates folder detail", () => {
  const status = {
    phase: "syncing",
    volumes: [],
    backup: { revision: 1 },
    devices: [],
  };
  const before = signature(status, "devices", null);
  status.backup.revision++;
  assert.notEqual(signature(status, "devices", null), before);
  const detail = signature(status, "folders", "a");
  status.phase = "paused";
  assert.notEqual(signature(status, "folders", "a"), detail);
});
