import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { JSDOM } from "jsdom";
import { buildLibrary } from "../apps/desktop/src/music-library.js";

const source = (name) => fs.readFileSync(new URL(`../apps/desktop/src/${name}`, import.meta.url), "utf8");
const html = source("index.html");
const script = [
  source("gallery-timeline-layout.js").replace(/export /g, ""),
  source("file-icons.js").replace(/export /g, ""),
  source("music-library.js").replace(/export /g, ""),
  source("favorite-order.js").replace(/export /g, ""),
  source("notice-contract.js").replace(/export /g, ""),
  source("app.js")
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

const base = { selected: 1, sync: { state: "synced", lastCompleted: new Date().toISOString() }, conflicts: 0, files: 20, bytes: 2048 };

async function boot(t, { volumes, favorites, extra = {}, answers = {} }) {
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://tauri.localhost" });
  const w = dom.window;
  const pending = new Set();
  const ui = { w, saves: [], favorites };
  t.after(async () => {
    do {
      await Promise.allSettled([...pending]);
      await new Promise((resolve) => setTimeout(resolve, 50));
    } while (pending.size || w.document.body?.getAttribute("aria-busy") === "true");
    dom.window.close();
  });
  w.setInterval = () => 0;
  w.HTMLElement.prototype.scrollIntoView = function () {};
  const status = { id: "hub", name: "Casa", role: "hub", phase: "idle", hub: "", volumes, ...extra };
  w.__TAURI__ = {
    core: {
      invoke: (command, args) => {
        const request = (async () => {
          if (command === "bootstrap") return { setup: false, status };
          if (command !== "api") return {};
          if (args.route === "/v1/status") return status;
          if (args.route === "/v1/favorites") {
            if (args.body) {
              ui.saves.push(JSON.parse(JSON.stringify(args.body.favorites)));
              ui.favorites = args.body.favorites;
            }
            return { favorites: ui.favorites };
          }
          for (const [prefix, answer] of Object.entries(answers)) if (args.route.startsWith(prefix)) return answer(args);
          if (args.route.startsWith("/v1/browse")) return { entries: [], next: null };
          if (args.route === "/v1/machines") return { machines: [] };
          if (args.route.startsWith("/v1/music/library")) return { version: "v1", indexing: true, tracks: [] };
          return {};
        })();
        pending.add(request);
        request.finally(() => pending.delete(request));
        return request;
      },
    },
    event: { listen: async () => () => {}, emit: async () => {} },
  };
  w.eval(`(async()=>{${script}\n})()`);
  ui.$ = (selector) => w.document.querySelector(selector);
  ui.$$ = (selector) => [...w.document.querySelectorAll(selector)];
  ui.rows = () => ui.$$("#favorites .favorite[data-id]").map((el) => el.querySelector(".favorite-name").textContent);
  ui.idle = () => w.document.body.getAttribute("aria-busy") !== "true";
  await until(() => (favorites.length ? ui.$("#favorites .favorite") : ui.$(".folder-card")) && ui.idle());
  return ui;
}

const fav = (folder, kind = "folder", target = "", label = folder) => ({ folder, kind, target, label });

test("the sidebar lists only the device's pinned favorites grouped like Folders and sorted by name, with kind glyphs and one state each", async (t) => {
  const ui = await boot(t, {
    volumes: [
      { ...base, id: "documents", name: "documents", conflicts: 1 },
      { ...base, id: "work", name: "alpi-workspace", sync: { state: "syncing" } },
      { ...base, id: "photos", name: "photos", gallery: true },
      { ...base, id: "music", name: "music", music: true },
      { ...base, id: "spare", name: "spare", selected: 0 },
    ],
    favorites: [fav("documents"), fav("documents", "path", "clients/acme/invoices", "invoices"), fav("work", "folder", "", "old name"), fav("photos", "path", "2026/Lisbon", "Lisbon"), fav("music", "album", "album:x", "Kind of Blue"), fav("music", "show", "show:y", "Lex Fridman Podcast")],
  });
  const { $, $$ } = ui;
  assert.equal($("#favorites").getAttribute("role"), "group");
  assert.equal($("#favorites").getAttribute("aria-label"), "Favorites");
  assert.deepEqual(ui.rows(), ["alpi-workspace", "documents", "invoices", "Lisbon", "Kind of Blue", "Lex Fridman Podcast"], "folders, then photos, then audio; places join their folder's group");
  const glyphs = $$("#favorites .favorite[data-id] > [data-icon], #favorites .favorite[data-id] > svg").map((el) => el.dataset.icon || el.getAttribute("data-lucide"));
  assert.equal(glyphs.length, 6);
  const row = (name) => $$("#favorites .favorite[data-id]").find((el) => el.querySelector(".favorite-name").textContent === name);
  assert.ok(row("documents").querySelector(".favorite-state .favorite-dot"));
  assert.equal(row("documents").getAttribute("aria-label"), "documents, Conflict");
  assert.ok(row("alpi-workspace").querySelector(".favorite-state .busy-grid"));
  assert.equal(row("invoices").querySelector(".favorite-state"), null, "a pinned place shows no state");
  assert.equal($$("#favorites .nav-item:not([data-id])").length, 0, "no row for the hub's other folders");
  assert.doesNotMatch($("#favorites").textContent, /more on hub|not synced here/);
  assert.ok($('nav [data-view="folders"]').classList.contains("active"), "Folders is active on the overview");
  assert.equal($$("#favorites .favorite.active").length, 0);
});

test("a favorite opens its place, becomes the only active row, and the header star toggles the location", async (t) => {
  const ui = await boot(t, {
    volumes: [{ ...base, id: "documents", name: "documents" }],
    favorites: [fav("documents"), fav("documents", "path", "clients/acme/invoices", "invoices")],
    answers: { "/v1/browse": () => ({ entries: [{ path: "clients/acme/invoices/2025", name: "2025", directory: 1, files: 9, size: 1400 }], next: null }) },
  });
  const { $, $$ } = ui;
  $$("#favorites .favorite[data-id]")[1].click();
  await until(() => $(".folder-breadcrumb [aria-current]")?.textContent === "invoices" && ui.idle());
  assert.deepEqual($$("#favorites .favorite.active").map((el) => el.querySelector(".favorite-name").textContent), ["invoices"]);
  assert.equal($("nav .nav-item.active"), null, "no nav item is active while a favorite is");
  const star = $(".heading-actions .favorite-star");
  assert.equal(star.getAttribute("aria-pressed"), "true");
  assert.equal(star.getAttribute("aria-label"), "Remove from Favorites");
  star.click();
  await until(() => ui.saves.length === 1);
  assert.deepEqual(ui.saves[0].map((item) => item.label), ["documents"]);
  await until(() => $(".heading-actions .favorite-star").getAttribute("aria-pressed") === "false" && !$(".heading-actions .favorite-star").disabled && ui.idle());
  assert.deepEqual($$("#favorites .favorite.active").map((el) => el.querySelector(".favorite-name").textContent), ["documents"], "else the favorite folder containing it");
  $(".heading-actions .favorite-star").click();
  await until(() => ui.saves.length === 2);
  assert.deepEqual(ui.saves[1].at(-1), fav("documents", "path", "clients/acme/invoices", "invoices"));
});

test("right-click pins a sub-folder into its sorted place, ⋯ removes a favorite and nothing reorders by hand", async (t) => {
  const ui = await boot(t, {
    volumes: [{ ...base, id: "documents", name: "documents" }, { ...base, id: "notes", name: "notes" }],
    favorites: [fav("documents"), fav("notes")],
    answers: { "/v1/browse": () => ({ entries: [{ path: "clients", name: "clients", directory: 1, files: 9, size: 1400 }], next: null }) },
  });
  const { $, $$, w } = ui;
  $$("#favorites .favorite[data-id]")[0].click();
  await until(() => $('.browser-file-row[data-action="browse-directory"]') && ui.idle());
  $('.browser-file-row[data-action="browse-directory"]').dispatchEvent(new w.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 300, clientY: 200 }));
  const menu = $(".context-menu");
  assert.ok(menu);
  assert.equal(menu.getAttribute("role"), "menu");
  assert.deepEqual($$(".context-menu button").map((el) => el.textContent.trim()), ["Open", "Add to Favorites"]);
  assert.equal(menu.style.getPropertyValue("--menu-x"), "300px");
  $('.context-menu [data-action="favorite-pin"]').click();
  await until(() => ui.saves.length === 1);
  assert.deepEqual(ui.saves[0].at(-1), fav("documents", "path", "clients", "clients"));
  assert.equal($(".context-menu"), null);
  await until(() => ui.rows().length === 3);
  assert.deepEqual(ui.rows(), ["clients", "documents", "notes"]);
  assert.ok($$("#favorites .favorite").every((row) => !row.hasAttribute("draggable") && !row.hasAttribute("title")));
  $$("#favorites .favorite[data-id]")[0].focus();
  $$("#favorites .favorite[data-id]")[0].dispatchEvent(new w.KeyboardEvent("keydown", { key: "ArrowDown", altKey: true, bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(ui.saves.length, 1, "Alt+arrows no longer move a favorite");
  assert.deepEqual(ui.rows(), ["clients", "documents", "notes"]);
  $$("#favorites .favorite-actions")[0].click();
  await until(() => $('.context-menu [data-action="favorite-remove"]'));
  $('.context-menu [data-action="favorite-remove"]').click();
  await until(() => ui.saves.length === 2);
  assert.deepEqual(ui.saves[1].map((item) => item.label), ["documents", "notes"]);
  await until(() => ui.rows().length === 2);
  assert.deepEqual(ui.rows(), ["documents", "notes"]);
  await until(() => ui.idle());
  await new Promise((resolve) => setTimeout(resolve, 100));
});

test("with nothing pinned the Favorites region is hidden and synced folders are never added", async (t) => {
  const ui = await boot(t, {
    volumes: [{ ...base, id: "documents", name: "documents" }, { ...base, id: "photos", name: "photos", gallery: true }, { ...base, id: "spare", name: "spare", selected: 0 }],
    favorites: [],
  });
  const { $ } = ui;
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal($("#favorites").hidden, true);
  assert.equal(ui.rows().length, 0);
  assert.deepEqual(ui.saves, [], "nothing is saved on the person's behalf");
});

test("a folder is pinned only explicitly, from its header star or its overview row's right-click", async (t) => {
  const ui = await boot(t, {
    volumes: [{ ...base, id: "documents", name: "documents" }, { ...base, id: "notes", name: "notes" }],
    favorites: [],
  });
  const { $, w } = ui;
  await until(() => $('.folder-card[data-action="folder-detail"][data-id="notes"]'));
  $('.folder-card[data-action="folder-detail"][data-id="notes"]').dispatchEvent(new w.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 300, clientY: 200 }));
  await until(() => $('.context-menu [data-action="favorite-pin"]'));
  $('.context-menu [data-action="favorite-pin"]').click();
  await until(() => ui.saves.length === 1);
  assert.deepEqual(ui.saves[0], [fav("notes")]);
  await until(() => !$("#favorites").hidden && ui.rows().length === 1);
  $('.folder-card[data-action="folder-detail"][data-id="documents"]').click();
  await until(() => $(".heading-actions .favorite-star") && ui.idle());
  assert.equal($(".heading-actions .favorite-star").getAttribute("aria-pressed"), "false");
  $(".heading-actions .favorite-star").click();
  await until(() => ui.saves.length === 2);
  assert.deepEqual(ui.saves[1], [fav("notes"), fav("documents")]);
  await until(() => ui.idle());
});

