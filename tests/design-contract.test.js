import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { init, digest } from "../packages/daemon/storage.js";
import { start } from "../packages/daemon/server.js";
import { issueWebCode } from "../packages/daemon/web.js";
test("design APIs: bounded filtered history, permissions, session revocation and local assets", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-design-"));
  init(home, { port: 0 });
  const d = await start(home, { timer: false });
  t.after(async () => {
    await d.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${d.port}`;
  const token = d.engine.config.adminToken;
  const request = (route, body, credential = token) =>
    fetch(url + route, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: "Bearer " + credential,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const v = d.engine.store.addVolume("Design");
  const candidate = path.join(d.engine.config.root, "Preflight only");
  const checked = await request("/v1/path-check", { path: candidate });
  assert.equal(checked.status, 200);
  const pathInfo = await checked.json();
  assert.equal(pathInfo.exists, false);
  assert.ok(pathInfo.freeBytes >= 0);
  assert.equal(
    fs.existsSync(candidate),
    false,
    "Preflight must not create directories",
  );
  const duplicate = await request("/v1/path-check", { path: v.path });
  assert.equal(duplicate.status, 400);
  assert.match((await duplicate.json()).error, /Already linked to "Design"/);
  const nested = await request("/v1/path-check", {
    path: path.join(v.path, "nested"),
  });
  assert.match((await nested.json()).error, /parent and child folders/);
  assert.equal(
    (await request("/v1/path-check", { path: candidate }, "invalid")).status,
    401,
  );

  fs.writeFileSync(path.join(v.path, "note.txt"), "one");
  await d.engine.cycle();
  fs.writeFileSync(path.join(v.path, "note.txt"), "two");
  await d.engine.cycle();
  fs.unlinkSync(path.join(v.path, "note.txt"));
  await d.engine.cycle();
  const page = await (await request("/v1/activity?limit=2")).json();
  assert.equal(page.versions.length, 2);
  assert.ok(page.next);
  const next = await (
    await request("/v1/activity?limit=2&before=" + page.next)
  ).json();
  assert.equal(next.versions.length, 1);
  assert.equal(next.next, null);
  assert.ok([...page.versions, ...next.versions].every((row) => !row.deleted));
  assert.ok(next.versions[0].rev < page.next);
  const deleted = await (await request("/v1/activity?filter=deleted")).json();
  assert.equal(deleted.versions.length, 1);
  assert.equal(deleted.versions[0].deleted, 1);
  assert.equal((await request("/v1/activity?limit=10000")).status, 400);
  assert.equal(
    (await request("/v1/locate-folder", { id: v.id, path: v.path })).status,
    409,
  );
  const moved = v.path + "-moved";
  fs.renameSync(v.path, moved);
  const missingRegistered = await request("/v1/path-check", { path: v.path });
  assert.equal(missingRegistered.status, 400);
  assert.match(
    (await missingRegistered.json()).error,
    /directory is missing.*still registered/,
  );
  assert.equal(
    fs.existsSync(v.path),
    false,
    "Preflight must not recreate a missing share",
  );
  assert.equal(
    d.engine.store.volume(v.id).path,
    v.path,
    "Preflight preserves the catalog mapping",
  );

  assert.equal(
    (await request("/v1/locate-folder", { id: v.id, path: candidate })).status,
    409,
  );
  assert.equal(fs.existsSync(candidate), false);
  const located = await request("/v1/locate-folder", { id: v.id, path: moved });
  assert.equal(located.status, 200);
  assert.equal(d.engine.store.volume(v.id).path, fs.realpathSync(moved));

  assert.equal(
    (await request("/v1/activity", undefined, "invalid")).status,
    401,
  );
  const invite = await (
    await request("/v1/devices", { name: "Replica", role: "replica" })
  ).json();
  assert.equal(
    (
      await request(
        "/v1/settings",
        { name: "Changed by replica" },
        invite.token,
      )
    ).status,
    403,
  );
  assert.equal(
    (await request("/v1/settings", { name: "Renamed hub" })).status,
    200,
  );
  assert.equal(d.engine.config.name, "Renamed hub");
  assert.equal((await request("/v1/settings", { name: "" })).status, 400);
  const { code } = issueWebCode(home);
  const login = await fetch(url + "/auth/login", {
    method: "POST",
    headers: { origin: url, "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  assert.equal(
    (await fetch(url + "/v1/status", { headers: { cookie } })).status,
    200,
  );
  assert.equal(
    (await request("/v1/web-sessions/revoke", {}, invite.token)).status,
    403,
  );
  assert.equal((await request("/v1/web-sessions/revoke", {})).status, 200);
  assert.equal(
    (await fetch(url + "/v1/status", { headers: { cookie } })).status,
    401,
  );
  for (const [asset, type] of [
    ["/tokens.css", "text/css"],
    ["/vendor/lucide.js", "text/javascript"],
    ["/assets/arca-icon.svg", "image/svg+xml"],
    ["/assets/fonts/instrument-sans.woff2", "font/woff2"],
    ["/assets/fonts/fragment-mono.woff2", "font/woff2"],
  ]) {
    const response = await fetch(url + asset);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), type);
    assert.ok((await response.arrayBuffer()).byteLength > 100);
  }
  assert.equal(
    (await request("/v1/pause", { paused: true, seconds: -1 })).status,
    400,
  );
  await request("/v1/pause", { paused: true, seconds: 1 });
  d.engine.pauseUntil = Date.now() - 1;
  await d.engine.cycle();
  assert.equal(d.engine.paused, false);
});
test("conflict review restores chosen content and rejects stale decisions without removing either history", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-conflict-design-"));
  init(home, { port: 0 });
  const d = await start(home, { timer: false });
  t.after(async () => {
    await d.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const s = d.engine.store,
    v = s.addVolume("Docs");
  const conflict = "note.txt.conflict-machine-operation";
  fs.writeFileSync(path.join(v.path, "note.txt"), "original");
  fs.writeFileSync(path.join(v.path, conflict), "alternative");
  await d.engine.cycle();
  const original = s.current(v.id, "note.txt"),
    other = s.current(v.id, conflict);
  const body = {
    volume: v.id,
    path: conflict,
    choice: "conflict",
    originalRev: original.rev,
    conflictRev: other.rev,
  };
  const request = (b) =>
    fetch(`http://127.0.0.1:${d.port}/v1/conflict-choice`, {
      method: "POST",
      headers: {
        authorization: "Bearer " + d.engine.config.adminToken,
        "content-type": "application/json",
      },
      body: JSON.stringify(b),
    });
  s.db
    .prepare("INSERT INTO devices(id,name,token_hash,role) VALUES(?,?,?,?)")
    .run("test-replica", "Test replica", digest("test-credential"), "replica");
  const replicaChoice = () =>
    fetch(`http://127.0.0.1:${d.port}/v1/conflict-choice`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-credential",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  assert.equal(
    (await replicaChoice()).status,
    409,
    "A replica without a selected-folder report cannot resolve",
  );
  assert.equal(s.current(v.id, "note.txt").rev, original.rev);
  assert.equal(s.unresolvedConflicts(v.id), 1);
  const conflictIncident = s.conflictRevision(v.id);
  assert.ok(conflictIncident > 0);
  s.db
    .prepare("INSERT INTO machine_reports VALUES(?,?)")
    .run("test-replica", JSON.stringify({ folderIds: [v.id] }));
  assert.equal(
    (await replicaChoice()).status,
    200,
    "A replica selecting the folder can resolve",
  );
  assert.equal(
    fs.readFileSync(path.join(v.path, "note.txt"), "utf8"),
    "alternative",
  );
  assert.equal(
    fs.readFileSync(path.join(v.path, conflict), "utf8"),
    "alternative",
  );
  assert.equal(s.unresolvedConflicts(v.id), 0);
  assert.equal(
    s.conflictRevision(v.id),
    conflictIncident,
    "Resolution alone does not create another incident",
  );
  assert.equal(s.conflictStatus(s.current(v.id, conflict)).resolved, true);
  assert.equal(
    s.conflictStatus(s.current(v.id, conflict)).resolutionRev,
    s.current(v.id, "note.txt").rev,
  );
  assert.equal(s.history(v.id, "note.txt").length, 2);
  assert.equal((await request(body)).status, 409);
  assert.equal((await request({ ...body, path: "note.txt" })).status, 400);
  const originalBefore = s.current(v.id, "note.txt").rev;
  fs.writeFileSync(path.join(v.path, conflict), "a different later edit");
  await d.engine.cycle();
  assert.equal(s.unresolvedConflicts(v.id), 1);
  assert.equal(s.conflictStatus(s.current(v.id, conflict)).resolved, false);
  assert.ok(
    s.conflictRevision(v.id) > conflictIncident,
    "Editing a conflict creates a new notification incident",
  );
  assert.equal(s.current(v.id, "note.txt").rev, originalBefore);
});

