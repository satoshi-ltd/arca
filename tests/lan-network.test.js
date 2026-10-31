import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { lanAddress, verifiedLanURL } from "../packages/daemon/network.js";
import { init } from "../packages/daemon/storage.js";
import { start } from "../packages/daemon/server.js";
import { issueWebCode } from "../packages/daemon/web.js";

test("untrusted plaintext peers need the LAN option for pairing and bearer access", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-plain-"));
  init(home, { port: 0 });
  const detector = { read: async () => ({ state: "connected", self: { addresses: ["100.64.0.1"] }, peers: [{ addresses: ["100.64.0.2"] }] }) };
  const daemon = await start(home, { timer: false, network: { detector } });
  t.after(async () => { await daemon.close(); fs.rmSync(home, { recursive: true, force: true }); });
  daemon.server.prependListener("request", (req) => Object.defineProperty(req.socket, "remoteAddress", { value: req.headers["x-test-peer"] || "127.0.0.1", configurable: true }));
  const base = `http://127.0.0.1:${daemon.port}`;
  const admin = daemon.engine.config.adminToken;
  const req = (route, peer, body, headers = {}) => fetch(base + route, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", ...(peer ? { "x-test-peer": peer } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const invitation = await (await req("/v1/pairing", null, { name: "device" }, { authorization: `Bearer ${admin}` })).json();
  for (const peer of ["192.168.1.9", "2001:db8::5", "100.64.0.3"]) {
    assert.equal((await req("/pair", peer, { code: invitation.code })).status, 412, peer);
    assert.equal((await req("/v1/status", peer, null, { authorization: `Bearer ${admin}` })).status, 412, `admin ${peer}`);
  }
  const pair = await req("/pair", "100.64.0.2", { code: invitation.code });
  assert.equal(pair.status, 201, "a verified Tailscale peer works with LAN off");
  const webCode = issueWebCode(home).code;
  const login = (peer) => req("/auth/login", peer, { code: webCode }, { origin: base });
  const accepted = await login("192.168.1.9");
  assert.equal(accepted.status, 200);
  const cookie = accepted.headers.get("set-cookie").split(";")[0];
  assert.equal((await req("/v1/status", "2001:db8::5", null, { cookie })).status, 200);
  await req("/v1/network/lan", null, { enabled: true }, { authorization: `Bearer ${admin}` });
  assert.equal((await req("/v1/status", "2001:db8::5", null, { authorization: `Bearer ${admin}` })).status, 200);
});

test("a hub that cannot read Tailscale status keeps tailnet-range peers working with the LAN option off", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-docker-tailnet-"));
  init(home, { port: 0 });
  const status = { state: "not-installed", peers: [] };
  const daemon = await start(home, { timer: false, network: { detector: { read: async () => status } } });
  t.after(async () => { await daemon.close(); fs.rmSync(home, { recursive: true, force: true }); });
  daemon.server.prependListener("request", (req) => Object.defineProperty(req.socket, "remoteAddress", { value: req.headers["x-test-peer"], configurable: true }));
  const admin = daemon.engine.config.adminToken;
  const get = (peer) => fetch(`http://127.0.0.1:${daemon.port}/v1/status`, { headers: { "x-test-peer": peer, authorization: `Bearer ${admin}` } });
  assert.equal((await get("100.101.1.2")).status, 200, "Docker without the status file");
  status.state = "unavailable";
  assert.equal((await get("fd7a:115c:a1e0::9")).status, 200, "stale status file");
  assert.equal((await get("2001:db8::5")).status, 412, "IPv6 outside Tailscale still needs the option");
  assert.equal((await get("192.168.1.9")).status, 412, "private IPv4 still needs the option");
  status.state = "disconnected";
  assert.equal((await get("100.101.1.2")).status, 412, "a readable status that is not connected proves no tailnet");
});

