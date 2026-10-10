import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { JSDOM } from "jsdom";

const read = (name) => fs.readFileSync(new URL(`../apps/desktop/src/${name}`, import.meta.url), "utf8");
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
};
const clock = (value) => new Date(value).toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

async function tray(t, status, { api = null, update = { available: false }, cover = () => ({}) } = {}) {
  const dom = new JSDOM('<div id="tray-content"></div>', { runScripts: "outside-only", url: "http://tauri.localhost" });
  const w = dom.window;
  t.after(() => w.close());
  w.setInterval = () => 0;
  w.matchMedia = () => ({ matches: false });
  w.ResizeObserver = class {
    observe() {}
  };
  w.lucide = { createIcons() {} };
  const ui = { w, calls: [], emitted: [], listeners: {}, covers: [], status };
  w.__TAURI__ = {
    core: {
      invoke: async (command, args) => {
        ui.calls.push({ command, args });
        if (command === "check_update") return update;
        if (command !== "api") return;
        if (args.route.startsWith("/v1/music/cover?")) {
          const key = new URLSearchParams(args.route.split("?")[1]).get("key");
          ui.covers.push(key);
          return cover(key);
        }
        if (api) {
          const answer = await api(args);
          if (answer !== undefined) return answer;
        }
        return typeof ui.status === "function" ? ui.status() : ui.status;
      },
    },
    event: {
      listen: async (name, handler) => {
        ui.listeners[name] = handler;
        return () => {};
      },
      emit: async (name, payload) => {
        ui.emitted.push([name, payload]);
      },
    },
  };
  await w.eval(`(async () => {${read("tray.js")}\nwindow.refreshTray = refresh;})()`);
  await settle();
  ui.$ = (selector) => w.document.querySelector(selector);
  ui.$$ = (selector) => [...w.document.querySelectorAll(selector)];
  ui.routes = () => ui.calls.filter(({ command }) => command === "api").map(({ args }) => args.route);
  ui.commands = () => ui.calls.map(({ command }) => command);
  return ui;
}

const folder = (id, extra = {}) => ({ id, name: id, selected: true, bytes: 1024, sync: { state: "synced" }, ...extra });
const LAST = "2026-09-30T14:02:00.000Z";

test("up to date is exactly the heading and the footer, whatever the number of folders", async (t) => {
  for (const count of [1, 50]) {
    const ui = await tray(t, { role: "hub", phase: "idle", lastSync: LAST, volumes: Array.from({ length: count }, (_, i) => folder(`f${i}`)) });
    assert.equal(ui.$(".tray-heading strong").textContent, "Up to date");
    assert.equal(ui.$(".tray-heading p").textContent, `Last completed ${clock(LAST)} · ${count === 1 ? "1 folder" : "50 folders"}`);
    assert.equal(ui.$(".tray-folders"), null, "no folder that is up to date gets a row");
    assert.equal(ui.$(".tray-music"), null);
    assert.equal(ui.$(".tray-progress"), null);
    assert.deepEqual(ui.$$(".tray-foot > button").map((el) => el.dataset.action), ["sync", "open", "more"]);
    assert.equal(ui.$(".tray-more-menu"), null);
    assert.ok(ui.$(".tray-heading .tray-role"));
    assert.equal(ui.commands().includes("main_window_open"), false, "Open Arca is always in the footer");
  }
});

test("disconnected and choose a folder keep their heading and list no folders", async (t) => {
  const ui = await tray(t, { role: "replica", phase: "unlinked", lastSync: null, volumes: [folder("saved", { conflicts: 2 })] });
  assert.equal(ui.$(".tray-heading strong").textContent, "Disconnected");
  assert.equal(ui.$(".tray-heading p").textContent, "Not yet verified");
  const logo = ui.$(".tray-heading .tray-brand-icon");
  assert.equal(logo.getAttribute("src"), "assets/arca-icon-small.svg");
  assert.equal(logo.getAttribute("alt"), "Arca");
  assert.equal(ui.$(".tray-folders"), null);
  const hub = await tray(t, { role: "hub", phase: "needs-folder", volumes: [] });
  assert.equal(hub.$(".tray-heading strong").textContent, "Choose a shared folder");
  assert.equal(hub.$(".tray-folders"), null);
});

