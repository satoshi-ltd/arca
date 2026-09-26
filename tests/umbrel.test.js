import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { init } from "../packages/daemon/storage.js";
import { start } from "../packages/daemon/server.js";
import { issueWebCode } from "../packages/daemon/web.js";

const repo = fileURLToPath(new URL("../", import.meta.url));
const source = path.join(repo, "deploy/umbrel/arca");
const password = "a".repeat(64); // Disposable fixture, never an installation credential.
function render(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arca-umbrel-"));
  for (const file of fs
    .readdirSync(source)
    .filter((f) => f.endsWith(".template"))) {
    const text = fs.readFileSync(path.join(source, file), "utf8");
    // Umbrel applies envsubst. Runtime templates must not accidentally contain
    // shell-style variables that it would replace or erase.
    assert.doesNotMatch(text, /\$\{?[A-Za-z_]/);
    fs.writeFileSync(path.join(root, file.replace(/\.template$/, "")), text);
  }
  return root;
}
const remove = (root) =>
  fs.promises.rm(root, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });

test("Umbrel initialization preserves existing identity, pause and files; refuses incomplete state", async (t) => {
  const root = render(t);
  t.after(() => remove(root));
  const home = path.join(root, "state");
  const files = path.join(root, "files");
  const backup = path.join(root, "backup");
  fs.mkdirSync(files);
  fs.mkdirSync(backup);
  fs.writeFileSync(path.join(files, ".gitkeep"), "");
  fs.writeFileSync(path.join(backup, ".gitkeep"), "");
  const run = () =>
    execFileSync(process.execPath, [path.join(root, "umbrel-init.mjs")], {
      env: {
        ...process.env,
        ARCA_APP_DIR: repo,
        ARCA_HOME: home,
        ARCA_FILES: files,
        ARCA_BACKUP: backup,
      },
      stdio: "pipe",
    });
  run();
  assert.deepEqual(fs.readdirSync(backup), [], "the backup mount starts empty");
  const configPath = path.join(home, "config.json");
  const config = JSON.parse(fs.readFileSync(configPath));
  assert.equal(config.role, "replica");
  assert.equal(fs.existsSync(path.join(files, ".gitkeep")), false);
  assert.equal(config.needsSetup, true);
  assert.equal(config.onboarding, false);
  assert.equal(config.root, fs.realpathSync(files));
  config.paused = true;
  fs.writeFileSync(configPath, JSON.stringify(config));
  fs.writeFileSync(path.join(files, "keep.txt"), "user file");
  const before = fs.readFileSync(configPath);
  run();
  assert.deepEqual(fs.readFileSync(configPath), before);
  assert.equal(
    fs.readFileSync(path.join(files, "keep.txt"), "utf8"),
    "user file",
  );
  fs.unlinkSync(configPath);
  fs.writeFileSync(path.join(home, "index.sqlite"), "existing state");
  assert.throws(run, /State exists without its configuration/);
  assert.equal(fs.existsSync(configPath), false);
});

test("Umbrel mounts the backup folder so a hub backup survives container recreation", () => {
  const compose = fs.readFileSync(path.join(source, "docker-compose.yml"), "utf8").replace(/\r\n/g, "\n");
  const service = (name) => compose.split(/\n  (?=\w+:\n)/).find((block) => block.startsWith(name + ":"));
  for (const name of ["initialize", "server"])
    assert.match(service(name), /- \$\{APP_DATA_DIR\}\/data\/backup:\/data\/backup\n/, name);
  assert.match(service("initialize"), /ARCA_BACKUP: \/data\/backup/);
  assert.equal(fs.statSync(path.join(source, "data", "backup", ".gitkeep")).size, 0);
});

