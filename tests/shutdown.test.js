import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { init } from "../packages/daemon/storage.js";
import { CONNECTION_GRACE_MS, SHUTDOWN_MS, start } from "../packages/daemon/server.js";

const repository = path.join(import.meta.dirname, "..");

function home(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arca-shutdown-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  init(root, { port: 0, name: "hub", role: "hub" });
  return root;
}

function stalledDownload(daemon, route) {
  return new Promise((resolve, reject) => {
    const request = http.get(
      { host: "127.0.0.1", port: daemon.port, path: route, headers: { Authorization: `Bearer ${daemon.engine.config.adminToken}` } },
      (response) => {
        response.pause();
        response.on("error", () => {});
        resolve({ response, ended: new Promise((done) => response.socket.once("close", done)) });
      },
    );
    request.on("error", reject);
  });
}

test("close ends within its bound despite a download that never drains and a step that never finishes", async (t) => {
  const root = home(t);
  const daemon = await start(root, { timer: false, connectionGraceMs: 200, shutdownMs: 1500 });
  const hash = "a".repeat(64);
  const object = daemon.engine.store.contentFile(hash);
  fs.mkdirSync(path.dirname(object), { recursive: true });
  const handle = fs.openSync(object, "w");
  fs.ftruncateSync(handle, 256 * 1024 * 1024);
  fs.closeSync(handle);
  const volume = daemon.engine.store.addVolume("Docs");
  daemon.engine.store.db
    .prepare("INSERT INTO pending(volume,path,row,expected) VALUES(?,?,?,?)")
    .run(volume.id, "kept.txt", JSON.stringify({ volume: volume.id, path: "kept.txt", rev: 7, hash: "b".repeat(64) }), null);
  const download = await stalledDownload(daemon, `/v1/blobs/${hash}`);
  assert.equal(download.response.statusCode, 200);
  let interrupted = 0;
  const interrupt = daemon.engine.interruptCycle.bind(daemon.engine);
  daemon.engine.interruptCycle = () => {
    interrupted++;
    interrupt();
  };
  daemon.engine.exclusive(() => new Promise(() => {}));
  const started = Date.now();
  await daemon.close();
  const took = Date.now() - started;
  assert.ok(took >= 1400 && took < 2500, `close took ${took} ms`);
  assert.equal(interrupted, 1, "close asks the running step to yield");
  download.response.resume();
  await download.ended;
  assert.equal(fs.existsSync(path.join(root, "daemon.lock")), false, "the state lock is released");
  const db = new DatabaseSync(path.join(root, "index.sqlite"));
  try {
    assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    assert.deepEqual({ ...db.prepare("SELECT volume,path FROM pending").get() }, { volume: volume.id, path: "kept.txt" });
  } finally {
    db.close();
  }
  const again = await start(root, { timer: false });
  try {
    assert.equal(again.engine.store.db.prepare("SELECT COUNT(*) AS n FROM pending").get().n, 1, "the journal is there for the next start's recovery");
  } finally {
    await again.close();
  }
});

test("an open download is cut after the connection grace and an idle close stays fast", async (t) => {
  const busy = await start(home(t), { timer: false });
  const hash = "c".repeat(64);
  const object = busy.engine.store.contentFile(hash);
  fs.mkdirSync(path.dirname(object), { recursive: true });
  const handle = fs.openSync(object, "w");
  fs.ftruncateSync(handle, 256 * 1024 * 1024);
  fs.closeSync(handle);
  const download = await stalledDownload(busy, `/v1/blobs/${hash}`);
  let started = Date.now();
  await busy.close();
  let took = Date.now() - started;
  assert.ok(took >= CONNECTION_GRACE_MS - 100 && took < CONNECTION_GRACE_MS + 1500, `close took ${took} ms`);
  download.response.resume();
  await download.ended;
  const idle = await start(home(t), { timer: false });
  started = Date.now();
  await idle.close();
  took = Date.now() - started;
  assert.ok(took < 1000, `an idle close took ${took} ms`);
});

test("Compose and the CLI leave the daemon time to close before they kill it", () => {
  const compose = fs.readFileSync(path.join(repository, "compose.yaml"), "utf8").replace(/\r\n/g, "\n");
  const grace = Number(/\n    stop_grace_period: (\d+)s\n/.exec(compose)?.[1]);
  assert.ok(grace * 1000 >= SHUTDOWN_MS + 5000, `Compose waits ${grace} s for a ${SHUTDOWN_MS} ms close`);
  assert.ok(SHUTDOWN_MS + 2000 < 30000, "the desktop updater waits 30 s for the daemon to exit");
  const cli = fs.readFileSync(path.join(repository, "packages", "cli", "arca.js"), "utf8").replace(/\r\n/g, "\n");
  const stop = cli.slice(cli.indexOf("const stop = async"), cli.indexOf('process.on("SIGTERM", stop)'));
  const backstop = stop.indexOf("SHUTDOWN_MS + 2000");
  assert.ok(backstop > 0, "stop arms a backstop after the close bound");
  assert.ok(backstop < stop.indexOf("await daemon.close()"), "the backstop is armed before the close starts");
  assert.match(stop, /process\.exit\(1\)/);
  assert.doesNotMatch(stop, /\.unref\(\)/, "an unref'd backstop lets the process end before the close finishes");
  const updater = fs.readFileSync(path.join(repository, "apps", "desktop", "src-tauri", "src", "main.rs"), "utf8");
  assert.match(updater, /for _ in 0\.\.300 \{\s*if running_daemon\(home\)\?\.is_none\(\)/, "the updater's 30 s wait this bound is measured against");
});

test("a closing daemon keeps its process alive until the index is closed and the lock released", (t) => {
  const root = home(t);
  const script = path.join(root, "close.mjs");
  const server = pathToFileURL(path.join(repository, "packages", "daemon", "server.js")).href;
  fs.writeFileSync(
    script,
    [
      `import { start } from ${JSON.stringify(server)};`,
      `const daemon = await start(${JSON.stringify(root)}, { timer: false, shutdownMs: 300 });`,
      "daemon.engine.exclusive(() => new Promise(() => {}));",
      "await daemon.close();",
      'console.log("closed");',
      "",
    ].join("\n"),
  );
  const child = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 20000 });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), "closed", "the process reached the end of close instead of ending with the loop");
  assert.equal(fs.existsSync(path.join(root, "daemon.lock")), false, "the state lock is released");
  const db = new DatabaseSync(path.join(root, "index.sqlite"));
  try {
    assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  } finally {
    db.close();
  }
});
