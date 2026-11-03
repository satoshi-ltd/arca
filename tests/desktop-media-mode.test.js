import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { JSDOM } from "jsdom";
import { sampleLibrary } from "./video-fixture.js";

const source = (name) => fs.readFileSync(new URL(`../apps/desktop/src/${name}`, import.meta.url), "utf8");
const html = source("index.html");
const script = [
  source("gallery-timeline-layout.js").replace(/export /g, ""),
  source("file-icons.js").replace(/export /g, ""),
  source("music-library.js").replace(/export /g, ""),
  source("video-library.js").replace(/export /g, ""),
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

const counted = { files: 1284, bytes: 9.6 * 1024 ** 3, conflicts: 0 };
const catalog = [
  { id: "aud", name: "music", music: true, ...counted },
  { id: "pod", name: "podcasts", music: true, ...counted },
  { id: "vid", name: "videos", video: true, ...counted },
  { id: "kep", name: "films", video: true, ...counted },
  { id: "doc", name: "documents", ...counted },
];
const replicaStatus = (media = {}) => ({
  id: "mac",
  name: "macbook-pro",
  role: "replica",
  phase: "idle",
  hub: "http://casa",
  hubId: "hub",
  hubName: "Casa",
  devices: [],
  root: "/Users/javi/Arca",
  protocol: 1,
  platform: "darwin",
  port: 17831,
  volumes: [],
  media,
});
const tracks = [
  { path: "Miles Davis/Kind of Blue/01 So What.mp3", hash: "a".repeat(64), title: "So What", artist: "Miles Davis", album: "Kind of Blue", track: 1, duration: 545 },
  { path: "Miles Davis/Kind of Blue/02 Blue in Green.mp3", hash: "b".repeat(64), title: "Blue in Green", artist: "Miles Davis", album: "Kind of Blue", track: 2, duration: 337 },
];

async function boot(t, { status, route = "#/folders", web = false, downloads = [], pathCheck = null, freeSpace = null, musicDownloads = null, library = tracks }) {
  const dom = new JSDOM(html, { runScripts: "outside-only", url: `http://tauri.localhost/${route}` });
  const w = dom.window;
  const pending = new Set();
  const ui = { posts: [], routes: [], timers: { 2000: [] } };
  t.after(async () => {
    do {
      await Promise.allSettled([...pending]);
      await new Promise((resolve) => setTimeout(resolve, 20));
    } while (pending.size);
    dom.window.close();
  });
  w.setInterval = () => 0;
  const setTimer = w.setTimeout.bind(w);
  const clearTimer = w.clearTimeout.bind(w);
  let held = 0;
  w.setTimeout = (callback, ms, ...rest) => {
    if (!ui.timers[ms]) return setTimer(callback, ms, ...rest);
    const id = `held-${++held}`;
    ui.timers[ms].push({ id, callback });
    return id;
  };
  w.clearTimeout = (id) => {
    if (typeof id !== "string" || !id.startsWith("held-")) return clearTimer(id);
    for (const list of Object.values(ui.timers)) {
      const index = list.findIndex((entry) => entry.id === id);
      if (index >= 0) list.splice(index, 1);
    }
  };
  ui.fire = (ms) => {
    for (const { callback } of ui.timers[ms].splice(0)) callback();
  };
  w.HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  w.HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
    this.dispatchEvent(new w.Event("close"));
  };
  w.IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  const answer = async (path, method, body) => {
    ui.routes.push(path);
    if (method === "POST") ui.posts.push([path, JSON.parse(JSON.stringify(body))]);
    if (path === "/v1/status") return status;
    if (path === "/v1/remote") return { name: "Casa", volumes: status.role === "hub" ? status.volumes : catalog };
    if (path === "/v1/favorites") return { favorites: [] };
    if (path === "/v1/machines") return { machines: [] };
    if (musicDownloads && path.startsWith("/v1/music/downloads?")) return { downloads: musicDownloads.rows };
    if (musicDownloads && path === "/v1/music/download") {
      if (musicDownloads.fail?.(body)) throw new Error("The hub did not answer");
      musicDownloads.rows = [...musicDownloads.rows.filter((row) => !body.paths.includes(row.path)), ...body.paths.map((p) => ({ path: p, hash: library.find((item) => item.path === p).hash, size: 100, done: 0, state: "queued", kind: "music" }))];
      return { downloads: musicDownloads.rows };
    }
    if (musicDownloads && ["/v1/music/download/cancel", "/v1/music/download/remove"].includes(path)) {
      musicDownloads.rows = musicDownloads.rows.filter((row) => !body.paths.includes(row.path));
      return { downloads: musicDownloads.rows };
    }
    if (path.startsWith("/v1/video/downloads?")) return freeSpace ? freeSpace() : { downloads, freeBytes: 589 * 1024 ** 3 };
    if (path.startsWith("/v1/video/library?")) return sampleLibrary();
    if (path.startsWith("/v1/video/art?")) return { data: "data:image/jpeg;base64,AAAA" };
    if (path.startsWith("/v1/music/library?")) return { version: "v1", indexing: false, tracks: library, playlists: [] };
    if (path.startsWith("/v1/music/cover?")) return { unavailable: true };
    if (path === "/v1/audio-positions") return { positions: [], finished: [] };
    if (path === "/v1/path-check") return pathCheck ? pathCheck(body) : { path: body.path, exists: false, writable: true, freeBytes: 589 * 1024 ** 3 };
    if (path === "/v1/unselect") return { deleted: 0, deletedBytes: 0, kept: 0 };
    return { ok: true };
  };
  const track = (request) => {
    pending.add(request);
    request.then(
      () => pending.delete(request),
      () => pending.delete(request),
    );
    return request;
  };
  if (web)
    w.fetch = (path, init = {}) =>
      track(
        answer(path, init.method || "GET", init.body ? JSON.parse(init.body) : null).then((data) => new Response(JSON.stringify(data), { status: 200 })),
      );
  else
    w.__TAURI__ = {
      core: {
        invoke: (command, args) =>
          track(
            (async () => {
              if (command === "bootstrap") return { setup: false, status };
              if (command === "api") return answer(args.route, args.method, args.body);
              return {};
            })(),
          ),
      },
      event: { listen: async () => () => {}, emit: async () => {} },
    };
  w.eval(`(async()=>{${script}\n})()`);
  const $ = (selector) => w.document.querySelector(selector);
  const $$ = (selector) => [...w.document.querySelectorAll(selector)];
  const idle = () => w.document.body.getAttribute("aria-busy") !== "true";
  const click = async (selector, ready = () => true) => {
    const target = typeof selector === "string" ? $(selector) : selector;
    assert.ok(target, String(selector));
    target.click();
    await until(() => ready() && idle());
  };
  const choose = async (value) => {
    const radio = $(`#dialog [name="mode"][value="${value}"]`);
    radio.checked = true;
    radio.dispatchEvent(new w.Event("change", { bubbles: true }));
  };
  return Object.assign(ui, { w, $, $$, idle, click, choose });
}

