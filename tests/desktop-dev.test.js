import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { init } from "../packages/daemon/storage.js";
import { startDaemon, stopDaemon } from "../scripts/desktop-dev.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
test("desktop dev replaces its local daemon while retaining identity, pairing, pause and files", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arca dev-"));
  const home = path.join(root, "state"),
    runtime = path.join(root, "runtime");
  const portServer = net.createServer();
  await new Promise((resolve) => portServer.listen(0, "127.0.0.1", resolve));
  const port = portServer.address().port;
  await new Promise((resolve) => portServer.close(resolve));
  const config = init(home, { role: "replica", port });
  config.paused = true;
  config.hub = {
    id: "isolated-hub",
    url: "http://127.0.0.1:1",
    token: "test-only-credential",
  };
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify(config));
  fs.writeFileSync(path.join(config.root, "kept.txt"), "unsynced local bytes");
  fs.mkdirSync(runtime);
  (process.platform === "win32" ? fs.copyFileSync : fs.symlinkSync)(
    process.execPath,
    path.join(runtime, process.platform === "win32" ? "node.exe" : "node"),
  );
  fs.cpSync(path.join(repo, "packages"), path.join(runtime, "packages"), {
    recursive: true,
  });
  const noticeContract = path.join(
    runtime,
    "apps/desktop/src/notice-contract.js",
  );
  fs.mkdirSync(path.dirname(noticeContract), { recursive: true });
  fs.copyFileSync(
    path.join(repo, "apps/desktop/src/notice-contract.js"),
    noticeContract,
  );
  fs.writeFileSync(
    path.join(runtime, "package.json"),
    JSON.stringify({ type: "module", arcaInstallation: "desktop" }),
  );
  t.after(async () => {
    await stopDaemon(home);
    // Windows can briefly retain executable/file handles after the PID exits.
    // Yield between bounded retries; a persistent cleanup failure must still fail.
    await fs.promises.rm(root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  });
  await startDaemon(home, runtime);
  const first = fs.readFileSync(path.join(home, "daemon.lock"), "utf8");
  await stopDaemon(home);
  const cli = path.join(runtime, "packages/cli/arca.js");
  fs.appendFileSync(cli, '\nconsole.log("updated development runtime");\n');
  await startDaemon(home, runtime);
  assert.notEqual(
    fs.readFileSync(path.join(home, "daemon.lock"), "utf8"),
    first,
  );
  const saved = JSON.parse(
    fs.readFileSync(path.join(home, "config.json"), "utf8"),
  );
  assert.equal(saved.id, config.id);
  assert.deepEqual(saved.hub, config.hub);
  assert.equal(saved.paused, true);
  assert.equal(
    fs.readFileSync(path.join(config.root, "kept.txt"), "utf8"),
    "unsynced local bytes",
  );
  assert.match(
    fs.readFileSync(path.join(home, "daemon.log"), "utf8"),
    /updated development runtime/,
  );
});

test("desktop dev refuses a lock naming another process and leaves fresh installs for onboarding", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-dev-lock-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.writeFileSync(path.join(home, "daemon.lock"), String(process.pid));
  await assert.rejects(stopDaemon(home), /refusing to stop/);
  assert.equal(
    fs.readFileSync(path.join(home, "daemon.lock"), "utf8"),
    String(process.pid),
  );
  await startDaemon(home, path.join(home, "not-staged"));
  assert.equal(fs.existsSync(path.join(home, "config.json")), false);
});
