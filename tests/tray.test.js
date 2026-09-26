import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { JSDOM } from "jsdom";

test("disconnected tray keeps the Arca header and explicit static folder warnings", async () => {
  const dom = new JSDOM('<div id="tray-content"></div>', {
    runScripts: "outside-only",
    url: "http://tauri.localhost",
  });
  const w = dom.window;
  w.setInterval = () => 0;
  w.matchMedia = () => ({ matches: false });
  w.ResizeObserver = class {
    observe() {}
  };
  w.lucide = { createIcons() {} };
  w.__TAURI__ = {
    core: {
      invoke: async () => ({
        name: "Mac",
        role: "replica",
        phase: "unlinked",
        lastSync: null,
        volumes: [
          {
            id: "saved",
            name: "Saved folder",
            selected: true,
            sync: { state: "synced" },
          },
        ],
      }),
    },
  };
  try {
    const source = fs.readFileSync(
      new URL("../apps/desktop/src/tray.js", import.meta.url),
      "utf8",
    );
    await w.eval(`(async () => {${source}\n})()`);
    assert.equal(
      w.document.querySelector(".tray-heading strong").textContent,
      "Disconnected",
    );
    const logo = w.document.querySelector(".tray-heading .tray-brand-icon");
    assert.equal(logo.getAttribute("src"), "assets/arca-icon.svg");
    assert.equal(logo.getAttribute("alt"), "Arca");
    assert.ok(w.document.querySelector(".tray-heading.tray-tone-conflict"));
    assert.ok(
      w.document.querySelector('[data-folder="saved"] [data-lucide="folder"]'),
    );
    assert.ok(
      w.document.querySelector('[data-folder="saved"].tray-tone-disconnected'),
    );
    assert.equal(
      w.document.querySelector('[data-folder="saved"] small').textContent,
      "Disconnected",
    );
    assert.equal(
      w.document.querySelectorAll('.busy-grid, [data-lucide="circle-check"]')
        .length,
      0,
    );
    assert.equal(
      w.document.querySelector(".tray-menu").nextElementSibling.id,
      "tray-error",
    );
    assert.doesNotMatch(w.document.body.textContent, /keeps the daemon running/);
  } finally {
    dom.window.close();
  }
});

test("tray includes gallery folders beyond six rows and preserves scroll on refresh", async () => {
  const dom = new JSDOM('<div id="tray-content"></div>', {
    runScripts: "outside-only",
    url: "http://tauri.localhost",
  });
  const w = dom.window;
  w.setInterval = () => 0;
  w.matchMedia = () => ({ matches: false });
  w.ResizeObserver = class {
    observe() {}
  };
  w.lucide = { createIcons() {} };
  const calls = [];
  const volumes = Array.from({ length: 12 }, (_, i) => ({
    id: `folder-${i}`,
    name: i === 6 ? "photos-yuri" : `Folder ${i}`,
    selected: true,
    gallery: i === 6,
    bytes: 1024,
    sync: { state: "synced" },
  }));
  w.__TAURI__ = {
    core: {
      invoke: async (command, args) => {
        calls.push({ command, args });
        return { role: "replica", phase: "idle", volumes };
      },
    },
  };
  try {
    const source = fs.readFileSync(
      new URL("../apps/desktop/src/tray.js", import.meta.url),
      "utf8",
    );
    await w.eval(`(async () => {${source}\nwindow.refreshTray = refresh;})()`);
    assert.equal(w.document.querySelectorAll("[data-folder]").length, 12);
    assert.ok(
      w.document.querySelector(
        '[data-folder="folder-6"] [data-lucide="images"]',
      ),
    );
    w.document.querySelector(".tray-folders").scrollTop = 180;
    await w.refreshTray();
    assert.equal(w.document.querySelector(".tray-folders").scrollTop, 180);
    w.document.querySelector('[data-folder="folder-6"]').click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(
      calls.some(
        ({ command, args }) =>
          command === "show_main" && args.folder === "folder-6",
      ),
    );
  } finally {
    w.close();
  }
});