const row = (ui, name) => ui.$$("#content .folder-card").find((card) => card.querySelector("strong")?.textContent === name);
const section = (ui, name) => ui.$$("#content section").find((el) => el.querySelector(".section-label")?.textContent === name);
const shown = (el) => !!el && !el.closest("[hidden]");
const submit = (ui) => ui.$("#submit-dialog");

test("Folders on a replica list only started libraries in their kind, and a Movies & TV library not started waits under On hub · not selected like an Audio one", async (t) => {
  const ui = await boot(t, { status: replicaStatus({ pod: "stream", kep: "keep" }) });
  await until(() => row(ui, "films"));
  assert.ok(section(ui, "Audio").contains(row(ui, "podcasts")));
  assert.match(row(ui, "podcasts").textContent, /Streams from hub/);
  assert.match(row(ui, "films").textContent, /Kept on this device/);
  assert.equal(row(ui, "podcasts").querySelector('[data-action="add"]'), null, "a streamed library is already chosen");
  assert.equal(row(ui, "films").querySelector('[data-action="add"]'), null, "a kept library is already chosen");
  assert.equal(section(ui, "Movies & TV").contains(row(ui, "videos")), false, "a Movies & TV library not started stays out of its kind");
  assert.ok(section(ui, "On hub · not selected").contains(row(ui, "videos")), "and waits with the folders not selected");
  assert.ok(row(ui, "videos").classList.contains("unselected"));
  assert.ok(row(ui, "videos").querySelector('[data-action="add"]'), "it offers Start syncing");
  assert.match(row(ui, "videos").textContent, /^videos1,284 files · 9\.6 GB/);
  assert.doesNotMatch(row(ui, "videos").textContent, /Streams from hub/);
  assert.ok(row(ui, "videos").querySelector('.row-main[data-action="folder-detail"]'), "while the row still opens the library");
  assert.ok(section(ui, "On hub · not selected").contains(row(ui, "music")));
  assert.ok(row(ui, "music").querySelector('[data-action="add"]'));
});

