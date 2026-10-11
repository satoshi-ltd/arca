import test from "node:test";
import { verifiedTailnetURL } from "../packages/daemon/network.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
  Tailscale,
  normalizeStatus,
  probeArca,
  discoverPeers,
  tailAddress,
} from "../packages/daemon/tailscale.js";
import { init } from "../packages/daemon/storage.js";
import { start } from "../packages/daemon/server.js";
const raw = {
  BackendState: "Running",
  Self: {
    ID: "self",
    HostName: "Mac",
    OS: "macOS",
    TailscaleIPs: ["100.70.0.1"],
    Online: true,
  },
  Peer: {
    a: {
      ID: "a",
      HostName: "Casa",
      OS: "linux",
      TailscaleIPs: ["100.70.0.2", "192.168.1.2"],
      Online: true,
    },
    b: {
      ID: "b",
      HostName: "Phone",
      OS: "iOS",
      TailscaleIPs: ["100.70.0.3"],
      Online: false,
    },
  },
};
const hello = {
  service: "arca",
  discoveryVersion: 1,
  protocol: 1,
  id: "arca-node",
  name: "Casa",
  role: "hub",
  platform: "linux",
  deployment: "docker",
  version: "0.1.0",
  apiPort: 17831,
  client: null,
};
test("normalization only exposes tailnet addresses and minimal peer metadata", () => {
  const s = normalizeStatus({ ...raw, User: { private: "secret" } }, "cli");
  assert.equal(s.state, "connected");
  assert.deepEqual(s.peers[0].addresses, ["100.70.0.2"]);
  assert.equal(s.User, undefined);
  assert.equal(tailAddress("127.0.0.1"), false);
  assert.equal(tailAddress("100.128.0.1"), false);
  assert.equal(tailAddress("fd7a:115c:a1e0::1"), true);
  assert.equal(
    normalizeStatus({ ...raw, BackendState: "NeedsLogin" }, "cli").state,
    "disconnected",
  );
});
test("missing CLI, permission errors and successful CLI results are distinct and cached", async () => {
  const absent = new Tailscale({
    run: async () => {
      throw Object.assign(new Error(), { code: "ENOENT" });
    },
  });
  assert.equal((await absent.read()).state, "not-installed");
  const denied = new Tailscale({
    run: async () => {
      throw Object.assign(new Error(), { code: "EACCES" });
    },
  });
  assert.equal((await denied.read()).state, "unavailable");
  let calls = 0;
  const connected = new Tailscale({
    run: async () => {
      calls++;
      return { stdout: JSON.stringify(raw) };
    },
  });
  await Promise.all([connected.read(), connected.read()]);
  await connected.read();
  assert.equal(calls, 1);
});
test("host-file status expires instead of retaining a stale connected tailnet", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arca-tailnet-"));
  const file = path.join(dir, "status.json");
  try {
    fs.writeFileSync(file, JSON.stringify(raw));
    const ts = new Tailscale({ statusFile: file });
    assert.equal((await ts.read()).state, "connected");
    fs.utimesSync(file, new Date(0), new Date(0));
    assert.equal((await ts.read(true)).state, "unavailable");
    fs.writeFileSync(file, "not json");
    assert.equal((await ts.read(true)).state, "unavailable");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("probe validates Arca response, never sends credentials and skips offline peers", async () => {
  const peers = normalizeStatus(raw, "cli").peers;
  let count = 0;
  const fetcher = async (url, opts) => {
    count++;
    assert.equal(url, "http://100.70.0.2:17831/.well-known/arca");
    assert.equal(opts.headers, undefined);
    assert.equal(opts.redirect, "error");
    return new Response(JSON.stringify(hello));
  };
  assert.equal((await probeArca(peers[0], { fetcher })).state, "available");
  assert.equal((await probeArca(peers[1], { fetcher })).state, "offline");
  assert.equal(count, 1);
  assert.equal(
    (
      await probeArca(peers[0], {
        fetcher: async () =>
          new Response(JSON.stringify({ ...hello, service: "other" })),
      })
    ).state,
    "not-detected",
  );
  assert.equal(
    (
      await probeArca(peers[0], {
        fetcher: async () =>
          new Response(JSON.stringify({ ...hello, protocol: 2 })),
      })
    ).state,
    "incompatible",
  );
  assert.equal(
    (
      await probeArca(peers[0], {
        fetcher: async () => new Response("x".repeat(9000)),
      })
    ).state,
    "not-detected",
  );
});
test("peer scans cap concurrency and never probe an arbitrary LAN address", async () => {
  let active = 0,
    max = 0,
    calls = 0;
  const state = normalizeStatus(raw, "cli");
  state.peers = Array.from({ length: 12 }, (_, i) => ({
    ...state.peers[0],
    id: String(i),
  }));
  const result = await discoverPeers(state, {
    fetcher: async () => {
      calls++;
      active++;
      max = Math.max(max, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return new Response(JSON.stringify(hello));
    },
  });
  assert.equal(result.length, 12);
  assert.equal(calls, 12);
  assert.ok(max <= 4);
  assert.equal(
    (
      await probeArca(
        { online: true, addresses: ["127.0.0.1"] },
        {
          fetcher: async () => {
            throw new Error("Must never run");
          },
        },
      )
    ).state,
    "not-detected",
  );
});
test("discovery is admin-only; tailnet API stays authenticated and closes on disconnect", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-network-"));
  init(home, { port: 0 });
  let snapshot = {
    ...normalizeStatus(raw, "cli"),
    self: { ...normalizeStatus(raw, "cli").self, addresses: ["127.0.0.1"] },
  };
  const daemon = await start(home, {
    timer: false,
    network: {
      detector: { read: async () => snapshot },
      probeOptions: {
        fetcher: async () => new Response(JSON.stringify(hello)),
      },
    },
  });
  const call = (route, body, authorized = true) =>
    fetch(`http://127.0.0.1:${daemon.port}${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(authorized
          ? { Authorization: `Bearer ${daemon.engine.config.adminToken}` }
          : {}),
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  try {
    assert.equal((await call("/v1/discovery", undefined, false)).status, 401);
    const scan = await (await call("/v1/discovery")).json();
    assert.equal(scan.peers[0].arca.state, "available");
    assert.equal(
      daemon.engine.store.db.prepare("SELECT COUNT(*) AS n FROM devices").get()
        .n,
      0,
    );
    assert.equal(
      (await call("/v1/network", { mode: "tailscale" })).status,
      200,
    );
    await call("/v1/client", { kind: "desktop" });
    const metadata = await (
      await fetch(`http://127.0.0.1:${daemon.port}/.well-known/arca`)
    ).json();
    assert.equal(metadata.client.kind, "desktop");
    assert.equal(metadata.adminToken, undefined);
    assert.equal(metadata.volumes, undefined);
    assert.equal(metadata.platform, process.platform);
    assert.equal(
      (await fetch(`http://127.0.0.1:${daemon.port}/v1/status`)).status,
      401,
    );
    const authenticated = await fetch(
      `http://127.0.0.1:${daemon.port}/v1/status`,
      {
        headers: { Authorization: `Bearer ${daemon.engine.config.adminToken}` },
      },
    );
    assert.equal(authenticated.status, 200);
    assert.equal((await authenticated.json()).id, daemon.engine.config.id);
    assert.equal(
      (
        await fetch(`http://127.0.0.1:${daemon.port}/.well-known/arca`, {
          headers: { Origin: "https://untrusted.test" },
        })
      ).status,
      403,
    );
    daemon.network.client.at = Date.now() - 31000;
    assert.equal(daemon.network.hello().client, null);
    snapshot = { state: "disconnected", peers: [] };
    await daemon.network.maintain();
    assert.equal(daemon.network.listener, null);
    assert.equal(daemon.engine.config.network.mode, "tailscale");
    assert.equal(
      (await call("/v1/network", { mode: "tailscale" })).status,
      409,
    );
    assert.equal(
      (await call("/v1/network", { mode: "standalone" })).status,
      200,
    );
  } finally {
    await daemon.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("automatic HTTP verification accepts known tailnet IPs, pins DNS and rejects unknown or mixed routes", async () => {
  const state = {
    state: "connected",
    self: { addresses: ["100.70.0.1"] },
    peers: [{ addresses: ["100.70.0.2", "fd7a:115c:a1e0::2"] }],
  };
  const ip = await verifiedTailnetURL(
    new URL("http://100.70.0.2:17831"),
    state,
  );
  assert.equal(ip.origin, "http://100.70.0.2:17831");
  const named = await verifiedTailnetURL(
    new URL("http://casa:17831"),
    state,
    async () => [{ address: "100.70.0.2" }],
  );
  assert.equal(named.origin, ip.origin);
  const ipv6 = await verifiedTailnetURL(
    new URL("http://[fd7a:115c:a1e0::2]:17831"),
    state,
  );
  assert.equal(ipv6.hostname, "[fd7a:115c:a1e0::2]");
  await assert.rejects(
    verifiedTailnetURL(new URL("http://100.70.0.3:17831"), state),
    /not verified/,
  );
  await assert.rejects(
    verifiedTailnetURL(new URL("http://casa:17831"), state, async () => [
      { address: "100.70.0.2" },
      { address: "192.168.1.2" },
    ]),
    /not verified/,
  );
  await assert.rejects(
    verifiedTailnetURL(ip, { ...state, state: "stopped" }),
    /Connect Tailscale/,
  );
  await assert.rejects(
    verifiedTailnetURL(new URL("http://casa:17831"), state, async () => {
      throw Error("DNS unavailable");
    }),
    /Cannot resolve/,
  );
});
test("a stale Tailscale status answers as temporarily unavailable, never as a refused credential", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-tailnet-gate-"));
  init(home, { port: 0 });
  let snapshot = { state: "unavailable", peers: [] };
  const daemon = await start(home, {
    timer: false,
    network: { detector: { read: async () => snapshot } },
  });
  daemon.engine.config.network = { mode: "tailscale" };
  let remote = "100.70.0.2";
  const peer = http.createServer((req, res) => {
    Object.defineProperty(req.socket, "remoteAddress", {
      value: remote,
      configurable: true,
    });
    daemon.network.apiHandler(req, res);
  });
  await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    peer.closeAllConnections();
    await new Promise((resolve) => peer.close(resolve));
    await daemon.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const call = async () => {
    const response = await fetch(
      `http://127.0.0.1:${peer.address().port}/v1/catalog`,
      { headers: { Authorization: "Bearer unknown" } },
    );
    return { status: response.status, body: await response.json() };
  };
  assert.deepEqual(await call(), {
    status: 503,
    body: { error: "Tailscale access unavailable" },
  });
  snapshot = {
    ...normalizeStatus(raw, "cli"),
    self: { ...normalizeStatus(raw, "cli").self, addresses: ["127.0.0.1"] },
  };
  assert.equal((await call()).status, 401);
  remote = "100.70.0.9";
  assert.equal((await call()).status, 403);
});
test("a CLI that hangs stops the search instead of trying every other candidate", async () => {
  const calls = [];
  const detector = new Tailscale({
    run: (binary) => {
      calls.push(binary);
      return calls.length === 1
        ? Promise.reject(Object.assign(new Error("missing"), { code: "ENOENT" }))
        : new Promise((_, reject) =>
            setTimeout(() => reject(Object.assign(new Error("Command failed: timed out"), { killed: true, signal: "SIGTERM" })), 50),
          );
    },
  });
  const state = await detector.read();
  assert.equal(state.state, "unavailable");
  assert.ok(calls.length <= 2, calls.join());
});
test("a slow Tailscale check never holds the daemon start or its first hub request", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-tailnet-slow-"));
  init(home, { port: 0, role: "replica" });
  let connections = 0;
  const sockets = new Set();
  const hub = http.createServer(() => {});
  hub.on("connection", (socket) => {
    connections++;
    sockets.add(socket);
  });
  await new Promise((resolve) => hub.listen(0, "127.0.0.1", resolve));
  const config = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
  config.hub = { url: `http://127.0.0.1:${hub.address().port}`, token: "token", id: "hub" };
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify(config));
  const slow = { read: () => new Promise((resolve) => setTimeout(() => resolve({ state: "not-installed", installed: false, peers: [] }), 2500)) };
  const started = Date.now();
  const daemon = await start(home, { network: { detector: slow } });
  t.after(async () => {
    const closed = new Promise((resolve) => hub.close(resolve));
    for (const socket of sockets) socket.destroy();
    await closed;
    await daemon.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  assert.ok(Date.now() - started < 2000, `start took ${Date.now() - started} ms`);
  while (!connections && Date.now() - started < 5000) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(connections > 0 && Date.now() - started < 2000, `first hub request after ${Date.now() - started} ms`);
});
