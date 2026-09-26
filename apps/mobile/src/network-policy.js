// Share concurrent discovery reads, but recheck permission on later requests.
const permissions = new Map();
const PROBE_TIMEOUT = 5000;
const unreachable = (message) =>
  Object.assign(new Error(message), { code: "HUB_UNREACHABLE" });
const lanUnreachable = () =>
  unreachable(
    "Cannot reach the hub over the local network. Connect this device to the hub’s Wi-Fi or Ethernet network and try again.",
  );
export function clearNetworkVerification() {
  permissions.clear();
}
export function isLanHost(hostname) {
  const parts = String(hostname).split(".").map(Number);
  return (
    parts.length === 4 &&
    parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) &&
    (parts[0] === 10 ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168))
  );
}
async function probe(origin, nativeFetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT);
  try {
    const response = await Promise.race([
      nativeFetch(`${origin}/.well-known/arca`, { signal: controller.signal }),
      new Promise((_, reject) =>
        controller.signal.addEventListener("abort", () =>
          reject(lanUnreachable()),
        ),
      ),
    ]);
    if (!response.ok) throw lanUnreachable();
    const info = await response.json();
    if (!info || typeof info.access !== "object" || !info.access)
      throw lanUnreachable();
    return info;
  } catch {
    throw lanUnreachable();
  } finally {
    clearTimeout(timer);
  }
}
export async function verifyPrivateURL(value, native, nativeFetch) {
  const url = new URL(value);
  if (isLanHost(url.hostname)) {
    try {
      await native.resolveLanHost(url.hostname);
    } catch {
      throw lanUnreachable();
    }
    // Check permission without sending a pairing code or saved credential.
    let cached = permissions.get(url.origin);
    if (!cached) {
      cached = { promise: probe(url.origin, nativeFetch) };
      permissions.set(url.origin, cached);
      if (permissions.size > 8)
        permissions.delete(permissions.keys().next().value);
    }
    let info;
    try {
      info = await cached.promise;
    } finally {
      if (permissions.get(url.origin) === cached)
        permissions.delete(url.origin);
    }
    if (info.access.allowLanHttp !== true)
      throw new Error(
        "Enable Allow HTTP on local network in the hub's Settings first.",
      );
    return url.origin;
  }
  let address;
  try {
    address = await native.resolvePrivateHost(url.hostname);
  } catch {
    throw unreachable(
      "Cannot connect using this address. For local Wi-Fi, enter the hub’s private IP address. To use a Tailscale name or address, connect Tailscale on this device and the hub.",
    );
  }
  if (
    !/^100\.(?:6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.(?:\d{1,3})\.(?:\d{1,3})$/.test(
      address,
    )
  )
    throw new Error("The hub is not on the private network");
  url.hostname = address;
  return url.origin;
}
