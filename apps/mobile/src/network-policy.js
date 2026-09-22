// Share concurrent discovery reads, but recheck permission on later requests.
const permissions = new Map();
export function clearNetworkVerification() {
  permissions.clear();
}
export async function verifyPrivateURL(value, native, nativeFetch) {
  const url = new URL(value);
  const parts = url.hostname.split(".").map(Number);
  const lan =
    parts.length === 4 &&
    parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) &&
    (parts[0] === 10 ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168));
  if (lan) {
    try {
      await native.resolveLanHost(url.hostname);
    } catch {
      throw new Error(
        "Cannot reach the hub over the local network. Connect this device to the hub’s Wi-Fi or Ethernet network and try again.",
      );
    }
    // Check permission without sending a pairing code or saved credential.
    let cached = permissions.get(url.origin);
    if (!cached) {
      cached = {
        promise: (async () => {
          const response = await nativeFetch(`${url.origin}/.well-known/arca`);
          return response.ok ? response.json() : null;
        })(),
      };
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
    if (info?.access?.allowLanHttp !== true) {
      permissions.delete(url.origin);
      throw new Error(
        "Enable Allow HTTP on local network in the hub's Settings first.",
      );
    }
    return url.origin;
  }
  let address;
  try {
    address = await native.resolvePrivateHost(url.hostname);
  } catch {
    throw new Error(
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