test("Start syncing an Audio library asks Stream or Keep: Keep shows today's destination, Stream hides it and starts streaming", async (t) => {
  const ui = await boot(t, { status: replicaStatus() });
  await until(() => row(ui, "music"));
  await ui.click(row(ui, "music").querySelector('[data-action="add"]'), () => ui.$("#dialog[open] .folder-selection"));
  assert.equal(ui.$("#dialog h2").textContent, "Sync “music” on macbook-pro");
  const cards = ui.$$("#dialog .role-card");
  assert.deepEqual(cards.map((card) => card.querySelector("strong").textContent), ["Stream from the hub", "Keep on this device"]);
  assert.deepEqual(cards.map((card) => card.querySelector("p").textContent), ["Download tracks or albums to listen offline.", "A full copy that syncs both ways."]);
  assert.equal(ui.$("#dialog .role-card [data-lucide], #dialog .role-card svg, #dialog .role-card .icon"), null, "the cards carry no icon");
  assert.equal(ui.$('#dialog [name="mode"]:checked').value, "keep", "Audio defaults to Keep");
  assert.ok(shown(ui.$("#selection-path")));
  assert.ok(shown(ui.$("#dialog .message:not(#folder-path-status)")));
  await until(() => shown(ui.$("#folder-path-status")) && /Needs 9\.6 GB/.test(ui.$("#folder-path-status").textContent));
  assert.match(submit(ui).textContent, /^Start syncing$/);
  await ui.choose("stream");
  assert.equal(shown(ui.$("#selection-path")), false, "Stream hides the destination");
  assert.equal(shown(ui.$("#folder-path-status")), false, "and the size line");
  assert.equal(shown(ui.$("#dialog .message:not(#folder-path-status)")), false, "and the .arcaignore callout");
  assert.equal(submit(ui).textContent, "Start streaming");
  assert.ok(submit(ui).querySelector('[data-lucide="play"], .lucide-play, [data-icon="play"]') || /play/.test(submit(ui).innerHTML));
  await ui.choose("keep");
  assert.ok(shown(ui.$("#selection-path")));
  assert.equal(submit(ui).textContent, "Start syncing");
  await ui.choose("stream");
  await ui.click("#submit-dialog", () => !ui.$("#dialog[open]"));
  assert.deepEqual(ui.posts.filter(([path]) => path === "/v1/select"), [["/v1/select", { id: "aud", mode: "stream" }]]);
  assert.equal(ui.posts.some(([path]) => path === "/v1/sync"), false, "nothing to sync when streaming");
});

test("Start syncing a Movies & TV library defaults to Stream, and Keep asks for a destination like an Audio library", async (t) => {
  const ui = await boot(t, { status: replicaStatus() });
  await until(() => row(ui, "videos"));
  await ui.click(row(ui, "videos").querySelector('[data-action="add"]'), () => ui.$("#dialog[open] .folder-selection"));
  assert.deepEqual(ui.$$("#dialog .role-card p").map((el) => el.textContent), ["Download titles to watch offline.", "A full copy that syncs both ways."]);
  assert.equal(ui.$('#dialog [name="mode"]:checked').value, "stream", "Movies & TV defaults to Stream");
  assert.equal(shown(ui.$("#selection-path")), false, "streaming needs no destination");
  assert.equal(submit(ui).textContent, "Start streaming");
  await ui.choose("keep");
  assert.ok(shown(ui.$("#selection-path")));
  assert.equal(ui.$("#selection-path").value, "/Users/javi/arca/videos");
  assert.ok(shown(ui.$("#dialog .message:not(#folder-path-status)")), "with the .arcaignore callout");
  await until(() => /New folder · Needs 9\.6 GB/.test(ui.$("#folder-path-status").textContent));
  assert.equal(submit(ui).textContent, "Start syncing");
  await ui.click("#submit-dialog", () => !ui.$("#dialog[open]"));
  assert.deepEqual(ui.posts.filter(([path]) => path === "/v1/select"), [["/v1/select", { id: "vid", mode: "keep", path: "/Users/javi/arca/videos" }]]);
  assert.ok(ui.posts.some(([path]) => path === "/v1/sync"), "a kept library starts syncing");
});

test("an ordinary folder's Start syncing shows no cards, and a web session keeps Movies & TV too", async (t) => {
  const ui = await boot(t, { status: replicaStatus() });
  await until(() => row(ui, "documents"));
  await ui.click(row(ui, "documents").querySelector('[data-action="add"]'), () => ui.$("#dialog[open] .folder-selection"));
  assert.equal(ui.$("#dialog .role-card"), null);
  assert.ok(shown(ui.$("#selection-path")));
  assert.equal(submit(ui).textContent, "Start syncing");
  assert.match(ui.$("#dialog .modal-title p").textContent, /Files sync both ways/);

  const web = await boot(t, { status: replicaStatus(), web: true });
  await until(() => row(web, "videos"));
  await web.click(row(web, "videos").querySelector('[data-action="add"]'), () => web.$("#dialog[open] .folder-selection"));
  assert.deepEqual(web.$$("#dialog .role-card strong").map((el) => el.textContent), ["Stream from the hub", "Keep on this device"], "a server can keep Movies & TV");
  assert.equal(submit(web).textContent, "Start streaming");
});