test("syncing lists only transferring folders, counts waiting ones and fills a bar with folders done", async (t) => {
  const volumes = [
    folder("photos", { sync: { state: "syncing" } }),
    folder("music", { sync: { state: "scanning" } }),
    ...["a", "b", "c", "d"].map((id) => folder(id, { sync: { state: "pending" } })),
    ...["e", "f"].map((id) => folder(id)),
  ];
  const ui = await tray(t, { role: "replica", phase: "syncing", volumes });
  assert.equal(ui.$(".tray-heading strong").textContent, "Syncing 6 folders");
  assert.equal(ui.$(".tray-heading p").textContent, "2 of 8 folders · 4 more waiting");
  assert.equal(ui.$(".tray-progress").getAttribute("value"), "0.25");
  assert.deepEqual(ui.$$(".tray-folders > button").map((el) => [el.dataset.folder, el.querySelector("small").textContent]), [["photos", "Syncing"], ["music", "Scanning"]]);
  assert.equal(ui.$$(".tray-folders .busy-grid").length, 2);
  ui.$('[data-folder="photos"]').click();
  await settle();
  assert.ok(ui.calls.some(({ command, args }) => command === "show_main" && args.folder === "photos"), "a row opens its folder");
});

test("attention rows sort errors, conflicts and transfers, cap at four and name the rest", async (t) => {
  const volumes = [
    folder("photos", { sync: { state: "syncing" } }),
    folder("documents", { conflicts: 3 }),
    folder("scans", { sync: { state: "error", error: "EACCES" } }),
    folder("notes", { sync: { state: "pending" } }),
    folder("music", { sync: { state: "scanning" } }),
  ];
  const ui = await tray(t, { role: "hub", phase: "idle", backup: { error: "Disk full" }, volumes });
  const heading = ui.$(".tray-heading");
  assert.ok(heading.classList.contains("tray-error"), "Needs attention reads in the error ink");
  assert.equal(heading.querySelector("strong").textContent, "Needs attention");
  assert.equal(heading.querySelector("p").textContent, "3 conflicts in documents · 1 folder error · backup failed");
  const rows = ui.$$(".tray-folders > button");
  assert.deepEqual(rows.map((el) => el.querySelector(".tray-folder-name").textContent), ["scans", "Backup", "documents", "photos", "1 more · Open Arca"]);
  assert.ok(rows[0].matches(".tray-tone-error") && rows[0].querySelector('[data-lucide="circle-alert"]'));
  assert.ok(rows[1].querySelector('[data-lucide="shield"]'));
  assert.ok(rows[2].matches(".tray-tone-conflict") && rows[2].querySelector('[data-lucide="triangle-alert"]'));
  assert.equal(rows[2].querySelector("small").textContent, "3 conflicts");
  assert.equal(rows[4].dataset.action, "open");
  assert.equal(ui.$$('.tray-folders [data-folder="notes"]').length, 0, "a pending folder never gets a row");
  rows[1].click();
  await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(ui.emitted.at(-1))), ["notice-action", { action: "backup" }], "the backup row opens Settings › Backup");
  const many = await tray(t, { role: "hub", phase: "idle", volumes: [folder("a", { conflicts: 1 }), folder("b", { conflicts: 2 })] });
  assert.equal(many.$(".tray-heading p").textContent, "3 conflicts in 2 folders");
});

test("paused shows when it ends, offers Resume and lists no folders; offline names the hub", async (t) => {
  const until = Date.now() + 3600000;
  const ui = await tray(t, { role: "replica", phase: "paused", pauseUntil: until, lastSync: LAST, volumes: [folder("a", { sync: { state: "paused" }, conflicts: 1 })] });
  const heading = ui.$(".tray-heading");
  assert.equal(heading.querySelector("strong").textContent, `Paused until ${clock(until)}`);
  assert.equal(heading.querySelector("p").textContent, `Sync resumes on its own · last completed ${clock(LAST)}`);
  assert.ok(heading.classList.contains("tray-warn"));
  assert.equal(ui.$(".tray-folders"), null);
  heading.querySelector('[data-action="resume"]').click();
  await settle();
  const resume = ui.calls.find(({ args }) => args?.route === "/v1/pause");
  assert.deepEqual({ ...resume.args.body }, { paused: false });
  assert.ok(ui.commands().includes("hide_tray"));
  const forever = await tray(t, { role: "replica", phase: "paused", pauseUntil: null, lastSync: LAST, volumes: [] });
  assert.equal(forever.$(".tray-heading strong").textContent, "Paused");
  for (const phase of ["offline", "syncing", "idle", "error"]) {
    const offline = await tray(t, { role: "replica", phase, hubUnavailable: true, hubName: "casa", lastSync: LAST, volumes: [folder("a", { sync: { state: "pending" } })] });
    assert.equal(offline.$(".tray-heading strong").textContent, "Offline", phase);
    assert.equal(offline.$(".tray-heading p").textContent, `Cannot reach casa · last completed ${clock(LAST)}`);
    assert.ok(offline.$(".tray-heading.tray-warn"));
    assert.equal(offline.$(".tray-folders"), null);
  }
});

