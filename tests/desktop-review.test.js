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

async function until(check, tries = 300) {
  for (let i = 0; i < tries; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("UI did not reach expected state");
}

async function boot(t, status, { answers: given = {}, hash = "" } = {}) {
  const answers = { "/v1/machines": () => ({ machines: [] }), "/v1/discovery": () => ({ peers: [] }), ...given };
  const dom = new JSDOM(html, { runScripts: "outside-only", url: `http://tauri.localhost/${hash}` });
  const w = dom.window;
  const pending = new Set();
  const calls = [];
  const intervals = [];
  t.after(async () => {
    do {
      await Promise.allSettled([...pending]);
      await new Promise((resolve) => setTimeout(resolve, 50));
    } while (pending.size || w.document.body?.getAttribute("aria-busy") === "true");
    dom.window.close();
  });
  w.setInterval = (run, ms) => intervals.push({ run, ms });
  w.HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  w.HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  w.__TAURI__ = {
    core: {
      invoke: (command, args) => {
        const request = (async () => {
          if (command === "bootstrap") return { setup: false, status };
          if (command !== "api") return {};
          calls.push([args.route.split("?")[0], args.body]);
          for (const [prefix, answer] of Object.entries(answers)) if (args.route.startsWith(prefix)) return answer(args);
          if (args.route === "/v1/status") return typeof status === "function" ? status() : status;
          if (args.route === "/v1/favorites") return { favorites: [] };
          return {};
        })();
        pending.add(request);
        request.finally(() => pending.delete(request)).catch(() => {});
        return request;
      },
    },
    event: { listen: async () => () => {}, emit: async () => {} },
  };
  w.eval(`(async()=>{${script}\n})()`);
  return { w, calls, intervals, q: (selector) => w.document.querySelector(selector), qa: (selector) => [...w.document.querySelectorAll(selector)] };
}

const base = { selected: 1, sync: { state: "synced", lastCompleted: new Date().toISOString() }, conflicts: 0, files: 20, bytes: 2048 };
const hub = (volumes, extra = {}) => ({ id: "hub", name: "Casa", role: "hub", phase: "idle", hub: "", volumes, devices: [], lastSync: new Date().toISOString(), ...extra });
const replica = (volumes, extra = {}) => ({ id: "mac", name: "macbook", role: "replica", phase: "idle", hub: "http://casa:17831", hubName: "casa", volumes, devices: [], lastSync: new Date().toISOString(), ...extra });

test("Sync now keeps its place while a sync runs: dimmed, aria-disabled, tooltip Syncing…, and never activates", async (t) => {
  const ui = await boot(t, hub([{ ...base, id: "docs", name: "docs" }], { phase: "syncing" }));
  await until(() => ui.q('#sync-controls [data-action="sync"]'));
  const now = ui.q('#sync-controls [data-action="sync"]');
  assert.deepEqual(ui.qa("#sync-controls button").map((el) => el.dataset.action), ["pause", "sync"]);
  assert.equal(now.getAttribute("aria-disabled"), "true");
  assert.equal(now.dataset.tooltip, "Syncing…");
  assert.equal(now.getAttribute("aria-label"), "Sync now");
  now.click();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(ui.calls.some(([route]) => route === "/v1/sync"), false);
  const idle = await boot(t, hub([{ ...base, id: "docs", name: "docs" }]));
  await until(() => idle.q('#sync-controls [data-action="sync"]'));
  assert.equal(idle.q('#sync-controls [data-action="sync"]').getAttribute("aria-disabled"), null);
  assert.equal(idle.q('#sync-controls [data-action="sync"]').dataset.tooltip, "Sync now");
  idle.q('#sync-controls [data-action="sync"]').click();
  await until(() => idle.calls.some(([route]) => route === "/v1/sync"));
});

test("Settings reads synchronization as a state pill, and Node and Port are never invented", async (t) => {
  const ui = await boot(t, replica([{ ...base, id: "docs", name: "docs" }], { phase: "paused" }), { hash: "#/settings" });
  await until(() => ui.q("#machine-name"));
  const row = ui.qa(".setting-row").find((el) => el.querySelector("strong")?.textContent === "Synchronization");
  assert.ok(row, "the row is titled Synchronization");
  assert.equal(row.querySelector(".pill").textContent, "Paused");
  assert.equal(row.querySelector("button, input, a"), null, "nothing in the row is interactive");
  const runtime = ui.qa(".setting-row").find((el) => el.querySelector("strong")?.textContent === "Runtime");
  assert.equal(runtime.textContent.replace(/\s+/g, " ").trim(), "RuntimePort Not reported · Node Not reported");
  const enabled = await boot(t, hub([{ ...base, id: "docs", name: "docs" }], { port: 17831, nodeVersion: "24.1.0" }), { hash: "#/settings" });
  await until(() => enabled.q("#machine-name"));
  const hubRow = enabled.qa(".setting-row").find((el) => el.querySelector("strong")?.textContent === "Synchronization");
  assert.ok(hubRow.querySelector(".pill.ok [data-icon='check']"));
  const shown = enabled.qa(".setting-row").find((el) => el.querySelector("strong")?.textContent === "Runtime");
  assert.equal(shown.textContent, "RuntimePort 17831 · Node 24.1.0");
});

test("saving the device name says so, and a rejected name shows its error beside the field", async (t) => {
  let reject = false;
  const ui = await boot(t, hub([{ ...base, id: "docs", name: "docs" }]), {
    hash: "#/settings",
    answers: {
      "/v1/settings": () => {
        if (reject) throw "That name is already taken.";
        return {};
      },
    },
  });
  await until(() => ui.q("#machine-name"));
  const field = ui.q("#machine-name");
  field.value = "Casa 2";
  field.dispatchEvent(new ui.w.Event("change", { bubbles: true }));
  await until(() => /Device name saved\./.test(ui.q("#notice").textContent));
  assert.equal(ui.q("#machine-name-error").hidden, true);
  reject = true;
  ui.q("#machine-name").value = "Taken";
  ui.q("#machine-name").dispatchEvent(new ui.w.Event("change", { bubbles: true }));
  await until(() => !ui.q("#machine-name-error").hidden);
  assert.equal(ui.q("#machine-name-error").textContent, "That name is already taken.");
  assert.equal(ui.q("#machine-name").getAttribute("aria-invalid"), "true");
  assert.equal(ui.q("#machine-name").getAttribute("aria-describedby"), "machine-name-error");
});

test("a view change sets the document title to Heading · Arca and moves focus to the new h1", async (t) => {
  const ui = await boot(t, hub([{ ...base, id: "docs", name: "docs" }]));
  await until(() => ui.q('.folder-card[data-id="docs"]'));
  ui.q('[data-view="history"]').click();
  await until(() => ui.q("#content h1")?.textContent === "History" && ui.w.document.activeElement === ui.q("#content h1"));
  assert.equal(ui.w.document.title, "History · Arca");
  ui.q('[data-view="settings"]').click();
  await until(() => ui.q("#content h1")?.textContent === "Settings" && ui.w.document.activeElement === ui.q("#content h1"));
  assert.equal(ui.w.document.title, "Settings · Arca");
});

test("an empty History caused by a filter or a folder says what is true and offers Show all changes, which clears both", async (t) => {
  const ui = await boot(t, hub([{ ...base, id: "docs", name: "docs" }]), {
    hash: "#/history?volume=docs&filter=conflicts",
    answers: { "/v1/activity": () => ({ versions: [], next: null }) },
  });
  await until(() => ui.q('[data-action="history-show-all"]'));
  assert.equal(ui.q("#history-list .empty h2").textContent, "No conflicts");
  assert.equal(ui.q("#history-list .empty p").textContent, "Nothing needs your decision.");
  ui.q('[data-action="history-show-all"]').click();
  await until(() => ui.w.location.hash === "#/history");
  await until(() => /No history yet/.test(ui.q("#history-list")?.textContent || ""));
  assert.equal(ui.q('[data-action="history-show-all"]'), null, "the unfiltered empty state is unchanged");
  const folder = await boot(t, hub([{ ...base, id: "docs", name: "docs" }]), {
    hash: "#/history?volume=docs",
    answers: { "/v1/activity": () => ({ versions: [], next: null }) },
  });
  await until(() => folder.q('[data-action="history-show-all"]'));
  assert.equal(folder.q("#history-list .empty p").textContent, "Nothing has changed here yet.");
});

test("Delete names the file, and a deleted file's newest version is Deleted with a line to restore an older one", async (t) => {
  const versions = [
    { rev: 9, created: new Date().toISOString(), deleted: true, size: 0, author: "hub", hash: null },
    { rev: 4, created: new Date(Date.now() - 86400000).toISOString(), deleted: false, size: 12, author: "hub", hash: "h1" },
  ];
  const ui = await boot(t, hub([{ ...base, id: "docs", name: "docs" }]), {
    hash: "#/history?volume=docs&path=notes%2Fbrief.md",
    answers: { "/v1/history": () => ({ versions, next: null }) },
  });
  await until(() => ui.q(".file-version-row"));
  const first = ui.qa(".file-version-row")[0];
  assert.equal(first.querySelector(".pill").textContent, "Deleted");
  assert.equal(ui.qa(".file-version-row .pill").some((el) => el.textContent === "Current"), false);
  assert.equal(ui.q("#history-list .hint").textContent, "This file is deleted. Restore an older version below.");
  const live = await boot(t, hub([{ ...base, id: "docs", name: "docs" }]), {
    hash: "#/history?volume=docs&path=notes%2Fbrief.md",
    answers: { "/v1/history": () => ({ versions: [{ ...versions[1], rev: 10 }], next: null, local: null }) },
  });
  await until(() => live.q(".file-version-row"));
  assert.equal(live.q(".file-version-row .pill").textContent, "Current");
  assert.equal(live.q("#history-list .hint"), null);
  live.q('[data-action="delete-file"]')?.click();
  await until(() => live.q("#dialog[open] h2"));
  assert.equal(live.q("#dialog h2").textContent, "Delete “brief.md”?");
});

test("Files rows carry the time of the last change, folders keep their count and size", async (t) => {
  const created = new Date(Date.now() - 2 * 3600000).toISOString();
  const ui = await boot(t, hub([{ ...base, id: "docs", name: "docs" }]), {
    hash: "#/folders/docs",
    answers: {
      "/v1/browse": () => ({
        entries: [
          { name: "notes", path: "notes", directory: 1, files: 6, size: 48 * 1024 },
          { name: "brief.md", path: "brief.md", directory: 0, size: 12 * 1024, rev: 3, hash: "h", created },
          { name: "old.md", path: "old.md", directory: 0, size: 100, rev: 2, hash: "o" },
        ],
        next: null,
      }),
    },
  });
  await until(() => ui.q(".browser-file-row"));
  const lines = ui.qa(".browser-file-row p").map((el) => el.textContent);
  assert.deepEqual(lines, ["6 files · 48.0 KB", "12.0 KB · 2 h ago", "100 B"]);
  assert.equal(ui.qa(".browser-file-row p")[1].dataset.relative, created);
  assert.equal(ui.q(".folder-explorer + .hint").textContent, "Space to preview");
});

test("a folder not yet counted reads Not counted yet, sizes reach TB and dates beyond this year carry it", async (t) => {
  const old = new Date(Date.now() - 400 * 86400000).toISOString();
  const ui = await boot(
    t,
    hub(
      [
        { ...base, id: "huge", name: "huge", files: 3, bytes: 2 * 1024 ** 4 },
        { ...base, id: "fresh", name: "fresh", files: undefined, bytes: undefined },
      ],
      { lastSync: old },
    ),
  );
  await until(() => ui.q('.folder-card[data-id="fresh"]'));
  assert.equal(ui.q('.folder-card[data-id="huge"] .meta').textContent, "3 files · 2.0 TB");
  assert.equal(ui.q('.folder-card[data-id="fresh"] .meta').textContent, "Not counted yet");
  assert.match(ui.q("#last-sync").textContent, /^Last sync .*\b\d{4}\b/);
});

test("relative times re-render on the one-minute tick", async (t) => {
  const ui = await boot(t, hub([{ ...base, id: "docs", name: "docs" }], { lastSync: new Date().toISOString() }));
  await until(() => ui.q("#last-sync")?.dataset.relative);
  ui.q("#last-sync").dataset.relative = new Date(Date.now() - 5 * 60000).toISOString();
  const tick = ui.intervals.find((timer) => timer.ms === 60000);
  assert.ok(tick, "a quiet timer re-renders relative times");
  tick.run();
  assert.equal(ui.q("#last-sync").textContent, "Last sync 5 min ago");
});

test("a Devices load failure shows one notice with Retry and a hint naming the missing source", async (t) => {
  const ui = await boot(t, hub([{ ...base, id: "docs", name: "docs" }]), {
    hash: "#/machines",
    answers: {
      "/v1/discovery": () => {
        throw "Discovery is down.";
      },
    },
  });
  await until(() => ui.q('#notice [data-action="refresh"]'));
  assert.equal(ui.qa("#notice .notice-card").length, 1);
  assert.equal(ui.q("#notice .notice-actions").textContent.trim(), "Retry now");
  await until(() => [...ui.qa("#content .hint")].some((el) => el.textContent === "Discovery unavailable."));
  assert.equal(ui.qa("#content .hint").some((el) => /Discovery is down/.test(el.textContent)), false, "the technical text is not repeated");
});

test("the replica's Stop syncing panel names the local choice", async (t) => {
  const ui = await boot(t, replica([{ ...base, id: "docs", name: "docs" }]), { hash: "#/folders/docs" });
  await until(() => ui.q(".detail-side .panel"));
  assert.match(ui.q("body").textContent.replace(/\s+/g, " "), /You choose whether this device's copy is kept or deleted\./);
});

test("the palette ignores Enter until its results are current", async (t) => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const row = { type: "folder", id: "docs", name: "docs", of: "folders" };
  const ui = await boot(t, hub([{ ...base, id: "docs", name: "docs" }]), {
    answers: {
      "/v1/search": async () => {
        await gate;
        return { groups: [{ id: "folders", label: "Folders", count: 1, rows: [row] }] };
      },
    },
  });
  await until(() => ui.q('.folder-card[data-id="docs"]'));
  ui.w.document.body.dispatchEvent(new ui.w.KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
  await until(() => ui.q("#palette .pal-input"));
  const input = ui.q("#palette .pal-input");
  input.value = "doc";
  input.dispatchEvent(new ui.w.Event("input", { bubbles: true }));
  assert.equal(ui.q("#palette .pal-field").classList.contains("pal-pending"), true);
  assert.equal(ui.q("#palette .pal-body").getAttribute("aria-busy"), "true");
  input.dispatchEvent(new ui.w.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(ui.q("#palette").open, true, "Enter did nothing while the query was in flight");
  release();
  await until(() => !ui.q("#palette .pal-field").classList.contains("pal-pending"));
  assert.equal(ui.q("#palette .pal-body").getAttribute("aria-busy"), null);
});

test("the wizard focuses its first field, groups the roles, shows a busy label and clears errors", async (t) => {
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://tauri.localhost" });
  const w = dom.window;
  t.after(() => w.close());
  w.setInterval = () => 0;
  w.setTimeout = () => 0;
  let finish;
  w.__TAURI__ = {
    core: {
      invoke: async (command, args) => {
        if (command === "bootstrap") return { setup: true, root: "/tmp/Arca" };
        if (command === "setup_info") return { root: args.root, freeBytes: 1000000000 };
        if (command === "initialize") return new Promise((resolve) => (finish = resolve));
        if (command === "api") return { id: "setup", name: "My PC", role: "hub", root: "/tmp/Arca", volumes: [], devices: [], phase: "needs-folder", retention: { days: 0, versions: 0 } };
        throw new Error(command);
      },
    },
  };
  await w.eval(`(async()=>{${script}\n})()`);
  const q = (selector) => w.document.querySelector(selector);
  const submit = () => q("#setup-form").dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
  assert.equal(w.document.activeElement, q("#setup-form h1"), "the welcome page focuses its heading");
  submit();
  await until(() => q('[name="name"]'));
  assert.equal(w.document.activeElement, q('[name="name"]'), "the first field is focused after each render");
  assert.equal(q("[role=radiogroup]").getAttribute("aria-label"), "Role");
  assert.equal(q("[role=radiogroup]").querySelectorAll(".role-card").length, 2);
  assert.match(w.document.title, /^Set up this device · Arca$/);
  q('[name="name"]').value = "My PC";
  q('[name="role"][value="hub"]').checked = true;
  submit();
  await until(() => q('[name="root"]'));
  assert.equal(w.document.activeElement, q('[name="root"]'));
  q("#setup-error").hidden = false;
  q("#setup-error").textContent = "stale";
  submit();
  await until(() => q('#setup-form button[type="submit"]').getAttribute("aria-busy") === "true");
  assert.equal(q("#setup-error").hidden, true, "an old error is cleared when the next check starts");
  assert.match(q('#setup-form button[type="submit"]').textContent, /Finishing…/);
  assert.ok(q('#setup-form button[type="submit"] .busy-grid'));
  assert.equal(q('#setup-form button[type="submit"]').disabled, true);
  await until(() => finish);
  finish();
});

test("web sign-in shows a routine expiry as a hint, not an error, and Copy rows for both commands", () => {
  const app = source("app.js");
  assert.match(app, /message === SESSION_ENDED \? `<p class="hint" id="login-notice">/);
  assert.match(app, /commandRow\("In Docker", WEB_CODE_DOCKER\)\}\$\{commandRow\("Installed directly", WEB_CODE_DIRECT\)/);
  assert.match(app, /wait\.innerHTML = `<p class="dialog-error" role="alert">\$\{result\.state === "denied" \? "Access denied\." : "Request expired\. Try again\."\}<\/p>`/);
  assert.match(app, /const restore = working\(submit, "Signing in…"\)/);
});

test("the player shows a busy mark, labelled skips and M, F and arrow keys; the viewer leaves video controls their arrows", () => {
  const app = source("app.js");
  assert.match(app, /<div class="video-loading" role="status" aria-label="Loading video">\$\{busyIcon\(\)\}<\/div>/);
  assert.match(app, /videoButton\("back10", "Back 10 seconds", "rotate-ccw", "", "10"\)/);
  assert.match(app, /videoButton\("forward30", "Forward 30 seconds", "rotate-cw", "", "30"\)/);
  for (const event of ["waiting", "stalled", "playing"]) assert.match(app, new RegExp(`video\\.addEventListener\\("${event}"`));
  assert.match(app, /event\.key === "ArrowUp" \|\| event\.key === "ArrowDown"/);
  assert.match(app, /event\.key\.toLowerCase\(\) === "m"/);
  assert.match(app, /event\.key\.toLowerCase\(\) === "f"/);
  assert.match(app, /event\.target\.closest\?\.\("\[data-video\], video, input\[type=range\]"\)\) return;/);
});

test("Quick Look says Details, explains a missing preview and the Files list hints Space", () => {
  const app = source("app.js");
  assert.match(app, /data-ql="open">Details<\/button>/);
  assert.match(app, /<span class="tag">↵<\/span>Details<\/span>/);
  assert.match(app, /No preview for this file type\./);
  assert.match(app, /Preview unavailable\./);
  assert.match(app, /<p class="hint">Space to preview<\/p>/);
});

test("the older-version mark and the video badge expose text without a tooltip", () => {
  const app = source("app.js");
  assert.match(app, /class="device-older" tabindex="0" data-tooltip="Older than the hub’s v\$\{escape\(hubVersion\)\}">[^`]*<span class="sr-only">, older than the hub’s v\$\{escape\(hubVersion\)\}<\/span>/);
  assert.match(app, /<span class="photo-video-badge" role="img" aria-label="Video">/);
});

test("library failures share one Retry empty state; Show more says how many are left; played and failed tracks say so", () => {
  const app = source("app.js");
  assert.match(app, /function mediaFailure\(action, detail, symbol\)/);
  for (const action of ["music-retry", "video-retry", "refresh"]) assert.match(app, new RegExp(`mediaFailure\\("${action}"`));
  assert.match(app, /icon\("image-off"\)\}<p>Preview unavailable\. Try opening the file\.<\/p>/);
  assert.match(app, /const moreLabel = \(left\) => `Show more · \$\{left\.toLocaleString\("en"\)\} left`;/);
  assert.equal((app.match(/music-more", "", "secondary"\)/g) || []).length, 5);
  assert.doesNotMatch(app, /button\("Show more(?: tracks| episodes)?", "music-more"/);
  assert.match(app, /music-length music-played" role="img" aria-label="Played"/);
  assert.match(app, /const MUSIC_FAILED = "Can't play this track";/);
  assert.match(app, /#music-player \.music-player-track > div, #music-mini \.music-mini-text/);
});

test("at 760 px the sleep menu keeps its column beside the controls and nothing hides the volume group", () => {
  const css = source("style.css");
  const narrow = css.slice(css.indexOf("@media (max-width: 760px) {\n  .music-range.video-volume"));
  assert.match(narrow, /\.music-player \{\s*grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1\.5fr\) auto;/);
  assert.doesNotMatch(narrow.slice(0, narrow.indexOf("@media (max-width: 480px)")), /\.music-player-volume \{\s*display: none;/);
  assert.match(css, /#music-player \.music-player-volume > :not\(\.sleep-slot\) \{\s*display: none;/);
});

test("notices have one dismiss control at 32 px and no Dismiss link", () => {
  const app = source("app.js");
  assert.doesNotMatch(app, /notice-muted/);
  assert.match(app, /\$\{action \? `<div class="notice-actions">\$\{action\}<\/div>` : ""\}/);
  assert.match(source("tokens.css"), /--notice-close: 32px;/);
  assert.match(source("style.css"), /\.notice-close \{\s*flex: none;\s*width: var\(--notice-close\);\s*height: var\(--notice-close\);/);
});