test("the hub never asks Stream or Keep", async (t) => {
  const status = { ...replicaStatus(), id: "hub", role: "hub", hub: "", volumes: [{ ...catalog[0], selected: 0, path: "/srv/music", sync: { state: "unselected" } }] };
  const ui = await boot(t, { status });
  await until(() => ui.$("#content .folder-card"));
  const add = ui.w.document.createElement("button");
  add.dataset.action = "add";
  add.dataset.id = "aud";
  ui.w.document.body.append(add);
  await ui.click(add, () => ui.$("#dialog[open] .folder-selection"));
  assert.ok(ui.$("#selection-path"), "the hub's own copy keeps its destination");
  assert.equal(ui.$("#dialog .role-card"), null);
});

test("a streamed Audio library opens on its library, deletes through the hub, edits no playlists and stops from its menu", async (t) => {
  const ui = await boot(t, { status: replicaStatus({ pod: "stream" }) });
  await until(() => row(ui, "podcasts"));
  await ui.click(row(ui, "podcasts"), () => ui.$('#content [data-action="music-tab"][data-id="albums"]'));
  await ui.click('#content [data-action="music-tab"][data-id="albums"]', () => ui.$("#content .music-card"));
  await ui.click("#content .music-card", () => ui.$("#content .music-track:not(.music-track-head)"));
  assert.equal(ui.$('#content [data-action="music-mode"]'), null, "there is no folder view to switch to");
  const menu = ui.$("#content .music-track:not(.music-track-head) .music-track-menu .menu-items");
  assert.ok(menu.querySelector('[data-action="music-delete"]'), "Delete… reaches the hub");
  assert.equal(menu.querySelector('[data-action="music-add"]'), null, "playlists stay read-only while streaming");
  await ui.click(menu.querySelector('[data-action="music-delete"]'), () => ui.$("#dialog[open]"));
  await ui.click("#submit-dialog", () => !ui.$("#dialog[open]"));
  assert.deepEqual(ui.posts.find(([path]) => path === "/v1/delete-file"), ["/v1/delete-file", { volume: "pod", path: tracks[0].path }]);
  assert.equal(ui.routes.some((path) => path.startsWith("/v1/history")), false);
  await ui.click('#content [data-action="music-crumb"][data-id="0"]', () => ui.$("#content .folder-actions-menu"));
  const stop = ui.$('#content .folder-actions-menu [data-action="unselect"]');
  assert.equal(stop.textContent, "Stop syncing…");
  await ui.click(stop, () => ui.$("#dialog[open]"));
  assert.equal(ui.$("#dialog h2").textContent, "Stop syncing “podcasts”?");
  await ui.click("#submit-dialog", () => !ui.$("#dialog[open]"));
  assert.deepEqual(ui.posts.find(([path]) => path === "/v1/unselect"), ["/v1/unselect", { id: "pod", deleteFiles: true }]);
});

test("a kept Movies & TV title offers no Remove from this device", async (t) => {
  const library = sampleLibrary();
  const movie = library.movies[0];
  const done = [{ id: movie.id, path: movie.path, hash: movie.hash, size: 10, done: 10, state: "done" }];
  const open = async (ui) => {
    await until(() => row(ui, "videos"));
    await ui.click(row(ui, "videos"), () => ui.$(".video-page .music-card"));
    await ui.click(`[data-action="video-title"][data-id="${movie.id}"]`, () => ui.$(".video-backdrop h2"));
    return ui.$$(".video-backdrop .video-menu .menu-items button").map((el) => el.textContent);
  };
  const kept = await boot(t, { status: replicaStatus({ vid: "keep" }), downloads: done });
  assert.equal((await open(kept)).includes("Remove from this device"), false);
  const streamed = await boot(t, { status: replicaStatus({ vid: "stream" }), downloads: done });
  assert.equal((await open(streamed)).includes("Remove from this device"), true, "a streamed library keeps per-title Remove");
});

test("switching back to Keep after a failed destination check keeps Start syncing disabled", async (t) => {
  const ui = await boot(t, { status: replicaStatus(), pathCheck: () => Promise.reject(Object.assign(new Error("Cannot read or write this folder"), { status: 403 })) });
  await until(() => row(ui, "music"));
  await ui.click(row(ui, "music").querySelector('[data-action="add"]'), () => ui.$("#dialog[open] .folder-selection"));
  await until(() => ui.$("#folder-path-status.message-error"));
  assert.equal(submit(ui).disabled, true);
  await ui.choose("stream");
  assert.equal(submit(ui).disabled, false, "streaming needs no destination");
  await ui.choose("keep");
  assert.equal(submit(ui).disabled, true, "the failed check still blocks Keep");
});

