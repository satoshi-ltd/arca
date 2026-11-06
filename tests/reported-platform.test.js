import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { reportedPlatform } from "../packages/daemon/platform.js";
import { machineReport } from "../packages/daemon/machines.js";
import { Network } from "../packages/daemon/network.js";

const daemon = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "packages", "daemon");

test("a Linux distribution names itself through ARCA_PLATFORM", () => {
  assert.equal(reportedPlatform({ ARCA_PLATFORM: "arcaOS" }, "linux"), "arcaOS");
  assert.equal(reportedPlatform({}, "linux"), "linux");
});

test("ARCA_PLATFORM never changes macOS or Windows, whose platform drives behaviour", () => {
  assert.equal(reportedPlatform({ ARCA_PLATFORM: "arcaOS" }, "darwin"), "darwin");
  assert.equal(reportedPlatform({ ARCA_PLATFORM: "arcaOS" }, "win32"), "win32");
});

test("a malformed ARCA_PLATFORM falls back to the real platform", () => {
  for (const name of ["", " arcaOS", "a\nb", "<b>x</b>", "x".repeat(41)])
    assert.equal(reportedPlatform({ ARCA_PLATFORM: name }, "linux"), "linux");
});

test("discovery and machine reports carry the reported platform", (t) => {
  const saved = process.env.ARCA_PLATFORM;
  t.after(() => {
    if (saved === undefined) delete process.env.ARCA_PLATFORM;
    else process.env.ARCA_PLATFORM = saved;
  });
  process.env.ARCA_PLATFORM = "arcaOS";
  const expected = process.platform === "linux" ? "arcaOS" : process.platform;
  const engine = {
    status: () => ({ id: "m", name: "thinkpad", volumes: [], phase: "idle", lastSync: null, media: {} }),
    config: { id: "m", name: "thinkpad", role: "replica" },
    store: { volumes: () => [] },
  };
  assert.equal(machineReport(engine).platform, expected);
  const network = Object.create(Network.prototype);
  network.engine = engine;
  assert.equal(network.hello().platform, expected);
});

test("status reports the reported platform", () => {
  const source = fs.readFileSync(path.join(daemon, "engine.js"), "utf8");
  assert.match(source, /platform: reportedPlatform\(\),/);
  assert.doesNotMatch(source, /platform: process\.platform,/);
});
