import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}
export async function stopDaemon(home, timeout = 30000) {
  const lock = path.join(home, "daemon.lock");
  if (!fs.existsSync(lock)) return;
  const pid = Number(fs.readFileSync(lock, "utf8"));
  if (!Number.isSafeInteger(pid) || pid <= 1)
    throw new Error(
      "Invalid daemon lock; refusing to stop an unknown process.",
    );
  if (!alive(pid)) {
    fs.unlinkSync(lock);
    return;
  }
  const command =
    process.platform === "win32"
      ? execFileSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-Command",
            `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CommandLine`,
          ],
          { encoding: "utf8" },
        ).trim()
      : execFileSync("ps", ["-p", String(pid), "-o", "command="], {
          encoding: "utf8",
        }).trim();
  if (
    !command.includes("arca.js") ||
    !/(?:^|\s)daemon(?:\s|$)/.test(command) ||
    ![`${"--home"} ${home}`, `--home "${home}"`].some((value) =>
      command.endsWith(value),
    )
  )
    throw new Error(
      `PID ${pid} is not the Arca daemon for this state directory; refusing to stop it.`,
    );
  console.log(`Restarting local Arca daemon (${pid})…`);
  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + timeout;
  while (alive(pid)) {
    if (Date.now() >= deadline)
      throw new Error(
        "The local daemon has not stopped yet. Wait for its active work to finish and retry.",
      );
    await sleep(100);
  }
}
function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal === "SIGINT" || signal === "SIGTERM") resolve();
      else if (code === 0) resolve();
      else
        reject(
          new Error(`${path.basename(command)} exited with ${code ?? signal}`),
        );
    });
  });
}
export async function startDaemon(home, runtime, timeout = 30000) {
  const configPath = path.join(home, "config.json");
  if (!fs.existsSync(configPath)) return; // First-run onboarding initializes it.
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const log = fs.openSync(path.join(home, "daemon.log"), "a", 0o600);
  const child = spawn(
    path.join(runtime, process.platform === "win32" ? "node.exe" : "node"),
    [path.join(runtime, "packages/cli/arca.js"), "daemon", "--home", home],
    { detached: true, stdio: ["ignore", log, log, "ipc"], windowsHide: true },
  );
  fs.closeSync(log);
  let failure,
    ready = false;
  child.on("message", (message) => {
    if (message?.type === "arca-ready") ready = true;
  });
  child.once("error", (error) => {
    failure = error;
  });
  child.unref();
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (failure) throw failure;
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(
        "The local daemon failed to start. Check daemon.log in its state directory.",
      );
    try {
      const response = await fetch(
        `http://127.0.0.1:${config.port}/v1/status`,
        {
          headers: { Authorization: `Bearer ${config.adminToken}` },
          signal: AbortSignal.timeout(1000),
        },
      );
      if (
        ready &&
        response.ok &&
        (await response.json()).id === config.id &&
        Number(fs.readFileSync(path.join(home, "daemon.lock"), "utf8")) ===
          child.pid
      ) {
        console.log("Local daemon is ready with the current checkout.");
        return;
      }
    } catch {}
    await sleep(100);
  }
  throw new Error(
    "The local daemon did not become ready. Check daemon.log before retrying.",
  );
}
async function main() {
  const home = path.resolve(
    process.env.ARCA_HOME || path.join(os.homedir(), ".arca"),
  );
  await stopDaemon(home);
  await run(process.execPath, [path.join(root, "scripts/stage-runtime.js")]);
  await startDaemon(home, path.join(root, "apps/desktop/src-tauri/runtime"));
  await run(
    process.execPath,
    [
      path.join(root, "node_modules/@tauri-apps/cli/tauri.js"),
      "dev",
      ...process.argv.slice(2),
    ],
    {
      cwd: path.join(root, "apps/desktop"),
      env: { ...process.env, ARCA_HOME: home },
    },
  );
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