test("tray offers Open Arca only while the main window is hidden or minimized", async () => {
  const dom = new JSDOM('<div id="tray-content"></div>', {
    runScripts: "outside-only",
    url: "http://tauri.localhost",
  });
  const w = dom.window;
  w.setInterval = () => 0;
  w.matchMedia = () => ({ matches: false });
  w.ResizeObserver = class {
    observe() {}
  };
  w.lucide = { createIcons() {} };
  let windowOpen = true;
  w.__TAURI__ = {
    core: {
      invoke: async (command) =>
        command === "main_window_open"
          ? windowOpen
          : { role: "replica", phase: "idle", volumes: [] },
    },
  };
  try {
    const source = fs.readFileSync(
      new URL("../apps/desktop/src/tray.js", import.meta.url),
      "utf8",
    );
    await w.eval(`(async () => {${source}\n})()`);
    const open = () => w.document.querySelector('[data-action="open"]');
    assert.equal(open(), null);
    assert.ok(w.document.querySelector('[data-action="quit"]'));
    windowOpen = false;
    w.dispatchEvent(new w.Event("focus"));
    for (let i = 0; i < 20 && !open(); i++)
      await new Promise((resolve) => setImmediate(resolve));
    assert.match(open().textContent, /Open Arca/);
  } finally {
    w.close();
  }
});

test("tray closes after Sync now or Pause succeeds and stays open to show a failure", async () => {
  const dom = new JSDOM('<div id="tray-content"></div>', {
    runScripts: "outside-only",
    url: "http://tauri.localhost",
  });
  const w = dom.window;
  w.setInterval = () => 0;
  w.matchMedia = () => ({ matches: false });
  w.ResizeObserver = class {
    observe() {}
  };
  w.lucide = { createIcons() {} };
  const calls = [];
  let failure = null;
  w.__TAURI__ = {
    core: {
      invoke: async (command, args) => {
        calls.push(command === "api" ? args.route : command);
        if (command === "main_window_open") return false;
        if (command === "hide_tray") return;
        if (failure && args?.route === "/v1/sync") throw failure;
        return { role: "replica", phase: "idle", volumes: [] };
      },
    },
  };
  const settle = async () => {
    for (let i = 0; i < 20; i++)
      await new Promise((resolve) => setImmediate(resolve));
  };
  try {
    const source = fs.readFileSync(
      new URL("../apps/desktop/src/tray.js", import.meta.url),
      "utf8",
    );
    await w.eval(`(async () => {${source}\n})()`);
    w.document.querySelector('[data-action="sync"]').click();
    await settle();
    assert.deepEqual(
      calls.slice(calls.indexOf("/v1/sync"), calls.indexOf("/v1/sync") + 2),
      ["/v1/sync", "hide_tray"],
    );
    calls.length = 0;
    w.document.querySelector('[data-action="pause"]').click();
    await settle();
    assert.deepEqual(calls.slice(0, 2), ["/v1/pause", "hide_tray"]);
    calls.length = 0;
    failure = new Error("The daemon is unavailable. Use Start service.");
    w.document.querySelector('[data-action="sync"]').click();
    await settle();
    assert.equal(calls.includes("hide_tray"), false);
    assert.match(
      w.document.querySelector("#tray-error").textContent,
      /daemon is unavailable/,
    );
  } finally {
    w.close();
  }
});

test("tray offers Start service and Quit while the daemon is unavailable", async () => {
  const dom = new JSDOM('<div id="tray-content"></div>', {
    runScripts: "outside-only",
    url: "http://tauri.localhost",
  });
  const w = dom.window;
  w.setInterval = () => 0;
  w.matchMedia = () => ({ matches: false });
  w.ResizeObserver = class {
    observe() {}
  };
  w.lucide = { createIcons() {} };
  const calls = [];
  let running = false;
  w.__TAURI__ = {
    core: {
      invoke: async (command, args) => {
        calls.push(command === "api" ? args.route : command);
        if (command === "main_window_open") return false;
        if (command === "start_daemon") {
          running = true;
          return;
        }
        if (!running) throw "The daemon is unavailable. Use Start service.";
        return { role: "replica", phase: "idle", volumes: [] };
      },
    },
  };
  const settle = async () => {
    for (let i = 0; i < 20; i++)
      await new Promise((resolve) => setImmediate(resolve));
  };
  try {
    const source = fs.readFileSync(
      new URL("../apps/desktop/src/tray.js", import.meta.url),
      "utf8",
    );
    await w.eval(`(async () => {${source}\n})()`);
    assert.equal(
      w.document.querySelector(".tray-heading strong").textContent,
      "Daemon unavailable",
    );
    assert.deepEqual(
      [...w.document.querySelectorAll(".tray-menu button")].map(
        (button) => button.dataset.action,
      ),
      ["start", "open", "quit"],
    );
    w.document.querySelector('[data-action="start"]').click();
    await settle();
    assert.ok(calls.includes("start_daemon"));
    assert.equal(
      w.document.querySelector(".tray-heading strong").textContent,
      "Up to date",
    );
  } finally {
    w.close();
  }
});
