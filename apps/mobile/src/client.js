import {
  abortable,
  abortRequest,
  cancellationReason,
} from "./request-control.js";
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
  constructor(message, status, code) {
    super(message);
    this.status = status;
    if (code) this.code = code;
    if ([502, 503, 504].includes(status)) this.hubUnavailable = true;
  }
}
const timedOut = () =>
  Object.assign(new Error("Hub request timed out"), { code: "HUB_TIMEOUT" });

export function createClient({
  secrets,
  cache,
  fetcher = globalThis.fetch,
  timeout = 15000,
  fileTransfers = false,
  resolvePrivateURL = null,
}) {
  let connection = null;
  let catalog = null;
  let busy = false;
  async function rawRequest(url, route, token, options = {}) {
    if (!route.startsWith("/v1/") && route !== "/pair")
      throw new Error("Invalid hub route");
    const limit = options.timeout || timeout;
    const deadline = Date.now() + limit;
    const controller = new AbortController();
    const cancel = () =>
      abortRequest(controller, cancellationReason(options.signal));
    if (options.signal?.aborted) cancel();
    else options.signal?.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(
      () => abortRequest(controller, timedOut()),
      limit,
    );
    let response;
    try {
      if (url.startsWith("http:")) {
        if (!resolvePrivateURL)
          throw new Error("Private network verification is unavailable");
        url = await abortable(() => resolvePrivateURL(url), controller.signal);
      }
      const perform = async () => {
        if (controller.signal.aborted)
          throw cancellationReason(controller.signal);
        return fetcher(url + route, {
          ...options,
          redirect: "error",
          signal: controller.signal,
          headers: {
            ...options.headers,
            "X-Arca-Directories": "1",
            "X-Arca-Path-Transitions": "1",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
        });
      };
      // File writes finish in native code before cancellation releases the sync
      // turn, so a resumed download cannot race a late write to its partial file.
      response = options.transfer
        ? await perform()
        : await abortable(perform, controller.signal);
      if (controller.signal.aborted)
        throw cancellationReason(controller.signal);
    } catch (error) {
      if (controller.signal.aborted)
        throw cancellationReason(controller.signal);
      throw error;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", cancel);
    }
    const consume = async (method) => {
      if (
        response.buffered &&
        !controller.signal.aborted &&
        !options.signal?.aborted
      )
        return response[method]();
      const remaining = deadline - Date.now();
      if (remaining <= 0) abortRequest(controller, timedOut());
      if (options.signal?.aborted) cancel();
      else options.signal?.addEventListener("abort", cancel, { once: true });
      const bodyTimer = setTimeout(
        () => abortRequest(controller, timedOut()),
        Math.max(0, remaining),
      );
      try {
        return await abortable(() => response[method](), controller.signal);
      } finally {
        clearTimeout(bodyTimer);
        options.signal?.removeEventListener("abort", cancel);
      }
    };
    if (!response.ok) {
      let data;
      try {
        data = await consume("json");
      } catch (error) {
        if (controller.signal.aborted)
          throw cancellationReason(controller.signal) || error;
      }
      if (
        response.status === 401 &&
        token &&
        connection?.token === token &&
        !connection.leaving
      ) {
        await secrets.clear();
        connection = null;
      }
      throw new HubError(
        data?.error ||
          ([502, 503, 504].includes(response.status)
            ? `Hub unavailable (HTTP ${response.status}).`
            : "The hub could not complete the request."),
        response.status,
        typeof data?.code === "string" ? data.code : undefined,
      );
    }
    return {
      ok: response.ok,
      status: response.status,
      headers: response.headers,
      bytesWritten: response.bytesWritten,
      json: () => consume("json"),
      arrayBuffer: () => consume("arrayBuffer"),
      text: () => consume("text"),
    };
  }
  async function request(url, route, token, body, options = {}) {
    const response = await rawRequest(url, route, token, {
      ...options,
      ...(body === undefined
        ? {}
        : {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }),
    });
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
        !(
          (Number.isSafeInteger(volume.files) &&
            volume.files >= 0 &&
            Number.isSafeInteger(volume.bytes) &&
            volume.bytes >= 0) ||
          (typeof volume.policyError === "string" &&
            volume.files === null &&
            volume.bytes === null)
        )
      )
        throw new Error("The hub returned an invalid folder catalog.");
    }
    return data;
  }
  async function serial(work) {
    if (busy)
      throw Object.assign(
        new Error("Wait for the current operation to finish."),
        { code: "CLIENT_BUSY" },
      );
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
  async function refresh(options = {}) {
    if (!connection) return state();
    if (connection.leaving) {
      await leave();
      return state();
    }
    try {
      const next = validateCatalog(
        await request(
          connection.url,
          "/v1/catalog",
          connection.token,
          undefined,
          options,
        ),
        connection.hubId,
      );
      const saved = { ...next, fetchedAt: Date.now() };
      await cache.write(saved);
      catalog = saved;
    } catch (error) {
      if (error.status === 401) {
        await secrets.clear();
        connection = null;
      }
      throw error;
    }
    return state();
  }
  let refreshing = null;
  return {
    state,
    fileTransfers,
    raw: authenticated,
    async api(route, body, options = {}) {
      const r = await authenticated(route, {
        ...options,
        ...(body === undefined
          ? {}
          : {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            }),
      });
      return r.json();
    },
    async load() {
      connection = await secrets.read();
      catalog = await cache.read();
      return state();
    },
    refresh: function shared(options = {}) {
      if (!refreshing) {
        refreshing = serial(() => refresh(options)).finally(() => {
          refreshing = null;
        });
        refreshing.signal = options.signal;
      }
      const joined = refreshing;
      if (options.signal) return abortable(() => joined, options.signal);
      // A refresh stopped by the sync that started it is retried for callers that never cancelled.
      return joined.catch((error) => {
        if (joined.signal?.aborted) return shared();
        throw error;
      });
    },
    pair: (address, code, name) =>
      serial(async () => {
        if (connection)
          throw new Error("Disconnect the current hub before pairing again.");
        let url = hubAddress(address, !!resolvePrivateURL);
        if (url.startsWith("http:")) {
          const controller = new AbortController();
          const timer = setTimeout(
            () => abortRequest(controller, timedOut()),
            timeout,
          );
          try {
            url = await abortable(
              () => resolvePrivateURL(url),
              controller.signal,
            );
          } finally {
            clearTimeout(timer);
          }
        }
        const normalized = code.replace(/[\s-]/g, "");
        if (!/^\d{6}$/.test(normalized))
          throw new Error("Enter the six-digit pairing code.");
        const paired = await request(url, "/pair", null, {
          code: normalized,
          ...(name ? { name } : {}),
        });
        if (
          typeof paired.token !== "string" ||
          !paired.token ||
          typeof paired.id !== "string" ||
          typeof paired.hubId !== "string"
        )
          throw new Error("The hub returned an invalid pairing response.");
        // Persist immediately: the pairing code has now been consumed.
        const next = { url, ...paired };
        await secrets.write(next);
        connection = next;
        catalog = null;
        await cache.write(null);
        return refresh();
      }),
    destroy: () =>
      serial(async () => {
        if (connection) {
          // Hub cleanup is best effort; local destruction must work offline.
          const controller = new AbortController();
          let timer;
          try {
            await Promise.race([
              rawRequest(connection.url, "/v1/leave", connection.token, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: "{}",
                signal: controller.signal,
              }).catch(() => {}),
              new Promise((resolve) => {
                timer = setTimeout(() => {
                  controller.abort();
                  resolve();
                }, 1000);
              }),
            ]);
          } finally {
            clearTimeout(timer);
          }
        }
        await secrets.clear();
        connection = null;
        await cache.write(null);
        catalog = null;
        return state();
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
