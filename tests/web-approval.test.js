import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
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
    fs.rmSync(home, { recursive: true, force: true });
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
  const r = await (await auth({ action: "create" })).json();
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
