import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { init, token, digest } from "../packages/daemon/storage.js";
import { start } from "../packages/daemon/server.js";
import { Web, browserLabel } from "../packages/daemon/web.js";
test("web approval requires delegated authority, binds redemption and resolves once", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-approval-"));
  init(home, { port: 0 });
  const d = await start(home, { timer: false });
  t.after(async () => {
    await d.close();
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const base = `http://127.0.0.1:${d.port}`,
    secret = token();
  d.engine.store.db
    .prepare(
      "INSERT INTO devices(id,name,token_hash,role) VALUES('device','Mac',?,'replica')",
    )
    .run(digest(secret));
  const auth = async (body, origin = base) =>
    fetch(base + "/auth/approval", {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        "User-Agent": "Test browser",
      },
      body: JSON.stringify(body),
    });
  const api = async (route, body, key = d.engine.config.adminToken) =>
    fetch(base + route, {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  assert.equal(
    (await auth({ action: "create" }, "https://evil.test")).status,
    403,
  );
  assert.equal((await auth({ action: "create" })).status, 409);
  assert.equal(
    (await api("/v1/web-approvers", { id: "device", enabled: true }, secret))
      .status,
    403,
  );
  assert.equal(
    (await api("/v1/web-approvers", { id: "device", enabled: true })).status,
    200,
  );
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock++;
  let r;
  try {
    r = await (await auth({ action: "create" })).json();
  } finally {
    Date.now = realNow;
  }
  const list = await (await api("/v1/web-approvals", null, secret)).json();
  assert.equal(list.requests[0].id, r.id);
  assert.equal(list.requests[0].secret, undefined);
  assert.equal(list.requests[0].expires - list.requests[0].created, 600000);
  assert.equal(list.requests[0].browser, "Browser");
  assert.equal(
    (await (await auth({ ...r, secret: "wrong", action: "poll" })).json())
      .state,
    "ended",
  );
  const answers = await Promise.all([
    api("/v1/web-approvals", { id: r.id, decision: "allow" }, secret),
    api("/v1/web-approvals", { id: r.id, decision: "allow" }, secret),
  ]);
  assert.deepEqual(answers.map((x) => x.status).sort(), [200, 409]);
  const login = await auth({ ...r, action: "poll" });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie");
  assert.match(cookie, /HttpOnly; SameSite=Strict/);
  assert.equal(
    (
      await fetch(base + "/v1/status", {
        headers: { Cookie: cookie.split(";")[0] },
      })
    ).status,
    200,
  );
  assert.equal(
    (await (await auth({ ...r, action: "poll" })).json()).state,
    "ended",
  );
  const denied = await (await auth({ action: "create" })).json();
  await api("/v1/web-approvals", { id: denied.id, decision: "deny" }, secret);
  assert.equal(
    (await (await auth({ ...denied, action: "poll" })).json()).state,
    "denied",
  );
  const revoked = await (await auth({ action: "create" })).json();
  await api("/v1/web-approvals", { id: revoked.id, decision: "allow" }, secret);
  await api("/v1/web-approvers", { id: "device", enabled: false });
  assert.equal(
    (await (await auth({ ...revoked, action: "poll" })).json()).state,
    "ended",
  );
  assert.equal(
    (
      await api(
        "/v1/web-approvals",
        { id: revoked.id, decision: "allow" },
        secret,
      )
    ).status,
    403,
  );
  await api("/v1/web-approvers", { id: "device", enabled: true });
  const cancelled = await (await auth({ action: "create" })).json();
  assert.equal(
    (await (await auth({ ...cancelled, action: "cancel" })).json()).state,
    "cancelled",
  );
  assert.equal(
    (
      await api(
        "/v1/web-approvals",
        { id: cancelled.id, decision: "allow" },
        secret,
      )
    ).status,
    409,
  );
  assert.equal((await auth({ action: "create" })).status, 429);
});
test("web approval expires, cancels stale decisions and forgets requests on restart", () => {
  const web = new Web("/unused");
  web.requests.set("expired", {
    id: "expired",
    state: "pending",
    expires: Date.now() - 1,
  });
  assert.deepEqual(web.pending(), []);
  assert.throws(() => web.decide("expired", "allow", "device"));
  const fresh = new Web("/unused");
  assert.equal(fresh.requests.size, 0);
});

test("approval browser descriptions distinguish browsers and never infer a network", () => {
  assert.equal(
    browserLabel(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X) Chrome/140.0 Safari/537.36",
    ),
    "Chrome on macOS",
  );
  assert.equal(
    browserLabel(
      "Mozilla/5.0 (Windows NT 10.0) Chrome/140.0 Safari/537.36 Edg/140.0",
    ),
    "Edge on Windows",
  );
  assert.equal(
    browserLabel(
      "Mozilla/5.0 (iPhone; CPU iPhone OS) FxiOS/140.0 Safari/605.1",
    ),
    "Firefox on iOS",
  );
  assert.equal(
    browserLabel("Mozilla/5.0 (Android) Chrome/140.0 Safari/537.36"),
    "Chrome on Android",
  );
  assert.equal(browserLabel("<script>"), "Browser");
});

test("a page on a rebound hostname gets no approval, no cookie and burns no sign-in attempt", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-rebind-"));
  init(home, { port: 0 });
  const d = await start(home, { timer: false });
  t.after(async () => {
    await d.close();
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  d.engine.config.webApprovers = [d.engine.config.id];
  const { issueWebCode } = await import("../packages/daemon/web.js");
  const { code } = issueWebCode(home);
  const post = (route, body, host) =>
    new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const req = http.request(
        {
          host: "127.0.0.1",
          port: d.port,
          path: route,
          method: "POST",
          headers: {
            Host: host,
            Origin: `http://${host}`,
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(data),
          },
        },
        (res) => {
          let text = "";
          res.on("data", (chunk) => (text += chunk));
          res.on("end", () => resolve({ status: res.statusCode, cookie: res.headers["set-cookie"], body: text }));
        },
      );
      req.on("error", reject);
      req.end(data);
    });
  const rebound = `evil.test:${d.port}`;
  const created = await post("/auth/approval", { action: "create" }, rebound);
  assert.equal(created.status, 403);
  assert.equal(created.cookie, undefined);
  assert.equal((await post("/auth/login", { code: "000000" }, rebound)).status, 403);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, "web-code.json"), "utf8")).failures, 0, "a refused host spends nothing");
  assert.equal((await post("/auth/login", { code }, `attacker.example.com.:${d.port}`)).status, 403);
  for (const host of [`127.0.0.1:${d.port}`, `casa:${d.port}`, `casa.local:${d.port}`, `[::1]:${d.port}`]) {
    const allowed = await post("/auth/approval", { action: "create" }, host);
    assert.equal(allowed.status, 200, host);
    const made = JSON.parse(allowed.body);
    assert.match(made.reference, /^\d{6}$/);
    if (!host.startsWith("casa.local")) await post("/auth/approval", { action: "cancel", id: made.id, secret: made.secret }, host);
  }
  const pending = await (await fetch(`http://127.0.0.1:${d.port}/v1/web-approvals`, { headers: { Authorization: `Bearer ${d.engine.config.adminToken}` } })).json();
  assert.ok(pending.requests.some((r) => r.host === `casa.local:${d.port}`), "the request records the address the browser used");
  d.engine.config.network = { ...d.engine.config.network, webHosts: ["nas.home.arpa"] };
  assert.equal((await post("/auth/approval", { action: "create" }, `nas.home.arpa:${d.port}`)).status, 200, "a configured name is trusted");
});