test("favorite rows share the nav items' type, ink, icons and geometry; only the label differs", () => {
  const css = source("style.css");
  const favorite = [...css.matchAll(/(?:^|\n)([^{}@]+)\{([^}]*)\}/g)]
    .filter(([, selectors]) => selectors.split(",").some((one) => [".nav-item.favorite", ".nav-item.favorite > svg", ".nav-item.favorite.active", ".nav-item.favorite.active > svg"].includes(one.trim())))
    .map(([, , body]) => body)
    .join("\n");
  assert.match(favorite, /flex: 1 1 auto;/);
  for (const property of ["font-size", "font-weight", "font-family", "color", "padding", "padding-block", "padding-inline", "line-height", "min-height", "height", "border-radius", "background", "gap"])
    assert.doesNotMatch(favorite, new RegExp(`(^|[\\s;])${property}:`), `favorite rows inherit ${property} from .nav-item`);
  assert.match(source("index.html"), /<div class="favorites-head section-label" aria-hidden="true"><span>Favorites<\/span><\/div>/);
  assert.match(css, /\n\.favorites \.favorites-head \{\s*min-height: var\(--space-5\);\s*margin: 0;\s*padding: 0 10px;\s*\}/);
});

test("an album that left the library is removed from Favorites once the library is read", async (t) => {
  const tracks = [{ path: "Miles/Kind of Blue/01 So What.mp3", hash: "h1", size: 1, title: "So What", artist: "Miles Davis", albumArtist: "Miles Davis", album: "Kind of Blue", track: 1, duration: 500 }];
  const kept = buildLibrary({ tracks }).albumList[0];
  const ui = await boot(t, {
    volumes: [{ ...base, id: "music", name: "music", music: true }],
    favorites: [fav("music"), fav("music", "album", kept.id, "Kind of Blue"), fav("music", "album", "album:gone", "Gone")],
    answers: { "/v1/music/library": () => ({ version: "v1", indexing: false, tracks }), "/v1/audio-positions": () => ({ positions: [] }) },
  });
  await until(() => ui.saves.length === 1);
  assert.deepEqual(ui.saves[0].map((item) => item.label), ["music", "Kind of Blue"]);
});

