import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isIP } from "node:net";
const execute = promisify(execFile);
export function tailAddress(address) {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return a === 100 && b >= 64 && b <= 127;
  }
  return (
    isIP(address) === 6 && address.toLowerCase().startsWith("fd7a:115c:a1e0:")
  );
}
export function normalizeStatus(raw, source) {
  if (!raw || typeof raw.BackendState !== "string")
    throw new Error("Invalid Tailscale status");
  const node = (p, self = false) => ({
    id: String(p.ID || p.PublicKey || p.HostName || "").slice(0, 200),
    name: String(p.HostName || p.DNSName || "Unknown device").slice(0, 200),
    dnsName: String(p.DNSName || "").slice(0, 253),
    os: String(p.OS || "unknown").slice(0, 40),
    addresses: (Array.isArray(p.TailscaleIPs) ? p.TailscaleIPs : []).filter(
      tailAddress,
    ),
    online: p.Online === true,
    self,
  });
  const self = node(raw.Self || {}, true);
  return {
    installed: true,
    state:
      raw.BackendState === "Running" && self.addresses.length
        ? "connected"
        : "disconnected",
    backendState: raw.BackendState,
    source,
    self,
    peers: Object.values(raw.Peer || {})
      .map((p) => node(p))
      .filter((p) => p.addresses.length),
    checkedAt: new Date().toISOString(),
  };
}
export class Tailscale {
  constructor({
    run = execute,
    statusFile = process.env.ARCA_TAILSCALE_STATUS_FILE,
    now = Date.now,
  } = {}) {
    this.run = run;
    this.statusFile = statusFile;
    this.now = now;
    this.cached = null;
    this.inflight = null;
  }
  async read(force = false) {
    if (!force && this.cached && this.now() - this.cached.time < 15000)
      return this.cached.value;
    if (this.inflight) return this.inflight;
    this.inflight = this.detect()
      .then((value) => {
        this.cached = { time: this.now(), value };
        return value;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }
  async detect() {
    if (this.statusFile) {
      try {
        const stat = await fs.stat(this.statusFile);
        if (this.now() - stat.mtimeMs > 90000 || stat.size > 2 * 1024 * 1024)
          throw new Error("Host Tailscale status is stale or too large");
        return normalizeStatus(
          JSON.parse(await fs.readFile(this.statusFile, "utf8")),
          "host-file",
        );
      } catch {
        return {
          installed: null,
          state: "unavailable",
          source: "host-file",
          error:
            "Host Tailscale status is missing, invalid or older than 90 seconds.",
          peers: [],
        };
      }
    }
    const candidates =
      process.platform === "darwin"
        ? [
            "tailscale",
            "/usr/local/bin/tailscale",
            "/opt/homebrew/bin/tailscale",
            "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
          ]
        : process.platform === "win32"
          ? [
              "tailscale.exe",
              `${process.env.ProgramFiles || "C:\\Program Files"}\\Tailscale\\tailscale.exe`,
            ]
          : ["tailscale", "/usr/bin/tailscale", "/usr/local/bin/tailscale"];
    let found = false;
    for (const binary of candidates) {
      try {
        const { stdout } = await this.run(binary, ["status", "--json"], {
          timeout: 4000,
          maxBuffer: 2 * 1024 * 1024,
          env: { ...process.env, TERM: "xterm", SHLVL: "1" },
          windowsHide: true,
        });
        return normalizeStatus(JSON.parse(stdout), "cli");
      } catch (error) {
        if (error.code !== "ENOENT") found = true;
      }
    }
    return {
      installed: found,
      state: found ? "unavailable" : "not-installed",
      source: "cli",
      error: found
        ? "Tailscale is installed but its status is unavailable. Check that it is running and signed in."
        : "Tailscale was not found on this device.",
      peers: [],
    };
  }
}
export async function probeArca(peer, { fetcher = fetch, port = 47831 } = {}) {
  if (!peer.online) return { state: "offline" };
  for (const address of peer.addresses.filter(tailAddress)) {
    const origin = `http://${isIP(address) === 6 ? `[${address}]` : address}:${port}`;
    try {
      const response = await fetcher(`${origin}/.well-known/arca`, {
        redirect: "error",
        signal: AbortSignal.timeout(1800),
      });
      if (!response.ok) {
        await response.body?.cancel();
        continue;
      }
      let text = "";
      for await (const chunk of response.body) {
        text += Buffer.from(chunk).toString();
        if (text.length > 8192) throw new Error("Discovery response too large");
      }
      const info = JSON.parse(text);
      if (
        info.service !== "arca" ||
        info.discoveryVersion !== 1 ||
        typeof info.id !== "string" ||
        info.id.length > 100 ||
        !["hub", "replica", "backup"].includes(info.role) ||
        !Number.isInteger(info.apiPort) ||
        info.apiPort < 1 ||
        info.apiPort > 65535
      )
        continue;
      return {
        state: info.protocol !== 1 ? "incompatible" : "available",
        id: info.id,
        name: String(info.name || "Arca").slice(0, 200),
        version: String(info.version || "unknown").slice(0, 40),
        role: info.role,
        platform: String(info.platform || "unknown").slice(0, 40),
        deployment: ["docker", "native"].includes(info.deployment)
          ? info.deployment
          : "unknown",
        client:
          info.client &&
          ["desktop", "mobile"].includes(info.client.kind) &&
          info.client.active === true
            ? { kind: info.client.kind, active: true }
            : null,
        endpoint: `http://${isIP(address) === 6 ? `[${address}]` : address}:${info.apiPort}`,
      };
    } catch {
      /* A closed/filtered port does not prove Arca is not installed. */
    }
  }
  return { state: "not-detected" };
}
export async function discoverPeers(snapshot, options = {}) {
  if (snapshot.state !== "connected") return [];
  const peers = snapshot.peers.map((p) => ({
    ...p,
    arca: { state: "not-checked" },
  }));
  let next = 0;
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (next < Math.min(peers.length, 128)) {
        const index = next++;
        peers[index].arca = await probeArca(peers[index], options);
      }
    }),
  );
  return peers;
}
