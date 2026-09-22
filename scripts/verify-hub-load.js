// Isolated metadata/API load qualification; never opens an existing state directory.
// Usage: node scripts/verify-hub-load.js [source-root] [indexed-rows]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fork } from "node:child_process";
import { once } from "node:events";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const script = fileURLToPath(import.meta.url);
if (process.argv[2] === "--child") {
  const [, , , source, home, count] = process.argv;
  const { init, Store } = await import(
    pathToFileURL(path.join(source, "packages/daemon/storage.js"))
  );
  const { start } = await import(
    pathToFileURL(path.join(source, "packages/daemon/server.js"))
  );
  init(home, { role: "hub", port: 0 });
  const store = new Store(home);
  const volume = store.addVolume("Synthetic archive");
  const working = store.addVolume("Working folder");
  // Model an indexed hub folder without a working copy. This isolates database
  // and HTTP latency from filesystem scanning and cannot delete real files.
  store.db.prepare("UPDATE volumes SET selected=0 WHERE id=?").run(volume.id);
  const emptyHash = createHash("sha256").update("").digest("hex");
  fs.writeFileSync(store.blob(emptyHash), "");
  const insert = store.db.prepare("INSERT INTO files VALUES(?,?,?,?,?,?,?,?)");
  store.db.exec("BEGIN");
  for (let i = 0; i < Number(count); i++) {
    const name = `file-${String(i).padStart(8, "0")}.txt`;
    const deleted = Number(i < Number(count) / 3);
    insert.run(
      volume.id,
      name,
      deleted ? null : emptyHash,
      0,
      deleted,
      i + 1,
      0,
      name,
    );
  }
  store.db.exec(
    "INSERT INTO revisions SELECT rev,volume,path,hash,size,deleted,'fixture','2026-01-01T00:00:00.000Z',directory FROM files",
  );
  store.db.exec("COMMIT");
  store.close();
  const server = await start(home, { timer: false });
  process.send({
    port: server.port,
    token: server.engine.config.adminToken,
    volume: volume.id,
    working: working.id,
  });
  process.on("message", async () => {
    await server.close();
    process.disconnect();
  });
} else {
  const source = path.resolve(
    process.argv[2] || path.join(path.dirname(script), ".."),
  );
  const count = Number(process.argv[3] || 33326);
  assert.ok(Number.isSafeInteger(count) && count >= 1000 && count <= 1000000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-hub-load-"));
  const child = fork(script, ["--child", source, home, String(count)], {
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  const exited = once(child, "exit");
  const deadline = setTimeout(() => child.kill("SIGKILL"), 45000);
  const measurements = { rows: count, requests: 0, timeouts: 0, samples: [] };
  let probing = false,
    probe;
  try {
    const [ready] = await Promise.race([
      once(child, "message"),
      exited.then(() => {
        throw new Error("Load fixture exited before readiness");
      }),
    ]);
    const base = `http://127.0.0.1:${ready.port}`;
    const headers = {
      Authorization: `Bearer ${ready.token}`,
      "X-Arca-Directories": "1",
      "X-Arca-Path-Transitions": "1",
    };
    async function request(route, timeout = 5000, options = {}) {
      const response = await fetch(base + route, {
        ...options,
        headers,
        signal: AbortSignal.timeout(timeout),
      });
      assert.equal(response.status, 200, route);
      return response.json();
    }
    // Warm totals once, then measure recurring status/catalog work separately.
    await request("/v1/status");
    const idleStart = performance.now();
    for (let i = 0; i < 20; i++) {
      await request("/v1/status");
      await request("/v1/catalog");
    }
    measurements.statusCatalog40Ms = Math.round(performance.now() - idleStart);
    probing = true;
    probe = (async () => {
      while (probing) {
        const started = performance.now();
        try {
          await request("/.well-known/arca", 2000);
          measurements.samples.push(Math.round(performance.now() - started));
        } catch {
          measurements.timeouts++;
        }
        measurements.requests++;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    })();
    const started = performance.now();
    const transfer = async () => {
      const start = performance.now();
      const bytes = Buffer.alloc(1024 * 1024, 7);
      const hash = createHash("sha256").update(bytes).digest("hex");
      const upload = await request(
        `/v1/uploads/${hash}?offset=0&size=${bytes.length}`,
        20000,
        { method: "PUT", body: bytes },
      );
      assert.equal(upload.complete, true);
      await request("/v1/propose", 20000, {
        method: "POST",
        body: JSON.stringify({
          volume: ready.working,
          path: "upload.bin",
          base: 0,
          hash,
          size: bytes.length,
        }),
      });
      const download = await fetch(`${base}/v1/blobs/${hash}`, {
        headers,
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(download.status, 200);
      assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
      measurements.uploadDownloadMs = Math.round(performance.now() - start);
    };
    const snapshotWork = Promise.all(
      [0, 1, 2].map(() =>
        request(`/v1/snapshot?volume=${ready.volume}&limit=1000`, 15000),
      ),
    ).then((pages) => {
      measurements.threeSnapshotsMs = Math.round(performance.now() - started);
      return pages;
    });
    const [snapshots] = await Promise.all([snapshotWork, transfer()]);
    for (const page of snapshots) {
      assert.equal(page.total, count);
      assert.equal(page.files.length, 1000);
      assert.ok(page.session);
      assert.equal(Boolean(page.next), count > 1000);
    }
    const page = snapshots[0];
    const paginationStarted = performance.now();
    let entries = page.files.length;
    let deleted = page.files.filter((row) => row.deleted).length;
    let after = page.next;
    while (after) {
      const next = await request(
        `/v1/snapshot?volume=${ready.volume}&session=${page.session}&after=${after}&limit=1000`,
      );
      assert.equal(next.total, count);
      assert.ok(next.files[0].path > after);
      entries += next.files.length;
      deleted += next.files.filter((row) => row.deleted).length;
      after = next.next;
    }
    assert.equal(entries, count);
    assert.equal(deleted, Math.ceil(count / 3));
    measurements.remainingSnapshotPagesMs = Math.round(performance.now() - paginationStarted);
    const status = await request("/v1/status");
    const folder = status.volumes.find((v) => v.id === ready.volume);
    assert.equal(folder.files, count - deleted, "visible files exclude tombstones");
    const paused = await request("/v1/pause", 2000, {
      method: "POST",
      body: JSON.stringify({ paused: true }),
    });
    assert.equal(paused.phase, "paused");
    await request("/v1/pause", 2000, {
      method: "POST",
      body: JSON.stringify({ paused: false }),
    });
    measurements.pauseResume = true;
    assert.equal(
      measurements.timeouts,
      0,
      "HTTP probes timed out during snapshots",
    );
  } catch (error) {
    measurements.error = error.message;
    process.exitCode = 1;
  } finally {
    probing = false;
    await probe;
    if (measurements.timeouts) {
      measurements.error ||= "HTTP probes timed out during load";
      process.exitCode = 1;
    }
    clearTimeout(deadline);
    child.kill("SIGKILL");
    await exited;
    fs.rmSync(home, { recursive: true, force: true });
    const samples = measurements.samples.sort((a, b) => a - b);
    delete measurements.samples;
    measurements.maxProbeMs = samples.at(-1) ?? null;
    measurements.p95ProbeMs =
      samples[Math.max(0, Math.ceil(samples.length * 0.95) - 1)] ?? null;
    console.log(JSON.stringify(measurements, null, 2));
  }
}