test("explicit HTTPS proxy mode permits web sessions but does not exempt pairing", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-proxy-policy-"));
  init(home, { port: 0 });
  const daemon = await start(home, { timer: false, webOrigin: "https://arca.example" });
  t.after(async () => { await daemon.close(); fs.rmSync(home, { recursive: true, force: true }); });
  daemon.server.prependListener("request", (req) => Object.defineProperty(req.socket, "remoteAddress", { value: "192.168.1.10", configurable: true }));
  const call = (route, method = "GET", body, cookie) => new Promise((resolve, reject) => {
    const req = http.request(`http://127.0.0.1:${daemon.port}${route}`, { method, headers: { host: "arca.example", origin: "https://arca.example", "content-type": "application/json", ...(cookie ? { cookie } : {}) } }, (res) => { res.resume(); res.on("end", () => resolve(res)); });
    req.on("error", reject); req.end(body ? JSON.stringify(body) : undefined);
  });
  const login = await call("/auth/login", "POST", { code: issueWebCode(home).code });
  assert.equal(login.statusCode, 200);
  const cookie = login.headers["set-cookie"][0].split(";")[0];
  assert.equal((await call("/v1/status", "GET", null, cookie)).statusCode, 200);
  assert.equal((await call("/pair", "POST", { code: "000000" })).statusCode, 412);
  daemon.engine.config.network = { ...daemon.engine.config.network, mode: "tailscale" };
  assert.equal((await call("/v1/status", "GET", null, cookie)).statusCode, 412, "Tailscale mode still gates a private-address proxy socket");
});

