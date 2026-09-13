import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  initializeServer,
  inspectSetupRoot,
} from "../packages/daemon/setup.js";
import { init } from "../packages/daemon/storage.js";
import { start } from "../packages/daemon/server.js";
import { issueWebCode } from "../packages/daemon/web.js";

const temporary = () =>
  fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "arca-server-setup-")));

test("Umbrel ships the same setup module as Docker; persistent roots reject escapes and existing content", () => {
  assert.equal(
    fs.readFileSync(
      new URL(
        "../deploy/umbrel/arca/server-setup.js.template",
        import.meta.url,
      ),
      "utf8",
    ),
    fs.readFileSync(
      new URL("../packages/daemon/setup.js", import.meta.url),
      "utf8",
    ),
  );
  const root = temporary();
  const previous = process.env.ARCA_FILES;
  try {
    const files = path.join(root, "files");
    fs.mkdirSync(files);
    process.env.ARCA_FILES = files;
    assert.equal(
      inspectSetupRoot(path.join(files, "chosen"), path.join(root, "state"))
        .root,
      path.join(files, "chosen"),
    );
    assert.throws(() => inspectSetupRoot(root, path.join(root, "state")));
    fs.symlinkSync(root, path.join(files, "escape"), "dir");
    assert.throws(
      () =>
        inspectSetupRoot(
          path.join(files, "escape", "outside"),
          path.join(root, "state"),
        ),
      /persistent server storage/,
    );
    fs.mkdirSync(path.join(files, "occupied"));
    fs.writeFileSync(path.join(files, "occupied", "keep"), "preserve");
    assert.throws(
      () =>
        inspectSetupRoot(
          path.join(files, "occupied"),
          path.join(root, "state"),
        ),
      /empty or new/,
    );
  } finally {
    if (previous === undefined) delete process.env.ARCA_FILES;
    else process.env.ARCA_FILES = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const role of ["hub", "replica"])
  test(
    "authenticated server wizard chooses " +
      role +
      " and resumes across restarts",
    async (t) => {
      const root = temporary();
      const home = path.join(root, "server");
      const files = path.join(root, "files");
      const initial = initializeServer(home, { root: files, port: 0 });
      assert.equal(initial.needsSetup, true);
      let daemon = await start(home, { timer: false });
      let hub;
      t.after(async () => {
        await daemon.close();
        if (hub) await hub.close();
        fs.rmSync(root, { recursive: true, force: true });
      });
      let cookie;
      const call = async (route, data, authenticated = true) => {
        const url = "http://127.0.0.1:" + daemon.port;
        const response = await fetch(url + route, {
          method: data === undefined ? "GET" : "POST",
          headers: {
            Origin: url,
            "Content-Type": "application/json",
            ...(authenticated ? { Cookie: cookie } : {}),
          },
          ...(data === undefined ? {} : { body: JSON.stringify(data) }),
        });
        return {
          status: response.status,
          body: await response.json(),
          headers: response.headers,
        };
      };
      const login = async () => {
        const result = await call(
          "/auth/login",
          { code: issueWebCode(home).code },
          false,
        );
        assert.equal(result.status, 200);
        cookie = result.headers.get("set-cookie").split(";")[0];
      };
      assert.equal(
        (await call("/v1/setup", { name: "Server", role, root: files }, false))
          .status,
        401,
      );
      await login();
      assert.equal(
        (await call("/v1/volumes", { name: "Too early" })).status,
        409,
      );
      assert.equal(
        (await call("/v1/pairing", { name: "Too early" })).status,
        409,
      );
      await daemon.close();
      initializeServer(home, { root: "/ignored", name: "Ignored" });
      daemon = await start(home, { timer: false });
      await login();
      assert.equal((await call("/v1/status")).body.needsSetup, true);
      assert.equal(
        (
          await call("/v1/setup", {
            name: "Chosen server",
            role,
            root: files,
            onboarding: true,
          })
        ).status,
        200,
      );
      let hubCredential;
      if (role === "replica") {
        const hubHome = path.join(root, "hub");
        init(hubHome, { role: "hub", port: 0 });
        hub = await start(hubHome, { timer: false });
        const response = await fetch(
          "http://127.0.0.1:" + hub.port + "/v1/pairing",
          {
            method: "POST",
            headers: {
              Authorization: "Bearer " + hub.engine.config.adminToken,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ name: "Server replica" }),
          },
        );
        const invite = await response.json();
        assert.equal(
          (
            await call("/v1/connect", {
              url: "http://127.0.0.1:" + hub.port,
              code: invite.code,
            })
          ).status,
          200,
        );
        hubCredential = daemon.engine.config.hub.token;
        assert.ok(hubCredential);
      }
      assert.equal(daemon.engine.store.volumes().length, 0);
      await daemon.close();
      initializeServer(home);
      daemon = await start(home, { timer: false });
      await login();
      assert.equal(daemon.engine.config.onboarding, true);
      if (hubCredential)
        assert.equal(daemon.engine.config.hub.token, hubCredential);
      assert.equal(
        (await call("/v1/setup", { name: "Chosen server", role, root: files }))
          .status,
        200,
      );
      assert.equal(daemon.engine.config.role, role);
      assert.equal(daemon.engine.config.onboarding, false);
      assert.equal(daemon.engine.config.id, initial.id);
      if (role === "replica")
        assert.equal(
          (await call("/v1/volumes", { name: "No hub authority" })).status,
          403,
        );
      daemon.engine.config.paused = true;
      daemon.engine.store.saveConfig();
      const before = fs.readFileSync(path.join(home, "config.json"));
      initializeServer(home, { name: "Do not replace", root: "/ignored" });
      assert.deepEqual(fs.readFileSync(path.join(home, "config.json")), before);
      assert.equal(
        (await call("/v1/setup", { name: "Overwrite", role, root: files }))
          .status,
        409,
      );
    },
  );

test("Docker's daemon --setup starts fresh state and preserves explicit CLI initialization", async (t) => {
  const root = temporary();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const configured of [false, true]) {
    const home = path.join(root, configured ? "existing" : "fresh");
    if (configured)
      init(home, {
        role: "hub",
        port: 0,
        root: path.join(root, "existing-files"),
      });
    const before =
      configured && fs.readFileSync(path.join(home, "config.json"));
    const child = spawn(
      process.execPath,
      [
        "packages/cli/arca.js",
        "daemon",
        "--setup",
        "--home",
        home,
        "--port",
        "0",
      ],
      {
        env: { ...process.env, ARCA_FILES: path.join(root, "fresh-files") },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "",
      errors = "";
    child.stderr.on("data", (data) => {
      errors += data;
    });
    try {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Daemon did not start: " + errors)),
          15000,
        );
        child.stdout.on("data", (data) => {
          output += data;
          if (output.includes("listening on")) {
            clearTimeout(timeout);
            resolve();
          }
        });
        child.once("exit", (code) => {
          clearTimeout(timeout);
          reject(new Error("Early exit " + code + ": " + errors));
        });
      });
      const config = JSON.parse(
        fs.readFileSync(path.join(home, "config.json")),
      );
      assert.equal(Boolean(config.needsSetup), !configured);
      if (configured) assert.equal(config.id, JSON.parse(before).id);
      else assert.equal(config.root, path.join(root, "fresh-files"));
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  }
});
