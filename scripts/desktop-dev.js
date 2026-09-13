import fs from "node:fs";
import net from "node:net";
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
export async function startDaemon(
  home,
  runtime,
  timeout = 30000,
  service = null,
) {
  const configPath = path.join(home, "config.json");
  if (!fs.existsSync(configPath)) return; // First-run onboarding initializes it.
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  let child,
    failure,
    ready = Boolean(service);
  if (service)
    execFileSync("launchctl", ["bootstrap", service.domain, service.file]);
  else {
    const log = fs.openSync(path.join(home, "daemon.log"), "a", 0o600);
    child = spawn(
      path.join(runtime, process.platform === "win32" ? "node.exe" : "node"),
      [path.join(runtime, "packages/cli/arca.js"), "daemon", "--home", home],
      { detached: true, stdio: ["ignore", log, log, "ipc"], windowsHide: true },
    );
    fs.closeSync(log);
    child.on("message", (message) => {
      if (message?.type === "arca-ready") ready = true;
    });
    child.once("error", (error) => {
      failure = error;
    });
    child.unref();
  }
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (failure) throw failure;
    if (child && (child.exitCode !== null || child.signalCode !== null))
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
        (child
          ? Number(fs.readFileSync(path.join(home, "daemon.lock"), "utf8")) ===
            child.pid
          : fs.existsSync(path.join(home, "daemon.lock")))
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
export function matchingService(args, home, runtime) {
  return (
    Array.isArray(args) &&
    args.length === 5 &&
    args[0] === path.join(runtime, "node") &&
    args[1] === path.join(runtime, "packages/cli/arca.js") &&
    args[2] === "daemon" &&
    args[3] === "--home" &&
    args[4] === home
  );
}
function devService(home, runtime) {
  if (process.platform !== "darwin") return null;
  const file = path.join(
    os.homedir(),
    "Library/LaunchAgents/com.soyjavi.arca.daemon.plist",
  );
  const domain = `gui/${process.getuid()}`;
  if (!fs.existsSync(file)) return null;
  const config = JSON.parse(
    execFileSync("plutil", ["-convert", "json", "-o", "-", file], {
      encoding: "utf8",
    }),
  );
  if (!matchingService(config.ProgramArguments, home, runtime)) return null;
  try {
    execFileSync("launchctl", ["print", `${domain}/com.soyjavi.arca.daemon`], {
      stdio: "ignore",
    });
  } catch {
    return null;
  }
  return { file, domain };
}
export async function restartDevDaemon(home, runtime, stage) {
  const service = devService(home, runtime);
  if (service) {
    console.log("Updating the local daemon through its macOS service…");
    execFileSync("launchctl", [
      "bootout",
      `${service.domain}/com.soyjavi.arca.daemon`,
    ]);
  }
  try {
    await stopDaemon(home);
    await stage();
  } catch (error) {
    if (service)
      execFileSync("launchctl", ["bootstrap", service.domain, service.file]);
    throw error;
  }
  await startDaemon(home, runtime, 30000, service);
}
export function checkDevPort(port = 1425) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", (error) =>
      reject(
        new Error(
          error.code === "EADDRINUSE"
            ? `Desktop development port ${port} is already in use. Stop the other Arca/Vite dev session and retry. No daemon was restarted.`
            : `Cannot open desktop development port ${port}: ${error.message}`,
        ),
      ),
    );
    server.listen(port, "127.0.0.1", () => server.close(resolve));
  });
}
async function main() {
  await checkDevPort();
  const args = process.argv.slice(2);
  if (args.includes("--clean")) {
    // Disposable Vite output only; never state, credentials, native builds or Metro.
    for (const directory of [
      "node_modules/.vite",
      "apps/desktop/src/node_modules/.vite",
    ])
      fs.rmSync(path.join(root, directory), { recursive: true, force: true });
    console.log("Vite cache cleared.");
  }
  const home = path.resolve(
    process.env.ARCA_HOME || path.join(os.homedir(), ".arca"),
  );
  await restartDevDaemon(
    home,
    path.join(root, "apps/desktop/src-tauri/runtime"),
    () => run(process.execPath, [path.join(root, "scripts/stage-runtime.js")]),
  );
  await run(
    process.execPath,
    [
      path.join(root, "node_modules/@tauri-apps/cli/tauri.js"),
      "dev",
      ...args.filter((arg) => arg !== "--clean"),
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
