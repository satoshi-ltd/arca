import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient, hubAddress } from "../apps/mobile/src/client.js";
import { init } from "../packages/daemon/storage.js";
import { start } from "../packages/daemon/server.js";

function persistence() {
  let secret = null,
    cached = null;
  return {
    secrets: {
      async read() {
        return secret;
      },
      async write(v) {
        secret = structuredClone(v);
      },
      async clear() {
        secret = null;
      },
    },
    cache: {
      async read() {
        return cached;
      },
      async write(v) {
        cached = structuredClone(v);
      },
    },
  };
}

test("mobile rejects unverified HTTP, embedded credentials and address paths", () => {
  assert.equal(hubAddress("https://casa:17831/"), "https://casa:17831");
  for (const value of [
    "http://100.99.29.84:17831",
    "https://name:secret@casa",
    "https://casa/path",
    "https://casa?token=x",
    "https://casa/#x",
  ])
    assert.throws(() => hubAddress(value));
});

test("mobile pairs only as replica, reads real catalog/history and disconnects on hub", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arca-mobile-"));
  init(root, { port: 0 });
  const daemon = await start(root, { timer: false });
  t.after(async () => {
    await daemon.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${daemon.port}`;
  const volume = daemon.engine.store.addVolume("Documents");
  fs.writeFileSync(path.join(volume.path, "notes.txt"), "hello");
  await daemon.engine.cycle();
  const invite = await (
    await fetch(base + "/v1/pairing", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${daemon.engine.config.adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "Mobile test" }),
    })
  ).json();
  const store = persistence();
  const client = createClient({
    ...store,
    fetcher: (url, options) =>
      fetch(url.replace("https://fixture.invalid", base), options),
  });
  await client.load();
  await client.pair("https://fixture.invalid", invite.code);
  assert.equal(client.state().catalog.volumes[0].name, "Documents");
  assert.equal(client.state().connection.linked, true);
  assert.equal("token" in client.state().connection, false);
  assert.equal(
    daemon.engine.store.db.prepare("SELECT role FROM devices").get().role,
    "replica",
  );
  const history = await client.history();
  assert.ok(history.versions.some((row) => row.path === "notes.txt"));
  await client.disconnect();
  assert.equal(client.state().connection, null);
  assert.equal(
    daemon.engine.store.db.prepare("SELECT COUNT(*) n FROM devices").get().n,
    0,
  );
  assert.equal(client.state().catalog.volumes[0].name, "Documents");
  assert.equal(
    fs.readFileSync(path.join(volume.path, "notes.txt"), "utf8"),
    "hello",
  );
});

test("mobile preserves consumed pairing credentials when first catalog fetch fails", async () => {
  const store = persistence();
  let online = false;
  const fetcher = async (url) => {
    if (url.endsWith("/pair"))
      return Response.json({
        id: "replica",
        token: "fixture-secret",
        hubId: "hub",
      });
    if (!online) throw new TypeError("Network request failed");
    return Response.json({ id: "hub", protocol: 1, name: "Hub", volumes: [] });
  };
  const client = createClient({ ...store, fetcher });
  await assert.rejects(client.pair("https://hub", "000123"), /Network request failed/);
  assert.equal((await store.secrets.read()).token, "fixture-secret");
  const restarted = createClient({ ...store, fetcher });
  await restarted.load();
  online = true;
  await restarted.refresh();
  assert.equal(restarted.state().catalog.name, "Hub");
});

test("a refresh joined by the interface survives the sync that started it being stopped", async () => {
  const store = persistence();
  await store.secrets.write({ url: "https://hub", token: "fixture-secret", hubId: "hub", id: "replica" });
  let answer;
  const catalogReply = new Promise((resolve) => {
    answer = resolve;
  });
  const client = createClient({
    ...store,
    fetcher: async () => {
      await catalogReply;
      return Response.json({ id: "hub", protocol: 1, name: "Hub", volumes: [] });
    },
  });
  await client.load();
  const sync = new AbortController();
  const bySync = client.refresh({ signal: sync.signal });
  const byInterface = client.refresh();
  sync.abort(new Error("Synchronization stopped"));
  await assert.rejects(bySync, /Synchronization stopped/);
  answer();
  await byInterface;
  assert.equal(client.state().catalog.name, "Hub");
});

test("mobile persists pending disconnect across restart and never refreshes folders before leaving", async () => {
  const store = persistence();
  await store.secrets.write({
    url: "https://hub",
    token: "fixture-secret",
    hubId: "hub",
    id: "replica",
  });
  const offline = createClient({
    ...store,
    fetcher: async () => {
      throw new TypeError("Network request failed");
    },
  });
  await offline.load();
  await assert.rejects(offline.disconnect(), /Network request failed/);
  assert.equal(offline.state().connection.linked, false);
  const calls = [];
  const resumed = createClient({
    ...store,
    fetcher: async (url) => {
      calls.push(url);
      return Response.json({ disconnected: true });
    },
  });
  await resumed.load();
  await resumed.refresh();
  assert.deepEqual(calls, ["https://hub/v1/leave"]);
  assert.equal(await store.secrets.read(), null);
});

test("mobile rejects changed hub identity and clears revoked credentials without clearing cached catalog", async () => {
  const store = persistence();
  await store.secrets.write({
    url: "https://hub",
    token: "fixture-secret",
    hubId: "original",
    id: "replica",
  });
  await store.cache.write({ id: "original", name: "Original", volumes: [] });
  let revoked = false;
  const client = createClient({
    ...store,
    fetcher: async () =>
      revoked
        ? Response.json({ error: "Revoked" }, { status: 401 })
        : Response.json({ id: "different", protocol: 1, volumes: [] }),
  });
  await client.load();
  await assert.rejects(client.refresh(), /identity/);
  assert.equal(client.state().catalog.name, "Original");
  revoked = true;
  await assert.rejects(client.refresh(), /Revoked/);
  assert.equal(client.state().connection, null);
  assert.equal(client.state().catalog.name, "Original");
});

test(
  "local client destruction does not wait indefinitely for hub acknowledgement",
  { timeout: 4000 },
  async () => {
    const store = persistence();
    await store.secrets.write({
      url: "https://hub",
      token: "secret",
      id: "replica",
      hubId: "hub",
    });
    const client = createClient({
      ...store,
      fetcher: () => new Promise(() => {}),
    });
    await client.load();
    await client.destroy();
    assert.equal(await store.secrets.read(), null);
    assert.deepEqual(client.state(), { connection: null, catalog: null });
  },
);

test("cancelled background requests do not block navigation or accept late native results", async () => {
  const store = persistence();
  await store.secrets.write({
    url: "https://hub",
    token: "secret",
    id: "replica",
    hubId: "hub",
  });
  let late;
  const client = createClient({
    ...store,
    fetcher: (url) =>
      url.endsWith("/v1/background")
        ? new Promise((resolve) => {
            late = resolve;
          })
        : Promise.resolve(Response.json({ ready: true })),
  });
  await client.load();
  const controller = new AbortController();
  const request = client.api("/v1/background", undefined, {
    signal: controller.signal,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await client.api("/v1/navigation"), { ready: true });
  const rejected = assert.rejects(request, /cancel background/);
  controller.abort(new Error("cancel background"));
  await rejected;
  late(Response.json({ error: "late unauthorized response" }, { status: 401 }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(client.state().connection);
});

for (const kind of ["timeout", "cancel"])
  test(`mobile ${kind} also bounds stalled response bodies`, async () => {
    const store = persistence();
    await store.secrets.write({
      url: "https://hub",
      token: "secret",
      id: "replica",
      hubId: "hub",
    });
    let bodyStarted;
    const started = new Promise((resolve) => {
      bodyStarted = resolve;
    });
    const client = createClient({
      ...store,
      timeout: kind === "timeout" ? 30 : 15000,
      fetcher: async () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: () => {
          bodyStarted();
          return new Promise(() => {});
        },
      }),
    });
    await client.load();
    const controller = new AbortController();
    const request = client.api("/v1/stalled", undefined, {
      signal: controller.signal,
    });
    const rejected = assert.rejects(
      request,
      kind === "timeout" ? /timed out/ : /cancel body/,
    );
    await started;
    if (kind === "cancel") controller.abort(new Error("cancel body"));
    await rejected;
    assert.ok(
      client.state().connection,
      "a timeout is not credential revocation",
    );
  });

test("cancelling an unfinished unauthorized response does not erase the connection", async () => {
  const store = persistence();
  await store.secrets.write({
    url: "https://hub",
    token: "secret",
    id: "replica",
    hubId: "hub",
  });
  let reading;
  const started = new Promise((resolve) => {
    reading = resolve;
  });
  const client = createClient({
    ...store,
    fetcher: async () => ({
      ok: false,
      status: 401,
      headers: new Headers(),
      json: () => {
        reading();
        return new Promise(() => {});
      },
    }),
  });
  await client.load();
  const controller = new AbortController();
  const request = client.api("/v1/stalled", undefined, {
    signal: controller.signal,
  });
  const rejected = assert.rejects(request, /cancelled response/);
  await started;
  controller.abort(new Error("cancelled response"));
  await rejected;
  assert.ok(client.state().connection);
  assert.ok(await store.secrets.read());
});

test("hub change waits authenticate, wake on committed files and recheck revocation", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arca-events-"));
  init(root, { port: 0 });
  const daemon = await start(root, { timer: false });
  t.after(async () => {
    await daemon.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${daemon.port}`;
  const volume = daemon.engine.store.addVolume("Events");
  const admin = {
    Authorization: `Bearer ${daemon.engine.config.adminToken}`,
    "Content-Type": "application/json",
  };
  assert.equal((await fetch(base + "/v1/events")).status, 401);
  const invite = await (
    await fetch(base + "/v1/pairing", {
      method: "POST",
      headers: admin,
      body: JSON.stringify({ name: "Events" }),
    })
  ).json();
  const paired = await (
    await fetch(base + "/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: invite.code }),
    })
  ).json();
  const headers = { Authorization: `Bearer ${paired.token}` };
  const initial = await (await fetch(base + "/v1/events", { headers })).json();
  const pending = fetch(base + `/v1/events?after=${initial.cursor}`, {
    headers,
  });
  fs.writeFileSync(path.join(volume.path, "new.txt"), "new file");
  await daemon.engine.cycle();
  const next = await (await pending).json();
  assert.notEqual(next.cursor, initial.cursor);
  daemon.engine.store.db.prepare("UPDATE devices SET last_seen=NULL WHERE id=?").run(paired.id);
  const blocked = fetch(base + `/v1/events?after=${next.cursor}`, { headers });
  // Wait until authentication has happened, then revoke the waiting request.
  for (let attempts = 0; attempts < 100; attempts++) {
    if (daemon.engine.store.db.prepare("SELECT last_seen FROM devices WHERE id=?").get(paired.id).last_seen) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(daemon.engine.store.db.prepare("SELECT last_seen FROM devices WHERE id=?").get(paired.id).last_seen);
  daemon.engine.store.db
    .prepare("UPDATE devices SET revoked=1 WHERE id=?")
    .run(paired.id);
  fs.writeFileSync(path.join(volume.path, "new.txt"), "wake after revocation");
  await daemon.engine.cycle();
  assert.equal((await blocked).status, 401);
});

test("private-network verification of a transfer is bounded and cancellable before any native request", async () => {
  const store = persistence();
  await store.secrets.write({
    url: "http://192.168.1.5:17831",
    token: "secret",
    id: "replica",
    hubId: "hub",
  });
  let fetched = 0;
  const client = createClient({
    ...store,
    timeout: 50,
    fetcher: async () => {
      fetched++;
      return Response.json({});
    },
    resolvePrivateURL: () => new Promise(() => {}),
  });
  await client.load();
  const started = Date.now();
  await assert.rejects(
    client.raw("/v1/uploads/x", { method: "PUT", transfer: {} }),
    (error) => {
      assert.equal(error.message, "Hub request timed out");
      assert.equal(error.code, "HUB_TIMEOUT");
      return true;
    },
  );
  assert.ok(Date.now() - started < 1000);
  const controller = new AbortController();
  const pending = client.raw("/v1/blobs/x", {
    transfer: {},
    signal: controller.signal,
    timeout: 60000,
  });
  const rejected = assert.rejects(pending, /stop sync/);
  const aborted = Date.now();
  controller.abort(new Error("stop sync"));
  await rejected;
  assert.ok(Date.now() - aborted < 100);
  assert.equal(fetched, 0);
});

test("only an explicit 401 unpairs; network gating and gateways are outages", async () => {
  const { isHubUnreachable } =
    await import("../apps/desktop/src/notice-contract.js");
  const store = persistence();
  await store.secrets.write({
    url: "https://hub",
    token: "secret",
    id: "replica",
    hubId: "hub",
  });
  let answer = () =>
    Response.json({ error: "Tailscale access unavailable" }, { status: 403 });
  const client = createClient({ ...store, fetcher: async () => answer() });
  await client.load();
  for (const call of [() => client.refresh(), () => client.api("/v1/machines")])
    await assert.rejects(call(), (error) => {
      assert.equal(error.status, 403);
      assert.equal(isHubUnreachable(error), true);
      return true;
    });
  assert.ok(client.state().connection);
  assert.ok(await store.secrets.read());
  answer = () =>
    Response.json(
      { error: "Tailscale access unavailable" },
      { status: 503 },
    );
  await assert.rejects(client.refresh(), (error) => {
    assert.equal(error.hubUnavailable, true);
    return true;
  });
  answer = () => new Response("<html>Bad gateway</html>", { status: 502 });
  await assert.rejects(client.api("/v1/machines"), (error) => {
    assert.equal(error.message, "Hub unavailable (HTTP 502).");
    assert.equal(isHubUnreachable(error.message), true);
    return true;
  });
  assert.ok(await store.secrets.read());
  answer = () => Response.json({ error: "Revoked" }, { status: 401 });
  await assert.rejects(client.refresh(), /Revoked/);
  assert.equal(client.state().connection, null);
  assert.equal(await store.secrets.read(), null);
});

test("concurrent catalog refreshes share one request and a joined caller can still cancel", async () => {
  const store = persistence();
  await store.secrets.write({
    url: "https://hub",
    token: "secret",
    id: "replica",
    hubId: "hub",
  });
  let requests = 0,
    release;
  const client = createClient({
    ...store,
    fetcher: async () => {
      requests++;
      await new Promise((resolve) => {
        release = resolve;
      });
      return Response.json({ id: "hub", protocol: 1, name: "Hub", volumes: [] });
    },
  });
  await client.load();
  const first = client.refresh();
  const second = client.refresh();
  const controller = new AbortController();
  const third = client.refresh({ signal: controller.signal });
  controller.abort(new Error("sync stopped"));
  await assert.rejects(third, /sync stopped/);
  for (let i = 0; !release && i < 100; i++)
    await new Promise((resolve) => setImmediate(resolve));
  release();
  assert.equal((await first).catalog.name, "Hub");
  assert.equal((await second).catalog.name, "Hub");
  assert.equal(requests, 1);
});

test("per-request deadlines override the default and buffered bodies are never timed out late", async () => {
  const store = persistence();
  await store.secrets.write({
    url: "https://hub",
    token: "secret",
    id: "replica",
    hubId: "hub",
  });
  let delay = 0;
  const client = createClient({
    ...store,
    timeout: 20,
    fetcher: async () => {
      await new Promise((resolve) => setTimeout(resolve, delay));
      const data = new TextEncoder().encode('{"ok":true}');
      return {
        ok: true,
        status: 200,
        buffered: true,
        headers: new Headers(),
        json: async () => JSON.parse(new TextDecoder().decode(data)),
      };
    },
  });
  await client.load();
  delay = 60;
  await assert.rejects(client.raw("/v1/slow"), /timed out/);
  assert.equal((await (await client.raw("/v1/slow", { timeout: 500 })).json()).ok, true);
  delay = 0;
  const response = await client.raw("/v1/fast");
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(await response.json(), { ok: true });
});
