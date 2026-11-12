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
  assert.equal(list.requests[0].reference, undefined, "the pending list never shows the number the approver must type");
  assert.equal(list.requests[0].expires - list.requests[0].created, 600000);
  assert.equal(list.requests[0].browser, "Browser");
  assert.equal(
    (await (await auth({ ...r, secret: "wrong", action: "poll" })).json())
      .state,
    "ended",
  );
  const answers = await Promise.all([
    api("/v1/web-approvals", { id: r.id, decision: "allow", reference: r.reference }, secret),
    api("/v1/web-approvals", { id: r.id, decision: "allow", reference: r.reference }, secret),
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
  await api("/v1/web-approvals", { id: revoked.id, decision: "allow", reference: revoked.reference }, secret);
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
test("Allow must carry the browser's number, and a wrong or missing one ends only that request", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-approval-ref-"));
  init(home, { port: 0 });
  const d = await start(home, { timer: false });
  t.after(async () => {
    await d.close();
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const base = `http://127.0.0.1:${d.port}`,
    secret = token();
  d.engine.store.db
    .prepare("INSERT INTO devices(id,name,token_hash,role) VALUES('device','Mac',?,'replica')")
    .run(digest(secret));
  d.engine.config.webApprovers = ["device"];
  const auth = async (body) =>
    (
      await fetch(base + "/auth/approval", {
        method: "POST",
        headers: { Origin: base, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
    ).json();
  const decide = (body) =>
    fetch(base + "/v1/web-approvals", {
      method: "POST",
      headers: { Authorization: "Bearer " + secret, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const pending = async () =>
    (
      await (await fetch(base + "/v1/web-approvals", { headers: { Authorization: "Bearer " + secret } })).json()
    ).requests.map((r) => r.id);
  const intruder = await auth({ action: "create" });
  const mine = await auth({ action: "create" });
  assert.notEqual(intruder.reference, mine.reference);
  assert.deepEqual((await pending()).sort(), [intruder.id, mine.id].sort());
  const wrong = await decide({ id: intruder.id, decision: "allow", reference: mine.reference });
  assert.equal(wrong.status, 422);
  assert.equal((await wrong.json()).error, "That number belongs to a different request.");
  assert.equal((await auth({ ...intruder, action: "poll" })).state, "ended", "a mismatch ends the request it was typed on");
  assert.deepEqual(await pending(), [mine.id], "the other request stays pending");
  const missing = await auth({ action: "create" });
  assert.equal((await decide({ id: missing.id, decision: "allow" })).status, 422);
  assert.equal((await auth({ ...missing, action: "poll" })).state, "ended");
  assert.equal((await decide({ id: missing.id, decision: "allow", reference: missing.reference })).status, 409, "an ended request cannot be retried");
  assert.equal((await auth({ ...mine, action: "poll" })).state, "pending");
  const grouped = `${mine.reference.slice(0, 3)}-${mine.reference.slice(3)}`;
  assert.equal((await decide({ id: mine.id, decision: "allow", reference: grouped })).status, 200);
  const login = await fetch(base + "/auth/approval", {
    method: "POST",
    headers: { Origin: base, "Content-Type": "application/json" },
    body: JSON.stringify({ ...mine, action: "poll" }),
  });
  assert.match(login.headers.get("set-cookie"), /arca_session=/);
  const denied = await auth({ action: "create" });
  assert.equal((await decide({ id: denied.id, decision: "deny" })).status, 200, "Deny needs no number");
  assert.equal((await auth({ ...denied, action: "poll" })).state, "denied");
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
  for (const host of ["127.0.0.1:17831", "[fe80::1]:17831", "100.64.0.9", "localhost:17831", "casa", "nas.local", "Casa.Local.", "2130706433"])
    assert.equal(trustedHost(host), true, host);
  for (const host of ["evil.test", "evil.test:17831", "casa.tail1234.ts.net", "", "a b", "127.0.0.1.nip.io", undefined, "evil.test:80@127.0.0.1", "127.0.0.1/x"])
    assert.equal(trustedHost(host), false, host);
  assert.equal(trustedHost("casa.tail1234.ts.net:17831", ["casa.tail1234.ts.net"]), true);
});

test("the hub counts pending web sign-in requests and tells only approvers, apart from the sync cursor, when one starts or ends", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-approval-feed-"));
  init(home, { port: 0 });
  const d = await start(home, { timer: false });
  t.after(async () => {
    await d.close();
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const approver = token(),
    bystander = token();
  const insert = d.engine.store.db.prepare("INSERT INTO devices(id,name,token_hash,role) VALUES(?,?,?,'replica')");
  insert.run("device", "Mac", digest(approver));
  insert.run("other", "Laptop", digest(bystander));
  d.engine.config.webApprovers = [d.engine.config.id, "device"];
  const base = `http://127.0.0.1:${d.port}`;
  const call = async (route, body, key = d.engine.config.adminToken, signal) =>
    (
      await fetch(base + route, {
        method: body ? "POST" : "GET",
        signal,
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "X-Arca-Directories": "1", "X-Arca-Path-Transitions": "1" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
    ).json();
  const auth = async (body) =>
    (
      await fetch(base + "/auth/approval", {
        method: "POST",
        headers: { Origin: base, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
    ).json();
  const events = (key, query = {}, signal) => call(`/v1/events?${new URLSearchParams(query)}`, undefined, key, signal);
  assert.equal((await call("/v1/status")).webApprovals, 0);
  const { cursor, approvals } = await events(approver);
  assert.match(approvals, /^[0-9a-f]+:\d+$/);
  assert.equal((await events(bystander)).approvals, undefined, "a device that may not approve never sees the field");
  const waiting = events(approver, { after: cursor, approvals });
  const idle = new AbortController();
  let bystanderWoke = false;
  events(bystander, { after: cursor, approvals: "" }, idle.signal).then(() => (bystanderWoke = true), () => {});
  const first = await auth({ action: "create" });
  const second = await auth({ action: "create" });
  const woke = await waiting;
  assert.equal(woke.cursor, cursor, "a sign-in request never moves the sync cursor");
  assert.notEqual(woke.approvals, approvals, "but wakes an approver waiting on it");
  await new Promise((resolve) => setTimeout(resolve, 1200));
  idle.abort();
  assert.equal(bystanderWoke, false, "a device that may not approve keeps waiting");
  const counted = await call("/v1/status");
  assert.equal(counted.webApprovals, 2);
  for (const key of ["requests", "reference", "browser", "approvals"])
    assert.equal(counted[key], undefined, `status carries no ${key}`);
  assert.doesNotMatch(JSON.stringify(counted), new RegExp(`${first.reference}|${second.reference}|${first.id}|${second.id}`));
  let before = (await events(approver)).approvals;
  await call("/v1/web-approvals", { id: first.id, decision: "deny" }, approver);
  let after = await events(approver, { after: cursor, approvals: before });
  assert.equal(after.cursor, cursor);
  assert.notEqual(after.approvals, before, "a decision ends the request");
  assert.equal((await call("/v1/status")).webApprovals, 1);
  before = after.approvals;
  await auth({ ...second, action: "cancel" });
  after = await events(approver);
  assert.notEqual(after.approvals, before, "a cancel ends it too");
  assert.equal((await call("/v1/status")).webApprovals, 0);
  before = after.approvals;
  await auth({ ...second, action: "cancel" });
  assert.equal((await events(approver)).approvals, before, "a request that already ended changes nothing");
  const revoked = events(approver, { after: cursor, approvals: before });
  await call("/v1/web-approvers", { id: "device", enabled: false });
  const answer = await revoked;
  assert.equal(answer.cursor, cursor);
  assert.equal(answer.approvals, undefined, "losing the authority wakes the device and drops the field");
});

test("a request that expires or is ended by a wrong number counts as ended", () => {
  const web = new Web("/unused");
  web.requests.set("old", { id: "old", state: "pending", expires: Date.now() + 1000 });
  web.requests.set("typo", { id: "typo", state: "pending", reference: "123456", expires: Date.now() + 600000 });
  const [boot, first] = web.generation().split(":");
  assert.throws(() => web.decide("typo", "allow", "device", "654321"));
  assert.equal(web.generation(), `${boot}:${Number(first) + 1}`);
  const realNow = Date.now;
  Date.now = () => realNow() + 2000;
  try {
    assert.equal(web.generation(), `${boot}:${Number(first) + 2}`);
    assert.deepEqual(web.pending(), []);
  } finally {
    Date.now = realNow;
  }
  assert.notEqual(new Web("/unused").generation().split(":")[0], boot, "every hub process counts from its own start");
});
