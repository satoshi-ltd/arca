import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JSDOM } from "jsdom";
import { init } from "../packages/daemon/storage.js";
import { start } from "../packages/daemon/server.js";
import {
  artistGroups,
  artistLetter,
  buildLibrary,
  formatDuration,
  nextRepeat,
  playedItems,
  rememberPlayed,
  searchText,
  shuffleOrder,
} from "../apps/desktop/src/music-library.js";
import { artistLetter as phoneLetter, buildLibrary as buildPhoneLibrary } from "../apps/mobile/src/music-library.js";

const source = (name) =>
  fs.readFileSync(new URL(`../apps/desktop/src/${name}`, import.meta.url), "utf8");
const html = source("index.html");
const script = [
  source("gallery-timeline-layout.js").replace(/export /g, ""),
  source("file-icons.js").replace(/export /g, ""),
  source("music-library.js").replace(/export /g, ""),
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

const COVER = "a".repeat(64);
const track = (path, tags = {}) => ({
  path,
  hash: `hash-${path}`,
  size: 1000,
  title: null,
  artist: null,
  albumArtist: null,
  album: null,
  track: null,
  disc: null,
  year: null,
  genre: null,
  duration: null,
  codec: null,
  cover: null,
  added: null,
  ...tags,
});
const TRACKS = [
  track("Miles Davis/Kind of Blue/02 Freddie Freeloader.mp3", { title: "Freddie Freeloader", artist: "Miles Davis", albumArtist: "Miles Davis", album: "Kind of Blue", track: 2, year: 1959, duration: 586, cover: COVER, added: "2026-01-01T00:00:00.000Z" }),
  track("Miles Davis/Kind of Blue/01 So What.mp3", { title: "So What", artist: "Miles Davis", albumArtist: "Miles Davis", album: "Kind of Blue", track: 1, year: 1959, duration: 562, cover: COVER, added: "2026-01-01T00:00:00.000Z" }),
  track("Coltrane/Blue Train/01 Blue Train.flac", { title: "Blue Train", artist: "John Coltrane", album: "Blue Train", track: 1, duration: 643, added: "2026-03-01T00:00:00.000Z" }),
  track("Loose/untagged.ogg"),
];

async function open(t, { role = "hub", selected = true, folders = ["Music"], manualCovers = false, library = null, storageFails = false, web = false, others = [] } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-desktop-music-"));
  init(home, { port: 0, name: "Casa" });
  const daemon = await start(home, { timer: false });
  const volumes = folders.map((name) => daemon.engine.store.addVolume(name));
  const plain = others.map((name) => daemon.engine.store.addVolume(name));
  for (const item of volumes) daemon.engine.music.mark(item.id);
  const volume = volumes[0];
  const dom = new JSDOM(html, {
    runScripts: "outside-only",
    url: `http://tauri.localhost/#/folders/${volume.id}`,
  });
  const pending = new Set();
  t.after(async () => {
    do {
      await Promise.allSettled([...pending]);
      await new Promise((resolve) => setImmediate(resolve));
    } while (pending.size);
    dom.window.close();
    await daemon.engine.music?.background;
    await daemon.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const w = dom.window;
  const ui = { patch: (value) => value, poll: null, timers: new Map(), observed: new Set(), listeners: {}, emitted: [], edits: [] };
  w.setInterval = (callback, ms) => {
    if (ms === 5000) ui.poll = callback;
    return 0;
  };
  const setTimer = w.setTimeout.bind(w);
  const clearTimer = w.clearTimeout.bind(w);
  let timerId = 0;
  w.setTimeout = (callback, ms, ...rest) => {
    if (ms !== 5000) return setTimer(callback, ms, ...rest);
    const id = `music-${++timerId}`;
    ui.timers.set(id, callback);
    return id;
  };
  w.clearTimeout = (id) => (ui.timers.has(id) ? ui.timers.delete(id) : clearTimer(id));
  const played = [];
  Object.defineProperty(w.HTMLMediaElement.prototype, "paused", {
    configurable: true,
    get() {
      return !this.playing;
    },
  });
  w.HTMLMediaElement.prototype.play = function () {
    this.playing = true;
    played.push(this.getAttribute("src"));
    this.dispatchEvent(new w.Event("play"));
    return Promise.resolve();
  };
  w.HTMLMediaElement.prototype.pause = function () {
    if (!this.playing) return;
    this.playing = false;
    this.dispatchEvent(new w.Event("pause"));
  };
  w.HTMLMediaElement.prototype.load = function () {};
  w.HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  w.HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  ui.metadata = 0;
  Object.defineProperty(w.navigator, "mediaSession", {
    configurable: true,
    value: { metadata: null, playbackState: "none", setActionHandler() {} },
  });
  w.MediaMetadata = class {
    constructor(value) {
      ui.metadata++;
      Object.assign(this, value);
    }
  };
  if (storageFails)
    for (const name of ["getItem", "setItem", "removeItem"])
      w.Storage.prototype[name] = () => {
        throw new w.DOMException("Storage is disabled", "SecurityError");
      };
  w.IntersectionObserver = class {
    constructor(callback) {
      this.callback = callback;
    }
    observe(target) {
      if (manualCovers) ui.observed.add([this, target]);
      else queueMicrotask(() => this.callback([{ isIntersecting: true, target }]));
    }
    unobserve() {}
    disconnect() {}
  };
  ui.reveal = () => {
    const items = [...ui.observed];
    ui.observed.clear();
    for (const [observer, target] of items) observer.callback([{ isIntersecting: true, target }]);
  };
  const routes = [];
  const status = () => {
    const value = daemon.engine.status();
    if (role === "hub") return ui.patch(value);
    return ui.patch({
      ...value,
      role: "replica",
      hub: "http://127.0.0.1:9",
      hubId: "hub-casa",
      hubName: "Casa",
      volumes: value.volumes.map((v) => ({ ...v, selected: selected ? 1 : 0 })),
    });
  };
  let tickets = 0;
  const invoke = async (command, args) => {
    if (command === "bootstrap") return { setup: false, status: status() };
    if (command !== "api") return {};
    routes.push(args.route);
    if (args.route === "/v1/status") {
      if (ui.expired) throw Object.assign(new Error("Unauthorized"), { status: 401 });
      return status();
    }
    if (args.route.startsWith("/v1/music/library?")) {
      const query = new URLSearchParams(args.route.split("?")[1]);
      return library ? library(query.get("volume")) : { version: "v1", indexing: false, tracks: TRACKS };
    }
    if (args.route === "/v1/music/playlist") {
      ui.edits.push(args.body);
      return { path: (args.body.action === "rename" && ui.renamedTo) || args.body.path || `Playlists/${args.body.name}.m3u8`, hash: "edited" };
    }
    if (args.route.startsWith("/v1/music/cover?"))
      return { data: `data:image/jpeg;base64,${new URLSearchParams(args.route.split("?")[1]).get("key").slice(0, 4)}` };
    if (args.route.startsWith("/v1/music/playback?")) {
      const query = new URLSearchParams(args.route.split("?")[1]);
      return { url: `http://127.0.0.1:1/v1/music/media?ticket=${encodeURIComponent(query.get("path"))}${tickets++ ? `&n=${tickets}` : ""}` };
    }
    const response = await fetch(`http://127.0.0.1:${daemon.port}${args.route}`, {
      method: args.method,
      ...(args.body ? { body: JSON.stringify(args.body) } : {}),
      headers: { authorization: `Bearer ${daemon.engine.config.adminToken}` },
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    return data;
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
    w.fetch = (route, init = {}) =>
      track(
        invoke("api", {
          route,
          method: init.method || "GET",
          body: init.body ? JSON.parse(init.body) : null,
        }).then(
          (data) => new Response(JSON.stringify(data), { status: 200 }),
          (error) => new Response(JSON.stringify({ error: error.message }), { status: error.status || 500 }),
        ),
      );
  else
    w.__TAURI__ = {
      core: { invoke: (...args) => track(invoke(...args)) },
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
  ui.command = (command) => ui.listeners["music-command"]?.({ payload: { command } });
  w.eval(`(async()=>{${script}\n})()`);
  const $ = (selector) => w.document.querySelector(selector);
  const $$ = (selector) => [...w.document.querySelectorAll(selector)];
  const idle = () => w.document.body.getAttribute("aria-busy") !== "true";
  const text = (selector) => $(selector)?.textContent.trim();
  const tabs = () => $$('.music-page .segmented[aria-label="Library"] button').map((el) => el.textContent.trim());
  const cards = () => $$(".music-page .music-card strong").map((el) => el.textContent);
  const artists = () => $$(".music-page .music-artist-row strong").map((el) => el.textContent);
  const click = async (selector, ready) => {
    $(selector).click();
    await until(() => ready() && idle());
  };
  return Object.assign(ui, { w, daemon, volume, volumes, plain, routes, played, status, $, $$, idle, text, tabs, cards, artists, click });
}

test("music grouping matches the phone: album keys, untagged names, sort orders and recent additions", () => {
  const library = buildLibrary({
    tracks: [
      ...TRACKS,
      track("Comp/One.mp3", { title: "One", artist: "A", album: "Comp", added: "2026-02-01T00:00:00.000Z" }),
      track("Comp/Two.mp3", { title: "Two", artist: "B", album: "Comp" }),
      track("Disc/CD2/01 Late.mp3", { title: "Late", artist: "C", albumArtist: "C", album: "Disc", disc: 2, track: 1 }),
      track("Disc/CD1/02 Early.mp3", { title: "Early", artist: "C", albumArtist: "C", album: "Disc", disc: 1, track: 2 }),
    ],
  });
  assert.deepEqual(library.albumList.map((album) => album.title), ["Blue Train", "Comp", "Disc", "Kind of Blue", "Loose"]);
  const blue = library.albums.get(library.albumList[3].id);
  assert.deepEqual(blue.tracks.map((item) => item.title), ["So What", "Freddie Freeloader"]);
  assert.equal(blue.artist, "Miles Davis");
  assert.equal(blue.year, 1959);
  assert.equal(blue.duration, 1148);
  assert.equal(blue.cover, COVER);
  assert.equal(library.albumList[1].artist, "Various artists");
  assert.deepEqual(library.albumList[2].tracks.map((item) => item.title), ["Early", "Late"]);
  const loose = library.albumList[4];
  assert.equal(loose.tracks[0].title, "untagged");
  assert.equal(loose.artist, "Unknown artist");
  assert.deepEqual(library.artists.map((artist) => artist.name), ["C", "John Coltrane", "Miles Davis", "Unknown artist", "Various artists"]);
  assert.deepEqual(library.playlists, []);
  assert.deepEqual(library.recent.map((album) => album.title), ["Blue Train", "Comp", "Kind of Blue"]);
  assert.equal(formatDuration(3723), "1:02:03");
  assert.equal(formatDuration(562), "9:22");
  assert.equal(formatDuration(0), "");
  assert.deepEqual(["off", "all", "one"].map(nextRepeat), ["all", "one", "off"]);
  const order = shuffleOrder(5, 3, () => 0);
  assert.equal(order[0], 3);
  assert.deepEqual([...order].sort(), [0, 1, 2, 3, 4]);
  let history = [];
  for (let i = 0; i < 25; i++) history = rememberPlayed(history, { kind: "album", id: `a${i}` });
  history = rememberPlayed(history, { kind: "album", id: "a10" });
  assert.equal(history.length, 20);
  assert.equal(history[0].id, "a10");
  assert.equal(history.filter((entry) => entry.id === "a10").length, 1);
  assert.deepEqual(
    playedItems(library, [{ kind: "playlist", id: "Lists/z.m3u" }, { kind: "album", id: "gone" }, { kind: "album", id: blue.id }]).map(({ kind, item }) => [kind, item.title]),
    [["album", "Kind of Blue"]],
    "only albums and playlists still in the library are listed",
  );
});

test("a music folder opens on its Artists tab; Albums is a grid; Recent falls back to recent additions, then lists what this device played", async (t) => {
  const ui = await open(t);
  const { $, $$, w } = ui;
  await until(() => $(".music-page .music-artist-row") && ui.idle());
  assert.deepEqual(ui.tabs(), ["Artists", "Albums", "Recent"]);
  assert.equal($('.music-page .segmented button[aria-pressed="true"]').textContent.trim(), "Artists");
  assert.deepEqual(ui.artists(), ["John Coltrane", "Miles Davis", "Unknown artist"]);
  await ui.click('[data-action="music-tab"][data-id="albums"]', () => ui.cards().length === 3 && ui.cards()[0] === "Blue Train");
  assert.deepEqual(ui.cards(), ["Blue Train", "Kind of Blue", "Loose"]);
  assert.match(ui.text(".detail-title p"), /^4 tracks · 3 albums · /);
  assert.equal(ui.text('.heading-actions [data-action="music-mode"]'), "View folder");
  assert.ok($(".heading-actions .folder-actions-menu"), "the hub keeps its Folder actions menu");
  assert.equal($(".music-page input"), null, "the search field opens only on request");
  await until(() => $(".music-card .music-cover img"));
  assert.equal($(".music-card .music-cover img").getAttribute("src"), "data:image/jpeg;base64,aaaa");
  assert.ok(ui.routes.some((route) => route.startsWith("/v1/music/cover?") && route.includes(`key=${COVER}`) && route.endsWith("size=small")));

  await ui.click('[data-action="music-tab"][data-id="recent"]', () => $(".music-caption"));
  assert.match(ui.text(".music-caption"), /^Recently added/);
  assert.deepEqual(ui.cards(), ["Blue Train", "Kind of Blue"]);

  await ui.click('[data-action="music-tab"][data-id="albums"]', () => ui.cards().length === 3);
  await ui.click('.music-card[data-action="music-album"]:nth-child(2)', () => $(".music-head"));
  assert.equal(ui.text(".music-head h2"), "Kind of Blue");
  assert.equal(ui.text(".music-head-info p"), "Miles Davis · 1959 · 2 tracks · 19:08");
  assert.equal(ui.text('.music-head [data-action="music-back"]'), "Albums");
  assert.deepEqual($$(".music-head .heading-actions button").map((el) => el.textContent.trim()), ["Play", "Shuffle"]);
  const rows = () => $$(".music-tracks .music-track[data-path]");
  assert.deepEqual(
    rows().map((row) => [...row.querySelector(".music-track-play").children].filter((el) => el.className !== "music-track-playing").map((el) => el.textContent.trim())),
    [["1", "So What", "Miles Davis", "9:22"], ["2", "Freddie Freeloader", "Miles Davis", "9:46"]],
  );
  assert.ok(!$(".music-tracks").classList.contains("music-with-album"), "an album's table keeps its four columns");
  assert.equal($("#music-player").hidden, true);

  rows()[1].querySelector(".music-track-play").click();
  await until(() => !$("#music-player").hidden && ui.played.length === 1 && ui.idle());
  assert.equal(ui.played[0], `http://127.0.0.1:1/v1/music/media?ticket=${encodeURIComponent("Miles Davis/Kind of Blue/02 Freddie Freeloader.mp3")}`);
  assert.ok(ui.routes.some((route) => route.startsWith("/v1/music/playback?") && route.includes("hash=hash-Miles")));
  assert.deepEqual(rows().map((row) => row.classList.contains("playing")), [false, true]);
  assert.equal(rows()[1].getAttribute("aria-current"), "true");
  assert.equal(ui.text(".music-player-track strong"), "Freddie Freeloader");
  assert.equal(ui.text(".music-player-track p"), "Miles Davis · Kind of Blue");
  assert.deepEqual(
    $$("#music-player .music-player-controls button").map((el) => el.getAttribute("aria-label")),
    ["Shuffle", "Previous", "Pause", "Next", "Repeat"],
  );
  assert.equal($('#music-player [data-player="next"]').disabled, true, "the last track has no next without repeat");
  assert.equal($('#music-player input[aria-label="Seek"]').type, "range");
  assert.equal($('#music-player input[aria-label="Volume"]').type, "range");
  assert.equal(ui.text('[data-music-time="total"]'), "9:46");
  const audio = $("audio");
  audio.currentTime = 65;
  audio.dispatchEvent(new w.Event("timeupdate"));
  assert.equal(ui.text('[data-music-time="elapsed"]'), "1:05");

  $('#music-player [data-player="repeat"]').click();
  assert.equal($('#music-player [data-player="repeat"]').getAttribute("aria-label"), "Repeat all");
  assert.equal($('#music-player [data-player="repeat"]').getAttribute("aria-pressed"), "true");
  $('#music-player [data-player="next"]').click();
  await until(() => ui.played.length === 2 && ui.idle());
  assert.equal(ui.text(".music-player-track strong"), "So What", "repeat all wraps to the first track");
  assert.deepEqual(rows().map((row) => row.classList.contains("playing")), [true, false]);
  $('#music-player [data-player="toggle"]').click();
  assert.equal(audio.paused, true);
  assert.equal($('#music-player [data-player="toggle"]').getAttribute("aria-label"), "Play");

  await ui.click('[data-action="music-back"]', () => ui.cards().length === 3);
  await ui.click('[data-action="music-tab"][data-id="recent"]', () => ui.tabs().length && $('.music-page .segmented button[aria-pressed="true"]').textContent.trim() === "Recent");
  assert.equal($(".music-caption"), null);
  assert.deepEqual(ui.cards(), ["Kind of Blue"]);
  const saved = JSON.parse(w.localStorage.getItem(`arca-music-recent:${ui.status().id}:${ui.volume.id}`));
  assert.deepEqual(saved.map((entry) => entry.kind), ["album"]);
  assert.ok(!ui.routes.some((route) => /recent/i.test(route) && route.startsWith("/v1/music")), "the history never reaches the hub");

  await ui.click('[data-action="back-folders"]', () => $(".folder-card"));
  assert.equal($("#music-mini").hidden, false, "the player survives navigation in the sidebar");
  assert.equal(ui.text(".music-player-track strong"), "So What");
  $('[data-view="devices"]').click();
  await until(() => $('[data-view="devices"]').classList.contains("active") && ui.idle());
  assert.equal($("#music-mini").hidden, false);
});

test("Artists open the artist's albums and then the album, and an album plays shuffled; Recent skips older playlist entries", async (t) => {
  const ui = await open(t);
  const { $, $$, w } = ui;
  await until(() => $(".music-page .music-artist-row") && ui.idle());
  assert.deepEqual(ui.artists(), ["John Coltrane", "Miles Davis", "Unknown artist"]);
  assert.deepEqual($$(".music-artist-row > span:nth-child(2) > span").map((el) => el.textContent), ["1 album · 1 track", "1 album · 2 tracks", "1 album · 1 track"]);
  await ui.click('.music-artist-row[data-id*="miles davis"]', () => $('.music-head [data-action="music-shuffle-artist"]'));
  assert.equal(ui.text(".music-head h2"), "Miles Davis");
  assert.equal(ui.text(".music-head-info p"), "1 album · 2 tracks");
  assert.equal(ui.text('.music-head [data-action="music-back"]'), "Artists");
  assert.deepEqual([...$(".music-head > .music-cover").classList].filter((name) => name !== "has-cover"), ["music-cover", "large"]);
  assert.deepEqual(ui.cards(), ["Kind of Blue"]);
  await ui.click('.music-card[data-action="music-album"]', () => $('.music-head [data-action="music-play"]'));
  assert.equal(ui.text('.music-head [data-action="music-back"]'), "Miles Davis");
  await ui.click('[data-action="music-back"]', () => $('.music-head [data-action="music-shuffle-artist"]'));
  await ui.click('[data-action="music-back"]', () => $(".music-artist-row") && !$(".music-head"));

  await ui.click('.music-artist-row[data-id*="miles davis"]', () => $('.music-head [data-action="music-shuffle-artist"]'));
  await ui.click('.music-card[data-action="music-album"]', () => $('.music-head [data-action="music-play"]'));
  w.Math.random = () => 0.99;
  $('[data-action="music-shuffle"]').click();
  await until(() => ui.played.length === 1 && ui.idle());
  assert.equal(ui.text(".music-player-track strong"), "Freddie Freeloader", "Shuffle starts from a random track of the album");
  assert.equal($('#music-player [data-player="shuffle"]').getAttribute("aria-pressed"), "true");
  const key = `arca-music-recent:${ui.status().id}:${ui.volume.id}`;
  const saved = JSON.parse(w.localStorage.getItem(key));
  assert.deepEqual(saved.map((entry) => entry.kind), ["album"]);
  w.localStorage.setItem(key, JSON.stringify([{ kind: "playlist", id: "Lists/road.m3u8" }, ...saved]));
  await ui.click('[data-action="music-tab"][data-id="recent"]', () => ui.cards().length === 1 && !$(".music-caption"));
  assert.deepEqual(ui.cards(), ["Kind of Blue"]);
});

test("View folder switches to Files and Recent with stats and the side column, and Library returns", async (t) => {
  const ui = await open(t);
  const { $ } = ui;
  await until(() => $(".music-page .music-artist-row") && ui.idle());
  await ui.click('[data-action="music-mode"]', () => $(".folder-stats") && $(".detail-side"));
  assert.equal($(".music-page"), null);
  assert.ok($('.segmented[aria-label="Folder content"]'));
  assert.equal(ui.text('.heading-actions [data-action="music-mode"]'), "Library");
  assert.ok($(".heading-actions .folder-actions-menu"));
  await ui.click('[data-action="music-mode"]', () => $(".music-page .music-artist-row"));
  assert.equal($('.music-page .segmented button[aria-pressed="true"]').textContent.trim(), "Artists");
  assert.equal(ui.text('.heading-actions [data-action="music-mode"]'), "View folder");
});

test("a desktop replica draws the same library without Folder actions and plays from its own daemon; an unselected folder stays files", async (t) => {
  const ui = await open(t, { role: "replica" });
  const { $ } = ui;
  await until(() => $(".music-page .music-artist-row") && ui.idle());
  assert.equal($(".folder-actions-menu"), null);
  assert.equal(ui.text('.heading-actions [data-action="music-mode"]'), "View folder");
  await ui.click('[data-action="music-tab"][data-id="albums"]', () => $('.music-card[data-action="music-album"]'));
  await ui.click('.music-card[data-action="music-album"]:nth-child(2)', () => $(".music-head"));
  $('[data-action="music-play"]').click();
  await until(() => ui.played.length === 1 && ui.idle());
  assert.equal(ui.text(".music-player-track strong"), "So What");
  assert.ok(ui.routes.some((route) => route.startsWith("/v1/music/playback?")));
  const saved = ui.w.localStorage.getItem(`arca-music-recent:hub-casa:${ui.volume.id}`);
  assert.ok(saved, "a replica keys its history by hub and folder");

  const other = await open(t, { role: "replica", selected: false });
  await until(() => other.$(".folder-stats") && other.idle());
  assert.equal(other.$(".music-page"), null);
  assert.equal(other.$('[data-action="music-mode"]'), null);
});

async function playAlbum(ui, row = 0) {
  if (!ui.$('.music-card[data-action="music-album"]'))
    await ui.click('[data-action="music-tab"][data-id="albums"]', () => ui.$('.music-card[data-action="music-album"]'));
  await ui.click('.music-card[data-action="music-album"]:nth-child(2)', () => ui.$(".music-head"));
  const before = ui.played.length;
  ui.$$(".music-tracks .music-track[data-path] .music-track-play")[row].click();
  await until(() => ui.played.length === before + 1 && ui.idle());
}
const grid = (ui) => until(() => ui.$(".music-page .music-artist-row") && ui.idle());

test("desktop and phone group the same rows into the same albums, artists, track order and recent additions", () => {
  const rows = [
    ...TRACKS,
    track("Comp/One.mp3", { title: "One", artist: "A", album: "Comp", added: "2026-02-01T00:00:00.000Z" }),
    track("Comp/Two.mp3", { title: "Two", artist: "B", album: "Comp", added: "2026-02-03T00:00:00.000Z" }),
    track("Disc/CD2/01 Late.mp3", { title: "Late", artist: "C", albumArtist: "C", album: "Disc", disc: 2, track: 1 }),
    track("Disc/CD1/02 Early.mp3", { title: "Early", artist: "C", albumArtist: "C", album: "Disc", disc: 1, track: 2 }),
    track("Disc/CD1/01 First.mp3", { title: "First", artist: "C", albumArtist: "c ", album: "disc", disc: 1, track: 1 }),
    track("Series/Album 10/1.mp3", { title: "Ten", artist: "Ärzte", album: "Album 10", year: 2010, cover: "1".repeat(64), added: "2026-04-01T00:00:00.000Z" }),
    track("Series/Album 2/1.mp3", { title: "Two", artist: "ärzte", album: "Album 2", year: 2002, cover: "2".repeat(64) }),
    track("Digits/1.mp3", { title: "Changes", artist: "2Pac", album: "Hits" }),
    track("Same/X/1.mp3", { title: "X one", artist: "Zed", album: "Same" }),
    track("Same/Y/1.mp3", { title: "Y one", artist: "Amy", album: "Same" }),
    track("root.flac", { title: "Root" }),
    track("Untitled/b 2.mp3"),
    track("Untitled/b 10.mp3"),
  ];
  const raw = { tracks: rows };
  const desk = buildLibrary(raw);
  const phone = buildPhoneLibrary([
    { id: "music", library: raw, present: new Map(rows.map((row) => [row.path, row.hash])) },
  ]);
  const phoneTrack = (id) => phone.tracks.get(id);
  const phoneAlbums = phone.albumOrder.map((id) => phone.albums.get(id));
  assert.deepEqual(
    desk.albumList.map((album) => [album.title, album.artist, album.year, album.cover, album.duration]),
    phoneAlbums.map((album) => [album.title, album.artist, album.year, album.cover, album.duration]),
  );
  assert.deepEqual(
    desk.albumList.map((album) => album.tracks.map((item) => [item.path, item.title, item.artist])),
    phoneAlbums.map((album) => album.tracks.map((id) => [phoneTrack(id).path, phoneTrack(id).title, phoneTrack(id).artist])),
  );
  assert.deepEqual(
    desk.artists.map((artist) => [artist.letter, artist.name, artist.cover, artist.albums.map((album) => album.title)]),
    phone.artists.map((artist) => [artist.letter, artist.name, artist.cover, artist.albums.map((id) => phone.albums.get(id).title)]),
  );
  assert.equal(desk.artists.find((artist) => artist.letter === "A" && artist.albums.length === 2).cover, "1".repeat(64), "the newest album's cover");
  assert.equal(desk.artists.at(-1).name, "2Pac");
  assert.deepEqual(
    desk.recent.map((album) => album.title),
    phone.recent.map((id) => phone.albums.get(id).title),
  );
});

test("the player stops, empties and clears the media session when the hub changes or its folder is no longer a library", async (t) => {
  const ui = await open(t);
  const { $, w } = ui;
  await grid(ui);
  await playAlbum(ui);
  assert.equal($("#music-player").hidden, false);
  assert.equal(w.navigator.mediaSession.metadata.title, "So What");
  ui.patch = (value) => ({ ...value, hubId: "another-hub" });
  await ui.poll();
  await until(() => $("#music-player").hidden && ui.idle());
  assert.equal($("audio").getAttribute("src"), null);
  assert.equal($("audio").paused, true);
  assert.equal(w.navigator.mediaSession.metadata, null);
  assert.equal(w.navigator.mediaSession.playbackState, "none");

  ui.patch = (value) => value;
  await ui.poll();
  $(".music-tracks .music-track[data-path] .music-track-play").click();
  await until(() => ui.played.length === 2 && !$("#music-player").hidden && ui.idle());
  ui.patch = (value) => ({ ...value, volumes: value.volumes.map((v) => ({ ...v, music: false })) });
  await ui.poll();
  await until(() => $("#music-player").hidden && ui.idle());
  assert.equal($("audio").getAttribute("src"), null);
});

test("an expired desktop ticket is renewed once and playback resumes where it stopped; a second failure explains it", async (t) => {
  const ui = await open(t);
  const { $, w } = ui;
  await grid(ui);
  await playAlbum(ui);
  const audio = $("audio");
  Object.defineProperty(audio, "readyState", { configurable: true, get: () => 4 });
  audio.currentTime = 120;
  Object.defineProperty(audio, "error", { configurable: true, get: () => ({ code: 2 }) });
  audio.dispatchEvent(new w.Event("error"));
  await until(() => ui.played.length === 2 && ui.idle());
  assert.notEqual(ui.played[1], ui.played[0], "a new ticket");
  audio.currentTime = 0;
  audio.dispatchEvent(new w.Event("loadedmetadata"));
  assert.equal(audio.currentTime, 120);
  assert.equal($(".notice-card"), null);
  Object.defineProperty(audio, "error", { configurable: true, get: () => ({ code: 4 }) });
  audio.dispatchEvent(new w.Event("error"));
  await until(() => /format may not be supported/.test(ui.text("#notice") || "") && ui.idle());
  assert.equal(ui.played.length, 2);
  assert.equal($('#music-player [data-player="toggle"]').getAttribute("aria-label"), "Play");
});

test("Next, Previous and a finished track keep keyboard focus on the same player control", async (t) => {
  const ui = await open(t);
  const { $, w } = ui;
  await grid(ui);
  await playAlbum(ui);
  const next = $('#music-player [data-player="next"]');
  next.focus();
  next.click();
  await until(() => ui.played.length === 2 && ui.idle());
  assert.equal(ui.text(".music-player-track strong"), "Freddie Freeloader");
  assert.equal(w.document.activeElement, next);
  $('#music-player [data-player="repeat"]').click();
  const toggle = $('#music-player [data-player="toggle"]');
  toggle.focus();
  $("audio").dispatchEvent(new w.Event("ended"));
  await until(() => ui.played.length === 3 && ui.idle());
  assert.equal(ui.text(".music-player-track strong"), "So What");
  assert.equal(w.document.activeElement, toggle);
  const previous = $('#music-player [data-player="previous"]');
  previous.focus();
  previous.click();
  await until(() => ui.played.length === 4 && ui.idle());
  assert.equal(ui.text(".music-player-track strong"), "Freddie Freeloader", "Previous wraps with repeat all");
  assert.equal(w.document.activeElement, previous);
});

test("each indexing library keeps its own refresh timer, also after a failed refresh", async (t) => {
  let calls = 0;
  const ui = await open(t, {
    folders: ["Music", "Records"],
    library: () => {
      calls++;
      if (calls === 3) throw new Error("Hub unavailable");
      return { version: "v1", indexing: true, tracks: TRACKS };
    },
  });
  await grid(ui);
  assert.equal(ui.timers.size, 1);
  ui.w.location.hash = `#/folders/${ui.volumes[1].id}`;
  await until(() => ui.text(".detail-title h1") === "Records" && ui.$(".music-page .music-artist-row") && ui.idle());
  assert.equal(ui.timers.size, 2, "opening another indexing library keeps the first one's timer");
  const [[id, run]] = [...ui.timers].slice(-1);
  ui.timers.delete(id);
  run();
  await until(() => calls === 3 && ui.idle());
  await until(() => ui.timers.size === 2);
});

test("a refreshed library updates the queue: tracks keep their new hash and removed ones leave", async (t) => {
  let version = 1;
  const extra = track("Miles Davis/Kind of Blue/03 Blue in Green.mp3", { title: "Blue in Green", artist: "Miles Davis", albumArtist: "Miles Davis", album: "Kind of Blue", track: 3, duration: 337 });
  const ui = await open(t, {
    library: () =>
      version === 1
        ? { version: "v1", indexing: false, tracks: [...TRACKS, extra] }
        : {
            version: "v2",
            indexing: false,
            tracks: TRACKS.map((row) => (row.title === "Freddie Freeloader" ? { ...row, hash: "hash-retagged" } : row)),
          },
  });
  const { $ } = ui;
  await grid(ui);
  await playAlbum(ui);
  assert.equal($('#music-player [data-player="next"]').disabled, false);
  version = 2;
  await ui.click('[data-action="back-folders"]', () => $(".folder-card"));
  await ui.click('.folder-card[data-action="folder-detail"]', () => $(".music-page .music-artist-row"));
  await until(() => ui.routes.filter((route) => route.startsWith("/v1/music/library?")).length === 2 && ui.idle());
  $('#music-player [data-player="next"]').click();
  await until(() => ui.played.length === 2 && ui.idle());
  assert.match(ui.routes.filter((route) => route.startsWith("/v1/music/playback?")).at(-1), /hash=hash-retagged/);
  assert.equal($('#music-player [data-player="next"]').disabled, true, "the removed third track left the queue");
});

test("the library and player work when this browser refuses local storage", async (t) => {
  const ui = await open(t, { storageFails: true });
  const { $, w } = ui;
  await grid(ui);
  await ui.click('[data-action="music-tab"][data-id="recent"]', () => $(".music-caption"));
  await ui.click('[data-action="music-tab"][data-id="albums"]', () => ui.cards().length === 3);
  await playAlbum(ui);
  assert.equal($("#music-player").hidden, false);
  const level = $('#music-player [data-player="volume"]');
  level.value = "0.3";
  level.dispatchEvent(new w.Event("input", { bubbles: true }));
  assert.equal($("audio").volume, 0.3);
  await ui.click('[data-action="music-back"]', () => ui.cards().length === 3);
  await ui.click('[data-action="music-tab"][data-id="recent"]', () => $(".music-caption"));
});

test("only the playing track's cover rebuilds the media session metadata", async (t) => {
  const rows = TRACKS.map((row) => (row.title === "Blue Train" ? { ...row, cover: "b".repeat(64) } : row));
  const ui = await open(t, { manualCovers: true, library: () => ({ version: "v1", indexing: false, tracks: rows }) });
  await grid(ui);
  await playAlbum(ui);
  const built = ui.metadata;
  await ui.click('[data-action="music-back"]', () => ui.cards().length === 3);
  const before = ui.routes.length;
  ui.reveal();
  await until(() => ui.$$(".music-card .music-cover img").length === 2 && ui.idle());
  const covers = ui.routes.slice(before).filter((route) => route.startsWith("/v1/music/cover?"));
  assert.ok(covers.some((route) => route.includes("b".repeat(64))));
  assert.equal(ui.metadata - built, covers.filter((route) => route.includes(COVER)).length);
});

test("an erased or reset device stops the player when it returns to onboarding", async (t) => {
  const ui = await open(t);
  await grid(ui);
  await playAlbum(ui);
  ui.patch = (value) => ({ ...value, needsSetup: true });
  await ui.poll();
  await until(() => ui.$("#music-player").hidden);
  assert.equal(ui.$("audio").getAttribute("src"), null);
});

test("the web admin plays a session URL and stops the player when its session ends", async (t) => {
  const ui = await open(t, { web: true });
  await grid(ui);
  await playAlbum(ui);
  assert.match(ui.played[0], /^\/v1\/music\/media\?volume=/);
  assert.ok(!ui.routes.some((route) => route.startsWith("/v1/music/playback?")), "the browser needs no ticket");
  ui.expired = true;
  await ui.poll();
  await until(() => ui.$("#music-player").hidden);
  assert.equal(ui.$("audio").getAttribute("src"), null);
});

test("a renewed track that fails again before its metadata never seeks the next track, and an error while a ticket loads is ignored", async (t) => {
  const ui = await open(t);
  const { $, w } = ui;
  await grid(ui);
  await playAlbum(ui);
  const audio = $("audio");
  let ready = 4;
  Object.defineProperty(audio, "readyState", { configurable: true, get: () => ready });
  const fail = (code) => {
    Object.defineProperty(audio, "error", { configurable: true, get: () => ({ code }) });
    audio.dispatchEvent(new w.Event("error"));
  };
  audio.currentTime = 95;
  fail(2);
  await until(() => ui.played.length === 2 && ui.idle());
  ready = 0;
  audio.currentTime = 0;
  fail(2);
  await until(() => /interrupted/.test(ui.text("#notice") || "") && ui.idle());
  const tickets = () => ui.routes.filter((route) => route.startsWith("/v1/music/playback?")).length;
  const before = tickets();
  $('#music-player [data-player="next"]').click();
  fail(2);
  await until(() => ui.played.length === 3 && ui.idle());
  assert.equal(tickets(), before + 1, "an error from the previous source during the ticket wait renews nothing");
  assert.equal(ui.text(".music-player-track strong"), "Freddie Freeloader");
  audio.dispatchEvent(new w.Event("loadedmetadata"));
  assert.equal(audio.currentTime, 0, "the next track starts at the beginning");
});

test("a refreshed library updates the playing track's title and media session", async (t) => {
  let tagged = false;
  const ui = await open(t, {
    library: () => ({
      version: tagged ? "v2" : "v1",
      indexing: !tagged,
      tracks: TRACKS.map((row) => (row.title === "So What" && !tagged ? { ...row, title: null } : row)),
    }),
  });
  const { $, w } = ui;
  await grid(ui);
  await playAlbum(ui);
  assert.equal(ui.text(".music-player-track strong"), "01 So What");
  tagged = true;
  const [[id, run]] = [...ui.timers];
  ui.timers.delete(id);
  run();
  await until(() => ui.text(".music-player-track strong") === "So What" && ui.idle());
  assert.equal(w.navigator.mediaSession.metadata.title, "So What");
});

test("Play waits for a library read already in flight after the caches were cleared", async (t) => {
  let gate = null;
  const ui = await open(t, {
    library: () => gate?.promise || { version: "v1", indexing: true, tracks: TRACKS },
  });
  const { $ } = ui;
  await grid(ui);
  await playAlbum(ui);
  ui.patch = (value) => ({ ...value, hubId: "another-hub" });
  await ui.poll();
  await until(() => $("#music-player").hidden && ui.idle());
  ui.patch = (value) => value;
  await ui.poll();
  let release = null;
  gate = { promise: new Promise((resolve) => (release = resolve)) };
  const [[id, run]] = [...ui.timers];
  ui.timers.delete(id);
  run();
  $(".music-tracks .music-track[data-path] .music-track-play").click();
  await new Promise((resolve) => setTimeout(resolve, 30));
  release({ version: "v1", indexing: false, tracks: TRACKS });
  await until(() => ui.played.length === 2 && !$("#music-player").hidden && ui.idle());
  assert.equal(ui.text(".music-player-track strong"), "So What");
});

test("Play after a failure before the metadata loaded resumes where the track last played", async (t) => {
  const ui = await open(t);
  const { $, w } = ui;
  await grid(ui);
  await playAlbum(ui);
  const audio = $("audio");
  let ready = 4;
  Object.defineProperty(audio, "readyState", { configurable: true, get: () => ready });
  const fail = () => {
    Object.defineProperty(audio, "error", { configurable: true, get: () => ({ code: 2 }) });
    audio.dispatchEvent(new w.Event("error"));
  };
  audio.currentTime = 95;
  fail();
  await until(() => ui.played.length === 2 && ui.idle());
  ready = 0;
  audio.currentTime = 0;
  audio.playing = false;
  fail();
  await until(() => /interrupted/.test(ui.text("#notice") || "") && ui.idle());
  $('#music-player [data-player="toggle"]').click();
  await until(() => ui.played.length === 3 && ui.idle());
  audio.dispatchEvent(new w.Event("loadedmetadata"));
  assert.equal(audio.currentTime, 95);
});

test("every album tile and the album header share one fixed cover size: 160px, 120px under 760px", () => {
  const css = source("style.css");
  assert.match(source("tokens.css"), /--detail-tile: 40px;/);
  const rule = (selector) => {
    const start = css.indexOf(`\n${selector} {`);
    return start < 0 ? "" : css.slice(start, css.indexOf("}", start));
  };
  assert.match(rule(".music-page"), /--music-tile: calc\(var\(--detail-tile\) \* 4\);/);
  assert.match(rule(".music-grid"), /grid-template-columns: repeat\(auto-fill, var\(--music-tile\)\);/);
  assert.match(rule(".music-grid"), /justify-content: start;/);
  assert.match(rule(".music-head > .music-cover"), /width: var\(--music-tile\);/);
  assert.match(rule(".music-card .music-cover"), /margin-bottom/);
  const narrow = css.slice(css.lastIndexOf("@media (max-width: 760px)"));
  assert.match(narrow, /\.music-page \{\s*--music-tile: calc\(var\(--detail-tile\) \* 3\);/);
  assert.doesNotMatch(css, /\.music-grid \{[^}]*minmax/);
});

test("artists sort into letter groups with # last, and an artist's art is its newest album with a cover", () => {
  const key = (n) => String(n).repeat(64);
  const evora = (album, year, cover) =>
    track(`Evora/${album}/1.mp3`, { title: album, artist: "Évora", albumArtist: "Évora", album, year, cover });
  const library = buildLibrary({
    tracks: [
      evora("Old", 1990, key(1)),
      evora("New", 2004, key(2)),
      evora("Bare", 2010),
      evora("Undated", undefined, key(3)),
      evora("Same", 1990, key(1)),
      track("Pac/1.mp3", { title: "Changes", artist: "2Pac", album: "Hits" }),
      track("Kino/1.mp3", { title: "Gruppa", artist: "Кино", album: "Gruppa krovi" }),
      track("Abba/1.mp3", { title: "Gold", artist: "abba", album: "Gold", cover: key(4) }),
      track("Zappa/1.mp3", { title: "Peaches", artist: "Zappa", album: "Hot Rats" }),
      track("Oy/1.mp3", { title: "Link", artist: "Øystein Sevåg", album: "Link" }),
    ],
  });
  assert.deepEqual(
    library.artists.map((artist) => [artist.letter, artist.name]),
    [["A", "abba"], ["E", "Évora"], ["O", "Øystein Sevåg"], ["Z", "Zappa"], ["#", "2Pac"], ["#", "Кино"]],
  );
  const names = ["Øystein", "Łukasz", "Đorđe", "Ðavid", "Æther", "œuvre", "Þór", "ßtar", "ﬁfty", "Ａｂｃ", "İlhan", "ıvan", "Ärzte", "2Pac", "Кино", ""];
  const letters = ["O", "L", "D", "D", "A", "O", "T", "S", "F", "A", "I", "I", "A", "#", "#", "#"];
  assert.deepEqual(names.map(artistLetter), letters, "letters without a decomposition and compatibility forms still find their letter");
  assert.deepEqual(names.map(phoneLetter), letters, "the phone files them under the same letters");
  const art = library.artists[1];
  assert.equal(art.cover, key(2), "the newest dated album with a cover; one without a year counts as oldest");
  assert.deepEqual(art.covers, [key(2), key(1), key(3)], "distinct covers, newest first");
  assert.deepEqual(
    art.albums.map((album) => album.title),
    ["Old", "Same", "New", "Bare", "Undated"],
    "the artist page keeps its album order",
  );
  assert.deepEqual(
    artistGroups(library.artists).map((group) => [group.letter, group.artists.length]),
    [["A", 1], ["E", 1], ["O", 1], ["Z", 1], ["#", 2]],
  );
});

test("Artists is an A–Z index with # last, track counts and a strip of the next five covers, 120 rows at a time", async (t) => {
  const key = (n) => n.toString(16).padStart(64, "0");
  const bill = Array.from({ length: 7 }, (_, index) =>
    track(`Bill/${1961 + index}/1.mp3`, { title: `Take ${index}`, artist: "Bill Evans", albumArtist: "Bill Evans", album: `Album ${1961 + index}`, year: 1961 + index, cover: key(1961 + index) }),
  );
  const zebras = Array.from({ length: 117 }, (_, index) => {
    const n = String(index + 1).padStart(3, "0");
    return track(`Zebra/${n}/1.mp3`, { title: `Z ${n}`, artist: `Zebra ${n}`, album: `Zebra ${n}` });
  });
  const ui = await open(t, {
    library: () => ({
      version: "v1",
      indexing: false,
      tracks: [
        ...bill,
        track("Chet/1.mp3", { title: "My Funny Valentine", artist: "Chet Baker", album: "Sings", cover: key(1) }),
        track("Pac/1.mp3", { title: "Changes", artist: "2Pac", album: "Hits" }),
        track("Arzte/1.mp3", { title: "Schrei nach Liebe", artist: "Ärzte", album: "Bestie" }),
        ...zebras,
      ],
    }),
  });
  const { $, $$ } = ui;
  await until(() => $(".music-page .music-artist-row") && ui.idle());
  const letters = () => $$(".music-view .section-label").map((el) => el.textContent);
  assert.deepEqual(letters(), ["A", "B", "C", "Z"]);
  assert.equal(ui.artists().length, 120);
  assert.deepEqual(ui.artists().slice(0, 4), ["Ärzte", "Bill Evans", "Chet Baker", "Zebra 001"]);
  assert.equal($(".music-view .music-grid"), null);
  const row = (name) => $(`.music-artist-row[data-id*="${name}"]`);
  const keys = (el) => [...el.querySelectorAll(".music-cover")].map((cover) => new URLSearchParams(cover.dataset.musicCover).get("key"));
  assert.equal(row("bill evans").children[1].lastElementChild.textContent, "7 albums · 7 tracks");
  assert.deepEqual(keys(row("bill evans")), [1967, 1966, 1965, 1964, 1963, 1962].map(key), "the newest cover, then the next five");
  assert.equal(row("bill evans").querySelector(".music-artist-albums").getAttribute("aria-hidden"), "true");
  assert.equal(row("bill evans").querySelector(".music-artist-albums svg, .music-artist-albums [data-icon]"), null, "strip covers carry no glyph");
  assert.equal(row("chet baker").querySelector(".music-artist-albums").children.length, 0);
  await ui.click('[data-action="music-more"]', () => letters().length === 5);
  assert.deepEqual(letters(), ["A", "B", "C", "Z", "#"]);
  assert.deepEqual(ui.artists().slice(-2), ["Zebra 117", "2Pac"]);
  assert.equal(row("2pac").querySelector(".music-cover").dataset.musicCover, undefined);
  assert.equal($('[data-action="music-more"]'), null);
});

test("a focused row at the top or bottom of a rounded card keeps its focus ring inside the card's corners", () => {
  const css = source("style.css");
  assert.match(css, /\n\.history-group \{[^}]*border-radius: var\(--r-card\);\s*overflow: hidden;/);
  assert.match(css, /\n\.history-group > :first-child:focus-visible \{\s*border-top-left-radius: calc\(var\(--r-card\) - 1px\);\s*border-top-right-radius: calc\(var\(--r-card\) - 1px\);/);
  assert.match(css, /\n\.history-group > :last-child:focus-visible \{\s*border-bottom-left-radius: calc\(var\(--r-card\) - 1px\);\s*border-bottom-right-radius: calc\(var\(--r-card\) - 1px\);/);
  assert.match(css, /\n\.music-row:focus-visible \{\s*outline-offset: -2px;/, "the picker's rows draw their ring inside, where the card clips");
});

test("the player bar opens the playing album from its cover, title and album name, and the artist from its name", async (t) => {
  const ui = await open(t, { folders: ["Music", "Records"] });
  const { $, $$, w } = ui;
  await grid(ui);
  await playAlbum(ui, 0);
  const title = $("#music-player .music-player-title");
  const [artist, album] = $$("#music-player .music-player-link");
  assert.equal(ui.text(".music-player-track strong"), "So What");
  assert.equal(ui.text(".music-player-track p"), "Miles Davis · Kind of Blue");
  assert.equal(title.getAttribute("aria-label"), "So What, open Kind of Blue");
  assert.equal(title.dataset.tooltip, "Open Kind of Blue");
  assert.deepEqual([artist.textContent, artist.dataset.tooltip, artist.dataset.player], ["Miles Davis", "Open Miles Davis", "artist"]);
  assert.deepEqual([album.textContent, album.dataset.tooltip, album.dataset.player], ["Kind of Blue", "Open Kind of Blue", "show"]);
  const cover = $("#music-player .music-player-cover");
  assert.deepEqual([cover.dataset.player, cover.getAttribute("tabindex"), cover.getAttribute("aria-hidden")], ["show", "-1", "true"], "the cover repeats the title's action for the pointer only");
  const away = async () => {
    w.location.hash = `#/folders/${ui.volumes[1].id}`;
    await until(() => ui.text(".detail-title h1") === "Records" && ui.idle());
  };
  await away();
  artist.click();
  await until(() => ui.text(".music-head h2") === "Miles Davis" && ui.idle());
  assert.equal(ui.text(".detail-title h1"), "Music");
  assert.equal(ui.text('.music-head [data-action="music-back"]'), "Artists");
  assert.equal(w.document.activeElement, $('#music-player [data-player="toggle"]'), "focus moves to the bar's Play/Pause");
  album.click();
  await until(() => ui.text(".music-head h2") === "Kind of Blue" && ui.idle());
  assert.equal(ui.text('.music-head [data-action="music-back"]'), "Albums");
  await away();
  title.click();
  await until(() => ui.text(".music-head h2") === "Kind of Blue" && ui.text(".detail-title h1") === "Music" && ui.idle());
  await away();
  cover.click();
  await until(() => ui.text(".music-head h2") === "Kind of Blue" && ui.text(".detail-title h1") === "Music" && ui.idle());
  $('#music-player [data-player="next"]').click();
  await until(() => ui.played.length === 2 && ui.idle());
  assert.equal($("#music-player .music-player-title"), title, "the bar is patched in place");
  assert.equal(title.getAttribute("aria-label"), "Freddie Freeloader, open Kind of Blue");
});

test("an artist name with no page of its own opens the album artist's page", async (t) => {
  const ui = await open(t, {
    library: () => ({
      version: "v1",
      indexing: false,
      tracks: [track("Hits/01 One.mp3", { title: "One", artist: "Solo Act", albumArtist: "Hits Crew", album: "Hits", track: 1, duration: 60 })],
    }),
  });
  const { $ } = ui;
  await until(() => $(".music-page .music-artist-row") && ui.idle());
  await ui.click('[data-action="music-tab"][data-id="albums"]', () => $('.music-card[data-action="music-album"]'));
  await ui.click('.music-card[data-action="music-album"]', () => $(".music-tracks .music-track[data-path]"));
  $(".music-tracks .music-track[data-path] .music-track-play").click();
  await until(() => ui.played.length === 1 && ui.idle());
  assert.equal($("#music-player .music-player-link").textContent, "Solo Act");
  $("#music-player .music-player-link").click();
  await until(() => ui.text(".music-head h2") === "Hits Crew" && ui.idle());
});

test("the bar's and the card's titles underline on hover, so they read as links", () => {
  const css = source("style.css");
  assert.match(css, /@media \(hover: hover\) \{\s*\.music-player-title:hover strong,\s*\.music-player-link:hover,\s*\.music-mini-track:hover strong \{\s*text-decoration: underline;/);
  assert.match(css, /\n\.music-tracks\.music-with-album \.music-track-play \{\s*grid-template-columns: var\(--space-6\) minmax\(0, 2fr\) minmax\(0, 1fr\) minmax\(0, 1fr\) calc\(var\(--space-6\) \* 2\);/);
  const narrow = css.slice(css.lastIndexOf("@media (max-width: 760px)"));
  assert.match(narrow, /\.music-tracks:not\(\.music-songs\) \.music-track-play > :nth-last-child\(2\),\s*\.music-tracks\.music-with-album \.music-track-play > :nth-last-child\(3\) \{\s*display: none;/, "under 760px a playlist hides Artist and Album");
  assert.match(css, /\n\.music-player-link \{\s*max-width: 100%;\s*overflow: hidden;\s*white-space: nowrap;\s*text-overflow: ellipsis;/, "a long album name ellipsizes");
});

test("no artist cover is round and the album strip hides under 760px", () => {
  const css = source("style.css");
  assert.doesNotMatch(css, /music-round|\.music-artist[\s,{]/);
  assert.doesNotMatch(source("app.js"), /music-round/);
  assert.match(css, /\n\.music-row\.music-artist-row \{\s*grid-template-columns: var\(--detail-tile\) minmax\(0, 1fr\) auto var\(--space-4\);/);
  const narrow = css.slice(css.lastIndexOf("@media (max-width: 760px)"));
  assert.match(narrow, /\.music-row\.music-artist-row \{\s*grid-template-columns: var\(--detail-tile\) minmax\(0, 1fr\) var\(--space-4\);\s*\}\s*\.music-artist-albums \{\s*display: none;/);
});

test("search shows grouped results instead of the tab, plays a song within its album and returns on Escape", async (t) => {
  const many = Array.from({ length: 125 }, (_, index) =>
    track(`Bjork/Long Album/${String(index + 1).padStart(3, "0")} Song.mp3`, { title: `Song ${index + 1}`, artist: "Björk", albumArtist: "Björk", album: "Long Album", track: index + 1, duration: 60 }),
  );
  const ui = await open(t, {
    folders: ["Music", "Records"],
    library: () => ({
      version: "v1",
      indexing: false,
      tracks: [...TRACKS, ...many, track("Night/01 Late.mp3", { title: "Late", artist: "Trio", album: "Café Nights" })],
    }),
  });
  const { $, $$, w } = ui;
  await grid(ui);
  const toggle = () => $('[data-action="music-search-toggle"]');
  assert.equal(toggle().getAttribute("aria-label"), "Search music");
  assert.equal($(".music-tools").nextElementSibling, toggle().parentElement);
  await ui.click('[data-action="music-search-toggle"]', () => $(".folder-browser-search #music-search-input"));
  assert.equal(w.document.activeElement.id, "music-search-input");
  assert.equal(toggle().getAttribute("aria-label"), "Close search");
  const type = async (value) => {
    const field = $("#music-search-input");
    field.value = value;
    field.dispatchEvent(new w.Event("input", { bubbles: true }));
    await until(() => ui.idle());
  };
  const groups = () => $$(".music-view .section-label").map((el) => el.textContent);
  const songs = () => $$(".music-view .music-songs .music-track strong").map((el) => el.textContent);
  const rows = () => $$(".music-view .music-row strong").map((el) => el.textContent);
  await type("blue");
  assert.deepEqual(groups(), ["Songs", "Albums"]);
  assert.deepEqual(songs(), ["Blue Train", "So What", "Freddie Freeloader"]);
  assert.equal($(".music-view .music-songs .music-track-play > strong + span").textContent, "John Coltrane · Blue Train");
  assert.deepEqual(ui.cards(), ["Blue Train", "Kind of Blue"]);
  assert.equal(w.document.activeElement.id, "music-search-input");
  await type("CAFE");
  assert.deepEqual(groups(), ["Songs", "Albums"], "no Playlists group");
  assert.deepEqual(songs(), ["Late"]);
  assert.deepEqual(ui.cards(), ["Café Nights"]);
  await type("bjork");
  assert.deepEqual(groups(), ["Songs", "Albums", "Artists"]);
  assert.equal(songs().length, 120);
  assert.deepEqual(rows(), ["Björk"]);
  await ui.click('[data-action="music-search-more"]', () => songs().length === 125);
  await ui.click('.music-row[data-action="music-artist"]', () => $('.music-head [data-action="music-shuffle-artist"]'));
  assert.equal(ui.text('.music-head [data-action="music-back"]'), "Results");
  await ui.click('[data-action="music-back"]', () => groups().length === 3);
  await type("zzz");
  assert.equal(ui.text(".music-view .empty h2"), "No results for “zzz”");
  await type("freddie");
  $(".music-view .music-songs .music-track-play").click();
  await until(() => ui.played.length === 1 && ui.idle());
  assert.equal(ui.text(".music-player-track strong"), "Freddie Freeloader");
  assert.ok($(".music-view .music-songs .music-track").classList.contains("playing"));
  assert.equal($('#music-player [data-player="next"]').disabled, true, "the song plays within its album");
  $('#music-player [data-player="previous"]').click();
  await until(() => ui.played.length === 2 && ui.idle());
  assert.equal(ui.text(".music-player-track strong"), "So What");
  const artists = ["Björk", "John Coltrane", "Miles Davis", "Trio", "Unknown artist"];
  await type("");
  assert.deepEqual(ui.artists(), artists);
  assert.ok($("#music-search-input"));
  await type("blue");
  $("#music-search-input").dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await until(() => !$("#music-search-input") && ui.artists().length === artists.length && ui.idle());
  assert.equal(w.document.activeElement, toggle());
  const stored = Array.from({ length: w.localStorage.length }, (_, index) => w.localStorage.getItem(w.localStorage.key(index))).join(" ");
  assert.doesNotMatch(stored, /zzz|bjork|cafe/i, "the query is never stored");
  await ui.click('[data-action="music-search-toggle"]', () => $("#music-search-input"));
  await type("blue");
  w.location.hash = `#/folders/${ui.volumes[1].id}`;
  await until(() => ui.text(".detail-title h1") === "Records" && ui.$(".music-page .music-artist-row") && ui.idle());
  assert.equal($("#music-search-input"), null, "each folder has its own search");
});

test("Shuffle plays the whole library or an artist's tracks in shuffled order and records nothing in Recent", async (t) => {
  const ui = await open(t);
  const { $, w } = ui;
  await grid(ui);
  assert.deepEqual(
    [...$(".music-tools").children].map((el) => (el.matches(".segmented") ? "tabs" : el.textContent.trim())),
    ["tabs", "Shuffle"],
  );
  assert.equal($('.music-tools [data-action="music-shuffle-all"] [data-icon]').dataset.icon, "shuffle");
  w.Math.random = () => 0.5;
  const titles = async () => {
    const seen = [ui.text(".music-player-track strong")];
    while (!$('#music-player [data-player="next"]').disabled) {
      const count = ui.played.length;
      $('#music-player [data-player="next"]').click();
      await until(() => ui.played.length === count + 1 && ui.idle());
      seen.push(ui.text(".music-player-track strong"));
    }
    return seen;
  };
  $('[data-action="music-shuffle-all"]').click();
  await until(() => ui.played.length === 1 && ui.idle());
  assert.equal($('#music-player [data-player="shuffle"]').getAttribute("aria-pressed"), "true");
  assert.deepEqual((await titles()).sort(), ["Blue Train", "Freddie Freeloader", "So What", "untagged"]);
  await ui.click('[data-action="music-tab"][data-id="artists"]', () => $(".music-artist-row"));
  await ui.click('.music-artist-row[data-id*="miles davis"]', () => $('[data-action="music-shuffle-artist"]'));
  const before = ui.played.length;
  $('[data-action="music-shuffle-artist"]').click();
  await until(() => ui.played.length === before + 1 && ui.idle());
  assert.deepEqual((await titles()).sort(), ["Freddie Freeloader", "So What"]);
  assert.equal(w.localStorage.getItem(`arca-music-recent:${ui.status().id}:${ui.volume.id}`), null);
  await ui.click('[data-action="music-tab"][data-id="recent"]', () => $(".music-caption"));
});

test("search folds only combining accents like the phone, shows the tab for an empty query and pages every group", async (t) => {
  assert.equal(searchText("Björk Café"), "bjork cafe");
  assert.equal(searchText("^·ー`"), "^·ー`");
  assert.equal(searchText("́"), "");
  const many = Array.from({ length: 125 }, (_, index) => {
    const n = String(index + 1).padStart(3, "0");
    return track(`Zebra/${n}/01 Song.mp3`, { title: `Song ${n}`, artist: `Zebra ${n}`, albumArtist: `Zebra ${n}`, album: `Zebra Album ${n}`, track: 1 });
  });
  const ui = await open(t, { library: () => ({ version: "v1", indexing: false, tracks: [...TRACKS, ...many] }) });
  const { $, $$, w } = ui;
  await grid(ui);
  await ui.click('[data-action="music-search-toggle"]', () => $("#music-search-input"));
  const type = async (value) => {
    const field = $("#music-search-input");
    field.value = value;
    field.dispatchEvent(new w.Event("input", { bubbles: true }));
    await until(() => ui.idle());
  };
  const tab = ["John Coltrane", "Miles Davis", "Unknown artist", "Zebra 001"];
  await type("́");
  assert.deepEqual(ui.artists().slice(0, 4), tab, "a query that folds to nothing shows the tab");
  await type("  ");
  assert.deepEqual(ui.artists().slice(0, 4), tab);
  await type("^");
  assert.equal(ui.text(".music-view .empty h2"), "No results for “^”");
  await type("zebra");
  const songs = () => $$(".music-view .music-songs .music-track").length;
  const albums = () => $$('.music-view .music-card[data-action="music-album"]').length;
  const artists = () => $$(".music-view .music-row").length;
  assert.deepEqual([songs(), albums(), artists()], [120, 60, 120]);
  await ui.click('[data-action="music-search-more"][data-id="albums"]', () => albums() === 120);
  await ui.click('[data-action="music-search-more"][data-id="albums"]', () => albums() === 125);
  assert.equal($('[data-action="music-search-more"][data-id="albums"]'), null);
  await ui.click('[data-action="music-search-more"][data-id="artists"]', () => artists() === 125);
  await ui.click('[data-action="music-search-more"][data-id="songs"]', () => songs() === 125);
  assert.equal($('[data-action="music-search-more"]'), null);
});

test("the library Shuffle beside the tabs shows only at a tab root, not on artist or album pages or with search results", async (t) => {
  const ui = await open(t);
  const { $, w } = ui;
  const shuffle = () => $('.music-tools [data-action="music-shuffle-all"]');
  await grid(ui);
  assert.ok(shuffle(), "Artists list");
  await ui.click('.music-artist-row[data-id*="miles davis"]', () => $('[data-action="music-shuffle-artist"]'));
  assert.equal(shuffle(), null, "artist page");
  assert.ok($(".music-tools .segmented"), "the tabs stay");
  await ui.click('.music-card[data-action="music-album"]', () => $('[data-action="music-play"]'));
  assert.equal(shuffle(), null, "album page");
  await ui.click('[data-action="music-tab"][data-id="albums"]', () => !$(".music-head") && shuffle());
  await ui.click('[data-action="music-tab"][data-id="recent"]', () => $(".music-caption") && shuffle());
  await ui.click('[data-action="music-search-toggle"]', () => $("#music-search-input"));
  assert.ok(shuffle(), "an empty search field keeps the tab");
  const field = $("#music-search-input");
  field.value = "blue";
  field.dispatchEvent(new w.Event("input", { bubbles: true }));
  await until(() => $(".music-view .section-label") && ui.idle());
  assert.equal(shuffle(), null, "search results");
  field.value = "";
  field.dispatchEvent(new w.Event("input", { bubbles: true }));
  await until(() => shuffle() && ui.idle());
});

test("desktop albums are their album directory, album artist and title, with disc folders joined and releases first", async () => {
  const { buildLibrary } = await import("../apps/desktop/src/music-library.js");
  const row = (path, tags) => ({ path, hash: `h-${path}`, size: 1, title: null, artist: null, albumArtist: null, album: null, track: null, disc: null, year: null, duration: null, cover: null, added: null, release: null, ...tags });
  const library = buildLibrary({ tracks: [
    row("Miles/Kind of Blue/01.flac", { title: "One", albumArtist: "Miles Davis", album: "Kind of Blue", track: 1 }),
    row("Miles/Kind of Blue/Disc 2/01.flac", { title: "Bonus", albumArtist: "Miles Davis", album: "Kind of Blue", track: 1, disc: 2 }),
    row("Miles/Kind of Blue (Remaster)/01.flac", { title: "One", albumArtist: "Miles Davis", album: "Kind of Blue", track: 1 }),
    row("Rips/A/1.flac", { title: "R1", albumArtist: "Ann", album: "First", release: "rel-1" }),
    row("Rips/B/2.flac", { title: "R2", albumArtist: "Ann", album: "First", release: "rel-1" }),
  ] });
  const albums = [...library.albums.values()].map((album) => album.tracks.length).sort();
  assert.deepEqual(albums, [1, 2, 2], "the disc folder and the release join; the remaster stays apart");
  const rows = [
    row("Miles/Kind of Blue/CD1/01.flac", { title: "One" }),
    row("Miles/Kind of Blue/Disk 2/01.flac", { title: "Two" }),
    row("CD 2/01.flac", { title: "Root disc" }),
    row("loose.flac", { title: "Loose" }),
    row("Rips/A/1.flac", { title: "R1", albumArtist: "Ann", album: "First", release: "rel-1" }),
    row("Rips/B/2.flac", { title: "R2", albumArtist: "Ann", album: "Other", release: "rel-1" }),
  ];
  const desktop = buildLibrary({ tracks: rows });
  const phone = buildPhoneLibrary([{ id: "f", library: { tracks: rows }, present: new Map(rows.map((item) => [item.path, item.hash])) }]);
  const shape = (albums) => [...albums.values()].map((album) => [album.title, album.tracks.length]).sort();
  assert.deepEqual(shape(desktop.albums), shape(phone.albums), "desktop and phone group the same way");
  assert.deepEqual(shape(desktop.albums), [["CD 2", 1], ["First", 2], ["Kind of Blue", 2], ["Unknown album", 1]]);
});

test("off an audio library the sidebar card replaces the bar while a track is loaded; in any audio library the bar shows", async (t) => {
  const ui = await open(t, { folders: ["Music", "Records"], others: ["Docs"] });
  const { $, w } = ui;
  const bar = () => !$("#music-player").hidden && !$("#music-player").classList.contains("music-elsewhere");
  const card = () => !$("#music-mini").hidden;
  await grid(ui);
  assert.deepEqual([bar(), card()], [false, false], "nothing loaded");
  await playAlbum(ui);
  assert.deepEqual([bar(), card()], [true, false], "the library shows the bar");
  assert.equal($("#music-mini").nextElementSibling, $(".status-card"));
  await ui.click('[data-action="music-mode"]', () => $(".folder-stats"));
  assert.deepEqual([bar(), card()], [false, true], "the music folder's files view");
  await ui.click('[data-action="music-mode"]', () => $(".music-page"));
  assert.deepEqual([bar(), card()], [true, false]);
  for (const name of ["devices", "history", "settings"]) {
    $(`[data-view="${name}"]`).click();
    await until(() => $(`[data-view="${name}"]`).classList.contains("active") && ui.idle());
    assert.deepEqual([bar(), card()], [false, true], name);
  }
  w.location.hash = `#/folders/${ui.plain[0].id}`;
  await until(() => ui.text(".detail-title h1, .heading h1") === "Docs" && ui.idle());
  assert.deepEqual([bar(), card()], [false, true], "another folder");
  w.location.hash = `#/folders/${ui.volumes[1].id}`;
  await until(() => ui.text(".detail-title h1") === "Records" && $(".music-page") && ui.idle());
  assert.deepEqual([bar(), card()], [true, false], "any audio library");
  $('[data-view="devices"]').click();
  await until(() => $('[data-view="devices"]').classList.contains("active") && card() && ui.idle());
  const opener = $("#music-mini .music-mini-track");
  assert.equal(opener.getAttribute("aria-label"), "So What by Miles Davis, open Kind of Blue");
  assert.equal(opener.dataset.tooltip, "Open Kind of Blue");
  assert.equal(ui.text("#music-mini .music-mini-text strong"), "So What");
  assert.equal(ui.text("#music-mini .music-mini-text > span"), "Miles Davis");
  const toggle = $('#music-mini [data-player="toggle"]');
  assert.ok(toggle.classList.contains("music-mini-play"));
  assert.equal(toggle.getAttribute("aria-label"), "Pause");
  toggle.click();
  assert.equal($("audio").paused, true);
  assert.equal(toggle.getAttribute("aria-label"), "Play");
  assert.ok(card(), "a paused track keeps the card");
  const next = $('#music-mini [data-player="next"]');
  next.focus();
  next.click();
  await until(() => ui.played.length === 2 && ui.idle());
  assert.equal(ui.text("#music-mini .music-mini-text strong"), "Freddie Freeloader");
  assert.equal(w.document.activeElement, next, "focus stays across track changes");
  assert.equal(next.disabled, true, "the last track has no Next without repeat");
  assert.equal($("#music-mini progress"), null, "the card carries no progress line");
  opener.focus();
  opener.click();
  await until(() => $(".music-head h2") && ui.idle());
  assert.equal(ui.text(".music-head h2"), "Kind of Blue");
  assert.equal(w.document.activeElement, $('#music-player [data-player="toggle"]'), "focus moves to the bar's Play/Pause");
  assert.equal(ui.text(".detail-title h1"), "Music");
  assert.deepEqual([bar(), card()], [true, false]);
  ui.patch = (value) => ({ ...value, hubId: "another-hub" });
  await ui.poll();
  await until(() => $("#music-player").hidden && ui.idle());
  assert.deepEqual([bar(), card()], [false, false], "both leave when the player stops");
});

test("the main window publishes music-state for the tray and answers each music-command", async (t) => {
  const ui = await open(t);
  const { $ } = ui;
  const states = () => ui.emitted.filter(([name]) => name === "music-state").map(([, payload]) => payload);
  await grid(ui);
  assert.deepEqual(states(), [null], "a fresh window publishes null");
  ui.command("state");
  assert.deepEqual(states(), [null, null], "it answers on request with nothing loaded");
  await playAlbum(ui);
  assert.deepEqual({ ...states().at(-1) }, {
    title: "So What",
    artist: "Miles Davis",
    album: "Kind of Blue",
    folder: ui.volume.id,
    cover: COVER,
    playing: true,
    next: true,
  });
  ui.command("toggle");
  assert.equal(states().at(-1).playing, false);
  ui.command("toggle");
  assert.equal(states().at(-1).playing, true);
  const before = states().length;
  ui.command("next");
  await until(() => ui.played.length === 3 && ui.idle());
  assert.deepEqual(
    states().slice(before).map((state) => [state.title, state.playing, state.next]),
    [["Freddie Freeloader", true, false]],
    "a track change publishes one state, and Next is off at the end of the list",
  );
  $('#music-player [data-player="repeat"]').click();
  assert.equal(states().at(-1).next, true, "repeat all enables Next");
  $('#music-player [data-player="repeat"]').click();
  $('#music-player [data-player="repeat"]').click();
  ui.command("previous");
  await until(() => ui.played.length === 4 && ui.idle());
  assert.equal(states().at(-1).title, "So What");
  const count = states().length;
  ui.command("state");
  assert.equal(states().length, count + 1);
  $('[data-view="devices"]').click();
  await until(() => $('[data-view="devices"]').classList.contains("active") && ui.idle());
  ui.command("show");
  await until(() => $(".music-head h2") && ui.idle());
  assert.equal(ui.text(".music-head h2"), "Kind of Blue");
  ui.patch = (value) => ({ ...value, hubId: "another-hub" });
  await ui.poll();
  await until(() => $("#music-player").hidden && ui.idle());
  assert.equal(states().at(-1), null, "a stop publishes null");
});

test("under 761px the sidebar card hides and the bar shows everywhere; notices rise only above a shown bar", () => {
  const css = source("style.css");
  const narrow = css.slice(css.lastIndexOf("@media (max-width: 760px) {\n  #music-mini"));
  assert.match(narrow, /^@media \(max-width: 760px\) \{\n  #music-mini \{\n    display: none;\n  \}/);
  assert.match(css, /\n\.music-player\.music-elsewhere \{\n  display: none;\n\}/);
  assert.match(narrow, /^@media \(max-width: 760px\) \{\n  #music-mini \{\n    display: none;\n  \}\n  \.music-player\.music-elsewhere \{\n    display: grid;\n  \}/);
  assert.doesNotMatch(css, /min-width: 761px/, "one query decides both, so fractional widths never show both");
  assert.match(css, /body:has\(#music-player:not\(\[hidden\]\):not\(\.music-elsewhere\)\) #notice \{/);
  assert.match(css, /\.music-mini-play \{\n  width: calc\(var\(--space-6\) \+ var\(--space-1\)\);/);
  assert.doesNotMatch(css, /music-mini-progress/);
});

const SO_WHAT = "Miles Davis/Kind of Blue/01 So What.mp3";
const BLUE_TRAIN = "Coltrane/Blue Train/01 Blue Train.flac";
const PLAYLISTS = [
  { path: "Playlists/Road trip.m3u8", name: "Road trip", hash: "h1", editable: true, entries: [SO_WHAT, BLUE_TRAIN, SO_WHAT, "Missing/Gone.mp3", null] },
  { path: "Playlists/Hand.m3u", name: "Hand", hash: "h2", editable: false, entries: [BLUE_TRAIN] },
];
const withPlaylists = (playlists = PLAYLISTS) => () => ({ version: `v${playlists.length}`, indexing: false, tracks: TRACKS, playlists });

test("the Playlists tab appears between Albums and Recent once a playlist exists, and a playlist page plays its resolved entries in order", async (t) => {
  let playlists = PLAYLISTS;
  const ui = await open(t, { library: () => withPlaylists(playlists)() });
  const { $, $$, w } = ui;
  await grid(ui);
  assert.deepEqual(ui.tabs(), ["Artists", "Albums", "Playlists", "Recent"]);
  await ui.click('[data-action="music-tab"][data-id="playlists"]', () => $('.music-card[data-action="music-playlist"]'));
  assert.deepEqual(ui.cards(), ["Hand", "Road trip"]);
  assert.equal($('.music-card[data-id="Playlists/Road trip.m3u8"] > span:last-child').textContent, "5 tracks");
  await ui.click('.music-card[data-id="Playlists/Road trip.m3u8"]', () => $(".music-head"));
  assert.equal(ui.text(".music-head h2"), "Road trip");
  assert.equal(ui.text(".music-head-info p"), "5 tracks · 29:27");
  assert.equal(ui.text('.music-head [data-action="music-back"]'), "Playlists");
  assert.match($(".music-head > .music-cover").dataset.musicCover, new RegExp(`key=${COVER}`));
  assert.deepEqual(
    $$('.music-head [aria-label="Playlist actions"] + .menu-items button').map((el) => el.textContent.trim()),
    ["Rename…", "Delete playlist…"],
  );
  const rows = () => $$(".music-tracks .music-track:not(.music-track-head)");
  assert.deepEqual(
    rows().map((row) => [row.querySelector("strong").textContent, row.querySelector("strong + span").textContent]),
    [["So What", "Miles Davis"], ["Blue Train", "John Coltrane"], ["So What", "Miles Davis"], ["Gone", "Not in this folder"], ["Unknown entry", "Not in this folder"]],
  );
  assert.ok($(".music-tracks").classList.contains("music-with-album"));
  assert.deepEqual($$(".music-track-head .music-track-play > span:not([data-icon])").map((el) => el.textContent), ["#", "Title", "Artist", "Album"]);
  assert.deepEqual(
    rows().map((row) => row.querySelector("strong + span + span").textContent),
    ["Kind of Blue", "Blue Train", "Kind of Blue", "", ""],
    "a playlist names each track's album; an unresolved entry leaves it empty",
  );
  assert.equal(rows()[3].querySelector("button.music-track-play"), null, "an unresolved entry never plays");
  assert.ok(rows()[3].classList.contains("music-track-missing"));
  assert.deepEqual(
    [...rows()[0].querySelectorAll(".menu-items button")].map((el) => el.textContent.trim()),
    ["Add to playlist…", "Remove from playlist"],
  );
  $('[data-action="music-play"]').click();
  await until(() => ui.played.length === 1 && ui.idle());
  const titles = [ui.text(".music-player-track strong")];
  while (!$('#music-player [data-player="next"]').disabled) {
    const count = ui.played.length;
    $('#music-player [data-player="next"]').click();
    await until(() => ui.played.length === count + 1 && ui.idle());
    titles.push(ui.text(".music-player-track strong"));
  }
  assert.deepEqual(titles, ["So What", "Blue Train", "So What"], "resolved entries in order, duplicates kept");
  assert.deepEqual(rows().map((row) => row.classList.contains("playing")), [false, false, true, false, false], "the playing appearance is marked by position");
  const saved = JSON.parse(w.localStorage.getItem(`arca-music-recent:${ui.status().id}:${ui.volume.id}`));
  assert.deepEqual(saved.map((entry) => [entry.kind, entry.id]), [["playlist", "Playlists/Road trip.m3u8"]]);
  await ui.click('[data-action="music-back"]', () => ui.cards().length === 2);
  await ui.click('.music-card[data-id="Playlists/Hand.m3u"]', () => ui.text(".music-head h2") === "Hand");
  assert.equal($('.music-head [aria-label="Playlist actions"]'), null, "a hand-made .m3u is read only");
  assert.deepEqual([...$$(".music-tracks .music-track:not(.music-track-head) .menu-items button")].map((el) => el.textContent.trim()), ["Add to playlist…"]);
  await ui.click('[data-action="music-tab"][data-id="recent"]', () => ui.cards().length);
  assert.deepEqual(ui.cards(), ["Road trip"], "Recent lists played playlists");
  await ui.click('[data-action="music-search-toggle"]', () => $("#music-search-input"));
  $("#music-search-input").value = "road";
  $("#music-search-input").dispatchEvent(new w.Event("input", { bubbles: true }));
  await until(() => $(".music-view .section-label") && ui.idle());
  assert.deepEqual($$(".music-view .section-label").map((el) => el.textContent), ["Playlists"]);
  assert.deepEqual($$(".music-view .music-row strong").map((el) => el.textContent), ["Road trip"]);
  playlists = [];
  $('[data-action="music-search-toggle"]').click();
  await until(() => !$("#music-search-input") && ui.idle());
  await ui.click('[data-action="back-folders"]', () => $(".folder-card"));
  await ui.click('.folder-card[data-action="folder-detail"]', () => $(".music-page .music-artist-row"));
  await until(() => !ui.tabs().includes("Playlists") && ui.idle());
  assert.deepEqual(ui.tabs(), ["Artists", "Albums", "Recent"], "the tab leaves with the last playlist");
});

test("Add to playlist… opens a picker of editable playlists and New playlist…, and each choice edits through the playlist route", async (t) => {
  const ui = await open(t, { library: withPlaylists() });
  const { $, $$ } = ui;
  await grid(ui);
  await ui.click('[data-action="music-tab"][data-id="albums"]', () => $('.music-card[data-action="music-album"]'));
  await ui.click('.music-card[data-action="music-album"]:nth-child(2)', () => $(".music-head"));
  const menu = $(".music-tracks .music-track[data-path] .music-track-menu");
  assert.equal(menu.querySelector("summary").getAttribute("aria-label"), "Track actions");
  assert.ok(menu.closest(".music-track").querySelector("button.music-track-play"), "the row is no longer one button");
  menu.open = true;
  await ui.click(".music-track-menu [data-action=\"music-add\"]", () => $("#dialog").open);
  assert.equal(menu.open, false);
  assert.equal(ui.text("#dialog-title"), "Add to playlist");
  assert.equal(ui.text("#dialog .modal-title p"), "So What · Miles Davis");
  assert.deepEqual($$("#dialog .music-picker .music-row strong").map((el) => el.textContent), ["Road trip", "New playlist…"]);
  assert.equal($("#submit-dialog").hidden, true);
  await ui.click('#dialog [data-action="music-pick"]', () => !$("#dialog").open && ui.edits.length === 1);
  assert.deepEqual({ ...ui.edits[0] }, { volume: ui.volume.id, action: "add", path: "Playlists/Road trip.m3u8", hash: "h1", track: SO_WHAT });
  await until(() => /Added to Road trip/.test(ui.text("#notice") || ""));
  $(".music-tracks .music-track[data-path] .music-track-menu").open = true;
  await ui.click('.music-track-menu [data-action="music-add"]', () => $("#dialog").open);
  await ui.click('#dialog [data-action="music-pick-new"]', () => $("#dialog input[name=name]"));
  $("#dialog input[name=name]").value = "Late night";
  $("#submit-dialog").click();
  await until(() => !$("#dialog").open && ui.edits.length === 2 && ui.idle());
  assert.deepEqual({ ...ui.edits[1] }, { volume: ui.volume.id, action: "create", name: "Late night", track: SO_WHAT });
});

test("a playlist page renames, deletes and removes entries through the playlist route", async (t) => {
  const ui = await open(t, { library: withPlaylists() });
  const { $, $$ } = ui;
  await grid(ui);
  await ui.click('[data-action="music-tab"][data-id="playlists"]', () => $('.music-card[data-action="music-playlist"]'));
  await ui.click('.music-card[data-id="Playlists/Road trip.m3u8"]', () => $(".music-head"));
  const rows = () => $$(".music-tracks .music-track:not(.music-track-head)");
  rows()[3].querySelector(".music-track-menu").open = true;
  await ui.click('.music-track-missing [data-action="music-remove"]', () => ui.edits.length === 1);
  assert.deepEqual({ ...ui.edits[0] }, { volume: ui.volume.id, action: "remove", path: "Playlists/Road trip.m3u8", hash: "h1", position: 3, track: "Missing/Gone.mp3" });
  $('.music-head [aria-label="Playlist actions"]').closest("details").open = true;
  await ui.click('[data-action="music-playlist-rename"]', () => $("#dialog").open);
  assert.equal($("#dialog input[name=name]").value, "Road trip");
  $("#dialog input[name=name]").value = "Night drive";
  $("#submit-dialog").click();
  await until(() => !$("#dialog").open && ui.edits.length === 2 && ui.idle());
  assert.deepEqual({ ...ui.edits[1] }, { volume: ui.volume.id, action: "rename", path: "Playlists/Road trip.m3u8", hash: "h1", name: "Night drive" });
  await until(() => ui.text(".music-head h2") === "Road trip" && ui.idle());
  $('.music-head [aria-label="Playlist actions"]').closest("details").open = true;
  await ui.click('[data-action="music-playlist-delete"]', () => $("#dialog").open);
  assert.equal(ui.text("#dialog-title"), "Delete playlist?");
  assert.ok($("#submit-dialog").classList.contains("danger"));
  $("#submit-dialog").click();
  await until(() => !$("#dialog").open && ui.edits.length === 3 && ui.idle());
  assert.deepEqual({ ...ui.edits[2] }, { volume: ui.volume.id, action: "delete", path: "Playlists/Road trip.m3u8", hash: "h1" });
});

test("renaming a playlist keeps it in Recent under its new file", async (t) => {
  const ui = await open(t, { library: withPlaylists() });
  const { $, w } = ui;
  await grid(ui);
  const key = `arca-music-recent:${ui.status().id}:${ui.volume.id}`;
  w.localStorage.setItem(key, JSON.stringify([{ kind: "playlist", id: "Playlists/Road trip.m3u8" }, { kind: "album", id: "keep" }]));
  ui.renamedTo = "Playlists/Night drive.m3u8";
  await ui.click('[data-action="music-tab"][data-id="playlists"]', () => $('.music-card[data-action="music-playlist"]'));
  await ui.click('.music-card[data-id="Playlists/Road trip.m3u8"]', () => $(".music-head"));
  $('.music-head [aria-label="Playlist actions"]').closest("details").open = true;
  await ui.click('[data-action="music-playlist-rename"]', () => $("#dialog").open);
  $("#dialog input[name=name]").value = "Night drive";
  $("#submit-dialog").click();
  await until(() => !$("#dialog").open && ui.edits.length === 1 && ui.idle());
  assert.deepEqual(
    JSON.parse(w.localStorage.getItem(key)).map((entry) => [entry.kind, entry.id]),
    [["playlist", "Playlists/Night drive.m3u8"], ["album", "keep"]],
  );
});

test("on a replica still syncing, an entry naming a file it does not have yet reads Not on this device yet", async (t) => {
  const ui = await open(t, { role: "replica", library: withPlaylists() });
  const { $, $$ } = ui;
  await grid(ui);
  ui.patch = (value) => ({ ...value, volumes: value.volumes.map((v) => ({ ...v, sync: { state: "syncing" } })) });
  await ui.poll();
  await ui.click('[data-action="music-tab"][data-id="playlists"]', () => $('.music-card[data-action="music-playlist"]'));
  await ui.click('.music-card[data-id="Playlists/Road trip.m3u8"]', () => $(".music-head"));
  assert.deepEqual(
    $$(".music-track-missing strong + span").map((el) => el.textContent),
    ["Not on this device yet", "Not in this folder"],
  );
});