test("a kept title that is downloading offers no Cancel download", async (t) => {
  const library = sampleLibrary();
  const movie = library.movies[0];
  const active = [{ id: movie.id, path: movie.path, hash: movie.hash, size: 10, done: 4, state: "downloading" }];
  const open = async (ui) => {
    await until(() => row(ui, "videos"));
    await ui.click(row(ui, "videos"), () => ui.$(".video-page .music-card"));
    await ui.click(`[data-action="video-title"][data-id="${movie.id}"]`, () => ui.$(".video-backdrop h2"));
    return ui.$$(".video-backdrop .video-menu .menu-items button").map((el) => el.textContent);
  };
  const kept = await boot(t, { status: replicaStatus({ vid: "keep" }), downloads: active });
  assert.equal((await open(kept)).includes("Cancel download"), false, "the reconciler would only queue it again");
  const streamed = await boot(t, { status: replicaStatus({ vid: "stream" }), downloads: active });
  assert.equal((await open(streamed)).includes("Cancel download"), true);
});

const openAlbum = async (ui, name) => {
  await until(() => row(ui, name));
  await ui.click(row(ui, name), () => ui.$('#content [data-action="music-tab"][data-id="albums"]'));
  await ui.click('#content [data-action="music-tab"][data-id="albums"]', () => ui.$("#content .music-card"));
  await ui.click("#content .music-card", () => ui.$("#content .music-track:not(.music-track-head)"));
};
const trackRows = (ui) => ui.$$("#content .music-track:not(.music-track-head)");
const glyphs = (ui) => trackRows(ui).map((el) => el.querySelector(".download-state")?.getAttribute("aria-label") || "");
const itemsOf = (menu) => [...menu.querySelectorAll(".menu-items button")].map((el) => el.textContent.trim());
const headMenu = (ui, label) => ui.$(`#content .music-head .heading-actions .music-track-menu summary[aria-label="${label}"]`)?.closest("details");

test("a streamed album downloads from its ⋯, each row shows its download glyph, and a track's ⋯ holds the same action before Delete…", async (t) => {
  const musicDownloads = { rows: [] };
  const ui = await boot(t, { status: replicaStatus({ aud: "stream" }), musicDownloads });
  await openAlbum(ui, "music");
  await until(() => headMenu(ui, "Album actions"));
  assert.deepEqual(itemsOf(headMenu(ui, "Album actions")), ["Download"]);
  assert.deepEqual(glyphs(ui), ["", ""]);
  assert.ok(ui.$("#content .music-tracks").classList.contains("music-downloadable"));
  assert.equal(ui.$("#content .music-track-head").children.length, 3, "the head keeps a slot for the glyph column");
  assert.deepEqual(itemsOf(trackRows(ui)[0].querySelector(".music-track-menu")), ["Download", "Delete…"]);
  await ui.click(headMenu(ui, "Album actions").querySelector('[data-action="music-download-all"]'), () => glyphs(ui).every((label) => label === "Waiting"));
  assert.deepEqual(ui.posts.find(([path]) => path === "/v1/music/download"), ["/v1/music/download", { volume: "aud", paths: tracks.map((item) => item.path) }]);
  assert.deepEqual(itemsOf(headMenu(ui, "Album actions")), ["Cancel download"]);
  assert.equal(trackRows(ui)[0].querySelector(".download-state [data-icon], .download-state svg")?.dataset?.icon ?? "svg", "circle-dashed");
  assert.deepEqual(itemsOf(trackRows(ui)[1].querySelector(".music-track-menu")), ["Cancel download", "Delete…"]);
  await ui.click(trackRows(ui)[1].querySelector('[data-action="music-download-cancel"]'), () => glyphs(ui)[1] === "");
  assert.deepEqual(ui.posts.find(([path]) => path === "/v1/music/download/cancel"), ["/v1/music/download/cancel", { volume: "aud", paths: [tracks[1].path] }]);
});

