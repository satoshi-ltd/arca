import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { init } from "../packages/daemon/storage.js";
import { start } from "../packages/daemon/server.js";
import { issueWebCode } from "../packages/daemon/web.js";
import {
  shortCode,
  normalizeCode,
  Attempts,
} from "../packages/daemon/codes.js";
test("numeric codes preserve zeroes and accept grouping; persistent credentials stay distinct", () => {
  for (let i = 0; i < 100; i++) assert.match(shortCode(), /^\d{6}$/);
  assert.equal(normalizeCode("001-002", "W"), "001002");
  assert.equal(normalizeCode("001002", "P"), "001002");
  assert.equal(normalizeCode("1", "W"), "");
  let now = 0;
  const rate = new Attempts(() => now);
  for (let i = 0; i < 5; i++) rate.check("a");
  assert.throws(
    () => rate.check("a"),
    (e) => e.status === 429,
  );
  now = 60001;
  assert.doesNotThrow(() => rate.check("a"));
});
test("web and pairing failure budgets persist across daemon restarts", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-codes-"));
  init(home, { port: 0 });
  let daemon = await start(home, { timer: false });
  t.after(async () => {
    await daemon.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const post = (route, b, web = false) =>
    fetch(`http://127.0.0.1:${daemon.port}${route}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(web
          ? { origin: `http://127.0.0.1:${daemon.port}` }
          : { authorization: `Bearer ${daemon.engine.config.adminToken}` }),
      },
      body: JSON.stringify(b),
    });
  const web = issueWebCode(home);
  assert.match(web.code, /^\d{6}$/);
  const wrong = web.code === "000000" ? "000001" : "000000";
  for (let i = 0; i < 4; i++)
    assert.equal(
      (await post("/auth/login", { code: wrong }, true)).status,
      401,
    );
  await daemon.close();
  daemon = await start(home, { timer: false });
  assert.equal((await post("/auth/login", { code: wrong }, true)).status, 429);
  assert.equal(fs.existsSync(path.join(home, "web-code.json")), false);
  assert.equal(
    (await post("/auth/login", { code: web.code }, true)).status,
    401,
  );
  const invite = await (await post("/v1/pairing", { name: "Laptop" })).json();
  assert.match(invite.code, /^\d{6}$/);
  const wrongPair = invite.code === "000000" ? "000001" : "000000";
  for (let i = 0; i < 4; i++)
    assert.equal((await post("/pair", { code: wrongPair })).status, 401);
  await daemon.close();
  daemon = await start(home, { timer: false });
  assert.equal((await post("/pair", { code: wrongPair })).status, 429);
  assert.equal(
    daemon.engine.store.db.prepare("SELECT COUNT(*) AS n FROM pairing").get().n,
    0,
  );
  assert.equal((await post("/pair", { code: invite.code })).status, 429);
});
test("issuing a new pairing code replaces the old invitation; grouped code works once", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-invite-"));
  init(home, { port: 0 });
  const d = await start(home, { timer: false });
  t.after(async () => {
    await d.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const post = (route, b) =>
    fetch(`http://127.0.0.1:${d.port}${route}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${d.engine.config.adminToken}`,
      },
      body: JSON.stringify(b),
    });
  const old = await (await post("/v1/pairing", { name: "Old" })).json();
  const next = await (await post("/v1/pairing", { name: "New" })).json();
  assert.equal(
    d.engine.store.db.prepare("SELECT COUNT(*) AS n FROM pairing").get().n,
    1,
  );
  if (old.code !== next.code)
    assert.equal((await post("/pair", { code: old.code })).status, 401);
  const response = await post("/pair", {
    code: next.code.slice(0, 3) + "-" + next.code.slice(3),
  });
  assert.equal(response.status, 201);
  assert.match((await response.json()).token, /^[a-f0-9]{64}$/);
  assert.equal((await post("/pair", { code: next.code })).status, 401);
});
