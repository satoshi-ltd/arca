import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtime = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(
      root,
      "apps/desktop/src-tauri/target/release/bundle/macos/Arca.app/Contents/Resources/runtime",
    );
const node = path.join(
  runtime,
  process.platform === "win32" ? "node.exe" : "node",
);
const cli = path.join(runtime, "packages/cli/arca.js");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-bundle-"));
let daemon;
try {
  const architecture = spawnSync(
    node,
    ["-p", 'process.platform + "/" + process.arch'],
    { encoding: "utf8" },
  );
  if (architecture.status !== 0)
    throw new Error(
      `Packaged Node could not start (${architecture.error?.code || architecture.signal || architecture.status}): ${architecture.stderr?.trim() || "no diagnostic output"}`,
    );
  if (architecture.stdout.trim() !== `${process.platform}/${process.arch}`)
    throw new Error("Packaged Node does not match the runner architecture");
  if (!fs.existsSync(path.join(runtime, "LICENSE.node")))
    throw new Error("Packaged Node license missing");
  const initialized = spawnSync(
    node,
    [cli, "init", "--home", home, "--port", "0"],
    { encoding: "utf8" },
  );
  if (initialized.status !== 0) throw new Error(initialized.stderr);
  daemon = spawn(node, [cli, "daemon", "--home", home], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const port = await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Bundled daemon startup timed out")),
      10000,
    );
    daemon.stdout.on("data", (data) => {
      const match = /listening on .*:(\d+)/.exec(data.toString());
      if (match) {
        clearTimeout(timeout);
        resolve(Number(match[1]));
      }
    });
    daemon.on("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Bundled daemon exited: ${code}`));
    });
  });
  const config = JSON.parse(fs.readFileSync(path.join(home, "config.json")));
  const response = await fetch(`http://127.0.0.1:${port}/v1/status`, {
    headers: { Authorization: `Bearer ${config.adminToken}` },
  });
  if (!response.ok || (await response.json()).role !== "hub")
    throw new Error("Bundled daemon API failed");
  for (const route of [
    "/",
    "/app.js",
    "/auth/login",
    "/v1/web-sessions/revoke",
  ]) {
    if ((await fetch(`http://127.0.0.1:${port}${route}`)).status !== 404)
      throw new Error(`Bundled desktop exposes web access: ${route}`);
  }
  const webCode = spawnSync(node, [cli, "web-code", "--home", home], {
    encoding: "utf8",
  });
  if (webCode.status === 0)
    throw new Error("Bundled desktop issued a web code");
  console.log(
    "Desktop web disabled; bundled official Node, CLI initialization, daemon startup and authenticated API: OK",
  );
} finally {
  if (daemon && daemon.exitCode === null) {
    daemon.kill("SIGTERM");
    await new Promise((resolve) => daemon.once("exit", resolve));
  }
  fs.rmSync(home, { recursive: true, force: true });
}
