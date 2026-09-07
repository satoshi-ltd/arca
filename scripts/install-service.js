// Explicit optional installation. Never run as part of app startup or build.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const home = path.resolve(
  process.env.ARCA_HOME || path.join(os.homedir(), ".arca"),
);
if (!fs.existsSync(path.join(home, "config.json")))
  throw new Error("Initialize Arca first");
const runtime = process.env.ARCA_RUNTIME;
const cli = runtime
  ? path.join(runtime, "packages/cli/arca.js")
  : path.join(root, "packages/cli/arca.js");
const node = runtime ? path.join(runtime, "node") : process.execPath;
const activate = process.argv.includes("--start");
function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${command} failed`);
}
if (activate && fs.existsSync(path.join(home, "daemon.lock"))) {
  const pid = Number(fs.readFileSync(path.join(home, "daemon.lock"), "utf8"));
  let running = false;
  try {
    process.kill(pid, 0);
    running = true;
  } catch (e) {
    if (e.code !== "ESRCH") throw e;
  }
  if (running)
    throw new Error(
      "Stop the manually started daemon before installing its service",
    );
}
const xml = (value) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
if (process.platform === "darwin") {
  const destination = path.join(
    os.homedir(),
    "Library/LaunchAgents/com.soyjavi.arca.daemon.plist",
  );
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(
    destination,
    `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>com.soyjavi.arca.daemon</string><key>ProgramArguments</key><array>${[node, cli, "daemon", "--home", home].map((v) => `<string>${xml(v)}</string>`).join("")}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>StandardOutPath</key><string>${xml(path.join(home, "service.log"))}</string><key>StandardErrorPath</key><string>${xml(path.join(home, "service.log"))}</string></dict></plist>`,
  );
  if (activate)
    run("launchctl", ["bootstrap", `gui/${process.getuid()}`, destination]);
  console.log(
    `Service definition written: ${destination}\nLoad after stopping any manual daemon: launchctl bootstrap gui/${process.getuid()} '${destination}'`,
  );
} else if (process.platform === "linux") {
  const quote = (value) =>
    '"' +
    value
      .replaceAll("\\", "\\\\")
      .replaceAll('"', '\\"')
      .replaceAll("%", "%%") +
    '"';
  const destination = path.join(
    os.homedir(),
    ".config/systemd/user/arca.service",
  );
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(
    destination,
    `[Unit]\nDescription=Arca personal drive\nAfter=network-online.target\n[Service]\nExecStart=${[node, cli, "daemon", "--home", home].map(quote).join(" ")}\nRestart=on-failure\nRestartSec=5\nUMask=0077\n[Install]\nWantedBy=default.target\n`,
  );
  const result = spawnSync("systemctl", ["--user", "daemon-reload"], {
    stdio: "inherit",
  });
  if (result.status !== 0) process.exitCode = 1;
  if (activate) run("systemctl", ["--user", "enable", "--now", "arca"]);
  console.log(
    "Definition written. After stopping a manual daemon: systemctl --user enable --now arca",
  );
} else
  throw new Error("Use Docker or start the daemon manually on this platform");
