import { abortRequest } from "./request-control.js";
import { errorNotice } from "../../desktop/src/notice-contract.js";

function key(route) {
  const [pathname, search = ""] = route.split("?");
  const query = new URLSearchParams(search);
  query.sort();
  return `${pathname}?${query}`;
}
export async function remoteView(replica, route, options = {}) {
  const scope = replica.scope;
  const connectionEpoch = replica.connectionEpoch;
  if (!scope || replica.interactiveClient.state().connection?.hubId !== scope)
    throw new Error("Connect to a hub first");
  const normalized = key(route);
  const controller = new AbortController();
  const cancel = () => abortRequest(controller, new Error("Request cancelled"));
  if (options.signal?.aborted) cancel();
  else options.signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(
    () => abortRequest(controller, new Error("Hub request timed out")),
    3000,
  );
  try {
    if (replica.hubUnavailable) throw new Error("Hub offline");
    const value = await replica.interactiveClient.api(route, undefined, {
      signal: controller.signal,
    });
    if (
      scope !== replica.scope ||
      replica.interactiveClient.state().connection?.hubId !== scope
    )
      throw new Error("Hub changed");
    await replica.store.db.runAsync(
      "INSERT OR REPLACE INTO view_cache VALUES(?,?,?,?)",
      scope,
      normalized,
      Date.now(),
      JSON.stringify(value),
    );
    await replica.store.db.runAsync(
      "DELETE FROM view_cache WHERE scope=? AND route NOT IN (SELECT route FROM view_cache WHERE scope=? ORDER BY updated DESC LIMIT 64)",
      scope,
      scope,
    );
    return value;
  } catch (error) {
    if (options.signal?.aborted || !errorNotice(error).offline) throw error;
    if (!options.silent && replica.connectionEpoch === connectionEpoch) {
      replica.hubUnavailable = true;
      replica.connectionChecked = true;
      replica.changed();
    }
    const cached = await replica.store.db.getFirstAsync(
      "SELECT row FROM view_cache WHERE scope=? AND route=?",
      scope,
      normalized,
    );
    if (cached) return { ...JSON.parse(cached.row), offline: true };
    // Reuse the saved metadata window when page sizes or parameter order differ.
    const [pathname, search] = normalized.split("?");
    const query = new URLSearchParams(search);
    if (pathname === "/v1/activity" || pathname === "/v1/history") {
      const entries = await replica.store.db.getAllAsync(
        "SELECT route,row FROM view_cache WHERE scope=? ORDER BY updated ASC",
        scope,
      );
      const rows = new Map();
      for (const entry of entries) {
        const [p, q] = entry.route.split("?");
        const saved = new URLSearchParams(q);
        if (saved.get("volume") !== query.get("volume")) continue;
        const fileFromActivity =
          pathname === "/v1/history" && p === "/v1/activity";
        if (
          !fileFromActivity &&
          (p !== pathname ||
            saved.get("path") !== query.get("path") ||
            (saved.get("filter") || "revisions") !==
              (query.get("filter") || "revisions"))
        )
          continue;
        for (const row of JSON.parse(entry.row).versions || [])
          if (!fileFromActivity || row.path === query.get("path"))
            rows.set(row.rev, row);
      }
      const before = Number(query.get("before") || Number.MAX_SAFE_INTEGER);
      const limit = Number(query.get("limit") || 50);
      const versions = [...rows.values()]
        .filter((row) => row.rev < before)
        .sort((a, b) => b.rev - a.rev);
      return {
        offline: true,
        versions: versions.slice(0, limit),
        next: versions.length > limit ? versions[limit - 1].rev : null,
      };
    }
    return { offline: true, machines: [] };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
  }
}
export async function warmViews(replica, folders) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => abortRequest(controller, new Error("Request cancelled")),
    3000,
  );
  const cancel = () => abortRequest(controller, new Error("Request cancelled"));
  replica.syncAbort?.signal.addEventListener("abort", cancel, { once: true });
  try {
    const routes = ["/v1/machines"];
    for (const folder of folders) {
      const remote = replica.client
        .state()
        .catalog?.volumes.find((v) => v.id === folder.id);
      if (!remote) continue;
      const retentionKey = `viewRetention:${replica.scope}:${folder.id}`;
      const retention = remote.historyRetention || "1m";
      if ((await replica.store.get(retentionKey)) !== retention) {
        const cached = await replica.store.db.getAllAsync(
          "SELECT route FROM view_cache WHERE scope=?",
          replica.scope,
        );
        for (const item of cached)
          if (
            new URLSearchParams(item.route.split("?")[1]).get("volume") ===
            folder.id
          )
            await replica.store.db.runAsync(
              "DELETE FROM view_cache WHERE scope=? AND route=?",
              replica.scope,
              item.route,
            );
        await replica.store.set(retentionKey, retention);
      }
      for (const filter of ["revisions", "deleted", "conflicts"])
        routes.push(
          `/v1/activity?${new URLSearchParams({ volume: folder.id, filter, limit: "50" })}`,
        );
    }
    for (const route of routes) {
      if (controller.signal.aborted || replica.stopped || replica.paused)
        return;
      const cached = await replica.store.db.getFirstAsync(
        "SELECT updated FROM view_cache WHERE scope=? AND route=?",
        replica.scope,
        key(route),
      );
      if (cached && Date.now() - cached.updated < 60000) continue;
      const value = await remoteView(replica, route, {
        signal: controller.signal,
        silent: true,
      });
      if (value.offline) return;
    }
  } catch {
    /* Optional metadata never fails file synchronization. */
  } finally {
    clearTimeout(timer);
    replica.syncAbort?.signal.removeEventListener("abort", cancel);
  }
}
