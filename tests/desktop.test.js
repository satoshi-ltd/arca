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
  fs.readFileSync(
    new URL("../apps/desktop/src/gallery-timeline-layout.js", import.meta.url),
    "utf8",
  ).replace(/export /g, "") +
  "\n" +
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
function nodeInit({ signal, ...options } = {}) {
  if (!signal) return options;
  const controller = new AbortController();
  if (signal.aborted) controller.abort();
  else signal.addEventListener("abort", () => controller.abort(), { once: true });
  return { ...options, signal: controller.signal };
}
async function until(check) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("UI did not reach expected state");
}

function trackInvoke(w, requests) {
  const invoke = w.__TAURI__.core.invoke;
  w.__TAURI__.core.invoke = (...args) => {
    const request = Promise.resolve(invoke(...args));
    requests.add(request);
    request.then(
      () => requests.delete(request),
      () => requests.delete(request),
    );
    return request;
  };
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
    assert.equal(
      w.document.querySelector('#content [data-action="sync"]'),
      null,
    );
    assert.equal(
      w.document.querySelector('#content [data-action="pause"]'),
      null,
    );
    assert.equal(
      w.document
        .querySelector('#sync-controls [data-action="pause"]')
        .getAttribute("aria-label"),
      "Pause sync",
    );
    assert.equal(
      w.document
        .querySelector('#sync-controls [data-action="sync"]')
        .getAttribute("data-tooltip"),
      "Sync now",
    );
    assert.match(
      w.document.querySelector("#last-sync").textContent,
      /Last sync|Not synced yet/,
    );
    assert.equal(
      w.document.querySelector("#backup-summary").textContent.trim(),
      "No backup reported",
    );
    const tooltipControl = w.document.querySelector(
      '#sync-controls [data-action="pause"]',
    );
    tooltipControl.focus();
    await until(() => w.document.querySelector('[role="tooltip"]'));
    assert.equal(
      w.document.querySelector('[role="tooltip"]').textContent,
      "Pause sync",
    );
    assert.equal(
      tooltipControl.getAttribute("aria-describedby"),
      "arca-tooltip",
    );
    tooltipControl.dispatchEvent(
      new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    assert.equal(w.document.querySelector('[role="tooltip"]'), null);
    assert.equal(tooltipControl.hasAttribute("aria-describedby"), false);

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
    assert.ok(finder.closest(".file-actions-menu"));
    assert.equal(
      finder.textContent.trim(),
      process.platform === "darwin" ? "Show in Finder" : "Show in folder",
    );
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
    if (process.platform === "darwin") {
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
    assert.equal(w.document.querySelector("#cancel-dialog").disabled, false);
    const escapeEvent = new w.Event("cancel", { cancelable: true });
    w.document.querySelector("#dialog").dispatchEvent(escapeEvent);
    assert.equal(escapeEvent.defaultPrevented, true);
    assert.equal(
      w.document.querySelector("#dialog").open,
      false,
      "Escape closes the dialog without cancelling the accepted operation",
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
    assert.equal(w.document.querySelector(".sync-actions-menu"), null);
    assert.equal(
      w.document
        .querySelector('#sync-controls [data-action="pause"]')
        .getAttribute("aria-label"),
      "Resume sync",
    );
    assert.equal(
      w.document.querySelector('#content [data-action="pause"]'),
      null,
    );

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
    request.then(
      () => requests.delete(request),
      () => requests.delete(request),
    );
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
    assert.ok(w.document.querySelector('[name="role"][value="replica"]').checked);
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
      ...nodeInit(options),
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
    w.document.querySelector("#backup-summary").textContent.trim(),
    "No backup reported",
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

test("selecting a folder shows the space it needs next to the free space", async () => {
  const dom = new JSDOM(
    '<div id="dialog"><div class="folder-selection"><div class="selection-path"><input name="path" value="/tmp/new"></div></div><button id="submit-dialog"></button></div>',
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
    `let activeRequests = 0, folderCacheEpoch = 0; const folderPageKey = route => route; const updateBrandActivity = () => {}; const icon = () => ""; const icons = () => {}; const escape = s => s; const bytes = n => n + " B"; const clearGalleryPages = () => {}; const rememberGalleryDeletion = () => {}; const folderPages = new Map(); const catalog = [{ id: "v1", files: 3, bytes: 1600 }]; const $ = s => document.querySelector(s); const invoke = async () => ({ path: "/tmp/new", exists: false, freeBytes: 5000 }); ${apiCode}\n${checkCode}\ncheckFolderPath('path', 'v1');`,
  );
  await until(() =>
    w.document.querySelector("#folder-path-status")?.textContent.includes("free"),
  );
  assert.equal(
    w.document.querySelector("#folder-path-status").textContent,
    "New folder · Needs 1600 B · 5000 B free",
  );
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

test("history revision numbers keep one line in a column wide enough for six digits", () => {
  const css = fs.readFileSync(
    new URL("../apps/desktop/src/style.css", import.meta.url),
    "utf8",
  );
  const dom = new JSDOM(
    `<style>${css}</style><div class="history-row"><span class="mono revision">rev 165764</span></div>`,
  );
  const row = dom.window.document.querySelector(".history-row");
  const style = dom.window.getComputedStyle(row.firstChild);
  assert.match(dom.window.getComputedStyle(row).gridTemplateColumns, / 110px 88px 56px auto$/);
  assert.equal(style.whiteSpace, "nowrap");
  assert.notEqual(style.textOverflow, "ellipsis");
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
            hubUnavailable: true,
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
  assert.match(w.document.querySelector("#connection").textContent, /Offline/);
  assert.doesNotMatch(
    w.document.querySelector(".folder-card").textContent,
    /Offline/,
  );
  assert.match(
    w.document.querySelector("#content").textContent,
    /Local documents/,
  );
  assert.equal(w.document.body.classList.contains("view-loading"), false);
});

test("hub-only actions are disabled with a reason while the hub is unavailable and never reach the hub", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-hub-only-ui-"));
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
  const routes = [];
  w.__TAURI__ = {
    core: {
      invoke: async (command, args) => {
        if (command === "bootstrap") return { setup: false };
        routes.push(args.route);
        if (args.route === "/v1/status")
          return {
            ...daemon.engine.status(),
            role: "replica",
            hubUnavailable: true,
            hubName: "Casa",
            hub: "http://127.0.0.1:49999",
          };
        if (args.route === "/v1/remote") return { offline: true, name: "Casa", volumes: [] };
        if (args.route === "/v1/machines") return { offline: true, machines: [] };
        return {};
      },
    },
  };
  w.eval(`(async()=>{${script}\n})()`);
  await until(() => w.document.querySelector(".folder-card"));
  const choose = w.document.querySelector('#content [data-action="add"]');
  assert.ok(choose, "Choose folders is present");
  assert.equal(choose.disabled, true);
  assert.match(choose.title, /Needs the hub/);
  const before = routes.length;
  const forced = w.document.createElement("button");
  forced.dataset.action = "review-conflict";
  forced.dataset.id = JSON.stringify({ volume: "x", path: "a.conflict-1.txt" });
  w.document.body.append(forced);
  forced.click();
  await until(() => /This needs Casa\. Try again when it is reachable\./.test(w.document.body.textContent));
  assert.doesNotMatch(w.document.body.textContent, /saved locally/);
  assert.deepEqual(routes.slice(before).filter((route) => route !== "/v1/status"), [], "a guarded action sends nothing to the hub");
  for (const name of ["restore", "disconnect-hub", "select"]) {
    const count = routes.length;
    const control = w.document.createElement("button");
    control.dataset.action = name;
    control.dataset.id = "x";
    w.document.body.append(control);
    control.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(routes.slice(count).filter((route) => route !== "/v1/status"), [], `${name} is blocked offline`);
  }
});

test("a replica's folder header offers Open in Finder alone: no Enable gallery and no folder actions menu", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-replica-folder-header-"));
  init(home, { port: 0, name: "Local Mac" });
  const daemon = await start(home, { timer: false });
  const volume = daemon.engine.store.addVolume("Docs");
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://tauri.localhost" });
  const requests = new Set();
  t.after(async () => {
    await drainRequests(requests);
    dom.window.close();
    await daemon.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const w = dom.window;
  w.setInterval = () => 0;
  w.__TAURI__ = {
    core: {
      invoke: async (command, args) => {
        if (command === "bootstrap") return { setup: false };
        if (args.route === "/v1/status")
          return { ...daemon.engine.status(), platform: "darwin", role: "replica", hubUnavailable: false, hubName: "Casa", hub: "http://127.0.0.1:49999" };
        if (args.route === "/v1/remote") return { name: "Casa", volumes: [{ ...volume, selected: 1, gallery: false }] };
        if (args.route === "/v1/machines") return { machines: [] };
        if (args.route.startsWith("/v1/browse")) return { entries: [], next: null };
        if (args.route.startsWith("/v1/activity") || args.route.startsWith("/v1/history")) return { versions: [], next: null };
        return {};
      },
    },
  };
  trackInvoke(w, requests);
  w.eval(`(async()=>{${script}\n})()`);
  await until(() => w.document.querySelector('.folder-card[data-action="folder-detail"]'));
  w.document.querySelector('.folder-card[data-action="folder-detail"]').click();
  await until(() => w.document.querySelector(".detail-head .heading-actions") && w.document.body.getAttribute("aria-busy") === "false");
  const actions = w.document.querySelector(".detail-head .heading-actions");
  assert.deepEqual([...actions.querySelectorAll("[data-action]")].map((el) => el.dataset.action), ["open"]);
  assert.match(actions.textContent, /Open in Finder/);
  assert.equal(actions.querySelector("details"), null, "only the hub decides that a folder is a gallery");
  assert.equal(w.document.querySelector('[data-action="enable-gallery"]'), null);
  assert.equal(w.document.querySelector("#folder-retention"), null, "a replica never edits retention");
  assert.equal(w.document.querySelector(".folder-history-status strong").textContent, "On · 30 days");
  assert.deepEqual(
    [...w.document.querySelectorAll(".detail-side .section-label")].map((label) => label.textContent),
    ["Local destination", "Copies"],
    "a replica's side column has no Version history panel",
  );
});

test("an empty Folders shows its one action in the header and the empty state only explains", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-folders-empty-"));
  init(home, { port: 0, name: "Local Mac" });
  const daemon = await start(home, { timer: false });
  const available = { ...daemon.engine.store.addVolume("Docs"), selected: 0, gallery: false };
  const requests = new Set();
  const windows = [];
  t.after(async () => {
    await drainRequests(requests);
    for (const window of windows) window.close();
    await daemon.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const open = async (state, remote) => {
    const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://tauri.localhost" });
    windows.push(dom.window);
    const w = dom.window;
    w.setInterval = () => 0;
    w.__TAURI__ = {
      core: {
        invoke: async (command, args) => {
          if (command === "bootstrap") return { setup: false };
          if (args.route === "/v1/status") return { ...daemon.engine.status(), platform: "darwin", volumes: [], hubUnavailable: false, ...state };
          if (args.route === "/v1/remote") return { name: "Casa", volumes: remote };
          if (args.route === "/v1/machines") return { machines: [] };
          return {};
        },
      },
    };
    trackInvoke(w, requests);
    w.eval(`(async()=>{${script}\n})()`);
    await until(() => w.document.querySelector(".page .empty"));
    return w.document;
  };
  const header = (document) => [...document.querySelectorAll("#content > .heading .heading-actions [data-action]")].map((el) => el.dataset.action);

  const replica = { role: "replica", hub: "http://127.0.0.1:49999", hubName: "Casa" };
  const withRows = await open(replica, [available]);
  await until(() => withRows.querySelector(".folder-card.unselected") && /or start syncing one below/.test(withRows.querySelector(".empty").textContent));
  assert.deepEqual(header(withRows), ["add"], "Choose folders once, in the header");
  assert.equal(withRows.querySelector(".empty button"), null, "the empty state has no button of its own");
  assert.match(withRows.querySelector(".empty").textContent, /Pick folders from your hub, or start syncing one below\. Full copies/);
  assert.ok(withRows.querySelector('.folder-card.unselected [data-action="add"]'), "the available row keeps its Select");

  const bare = await open(replica, []);
  await until(() => !bare.querySelector(".scaffold-row"));
  assert.deepEqual(header(bare), ["add"]);
  assert.equal(bare.querySelector(".empty button"), null);
  assert.match(bare.querySelector(".empty").textContent, /Pick folders from your hub\. Full copies/);
  assert.doesNotMatch(bare.querySelector(".empty").textContent, /select one below/);

  const hub = await open({ role: "hub", hub: "", hubName: "" }, []);
  assert.deepEqual(header(hub), ["share"], "Create shared folder once, in the header");
  assert.equal(hub.querySelector(".empty button"), null);
  assert.match(hub.querySelector(".empty").textContent, /No shared folders yet/);

  const offline = await open({ role: "replica", hub: "", hubName: "" }, []);
  assert.deepEqual(header(offline), ["connect"], "Connect to hub… once, in the header");
  assert.equal(offline.querySelector(".page .empty button"), null);
});

test("the file detail reveals with the platform's own word while the folder header keeps opening the folder", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-reveal-words-"));
  init(home, { port: 0, name: "Test hub" });
  const daemon = await start(home, { timer: false });
  const volume = daemon.engine.store.addVolume("Documents");
  fs.writeFileSync(path.join(volume.path, "brief.md"), "text");
  await daemon.engine.cycle();
  const requests = new Set();
  const windows = [];
  t.after(async () => {
    await drainRequests(requests);
    for (const window of windows) window.close();
    await daemon.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const open = async (platform) => {
    const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://tauri.localhost" });
    windows.push(dom.window);
    const w = dom.window;
    w.setInterval = () => 0;
    const native = [];
    w.__TAURI__ = {
      core: {
        invoke: async (command, args) => {
          if (command === "bootstrap") return { setup: false, status: { ...daemon.engine.status(), platform } };
          if (command === "open_file" || command === "open_folder") {
            native.push([command, { ...args }]);
            return;
          }
          if (command !== "api") throw new Error("Unexpected native command");
          const response = await fetch(`http://127.0.0.1:${daemon.port}${args.route}`, {
            method: args.method,
            headers: { Authorization: `Bearer ${daemon.engine.config.adminToken}`, "Content-Type": "application/json" },
            ...(args.method === "POST" ? { body: JSON.stringify(args.body) } : {}),
          });
          const value = await response.json();
          if (!response.ok) throw new Error(value.error);
          return args.route === "/v1/status" ? { ...value, platform } : value;
        },
      },
    };
    trackInvoke(w, requests);
    w.eval(`(async()=>{${script}\n})()`);
    await until(() => w.document.querySelector('.folder-card[data-action="folder-detail"]'));
    w.document.querySelector('.folder-card[data-action="folder-detail"]').click();
    await until(() => w.document.querySelector(".browser-file-row") && w.document.body.getAttribute("aria-busy") === "false");
    const folderOpen = w.document.querySelector('.heading-actions [data-action="open"]').textContent.trim();
    w.document.querySelector(".browser-file-row").click();
    await until(() => w.document.querySelector('[data-action="history-reveal-file"]') && w.document.body.getAttribute("aria-busy") === "false");
    return { w, native, folderOpen };
  };

  const mac = await open("darwin");
  const reveal = mac.w.document.querySelector('[data-action="history-reveal-file"]');
  assert.equal(reveal.textContent.trim(), "Show in Finder");
  assert.ok(reveal.closest(".file-actions-menu"), "the reveal action stays in the menu");
  assert.equal(mac.folderOpen, "Open in Finder", "the folder header still opens the folder");
  assert.equal(mac.w.document.querySelector('[data-action="history-open-file"]').textContent.trim(), "Open file");
  reveal.click();
  await until(() => mac.native.length === 1);
  assert.deepEqual(mac.native[0], ["open_file", { volume: volume.id, path: "brief.md", reveal: true }]);

  for (const platform of ["win32", "linux"]) {
    const other = await open(platform);
    const control = other.w.document.querySelector('[data-action="history-reveal-file"]');
    assert.equal(control.textContent.trim(), "Show in folder", platform);
    assert.ok(control.closest(".file-actions-menu"));
    assert.equal(other.folderOpen, "Open folder", `${platform}: the folder header keeps its word`);
    control.click();
    await until(() => other.native.length === 1);
    assert.deepEqual(other.native[0], ["open_folder", { id: volume.id }], `${platform}: no reveal exists, so it opens the shared folder`);
  }
});

test("Settings offers Clean up…, and the dialog shows the count before Apply cleanup removes anything", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-cleanup-words-"));
  init(home, { port: 0, name: "Test hub" });
  const daemon = await start(home, { timer: false });
  const volume = daemon.engine.store.addVolume("Documents");
  const file = path.join(volume.path, "note.txt");
  for (const text of ["one", "two", "three"]) {
    fs.writeFileSync(file, text);
    await daemon.engine.cycle();
  }
  const revisions = () => daemon.engine.store.db.prepare("SELECT COUNT(*) AS n FROM revisions").get().n;
  const before = revisions();
  assert.ok(before >= 3);
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://tauri.localhost" });
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
        if (command === "bootstrap") return { setup: false, status: daemon.engine.status() };
        if (command !== "api") throw new Error("Unexpected native command");
        const response = await fetch(`http://127.0.0.1:${daemon.port}${args.route}`, {
          method: args.method,
          headers: { Authorization: `Bearer ${daemon.engine.config.adminToken}`, "Content-Type": "application/json" },
          ...(args.method === "POST" ? { body: JSON.stringify(args.body) } : {}),
        });
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
  w.eval(`(async()=>{${script}\n})()`);
  await until(() => w.document.querySelector(".folder-card"));
  w.document.querySelector('[data-view="settings"]').click();
  await until(() => w.document.querySelector('[data-action="retention"]') && w.document.body.getAttribute("aria-busy") === "false");
  const control = w.document.querySelector('[data-action="retention"]');
  const section = control.closest("section");
  assert.equal(section.querySelector(".section-label").textContent, "History");
  assert.equal(control.textContent.trim(), "Clean up…");
  assert.equal(section.querySelector(".setting-row strong").textContent, "Older versions");
  assert.match(section.querySelector(".setting-row p").textContent, new RegExp(`^${before} kept across your folders\\. Each folder decides how long it keeps them\\.$`));
  assert.equal(
    section.querySelector("p.hint").textContent,
    "Cleanup shows what it would remove before anything is deleted. Current files, pending changes and history not yet backed up are never removed.",
  );
  assert.doesNotMatch(section.textContent, /Limits|Preview cleanup|Kept\b/);

  control.click();
  await until(() => w.document.querySelector("#dialog").open && w.document.querySelector("#dialog-days"));
  const dialog = w.document.querySelector("#dialog");
  assert.equal(dialog.querySelector("h2").textContent, "Clean up older versions");
  assert.equal(dialog.querySelector(".modal-title p").textContent, "Nothing is removed until you apply. See the count first.");
  assert.equal(dialog.querySelector('label[for="dialog-days"]').textContent, "Remove versions older than (days)");
  assert.equal(dialog.querySelector('label[for="dialog-versions"]').textContent, "But always keep the last (versions per file)");
  assert.equal(w.document.querySelector("#submit-dialog").textContent.trim(), "See the count");
  w.document.querySelector("#dialog-days").value = "0";
  w.document.querySelector("#dialog-versions").value = "1";
  const submit = () => w.document.querySelector("#dialog-form").dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
  submit();
  await until(() => w.document.querySelector("#retention-preview .retention-stats"));
  const labels = [...w.document.querySelectorAll("#retention-preview .retention-stats .hint")].map((el) => el.textContent);
  assert.deepEqual(labels, ["Would remove", "Keeps", "Protected"]);
  assert.equal(w.document.querySelector("#submit-dialog").textContent.trim(), "Apply cleanup");
  assert.ok(w.document.querySelector("#submit-dialog").classList.contains("danger"));
  assert.equal(revisions(), before, "counting removes nothing");

  fs.writeFileSync(file, "four");
  await daemon.engine.cycle();
  const changed = revisions();
  assert.equal(changed, before + 1);
  submit();
  await until(() => !w.document.querySelector("#dialog-error").hidden);
  assert.match(w.document.querySelector("#dialog-error").textContent, /History changed\. Count again before applying\./);
  assert.equal(w.document.querySelector("#submit-dialog").textContent.trim(), "See the count", "a refused apply goes back to counting");
  assert.equal(w.document.querySelector("#retention-preview").innerHTML, "");
  assert.equal(revisions(), changed, "a refused apply removes nothing");

  submit();
  await until(() => w.document.querySelector("#retention-preview .retention-stats"));
  assert.equal(w.document.querySelector("#submit-dialog").textContent.trim(), "Apply cleanup");
  submit();
  await until(() => revisions() < changed);
  assert.equal(revisions(), changed - 3, "only the superseded revisions go; the current file stays");
  await until(() => /Cleanup applied\./.test(w.document.querySelector("#notice").textContent));
});

test("offline labels: this machine reads Offline, saved machines say last known and nothing-saved screens say so", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-offline-labels-"));
  init(home, { port: 0, name: "Local Mac" });
  const daemon = await start(home, { timer: false });
  const volume = daemon.engine.store.addVolume("Docs");
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://tauri.localhost" });
  t.after(async () => {
    dom.window.close();
    await daemon.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const w = dom.window;
  w.setInterval = () => 0;
  const hubDown = true;
  let saved = true;
  w.__TAURI__ = {
    core: {
      invoke: async (command, args) => {
        if (command === "bootstrap") return { setup: false };
        if (args.route === "/v1/status")
          return {
            ...daemon.engine.status(),
            role: "replica",
            phase: hubDown ? "offline" : "syncing",
            hubUnavailable: hubDown,
            hubName: "Casa",
            hub: "http://127.0.0.1:49999",
          };
        if (args.route === "/v1/remote") return { offline: saved, name: "Casa", volumes: [{ ...volume, selected: 1 }] };
        if (args.route === "/v1/machines")
          return {
            offline: saved,
            machines: [
              { name: "phone-fold", role: "replica", platform: "android", machineId: "fold", lastAddress: "192.168.1.144", isHub: false },
            ],
          };
        if (args.route.startsWith("/v1/history")) {
          if (args.route.includes("local-only.txt"))
            return { offline: true, localOnly: true, versions: [{ rev: 7, size: 12, deleted: 0 }], next: null };
          if (args.route.includes("empty-saved.txt")) return { offline: true, versions: [], next: null };
          return { offline: true, localOnly: true, versions: [], next: null };
        }
        if (args.route.startsWith("/v1/activity")) return { offline: saved, versions: [], next: null };
        if (args.route.startsWith("/v1/browse")) return { entries: [], next: null };
        return {};
      },
    },
  };
  w.eval(`(async()=>{${script}\n})()`);
  await until(() => w.document.querySelector(".folder-card"));
  const body = () => w.document.body.textContent;
  const machines = async () => {
    w.document.querySelector('[data-view="devices"]').click();
    await until(() => w.document.querySelectorAll(".device-row").length >= 3);
    const rows = [...w.document.querySelectorAll(".device-row")];
    return {
      own: rows.find((row) => row.querySelector(".tag.self")),
      other: rows.find((row) => /phone-fold/.test(row.textContent)),
    };
  };
  const { own, other } = await machines();
  assert.equal(own.querySelector(".pill").textContent.trim(), "Offline");
  assert.ok(own.querySelector(".pill.wa"), "a warning pill, never Syncing or a green state");
  assert.equal(other.querySelector(".pill").textContent.trim(), "Offline");
  assert.match(other.querySelector(".connection-line").textContent, / · last known$/);
  assert.match(w.document.querySelector("#content").textContent, /Offline · showing saved device information · last known/);
  const openFile = async (file, expected, gone = /^$/) => {
    const forced = w.document.createElement("button");
    forced.dataset.action = "activity-file";
    forced.dataset.id = JSON.stringify({ volume: volume.id, path: file });
    w.document.body.append(forced);
    forced.click();
    await until(() => body().includes(file) && expected.test(body()) && !gone.test(body()));
    forced.remove();
  };
  await openFile("nothing-saved.txt", /No saved versions for this file/);
  assert.match(body(), /Offline\. Connect to the hub to load its history\./);
  assert.doesNotMatch(body(), /Your local file is still available|No retained versions/, "no local row, so it does not promise one");
  await openFile("local-only.txt", /Your local file is still available/);
  assert.match(body(), /No saved versions for this file/);
  assert.match(body(), /Local copy/);
  await openFile("empty-saved.txt", /No saved versions for this file/, /Local copy|Your local file is still available/);
  assert.doesNotMatch(body(), /Your local file is still available|No retained versions/);
  const recent = () => w.document.querySelector("#content").textContent;
  const cell = () => w.document.querySelector("#content .folder-stats .stat:nth-child(3) strong")?.textContent;
  const openRecent = async () => {
    w.document.querySelector('[data-view="folders"]').click();
    await until(() => w.document.querySelector('[data-action="folder-detail"]'));
    w.document.querySelector('[data-action="folder-detail"]').click();
    await until(() => w.document.querySelector('[data-action="folder-tab"][data-id="recent"]'));
    w.document.querySelector('[data-action="folder-tab"][data-id="recent"]').click();
  };
  await openRecent();
  await until(() => /Offline\. Connect to the hub to load its history\./.test(recent()));
  assert.match(recent(), /No saved versions/);
  assert.equal(cell(), "No saved versions");
  assert.doesNotMatch(recent(), /No versions yet/);
  const refresh = w.document.createElement("button");
  refresh.dataset.action = "refresh";
  w.document.body.append(refresh);
  saved = false;
  refresh.click();
  await until(() => /No versions yet/.test(recent()));
  assert.equal(cell(), "Not yet", "a live empty answer is not 'saved'");
  assert.doesNotMatch(recent(), /Connect to the hub to load its history/);
  saved = true;
  refresh.click();
  await until(() => /Offline\. Connect to the hub to load its history\./.test(recent()));
  assert.equal(cell(), "No saved versions", "equal empty pages still repaint when only the saved flag changes");
  await until(() => w.document.body.getAttribute("aria-busy") !== "true");
  await new Promise((resolve) => setTimeout(resolve, 50));
});

test("a paused replica stays Paused and a live list while the hub is unavailable stays Linked", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-paused-labels-"));
  init(home, { port: 0, name: "Local Mac" });
  const daemon = await start(home, { timer: false });
  daemon.engine.store.addVolume("Docs");
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://tauri.localhost" });
  t.after(async () => {
    dom.window.close();
    await daemon.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const w = dom.window;
  w.setInterval = () => 0;
  let phase = "paused";
  w.__TAURI__ = {
    core: {
      invoke: async (command, args) => {
        if (command === "bootstrap") return { setup: false };
        if (args.route === "/v1/status")
          return { ...daemon.engine.status(), role: "replica", phase, hubUnavailable: true, hubName: "Casa", hub: "http://127.0.0.1:49999" };
        if (args.route === "/v1/remote") return { name: "Casa", volumes: [] };
        if (args.route === "/v1/machines")
          return { machines: [{ name: "phone-fold", role: "replica", platform: "android", machineId: "fold", lastAddress: "192.168.1.144", isHub: false }] };
        return {};
      },
    },
  };
  w.eval(`(async()=>{${script}\n})()`);
  await until(() => w.document.querySelector(".folder-card"));
  w.document.querySelector('[data-view="devices"]').click();
  await until(() => w.document.querySelectorAll(".device-row").length >= 3);
  const rows = [...w.document.querySelectorAll(".device-row")];
  assert.equal(rows.find((row) => row.querySelector(".tag.self")).querySelector(".pill").textContent.trim(), "Paused", "pausing is a choice that outranks Offline");
  const other = rows.find((row) => /phone-fold/.test(row.textContent));
  assert.equal(other.querySelector(".pill").textContent.trim(), "Linked", "a live list is never marked Offline just because the hub is");
  assert.doesNotMatch(other.querySelector(".connection-line").textContent, /last known/);
});

test("online, the machines list keeps real states and never says last known", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-online-labels-"));
  init(home, { port: 0, name: "Local Mac" });
  const daemon = await start(home, { timer: false });
  daemon.engine.store.addVolume("Docs");
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://tauri.localhost" });
  t.after(async () => {
    dom.window.close();
    await daemon.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const w = dom.window;
  w.setInterval = () => 0;
  w.__TAURI__ = {
    core: {
      invoke: async (command, args) => {
        if (command === "bootstrap") return { setup: false };
        if (args.route === "/v1/status")
          return { ...daemon.engine.status(), role: "replica", phase: "syncing", hubUnavailable: false, hubName: "Casa", hub: "http://127.0.0.1:49999" };
        if (args.route === "/v1/remote") return { name: "Casa", volumes: [] };
        if (args.route === "/v1/machines")
          return { machines: [{ name: "phone-fold", role: "replica", platform: "android", machineId: "fold", lastAddress: "192.168.1.144", isHub: false }] };
        return {};
      },
    },
  };
  w.eval(`(async()=>{${script}\n})()`);
  await until(() => w.document.querySelector(".folder-card"));
  w.document.querySelector('[data-view="devices"]').click();
  await until(() => w.document.querySelectorAll(".device-row").length >= 3);
  const rows = [...w.document.querySelectorAll(".device-row")];
  assert.equal(rows.find((row) => row.querySelector(".tag.self")).querySelector(".pill").textContent.trim(), "Syncing");
  const other = rows.find((row) => /phone-fold/.test(row.textContent));
  assert.equal(other.querySelector(".pill").textContent.trim(), "Linked");
  assert.doesNotMatch(w.document.querySelector("#content").textContent, /last known|showing saved machine information/);
});

test("hub-only controls follow the hub's availability and a status-less 'Hub unavailable' failure reads as hub-only", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-hub-flip-ui-"));
  init(home, { port: 0, name: "Local Mac" });
  const daemon = await start(home, { timer: false });
  daemon.engine.store.addVolume("Local documents");
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://tauri.localhost" });
  t.after(async () => {
    dom.window.close();
    await daemon.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const w = dom.window;
  w.setInterval = () => 0;
  let offline = true;
  let failStatus = false;
  w.__TAURI__ = {
    core: {
      invoke: async (command, args) => {
        if (command === "bootstrap") return { setup: false };
        if (args.route === "/v1/status") {
          if (failStatus) throw "Hub unavailable. Try again when it is reachable.";
          return {
            ...daemon.engine.status(),
            role: "replica",
            hubUnavailable: offline,
            hubName: "Casa",
            hub: "http://127.0.0.1:49999",
          };
        }
        if (args.route === "/v1/remote") return { offline, name: "Casa", volumes: [] };
        return {};
      },
    },
  };
  w.eval(`(async()=>{${script}\n})()`);
  await until(() => w.document.querySelector(".folder-card"));
  const extra = ["restore", "review-conflict", "disconnect-hub"].map((name) => {
    const control = w.document.createElement("button");
    control.dataset.action = name;
    w.document.body.append(control);
    return control;
  });
  const gallery = w.document.createElement("button");
  gallery.className = "photo-selection-delete";
  w.document.body.append(gallery);
  offline = false;
  w.document.querySelector('[data-action="refresh"], [data-view="folders"]').click();
  await until(() => extra.every((control) => !control.disabled) && !gallery.disabled);
  offline = true;
  w.document.querySelector('[data-view="folders"]').click();
  await until(() => extra.every((control) => control.disabled) && gallery.disabled);
  assert.ok(extra.every((control) => /Needs the hub/.test(control.title)));
  failStatus = true;
  const retry = w.document.createElement("button");
  retry.dataset.action = "refresh";
  w.document.body.append(retry);
  retry.click();
  await until(() => /This needs Casa\. Try again when it is reachable\./.test(w.document.body.textContent));
  assert.doesNotMatch(w.document.body.textContent, /saved locally/);
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
  const v = await daemon.engine.publish("Original");
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
  await request("/v1/unselect", { id: v.id });
  const catalog = await open(`#/folders/${v.id}`);
  await until(() =>
    catalog.document.querySelector('[data-action="edit-ignore"]'),
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
  w.setInterval = (callback, ms) => {
    if (ms === 5000) poll = callback;
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
  assert.match(q("#dialog-title").textContent, /Stop syncing.*Unlink example/);
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
  const keep = q('#dialog [name="deleteFiles"]');
  keep.checked = false;
  keep.dispatchEvent(new w.Event("change"));
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

test("a replica shows full-backup progress, waits quietly for the hub and never counts unknown folders as empty", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arca-backup-progress-ui-"));
  const nodes = [];
  const node = async (name, role) => {
    const home = path.join(root, name);
    init(home, { name, role, port: 0 });
    const daemon = await start(home, { timer: false });
    nodes.push(daemon);
    daemon.api = async (route, body) => {
      const r = await fetch(`http://127.0.0.1:${daemon.port}${route}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { Authorization: `Bearer ${daemon.engine.config.adminToken}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error);
      return data;
    };
    return daemon;
  };
  const hub = await node("Hub", "hub"),
    mac = await node("Mac", "replica");
  await hub.api("/v1/volumes", { name: "photos" });
  const invite = await hub.api("/v1/devices", { name: "Mac", role: "replica" });
  await mac.api("/v1/connect", { url: `http://127.0.0.1:${hub.port}`, token: invite.token });
  let backup = { enabled: true, path: "/data/backup", error: null, waiting: false, progress: { revisions: 1203 } };
  const status = mac.engine.status.bind(mac.engine);
  mac.engine.status = (...args) => ({ ...status(...args), backup });
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://tauri.localhost/#/settings" });
  const w = dom.window;
  let poll;
  w.setInterval = (callback, ms) => {
    if (ms === 5000) poll = callback;
    return 0;
  };
  const requests = new Set();
  w.__TAURI__ = {
    core: {
      invoke: (command, args) => {
        if (command === "bootstrap") return Promise.resolve({ setup: false, status: mac.engine.status() });
        const request = mac.api(args.route, args.method === "POST" ? args.body : undefined);
        requests.add(request);
        request.then(() => requests.delete(request), () => requests.delete(request));
        return request;
      },
    },
  };
  t.after(async () => {
    await drainRequests(requests);
    w.close();
    for (const daemon of nodes.reverse()) await daemon.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await w.eval(`(async()=>{${script}\n})()`);
  const q = (selector) => w.document.querySelector(selector);
  await until(() => q("#backup-completion"));
  assert.equal(q("#backup-summary").textContent.trim(), "Backing up…");
  assert.match(q("#backup-completion").textContent, /Copying history · 1,203 versions/);
  assert.match(q("#backup-completion").textContent, /Running/);
  backup = { ...backup, progress: null, waiting: true };
  await poll();
  await until(() => /waiting for hub/.test(q("#backup-summary").textContent));
  assert.doesNotMatch(q("#backup-completion").textContent, /Needs attention/);
  assert.match(q("#backup-completion").textContent, /Offline/);
  w.location.hash = "#/folders";
  w.dispatchEvent(new w.HashChangeEvent("hashchange"));
  await until(() => /photos/.test(q("#content").textContent) && /Not counted yet|files/.test(q("#content").textContent));
  assert.doesNotMatch(q("#content").textContent, /0 files · 0 B/);
});

test("folder progress shows files and bytes for the current phase", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arca-progress-label-ui-"));
  const nodes = [];
  const node = async (name, role) => {
    const home = path.join(root, name);
    init(home, { name, role, port: 0 });
    const daemon = await start(home, { timer: false });
    nodes.push(daemon);
    daemon.api = async (route, body) => {
      const r = await fetch(`http://127.0.0.1:${daemon.port}${route}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { Authorization: `Bearer ${daemon.engine.config.adminToken}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error);
      return data;
    };
    return daemon;
  };
  const hub = await node("Hub", "hub"),
    mac = await node("Mac", "replica");
  const volume = await hub.api("/v1/volumes", { name: "photos" });
  const invite = await hub.api("/v1/devices", { name: "Mac", role: "replica" });
  await mac.api("/v1/connect", { url: `http://127.0.0.1:${hub.port}`, token: invite.token });
  await mac.api("/v1/select", { id: volume.id });
  const GB = 1024 ** 3;
  let progress = { volume: volume.id, stage: "upload", direction: "upload", path: "IMG_0042.jpg", filesDone: 402, filesTotal: 1269, sizeDone: 4 * GB, sizeTotal: 14 * GB, bytesDone: 1024, bytesTotal: 2048 };
  const status = mac.engine.status.bind(mac.engine);
  mac.engine.status = (...args) => ({ ...status(...args), phase: "syncing", progress });
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://tauri.localhost/#/folders" });
  const w = dom.window;
  let poll;
  w.setInterval = (callback, ms) => {
    if (ms === 5000) poll = callback;
    return 0;
  };
  const requests = new Set();
  w.__TAURI__ = {
    core: {
      invoke: (command, args) => {
        if (command === "bootstrap") return Promise.resolve({ setup: false, status: mac.engine.status() });
        const request = mac.api(args.route, args.method === "POST" ? args.body : undefined);
        requests.add(request);
        request.then(() => requests.delete(request), () => requests.delete(request));
        return request;
      },
    },
  };
  t.after(async () => {
    await drainRequests(requests);
    w.close();
    for (const daemon of nodes.reverse()) await daemon.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await w.eval(`(async()=>{${script}\n})()`);
  const q = (selector) => w.document.querySelector(selector);
  await until(() => q(".folder-card progress"));
  assert.equal(q(".folder-card .meta").textContent, "402 / 1,269 files sent · 4.0 GB / 14.0 GB · IMG_0042.jpg");
  assert.equal(q(".folder-card progress").getAttribute("aria-label"), "Files sent");
  progress = { volume: volume.id, stage: "receive", direction: "download", path: "IMG_0100.jpg", filesDone: 3, filesTotal: null, sizeDone: 0, sizeTotal: 0, bytesDone: 1024, bytesTotal: 2048 };
  await poll();
  await until(() => /checked/.test(q(".folder-card .meta").textContent));
  assert.equal(q(".folder-card .meta").textContent, "3 files checked · IMG_0100.jpg · 1.0 KB / 2.0 KB");
  assert.equal(q(".folder-card progress").getAttribute("aria-label"), "Files checked");
});

test("unlink can also delete the replica files the hub already has", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arca-unlink-delete-ui-"));
  const nodes = [];
  async function node(name, role) {
    const home = path.join(root, name);
    init(home, { name, role, port: 0 });
    const daemon = await start(home, { timer: false });
    nodes.push(daemon);
    daemon.api = async (route, body) => {
      const r = await fetch(`http://127.0.0.1:${daemon.port}${route}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { Authorization: `Bearer ${daemon.engine.config.adminToken}`, "Content-Type": "application/json" },
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
  const folder = await hub.api("/v1/volumes", { name: "Photos" });
  fs.writeFileSync(path.join(folder.path, "synced.jpg"), "on the hub");
  await hub.engine.cycle();
  const invite = await hub.api("/v1/devices", { name: "Mac", role: "replica" });
  await mac.api("/v1/connect", { url: `http://127.0.0.1:${hub.port}`, token: invite.token });
  const local = await mac.api("/v1/select", { id: folder.id });
  await mac.engine.cycle();
  fs.writeFileSync(path.join(local.path, "draft.jpg"), "only here");
  const dom = new JSDOM(html, { runScripts: "outside-only", url: `http://tauri.localhost/#/folders/${folder.id}` });
  const w = dom.window;
  w.setInterval = () => 0;
  w.HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  w.HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  const bodies = [];
  const requests = new Set();
  w.__TAURI__ = {
    core: {
      invoke: (command, args) => {
        if (command === "bootstrap") return Promise.resolve({ setup: false, status: mac.engine.status() });
        if (args.route === "/v1/unselect") bodies.push(args.body);
        const request = mac.api(args.route, args.method === "POST" ? args.body : undefined);
        requests.add(request);
        request.then(() => requests.delete(request), () => requests.delete(request));
        return request;
      },
    },
  };
  t.after(async () => {
    await drainRequests(requests);
    w.close();
    for (const daemon of nodes.reverse()) await daemon.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await w.eval(`(async()=>{${script}\n})()`);
  const q = (selector) => w.document.querySelector(selector);
  await until(() => q('[data-action="unselect"]'));
  q('[data-action="unselect"]').click();
  await until(() => q("#dialog").open);
  const option = q('#dialog [name="deleteFiles"]');
  assert.equal(option.checked, true, "unlinking deletes the verified synced copy by default");
  assert.equal(q("#submit-dialog").textContent, "Stop syncing and delete");
  option.checked = false;
  option.dispatchEvent(new w.Event("change"));
  assert.equal(q("#submit-dialog").textContent, "Stop syncing");
  assert.match(q('#dialog label[for="unlink-delete"]').textContent, /^Delete the files on this (Mac|device)$/);
  assert.ok(q("#dialog").classList.contains("confirmation-dialog"), "an option keeps the compact confirmation");
  assert.equal(q("#cancel-dialog").autofocus, true, "a destructive confirmation opens on Cancel");
  assert.match(q("#dialog").textContent, /The hub keeps the shared folder, its files and history/);
  option.checked = true;
  option.dispatchEvent(new w.Event("change"));
  assert.equal(q("#submit-dialog").textContent, "Stop syncing and delete");
  q("#dialog-form").dispatchEvent(new w.Event("submit", { cancelable: true }));
  await until(() => !q("#dialog").open && bodies.length);
  assert.deepEqual(JSON.parse(JSON.stringify(bodies)), [{ id: folder.id, deleteFiles: true }]);
  await until(() => /2 files .* deleted from this (Mac|device)/.test(w.document.body.textContent));
  assert.equal(fs.existsSync(path.join(local.path, "synced.jpg")), false);
  assert.equal(fs.existsSync(path.join(local.path, ".arcaignore")), false);
  assert.equal(fs.readFileSync(path.join(local.path, "draft.jpg"), "utf8"), "only here");
  assert.match(w.document.body.textContent, /file not on the hub stay on disk|files not on the hub stay on disk/);
  assert.equal(fs.readFileSync(path.join(folder.path, "synced.jpg"), "utf8"), "on the hub");
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
          ...nodeInit(options),
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
      if (surface === "web") {
        w.document.querySelector('[data-action="logout-all"]').click();
        await until(() => w.document.querySelector("#dialog").open);
        assert.ok(w.document.querySelector("#submit-dialog").classList.contains("danger"), "signing every browser out is destructive");
        w.document.querySelector("#cancel-dialog").click();
      }
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
        assert.equal(
          w.document.querySelectorAll("#image-settings .settings-card").length,
          1,
        );
        assert.ok(w.document.querySelector("#image-regenerate-job").hidden);
        assert.equal(
          w.document.querySelector("#image-settings").textContent.includes("Optimize space"),
          false,
        );
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
        "Devices",
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
  const v = await hub.engine.publish("Documents");
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
      ...nodeInit(options),
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
  w.setInterval = (fn, ms) => {
    if (ms === 5000) poll = fn;
    return 0;
  };
  w.fetch = (route, options = {}) =>
    fetch(`http://127.0.0.1:${daemon.port}${route}`, {
      ...nodeInit(options),
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
  assert.equal(
    w.document.querySelector("#backup-summary").textContent.trim(),
    "1 backup reported",
  );
  assert.equal(
    w.document.querySelector("#backup-summary").dataset.action,
    "machines",
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
    request.then(
      () => requests.delete(request),
      () => requests.delete(request),
    );
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
        script.indexOf("function rowPreview("),
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
  const v = await hub.engine.publish("Documents");
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
  await until(() => title() === "Devices");
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
  assert.equal(
    w.document.querySelector(".folder-history-status #folder-retention"),
    null,
    "the summary only reads, on the hub too",
  );
  assert.equal(
    w.document.querySelector(".heading-actions #folder-retention"),
    null,
  );
  assert.equal(
    w.document.querySelector(".folder-history-status strong").textContent,
    "On · 30 days",
  );
  assert.doesNotMatch(
    w.document.querySelector(".folder-history-status").textContent,
    /on hub/,
  );
  const retention = w.document.querySelector(".detail-side .panel #folder-retention");
  assert.ok(retention, "the hub's control lives in a Version history panel of the side column");
  assert.match(retention.closest("section").querySelector(".section-label").textContent, /^Version history$/);
  assert.equal(retention.closest(".panel").querySelector("h3").textContent, "Keep older versions for");
  assert.deepEqual(
    [...retention.querySelectorAll("button")].map((option) => option.textContent),
    ["Off", "1 day", "1 week", "30 days", "Forever"],
  );
  assert.equal(retention.querySelector(".segmented-compact"), null);
  assert.match(
    retention.closest(".panel").querySelector("p").textContent,
    /Older versions of every file in this folder stay restorable for 30 days after a change or deletion; after that, only the current files remain\./,
  );
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
    retention.compareDocumentPosition(w.document.querySelector("#folder-copies")) & w.Node.DOCUMENT_POSITION_PRECEDING,
    "the panel follows Copies",
  );
  assert.ok(
    retention.compareDocumentPosition(w.document.querySelector('[data-action="unselect"]')) & w.Node.DOCUMENT_POSITION_FOLLOWING,
    "and comes before the Hub working copy panel",
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
    /3 older versions/,
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
  const folderMenu = w.document.querySelector(".heading-actions details.folder-actions-menu");
  assert.equal(folderMenu.querySelector("summary").getAttribute("aria-label"), "Folder actions");
  assert.deepEqual(
    [...folderMenu.querySelectorAll(".menu-items [data-action]")].map((el) => el.dataset.action),
    ["enable-gallery", "rename-share", "edit-ignore"],
    "configuration actions live in the menu",
  );
  assert.deepEqual(
    [...w.document.querySelectorAll(".heading-actions > [data-action]")].map((el) => el.dataset.action),
    ["open"],
    "the header keeps the daily action alone",
  );
  folderMenu.open = true;
  folderMenu.querySelector('[data-action="rename-share"]').dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(folderMenu.open, false, "Escape closes the menu");
  assert.equal(w.document.activeElement, folderMenu.querySelector("summary"), "and returns focus to its summary");
  folderMenu.open = true;
  w.document.querySelector('[data-action="back-folders"]').focus();
  assert.equal(folderMenu.open, false, "focus leaving the menu closes it");
  folderMenu.open = true;
  w.document.querySelector('[data-action="enable-gallery"]').click();
  assert.equal(folderMenu.open, false, "the menu closes on selection");
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
    /View folder/,
  );
  assert.deepEqual(
    [...w.document.querySelectorAll(".heading-actions .folder-actions-menu [data-action]")].map((el) => el.dataset.action),
    ["rename-share", "edit-ignore"],
    "a gallery folder keeps Rename and .arcaignore… in the menu, without Enable gallery",
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
  w.document.querySelector(".page").scrollTop = 123;
  w.document.querySelector('[data-action="gallery-mode"]').click();
  await until(() => !w.document.querySelector("#photo-gallery"));
  w.document.querySelector('[data-action="gallery-mode"]').click();
  await until(() => w.document.querySelectorAll(".photo-select").length === 2);
  await until(() => w.document.querySelector(".page").scrollTop === 123);
  assert.ok(w.document.querySelector('[data-action="gallery-mode"]').classList.contains("primary"));
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
    "View folder",
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
  const current = {
    id: "request",
    reference: "042123",
    browser: "Safari on macOS",
    created: Date.now(),
    expires: Date.now() + 600000,
    agent: "Safari <script>",
    ip: "100.1.2.3",
  };
  const expired = {
    ...current,
    id: "expired",
    created: Date.now() - 660000,
    expires: Date.now() - 60000,
  };
  let requests = [current],
    offline = true;
  w.__TAURI__ = {
    core: {
      invoke: async (command, args) => {
        if (command === "bootstrap") return { setup: false };
        if (command !== "api") return {};
        if (args.route === "/v1/status") return daemon.engine.status();
        if (args.route === "/v1/web-approvals")
          return offline ? { requests, offline } : { requests };
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
  const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
  timers[0]();
  await settle();
  assert.equal(w.document.querySelector("#dialog").open, false);
  offline = false;
  requests = [expired];
  timers[0]();
  await settle();
  assert.equal(w.document.querySelector("#dialog").open, false);
  requests = [current];
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
          ...nodeInit(options),
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
      w.document.querySelector('[name="role"][value="' + role + '"]').checked =
        true;
      submit();
      await waitFor('[data-code="setup-access"]');
      assert.equal(mutations, 0);
      assert.equal(daemon.engine.config.needsSetup, true);
      const rail = () =>
        [...w.document.querySelectorAll(".onboarding .steps .step")].map((el) => el.textContent.trim().replace(/^\d+/, ""));
      assert.deepEqual(rail(), ["This device", role === "hub" ? "Connect · Not needed" : "Connect", "Folders"]);
      assert.equal(w.document.querySelector(".onboarding .step.current").textContent.trim().replace(/^\d+/, ""), "This device", "the access page sits under This device");
      w.document.querySelector("#setup-back").click();
      await waitFor('[name="name"]');
      assert.equal(w.document.querySelector('[name="name"]').value, "Chosen server");
      assert.ok(w.document.querySelector('[name="role"][value="' + role + '"]').checked, "Back from access keeps the name and role");
      submit();
      await waitFor('[data-code="setup-access"]');
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
  w.fetch = (route, options) => fetch(new URL(route, base), nodeInit(options));
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
  const v = await hub.engine.publish("Documents");
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
    /Other devices keep their local files/,
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
    /View folder/,
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
  await until(() => w.document.querySelector(".brand-mark.is-busy .busy-grid"));
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
      release &&
      w.document.querySelector(".folder-explorer") &&
      w.document.querySelector(".folder-stats .stat:nth-child(3) .scaffold-line"),
  );
  assert.equal(
    w.document.querySelectorAll(".detail-revisions .scaffold-row").length,
    0,
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

test("folder detail lists local files while the hub-backed Recent never answers", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-detail-first-"));
  init(home, { port: 0 });
  const daemon = await start(home, { timer: false });
  const volume = daemon.engine.store.addVolume("Photos");
  fs.writeFileSync(path.join(volume.path, "local.txt"), "on disk");
  await daemon.engine.cycle();
  const w = new JSDOM(html, {
    runScripts: "outside-only",
    url: "http://tauri.localhost",
  }).window;
  w.setInterval = () => 0;
  let release;
  const pending = new Set();
  w.__TAURI__ = {
    core: {
      invoke: async (command, args) => {
        if (command === "bootstrap")
          return { setup: false, status: daemon.engine.status() };
        if (command !== "api") throw new Error(command);
        const work = (async () => {
          if (args.route.startsWith("/v1/activity?volume="))
            await new Promise((resolve) => {
              release = resolve;
            });
          const response = await fetch(
            `http://127.0.0.1:${daemon.port}${args.route}`,
            {
              headers: {
                Authorization: `Bearer ${daemon.engine.config.adminToken}`,
              },
            },
          );
          if (!response.ok) throw new Error(`API ${response.status}`);
          return response.json();
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
    release?.();
    await drainRequests(pending);
    w.close();
    await daemon.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  await w.eval(`(async()=>{${script}\n})()`);
  w.document
    .querySelector(`[data-action="folder-detail"][data-id="${volume.id}"]`)
    .click();
  await until(() => w.document.querySelector(".browser-file-row"));
  assert.ok(release, "Recent is still waiting on the hub");
  assert.match(
    w.document.querySelector(".folder-explorer").textContent,
    /local.txt/,
  );
  assert.ok(
    w.document.querySelector(".folder-stats .stat:nth-child(3) .scaffold-line"),
  );
  release();
  await until(() =>
    /^rev \d+$/.test(
      w.document.querySelector(".folder-stats .stat:nth-child(3) strong")
        ?.textContent || "",
    ),
  );
});

test("a late Recent answer patches the open folder without rebuilding it, and a poll does not restart it", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-detail-patch-"));
  init(home, { port: 0 });
  const daemon = await start(home, { timer: false });
  const volume = daemon.engine.store.addVolume("Documents");
  for (let n = 0; n < 5; n++)
    fs.writeFileSync(path.join(volume.path, `file-${n}.txt`), `file ${n}`);
  await daemon.engine.cycle();
  const w = new JSDOM(html, {
    runScripts: "outside-only",
    url: "http://tauri.localhost",
  }).window;
  const polls = [];
  w.setInterval = (fn, ms) => {
    if (ms === 5000) polls.push(fn);
    return 0;
  };
  const releases = [];
  let activity = 0;
  const pending = new Set();
  w.__TAURI__ = {
    core: {
      invoke: async (command, args) => {
        if (command === "bootstrap")
          return { setup: false, status: daemon.engine.status() };
        if (command !== "api") throw new Error(command);
        const work = (async () => {
          if (args.route.startsWith("/v1/activity?volume=")) {
            activity++;
            await new Promise((resolve) => releases.push(resolve));
          }
          const response = await fetch(
            `http://127.0.0.1:${daemon.port}${args.route}`,
            {
              headers: {
                Authorization: `Bearer ${daemon.engine.config.adminToken}`,
              },
            },
          );
          if (!response.ok) throw new Error(`API ${response.status}`);
          return response.json();
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
    for (const release of releases) release();
    await drainRequests(pending);
    w.close();
    await daemon.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  await w.eval(`(async()=>{${script}\n})()`);
  w.document
    .querySelector(`[data-action="folder-detail"][data-id="${volume.id}"]`)
    .click();
  await until(
    () =>
      w.document.querySelector(".browser-file-row") &&
      w.document.body.getAttribute("aria-busy") === "false",
  );
  for (const poll of polls) await poll();
  assert.equal(
    activity,
    1,
    "a poll right after opening does not restart Recent",
  );
  w.document.querySelector('[data-action="folder-search-toggle"]').click();
  await until(() => w.document.querySelector("#folder-search-input"));
  const page = w.document.querySelector("#content .page");
  const input = w.document.querySelector("#folder-search-input");
  input.value = "file-3";
  for (const release of releases.splice(0)) release();
  await until(() =>
    /^rev \d+$/.test(
      w.document.querySelector(".folder-stats .stat:nth-child(3) strong")
        ?.textContent || "",
    ),
  );
  assert.equal(w.document.querySelector("#content .page"), page);
  assert.equal(w.document.querySelector("#folder-search-input"), input);
  assert.equal(input.value, "file-3");
});

test("a late Recent answer fills the open Recent tab in place", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-detail-recent-"));
  init(home, { port: 0 });
  const daemon = await start(home, { timer: false });
  const volume = daemon.engine.store.addVolume("Notes");
  for (let n = 0; n < 3; n++)
    fs.writeFileSync(path.join(volume.path, `note-${n}.txt`), `note ${n}`);
  await daemon.engine.cycle();
  const w = new JSDOM(html, {
    runScripts: "outside-only",
    url: "http://tauri.localhost",
  }).window;
  w.setInterval = () => 0;
  const releases = [];
  const pending = new Set();
  w.__TAURI__ = {
    core: {
      invoke: async (command, args) => {
        if (command === "bootstrap")
          return { setup: false, status: daemon.engine.status() };
        if (command !== "api") throw new Error(command);
        const work = (async () => {
          if (args.route.startsWith("/v1/activity?volume="))
            await new Promise((resolve) => releases.push(resolve));
          const response = await fetch(
            `http://127.0.0.1:${daemon.port}${args.route}`,
            {
              headers: {
                Authorization: `Bearer ${daemon.engine.config.adminToken}`,
              },
            },
          );
          if (!response.ok) throw new Error(`API ${response.status}`);
          return response.json();
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
    for (const release of releases) release();
    await drainRequests(pending);
    w.close();
    await daemon.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  await w.eval(`(async()=>{${script}\n})()`);
  w.document
    .querySelector(`[data-action="folder-detail"][data-id="${volume.id}"]`)
    .click();
  await until(() => w.document.querySelector(".browser-file-row"));
  w.document
    .querySelector('[data-action="folder-tab"][data-id="recent"]')
    .click();
  await until(() =>
    w.document.querySelector(".detail-revisions .scaffold-row"),
  );
  const page = w.document.querySelector("#content .page");
  const tabs = w.document.querySelector(
    ".detail-revisions .folder-browser-tools",
  );
  for (const release of releases.splice(0)) release();
  await until(
    () =>
      w.document.querySelectorAll(
        ".detail-revisions .history-row, .detail-revisions [data-action='activity-file']",
      ).length >= 3,
  );
  assert.equal(w.document.querySelector("#content .page"), page);
  assert.equal(
    w.document.querySelector(".detail-revisions .folder-browser-tools"),
    tabs,
  );
  assert.equal(
    w.document.querySelectorAll(".detail-revisions .scaffold-row").length,
    0,
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
    "Album source",
  );
  assert.equal(row("macbook-pro").querySelector(".tag"), null, "an ordinary device carries no role label");
  assert.equal(row("casa").querySelector(".tag").textContent, "This device");
});

test("the status card shows the last sync only when the machine is not up to date", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-last-sync-"));
  init(home, { port: 0 });
  const daemon = await start(home, { timer: false });
  daemon.engine.store.addVolume("Documents");
  t.after(async () => {
    await daemon.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const card = async (phase) => {
    const dom = new JSDOM(html, {
      runScripts: "outside-only",
      url: "http://tauri.localhost",
    });
    const w = dom.window;
    const pending = new Set();
    w.setInterval = () => 0;
    const status = () => ({
      ...daemon.engine.status(),
      phase,
      lastSync: new Date().toISOString(),
    });
    w.__TAURI__ = {
      core: {
        invoke: async (command, args) => {
          if (command === "bootstrap") return { setup: false, status: status() };
          if (command === "check_update")
            return { available: false, version: null, notes: null };
          if (args?.route === "/v1/status") return status();
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
    try {
      await w.eval(`(async()=>{${script}\n})()`);
      await until(() => !pending.size);
      const line = w.document.querySelector("#last-sync");
      return {
        state: w.document.querySelector("#connection").textContent,
        hidden: line.hidden,
        text: line.textContent,
      };
    } finally {
      await drainRequests(pending);
      w.close();
    }
  };
  const current = await card("idle");
  assert.equal(current.state, "Up to date");
  assert.equal(current.hidden, true);
  const paused = await card("paused");
  assert.equal(paused.state, "Paused");
  assert.equal(paused.hidden, false);
  assert.match(paused.text, /^Last sync /);
});
test("a daemon that failed to restart after an update explains why on the stopped page", async () => {
  const dom = new JSDOM(html, {
    runScripts: "outside-only",
    url: "http://tauri.localhost",
  });
  const w = dom.window;
  w.setInterval = () => 0;
  w.__TAURI__ = {
    core: {
      invoke: async (command) => {
        if (command === "bootstrap")
          return {
            setup: false,
            stopped: true,
            error: "The local daemon did not start <after> the update.",
          };
        if (command === "check_update")
          return { available: false, version: null, notes: null };
        throw new Error(command);
      },
    },
  };
  try {
    await w.eval(`(async()=>{${script}\n})()`);
    const content = w.document.querySelector("#content");
    await until(() => /Daemon stopped/.test(content.textContent));
    assert.match(
      content.textContent,
      /The local daemon did not start <after> the update\./,
    );
    assert.equal(content.querySelector("after"), null);
    assert.ok(content.querySelector('[data-action="start"]'));
  } finally {
    w.close();
  }
});
test("the sidebar offers a signed update only when one exists and installs it on request", async () => {
  const dom = new JSDOM(html, {
    runScripts: "outside-only",
    url: "http://tauri.localhost",
  });
  const w = dom.window;
  w.setInterval = () => 0;
  let update = { available: false, version: null, notes: null };
  const installs = [];
  let installError = null;
  w.__TAURI__ = {
    core: {
      invoke: async (command) => {
        if (command === "bootstrap") return { setup: true, root: "/tmp/Arca" };
        if (command === "check_update") return update;
        if (command === "install_update") {
          installs.push(update.version);
          if (installError) throw installError;
          return;
        }
        if (command === "setup_info")
          return { root: "/tmp/Arca", freeBytes: 1 };
        throw new Error(command);
      },
    },
  };
  const requests = new Set();
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
  try {
    await w.eval(`(async()=>{${script}\n})()`);
    const card = w.document.querySelector("#update-card");
    const button = w.document.querySelector("#update-install");
    await until(() => !requests.size);
    assert.equal(card.hidden, true, "no card without an update");
    update = { available: true, version: "9.9.9", notes: null };
    w.dispatchEvent(new w.Event("online"));
    await until(() => !card.hidden);
    assert.match(card.textContent, /Arca 9\.9\.9 is available/);
    assert.match(
      w.document.querySelector("#update-heading").textContent,
      /Arca 9\.9\.9 is available/,
    );
    installError = new Error("Update signature check failed");
    button.click();
    await until(() => installs.length === 1 && !button.disabled);
    assert.match(
      button.textContent,
      /Update and restart/,
      "a failed install stays retryable",
    );
    installError = null;
    button.click();
    await until(() => installs.length === 2);
    assert.deepEqual(installs, ["9.9.9", "9.9.9"]);
    assert.equal(button.disabled, true);
    assert.match(button.textContent, /Installing/);
  } finally {
    await drainRequests(requests);
    w.close();
  }
});
test("web admin reads time out into the connection notice while a stalled submission stays closable and releases the queue", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-web-timeout-"));
  init(home, { port: 0, name: "Casa" });
  const daemon = await start(home, { timer: false });
  const v = await daemon.engine.publish("Original");
  const base = `http://127.0.0.1:${daemon.port}`;
  const dom = new JSDOM(html, {
    runScripts: "outside-only",
    url: `${base}/#/folders/${v.id}`,
  });
  const w = dom.window;
  const pending = new Set();
  t.after(async () => {
    await drainRequests(pending);
    w.close();
    await daemon.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  let poll;
  w.setInterval = (fn, ms) => {
    if (ms === 5000) poll = fn;
    return 0;
  };
  const timeout = w.setTimeout.bind(w),
    clear = w.clearTimeout.bind(w),
    deadlines = new Map();
  let deadline = 0;
  w.setTimeout = (fn, ms, ...args) => {
    if (ms < 15000) return timeout(fn, ms, ...args);
    deadlines.set(`deadline-${++deadline}`, { fn, ms });
    return `deadline-${deadline}`;
  };
  w.clearTimeout = (id) => (deadlines.delete(id) ? undefined : clear(id));
  const expire = (ms) => {
    const due = [...deadlines].filter(([, entry]) => entry.ms === ms);
    assert.ok(due.length, `a ${ms} ms deadline is pending`);
    for (const [id, entry] of due) {
      deadlines.delete(id);
      entry.fn();
    }
  };
  w.HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  w.HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  const stalled = new Set(),
    sent = [];
  w.fetch = (route, options = {}) => {
    sent.push(`${options.method} ${route.split("?")[0]}`);
    if (stalled.has(route.split("?")[0]))
      return new Promise((_, reject) =>
        options.signal.addEventListener(
          "abort",
          () => reject(new w.DOMException("Aborted", "AbortError")),
          { once: true },
        ),
      );
    const work = fetch(new URL(route, base), {
      ...nodeInit(options),
      headers: {
        ...options.headers,
        Authorization: `Bearer ${daemon.engine.config.adminToken}`,
      },
    });
    pending.add(work);
    void work.finally(() => pending.delete(work));
    return work;
  };
  const q = (selector) => w.document.querySelector(selector);
  const idle = () => w.document.body.getAttribute("aria-busy") === "false";
  await w.eval(`(async()=>{${script}\n})()`);
  await until(() => q(".detail-title h1")?.textContent === "Original" && idle());
  await until(() => !deadlines.size);
  q('[data-action="rename-share"]').click();
  await until(() => q('#dialog [name="name"]') && idle());
  q('#dialog [name="name"]').value = "Renamed";
  stalled.add("/v1/rename-share");
  q("#dialog-form").dispatchEvent(new w.Event("submit", { cancelable: true }));
  await until(() => sent.includes("POST /v1/rename-share"));
  assert.equal(q("#submit-dialog").getAttribute("aria-busy"), "true");
  assert.equal(q("#cancel-dialog").disabled, false);

  stalled.add("/v1/status");
  const polled = poll();
  await until(() => sent.filter((r) => r === "GET /v1/status").length > 1);
  expire(20000);
  await polled;
  assert.match(q("#notice").textContent, /Cannot reach this device/);
  assert.equal(q("#dialog").open, true, "the notice does not wait for the dialog");

  q("#cancel-dialog").click();
  assert.equal(q("#dialog").open, false);
  assert.equal(q("#submit-dialog").hasAttribute("aria-busy"), false);
  stalled.delete("/v1/status");
  q('#sync-controls [data-action="pause"]').click();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(sent.includes("POST /v1/pause"), false, "mutations stay ordered");
  expire(30000);
  await until(() => daemon.engine.paused && idle());
  assert.match(q("#notice").textContent, /Connection interrupted/);
  assert.equal(daemon.engine.store.volume(v.id).name, "Original");
  await until(() => !/Cannot reach this device/.test(q("#notice").textContent));
});

test("Tauri replaces the stale view with Start service when the daemon stops and restores it once the daemon answers", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-daemon-stop-"));
  init(home, { port: 0, name: "Casa" });
  const daemon = await start(home, { timer: false });
  daemon.engine.store.addVolume("Documents");
  const pending = new Set();
  const dom = new JSDOM(html, {
    runScripts: "outside-only",
    url: "http://tauri.localhost",
  });
  const w = dom.window;
  t.after(async () => {
    await drainRequests(pending);
    w.close();
    await daemon.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const intervals = [];
  w.setInterval = (fn, ms) => {
    if (ms === 5000) intervals.push(fn);
    return 0;
  };
  let down = false;
  w.__TAURI__ = {
    core: {
      invoke: async (command, args) => {
        if (command === "bootstrap") return { setup: false };
        if (command === "check_update")
          return { available: false, version: null, notes: null };
        if (command !== "api") throw new Error(command);
        if (down) throw "The daemon is unavailable. Use Start service.";
        const work = fetch(`http://127.0.0.1:${daemon.port}${args.route}`, {
          method: args.method,
          headers: {
            Authorization: `Bearer ${daemon.engine.config.adminToken}`,
            "Content-Type": "application/json",
          },
          ...(args.method === "POST" ? { body: JSON.stringify(args.body) } : {}),
        }).then(async (r) => {
          const value = await r.json();
          if (!r.ok) throw value.error;
          return value;
        });
        pending.add(work);
        try {
          return await work;
        } finally {
          pending.delete(work);
        }
      },
    },
  };
  const q = (selector) => w.document.querySelector(selector);
  const idle = () => w.document.body.getAttribute("aria-busy") === "false";
  await w.eval(`(async()=>{${script}\n})()`);
  await until(() => q(".folder-card") && idle());
  const [poll] = intervals;
  down = true;
  await poll();
  assert.match(q("#content").textContent, /Daemon stopped/);
  assert.ok(q('#content [data-action="start"]'));
  assert.equal(q("#connection").textContent, "Service stopped");
  assert.equal(q("#sync-controls").hidden, true);
  assert.doesNotMatch(q("#notice").textContent, /Could not complete action/);
  w.document.body.dispatchEvent(
    new w.KeyboardEvent("keydown", { key: "r", metaKey: true, bubbles: true }),
  );
  await until(idle);
  assert.match(q("#content").textContent, /Daemon stopped/);
  assert.doesNotMatch(q("#notice").textContent, /daemon is unavailable/);
  const probe = intervals.at(-1);
  assert.notEqual(probe, poll);
  await probe();
  assert.match(q("#content").textContent, /Daemon stopped/);
  down = false;
  await probe();
  await until(() => q(".folder-card") && idle());
  assert.notEqual(q("#connection").textContent, "Service stopped");
  assert.equal(q("#sync-controls").hidden, false);
  assert.doesNotMatch(q("#notice").textContent, /daemon is unavailable/);
});

test("file rename and delete send the newest known revision when saved history is stale", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-file-rev-"));
  init(home, { port: 0, name: "Casa" });
  const daemon = await start(home, { timer: false });
  const v = daemon.engine.store.addVolume("Documents");
  fs.writeFileSync(path.join(v.path, "note.txt"), "one");
  await daemon.engine.cycle();
  fs.writeFileSync(path.join(v.path, "note.txt"), "two");
  await daemon.engine.cycle();
  const current = daemon.engine.store.current(v.id, "note.txt");
  assert.ok(current.rev > 1);
  const pending = new Set();
  const dom = new JSDOM(html, {
    runScripts: "outside-only",
    url: "http://tauri.localhost",
  });
  const w = dom.window;
  t.after(async () => {
    await drainRequests(pending);
    w.close();
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
  const posted = [];
  w.__TAURI__ = {
    core: {
      invoke: async (command, args) => {
        if (command === "bootstrap") return { setup: false };
        if (command === "check_update")
          return { available: false, version: null, notes: null };
        if (command !== "api") throw new Error(command);
        if (args.route.startsWith("/v1/history?"))
          return {
            offline: true,
            next: null,
            versions: [{ ...current, rev: 1, size: 3, created: Date.now() - 60000 }],
          };
        if (args.method === "POST") posted.push([args.route, args.body]);
        const work = fetch(`http://127.0.0.1:${daemon.port}${args.route}`, {
          method: args.method,
          headers: {
            Authorization: `Bearer ${daemon.engine.config.adminToken}`,
            "Content-Type": "application/json",
          },
          ...(args.method === "POST" ? { body: JSON.stringify(args.body) } : {}),
        }).then(async (r) => {
          const value = await r.json();
          if (!r.ok) throw value.error;
          return value;
        });
        pending.add(work);
        try {
          return await work;
        } finally {
          pending.delete(work);
        }
      },
    },
  };
  const q = (selector) => w.document.querySelector(selector);
  const idle = () => w.document.body.getAttribute("aria-busy") === "false";
  await w.eval(`(async()=>{${script}\n})()`);
  await until(() => q('[data-action="folder-detail"]') && idle());
  q('[data-action="folder-detail"]').click();
  const row = (name) =>
    [...w.document.querySelectorAll(".browser-file-row")].find(
      (el) => el.querySelector("strong").textContent === name,
    );
  await until(() => row("note.txt") && idle());
  row("note.txt").click();
  await until(() => q('.file-actions-menu [data-action="rename-file"]') && idle());
  q('.file-actions-menu [data-action="rename-file"]').click();
  await until(() => q('#dialog [name="name"]'));
  q('#dialog [name="name"]').value = "renamed.txt";
  q("#dialog-form").dispatchEvent(new w.Event("submit", { cancelable: true }));
  await until(() => !q("#dialog").open && idle());
  assert.deepEqual(JSON.parse(JSON.stringify(posted[0])), [
    "/v1/rename-file",
    { volume: v.id, path: "note.txt", rev: current.rev, name: "renamed.txt" },
  ]);
  assert.ok(fs.existsSync(path.join(v.path, "renamed.txt")));
  assert.match(q("#notice").textContent, /File renamed/);
  const renamed = daemon.engine.store.current(v.id, "renamed.txt");
  await until(() => row("renamed.txt") && idle());
  row("renamed.txt").click();
  await until(() => q('.file-actions-menu [data-action="delete-file"]') && idle());
  q('.file-actions-menu [data-action="delete-file"]').click();
  await until(() => q("#dialog").open);
  q("#dialog-form").dispatchEvent(new w.Event("submit", { cancelable: true }));
  await until(() => !q("#dialog").open && idle());
  assert.deepEqual(JSON.parse(JSON.stringify(posted[1])), [
    "/v1/delete-file",
    { volume: v.id, path: "renamed.txt", rev: renamed.rev },
  ]);
  assert.equal(fs.existsSync(path.join(v.path, "renamed.txt")), false);
});

test("web admin reports gateway failures as an unreachable machine and keeps the daemon's own 503 readable", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-web-gateway-"));
  init(home, { port: 0, name: "Casa" });
  const daemon = await start(home, { timer: false });
  daemon.engine.store.addVolume("Documents");
  const base = `http://127.0.0.1:${daemon.port}`;
  const dom = new JSDOM(html, { runScripts: "outside-only", url: base });
  const w = dom.window;
  const pending = new Set();
  t.after(async () => {
    await drainRequests(pending);
    w.close();
    await daemon.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  let poll;
  w.setInterval = (fn, ms) => {
    if (ms === 5000) poll = fn;
    return 0;
  };
  const answers = new Map();
  w.fetch = async (route, options = {}) => {
    const answer = answers.get(route);
    if (answer) return new Response(answer.body, { status: answer.status });
    const work = fetch(new URL(route, base), {
      ...nodeInit(options),
      headers: {
        ...options.headers,
        Authorization: `Bearer ${daemon.engine.config.adminToken}`,
      },
    });
    pending.add(work);
    void work.finally(() => pending.delete(work));
    return work;
  };
  const q = (selector) => w.document.querySelector(selector);
  const idle = () => w.document.body.getAttribute("aria-busy") === "false";
  await w.eval(`(async()=>{${script}\n})()`);
  await until(() => q(".folder-card") && idle());
  answers.set("/v1/status", { status: 502, body: "<html>Bad gateway</html>" });
  await poll();
  assert.match(q("#notice").textContent, /Cannot reach this device/);
  answers.set("/v1/status", {
    status: 503,
    body: JSON.stringify({ error: "Tailscale access unavailable" }),
  });
  await poll();
  assert.match(q("#notice").textContent, /Cannot reach this device/);
  assert.doesNotMatch(q("#notice").textContent, /Permission required/);
  answers.delete("/v1/status");
  answers.set("/v1/pause", {
    status: 503,
    body: JSON.stringify({
      error: "Hub unavailable. Try again when it is reachable.",
    }),
  });
  q('#sync-controls [data-action="pause"]').click();
  await until(() => /Hub unavailable\. Try again/.test(q("#notice").textContent));
  assert.doesNotMatch(q("#notice").textContent, /Permission required/);
});

test("the photo timeline scales months by count, keeps year labels apart and scrubs to a month", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-timeline-"));
  init(home, { port: 0, name: "Gallery" });
  const daemon = await start(home, { timer: false });
  const v = daemon.engine.store.addVolume("Photos");
  const sharp = (await import("sharp")).default;
  fs.writeFileSync(
    path.join(v.path, "photo.jpg"),
    await sharp({ create: { width: 40, height: 40, channels: 3, background: "red" } })
      .jpeg()
      .toBuffer(),
  );
  await daemon.engine.cycle();
  daemon.engine.store.db.prepare("INSERT OR IGNORE INTO gallery_folders VALUES(?)").run(v.id);
  const timeline = [
    { month: "2026-09", count: 400 },
    { month: "2026-08", count: 380 },
    { month: "2025-12", count: 300 },
    { month: "2024-05", count: 250 },
    { month: "2017-03", count: 4 },
    { month: "2016-02", count: 3 },
    { month: "2015-01", count: 2 },
    { month: "2012-06", count: 1 },
  ];
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://tauri.localhost" });
  const w = dom.window;
  w.setInterval = () => 0;
  const galleryRequests = [];
  const requests = new Set();
  t.after(async () => {
    await drainRequests(requests);
    w.close();
    await daemon.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  w.__TAURI__ = {
    core: {
      invoke: (command, args) => {
        const request = (async () => {
          if (command === "bootstrap")
            return { setup: false, status: daemon.engine.status() };
          if (command !== "api") throw new Error(command);
          if (args.route.startsWith("/v1/gallery?")) galleryRequests.push(args.route);
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
          if (args.route.startsWith("/v1/gallery?")) return { ...data, timeline };
          return data;
        })();
        requests.add(request);
        request.then(() => requests.delete(request), () => requests.delete(request));
        return request;
      },
    },
  };
  await w.eval(`(async()=>{${script}\n})()`);
  w.location.hash = `#/folders/${v.id}`;
  w.dispatchEvent(new w.HashChangeEvent("hashchange"));
  await until(() => w.document.querySelector('[data-action="gallery-mode"]'));
  if (!w.document.querySelector(".photo-timeline"))
    w.document.querySelector('[data-action="gallery-mode"]').click();
  await until(() => w.document.querySelectorAll(".photo-timeline button").length === 8);
  const rail = w.document.querySelector(".photo-timeline");
  Object.defineProperty(rail, "clientHeight", { configurable: true, value: 600 });
  rail.getBoundingClientRect = () => ({ top: 0, bottom: 600, left: 0, right: 76, width: 76, height: 600 });
  w.dispatchEvent(new w.Event("resize"));
  const buttons = [...rail.querySelectorAll("button")];
  const size = (button) => parseFloat(button.style.getPropertyValue("--segment-height"));
  const top = (button) => parseFloat(button.style.getPropertyValue("--segment-top"));
  assert.ok(size(buttons[0]) > 10 * size(buttons[7]), "busy months take more space");
  assert.ok(size(buttons[0]) < 20 * size(buttons[7]), "square-root weights avoid long empty stretches");
  assert.ok(size(buttons[7]) >= 3, "a sparse month stays reachable");
  assert.ok(Math.abs(top(buttons[7]) + size(buttons[7]) - 600) < 0.01, "the rail spans the whole height without scrolling");
  const labels = buttons
    .filter((button) => button.dataset.year)
    .map((button) => [button.dataset.year, !button.classList.contains("photo-year-hidden")]);
  assert.deepEqual(labels.at(0), ["2026", true]);
  assert.deepEqual(labels.at(-1), ["2012", true], "the oldest year is always labelled");
  const visible = buttons.filter((button) => button.dataset.year && !button.classList.contains("photo-year-hidden")).map(top);
  for (let i = 1; i < visible.length; i++)
    assert.ok(visible[i] - visible[i - 1] >= 20, "visible year labels never overlap");
  assert.ok(labels.some(([, visible]) => !visible), "crowded years do not overlap");
  const hover = rail.querySelector(".photo-timeline-hover");
  const pointer = (type, clientY) => {
    const event = new w.MouseEvent(type, { bubbles: true, clientY, button: 0 });
    rail.dispatchEvent(event);
  };
  pointer("pointermove", top(buttons[3]) + 16 + 2);
  assert.equal(hover.hidden, false);
  assert.equal(hover.textContent, buttons[3].dataset.label);
  assert.ok(buttons[3].classList.contains("photo-date-hovered"));
  assert.equal(buttons[3].title, "", "the chip replaces the native tooltip");
  assert.match(buttons[3].getAttribute("aria-label"), /May 2024, 250 photos/);
  const before = galleryRequests.length;
  pointer("pointerdown", top(buttons[3]) + 16 + 2);
  pointer("pointerup", top(buttons[3]) + 16 + 2);
  await until(() => galleryRequests.length > before);
  assert.match(galleryRequests.at(-1), /month=2024-05/);
  assert.equal(hover.hidden, true);
  assert.equal(buttons[3].hasAttribute("aria-current"), true, "the viewed month's dot is lit");
  assert.equal(rail.querySelectorAll("[aria-current]").length, 1);
});

test("the photo timeline appears and seeks while the gallery is still indexing", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-timeline-indexing-"));
  init(home, { port: 0, name: "Gallery" });
  const daemon = await start(home, { timer: false });
  const v = daemon.engine.store.addVolume("Photos");
  const sharp = (await import("sharp")).default;
  fs.writeFileSync(
    path.join(v.path, "photo.jpg"),
    await sharp({ create: { width: 40, height: 40, channels: 3, background: "red" } }).jpeg().toBuffer(),
  );
  await daemon.engine.cycle();
  daemon.engine.store.db.prepare("INSERT OR IGNORE INTO gallery_folders VALUES(?)").run(v.id);
  const timeline = [
    { month: "2026-09", count: 40 },
    { month: "2020-12", count: 12 },
    { month: "2012-06", count: 1 },
  ];
  let indexing = true;
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://tauri.localhost" });
  const w = dom.window;
  w.setInterval = () => 0;
  const galleryRequests = [];
  const requests = new Set();
  t.after(async () => {
    indexing = false;
    await drainRequests(requests);
    w.close();
    await daemon.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  w.__TAURI__ = {
    core: {
      invoke: (command, args) => {
        const request = (async () => {
          if (command === "bootstrap") return { setup: false, status: daemon.engine.status() };
          if (command !== "api") throw new Error(command);
          if (args.route.startsWith("/v1/gallery?")) galleryRequests.push(args.route);
          const r = await fetch(`http://127.0.0.1:${daemon.port}${args.route}`, {
            method: args.method || "GET",
            headers: { Authorization: `Bearer ${daemon.engine.config.adminToken}`, "Content-Type": "application/json" },
            ...(args.body ? { body: JSON.stringify(args.body) } : {}),
          });
          const data = await r.json();
          if (!r.ok) throw new Error(data.error);
          if (args.route.startsWith("/v1/gallery?")) return { ...data, indexing, timeline };
          return data;
        })();
        requests.add(request);
        request.then(() => requests.delete(request), () => requests.delete(request));
        return request;
      },
    },
  };
  await w.eval(`(async()=>{${script}\n})()`);
  w.location.hash = `#/folders/${v.id}`;
  w.dispatchEvent(new w.HashChangeEvent("hashchange"));
  await until(() => w.document.querySelector('[data-action="gallery-mode"]'));
  if (!w.document.querySelector(".photo-timeline"))
    w.document.querySelector('[data-action="gallery-mode"]').click();
  await until(() => w.document.querySelectorAll(".photo-timeline button").length === 3);
  assert.equal(w.document.querySelector(".photo-more").getAttribute("aria-label"), "Preparing gallery");
  const before = galleryRequests.length;
  await until(() => galleryRequests.length > before + 1);
  w.document.querySelector('.photo-timeline button[data-month="2020-12"]').click();
  await until(() => galleryRequests.some((route) => route.includes("month=2020-12")));
  indexing = false;
  await until(() => !w.document.querySelector(".photo-more").hasAttribute("aria-busy"));
  assert.match(galleryRequests.at(-1), /month=2020-12/, "the seeked month survives the end of indexing");
  assert.equal(w.document.querySelectorAll(".photo-timeline button").length, 3);
  assert.equal(
    w.document.querySelector(".photo-timeline [aria-current]")?.dataset.month,
    "2020-12",
  );
});

test("the gallery retries a failed first page and loads pages whose sentinel stays in view, without buttons", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-gallery-more-"));
  init(home, { port: 0, name: "Gallery" });
  const daemon = await start(home, { timer: false });
  const v = daemon.engine.store.addVolume("Photos");
  const sharp = (await import("sharp")).default;
  const image = await sharp({ create: { width: 8, height: 8, channels: 3, background: "red" } }).jpeg().toBuffer();
  for (let n = 0; n < 65; n++) fs.writeFileSync(path.join(v.path, `IMG_${String(n).padStart(3, "0")}.jpg`), image);
  fs.writeFileSync(path.join(v.path, "CLIP_000.mov"), "video");
  await daemon.engine.cycle();
  const db = daemon.engine.store.db;
  db.prepare("INSERT OR IGNORE INTO gallery_folders VALUES(?)").run(v.id);
  db.prepare("INSERT OR REPLACE INTO gallery_metadata(hash,captured,date_checked) VALUES(?,?,1)")
    .run(daemon.engine.store.current(v.id, "IMG_000.jpg").hash, "2026-03-10T12:00:00");
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://tauri.localhost" });
  const w = dom.window;
  w.setInterval = () => 0;
  w.IntersectionObserver = class {
    observe() {}
    disconnect() {}
  };
  const galleryRequests = [];
  const requests = new Set();
  let failing = true;
  const delayed = [];
  const setTimeoutReal = w.setTimeout.bind(w);
  w.setTimeout = (callback, ms, ...rest) =>
    ms === 5000 ? (delayed.push(callback), 0) : setTimeoutReal(callback, ms, ...rest);
  t.after(async () => {
    await drainRequests(requests);
    w.close();
    await daemon.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  w.__TAURI__ = {
    core: {
      invoke: (command, args) => {
        const request = (async () => {
          if (command === "bootstrap") return { setup: false, status: daemon.engine.status() };
          if (command !== "api") throw new Error(command);
          if (args.route.startsWith("/v1/gallery?")) {
            galleryRequests.push(args.route);
            if (failing && w.document.querySelector(".photo-more"))
              throw new Error("Hub unavailable. Try again when it is reachable.");
          }
          const r = await fetch(`http://127.0.0.1:${daemon.port}${args.route}`, {
            method: args.method || "GET",
            headers: { Authorization: `Bearer ${daemon.engine.config.adminToken}`, "Content-Type": "application/json" },
            ...(args.body ? { body: JSON.stringify(args.body) } : {}),
          });
          const data = await r.json();
          if (!r.ok) throw new Error(data.error);
          return data;
        })();
        requests.add(request);
        request.then(() => requests.delete(request), () => requests.delete(request));
        return request;
      },
    },
  };
  await w.eval(`(async()=>{${script}\n})()`);
  w.location.hash = `#/folders/${v.id}`;
  w.dispatchEvent(new w.HashChangeEvent("hashchange"));
  await until(() => w.document.querySelector('[data-action="gallery-mode"]'));
  if (!w.document.querySelector(".photo-timeline"))
    w.document.querySelector('[data-action="gallery-mode"]').click();
  await until(() => /Retrying/.test(w.document.querySelector(".photo-more")?.textContent));
  failing = false;
  for (const callback of delayed.splice(0)) callback();
  await until(() => w.document.querySelectorAll(".photo-thumb").length === 66);
  assert.ok(galleryRequests.some((route) => route.includes("after=")), "the second page loaded by itself");
  const summary = w.document.querySelector(".detail-head .heading p");
  assert.match(summary.textContent, /^65 photos · 1 video · /);
  summary.textContent = summary.textContent.replace(/^65 photos · 1 video/, "66 photos");
  Object.defineProperty(w.document, "hidden", { configurable: true, value: false });
  w.document.dispatchEvent(new w.Event("arca-changes"));
  await until(() => /^65 photos · 1 video · /.test(summary.textContent));
  const sentinel = w.document.querySelector(".photo-more");
  assert.equal(sentinel.tagName, "DIV");
  assert.equal(sentinel.hidden, true);
  assert.doesNotMatch(w.document.querySelector("#photo-gallery").textContent, /Load more/);
});

test("after seeking a month the gallery loads newer photos above when scrolling up", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-timeline-up-"));
  init(home, { port: 0, name: "Gallery" });
  const daemon = await start(home, { timer: false });
  const v = daemon.engine.store.addVolume("Photos");
  const sharp = (await import("sharp")).default;
  const dates = { "new.jpg": "2026-03-10T12:00:00", "middle.jpg": "2025-07-10T12:00:00", "old.jpg": "2024-05-10T12:00:00" };
  for (const [name, color] of [["new.jpg", "red"], ["middle.jpg", "green"], ["old.jpg", "blue"]])
    fs.writeFileSync(
      path.join(v.path, name),
      await sharp({ create: { width: 40, height: 40, channels: 3, background: color } }).jpeg().toBuffer(),
    );
  await daemon.engine.cycle();
  const db = daemon.engine.store.db;
  db.prepare("INSERT OR IGNORE INTO gallery_folders VALUES(?)").run(v.id);
  for (const [name, captured] of Object.entries(dates))
    db.prepare("INSERT OR REPLACE INTO gallery_metadata(hash,captured,date_checked) VALUES(?,?,1)")
      .run(daemon.engine.store.current(v.id, name).hash, captured);
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://tauri.localhost" });
  const w = dom.window;
  w.setInterval = () => 0;
  const observers = [];
  w.IntersectionObserver = class {
    constructor(callback) {
      this.callback = callback;
      observers.push(this);
    }
    observe(element) {
      this.element = element;
    }
    disconnect() {}
  };
  const galleryRequests = [];
  const requests = new Set();
  let failNewer = true;
  let retryNewer;
  const setTimeoutReal = w.setTimeout.bind(w);
  w.setTimeout = (callback, ms, ...rest) =>
    ms === 5000 ? ((retryNewer = callback), 0) : setTimeoutReal(callback, ms, ...rest);
  t.after(async () => {
    await drainRequests(requests);
    w.close();
    await daemon.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  w.__TAURI__ = {
    core: {
      invoke: (command, args) => {
        const request = (async () => {
          if (command === "bootstrap") return { setup: false, status: daemon.engine.status() };
          if (command !== "api") throw new Error(command);
          if (args.route.startsWith("/v1/gallery?")) galleryRequests.push(args.route);
          if (args.route.includes("before=") && failNewer) {
            failNewer = false;
            throw new Error("Hub unavailable. Try again when it is reachable.");
          }
          const r = await fetch(`http://127.0.0.1:${daemon.port}${args.route}`, {
            method: args.method || "GET",
            headers: { Authorization: `Bearer ${daemon.engine.config.adminToken}`, "Content-Type": "application/json" },
            ...(args.body ? { body: JSON.stringify(args.body) } : {}),
          });
          const data = await r.json();
          if (!r.ok) throw new Error(data.error);
          return data;
        })();
        requests.add(request);
        request.then(() => requests.delete(request), () => requests.delete(request));
        return request;
      },
    },
  };
  await w.eval(`(async()=>{${script}\n})()`);
  w.location.hash = `#/folders/${v.id}`;
  w.dispatchEvent(new w.HashChangeEvent("hashchange"));
  await until(() => w.document.querySelector('[data-action="gallery-mode"]'));
  if (!w.document.querySelector(".photo-timeline"))
    w.document.querySelector('[data-action="gallery-mode"]').click();
  await until(() => w.document.querySelectorAll(".photo-timeline button").length === 3);
  const paths = () =>
    [...w.document.querySelectorAll(".photo-thumb .photo-open")].map((tile) => tile.getAttribute("aria-label"));
  await until(() => paths().length === 3);
  w.document.querySelector('.photo-timeline button[data-month="2024-05"]').click();
  await until(() => retryNewer);
  assert.deepEqual(paths(), ["Open old.jpg"], "a failed newer page leaves the seeked month in place");
  retryNewer();
  await until(() => paths().length === 3);
  const seek = galleryRequests.findIndex((route) => route.includes("month=2024-05"));
  assert.ok(seek >= 0);
  assert.ok(galleryRequests.slice(seek + 1).some((route) => route.includes("before=")), "newer photos load above the seeked month");
  assert.deepEqual(paths(), ["Open new.jpg", "Open middle.jpg", "Open old.jpg"]);
  const newer = observers.find((observer) => observer.element?.classList.contains("photo-newer"));
  assert.ok(newer, "the top of the gallery is observed");
  const count = galleryRequests.length;
  newer.callback([{ isIntersecting: true }]);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const day = w.document.querySelector(".photo-day");
  day.getBoundingClientRect = () => ({ top: 0, bottom: 500, left: 0, right: 500, width: 500, height: 500 });
  const chip = w.document.querySelector(".photo-timeline-hover");
  w.document.querySelector(".photo-days").closest(".page").dispatchEvent(new w.Event("scroll"));
  assert.equal(chip.hidden, false, "scrolling shows the date chip");
  assert.equal(chip.textContent, "Mar 2026");
  await until(() => chip.hidden);
  assert.equal(galleryRequests.length, count, "nothing newer remains to load");
});

test("the wizard sets up name and role on one page, says who each role is for and keeps a three-step rail", async () => {
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://tauri.localhost" });
  const w = dom.window;
  w.setInterval = () => 0;
  w.setTimeout = () => 0;
  w.__TAURI__ = {
    core: {
      invoke: async (command, args) => {
        if (command === "bootstrap") return { setup: true, root: "/tmp/Arca", name: "studio", platform: "macos", arch: "arm64" };
        if (command === "setup_info") return { root: args.root, freeBytes: 1000000000 };
        throw new Error(command);
      },
    },
  };
  const submit = () => w.document.querySelector("#setup-form").dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
  const idle = () => w.document.body.getAttribute("aria-busy") === "false";
  const steps = () => [...w.document.querySelectorAll(".onboarding .steps .step")].map((el) => el.textContent.trim());
  try {
    await w.eval(`(async()=>{${script}\n})()`);
    submit();
    await until(() => w.document.querySelector('[name="name"]') && idle());
    const page = w.document.querySelector("#content");
    assert.match(page.textContent, /Set up this device/);
    assert.deepEqual(steps().map((label) => label.replace(/^\d+/, "")), ["This device", "Connect", "Folders"]);
    assert.equal(w.document.querySelector(".onboarding .step.current").textContent.trim().replace(/^\d+/, ""), "This device");
    assert.equal(w.document.querySelectorAll('[name="role"]').length, 2);
    assert.match(page.textContent, /Choose this for the device that stays on: a server, a NAS or a computer that is rarely off\./);
    assert.match(page.textContent, /Needs a pairing code from your hub\./);
    assert.doesNotMatch(page.textContent, /What is /);
    w.document.querySelector('[name="role"][value="hub"]').checked = true;
    submit();
    await until(() => w.document.querySelector('[name="root"]') && idle());
    assert.match(w.document.querySelector("#content").textContent, /A home for your folders/);
    assert.deepEqual(steps().map((label) => label.replace(/^\d+/, "")), ["This device", "Connect · Not needed", "Folders"]);
    assert.equal(w.document.querySelector(".onboarding .step.current").textContent.trim().replace(/^\d+/, ""), "Folders");
    w.document.querySelector("#setup-back").click();
    await until(() => w.document.querySelector('[name="role"]') && idle());
    assert.match(w.document.querySelector("#content").textContent, /Set up this device/);
    assert.ok(w.document.querySelector('[name="role"][value="hub"]').checked, "the chosen role is kept");
    w.document.querySelector("#setup-back").click();
    await until(() => w.document.querySelector("#content").textContent.includes("Many devices") && idle());
    assert.deepEqual(steps().map((label) => label.replace(/^\d+/, "")), ["This device", "Connect", "Folders"], "the welcome rail never says Not needed");
  } finally {
    w.close();
  }
});

for (const umbrel of [false, true]) {
  test("the server access step " + (umbrel ? "keeps the Umbrel link and shows no command" : "shows the documented command with Copy and where the code is"), async (t) => {
    const { initializeServer } = await import("../packages/daemon/setup.js");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-access-command-"));
    initializeServer(home, { port: 0 });
    const previous = process.env.ARCA_SETUP_CODE_PATH;
    if (umbrel) process.env.ARCA_SETUP_CODE_PATH = "/umbrel";
    else delete process.env.ARCA_SETUP_CODE_PATH;
    const daemon = await start(home, { timer: false });
    const base = "http://127.0.0.1:" + daemon.port;
    const w = new JSDOM(html, { runScripts: "outside-only", url: base }).window;
    w.setInterval = () => 0;
    w.fetch = async (route, options = {}) =>
      fetch(new URL(route, base), { ...nodeInit(options), headers: { ...options.headers, Origin: base } });
    let copied = null;
    Object.defineProperty(w.navigator, "clipboard", { value: { writeText: async (value) => (copied = value) } });
    t.after(async () => {
      w.close();
      await daemon.close();
      fs.rmSync(home, { recursive: true, force: true });
      if (previous === undefined) delete process.env.ARCA_SETUP_CODE_PATH;
      else process.env.ARCA_SETUP_CODE_PATH = previous;
    });
    await w.eval(`(async()=>{${script}\n})()`);
    const submit = () => w.document.querySelector("#setup-form").dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
    const waitFor = (selector) => until(() => w.document.querySelector(selector) && w.document.body.getAttribute("aria-busy") === "false");
    await waitFor("#setup-form");
    submit();
    await waitFor('[name="name"]');
    w.document.querySelector('[name="name"]').value = "Server";
    submit();
    await waitFor('[data-code="setup-access"]');
    const page = w.document.querySelector("#content");
    const command = "docker exec <container> node packages/cli/arca.js web-code";
    if (umbrel) {
      assert.ok(page.querySelector('a[href="/umbrel"]'));
      assert.doesNotMatch(page.textContent, /docker exec/);
      assert.equal(page.querySelector('[data-action="copy"]'), null);
      return;
    }
    assert.equal(page.querySelector('a[href="/umbrel"]'), null);
    assert.match(page.textContent, /On the server, run:/);
    assert.ok(page.textContent.includes(command));
    assert.match(page.textContent, /The reply is JSON: enter the value of code\./);
    assert.doesNotMatch(page.textContent, /run arca web-code/);
    const copy = page.querySelector('[data-action="copy"]');
    assert.equal(copy.dataset.id, command);
    copy.click();
    await until(() => copied !== null);
    assert.equal(copied, command);
  });
}

test("a server replica's web file detail downloads the file from its own copy, the hub from its store", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arca-replica-download-"));
  const nodes = [];
  async function node(name, role) {
    const home = path.join(root, name);
    init(home, { name, role, port: 0 });
    const daemon = await start(home, { timer: false });
    nodes.push(daemon);
    daemon.base = `http://127.0.0.1:${daemon.port}`;
    daemon.request = (route, body) =>
      fetch(daemon.base + route, {
        method: body === undefined ? "GET" : "POST",
        headers: { Authorization: `Bearer ${daemon.engine.config.adminToken}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    daemon.api = async (route, body) => {
      const r = await daemon.request(route, body);
      const data = await r.json();
      if (!r.ok) throw new Error(data.error);
      return data;
    };
    return daemon;
  }
  const hub = await node("Hub", "hub");
  const server = await node("Server", "replica");
  const folder = await hub.api("/v1/volumes", { name: "Shared" });
  fs.writeFileSync(path.join(folder.path, "keep.txt"), "Keep this file");
  await hub.engine.cycle();
  const invite = await hub.api("/v1/devices", { name: "Server", role: "replica" });
  await server.api("/v1/connect", { url: hub.base, token: invite.token });
  await server.api("/v1/select", { id: folder.id });
  await server.engine.cycle();
  const doms = [];
  let inFlight = 0;
  t.after(async () => {
    await until(() => inFlight === 0);
    await new Promise((resolve) => setImmediate(resolve));
    for (const dom of doms) dom.window.close();
    for (const daemon of nodes.reverse()) await daemon.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  async function open(daemon, hash) {
    const dom = new JSDOM(html, { runScripts: "outside-only", url: daemon.base + "/" + hash });
    doms.push(dom);
    const w = dom.window;
    w.setInterval = () => 0;
    w.fetch = async (route, options = {}) => {
      inFlight++;
      try {
        const response = await daemon.request(route, options.body === undefined ? undefined : JSON.parse(options.body));
        const body = await response.json();
        return { ok: response.ok, status: response.status, json: async () => body };
      } finally {
        inFlight--;
      }
    };
    await w.eval(`(async()=>{${script}\n})()`);
    await until(() => w.document.querySelector(".file-header-actions") && w.document.body.getAttribute("aria-busy") === "false");
    return w;
  }
  const route = `#/history?${new URLSearchParams({ volume: folder.id, path: "keep.txt" })}`;
  const replica = await open(server, route);
  const link = replica.document.querySelector(".file-header-actions a[download]");
  assert.ok(link, "a replica's web file detail offers Download file");
  assert.equal(link.textContent.trim(), "Download file");
  assert.equal(link.getAttribute("download"), "keep.txt");
  const href = link.getAttribute("href");
  assert.match(href, /^\/v1\/gallery\/download\?/, "served by the replica itself, never the hub");
  assert.equal(replica.document.querySelector('[data-action="history-open-file"]'), null, "web cannot open the file on the machine");
  const served = await server.request(href);
  assert.equal(served.status, 200);
  assert.equal(await served.text(), "Keep this file");
  assert.equal(served.headers.get("content-disposition"), "attachment; filename*=UTF-8''keep.txt");
  const web = await open(hub, route);
  assert.match(web.document.querySelector(".file-header-actions a[download]").getAttribute("href"), /^\/v1\/blobs\//, "the hub keeps serving its store");
  const hubServed = await hub.request(web.document.querySelector(".file-header-actions a[download]").getAttribute("href"));
  assert.equal(hubServed.status, 200);
  fs.writeFileSync(path.join(folder.path, "keep.txt"), "Edited on the hub");
  await hub.engine.cycle();
  const lagging = await open(server, route);
  const lag = lagging.document.querySelector(".file-header-actions a[download]");
  assert.ok(lag, "a replica behind the hub still offers its own copy");
  assert.equal(lag.getAttribute("href"), href, "the link names the revision the replica holds, not the hub's newest");
  const stillServed = await server.request(lag.getAttribute("href"));
  assert.equal(stillServed.status, 200);
  assert.equal(await stillServed.text(), "Keep this file");
  fs.rmSync(path.join(server.engine.store.volume(folder.id).path, "keep.txt"));
  const missing = await server.request(href);
  assert.equal(missing.status, 409);
  assert.match((await missing.json()).error, /Local copy missing/, "a copy that is not on disk is told apart from a changed one");
  await server.api("/v1/unselect", { id: folder.id });
  const refused = await server.request(href);
  assert.equal(refused.status, 404, "an unlinked folder serves nothing");
  assert.match((await refused.json()).error, /Unknown volume/);
});

test("offline file history shows only the saved rows, says they are recent entries and keeps Restore for the hub", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-offline-file-history-"));
  init(home, { port: 0, name: "Local Mac" });
  const daemon = await start(home, { timer: false });
  const volume = daemon.engine.store.addVolume("Docs");
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://tauri.localhost" });
  t.after(async () => {
    dom.window.close();
    await daemon.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const w = dom.window;
  let poll = null;
  w.setInterval = (callback, ms) => {
    if (ms === 5000) poll = callback;
    return 0;
  };
  let hubDown = true;
  const rows = [120, 115, 110].map((rev) => ({ rev, path: "brief.md", size: 4000 + rev, deleted: 0, author: daemon.engine.config.id, created: `2026-09-30T1${String(rev % 10)}:00:00Z` }));
  w.__TAURI__ = {
    core: {
      invoke: async (command, args) => {
        if (command === "bootstrap") return { setup: false };
        if (args.route === "/v1/status")
          return { ...daemon.engine.status(), role: "replica", phase: hubDown ? "offline" : "idle", hubUnavailable: hubDown, hubName: "Casa", hub: "http://127.0.0.1:49999" };
        if (args.route === "/v1/remote") return { offline: true, name: "Casa", volumes: [{ ...volume, selected: 1 }] };
        if (args.route === "/v1/machines") return { offline: true, machines: [] };
        if (args.route.startsWith("/v1/history") && args.route.includes("before=")) return { offline: true, truncated: true, versions: [], next: null };
        if (args.route.startsWith("/v1/history")) return { offline: true, truncated: !args.route.includes("quiet.md"), versions: rows, next: args.route.includes("quiet.md") ? null : 110 };
        if (args.route.startsWith("/v1/activity")) return { offline: true, versions: [], next: null };
        if (args.route.startsWith("/v1/browse")) return { entries: [], next: null };
        return {};
      },
    },
  };
  w.eval(`(async()=>{${script}\n})()`);
  await until(() => w.document.querySelector(".folder-card"));
  const forced = w.document.createElement("button");
  forced.dataset.action = "activity-file";
  forced.dataset.id = JSON.stringify({ volume: volume.id, path: "brief.md" });
  w.document.body.append(forced);
  forced.click();
  await until(() => w.document.querySelectorAll(".file-version-row").length === 3 && w.document.body.getAttribute("aria-busy") === "false");
  const content = w.document.querySelector("#content");
  assert.match(content.querySelector("#history-list .hint").textContent, /^Showing saved history · recent entries only\. Connect to the hub for updated retention and older versions\.$/);
  assert.doesNotMatch(content.textContent, /Offline · showing saved history/);
  content.querySelector('.pagination button[data-action="history-page"]').click();
  await until(() => !content.querySelector(".pagination") && w.document.body.getAttribute("aria-busy") === "false");
  assert.equal(content.querySelectorAll(".file-version-row").length, 3, "an empty continuation keeps the rows already shown");
  assert.doesNotMatch(content.textContent, /No saved versions for this file/);
  assert.match(content.querySelector("#history-list .hint").textContent, /recent entries only/, "an exhausted saved window still means older rows exist on the hub");
  const versions = [...content.querySelectorAll(".file-version-row")];
  assert.ok(versions[0].querySelector(".pill"), "the newest saved row is Current");
  const restores = versions.slice(1).map((row) => row.querySelector(".row-actions button"));
  assert.equal(restores.length, 2);
  for (const restore of restores) {
    assert.match(restore.textContent, /Restore/);
    assert.equal(restore.disabled, true, "Restore needs the hub");
    assert.match(restore.title, /Needs the hub, which is unavailable\./);
    assert.equal(restore.dataset.action, "restore", "it is the same control the hub-only sync re-enables");
  }
  hubDown = false;
  await poll();
  await until(() => restores.every((restore) => !restore.disabled && !restore.title));
  hubDown = true;
  await poll();
  await until(() => restores.every((restore) => restore.disabled));
  const quiet = w.document.createElement("button");
  quiet.dataset.action = "activity-file";
  quiet.dataset.id = JSON.stringify({ volume: volume.id, path: "quiet.md" });
  w.document.body.append(quiet);
  quiet.click();
  await until(() => w.document.querySelector("#history-list .hint")?.textContent.startsWith("Showing saved history. ") && w.document.body.getAttribute("aria-busy") === "false");
  assert.equal(w.document.querySelector("#history-list .hint").textContent, "Showing saved history. Connect to the hub for updated retention.", "a complete saved history does not claim to be recent entries only");
});