test("the hub's Tailscale name and ARCA_WEB_HOSTS are trusted, and a session cookie is ignored under any other host", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-hosts-"));
  init(home, { port: 0 });
  const previous = process.env.ARCA_WEB_HOSTS;
  process.env.ARCA_WEB_HOSTS = "a.lan, b.lan";
  const d = await start(home, { timer: false });
  t.after(async () => {
    if (previous === undefined) delete process.env.ARCA_WEB_HOSTS;
    else process.env.ARCA_WEB_HOSTS = previous;
    await d.close();
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  d.network.detector.cached = { time: Date.now(), value: { self: { dnsName: "casa.tail1234.ts.net." } } };
  d.engine.config.network = { ...d.engine.config.network, webHosts: "nas.lan" };
  const { issueWebCode } = await import("../packages/daemon/web.js");
  const request = (route, { method = "POST", host, body, cookie } = {}) =>
    new Promise((resolve, reject) => {
      const data = body === undefined ? "" : JSON.stringify(body);
      const req = http.request(
        {
          host: "127.0.0.1",
          port: d.port,
          path: route,
          method,
          headers: {
            Host: host,
            ...(method === "POST" ? { Origin: `http://${host}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}),
            ...(cookie ? { Cookie: cookie } : {}),
          },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve({ status: res.statusCode, cookie: res.headers["set-cookie"]?.[0] }));
        },
      );
      req.on("error", reject);
      req.end(data);
    });
  for (const host of ["casa.tail1234.ts.net", "a.lan", "b.lan"]) {
    const { code } = issueWebCode(home);
    const signed = await request("/auth/login", { host: `${host}:${d.port}`, body: { code } });
    assert.equal(signed.status, 200, host);
  }
  assert.equal((await request("/auth/login", { host: `nas.lan:${d.port}`, body: { code: "000000" } })).status, 403, "a malformed webHosts value trusts nothing and breaks nothing");
  const { code } = issueWebCode(home);
  const { cookie } = await request("/auth/login", { host: `a.lan:${d.port}`, body: { code } });
  const session = cookie.split(";")[0];
  assert.equal((await request("/v1/status", { method: "GET", host: `a.lan:${d.port}`, cookie: session })).status, 200);
  assert.equal((await request("/v1/status", { method: "GET", host: `evil.test:${d.port}`, cookie: session })).status, 401, "a cookie replayed under another host is not a session");
});

test("trusted hosts are IP literals, single labels, .local names and the configured list", async () => {
  const { trustedHost } = await import("../packages/daemon/web.js");
  for (const host of ["127.0.0.1:17831", "[fe80::1]:17831", "100.64.0.9", "localhost:17831", "casa", "umbrel.local", "Casa.Local.", "2130706433"])
    assert.equal(trustedHost(host), true, host);
  for (const host of ["evil.test", "evil.test:17831", "casa.tail1234.ts.net", "", "a b", "127.0.0.1.nip.io", undefined, "evil.test:80@127.0.0.1", "127.0.0.1/x"])
    assert.equal(trustedHost(host), false, host);
  assert.equal(trustedHost("casa.tail1234.ts.net:17831", ["casa.tail1234.ts.net"]), true);
});
