import http from "node:http";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import fs from "node:fs";
import { Tailscale, discoverPeers, tailAddress } from "./tailscale.js";
import { fail } from "./storage.js";
export function lanAddress(address) {
  if (isIP(address || "") !== 4) return false;
  const [a, b] = address.split(".").map(Number);
  return (
    a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
  );
}
export async function verifiedLanURL(remote, fetcher = fetch) {
  if (!lanAddress(remote.hostname))
    fail("Use the hub's private IPv4 address", 400);
  const response = await fetcher(`${remote.origin}/.well-known/arca`, {
    redirect: "error",
    signal: AbortSignal.timeout(10000),
  });
  const info = response.ok ? await response.json() : null;
  if (info?.access?.allowLanHttp !== true)
    fail("Enable Allow HTTP on local network in the hub's Settings first", 412);
  return remote;
}
export async function verifiedTailnetURL(remote, state, resolveHost = lookup) {
  if (state.state !== "connected")
    fail(
      "Connect Tailscale on both machines, or use an HTTPS hub address.",
      400,
    );
  const host = remote.hostname.replace(/^\[|\]$/g, "");
  let resolved;
  try {
    resolved = isIP(host)
      ? [{ address: host }]
      : await resolveHost(host, { all: true });
  } catch {
    fail(
      "Cannot resolve the hub address. Use its Tailscale IP or an HTTPS address.",
      400,
    );
  }
  const known = new Set(
    [state.self, ...(state.peers || [])].flatMap(
      (peer) => peer?.addresses || [],
    ),
  );
  if (
    !resolved.length ||
    resolved.some(({ address }) => !tailAddress(address) || !known.has(address))
  )
    fail(
      "This HTTP address is not verified on your Tailscale network. Use the hub’s Tailscale address or HTTPS.",
      400,
    );
  const ip =
    resolved.find(({ address }) => isIP(address) === 4)?.address ||
    resolved[0].address;
  const pinned = new URL(remote.origin);
  pinned.hostname = isIP(ip) === 6 ? `[${ip}]` : ip;
  return pinned;
}
export class Network {
  constructor(
    engine,
    {
      detector = new Tailscale(),
      probeOptions,
      discoveryHost = process.env.ARCA_DISCOVERY_HOST,
    } = {},
  ) {
    this.engine = engine;
    this.detector = detector;
    this.probeOptions = probeOptions;
    this.discoveryHost = discoveryHost;
    this.listener = null;
    this.address = null;
    this.issue = null;
    this.client = null;
    this.discovery = null;
    this.scanPromise = null;
    this.stopping = false;
    this.maintenance = Promise.resolve();
  }
  hello() {
    const c = this.engine.config;
    return {
      service: "arca",
      discoveryVersion: 1,
      protocol: 1,
      version: "0.3.0",
      id: c.id,
      name: c.name,
      role: c.role,
      ready: c.role !== "hub" || this.engine.store.volumes().length > 0,
      platform: process.platform,
      deployment: fs.existsSync("/.dockerenv") ? "docker" : "native",
      apiPort: this.port || c.port,
      client:
        this.client && Date.now() - this.client.at < 30000
          ? {
              kind: this.client.kind,
              active: true,
              lastSeenAt: new Date(this.client.at).toISOString(),
            }
          : null,
    };
  }
  heartbeat(kind) {
    if (!["desktop", "mobile"].includes(kind)) fail("Invalid client kind");
    this.client = { kind, at: Date.now() };
  }
  async status() {
    const tailscale = await this.detector.read();
    return {
      mode: this.engine.config.network?.mode || "standalone",
      allowLanHttp: this.engine.config.network?.allowLanHttp === true,
      tailscale,
      publishing:
        Boolean(this.listener) ||
        (this.engine.config.network?.mode === "tailscale" &&
          tailscale.state === "connected" &&
          ["0.0.0.0", "::"].includes(this.mainHost)),
      discoveryPort: this.port || this.engine.config.port,
      error: this.issue,
    };
  }
  async peers() {
    const state = await this.status();
    if (state.tailscale.state !== "connected") {
      this.discovery = null;
      return { ...state, peers: [], scannedAt: null };
    }
    const signature = JSON.stringify(state.tailscale.peers);
    if (
      this.discovery &&
      this.discovery.signature === signature &&
      Date.now() - this.discovery.time < 15000
    )
      return { ...state, ...this.discovery.result };
    if (!this.scanPromise)
      this.scanPromise = discoverPeers(state.tailscale, this.probeOptions)
        .then((peers) => {
          const result = { peers, scannedAt: new Date().toISOString() };
          this.discovery = { signature, time: Date.now(), result };
          return result;
        })
        .finally(() => {
          this.scanPromise = null;
        });
    return { ...state, ...(await this.scanPromise) };
  }
  async setMode(mode) {
    if (!["standalone", "tailscale"].includes(mode))
      fail("Invalid network mode");
    if (
      mode === "tailscale" &&
      (await this.detector.read(true)).state !== "connected"
    )
      fail("Connect Tailscale before enabling Tailscale mode", 409);
    this.engine.config.network = { ...this.engine.config.network, mode };
    this.engine.store.saveConfig();
    await this.maintain();
    return this.status();
  }
  async setLanHttp(enabled) {
    if (this.engine.config.role !== "hub")
      fail("Only a hub can allow LAN connections", 403);
    if (typeof enabled !== "boolean")
      fail("Expected enabled to be a boolean", 400);
    this.engine.config.network = {
      ...this.engine.config.network,
      allowLanHttp: enabled,
    };
    this.engine.store.saveConfig();
    return this.status();
  }
  maintain() {
    this.maintenance = this.maintenance
      .catch(() => {})
      .then(() => this.updateListener());
    return this.maintenance;
  }
  async updateListener() {
    if (this.stopping) return;
    const state = await this.detector.read();
    const enabled =
      this.engine.config.network?.mode === "tailscale" &&
      state.state === "connected";
    const address = enabled
      ? this.discoveryHost ||
        state.self.addresses.find((ip) => !ip.includes(":")) ||
        state.self.addresses[0]
      : null;
    if (this.listener && this.address !== address) {
      await this.stopListener();
    }
    if (!address || this.listener) return;
    // Wildcard binding is only for containers whose port is mapped to the host's Tailscale IP.
    if (
      this.discoveryHost &&
      (!fs.existsSync("/.dockerenv") || state.source !== "host-file")
    ) {
      this.issue =
        "A discovery host override requires Docker and a host status file.";
      return;
    }
    if (["0.0.0.0", "::", address].includes(this.mainHost)) return;
    const server = http.createServer((req, res) => this.apiHandler(req, res));
    server.requestTimeout = 5000;
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(this.port || this.engine.config.port, address, resolve);
      });
      this.listener = server;
      this.address = address;
      this.issue = null;
      server.on("error", () => {
        this.issue = "Tailscale discovery listener failed.";
      });
    } catch {
      server.close();
      this.issue =
        "Cannot listen on the Tailscale address. Check the Arca port and the network interface.";
    }
  }
  async stopListener() {
    const server = this.listener;
    this.listener = null;
    this.address = null;
    if (server)
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      });
  }
  async start() {
    await this.maintain();
    this.timer = setInterval(() => this.maintain().catch(() => {}), 15000);
    this.timer.unref();
  }
  async close() {
    this.stopping = true;
    clearInterval(this.timer);
    await this.maintenance;
    await this.stopListener();
  }
}
