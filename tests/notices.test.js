import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  createNoticeStore,
  conditionNotices,
  errorNotice,
  noticeMetrics,
  safeDetails,
} from "../apps/desktop/src/notice-contract.js";

test("notice queue stacks three, expires only info and suppresses dismissed conditions until recovery or change", () => {
  const timers = new Map();
  let tick = 0,
    key = 0;
  const store = createNoticeStore({
    now: () => ++tick,
    schedule: (fn, ms) => {
      assert.equal(ms, 4000);
      timers.set(++key, fn);
      return key;
    },
    cancel: (id) => timers.delete(id),
  });
  store.push({ id: "a", kind: "info", title: "Saved" });
  store.push({ id: "b", kind: "warning", title: "Conflict" });
  store.push({ id: "c", kind: "error", title: "Stopped" });
  store.push({ id: "d", kind: "info", title: "Restored" });
  assert.deepEqual(
    store.snapshot().map((n) => n.id),
    ["b", "c", "d"],
  );
  for (const fn of [...timers.values()]) fn();
  assert.deepEqual(
    store.snapshot().map((n) => n.id),
    ["b", "c"],
  );
  store.reconcile([{ id: "hub", kind: "error", title: "Offline" }]);
  store.remove("status:hub");
  store.reconcile([{ id: "hub", kind: "error", title: "Offline" }]);
  assert.ok(!store.snapshot().some((n) => n.id === "status:hub"));
  store.reconcile([]);
  store.reconcile([{ id: "hub", kind: "error", title: "Offline" }]);
  assert.ok(store.snapshot().some((n) => n.id === "status:hub"));
  const created = store.snapshot().at(-1).created;
  store.reconcile([{ id: "hub", kind: "error", title: "Offline" }]);
  assert.equal(store.snapshot().at(-1).created, created);
  store.dispose();
  assert.equal(timers.size, 0);
});
test("conditions use per-folder identities and the same human copy for app and system", () => {
  const items = conditionNotices({
    hubName: "Casa",
    volumes: [
      { id: "a", name: "Projects", conflicts: 9 },
      { id: "b", name: "Photos", issue: "E_VERIFY_MISMATCH" },
    ],
    backup: { error: "Disk full" },
  });
  assert.equal(items.length, 3);
  assert.equal(items[0].title, "Conflict in Projects");
  assert.equal(items[0].actionLabel, "Review");
  assert.equal(items[1].volume, "b");
  assert.equal(items[2].actionLabel, "Backup settings");
  assert.equal(conditionNotices({ volumes: [] }).length, 0);
  const offline = errorNotice("connect ETIMEDOUT", { hubName: "Casa" });
  assert.equal(offline.offline, true);
  assert.match(offline.title, /Casa unreachable/);
  assert.equal(offline.actionLabel, "Retry now");
  assert.ok(
    !safeDetails(
      "GET https://user:pass@example.test token=abc Authorization: Bearer xyz",
    ).includes("abc"),
  );
  assert.ok(!safeDetails("Bearer xyz").includes("xyz"));
  assert.equal(
    safeDetails('{"token":"abc","password":"def"}'),
    '{"token":"[redacted]","password":"[redacted]"}',
  );
});
test("Android native connection failures show a grouped outage with collapsed diagnostics", () => {
  const message = "Call to function 'ArcaNetwork.request' has been rejected. → Caused by: java.net.ConnectException: Failed to connect to /192.168.1.190:17831";
  const notice = errorNotice(message, { hubName: "Casa" });
  assert.equal(notice.offline, true);
  assert.equal(notice.cause, "connection");
  assert.equal(notice.title, "Hub Casa unreachable");
  assert.equal(notice.details, message);
  assert.doesNotMatch(notice.body, /java|ArcaNetwork|192\.168/);
  const grouped = conditionNotices({ hubName: "Casa", volumes: [
    { id: "a", issue: message }, { id: "b", issue: message },
  ] });
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].cause, "connection");
});
test("notice geometry and colors are tokenized consistently across renderers", async () => {
  const css = fs.readFileSync(
    new URL("../apps/desktop/src/tokens.css", import.meta.url),
    "utf8",
  );
  for (const [key, token] of Object.entries({
    width: "width",
    inset: "inset",
    radius: "radius",
    padding: "padding",
    gap: "gap",
    icon: "icon",
    title: "title",
    body: "body",
    line: "line",
    detailsHeight: "details-height",
    duration: "duration",
  }))
    assert.equal(
      Number(css.match(new RegExp(`--notice-${token}:\\s*([\\d.]+)`))[1]),
      noticeMetrics[key],
    );
  const { palettes } = await import("../apps/mobile/src/palette.js");
  const [light, dark] = css.split('[data-theme="dark"] {');
  for (const [key, token] of Object.entries({
    noticeSurface: "surface",
    noticeInfoBg: "info-bg",
    noticeInfoFg: "info-fg",
    noticeInfoLink: "info-link",
    noticeLink: "link",
  }))
    for (const [theme, source] of [
      ["light", light],
      ["dark", dark],
    ])
      assert.equal(
        palettes[theme][key],
        source.match(new RegExp(`--notice-${token}:\\s*(#[\\da-f]+)`))[1],
      );
});