test("⋯ expands the footer in place with both pauses and Quit; Escape closes it, then the popover", async (t) => {
  const ui = await tray(t, { role: "replica", phase: "idle", volumes: [] });
  ui.$('[data-action="more"]').click();
  await settle();
  assert.equal(ui.$('[data-action="more"]').getAttribute("aria-expanded"), "true");
  assert.ok(ui.$(".tray-foot + .tray-more-menu"));
  assert.deepEqual(ui.$$(".tray-more-menu button").map((el) => el.dataset.action), ["pause", "pause-tomorrow", "quit"]);
  ui.w.document.dispatchEvent(new ui.w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(ui.$(".tray-more-menu"), null);
  assert.equal(ui.commands().includes("hide_tray"), false);
  ui.w.document.dispatchEvent(new ui.w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await settle();
  assert.ok(ui.commands().includes("hide_tray"));
  ui.$('[data-action="more"]').click();
  await settle();
  const before = new Date();
  ui.$('[data-action="pause-tomorrow"]').click();
  await settle();
  const pause = ui.calls.find(({ args }) => args?.route === "/v1/pause");
  const next = new Date(before);
  next.setHours(8, 0, 0, 0);
  if (next <= before) next.setDate(next.getDate() + 1);
  const expected = Math.ceil((next - before) / 1000);
  assert.equal(pause.args.body.paused, true);
  assert.ok(pause.args.body.seconds <= 86400 && Math.abs(pause.args.body.seconds - expected) <= 1, "until the next 08:00 local");
  ui.status = { role: "replica", phase: "paused", volumes: [] };
  await ui.w.refreshTray();
  ui.$('[data-action="more"]').click();
  await settle();
  assert.deepEqual(ui.$$(".tray-more-menu button").map((el) => el.dataset.action), ["resume", "quit"]);
  ui.w.document.dispatchEvent(new ui.w.KeyboardEvent("keydown", { key: "q", metaKey: true, bubbles: true }));
  await settle();
  assert.ok(ui.commands().includes("quit_app"), "⌘Q works with ⋯ closed or open");
});

test("Command-Q and Command-O work while ⋯ is closed", async (t) => {
  const ui = await tray(t, { role: "replica", phase: "idle", volumes: [] });
  ui.w.document.dispatchEvent(new ui.w.KeyboardEvent("keydown", { key: "o", metaKey: true, bubbles: true }));
  await settle();
  assert.ok(ui.calls.some(({ command, args }) => command === "show_main" && args.folder === null));
  ui.w.document.dispatchEvent(new ui.w.KeyboardEvent("keydown", { key: "q", metaKey: true, bubbles: true }));
  await settle();
  assert.ok(ui.commands().includes("quit_app"));
});

test("an available update shows one row that opens the main window", async (t) => {
  const ui = await tray(t, { role: "hub", phase: "idle", volumes: [] }, { update: { available: true, version: "0.7.37" } });
  assert.equal(ui.$(".tray-update-text").textContent, "Arca 0.7.37 is ready");
  ui.$('.tray-update [data-action="update"]').click();
  await settle();
  assert.ok(ui.calls.some(({ command, args }) => command === "show_main" && args.folder === null));
  const none = await tray(t, { role: "hub", phase: "idle", volumes: [] });
  assert.equal(none.$(".tray-update"), null);
});

test("tray closes after Sync now or Pause succeeds and stays open to show a failure", async (t) => {
  let failure = null;
  const ui = await tray(t, { role: "replica", phase: "idle", volumes: [] }, {
    api: ({ route }) => {
      if (failure && route === "/v1/sync") throw failure;
    },
  });
  const calls = () => ui.calls.map(({ command, args }) => (command === "api" ? args.route : command));
  ui.$('[data-action="sync"]').click();
  await settle();
  assert.deepEqual(calls().slice(calls().indexOf("/v1/sync"), calls().indexOf("/v1/sync") + 2), ["/v1/sync", "hide_tray"]);
  ui.calls.length = 0;
  ui.$('[data-action="more"]').click();
  await settle();
  ui.$('[data-action="pause"]').click();
  await settle();
  assert.deepEqual(calls().slice(0, 2), ["/v1/pause", "hide_tray"]);
  assert.deepEqual({ ...ui.calls[0].args.body }, { paused: true, seconds: 3600 });
  ui.calls.length = 0;
  failure = new Error("The daemon is unavailable. Use Start service.");
  ui.$('[data-action="sync"]').click();
  await settle();
  assert.equal(calls().includes("hide_tray"), false);
  assert.match(ui.$("#tray-error").textContent, /daemon is unavailable/);
});

test("tray offers Start service and Quit while the daemon is unavailable", async (t) => {
  let ui = null;
  ui = await tray(t, { role: "replica", phase: "idle", volumes: [] }, {
    api: () => {
      if (!ui?.commands().includes("start_daemon")) throw "The daemon is unavailable. Use Start service.";
    },
  });
  assert.equal(ui.$(".tray-heading strong").textContent, "Daemon unavailable");
  assert.deepEqual(ui.$$(".tray-menu button").map((button) => button.dataset.action), ["start", "open", "quit"]);
  ui.$('[data-action="start"]').click();
  await settle();
  assert.ok(ui.commands().includes("start_daemon"));
  assert.equal(ui.$(".tray-heading strong").textContent, "Up to date");
});

test("the native tray reads offline while only the hub is unreachable", () => {
  const source = fs.readFileSync(new URL("../apps/desktop/src-tauri/src/main.rs", import.meta.url), "utf8");
  assert.match(source, /let offline = status\["phase"\] == "offline";/);
  assert.match(source, /\(!offline && status\["error"\]\.as_str\(\)\.is_some\(\)\)/, "the hub's own error no longer raises the alert");
  assert.match(source, /"offline" if tray_state\(status\) == "alert" => "Arca · needs attention",\s+"offline" => "Arca · offline",/);
  assert.match(source, /Ok\(s\) => tray_text\(s\),/, "the tooltip comes from tray_text");
  assert.match(source, /fn an_unreachable_hub_reads_offline_but_other_problems_still_raise_the_alert\(\)/, "the Rust test exists");
});

test("Now playing is one compact row without Previous, patched in place from music-state", async (t) => {
  const ui = await tray(t, { role: "replica", phase: "idle", volumes: [folder("music", { music: true })] }, { cover: () => ({ data: "data:image/jpeg;base64,AAAA" }) });
  const { $ } = ui;
  const playing = { title: "Flamenco Sketches", artist: "Miles Davis", album: "Kind of Blue", folder: "music", cover: "a".repeat(64), playing: true };
  assert.deepEqual(ui.emitted.map(([name, payload]) => [name, payload.command]), [["music-command", "state"]]);
  assert.equal($(".tray-music"), null);
  ui.listeners["music-state"]({ payload: playing });
  await settle();
  assert.ok($(".tray-heading + .tray-music + .tray-foot"), "between the heading and the footer when no folder needs anything");
  assert.equal($(".tray-music strong").textContent, "Flamenco Sketches");
  assert.equal($(".tray-track-line > span").textContent, "· Miles Davis");
  assert.equal($('.tray-music [data-music="previous"]'), null, "no Previous in the row");
  assert.deepEqual(ui.$$(".tray-music button").map((el) => el.dataset.music), ["show", "toggle", "next"]);
  assert.equal($(".tray-music .music-cover img")?.getAttribute("src"), "data:image/jpeg;base64,AAAA");
  const toggle = $('.tray-music [data-music="toggle"]');
  ui.listeners["music-state"]({ payload: { ...playing, title: "All Blues", playing: false, next: false } });
  assert.equal($('.tray-music [data-music="toggle"]'), toggle, "the row is patched in place");
  assert.equal(toggle.getAttribute("aria-label"), "Play");
  assert.equal($('.tray-music [data-music="next"]').disabled, true);
  assert.equal($(".tray-music strong").textContent, "All Blues");
  for (const command of ["toggle", "next"]) {
    $('.tray-music [data-music="next"]').disabled = false;
    $(`.tray-music [data-music="${command}"]`).click();
    await settle();
    assert.deepEqual([ui.emitted.at(-1)[0], ui.emitted.at(-1)[1].command], ["music-command", command]);
  }
  assert.ok(!ui.commands().some((command) => ["show_main", "hide_tray"].includes(command)), "controls keep the popover open");
  $(".tray-track").click();
  await settle();
  assert.deepEqual([ui.emitted.at(-1)[0], ui.emitted.at(-1)[1].command], ["music-command", "show"]);
  assert.ok(ui.calls.some(({ command, args }) => command === "show_main" && args.folder === null));
  ui.listeners["music-state"]({ payload: null });
  assert.equal($(".tray-music"), null);
});

test("the popover has no folder viewport: rows are capped instead of scrolled", () => {
  assert.doesNotMatch(read("tokens.css"), /--tray-folders-max-height/);
  assert.doesNotMatch(read("style.css"), /--tray-folders-max-height/);
  const css = read("style.css");
  assert.match(css, /\n\.tray-menu\.tray-foot \{\s*flex-direction: row;/);
  assert.match(css, /\n\.tray-progress \{[^}]*height: 3px;/);
  assert.match(css, /\n\.tray-tone-error > svg \{\s*color: var\(--erFg\);/);
  assert.match(css, /\n\.tray-tone-conflict > svg \{\s*color: var\(--waFg\);/);
});

test("the tray asks the main window for the player state again whenever it gains focus", async (t) => {
  const ui = await tray(t, { role: "replica", phase: "idle", volumes: [] });
  assert.deepEqual(ui.emitted.map(([name, payload]) => [name, payload.command]), [["music-command", "state"]]);
  ui.w.dispatchEvent(new ui.w.Event("focus"));
  await settle();
  assert.deepEqual(ui.emitted.map(([name, payload]) => [name, payload.command]), [["music-command", "state"], ["music-command", "state"]]);
});

test("tray covers retry a minute after a failure, never after unavailable, and keep only the two newest", async (t) => {
  const answers = { a: [{ retry: true }, { data: "data:image/jpeg;base64,QQ==" }], b: [{ unavailable: true }], c: [{ data: "data:image/jpeg;base64,Qw==" }], d: [{ data: "data:image/jpeg;base64,RA==" }] };
  const key = (letter) => letter.repeat(64);
  const ui = await tray(t, { role: "replica", phase: "idle", volumes: [] }, { cover: (value) => answers[value[0]].shift() || { data: "data:image/jpeg;base64,Rg==" } });
  const show = async (cover) => {
    ui.listeners["music-state"]({ payload: { title: "T", artist: "A", album: "B", folder: "music", cover, playing: true, next: true } });
    await new Promise((resolve) => setImmediate(resolve));
  };
  const realNow = Date.now;
  try {
    await show(key("a"));
    assert.equal(ui.$(".tray-music .music-cover img"), null);
    await show(key("a"));
    assert.equal(ui.covers.length, 1, "no second request within a minute");
    ui.w.Date.now = Date.now = () => realNow() + 61000;
    await show(key("a"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ui.covers.length, 2);
    assert.equal(ui.$(".tray-music .music-cover img")?.getAttribute("src"), "data:image/jpeg;base64,QQ==");
    await show(key("b"));
    await show(key("b"));
    assert.equal(ui.covers.filter((value) => value === key("b")).length, 1, "unavailable is remembered");
    await show(key("c"));
    await show(key("d"));
    await show(key("a"));
    assert.equal(ui.covers.filter((value) => value === key("a")).length, 3, "only the two newest covers stay cached");
  } finally {
    Date.now = realNow;
  }
});

test("the daemon publishes when a timed pause ends, and nothing once it is resumed", async (t) => {
  const os = await import("node:os");
  const path = await import("node:path");
  const { init } = await import("../packages/daemon/storage.js");
  const { start } = await import("../packages/daemon/server.js");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-tray-pause-"));
  init(home, { port: 0, name: "Mac" });
  const daemon = await start(home, { timer: false });
  daemon.engine.store.addVolume("Docs");
  t.after(async () => {
    await daemon.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const post = (body) =>
    fetch(`http://127.0.0.1:${daemon.port}/v1/pause`, {
      method: "POST",
      headers: { authorization: `Bearer ${daemon.engine.config.adminToken}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((response) => response.json());
  const before = Date.now();
  const paused = await post({ paused: true, seconds: 86400 });
  assert.equal(paused.phase, "paused");
  assert.ok(paused.pauseUntil >= before + 86400000 && paused.pauseUntil <= Date.now() + 86400000);
  const resumed = await post({ paused: false });
  assert.equal(resumed.pauseUntil, null);
  assert.equal((await post({ paused: true })).pauseUntil, null, "an indefinite pause has no end");
});

test("the tray ⋯ menu enters from its trigger and fades out inert over the fast exit before it is removed", async (t) => {
  const ui = await tray(t, { role: "replica", phase: "idle", volumes: [] });
  const style = ui.w.document.createElement("style");
  style.textContent = read("tokens.css");
  ui.w.document.head.append(style);
  const animations = [];
  ui.w.Element.prototype.animate = function (frames, options) {
    let resolve;
    const animation = { element: this, frames: JSON.parse(JSON.stringify(frames)), options, finished: new Promise((done) => (resolve = done)), finish: () => resolve() };
    animations.push(animation);
    return animation;
  };
  ui.$('[data-action="more"]').click();
  await settle();
  const menu = ui.$(".tray-more-menu");
  assert.deepEqual(animations.at(-1).frames, [{ opacity: 0, transform: "translateY(-4px)" }, { opacity: 1, transform: "none" }]);
  assert.equal(animations.at(-1).options.duration, 120);
  ui.$('[data-action="more"]').click();
  await settle();
  assert.equal(ui.$(".tray-more-menu"), menu, "it stays while it leaves");
  assert.equal(menu.inert, true);
  assert.equal(ui.$('[data-action="more"]').getAttribute("aria-expanded"), "false");
  assert.deepEqual(animations.at(-1).frames, [{ opacity: 1 }, { opacity: 0 }]);
  assert.equal(animations.at(-1).options.duration, 80);
  animations.at(-1).finish();
  await settle();
  assert.equal(ui.$(".tray-more-menu"), null);
  assert.equal(ui.$('[data-action="more"]').getAttribute("aria-expanded"), "false");
});

test("Pause until tomorrow lasts until the next local 08:00, always under 24 hours of wall time and the daemon's limit", (t) => {
  const source = read("tray.js");
  const body = source.slice(source.indexOf("function untilTomorrow("), source.indexOf("\n}\n", source.indexOf("function untilTomorrow(")) + 2);
  const untilTomorrow = new Function(`${body}\nreturn untilTomorrow;`)();
  const zone = process.env.TZ;
  t.after(() => {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  });
  process.env.TZ = "Europe/Madrid";
  const at = (text) => untilTomorrow(new Date(text));
  assert.equal(at("2026-06-10T07:00:00"), 3600);
  assert.equal(at("2026-06-10T08:00:00"), 86399, "exactly 08:00 waits for tomorrow, one second short of a day");
  assert.equal(at("2026-06-10T08:00:01"), 86399);
  assert.equal(at("2026-06-10T20:00:00"), 12 * 3600);
  assert.equal(at("2026-03-28T20:00:00"), 11 * 3600, "the night clocks go forward is an hour shorter");
  assert.equal(at("2026-03-28T08:30:00"), 22 * 3600 + 1800);
  assert.equal(at("2026-03-28T08:00:00"), 23 * 3600 - 1, "and never reaches a full day of wall time");
  assert.equal(at("2026-10-24T20:00:00"), 13 * 3600, "the night clocks go back is an hour longer");
  assert.equal(at("2026-10-24T08:30:00"), 86399, "but stays within the daemon's one-day pause");
  for (let hour = 0; hour < 24; hour++) {
    const seconds = at(`2026-10-24T${String(hour).padStart(2, "0")}:15:00`);
    assert.ok(seconds >= 1 && seconds < 86400, `${hour}:15 → ${seconds}`);
  }
});