test("Umbrel access uses real single-use codes, preserves CSRF, pairing, streaming sync and restart persistence", async (t) => {
  const root = render(t);
  const { createAccess } = await import(
    pathToFileURL(path.join(root, "umbrel-access.mjs"))
  );
  const home = path.join(root, "hub");
  init(home, { port: 0 });
  let hub = await start(home, { timer: false });
  let access;
  let replica;
  t.after(async () => {
    if (replica) await replica.close();
    if (access) {
      access.closeAllConnections();
      await new Promise((r) => access.close(r));
    }
    await hub.close();
    await remove(root);
  });
  const launch = async () => {
    access = createAccess({
      password,
      home,
      upstream: "http://127.0.0.1:" + hub.port,
      assets: root,
      issueCode: issueWebCode,
    });
    await new Promise((r) => access.listen(0, "127.0.0.1", r));
    return "http://127.0.0.1:" + access.address().port;
  };
  let url = await launch();
  const post = (route, data, headers = {}) =>
    fetch(url + route, {
      method: "POST",
      headers: { Origin: url, "Content-Type": "application/json", ...headers },
      body: JSON.stringify(data),
    });
  assert.equal((await fetch(url + "/umbrel")).status, 200);
  assert.equal((await fetch(url + "/tokens.css")).status, 200);
  assert.equal((await fetch(url + "/v1/status")).status, 401);
  assert.equal(
    (await post("/umbrel/code", { password }, { Origin: "http://evil.test" }))
      .status,
    403,
  );
  assert.equal((await post("/umbrel/code", { password: "wrong" })).status, 401);
  assert.equal(
    (await post("/umbrel/code", { password }, { "Content-Type": "text/plain" }))
      .status,
    415,
  );
  const issued = await post("/umbrel/code", { password });
  assert.equal(issued.status, 200);
  assert.equal(issued.headers.get("cache-control"), "no-store");
  const data = await issued.json();
  assert.match(data.code, /^\d{6}$/);
  assert.equal(data.expiresInMinutes, 10);
  assert.doesNotMatch(
    fs.readFileSync(path.join(home, "web-code.json"), "utf8"),
    new RegExp(data.code),
  );
  const logged = await post("/auth/login", { code: data.code });
  assert.equal(logged.status, 200);
  const cookie = logged.headers.get("set-cookie").split(";")[0];
  assert.match(logged.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
  assert.equal((await post("/auth/login", { code: data.code })).status, 401);
  assert.equal(
    (
      await post(
        "/v1/volumes",
        { name: "Rejected" },
        { Cookie: cookie, Origin: "http://evil.test" },
      )
    ).status,
    403,
  );
  const published = await post(
    "/v1/volumes",
    { name: "Umbrel files" },
    { Cookie: cookie },
  );
  assert.equal(published.status, 201);
  const volume = await published.json();
  const pairing = await post(
    "/v1/pairing",
    { name: "Test replica" },
    { Cookie: cookie },
  );
  assert.equal(pairing.status, 201);
  const invite = await pairing.json();
  const paired = await fetch(url + "/pair", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: invite.code, name: "Test replica" }),
  });
  assert.equal(paired.status, 201);
  const device = await paired.json();
  const denied = await fetch(url + "/v1/pairing", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + device.token,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  assert.equal(denied.status, 403);
  const replicaHome = path.join(root, "replica");
  init(replicaHome, { port: 0, role: "replica" });
  replica = await start(replicaHome, { timer: false });
  const connected = await fetch(
    "http://127.0.0.1:" + replica.port + "/v1/connect",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + replica.engine.config.adminToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url, token: device.token }),
    },
  );
  assert.equal(connected.status, 200);
  await replica.engine.select(volume.id);
  const bytes = Buffer.alloc(2 * 1024 * 1024, 37);
  fs.writeFileSync(
    path.join(hub.engine.store.volume(volume.id).path, "large.bin"),
    bytes,
  );
  await hub.engine.cycle();
  await replica.engine.cycle();
  const local = replica.engine.store.volume(volume.id).path;
  assert.deepEqual(fs.readFileSync(path.join(local, "large.bin")), bytes);
  fs.writeFileSync(
    path.join(local, "from-replica.txt"),
    "uploaded through gateway",
  );
  await replica.engine.cycle();
  assert.equal(
    fs.readFileSync(
      path.join(hub.engine.store.volume(volume.id).path, "from-replica.txt"),
      "utf8",
    ),
    "uploaded through gateway",
  );
  const id = hub.engine.config.id;
  await replica.close();
  replica = null;
  access.closeAllConnections();
  await new Promise((r) => access.close(r));
  access = null;
  await hub.close();
  hub = await start(home, { timer: false });
  url = await launch();
  assert.equal(hub.engine.config.id, id);
  assert.equal(
    (await fetch(url + "/v1/status", { headers: { Cookie: cookie } })).status,
    401,
  );
  assert.deepEqual(
    fs.readFileSync(
      path.join(hub.engine.store.volume(volume.id).path, "large.bin"),
    ),
    bytes,
  );
  assert.equal((await post("/umbrel/code", { password })).status, 200);
});

test("Umbrel code issuer fails closed without the per-install secret and limits password guesses", async (t) => {
  const root = render(t);
  const { createAccess } = await import(
    pathToFileURL(path.join(root, "umbrel-access.mjs"))
  );
  const options = {
    home: root,
    upstream: "http://127.0.0.1:1",
    assets: root,
    issueCode: () => {
      throw Error("must not issue");
    },
  };
  assert.throws(() => createAccess({ ...options, password: "" }), /password/);
  assert.throws(
    () => createAccess({ ...options, password: "short" }),
    /password/,
  );
  const access = createAccess({ ...options, password });
  await new Promise((r) => access.listen(0, "127.0.0.1", r));
  t.after(async () => {
    access.closeAllConnections();
    await new Promise((r) => access.close(r));
    await remove(root);
  });
  const url = "http://127.0.0.1:" + access.address().port;
  for (let n = 0; n < 6; n++) {
    const r = await fetch(url + "/umbrel/code", {
      method: "POST",
      headers: { Origin: url, "Content-Type": "application/json" },
      body: JSON.stringify({ password: "wrong" }),
    });
    assert.equal(r.status, n < 5 ? 401 : 429);
  }
  assert.equal((await fetch(url + "/")).status, 502);
});