test("only the Favorites region scrolls, with a fade on the clipped edge, and the 64 px rail keeps glyphs with corner dots", () => {
  const css = source("style.css");
  assert.match(css, /\n\.favorites \{\s*flex: 0 1 auto;\s*min-height: 0;[^}]*overflow-y: auto;/);
  assert.match(css, /\n\.favorites\.fade-end \{\s*mask-image: linear-gradient\(var\(--ink\) calc\(100% - var\(--space-5\)\), transparent\);/);
  assert.match(css, /@media \(max-width: 480px\) \{\n  \.favorites \.favorites-head \{[^}]*background: var\(--div\);[\s\S]*?\.favorite-state \{\s*position: absolute;[^}]*border-radius: 50%;/);
  assert.match(source("index.html"), /<div id="favorites" class="favorites" role="group" aria-label="Favorites" hidden>/);
});

test("the sidebar Search is a borderless nav-style row that opens the one palette", () => {
  const css = source("style.css");
  const rule = /\n\.palette-open \{([^}]*)\}/.exec(css)[1];
  assert.match(rule, /padding: 7px 10px;/);
  assert.match(rule, /border: 0;/);
  assert.match(rule, /background: none;/);
  assert.match(rule, /color: var\(--soft\);/);
  assert.match(rule, /font-weight: 500;/);
  assert.match(css, /\n\.palette-open:hover \{\s*background: var\(--surface\);/);
  assert.match(css, /\n\.palette-open \.palette-key \{\s*margin-left: auto;\s*border-color: transparent;\s*background: none;\s*color: var\(--mute\);/);
  const atRest = [...css.matchAll(/(?:^|\n)([^{}@]+)\{([^}]*)\}/g)]
    .filter(([, selectors]) => selectors.split(",").some((one) => /\.palette-open(?![\w-])(?!\S*:(hover|active|focus))(?! \S)/.test(one.trim())))
    .map(([, , body]) => body);
  assert.ok(atRest.length >= 2);
  for (const body of atRest) assert.doesNotMatch(body, /background(-color)?: (?!none)/, "no fill at rest");
  assert.doesNotMatch(atRest.join("\n"), /border: (?!0)|box-shadow:/, "no frame at rest");
  assert.match(source("index.html"), /<button type="button" class="palette-open" data-action="palette" aria-label="Search">/);
});

test("favorites sort by the folder's kind, then by name ignoring case and accents, the same collation as Folders", async () => {
  const { favoriteOrder, nameOrder } = await import("../apps/desktop/src/favorite-order.js");
  const volumes = [
    { id: "b", name: "Écoles" },
    { id: "a", name: "apuntes" },
    { id: "p", name: "Photos", gallery: true },
    { id: "m", name: "música", music: true },
    { id: "g", name: "Álbum", gallery: true, music: true },
  ];
  const items = [fav("m"), fav("m", "show", "s", "Acquired"), fav("p", "path", "2026", "2026 Lisbon"), fav("b"), fav("g"), fav("a", "path", "x", "Zeta"), fav("a"), fav("a", "path", "y", "écrits 10"), fav("a", "path", "z", "écrits 9")];
  const labels = favoriteOrder(items, volumes).map((index) => (items[index].kind === "folder" ? volumes.find((v) => v.id === items[index].folder).name : items[index].label));
  assert.deepEqual(labels, ["apuntes", "Écoles", "écrits 9", "écrits 10", "Zeta", "2026 Lisbon", "Álbum", "Acquired", "música"]);
  assert.ok(nameOrder("école", "Ecole") === 0 && nameOrder("b", "A") > 0);
  const app = source("app.js");
  assert.match(app, /\[\.\.\.\(status\.role === "hub" \? status\.volumes : selected\)\]\.sort\(\(a, b\) => nameOrder\(a\.name, b\.name\)\)/, "Folders uses the same collation");
  assert.doesNotMatch(app, /moveFavorite|dragstart|favoriteDrag|drop-before/);
  assert.doesNotMatch(source("style.css"), /drop-before|drop-after|\.favorite\.dragging/);
});

test("the Favorites context menu walks with arrows, Home and End, leaves on Tab or focus elsewhere and stays inside the window", async (t) => {
  const ui = await boot(t, {
    volumes: [{ ...base, id: "documents", name: "documents" }, { ...base, id: "notes", name: "notes" }],
    favorites: [],
  });
  const { $, $$, w } = ui;
  w.HTMLElement.prototype.getBoundingClientRect = function () {
    return this.matches(".context-menu") ? { top: 0, left: 0, right: 200, bottom: 120, width: 200, height: 120 } : { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
  };
  const card = $('.folder-card[data-action="folder-detail"][data-id="notes"]');
  const open = (x, y) => card.dispatchEvent(new w.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y }));
  const key = (name) => w.document.activeElement.dispatchEvent(new w.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
  open(w.innerWidth - 20, w.innerHeight - 10);
  const menu = $(".context-menu");
  assert.equal(menu.style.getPropertyValue("--menu-x"), `${w.innerWidth - 200 - 8}px`, "clamped to the right edge");
  assert.equal(menu.style.getPropertyValue("--menu-y"), `${w.innerHeight - 120 - 8}px`, "and to the bottom edge");
  const items = $$(".context-menu button");
  assert.equal(w.document.activeElement, items[0]);
  key("ArrowDown");
  assert.equal(w.document.activeElement, items[1]);
  key("ArrowDown");
  assert.equal(w.document.activeElement, items[0], "arrows wrap");
  key("End");
  assert.equal(w.document.activeElement, items.at(-1));
  key("Home");
  assert.equal(w.document.activeElement, items[0]);
  key("ArrowUp");
  assert.equal(w.document.activeElement, items.at(-1));
  card.focus();
  assert.equal($(".context-menu"), null, "focus moving elsewhere dismisses it");
  open(300, 200);
  assert.equal($(".context-menu").style.getPropertyValue("--menu-x"), "300px");
  key("Tab");
  assert.equal($(".context-menu"), null, "Tab dismisses it");
  assert.equal(w.document.activeElement, card, "and returns to its row");
});
