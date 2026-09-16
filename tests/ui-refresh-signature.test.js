import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
const source = readFileSync(
  new URL("../apps/desktop/src/app.js", import.meta.url),
  "utf8",
);
function loadSignature(source) {
  const declaration =
    "function viewRefreshSignature" +
    source.split("function viewRefreshSignature")[1].split(/\r?\n}\r?\n/)[0] +
    "\n}";
  return vm.runInNewContext(`(${declaration})`);
}
// Exercise both checkout formats on every runner, including macOS/Linux.
for (const ending of ["\n", "\r\n"]) {
  const signature = loadSignature(source.replace(/\r?\n/g, ending));
  test(`folder detail ignores unrelated sync updates but reacts to its own changes (${ending.length === 1 ? "LF" : "CRLF"})`, () => {
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
  test(`machines still refreshes backup and device reports; pause updates folder detail (${ending.length === 1 ? "LF" : "CRLF"})`, () => {
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
}