test("a server replica explicitly bound to a private network keeps web administration", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-replica-web-"));
  init(home, { port: 0, role: "replica" });
  const daemon = await start(home, { timer: false, privateNetwork: true });
  t.after(async () => { await daemon.close(); fs.rmSync(home, { recursive: true, force: true }); });
  daemon.server.prependListener("request", (req) => Object.defineProperty(req.socket, "remoteAddress", { value: "192.168.1.10", configurable: true }));
  const base = `http://127.0.0.1:${daemon.port}`;
  const login = await fetch(base + "/auth/login", { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify({ code: issueWebCode(home).code }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  assert.equal((await fetch(base + "/v1/status", { headers: { cookie } })).status, 200);
});

test("LAN addresses are bounded to literal RFC1918 IPv4 and require hub opt-in", async () => {
  for (const value of [
    "10.0.0.1",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.5",
  ])
    assert.equal(lanAddress(value), true);
  for (const value of [
    "172.32.0.1",
    "100.99.29.84",
    "127.0.0.1",
    "169.254.1.2",
    "8.8.8.8",
    "::1",
    "casa",
    "192.168.1.999",
    undefined,
  ])
    assert.equal(lanAddress(value), false);
  const url = new URL("http://192.168.1.5:17831");
  let calls = 0;
  const fetcher = async (address, options) => {
    calls++;
    assert.equal(address, `${url.origin}/.well-known/arca`);
    assert.equal(options.redirect, "error");
    assert.equal(options.headers, undefined);
    return Response.json({ access: { allowLanHttp: true } });
  };
  assert.equal(await verifiedLanURL(url, fetcher), url);
  assert.equal(calls, 1);
  await assert.rejects(verifiedLanURL(new URL("http://8.8.8.8"), fetcher));
  assert.equal(calls, 1);
  for (const info of [
    {},
    { access: { allowLanHttp: false } },
    { access: { allowLanHttp: "true" } },
  ])
    await assert.rejects(
      verifiedLanURL(url, async () => Response.json(info)),
      /Enable Allow HTTP/,
    );
});

test("hub LAN permission persists, gates pairing and sync, and is admin-only", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-lan-"));
  init(home, { port: 0 });
  const daemon = await start(home, { timer: false });
  // Exercise the real HTTP handler with deterministic socket peers, without
  // requiring a physical LAN interface on CI. This hook exists only in tests.
  daemon.server.prependListener("request", (req) => {
    Object.defineProperty(req.socket, "remoteAddress", {
      value: req.headers["x-test-peer"] || "127.0.0.1",
      configurable: true,
    });
  });
  const admin = daemon.engine.config.adminToken;
  const call = (route, body, credential = admin, lan = false) =>
    fetch(`http://127.0.0.1:${daemon.port}${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
        ...(lan ? { "X-Test-Peer": "192.168.1.50" } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  try {
    assert.equal(
      (await (await call("/v1/network")).json()).allowLanHttp,
      false,
    );
    assert.equal(
      (await (await call("/.well-known/arca", undefined, null, true)).json())
        .access.allowLanHttp,
      false,
    );
    const invitation = await (
      await call("/v1/pairing", { name: "LAN phone" })
    ).json();
    assert.equal(
      (await call("/pair", { code: invitation.code }, null, true)).status,
      412,
    );
    assert.equal(
      (await call("/v1/network/lan", { enabled: "true" })).status,
      400,
    );
    assert.equal(
      (await call("/v1/network/lan", { enabled: true }, null)).status,
      401,
    );
    assert.equal(
      (await call("/v1/network/lan", { enabled: true })).status,
      200,
    );
    await call("/v1/network", { mode: "standalone" });
    assert.equal(daemon.engine.config.network.allowLanHttp, true);
    const paired = await (
      await call("/pair", { code: invitation.code }, null, true)
    ).json();
    assert.ok(paired.token, JSON.stringify(paired));
    assert.equal(
      (await call("/v1/catalog", undefined, paired.token, true)).status,
      200,
    );
    assert.equal(
      (await call("/v1/network/lan", { enabled: false }, paired.token, true))
        .status,
      403,
    );
    // LAN permission also works independently of the Tailscale mode/connection.
    daemon.engine.config.network.mode = "tailscale";
    assert.equal(
      (await call("/v1/catalog", undefined, paired.token, true)).status,
      200,
    );
    await call("/v1/network/lan", { enabled: false });
    assert.equal(
      (await (await call("/.well-known/arca", undefined, null, true)).json())
        .access.allowLanHttp,
      false,
    );
    assert.equal(
      (await call("/v1/catalog", undefined, paired.token, true)).status,
      412,
    );
    // Turning off LAN does not revoke the device: another permitted route works.
    assert.equal(
      (await call("/v1/catalog", undefined, paired.token)).status,
      200,
    );
    await call("/v1/network/lan", { enabled: true });
    assert.equal(
      (await call("/v1/catalog", undefined, paired.token, true)).status,
      200,
    );
    const config = JSON.parse(
      fs.readFileSync(path.join(home, "config.json"), "utf8"),
    );
    assert.equal(config.network.allowLanHttp, true);
    daemon.engine.config.role = "replica";
    assert.equal(
      (await call("/v1/network/lan", { enabled: false })).status,
      403,
    );
  } finally {
    await daemon.close();
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("mobile checks native LAN routing and permission before returning a credential destination", async () => {
  const { verifyPrivateURL } =
    await import("../apps/mobile/src/network-policy.js");
  const url = "http://192.168.1.5:17831";
  const calls = [];
  let allowed = true;
  const native = {
    async resolveLanHost(host) {
      calls.push(host);
      return host;
    },
    async resolvePrivateHost() {
      throw Error("Tailscale unavailable");
    },
  };
  const fetcher = async (...args) => {
    calls.push(args);
    return Response.json({ access: { allowLanHttp: allowed } });
  };
  assert.equal(await verifyPrivateURL(url, native, fetcher), url);
  assert.equal(calls.length, 2);
  assert.equal(calls[0], "192.168.1.5");
  assert.equal(calls[1][0], url + "/.well-known/arca");
  assert.deepEqual(Object.keys(calls[1][1]), ["signal"]);
  allowed = false;
  await assert.rejects(
    verifyPrivateURL(url, native, fetcher),
    /Enable Allow HTTP/,
  );
  await assert.rejects(
    verifyPrivateURL("http://8.8.8.8", native, fetcher),
    /Tailscale/,
  );
  const disconnected = {
    async resolveLanHost() {
      throw Error(
        "Call to function ArcaNetwork.resolveLanHost rejected: java.lang.IllegalStateException: No Wi-Fi",
      );
    },
  };
  await assert.rejects(
    verifyPrivateURL(url, disconnected, () => {
      throw Error("Must not send any HTTP");
    }),
    (error) => {
      assert.match(error.message, /Wi-Fi or Ethernet/);
      assert.doesNotMatch(error.message, /java\.lang|ArcaNetwork/);
      return true;
    },
  );
});

test("mobile LAN probe is bounded and only a parsed hub answer can ask for Allow HTTP", async (t) => {
  const { verifyPrivateURL, isLanHost } =
    await import("../apps/mobile/src/network-policy.js");
  const { isHubUnreachable } =
    await import("../apps/desktop/src/notice-contract.js");
  for (const host of ["192.168.1.5", "10.0.0.1", "172.16.0.1"])
    assert.equal(isLanHost(host), true);
  for (const host of ["100.99.29.84", "casa", "172.32.0.1", "192.168.1.999"])
    assert.equal(isLanHost(host), false);
  const url = "http://192.168.1.5:17831";
  const native = { resolveLanHost: async (host) => host };
  const unreachable = (error) => {
    assert.match(error.message, /Cannot reach the hub over the local network/);
    assert.equal(error.code, "HUB_UNREACHABLE");
    assert.equal(isHubUnreachable(error), true);
    return true;
  };
  for (const answer of [
    () => new Response("unavailable", { status: 503 }),
    () => new Response("<html>portal</html>", { status: 200 }),
    () => Response.json({ hello: "not arca" }),
    () => {
      throw new Error("java.net.ConnectException: failed to connect");
    },
  ])
    await assert.rejects(
      verifyPrivateURL(url, native, async () => answer()),
      unreachable,
    );
  await assert.rejects(
    verifyPrivateURL(url, native, async () =>
      Response.json({ access: { allowLanHttp: false } }),
    ),
    (error) => {
      assert.match(error.message, /Enable Allow HTTP/);
      assert.equal(isHubUnreachable(error), false);
      return true;
    },
  );
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let probeSignal;
  const stalled = verifyPrivateURL(url, native, (address, options) => {
    probeSignal = options.signal;
    return new Promise(() => {});
  });
  const rejected = assert.rejects(stalled, unreachable);
  for (let i = 0; !probeSignal && i < 100; i++)
    await new Promise((resolve) => setImmediate(resolve));
  assert.ok(probeSignal, "the probe must receive its own abort signal");
  t.mock.timers.tick(5000);
  await rejected;
  assert.equal(probeSignal.aborted, true);
});

test("mobile Tailscale route failures are coded connection outages", async () => {
  const { verifyPrivateURL } =
    await import("../apps/mobile/src/network-policy.js");
  const { errorNotice } =
    await import("../apps/desktop/src/notice-contract.js");
  await assert.rejects(
    verifyPrivateURL(
      "http://100.99.29.84:17831",
      {
        async resolvePrivateHost() {
          throw new Error(
            "java.lang.IllegalStateException: Connect Tailscale on this device and the hub",
          );
        },
      },
      () => {
        throw new Error("Must not send any HTTP");
      },
    ),
    (error) => {
      assert.equal(error.code, "HUB_UNREACHABLE");
      assert.match(error.message, /connect Tailscale/);
      const notice = errorNotice(error, { hubName: "Casa" });
      assert.equal(notice.offline, true);
      assert.equal(notice.cause, "connection");
      return true;
    },
  );
});

test("discovery names no separate code page", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-discovery-access-"));
  init(home, { port: 0 });
  const daemon = await start(home, { timer: false });
  t.after(async () => { await daemon.close(); fs.rmSync(home, { recursive: true, force: true }); });
  const info = await (await fetch(`http://127.0.0.1:${daemon.port}/.well-known/arca`)).json();
  assert.equal(info.access.codeDigits, 6);
  assert.equal("setupCodePath" in info.access, false);
});