test("a downloaded and a downloading track show the arrow and the ring, and Remove from this device asks first and covers only the downloaded ones", async (t) => {
  const musicDownloads = {
    rows: [
      { path: tracks[0].path, hash: tracks[0].hash, size: 100, done: 100, state: "done", kind: "music" },
      { path: tracks[1].path, hash: tracks[1].hash, size: 100, done: 42, state: "downloading", kind: "music" },
    ],
  };
  const ui = await boot(t, { status: replicaStatus({ aud: "stream" }), musicDownloads });
  await openAlbum(ui, "music");
  await until(() => glyphs(ui)[0] === "Downloaded");
  assert.deepEqual(glyphs(ui), ["Downloaded", "Downloading 42%"]);
  assert.equal(trackRows(ui)[1].querySelector(".download-ring-fill").getAttribute("stroke-dasharray"), "42 100");
  assert.equal(trackRows(ui)[1].querySelector(".download-state").dataset.tooltip, "Downloading 42%");
  assert.deepEqual(itemsOf(headMenu(ui, "Album actions")), ["Cancel download", "Remove from this device"]);
  assert.deepEqual(itemsOf(trackRows(ui)[0].querySelector(".music-track-menu")), ["Remove from this device", "Delete…"]);
  const remove = headMenu(ui, "Album actions").querySelector('[data-action="music-download-remove-all"]');
  assert.equal(remove.querySelector("[data-icon]").dataset.icon, "monitor");
  assert.equal(remove.classList.contains("danger"), false);
  await ui.click(remove, () => ui.$("#dialog[open]"));
  assert.equal(ui.$("#dialog h2").textContent, "Remove from this device?");
  assert.equal(ui.posts.some(([path]) => path === "/v1/music/download/remove"), false, "nothing is removed before the confirmation");
  await ui.click("#submit-dialog", () => !ui.$("#dialog[open]") && glyphs(ui)[0] === "");
  assert.deepEqual(ui.posts.find(([path]) => path === "/v1/music/download/remove"), ["/v1/music/download/remove", { volume: "aud", paths: [tracks[0].path] }]);
});

test("an artist's ⋯ downloads all of its albums", async (t) => {
  const musicDownloads = { rows: [] };
  const ui = await boot(t, { status: replicaStatus({ aud: "stream" }), musicDownloads });
  await until(() => row(ui, "music"));
  await ui.click(row(ui, "music"), () => ui.$('#content [data-action="music-artist"]'));
  await ui.click('#content [data-action="music-artist"]', () => headMenu(ui, "Artist actions"));
  assert.deepEqual(itemsOf(headMenu(ui, "Artist actions")), ["Download"]);
  await ui.click(headMenu(ui, "Artist actions").querySelector('[data-action="music-download-all"]'), () => ui.posts.some(([path]) => path === "/v1/music/download"));
  assert.deepEqual(ui.posts.find(([path]) => path === "/v1/music/download")[1], { volume: "aud", paths: tracks.map((item) => item.path) });
});

test("a library kept on the device shows today's pages: no download menu, glyph or column", async (t) => {
  const musicDownloads = { rows: [] };
  const status = replicaStatus({ aud: "keep" });
  status.volumes = [{ id: "aud", name: "music", music: true, selected: true, mode: "keep", path: "/Users/javi/Arca/music", ...counted, sync: { state: "synced" } }];
  const ui = await boot(t, { status, musicDownloads });
  await openAlbum(ui, "music");
  assert.equal(headMenu(ui, "Album actions"), undefined);
  assert.equal(ui.$("#content .music-downloadable"), null);
  assert.equal(ui.$("#content .music-track-head").children.length, 2);
  assert.equal(ui.$$('#content [data-action^="music-download"]').length, 0);
  assert.equal(ui.routes.some((path) => path.startsWith("/v1/music/downloads")), false);
});

test("a download that finishes while a menu is open redraws once the menu closes", async (t) => {
  const musicDownloads = { rows: [{ path: tracks[0].path, hash: tracks[0].hash, size: 100, done: 42, state: "downloading", kind: "music" }] };
  const ui = await boot(t, { status: replicaStatus({ aud: "stream" }), musicDownloads });
  await openAlbum(ui, "music");
  await until(() => glyphs(ui)[0] === "Downloading 42%");
  trackRows(ui)[1].querySelector(".music-track-menu").setAttribute("open", "");
  musicDownloads.rows = [{ ...musicDownloads.rows[0], done: 100, state: "done" }];
  ui.fire(2000);
  await until(() => ui.idle() && ui.timers[2000].length === 1);
  assert.equal(glyphs(ui)[0], "Downloading 42%", "nothing redraws under an open menu");
  trackRows(ui)[1].querySelector(".music-track-menu").removeAttribute("open");
  ui.fire(2000);
  await until(() => glyphs(ui)[0] === "Downloaded");
  assert.deepEqual(itemsOf(headMenu(ui, "Album actions")), ["Download", "Remove from this device"]);
});

