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
    if (!online) throw new Error("offline");
    return Response.json({ id: "hub", protocol: 1, name: "Hub", volumes: [] });
  };
  const client = createClient({ ...store, fetcher });
  await assert.rejects(client.pair("https://hub", "000123"), /offline/);
  assert.equal((await store.secrets.read()).token, "fixture-secret");
  const restarted = createClient({ ...store, fetcher });
  await restarted.load();
  online = true;
  await restarted.refresh();
  assert.equal(restarted.state().catalog.name, "Hub");
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
      throw new Error("offline");
    },
  });
  await offline.load();
  await assert.rejects(offline.disconnect(), /offline/);
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
