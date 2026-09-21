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
const fileIconScript = fs
  .readFileSync(
    new URL("../apps/desktop/src/file-icons.js", import.meta.url),
    "utf8",
  )
  .replace(/export /g, "");
const script =
  fileIconScript +
  "\n" +
  fs
    .readFileSync(
      new URL("../apps/desktop/src/notice-contract.js", import.meta.url),
      "utf8",
    )
    .replace(/export /g, "") +
  "\n" +
  fs
    .readFileSync(
      new URL("../apps/desktop/src/app.js", import.meta.url),
      "utf8",
    )
    // Exercise Windows checkout line endings on every runner.
    .replace(/\r?\n/g, "\r\n")
    .replace(/^import[\s\S]*?notice-contract\.js";\r?\n/, "")
    .replace(/import \{ fileIcon \} from "\.\/file-icons\.js";\r?\n/, "");
async function until(check) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("UI did not reach expected state");
}

async function drainRequests(requests) {
  do {
    await Promise.allSettled([...requests]);
    // Native replies settle before the app's then/finally render callbacks.
    // Let those finish, including any follow-up requests, before closing JSDOM.
    await new Promise((resolve) => setImmediate(resolve));
  } while (requests.size);
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
              apiPort: 17831,
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
      assert.ok(finder.closest(".file-actions-menu"));
      assert.equal(
        w.document
          .querySelector('[data-action="history-open-file"]')
          .closest(".file-actions-menu"),
        null,
      );
      assert.ok(
        w.document
          .querySelector('.file-actions-menu [data-action="delete-file"]')
          .classList.contains("menu-item-separated"),
      );
      finder.closest("details").open = true;
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
  const requests = new Set();
  const invoke = w.__TAURI__.core.invoke;
  w.__TAURI__.core.invoke = (...args) => {
    const request = invoke(...args);
    requests.add(request);
    request.then(() => requests.delete(request), () => requests.delete(request));
    return request;
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
    await drainRequests(requests);
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
  daemon.engine.store.db
    .prepare(
      "INSERT INTO devices(id,name,token_hash,role) VALUES('approver','Mac',?,'replica')",
    )
    .run(digest("test-approver"));
  daemon.engine.config.webApprovers = ["approver"];
  await w.eval(`(async()=>{${script}\n})()`);
  assert.equal(w.document.querySelectorAll('[data-code="web"]').length, 6);
  await until(() => !w.document.querySelector("#access-methods").hidden);
  // A cancelled approval must not keep polling, and switching methods preserves code input.
  w.document.querySelector('[data-digit="0"]').value = "0";
  w.document.querySelector('[data-action="login-approval"]').click();
  await until(() => w.document.querySelector("#request-countdown"));
  assert.equal(w.document.querySelector("#access-code").hidden, true);
  assert.match(
    w.document.querySelector("#request-countdown").textContent,
    /Expires in (10:00|9:59)/,
  );
  w.document.querySelector("#web-approval-wait button").click();
  assert.equal(w.document.querySelector("#access-code").hidden, false);
  assert.equal(w.document.querySelector('[data-digit="0"]').value, "0");
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const pending = await fetch(base + "/v1/web-approvals", {
    headers: { Authorization: "Bearer " + daemon.engine.config.adminToken },
  });
  assert.equal((await pending.json()).requests.length, 0);

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
    script.indexOf("let dismissedStatusError"),
  );
  const checkCode = script.slice(
    script.indexOf("function checkFolderPath("),
    script.indexOf("function codeFields("),
  );
  w.eval(
    `let activeRequests = 0, folderCacheEpoch = 0; const folderPageKey = route => route; const updateBrandActivity = () => {}; const icon = () => ""; const icons = () => {}; const escape = s => s; const $ = s => document.querySelector(s); const invoke = async () => { throw 'This folder is already shared as "alpi-host".'; }; ${apiCode}\n${checkCode}\ncheckFolderPath('path', 'new-share');`,
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
  assert.equal(style.padding, "0px");
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

test("replica folder history uses the hub policy when local status omits it", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-retention-ui-"));
  init(home, { port: 0, name: "Local Mac" });
  const daemon = await start(home, { timer: false });
  const volume = daemon.engine.store.addVolume("Photos");
  const dom = new JSDOM(html, {
    runScripts: "outside-only",
    url: "http://tauri.localhost",
  });
  const w = dom.window;
  w.setInterval = () => 0;
  t.after(async () => {
    dom.window.close();
    await daemon.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  let mode = "off";
  w.__TAURI__ = {
    core: {
      invoke: async (command, args) => {
        if (command === "bootstrap") return { setup: false };
        if (command !== "api") return {};
        if (args.route === "/v1/status") {
          const value = daemon.engine.status();
          value.role = "replica";
          value.hub = "http://hub.test";
          value.volumes.forEach((v) => {
            delete v.historyRetention;
          });
          return value;
        }
        if (args.route === "/v1/remote")
          return {
            name: "Casa",
            volumes: [{ ...volume, historyRetention: mode }],
          };
        if (args.route.startsWith("/v1/activity")) return { versions: [] };
        if (args.route.startsWith("/v1/browse")) return { entries: [] };
        if (args.route === "/v1/machines") return { machines: [] };
        throw new Error("Unexpected route " + args.route);
      },
    },
  };
  await w.eval(`(async()=>{${script}\n})()`);
  w.document.querySelector('[data-action="folder-detail"]').click();
  await until(
    () =>
      w.document.querySelector(".folder-history-status strong")?.textContent ===
      "Off",
  );
  assert.match(
    w.document.querySelector(".folder-history-status").textContent,
    /Current files only/,
  );
  await until(() => w.document.body.getAttribute("aria-busy") !== "true");
  mode = "1w";
  w.document.querySelector('[data-view="folders"]').click();
  await until(
    () =>
      w.document.querySelector(".folder-card") &&
      !w.document.body.classList.contains("view-loading"),
  );
  w.document.querySelector('[data-action="folder-detail"]').click();
  await until(
    () =>
      w.document.querySelector(".folder-history-status strong")?.textContent ===
      "On · 1 week",
  );
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
      // Keep the history scaffold visible before the real API response settles.
      if (route.startsWith("/v1/activity?") && route.includes("filter=deleted"))
        await new Promise((resolve) => setTimeout(resolve, 100));
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
  assert.ok(q(".detail-page > .file-history-summary .stats"));
  assert.equal(q(".detail-head .file-history-summary"), null);
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
  const historyIdle = () =>
    historyWindow.document.body.getAttribute("aria-busy") === "false";
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
        "true" && historyIdle(),
  );
  historyQuery("#history-share").click();
  historyQuery(`[role="option"][data-id="${v.id}"]`).click();
  await until(
    () =>
      historyWindow.location.hash.includes("volume=" + v.id) && historyIdle(),
  );
  assert.ok(historyWindow.location.hash.includes("filter=conflicts"));
  historyQuery('[data-action="history-filter"][data-id="deleted"]').click();
  await until(
    () =>
      historyQuery('[data-id="deleted"]').getAttribute("aria-pressed") ===
        "true" && historyIdle(),
  );
  assert.equal(
    historyQuery("#history-share-options [aria-selected='true']").dataset.id,
    v.id,
  );
  historyQuery('[data-action="history-filter"][data-id="deleted"]').click();
  await until(
    () =>
      historyQuery('[data-id="deleted"]').getAttribute("aria-pressed") ===
        "false" && historyIdle(),
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
  fs.writeFileSync(path.join(v.path, "rename-me.txt"), "content");
  fs.writeFileSync(path.join(v.path, "occupied.txt"), "do not replace");
  await daemon.engine.exclusive(() => daemon.engine.cycle());
  const renameWindow = await open(
    `#/history?volume=${v.id}&path=rename-me.txt`,
  );
  const rq = (selector) => renameWindow.document.querySelector(selector);
  const renameIdle = () =>
    renameWindow.document.body.getAttribute("aria-busy") === "false";
  const fileMenu = rq(".file-header-actions .file-actions-menu");
  assert.ok(fileMenu);
  assert.equal(
    fileMenu.querySelector('[data-action="history-view-folder"]'),
    null,
  );
  assert.ok(rq('.detail-side [data-action="history-view-folder"]'));
  const fileTrigger = fileMenu.querySelector("summary");
  assert.equal(fileMenu.open, false);
  fileTrigger.click();
  assert.equal(fileMenu.open, true);
  fileTrigger.dispatchEvent(
    new renameWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
  assert.equal(fileMenu.open, false);
  assert.equal(renameWindow.document.activeElement, fileTrigger);
  fileTrigger.click();
  rq(".detail-side .panel strong").click();
  assert.equal(fileMenu.open, false);
  fileTrigger.click();
  rq('[data-action="rename-file"]').click();
  assert.equal(fileMenu.open, false);

  await until(() => rq('#dialog [name="name"]') && renameIdle());
  assert.equal(rq('#dialog [name="name"]').value, "rename-me.txt");
  rq('#dialog [name="name"]').value = "occupied.txt";
  rq("#dialog-form").dispatchEvent(
    new renameWindow.Event("submit", { cancelable: true }),
  );
  await until(() => !rq("#dialog-error").hidden && renameIdle());
  assert.ok(rq("#dialog").open);
  assert.equal(
    fs.readFileSync(path.join(v.path, "occupied.txt"), "utf8"),
    "do not replace",
  );
  rq('#dialog [name="name"]').value = "renamed-file.txt";
  rq("#dialog-form").dispatchEvent(
    new renameWindow.Event("submit", { cancelable: true }),
  );
  await until(() => !rq("#dialog").open && renameIdle());
  assert.equal(
    fs.readFileSync(path.join(v.path, "renamed-file.txt"), "utf8"),
    "content",
  );
  assert.equal(fs.existsSync(path.join(v.path, "rename-me.txt")), false);
  await until(
    () =>
      rq("#folder-copies") &&
      !rq("#folder-copies").textContent.includes("Checking"),
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
      const requests = new Set();
      t.after(async () => {
        await drainRequests(requests);
        dom.window.close();
        await daemon.close();
        fs.rmSync(home, { recursive: true, force: true });
      });
      const w = dom.window;
      w.HTMLDialogElement.prototype.showModal = function () {
        this.setAttribute("open", "");
      };
      w.HTMLDialogElement.prototype.close = function () {
        this.removeAttribute("open");
      };
      w.setInterval = () => 0;
      const request = (route, options = {}) => {
        const pending = fetch(`http://127.0.0.1:${daemon.port}${route}`, {
          ...options,
          headers: {
            Authorization: `Bearer ${daemon.engine.config.adminToken}`,
            "Content-Type": "application/json",
          },
        });
        requests.add(pending);
        void pending.finally(() => requests.delete(pending));
        return pending;
      };
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
      assert.equal(
        Boolean(w.document.querySelector("#image-settings")),
        role === "hub",
      );
      if (role === "hub") {
        await until(
          () =>
            w.document.querySelector("#image-regenerate-job") &&
            w.document.body.getAttribute("aria-busy") === "false",
        );
        assert.equal(w.document.querySelectorAll("#image-settings .settings-card").length, 1);
        assert.ok(w.document.querySelector("#image-regenerate-job").hidden);
        w.document.querySelector('[data-action="images-regenerate"]').click();
        await until(
          () =>
            w.document
              .querySelector("#image-regenerate-job")
              ?.textContent.includes("Completed") &&
            w.document.body.getAttribute("aria-busy") === "false",
        );
        assert.equal(w.document.querySelector("#dialog").open, false);
      }
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
    await until(
      () =>
        w.document.body.getAttribute("aria-busy") !== "true" &&
        w.document.querySelector("#content").getAttribute("aria-busy") !==
          "true",
    );
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
    url: "http://casa:17831/#/machines",
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
  assert.equal(buttons[0].dataset.id, "http://casa:17831");
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
  const service = diagnostics.closest("section");
  assert.match(service.textContent, /Service/);
  assert.match(service.textContent, /Runtime/);
  assert.doesNotMatch(service.textContent, /alpha/);
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
                  hub: "http://casa:17831",
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
  const requests = new Set();
  t.after(async () => {
    await drainRequests(requests);
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
  const invoke = w.__TAURI__.core.invoke;
  w.__TAURI__.core.invoke = (...args) => {
    const request = invoke(...args);
    requests.add(request);
    request.then(() => requests.delete(request), () => requests.delete(request));
    return request;
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

test("notices use a stable stack, expose Copy while collapsed, and preserve Details across polling", async (t) => {
  const dom = new JSDOM(html, {
    runScripts: "outside-only",
    url: "http://localhost",
  });
  const w = dom.window;
  w.setInterval = () => 0;
  let copied = "";
  Object.defineProperty(w.navigator, "clipboard", {
    value: {
      writeText: async (value) => {
        copied = value;
      },
    },
  });
  await w.eval(
    `(async()=>{${script.replace("await action(boot);", "")}\nwindow.queue=noticeStore;})()`,
  );
  t.after(() => {
    w.queue.dispose();
    dom.window.close();
  });
  const item = {
    id: "status:hub",
    kind: "error",
    title: "Hub Casa unreachable",
    body: "Your edits are saved locally.",
    details: "GET /v1/catalog\nE_TIMEOUT token=hidden",
    action: "refresh",
    actionLabel: "Retry now",
  };
  w.queue.push(item);
  const card = w.document.querySelector(".notice-card"),
    details = card.querySelector("details"),
    copy = card.querySelector('[data-action="copy-notice"]');
  assert.ok(details.querySelector("summary").contains(copy));
  assert.equal(details.open, false);
  copy.click();
  await until(() => copied.length > 0);
  assert.ok(!copied.includes("hidden"));
  assert.equal(details.open, false);
  details.open = true;
  w.queue.push(item);
  assert.equal(w.document.querySelector(".notice-card"), card);
  assert.equal(details.open, true);
  assert.ok(card.classList.contains("notice-enter"));
  w.queue.push({ ...item, body: "Connection still unavailable." });
  const updated = w.document.querySelector(".notice-card");
  assert.notEqual(updated, card);
  assert.equal(updated.classList.contains("notice-enter"), false);
  assert.equal(updated.querySelector("details").open, true);
  w.queue.push({ id: "info", title: "Saved" });
  w.queue.push({ id: "warning", kind: "warning", title: "Conflict" });
  w.queue.push({ id: "info2", title: "Restored" });
  assert.equal(w.document.querySelectorAll("#notice .notice-card").length, 3);
});

test("navigation paints before slow reads, retains updating feedback and ignores responses from older tabs", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-navigation-"));
  init(home, { port: 0, name: "Navigation hub" });
  const daemon = await start(home, { timer: false });
  const volume = daemon.engine.store.addVolume("Documents");
  fs.writeFileSync(path.join(volume.path, "navigation.txt"), "A revision");
  await daemon.engine.cycle();
  const dom = new JSDOM(html, {
    runScripts: "outside-only",
    url: "http://tauri.localhost",
  });
  const w = dom.window,
    gates = new Map(),
    calls = [];
  let poll;
  w.setInterval = (callback, ms) => {
    if (ms === 5000) poll = callback;
    return 0;
  };
  const hold = (route) => {
    let release;
    const promise = new Promise((resolve) => {
      release = resolve;
    });
    gates.set(route, { promise, release });
    return () => {
      gates.delete(route);
      release();
    };
  };
  w.__TAURI__ = {
    core: {
      invoke: async (command, args) => {
        if (command === "bootstrap")
          return { setup: false, status: daemon.engine.status() };
        if (command === "desktop_preferences") return {};
        if (command !== "api") return {};
        calls.push(args.route);
        const gate = gates.get(args.route.split("?")[0]);
        if (gate) await gate.promise;
        const response = await fetch(
          `http://127.0.0.1:${daemon.port}${args.route}`,
          {
            method: args.method,
            ...(args.body ? { body: JSON.stringify(args.body) } : {}),
            headers: {
              authorization: `Bearer ${daemon.engine.config.adminToken}`,
            },
          },
        );
        const data = await response.json();
        if (!response.ok) throw new Error(data.error);
        return data;
      },
    },
  };
  t.after(async () => {
    for (const gate of gates.values()) gate.release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    dom.window.close();
    await daemon.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  await w.eval(`(async()=>{${script}\n})()`);
  const title = () => w.document.querySelector("#content h1")?.textContent;
  const updating = () => w.document.body.classList.contains("view-loading");
  const nav = (view) =>
    w.document.querySelector(`[data-view="${view}"]`).click();
  const releaseInitialHistory = hold("/v1/activity");
  nav("history");
  await until(() => w.document.querySelector("#history-list .scaffold-row"));
  assert.equal(
    w.document.querySelectorAll("#history-list .scaffold-row").length,
    1,
  );
  assert.equal(w.document.querySelector("#content h1").textContent, "History");
  nav("folders");
  releaseInitialHistory();
  await until(() => title() === "Folders" && !updating());
  const releaseStatus = hold("/v1/status");
  const releaseDiscovery = hold("/v1/discovery"),
    releaseMachines = hold("/v1/machines");
  nav("devices");
  await until(() => title() === "Machines");
  await until(
    () => calls.includes("/v1/discovery") && calls.includes("/v1/machines"),
  );
  assert.ok(
    updating(),
    "The target is visible while both independent machine reads are still pending",
  );
  assert.equal(
    w.document.body.getAttribute("aria-busy"),
    "false",
    "Reads do not lock navigation",
  );
  const releaseNetwork = hold("/v1/network");
  nav("settings");
  await until(() => title() === "Settings");
  releaseDiscovery();
  releaseMachines();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(title(), "Settings", "Old machine data cannot replace Settings");
  assert.ok(
    updating(),
    "Finishing the old tab cannot hide the new tab's progress",
  );
  const name = w.document.querySelector("#machine-name");
  name.focus();
  name.value = "Unsaved edit";
  releaseNetwork();
  releaseStatus();
  await until(() => !updating());
  assert.equal(w.document.querySelector("#machine-name"), name);
  assert.equal(
    name.value,
    "Unsaved edit",
    "Background data preserves the active field",
  );
  name.blur();
  nav("history");
  await until(() => !updating() && w.document.querySelector(".history-row"));
  nav("folders");
  await until(() => title() === "Folders" && !updating());
  const releaseHistory = hold("/v1/activity");
  nav("history");
  await until(
    () => title() === "History" && w.document.querySelector(".history-row"),
  );
  assert.ok(
    updating(),
    "Cached history is usable before the fresh read completes",
  );
  assert.match(
    w.document.querySelector("#history-list").textContent,
    /navigation.txt/,
  );
  releaseHistory();
  await until(() => !updating());
  nav("folders");
  await until(() => !updating());
  const card = w.document.querySelector(".folder-card[data-id]");
  w.document.querySelector("#content").scrollTop = 40;
  fs.writeFileSync(path.join(volume.path, "arrived.txt"), "new photo bytes");
  await daemon.engine.cycle();
  // Establish the latest structural state before changing only counters.
  await poll();
  const stable = w.document.querySelector(".folder-card[data-id]");
  fs.writeFileSync(path.join(volume.path, "another.txt"), "more bytes");
  await daemon.engine.cycle();
  await poll();
  assert.equal(w.document.querySelector(".folder-card[data-id]"), stable);
  assert.ok(
    stable
      .querySelector(".meta")
      .textContent.startsWith(
        `${daemon.engine.store.visibleTotals(volume.id).files} files`,
      ),
  );
  const releaseSync = hold("/v1/sync");
  nav("settings");
  await until(() => !updating());
  w.document.querySelector('[data-action="sync"]').click();
  await until(() => calls.includes("/v1/sync"));
  const pause = w.document.querySelector('[data-action="pause"]');
  pause.click();
  pause.click();
  assert.equal(
    pause.disabled,
    true,
    "queued mutation disables only its own control",
  );
  assert.equal(calls.filter((route) => route === "/v1/pause").length, 0);
  nav("folders");
  await until(() => title() === "Folders");
  w.document.querySelector('[data-action="folder-detail"]').click();
  await until(() => title() === "Documents");
  releaseSync();
  await until(
    () =>
      daemon.engine.paused &&
      w.document.body.getAttribute("aria-busy") === "false",
  );
  assert.equal(
    calls.filter((route) => route === "/v1/pause").length,
    1,
    "queued clicks are retained, duplicate submission is suppressed",
  );
});

test("gallery folders open a chronological grid, viewer and existing Files tab", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-gallery-dom-"));
  init(home, { port: 0, name: "Gallery" });
  const daemon = await start(home, { timer: false });
  const v = daemon.engine.store.addVolume("Photos");
  const sharp = (await import("sharp")).default;
  fs.writeFileSync(
    path.join(v.path, "photo.jpg"),
    await sharp({
      create: { width: 40, height: 40, channels: 3, background: "red" },
    })
      .jpeg()
      .toBuffer(),
  );
  for (const [name, color] of [
    ["a-photo.jpg", "blue"],
    ["0-photo.jpg", "green"],
  ]) {
    fs.writeFileSync(
      path.join(v.path, name),
      await sharp({
        create: { width: 40, height: 40, channels: 3, background: color },
      })
        .jpeg()
        .toBuffer(),
    );
  }
  await daemon.engine.cycle();
  const dom = new JSDOM(html, {
    runScripts: "outside-only",
    url: "http://tauri.localhost",
  });
  const retentionCalls = [];
  const largeRequests = [];
  let releaseLarge;
  const largeGate = new Promise((resolve) => {
    releaseLarge = resolve;
  });
  t.after(() => releaseLarge());
  const galleryRequests = [];
  let staleGallery = null;
  let replayStaleGallery = false;
  const requests = new Set();
  t.after(async () => {
    await until(
      () => dom.window.document.body.getAttribute("aria-busy") !== "true",
    );
    await drainRequests(requests);
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
        if (command !== "api") throw new Error(command);
        if (args.route === "/v1/folder-retention") {
          retentionCalls.push(args.body);
          return { remove: 3, confirmation: "preview" };
        }
        if (
          args.route.includes("/gallery/preview-url?") &&
          args.route.includes("size=large")
        ) {
          largeRequests.push(args.route);
          await largeGate;
        }
        if (args.route.startsWith("/v1/gallery?"))
          galleryRequests.push(args.route);
        const r = await fetch(`http://127.0.0.1:${daemon.port}${args.route}`, {
          method: args.method || "GET",
          headers: {
            Authorization: `Bearer ${daemon.engine.config.adminToken}`,
            "Content-Type": "application/json",
          },
          ...(args.body ? { body: JSON.stringify(args.body) } : {}),
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error);
        if (args.route.startsWith("/v1/gallery?")) {
          if (replayStaleGallery) return structuredClone(staleGallery);
          staleGallery = structuredClone(data);
        }
        return data;
      },
    },
  };
  const invoke = w.__TAURI__.core.invoke;
  w.__TAURI__.core.invoke = (...args) => {
    const request = invoke(...args);
    requests.add(request);
    request.then(
      () => requests.delete(request),
      () => requests.delete(request),
    );
    return request;
  };
  await w.eval(`(async()=>{${script}\n})()`);
  assert.ok(w.document.querySelector('.folder-card [data-icon="folder"]'));
  w.document.querySelector('[data-action="folder-detail"]').click();
  await until(() => w.document.querySelector(".browser-file-row"));
  assert.ok(w.document.querySelector('[data-action="open"]'));
  await until(() => w.document.body.getAttribute("aria-busy") !== "true");
  assert.ok(
    w.document.querySelector(".folder-history-status #folder-retention"),
  );
  assert.equal(
    w.document.querySelector(".heading-actions #folder-retention"),
    null,
  );
  assert.doesNotMatch(
    w.document.querySelector(".folder-history-status").textContent,
    /on hub/,
  );
  const retention = w.document.querySelector("#folder-retention");
  assert.equal(
    retention.querySelector('[aria-pressed="true"]').dataset.id,
    "1m",
  );
  assert.deepEqual(
    [...retention.querySelectorAll("button")].map(
      (option) => option.dataset.id,
    ),
    ["off", "1d", "1w", "1m", "forever"],
  );
  assert.ok(
    retention.compareDocumentPosition(
      w.document.querySelector('[data-action="rename-share"]'),
    ) & w.Node.DOCUMENT_POSITION_PRECEDING,
  );
  retention.querySelector('[data-id="off"]').click();
  await until(
    () =>
      w.document.querySelector("#dialog").open &&
      w.document.body.getAttribute("aria-busy") !== "true",
  );
  assert.ok(w.document.querySelector("#dialog.confirmation-dialog"));
  assert.match(
    w.document.querySelector("#dialog-content").textContent,
    /3 older revisions/,
  );
  assert.equal(
    retention.querySelector('[aria-pressed="true"]').dataset.id,
    "1m",
  );
  assert.equal(w.document.querySelector(".retention-inline-review"), null);
  w.document.querySelector("#cancel-dialog").click();
  assert.equal(retentionCalls.length, 1);
  assert.equal(retentionCalls[0].apply, undefined);

  assert.deepEqual(
    [...w.document.querySelectorAll('[data-action="folder-tab"]')].map(
      (el) => el.dataset.id,
    ),
    ["files", "recent"],
  );
  assert.ok(w.document.querySelector('[data-action="open"]'));
  w.document.querySelector('[data-action="enable-gallery"]').click();
  assert.match(
    w.document.querySelector("#dialog-content").textContent,
    /Files and synchronization stay the same/,
  );
  await until(() => w.document.body.getAttribute("aria-busy") !== "true");
  w.document.querySelector("#submit-dialog").click();
  await until(() => w.document.querySelector(".photo-thumb img"));
  assert.equal(
    daemon.engine.status().volumes.find((folder) => folder.id === v.id).gallery,
    true,
  );
  assert.equal(fs.existsSync(path.join(v.path, "0-photo.jpg")), true);
  assert.ok(w.document.querySelector(".photo-thumb .photo-open img"));
  assert.equal(w.document.querySelector('[data-action="open"]'), null);
  assert.equal(w.document.querySelector(".folder-browser-tools"), null);
  assert.match(
    w.document.querySelector('.heading-actions [data-action="gallery-mode"]')
      .textContent,
    /Exit gallery/,
  );

  assert.notEqual(
    w.document.querySelector(".photo-day h2").textContent,
    "Date unknown",
  );
  await until(() => w.document.querySelector(".photo-timeline button"));
  assert.ok(w.document.querySelector(".photo-timeline button"));
  assert.equal(w.document.querySelectorAll(".photo-day").length, 1);
  assert.equal(
    w.document.querySelectorAll(".photo-day .photo-thumb").length,
    3,
  );
  assert.match(
    w.document.querySelector(".photo-day").dataset.day,
    /^\d{4}-\d{2}$/,
  );
  assert.match(
    w.document.querySelector(".photo-day h2").textContent,
    /^[A-Za-z]+ \d{4}$/,
  );
  await until(
    () => w.document.querySelectorAll(".photo-open img").length === 3,
  );
  Object.defineProperty(w.document, "hidden", {
    configurable: true,
    value: false,
  });
  const galleryRoot = w.document.querySelector("#photo-gallery");
  const galleryPage = w.document.querySelector(".page");
  galleryPage.scrollTop = 77;
  fs.copyFileSync(
    path.join(v.path, "photo.jpg"),
    path.join(v.path, "new-arrival.jpg"),
  );
  await daemon.engine.cycle();
  await daemon.engine.gallery.background;
  w.document.dispatchEvent(new w.Event("visibilitychange"));
  await until(() => w.document.querySelectorAll(".photo-thumb").length === 4);
  assert.equal(w.document.querySelector("#photo-gallery"), galleryRoot);
  assert.equal(galleryPage.scrollTop, 77);
  fs.unlinkSync(path.join(v.path, "new-arrival.jpg"));
  await daemon.engine.cycle();
  w.document.dispatchEvent(new w.Event("visibilitychange"));
  await until(() => w.document.querySelectorAll(".photo-thumb").length === 3);
  await until(
    () => w.document.querySelectorAll(".photo-open img").length === 3,
  );
  const thumbnail = w.document.querySelector(".photo-open img").src;
  w.document.querySelector(".photo-open").click();
  assert.equal(
    w.document.querySelector(".photo-viewer-image img").src,
    thumbnail,
  );
  assert.equal(
    w.document.querySelector(".photo-viewer-image .busy-grid"),
    null,
  );
  await until(() => largeRequests.length === 2);
  assert.ok(
    w.document.querySelector(".photo-preview-placeholder"),
    "thumbnail stays visible while the full preview is stalled",
  );
  w.document.querySelector(".photo-next").click();
  assert.equal(
    w.document.querySelector(".photo-viewer-image img").alt,
    "a-photo.jpg",
  );
  w.document.querySelector(".photo-previous").click();
  assert.equal(
    w.document.querySelector(".photo-viewer-image img").alt,
    "photo.jpg",
  );
  releaseLarge();
  await until(() =>
    w.document.querySelector(
      ".photo-viewer-image img:not(.photo-preview-placeholder)",
    ),
  );
  assert.equal(
    w.document.querySelector(".photo-viewer-image img").alt,
    "photo.jpg",
  );
  assert.equal(w.document.querySelector(".photo-previous").disabled, true);
  assert.equal(
    w.document.querySelector("#cancel-dialog").getAttribute("aria-label"),
    "Back to gallery",
  );
  assert.ok(w.document.querySelector(".photo-download"));
  w.document.body.dispatchEvent(
    new w.KeyboardEvent("keydown", { key: "i", metaKey: true, bubbles: true }),
  );
  assert.equal(w.document.querySelector(".photo-info").hidden, false);
  w.document.body.dispatchEvent(
    new w.KeyboardEvent("keydown", { key: "i", ctrlKey: true, bubbles: true }),
  );
  assert.equal(w.document.querySelector(".photo-info").hidden, true);
  w.document.querySelector(".photo-info-toggle").click();
  assert.equal(w.document.querySelector(".photo-info").hidden, false);
  assert.match(
    w.document.querySelector(".photo-info").textContent,
    /photo.jpg/,
  );
  await until(() =>
    /40 × 40/.test(w.document.querySelector(".photo-info").textContent),
  );
  assert.match(
    w.document.querySelector(".photo-info").textContent,
    /File path/,
  );
  assert.equal(w.document.querySelector(".photo-file").hidden, true);
  await until(() =>
    largeRequests.some((route) => route.includes("path=a-photo.jpg")),
  );
  w.document.querySelector(".photo-next").click();
  await until(
    () =>
      w.document.querySelector(".photo-viewer-image img")?.alt ===
      "a-photo.jpg",
  );
  assert.equal(w.document.querySelector(".photo-info").hidden, true);
  assert.equal(
    w.document
      .querySelector(".photo-info-toggle")
      .getAttribute("aria-expanded"),
    "false",
  );
  w.document.querySelector(".photo-previous").click();
  await until(
    () =>
      w.document.querySelector(".photo-viewer-image img")?.alt === "photo.jpg",
  );
  assert.equal(
    largeRequests.filter((route) => route.includes("path=photo.jpg")).length,
    1,
  );
  assert.equal(
    largeRequests.filter((route) => route.includes("path=a-photo.jpg")).length,
    1,
  );
  w.document.querySelector(".photo-info-close").click();
  assert.equal(w.document.querySelector(".photo-info").hidden, true);
  w.document.querySelector("#cancel-dialog").click();
  const pageReads = galleryRequests.length;
  w.document.querySelector('[data-action="gallery-mode"]').click();
  await until(() => !w.document.querySelector("#photo-gallery"));
  w.document.querySelector('[data-action="gallery-mode"]').click();
  await until(() => w.document.querySelector(".photo-open"));
  assert.equal(
    galleryRequests.length,
    pageReads,
    "reopening must reuse the prepared page",
  );
  w.document.querySelector(".photo-open").click();
  await until(() => w.document.querySelector(".photo-viewer-image img"));
  assert.equal(
    largeRequests.filter((route) => route.includes("path=photo.jpg")).length,
    1,
    "reopening the gallery must reuse its content-addressed preview",
  );
  w.document.querySelector(".photo-delete").click();
  assert.ok(w.document.querySelector(".confirmation-dialog"));
  assert.ok(
    w.document.querySelector(
      "#background-dialog[open] .photo-viewer-image img",
    ),
  );
  w.document.querySelector("#cancel-dialog").click();
  assert.equal(daemon.engine.store.current(v.id, "photo.jpg").deleted, 0);
  assert.equal(
    w.document.querySelector("#dialog").classList.contains("photo-viewer"),
    true,
  );
  assert.equal(
    w.document.querySelector(".photo-viewer-image img").alt,
    "photo.jpg",
  );
  replayStaleGallery = true;
  w.document.querySelector(".photo-delete").click();
  w.document
    .querySelector("#dialog-form")
    .dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
  await until(
    () =>
      w.document.querySelector("#dialog.photo-viewer .photo-viewer-image img")
        ?.alt === "a-photo.jpg",
  );
  await until(() => w.document.body.getAttribute("aria-busy") !== "true");
  assert.equal(daemon.engine.store.current(v.id, "photo.jpg").deleted, 1);
  assert.equal(w.document.querySelector(".photo-previous").disabled, true);
  assert.equal(w.document.querySelector('[aria-label="Open photo.jpg"]'), null);
  w.document.querySelector("#cancel-dialog").click();
  w.document.querySelector('[data-action="gallery-mode"]').click();
  await until(() => !w.document.querySelector("#photo-gallery"));
  w.document.querySelector('[data-action="gallery-mode"]').click();
  await until(() => w.document.querySelectorAll(".photo-select").length === 2);
  assert.equal(
    w.document.querySelector('[aria-label="Open photo.jpg"]'),
    null,
    "a stale hub page cannot revive the confirmed local deletion",
  );
  for (const check of w.document.querySelectorAll(".photo-select"))
    check.click();
  assert.equal(w.document.querySelector("#photo-selection").hidden, false);
  assert.ok(
    w.document.querySelector(".detail-head > .heading > #photo-selection"),
  );
  assert.ok(w.document.querySelector(".heading.has-photo-selection"));
  assert.equal(w.document.querySelector(".page #photo-selection"), null);
  assert.equal(
    w.document.querySelector(".photo-selection-count").textContent,
    "2 selected",
  );
  w.document.querySelector(".photo-selection-delete").click();
  assert.match(
    w.document.querySelector("#dialog-title").textContent,
    /2 photos/,
  );
  w.document.querySelector("#cancel-dialog").click();
  w.document.querySelector(".photo-selection-clear").click();
  assert.equal(w.document.querySelector("#photo-selection").hidden, true);
  assert.equal(w.document.querySelector(".heading.has-photo-selection"), null);

  w.document.querySelector("#cancel-dialog").click();
  w.document.querySelector('[data-action="gallery-mode"]').click();
  await until(() => w.document.querySelector(".browser-file-row"));
  await until(() => w.document.body.getAttribute("aria-busy") !== "true");
  assert.match(
    [...w.document.querySelectorAll(".browser-file-row")]
      .map((row) => row.textContent)
      .join(" "),
    /photo.jpg/,
  );
  w.document
    .querySelector('[data-action="folder-tab"][data-id="recent"]')
    .click();
  await until(() => w.document.querySelector(".history-row"));
  await until(
    () =>
      w.document.querySelector("#content").getAttribute("aria-busy") !== "true",
  );
  w.document.querySelector(".page").scrollTop = 123;
  w.document.querySelector('[data-action="gallery-mode"]').click();
  await until(() => w.document.querySelectorAll(".photo-select").length === 2);
  w.document.querySelector(".photo-select").click();
  assert.equal(
    w.document
      .querySelector('#photo-selection [data-action="gallery-mode"]')
      .textContent.trim(),
    "Exit gallery",
  );
  w.document
    .querySelector('#photo-selection [data-action="gallery-mode"]')
    .click();
  await until(() => w.document.querySelector(".history-row"));
  await until(() => w.document.querySelector(".page").scrollTop === 123);
  assert.equal(
    w.document
      .querySelector('[data-action="folder-tab"][data-id="recent"]')
      .getAttribute("aria-pressed"),
    "true",
  );
  w.document.querySelector('[data-action="gallery-mode"]').click();
  await until(() => w.document.querySelectorAll(".photo-select").length === 2);
  assert.equal(w.document.querySelector("#photo-selection").hidden, true);
  for (const check of w.document.querySelectorAll(".photo-select"))
    check.click();
  w.document.querySelector(".photo-selection-delete").click();
  w.document
    .querySelector("#dialog-form")
    .dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
  await until(
    () =>
      daemon.engine.store.current(v.id, "photo.jpg").deleted &&
      daemon.engine.store.current(v.id, "a-photo.jpg").deleted,
  );
  await until(() => !w.document.querySelector("#dialog").open);
  await until(
    () =>
      !w.document.querySelector("#submit-dialog").disabled &&
      !w.document.querySelector("#submit-dialog").hasAttribute("aria-busy"),
  );
  await until(
    () =>
      w.document.querySelector("#content").getAttribute("aria-busy") !== "true",
  );
});

test("web approval uses the shared confirmation and closes after another machine responds", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-approval-ui-"));
  init(home, { port: 0, name: "Casa" });
  const daemon = await start(home, { timer: false });
  const dom = new JSDOM(html, {
    runScripts: "outside-only",
    url: "http://tauri.localhost",
  });
  const w = dom.window;
  const timers = [];
  w.setInterval = (fn, ms) => {
    if (ms === 3000) timers.push(fn);
    return 0;
  };
  let requests = [
    {
      id: "request",
      reference: "042123",
      browser: "Safari on macOS",
      created: Date.now(),
      expires: Date.now() + 600000,
      agent: "Safari <script>",
      ip: "100.1.2.3",
    },
  ];
  w.__TAURI__ = {
    core: {
      invoke: async (command, args) => {
        if (command === "bootstrap") return { setup: false };
        if (command !== "api") return {};
        if (args.route === "/v1/status") return daemon.engine.status();
        if (args.route === "/v1/web-approvals") return { requests };
        throw new Error("Unexpected route " + args.route);
      },
    },
  };
  w.HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  w.HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
    this.dispatchEvent(new w.Event("close"));
  };
  t.after(async () => {
    w.close();
    await daemon.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  await w.eval(`(async()=>{${script}\n})()`);
  timers[0]();
  await until(() => w.document.querySelector("#dialog").open);
  assert.ok(w.document.querySelector("#dialog.confirmation-dialog"));
  assert.match(
    w.document.querySelector("#dialog-content").textContent,
    /042–123/,
  );
  assert.equal(w.document.querySelector("#dialog-content script"), null);
  assert.equal(w.document.querySelector("#submit-dialog").textContent, "Allow");
  assert.equal(w.document.querySelector("#cancel-dialog").textContent, "Deny");
  requests = [];
  timers[0]();
  await until(() => !w.document.querySelector("#dialog").open);
});

for (const role of ["hub", "replica"])
  test(
    "unconfigured web opens onboarding before authentication: " + role,
    async (t) => {
      const { initializeServer } = await import("../packages/daemon/setup.js");
      const { issueWebCode } = await import("../packages/daemon/web.js");
      const home = fs.mkdtempSync(
        path.join(os.tmpdir(), "arca-first-access-ui-"),
      );
      initializeServer(home, { port: 0 });
      const daemon = await start(home, { timer: false });
      const base = "http://127.0.0.1:" + daemon.port;
      const w = new JSDOM(html, { runScripts: "outside-only", url: base })
        .window;
      w.setInterval = () => 0;
      let cookie = "",
        mutations = 0;
      w.fetch = async (route, options = {}) => {
        if (route === "/v1/setup") mutations++;
        const response = await fetch(new URL(route, base), {
          ...options,
          headers: {
            ...options.headers,
            Origin: base,
            ...(cookie ? { Cookie: cookie } : {}),
          },
        });
        if (response.headers.get("set-cookie"))
          cookie = response.headers.get("set-cookie").split(";")[0];
        // Server state may be committed before the browser receives the reply.
        if (route === "/v1/setup")
          await new Promise((resolve) => setTimeout(resolve, 100));
        return response;
      };
      t.after(async () => {
        w.close();
        await daemon.close();
        fs.rmSync(home, { recursive: true, force: true });
      });
      await w.eval(`(async()=>{${script}\n})()`);
      await until(() => w.document.querySelector("#setup-form"));
      assert.match(w.document.querySelector("h1").textContent, /Many devices/);
      assert.equal(w.document.querySelector("#web-login"), null);
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
      submit();
      await waitFor('[name="name"]');
      w.document.querySelector('[name="name"]').value = "Chosen server";
      submit();
      await waitFor('[name="role"]');
      w.document.querySelector('[name="role"][value="' + role + '"]').checked =
        true;
      submit();
      await waitFor('[data-code="setup-access"]');
      assert.equal(mutations, 0);
      assert.equal(daemon.engine.config.needsSetup, true);
      submit();
      await until(() => !w.document.querySelector("#setup-error").hidden);
      assert.match(
        w.document.querySelector("#setup-error").textContent,
        /six digits/,
      );
      const { code } = issueWebCode(home);
      [...code].forEach((digit, i) => {
        w.document.querySelector(
          '[data-code="setup-access"][data-digit="' + i + '"]',
        ).value = digit;
      });
      submit();
      await waitFor(role === "hub" ? '[name="root"]' : '[name="url"]');
      assert.ok(cookie);
      assert.equal(mutations, 0);
      if (role === "hub") {
        submit();
        await until(
          () =>
            !daemon.engine.config.needsSetup &&
            !daemon.engine.config.onboarding &&
            !w.document.querySelector("#setup-form") &&
            w.document.body.getAttribute("aria-busy") === "false" &&
            !w.document.body.classList.contains("view-loading"),
        );
        assert.equal(daemon.engine.config.name, "Chosen server");
        assert.equal(daemon.engine.config.role, "hub");
      }
    },
  );

test("configured server hides unavailable machine approval and displays the chosen name", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-no-approvers-ui-"));
  init(home, { name: "My server", port: 0 });
  const daemon = await start(home, { timer: false });
  const base = "http://127.0.0.1:" + daemon.port;
  const w = new JSDOM(html, { runScripts: "outside-only", url: base }).window;
  w.setInterval = () => 0;
  w.fetch = (route, options) => fetch(new URL(route, base), options);
  t.after(async () => {
    w.close();
    await daemon.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  await w.eval(`(async()=>{${script}\n})()`);
  await until(() =>
    w.document.querySelector("#access-name")?.textContent.includes("My server"),
  );
  assert.equal(w.document.querySelector("#access-methods").hidden, true);
  assert.ok(w.document.querySelector("#web-login"));
  w.document.querySelector('[data-action="login-approval"]').click();
  assert.equal(w.document.querySelector("#access-code").hidden, false);
});

test("hub danger zone cancels safely and returns to onboarding after local destruction", async (t) => {
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
  const v = await hub.engine.publish("Documents", undefined, false);
  const destination = v.path;
  fs.writeFileSync(path.join(destination, "local.txt"), "hub data");
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
          hub,
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
      w.document.querySelector('[data-action="destroy-hub"]') &&
      w.document.body.getAttribute("aria-busy") === "false",
  );
  assert.equal(
    w.document.querySelector('[data-action="disconnect-hub"]'),
    null,
  );
  w.document.querySelector('[data-action="destroy-hub"]').click();
  await until(() => w.document.querySelector("#dialog").open);
  assert.ok(
    w.document.querySelector("#dialog").textContent.includes(destination),
  );
  assert.match(
    w.document.querySelector("#dialog").textContent,
    /Replicas keep their local files/,
  );
  assert.ok(
    w.document.querySelector("#submit-dialog").classList.contains("danger"),
  );
  w.document.querySelector("#cancel-dialog").click();
  assert.ok(fs.existsSync(destination));
  assert.equal(hub.engine.config.role, "hub");
  await until(() => w.document.body.getAttribute("aria-busy") === "false");
  w.document.querySelector('[data-action="destroy-hub"]').click();
  await until(() => w.document.querySelector("#dialog").open);
  w.document.querySelector("#submit-dialog").click();
  await until(
    () =>
      w.document.querySelector("#setup-form") &&
      w.document.body.getAttribute("aria-busy") === "false",
  );
  assert.equal(fs.existsSync(destination), false);
  assert.equal(hub.engine.config.needsSetup, true);
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

test("Tauri gallery opens video before its poster and stops media when closed", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-video-dom-"));
  init(home, { port: 0 });
  const daemon = await start(home, { timer: false });
  const volume = daemon.engine.store.addVolume("Videos");
  fs.writeFileSync(path.join(volume.path, "clip.mp4"), "video fixture");
  await daemon.engine.cycle();
  daemon.engine.gallery.mark(volume.id);
  await daemon.engine.gallery.background;
  const dom = new JSDOM(html, {
    runScripts: "outside-only",
    pretendToBeVisual: true,
    url: "http://tauri.localhost",
  });
  const w = dom.window;
  let releasePoster,
    paused = 0,
    loads = 0,
    played = 0,
    reducedMotion = false,
    rejectPlay = false,
    holdPlayback = false,
    releasePlayback;
  w.matchMedia = () => ({ matches: reducedMotion });
  w.HTMLMediaElement.prototype.play = function () {
    played++;
    return rejectPlay
      ? Promise.reject(new Error("Autoplay blocked"))
      : Promise.resolve();
  };
  let activityReads = 0;
  w.setInterval = () => 0;
  w.HTMLMediaElement.prototype.pause = function () {
    paused++;
  };
  w.HTMLMediaElement.prototype.load = function () {
    loads++;
  };
  w.HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  w.HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
    this.dispatchEvent(new w.Event("close"));
  };
  w.__TAURI__ = {
    core: {
      invoke: async (command, args) => {
        if (command === "bootstrap")
          return { setup: false, status: daemon.engine.status() };
        if (command !== "api") throw new Error(command);
        if (args.route.startsWith("/v1/activity?volume=")) activityReads++;
        if (args.route.startsWith("/v1/gallery/preview?"))
          return new Promise((resolve) => {
            releasePoster = resolve;
          });
        if (holdPlayback && args.route.startsWith("/v1/gallery/playback?"))
          await new Promise((resolve) => {
            releasePlayback = resolve;
          });
        const r = await fetch(`http://127.0.0.1:${daemon.port}${args.route}`, {
          method: args.method,
          headers: {
            Authorization: `Bearer ${daemon.engine.config.adminToken}`,
            "Content-Type": "application/json",
          },
          ...(args.body ? { body: JSON.stringify(args.body) } : {}),
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error);
        return data;
      },
    },
  };
  t.after(async () => {
    releasePlayback?.();
    releasePoster?.({ unavailable: true });
    w.close();
    await daemon.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  await w.eval(`(async()=>{${script}\n})()`);
  w.document.querySelector('[data-action="folder-detail"]').click();
  await until(
    () =>
      w.document.querySelector('[data-action="gallery-mode"]') &&
      w.document.body.getAttribute("aria-busy") === "false",
  );
  await until(() => w.document.querySelector(".photo-open"));
  assert.equal(
    activityReads,
    0,
    "gallery entry must not wait for folder history",
  );
  assert.match(
    w.document.querySelector('[data-action="gallery-mode"]').textContent,
    /Exit gallery/,
  );
  assert.ok(w.document.querySelector(".photo-video-badge"));
  await until(() => w.document.body.getAttribute("aria-busy") === "false");
  const tile = w.document.querySelector(".photo-thumb");
  const enter = (pointerType = "mouse") =>
    tile.dispatchEvent(
      Object.assign(new w.Event("pointerenter"), { pointerType }),
    );
  enter("touch");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(played, 0, "touch must not start a hover preview");
  reducedMotion = true;
  enter();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(played, 0, "respect reduced motion");
  reducedMotion = false;
  enter();
  await until(() => tile.querySelector("video"));
  const preview = tile.querySelector("video");
  assert.equal(preview.muted, true);
  assert.equal(preview.controls, false);
  preview.currentTime = 3;
  preview.dispatchEvent(new w.Event("timeupdate"));
  assert.equal(tile.querySelector("video"), null);
  assert.equal(preview.hasAttribute("src"), false);
  enter();
  await until(() => tile.querySelector("video"));
  tile.dispatchEvent(new w.Event("pointerleave"));
  assert.equal(tile.querySelector("video"), null);
  holdPlayback = true;
  enter();
  await until(() => releasePlayback);
  tile.dispatchEvent(new w.Event("pointerleave"));
  releasePlayback();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(
    tile.querySelector("video"),
    null,
    "late playback response cannot restart hover",
  );
  holdPlayback = false;
  const beforeClose = { paused, loads, played };
  w.document.querySelector(".photo-open").click();
  await until(() => w.document.querySelector(".photo-viewer video"));
  const video = w.document.querySelector("video");
  assert.equal(video.controls, true);
  assert.equal(video.autoplay, true);
  assert.equal(played, beforeClose.played + 1);
  w.document.querySelector(".photo-info-toggle").click();
  assert.equal(w.document.querySelector(".photo-info").hidden, false);
  assert.match(video.src, /127\.0\.0\.1.*ticket=/);
  w.document.querySelector("#cancel-dialog").click();
  assert.equal(paused, beforeClose.paused + 1);
  assert.equal(loads, beforeClose.loads + 1);
  assert.equal(video.hasAttribute("src"), false);
  rejectPlay = true;
  w.document.querySelector(".photo-open").click();
  await until(() => w.document.querySelector(".photo-viewer video"));
  assert.equal(w.document.querySelector(".photo-info").hidden, true);
  assert.equal(
    w.document
      .querySelector(".photo-info-toggle")
      .getAttribute("aria-expanded"),
    "false",
  );
  assert.equal(w.document.querySelector(".photo-viewer video").controls, true);
  w.document.querySelector("#cancel-dialog").click();
});

test("folder reentry keeps known files and revision while the brand shows refresh activity", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-folder-cache-"));
  init(home, { port: 0 });
  const daemon = await start(home, { timer: false });
  const volume = daemon.engine.store.addVolume("Cached folder");
  const other = daemon.engine.store.addVolume("Other folder");
  fs.writeFileSync(path.join(volume.path, "known.txt"), "known content");
  await daemon.engine.cycle();
  const dom = new JSDOM(html, {
    runScripts: "outside-only",
    url: "http://tauri.localhost",
  });
  const w = dom.window;
  w.setInterval = () => 0;
  let hold = false,
    fail = false,
    release;
  const pending = new Set();
  w.__TAURI__ = {
    core: {
      invoke: async (command, args) => {
        if (command === "bootstrap")
          return { setup: false, status: daemon.engine.status() };
        if (command !== "api") throw new Error(command);
        const work = (async () => {
          if (hold && args.route.startsWith("/v1/activity?volume="))
            await new Promise((resolve) => {
              release = resolve;
            });
          if (fail && /^\/v1\/(activity|browse)\?/.test(args.route))
            throw new Error("Hub offline");
          const response = await fetch(
            `http://127.0.0.1:${daemon.port}${args.route}`,
            {
              headers: {
                Authorization: `Bearer ${daemon.engine.config.adminToken}`,
              },
            },
          );
          if (!response.ok) throw new Error(`API ${response.status}`);
          const value = await response.json();
          if (args.route === "/v1/machines")
            await new Promise((resolve) => setTimeout(resolve, 100));
          return value;
        })();
        pending.add(work);
        try {
          return await work;
        } finally {
          pending.delete(work);
        }
      },
    },
  };
  t.after(async () => {
    hold = false;
    release?.();
    await drainRequests(pending);
    w.close();
    await daemon.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const click = (action, id) =>
    w.document
      .querySelector(
        `[data-action="${action}"]${id ? `[data-id="${id}"]` : ""}`,
      )
      .click();
  const idle = () => w.document.body.getAttribute("aria-busy") === "false";
  await w.eval(`(async()=>{${script}\n})()`);
  click("folder-detail", volume.id);
  await until(() => idle() && w.document.querySelector(".browser-file-row"));
  const revision = w.document.querySelector(
    ".folder-stats .stat:nth-child(3) strong",
  ).textContent;
  assert.match(revision, /^rev \d+$/);
  click("back-folders");
  await until(idle);
  hold = true;
  click("folder-detail", volume.id);
  await until(() => release && w.document.querySelector(".browser-file-row"));
  assert.match(
    w.document.querySelector(".folder-explorer").textContent,
    /known.txt/,
  );
  assert.equal(
    w.document.querySelector(".folder-stats .stat:nth-child(3) strong")
      .textContent,
    revision,
  );
  assert.equal(
    w.document.querySelectorAll(".detail-revisions .scaffold-row").length,
    0,
  );
  assert.ok(w.document.querySelector(".brand-mark.is-busy .busy-grid"));
  assert.equal(
    w.document.querySelector(".brand-mark").getAttribute("aria-busy"),
    "true",
  );
  fail = true;
  hold = false;
  release();
  await until(idle);
  await until(
    () =>
      w.document.querySelector(".brand-mark").getAttribute("aria-busy") ===
      "false",
  );
  assert.match(
    w.document.querySelector(".folder-explorer").textContent,
    /known.txt/,
  );
  assert.equal(
    w.document.querySelector(".folder-stats .stat:nth-child(3) strong")
      .textContent,
    revision,
  );
  click("back-folders");
  await until(idle);
  hold = true;
  release = null;
  fail = false;
  click("folder-detail", other.id);
  await until(
    () =>
      release && w.document.querySelector(".detail-revisions .scaffold-row"),
  );
  assert.doesNotMatch(
    w.document.querySelector(".detail-revisions").textContent,
    /known.txt/,
  );
  hold = false;
  release();
  await until(idle);
  assert.doesNotMatch(
    w.document.querySelector(".folder-explorer").textContent,
    /known.txt/,
  );
});

test("Review opens the folder error details without navigating away", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-review-error-"));
  init(home, { port: 0 });
  const daemon = await start(home, { timer: false });
  daemon.engine.store.addVolume("Documents");
  const dom = new JSDOM(html, {
    runScripts: "outside-only",
    url: "http://tauri.localhost",
  });
  const w = dom.window;
  const pending = new Set();
  w.setInterval = () => 0;
  w.HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  w.HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  const problem =
    'Unsupported file path: "café/report?.txt". Remove reserved characters.';
  const status = () => ({
    ...daemon.engine.status(),
    volumes: daemon.engine
      .status()
      .volumes.map((v) => ({ ...v, sync: { state: "error", error: problem } })),
  });
  w.__TAURI__ = {
    core: {
      invoke: async (command, args) => {
        if (command === "bootstrap") return { setup: false, status: status() };
        if (args.route === "/v1/status") return status();
        const work = fetch(`http://127.0.0.1:${daemon.port}${args.route}`, {
          headers: {
            Authorization: `Bearer ${daemon.engine.config.adminToken}`,
          },
        }).then((r) => r.json());
        pending.add(work);
        try {
          return await work;
        } finally {
          pending.delete(work);
        }
      },
    },
  };
  t.after(async () => {
    await drainRequests(pending);
    w.close();
    await daemon.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  await w.eval(`(async()=>{${script}\n})()`);
  w.document.querySelector('[data-action="folder-problem"]').click();
  await until(
    () =>
      w.document.querySelector("#dialog").open &&
      w.document.body.getAttribute("aria-busy") === "false",
  );
  assert.match(
    w.document.querySelector("#dialog-title").textContent,
    /Documents/,
  );
  assert.ok(
    w.document.querySelector("#dialog-content").textContent.includes(problem),
  );
  assert.equal(
    w.document.querySelector("#submit-dialog").textContent,
    "Retry now",
  );
  assert.ok(w.document.querySelector(".folder-card"));
  w.document.querySelector("#cancel-dialog").click();
  assert.equal(w.document.querySelector("#dialog").open, false);
});

test("gallery deletion filtering survives reload and permits restored revisions without hiding another folder", async (t) => {
  const key = JSON.stringify(["replica", "hub", "photos", "photo.jpg"]);
  const dom = new JSDOM(html, {
    runScripts: "outside-only",
    url: "http://localhost",
  });
  const w = dom.window;
  w.setInterval = () => 0;
  w.localStorage.setItem(
    "arca-gallery-deletions",
    JSON.stringify({ [key]: 12 }),
  );
  await w.eval(
    `(async()=>{${script.replace("await action(boot);", "")}\nstatus = { id: "replica", hubId: "hub" }; window.visiblePage = visibleGalleryPage; window.disposeNotices = () => noticeStore.dispose();})()`,
  );
  t.after(() => {
    w.disposeNotices();
    w.close();
  });
  const page = {
    items: [
      { path: "photo.jpg", rev: 12 },
      { path: "other.jpg", rev: 11 },
    ],
    next: null,
  };
  assert.equal(
    w.visiblePage("/v1/gallery?volume=photos", page).items.length,
    1,
  );
  assert.equal(
    page.items.length,
    2,
    "filtering does not mutate shared cached responses",
  );
  assert.equal(w.visiblePage("/v1/gallery?volume=other", page).items.length, 2);
  assert.equal(
    w.visiblePage("/v1/gallery?volume=photos", {
      items: [{ path: "photo.jpg", rev: 13 }],
      next: null,
    }).items.length,
    1,
    "a newer restored revision remains visible",
  );
});

test("folder copies include linked phone albums without labeling them as replicas", async (t) => {
  const dom = new JSDOM(html, {
    runScripts: "outside-only",
    url: "http://localhost",
  });
  const w = dom.window;
  w.setInterval = () => 0;
  await w.eval(`(async()=>{${script.replace("await action(boot);", "")}

    status = { id: "hub", name: "casa", role: "hub", volumes: [{ id: "photos", selected: true }] };
    detailId = "photos";
    copiesRoster = { machines: [
      { machineId: "phone", name: "phone", platform: "android", folderIds: [], albumFolderIds: ["photos"], freshness: "recent" },
      { machineId: "fold", name: "phone-fold", platform: "android", folderIds: [], albumFolderIds: ["photos"], freshness: "stale" },
      { machineId: "mac", name: "macbook-pro", folderIds: ["photos"], freshness: "recent" },
      { machineId: "other", name: "other", folderIds: [], albumFolderIds: ["unrelated"] }
    ] };
    document.querySelector("#content").innerHTML = '<div id="folder-copies"></div>';
    renderCopies();
    window.disposeNotices = () => noticeStore.dispose();
  })()`);
  t.after(() => {
    w.disposeNotices();
    w.close();
  });
  const rows = [...w.document.querySelectorAll(".copy-row")];
  assert.equal(rows.length, 4);
  const row = (name) =>
    rows.find((r) => r.querySelector("strong").textContent === name);
  assert.equal(row("phone").querySelector(".tag").textContent, "Album source");
  assert.equal(
    row("phone-fold").querySelector(".tag").textContent,
    "Album source · last reported",
  );
  assert.equal(row("macbook-pro").querySelector(".tag").textContent, "Replica");
  assert.equal(row("casa").querySelector(".tag").textContent, "This machine");
});
