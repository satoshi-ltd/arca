import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JSDOM } from "jsdom";
import { init } from "../packages/daemon/storage.js";
import { start } from "../packages/daemon/server.js";
const html = fs.readFileSync(
  new URL("../apps/desktop/src/index.html", import.meta.url),
  "utf8",
);
const script = fs.readFileSync(
  new URL("../apps/desktop/src/app.js", import.meta.url),
  "utf8",
);
async function until(check) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("UI did not reach expected state");
}

test("desktop DOM uses real API: folders, history, restore and pause", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-desktop-test-"));
  init(home, { port: 0, name: "Test hub" });
  const daemon = await start(home, {
    timer: false,
    network: {
      detector: {
        read: async () => ({
          state: "connected",
          installed: true,
          self: { name: "Test Mac", os: "macOS", addresses: ["100.70.0.1"] },
          peers: [
            {
              id: "peer-a",
              name: "<img src=x onerror=alert(1)>",
              os: "linux",
              online: true,
              addresses: ["100.70.0.2"],
            },
            {
              id: "phone",
              name: "Phone",
              os: "iOS",
              online: false,
              addresses: ["100.70.0.3"],
            },
          ],
        }),
      },
      probeOptions: {
        fetcher: async () =>
          new Response(
            JSON.stringify({
              service: "arca",
              discoveryVersion: 1,
              protocol: 1,
              id: "server",
              name: "Test replica",
              role: "replica",
              version: "0.1.0",
              platform: "linux",
              deployment: "docker",
              apiPort: 47831,
              client: null,
            }),
          ),
      },
    },
  });
  t.after(async () => {
    await daemon.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const v = daemon.engine.store.addVolume("Documents");
  const file = path.join(v.path, "note.txt");
  fs.writeFileSync(file, "old");
  await daemon.engine.cycle();
  fs.writeFileSync(file, "new");
  await daemon.engine.cycle();
  const dom = new JSDOM(html, {
    runScripts: "outside-only",
    url: "http://tauri.localhost",
  });
  const w = dom.window;
  w.setInterval = () => 0;
  w.HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  w.HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  let releaseRestore;
  const restoreGate = new Promise((resolve) => {
    releaseRestore = resolve;
  });
  const openedFiles = [];
  w.__TAURI__ = {
    core: {
      invoke: async (command, args) => {
        if (command === "open_file") {
          openedFiles.push(args);
          return;
        }
        if (command === "bootstrap")
          return { setup: false, status: daemon.engine.status() };
        if (command !== "api") throw new Error("Unexpected native command");
        if (args.route === "/v1/restore") await restoreGate;
        const r = await fetch(`http://127.0.0.1:${daemon.port}${args.route}`, {
          method: args.method,
          headers: {
            Authorization: `Bearer ${daemon.engine.config.adminToken}`,
            "Content-Type": "application/json",
          },
          ...(args.method === "POST"
            ? { body: JSON.stringify(args.body) }
            : {}),
        });
        const value = await r.json();
        if (!r.ok) throw new Error(value.error);
        return value;
      },
    },
  };
  try {
    await w.eval(`(async()=>{${script}\n})()`);
    assert.equal(w.document.querySelectorAll(".folder-card").length, 1);
    w.document.querySelector('[data-action="folder-detail"]').click();
    await until(
      () =>
        w.document.querySelector(".browser-file-row") &&
        w.document.body.getAttribute("aria-busy") === "false",
    );
    assert.ok(
      [...w.document.querySelectorAll(".browser-file-row strong")].some(
        (el) => el.textContent === "note.txt",
      ),
    );
    w.document
      .querySelector('[data-action="folder-tab"][data-id="recent"]')
      .click();
    await until(
      () =>
        w.document.querySelector('[data-action="folder-history"]') &&
        w.document.body.getAttribute("aria-busy") === "false",
    );
    w.document.querySelector('[data-action="folder-history"]').click();
    await until(
      () =>
        w.document.querySelector('[data-action="activity-file"]') &&
        w.document.body.getAttribute("aria-busy") === "false",
    );
    w.document.querySelector('[data-action="activity-file"] strong').click();
    await until(
      () => w.document.querySelectorAll('[data-action="restore"]').length === 1,
    );
    const controls = w.document.querySelectorAll('[data-action="restore"]');
    assert.equal(w.document.querySelector("#history-share"), null);
    assert.equal(
      w.document.querySelector('[data-action="history-filter"]'),
      null,
    );
    assert.ok(w.document.querySelector(".detail-head h1"));
    assert.ok(w.document.querySelector('[data-action="history-open-file"]'));
    const selectedPath = new URLSearchParams(w.location.hash.split("?")[1]).get(
      "path",
    );
    w.document.querySelector('[data-action="history-open-file"]').click();
    await until(
      () =>
        openedFiles.length === 1 &&
        w.document.body.getAttribute("aria-busy") === "false",
    );
    assert.equal(openedFiles[0].path, selectedPath);
    assert.equal(openedFiles[0].reveal, false);
    const finder = w.document.querySelector(
      '[data-action="history-reveal-file"]',
    );
    if (process.platform === "darwin") {
      assert.ok(finder);
      finder.click();
      await until(
        () =>
          openedFiles.length === 2 &&
          w.document.body.getAttribute("aria-busy") === "false",
      );
      assert.deepEqual(
        { ...openedFiles[1] },
        { ...openedFiles[0], reveal: true },
      );
    } else {
      assert.equal(finder, null);
    }
    assert.equal(
      openedFiles[0].volume,
      new URLSearchParams(w.location.hash.split("?")[1]).get("volume"),
    );
    assert.match(
      w.document.querySelector("#history-list").textContent,
      /Current/,
    );
    controls[0].click();
    await until(
      () =>
        w.document.querySelector("#dialog").open &&
        w.document.body.getAttribute("aria-busy") === "false",
    );
    w.document
      .querySelector("#dialog-form")
      .dispatchEvent(
        new w.Event("submit", { bubbles: true, cancelable: true }),
      );
    assert.equal(
      w.document.querySelector("#submit-dialog").getAttribute("aria-busy"),
      "true",
    );
    assert.equal(w.document.querySelector("#cancel-dialog").disabled, true);
    const escapeEvent = new w.Event("cancel", { cancelable: true });
    w.document.querySelector("#dialog").dispatchEvent(escapeEvent);
    assert.equal(
      escapeEvent.defaultPrevented,
      true,
      "Escape must not imply cancellation of an accepted operation",
    );
    releaseRestore();
    await until(() =>
      w.document.querySelector("#notice").textContent.includes("restored"),
    );
    await until(() => w.document.body.getAttribute("aria-busy") === "false");
    assert.equal(
      w.document.querySelector("#submit-dialog").hasAttribute("aria-busy"),
      false,
    );
    assert.equal(w.document.querySelector("#cancel-dialog").disabled, false);
    assert.equal(
      w.document
        .querySelector('#notice [data-action="dismiss"]')
        .getAttribute("aria-label"),
      "Dismiss notification",
    );
    assert.equal(fs.readFileSync(file, "utf8"), "old");
    w.document.querySelector('[data-view="settings"]').click();
    await until(
      () =>
        w.document.querySelector('[data-action="pause"]') &&
        w.document.body.getAttribute("aria-busy") === "false",
    );
    const lanToggle = w.document.querySelector("#allow-lan-http");
    assert.equal(lanToggle.checked, false);
    lanToggle.checked = true;
    lanToggle.dispatchEvent(new w.Event("change", { bubbles: true }));
    await until(
      () =>
        daemon.engine.config.network?.allowLanHttp === true &&
        !lanToggle.disabled,
    );
    lanToggle.checked = false;
    lanToggle.dispatchEvent(new w.Event("change", { bubbles: true }));
    await until(
      () =>
        daemon.engine.config.network?.allowLanHttp === false &&
        !lanToggle.disabled,
    );
    const themeGroup = w.document.querySelector(
      '[role="group"][aria-label="Theme"]',
    );
    assert.ok(themeGroup);
    assert.equal(
      themeGroup
        .querySelector('[data-id="system"]')
        .getAttribute("aria-pressed"),
      "true",
    );
    themeGroup.querySelector('[data-id="dark"]').click();
    await until(
      () =>
        w.document.documentElement.dataset.theme === "dark" &&
        w.document.body.getAttribute("aria-busy") === "false",
    );
    assert.equal(
      w.document
        .querySelector('[data-action="theme"][data-id="dark"]')
        .getAttribute("aria-pressed"),
      "true",
    );
    w.document.querySelector('[data-action="pause"]').click();
    await until(() =>
      w.document.querySelector("#connection").textContent.includes("Paused"),
    );
    assert.equal(daemon.engine.paused, true);
    await until(() => w.document.body.getAttribute("aria-busy") === "false");
    w.document.querySelector('[data-view="devices"]').click();
    await until(
      () =>
        w.document
          .querySelector("#devices-list")
          ?.textContent.includes("Arca detected") &&
        w.document.body.getAttribute("aria-busy") === "false",
    );
    assert.ok(
      w.document
        .querySelector("#devices-list")
        .textContent.includes("Arca 0.1.0"),
    );
    assert.equal(
      w.document.querySelector("#devices-list").textContent.includes("Offline"),
      false,
    );
    assert.equal(
      w.document
        .querySelector("#devices-list")
        .textContent.includes("Arca not detected"),
      false,
    );
    assert.equal(w.document.querySelector("#devices-list img"), null);
    assert.equal(
      w.document.body.textContent.includes("Tailscale devices"),
      false,
    );
    assert.equal(
      w.document.querySelectorAll("#devices-list .device-row").length,
      2,
    );
    assert.equal(w.document.querySelector('[data-action="tailscale"]'), null);
    daemon.engine.store.db
      .prepare(
        "INSERT INTO devices(id,name,token_hash,role,last_address) VALUES(?,?,?,?,?)",
      )
      .run(
        "linked-test",
        "Known device",
        "unused-test-hash",
        "replica",
        "100.70.0.2",
      );
    w.document.querySelector('[data-view="devices"]').click();
    await until(
      () =>
        w.document.querySelector('[data-action="revoke"]') &&
        w.document.body.getAttribute("aria-busy") === "false",
    );
    assert.equal(
      w.document.querySelectorAll("#devices-list .device-row").length,
      2,
    );
    assert.ok(
      w.document
        .querySelector("#devices-list")
        .textContent.includes("Known device"),
    );
    daemon.engine.store.db
      .prepare("UPDATE devices SET last_address=? WHERE id=?")
      .run("100.70.0.3", "linked-test");
    w.document.querySelector('[data-view="devices"]').click();
    await until(
      () =>
        w.document
          .querySelector("#devices-list")
          .textContent.includes("Offline") &&
        w.document.body.getAttribute("aria-busy") === "false",
    );
    assert.ok(
      w.document
        .querySelector("#devices-list")
        .textContent.includes("Known device"),
    );
    daemon.engine.store.db
      .prepare("DELETE FROM devices WHERE id=?")
      .run("linked-test");
    daemon.engine.paused = false;
    w.document.querySelector('[data-view="folders"]').click();
    await until(
      () =>
        w.document.querySelector('[data-action="share"]') &&
        w.document.body.getAttribute("aria-busy") === "false",
    );
    w.document.querySelector('[data-action="share"]').click();
    await until(() => w.document.querySelector('#dialog input[name="name"]'));
    w.document.querySelector('#dialog input[name="name"]').value = "Published";
    w.document
      .querySelector('#dialog input[name="name"]')
      .dispatchEvent(new w.Event("input"));
    assert.equal(
      w.document.querySelector('#dialog input[name="path"]').value,
      `${daemon.engine.config.root}/Published`,
    );
    w.document.querySelector('#dialog input[name="path"]').value =
      "/custom-destination";
    w.document
      .querySelector('#dialog input[name="name"]')
      .dispatchEvent(new w.Event("input"));
    assert.equal(
      w.document.querySelector('#dialog input[name="path"]').value,
      "/custom-destination",
    );

    w.document.querySelector('#dialog input[name="path"]').value = path.join(
      home,
      "files",
      "custom-destination",
    );
    w.document
      .querySelector("#dialog form")
      .dispatchEvent(
        new w.Event("submit", { bubbles: true, cancelable: true }),
      );
    await until(
      () =>
        daemon.engine.store.volumes().some((v) => v.name === "Published") &&
        !w.document.querySelector("#dialog").open &&
        w.document.body.getAttribute("aria-busy") === "false",
    );
    const published = daemon.engine.store
      .volumes()
      .find((v) => v.name === "Published");
    assert.equal(
      published.path,
      fs.realpathSync(path.join(home, "files", "custom-destination")),
    );
    w.document.querySelector('[data-action="share"]').click();
    await until(() => w.document.querySelector('#dialog input[name="name"]'));
    w.document.querySelector('#dialog input[name="name"]').value = "Relative";
    w.document.querySelector('#dialog input[name="path"]').value =
      "relative/path";
    w.document
      .querySelector("#dialog form")
      .dispatchEvent(
        new w.Event("submit", { bubbles: true, cancelable: true }),
      );
    await until(() => !w.document.querySelector("#dialog-error").hidden);
    assert.match(
      w.document.querySelector("#dialog-error").textContent,
      /absolute/,
    );
    assert.equal(w.document.querySelector("#dialog").open, true);

    assert.equal(
      daemon.engine.store.db.prepare("SELECT COUNT(*) AS n FROM devices").get()
        .n,
      0,
    );
  } finally {
    releaseRestore();
    w.close();
  }
});

test("desktop onboarding submits chosen role and root without a browser credential", async () => {
  const dom = new JSDOM(html, {
    runScripts: "outside-only",
    url: "http://tauri.localhost",
  });
  const w = dom.window;
  w.setInterval = () => 0;
  w.setTimeout = () => 0;
  let received;
  w.__TAURI__ = {
    core: {
      invoke: async (command, args) => {
        if (command === "bootstrap") return { setup: true, root: "/tmp/Arca" };
        if (command === "setup_info")
          return { root: args.root, freeBytes: 1000000000 };
        if (command === "initialize") {
          received = args;
          return;
        }
        if (command === "api")
          return {
            id: "setup",
            name: "My PC",
            role: "hub",
            root: "/tmp/Arca",
            volumes: [],
            devices: [],
            phase: "needs-folder",
            retention: { days: 0, versions: 0 },
          };
        throw new Error(command);
      },
    },
  };
  try {
    await w.eval(`(async()=>{${script}\n})()`);
    const submit = () =>
      w.document
        .querySelector("#setup-form")
        .dispatchEvent(
          new w.Event("submit", { bubbles: true, cancelable: true }),
        );
    assert.match(
      w.document.querySelector("#content").textContent,
      /Many devices/,
    );
    submit();
    await until(
      () =>
        w.document.querySelector('[name="name"]') &&
        w.document.body.getAttribute("aria-busy") === "false",
    );
    w.document.querySelector('[name="name"]').value = "My PC";
    submit();
    await until(
      () =>
        w.document.querySelector('[name="role"]') &&
        w.document.body.getAttribute("aria-busy") === "false",
    );
    w.document.querySelector('[name="role"][value="hub"]').checked = true;
    submit();
    await until(
      () =>
        w.document.querySelector('[name="root"]') &&
        w.document.body.getAttribute("aria-busy") === "false",
    );
    submit();
    await until(
      () => received && w.document.body.getAttribute("aria-busy") === "false",
    );
    assert.equal(received.role, "hub");
    assert.equal(received.root, "/tmp/Arca");
    assert.equal(w.localStorage?.length || 0, 0);
  } finally {
    w.close();
  }
});

test("web design preserves leading zeroes, validates before sending, pastes grouped codes and clears secrets on sign-out", async (t) => {
  const { issueWebCode } = await import("../packages/daemon/web.js");
  const { digest, atomic } = await import("../packages/daemon/storage.js");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-access-ui-"));
  init(home, { port: 0 });
  const daemon = await start(home, { timer: false });
  const base = `http://127.0.0.1:${daemon.port}`;
  const dom = new JSDOM(html, { runScripts: "outside-only", url: base });
  const w = dom.window;
  w.setInterval = () => 0;
  let cookie = "",
    attempts = 0,
    failedReads = 0,
    failLogin = false;
  w.HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  w.HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  w.fetch = async (route, options = {}) => {
    if (route === "/auth/login") {
      attempts++;
      if (failLogin) {
        failLogin = false;
        throw new TypeError("Failed to fetch");
      }
    }
    if (route === "/v1/status" && failedReads > 0) {
      failedReads--;
      throw new TypeError("Failed to fetch");
    }
    const response = await fetch(new URL(route, base), {
      ...options,
      headers: {
        ...options.headers,
        origin: base,
        ...(cookie ? { cookie } : {}),
      },
    });
    if (response.headers.get("set-cookie"))
      cookie = response.headers.get("set-cookie").split(";")[0];
    return response;
  };
  t.after(async () => {
    w.close();
    await daemon.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  issueWebCode(home);
  atomic(
    path.join(home, "web-code.json"),
    JSON.stringify({
      hash: digest("001234"),
      expires: Date.now() + 600000,
      failures: 0,
    }),
  );
  await w.eval(`(async()=>{${script}\n})()`);
  assert.equal(w.document.querySelectorAll('[data-code="web"]').length, 6);
  const submit = () =>
    w.document
      .querySelector("#web-login")
      .dispatchEvent(
        new w.Event("submit", { bubbles: true, cancelable: true }),
      );
  submit();
  assert.equal(attempts, 0);
  assert.match(w.document.querySelector("#login-error").textContent, /all six/);
  const paste = new w.Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(paste, "clipboardData", {
    value: { getData: () => "001-234" },
  });
  w.document.querySelector('[data-digit="0"]').dispatchEvent(paste);
  assert.equal(
    [...w.document.querySelectorAll('[data-code="web"]')]
      .map((i) => i.value)
      .join(""),
    "001234",
  );
  failLogin = true;
  submit();
  await until(() =>
    w.document
      .querySelector("#login-error")
      .textContent.includes("result is unknown"),
  );
  assert.equal(attempts, 1, "A mutation is never replayed automatically");
  failedReads = 2;
  submit();
  await until(() =>
    w.document.querySelector('#notice [data-action="refresh"]'),
  );
  assert.equal(attempts, 2);
  assert.equal(
    w.document.querySelector("#web-login"),
    null,
    "Successful login is not offered again after a failed read",
  );
  failedReads = 1;
  w.document.querySelector('#notice [data-action="refresh"]').click();
  await until(() => w.document.querySelector('[data-action="share"]'));
  assert.equal(attempts, 2, "Recovery uses the existing session");
  assert.equal(w.document.querySelector("#notice").hidden, true);
  assert.equal(w.document.querySelectorAll("#node-name").length, 0);
  assert.equal(w.document.querySelector("#managed-role").textContent, "Hub");
  assert.equal(
    w.document.querySelector("#backup-summary").textContent,
    "Hub backup",
  );
  assert.equal(w.document.querySelectorAll('[data-code="web"]').length, 0);
  assert.equal(w.localStorage.length, 0);
  w.document.querySelector('[data-action="logout"]').click();
  await until(
    () =>
      w.document.querySelector('[data-code="web"]') &&
      w.document.body.getAttribute("aria-busy") === "false",
  );
  assert.equal(
    [...w.document.querySelectorAll('[data-code="web"]')]
      .map((i) => i.value)
      .join(""),
    "",
  );
  // Let the non-blocking public discovery request finish before closing the document.
  await until(
    () =>
      w.document.querySelector("#access-name")?.textContent ===
      `${daemon.engine.config.name} ·`,
  );
  assert.equal(
    w.document.querySelector(".access-brand h1").textContent,
    "arca",
  );
});

test("native path validation displays string errors instead of a blank disabled dialog", async () => {
  const dom = new JSDOM(
    '<div id="dialog"><div class="folder-selection"><div class="selection-path"><input name="path" value="~/.alpi"></div></div><button id="submit-dialog"></button></div>',
    { runScripts: "outside-only" },
  );
  const w = dom.window;
  const apiCode = script.slice(
    script.indexOf("const api ="),
    script.indexOf(
      "\n",
      script.indexOf("  });", script.indexOf("const api =")),
    ),
  );
  const checkCode = script.slice(
    script.indexOf("function checkFolderPath("),
    script.indexOf("function codeFields("),
  );
  w.eval(
    `const icon = () => ""; const icons = () => {}; const escape = s => s; const $ = s => document.querySelector(s); const invoke = async () => { throw 'This folder is already shared as "alpi-host".'; }; ${apiCode}\n${checkCode}\ncheckFolderPath('path', 'new-share');`,
  );
  await until(() =>
    w.document
      .querySelector(".path-check-error")
      ?.textContent.includes("already shared"),
  );
  assert.equal(w.document.querySelector("#submit-dialog").disabled, true);
  dom.window.close();
});

test("folder errors use one floating notification through refresh, dismissal and recovery", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-notice-test-"));
  init(home, { port: 0, name: "Test hub" });
  const daemon = await start(home, { timer: false });
  const volume = daemon.engine.store.addVolume("Documents");
  const dom = new JSDOM(html, {
    runScripts: "outside-only",
    url: "http://tauri.localhost",
  });
  t.after(async () => {
    dom.window.close();
    await daemon.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const w = dom.window;
  w.setInterval = () => 0;
  let folderError = "Names BACK and back differ only by letter case.";
  let globalError = null;
  w.__TAURI__ = {
    core: {
      invoke: async (command, args) => {
        if (command === "bootstrap") return { setup: false };
        if (args.route === "/v1/status") {
          const value = daemon.engine.status();
          value.error = globalError;
          value.volumes[0].sync = {
            state: folderError ? "error" : "idle",
            error: folderError,
          };
          return value;
        }
        if (args.route.startsWith("/v1/activity")) return { versions: [] };
        throw new Error(`Unexpected route: ${args.route}`);
      },
    },
  };
  await w.eval(`(async()=>{${script}\nwindow.testRefresh = refresh;})()`);
  const notice = w.document.querySelector("#notice");
  assert.equal(notice.hidden, false);
  assert.match(notice.textContent, /BACK and back/);
  w.document
    .querySelector(`[data-action="folder-detail"][data-id="${volume.id}"]`)
    .click();
  await until(() => w.document.querySelector(".detail-head"));
  assert.equal(w.document.querySelector(".folder-error"), null);
  assert.equal(
    w.document.querySelectorAll('#content [role="alert"]').length,
    0,
  );
  notice.querySelector('[data-action="dismiss"]').click();
  await until(() => notice.hidden);
  globalError = `Documents: ${folderError}`;
  await w.testRefresh();
  assert.equal(
    notice.hidden,
    true,
    "aggregation must not reshow a dismissed folder error",
  );
  folderError = globalError = null;
  await w.testRefresh();
  assert.equal(notice.hidden, true);
  folderError = "New scan error";
  await w.testRefresh();
  assert.equal(notice.hidden, false);
  assert.match(notice.textContent, /New scan error/);
});

test("floating notification keeps its layout outside the access screen", () => {
  const css = fs.readFileSync(
    new URL("../apps/desktop/src/style.css", import.meta.url),
    "utf8",
  );
  const dom = new JSDOM(
    `<style>${css}</style><div id="notice" class="error"><span>Error</span><button>Retry</button></div>`,
  );
  const style = dom.window.getComputedStyle(
    dom.window.document.querySelector("#notice"),
  );
  assert.equal(style.display, "flex");
  assert.equal(style.padding, "12px 14px");
  assert.equal(style.position, "fixed");
  dom.window.close();
});

test("local folders render while the hub catalog is still pending", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-offline-ui-"));
  init(home, { port: 0, name: "Local Mac" });
  const daemon = await start(home, { timer: false });
  daemon.engine.store.addVolume("Local documents");
  const dom = new JSDOM(html, {
    runScripts: "outside-only",
    url: "http://tauri.localhost",
  });
  t.after(async () => {
    dom.window.close();
    await daemon.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const w = dom.window;
  w.setInterval = () => 0;
  let remoteRequested = false;
  w.__TAURI__ = {
    core: {
      invoke: async (command, args) => {
        if (command === "bootstrap") return { setup: false };
        if (args.route === "/v1/status")
          return {
            ...daemon.engine.status(),
            role: "replica",
            hub: "http://127.0.0.1:49999",
          };
        if (args.route === "/v1/remote") {
          remoteRequested = true;
          return new Promise(() => {});
        }
        throw new Error(`Unexpected route ${args.route}`);
      },
    },
  };
  w.eval(`(async()=>{${script}\n})()`);
  await until(() => w.document.querySelector(".folder-card"));
  assert.equal(remoteRequested, true);
  assert.match(
    w.document.querySelector("#content").textContent,
    /Local documents/,
  );
  assert.equal(w.document.body.classList.contains("view-loading"), false);
});

test("share web routes survive reload and history navigation; hub edits use real API", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-share-ui-"));
  init(home, { port: 0, name: "Casa" });
  const daemon = await start(home, { timer: false });
  const v = await daemon.engine.publish("Original", undefined, false);
  const base = `http://127.0.0.1:${daemon.port}`;
  const request = (route, body) =>
    fetch(base + route, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${daemon.engine.config.adminToken}`,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const doms = [];
  let inFlight = 0;
  t.after(async () => {
    await until(() => inFlight === 0);
    await new Promise((resolve) => setImmediate(resolve));
    for (const dom of doms) dom.window.close();
    await daemon.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  async function open(hash) {
    const dom = new JSDOM(html, {
      runScripts: "outside-only",
      url: base + "/" + hash,
    });
    doms.push(dom);
    const w = dom.window;
    w.setInterval = () => 0;
    w.fetch = async (route, options = {}) => {
      inFlight++;
      const response = await request(
        route,
        options.body === undefined ? undefined : JSON.parse(options.body),
      );
      return {
        ok: response.ok,
        status: response.status,
        json: async () => {
          try {
            return await response.json();
          } finally {
            inFlight--;
          }
        },
      };
    };
    w.HTMLDialogElement.prototype.showModal = function () {
      this.setAttribute("open", "");
    };
    w.HTMLDialogElement.prototype.close = function () {
      this.removeAttribute("open");
    };
    await w.eval(`(async()=>{${script}\n})()`);
    return w;
  }
  const w = await open(`#/folders/${v.id}`);
  const q = (selector) => w.document.querySelector(selector);
  const idle = () => w.document.body.getAttribute("aria-busy") === "false";
  assert.equal(q(".detail-title h1").textContent, "Original");
  await until(() => q("#folder-copies")?.textContent.includes("Casa"));
  assert.ok(!q("#folder-copies").textContent.includes("Local copy selected"));
  q('[data-action="rename-share"]').click();
  await until(() => q('#dialog [name="name"]') && idle());
  q('#dialog [name="name"]').value = "Renamed";
  q("#dialog-form").dispatchEvent(new w.Event("submit", { cancelable: true }));
  await until(() => q(".detail-title h1")?.textContent === "Renamed" && idle());
  assert.equal(daemon.engine.store.volume(v.id).path, v.path);
  q('[data-action="edit-ignore"]').click();
  await until(() => q('#dialog [name="text"]') && idle());
  q('#dialog [name="text"]').value = "*.tmp\n";
  q("#dialog").dispatchEvent(
    new w.WheelEvent("wheel", { deltaY: 1000, bubbles: true }),
  );
  q("#dialog").dispatchEvent(
    new w.MouseEvent("click", { clientX: -10, clientY: -10, bubbles: true }),
  );
  assert.equal(
    q("#dialog").open,
    true,
    "scroll/backdrop gestures must preserve the editor",
  );
  assert.equal(q('#dialog [name="text"]').value, "*.tmp\n");
  q("#dialog-form").dispatchEvent(new w.Event("submit", { cancelable: true }));
  await until(() => !q("#dialog").open && idle());
  assert.equal(
    fs.readFileSync(path.join(v.path, ".arcaignore"), "utf8"),
    "*.tmp\n",
  );
  q('[data-action="folder-tab"][data-id="recent"]').click();
  await until(() => q('[data-action="folder-history"]') && idle());
  q('[data-action="folder-history"]').click();
  await until(() => w.location.hash.startsWith("#/history?") && idle());
  assert.equal(
    new w.URLSearchParams(w.location.hash.split("?")[1]).get("volume"),
    v.id,
  );
  w.history.back();
  await until(
    () =>
      q(".detail-title h1") &&
      w.location.hash === `#/folders/${v.id}` &&
      idle(),
  );
  w.history.forward();
  await until(
    () =>
      w.location.hash.startsWith("#/history?") && q("#history-list") && idle(),
  );
  const reloaded = await open(w.location.hash);
  assert.ok(reloaded.document.querySelector("#history-list"));
  const forward = q('[data-action="activity-file"]');
  assert.ok(forward.getAttribute("aria-label").startsWith("View history for "));
  assert.equal(forward.getAttribute("role"), "button");
  assert.equal(forward.getAttribute("tabindex"), "0");
  assert.equal(forward.querySelector(".icon-button"), null);
  forward.focus();
  forward.dispatchEvent(
    new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
  );
  await until(() => q('[data-action="history-back"]') && idle());
  assert.equal(q("#history-share"), null);
  assert.equal(q('[data-action="history-filter"]'), null);
  assert.ok(q(".file-history-summary .stats"));
  const download = q(".file-header-actions a[download]");
  assert.ok(download);
  const blob = await request(download.getAttribute("href"));
  assert.equal(blob.status, 200);
  const fileURL = w.location.hash;
  const fileReload = await open(fileURL);
  assert.ok(fileReload.document.querySelector(".detail-head h1"));
  q('[data-action="history-back"]').click();
  await until(() => q("#history-share") && idle());
  assert.ok(!w.location.hash.includes("path="));
  assert.ok(w.location.hash.includes("volume=" + v.id));

  const historyWindow = await open("#/history");
  const historyQuery = (selector) =>
    historyWindow.document.querySelector(selector);
  assert.equal(historyQuery("#history-share span").textContent, "All");
  historyQuery("#history-share").click();
  assert.equal(
    historyQuery("#history-share").getAttribute("aria-expanded"),
    "true",
  );
  historyWindow.document.activeElement.dispatchEvent(
    new historyWindow.KeyboardEvent("keydown", {
      key: "ArrowDown",
      bubbles: true,
    }),
  );
  assert.equal(historyWindow.document.activeElement.dataset.id, v.id);
  historyWindow.document.activeElement.dispatchEvent(
    new historyWindow.KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
    }),
  );
  assert.equal(
    historyQuery("#history-share").getAttribute("aria-expanded"),
    "false",
  );
  assert.equal(historyWindow.document.activeElement.id, "history-share");
  historyQuery('[data-action="history-filter"][data-id="conflicts"]').click();
  await until(
    () =>
      historyQuery('[data-id="conflicts"]').getAttribute("aria-pressed") ===
      "true",
  );
  historyQuery("#history-share").click();
  historyQuery(`[role="option"][data-id="${v.id}"]`).click();
  await until(
    () =>
      historyWindow.location.hash.includes("volume=" + v.id) &&
      historyWindow.document.body.getAttribute("aria-busy") === "false",
  );
  assert.ok(historyWindow.location.hash.includes("filter=conflicts"));
  historyQuery('[data-action="history-filter"][data-id="deleted"]').click();
  await until(
    () =>
      historyQuery('[data-id="deleted"]').getAttribute("aria-pressed") ===
      "true",
  );
  assert.equal(
    historyQuery("#history-share-options [aria-selected='true']").dataset.id,
    v.id,
  );
  historyQuery('[data-action="history-filter"][data-id="deleted"]').click();
  await until(
    () =>
      historyQuery('[data-id="deleted"]').getAttribute("aria-pressed") ===
      "false",
  );
  assert.ok(!historyWindow.location.hash.includes("filter="));
  const deep = await open(`#/folders/${v.id}`);
  assert.equal(
    deep.document.querySelector(".detail-title h1").textContent,
    "Renamed",
  );
  await until(
    () =>
      !deep.document
        .querySelector("#folder-copies")
        .textContent.includes("Checking"),
  );
});

test("unlink confirms and completes while a native background status read is pending", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arca-unlink-ui-"));
  const nodes = [];
  async function node(name, role) {
    const home = path.join(root, name);
    init(home, { name, role, port: 0 });
    const daemon = await start(home, { timer: false });
    nodes.push(daemon);
    daemon.api = async (route, body) => {
      const r = await fetch(`http://127.0.0.1:${daemon.port}${route}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${daemon.engine.config.adminToken}`,
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error);
      return data;
    };
    return daemon;
  }
  const hub = await node("Hub", "hub"),
    mac = await node("Mac", "replica");
  const folder = await hub.api("/v1/volumes", { name: "Unlink example" });
  fs.writeFileSync(path.join(folder.path, "keep.txt"), "Keep this file");
  await hub.engine.cycle();
  const invite = await hub.api("/v1/devices", { name: "Mac", role: "replica" });
  await mac.api("/v1/connect", {
    url: `http://127.0.0.1:${hub.port}`,
    token: invite.token,
  });
  const local = await mac.api("/v1/select", { id: folder.id });
  await mac.engine.cycle();
  const dom = new JSDOM(html, {
    runScripts: "outside-only",
    url: `http://tauri.localhost/#/folders/${folder.id}`,
  });
  const w = dom.window;
  let poll,
    hold = false,
    waiting = false,
    release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let inflight = 0;
  w.setInterval = (callback) => {
    poll = callback;
    return 0;
  };
  w.HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  w.HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  w.__TAURI__ = {
    core: {
      invoke: async (command, args) => {
        if (command === "bootstrap")
          return { setup: false, status: mac.engine.status() };
        inflight++;
        try {
          const result = await mac.api(
            args.route,
            args.method === "POST" ? args.body : undefined,
          );
          if (args.route === "/v1/status" && hold) {
            hold = false;
            waiting = true;
            await gate;
          }
          return result;
        } finally {
          inflight--;
        }
      },
    },
  };
  t.after(async () => {
    release();
    await until(() => inflight === 0);
    await new Promise((resolve) => setImmediate(resolve));
    w.close();
    for (const daemon of nodes.reverse()) await daemon.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await w.eval(`(async()=>{${script}\n})()`);
  hold = true;
  const background = poll();
  await until(() => waiting);
  const q = (selector) => w.document.querySelector(selector);
  q('[data-action="unselect"]').click();
  await until(() => q("#dialog").open);
  assert.match(q("#dialog-title").textContent, /Unlink.*Unlink example/);
  assert.equal(
    mac.engine.store.volume(folder.id).selected,
    1,
    "Opening confirmation does not unlink",
  );
  q("#cancel-dialog").click();
  assert.equal(
    mac.engine.store.volume(folder.id).selected,
    1,
    "Cancel preserves the link",
  );
  q('[data-action="unselect"]').click();
  await until(
    () =>
      q("#dialog").open &&
      w.document.body.getAttribute("aria-busy") === "false",
  );
  q("#dialog-form").dispatchEvent(new w.Event("submit", { cancelable: true }));
  await until(
    () =>
      !q("#dialog").open &&
      w.document.body.getAttribute("aria-busy") === "false",
  );
  assert.ok(!mac.engine.store.volumes().some((v) => v.id === folder.id));
  assert.equal(
    fs.readFileSync(path.join(local.path, "keep.txt"), "utf8"),
    "Keep this file",
  );
  assert.equal(fs.existsSync(path.join(local.path, ".arca-volume")), false);
  assert.ok(hub.engine.store.volume(folder.id));
  release();
  await background;
  assert.equal(
    q('[data-action="unselect"]'),
    null,
    "Stale poll cannot resurrect the old detail",
  );
});

for (const surface of ["web", "desktop"]) {
  for (const role of ["hub", "replica"]) {
    test(`${surface} ${role} keeps machine authority separate from interface access`, async (t) => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-context-ui-"));
      init(home, { port: 0, name: `Test ${role}`, role });
      const daemon = await start(home, { timer: false });
      const dom = new JSDOM(html, {
        runScripts: "outside-only",
        url: "http://localhost/#/settings",
      });
      t.after(async () => {
        dom.window.close();
        await daemon.close();
        fs.rmSync(home, { recursive: true, force: true });
      });
      const w = dom.window;
      w.setInterval = () => 0;
      const request = (route, options = {}) =>
        fetch(`http://127.0.0.1:${daemon.port}${route}`, {
          ...options,
          headers: {
            Authorization: `Bearer ${daemon.engine.config.adminToken}`,
            "Content-Type": "application/json",
          },
        });
      w.fetch = request;
      if (surface === "desktop")
        w.__TAURI__ = {
          core: {
            invoke: async (command, args) => {
              if (command === "bootstrap") return { setup: false };
              if (command === "desktop_preferences")
                return { launchAtLogin: false, notifications: false };
              if (command !== "api") return null;
              const response = await request(args.route, {
                method: args.method,
                ...(args.method === "POST"
                  ? { body: JSON.stringify(args.body) }
                  : {}),
              });
              const body = await response.json();
              if (!response.ok) throw new Error(body.error);
              if (args.route === "/v1/status")
                body.platform = role === "hub" ? "win32" : "linux";
              return body;
            },
          },
        };
      await w.eval(`(async()=>{${script}\n})()`);
      w.document.querySelector('[data-view="settings"]').click();
      await until(
        () =>
          w.document.querySelector("#machine-name") &&
          w.document.body.getAttribute("aria-busy") === "false",
      );
      assert.equal(
        Boolean(w.document.querySelector('[data-action="logout-all"]')),
        surface === "web",
      );
      assert.equal(
        Boolean(w.document.querySelector("#allow-lan-http")),
        role === "hub",
      );
      assert.equal(
        Boolean(w.document.querySelector("#notifications-enabled")),
        surface === "desktop",
      );
      if (surface === "desktop") {
        assert.equal(w.document.querySelector("#service-control"), null);
        assert.equal(w.document.body.textContent.includes("this Mac"), false);
        assert.ok(w.document.body.textContent.includes("System notifications"));
      }
      assert.equal(
        Boolean(w.document.querySelector('[data-action="retention"]')),
        role === "hub",
      );
      assert.equal(
        Boolean(w.document.querySelector('[data-action="connect"]')),
        role === "replica",
      );
      assert.equal(
        w.document.body.textContent.includes("System account"),
        false,
      );
      assert.equal(
        w.document.querySelector('[data-view="devices"]').textContent.trim(),
        "Machines",
      );
      w.document.querySelector('[data-view="folders"]').click();
      await until(
        () =>
          w.document.body.getAttribute("aria-busy") === "false" &&
          w.document.querySelector("#content h1")?.textContent === "Folders",
      );
      assert.equal(
        Boolean(w.document.querySelector('[data-action="share"]')),
        role === "hub",
      );
      if (role === "replica") {
        assert.equal(w.document.querySelector('[data-action="add"]'), null);
        w.document.querySelector('[data-view="history"]').click();
        await until(() =>
          w.document
            .querySelector("#content")
            .textContent.includes("Connect to view history"),
        );
        assert.ok(w.document.querySelector('[data-action="connect"]'));
      }
    });
  }
}

test("desktop connection confirms disconnect, retains files and offers a fresh pairing code", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arca-disconnect-ui-"));
  const nodes = [];
  for (const role of ["hub", "replica"]) {
    const home = path.join(root, role);
    init(home, { role, port: 0, name: role });
    nodes.push(await start(home, { timer: false }));
  }
  const [hub, replica] = nodes;
  const request = (node, route, body) =>
    fetch(`http://127.0.0.1:${node.port}${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${node.engine.config.adminToken}`,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const invite = await (
    await request(hub, "/v1/devices", { name: "replica", role: "replica" })
  ).json();
  await request(replica, "/v1/connect", {
    url: `http://127.0.0.1:${hub.port}`,
    token: invite.token,
  });
  const v = await hub.engine.publish("Documents", undefined, false);
  await replica.engine.select(v.id);
  const destination = replica.engine.store.volume(v.id).path;
  fs.writeFileSync(path.join(destination, "local.txt"), "keep me");
  const dom = new JSDOM(html, {
    runScripts: "outside-only",
    url: "http://localhost/#/machines",
  });
  const w = dom.window;
  t.after(async () => {
    dom.window.close();
    for (const n of nodes.reverse()) await n.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  w.setInterval = () => 0;
  w.HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  w.HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  w.__TAURI__ = {
    core: {
      invoke: async (command, args) => {
        if (command === "bootstrap") return { setup: false };
        if (command !== "api") return null;
        const r = await request(
          replica,
          args.route,
          args.method === "POST" ? args.body : undefined,
        );
        const b = await r.json();
        if (!r.ok) throw new Error(b.error);
        return b;
      },
    },
  };
  await w.eval(`(async()=>{${script}\n})()`);
  w.document.querySelector('[data-view="devices"]').click();
  await until(
    () =>
      w.document.querySelector('[data-action="disconnect-hub"]') &&
      w.document.body.getAttribute("aria-busy") === "false",
  );
  w.document.querySelector('[data-action="disconnect-hub"]').click();
  await until(() => w.document.querySelector("#dialog").hasAttribute("open"));
  assert.match(w.document.querySelector("#dialog").textContent, /files/i);
  w.document.querySelector("#cancel-dialog").click();
  assert.ok(replica.engine.config.hub);
  await until(() => w.document.body.getAttribute("aria-busy") === "false");
  w.document.querySelector('[data-action="disconnect-hub"]').click();
  await until(() => w.document.querySelector("#dialog").hasAttribute("open"));
  w.document.querySelector("#submit-dialog").click();
  await until(
    () =>
      !replica.engine.config.hub &&
      !w.document.querySelector("#dialog").hasAttribute("open"),
  );
  assert.equal(
    fs.readFileSync(path.join(destination, "local.txt"), "utf8"),
    "keep me",
  );
  assert.equal(replica.engine.store.volume(v.id).path, destination);
  await until(
    () =>
      w.document.querySelector('[data-action="connect"]') &&
      w.document.body.getAttribute("aria-busy") === "false",
  );
  assert.equal(w.document.querySelector("#devices-list .busy-grid"), null);
  const disconnected = [
    ...w.document.querySelectorAll("#devices-list .pill"),
  ].find((el) => el.textContent.includes("Disconnected"));
  assert.ok(disconnected.classList.contains("wa"));
  w.document.querySelector('[data-action="connect"]').click();
  await until(() => w.document.querySelector("#dialog").hasAttribute("open"));
  assert.match(
    w.document.querySelector("#dialog-title").textContent,
    /Reconnect/,
  );
  assert.match(w.document.querySelector("#dialog").textContent, /Pairing code/);
  assert.equal(w.document.querySelector('input[name="reconcile"]'), null);
  assert.equal(w.document.querySelector('input[name="privateNetwork"]'), null);
});

test("pairing shows two addresses and copies each inside the active HTTP dialog", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-pair-copy-"));
  init(home, { port: 0, name: "casa" });
  const daemon = await start(home, { timer: false });
  const dom = new JSDOM(html, {
    runScripts: "outside-only",
    url: "http://casa:47831/#/machines",
  });
  const w = dom.window;
  t.after(async () => {
    dom.window.close();
    await daemon.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  w.setInterval = () => 0;
  w.HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  w.HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  const copied = [];
  w.document.execCommand = (command) => {
    const field = w.document.activeElement;
    if (
      command !== "copy" ||
      !field.matches("textarea") ||
      !field.closest("dialog[open]")
    )
      return false;
    copied.push(field.value);
    return true;
  };
  w.fetch = async (route, options = {}) => {
    if (route === "/v1/network")
      return new Response(
        JSON.stringify({
          mode: "tailscale",
          tailscale: {
            state: "connected",
            self: {
              addresses: ["100.99.29.84"],
              dnsName: "casa.example.ts.net.",
            },
          },
        }),
      );
    return fetch(`http://127.0.0.1:${daemon.port}${route}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${daemon.engine.config.adminToken}`,
        "Content-Type": "application/json",
      },
    });
  };
  await w.eval(`(async()=>{${script}\n})()`);
  w.document.querySelector('[data-view="devices"]').click();
  await until(
    () =>
      w.document.querySelector('[data-action="invite"]') &&
      w.document.body.getAttribute("aria-busy") === "false",
  );
  w.document.querySelector('[data-action="invite"]').click();
  await until(
    () =>
      w.document.querySelector("#pair-code")?.textContent.match(/\d/) &&
      w.document.body.getAttribute("aria-busy") === "false",
  );
  const buttons = [
    ...w.document.querySelectorAll('#dialog-content [data-action="copy"]'),
  ];
  assert.equal(buttons.length, 2);
  assert.equal(buttons[0].dataset.id, "http://casa:47831");
  assert.equal(buttons[1].dataset.id, `http://100.99.29.84:${daemon.port}`);
  assert.equal(
    w.document
      .querySelector("#dialog-content")
      .textContent.includes("casa.example.ts.net"),
    false,
  );
  for (const button of buttons) {
    button.focus();
    button.click();
    await until(
      () =>
        button.textContent.includes("Copied") &&
        w.document.body.getAttribute("aria-busy") === "false",
    );
    assert.equal(copied.at(-1), button.dataset.id);
    assert.equal(w.document.activeElement, button);
  }
  Object.defineProperty(w.navigator, "clipboard", {
    value: {
      writeText: async () => {
        throw new Error("Clipboard permission denied");
      },
    },
  });
  w.document.querySelector('[data-action="copy-pair"]').click();
  await until(() => copied.length === 3);
  assert.equal(
    copied.at(-1),
    w.document.querySelector("#pair-code").textContent.replace(/\D/g, ""),
  );
  assert.ok(w.document.querySelector("#dialog").hasAttribute("open"));
  w.document.querySelector("#dialog").close();
  w.navigator.clipboard.writeText = async (value) => copied.push(value);
  w.document.querySelector('[data-view="settings"]').click();
  await until(() => w.document.querySelector('[data-action="diagnostics"]'));
  const diagnostics = w.document.querySelector('[data-action="diagnostics"]');
  diagnostics.click();
  await until(() => diagnostics.textContent.includes("Copied"));
  assert.equal(
    JSON.parse(copied.at(-1)).version,
    JSON.parse(
      fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ).version,
  );
  await new Promise((resolve) => setTimeout(resolve, 2100));
  assert.ok(diagnostics.textContent.includes("Copy diagnostics"));
});

test("Machines refreshes backup acknowledgements without navigation", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-backup-ui-"));
  init(home, { port: 0, name: "Hub" });
  const daemon = await start(home, { timer: false });
  daemon.engine.store.addVolume("Docs");
  const dom = new JSDOM(html, {
    runScripts: "outside-only",
    url: "http://casa/#/machines",
  });
  const w = dom.window;
  let poll;
  w.setInterval = (fn) => {
    poll = fn;
    return 0;
  };
  w.fetch = (route, options = {}) =>
    fetch(`http://127.0.0.1:${daemon.port}${route}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${daemon.engine.config.adminToken}`,
        "Content-Type": "application/json",
      },
    });
  t.after(async () => {
    dom.window.close();
    await daemon.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  await w.eval(`(async()=>{${script}\n})()`);
  await until(() => w.document.querySelector("#devices-list"));
  assert.match(
    w.document.querySelector("#devices-list").textContent,
    /No hub backup recorded/,
  );
  const response = await w.fetch("/v1/devices", {
    method: "POST",
    body: JSON.stringify({ name: "Backup Mac", role: "replica" }),
  });
  const device = await response.json();
  daemon.engine.store.db
    .prepare(
      "INSERT INTO backup_ack(device,enabled,revision,updated) VALUES(?,?,?,?)",
    )
    .run(device.id, 1, 42, new Date().toISOString());
  await poll();
  assert.match(
    w.document.querySelector("#devices-list").textContent,
    /Backup Mac backs up this hub/,
  );
  assert.match(
    w.document.querySelector("#devices-list").textContent,
    /Backs up hub/,
  );
  const menu = w.document.querySelector(".details-menu");
  menu.open = true;
  daemon.engine.store.db
    .prepare("UPDATE backup_ack SET revision=43 WHERE device=?")
    .run(device.id);
  await poll();
  assert.equal(w.document.querySelector(".details-menu"), menu);
  menu.open = false;
  await poll();
  assert.match(w.document.querySelector("#devices-list").textContent, /rev 43/);
  assert.match(
    w.document.querySelector("#devices-list").textContent,
    /Reported/,
  );
  assert.doesNotMatch(
    w.document.querySelector("#devices-list").textContent,
    /Acknowledged/,
  );
  daemon.engine.store.db
    .prepare("UPDATE backup_ack SET updated=NULL WHERE device=?")
    .run(device.id);
  await poll();
  assert.match(
    w.document.querySelector("#devices-list").textContent,
    /Waiting for the first backup report/,
  );
  assert.match(
    w.document.querySelector("#devices-list").textContent,
    /Pending/,
  );
});

test("LAN mobile metadata appears on hub and other machines appear read-only on desktop replicas", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-mobile-roster-ui-"));
  init(home, { port: 0, name: "Casa" });
  const hub = await start(home, { timer: false });
  const call = async (route, body) => {
    const r = await fetch(`http://127.0.0.1:${hub.port}${route}`, {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${hub.engine.config.adminToken}`,
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return r.json();
  };
  const device = await call("/v1/devices", {
    name: "Android emulator",
    role: "replica",
  });
  hub.engine.store.db
    .prepare("UPDATE devices SET last_address=?, last_seen=? WHERE id=?")
    .run("192.168.1.171", new Date().toISOString(), device.id);
  hub.engine.store.db
    .prepare("INSERT OR REPLACE INTO machine_reports VALUES(?,?)")
    .run(
      device.id,
      JSON.stringify({
        machineId: device.id,
        name: "Android emulator",
        platform: "android",
        reportedAt: new Date().toISOString(),
      }),
    );
  const doms = [];
  t.after(async () => {
    doms.forEach((d) => d.window.close());
    await hub.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  for (const role of ["hub", "replica"]) {
    const dom = new JSDOM(html, {
      runScripts: "outside-only",
      url: "http://tauri.localhost/#/machines",
    });
    doms.push(dom);
    const w = dom.window;
    w.setInterval = () => 0;
    w.__TAURI__ = {
      core: {
        invoke: async (command, args) => {
          if (command === "bootstrap") return { setup: false };
          if (command !== "api") return {};
          if (args.route === "/v1/status") {
            const s = hub.engine.status();
            return role === "hub"
              ? s
              : {
                  ...s,
                  id: "local-mac",
                  role,
                  name: "Mac",
                  hub: "http://casa:47831",
                  devices: [],
                };
          }
          if (args.route === "/v1/discovery")
            return { peers: [], tailscale: { state: "not-installed" } };
          return call(args.route, args.body);
        },
      },
    };
    await w.eval(`(async()=>{${script}\n})()`);
    await until(() => w.document.body.textContent.includes("Android emulator"));
    const row = [...w.document.querySelectorAll(".device-row")].find((r) =>
      r.textContent.includes("Android emulator"),
    );
    assert.match(row.textContent, /192\.168\.1\.171/);
    assert.match(row.textContent, /Android/i);
    assert.equal(
      row.textContent.includes("Connection details unavailable"),
      false,
    );
    assert.equal(
      Boolean(row.querySelector('[data-action="revoke"]')),
      role === "hub",
    );
  }
});

test("conflict file detail opens a guarded version choice and restores the selected content", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-conflict-ui-"));
  init(home, { port: 0 });
  const daemon = await start(home, { timer: false });
  const volume = daemon.engine.store.addVolume("Documents");
  const conflict = "note.txt.conflict-test-version";
  fs.writeFileSync(path.join(volume.path, "note.txt"), "original");
  fs.writeFileSync(path.join(volume.path, conflict), "alternative");
  await daemon.engine.cycle();
  const dom = new JSDOM(html, {
    runScripts: "outside-only",
    url: `http://tauri.localhost/#history?volume=${volume.id}&path=${conflict}`,
  });
  t.after(async () => {
    dom.window.close();
    await daemon.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const w = dom.window;
  w.setInterval = () => 0;
  w.HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  w.HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  w.__TAURI__ = {
    core: {
      invoke: async (command, args) => {
        if (command === "bootstrap")
          return { setup: false, status: daemon.engine.status() };
        if (command !== "api") return;
        const response = await fetch(
          `http://127.0.0.1:${daemon.port}${args.route}`,
          {
            method: args.method,
            headers: {
              Authorization: `Bearer ${daemon.engine.config.adminToken}`,
              "Content-Type": "application/json",
            },
            ...(args.method === "POST"
              ? { body: JSON.stringify(args.body) }
              : {}),
          },
        );
        const value = await response.json();
        if (!response.ok) throw new Error(value.error);
        return value;
      },
    },
  };
  await w.eval(`(async()=>{${script}\n})()`);
  const q = (selector) => w.document.querySelector(selector);
  assert.ok(q('.file-header-actions [data-action="review-conflict"]'));
  q('[data-action="review-conflict"]').click();
  await until(() => q('#dialog[open] input[value="conflict"]'));
  assert.equal(q('input[name="choice"]:checked').value, "original");
  q('input[value="conflict"]').checked = true;
  q("#dialog-form").dispatchEvent(
    new w.Event("submit", { bubbles: true, cancelable: true }),
  );
  await until(
    () =>
      !q("#dialog[open]") &&
      w.document.body.getAttribute("aria-busy") === "false" &&
      fs.readFileSync(path.join(volume.path, "note.txt"), "utf8") ===
        "alternative",
  );
  assert.equal(
    fs.readFileSync(path.join(volume.path, conflict), "utf8"),
    "alternative",
  );
});

test("numeric Lucide names render deletion and restore icons", () => {
  const dom = new JSDOM(
    '<span data-icon="trash-2"></span><span data-icon="undo-2"></span>',
    { runScripts: "outside-only" },
  );
  try {
    dom.window.eval(
      fs.readFileSync(
        new URL("../apps/desktop/src/vendor/lucide.js", import.meta.url),
        "utf8",
      ),
    );
    dom.window.eval(
      script.slice(
        script.indexOf("function icons()"),
        script.indexOf("function pill("),
      ) + "\nicons();",
    );
    assert.equal(dom.window.document.querySelectorAll("svg.icon").length, 2);
    assert.equal(dom.window.document.querySelectorAll("[data-icon]").length, 0);
  } finally {
    dom.window.close();
  }
});

test("desktop destroy confirmation cancels safely and returns to first-run onboarding after deletion", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arca-destroy-ui-"));
  const nodes = [];
  for (const role of ["hub", "replica"]) {
    const home = path.join(root, role);
    init(home, { role, port: 0, name: role });
    nodes.push(await start(home, { timer: false }));
  }
  const [hub, replica] = nodes;
  const request = (node, route, body) =>
    fetch(`http://127.0.0.1:${node.port}${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${node.engine.config.adminToken}`,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const invite = await (
    await request(hub, "/v1/devices", { name: "replica", role: "replica" })
  ).json();
  await request(replica, "/v1/connect", {
    url: `http://127.0.0.1:${hub.port}`,
    token: invite.token,
  });
  const v = await hub.engine.publish("Documents", undefined, false);
  await replica.engine.select(v.id);
  const destination = replica.engine.store.volume(v.id).path;
  fs.writeFileSync(path.join(destination, "local.txt"), "keep me");
  const dom = new JSDOM(html, {
    runScripts: "outside-only",
    url: "http://localhost/#/machines",
  });
  const w = dom.window;
  t.after(async () => {
    dom.window.close();
    for (const n of nodes.reverse()) await n.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  w.setInterval = () => 0;
  w.HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  w.HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  w.__TAURI__ = {
    core: {
      invoke: async (command, args) => {
        if (command === "bootstrap") return { setup: false };
        if (command !== "api") return null;
        const r = await request(
          replica,
          args.route,
          args.method === "POST" ? args.body : undefined,
        );
        const b = await r.json();
        if (!r.ok) throw new Error(b.error);
        return b;
      },
    },
  };
  await w.eval(`(async()=>{${script}\n})()`);
  w.document.querySelector('[data-view="settings"]').click();
  await until(
    () =>
      w.document.querySelector('[data-action="destroy-replica"]') &&
      w.document.body.getAttribute("aria-busy") === "false",
  );
  assert.ok(w.document.querySelector('[data-action="disconnect-hub"]'));
  w.document.querySelector('[data-action="destroy-replica"]').click();
  await until(() => w.document.querySelector("#dialog").open);
  assert.ok(
    w.document.querySelector("#dialog").textContent.includes(destination),
  );
  assert.match(
    w.document.querySelector("#dialog").textContent,
    /unsynced changes/,
  );
  assert.ok(
    w.document.querySelector("#submit-dialog").classList.contains("danger"),
  );
  w.document.querySelector("#cancel-dialog").click();
  assert.ok(fs.existsSync(destination));
  assert.ok(replica.engine.config.hub);
  await until(() => w.document.body.getAttribute("aria-busy") === "false");
  w.document.querySelector('[data-action="destroy-replica"]').click();
  await until(() => w.document.querySelector("#dialog").open);
  w.document.querySelector("#submit-dialog").click();
  await until(
    () =>
      w.document.querySelector("#setup-form") &&
      w.document.body.getAttribute("aria-busy") === "false",
  );
  assert.equal(fs.existsSync(destination), false);
  assert.equal(replica.engine.config.needsSetup, true);
  assert.match(
    w.document.querySelector("#content").textContent,
    /Many devices/,
  );
  w.document.querySelector('#setup-form button[type="submit"]').click();
  await until(
    () =>
      w.document.querySelector('input[name="name"]') &&
      w.document.body.getAttribute("aria-busy") === "false",
  );
  assert.equal(w.document.querySelector('input[name="name"]').value, "");
});

test("replica onboarding follows welcome, name, role, pairing and root, and resumes after pairing", async (t) => {
  const { inspectSetupRoot } = await import("../packages/daemon/setup.js");
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "arca-onboarding-dom-")),
  );
  const nodes = [],
    windows = [];
  for (const role of ["hub", "replica"]) {
    const home = path.join(root, role);
    init(home, { role, port: 0, name: role });
    nodes.push(await start(home, { timer: false }));
  }
  const [hub, replica] = nodes;
  replica.engine.config.needsSetup = true;
  replica.engine.store.saveConfig();
  t.after(async () => {
    for (const w of windows) w.close();
    for (const n of nodes.reverse()) await n.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const calls = [];
  async function request(node, route, body) {
    calls.push(route);
    const r = await fetch(`http://127.0.0.1:${node.port}${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${node.engine.config.adminToken}`,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await r.json();
    if (!r.ok) throw new Error(value.error);
    return value;
  }
  const invite = await request(hub, "/v1/pairing", { name: "Invited machine" });
  async function open() {
    const w = new JSDOM(html, {
      runScripts: "outside-only",
      url: "http://localhost",
    }).window;
    windows.push(w);
    w.setInterval = () => 0;
    w.__TAURI__ = {
      core: {
        invoke: async (command, args) => {
          if (command === "bootstrap") return { setup: false };
          if (command === "setup_info")
            return inspectSetupRoot(args.root, replica.engine.store.home);
          if (command === "initialize")
            return request(replica, "/v1/setup", { ...args, onboarding: true });
          if (command === "api")
            return request(
              replica,
              args.route,
              args.method === "POST" ? args.body : undefined,
            );
          return null;
        },
      },
    };
    await w.eval(`(async()=>{${script}\n})()`);
    return w;
  }
  let w = await open();
  const submit = () =>
    w.document
      .querySelector("#setup-form")
      .dispatchEvent(
        new w.Event("submit", { bubbles: true, cancelable: true }),
      );
  const waitFor = (selector) =>
    until(
      () =>
        w.document.querySelector(selector) &&
        w.document.body.getAttribute("aria-busy") === "false",
    );
  assert.match(
    w.document.querySelector("#content").textContent,
    /Many devices/,
  );
  submit();
  await waitFor('[name="name"]');
  w.document.querySelector('[name="name"]').value = "Studio Mac";
  submit();
  await waitFor('[name="role"]');
  assert.ok(w.document.querySelector('[name="role"][value="replica"]').checked);
  submit();
  await waitFor('[name="url"]');
  assert.equal(w.document.querySelector('[name="root"]'), null);
  w.document.querySelector('[name="url"]').value =
    `http://127.0.0.1:${hub.port}`;
  [...invite.code].forEach((digit, i) => {
    w.document.querySelector(
      `[data-code="onboarding"][data-digit="${i}"]`,
    ).value = digit;
  });
  submit();
  await waitFor('[name="root"]');
  assert.equal(replica.engine.config.onboarding, true);
  assert.ok(replica.engine.config.hub.token);
  assert.equal(replica.engine.store.volumes().length, 0);
  assert.equal(
    hub.engine.store.db.prepare("SELECT name FROM devices").get().name,
    "Studio Mac",
  );
  w.close();
  w = await open();
  await waitFor('[name="root"]');
  assert.equal(w.document.querySelector('[data-code="onboarding"]'), null);
  const chosen = path.join(root, "Chosen folders");
  w.document.querySelector('[name="root"]').value = chosen;
  submit();
  await until(
    () =>
      !replica.engine.config.onboarding &&
      w.document.body.getAttribute("aria-busy") === "false",
  );
  assert.equal(replica.engine.config.root, chosen);
  assert.equal(calls.filter((route) => route === "/v1/connect").length, 1);
});
