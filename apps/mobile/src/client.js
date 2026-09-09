// Platform-independent replica client. Native persistence is injected.
export function hubAddress(input, privateNetwork = false) {
  let url;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error(
      "Enter the full hub address, including https:// and its port.",
    );
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["", "/"].includes(url.pathname)
  )
    throw new Error("Enter only the hub address and port.");
  if (
    url.protocol !== "https:" &&
    !(privateNetwork && url.protocol === "http:")
  )
    throw new Error("Use HTTPS, or HTTP through a verified private network.");
  return url.origin;
}

export class HubError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export function createClient({
  secrets,
  cache,
  fetcher = globalThis.fetch,
  timeout = 15000,
  resolvePrivateURL = null,
}) {
  let connection = null;
  let catalog = null;
  let busy = false;
  async function rawRequest(url, route, token, options = {}) {
    if (!route.startsWith("/v1/") && route !== "/pair")
      throw new Error("Invalid hub route");
    if (url.startsWith("http:")) {
      if (!resolvePrivateURL)
        throw new Error("Private network verification is unavailable");
      url = await resolvePrivateURL(url);
    }
    const response = await fetcher(url + route, {
      ...options,
      redirect: "error",
      signal: options.signal || globalThis.AbortSignal?.timeout?.(timeout),
      headers: {
        ...options.headers,
        "X-Arca-Directories": "1",
        "X-Arca-Path-Transitions": "1",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    if (!response.ok) {
      let data;
      try {
        data = await response.json();
      } catch {}
      if (
        [401, 403].includes(response.status) &&
        token &&
        connection?.token === token &&
        !connection.leaving
      ) {
        await secrets.clear();
        connection = null;
      }
      throw new HubError(
        data?.error || "The hub could not complete the request.",
        response.status,
      );
    }
    return response;
  }
  async function request(url, route, token, body) {
    const response = await rawRequest(
      url,
      route,
      token,
      body === undefined
        ? {}
        : {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
    );
    return response.json();
  }
  async function authenticated(route, options = {}) {
    if (!connection || connection.leaving)
      throw new Error("Connect to your hub first");
    return rawRequest(connection.url, route, connection.token, options);
  }
  function validateCatalog(data, id) {
    if (data?.protocol !== 1 || data.id !== id || !Array.isArray(data.volumes))
      throw new Error(
        "The hub identity or protocol changed. Reconnect from Machines.",
      );
    for (const volume of data.volumes) {
      if (
        typeof volume.id !== "string" ||
        typeof volume.name !== "string" ||
        !Number.isSafeInteger(volume.files) ||
        volume.files < 0 ||
        !Number.isSafeInteger(volume.bytes) ||
        volume.bytes < 0
      )
        throw new Error("The hub returned an invalid folder catalog.");
    }
    return data;
  }
  async function serial(work) {
    if (busy) throw new Error("Wait for the current operation to finish.");
    busy = true;
    try {
      return await work();
    } finally {
      busy = false;
    }
  }
  function state() {
    return {
      connection: connection
        ? {
            id: connection.id,
            url: connection.url,
            hubId: connection.hubId,
            linked: !connection.leaving,
            leaving: !!connection.leaving,
          }
        : null,
      catalog,
    };
  }
  async function leave() {
    try {
      await request(connection.url, "/v1/leave", connection.token, {});
    } catch (error) {
      if (![401, 403].includes(error.status)) throw error;
    }
    await secrets.clear();
    connection = null;
  }
  async function refresh() {
    if (!connection) return state();
    if (connection.leaving) {
      await leave();
      return state();
    }
    try {
      const next = validateCatalog(
        await request(connection.url, "/v1/catalog", connection.token),
        connection.hubId,
      );
      const saved = { ...next, fetchedAt: Date.now() };
      await cache.write(saved);
      catalog = saved;
    } catch (error) {
      if ([401, 403].includes(error.status)) {
        await secrets.clear();
        connection = null;
      }
      throw error;
    }
    return state();
  }
  return {
    state,
    raw: authenticated,
    async api(route, body) {
      const r = await authenticated(
        route,
        body === undefined
          ? {}
          : {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            },
      );
      return r.json();
    },
    async load() {
      connection = await secrets.read();
      catalog = await cache.read();
      return state();
    },
    refresh: () => serial(refresh),
    pair: (address, code) =>
      serial(async () => {
        if (connection)
          throw new Error("Disconnect the current hub before pairing again.");
        let url = hubAddress(address, !!resolvePrivateURL);
        if (url.startsWith("http:")) url = await resolvePrivateURL(url);
        const normalized = code.replace(/[\s-]/g, "");
        if (!/^\d{6}$/.test(normalized))
          throw new Error("Enter the six-digit pairing code.");
        const paired = await request(url, "/pair", null, { code: normalized });
        if (
          typeof paired.token !== "string" ||
          !paired.token ||
          typeof paired.id !== "string" ||
          typeof paired.hubId !== "string"
        )
          throw new Error("The hub returned an invalid pairing response.");
        // Persist immediately: the pairing code has now been consumed.
        connection = { url, ...paired };
        await secrets.write(connection);
        catalog = null;
        await cache.write(null);
        return refresh();
      }),
    disconnect: () =>
      serial(async () => {
        if (!connection) return state();
        connection = { ...connection, leaving: true };
        await secrets.write(connection);
        await leave();
        return state();
      }),
    history: (volume, before) =>
      serial(async () => {
        if (!connection || connection.leaving)
          throw new Error("Connect to your hub to view history.");
        await refresh();
        const query = new URLSearchParams({
          ...(volume ? { volume } : {}),
          limit: "50",
          ...(before ? { before: String(before) } : {}),
        });
        return request(
          connection.url,
          `/v1/activity?${query}`,
          connection.token,
        );
      }),
  };
}
