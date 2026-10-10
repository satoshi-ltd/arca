import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { JSDOM } from "jsdom";

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

async function boot(t, status, answers = {}) {
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://tauri.localhost" });
  const w = dom.window;
  const pending = new Set();
  t.after(async () => {
    do {
      await Promise.allSettled([...pending]);
      await new Promise((resolve) => setTimeout(resolve, 50));
    } while (pending.size || w.document.body?.getAttribute("aria-busy") === "true");
    dom.window.close();
  });
  w.setInterval = () => 0;
  w.__TAURI__ = {
    core: {
      invoke: (command, args) => {
        const request = (async () => {
          if (command === "bootstrap") return { setup: false, status };
          if (command !== "api") return {};
          if (args.route === "/v1/status") return status;
          if (args.route === "/v1/favorites") return { favorites: [] };
          for (const [prefix, answer] of Object.entries(answers)) if (args.route.startsWith(prefix)) return answer(args);
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
  return w;
}

const base = { selected: 1, sync: { state: "synced", lastCompleted: new Date().toISOString() }, conflicts: 0, files: 20, bytes: 2048 };
const hub = (volumes, extra = {}) => ({ id: "hub", name: "Casa", role: "hub", phase: "idle", hub: "", volumes, ...extra });

test("a folder row's state tints its tile, leads its subtitle and drops the pill; only progress draws a ring", async (t) => {
  const w = await boot(
    t,
    hub([
      { ...base, id: "docs", name: "documents", conflicts: 2 },
      { ...base, id: "scans", name: "scans", sync: { state: "error", error: "EACCES: permission denied" } },
      { ...base, id: "projects", name: "projects", path: "/Volumes/Archive/projects", sync: { state: "error", error: "ENOENT: no such file" } },
      { ...base, id: "music", name: "music", music: true, sync: { state: "idle" } },
      { ...base, id: "backups", name: "backups" },
    ]),
  );
  const row = (id) => w.document.querySelector(`.folder-card[data-id="${id}"]`);
  await until(() => row("backups"));
  const docs = row("docs");
  assert.ok(docs.querySelector(".home-lead > .tile.large.wa"));
  assert.equal(docs.querySelector(".home-ring"), null);
  assert.equal(docs.querySelector(".meta").textContent, "2 conflicts · 20 files · 2.0 KB");
  assert.ok(docs.querySelector(".meta .state-word.state-wa"));
  assert.ok(docs.querySelector('[data-action="folder-conflicts"]'), "Review stays");
  const scans = row("scans");
  assert.ok(scans.querySelector(".home-lead > .tile.large.er"));
  assert.equal(scans.querySelector(".meta").textContent, "Needs attention · EACCES: permission denied");
  assert.ok(scans.querySelector(".meta .state-word.state-er"));
  const projects = row("projects");
  assert.equal(projects.querySelector(".meta").textContent, "Path missing · /Volumes/Archive/projects");
  assert.ok(projects.querySelector('[data-action="locate-folder"]'));
  assert.match(projects.getAttribute("aria-label"), /, Path missing$/);
  const music = row("music");
  assert.equal(music.querySelector(".tile.wa, .tile.er, .tile.id"), null, "pending keeps the normal tile");
  assert.equal(music.querySelector(".meta").textContent, "Pending · 20 files · 2.0 KB");
  assert.equal(row("backups").querySelector(".meta").textContent, "20 files · 2.0 KB");
  assert.equal(w.document.querySelector(".folder-card .pill"), null, "no folder row carries a state pill");
  const app = source("app.js");
  assert.match(app, /if \(status\.phase === "paused"\) return \["Paused", "id", "pause"\];/);
  assert.match(app, /if \(status\.hubUnavailable\) return \["Offline", "id", "wifi-off"\];/);
  const css = source("style.css");
  assert.match(css, /\n\.tile\.wa,\n\.row-preview\.wa \{\s*background: var\(--waBg\);\s*color: var\(--waFg\);/);
  assert.match(css, /\n\.tile\.er,\n\.row-preview\.er \{\s*background: var\(--erBg\);\s*color: var\(--erFg\);/);
  assert.match(css, /\n\.tile\.id,\n\.row-preview\.id \{\s*background: var\(--idBg\);\s*color: var\(--idFg\);/);
  assert.doesNotMatch(css, /home-conflict|\.history-row\.conflict > \.icon/);
});

test("a paused hub draws every folder on a neutral tile with its kind glyph and the word Paused", async (t) => {
  const w = await boot(t, hub([{ ...base, id: "photos", name: "photos", gallery: true }], { phase: "paused" }));
  await until(() => w.document.querySelector('.folder-card[data-id="photos"]'));
  const row = w.document.querySelector('.folder-card[data-id="photos"]');
  assert.ok(row.querySelector(".home-lead > .tile.large.id"));
  assert.ok(!row.querySelector('[data-icon="pause"]'), "the kind glyph stays");
  assert.equal(row.querySelector(".meta").textContent, "Paused · 20 files · 2.0 KB");
  assert.equal(row.querySelector(".meta .state-word").className, "state-word");
});

test("history tints conflict and deleted previews behind their glyph", async (t) => {
  const ago = new Date(Date.now() - 60000).toISOString();
  const versions = [
    { rev: 3, volume: "docs", path: "brief.conflict-fold-9f3a.md", created: ago, author: "fold", deleted: 0, hash: "a" },
    { rev: 2, volume: "docs", path: "old-plan.md", created: ago, author: "mac", deleted: 1 },
    { rev: 1, volume: "docs", path: "notes.md", created: ago, author: "mac", deleted: 0, hash: "b" },
  ];
  const w = await boot(t, hub([{ ...base, id: "docs", name: "documents" }]), { "/v1/activity": () => ({ versions, next: null }) });
  await until(() => w.document.querySelector(".folder-card"));
  w.document.querySelector('[data-view="history"]').click();
  await until(() => w.document.querySelectorAll(".history-row").length === 3);
  const [conflict, deleted, plain] = w.document.querySelectorAll(".history-row");
  assert.ok(conflict.querySelector(".row-preview.wa"));
  assert.ok(deleted.querySelector(".row-preview.id"));
  assert.equal(plain.querySelector(".row-preview"), null);
});

test("no control carries a native title: hinted buttons rely on the shared tooltip alone", () => {
  for (const name of ["app.js", "index.html", "tray.js"]) {
    const text = source(name);
    assert.doesNotMatch(text, /<button\b[^>]*\stitle=/, `${name} has no button with title=`);
    assert.doesNotMatch(text, /<[a-z]+\b[^>]*\b(data-tooltip|aria-label)="[^"]*"[^>]*\stitle=|<[a-z]+\b[^>]*\stitle="[^"]*"[^>]*\bdata-tooltip=/, `${name} pairs no title with a tooltip`);
    assert.doesNotMatch(text, /<span class="mono" title=/);
  }
  assert.match(source("app.js"), /\$\("\.photo-info-toggle"\)\.dataset\.tooltip = "Info \(⌘I \/ Ctrl\+I\)";/);
});

test("a control that cannot act now is dimmed and never takes the press fill", () => {
  const css = source("style.css");
  const press = [...css.matchAll(/(?:^|\n)([^{}@]+)\{([^}]*)\}/g)].filter(([, , body]) => /background: var\(--press\)|opacity: 0\.85/.test(body));
  const selectors = press.flatMap(([, list]) => list.split(",").map((one) => one.trim()));
  for (const selector of selectors.filter((one) => /^(:not\(\[aria-disabled="true"\]\))?\.(secondary|icon-button|primary|history-row)|menu-items button/.test(one)))
    assert.match(selector, /:not\(\[aria-disabled="true"\]\)/, selector);
  assert.match(css, /button:disabled,\s*button\[aria-disabled="true"\],\s*\.history-row\[aria-disabled="true"\] \{\s*opacity: 0\.5;/);
});

test("an empty state's 40 px arch uses the small drawing", async () => {
  const { brandDrawing } = await import("../packages/core/brand-mark.js");
  const app = source("app.js");
  const helpers = app.slice(app.indexOf("const brandArch = () =>"), app.indexOf("const brandDraw ="));
  const pick = app.slice(app.indexOf("function empty("), app.indexOf("\n}\n", app.indexOf("function empty(")) + 2);
  const run = new Function("icon", `${helpers}\n${pick}\nreturn empty("This folder is empty", "", "", "arca");`);
  const markup = run((name) => `<span data-icon="${name}"></span>`);
  const size = Number(/\.empty > \.brand-arch \{\s*width: (\d+)px;/.exec(source("style.css"))[1]);
  const drawing = brandDrawing(size);
  assert.equal(drawing, brandDrawing(40));
  assert.ok(markup.includes(`d="${drawing.arch}"`), "the arch is the drawing for its size");
  assert.ok(markup.includes(`<rect x="${drawing.door.x}" y="${drawing.door.y}" width="${drawing.door.width}" height="${drawing.door.height}" rx="${drawing.door.rx}"/>`));
});
