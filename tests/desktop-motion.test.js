import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { JSDOM } from "jsdom";

const source = (name) => fs.readFileSync(new URL(`../apps/desktop/src/${name}`, import.meta.url), "utf8");
const tokens = source("tokens.css");
const style = source("style.css");
const app = source("app.js");
const html = source("index.html").replace("</head>", `<style>${tokens}</style></head>`);
const script = [
  source("gallery-timeline-layout.js").replace(/export /g, ""),
  source("file-icons.js").replace(/export /g, ""),
  source("music-library.js").replace(/export /g, ""),
  source("favorite-order.js").replace(/export /g, ""),
  source("notice-contract.js").replace(/export /g, ""),
  app
    .replace(/\r?\n/g, "\r\n")
    .replace(/^import[\s\S]*?notice-contract\.js";\r?\n/, "")
    .replace(/import \{ fileIcon \} from "\.\/file-icons\.js";\r?\n/, ""),
].join("\n");

async function until(check) {
  for (let i = 0; i < 300; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("UI did not reach expected state");
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const base = { selected: 1, sync: { state: "synced", lastCompleted: new Date().toISOString() }, conflicts: 0, files: 20, bytes: 2048 };

async function boot(t, { reduced = false, answers = {}, asyncClose = false, volumes = [{ ...base, id: "documents", name: "documents" }, { ...base, id: "notes", name: "notes" }, { ...base, id: "photos", name: "photos" }] } = {}) {
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://tauri.localhost" });
  const w = dom.window;
  const pending = new Set();
  const ui = { w, polls: [], calls: [] };
  t.after(async () => {
    do {
      await Promise.allSettled([...pending]);
      await wait(30);
    } while (pending.size);
    dom.window.close();
  });
  w.setInterval = (callback, ms) => {
    if (ms === 5000) ui.polls.push(callback);
    return 0;
  };
  w.matchMedia = (query) => ({ matches: reduced && query.includes("reduce"), addEventListener() {}, removeEventListener() {} });
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.HTMLElement.prototype.getBoundingClientRect = function () {
    const index = this.parentElement ? [...this.parentElement.children].indexOf(this) : 0;
    return { top: index * 50, bottom: index * 50 + 50, left: 0, right: 100, width: 100, height: 50, x: 0, y: index * 50 };
  };
  const animations = [];
  w.Element.prototype.animate = function (frames, options) {
    let resolve;
    const animation = {
      element: this,
      frames,
      options: typeof options === "number" ? { duration: options } : options,
      playState: "running",
      reversed: false,
      finished: new Promise((done) => (resolve = done)),
      finish() {
        if (this.playState !== "running") return;
        this.playState = "finished";
        resolve(this);
      },
      cancel() {
        this.playState = "idle";
      },
      reverse() {
        this.reversed = !this.reversed;
      },
    };
    animations.push(animation);
    return animation;
  };
  w.document.getAnimations = () => animations.filter((animation) => animation.playState === "running");
  ui.running = (element) => animations.filter((animation) => animation.element === element && animation.playState === "running");
  ui.finishAll = async () => {
    for (const animation of animations) animation.finish();
    await wait(0);
  };
  ui.settled = (check) => () => {
    for (const animation of animations) animation.finish();
    return check();
  };
  w.HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  w.HTMLDialogElement.prototype.close = function () {
    if (!this.hasAttribute("open")) return;
    this.removeAttribute("open");
    if (asyncClose) setTimeout(() => this.dispatchEvent(new w.Event("close")));
    else this.dispatchEvent(new w.Event("close"));
  };
  const status = { id: "hub", name: "Casa", role: "hub", phase: "idle", hub: "", root: "/srv/arca", volumes };
  ui.status = status;
  w.__TAURI__ = {
    core: {
      invoke: (command, args) => {
        const request = (async () => {
          if (command === "bootstrap") return { setup: false, status };
          if (command !== "api") return {};
          ui.calls.push(`${args.method} ${args.route}`);
          if (args.route === "/v1/status") return status;
          for (const [prefix, answer] of Object.entries(answers)) if (args.route.startsWith(prefix)) return answer(args);
          if (args.route === "/v1/favorites") return { favorites: [] };
          if (args.route.startsWith("/v1/browse")) return { entries: [], next: null };
          if (args.route === "/v1/machines") return { machines: [] };
          return {};
        })();
        pending.add(request);
        request.then(() => pending.delete(request), () => pending.delete(request));
        return request;
      },
    },
    event: { listen: async () => () => {}, emit: async () => {} },
  };
  w.eval(`(async()=>{${script}\n})()`);
  ui.$ = (selector) => w.document.querySelector(selector);
  ui.$$ = (selector) => [...w.document.querySelectorAll(selector)];
  ui.idle = () => w.document.body.getAttribute("aria-busy") !== "true";
  ui.key = (key, init = {}, target = w.document.activeElement || w.document.body) =>
    target.dispatchEvent(new w.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
  await until(() => ui.$(".folder-card") && ui.idle());
  return ui;
}
async function folderPage(ui) {
  ui.$('.folder-card[data-id="documents"]').click();
  await until(() => ui.$(".heading-actions .folder-actions-menu") && ui.idle());
  return ui.$(".heading-actions .folder-actions-menu");
}

test("motion tokens add the fast exit and the tooltip hold, collapse under reduced motion and leave no notice duration", () => {
  assert.match(tokens, /--motion-exit-fast:\s*80ms;/);
  assert.match(tokens, /--motion-hint-delay:\s*400ms;/);
  assert.doesNotMatch(tokens, /--notice-duration/);
  const reduced = tokens.slice(tokens.indexOf("@media (prefers-reduced-motion: reduce)"));
  for (const name of ["exit-fast", "fast", "enter", "exit"]) assert.match(reduced, new RegExp(`--motion-${name}:\\s*0ms;`));
  assert.match(reduced, /--motion-route-rise:\s*0px;/);
  const values = (name) => [...tokens.matchAll(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "g"))].map((match) => match[1]);
  assert.equal(values("press").length, 2, "light and dark");
  assert.equal(values("hover").length, 2);
  values("press").forEach((press, index) => assert.notEqual(press, values("hover")[index], "press is not hover"));
});

test("a press fills one step past hover at once and releases over the fast token", () => {
  for (const selector of [".secondary:active:not(:disabled)", ".folder-card:active", ".menu-items button:active:not(:disabled)"])
    assert.match(style, new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^{]*\\{\\s*background: var\\(--press\\);\\s*transition-duration: 0ms;`));
  assert.doesNotMatch(style, /:active[^{]*\{\s*background: var\(--(hover|track)\);/, "no press reuses a hover fill");
});

test("no animation carries a literal duration or distance and menus grow from their trigger", () => {
  assert.doesNotMatch(app, /duration:\s*\d/);
  assert.doesNotMatch(app, /cubic-bezier|translate[XY]?\([^)]*\d+px/);
  assert.doesNotMatch(style, /animation(-duration|-delay)?:[^;]*\d(ms|s)\b/);
  assert.match(style, /@keyframes menu-enter \{\s*from \{\s*opacity: 0;\s*transform: translateY\(calc\(var\(--motion-distance\) \/ -2\)\);/);
  assert.match(style, /@keyframes menu-enter-up \{\s*from \{\s*opacity: 0;\s*transform: translateY\(calc\(var\(--motion-distance\) \/ 2\)\);/);
  assert.match(style, /\.sleep-menu \.menu-items \{\s*animation-name: menu-enter-up;/);
  assert.match(style, /@keyframes palette-enter \{\s*from \{\s*opacity: 0;\s*transform: translateY\(calc\(var\(--motion-distance\) \* -1\)\) scale\(var\(--motion-dialog-scale\)\);/);
  assert.doesNotMatch(style, /dialog\.palette\[open\] \{[^}]*animation-duration/, "the palette enters with the dialog role");
  assert.match(style, /\.tooltip \{[^}]*animation: label-in var\(--motion-fast\) var\(--motion-ease\);/);
});

test("a ⋯ menu leaves over 80 ms inert, reopening reverses it, arrows move between items and Escape closes it from anywhere", async (t) => {
  const ui = await boot(t);
  const menu = await folderPage(ui);
  const summary = menu.querySelector("summary");
  const panel = menu.querySelector(".menu-items");
  summary.click();
  assert.equal(menu.open, true);
  assert.equal(panel.getAttribute("role"), "menu");
  assert.ok([...panel.querySelectorAll("button")].every((item) => item.getAttribute("role") === "menuitem"));
  summary.click();
  assert.equal(menu.open, true, "it stays drawn while it leaves");
  assert.equal(panel.inert, true);
  const [exit] = ui.running(panel);
  assert.equal(exit.options.duration, 80);
  assert.deepEqual(JSON.parse(JSON.stringify(exit.frames)), [{ opacity: 1 }, { opacity: 0 }]);
  summary.click();
  assert.equal(exit.reversed, true, "reopening during the exit reverses it");
  assert.equal(panel.inert, false);
  assert.equal(menu.open, true);
  await ui.finishAll();
  assert.equal(menu.open, true, "a reversed exit never closes the menu");
  const items = [...panel.querySelectorAll("button")];
  items[0].focus();
  ui.key("ArrowDown");
  assert.equal(ui.w.document.activeElement, items[1]);
  ui.key("ArrowUp");
  ui.key("ArrowUp");
  assert.equal(ui.w.document.activeElement, items.at(-1));
  ui.w.document.activeElement.blur();
  ui.key("Escape", {}, ui.w.document.body);
  assert.equal(ui.w.document.activeElement, summary, "focus returns to the ⋯ even when the click never focused it");
  assert.equal(ui.running(panel)[0].options.duration, 80);
  await ui.finishAll();
  assert.equal(menu.open, false);
});

test("a dialog leaves over 140 ms with its backdrop, inert, and returns focus to the ⋯ that opened it", async (t) => {
  const ui = await boot(t);
  const menu = await folderPage(ui);
  menu.querySelector("summary").click();
  menu.querySelector('[data-action="rename-share"]').click();
  await until(() => ui.$("#dialog").open && ui.idle());
  await ui.finishAll();
  assert.equal(menu.open, false);
  const dialog = ui.$("#dialog");
  ui.$("#cancel-dialog").click();
  assert.equal(dialog.open, true, "the dialog stays while it leaves");
  assert.equal(dialog.inert, true);
  const exits = ui.running(dialog);
  const body = exits.find((animation) => !animation.options.pseudoElement);
  assert.equal(body.options.duration, 140);
  assert.deepEqual(JSON.parse(JSON.stringify(body.frames)), [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "scale(0.985)" }]);
  assert.equal(exits.find((animation) => animation.options.pseudoElement === "::backdrop").options.duration, 140);
  await ui.finishAll();
  assert.equal(dialog.open, false);
  assert.equal(ui.w.document.activeElement, menu.querySelector("summary"));
});

test("the reused dialog finishes a pending exit before new content is drawn", async (t) => {
  const ui = await boot(t);
  const menu = await folderPage(ui);
  menu.querySelector("summary").click();
  menu.querySelector('[data-action="rename-share"]').click();
  await until(() => ui.$("#dialog").open && ui.idle());
  ui.$("#cancel-dialog").click();
  const exit = ui.running(ui.$("#dialog"))[0];
  menu.querySelector("summary").click();
  menu.querySelector('[data-action="edit-ignore"]').click();
  await until(() => exit.playState !== "running" && ui.$("#dialog").open && /arcaignore/.test(ui.$("#dialog").textContent) && ui.idle());
  assert.equal(ui.$("#dialog").inert, false);
});

test("the tooltip holds 400 ms, fades out over 80 ms, shows at once when warm and is cut by a press", async (t) => {
  const ui = await boot(t);
  const menu = await folderPage(ui);
  const summary = menu.querySelector("summary");
  const star = ui.$(".heading-actions .favorite-star");
  summary.dispatchEvent(new ui.w.MouseEvent("pointerover", { bubbles: true }));
  await wait(250);
  assert.equal(ui.$(".tooltip"), null, "the hold is 400 ms");
  await until(() => ui.$(".tooltip"));
  assert.equal(ui.$(".tooltip").textContent, "Folder actions", "an icon-only control's tooltip is its label");
  const tip = ui.$(".tooltip");
  summary.dispatchEvent(new ui.w.MouseEvent("pointerout", { bubbles: true, relatedTarget: ui.w.document.body }));
  assert.ok(tip.isConnected, "it fades instead of vanishing");
  assert.equal(ui.running(tip)[0].options.duration, 80);
  star.dispatchEvent(new ui.w.MouseEvent("pointerover", { bubbles: true }));
  await wait(30);
  assert.equal([...ui.$$(".tooltip")].at(-1).textContent, "Add to Favorites", "a second tooltip within 800 ms skips the hold");
  ui.w.document.dispatchEvent(new ui.w.MouseEvent("pointerdown", { bubbles: true }));
  assert.equal(ui.$$(".tooltip").filter((el) => el.textContent === "Add to Favorites").length, 0, "a press cuts it at once");
  await ui.finishAll();
  assert.equal(ui.$(".tooltip"), null);
});

test("a dismissed notice falls and fades for 140 ms before it leaves, and the box hides only after", async (t) => {
  const ui = await boot(t, { answers: { "/v1/sync": () => Promise.reject(new Error("Sync failed")) } });
  ui.key("r", { metaKey: true }, ui.w.document.body);
  await until(() => ui.$("#notice .notice-card"));
  const card = ui.$("#notice .notice-card");
  card.querySelector(".notice-close").click();
  assert.ok(card.isConnected);
  assert.equal(card.inert, true);
  assert.equal(ui.$("#notice").hidden, false);
  const [exit] = ui.running(card);
  assert.equal(exit.options.duration, 140);
  assert.deepEqual(JSON.parse(JSON.stringify(exit.frames)), [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(8px)" }]);
  await ui.finishAll();
  assert.equal(card.isConnected, false);
  assert.equal(ui.$("#notice").hidden, true);
});

test("a removed folder fades before the rows below rise", async (t) => {
  const ui = await boot(t);
  const before = ui.$$(".folder-card").map((card) => card.dataset.id);
  assert.deepEqual(before, ["documents", "notes", "photos"]);
  await wait(50);
  ui.status.volumes = ui.status.volumes.filter((v) => v.id !== "notes");
  for (const poll of ui.polls) await poll();
  await until(() => ui.$$(".folder-card:not(.row-leaving)").length === 2 && ui.$(".row-leaving") && ui.idle());
  const ghost = ui.$(".row-leaving");
  assert.equal(ghost.dataset.id, "notes");
  assert.equal(ghost.inert, true);
  assert.equal(ui.running(ghost).at(-1).options.duration, 140);
  assert.deepEqual(JSON.parse(JSON.stringify(ui.running(ghost).at(-1).frames)), [{ opacity: 1 }, { opacity: 0 }]);
  const follower = ui.$('.folder-card[data-id="photos"]:not(.row-leaving)');
  const rise = ui.running(follower).at(-1);
  assert.equal(rise.options.duration, 280, "the rows below wait for the fade, then rise");
  assert.deepEqual([...rise.frames.map((frame) => frame.transform)], ["translate(0px, 50px)", "translate(0px, 50px)", "none"]);
  await ui.finishAll();
  assert.equal(ui.$(".row-leaving"), null);
});

test("with reduced motion every surface leaves at once", async (t) => {
  const ui = await boot(t, { reduced: true });
  const menu = await folderPage(ui);
  menu.querySelector("summary").click();
  menu.querySelector("summary").click();
  assert.equal(menu.open, false);
  menu.querySelector("summary").click();
  menu.querySelector('[data-action="rename-share"]').click();
  await until(() => ui.$("#dialog").open && ui.idle());
  ui.$("#cancel-dialog").click();
  assert.equal(ui.$("#dialog").open, false);
});

test("⌘K leaves with the dialog role on Escape and reopening during the exit reverses it", async (t) => {
  const ui = await boot(t);
  ui.key("k", { metaKey: true }, ui.w.document.body);
  await until(() => ui.$("#palette")?.open);
  const dialog = ui.$("#palette");
  const cancel = new ui.w.Event("cancel", { cancelable: true });
  dialog.dispatchEvent(cancel);
  assert.equal(cancel.defaultPrevented, true);
  assert.equal(dialog.open, true);
  assert.equal(dialog.inert, true);
  const exit = ui.running(dialog).find((animation) => !animation.options.pseudoElement);
  assert.equal(exit.options.duration, 140);
  ui.key("k", { metaKey: true }, ui.w.document.body);
  assert.equal(exit.reversed, true);
  assert.equal(dialog.inert, false);
  await ui.finishAll();
  assert.equal(dialog.open, true);
  assert.equal(ui.w.document.activeElement, dialog.querySelector(".pal-input"));
});

const pressPalette = (ui, key, init = {}) => ui.key(key, init, ui.$("#palette .pal-input") || ui.w.document.body);
async function typePalette(ui, value, group) {
  const input = ui.$("#palette .pal-input");
  input.value = value;
  input.dispatchEvent(new ui.w.Event("input", { bubbles: true }));
  await until(() => ui.$(`#palette .pal-group[aria-label^="${group}"] [data-pal="0"]`));
}

test("⌘K ignores a second Enter or click while it leaves, so an action runs once", async (t) => {
  const ui = await boot(t);
  ui.key("k", { metaKey: true }, ui.w.document.body);
  await until(() => ui.$("#palette")?.open && ui.$('#palette [data-pal="0"]'));
  const syncs = () => ui.calls.filter((call) => call === "POST /v1/sync").length;
  const row = ui.$('#palette [data-pal="0"]');
  assert.match(row.textContent, /Sync now/);
  pressPalette(ui, "Enter");
  assert.ok(ui.$("#palette").inert, "the palette is leaving");
  ui.key("Enter", {}, ui.w.document.body);
  row.click();
  await until(() => syncs() >= 1 && ui.idle());
  await ui.finishAll();
  await wait(50);
  assert.equal(syncs(), 1);
});

test("⌘K reopened after the system closed it mid-exit is visible, live and stays open", async (t) => {
  const ui = await boot(t);
  ui.key("k", { metaKey: true }, ui.w.document.body);
  await until(() => ui.$("#palette")?.open);
  const dialog = ui.$("#palette");
  dialog.dispatchEvent(new ui.w.Event("cancel", { cancelable: true }));
  assert.equal(dialog.inert, true);
  dialog.close();
  assert.equal(dialog.open, false);
  ui.key("k", { metaKey: true }, ui.w.document.body);
  assert.equal(dialog.open, true);
  assert.equal(dialog.inert, false, "the leftover exit no longer holds it inert");
  assert.equal(ui.running(dialog).filter((animation) => !animation.options.pseudoElement && !animation.reversed).length, 0);
  await ui.finishAll();
  assert.equal(dialog.open, true, "the old exit never closes the new palette");
  assert.equal(ui.w.document.activeElement, dialog.querySelector(".pal-input"));
});

test("a dialog opened from ⌘K returns focus to what opened the palette", async (t) => {
  const ui = await boot(t, { asyncClose: true });
  const opener = ui.$(".palette-open");
  opener.focus();
  opener.click();
  await until(() => ui.$("#palette")?.open && ui.$('#palette [data-pal="2"]'));
  assert.match(ui.$('#palette [data-pal="2"]').textContent, /Create shared folder/);
  ui.$('#palette [data-pal="2"]').click();
  await until(ui.settled(() => ui.$("#dialog").open && !ui.$("#palette").open && ui.idle()));
  await wait(20);
  ui.$("#cancel-dialog").click();
  await until(ui.settled(() => !ui.$("#dialog").open));
  assert.equal(ui.w.document.activeElement, opener);
});

test("⌘Enter on a file past the first page loads pages until its row is selected and focused", async (t) => {
  const entries = Array.from({ length: 250 }, (_, i) => ({ path: `deep/f${String(i).padStart(3, "0")}.txt`, name: `f${String(i).padStart(3, "0")}.txt`, hash: `h${i}`, size: 1, rev: 1 }));
  const ui = await boot(t, {
    answers: {
      "/v1/search": () => ({ groups: [{ type: "files", count: 1, rows: [{ volume: "documents", folder: "documents", path: "deep/f150.txt", name: "f150.txt", hash: "h150", size: 1, rev: 1 }] }] }),
      "/v1/browse": (args) => {
        const query = new URL(args.route, "http://x").searchParams;
        const start = query.get("after") ? entries.findIndex((row) => row.path === query.get("after")) + 1 : 0;
        const page = entries.slice(start, start + 100);
        return { entries: page, next: start + 100 < entries.length ? page.at(-1).path : null };
      },
    },
  });
  ui.key("k", { metaKey: true }, ui.w.document.body);
  await until(() => ui.$("#palette")?.open);
  await typePalette(ui, "f150", "Files");
  pressPalette(ui, "Enter", { metaKey: true });
  await until(ui.settled(() => ui.$('.browser-file-row[aria-current="true"]') && ui.w.document.activeElement === ui.$('.browser-file-row[aria-current="true"]')));
  assert.equal(ui.$('.browser-file-row[aria-current="true"]').dataset.name, "f150.txt");
  assert.equal(ui.$$(".browser-file-row").length, 200, "it stops at the page that holds the row");
});

test("⌘Enter on a month row opens that month in the gallery and closes the palette", async (t) => {
  const ui = await boot(t, {
    volumes: [{ ...base, id: "photos", name: "photos", gallery: true }],
    answers: {
      "/v1/search": () => ({ groups: [{ type: "photos", count: 3, label: "Sep 2026", periods: [{ volume: "photos", folder: "photos", label: "September 2026", cursor: "2026-09-30|~", count: 3 }], rows: [] }] }),
      "/v1/gallery?": () => ({ items: [], next: null, previous: null, days: {}, timeline: [], undated: { count: 0, videos: 0, rev: 0 } }),
    },
  });
  ui.key("k", { metaKey: true }, ui.w.document.body);
  await until(() => ui.$("#palette")?.open);
  await typePalette(ui, "september", "Photos");
  assert.match(ui.$('#palette [data-pal="0"]').textContent, /September 2026/);
  pressPalette(ui, "Enter", { metaKey: true });
  await until(ui.settled(() => !ui.$("#palette").open && ui.calls.some((call) => call.startsWith("GET /v1/gallery?") && call.includes("from=2026-09-30"))));
});

const photo = (name, day) => ({ path: name, hash: `h-${name}`, kind: "image", date: `2026-09-${day}T10:00:00`, cursor: `2026-09-${day}T10:00:00|${name}`, size: 1, rev: 1, dateSource: "capture date" });
async function viewerGallery(t, items, options = {}) {
  const deleted = new Set();
  const ui = await boot(t, {
    ...options,
    volumes: [{ ...base, id: "photos", name: "photos", gallery: true }],
    answers: {
      "/v1/gallery/delete": (args) => {
        deleted.add(args.body.path);
        return { paths: [args.body.path], rows: [{ path: args.body.path, rev: 2 }] };
      },
      "/v1/gallery?": () => {
        const shown = items.filter((item) => !deleted.has(item.path));
        return { items: shown, next: null, previous: null, days: { "2026-09-20": shown.length }, timeline: [{ month: "2026-09", count: shown.length, videos: 0 }], undated: { count: 0, videos: 0, rev: 0 } };
      },
      "/v1/gallery/preview": () => ({ data: "data:image/png;base64,AAAA" }),
      "/v1/gallery/info": () => ({}),
      "/v1/gallery/memories": () => ({ items: [] }),
      "/v1/gallery/periods": () => ({ periods: [] }),
    },
  });
  ui.$('.folder-card[data-id="photos"]').click();
  await until(ui.settled(() => ui.$$(".photo-thumb[data-photo] .photo-open").length === items.length && ui.idle()));
  return ui;
}
async function openViewer(ui, index) {
  const tile = ui.$$(".photo-thumb[data-photo] .photo-open")[index];
  tile.focus();
  tile.click();
  await until(ui.settled(() => ui.$("#dialog.photo-viewer")?.open && ui.$(".photo-delete")));
  return tile;
}
async function confirmDelete(ui) {
  ui.$(".photo-delete").click();
  await until(() => ui.$("#background-dialog") && ui.$("#dialog").open && ui.$("#submit-dialog")?.textContent === "Delete");
  ui.$("#dialog-form").requestSubmit();
}

test("deleting the only photo from the viewer closes the viewer once the confirmation leaves, and focus lands in the gallery", async (t) => {
  const ui = await viewerGallery(t, [photo("solo.jpg", "20")]);
  await openViewer(ui, 0);
  await confirmDelete(ui);
  await until(ui.settled(() => !ui.$("#dialog")?.open && !ui.$("#background-dialog") && ui.idle()));
  assert.equal(ui.$$("dialog.photo-viewer[open]").length, 0, "the viewer never stays on the deleted photo");
  assert.notEqual(ui.w.document.activeElement, ui.w.document.body, "focus is not dropped on the page");
  assert.ok(ui.$("#content").contains(ui.w.document.activeElement));
});

test("after deleting inside the viewer, closing it returns focus to the photo it shows", async (t) => {
  const ui = await viewerGallery(t, [photo("a.jpg", "21"), photo("b.jpg", "20")]);
  await openViewer(ui, 0);
  await confirmDelete(ui);
  await until(ui.settled(() => ui.$("#dialog.photo-viewer")?.open && !ui.$("#background-dialog") && ui.$$(".photo-thumb[data-photo] .photo-open").length === 1 && ui.idle()));
  ui.$("#cancel-dialog").click();
  await until(ui.settled(() => !ui.$("#dialog").open));
  const left = ui.$$(".photo-thumb[data-photo] .photo-open");
  assert.equal(left.length, 1);
  assert.equal(ui.w.document.activeElement, left[0]);
});

test("a layered confirmation that closes asynchronously returns focus to the viewer control that opened it", async (t) => {
  const ui = await viewerGallery(t, [photo("a.jpg", "21"), photo("b.jpg", "20")], { asyncClose: true });
  await openViewer(ui, 0);
  ui.$(".photo-delete").focus();
  ui.$(".photo-delete").click();
  await until(() => ui.$("#background-dialog") && ui.$("#dialog").open && ui.$("#submit-dialog")?.textContent === "Delete");
  ui.$("#cancel-dialog").focus();
  ui.$("#cancel-dialog").click();
  await until(ui.settled(() => !ui.$("#background-dialog")));
  await wait(20);
  assert.equal(ui.w.document.activeElement, ui.$(".photo-delete"));
  assert.ok(ui.$("#dialog.photo-viewer").open);
});

const file = (path, directory = false) => ({ path, name: path.split("/").pop(), hash: directory ? "" : `h-${path}`, size: 1, rev: 1, ...(directory ? { directory: 1, files: 1 } : {}) });
function browseAnswer(listings) {
  return (args) => ({ entries: listings[new URL(args.route, "http://x").searchParams.get("prefix") || ""] || [], next: null });
}

test("moving between listings of one folder never leaves ghosts of the previous listing", async (t) => {
  const listings = { "": [file("a", true), file("x.txt"), file("y.txt")], a: [file("a/1.txt")] };
  const ui = await boot(t, {
    answers: {
      "/v1/browse": browseAnswer(listings),
      "/v1/activity": () => ({ versions: [{ volume: "documents", path: "x.txt", rev: 3, hash: "h3", size: 1, created: new Date().toISOString(), author: "hub" }], next: null }),
    },
  });
  ui.$('.folder-card[data-id="documents"]').click();
  await until(() => ui.$$(".browser-file-row").length === 3 && ui.idle());
  await wait(60);
  ui.$('.browser-file-row[data-action="browse-directory"]').click();
  await until(() => ui.$$(".browser-file-row:not(.row-leaving)").length === 1 && ui.idle());
  await wait(60);
  assert.equal(ui.$(".row-leaving"), null, "a subfolder is a new listing");
  ui.$('.folder-breadcrumb [data-action="browse-directory"]').click();
  await until(() => ui.$$(".browser-file-row:not(.row-leaving)").length === 3 && ui.idle());
  await wait(60);
  assert.equal(ui.$(".row-leaving"), null, "so is the breadcrumb's parent");
  ui.$('[data-action="folder-tab"][data-id="recent"]').click();
  await until(() => ui.$("#content .history-row") && ui.idle());
  await wait(60);
  assert.equal(ui.$(".row-leaving"), null, "and Recent");
});

test("a row that leaves while the page's scroll is not yet restored fades where it was in its list", async (t) => {
  const listings = { "": [file("p1.txt"), file("p2.txt"), file("p3.txt"), file("p4.txt")] };
  const ui = await boot(t, { answers: { "/v1/browse": browseAnswer(listings) } });
  const { w } = ui;
  const scrolls = new WeakMap();
  Object.defineProperty(w.HTMLElement.prototype, "scrollTop", { configurable: true, get() { return scrolls.get(this) || 0; }, set() {} });
  const flat = w.HTMLElement.prototype.getBoundingClientRect;
  w.HTMLElement.prototype.getBoundingClientRect = function () {
    const rect = flat.call(this);
    const page = this.parentElement?.closest(".page");
    const shift = page ? page.scrollTop : 0;
    return { ...rect, top: rect.top - shift, bottom: rect.bottom - shift, y: rect.y - shift };
  };
  Object.defineProperty(w.document, "hidden", { configurable: true, get: () => false });
  ui.$('.folder-card[data-id="documents"]').click();
  await until(() => ui.$$(".browser-file-row").length === 4 && ui.idle());
  await wait(60);
  scrolls.set(ui.$("#content .page"), 400);
  ui.$("#content .page").append(w.document.createElement("i"));
  await wait(60);
  const index = [...ui.$('.browser-file-row[data-name="p3.txt"]').parentElement.children].indexOf(ui.$('.browser-file-row[data-name="p3.txt"]'));
  listings[""] = listings[""].filter((row) => row.path !== "p3.txt");
  ui.status.volumes[0] = { ...ui.status.volumes[0], files: 19 };
  for (const poll of ui.polls) await poll();
  await until(() => ui.$(".row-leaving") && ui.idle());
  const ghost = ui.$(".row-leaving");
  assert.equal(ghost.dataset.name, "p3.txt");
  const list = ghost.parentElement.getBoundingClientRect();
  assert.equal(ghost.style.getPropertyValue("--ghost-y"), `${index * 50 - list.top}px`, "measured in its list, so it scrolls with the rows");
  assert.match(style, /:has\(> \.row-leaving\) \{\s*position: relative;\s*\}\s*\.row-leaving \{\s*position: absolute;/);
});
