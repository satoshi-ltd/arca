import http from "node:http";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { init } from "../packages/daemon/storage.js";
import { start } from "../packages/daemon/server.js";
import { issueWebCode } from "../packages/daemon/web.js";
test("single port web, discovery, one-time login, CSRF rejection and logout", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-web-"));
  init(home, { port: 0 });
  const d = await start(home, { timer: false });
  t.after(async () => {
    await d.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${d.port}`;
  assert.equal((await fetch(url)).status, 200);
  const fileIcons = await fetch(url + "/file-icons.js");
  assert.equal(fileIcons.status, 200);
  assert.match(fileIcons.headers.get("content-type"), /javascript/);
  assert.equal(
    await fileIcons.text(),
    fs.readFileSync(
      new URL("../apps/desktop/src/file-icons.js", import.meta.url),
      "utf8",
    ),
  );
  assert.equal((await fetch(url + "/v1/status")).status, 401);
  assert.equal(
    (await (await fetch(url + "/.well-known/arca")).json()).apiPort,
    d.port,
  );
  const { code } = issueWebCode(home);
  const login = (origin, c = code) =>
    fetch(url + "/auth/login", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ code: c }),
    });
  assert.equal((await login("https://evil.test")).status, 403);
  assert.equal((await login(url, "wrong")).status, 401);
  const response = await login(url);
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie").split(";")[0];
  assert.match(response.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
  assert.equal((await login(url)).status, 401);
  assert.equal(
    (await fetch(url + "/v1/status", { headers: { Cookie: cookie } })).status,
    200,
  );
  const create = (origin) =>
    fetch(url + "/v1/volumes", {
      method: "POST",
      headers: {
        Cookie: cookie,
        ...(origin ? { Origin: origin } : {}),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "Web folder" }),
    });
  assert.equal((await create()).status, 403);
  assert.equal((await create("https://evil.test")).status, 403);
  assert.equal((await create(url)).status, 201);
  assert.equal((await fetch(url + "/config.json")).status, 401);
  await fetch(url + "/auth/logout", {
    method: "POST",
    headers: { Origin: url, Cookie: cookie },
  });
  assert.equal(
    (await fetch(url + "/v1/status", { headers: { Cookie: cookie } })).status,
    401,
  );
});

test("explicit HTTPS proxy origin accepts matching host, uses Secure cookies and rejects forwarded-header spoofing", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-proxy-"));
  init(home, { port: 0 });
  const d = await start(home, {
    timer: false,
    webOrigin: "https://arca.example",
  });
  t.after(async () => {
    await d.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const { code } = issueWebCode(home),
    url = `http://127.0.0.1:${d.port}`;
  const login = (host, origin) =>
    new Promise((resolve, reject) => {
      const request = http.request(
        url + "/auth/login",
        {
          method: "POST",
          headers: {
            host,
            origin,
            "content-type": "application/json",
            "x-forwarded-proto": "https",
          },
        },
        (response) => {
          response.resume();
          response.on("end", () =>
            resolve({
              status: response.statusCode,
              headers: { get: (name) => String(response.headers[name] || "") },
            }),
          );
        },
      );
      request.on("error", reject);
      request.end(JSON.stringify({ code }));
    });
  assert.equal(
    (await login("evil.example", "https://arca.example")).status,
    403,
  );
  assert.equal(
    (await login("arca.example", "https://evil.example")).status,
    403,
  );
  const response = await login("arca.example", "https://arca.example");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("set-cookie"), /; Secure/);
});

for (const role of ["hub", "replica"]) {
  test(`desktop ${role} rejects browser access while retaining authenticated API and discovery`, async (t) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-desktop-api-"));
    const config = init(home, { port: 0, role, installation: "desktop" });
    const d = await start(home, { timer: false });
    t.after(async () => {
      await d.close();
      fs.rmSync(home, { recursive: true, force: true });
    });
    const base = `http://127.0.0.1:${d.port}`;
    const admin = { Authorization: `Bearer ${config.adminToken}` };
    for (const route of [
      "/",
      "/index.html",
      "/app.js",
      "/style.css",
      "/tokens.css",
      "/auth/login",
      "/auth/logout",
      "/v1/web-sessions/revoke",
    ]) {
      for (const method of ["GET", "POST"]) {
        const r = await fetch(base + route, { method, headers: admin });
        assert.equal(r.status, 404, `${method} ${route}`);
      }
    }
    assert.throws(() => issueWebCode(home), /not available in the desktop/);
    assert.equal((await fetch(base + "/v1/status")).status, 401);
    assert.equal(
      (
        await fetch(base + "/v1/status", {
          headers: { Cookie: "arca_session=" + "a".repeat(64) },
        })
      ).status,
      401,
    );
    assert.equal(
      (await fetch(base + "/v1/status", { headers: admin })).status,
      200,
    );
    assert.equal(
      (
        await fetch(base + "/v1/status", {
          headers: { ...admin, Origin: base },
        })
      ).status,
      403,
    );
    assert.equal((await fetch(base + "/.well-known/arca")).status, 200);
    if (role === "hub") {
      const invitation = await (
        await fetch(base + "/v1/pairing", {
          method: "POST",
          headers: { ...admin, "Content-Type": "application/json" },
          body: JSON.stringify({ name: "New replica" }),
        })
      ).json();
      const pairing = await fetch(base + "/pair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: invitation.code }),
      });
      assert.equal(pairing.status, 201);
      const { token } = await pairing.json();
      assert.equal(
        (
          await fetch(base + "/v1/catalog", {
            headers: { Authorization: `Bearer ${token}` },
          })
        ).status,
        200,
      );
    }
  });
}

test("server replicas retain web access independently of machine role", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-server-replica-"));
  init(home, { port: 0, role: "replica", installation: "server" });
  const d = await start(home, { timer: false });
  t.after(async () => {
    await d.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  assert.equal((await fetch(`http://127.0.0.1:${d.port}/`)).status, 200);
  assert.match(issueWebCode(home).code, /^\d{6}$/);
});
