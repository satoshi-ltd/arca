import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  answers,
  imageRows,
  matchImage,
  pidAlive,
  processRunning,
  runningImages,
  watchUpdate,
} from "../packages/cli/update-watch.js";

const script = fileURLToPath(
  new URL("../packages/cli/update-watch.js", import.meta.url),
);

function world(overrides = {}) {
  let time = 0;
  const state = {
    started: [],
    cleared: 0,
    aliveUntil: 0,
    marker: () => true,
    app: () => false,
    installer: () => false,
    daemon: null,
    ...overrides,
  };
  const deps = {
    now: () => time,
    sleep: async (ms) => {
      time += ms;
    },
    alive: () => time < state.aliveUntil,
    markerExists: () => state.marker(time),
    clearMarker: () => {
      state.cleared++;
    },
    appRunning: () => state.app(time),
    installerBusy: () => state.installer(time),
    daemonAnswers: async () =>
      state.daemon ? state.daemon(time) : state.started.length > 0,
    startDaemon: () => state.started.push(time),
  };
  return { deps, state };
}

test("a failed installer that leaves Arca closed gets the daemon back and clears the marker", async () => {
  const { deps, state } = world({ aliveUntil: 10000 });
  assert.equal(await watchUpdate(deps, { appPid: 1 }), "restored");
  assert.equal(state.started.length, 1);
  assert.equal(state.cleared, 1);
  assert.ok(state.started[0] >= 10000 + 45000, "it waits for the installer to settle first");
});

test("a daemon that does not answer after the start is reported and keeps the marker", async () => {
  const { deps, state } = world({ aliveUntil: 2000, daemon: async () => false });
  assert.equal(await watchUpdate(deps, { appPid: 1 }), "start-failed");
  assert.equal(state.started.length, 1);
  assert.equal(state.cleared, 0);
});

test("a daemon that cannot even be spawned is reported without crashing the watcher", async () => {
  const { deps, state } = world({ aliveUntil: 2000 });
  deps.startDaemon = () => {
    throw new Error("daemon.log is locked");
  };
  assert.equal(await watchUpdate(deps, { appPid: 1 }), "start-failed");
  assert.equal(state.cleared, 0);
});

test("an installer that relaunches Arca is left alone", async () => {
  const cleared = world({ aliveUntil: 4000, marker: (time) => time < 20000 });
  assert.equal(await watchUpdate(cleared.deps, { appPid: 1 }), "relaunched");
  assert.deepEqual(cleared.state.started, []);
  const running = world({ aliveUntil: 4000, app: (time) => time > 12000 });
  assert.equal(await watchUpdate(running.deps, { appPid: 1 }), "relaunched");
  assert.deepEqual(running.state.started, []);
});

test("it waits while the installer is still working and restores only after it ends", async () => {
  const { deps, state } = world({
    aliveUntil: 2000,
    installer: (time) => time < 120000,
  });
  assert.equal(await watchUpdate(deps, { appPid: 1 }), "restored");
  assert.ok(state.started[0] >= 120000 + 45000);
});

test("an installer that never ends is never interrupted", async () => {
  const { deps, state } = world({ aliveUntil: 2000, installer: () => true });
  assert.equal(await watchUpdate(deps, { appPid: 1 }), "gave-up");
  assert.deepEqual(state.started, []);
});

test("Arca that never exits is never taken over and a daemon already answering is not started twice", async () => {
  const stuck = world({ aliveUntil: Infinity });
  assert.equal(await watchUpdate(stuck.deps, { appPid: 1 }), "gave-up");
  assert.deepEqual(stuck.state.started, []);
  const answering = world({ aliveUntil: 2000, daemon: async () => true });
  assert.equal(await watchUpdate(answering.deps, { appPid: 1 }), "running");
  assert.deepEqual(answering.state.started, []);
});

test("a reused process id does not keep the watcher waiting once the app image is gone", async () => {
  const { deps, state } = world({
    aliveUntil: Infinity,
    app: (time) => time < 6000,
  });
  assert.equal(await watchUpdate(deps, { appPid: 1, appExe: "Arca.exe" }), "restored");
  assert.equal(state.started.length, 1);
});

test("tasklist rows are read from CSV and localized notices are ignored", () => {
  const listing = [
    "INFORMACIÓN: no hay tareas en ejecución que coincidan con los criterios.",
    '"Arca-0.6.69-installer.exe","5120","Console","1","81,236 K"',
    '"node.exe","77","Console","1","20,000 K"',
    "",
  ].join("\r\n");
  assert.deepEqual(imageRows(listing), ["arca-0.6.69-installer.exe", "node.exe"]);
  assert.deepEqual(imageRows("INFO: No tasks are running which match the specified criteria.\r\n"), []);
});

test("image patterns match the installer name the updater writes and nothing unrelated", () => {
  const images = ["explorer.exe", "arca-0.6.69-installer.exe", "node.exe"];
  assert.equal(matchImage(images, "Arca*installer*"), true);
  assert.equal(matchImage(images, "Arca-*-installer.exe"), true);
  assert.equal(matchImage(images, "NODE.EXE"), true);
  assert.equal(matchImage(images, "Arca*setup*"), false);
  assert.equal(matchImage(images, "arca"), false);
  assert.equal(matchImage(["a.b"], "a.b"), true);
  assert.equal(matchImage(["axb"], "a.b"), false);
});