test("background sync acknowledges before completion, coalesces requests and exposes failures", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-async-sync-"));
  init(home, { port: 0 });
  const d = await start(home, { timer: false });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  t.after(async () => {
    release();
    await d.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  let cycles = 0;
  d.engine.cycle = async () => {
    cycles++;
    await gate;
    d.engine.error = "Test transfer failure";
  };
  const request = (route, body) =>
    fetch(`http://127.0.0.1:${d.port}${route}`, {
      method: body ? "POST" : "GET",
      headers: {
        authorization: `Bearer ${d.engine.config.adminToken}`,
        "content-type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(2000),
    });
  assert.equal((await request("/v1/sync", { background: true })).status, 202);
  assert.equal((await request("/v1/sync", { background: true })).status, 202);
  assert.equal((await request("/v1/status")).status, 200);
  assert.equal(cycles, 1);
  release();
  await d.engine.tail;
  const status = await (await request("/v1/status")).json();
  assert.equal(status.error, "Test transfer failure");
});

test("replica credentials cannot administer the hub; replica administrators cannot create hub resources", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-role-boundary-"));
  init(home, { port: 0 });
  const hub = await start(home, { timer: false });
  t.after(async () => {
    await hub.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const call = (route, token, body) =>
    fetch(`http://127.0.0.1:${hub.port}${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const admin = hub.engine.config.adminToken;
  const before = hub.engine.config.name;
  for (const role of ["replica"]) {
    const device = await (
      await call("/v1/devices", admin, { name: role, role })
    ).json();
    for (const route of [
      "/v1/volumes",
      "/v1/delete-share",
      "/v1/rename-share",
      "/v1/ignore-policy",
      "/v1/pairing",
      "/v1/devices",
      "/v1/revoke",
      "/v1/settings",
      "/v1/network",
      "/v1/network/lan",
      "/v1/retention",
      "/v1/promote",
      "/v1/backup",
      "/v1/pause",
    ]) {
      const response = await call(route, device.token, {});
      assert.equal(
        response.status,
        403,
        `${role} ${route}: ${await response.text()}`,
      );
    }
    assert.equal((await call("/v1/machines", device.token)).status, 200);
    assert.equal((await call("/v1/status", device.token)).status, 403);
  }
  assert.equal(hub.engine.config.name, before);
  assert.equal(hub.engine.store.volumes().length, 0);
  hub.engine.config.role = "replica";
  for (const route of [
    "/v1/volumes",
    "/v1/pairing",
    "/v1/delete-share",
    "/v1/rename-share",
    "/v1/devices",
    "/v1/revoke",
    "/v1/retention",
  ])
    assert.ok(
      [403, 409].includes((await call(route, admin, {})).status),
      route,
    );
});
