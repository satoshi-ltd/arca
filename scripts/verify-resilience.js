// Isolated process-failure and recovery qualification. Never opens live Arca state.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { init, Store } from "../packages/daemon/storage.js";
import { start } from "../packages/daemon/server.js";
import { recoverBackup } from "../packages/daemon/recovery.js";
const script = fileURLToPath(import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (process.argv[2] === "--worker") {
  const daemon = await start(process.argv[3], {
    port: Number(process.argv[4]),
    timer: process.argv[5] === "auto",
  });
  let scans = 0,
    requests = 0;
  const scan = daemon.engine.scanner.scan.bind(daemon.engine.scanner);
  daemon.engine.scanner.scan = (...args) => {
    scans++;
    return scan(...args);
  };
  const request = daemon.engine.request.bind(daemon.engine);
  daemon.engine.request = (...args) => {
    requests++;
    return request(...args);
  };
  process.send({ port: daemon.port });
  process.on("message", async (command) => {
    if (command === "metrics")
      process.send({
        cpu: process.cpuUsage(),
        rss: process.memoryUsage().rss,
        scans,
        requests,
      });
    if (command === "close") {
      await daemon.close();
      process.exit(0);
    }
  });
} else {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arca-resilience-"));
  const nodes = [];
  async function launch(name, role, prior, auto = false) {
    const home = path.join(root, name);
    if (!prior) init(home, { name, role, port: 0 });
    const child = fork(
      script,
      ["--worker", home, String(prior?.port || 0), auto ? "auto" : "manual"],
      { stdio: ["ignore", "ignore", "inherit", "ipc"] },
    );
    const [ready] = await once(child, "message");
    const c = JSON.parse(fs.readFileSync(path.join(home, "config.json")));
    const n = { home, child, port: ready.port, c };
    n.api = async (route, body) => {
      const r = await fetch(`http://127.0.0.1:${n.port}${route}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${c.adminToken}`,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(120000),
      });
      const value = await r.json();
      if (!r.ok) throw new Error(value.error);
      return value;
    };
    n.sync = () => n.api("/v1/sync", {});
    nodes.push(n);
    return n;
  }
  async function stop(n, signal) {
    if (n.child.exitCode !== null || n.child.signalCode !== null) return;
    const exited = once(n.child, "exit");
    signal ? n.child.kill(signal) : n.child.send("close");
    await exited;
  }
  const manifest = (dir) => {
    const out = {};
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".arca")) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory())
        for (const [name, hash] of Object.entries(manifest(file)))
          out[entry.name + "/" + name] = hash;
      else if (entry.isFile())
        out[entry.name] = crypto
          .createHash("sha256")
          .update(fs.readFileSync(file))
          .digest("hex");
    }
    return out;
  };
  const metrics = async (n) => {
    const reply = once(n.child, "message");
    n.child.send("metrics");
    return (await reply)[0];
  };
  try {
    let hub = await launch("hub", "hub");
    let mac = await launch("mac", "replica");
    const v = await hub.api("/v1/volumes", { name: "Qualification" });
    const link = async (n) => {
      const invite = await hub.api("/v1/devices", {
        name: n.c.name,
        role: n.c.role,
      });
      await n.api("/v1/connect", {
        url: `http://127.0.0.1:${hub.port}`,
        token: invite.token,
      });
      await n.api("/v1/select", { id: v.id });
    };
    await link(mac);
    const local = (await mac.api("/v1/status")).volumes[0].path;
    for (let i = 0; i < 200; i++)
      fs.writeFileSync(path.join(v.path, `file-${i}.txt`), `initial-${i}`);
    await hub.sync();
    await mac.sync();
    assert.deepEqual(manifest(local), manifest(v.path));
    console.log("PASS initial independent SHA-256 manifests: 200 files");
    fs.writeFileSync(path.join(v.path, "file-0.txt"), "hub-conflict");
    fs.writeFileSync(path.join(local, "file-0.txt"), "replica-conflict");
    await hub.sync();
    await mac.sync();
    await hub.sync();
    await mac.sync();
    const values = fs
      .readdirSync(local)
      .filter((n) => n.includes("file-0"))
      .map((n) => fs.readFileSync(path.join(local, n), "utf8"));
    assert.ok(
      values.includes("hub-conflict") && values.includes("replica-conflict"),
    );
    assert.deepEqual(manifest(local), manifest(v.path));
    console.log(
      "PASS simultaneous edits: both versions preserved and manifests match",
    );
    fs.renameSync(
      path.join(local, "file-1.txt"),
      path.join(local, "renamed.txt"),
    );
    fs.unlinkSync(path.join(local, "file-2.txt"));
    await mac.sync();
    await hub.sync();
    assert.deepEqual(manifest(local), manifest(v.path));
    const payload = crypto.randomBytes(32 * 1024 * 1024);
    fs.writeFileSync(path.join(local, "large.bin"), payload);
    const pending = mac.sync().then(
      () => null,
      (e) => e,
    );
    // Interrupt only after the hub has received a partial upload.
    const uploads = path.join(hub.home, "uploads");
    let partial = false;
    for (let i = 0; i < 2000; i++) {
      if (
        fs.existsSync(uploads) &&
        fs.readdirSync(uploads).some((n) => n.endsWith(".part"))
      ) {
        partial = true;
        break;
      }
      await sleep(2);
    }
    assert.ok(partial, "transfer must be in progress before failure injection");
    await stop(hub, "SIGKILL");
    await pending;
    hub = await launch("hub", "hub", hub);
    await mac.sync();
    await hub.sync();
    assert.deepEqual(manifest(local), manifest(v.path));
    console.log(
      "PASS hub SIGKILL during upload, stale lock recovery and transfer retry",
    );
    await stop(mac, "SIGKILL");
    mac = await launch("mac", "replica", mac);
    await mac.sync();
    assert.deepEqual(manifest(local), manifest(v.path));
    console.log(
      "PASS replica abrupt restart retains identity, paths and content",
    );
    const backupRoot = path.join(root, "backup");
    fs.mkdirSync(backupRoot);
    await mac.api("/v1/backup", { enabled: true, path: backupRoot });
    await mac.sync();
    await stop(mac);
    const backupHome = path.join(backupRoot, "state");
    const recovered = path.join(root, "recovered");
    const result = recoverBackup(backupHome, recovered);
    const restored = new Store(recovered);
    assert.deepEqual(manifest(restored.volume(v.id).path), manifest(v.path));
    assert.ok(restored.history(v.id, "file-0.txt").length >= 2);
    const originalIndex = new DatabaseSync(
      path.join(hub.home, "index.sqlite"),
      { readOnly: true },
    );
    try {
      const query =
        "SELECT rev,volume,path,hash,size,deleted,author,created FROM revisions ORDER BY rev";
      assert.deepEqual(
        restored.db.prepare(query).all(),
        originalIndex.prepare(query).all(),
      );
    } finally {
      originalIndex.close();
    }
    restored.close();
    const backupIndex = new DatabaseSync(
      path.join(backupHome, "index.sqlite"),
      { readOnly: true },
    );
    const archived = JSON.parse(
      backupIndex.prepare("SELECT row FROM backup_history LIMIT 1").get().row,
    );
    backupIndex.close();
    const object = path.join(backupHome, "objects", archived.hash);
    const original = fs.readFileSync(object);
    const rejectedTarget = path.join(root, "corrupt-recovery");
    try {
      fs.writeFileSync(object, "deliberately corrupted test object");
      assert.throws(
        () => recoverBackup(backupHome, rejectedTarget),
        /missing or corrupt/,
      );
      assert.ok(!fs.existsSync(rejectedTarget));
    } finally {
      fs.writeFileSync(object, original);
    }

    console.log(
      JSON.stringify({
        backupRecovery: "PASS",
        revisions: result.revisions,
        sha256ManifestMatches: true,
      }),
    );
    await stop(mac);
    mac = await launch("mac", "replica", mac, true);
    await sleep(3000);
    const baseline = await metrics(mac);
    let previous = baseline;
    for (let minute = 1; minute <= 6; minute++) {
      await sleep(60000);
      const current = await metrics(mac);
      console.log(
        JSON.stringify({
          idleMinute: minute,
          cpuMs: Math.round(
            (current.cpu.user +
              current.cpu.system -
              previous.cpu.user -
              previous.cpu.system) /
              1000,
          ),
          rssMiB: Math.round(current.rss / 1048576),
          scans: current.scans - previous.scans,
          requests: current.requests - previous.requests,
        }),
      );
      previous = current;
    }
    assert.deepEqual(manifest(local), manifest(v.path));
    console.log(
      "PASS final integrity after idle observation; physical sleep/power loss and multi-day soak not covered",
    );
  } finally {
    for (const n of nodes.reverse()) await stop(n);
    fs.rmSync(root, { recursive: true, force: true });
  }
}