test("Download on more than a thousand tracks sends them in batches the daemon accepts", async (t) => {
  const many = Array.from({ length: 1001 }, (_, index) => ({ path: `Various/Big Box/${String(index).padStart(4, "0")}.mp3`, hash: index.toString(16).padStart(64, "0"), title: `Track ${index}`, artist: "Various", album: "Big Box", track: index + 1, duration: 60 }));
  const musicDownloads = { rows: [] };
  const ui = await boot(t, { status: replicaStatus({ aud: "stream" }), musicDownloads, library: many });
  await openAlbum(ui, "music");
  await until(() => headMenu(ui, "Album actions"));
  await ui.click(headMenu(ui, "Album actions").querySelector('[data-action="music-download-all"]'), () => ui.posts.filter(([path]) => path === "/v1/music/download").length === 2);
  assert.deepEqual(ui.posts.filter(([path]) => path === "/v1/music/download").map(([, body]) => body.paths.length), [1000, 1]);
  assert.deepEqual(ui.posts.filter(([path]) => path === "/v1/music/download").flatMap(([, body]) => body.paths), many.map((item) => item.path));
});

test("Stop syncing forgets the library's downloads, so streaming it again reads them from the daemon", async (t) => {
  const musicDownloads = { rows: [{ path: tracks[0].path, hash: tracks[0].hash, size: 100, done: 100, state: "done", kind: "music" }] };
  const ui = await boot(t, { status: replicaStatus({ aud: "stream" }), musicDownloads });
  await openAlbum(ui, "music");
  await until(() => glyphs(ui)[0] === "Downloaded");
  const reads = () => ui.routes.filter((path) => path.startsWith("/v1/music/downloads")).length;
  const first = reads();
  await ui.click('#content [data-action="music-crumb"][data-id="0"]', () => ui.$("#content .folder-actions-menu"));
  await ui.click('#content .folder-actions-menu [data-action="unselect"]', () => ui.$("#dialog[open]"));
  musicDownloads.rows = [];
  await ui.click("#submit-dialog", () => !ui.$("#dialog[open]"));
  await openAlbum(ui, "music");
  await until(() => reads() > first && glyphs(ui)[0] === "");
  assert.deepEqual(glyphs(ui), ["", ""]);
});

test("reading the library again re-reads its downloads, and a download the daemon dropped loses its glyph", async (t) => {
  const musicDownloads = { rows: [{ path: tracks[0].path, hash: tracks[0].hash, size: 100, done: 100, state: "done", kind: "music" }] };
  const ui = await boot(t, { status: replicaStatus({ aud: "stream" }), musicDownloads });
  await openAlbum(ui, "music");
  await until(() => glyphs(ui)[0] === "Downloaded");
  musicDownloads.rows = [];
  const now = ui.w.Date.now();
  ui.w.Date.now = () => now + 60000;
  await ui.click('#content [data-action="back-folders"]', () => row(ui, "music"));
  await openAlbum(ui, "music");
  await until(() => glyphs(ui)[0] === "");
  assert.deepEqual(itemsOf(headMenu(ui, "Album actions")), ["Download"]);
});

test("when a later batch fails, the tracks already queued still show their glyph", async (t) => {
  const many = Array.from({ length: 1001 }, (_, index) => ({ path: `Various/Big Box/${String(index).padStart(4, "0")}.mp3`, hash: index.toString(16).padStart(64, "0"), title: `Track ${index}`, artist: "Various", album: "Big Box", track: index + 1, duration: 60 }));
  const musicDownloads = { rows: [], fail: (body) => body.paths.length === 1 };
  const ui = await boot(t, { status: replicaStatus({ aud: "stream" }), musicDownloads, library: many });
  await openAlbum(ui, "music");
  await until(() => headMenu(ui, "Album actions"));
  ui.$("#content .music-tracks").dataset.stale = "1";
  headMenu(ui, "Album actions").querySelector('[data-action="music-download-all"]').click();
  await until(() => ui.idle() && !ui.$("#content .music-tracks")?.dataset.stale && glyphs(ui)[0] === "Waiting");
  assert.equal(ui.posts.filter(([path]) => path === "/v1/music/download").length, 2);
  assert.deepEqual(itemsOf(headMenu(ui, "Album actions")), ["Download", "Cancel download"]);
});

test("a Movies & TV library kept as a folder lists in its kind, and View folder opens its files with Open in Finder", async (t) => {
  const status = replicaStatus();
  status.volumes = [{ id: "vid", name: "videos", video: true, selected: true, path: "/Users/javi/Arca/videos", ...counted, sync: { state: "synced" } }];
  const ui = await boot(t, { status });
  await until(() => row(ui, "videos"));
  assert.ok(section(ui, "Movies & TV").contains(row(ui, "videos")));
  assert.doesNotMatch(row(ui, "videos").textContent, /Streams from hub|Kept on this device/);
  await ui.click(row(ui, "videos"), () => ui.$('#content [data-action="video-mode"]'));
  assert.equal(ui.$('#content [data-action="video-mode"]').textContent, "View folder");
  await ui.click('#content [data-action="video-mode"]', () => /local/.test(ui.$("#content .detail-title p")?.textContent || ""));
  assert.equal(ui.$("#content .detail-title p").textContent, "1,284 files · 9.6 GB local", "View folder switches to its files as for Audio");
  assert.equal(ui.$('#content [data-action="open"]').textContent, "Open in Finder");
});

