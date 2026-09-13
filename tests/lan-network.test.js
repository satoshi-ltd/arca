import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { lanAddress, verifiedLanURL } from "../packages/daemon/network.js";
import { init } from "../packages/daemon/storage.js";
import { start } from "../packages/daemon/server.js";

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
    fs.rmSync(home, { recursive: true, force: true });
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
  assert.deepEqual(calls, ["192.168.1.5", [url + "/.well-known/arca"]]);
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
      throw Error("No Wi-Fi");
    },
  };
  await assert.rejects(
    verifyPrivateURL(url, disconnected, () => {
      throw Error("Must not send any HTTP");
    }),
    /No Wi-Fi/,
  );
});
