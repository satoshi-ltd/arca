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
    name: i === 6 ? "photos-yuri" : i === 7 ? "music" : `Folder ${i}`,
    selected: true,
    gallery: i === 6,
    music: i === 7,
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
      ) && w.document.querySelector(
        '[data-folder="folder-7"] [data-lucide="music"]',
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

test("tray heading reads Offline while the hub is unavailable, except when paused or disconnected", async () => {
  const run = async (status) => {
    const dom = new JSDOM('<div id="tray-content"></div>', { runScripts: "outside-only", url: "http://tauri.localhost" });
    const w = dom.window;
    w.setInterval = () => 0;
    w.matchMedia = () => ({ matches: false });
    w.ResizeObserver = class { observe() {} };
    w.lucide = { createIcons() {} };
    w.__TAURI__ = { core: { invoke: async () => ({ name: "Mac", role: "replica", lastSync: "2026-09-30T14:02:00.000Z", volumes: [], ...status }) } };
    try {
      const source = fs.readFileSync(new URL("../apps/desktop/src/tray.js", import.meta.url), "utf8");
      await w.eval(`(async () => {${source}\n})()`);
      const heading = w.document.querySelector(".tray-heading");
      return { text: heading.querySelector("strong").textContent, tone: [...heading.classList].find((name) => name.startsWith("tray-tone-")) };
    } finally {
      dom.window.close();
    }
  };
  for (const phase of ["offline", "syncing", "idle", "error"])
    assert.deepEqual(await run({ phase, hubUnavailable: true }), { text: "Offline", tone: "tray-tone-disconnected" }, phase);
  assert.deepEqual(await run({ phase: "syncing", hubUnavailable: false }), { text: "Syncing", tone: "tray-tone-syncing" });
  assert.deepEqual(await run({ phase: "error", hubUnavailable: false }), { text: "Needs attention", tone: "tray-tone-error" });
  assert.deepEqual(await run({ phase: "paused", hubUnavailable: true }), { text: "Paused", tone: "tray-tone-paused" });
  assert.deepEqual(await run({ phase: "unlinked", hubUnavailable: true }), { text: "Disconnected", tone: "tray-tone-conflict" });
});

test("the native tray reads offline while only the hub is unreachable", () => {
  const source = fs.readFileSync(new URL("../apps/desktop/src-tauri/src/main.rs", import.meta.url), "utf8");
  assert.match(source, /let offline = status\["phase"\] == "offline";/);
  assert.match(source, /\(!offline && status\["error"\]\.as_str\(\)\.is_some\(\)\)/, "the hub's own error no longer raises the alert");
  assert.match(source, /"offline" if tray_state\(status\) == "alert" => "Arca · needs attention",\s+"offline" => "Arca · offline",/);
  assert.match(source, /Ok\(s\) => tray_text\(s\),/, "the tooltip comes from tray_text");
  assert.match(source, /fn an_unreachable_hub_reads_offline_but_other_problems_still_raise_the_alert\(\)/, "the Rust test exists");
});

test("tray shows Now playing from the main window's music-state and sends each music-command", async () => {
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
  const emitted = [];
  const listeners = {};
  const volumes = Array.from({ length: 10 }, (_, i) => ({
    id: `folder-${i}`,
    name: i ? `Folder ${i}` : "music",
    selected: true,
    music: !i,
    bytes: 1024,
    sync: { state: "synced" },
  }));
  w.__TAURI__ = {
    core: {
      invoke: async (command, args) => {
        calls.push({ command, args });
        if (command === "api" && args.route.startsWith("/v1/music/cover?"))
          return { data: "data:image/jpeg;base64,AAAA" };
        if (command === "main_window_open") return false;
        return { role: "replica", phase: "idle", volumes };
      },
    },
    event: {
      listen: async (name, handler) => {
        listeners[name] = handler;
        return () => {};
      },
      emit: async (name, payload) => {
        emitted.push({ name, payload });
      },
    },
  };
  const playing = {
    title: "Flamenco Sketches",
    artist: "Miles Davis",
    album: "Kind of Blue",
    folder: "folder-0",
    cover: "a".repeat(64),
    playing: true,
  };
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  try {
    const source = fs.readFileSync(
      new URL("../apps/desktop/src/tray.js", import.meta.url),
      "utf8",
    );
    await w.eval(`(async () => {${source}\nwindow.refreshTray = refresh;})()`);
    const $ = (selector) => w.document.querySelector(selector);
    assert.deepEqual(
      emitted.map(({ name, payload }) => [name, payload.command]),
      [["music-command", "state"]],
      "the popover asks for the player state on load",
    );
    assert.equal($(".tray-music"), null);
    listeners["music-state"]({ payload: playing });
    await settle();
    assert.ok($(".tray-heading + .tray-music + .tray-folders"), "between the header and the folders");
    assert.equal($(".tray-music strong").textContent, "Flamenco Sketches");
    assert.equal($(".tray-music .music-mini-text > span").textContent, "Miles Davis · Kind of Blue");
    assert.equal($('.tray-music [data-music="toggle"]').getAttribute("aria-label"), "Pause");
    assert.ok(calls.some(({ args }) => args?.route?.startsWith("/v1/music/cover?volume=folder-0&key=aaaa")));
    assert.equal($(".tray-music .music-cover img")?.getAttribute("src"), "data:image/jpeg;base64,AAAA");
    const toggle = $('.tray-music [data-music="toggle"]');
    const next = $('.tray-music [data-music="next"]');
    assert.equal(next.disabled, false);
    listeners["music-state"]({ payload: { ...playing, playing: false } });
    assert.equal($('.tray-music [data-music="toggle"]').getAttribute("aria-label"), "Play");
    listeners["music-state"]({ payload: { ...playing, title: "All Blues", playing: false, next: false } });
    assert.equal($('.tray-music [data-music="toggle"]'), toggle, "the box is patched in place");
    assert.equal($('.tray-music [data-music="next"]'), next);
    assert.equal(next.disabled, true, "Next is off at the end of the queue");
    assert.equal($(".tray-music strong").textContent, "All Blues");
    assert.equal($(".tray-music .music-cover img")?.getAttribute("src"), "data:image/jpeg;base64,AAAA");
    listeners["music-state"]({ payload: { ...playing, playing: false } });
    assert.equal(
      $(".tray-music .music-mini-track").getAttribute("aria-label"),
      "Flamenco Sketches by Miles Davis, show in Arca",
    );
    for (const command of ["previous", "toggle", "next"]) {
      $(`.tray-music [data-music="${command}"]`).click();
      await settle();
      assert.deepEqual([emitted.at(-1).name, emitted.at(-1).payload.command], ["music-command", command]);
    }
    assert.ok(!calls.some(({ command }) => ["show_main", "hide_tray"].includes(command)), "controls keep the popover open");
    assert.ok($(".tray-music"));
    $(".tray-folders").scrollTop = 120;
    await w.refreshTray();
    assert.equal($(".tray-folders").scrollTop, 120);
    listeners["music-state"]({ payload: playing });
    assert.equal($(".tray-folders").scrollTop, 120);
    $(".tray-music .music-mini-track").click();
    await settle();
    await settle();
    assert.deepEqual([emitted.at(-1).name, emitted.at(-1).payload.command], ["music-command", "show"]);
    assert.ok(calls.some(({ command, args }) => command === "show_main" && args.folder === null));
    listeners["music-state"]({ payload: null });
    assert.equal($(".tray-music"), null);
  } finally {
    w.close();
  }
});

test("the folder viewport drops from 320 to 256px while Now playing shows", () => {
  const read = (name) => fs.readFileSync(new URL(`../apps/desktop/src/${name}`, import.meta.url), "utf8");
  assert.match(read("tokens.css"), /--tray-folders-max-height: 320px;/);
  assert.match(
    read("style.css"),
    /#tray-content:has\(\.tray-music\) \.tray-folders \{\n  max-height: calc\(var\(--tray-folders-max-height\) - 64px\);\n\}/,
  );
});

async function trayWithMusic(cover) {
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
  const tray = { w, emitted: [], listeners: {}, covers: [] };
  w.__TAURI__ = {
    core: {
      invoke: async (command, args) => {
        if (command === "api" && args.route.startsWith("/v1/music/cover?")) {
          const key = new URLSearchParams(args.route.split("?")[1]).get("key");
          tray.covers.push(key);
          return cover(key);
        }
        return { role: "replica", phase: "idle", volumes: [] };
      },
    },
    event: {
      listen: async (name, handler) => {
        tray.listeners[name] = handler;
        return () => {};
      },
      emit: async (name, payload) => {
        tray.emitted.push([name, payload.command]);
      },
    },
  };
  await w.eval(`(async () => {${fs.readFileSync(new URL("../apps/desktop/src/tray.js", import.meta.url), "utf8")}\n})()`);
  tray.show = async (key) => {
    tray.listeners["music-state"]({ payload: { title: "T", artist: "A", album: "B", folder: "music", cover: key, playing: true, next: true } });
    await new Promise((resolve) => setImmediate(resolve));
  };
  return tray;
}

test("the tray asks the main window for the player state again whenever it gains focus", async () => {
  const tray = await trayWithMusic(() => ({}));
  try {
    assert.deepEqual(tray.emitted, [["music-command", "state"]]);
    tray.w.dispatchEvent(new tray.w.Event("focus"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(tray.emitted, [["music-command", "state"], ["music-command", "state"]]);
  } finally {
    tray.w.close();
  }
});

test("tray covers retry a minute after a failure, never after unavailable, and keep only the two newest", async () => {
  const answers = { a: [{ retry: true }, { data: "data:image/jpeg;base64,QQ==" }], b: [{ unavailable: true }], c: [{ data: "data:image/jpeg;base64,Qw==" }], d: [{ data: "data:image/jpeg;base64,RA==" }] };
  const key = (letter) => letter.repeat(64);
  const tray = await trayWithMusic((value) => answers[value[0]].shift() || { data: "data:image/jpeg;base64,Rg==" });
  const realNow = Date.now;
  try {
    const $ = (selector) => tray.w.document.querySelector(selector);
    await tray.show(key("a"));
    assert.equal($(".tray-music .music-cover img"), null);
    await tray.show(key("a"));
    assert.equal(tray.covers.length, 1, "no second request within a minute");
    tray.w.Date.now = Date.now = () => realNow() + 61000;
    await tray.show(key("a"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(tray.covers.length, 2);
    assert.equal($(".tray-music .music-cover img")?.getAttribute("src"), "data:image/jpeg;base64,QQ==");
    await tray.show(key("b"));
    await tray.show(key("b"));
    assert.equal(tray.covers.filter((value) => value === key("b")).length, 1, "unavailable is remembered");
    await tray.show(key("c"));
    await tray.show(key("d"));
    await tray.show(key("a"));
    assert.equal(tray.covers.filter((value) => value === key("a")).length, 3, "only the two newest covers stay cached");
  } finally {
    Date.now = realNow;
    tray.w.close();
  }
});