test("a Movies & TV library kept as a folder offers no per-title Download", async (t) => {
  const movie = sampleLibrary().movies[0];
  const status = replicaStatus();
  status.volumes = [{ id: "vid", name: "videos", video: true, selected: true, path: "/Users/javi/Arca/videos", ...counted, sync: { state: "synced" } }];
  const ui = await boot(t, { status });
  await until(() => row(ui, "videos"));
  await ui.click(row(ui, "videos"), () => ui.$(".video-page .music-card"));
  await ui.click(`[data-action="video-title"][data-id="${movie.id}"]`, () => ui.$(".video-backdrop h2"));
  const items = ui.$$(".video-backdrop .video-menu .menu-items button").map((el) => el.textContent);
  assert.ok(items.length, "the title still has its menu");
  assert.equal(items.some((text) => /Download|Remove from this device|Cancel download/.test(text)), false, "its files are already here");
});

test("with the hub away a streamed library's row reads Offline on the neutral tile and counts what still plays, and a kept one is unchanged", async (t) => {
  const status = { ...replicaStatus({ aud: "stream", vid: "stream", kep: "keep" }), hubUnavailable: true, downloaded: { vid: 2 } };
  const ui = await boot(t, { status });
  await until(() => row(ui, "videos"));
  assert.equal(row(ui, "videos").querySelector(".meta").textContent, "Offline · 2 downloads to watch · Streams from hub");
  assert.ok(row(ui, "videos").querySelector(".tile").classList.contains("id"), "the neutral tile");
  assert.equal(row(ui, "music").querySelector(".meta").textContent, "Offline · Nothing downloaded · Streams from hub");
  assert.match(row(ui, "videos").getAttribute("aria-label"), /Offline/);
  assert.doesNotMatch(row(ui, "films").textContent, /Offline/, "a kept library keeps its row");
  const online = await boot(t, { status: { ...status, hubUnavailable: false } });
  await until(() => row(online, "videos"));
  assert.match(row(online, "videos").querySelector(".meta").textContent, /^1,284 files · 9.6 GB · Streams from hub$/);
  assert.equal(row(online, "videos").querySelector(".tile").classList.contains("id"), false);
});

test("with the hub away a streamed Movies & TV library shows only its finished downloads, and returns to the full library when the hub answers", async (t) => {
  const library = sampleLibrary();
  const movie = library.movies[0];
  const done = [{ id: movie.id, path: movie.path, hash: movie.hash, size: 10, done: 10, state: "done" }];
  const status = { ...replicaStatus({ vid: "stream" }), hubUnavailable: true, downloaded: { vid: 1 } };
  const ui = await boot(t, { status, downloads: done });
  await until(() => row(ui, "videos"));
  await ui.click(row(ui, "videos"), () => ui.$(".video-page .music-card"));
  assert.equal(ui.$(".video-page .music-caption").textContent, "Offline · showing your downloads");
  assert.deepEqual(ui.$$(".video-page .music-card strong").map((el) => el.textContent), [movie.title]);
  assert.equal(ui.$(".video-page .segmented"), null, "no tabs or sort");
  assert.ok(ui.$(".detail-head .tile").classList.contains("id"));
  ui.w.dispatchEvent(new ui.w.Event("online"));
  await until(() => ui.idle());
  assert.equal(ui.$(".video-page .music-caption").textContent, "Offline · showing your downloads", "a repaint keeps the offline line");
  const empty = await boot(t, { status: { ...status, downloaded: {} } });
  await until(() => row(empty, "videos"));
  await empty.click(row(empty, "videos"), () => empty.$(".video-page .empty"));
  assert.match(empty.$(".video-page .empty").textContent, /Nothing downloaded/);
  const kept = await boot(t, { status: { ...replicaStatus({ vid: "keep" }), hubUnavailable: true }, downloads: done });
  await until(() => row(kept, "videos"));
  await kept.click(row(kept, "videos"), () => kept.$(".video-page .music-card"));
  assert.equal(kept.$(".video-page .music-caption")?.textContent === "Offline · showing your downloads", false, "a kept library plays everything offline");
  assert.ok(kept.$$(".video-page .music-card").length > 1);
  const online = await boot(t, { status: { ...status, hubUnavailable: false }, downloads: done });
  await until(() => row(online, "videos"));
  await online.click(row(online, "videos"), () => online.$(".video-page .music-card"));
  assert.ok(online.$(".video-page .segmented"), "the tabs are back");
  assert.ok(online.$$(".video-page .music-card").length > 1, "the whole library is back");
});