test("the real process listing finds this runner by exact name and by wildcard", () => {
  const image = path.basename(process.execPath);
  const stem = image.replace(/\.exe$/i, "");
  assert.equal(processRunning(image), true, `images seen: ${runningImages().slice(0, 60).join(", ")}`);
  assert.equal(processRunning(`${stem.slice(0, 2)}*`), true);
  assert.equal(processRunning(`*${stem.slice(-2)}*`), true);
  assert.equal(processRunning("arca*installer*"), false);
});

test("process helpers see real processes and answers means any HTTP reply", async (t) => {
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(2 ** 22 + 12345), false);
  assert.equal(processRunning(path.basename(process.argv0)), true);
  assert.equal(processRunning("arca-no-such-process.exe"), false);
  if (process.platform !== "win32") {
    const sleeper = spawn("sleep", ["5"], { stdio: "ignore" });
    t.after(() => sleeper.kill());
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(processRunning("sleep"), true);
    assert.equal(processRunning("sle*"), true);
  }
  const server = http.createServer((request, response) => {
    response.statusCode = 401;
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  assert.equal(await answers(server.address().port), true);
  const closed = http.createServer();
  await new Promise((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const port = closed.address().port;
  await new Promise((resolve) => closed.close(resolve));
  assert.equal(await answers(port, 500), false);
});

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arca-update-watch-"));
  t.after(() =>
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }),
  );
  const home = path.join(root, "state");
  fs.mkdirSync(home);
  fs.writeFileSync(
    path.join(home, "config.json"),
    JSON.stringify({ port: await freePort() }),
  );
  fs.writeFileSync(path.join(home, "restart-daemon"), "process");
  const cli = path.join(root, "fake-cli.mjs");
  fs.writeFileSync(
    cli,
    [
      'import fs from "node:fs";',
      'import http from "node:http";',
      'import path from "node:path";',
      "const home = process.argv[4];",
      'const port = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8")).port;',
      'fs.writeFileSync(path.join(home, "daemon-started"), process.argv.slice(2).join(" "));',
      'http.createServer((request, response) => response.end()).listen(port, "127.0.0.1", () => setTimeout(() => process.exit(0), 1200));',
    ].join("\n"),
  );
  return { root, home, cli };
}

function run(options) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, JSON.stringify(options)], {
      stdio: "ignore",
    });
    child.on("exit", (code) => resolve(code));
  });
}

test("simulated failure: Arca exits, the installer fails and the watcher starts the daemon", async (t) => {
  const { root, home, cli } = await fixture(t);
  const app = spawn(process.execPath, ["-e", "setTimeout(()=>{},400)"], {
    stdio: "ignore",
  });
  const cleanup = path.join(root, "copy");
  fs.mkdirSync(cleanup);
  const code = await run({
    appPid: app.pid,
    home,
    node: process.execPath,
    cli,
    installerNames: ["arca-no-such-installer*"],
    pollMs: 50,
    settleMs: 300,
    startWaitMs: 5000,
    cleanupDir: process.platform === "win32" ? undefined : cleanup,
  });
  assert.equal(code, 0);
  assert.equal(fs.readFileSync(path.join(home, "daemon-started"), "utf8"), `daemon --home ${home}`);
  assert.match(fs.readFileSync(path.join(home, "update-watch.log"), "utf8"), / restored\n$/);
  assert.equal(fs.existsSync(path.join(home, "restart-daemon")), false, "the marker goes once the daemon answers");
  if (process.platform !== "win32") assert.equal(fs.existsSync(cleanup), false, "the temporary copy is removed");
});

test("simulated success: the relaunched Arca clears the marker and the watcher stays out of the way", async (t) => {
  const { home, cli } = await fixture(t);
  const app = spawn(process.execPath, ["-e", "setTimeout(()=>{},300)"], {
    stdio: "ignore",
  });
  setTimeout(() => fs.rmSync(path.join(home, "restart-daemon"), { force: true }), 700);
  const code = await run({
    appPid: app.pid,
    home,
    node: process.execPath,
    cli,
    installerNames: ["arca-no-such-installer*"],
    pollMs: 50,
    settleMs: 5000,
  });
  assert.equal(code, 0);
  assert.equal(fs.existsSync(path.join(home, "daemon-started")), false);
  assert.match(fs.readFileSync(path.join(home, "update-watch.log"), "utf8"), / relaunched\n$/);
});

test("the desktop update flow starts the watcher before the installer, names the installer it writes and cancels on failure", () => {
  const main = fs.readFileSync(
    new URL("../apps/desktop/src-tauri/src/main.rs", import.meta.url),
    "utf8",
  );
  const flow = main.slice(main.indexOf("async fn install_update"));
  assert.ok(flow.indexOf("start_update_watcher(&app)") > 0);
  assert.ok(flow.indexOf("start_update_watcher(&app)") < flow.indexOf("update.install(bytes)"));
  assert.match(flow, /if cfg!\(windows\) && \(service \|\| running\)/);
  assert.match(flow, /if let Err\(error\) = update\.install\(bytes\) \{\s+if let Some\(watcher\) = watcher \{\s+watcher\.cancel\(\);/);
  assert.match(main, /with_file_name\("update-watch\.js"\)/);
  assert.match(main, /"installerNames": \[format!\("\{\}\*installer\*", app\.package_info\(\)\.name\)\]/);
  assert.match(main, /fn sweep_update_watchers/);
  assert.match(main.slice(main.indexOf("async fn bootstrap")), /^[\s\S]{0,200}sweep_update_watchers\(\);/);
});
