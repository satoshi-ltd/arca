import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export async function watchUpdate(deps, options) {
  const {
    appPid,
    appExe,
    pollMs = 2000,
    settleMs = 45000,
    installerCapMs = 600000,
    appExitCapMs = 600000,
    startWaitMs = 20000,
  } = options;
  const begun = deps.now();
  while (deps.alive(appPid) && (!appExe || deps.appRunning())) {
    if (deps.now() - begun > appExitCapMs) return "gave-up";
    await deps.sleep(pollMs);
  }
  const exited = deps.now();
  let quietSince = null;
  for (;;) {
    if (!deps.markerExists() || deps.appRunning()) return "relaunched";
    if (deps.installerBusy()) {
      quietSince = null;
      if (deps.now() - exited > installerCapMs) return "gave-up";
    } else if (quietSince === null) quietSince = deps.now();
    else if (deps.now() - quietSince >= settleMs) break;
    await deps.sleep(pollMs);
  }
  if (await deps.daemonAnswers()) return "running";
  try {
    deps.startDaemon();
  } catch {
    return "start-failed";
  }
  const started = deps.now();
  while (deps.now() - started < startWaitMs) {
    await deps.sleep(pollMs);
    if (await deps.daemonAnswers()) {
      deps.clearMarker();
      return "restored";
    }
  }
  return "start-failed";
}

export const imageRows = (output) =>
  output
    .split(/\r?\n/)
    .filter((line) => line.startsWith('"'))
    .map((line) => line.split('","')[0].replace(/^"/, "").toLowerCase());

export function matchImage(images, pattern) {
  const wanted = pattern.toLowerCase();
  if (!wanted.includes("*")) return images.includes(wanted);
  const expression = new RegExp(
    `^${wanted
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
  );
  return images.some((image) => expression.test(image));
}

export function runningImages(platform = process.platform) {
  if (platform === "win32") {
    const listing = spawnSync("tasklist", ["/FO", "CSV", "/NH"], {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (listing.error || listing.status !== 0)
      throw new Error("Could not list the running processes");
    return imageRows(listing.stdout);
  }
  const lines = [];
  for (const column of ["comm=", "args="]) {
    const listing = spawnSync("ps", ["-A", "-o", column], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    if (listing.error || listing.status !== 0)
      throw new Error("Could not list the running processes");
    for (const line of listing.stdout.split("\n")) {
      const first = column === "args=" ? line.trim().split(/\s+/)[0] : line.trim();
      if (first) lines.push(path.basename(first).toLowerCase());
    }
  }
  return lines;
}

export function processRunning(name, platform = process.platform) {
  return matchImage(runningImages(platform), name);
}

export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

export function answers(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const request = http.get(
      { host: "127.0.0.1", port, path: "/v1/status", timeout: timeoutMs },
      (response) => {
        response.resume();
        resolve(true);
      },
    );
    request.on("timeout", () => {
      request.destroy();
      resolve(false);
    });
    request.on("error", () => resolve(false));
  });
}

export function realDeps({ home, node, cli, appExe, installerNames }) {
  const marker = path.join(home, "restart-daemon");
  return {
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    alive: pidAlive,
    markerExists: () => fs.existsSync(marker),
    clearMarker: () => fs.rmSync(marker, { force: true }),
    appRunning: () => {
      if (!appExe) return false;
      try {
        return processRunning(appExe);
      } catch {
        return false;
      }
    },
    installerBusy: () => {
      try {
        return installerNames.some((name) => processRunning(name));
      } catch {
        return true;
      }
    },
    daemonAnswers: async () => {
      try {
        const port = JSON.parse(
          fs.readFileSync(path.join(home, "config.json"), "utf8"),
        ).port;
        return Number.isInteger(port) && (await answers(port));
      } catch {
        return false;
      }
    },
    startDaemon: () => {
      const log = fs.openSync(path.join(home, "daemon.log"), "a");
      spawn(node, [cli, "daemon", "--home", home], {
        detached: true,
        stdio: ["ignore", log, log],
        windowsHide: true,
      }).unref();
    },
  };
}

function removeDirectory(directory) {
  if (process.platform === "win32") {
    spawn(
      "cmd.exe",
      [
        "/d",
        "/s",
        "/c",
        `"ping -n 4 127.0.0.1 >nul & rmdir /s /q "${directory}""`,
      ],
      {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        windowsVerbatimArguments: true,
      },
    ).unref();
    return;
  }
  fs.rmSync(directory, { recursive: true, force: true });
}

export async function main(argument) {
  const options = JSON.parse(argument);
  const outcome = await watchUpdate(
    realDeps({
      ...options,
      installerNames: options.installerNames || ["Arca*installer*"],
    }),
    options,
  );
  try {
    fs.appendFileSync(
      path.join(options.home, "update-watch.log"),
      `${new Date().toISOString()} ${outcome}\n`,
    );
  } catch {}
  if (options.cleanupDir) removeDirectory(options.cleanupDir);
  return outcome;
}

if (
  process.argv[1] &&
  fs.realpathSync(process.argv[1]) ===
    fs.realpathSync(fileURLToPath(import.meta.url))
)
  await main(process.argv[2]);