test("one hub outage owns folder, backup and action failures without hiding independent failures", () => {
  const conditions = conditionNotices({
    hubName: "Casa",
    error: "fetch failed",
    backup: { error: "connect ECONNREFUSED" },
    volumes: [
      { id: "a", name: "A", selected: true, issue: "ETIMEDOUT" },
      { id: "b", name: "B", selected: true, issue: "fetch failed" },
      { id: "c", name: "C", selected: true, issue: "Disk full" },
      {
        id: "d",
        name: "D",
        selected: false,
        issue: "Path missing",
        conflicts: 1,
      },
    ],
  });
  assert.deepEqual(
    conditions.map((n) => n.id),
    ["folder:c", "connection"],
  );
  assert.equal(conditions[1].title, "Hub Casa unreachable");
  const store = createNoticeStore();
  store.push(errorNotice("fetch failed"));
  store.reconcile(conditions);
  assert.equal(
    store.snapshot().filter((n) => n.cause === "connection").length,
    1,
  );
  store.push(errorNotice("ETIMEDOUT"));
  assert.equal(
    store.snapshot().filter((n) => n.cause === "connection").length,
    1,
  );
  store.dispose();
});

test("403 requests permission without suggesting re-pairing; 401 requests sign-in without claiming revocation", () => {
  const denied = errorNotice(
    'Hub 403: {"error":"Local administrator credential required"}',
  );
  assert.equal(denied.title, "Permission required");
  assert.equal(denied.action, null);
  assert.equal(denied.cause, "");
  assert.equal(
    errorNotice("Hub 401: Unauthorized").title,
    "Hub sign-in required",
  );
  assert.equal(errorNotice("Machine access revoked").action, "pair");
});

test("authoritative conflict resolution clears local notices and a new revision reopens a dismissed incident", () => {
  const status = {
    volumes: [{ id: "a", name: "A", selected: true, conflicts: 9 }],
    catalog: { volumes: [{ id: "a", conflicts: 1, conflictRevision: 7 }] },
  };
  const store = createNoticeStore();
  store.reconcile(conditionNotices(status));
  store.remove("status:conflict:a");
  store.reconcile(conditionNotices(status));
  assert.equal(store.snapshot().length, 0);
  status.catalog.volumes[0].conflictRevision = 8;
  store.reconcile(conditionNotices(status));
  assert.equal(store.snapshot()[0].incident, 8);
  status.catalog.volumes[0].conflicts = 0;
  store.reconcile(conditionNotices(status));
  assert.equal(store.snapshot().length, 0);
  store.dispose();
});


test("mobile LAN policy reachability failure is a connection condition", () => {
  const message = "Cannot reach the hub over the local network. Connect this device to the hub’s Wi-Fi or Ethernet network and try again.";
  assert.equal(errorNotice(message).offline, true);
  assert.equal(errorNotice(message).cause, "connection");
});

test("connection outages are recognised by code or transport text, never by local source failures", async () => {
  const { isHubUnreachable } =
    await import("../apps/desktop/src/notice-contract.js");
  for (const value of [
    "Cannot connect using this address. For local Wi-Fi, enter the hub’s private IP address. To use a Tailscale name or address, connect Tailscale on this device and the hub.",
    "The connection to the hub was interrupted. Check the connection and try again.",
    "Call to function 'ArcaNetwork.request' has been rejected.\n→ Caused by: java.net.SocketException: Connection reset",
    "Call to function 'ArcaNetwork.request' has been rejected.\n→ Caused by: java.lang.IllegalStateException: Connect Tailscale on this device and the hub",
    "Call to function 'ArcaNetwork.request' has been rejected.\n→ Caused by: java.net.UnknownHostException: Unable to resolve host",
    "UnexpectedException: Could not connect to the server. (at ExpoModulesCore/ConcurrentFunctionDefinition.swift:90)",
    "UnexpectedException: The network connection was lost.",
    "A server with the specified hostname could not be found.",
    "A data connection is not currently allowed.",
    "Tailscale access unavailable",
    "Hub 503: Service Unavailable",
    "Hub unavailable (HTTP 502).",
    "connect ECONNREFUSED 127.0.0.1:17831",
    "getaddrinfo ENOTFOUND casa.local",
    Object.assign(new Error("Anything"), { code: "HUB_UNREACHABLE" }),
    Object.assign(new Error("Anything"), { code: "CONNECTION_LOST" }),
    "The request timed out.",
    "The operation was aborted due to timeout",
    "The Internet connection appears to be offline.",
    "connect EHOSTUNREACH: host is unreachable",
    Object.assign(new Error("Anything"), { hubUnavailable: true }),
  ]) {
    assert.equal(isHubUnreachable(value), true, String(value?.message || value));
    const notice = errorNotice(value, { hubName: "Casa" });
    assert.equal(notice.cause, "connection");
    assert.equal(notice.title, "Hub Casa unreachable");
  }
  for (const value of [
    "java.io.FileNotFoundException: Inputstream for content://provider/doc was null.",
    "Reconnect from Machines.",
    "Too many active snapshots; retry after snapshots expire",
    "Original download timed out. Keep Arca open and retry.",
    "Photo export timed out. Keep Arca open and retry.",
    "Could not read offline-notes.txt from the app that provides it. Download it on this phone and add it again.",
    "ENOENT: no such file or directory, open '/storage/emulated/0/Download/offline-maps.zip'",
    "EACCES: permission denied, open '/Photos/unreachable peaks/timed out.jpg'",
    "Enable Allow HTTP on local network in the hub's Settings first.",
    Object.assign(new Error("Hub request timed out"), {
      code: "SOURCE_UNAVAILABLE",
    }),
  ])
    assert.equal(
      isHubUnreachable(value),
      false,
      String(value?.message || value),
    );
});
