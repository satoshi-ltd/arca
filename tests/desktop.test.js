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
      new URL("../apps/desktop/src/music-library.js", import.meta.url),
      "utf8",
    )
    .replace(/export /g, "") +
  "\n" +
  fs
    .readFileSync(
      new URL("../apps/desktop/src/favorite-order.js", import.meta.url),
      "utf8",
    )
    .replace(/export /g, "") +
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
async function until(check, tries = 200) {
  for (let i = 0; i < tries; i++) {
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
    assert.match(
      w.document.querySelector("#content").textContent,
      /Anyone on that network could read your files and sign-in details/,
    );
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
    assert.equal(w.document.querySelector("#connection").className, "wa", "Paused is a warning tone");
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
          .textContent.includes("Known device") &&
        w.document.body.getAttribute("aria-busy") === "false",
    );
    assert.equal(
      w.document.querySelector("#devices-list").textContent.includes("Offline"),
      false,
      "Tailscale presence never reaches a device row",
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

  const help = w.document.querySelector(".access-help");
  assert.equal(
    help.querySelector("code").textContent,
    "docker exec <container> node packages/cli/arca.js web-code",
  );
  assert.match(help.textContent, /if it is installed directly/);
  assert.match(help.textContent, /six-digit code\. Enter that code above\./);
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
  assert.equal(w.document.querySelector("#status-device [data-icon]").dataset.icon, "server");
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

test("retention choices share one row in equal segments with whole labels, and the history filters keep their layout", () => {
  const css = fs.readFileSync(
    new URL("../apps/desktop/src/style.css", import.meta.url),
    "utf8",
  );
  const dom = new JSDOM(
    `<style>${css}</style><div class="segmented segmented-fill"><button>Forever</button></div><div class="segmented history-filters"><button>All</button></div>`,
  );
  const [fill, filters] = dom.window.document.querySelectorAll(".segmented");
  const style = (element) => dom.window.getComputedStyle(element);
  const choice = style(fill.firstChild);
  assert.deepEqual([choice.flexGrow, choice.flexShrink, choice.flexBasis], ["1", "1", "0%"], "segments share the row equally");
  assert.equal(style(fill).flexWrap, "wrap", "a row too narrow for the whole labels wraps instead of scrolling the page sideways");
  assert.equal(choice.minWidth, "auto", "each whole label sets its segment's floor");
  assert.equal(choice.whiteSpace, "nowrap", "a label never breaks");
  assert.equal(choice.justifyContent, "center");
  assert.equal(choice.paddingInline, "var(--space-1)");
  assert.equal(choice.fontSize, "var(--text-body)");
  assert.equal(style(filters).flexWrap, "wrap", "the history filters still wrap");
  assert.equal(style(filters.firstChild).flexGrow, "0");
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
  assert.match(
    w.document.querySelector(".folder-card .meta").textContent,
    /^Offline · /,
    "the row says Offline once, in its subtitle",
  );
  assert.ok(w.document.querySelector(".folder-card .home-lead > .tile.id"), "offline draws the neutral tile");
  assert.equal(w.document.querySelector(".folder-card .pill"), null);
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
  assert.equal(choose.getAttribute("aria-disabled"), "true", "it stays focusable so its reason can be read");
  assert.equal(choose.disabled, false);
  assert.equal(choose.hasAttribute("title"), false, "no native tooltip");
  assert.match(choose.dataset.tooltip, /Needs the hub/);
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

test("the hub's folder menu makes an ordinary folder an audio library, which then shows the music tile and offers neither Enable item", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-music-menu-"));
  init(home, { port: 0, name: "Music hub" });
  const daemon = await start(home, { timer: false });
  const volume = daemon.engine.store.addVolume("Records");
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://tauri.localhost" });
  const requests = new Set();
  t.after(async () => {
    await drainRequests(requests);
    dom.window.close();
    await daemon.engine.music?.background;
    await daemon.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const w = dom.window;
  let poll = null;
  w.setInterval = (callback, ms) => {
    if (ms === 5000) poll = callback;
    return 0;
  };
  const posted = [];
  w.__TAURI__ = {
    core: {
      invoke: async (command, args) => {
        if (command === "bootstrap") return { setup: false, status: daemon.engine.status() };
        if (command === "desktop_preferences") return {};
        if (command !== "api") return {};
        if (args.method === "POST") posted.push(args.route);
        const response = await fetch(`http://127.0.0.1:${daemon.port}${args.route}`, {
          method: args.method,
          ...(args.body ? { body: JSON.stringify(args.body) } : {}),
          headers: { authorization: `Bearer ${daemon.engine.config.adminToken}` },
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error);
        return data;
      },
    },
  };
  trackInvoke(w, requests);
  w.eval(`(async()=>{${script}\n})()`);
  const idle = () => w.document.body.getAttribute("aria-busy") === "false";
  await until(() => w.document.querySelector('.folder-card[data-action="folder-detail"]') && idle());
  assert.equal(w.document.querySelector(".folder-card .tile [data-icon]").dataset.icon, "folder");
  w.document.querySelector('.folder-card[data-action="folder-detail"]').click();
  await until(() => w.document.querySelector(".heading-actions .folder-actions-menu") && idle());
  const menu = w.document.querySelector(".heading-actions .folder-actions-menu");
  const enable = menu.querySelector('[data-action="enable-music"]');
  assert.match(enable.textContent, /Enable audio library/);
  assert.equal(enable.querySelector("[data-icon]").dataset.icon, "music");
  menu.open = true;
  enable.click();
  await until(() => /Enable audio library\?/.test(w.document.querySelector("#dialog-content")?.textContent || "") && idle());
  assert.match(w.document.querySelector("#dialog-content").textContent, /Files and synchronization stay the same/);
  assert.equal(menu.open, false);
  w.document.querySelector("#submit-dialog").click();
  await until(() => daemon.engine.status().volumes[0].music && !w.document.querySelector("#dialog").open && idle());
  await poll();
  await until(() => w.document.querySelector(".music-page") && idle());
  assert.ok(w.document.querySelector('.detail-title .tile [data-icon="music"]'));
  assert.equal(w.document.querySelector('.heading-actions [data-action="music-mode"]').textContent.trim(), "View folder");
  assert.deepEqual(posted, ["/v1/music/mark"]);
  assert.deepEqual(
    [...w.document.querySelectorAll(".heading-actions .folder-actions-menu [data-action]")].map((el) => el.dataset.action),
    ["rename-share", "edit-ignore"],
    "an audio library offers neither Enable gallery nor Enable audio library",
  );
  w.document.querySelector('[data-action="back-folders"]').click();
  await until(() => w.document.querySelector('.folder-card .tile [data-icon="music"]') && idle());
  assert.equal(volume.id, daemon.engine.status().volumes[0].id);
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
  assert.deepEqual([...actions.querySelectorAll("[data-action]")].map((el) => el.dataset.action), ["favorite-toggle", "open"]);
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

test("the status card opens with the device glyph, name and role, and the lockup is the brand only", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-status-identity-"));
  init(home, { port: 0, name: "Local Mac" });
  const daemon = await start(home, { timer: false });
  const requests = new Set();
  const windows = [];
  t.after(async () => {
    await drainRequests(requests);
    for (const window of windows) window.close();
    await daemon.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const open = async (state, native) => {
    const dom = new JSDOM(html, { runScripts: "outside-only", url: native ? "http://tauri.localhost" : "http://127.0.0.1:17831" });
    windows.push(dom.window);
    const w = dom.window;
    w.setInterval = () => 0;
    const reply = (route) => {
      if (route === "/v1/status") return { ...daemon.engine.status(), platform: "linux", volumes: [], hubUnavailable: false, ...state };
      if (route === "/v1/remote") return { name: "Casa", volumes: [] };
      if (route === "/v1/machines") return { machines: [] };
      return {};
    };
    if (native) {
      w.__TAURI__ = { core: { invoke: async (command, args) => (command === "bootstrap" ? { setup: false } : reply(args.route)) } };
      trackInvoke(w, requests);
    } else
      w.fetch = async (route) => {
        const request = Promise.resolve(new Response(JSON.stringify(reply(String(route).replace(/^https?:\/\/[^/]+/, ""))), { headers: { "Content-Type": "application/json" } }));
        requests.add(request);
        request.finally(() => requests.delete(request));
        return request;
      };
    const document = w.document;
    assert.equal(document.querySelector(".managing"), null, "no identity card under the lockup");
    assert.equal(document.querySelector("#status-device").hidden, true, "the device row is absent before the first status");
    assert.equal(document.querySelector(".status-card").hidden, true, "no empty card is drawn before the first status");
    w.eval(`(async()=>{${script}\n})()`);
    await until(() => !document.querySelector("#status-device").hidden);
    assert.equal(document.querySelector(".status-card").hidden, false);
    const row = document.querySelector("#status-device");
    return {
      glyph: row.firstElementChild.dataset.icon,
      name: row.querySelector("#managed-name").textContent,
      role: row.querySelector("#managed-role").textContent,
      label: document.querySelector(".status-card").getAttribute("aria-label"),
      first: document.querySelector(".status-card").firstElementChild.id,
      brand: document.querySelector(".brand").textContent.trim(),
      dot: row.querySelector(".status-dot").className,
    };
  };
  const app = await open({ role: "replica", name: "macbook-pro", phase: "idle", lastSync: new Date().toISOString(), hub: "http://127.0.0.1:49999", hubName: "Casa" }, true);
  assert.deepEqual(app, { glyph: "monitor", name: "macbook-pro", role: "Replica", label: "macbook-pro, Replica, Up to date", first: "status-device", brand: "arca", dot: "status-dot ok" });
  const offline = await open({ role: "hub", name: "casa", phase: "idle", hubUnavailable: true, hub: "", hubName: "" }, true);
  assert.equal(offline.glyph, "server", "the hub is a server even in its desktop app");
  assert.equal(offline.role, "Hub");
  assert.equal(offline.label, "casa, Hub, Offline");
  assert.equal(offline.dot, "status-dot wa");
  const server = await open({ role: "replica", name: "nas", phase: "idle", lastSync: new Date().toISOString(), hub: "http://127.0.0.1:49999", hubName: "Casa" }, false);
  assert.equal(server.glyph, "server", "a replica seen through its own web is a server replica");
  assert.equal(server.role, "Replica");
  assert.equal(server.label, "nas, Replica, Up to date");
});

test("the Search Arca active row stays visible on the dialog surface in dark", () => {
  const tokens = fs.readFileSync(new URL("../apps/desktop/src/tokens.css", import.meta.url), "utf8");
  const css = fs.readFileSync(new URL("../apps/desktop/src/style.css", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const split = tokens.indexOf('\n[data-theme="dark"] {');
  const light = tokens.slice(0, split);
  const dark = tokens.slice(split);
  const value = (block, name) => block.match(new RegExp(`--${name}:\\s*#([0-9a-f]{6})`, "i"))[1].match(/../g).map((h) => parseInt(h, 16));
  const distance = (block, a, b) => Math.hypot(...value(block, a).map((c, i) => c - value(block, b)[i]));
  const fill = (selector) => css.match(new RegExp(`${selector.replace(/[.()]/g, "\\$&")} \\{\\s*background: var\\(--([a-z-]+)\\)`))[1];
  const step = distance(light, "hover", "notice-surface");
  const token = fill(".pal-active");
  assert.ok(distance(dark, token, "notice-surface") >= step, `--${token} is visible on the dark dialog surface`);
  assert.ok(distance(light, token, "notice-surface") >= step, `--${token} is visible on the light dialog surface`);
});

test("the Devices row tagged This device draws the same glyph as the status card", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-self-glyph-"));
  init(home, { port: 0, name: "Local Mac" });
  const daemon = await start(home, { timer: false });
  const requests = new Set();
  const windows = [];
  t.after(async () => {
    await drainRequests(requests);
    for (const window of windows) window.close();
    await daemon.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const open = async (state, native) => {
    const dom = new JSDOM(html, { runScripts: "outside-only", url: native ? "http://tauri.localhost" : "http://127.0.0.1:17831" });
    windows.push(dom.window);
    const w = dom.window;
    w.setInterval = () => 0;
    const reply = (route) => {
      if (route === "/v1/status") return { ...daemon.engine.status(), platform: "darwin", volumes: [], hubUnavailable: false, ...state };
      if (route === "/v1/remote") return { name: "Casa", volumes: [] };
      if (route === "/v1/machines") return { machines: [] };
      return {};
    };
    if (native) {
      w.__TAURI__ = { core: { invoke: async (command, args) => (command === "bootstrap" ? { setup: false } : reply(args.route)) } };
      trackInvoke(w, requests);
    } else
      w.fetch = async (route) => {
        const request = Promise.resolve(new Response(JSON.stringify(reply(String(route).replace(/^https?:\/\/[^/]+/, "").split("?")[0])), { headers: { "Content-Type": "application/json" } }));
        requests.add(request);
        request.finally(() => requests.delete(request));
        return request;
      };
    w.eval(`(async()=>{${script}\n})()`);
    const document = w.document;
    await until(() => !document.querySelector("#status-device").hidden && document.body.getAttribute("aria-busy") === "false");
    document.querySelector('[data-view="devices"]').click();
    await until(() => document.querySelector(".device-row .tag.self"));
    return {
      card: document.querySelector("#status-device").firstElementChild.dataset.icon,
      row: document.querySelector(".device-row .tag.self").closest(".device-row").querySelector(".tile [data-icon]").dataset.icon,
    };
  };
  const replica = { role: "replica", name: "macbook", phase: "idle", lastSync: new Date().toISOString(), hub: "http://127.0.0.1:49999", hubName: "Casa" };
  assert.deepEqual(await open(replica, false), { card: "server", row: "server" }, "a replica's own web draws it as a server in both places");
  assert.deepEqual(await open(replica, true), { card: "monitor", row: "monitor" });
  assert.deepEqual(await open({ role: "hub", name: "casa", phase: "idle", hub: "", hubName: "" }, false), { card: "server", row: "server" });
});

test("the sidebar keeps the status card inside the narrow column and the rail", () => {
  const css = fs.readFileSync(new URL("../apps/desktop/src/style.css", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  assert.doesNotMatch(css, /\.managing\b/);
  const blocks = (width) => [...css.matchAll(new RegExp(`@media \\(max-width: ${width}px\\) \\{([\\s\\S]*?)\\n\\}`, "g"))].map((m) => m[1]).join("\n");
  assert.match(blocks(760), /\.sync-status-heading,\s*#sync-controls \{\s*grid-column: 1 \/ -1;/, "below 760 px the state line takes the card's width and the controls drop below it");
  assert.match(blocks(760), /\.status-device svg \{\s*display: none;/, "below 760 px the device row gives the glyph's room to the name");
  assert.match(blocks(760), /\.status-card \.backup-link > span:last-child \{\s*min-width: 0;\s*overflow: hidden;\s*text-overflow: ellipsis;\s*white-space: nowrap;/, "below 760 px the backup label stays on one line");
  assert.doesNotMatch(css, /\.backup-link > span \{/, "only the label span ellipsizes, never the icon placeholder");
  const kit = fs.readFileSync(new URL("../design/kit.css", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  assert.match(kit, /\.kit-status-narrow \.backup-link > span:last-child \{\s*min-width: 0;\s*overflow: hidden;\s*text-overflow: ellipsis;\s*white-space: nowrap;/, "the kit draws the narrow card with the same rule");
  const rail = blocks(480);
  assert.match(rail, /\.status-device svg \{\s*display: block;/, "the rail keeps the glyph as its only mark");
  assert.match(rail, /\.brand > span,[\s\S]*?display: none;/, "the rail hides the wordmark instead of shrinking it");
  assert.match(rail, /\.status-card > :not\(#status-device\),\s*\.status-device > :not\(svg\):not\(\.status-dot\) \{\s*display: none;/, "the id in :not() outranks #sync-controls without a second selector");
  assert.doesNotMatch(rail, /\.status-card #sync-controls/);
  assert.match(rail, /\.status-dot \{\s*display: block;/);
  assert.match(rail, /\.ghost\.sign-out \{\s*justify-content: center;\s*font-size: 0;/);
  assert.match(css, /\n\.ghost\.sign-out \{\s*justify-content: flex-start;\s*\}/);
  assert.doesNotMatch(css, /\.sign-out \{[^}]*!important/, "specificity, not !important, aligns Sign out");
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

test("the file detail reveals the file on every platform with the platform's own word while the folder header keeps opening the folder", async (t) => {
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
    assert.deepEqual(other.native[0], ["open_file", { volume: volume.id, path: "brief.md", reveal: true }], `${platform}: it reveals the file's own folder`);
  }
});

test("the photo viewer and the native command reveal the file's own folder on every platform", () => {
  const app = fs.readFileSync(new URL("../apps/desktop/src/app.js", import.meta.url), "utf8");
  const viewer = app.slice(app.indexOf('infoPanel.querySelector(".photo-reveal")?.addEventListener'));
  assert.match(viewer.slice(0, 300), /invoke\("open_file", \{\s+volume: state\.volume,\s+path: item\.path,\s+reveal: true,/);
  assert.doesNotMatch(viewer.slice(0, 300), /open_folder|darwin/);
  assert.doesNotMatch(app, /name === "history-reveal-file" && status\.platform/);
  const main = fs.readFileSync(new URL("../apps/desktop/src-tauri/src/main.rs", import.meta.url), "utf8");
  assert.doesNotMatch(main, /only available on macOS/);
  assert.match(main, /raw_arg\(select_argument\(/);
  assert.match(main, /fn reveal_target\(/);
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
  const older = daemon.engine.store.db
    .prepare("SELECT COUNT(*) AS n FROM revisions WHERE rev NOT IN (SELECT rev FROM files)")
    .get().n;
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://tauri.localhost" });
  const requests = new Set();
  t.after(async () => {
    await drainRequests(requests);
    dom.window.close();
    await daemon.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  assert.equal(older, before - 1, "note.txt keeps one current revision");
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
  assert.match(section.querySelector(".setting-row p").textContent, new RegExp(`^${older} kept across your folders\\. Each folder decides how long it keeps them\\.$`));
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
  for (const id of ["#dialog-days", "#dialog-versions"]) {
    const field = w.document.querySelector(id);
    const value = field.value;
    field.value = String(Number(value) + 1);
    field.dispatchEvent(new w.Event("input", { bubbles: true }));
    assert.equal(w.document.querySelector("#retention-preview").innerHTML, "", `editing ${id} clears the counts`);
    assert.equal(w.document.querySelector("#submit-dialog").textContent.trim(), "See the count");
    assert.equal(w.document.querySelector("#submit-dialog").classList.contains("danger"), false);
    field.value = value;
    submit();
    await until(() => w.document.querySelector("#retention-preview .retention-stats"));
    assert.equal(w.document.querySelector("#submit-dialog").textContent.trim(), "Apply cleanup");
  }
  assert.equal(revisions(), changed, "recounting removes nothing");
  const days = w.document.querySelector("#dialog-days");
  const original = days.value;
  days.value = "1";
  days.dispatchEvent(new w.Event("input", { bubbles: true }));
  submit();
  days.value = "2";
  days.dispatchEvent(new w.Event("input", { bubbles: true }));
  await drainRequests(requests);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(w.document.querySelector("#retention-preview").innerHTML, "", "a count for edited fields is not shown");
  assert.equal(w.document.querySelector("#submit-dialog").textContent.trim(), "See the count");
  days.value = original;
  submit();
  await until(() => w.document.querySelector("#retention-preview .retention-stats"));
  submit();
  await until(() => revisions() < changed);
  assert.equal(revisions(), changed - 3, "only the superseded revisions go; the current file stays");
  await until(() => /Cleanup applied\./.test(w.document.querySelector("#notice").textContent));
});

test("the folder summary has three cells: Status, Last change with file and device, Version history, and no Files cell", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-folder-summary-"));
  init(home, { port: 0, name: "Test hub" });
  const daemon = await start(home, { timer: false });
  const busy = daemon.engine.store.addVolume("Busy");
  const quiet = daemon.engine.store.addVolume("Quiet");
  fs.mkdirSync(path.join(busy.path, "notes"));
  fs.writeFileSync(path.join(busy.path, "notes", "brief.md"), "text");
  await daemon.engine.cycle();
  const requests = new Set();
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://tauri.localhost" });
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
      invoke: (command, args) => {
        const work = (async () => {
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
        })();
        requests.add(work);
        work.then(() => requests.delete(work), () => requests.delete(work));
        return work;
      },
    },
  };
  w.eval(`(async()=>{${script}\n})()`);
  await until(() => w.document.querySelector(".folder-card"));
  const open = async (name) => {
    w.document.querySelector('[data-action="back-folders"]')?.click();
    await until(() => [...w.document.querySelectorAll(".folder-card")].length >= 2);
    [...w.document.querySelectorAll(".folder-card")].find((card) => card.textContent.includes(name)).click();
    await until(() => w.document.querySelector(".folder-stats") && w.document.body.getAttribute("aria-busy") === "false");
  };
  const cells = () => [...w.document.querySelectorAll(".folder-stats .stat")].map((cell) => ({
    label: cell.querySelector("span").textContent,
    value: cell.querySelector("strong").textContent,
    note: cell.querySelector("p").textContent,
  }));
  await open("Busy");
  await until(() => w.document.querySelector(".stat-last-change strong")?.textContent === "just now");
  const busyCells = cells();
  assert.deepEqual(busyCells.map((cell) => cell.label), ["Status", "Last change", "Version history"]);
  assert.equal(busyCells[1].note, "brief.md · Test hub");
  assert.equal(busyCells[2].value, "On · 30 days");
  assert.equal(busyCells[2].note, "Older versions kept");
  assert.doesNotMatch(w.document.querySelector(".folder-stats").textContent, /Files|indexed|Latest known/);
  assert.match(w.document.querySelector(".detail-head h1 + p, .detail-head p").textContent, /\d+ files? · /);
  await open("Quiet");
  await until(() => w.document.querySelector(".stat-last-change strong")?.textContent === "No changes yet");
  assert.equal(cells()[1].note, "Accepted by the hub");
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
  assert.equal(own.querySelector(".pill"), null, "this device's sync state stays in the status card");
  assert.equal(own.querySelector(".tile.large").className, "tile large");
  assert.equal(other.querySelector(".pill"), null, "presence never reaches a device row");
  assert.doesNotMatch(other.querySelector(".connection-line").textContent, /last known|192\.168/);
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
  const cell = () => w.document.querySelector("#content .folder-stats .stat-last-change strong")?.textContent;
  const note = () => w.document.querySelector("#content .folder-stats .stat-last-change p")?.textContent;
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
  assert.equal(note(), "Connect to the hub for the newest");
  assert.doesNotMatch(recent(), /No versions yet/);
  const refresh = w.document.createElement("button");
  refresh.dataset.action = "refresh";
  w.document.body.append(refresh);
  saved = false;
  refresh.click();
  await until(() => /No versions yet/.test(recent()));
  assert.equal(cell(), "No changes yet");
  assert.equal(note(), "Accepted by the hub", "a live empty answer is not 'saved'");
  assert.doesNotMatch(recent(), /Connect to the hub to load its history/);
  saved = true;
  refresh.click();
  await until(() => /Offline\. Connect to the hub to load its history\./.test(recent()));
  assert.equal(cell(), "No saved versions");
  assert.equal(note(), "Connect to the hub for the newest", "equal empty pages still repaint when only the saved flag changes");
  await until(() => w.document.body.getAttribute("aria-busy") !== "true");
  await new Promise((resolve) => setTimeout(resolve, 50));
});

test("Folders has no Just arrived row, keeps type icons and shows no path or last file", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-home-live-"));
  init(home, { port: 0, name: "Local Mac" });
  const daemon = await start(home, { timer: false });
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
  const base = { selected: 1, sync: { state: "idle", lastCompleted: new Date().toISOString() }, conflicts: 0, files: 12, bytes: 2048, path: "/Users/javi/arca/x" };
  const volumes = [
    { ...base, id: "photos", name: "photos", gallery: true },
    { ...base, id: "music", name: "music", music: true },
    { ...base, id: "docs", name: "documents", conflicts: 1 },
  ];
  const ago = (ms) => new Date(Date.now() - ms).toISOString();
  const versions = [
    { rev: 9, volume: "photos", path: "2026/IMG_4412.jpg", created: ago(120000), author: "fold", deleted: 0 },
    { rev: 8, volume: "docs", path: "notes/brief.md", created: ago(2 * 3600000), author: "mac", deleted: 0 },
    { rev: 7, volume: "docs", path: "gone.md", created: ago(3 * 3600000), author: "mac", deleted: 1 },
    { rev: 6, volume: "music", path: "Kind of Blue/So What.flac", created: ago(86400000), author: "mac", deleted: 0 },
    { rev: 5, volume: "photos", path: "2026/IMG_1.jpg", created: ago(90000000), author: "fold", deleted: 0 },
  ];
  const routes = [];
  w.__TAURI__ = {
    core: {
      invoke: async (command, args) => {
        if (command === "bootstrap") return { setup: false };
        routes.push(args.route);
        if (args.route === "/v1/status")
          return { ...daemon.engine.status(), role: "replica", phase: "idle", hubId: "hub", hubName: "Casa", hub: "http://127.0.0.1:49999", deviceId: "mac", hubDevices: [{ id: "mac", name: "Local Mac" }, { id: "fold", name: "phone-fold" }], volumes };
        if (args.route === "/v1/remote") return { name: "Casa", volumes };
        if (args.route === "/v1/machines") return { machines: [] };
        if (args.route.startsWith("/v1/activity")) return { versions, next: null };
        if (args.route.startsWith("/v1/gallery/preview")) return { data: "data:image/png;base64,AAAA" };
        if (args.route.startsWith("/v1/music/cover")) return { data: "data:image/jpeg;base64,BBBB" };
        return {};
      },
    },
  };
  trackInvoke(w, requests);
  w.eval(`(async()=>{${script}\n})()`);
  await until(() => w.document.querySelectorAll(".folder-card").length === 3);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(w.document.querySelector(".home-arrival, .home-arrivals"), null, "Folders has no Just arrived row");
  assert.doesNotMatch(w.document.querySelector("#content").textContent, /Just arrived/);
  assert.equal(routes.some((route) => route.startsWith("/v1/activity")), false, "Folders does not fetch history");
  const sections = [...w.document.querySelectorAll("#content .section-label")].map((label) => label.textContent.trim());
  assert.deepEqual(sections.filter((label) => ["Folders", "Photos", "Audio"].includes(label)), ["Folders", "Photos", "Audio"], "folders are grouped by kind");
  const byId = (id) => w.document.querySelector(`.folder-card[data-id="${id}"]`);
  const cards = [byId("photos"), byId("music"), byId("docs")];
  assert.ok(cards[0].querySelector('.home-lead .tile [data-icon="images"], .home-lead .tile svg'), "a photo folder keeps its Images icon");
  assert.ok(cards[1].querySelector('.home-lead .tile [data-icon="music"], .home-lead .tile svg'), "a music folder keeps its Music icon");
  assert.equal(cards[0].querySelector("img"), null, "a folder card never shows file content");
  assert.equal(cards[2].querySelector(".home-ring"), null, "a ring only ever means progress");
  assert.ok(cards[2].querySelector('.home-lead .tile.wa [data-icon="triangle-alert"], .home-lead .tile.wa svg'), "a conflict tints the tile and shows the warning glyph");
  assert.equal(cards[2].querySelector(".meta .state-word.state-wa").textContent, "1 conflict");
  assert.equal(cards[2].querySelector(".pill"), null, "the folder row carries no state pill");
  assert.match(cards[2].getAttribute("aria-label"), /, 1 conflict$/);
  assert.equal(w.document.querySelector(".home-latest"), null, "a card does not name the last file touched");
  for (const card of cards) assert.doesNotMatch(card.textContent, /\/Users\/javi/, "the path lives in the folder detail");
  assert.equal(routes.some((route) => route.startsWith("/v1/folder-previews")), false);
});

test("a paused replica's Devices rows carry roles and full backup, never sync, presence or Linked pills", async (t) => {
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
          return { machines: [{ name: "phone-fold", role: "replica", platform: "android", machineId: "fold", lastAddress: "192.168.1.144", isHub: false }, { name: "umbrel", role: "replica", platform: "linux", machineId: "umbrel", lastAddress: "192.168.1.150", isHub: false, backup: { enabled: true } }] };
        return {};
      },
    },
  };
  w.eval(`(async()=>{${script}\n})()`);
  await until(() => w.document.querySelector(".folder-card"));
  w.document.querySelector('[data-view="devices"]').click();
  await until(() => w.document.querySelectorAll(".device-row").length >= 4);
  const rows = [...w.document.querySelectorAll(".device-row")];
  assert.equal(rows.find((row) => row.querySelector(".tag.self")).querySelector(".pill"), null, "Paused lives in the status card");
  const other = rows.find((row) => /phone-fold/.test(row.textContent));
  assert.equal(other.querySelector(".pill"), null, "no Linked or Offline pill");
  assert.doesNotMatch(other.querySelector(".connection-line").textContent, /last known/);
  assert.equal(other.querySelector(".tag.full-backup"), null, "a device that is not a backup has no full-backup segment");
  assert.equal(other.querySelector(".row-end > .role-set").textContent, "Replica");
  const umbrel = rows.find((row) => /umbrel/.test(row.textContent));
  assert.equal(umbrel.querySelector(".role-set .tag.full-backup").textContent, "Full backup", "the hub's backup server carries the full-backup segment");
  assert.doesNotMatch(w.document.querySelector("#devices-list").textContent, /Backs up hub|Linked/);
});

test("offline, an empty saved History reads its normal empty state and Copies say they are last known", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-offline-wording-"));
  init(home, { port: 0, name: "Local Mac" });
  const daemon = await start(home, { timer: false });
  const volume = daemon.engine.store.addVolume("Docs");
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://tauri.localhost" });
  const w = dom.window;
  const requests = new Set();
  let activity = { offline: true, saved: true, versions: [], next: null };
  t.after(async () => {
    await drainRequests(requests);
    w.close();
    await daemon.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  w.setInterval = () => 0;
  w.__TAURI__ = {
    core: {
      invoke: async (command, args) => {
        if (command === "bootstrap") return { setup: false };
        if (args.route === "/v1/status")
          return { ...daemon.engine.status(), role: "replica", phase: "offline", lastSync: new Date().toISOString(), hubUnavailable: true, hubName: "Casa", hub: "http://127.0.0.1:49999" };
        if (args.route.startsWith("/v1/activity?")) return activity;
        if (args.route === "/v1/machines") return { offline: true, savedAt: 1, machines: [{ name: "Casa", role: "hub", isHub: true, machineId: "hub", folderIds: [volume.id] }] };
        if (args.route === "/v1/remote") return { name: "Casa", volumes: [] };
        return {};
      },
    },
  };
  trackInvoke(w, requests);
  w.eval(`(async()=>{${script}\n})()`);
  await until(() => w.document.querySelector(".folder-card"));
  w.location.hash = "#/history?filter=conflicts";
  w.dispatchEvent(new w.HashChangeEvent("hashchange"));
  await until(() => /No conflicts/.test(w.document.querySelector("#content").textContent));
  assert.doesNotMatch(w.document.querySelector("#content").textContent, /History unavailable offline/);
  activity = { offline: true, versions: [], next: null };
  w.location.hash = "#/history?filter=deleted";
  w.dispatchEvent(new w.HashChangeEvent("hashchange"));
  await until(() => /History unavailable offline/.test(w.document.querySelector("#content").textContent));
  w.location.hash = `#/folders/${volume.id}`;
  w.dispatchEvent(new w.HashChangeEvent("hashchange"));
  await until(() => /Hub unavailable\. Showing last known copies\./.test(w.document.querySelector("#folder-copies")?.textContent || ""));
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
  assert.equal(rows.find((row) => row.querySelector(".tag.self")).querySelector(".pill"), null, "no Syncing pill on Devices");
  const other = rows.find((row) => /phone-fold/.test(row.textContent));
  assert.equal(other.querySelector(".pill"), null, "no Linked pill");
  assert.doesNotMatch(w.document.querySelector("#content").textContent, /last known|showing saved machine information/);
});

async function devicesPage(t, { status, machines, web = "", ready = () => true, discovery = { peers: [], tailscale: { state: "not-installed" } }, prepare, roster }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-device-lines-"));
  init(home, { port: 0, name: "Local Mac" });
  const daemon = await start(home, { timer: false });
  const dom = new JSDOM(html, { runScripts: "outside-only", url: web || "http://tauri.localhost" });
  t.after(async () => {
    dom.window.close();
    await daemon.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const w = dom.window;
  w.setInterval = () => 0;
  const answer = (route) =>
    route === "/v1/status"
      ? { ...daemon.engine.status(), ...status(daemon) }
      : route === "/v1/remote"
        ? { name: "casa", volumes: [] }
        : route === "/v1/machines"
          ? roster?.() || { machines }
          : route === "/v1/discovery"
            ? discovery
            : {};
  if (web) w.fetch = async (route) => new Response(JSON.stringify(answer(String(route).replace(/^https?:\/\/[^/]+/, ""))), { headers: { "Content-Type": "application/json" } });
  else
    w.__TAURI__ = {
      core: {
        invoke: async (command, args) => (command === "bootstrap" ? { setup: false } : answer(args.route)),
      },
    };
  prepare?.(w);
  w.eval(`(async()=>{${script}\n})()`);
  await until(() => w.document.querySelector("#nav, .folder-card, .empty, #devices-list"));
  w.document.querySelector('[data-view="devices"]').click();
  await until(() => w.document.querySelectorAll(".device-entry").length >= machines.length && ready(w.document.querySelector("#devices-list")?.textContent || ""));
  const rows = [...w.document.querySelectorAll("#devices-list .device-entry")];
  const named = (name, list = rows) => list.find((row) => row.querySelector(".row-tags strong").textContent === name);
  const segments = (row) =>
    [...row.querySelectorAll(".device-line .device-segs > span")].map((segment) =>
      segment.children.length ? [...segment.children].map((part) => part.textContent) : segment.textContent,
    );
  const cells = (row) =>
    [...row.querySelectorAll(".device-cells > .device-cell")].map((cell) =>
      cell.children.length > 1 ? [...cell.children].map((part) => part.textContent) : cell.textContent,
    );
  return { w, rows, named, segments, cells };
}
const seenAt = (value) => `Seen ${new Date(value).toLocaleString("en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}`;

test("a replica's device rows read the OS under the name, then version, folders over size and last seen in aligned cells, and end in their role chip", async (t) => {
  const GB = 1024 ** 3;
  const clock = Date.parse("2026-10-11T09:40:00.000Z");
  const at = (seconds) => new Date(clock - seconds * 1000).toISOString();
  let perChild = 40.5,
    fontsLoaded;
  const { w, rows, named, segments, cells } = await devicesPage(t, {
    status: (daemon) => ({
      role: "replica",
      phase: "idle",
      hubName: "casa",
      hubId: "hub",
      hub: "http://127.0.0.1:49999",
      backup: { enabled: false },
      volumes: [
        { id: "a", name: "a", selected: 1, bytes: 2 * GB, files: 1 },
        { id: "b", name: "b", selected: 1, bytes: GB, files: 1 },
        { id: "c", name: "c", selected: 0, bytes: 9 * GB, files: 1 },
      ],
      id: "mac",
    }),
    machines: [
      { isHub: true, name: "casa", role: "hub", platform: "linux", version: "0.7.38", selectedFolders: 9, indexedBytes: 412 * GB, reportedAt: at(0) },
      { name: "Local Mac", role: "replica", platform: process.platform, machineId: "mac", version: "0.7.30", selectedFolders: 2, indexedBytes: 3 * GB, lastContact: at(5000) },
      { name: "umbrel", role: "replica", platform: "linux", machineId: "umbrel", version: "0.7.38-beta.12+build.2026", selectedFolders: 9, indexedBytes: 401 * GB, backup: { enabled: true }, lastContact: at(119), reportedAt: at(900) },
      { name: "Yuri", role: "replica", platform: "android", machineId: "yuri", version: "0.7.35", selectedFolders: 2, indexedBytes: 3 * GB, lastContact: at(4000), reportedAt: at(121) },
      { name: "Fresh", role: "replica", platform: "ios", machineId: "fresh" },
      { name: "Tablet", role: "replica", platform: "android", machineId: "tablet", version: "0.6.99", selectedFolders: 3, indexedBytes: 5 * GB, revoked: true, lastContact: at(90) },
    ],
    ready: (text) => text.includes("Tablet") && text.includes("412.0 GB"),
    prepare: (w) => {
      Object.defineProperty(w.document, "fonts", { value: { ready: new Promise((resolve) => (fontsLoaded = resolve)) } });
      w.Element.prototype.getBoundingClientRect = function () {
        return { width: this.classList.contains("device-end") ? perChild * this.children.length : 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
      };
    },
  });
  assert.equal(rows.length, 6);
  const list = w.document.querySelector("#devices-list .device-list");
  assert.equal(list.style.getPropertyValue("--device-end"), "81px", "every end takes the widest end's width");
  perChild = 50;
  fontsLoaded();
  await until(() => list.style.getPropertyValue("--device-end") === "100px");
  const hub = named("casa");
  assert.deepEqual(segments(hub), ["Linux", "127.0.0.1:49999"], "the name block keeps only the OS and the hub's address");
  assert.deepEqual(cells(hub), ["v0.7.38", ["9 folders", "412.0 GB"], "Connected"]);
  assert.equal(hub.querySelector(".device-seen .status-dot").className, "status-dot", "connected reads the --ok dot");
  assert.deepEqual([...hub.children].map((el) => el.className), ["tile large hub", "row-main", "device-cells", "row-end device-end"], "the cells sit between the name block and the right edge");
  assert.deepEqual([...hub.querySelector(".row-end").children].map((el) => el.className), ["secondary small-button danger", "role-set"], "Disconnect… sits just before the chip");
  assert.equal(hub.querySelector(".role-set").innerHTML, '<span class="tag hub">Hub</span>');
  const own = rows.find((row) => row.querySelector(".tag.self"));
  assert.deepEqual(segments(own), [{ darwin: "macOS", linux: "Linux", win32: "Windows" }[process.platform]]);
  const running = /const APP_VERSION = "([^"]+)";/.exec(fs.readFileSync(new URL("../apps/desktop/src/app.js", import.meta.url), "utf8"))[1];
  assert.deepEqual(cells(own), [`v${running}`, ["2 folders", "3.0 GB"], "Connected"], "only selected folders count, this device runs its own version and is always Connected");
  assert.equal(own.querySelector(".role-set").textContent, "Replica");
  assert.deepEqual(segments(named("umbrel")), ["Linux"]);
  assert.deepEqual(cells(named("umbrel")), ["v0.7.38", ["9 folders", "401.0 GB"], "Connected"], "the freshest of last contact and report decides, within two minutes of the hub's clock");
  assert.equal(named("umbrel").querySelector(".device-older"), null, "a current version is shown without the warning");
  const suffixed = named("umbrel").querySelector(".device-version > span");
  assert.equal(suffixed.dataset.tooltip, "v0.7.38-beta.12+build.2026", "the cell shows the x.y.z core and keeps the full version in its tooltip");
  assert.equal(suffixed.getAttribute("aria-label"), "v0.7.38-beta.12+build.2026");
  assert.equal(named("umbrel").querySelector(".role-set").textContent, "ReplicaFull backup");
  assert.ok(named("umbrel").querySelector('.tag.full-backup [data-icon="shield-check"], .tag.full-backup svg'));
  const yuri = named("Yuri");
  assert.deepEqual(segments(yuri), ["Android"]);
  assert.deepEqual(cells(yuri), ["v0.7.35", ["2 folders", "3.0 GB"], seenAt(at(121))]);
  assert.equal(yuri.querySelector(".device-seen .status-dot").className, "status-dot id", "not connected reads the grey dot");
  const version = yuri.querySelector(".device-version .device-older");
  assert.equal(version.dataset.tooltip, "Older than the hub’s v0.7.38");
  assert.equal(version.getAttribute("aria-label"), "v0.7.35, older than the hub’s v0.7.38");
  assert.ok(version.querySelector('[data-icon="circle-arrow-up"], svg'), "an older version carries the up-arrow");
  assert.deepEqual(segments(named("Fresh")), ["iOS"]);
  assert.deepEqual(cells(named("Fresh")), ["", "", ""], "an unreported device leaves its cells empty, never 0");
  const tablet = named("Tablet");
  assert.deepEqual(cells(tablet), ["v0.6.99", ["3 folders", "5.0 GB"], seenAt(at(90))], "a removed device never reads Connected");
  assert.equal(tablet.querySelector(".device-older"), null, "a removed device never shows the up-arrow");
  assert.deepEqual([...tablet.querySelector(".row-end").children].map((el) => el.className), ["pill er", "role-set"], "Removed sits just before the chip");
  assert.ok(tablet.querySelector(".tile.large.er"));
  for (const row of rows) {
    assert.equal(row.querySelector(".row-end").lastElementChild.className, "role-set", "every row ends in its role chip");
    assert.ok(row.querySelector(".row-end").classList.contains("device-end"));
    assert.ok(row.querySelector(".connection-line").classList.contains("device-line"));
  }
  assert.doesNotMatch(w.document.querySelector("#devices-list").textContent, /Linked|Backs up hub|Syncing|Up to date|Offline|Running| local/);
});

test("with the hub unreachable a replica's saved rows never read Connected, and the hub row shows when it was last reached", async (t) => {
  const clock = Date.parse("2026-10-11T09:40:00.000Z");
  const at = (seconds) => new Date(clock - seconds * 1000).toISOString();
  const { named, cells } = await devicesPage(t, {
    status: () => ({ role: "replica", phase: "offline", hubUnavailable: true, hubName: "casa", hubId: "hub", hub: "http://127.0.0.1:49999", backup: { enabled: false }, volumes: [], id: "mac" }),
    machines: [
      { isHub: true, name: "casa", role: "hub", platform: "linux", version: "0.7.38", selectedFolders: 1, indexedBytes: 1024, reportedAt: at(30) },
      { name: "Local Mac", role: "replica", platform: process.platform, machineId: "mac", lastContact: at(0) },
      { name: "umbrel", role: "replica", platform: "linux", machineId: "umbrel", version: "0.7.38", lastContact: at(5) },
    ],
    ready: (text) => text.includes("umbrel") && text.includes("1.0 KB"),
  });
  assert.equal(cells(named("casa"))[2], seenAt(at(0)), "the replica's own last contact is its last successful hub request");
  assert.equal(cells(named("umbrel"))[2], seenAt(at(5)));
  assert.equal(cells(named("Local Mac"))[2], "Connected", "this device is always Connected");
});

test("presence ages while Devices stays open: a quiet timer rereads the roster, time advances between reads, and leaving stops it", async (t) => {
  const clock = Date.parse("2026-10-11T09:40:00.000Z");
  const at = (seconds) => new Date(clock - seconds * 1000).toISOString();
  let elapsed = 0,
    failing = false,
    reads = 0;
  const timers = [],
    cleared = [];
  const machines = [
    { isHub: true, name: "casa", role: "hub", platform: "linux", version: "0.7.38", selectedFolders: 1, indexedBytes: 1024, reportedAt: at(0) },
    { credentialId: "mac", name: "macbook-pro", platform: "darwin", version: "0.7.38", selectedFolders: 1, indexedBytes: 1024 },
  ];
  const { w, cells } = await devicesPage(t, {
    status: () => ({
      role: "hub",
      name: "casa",
      platform: "linux",
      phase: "idle",
      volumes: [{ id: "a", name: "a", selected: 1, bytes: 1024, files: 1 }],
      devices: [{ id: "mac", name: "macbook-pro", role: "replica", last_seen: at(10), last_address: "100.84.10.2", backup_enabled: null, revoked: 0 }],
    }),
    machines,
    roster: () => {
      reads++;
      if (failing) throw new Error("timed out");
      return { machines };
    },
    prepare: (w) => {
      w.performance.now = () => elapsed;
      w.setInterval = (run, ms) => timers.push({ run, ms });
      w.clearInterval = (id) => cleared.push(id);
    },
    ready: (text) => /macbook-promacOSv0\.7\.38/.test(text),
  });
  const mac = () => [...w.document.querySelectorAll("#devices-list .device-entry")].find((row) => /macbook-pro/.test(row.textContent));
  assert.equal(cells(mac())[2], "Connected");
  const watch = timers.findIndex((timer) => timer.ms === 30000);
  assert.ok(watch >= 0, "Devices rereads the roster every 30 seconds");
  failing = true;
  elapsed = 111000;
  const before = reads;
  await timers[watch].run();
  assert.equal(reads, before + 1);
  await until(() => cells(mac())[2] === `Seen ${new Date(at(10)).toLocaleString("en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}`);
  w.document.querySelector('[data-view="folders"]').click();
  await until(() => cleared.includes(watch + 1));
  const after = reads;
  await timers[watch].run();
  assert.equal(reads, after, "a stopped watch reads nothing");
});

test("after the computer sleeps the hub connection row ages by the wall clock too, so it never reads Connected on wake", async (t) => {
  const clock = Date.parse("2026-10-11T09:40:00.000Z");
  const { w } = await devicesPage(t, {
    status: () => ({ role: "replica", phase: "idle", hubName: "casa", hubId: "hub", hub: "http://127.0.0.1:49999", backup: { enabled: false }, volumes: [], id: "mac" }),
    machines: [
      { isHub: true, name: "casa", role: "hub", platform: "linux", version: "0.7.38", selectedFolders: 1, indexedBytes: 1024, reportedAt: new Date(clock).toISOString() },
      { name: "Local Mac", role: "replica", platform: process.platform, machineId: "mac", lastContact: new Date(clock).toISOString() },
    ],
    prepare: (w) => {
      w.performance.now = () => 0;
    },
    ready: (text) => text.includes("1.0 KB"),
  });
  const hubSeen = () => w.document.querySelector("#content .device-entry .device-seen")?.textContent;
  const wall = w.Date.now.bind(w.Date);
  w.Date.now = () => wall() + 600000;
  w.document.querySelector('[data-view="settings"]').click();
  await until(() => hubSeen() !== undefined);
  assert.equal(hubSeen(), "", "the monotonic clock paused in sleep, the wall clock did not");
});

function devicesWatchHarness() {
  const timers = [],
    cleared = [];
  return {
    timers,
    cleared,
    install(w) {
      w.setInterval = (run, ms) => timers.push({ run, ms });
      w.clearInterval = (id) => cleared.push(id);
    },
    watches: () => timers.flatMap((timer, index) => (timer.ms === 30000 ? [index + 1] : [])),
    tick: (id) => timers[id - 1].run(),
  };
}
const hubDevicesStatus = (clock) => ({
  role: "hub",
  name: "casa",
  platform: "linux",
  phase: "idle",
  volumes: [{ id: "a", name: "a", selected: 1, bytes: 1024, files: 1 }],
  devices: [{ id: "mac", name: "macbook-pro", role: "replica", last_seen: new Date(clock).toISOString(), last_address: "100.84.10.2", backup_enabled: null, revoked: 0 }],
});
const hubRoster = (clock, version = "0.7.38") => [
  { isHub: true, name: "casa", role: "hub", platform: "linux", version: "0.7.38", selectedFolders: 1, indexedBytes: 1024, reportedAt: new Date(clock).toISOString() },
  { credentialId: "mac", name: "macbook-pro", platform: "darwin", version, selectedFolders: 1, indexedBytes: 1024 },
];

test("the Devices watch draws nothing over the Service stopped page and stops with it", async (t) => {
  const clock = Date.parse("2026-10-11T09:40:00.000Z");
  const harness = devicesWatchHarness();
  let down = false,
    reads = 0;
  const { w } = await devicesPage(t, {
    status: () => {
      if (down) throw "The daemon is unavailable. Use Start service.";
      return hubDevicesStatus(clock);
    },
    machines: hubRoster(clock),
    roster: () => {
      reads++;
      return { machines: hubRoster(clock) };
    },
    prepare: harness.install,
    ready: (text) => /macbook-promacOSv0\.7\.38/.test(text),
  });
  const [watch] = harness.watches();
  const poll = harness.timers.find((timer) => timer.ms === 5000);
  down = true;
  await poll.run();
  const content = w.document.querySelector("#content");
  await until(() => /Service stopped/.test(content.textContent));
  assert.ok(harness.cleared.includes(watch), "showing the stopped page stops the watch");
  const before = reads;
  await harness.tick(watch);
  assert.match(content.textContent, /Service stopped/, "a late tick never redraws the old roster");
  assert.equal(reads, before);
});

test("after the web session ends the Devices watch stops and a late tick reads nothing", async (t) => {
  const clock = Date.parse("2026-10-11T09:40:00.000Z");
  const harness = devicesWatchHarness();
  let expired = false,
    reads = 0;
  const { w } = await devicesPage(t, {
    web: "http://192.168.1.10:17831/#/machines",
    status: () => hubDevicesStatus(clock),
    machines: hubRoster(clock),
    roster: () => {
      reads++;
      return { machines: hubRoster(clock) };
    },
    prepare: (w) => {
      harness.install(w);
      const original = w.fetch;
      w.fetch = async (route, options) =>
        expired && /\/v1\/status/.test(String(route))
          ? new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } })
          : original(route, options);
    },
    ready: (text) => /macbook-promacOSv0\.7\.38/.test(text),
  });
  const [watch] = harness.watches();
  expired = true;
  w.document.querySelector('[data-view="devices"]').click();
  await until(() => w.document.body.classList.contains("access-mode"));
  assert.ok(harness.cleared.includes(watch), "showing the login stops the watch");
  const before = reads;
  await harness.tick(watch);
  assert.equal(reads, before, "nothing reads the roster, or status.role on a null status");
  assert.equal(w.document.querySelector("#devices-list"), null);
});

test("the Devices watch keeps an open dialog, menu, pressed pointer or focused control and runs one interval per visit", async (t) => {
  const clock = Date.parse("2026-10-11T09:40:00.000Z");
  const harness = devicesWatchHarness();
  let version = "0.7.38";
  const { w } = await devicesPage(t, {
    status: () => hubDevicesStatus(clock),
    machines: hubRoster(clock),
    roster: () => ({ machines: hubRoster(clock, version) }),
    prepare: harness.install,
    ready: (text) => /macbook-promacOSv0\.7\.38/.test(text),
  });
  assert.equal(harness.watches().length, 1, "repeated renders of Devices share one interval");
  const [watch] = harness.watches();
  const shown = () => w.document.querySelector("#devices-list")?.textContent || "";
  const dialog = w.document.querySelector("#dialog");
  const menu = () => w.document.querySelector("#devices-list .details-menu");
  const control = () => w.document.querySelector('#content [data-action="invite"]');
  const gates = [
    ["dialog", () => dialog.setAttribute("open", ""), () => dialog.removeAttribute("open")],
    ["menu", () => (menu().open = true), () => (menu().open = false)],
    ["pointer", () => w.dispatchEvent(new w.Event("pointerdown")), () => w.dispatchEvent(new w.Event("pointerup"))],
    ["focus", () => control().focus(), () => control().blur()],
  ];
  for (const [name, hold, release] of gates) {
    version = version === "0.7.38" ? "0.7.37" : "0.7.38";
    hold();
    const focused = name === "focus" && control();
    if (focused) assert.equal(w.document.activeElement, focused);
    const before = shown();
    await harness.tick(watch);
    assert.equal(shown(), before, `${name}: no redraw`);
    if (focused) assert.equal(w.document.activeElement, focused, "focus is kept");
    release();
    await harness.tick(watch);
    assert.match(shown(), new RegExp(`macbook-promacOSv${version.replaceAll(".", "\\.")}`), `${name}: redraws once released`);
  }
  w.document.querySelector('[data-view="folders"]').click();
  await until(() => harness.cleared.includes(watch));
  w.document.querySelector('[data-view="devices"]').click();
  await until(() => harness.watches().length === 2);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(harness.watches().length, 2, "re-entering Devices starts exactly one new interval");
});

test("away from Devices the hub connection row leaves last seen out once its roster is older than two minutes", async (t) => {
  const clock = Date.parse("2026-10-11T09:40:00.000Z");
  let elapsed = 0;
  const { w } = await devicesPage(t, {
    status: () => ({ role: "replica", phase: "idle", hubName: "casa", hubId: "hub", hub: "http://127.0.0.1:49999", backup: { enabled: false }, volumes: [], id: "mac" }),
    machines: [
      { isHub: true, name: "casa", role: "hub", platform: "linux", version: "0.7.38", selectedFolders: 1, indexedBytes: 1024, reportedAt: new Date(clock).toISOString() },
      { name: "Local Mac", role: "replica", platform: process.platform, machineId: "mac", lastContact: new Date(clock).toISOString() },
    ],
    prepare: (w) => {
      w.performance.now = () => elapsed;
    },
    ready: (text) => text.includes("1.0 KB"),
  });
  const hubSeen = () => w.document.querySelector("#content .device-entry .device-seen")?.textContent;
  w.document.querySelector('[data-view="settings"]').click();
  await until(() => /Hub connection/i.test(w.document.querySelector("#content").textContent) && hubSeen() !== undefined);
  assert.equal(hubSeen(), "Connected", "a fresh roster still answers");
  elapsed = 120000;
  w.document.querySelector('[data-view="folders"]').click();
  await until(() => !w.document.querySelector("#content .device-entry"));
  w.document.querySelector('[data-view="settings"]').click();
  await until(() => hubSeen() !== undefined);
  assert.equal(hubSeen(), "", "a stale roster leaves the cell empty rather than claim Connected");
});

test("the hub's own Devices page draws its row like the others, keeps ⋯ before each chip and reads presence from last contact", async (t) => {
  const GB = 1024 ** 3;
  const clock = Date.parse("2026-10-11T09:40:00.000Z");
  const at = (seconds) => new Date(clock - seconds * 1000).toISOString();
  const now = at(10);
  const { w, named, segments, cells } = await devicesPage(t, {
    status: () => ({
      role: "hub",
      name: "casa",
      platform: "linux",
      phase: "idle",
      volumes: [{ id: "a", name: "a", selected: 1, bytes: 4 * GB, files: 1 }],
      devices: [
        { id: "mac", name: "macbook-pro", role: "replica", last_seen: now, last_address: "100.84.10.2", backup_enabled: null, revoked: 0 },
        { id: "umbrel", name: "umbrel", role: "replica", last_seen: at(600), last_address: "100.70.3.9", backup_enabled: 1, revoked: 0 },
        { id: "tablet", name: "Tablet", role: "replica", last_seen: at(7200), last_address: "100.88.7.30", backup_enabled: null, revoked: 1 },
        { id: "new", name: "new-laptop", role: "replica", last_seen: null, last_address: null, backup_enabled: null, revoked: 0 },
      ],
    }),
    machines: [
      { isHub: true, name: "casa", role: "hub", platform: "linux", version: "0.7.38", selectedFolders: 1, indexedBytes: 4 * GB, reportedAt: at(0) },
      { credentialId: "mac", name: "macbook-pro", platform: "darwin", version: "0.7.36", selectedFolders: 9, indexedBytes: 36 * GB },
      { credentialId: "umbrel", name: "umbrel", platform: "linux", version: "0.7.38", selectedFolders: 9, indexedBytes: 401 * GB },
      { credentialId: "tablet", name: "Tablet", platform: "android" },
    ],
    ready: (text) => text.includes("100.99.29.84") && text.includes("v0.7.36"),
    discovery: {
      tailscale: { state: "connected", self: { addresses: ["100.99.29.84"] } },
      peers: [{ id: "p1", name: "macbook-pro", addresses: ["100.84.10.2"], online: false, os: "macOS", arca: { id: "x", role: "replica", state: "linked" } }],
    },
  });
  const hub = named("casa");
  assert.ok(hub.querySelector(".tag.self"));
  assert.deepEqual(segments(hub), ["Linux", "Tailscale", "100.99.29.84"]);
  assert.deepEqual(cells(hub), ["v0.7.38", ["1 folder", "4.0 GB"], "Connected"]);
  assert.equal(hub.querySelector(".row-end").children.length, 1, "no Running pill");
  assert.equal(hub.querySelector(".role-set").innerHTML, '<span class="tag hub">Hub</span>');
  const mac = named("macbook-pro");
  assert.deepEqual(segments(mac), ["macOS"]);
  assert.deepEqual(cells(mac), ["v0.7.36", ["9 folders", "36.0 GB"], "Connected"]);
  assert.ok(mac.querySelector(".device-version .device-older"));
  assert.deepEqual(cells(named("umbrel")), ["v0.7.38", ["9 folders", "401.0 GB"], seenAt(at(600))]);
  assert.deepEqual(cells(named("Tablet")), ["", "", seenAt(at(7200))], "a removed device keeps when it was last seen");
  assert.deepEqual(cells(named("new-laptop")), ["", "", ""], "an invitation never seen leaves its cells empty");
  assert.deepEqual([...named("new-laptop").querySelector(".row-end").children].map((el) => el.className), ["pill wa", "details-menu", "role-set"]);
  assert.deepEqual([...mac.querySelector(".row-end").children].map((el) => el.className), ["details-menu", "role-set"], "⋯ sits just before the chip");
  assert.equal(mac.querySelector(".pill"), null, "a peer Tailscale reports down shows no Offline pill");
  assert.equal(named("umbrel").querySelector(".role-set").textContent, "ReplicaFull backup");
  assert.deepEqual([...named("Tablet").querySelector(".row-end").children].map((el) => el.className), ["pill er", "role-set"]);
  assert.doesNotMatch(w.document.querySelector("#devices-list").textContent, /Linked|Backs up hub|Running|Offline|100\.84\.10\.2/);
});

test("a LAN hub's own web page shows the address it is reached at, in host form", async (t) => {
  const GB = 1024 ** 3;
  const { named, segments } = await devicesPage(t, {
    web: "http://192.168.1.10:17831/#/machines",
    status: () => ({ role: "hub", name: "casa", platform: "linux", phase: "idle", volumes: [{ id: "a", name: "a", selected: 1, bytes: GB, files: 1 }], devices: [] }),
    machines: [{ isHub: true, name: "casa", role: "hub", platform: "linux", version: "0.7.38", selectedFolders: 1, indexedBytes: GB }],
    ready: (text) => text.includes("192.168.1.10"),
  });
  assert.deepEqual(segments(named("casa")), ["Linux", "192.168.1.10:17831"]);
});

test("a backup connection's hub row names its address in host form, without the scheme", async (t) => {
  const { named, segments, cells } = await devicesPage(t, {
    status: () => ({ role: "backup", phase: "idle", hub: "http://192.168.1.10:17831", hubName: "casa", hubId: "hub", backup: { enabled: false }, volumes: [] }),
    machines: [{ isHub: true, name: "casa", role: "hub", platform: "linux", version: "0.7.38", selectedFolders: 1, indexedBytes: 1024 }],
    ready: (text) => text.includes("1.0 KB"),
  });
  assert.deepEqual(segments(named("casa")), ["Linux", "192.168.1.10:17831"]);
  assert.deepEqual(cells(named("casa")).slice(0, 2), ["v0.7.38", ["1 folder", "1.0 KB"]]);
});

test("device lines wrap between segments and never ellipsize", () => {
  const style = fs.readFileSync(new URL("../apps/desktop/src/style.css", import.meta.url), "utf8");
  const rule = (selector) => {
    const at = style.indexOf(`\n${selector} {`);
    assert.ok(at >= 0, selector);
    return style.slice(at, style.indexOf("}", at));
  };
  const line = rule(".device-row .connection-line.device-line");
  assert.match(line, /white-space: normal;/);
  assert.match(line, /text-overflow: clip;/);
  assert.match(line, /overflow: hidden;/);
  assert.match(rule(".device-segs"), /flex-wrap: wrap;\s+margin-left: calc\(var\(--space-3\) \* -1\);/, "a wrapped line hides its leading separator");
  assert.match(rule(".device-segs > span"), /white-space: nowrap;/, "never mid-segment");
  assert.match(rule(".device-row .row-end.device-end"), /flex: none;[\s\S]*margin-left: auto;/, "the chip column stays right-aligned, on its own line under 760px");
  assert.match(rule(".device-row.device-entry .row-main"), /max-width: calc\(100% - var\(--detail-tile\) - var\(--space-3\)\);/, "a wrapping row keeps its name and line beside the tile");
});

test("device cells are fixed-width caption columns after a fixed name block, so they align from row to row", () => {
  const style = fs.readFileSync(new URL("../apps/desktop/src/style.css", import.meta.url), "utf8");
  const rule = (selector) => {
    const at = style.indexOf(`\n${selector} {`);
    assert.ok(at >= 0, selector);
    return style.slice(at, style.indexOf("}", at));
  };
  assert.match(rule(".device-row.device-entry > .row-main"), /flex: 1 1 160px;\s+min-width: 160px;\s+max-width: 240px;/);
  assert.match(style, /\n\.device-list \{\n  container-type: inline-size;\n\}/, "rows query their list's width");
  assert.match(rule(".device-list .device-row .row-end.device-end"), /width: var\(--device-end, auto\);/, "every row's end takes the widest end of the page, so the columns align");
  assert.match(rule(".device-cells"), /flex: none;/);
  assert.match(rule(".device-cell"), /font-size: var\(--text-caption\);[\s\S]*color: var\(--soft\);[\s\S]*white-space: nowrap;/);
  assert.match(rule(".device-cell.device-version"), /width: 72px;/);
  assert.match(rule(".device-cell.device-folders"), /width: 80px;/);
  assert.match(rule(".device-cell.device-seen"), /width: 136px;/);
  assert.match(rule(".device-folders > .device-size"), /color: var\(--mute\);/);
  assert.match(rule(".device-older"), /color: var\(--waFg\);/);
  assert.match(rule(".device-older svg"), /width: var\(--pill-icon\);/);
  assert.match(rule(".device-seen .status-dot"), /display: block;\s+position: static;/, "the presence dot shows at every width");
  const narrow = style.slice(style.indexOf("@container (max-width: 580px) {"), style.indexOf("\n}\n", style.indexOf("@container (max-width: 580px) {")));
  assert.match(narrow, /\.device-cells \{[^}]*flex-wrap: wrap;[^}]*margin-left: calc\(var\(--detail-tile\) \+ var\(--space-3\)\);/, "a narrow list moves the cells under the name, beside the tile column");
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
  const blocked = (control) => control.getAttribute("aria-disabled") === "true";
  await until(() => extra.every((control) => !blocked(control)) && !blocked(gallery));
  offline = true;
  w.document.querySelector('[data-view="folders"]').click();
  await until(() => extra.every(blocked) && blocked(gallery));
  assert.ok(extra.every((control) => /Needs the hub/.test(control.dataset.tooltip) && !control.disabled && !control.title));
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
  const filtersBefore = historyQuery(".history-filters");
  historyQuery('[data-action="history-filter"][data-id="conflicts"]').click();
  await until(
    () =>
      historyQuery('[data-id="conflicts"]').getAttribute("aria-pressed") ===
        "true" && historyIdle(),
  );
  assert.equal(historyQuery(".history-filters"), filtersBefore, "a filter changes the list in place, without redrawing the page");
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
  await until(() => q(".folder-card .home-ring"));
  assert.equal(q(".folder-card .meta").textContent, "402 / 1,269 files sent · 4.0 GB / 14.0 GB · IMG_0042.jpg");
  assert.equal(q(".folder-card .home-lead").getAttribute("aria-label"), "Files sent: 402 of 1,269");
  assert.equal(q(".folder-card .home-ring-fill").getAttribute("stroke-dasharray"), "32 100", "a ring around the tile fills with files sent");
  assert.equal(q(".folder-card progress"), null, "the ring replaces the bar");
  progress = { volume: volume.id, stage: "receive", direction: "download", path: "IMG_0100.jpg", filesDone: 3, filesTotal: null, sizeDone: 0, sizeTotal: 0, bytesDone: 1024, bytesTotal: 2048 };
  await poll();
  await until(() => /checked/.test(q(".folder-card .meta").textContent));
  assert.equal(q(".folder-card .meta").textContent, "3 files checked · IMG_0100.jpg · 1.0 KB / 2.0 KB");
  assert.equal(q(".folder-card .home-ring"), null, "an indeterminate cycle draws no ring");
  assert.equal(q(".folder-card progress"), null);
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
  assert.equal(
    w.document.querySelector("#devices-list .device-entry.device-row .pill"),
    null,
    "this device's sync state stays in the status card",
  );
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
  assert.equal(
    w.document.querySelector("#devices-list .device-row .role-set .tag.full-backup").textContent,
    "Full backup",
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
    assert.doesNotMatch(row.textContent, /192\.168\.1\.171/, "only the hub row carries an address");
    assert.match(row.querySelector(".device-line").textContent, /Android/);
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

test("a version preview that waits on the hub shows a clock whose tooltip and label carry the hub's answer", async () => {
  const dom = new JSDOM('<div id="host"></div>', { runScripts: "outside-only" });
  const w = dom.window;
  try {
    w.eval(fs.readFileSync(new URL("../apps/desktop/src/vendor/lucide.js", import.meta.url), "utf8"));
    const answers = {
      slow: new Error("The hub took too long to prepare this preview. Try again."),
      down: new Error("Hub unavailable. Try again when it is reachable."),
      gone: new Error("This photo is no longer available"),
    };
    w.escape = (value) => String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
    w.icon = (name) => `<span data-icon="${name}" aria-hidden="true"></span>`;
    w.cachedPhoto = (route) => {
      const hash = new URLSearchParams(route.split("?")[1]).get("hash");
      return hash in answers
        ? Promise.reject(answers[hash])
        : Promise.resolve({ data: "data:image/gif;base64,R0lGODlhAQABAAAAACw=" });
    };
    w.IntersectionObserver = class {
      constructor(callback) {
        this.callback = callback;
      }
      observe(target) {
        this.callback([{ isIntersecting: true, target }]);
      }
      unobserve() {}
      disconnect() {}
    };
    w.eval(
      script.slice(script.indexOf("function rowPreview("), script.indexOf("function pill(")) +
        "\nwindow.__mount = mountRowPreviews; window.__preview = rowPreview;",
    );
    const host = w.document.querySelector("#host");
    host.innerHTML = ["slow", "down", "gone", "ok"]
      .map((hash, rev) => `<div class="history-row">${w.__preview({ volume: "v", path: "a.jpg", hash, rev }, "git-commit-horizontal", true)}</div>`)
      .join("");
    w.__mount();
    await until(() => host.querySelectorAll(".row-preview.is-failed").length === 2);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const states = [...host.querySelectorAll(".row-preview")].map((el) => ({
      failed: el.classList.contains("is-failed"),
      tooltip: el.querySelector(".row-preview-status").dataset.tooltip,
      label: el.querySelector(".row-preview-status").getAttribute("aria-label"),
      clock: /12 6 12 12 16 14/.test(el.querySelector(".row-preview-status").innerHTML),
      role: el.querySelector(".row-preview-status").getAttribute("role"),
    }));
    assert.deepEqual(states.map((s) => s.failed), [true, true, false, false]);
    assert.equal(states[0].tooltip, answers.slow.message);
    assert.equal(states[0].label, answers.slow.message);
    assert.equal(states[1].tooltip, answers.down.message);
    assert.equal(states[0].clock && states[1].clock, true, "the status shows a clock");
    assert.equal(states[0].role, "img", "the label is exposed to assistive technology");
    assert.equal(states[2].clock, false);
    assert.equal(states[2].tooltip, undefined, "an answer that is not about the hub keeps the plain placeholder");
    assert.equal(states[3].tooltip, undefined, "a preview that loaded is untouched");
  } finally {
    w.close();
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
  const requests = new Set();
  trackInvoke(w, requests);
  t.after(async () => {
    for (const gate of gates.values()) gate.release();
    await drainRequests(requests);
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
  assert.ok(retention.querySelector(".segmented.segmented-fill"), "the five choices use the fill variant");
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
    ["enable-gallery", "enable-music", "rename-share", "edit-ignore"],
    "configuration actions live in the menu",
  );
  assert.deepEqual(
    [...w.document.querySelectorAll(".heading-actions > [data-action]")].map((el) => el.dataset.action),
    ["favorite-toggle", "open"],
    "the header keeps the Favorites star and the daily action alone",
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
  assert.match(
    w.document.querySelector("#dialog").textContent,
    /Erase this hub and all its folders\?/,
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
    ".folder-stats .stat-last-change strong",
  ).textContent;
  assert.match(revision, /^(just now|\d+ min ago|\d+ h ago)$/);
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
    w.document.querySelector(".folder-stats .stat-last-change strong")
      .textContent,
    revision,
  );
  assert.equal(
    w.document.querySelectorAll(".detail-revisions .scaffold-row").length,
    0,
  );
  await until(() => w.document.querySelector(".brand-mark.is-busy .brand-door"));
  assert.equal(w.document.querySelector(".brand-mark .busy-grid"), null, "the mark stays whole; only its door breathes");
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
    w.document.querySelector(".folder-stats .stat-last-change strong")
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
      w.document.querySelector(".folder-stats .stat-last-change .scaffold-line"),
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

test("the Last change cell says Not available when nothing could be read and recovers on the next answer", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-last-change-failed-"));
  init(home, { port: 0 });
  const daemon = await start(home, { timer: false });
  const volume = daemon.engine.store.addVolume("Failing recent");
  fs.writeFileSync(path.join(volume.path, "local.txt"), "on disk");
  await daemon.engine.cycle();
  const w = new JSDOM(html, {
    runScripts: "outside-only",
    url: "http://tauri.localhost",
  }).window;
  w.setInterval = () => 0;
  let fail = true;
  const pending = new Set();
  w.__TAURI__ = {
    core: {
      invoke: async (command, args) => {
        if (command === "bootstrap")
          return { setup: false, status: daemon.engine.status() };
        if (command !== "api") throw new Error(command);
        const work = (async () => {
          if (fail && args.route.startsWith("/v1/activity?volume="))
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
    await drainRequests(pending);
    w.close();
    await daemon.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const click = (action, id) =>
    w.document
      .querySelector(`[data-action="${action}"]${id ? `[data-id="${id}"]` : ""}`)
      .click();
  const idle = () => w.document.body.getAttribute("aria-busy") === "false";
  const cell = () => w.document.querySelector(".folder-stats .stat-last-change");
  await w.eval(`(async()=>{${script}\n})()`);
  click("folder-detail", volume.id);
  await until(() => idle() && cell() && /Not available/.test(cell().textContent));
  assert.match(cell().textContent, /Try again when the hub is reachable/);
  click("back-folders");
  await until(idle);
  fail = false;
  click("folder-detail", volume.id);
  await until(() => idle() && /^(just now|\d+ min ago|\d+ h ago)$/.test(cell()?.querySelector("strong").textContent));
  assert.doesNotMatch(cell().textContent, /Not available/);
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
    w.document.querySelector(".folder-stats .stat-last-change .scaffold-line"),
  );
  release();
  await until(() =>
    /^(just now|\d+ min ago|\d+ h ago)$/.test(
      w.document.querySelector(".folder-stats .stat-last-change strong")
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
  const page = w.document.querySelector("#content .page");
  const row = w.document.querySelector(".browser-file-row");
  for (const release of releases.splice(0)) release();
  await until(() =>
    /^(just now|\d+ min ago|\d+ h ago)$/.test(
      w.document.querySelector(".folder-stats .stat-last-change strong")
        ?.textContent || "",
    ),
  );
  assert.equal(w.document.querySelector("#content .page"), page);
  assert.equal(w.document.querySelector(".browser-file-row"), row, "the file list is not rebuilt");
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

test("a replica names its own changes and the hub's other devices instead of Device ids", async (t) => {
  const dom = new JSDOM(html, {
    runScripts: "outside-only",
    url: "http://localhost",
  });
  const w = dom.window;
  w.setInterval = () => 0;
  await w.eval(
    `(async()=>{${script.replace("await action(boot);", "")}\nstatus = { id: "local", name: "macbook-pro", deviceId: "mine", hubId: "hub", hubName: "casa", devices: [], hubDevices: [{ id: "mine", name: "macbook-pro" }, { id: "fold", name: "phone-fold" }] }; window.author = authorName; window.disposeNotices = () => noticeStore.dispose();})()`,
  );
  t.after(() => {
    w.disposeNotices();
    w.close();
  });
  assert.equal(w.author("mine"), "macbook-pro");
  assert.equal(w.author("local"), "macbook-pro");
  assert.equal(w.author("hub"), "casa");
  assert.equal(w.author("fold"), "phone-fold");
  assert.equal(w.author("0123456789abcdef"), "Device 01234567");
  assert.equal(w.author(null), "Device null");
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
    await until(() => /Service stopped/.test(content.textContent));
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
  for (let read = 2; read <= 3; read++) {
    const polled = poll();
    await until(() => sent.filter((r) => r === "GET /v1/status").length >= read);
    expire(20000);
    await polled;
  }
  assert.match(q("#notice").textContent, /Cannot reach Casa/);
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
  await until(() => !/Cannot reach Casa/.test(q("#notice").textContent));
});

test("web admin marks the card unreachable when a background status read fails and recovers on the next good read", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-web-unreachable-"));
  init(home, { port: 0, name: "casa" });
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
  let offline = false;
  w.fetch = async (route, options = {}) => {
    if (offline && route === "/v1/status") throw new w.TypeError("Failed to fetch");
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
  daemon.engine.lastSync = new Date().toISOString();
  await poll(true);
  await until(() => q("#connection").textContent === "Up to date");
  offline = true;
  await poll(true);
  assert.equal(q("#connection").textContent, "Up to date", "one failed read is not enough to call the device offline");
  assert.equal(q('#notice [data-notice-id="connection"]'), null);
  await poll(true);
  assert.equal(q("#connection").textContent, "Offline");
  assert.equal(q("#connection").className, "wa");
  assert.match(q("#connection").innerHTML, /wifi-off/);
  assert.equal(q("#status-device .status-dot").className, "status-dot wa");
  assert.equal(q(".status-card").getAttribute("aria-label"), "casa, Hub, Offline");
  const item = q('#notice [data-notice-id="connection"]');
  assert.equal(item?.querySelector("strong")?.textContent, "Cannot reach casa");
  assert.equal(item.querySelector("p")?.textContent, "Check your connection and retry.");
  assert.match(item.innerHTML, /wifi-off/);
  assert.doesNotMatch(item.innerHTML, /circle-alert/);
  assert.doesNotMatch(q("#notice").textContent, /Could not complete action/);
  offline = false;
  await poll(true);
  assert.equal(q("#connection").textContent, "Up to date");
  assert.equal(q("#status-device .status-dot").className, "status-dot ok");
  await until(() => !q('#notice [data-notice-id="connection"]'));
});

test("web admin leaves Offline as soon as an events read answers, without waiting for the next status read", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-web-events-back-"));
  init(home, { port: 0, name: "casa" });
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
  let poll, events;
  Object.defineProperty(w.document, "hidden", { configurable: true, get: () => false });
  w.setInterval = (fn, ms) => {
    if (ms === 5000) poll = fn;
    if (ms === 1000 && poll && !events) events = fn;
    return 0;
  };
  let offline = false;
  w.fetch = async (route, options = {}) => {
    if (route.startsWith("/v1/events")) {
      if (offline) throw new w.TypeError("Failed to fetch");
      return new Response(JSON.stringify({ cursor: null }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (offline && route === "/v1/status") throw new w.TypeError("Failed to fetch");
    const work = fetch(new URL(route, base), {
      ...nodeInit(options),
      headers: { ...options.headers, Authorization: `Bearer ${daemon.engine.config.adminToken}` },
    });
    pending.add(work);
    void work.finally(() => pending.delete(work));
    return work;
  };
  const q = (selector) => w.document.querySelector(selector);
  const idle = () => w.document.body.getAttribute("aria-busy") === "false";
  await w.eval(`(async()=>{${script}\n})()`);
  await until(() => q(".folder-card") && idle());
  daemon.engine.lastSync = new Date().toISOString();
  await poll(true);
  await until(() => q("#connection").textContent === "Up to date");
  offline = true;
  await poll(true);
  await poll(true);
  assert.equal(q("#connection").textContent, "Offline");
  assert.ok(q('#notice [data-notice-id="connection"]'));
  offline = false;
  await events();
  assert.equal(q("#connection").textContent, "Up to date");
  await until(() => !q('#notice [data-notice-id="connection"]'));
  offline = true;
  await poll(true);
  assert.equal(q("#connection").textContent, "Up to date", "a good events read restarts the count of failed status reads");
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
  assert.match(q("#content").textContent, /Service stopped/);
  assert.doesNotMatch(q("#content").textContent, /daemon/i, "the page never says daemon to a person");
  assert.ok(q('#content [data-action="start"]'));
  assert.equal(q("#connection").textContent, "Service stopped");
  assert.equal(q("#sync-controls").hidden, true);
  assert.doesNotMatch(q("#notice").textContent, /Could not complete action/);
  w.document.body.dispatchEvent(
    new w.KeyboardEvent("keydown", { key: "r", metaKey: true, bubbles: true }),
  );
  await until(idle);
  assert.match(q("#content").textContent, /Service stopped/);
  assert.doesNotMatch(q("#notice").textContent, /daemon is unavailable/);
  const probe = intervals.at(-1);
  assert.notEqual(probe, poll);
  await probe();
  assert.match(q("#content").textContent, /Service stopped/);
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

test("a file only this replica holds is renamed and deleted with revision 0, not with no revision", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-file-rev-zero-"));
  init(home, { port: 0, name: "Casa" });
  const daemon = await start(home, { timer: false });
  const v = daemon.engine.store.addVolume("Documents");
  fs.writeFileSync(path.join(v.path, "note.txt"), "one");
  await daemon.engine.cycle();
  const current = daemon.engine.store.current(v.id, "note.txt");
  const pending = new Set();
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://tauri.localhost" });
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
        if (command === "check_update") return { available: false, version: null, notes: null };
        if (command !== "api") throw new Error(command);
        if (args.route.startsWith("/v1/history?"))
          return { offline: true, localOnly: true, next: null, versions: [{ ...current, rev: 0 }] };
        if (args.method === "POST") {
          posted.push([args.route, args.body]);
          return {};
        }
        const work = fetch(`http://127.0.0.1:${daemon.port}${args.route}`, {
          headers: { Authorization: `Bearer ${daemon.engine.config.adminToken}` },
        }).then(async (r) => {
          const value = await r.json();
          if (args.route.startsWith("/v1/browse?"))
            value.entries = value.entries.map((entry) => ({ ...entry, rev: 0 }));
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
  await until(() => [...w.document.querySelectorAll(".browser-file-row")].some((el) => el.querySelector("strong").textContent === "note.txt") && idle());
  [...w.document.querySelectorAll(".browser-file-row")].find((el) => el.querySelector("strong").textContent === "note.txt").click();
  await until(() => q('.file-actions-menu [data-action="rename-file"]') && idle());
  q('.file-actions-menu [data-action="rename-file"]').click();
  await until(() => q('#dialog [name="name"]'));
  q('#dialog [name="name"]').value = "renamed.txt";
  q("#dialog-form").dispatchEvent(new w.Event("submit", { cancelable: true }));
  await until(() => posted.length === 1);
  assert.deepEqual(JSON.parse(JSON.stringify(posted[0])), ["/v1/rename-file", { volume: v.id, path: "note.txt", rev: 0, name: "renamed.txt" }]);
});

test("a replica's web conflict dialog downloads the local copies it holds and hides the link for a copy it does not", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-web-conflict-links-"));
  init(home, { port: 0, name: "Server" });
  const daemon = await start(home, { timer: false });
  const volume = daemon.engine.store.addVolume("Documents");
  const base = `http://127.0.0.1:${daemon.port}`;
  const dom = new JSDOM(html, { runScripts: "outside-only", url: base });
  const w = dom.window;
  const pending = new Set();
  let role = "replica";
  let conflictLocal = { rev: 3, hash: "h-conflict", size: 5 };
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
  w.HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  const version = (path, hash, rev) => ({ volume: volume.id, path, hash, rev, size: 5, deleted: 0, created: Date.now(), author: "device" });
  const json = (value) => new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
  w.fetch = async (route, options = {}) => {
    const url = new URL(route, base);
    if (url.pathname === "/v1/status")
      return json({ ...daemon.engine.status(), role, hubUnavailable: false, volumes: daemon.engine.status().volumes.map((v) => ({ ...v, selected: 1 })) });
    if (url.pathname === "/v1/history") {
      const name = url.searchParams.get("path");
      return json(name.includes(".conflict-")
        ? { versions: [version(name, "h-conflict", 3)], ...(conflictLocal ? { local: conflictLocal } : {}) }
        : { versions: [version(name, "h-original", 2)], local: { rev: 2, hash: "h-original", size: 5 } });
    }
    const work = fetch(new URL(route, base), { ...nodeInit(options), headers: { ...options.headers, Authorization: `Bearer ${daemon.engine.config.adminToken}` } });
    pending.add(work);
    void work.finally(() => pending.delete(work));
    return work;
  };
  const q = (selector) => w.document.querySelector(selector);
  await w.eval(`(async()=>{${script}\n})()`);
  await until(() => q(".folder-card"));
  const open = async () => {
    const button = w.document.createElement("button");
    button.dataset.action = "review-conflict";
    button.dataset.id = JSON.stringify({ volume: volume.id, path: "note.txt.conflict-device-1" });
    w.document.body.append(button);
    button.click();
    await until(() => q("#dialog[open] .conflict-options"));
    const links = [...w.document.querySelectorAll("#dialog a[download]")].map((a) => [a.textContent.trim(), a.getAttribute("href")]);
    q("#dialog").removeAttribute("open");
    return links;
  };
  const original = `/v1/gallery/download?${new URLSearchParams({ volume: volume.id, path: "note.txt", hash: "h-original" })}`;
  const conflict = `/v1/gallery/download?${new URLSearchParams({ volume: volume.id, path: "note.txt.conflict-device-1", hash: "h-conflict" })}`;
  assert.deepEqual(await open(), [["Download original", original], ["Download conflict copy", conflict]], "a replica links the routes it serves, with its local hashes");
  conflictLocal = null;
  assert.deepEqual(await open(), [["Download original", original]], "a copy with no local file has no link");
  conflictLocal = { rev: 3, hash: "an-older-local-hash", size: 5 };
  assert.deepEqual(await open(), [["Download original", original]], "a local copy that is not that version has no link either");
  role = "hub";
  await poll();
  assert.deepEqual(await open(), [["Download original", "/v1/blobs/h-original"], ["Download conflict copy", "/v1/blobs/h-conflict"]], "the hub still serves its own objects");
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
  await poll();
  assert.match(q("#notice").textContent, /Cannot reach Casa/);
  answers.set("/v1/status", {
    status: 503,
    body: JSON.stringify({ error: "Tailscale access unavailable" }),
  });
  await poll();
  assert.match(q("#notice").textContent, /Cannot reach Casa/);
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

test("the gallery heads each month once with no day labels, with On this day, and pinches to Years and Months", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-moments-"));
  init(home, { port: 0, name: "Gallery" });
  const daemon = await start(home, { timer: false });
  const v = daemon.engine.store.addVolume("Photos");
  daemon.engine.store.db.prepare("INSERT OR IGNORE INTO gallery_folders VALUES(?)").run(v.id);
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://tauri.localhost" });
  const w = dom.window;
  w.setInterval = () => 0;
  const requests = new Set();
  t.after(async () => {
    await drainRequests(requests);
    w.close();
    await daemon.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const item = (day, n) => ({ path: `${day}-${n}.jpg`, hash: `h${day}${n}`, kind: "image", date: `${day}T10:00:00.000Z`, cursor: `${day}T10:00:00.000Z|${day}-${n}.jpg`, size: 1, rev: 1, dateSource: "capture date" });
  const plan = [["2026-09-12", 9], ["2026-09-10", 2], ["2026-09-09", 1], ["2026-09-05", 5]];
  const items = plan.flatMap(([day, n]) => Array.from({ length: n }, (_, i) => item(day, i)));
  const days = Object.fromEntries(plan);
  const routes = [];
  w.__TAURI__ = {
    core: {
      invoke: (command, args) => {
        const request = (async () => {
          if (command === "bootstrap") return { setup: false, status: daemon.engine.status() };
          if (command !== "api") throw new Error(command);
          routes.push(args.route);
          if (args.route.startsWith("/v1/gallery?"))
            return { indexing: false, timeline: [{ month: "2026-09", count: 17, videos: 0 }], undated: { count: 0, videos: 0, rev: 0 }, items, days, next: null, previous: null };
          if (args.route.startsWith("/v1/gallery/memories"))
            return { memories: [{ year: String(new Date().getFullYear() - 1), count: 21, path: "2026-09-10-1.jpg", hash: "mh", kind: "image", cursor: "2026-09-10T10:00:00.000Z|2026-09-10-1.jpg" }, { year: String(new Date().getFullYear() - 2), count: 1, path: "n.jpg", hash: "nh", kind: "image" }] };
          if (args.route.startsWith("/v1/gallery/periods"))
            return { level: args.route.includes("level=year") ? "year" : "month", periods: args.route.includes("level=year") ? [{ period: "2026", latest: "2026-09", count: 17, path: "p.jpg", hash: "ph", kind: "image" }, { period: "2025", latest: "2025-12", count: 4, path: "q.jpg", hash: "qh", kind: "image" }] : [{ period: "2026-09", count: 17, path: "p.jpg", hash: "ph", kind: "image" }] };
          if (args.route.startsWith("/v1/gallery/preview")) return { unavailable: true };
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
  if (!w.document.querySelector(".photo-timeline")) w.document.querySelector('[data-action="gallery-mode"]').click();
  await until(() => w.document.querySelectorAll(".photo-thumb").length === 17);
  assert.deepEqual([...w.document.querySelectorAll(".photo-day h2")].map((h) => h.textContent), ["September 2026"]);
  assert.equal(w.document.querySelector(".photo-block, .photo-grid, .photo-day h3, .photo-day-name, .photo-count"), null, "no day labels anywhere");
  assert.equal(w.document.querySelectorAll('.photo-day[data-day="2026-09"] > .photo-flow > .photo-thumb').length, 17, "the month's photos are one flow");
  assert.equal(w.document.querySelector(".photo-mosaic, .photo-hero, .photo-side"), null);
  await until(() => !w.document.querySelector(".photo-memories").hidden);
  const memories = [...w.document.querySelectorAll(".memory-card")].map((c) => c.textContent);
  assert.equal(memories.length, 2);
  assert.match(memories[0], /1 year ago · 21 photos/);
  assert.match(memories[1], /2 years ago · 1 photo/);
  assert.ok(routes.some((route) => /memories\?.*day=\d\d-\d\d.*year=\d{4}/.test(route) || /memories\?.*year=\d{4}.*day=\d\d-\d\d/.test(route)));
  assert.equal(w.document.querySelector(".gallery-zoom, [data-action='gallery-zoom']"), null, "no Years · Months · Days control");
  assert.match(w.document.querySelector('.heading-actions [data-action="gallery-mode"]').textContent, /View folder/);
  const pinch = (deltaY) => w.document.querySelector(".page").dispatchEvent(new w.WheelEvent("wheel", { ctrlKey: true, deltaY, bubbles: true, cancelable: true }));
  for (let step = 0; step < 2; step++) {
    pinch(60);
    await new Promise((resolve) => setTimeout(resolve, 450));
  }
  await until(() => w.document.querySelectorAll(".period-tile").length === 1);
  assert.ok(w.document.querySelector("#photo-gallery").classList.contains("gallery-periods-view"), "pinching in from Medium past Small shows Months");
  pinch(60);
  await until(() => w.document.querySelectorAll(".period-tile").length === 2);
  assert.match(w.document.querySelector(".period-tile").textContent, /2026\s*17/);
  w.document.querySelectorAll(".period-tile")[1].click();
  await until(() => routes.some((route) => route.includes("month=2025-12")));
  assert.equal(w.document.querySelector("#photo-gallery").classList.contains("gallery-periods-view"), false, "choosing a year returns to the photos at that period");
  const flights = [];
  w.Element.prototype.animate = function (frames, options) {
    flights.push({ element: this, frames, options });
    return { cancel() {} };
  };
  w.Element.prototype.getBoundingClientRect = function () {
    return this.matches?.(".photo-thumb") ? { left: 10, top: 20, width: 100, height: 50 } : this.matches?.(".photo-viewer-image") ? { left: 0, top: 0, width: 400, height: 200 } : { left: 0, top: 0, width: 0, height: 0 };
  };
  w.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  w.HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  await until(() => w.document.querySelector(".photo-thumb .photo-open"));
  w.document.querySelector(".photo-thumb .photo-open").click();
  await until(() => flights.some((flight) => flight.element.matches?.(".photo-viewer-image")));
  const opening = flights.find((flight) => flight.element.matches?.(".photo-viewer-image"));
  assert.equal(opening.frames[0].transform, "translate(-140px, -55px) scale(0.25)", "a photo opens from its own thumbnail");
  assert.equal(opening.frames[1].transform, "none");
  const flightsBefore = flights.length;
  w.document.querySelector("#cancel-dialog").click();
  await until(() => flights.length > flightsBefore);
  const leaving = flights[flights.length - 1];
  assert.equal(leaving.frames[0].transform, "none", "closing starts from the open viewer");
  assert.equal(leaving.frames[1].transform, "translate(-140px, -55px) scale(0.25)", "and shrinks back into its own thumbnail");
  assert.equal(leaving.options.fill, "forwards");
  await until(() => !w.document.querySelector("#dialog").hasAttribute("open"));
  const count = flights.length;
  w.Element.prototype.getBoundingClientRect = function () {
    return this.matches?.(".photo-thumb") ? { left: 10, top: 5000, right: 110, bottom: 5050, width: 100, height: 50 } : { left: 0, top: 0, width: 400, height: 200 };
  };
  w.document.querySelector(".photo-thumb .photo-open").click();
  await until(() => w.document.querySelector(".photo-viewer-image"));
  assert.equal(flights.length, count, "a thumbnail scrolled out of view opens with the plain fade");
  w.document.querySelector("#cancel-dialog").click();
  await until(() => !w.document.querySelector("#dialog").hasAttribute("open"));
  const wallRequests = () => routes.filter((route) => route.startsWith("/v1/gallery?")).length;
  w.document.documentElement.style.setProperty("--motion-settle", "1800ms");
  w.document.querySelector(".memory-card").click();
  await until(() => routes.some((route) => route.includes("from=2026-09-10")));
  await until(() => w.document.querySelector(".photo-found"));
  assert.equal(w.document.querySelector(".photo-memories").hidden, false);
  const toggle = () => w.document.querySelector('[data-action="gallery-mode"]').click();
  toggle();
  await until(() => !w.document.querySelector(".photo-timeline"));
  toggle();
  await until(() => w.document.querySelectorAll(".photo-thumb").length === 17);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(w.document.querySelector(".photo-memories").hidden, false, "leaving the wall and coming back brings On this day back");
  assert.equal(w.document.querySelectorAll(".memory-card").length, 2, "with the same cards");
  const settled = wallRequests();
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(wallRequests(), settled, "the wall stays still: no re-fetch loop");
});

test("the wall files each photo under the local day its date names, sharpens tiles and lays out only what changed", async (t) => {
  const zone = process.env.TZ;
  process.env.TZ = "Asia/Bangkok";
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-wall-"));
  init(home, { port: 0, name: "Gallery" });
  const daemon = await start(home, { timer: false });
  const v = daemon.engine.store.addVolume("Photos");
  daemon.engine.store.db.prepare("INSERT OR IGNORE INTO gallery_folders VALUES(?)").run(v.id);
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://tauri.localhost" });
  const w = dom.window;
  w.setInterval = () => 0;
  w.devicePixelRatio = 2;
  Object.defineProperty(w.HTMLElement.prototype, "clientWidth", { configurable: true, get() { return this.classList.contains("photo-flow") ? 1000 : 0; } });
  Object.defineProperty(w.HTMLImageElement.prototype, "naturalWidth", { configurable: true, get: () => 360 });
  Object.defineProperty(w.HTMLImageElement.prototype, "naturalHeight", { configurable: true, get: () => 270 });
  w.HTMLImageElement.prototype.decode = () => Promise.resolve();
  w.IntersectionObserver = class {
    constructor(callback) {
      this.callback = callback;
    }
    observe(target) {
      queueMicrotask(() => this.callback([{ target, isIntersecting: true }]));
    }
    unobserve() {}
    disconnect() {}
  };
  const requests = new Set();
  t.after(async () => {
    await drainRequests(requests);
    w.close();
    await daemon.close();
    fs.rmSync(home, { recursive: true, force: true });
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  });
  const item = (path, date) => ({ path, hash: `h-${path}`, kind: "image", date, cursor: `${date || "!"}|${path}`, size: 1, rev: 1, dateSource: date ? "capture date" : "date added" });
  const first = [item("night.jpg", "2026-09-27T22:30:00.000Z"), item("a.jpg", "2026-09-26T10:00:00"), item("b.jpg", "2026-09-26T09:00:00"), item("c.jpg", "2026-09-25T10:00:00")];
  const second = [item("d.jpg", "2026-09-20T11:06:00"), item("unknown.jpg", null), item("none.jpg", null)];
  let releaseSecond;
  const secondReady = new Promise((resolve) => (releaseSecond = resolve));
  const timeline = [{ month: "2026-09", count: 5, videos: 0 }];
  const large = [];
  const medium = [];
  w.__TAURI__ = {
    core: {
      invoke: (command, args) => {
        const request = (async () => {
          if (command === "bootstrap") return { setup: false, status: daemon.engine.status() };
          if (command !== "api") throw new Error(command);
          const route = args.route;
          if (route.startsWith("/v1/gallery?")) {
            const base = { indexing: false, timeline, undated: { count: 2, videos: 0, rev: 0 } };
            if (!route.includes("after=") || /after=(&|$)/.test(route))
              return { ...base, items: first, next: "cursor-1", previous: null };
            await secondReady;
            return { ...base, items: second, next: null, previous: null };
          }
          if (route.startsWith("/v1/gallery/memories")) return { memories: [] };
          if (route.startsWith("/v1/gallery/preview-url")) {
            large.push(route);
            return { url: `http://127.0.0.1:9/large/${new URLSearchParams(route.split("?")[1]).get("path")}`, expires: Date.now() + 3600000 };
          }
          if (route.startsWith("/v1/gallery/preview")) {
            if (route.includes("size=medium")) {
              medium.push(route);
              return { data: "data:image/jpeg;base64,TUVE" };
            }
            return { data: "data:image/jpeg;base64,AAAA" };
          }
          const r = await fetch(`http://127.0.0.1:${daemon.port}${route}`, {
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
  if (!w.document.querySelector(".photo-timeline")) w.document.querySelector('[data-action="gallery-mode"]').click();
  await until(() => w.document.querySelectorAll(".photo-thumb").length === 4);
  const earlier = [...w.document.querySelectorAll('.photo-day[data-day="2026-09"] .photo-thumb')].slice(0, 2);
  assert.equal(earlier.length, 2);
  const writes = [];
  for (const tile of earlier) {
    const set = tile.style.setProperty.bind(tile.style);
    tile.style.setProperty = (...args) => {
      writes.push(args[0]);
      return set(...args);
    };
  }
  releaseSecond();
  await until(() => w.document.querySelectorAll(".photo-thumb").length === 7);
  assert.ok(earlier.every((tile) => tile.isConnected));
  assert.ok(earlier.every((tile) => tile.style.getPropertyValue("--photo-height")));
  assert.deepEqual(writes, [], "a new page leaves the rows already laid out alone");
  const september = [...w.document.querySelectorAll('.photo-day[data-day="2026-09"] .photo-thumb')];
  assert.deepEqual(september.map((tile) => tile.querySelector(".photo-open").getAttribute("aria-label")), ["Open night.jpg", "Open a.jpg", "Open b.jpg", "Open c.jpg", "Open d.jpg"], "one month flow, newest first");
  assert.equal(w.document.querySelector(".photo-block, .photo-day h3"), null);
  const night = september[0];
  assert.match(night.dataset.tooltip, /^September 28, 2026/, "a UTC capture keeps its local day in the tooltip");
  assert.equal(night.hasAttribute("title"), false);
  assert.match(september[4].dataset.tooltip, /^September 20, 2026 at 11:06/);
  const groups = [...w.document.querySelectorAll(".photo-day")];
  assert.deepEqual(groups.map((g) => g.querySelector("h2").textContent), ["September 2026", "Date unknown"]);
  assert.equal(groups[1].querySelectorAll(".photo-thumb").length, 2);
  assert.equal(groups[1].querySelectorAll(".photo-thumb")[0].dataset.tooltip, "Date unknown", "an undated photo names no date source");
  assert.deepEqual([...w.document.querySelectorAll(".photo-timeline button")].map((b) => b.dataset.month), ["2026-09"]);
  for (const img of w.document.querySelectorAll(".photo-thumb img")) img.dispatchEvent(new w.Event("load"));
  await until(() => [...w.document.querySelectorAll(".photo-thumb img")].every((img) => img.src === "data:image/jpeg;base64,TUVE"));
  assert.equal(medium.length, 7, "tiles up to 720 device pixels load the medium preview");
  assert.deepEqual(large, [], "no wall tile at this size pulls the 2048 px preview");
});

async function mountWall(t, { zone, page, preview, prepare = () => {}, memories = [], answer = () => undefined }) {
  const previousZone = process.env.TZ;
  if (zone) process.env.TZ = zone;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-wall-"));
  init(home, { port: 0, name: "Gallery" });
  const daemon = await start(home, { timer: false });
  const v = daemon.engine.store.addVolume("Photos");
  daemon.engine.store.db.prepare("INSERT OR IGNORE INTO gallery_folders VALUES(?)").run(v.id);
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://tauri.localhost" });
  const w = dom.window;
  w.setInterval = () => 0;
  w.devicePixelRatio = 2;
  Object.defineProperty(w.HTMLElement.prototype, "clientWidth", { configurable: true, get() { return this.classList.contains("photo-flow") ? 1000 : 0; } });
  Object.defineProperty(w.HTMLImageElement.prototype, "naturalWidth", { configurable: true, get: () => 360 });
  Object.defineProperty(w.HTMLImageElement.prototype, "naturalHeight", { configurable: true, get: () => 270 });
  w.HTMLImageElement.prototype.decode = () => Promise.resolve();
  w.HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  w.HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  w.IntersectionObserver = class {
    constructor(callback) {
      this.callback = callback;
    }
    observe(target) {
      queueMicrotask(() => this.callback([{ target, isIntersecting: true }]));
    }
    unobserve() {}
    disconnect() {}
  };
  prepare(w);
  const requests = new Set();
  const log = [];
  t.after(async () => {
    await drainRequests(requests);
    w.close();
    await daemon.close();
    fs.rmSync(home, { recursive: true, force: true });
    if (previousZone === undefined) delete process.env.TZ;
    else process.env.TZ = previousZone;
  });
  w.__TAURI__ = {
    core: {
      invoke: (command, args) => {
        const request = (async () => {
          if (command === "bootstrap") return { setup: false, status: daemon.engine.status() };
          if (command !== "api") throw new Error(command);
          const route = args.route;
          const answered = await answer(route, args);
          if (answered !== undefined) return answered;
          if (route.startsWith("/v1/gallery?")) return { indexing: false, previous: null, next: null, ...(await page(new URLSearchParams(route.split("?")[1]))) };
          if (route.startsWith("/v1/gallery/memories")) return { memories };
          if (route.startsWith("/v1/gallery/preview")) {
            const query = new URLSearchParams(route.split("?")[1]);
            const size = route.startsWith("/v1/gallery/preview-url") ? "large" : query.get("size") || "thumb";
            log.push(`${size}:${query.get("path")}`);
            return await preview(size, query.get("path"));
          }
          const r = await fetch(`http://127.0.0.1:${daemon.port}${route}`, {
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
  if (!w.document.querySelector(".photo-timeline")) w.document.querySelector('[data-action="gallery-mode"]').click();
  const loadThumbs = () => {
    for (const img of w.document.querySelectorAll(".photo-thumb img"))
      if (!img.loaded) {
        img.loaded = true;
        img.dispatchEvent(new w.Event("load"));
      }
  };
  return { w, log, loadThumbs };
}
const wallItem = (path, date) => ({ path, hash: `h-${path}`, kind: "image", date, cursor: `${date || "!"}|${path}`, size: 1, rev: 1, dateSource: date ? "metadata" : "date added" });
const pathsOf = (w, selector) => [...w.document.querySelectorAll(`${selector} .photo-thumb`)].map((tile) => tile.querySelector(".photo-open").getAttribute("aria-label").replace("Open ", ""));

test("photos that cross a local month boundary file under their local month, in time order, and the viewer follows the screen", async (t) => {
  const items = [
    wallItem("a.jpg", "2026-10-01T10:00:00"),
    wallItem("night.jpg", "2026-10-01T02:30:00.000Z"),
    wallItem("late.jpg", "2026-09-30T23:00:00"),
    wallItem("c.jpg", "2026-09-26T10:00:00"),
    wallItem("east.jpg", "2026-09-25T23:30:00-09:00"),
    wallItem("g.jpg", "2026-09-25T10:00:00"),
  ];
  const { w } = await mountWall(t, {
    zone: "America/New_York",
    page: () => ({ items, timeline: [{ month: "2026-10", count: 2, videos: 0 }, { month: "2026-09", count: 4, videos: 0 }], undated: { count: 0, videos: 0, rev: 0 } }),
    preview: () => ({ data: "data:image/jpeg;base64,AAAA" }),
  });
  await until(() => w.document.querySelectorAll(".photo-thumb").length === 6);
  assert.deepEqual([...w.document.querySelectorAll(".photo-day h2")].map((h) => h.textContent), ["October 2026", "September 2026"], "a month heading carries only its name");
  assert.deepEqual(pathsOf(w, '.photo-day[data-day="2026-10"]'), ["a.jpg"]);
  assert.deepEqual(pathsOf(w, '.photo-day[data-day="2026-09"]'), ["late.jpg", "night.jpg", "c.jpg", "east.jpg", "g.jpg"], "a month's photos run newest first by instant");
  w.document.querySelector('.photo-thumb .photo-open[aria-label="Open late.jpg"]').click();
  await until(() => w.document.querySelector("#dialog-title")?.textContent === "late.jpg");
  w.document.querySelector(".photo-next").click();
  await until(() => w.document.querySelector("#dialog-title")?.textContent === "night.jpg");
  w.document.querySelector(".photo-previous").click();
  await until(() => w.document.querySelector("#dialog-title")?.textContent === "late.jpg");
  w.document.querySelector(".photo-previous").click();
  await until(() => w.document.querySelector("#dialog-title")?.textContent === "a.jpg");
});

test("a month is one flow whose heading sticks only while its photos pass under it", async (t) => {
  const items = Array.from({ length: 43 }, (_, i) => wallItem(`p${String(i).padStart(2, "0")}.jpg`, `2026-09-${String(28 - Math.floor(i / 2)).padStart(2, "0")}T10:00:00`));
  const observers = [];
  const { w, loadThumbs } = await mountWall(t, {
    page: () => ({ items, timeline: [{ month: "2026-09", count: 43, videos: 0 }], undated: { count: 0, videos: 0, rev: 0 } }),
    preview: () => ({ data: "data:image/jpeg;base64,AAAA" }),
    prepare: (w) => {
      Object.defineProperty(w.HTMLImageElement.prototype, "naturalWidth", { configurable: true, get: () => 135 });
      w.IntersectionObserver = class {
        constructor(callback, options) {
          this.callback = callback;
          this.options = options;
          observers.push(this);
        }
        observe(target) {
          queueMicrotask(() => this.callback([{ target, isIntersecting: true, boundingClientRect: { top: 0 }, rootBounds: { top: 0 } }]));
        }
        unobserve() {}
        disconnect() {}
      };
    },
  });
  await until(() => w.document.querySelectorAll(".photo-thumb").length === 43);
  const flows = w.document.querySelectorAll('.photo-day[data-day="2026-09"] > .photo-flow');
  assert.equal(flows.length, 1);
  assert.equal(flows[0].querySelectorAll(":scope > .photo-thumb").length, 43, "tiles sit directly in the month's flow");
  const px = (element, name) => parseFloat(element.style.getPropertyValue(name));
  await until(() => {
    loadThumbs();
    return [...w.document.querySelectorAll(".photo-thumb")].every((tile) => px(tile, "--photo-width") < px(tile, "--photo-height"));
  });
  const tops = [...new Set([...w.document.querySelectorAll(".photo-thumb")].map((tile) => px(tile, "--photo-top")))].sort((a, b) => a - b);
  assert.ok(tops.length > 3);
  for (let index = 1; index < tops.length; index++) {
    const above = [...w.document.querySelectorAll(".photo-thumb")].find((tile) => px(tile, "--photo-top") === tops[index - 1]);
    assert.ok(Math.abs(tops[index] - (tops[index - 1] + px(above, "--photo-height") + 6)) < 0.05, "rows follow one tile gap apart with no label room");
  }
  const bottom = Math.max(...[...w.document.querySelectorAll(".photo-thumb")].map((tile) => px(tile, "--photo-top") + px(tile, "--photo-height")));
  assert.ok(Math.abs(px(flows[0], "--flow-height") - bottom) < 0.05, "the month is as tall as its rows");
  const group = w.document.querySelector('.photo-day[data-day="2026-09"]');
  const edge = group.querySelector(":scope > .photo-day-edge");
  assert.equal(edge.nextElementSibling.tagName, "H2", "the sentinel sits right above the heading");
  const sticky = observers.find((observer) => observer.options?.root === w.document.querySelector(".page"));
  assert.ok(sticky, "the sentinel is watched against the scrolling page");
  assert.match(sticky.options.rootMargin, /^0px 0px \d+px 0px$/, "a jump past the heading still reports it");
  sticky.callback([{ target: edge, isIntersecting: false, boundingClientRect: { top: -40 }, rootBounds: { top: 0 } }]);
  assert.ok(group.classList.contains("photo-day-stuck"), "the fade shows once the heading's own top has scrolled under it");
  sticky.callback([{ target: edge, isIntersecting: true, boundingClientRect: { top: 30 }, rootBounds: { top: 0 } }]);
  assert.equal(group.classList.contains("photo-day-stuck"), false, "and goes when the heading is back in place");
});

test("a month emptied by a deletion stops watching its heading sentinel", async (t) => {
  const unobserved = [];
  const { w } = await mountWall(t, {
    page: () => ({ items: [wallItem("a.jpg", "2026-09-27T10:00:00"), wallItem("b.jpg", "2026-08-10T10:00:00")], timeline: [{ month: "2026-09", count: 1, videos: 0 }, { month: "2026-08", count: 1, videos: 0 }], undated: noUndated }),
    preview: () => ({ data: "data:image/jpeg;base64,AAAA" }),
    answer: (route) => (route === "/v1/gallery/delete" ? { paths: ["b.jpg"], rows: [{ path: "b.jpg", rev: 1 }] } : undefined),
    prepare: (w) => {
      w.IntersectionObserver = class {
        constructor(callback, options) {
          this.callback = callback;
          this.options = options;
        }
        observe(target) {
          queueMicrotask(() => this.callback([{ target, isIntersecting: true, boundingClientRect: { top: 0 }, rootBounds: { top: 0 } }]));
        }
        unobserve(target) {
          if (this.options?.root?.classList?.contains("page")) unobserved.push(target);
        }
        disconnect() {}
      };
    },
  });
  await until(() => w.document.querySelector('.photo-day[data-day="2026-08"] .photo-thumb'));
  const edge = w.document.querySelector('.photo-day[data-day="2026-08"] > .photo-day-edge');
  w.document.querySelector('.photo-day[data-day="2026-08"] .photo-select').click();
  w.document.querySelector(".photo-selection-delete").click();
  w.document.querySelector("#dialog-form").dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
  await until(() => !w.document.querySelector('.photo-day[data-day="2026-08"]'));
  assert.ok(unobserved.includes(edge), "the removed month's sentinel leaves the sticky observer");
  assert.ok(!unobserved.includes(w.document.querySelector('.photo-day[data-day="2026-09"] > .photo-day-edge')));
});

const tilePx = (element, name) => parseFloat(element.style.getPropertyValue(name));
const frames = () => new Promise((resolve) => setTimeout(resolve, 80));
const noUndated = { count: 0, videos: 0, rev: 0 };

test("a page whose first new photo closes the row above re-lays that whole row", async (t) => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const timeline = [{ month: "2026-09", count: 5, videos: 0 }];
  const { w, loadThumbs } = await mountWall(t, {
    page: async (query) =>
      query.get("after")
        ? (await gate, { items: [wallItem("e.jpg", "2026-09-26T10:00:00")], timeline, undated: noUndated })
        : { items: ["a", "b", "c", "d"].map((name, i) => wallItem(`${name}.jpg`, `2026-09-27T1${5 - i}:00:00`)), next: "cursor-1", timeline, undated: noUndated },
    preview: () => ({ data: "data:image/jpeg;base64,AAAA" }),
  });
  const all = () => [...w.document.querySelectorAll('.photo-day[data-day="2026-09"] .photo-thumb')];
  const settled = (tiles) => tiles.every((tile) => Math.abs(tilePx(tile, "--photo-width") / tilePx(tile, "--photo-height") - 4 / 3) < 0.01);
  await until(() => {
    loadThumbs();
    return all().length === 4 && settled(all());
  });
  assert.equal(tilePx(all()[0], "--photo-height"), 180, "the month's last row keeps the target height");
  release();
  await until(() => {
    loadThumbs();
    return all().length === 5 && settled(all());
  });
  await frames();
  const row = all().slice(0, 4);
  const next = all()[4];
  assert.ok(tilePx(next, "--photo-top") > tilePx(row[0], "--photo-top"), "the new photo starts the next row");
  for (const tile of row) assert.ok(Math.abs(tilePx(tile, "--photo-height") - 184.17) < 0.05, `the closed row takes its new height, not ${tilePx(tile, "--photo-height")}`);
  const last = row.at(-1);
  assert.ok(Math.abs(tilePx(last, "--photo-left") + tilePx(last, "--photo-width") - 1000) < 0.5, "the closed row fills the wall with no blank strip");
  assert.ok(Math.abs(tilePx(next, "--photo-top") - (tilePx(row[0], "--photo-top") + 184.17 + 6)) < 0.05, "one tile gap below, with no label room");
});

test("On this day cards take the wall's current row height as 4:3 photos and load a preview sharp enough for it", async (t) => {
  const year = String(new Date().getFullYear() - 1);
  const { w, log } = await mountWall(t, {
    page: () => ({ items: ["a", "b"].map((name, i) => wallItem(`${name}.jpg`, `2026-09-27T1${5 - i}:00:00`)), timeline: [{ month: "2026-09", count: 2, videos: 0 }], undated: noUndated }),
    memories: [{ year, count: 3, path: "m.jpg", hash: "mh", kind: "image" }],
    preview: () => ({ data: "data:image/jpeg;base64,AAAA" }),
    prepare: (w) => Object.defineProperty(w.HTMLElement.prototype, "clientWidth", { configurable: true, get() { return this.classList.contains("photo-flow") || this.classList.contains("photo-days") ? 1000 : 0; } }),
  });
  const gallery = w.document.querySelector("#photo-gallery");
  const row = () => gallery.style.getPropertyValue("--photo-row");
  await until(() => w.document.querySelector(".memory-card img"));
  assert.equal(row(), "180px", "Medium rows are 180 px on a 1000 px wall");
  assert.ok(log.includes("medium:m.jpg"), `a 240 × 180 card at 2× asks for the medium preview, not the thumbnail (${log.join(" ")})`);
  const pinch = async (deltaY) => {
    w.document.querySelector(".page").dispatchEvent(new w.WheelEvent("wheel", { ctrlKey: true, deltaY, bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 450));
  };
  await pinch(-60);
  assert.equal(row(), "240px", "Large rows grow the cards with them");
  await pinch(60);
  await pinch(60);
  assert.equal(row(), "120px", "Small rows shrink them");
  const tile = w.document.querySelector(".photo-thumb");
  await until(() => tilePx(tile, "--photo-height") > 0);
  assert.ok(tilePx(tile, "--photo-height") <= 120 * 1.25, "the wall uses the same Small target");
});

test("an On this day card sharpens a wide photo until its short side covers the 4:3 crop", async (t) => {
  const year = String(new Date().getFullYear() - 1);
  const { w, log } = await mountWall(t, {
    page: () => ({ items: [wallItem("a.jpg", "2026-09-27T15:00:00")], timeline: [{ month: "2026-09", count: 1, videos: 0 }], undated: noUndated }),
    memories: [{ year, count: 3, path: "m.jpg", hash: "mh", kind: "image" }],
    preview: () => ({ data: "data:image/jpeg;base64,AAAA" }),
    prepare: (w) => {
      Object.defineProperty(w.HTMLElement.prototype, "clientWidth", { configurable: true, get() { return this.classList.contains("photo-flow") || this.classList.contains("photo-days") ? 600 : 0; } });
      Object.defineProperty(w.HTMLImageElement.prototype, "naturalHeight", { configurable: true, get: () => 203 });
    },
  });
  await until(() => w.document.querySelector(".memory-card")?.dataset.source === "medium");
  assert.equal(w.document.querySelector("#photo-gallery").style.getPropertyValue("--photo-row"), "120px");
  assert.deepEqual(log.filter((entry) => entry.endsWith(":m.jpg")), ["thumb:m.jpg", "medium:m.jpg"], "a 160 × 120 card at 2× fits the thumbnail, but a 16:9 thumbnail is only 203 px tall");
});

test("an On this day card whose preview is busy asks again and ends with its photo", async (t) => {
  const year = String(new Date().getFullYear() - 1);
  let busy = 1;
  const { w, log } = await mountWall(t, {
    page: () => ({ items: [wallItem("a.jpg", "2026-09-27T15:00:00")], timeline: [{ month: "2026-09", count: 1, videos: 0 }], undated: noUndated }),
    memories: [{ year, count: 3, path: "m.jpg", hash: "mh", kind: "image" }],
    preview: (size, path) => {
      if (path === "m.jpg" && busy-- > 0) throw Object.assign(new Error("Previews are busy. Try again."), { status: 429 });
      return { data: "data:image/jpeg;base64,AAAA" };
    },
    prepare: (w) => Object.defineProperty(w.HTMLElement.prototype, "clientWidth", { configurable: true, get() { return this.classList.contains("photo-flow") || this.classList.contains("photo-days") ? 1000 : 0; } }),
  });
  await until(() => w.document.querySelector(".memory-card img"), 400);
  assert.equal(log.filter((entry) => entry.endsWith(":m.jpg")).length, 2, "one busy answer, one retry");
  assert.equal(w.document.querySelector(".memory-card").dataset.source, "medium");
});

test("moving to a screen with another pixel density sharpens the tiles without a resize", async (t) => {
  const queries = [];
  const { w, log, loadThumbs } = await mountWall(t, {
    page: () => ({ items: ["a", "b", "c", "d"].map((name, i) => wallItem(`${name}.jpg`, `2026-09-27T1${5 - i}:00:00`)), timeline: [{ month: "2026-09", count: 4, videos: 0 }], undated: noUndated }),
    preview: (size) => (size === "large" ? { url: "http://127.0.0.1:9/large", expires: Date.now() + 3600000 } : { data: "data:image/jpeg;base64,AAAA" }),
    prepare: (w) => {
      w.matchMedia = (media) => {
        const query = new w.EventTarget();
        query.media = media;
        query.matches = false;
        queries.push(query);
        return query;
      };
    },
  });
  await until(() => {
    loadThumbs();
    return log.filter((entry) => entry.startsWith("medium:")).length === 4;
  });
  await frames();
  assert.ok(!log.some((entry) => entry.startsWith("large:")));
  const density = queries.findLast((query) => query.media === "(resolution: 2dppx)");
  assert.ok(density, "the gallery watches the current pixel density");
  w.devicePixelRatio = 4;
  density.dispatchEvent(new w.Event("change"));
  await until(() => log.some((entry) => entry.startsWith("large:")));
  assert.ok(queries.some((query) => query.media === "(resolution: 4dppx)"), "and keeps watching at the new density");
});

test("a raw epoch capture time never files a photo under 1970, and a tile scrolled out keeps its placeholder", async (t) => {
  const observers = [];
  const { w, loadThumbs } = await mountWall(t, {
    page: () => ({
      items: [
        wallItem("a.jpg", "2026-09-27T10:00:00"),
        { ...wallItem("clip.mp4", "2026-09-27T09:00:00"), kind: "video" },
        { ...wallItem("epoch.jpg", null), captured: "1970-01-01T00:00:00.000Z" },
      ],
      timeline: [{ month: "2026-09", count: 2, videos: 1 }],
      undated: { count: 1, videos: 0, rev: 0 },
    }),
    preview: () => ({ data: "data:image/jpeg;base64,AAAA" }),
    prepare: (w) => {
      w.IntersectionObserver = class {
        constructor(callback, options) {
          this.callback = callback;
          this.options = options;
          observers.push(this);
        }
        observe(target) {
          queueMicrotask(() => this.callback([{ target, isIntersecting: true }]));
        }
        unobserve() {}
        disconnect() {}
      };
    },
  });
  await until(() => {
    loadThumbs();
    return w.document.querySelectorAll(".photo-thumb img").length === 3;
  });
  assert.deepEqual([...w.document.querySelectorAll(".photo-day")].map((group) => group.dataset.day), ["2026-09", "unknown"]);
  const epoch = [...w.document.querySelectorAll(".photo-thumb")].find((tile) => tile.querySelector('[aria-label="Open epoch.jpg"]'));
  assert.equal(epoch.closest(".photo-day").dataset.day, "unknown");
  assert.equal(epoch.dataset.tooltip, "Date unknown");
  const tile = (name) => w.document.querySelector(`.photo-open[aria-label="Open ${name}"]`).closest(".photo-thumb");
  const tiles = [tile("a.jpg"), tile("clip.mp4")];
  for (const target of tiles) for (const each of observers.filter((observer) => !observer.options?.root)) each.callback([{ target, isIntersecting: false }]);
  assert.ok(tile("a.jpg").querySelector(".photo-open svg.brand-arch"), "a photo scrolled out shows the arch placeholder");
  assert.ok(!tile("a.jpg").querySelector(".photo-open img"));
  assert.ok(tile("clip.mp4").querySelector('.photo-open [data-icon="play"], .photo-open svg'), "a video scrolled out shows its play glyph");
  assert.ok(!tile("clip.mp4").querySelector(".photo-open svg.brand-arch"));
});

test("seeking a month opens on that month, not on a neighbour holding one shifted photo", async (t) => {
  const { w } = await mountWall(t, {
    zone: "Asia/Bangkok",
    page: (query) =>
      query.get("month") === "2026-09"
        ? { items: [wallItem("night.jpg", "2026-09-30T22:30:00.000Z"), wallItem("s.jpg", "2026-09-20T10:00:00")], timeline: [{ month: "2026-09", count: 2, videos: 0 }, { month: "2026-08", count: 1, videos: 0 }], undated: { count: 0, videos: 0, rev: 0 } }
        : { items: [wallItem("aug.jpg", "2026-08-10T10:00:00")], timeline: [{ month: "2026-09", count: 2, videos: 0 }, { month: "2026-08", count: 1, videos: 0 }], undated: { count: 0, videos: 0, rev: 0 } },
    preview: () => ({ data: "data:image/jpeg;base64,AAAA" }),
    prepare: (w) => {
      const rect = w.HTMLElement.prototype.getBoundingClientRect;
      w.HTMLElement.prototype.getBoundingClientRect = function () {
        if (this.matches('.photo-day[data-day="2026-09"]')) return { top: 300, bottom: 600, left: 0, right: 0, width: 0, height: 300 };
        return rect.call(this);
      };
    },
  });
  await until(() => w.document.querySelector(".photo-timeline button"));
  w.document.querySelector('.photo-timeline button[data-month="2026-09"]').click();
  await until(() => w.document.querySelectorAll(".photo-thumb").length === 2);
  assert.deepEqual([...w.document.querySelectorAll(".photo-day")].map((group) => group.dataset.day), ["2026-10", "2026-09"]);
  assert.equal(w.document.querySelector(".page").scrollTop, 300, "the requested month sits at the top of the view");
});

test("busy previews are retried, and tiles sharpen only once every thumbnail is in", async (t) => {
  const busy = new Map();
  const items = Array.from({ length: 5 }, (_, i) => wallItem(`p${i}.jpg`, `2026-09-2${i}T10:00:00`));
  const { w, log, loadThumbs } = await mountWall(t, {
    page: () => ({ items, timeline: [{ month: "2026-09", count: 5, videos: 0 }], undated: { count: 0, videos: 0, rev: 0 } }),
    preview: (size, file) => {
      const key = `${size}:${file}`;
      const refusals = busy.get(key) ?? (size === "thumb" ? (file === "p0.jpg" || file === "p3.jpg" ? 2 : 0) : file === "p1.jpg" ? 1 : 0);
      if (refusals) {
        busy.set(key, refusals - 1);
        throw new Error("Previews are busy. Try again.");
      }
      busy.set(key, 0);
      return { data: size === "thumb" ? "data:image/jpeg;base64,AAAA" : "data:image/jpeg;base64,TUVE" };
    },
  });
  await until(() => {
    loadThumbs();
    return [...w.document.querySelectorAll(".photo-thumb img")].length === 5 && [...w.document.querySelectorAll(".photo-thumb img")].every((img) => img.src === "data:image/jpeg;base64,TUVE");
  }, 600);
  assert.equal(w.document.querySelector(".photo-thumb [data-lucide='image-off'], .photo-thumb .lucide-image-off"), null);
  const lastThumb = log.findLastIndex((entry) => entry.startsWith("thumb:"));
  const firstMedium = log.findIndex((entry) => entry.startsWith("medium:"));
  assert.ok(lastThumb < firstMedium, log.join(" "));
});

test("medium previews that fail to decode free their cache share, and tiles upgrade when the screen needs more pixels", async (t) => {
  const items = ["bad0.jpg", "bad1.jpg", "bad2.jpg", "good.jpg"].map((file, i) => wallItem(file, `2026-09-20T1${9 - i}:00:00`));
  const filler = "A".repeat(1200000);
  const frames = [];
  const { w, log, loadThumbs } = await mountWall(t, {
    page: () => ({ items, timeline: [{ month: "2026-09", count: 4, videos: 0 }], undated: { count: 0, videos: 0, rev: 0 } }),
    preview: (size, file) =>
      size === "thumb"
        ? { data: "data:image/jpeg;base64,AAAA" }
        : size === "large"
          ? { url: `http://127.0.0.1:9/large/${file}`, expires: Date.now() + 3600000 }
          : { data: `data:image/jpeg;base64,${file.startsWith("bad") ? "QkFE" : "R09P"}${filler}` },
    prepare: (w) => {
      w.HTMLImageElement.prototype.decode = function () {
        return this.src.includes("QkFE") ? Promise.reject(new Error("bad")) : Promise.resolve();
      };
      w.requestAnimationFrame = (callback) => frames.push(callback);
    },
  });
  await until(() => w.document.querySelectorAll(".photo-thumb img").length === 4);
  frames.length = 0;
  loadThumbs();
  assert.equal(frames.length, 1, "tiles of one day changing ratio in a frame schedule one layout");
  const page = w.document.querySelector(".page");
  let writes = 0;
  const descriptor = Object.getOwnPropertyDescriptor(w.Element.prototype, "scrollTop");
  Object.defineProperty(page, "scrollTop", { configurable: true, get: () => descriptor.get.call(page), set: (value) => { writes++; descriptor.set.call(page, value); } });
  frames.splice(0).forEach((frame) => frame());
  assert.equal(writes, 0, "a layout that leaves the first photo in place does not touch the scroll position");
  const good = () => w.document.querySelector('.photo-thumb .photo-open[aria-label="Open good.jpg"] img');
  await until(() => good().src.startsWith("data:image/jpeg;base64,R09P"));
  w.devicePixelRatio = 4;
  w.dispatchEvent(new w.Event("resize"));
  await until(() => good().src === "http://127.0.0.1:9/large/good.jpg");
  assert.ok(log.includes("large:good.jpg"));
});

test("Space opens a Quick Look with the file's preview, arrows move through the folder and Space closes", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-quicklook-"));
  init(home, { port: 0, name: "Quick Look" });
  const daemon = await start(home, { timer: false });
  const v = daemon.engine.store.addVolume("Docs");
  const sharp = (await import("sharp")).default;
  fs.writeFileSync(path.join(v.path, "a-note.txt"), "first line\nsecond line");
  fs.writeFileSync(path.join(v.path, "b-picture.png"), await sharp({ create: { width: 40, height: 30, channels: 3, background: "red" } }).png().toBuffer());
  fs.writeFileSync(path.join(v.path, "c-sheet.xlsx"), "binary-ish");
  fs.mkdirSync(path.join(v.path, "zdir"));
  fs.writeFileSync(path.join(v.path, "zdir", "inner.txt"), "x");
  await daemon.engine.cycle();
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://tauri.localhost" });
  const w = dom.window;
  w.setInterval = () => 0;
  const requests = new Set();
  t.after(async () => {
    await drainRequests(requests);
    w.close();
    await daemon.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  w.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  w.HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); this.dispatchEvent(new w.Event("close")); };
  w.__TAURI__ = {
    core: {
      invoke: (command, args) => {
        const request = (async () => {
          if (command === "bootstrap") return { setup: false, status: daemon.engine.status() };
          if (command !== "api") throw new Error(command);
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
  await until(() => w.document.querySelectorAll(".browser-file-row").length === 4);
  const rows = [...w.document.querySelectorAll('.browser-file-row[data-action="activity-file"]')];
  assert.equal(rows.length, 3);
  const key = (el, k) => el.dispatchEvent(new w.KeyboardEvent("keydown", { key: k, bubbles: true }));
  key(rows[0], " ");
  const dialog = w.document.getElementById("quicklook");
  assert.ok(dialog.open);
  assert.match(dialog.querySelector(".ql-title").textContent, /a-note\.txt.*1 of 3 in this folder/s, "folders are not part of the walk");
  await until(() => dialog.querySelector(".ql-text"));
  assert.match(dialog.querySelector(".ql-text").textContent, /first line\nsecond line/);
  assert.equal(dialog.querySelector('[data-ql="prev"]').disabled, true);
  key(dialog, "ArrowRight");
  await until(() => /b-picture\.png/.test(dialog.querySelector(".ql-title").textContent));
  await until(() => dialog.querySelector(".ql-stage img"));
  key(dialog, "ArrowRight");
  await until(() => /c-sheet\.xlsx/.test(dialog.querySelector(".ql-title").textContent));
  assert.equal(dialog.querySelector(".ql-stage img, .ql-stage .ql-text"), null, "an unknown type shows its icon and metadata with no error");
  assert.equal(dialog.querySelector('[data-ql="next"]').disabled, true);
  assert.match(dialog.querySelector(".ql-meta").textContent, /XLSX/);
  key(dialog, " ");
  assert.equal(dialog.open, false, "Space closes");
  rows[1].focus();
  key(rows[1], " ");
  rows[1].remove();
  dialog.querySelector('[data-ql="open"]').click();
  await until(() => w.document.querySelector(".file-hero .file-hero-stage img"));
  assert.equal(dialog.open, false);
  assert.ok(w.document.querySelector(".file-history-summary .stats"), "the preview heads File detail above its stats");
});

test("Command-K opens one palette with typed groups and no scopes, walks results with the keyboard, runs actions and remembers searches", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-palette-"));
  init(home, { port: 0, name: "Palette" });
  const daemon = await start(home, { timer: false });
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://tauri.localhost" });
  const w = dom.window;
  w.setInterval = () => 0;
  const requests = new Set();
  t.after(async () => {
    await drainRequests(requests);
    w.close();
    await daemon.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  w.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  w.HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); this.dispatchEvent(new w.Event("close")); };
  const searches = [];
  const calls = [];
  w.__TAURI__ = {
    core: {
      invoke: async (command, args) => {
        if (command === "bootstrap") return { setup: false };
        calls.push(`${args.method || "GET"} ${args.route}`);
        if (args.route === "/v1/status")
          return { ...daemon.engine.status(), role: "replica", phase: "idle", hubId: "hub", hubName: "Casa", hub: "http://127.0.0.1:49999", volumes: [{ id: "docs", name: "documents", selected: 1, files: 3, bytes: 1, sync: { state: "idle" } }] };
        if (args.route === "/v1/remote") return { name: "Casa", volumes: [] };
        if (args.route.startsWith("/v1/search")) {
          searches.push(args.route);
          const q = new URL(args.route, "http://x").searchParams;
          if (q.get("q") === "zzzz") return { groups: [] };
          return {
            groups: [
              { type: "folders", count: 1, rows: [{ id: "docs", name: "blueprints" }] },
              { type: "photos", count: 1, rows: [{ volume: "docs", folder: "documents", gallery: false, path: "blue-door.jpg", name: "blue-door.jpg", hash: "h2", size: 10, rev: 6, kind: "image", date: "2026-09-14", cursor: "2026-09-14|blue-door.jpg" }] },
              { type: "files", count: 1, rows: [{ volume: "docs", folder: "documents", path: "plans/blueprint-v3.pdf", name: "blueprint-v3.pdf", hash: "h1", size: 2400, rev: 7 }] },
            ],
          };
        }
        if (args.route.startsWith("/v1/gallery/preview")) return { data: "data:image/png;base64,AAAA" };
        if (args.route.startsWith("/v1/activity") || args.route.startsWith("/v1/history")) return { versions: [], next: null };
        return {};
      },
    },
  };
  trackInvoke(w, requests);
  w.eval(`(async()=>{${script}\n})()`);
  await until(() => w.document.querySelector(".folder-card") && w.document.body.getAttribute("aria-busy") === "false");
  const press = (key, extra = {}) => w.document.body.dispatchEvent(new w.KeyboardEvent("keydown", { key, bubbles: true, ...extra }));
  press("k", { ctrlKey: true });
  const dialog = w.document.getElementById("palette");
  assert.ok(dialog.open, "Control-K opens it from any page");
  assert.match(dialog.textContent, /Actions/);
  assert.deepEqual([...dialog.querySelectorAll('[role="group"][aria-label="Actions"] strong')].map((n) => n.textContent), ["Sync now", "Pause sync", "Choose folders…", "Open Settings"], "an empty field is a launcher");
  const type = (value) => {
    const input = dialog.querySelector(".pal-input");
    input.value = value;
    input.dispatchEvent(new w.Event("input", { bubbles: true }));
  };
  type("blue");
  await until(() => dialog.querySelector('[aria-label="Files"]'));
  assert.equal(dialog.querySelector(".pal-scopes, [data-pal-scope]"), null, "the groups separate the kinds; there are no scopes");
  assert.equal(dialog.querySelector(".pal-input").placeholder, "Search Arca");
  assert.deepEqual([...dialog.querySelectorAll(".pal-group")].map((g) => g.getAttribute("aria-label")), ["Folders", "Photos", "Files"]);
  assert.equal(dialog.querySelectorAll(".pal-thumbs .pal-cell").length, 1, "photos are a thumbnail row");
  await until(() => dialog.querySelector(".pal-thumb img"));
  assert.match(dialog.querySelector('[aria-label="Folders"]').textContent, /blueprints\s*Folder · 3 files\s*Open/);
  assert.match(dialog.querySelector('[aria-label="Files"]').textContent, /blueprint-v3\.pdf\s*plans · 2\.3 KB\s*Details/);
  assert.match(dialog.querySelector(".pal-foot").textContent, /Open.*Ctrl↵Show in folder/, "the foot names Show in folder");
  assert.equal(dialog.querySelector('[role="option"][aria-selected="true"]').textContent.includes("blueprints"), true, "the first row is selected");
  press("ArrowDown");
  assert.equal(dialog.querySelector('[role="option"][aria-selected="true"]').textContent.includes("Sep 14, 2026"), true, "arrows walk into the photo cells");
  press("ArrowUp");
  press("ArrowUp");
  assert.equal(dialog.querySelector('[role="option"][aria-selected="true"]').textContent.includes("blueprint-v3.pdf"), true, "the selection wraps");
  const flights = [];
  w.Element.prototype.animate = function (frames, options) {
    flights.push({ element: this, frames, options });
    return { cancel() {} };
  };
  const place = (node) => [...node.parentNode.children].filter((n) => n.matches("button")).indexOf(node);
  const originals = ["offsetWidth", "offsetLeft"].map((name) => [name, Object.getOwnPropertyDescriptor(w.HTMLElement.prototype, name)]);
  Object.defineProperty(w.HTMLElement.prototype, "offsetWidth", { configurable: true, get() { return this.matches("button") ? 60 : this.matches(".segmented") ? 240 : 0; } });
  Object.defineProperty(w.HTMLElement.prototype, "offsetLeft", { configurable: true, get() { return this.matches("button") ? place(this) * 60 : 0; } });
  w.document.documentElement.style.setProperty("--motion-fast", "120ms");
  dialog.insertAdjacentHTML("beforeend", '<div class="segmented" role="group" aria-label="Probe"><button type="button" class="active" aria-pressed="true">All</button><button type="button" aria-pressed="false">Files</button><button type="button" aria-pressed="false">Photos</button><button type="button" aria-pressed="false">Music</button></div>');
  const segments = [...dialog.querySelectorAll('.segmented[aria-label="Probe"] button')];
  const pick = (index) => segments.forEach((button, i) => {
    button.classList.toggle("active", i === index);
    button.setAttribute("aria-pressed", String(i === index));
  });
  pick(1);
  await until(() => dialog.querySelector(".segmented-thumb"));
  assert.ok(dialog.querySelector(".segmented").classList.contains("has-thumb"));
  await new Promise((resolve) => setTimeout(resolve, 60));
  let churn = 0;
  const probe = new w.MutationObserver((records) => (churn += records.length));
  probe.observe(dialog, { attributes: true, subtree: true, attributeFilter: ["class"] });
  await new Promise((resolve) => setTimeout(resolve, 150));
  probe.disconnect();
  assert.equal(churn, 0, "placing the pill does not retrigger itself");
  pick(3);
  await until(() => flights.some((flight) => flight.element.matches?.(".segmented-thumb")));
  assert.equal(flights.find((flight) => flight.element.matches(".segmented-thumb")).frames[0].transform, "translate(-120px, 0px) scale(1, 1)", "the selected pill slides to the new segment");
  Object.defineProperty(w.document, "hidden", { configurable: true, get: () => false });
  const content = w.document.querySelector("#content");
  await new Promise((resolve) => setTimeout(resolve, 1600));
  content.insertAdjacentHTML("beforeend", '<span class="pill ok probe">Up to date</span><span class="filter-count">3</span>');
  await new Promise((resolve) => setTimeout(resolve, 80));
  const quiet = flights.filter((flight) => flight.element.matches?.(".probe, .filter-count")).length;
  assert.equal(quiet, 0, "a first sight animates nothing");
  content.querySelector(".probe").className = "pill wa probe";
  content.querySelector(".probe").textContent = "Syncing";
  content.querySelector(".filter-count").textContent = "4";
  await until(() => flights.filter((flight) => flight.element.matches?.(".probe, .filter-count")).length >= 2);
  const moved = flights.filter((flight) => flight.element.matches?.(".probe, .filter-count"));
  assert.ok(moved.some((flight) => flight.element.matches(".filter-count") && /translateY\(4px\)/.test(flight.frames[0].transform)), "a changed count rolls in");
  assert.ok(moved.some((flight) => flight.element.matches(".probe") && flight.frames[0].opacity === 0.35), "a changed status cross-fades");
  content.querySelector(".probe").remove();
  content.querySelector(".filter-count").remove();
  for (const [name, descriptor] of originals) Object.defineProperty(w.HTMLElement.prototype, name, descriptor);
  delete w.Element.prototype.animate;
  dialog.querySelector('.segmented[aria-label="Probe"]').remove();
  assert.ok(searches.every((route) => !route.includes("scope=")), "no scope is ever sent");
  press("Enter");
  await until(() => !dialog.open);
  await until(() => /Device|History|blueprint/i.test(w.document.querySelector("#content h1")?.textContent || ""));
  assert.ok(calls.some((call) => call.includes("/v1/history?") && call.includes("blueprint-v3.pdf")), "Enter on a file opens its detail");
  assert.deepEqual(JSON.parse(w.localStorage.getItem("arca-palette-recent")), ["blue"], "an opened result remembers its search");
  press("k", { metaKey: true });
  assert.ok(dialog.open);
  assert.match(dialog.querySelector('[aria-label="Recent searches"]').textContent, /blue/);
  type("zzzz");
  await until(() => dialog.querySelector(".empty"));
  assert.match(dialog.querySelector(".empty").textContent, /No matches for “zzzz”/);
  type("sync");
  await until(() => dialog.querySelector('[aria-label="Actions"]'));
  dialog.querySelector('[aria-label="Actions"] [data-pal]').click();
  await until(() => !dialog.open);
  await until(() => calls.includes("POST /v1/sync"));
  press("k", { ctrlKey: true });
  press("k", { ctrlKey: true });
  assert.equal(dialog.open, false, "the shortcut toggles it");
});

test("rows cascade in on a new route, a new arrival settles once and a folder's tile travels into its header", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-motion-"));
  init(home, { port: 0, name: "Motion" });
  const daemon = await start(home, { timer: false });
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://tauri.localhost", pretendToBeVisual: true });
  const w = dom.window;
  let poll;
  w.setInterval = (callback, ms) => {
    if (ms === 5000) poll = callback;
    return 0;
  };
  const requests = new Set();
  t.after(async () => {
    await drainRequests(requests);
    w.close();
    await daemon.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const base = { selected: 1, sync: { state: "idle", lastCompleted: new Date().toISOString() }, conflicts: 0, files: 1, bytes: 1, path: "/x" };
  const volumes = Array.from({ length: 8 }, (_, i) => ({ ...base, id: `v${i}`, name: `folder-${i}` }));
  const animations = [];
  w.Element.prototype.animate = function (frames, options) {
    animations.push({ element: this, frames, options });
    return { cancel() {} };
  };
  w.Element.prototype.getBoundingClientRect = function () {
    return this.matches?.(".home-lead, .tile") && this.closest?.(".folder-card")
      ? { left: 100, top: 200, width: 40, height: 40 }
      : this.matches?.(".detail-title .tile")
        ? { left: 20, top: 40, width: 80, height: 80 }
        : { left: 0, top: 0, width: 0, height: 0 };
  };
  w.document.documentElement.style.setProperty("--motion-enter", "200ms");
  w.document.documentElement.style.setProperty("--motion-stagger", "20ms");
  w.document.documentElement.style.setProperty("--motion-shared", "280ms");
  w.document.documentElement.style.setProperty("--motion-settle", "1800ms");
  w.document.documentElement.style.setProperty("--motion-distance", "8px");
  w.__TAURI__ = {
    core: {
      invoke: async (command, args) => {
        if (command === "bootstrap") return { setup: false };
        if (args.route === "/v1/status")
          return { ...daemon.engine.status(), role: "replica", phase: "idle", hubId: "hub", hubName: "Casa", hub: "http://127.0.0.1:49999", volumes };
        if (args.route === "/v1/remote") return { name: "Casa", volumes };
        if (args.route === "/v1/machines") return { machines: [] };
        if (args.route.startsWith("/v1/activity")) return { versions: [], next: null };
        if (args.route.startsWith("/v1/browse")) return { entries: [], next: null };
        return {};
      },
    },
  };
  trackInvoke(w, requests);
  w.eval(`(async()=>{${script}\n})()`);
  await until(() => w.document.querySelectorAll(".folder-card").length === 8 && w.document.body.getAttribute("aria-busy") === "false");
  const rise = animations.filter((a) => a.element.matches?.(".folder-card") && a.options.fill === "backwards");
  assert.equal(rise.length, 6, "at most six rows cascade");
  assert.deepEqual(rise.map((a) => a.options.delay), [0, 20, 40, 60, 80, 100], "a 20 ms step");
  assert.equal(JSON.stringify(rise[0].frames[0]), JSON.stringify({ opacity: 0, transform: "translateY(8px)" }));
  assert.equal(w.document.querySelector(".row-arrived"), null, "rows present at first paint are not arrivals");
  await new Promise((resolve) => setTimeout(resolve, 100));
  volumes.push({ ...base, id: "v8", name: "folder-8" });
  await poll();
  await until(() => w.document.querySelectorAll(".folder-card").length === 9);
  await until(() => w.document.querySelector(".folder-card.row-arrived"));
  assert.equal(w.document.querySelectorAll(".row-arrived").length, 1, "only the new row settles");
  assert.match(w.document.querySelector(".row-arrived").textContent, /folder-8/);
  const before = animations.length;
  w.document.querySelector('.folder-card[data-id="v0"]').click();
  await until(() => w.document.querySelector(".detail-title .tile"));
  await until(() => animations.some((a, i) => i >= before && a.element.matches?.(".detail-title .tile")));
  const travel = animations.find((a, i) => i >= before && a.element.matches?.(".detail-title .tile"));
  assert.equal(travel.options.duration, 280);
  assert.equal(travel.frames[0].transform, "translate(80px, 160px) scale(0.5, 0.5)", "the header tile starts where the card's tile was");
  assert.equal(travel.frames[1].transform, "none");
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
  await until(() => w.document.querySelectorAll(".photo-thumb").length === 66, 3000);
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

test("the gallery header counts photos that are still waiting for a date", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-gallery-undated-"));
  init(home, { port: 0, name: "Gallery" });
  const daemon = await start(home, { timer: false });
  const v = daemon.engine.store.addVolume("Photos");
  const sharp = (await import("sharp")).default;
  const image = await sharp({ create: { width: 8, height: 8, channels: 3, background: "blue" } }).jpeg().toBuffer();
  for (const name of ["first.jpg", "second.jpg", "third.jpg"]) fs.writeFileSync(path.join(v.path, name), image);
  await daemon.engine.cycle();
  const db = daemon.engine.store.db;
  db.prepare("INSERT OR IGNORE INTO gallery_folders VALUES(?)").run(v.id);
  await daemon.engine.gallery.background;
  db.prepare("DELETE FROM revisions").run();
  for (const name of ["first.jpg", "second.jpg", "third.jpg"])
    db.prepare("INSERT OR REPLACE INTO gallery_metadata(hash,captured,date_checked) VALUES(?,NULL,1)").run(
      daemon.engine.store.current(v.id, name).hash,
    );
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://tauri.localhost" });
  const w = dom.window;
  w.setInterval = () => 0;
  w.IntersectionObserver = class {
    observe() {}
    disconnect() {}
  };
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
          if (command === "bootstrap") return { setup: false, status: daemon.engine.status() };
          if (command !== "api") throw new Error(command);
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
  await until(() => w.document.querySelectorAll(".photo-thumb").length === 3);
  const summary = w.document.querySelector(".detail-head .heading p");
  assert.match(summary.textContent, /^3 photos · /, "three tiles read 3 photos, never 0");
  w.dispatchEvent(new w.HashChangeEvent("hashchange"));
  await until(() => w.document.querySelectorAll(".photo-thumb").length === 3 && w.document.querySelector(".photo-timeline"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.match(w.document.querySelector(".detail-head .heading p").textContent, /^3 photos · /, "a re-render keeps counting the undated photos");
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
    assert.match(page.textContent, /The command prints a result that includes a six-digit code\. Enter that code below\./);
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
  assert.equal(content.querySelector('.pagination button[data-action="history-page"]').textContent.trim(), "Show more versions");
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
    assert.equal(restore.getAttribute("aria-disabled"), "true", "Restore needs the hub");
    assert.match(restore.dataset.tooltip, /Needs the hub, which is unavailable\./);
    assert.equal(restore.dataset.action, "restore", "it is the same control the hub-only sync re-enables");
  }
  hubDown = false;
  await poll();
  await until(() => restores.every((restore) => !restore.hasAttribute("aria-disabled") && !restore.dataset.tooltip));
  hubDown = true;
  await poll();
  await until(() => restores.every((restore) => restore.getAttribute("aria-disabled") === "true"));
  const quiet = w.document.createElement("button");
  quiet.dataset.action = "activity-file";
  quiet.dataset.id = JSON.stringify({ volume: volume.id, path: "quiet.md" });
  w.document.body.append(quiet);
  quiet.click();
  await until(() => w.document.querySelector("#history-list .hint")?.textContent.startsWith("Showing saved history. ") && w.document.body.getAttribute("aria-busy") === "false");
  assert.equal(w.document.querySelector("#history-list .hint").textContent, "Showing saved history. Connect to the hub for updated retention.", "a complete saved history does not claim to be recent entries only");
});

test("the Files list appends pages under one Show more files button, has no search of its own and stops at 500 rows", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-files-more-"));
  init(home, { port: 0, name: "Local Mac" });
  const daemon = await start(home, { timer: false });
  const volume = daemon.engine.store.addVolume("Docs");
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://tauri.localhost" });
  const requests = new Set();
  const browsed = [];
  t.after(async () => {
    await drainRequests(requests);
    dom.window.close();
    await daemon.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const w = dom.window;
  w.setInterval = () => 0;
  const page = (after) => {
    const index = after ? Number(after.slice(1)) : 0;
    return {
      entries: Array.from({ length: 100 }, (_, n) => {
        const name = `f${String(index * 100 + n).padStart(3, "0")}.txt`;
        return { path: name, name, size: 10, rev: 1, directory: false };
      }),
      next: index < 5 ? `p${index + 1}` : null,
    };
  };
  w.__TAURI__ = {
    core: {
      invoke: async (command, args) => {
        if (command === "bootstrap") return { setup: false };
        if (args.route === "/v1/status")
          return { ...daemon.engine.status(), platform: "darwin", role: "replica", hubUnavailable: false, hubName: "Casa", hub: "http://127.0.0.1:49999" };
        if (args.route === "/v1/remote") return { name: "Casa", volumes: [{ ...volume, selected: 1, gallery: false }] };
        if (args.route === "/v1/machines") return { machines: [] };
        if (args.route.startsWith("/v1/browse")) {
          const query = new URL(args.route, "http://x").searchParams;
          browsed.push({ after: query.get("after"), search: query.get("search") });
          return page(query.get("after"));
        }
        if (args.route.startsWith("/v1/activity") || args.route.startsWith("/v1/history")) return { versions: [], next: null };
        return {};
      },
    },
  };
  trackInvoke(w, requests);
  w.eval(`(async()=>{${script}\n})()`);
  await until(() => w.document.querySelector('.folder-card[data-action="folder-detail"]'));
  w.document.querySelector('.folder-card[data-action="folder-detail"]').click();
  const rows = () => w.document.querySelectorAll(".browser-file-row").length;
  const more = () => w.document.querySelector('[data-action="browse-more"]');
  await until(() => rows() === 100 && w.document.body.getAttribute("aria-busy") === "false");
  assert.equal(more().textContent.trim(), "Show more files");
  assert.doesNotMatch(w.document.body.textContent, /First files|Next files/);
  w.document.querySelector(".page").scrollTop = 123;
  const button = more();
  button.click();
  button.click();
  await until(() => rows() === 200 && w.document.body.getAttribute("aria-busy") === "false");
  assert.equal(new Set([...w.document.querySelectorAll(".browser-file-row")].map((row) => row.getAttribute("aria-label"))).size, 200, "a double click appends the page once");
  assert.equal(w.document.querySelector(".page").scrollTop, 123, "Show more keeps the scroll position");
  assert.ok(w.document.querySelector('.browser-file-row[aria-label="Open f000.txt"]'), "the first rows stay");
  assert.ok(w.document.querySelector('.browser-file-row[aria-label="Open f199.txt"]'), "the next page is appended");
  for (const rowsAfter of [300, 400, 500]) {
    more().click();
    await until(() => rows() === rowsAfter && w.document.body.getAttribute("aria-busy") === "false");
  }
  assert.equal(more(), null, "the list stops growing at 500 rows");
  assert.match(w.document.querySelector(".hint").textContent, /Showing the first 500 files\. Search Arca to find the rest\./);
  assert.ok(browsed.every((request) => request.search === null), "the folder browser never filters by itself");
  assert.equal(w.document.querySelector('[data-action="folder-search-toggle"], #folder-search-input'), null, "the one search is the palette");
});

test("Show more still lists every file when the folder gained one at the top meanwhile", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-files-shift-"));
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
  const names = Array.from({ length: 130 }, (_, n) => `f${String(n).padStart(3, "0")}.txt`);
  const page = (after) => {
    const rest = names.filter((name) => !after || name > after);
    const entries = rest.slice(0, 100).map((name) => ({ path: name, name, size: 10, rev: 1, directory: false }));
    return { entries, next: rest.length > 100 ? entries.at(-1).name : null };
  };
  w.__TAURI__ = {
    core: {
      invoke: async (command, args) => {
        if (command === "bootstrap") return { setup: false };
        if (args.route === "/v1/status")
          return { ...daemon.engine.status(), platform: "darwin", role: "replica", hubUnavailable: false, hubName: "Casa", hub: "http://127.0.0.1:49999" };
        if (args.route === "/v1/remote") return { name: "Casa", volumes: [{ ...volume, selected: 1, gallery: false }] };
        if (args.route === "/v1/machines") return { machines: [] };
        if (args.route.startsWith("/v1/browse")) return page(new URL(args.route, "http://x").searchParams.get("after"));
        if (args.route.startsWith("/v1/activity") || args.route.startsWith("/v1/history")) return { versions: [], next: null };
        return {};
      },
    },
  };
  trackInvoke(w, requests);
  w.eval(`(async()=>{${script}\n})()`);
  await until(() => w.document.querySelector('.folder-card[data-action="folder-detail"]'));
  w.document.querySelector('.folder-card[data-action="folder-detail"]').click();
  const rows = () => w.document.querySelectorAll(".browser-file-row").length;
  await until(() => rows() === 100 && w.document.body.getAttribute("aria-busy") === "false");
  names.unshift("a000.txt");
  w.document.querySelector('[data-action="browse-more"]').click();
  await until(() => rows() === 131 && w.document.body.getAttribute("aria-busy") === "false");
  assert.ok(w.document.querySelector('.browser-file-row[aria-label="Open f099.txt"]'), "the file that moved past the first page is still listed");
  assert.equal(w.document.querySelector('[data-action="browse-more"]'), null);
});

test("only the native macOS app marks the page so the viewer's Back button clears the window controls", async (t) => {
  const open = async (native, platform) => {
    const dom = new JSDOM(html, { runScripts: "outside-only", url: native ? "http://tauri.localhost" : "http://127.0.0.1:17831" });
    t.after(() => dom.window.close());
    const w = dom.window;
    w.setInterval = () => 0;
    Object.defineProperty(w.navigator, "platform", { value: platform, configurable: true });
    if (platform === "") Object.defineProperty(w.navigator, "userAgent", { value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)", configurable: true });
    if (native) w.__TAURI__ = { core: { invoke: async () => ({}) } };
    w.eval(`(async()=>{${script}\n})()`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    return [...w.document.body.classList];
  };
  assert.deepEqual((await open(true, "MacIntel")).filter((name) => name.endsWith("native")).sort(), ["mac-native", "native"]);
  assert.deepEqual((await open(true, "")).filter((name) => name.endsWith("native")).sort(), ["mac-native", "native"], "a webview without a platform falls back to its user agent");
  assert.deepEqual((await open(true, "Win32")).filter((name) => name.endsWith("native")), ["native"]);
  assert.deepEqual((await open(true, "Linux x86_64")).filter((name) => name.endsWith("native")), ["native"]);
  assert.deepEqual((await open(false, "MacIntel")).filter((name) => name.endsWith("native")), [], "the web interface on a Mac keeps its layout");
});

test("History groups rows under Today, Yesterday and a short date and shows each row's clock time", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-history-days-"));
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
  const days = [0, 1, 400].map((back) => {
    const day = new Date();
    day.setDate(day.getDate() - back);
    return day.toISOString();
  });
  const versions = days.map((created, n) => ({ rev: 10 - n, path: `file-${n}.txt`, volume: volume.id, folder: "Docs", created, size: 10, deleted: 0, author: "mac" }));
  w.__TAURI__ = {
    core: {
      invoke: async (command, args) => {
        if (command === "bootstrap") return { setup: false };
        if (args.route === "/v1/status")
          return { ...daemon.engine.status(), platform: "darwin", role: "replica", hubUnavailable: false, hubName: "Casa", hub: "http://127.0.0.1:49999" };
        if (args.route === "/v1/remote") return { name: "Casa", volumes: [{ ...volume, selected: 1, gallery: false }] };
        if (args.route === "/v1/machines") return { machines: [] };
        if (args.route.startsWith("/v1/browse")) return { entries: [], next: null };
        if (args.route.startsWith("/v1/activity")) return { versions, next: null };
        return {};
      },
    },
  };
  trackInvoke(w, requests);
  w.eval(`(async()=>{${script}\n})()`);
  await until(() => w.document.querySelector(".folder-card") && w.document.body.getAttribute("aria-busy") === "false");
  w.document.querySelector('[data-view="history"]').click();
  await until(() => w.document.querySelectorAll("#history-list .history-row").length === 3);
  const labels = [...w.document.querySelectorAll("#history-list .section-label")].map((label) => label.textContent.trim());
  assert.equal(labels[0], "Today");
  assert.equal(labels[1], "Yesterday");
  assert.match(labels[2], /^[A-Z][a-z]{2} \d{1,2}, \d{4}$/, "an older year keeps its year");
  for (const time of w.document.querySelectorAll("#history-list .history-row .row-time"))
    assert.match(time.textContent.trim(), /^\d{2}:\d{2}$/);
});
