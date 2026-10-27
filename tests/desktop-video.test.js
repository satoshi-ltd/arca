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

const base = { selected: 1, sync: { state: "synced", lastCompleted: new Date().toISOString() }, conflicts: 0, files: 318, bytes: 2 * 1024 ** 4 };
const hubStatus = (volumes = [{ ...base, id: "vid", name: "video", video: true, path: "/srv/video" }]) => ({
  id: "hub",
  name: "Casa",
  role: "hub",
  phase: "idle",
  hub: "",
  devices: [],
  root: "/srv",
  protocol: 1,
  platform: "linux",
  port: 17831,
  volumes,
});
const CONTENTS = [
  { id: "es-ES", label: "Español · España" },
  { id: "en-US", label: "English · United States" },
  { id: "en-GB", label: "English · United Kingdom" },
  { id: "de-DE", label: "Deutsch · Deutschland" },
  { id: "fr-FR", label: "Français · France" },
];
const SETTINGS = {
  tokenSet: true,
  state: "connected",
  matched: 7,
  total: 8,
  content: "es-ES",
  contents: CONTENTS,
  libraries: [{ volume: "vid", name: "video", movies: 5, shows: 3, unrecognised: 1 }],
};

async function boot(t, { status = hubStatus(), route = "#/folders/vid", web = false, canPlay = "maybe", library = sampleLibrary, remote = null, search = null, playback = null, settings = () => SETTINGS, audioTracks = false, compatible = null, subtitles = null, downloads = null, watched = null } = {}) {
  const dom = new JSDOM(html, { runScripts: "outside-only", url: `http://tauri.localhost/${route}` });
  const w = dom.window;
  const pending = new Set();
  const ui = { posts: [], routes: [], commands: [], timers: { 300: [], 1000: [], 2000: [], 2500: [], 3000: [], 5000: [], 60000: [] }, played: [], blobs: 0, revoked: [], fetched: [], blobText: [] };
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
    if (ui.timers[ms]) {
      const id = `held-${++held}`;
      ui.timers[ms].push({ id, callback });
      return id;
    }
    return setTimer(callback, ms, ...rest);
  };
  w.clearTimeout = (id) => {
    if (typeof id === "string" && id.startsWith("held-")) {
      for (const list of Object.values(ui.timers)) {
        const index = list.findIndex((entry) => entry.id === id);
        if (index >= 0) list.splice(index, 1);
      }
      return;
    }
    clearTimer(id);
  };
  ui.fire = (ms) => {
    const due = ui.timers[ms].splice(0);
    for (const { callback } of due) callback();
  };
  const media = w.HTMLMediaElement.prototype;
  Object.defineProperty(media, "paused", { configurable: true, get() { return !this.playing; } });
  Object.defineProperty(media, "currentTime", { configurable: true, get() { return this.time || 0; }, set(value) { this.time = value; } });
  Object.defineProperty(media, "duration", { configurable: true, get() { return this.length ?? NaN; } });
  Object.defineProperty(w.HTMLVideoElement.prototype, "videoWidth", { configurable: true, get() { return 1920; } });
  media.canPlayType = (type) => (typeof canPlay === "function" ? canPlay(type) : canPlay);
  Object.defineProperty(media, "seekable", {
    configurable: true,
    get() {
      const end = this.ranges;
      return end ? { length: 1, start: () => 0, end: () => end } : { length: 0, start: () => 0, end: () => 0 };
    },
  });
  media.play = function () {
    this.playing = true;
    ui.played.push(this.getAttribute("src"));
    this.dispatchEvent(new w.Event("play"));
    return Promise.resolve();
  };
  media.pause = function () {
    if (!this.playing) return;
    this.playing = false;
    this.dispatchEvent(new w.Event("pause"));
  };
  media.load = function () {};
  Object.defineProperty(media, "audioTracks", {
    configurable: true,
    get() {
      if (!audioTracks) return undefined;
      this.audio ||= typeof audioTracks === "function" ? audioTracks() : [{ enabled: true }, { enabled: false }];
      return this.audio;
    },
  });
  Object.defineProperty(media, "textTracks", {
    configurable: true,
    get() {
      this.inBand ||= { mode: "showing", inBand: true };
      return [...this.querySelectorAll("track")].map((el) => el.track).concat(this.inBand);
    },
  });
  Object.defineProperty(w.HTMLTrackElement.prototype, "track", {
    configurable: true,
    get() {
      this.cue ||= { mode: "showing", cues: [{ startTime: 1600, endTime: 1602 }] };
      return this.cue;
    },
  });
  w.HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  w.HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
    this.dispatchEvent(new w.Event("close"));
  };
  w.IntersectionObserver = class {
    constructor(callback) {
      this.callback = callback;
    }
    observe(target) {
      queueMicrotask(() => this.callback([{ isIntersecting: true, target }]));
    }
    unobserve() {}
    disconnect() {}
  };
  let data = null;
  let version = 0;
  const items = () => [...data.movies, ...data.other, ...data.shows.flatMap((show) => show.seasons.flatMap((season) => season.episodes))];
  const answer = async (route, method, body) => {
    ui.routes.push(route);
    if (method === "POST") ui.posts.push([route, JSON.parse(JSON.stringify(body))]);
    if (downloads && route.startsWith("/v1/video/download")) return downloads(route, method, body);
    if (watched && route === "/v1/video/watched" && watched(body)) return Promise.reject(Object.assign(new Error("The hub is busy"), { status: 500 }));
    if (route === "/v1/video/watched" || route === "/v1/video/position" || route === "/v1/video/kids") {
      data ||= library();
      version++;
      const item = route === "/v1/video/kids" ? [...data.movies, ...data.shows].find((row) => row.id === body.id) : items().find((row) => row.path === body.path);
      if (item && route === "/v1/video/watched") Object.assign(item, { watched: body.watched }, body.watched ? { position: null } : {});
      if (item && route === "/v1/video/position") item.position = { position: body.position, duration: body.duration, updated: Date.now(), device: "mac" };
      if (item && route === "/v1/video/kids") item.kids = body.kids;
      return { ok: true };
    }
    if (route === "/v1/video/watch-next/remove" || route === "/v1/video/watch-next/restore") {
      data ||= library();
      version++;
      if (route.endsWith("/remove")) data.watchNext = data.watchNext.filter((row) => row.id !== body.id);
      return { version: `${data.version}-${version}` };
    }
    if (route === "/v1/status") return status;
    if (route === "/v1/favorites") return { favorites: [] };
    if (route === "/v1/remote") return remote || { volumes: [] };
    if (route === "/v1/machines") return { machines: [] };
    if (route === "/v1/network") return { mode: "standalone", tailscale: { state: "stopped" }, publishing: false, allowLanHttp: false };
    if (route.startsWith("/v1/video/library?")) {
      data ||= library();
      const current = `${data.version}-${version}`;
      if (new URLSearchParams(route.split("?")[1]).get("version") === current) return { version: current, unchanged: true, indexing: data.indexing, matching: data.matching, tmdb: data.tmdb };
      return { ...data, version: current };
    }
    if (route.startsWith("/v1/video/art?")) return { data: "data:image/jpeg;base64,AAAA" };
    if (route.startsWith("/v1/video/subtitles?") && subtitles) return subtitles(route);
    if (route.startsWith("/v1/video/subtitles?")) return { text: `WEBVTT\n\n00:00.000 --> 00:01.000\n${new URLSearchParams(route.split("?")[1]).get("path")}\n` };
    if (route.startsWith("/v1/video/compatible?")) {
      if (compatible) return compatible(route);
      const query = new URLSearchParams(route.split("?")[1]);
      const start = Number(query.get("start")) || 0;
      return { url: `http://127.0.0.1:1/v1/video/hls/${encodeURIComponent(query.get("path"))}/index.m3u8?from=${start}`, offset: start, audio: Number(query.get("audio") ?? 0), duration: 2880 };
    }
    if (route.startsWith("/v1/video/playback?")) {
      if (playback) return playback(route);
      const query = new URLSearchParams(route.split("?")[1]);
      return {
        url: `http://127.0.0.1:1/v1/video/media?ticket=${encodeURIComponent(query.get("path"))}`,
        subtitles: web
          ? [
              { label: "Spanish", language: "es", url: "/v1/video/subtitles?volume=vid&path=Inception.es.srt" },
              { label: "English", language: "en", url: "/v1/video/subtitles?volume=vid&path=Inception.en.srt" },
            ]
          : [
              { path: "Inception.es.srt", label: "Spanish", language: "es" },
              { path: "Inception.en.srt", label: "English", language: "en" },
              { path: "Inception.en.sdh.srt", label: "English", language: "en" },
              { embedded: true, stream: 0, label: "French", language: "fr" },
              { embedded: true, stream: 1, label: "German", language: "de", image: true },
            ],
      };
    }
    if (route === "/v1/video/settings" && method === "GET") return settings();
    if (route.startsWith("/v1/video/tmdb-search?"))
      return { results: [{ type: "movie", id: 27205, title: "Inception", year: 2010, overview: "", poster: "/v1/video/tmdb-image?path=%2Fi.jpg" }] };
    if (route.startsWith("/v1/video/tmdb-image?")) return { data: "data:image/jpeg;base64,BBBB" };
    if (route.startsWith("/v1/search?")) return search || { groups: [] };
    if (route.startsWith("/v1/history?")) return { versions: [{ rev: 7 }] };
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
    w.fetch = (route, init = {}) =>
      track(
        answer(route, init.method || "GET", init.body ? JSON.parse(init.body) : null).then(
          (data) => new Response(JSON.stringify(data), { status: 200 }),
          (error) => new Response(JSON.stringify({ error: error?.message || String(error) }), { status: error?.status || 500 }),
        ),
      );
  else {
    w.fetch = async (url) => {
      ui.fetched.push(url);
      throw new TypeError("Refused by the content security policy");
    };
    w.URL.createObjectURL = (blob) => {
      blob.text().then((value) => ui.blobText.push(value));
      return `blob:subtitle-${++ui.blobs}`;
    };
    w.URL.revokeObjectURL = (url) => ui.revoked.push(url);
    w.__TAURI__ = {
      core: {
        invoke: (command, args) =>
          track(
            (async () => {
              if (command === "bootstrap") return { setup: false, status };
              if (command === "api") return answer(args.route, args.method, args.body);
              ui.commands.push([command, args]);
              return {};
            })(),
          ),
      },
      event: { listen: async () => () => {}, emit: async () => {} },
    };
  }
  w.eval(`(async()=>{${script}\n})()`);
  const $ = (selector) => w.document.querySelector(selector);
  const $$ = (selector) => [...w.document.querySelectorAll(selector)];
  const idle = () => w.document.body.getAttribute("aria-busy") !== "true";
  const text = (selector) => $(selector)?.textContent.trim();
  const texts = (selector) => $$(selector).map((el) => el.textContent.trim());
  const click = async (selector, ready = () => true) => {
    const target = typeof selector === "string" ? $(selector) : selector;
    assert.ok(target, String(selector));
    target.click();
    await until(() => ready() && idle());
  };
  const press = (key, target = w.document.body, extra = {}) => target.dispatchEvent(new w.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...extra }));
  const video = () => $("#video-player video");
  return Object.assign(ui, { w, $, $$, idle, text, texts, click, press, video });
}
const cardTitles = (ui) => ui.texts(".video-page .music-card strong");
const library = async (ui) => until(() => ui.$(".video-page .music-card") && ui.idle());
const openMovie = async (ui, title = "Inception", tab = "movies") => {
  await library(ui);
  await ui.click(`[data-action="video-tab"][data-id="${tab}"]`, () => cardTitles(ui).includes(title));
  const card = ui.$$(".video-page .music-card").find((el) => el.querySelector("strong").textContent === title);
  await ui.click(card, () => ui.text(".video-backdrop h2") === title);
};
const openPlayer = async (ui, selector) => {
  await ui.click(selector, () => ui.video()?.getAttribute("src"));
  ui.video().length = Number(ui.video().length) || 8880;
  ui.video().dispatchEvent(new ui.w.Event("loadedmetadata"));
};

test("a video folder opens on Home with tabs, shelves, covers and View folder", async (t) => {
  const ui = await boot(t);
  await library(ui);
  assert.deepEqual(ui.texts('.video-page .segmented[aria-label="Library"] button'), ["Home", "Movies", "TV Shows", "Kids", "Others"]);
  assert.equal(ui.text('.video-page .segmented button[aria-pressed="true"]'), "Home");
  assert.equal(ui.$(".video-page .music-caption"), null, "no caption once the hub has read everything");
  assert.deepEqual(ui.texts(".video-shelves .section-label"), ["Watch next", "Recently added movies", "Recently added shows", "Kids picks"]);
  const resume = ui.$$(".video-shelves section")[0];
  assert.deepEqual([...resume.querySelectorAll(".music-card > span:last-child")].map((el) => el.textContent), ["S1 · E4 · 23 min left", "1 h 26 min left", "S1 · E2 · Hospital", "Because you watched Inception", "Added this week", "In your library since January"]);
  assert.deepEqual([...resume.querySelectorAll(".music-card")].map((el) => el.querySelector(".video-next")?.textContent || ""), ["", "", "Next", "", "New", ""], "the hub's Watch next row is drawn as sent: resume, next, then picks, New tagged");
  assert.ok(resume.querySelector(".music-cover.video-still progress.music-cover-bar"));
  assert.equal(ui.$(".video-shelves .video-still .video-rating:not(.video-next)"), null, "stills never carry the rating");
  assert.ok(ui.$(".video-shelf.video-posters .video-poster .video-rating"));
  assert.equal(resume.querySelectorAll("strong")[2].textContent, "Bluey");
  assert.deepEqual([...resume.querySelectorAll(".music-card")].map((el) => el.getAttribute("data-action")), ["video-play", "video-play", "video-play", "video-title", "video-title", "video-title"], "a pick opens its title page");
  assert.ok(ui.$(".video-shelf.video-posters .music-cover.video-poster"));
  assert.match(ui.text(".detail-title p"), /^6 movies · 2 shows · 1 other video · /);
  assert.deepEqual(ui.texts("#content .music-trail :is(button, [aria-current])"), ["Folders", "video"]);
  assert.equal(ui.text('.heading-actions [data-action="video-mode"]'), "View folder");
  assert.equal(ui.$('.folder-actions-menu [data-action="enable-video"]'), null, "a video folder offers no Enable video library");
  await until(() => ui.$("[data-video-art] img"));
  assert.ok(ui.routes.some((route) => route.startsWith("/v1/video/art?") && route.includes("key=p-inception")));
  assert.ok(ui.routes.find((route) => route.startsWith("/v1/video/library?")).includes("volume=vid"));
});

test("a Watch next card is removed with a cross and Undo restores it", async (t) => {
  const ui = await boot(t);
  await library(ui);
  const cards = () => ui.$$(".video-shelves section")[0].querySelectorAll(".video-card");
  const first = cards()[0];
  const cross = first.querySelector('[data-action="video-watch-remove"]');
  assert.equal(cross.getAttribute("aria-label"), `Remove from Watch next: ${first.querySelector("strong").textContent}`);
  assert.equal(cross.closest(".music-card"), null, "the cross sits beside the card's own button");
  const total = cards().length;
  await ui.click(cross, () => cards().length === total - 1);
  assert.deepEqual(ui.posts.filter(([route]) => route === "/v1/video/watch-next/remove").map(([, body]) => body), [{ volume: "vid", id: cross.dataset.id }]);
  assert.equal(ui.text("#notice .notice-card strong"), "Removed from Watch next");
  await ui.click('[data-action="video-tab"][data-id="movies"]', () => cardTitles(ui).length > 0);
  await ui.click('#notice [data-action="video-watch-undo"]', () => ui.posts.some(([route]) => route === "/v1/video/watch-next/restore"));
  assert.deepEqual(ui.posts.find(([route]) => route === "/v1/video/watch-next/restore")[1], { volume: "vid", id: cross.dataset.id });
});

test("the hub reading or matching shows a caption, and a folder with only home videos has no tab row", async (t) => {
  const reading = await boot(t, { library: () => ({ ...sampleLibrary(), indexing: { done: 42, total: 310 } }) });
  await library(reading);
  assert.equal(reading.text(".video-page .music-caption"), "Reading 42 of 310 videos…");
  const other = await boot(t, { library: () => ({ version: "v2", other: sampleLibrary().other, matching: true }) });
  await library(other);
  assert.equal(other.$('.video-page .segmented[aria-label="Library"]'), null);
  assert.equal(other.text(".video-page .music-caption"), "Matching titles…");
  assert.deepEqual(cardTitles(other), ["Beach"]);
  assert.ok(other.$(".video-still-grid .music-cover.video-still"));
});

test("Set up as library replaces the Enable items and asks what the folder holds", async (t) => {
  const ui = await boot(t, { status: hubStatus([{ ...base, id: "docs", name: "documents", path: "/srv/docs", files: 8, bytes: 12.4 * 1024 ** 3 }]), route: "#/folders/docs" });
  await until(() => ui.$(".folder-actions-menu") && ui.idle());
  assert.deepEqual(ui.texts(".folder-actions-menu .menu-items button"), ["Set up as library…", "Rename…", ".arcaignore…"]);
  assert.equal(ui.$('[data-action="setup-library"] [data-icon]').dataset.icon, "library-big");
  await ui.click('[data-action="setup-library"]', () => ui.$("#dialog[open]"));
  assert.equal(ui.text("#dialog-title"), "What’s in this folder?");
  assert.equal(ui.text("#dialog .modal-title p"), "documents · 8 files · 12.4 GB");
  assert.deepEqual(ui.texts("#dialog .role-card strong"), ["Photos", "Audio", "Movies & TV"]);
  assert.deepEqual(ui.$$('#dialog .role-card input[type="radio"]').map((el) => el.value), ["gallery", "music", "video"]);
  assert.deepEqual(ui.texts("#dialog .role-card p"), ["Photos and videos by date.", "Music and podcasts, with playlists.", "Films and series. Stays on the hub and streams to your devices; no older versions."]);
  assert.equal(ui.text("#dialog-content > .hint"), "This can’t be changed later. Your files stay as they are; Movies & TV also removes the folder’s older versions, and other devices stop syncing it and stream it instead.");
  assert.equal(ui.text("#submit-dialog"), "Set up");
  assert.equal(ui.$("#submit-dialog").disabled, true, "Set up waits for a choice");
  const video = ui.$('#dialog input[value="video"]');
  video.checked = true;
  video.dispatchEvent(new ui.w.Event("change", { bubbles: true }));
  assert.equal(ui.$("#submit-dialog").disabled, false);
  await ui.click("#submit-dialog", () => ui.posts.some(([route]) => route === "/v1/video/mark"));
  assert.deepEqual(ui.posts.find(([route]) => route === "/v1/video/mark")[1], { volume: "docs" });
  assert.equal(ui.posts.some(([route]) => route === "/v1/gallery/link" || route === "/v1/music/mark"), false);
});
test("the tabs and the sort share one row; Movies sorts and stacks a saga, and Home has no sort", async (t) => {
  const ui = await boot(t);
  await library(ui);
  assert.equal(ui.$(".video-tools .video-sort"), null, "Home is not sorted");
  await ui.click('[data-action="video-tab"][data-id="movies"]', () => ui.$(".video-tools .video-sort"));
  const row = ui.$(".video-page .folder-browser-tools.video-tools");
  assert.ok(row.querySelector('.music-tools > .segmented[aria-label="Library"]'), "tabs on the left");
  assert.equal(row.lastElementChild, row.querySelector('.segmented.video-sort[aria-label="Sort"]'), "sort on the right of the same row");
  assert.deepEqual(ui.texts('.video-tools .segmented[aria-label="Sort"] button'), ["A–Z", "Recently added", "Year", "Rating"]);
  assert.equal(ui.$('[aria-label="Genre"], [data-action="video-genre"], .video-chip, .video-filters'), null, "no genre filter");
  assert.deepEqual(cardTitles(ui), ["Arrival", "Dune Part Two", "The Fellowship of the Ring", "Inception", "The Two Towers"], "every movie is its own poster, A–Z past a leading The, kids titles in Kids only");
  assert.equal(ui.$(".video-stack"), null);
  const card = (title) => ui.$$(".video-page .music-card").find((el) => el.querySelector("strong").textContent === title);
  assert.ok(card("Arrival").querySelector('.video-watched[aria-label="Watched"]'));
  assert.ok(card("Inception").querySelector("progress.music-cover-bar"));
  await ui.click('[data-action="video-sort"][data-id="year"]', () => cardTitles(ui)[0] === "Dune Part Two");
  assert.deepEqual(cardTitles(ui), ["Dune Part Two", "Arrival", "Inception", "The Two Towers", "The Fellowship of the Ring"]);
  await ui.click('[data-action="video-tab"][data-id="shows"]', () => cardTitles(ui).includes("Breaking Bad"));
  assert.equal(ui.text('.video-tools .video-sort button[aria-pressed="true"]'), "Year", "the sort carries over to TV Shows");
  assert.deepEqual(cardTitles(ui), ["Bluey", "Breaking Bad"], "a kids show still lives in TV Shows");
  await ui.click('[data-action="video-sort"][data-id="rating"]', () => cardTitles(ui)[0] === "Breaking Bad");
  await ui.click('[data-action="video-tab"][data-id="kids"]', () => ui.$(".video-tools .video-sort"));
  await ui.click('[data-action="video-tab"][data-id="other"]', () => ui.$(".video-tools .video-sort") && cardTitles(ui).includes("Beach"));
  await ui.click('[data-action="video-tab"][data-id="movies"]', () => cardTitles(ui)[0] === "The Fellowship of the Ring");
  await ui.click(card("The Fellowship of the Ring"), () => ui.$(".video-more"));
  assert.equal(ui.text(".video-more .section-label"), "Related");
  assert.deepEqual(ui.texts(".video-more .music-card strong"), ["The Two Towers"]);
  await ui.click(ui.$(".video-more .music-card"), () => ui.text(".video-backdrop h2") === "The Two Towers");
  assert.deepEqual(ui.texts("#content .music-trail :is(button, [aria-current])"), ["Folders", "video", "Movies", "The Two Towers"], "a related title opens its own page");
  const css = fs.readFileSync(new URL("../apps/desktop/src/style.css", import.meta.url), "utf8");
  assert.match(css, /\.video-tools \{\s*flex-wrap: wrap;\s*\}\s*\.video-tools > \.segmented\.video-sort \{\s*margin-left: auto;/, "a narrow window wraps the sort to its own row, aligned right");
  assert.doesNotMatch(css, /video-chip|video-genres|video-filters/);
});

test("a movie banner holds title, facts with badges, languages, overview, cast, buttons and ⋯ with nothing below it", async (t) => {
  const ui = await boot(t);
  await openMovie(ui);
  assert.deepEqual(ui.texts(".video-backdrop .video-facts > span"), ["★ 8.4", "12", "2010", "2 h 28 min", "Action, Sci-Fi", "HD", "5.1"]);
  assert.deepEqual(ui.texts(".video-backdrop .video-facts .video-badge"), ["12", "HD", "5.1"]);
  assert.deepEqual(ui.$$(".video-backdrop .video-languages .video-language-group").map((el) => [el.getAttribute("aria-label"), [...el.querySelectorAll(".video-badge")].map((chip) => chip.textContent)]), [
    ["Audio: English, Spanish", ["EN", "ES"]],
    ["Subtitles: Spanish, English, French", ["ES", "EN", "FR"]],
  ]);
  assert.ok(ui.$('.video-backdrop .video-language-group [data-icon="audio-lines"]') && ui.$('.video-backdrop .video-language-group [data-icon="captions"]'), "the icons sit outside the chips");
  assert.equal(ui.text(".video-backdrop .video-hero-overview"), "A thief who steals secrets from dreams.");
  assert.equal(ui.text(".video-backdrop .video-cast"), "CastLeonardo DiCaprio, Joseph Gordon-Levitt, Elliot Page, Tom Hardy, Ken Watanabe");
  assert.deepEqual(
    [...ui.$(".video-backdrop .music-head-info > div").children].map((el) => el.className || el.tagName),
    ["H2", "video-facts", "video-languages", "video-hero-overview", "video-line video-cast", "heading-actions"],
  );
  assert.ok([undefined, "Related"].includes(ui.$(".video-backdrop").nextElementSibling?.getAttribute("aria-label")), "only Related can sit below a movie's banner");
  assert.equal(ui.$(".video-about"), null);
  assert.ok(ui.$('.video-backdrop .video-backdrop-art[data-video-art*="size=large"]'));
  assert.deepEqual(ui.texts(".video-backdrop .heading-actions > button"), ["Resume from 1:02:10", "Start over", "Mark as watched"]);
  assert.deepEqual(ui.texts(".video-menu .menu-items button"), ["Fix match…", "Mark as kids", "Delete…"]);
  assert.ok(ui.$('.video-menu [data-action="video-delete"]').classList.contains("menu-item-separated"));
  assert.deepEqual(ui.texts("#content .music-trail :is(button, [aria-current])"), ["Folders", "video", "Movies", "Inception"]);
  assert.equal(ui.$(".video-backdrop > .video-poster .video-watched"), null);
  await ui.click('.video-backdrop [data-action="video-watched"]', () => ui.text('.video-backdrop [data-action="video-watched"]') === "Mark as unwatched");
  assert.ok(ui.$('.video-backdrop > .video-poster .video-watched[aria-label="Watched"]'), "the page's own poster shows the watched mark at once");
  assert.deepEqual(ui.posts.find(([route]) => route === "/v1/video/watched")[1], { volume: "vid", path: "Inception.mp4", hash: "h-Inception.mp4", watched: true });
  assert.equal(ui.text(".video-backdrop .heading-actions > button"), "Play", "a finished movie starts from the beginning");
  await ui.click('.video-menu [data-action="video-kids"]', () => ui.posts.some(([route]) => route === "/v1/video/kids"));
  assert.deepEqual(ui.posts.find(([route]) => route === "/v1/video/kids")[1], { volume: "vid", id: "m:inception", kids: true });
  const crumb = ui.$$("#content .music-trail button").find((el) => el.textContent.trim() === "Movies");
  await ui.click(crumb, () => ui.$(".video-tools .video-sort"));
  assert.equal(ui.$$(".video-page .music-card").find((el) => el.textContent.includes("Arrival")).querySelector(":scope > span:last-child").textContent, "2016", "the caption is the year alone");
  assert.equal(ui.$$(".video-page .music-card").find((el) => el.textContent.includes("Arrival")).querySelector(".video-poster > .video-rating").textContent, "★ 7.9");
  assert.equal(ui.$$(".video-page .music-card").find((el) => el.textContent.includes("Dune")).querySelector(".video-rating"), null, "no badge without a rating");
  assert.equal(ui.$$(".video-page .music-card").find((el) => el.textContent.includes("Dune")).querySelector(":scope > span:last-child").textContent, "2024", "only the year without a rating");
});

test("a show page plays the next episode, switches seasons and toggles watched episodes", async (t) => {
  const ui = await boot(t);
  await library(ui);
  await ui.click('[data-action="video-tab"][data-id="shows"]', () => cardTitles(ui).includes("Breaking Bad"));
  assert.deepEqual(ui.texts(".video-page .music-card > span:last-child"), ["2018", "2008"]);
  assert.deepEqual(ui.texts(".video-page .music-card .video-poster .video-rating"), ["★ 8.9"], "the rating sits in the artwork, Bluey has none");
  const card = ui.$$(".video-page .music-card").find((el) => el.querySelector("strong").textContent === "Breaking Bad");
  await ui.click(card, () => ui.text(".video-backdrop h2") === "Breaking Bad");
  assert.deepEqual(ui.texts(".video-backdrop .video-facts > span"), ["★ 8.9", "16", "2008", "2 seasons", "Crime, Drama", "HD"]);
  assert.equal(ui.$(".video-backdrop .video-languages"), null, "an episode without named audio or subtitles shows no chips");
  assert.ok(ui.$(".video-backdrop + .video-season-bar > .segmented.video-seasons"), "the season control follows the banner, in the bar that also holds Download season");
  assert.equal(ui.text(".video-backdrop .heading-actions > button"), "Play S1 · E4");
  assert.deepEqual(ui.texts(".video-menu .menu-items button"), ["Fix match…"], "a TMDB-matched show takes Kids from TMDB and has no Delete");
  assert.deepEqual(ui.texts('.segmented[aria-label="Season"] button'), ["Season 1", "Season 2", "Specials"]);
  assert.deepEqual(ui.texts(".video-episode .video-episode-main strong"), ["1. Pilot", "2. Cat's in the Bag...", "3. ...And the Bag's in the River", "4. Cancer Man", "5. Gray Matter"]);
  assert.equal(ui.text('.video-episode[aria-current="true"] .video-meta'), "S1 · E4 · 23 min left");
  assert.ok(ui.$('.video-episode[aria-current="true"] progress.music-cover-bar'));
  assert.equal(ui.$$(".video-episode")[0].querySelector('[data-action="video-watched"]').getAttribute("aria-label"), "Mark as unwatched");
  assert.equal(ui.text(".video-episode .video-meta"), "S1 · E1 · 58 min");
  await ui.click(ui.$$(".video-episode")[4].querySelector('[data-action="video-watched"]'), () =>
    ui.$$(".video-episode")[4].querySelector('[data-action="video-watched"]').getAttribute("aria-label") === "Mark as unwatched",
  );
  assert.deepEqual(ui.posts.find(([route]) => route === "/v1/video/watched")[1], { volume: "vid", path: "Breaking Bad/Season 1/S01E05.mkv", hash: "h-Breaking Bad/Season 1/S01E05.mkv", watched: true });
  await ui.click('[data-action="video-season"][data-id="2"]', () => ui.$$(".video-episode").length === 1);
  assert.equal(ui.text(".video-episode strong"), "1. Seven Thirty-Seven");
});

test("the player streams with subtitles, seeks, answers the keyboard, hides its controls and saves positions", async (t) => {
  const ui = await boot(t);
  await openMovie(ui);
  await openPlayer(ui, '.video-backdrop [data-action="video-resume"]');
  const { $, w } = ui;
  assert.equal($("#video-player").hidden, false);
  assert.equal(ui.video().getAttribute("src"), "http://127.0.0.1:1/v1/video/media?ticket=Inception.mp4");
  assert.deepEqual([...ui.video().querySelectorAll("track")].map((el) => [el.kind, el.label, el.srclang, el.getAttribute("src")]), [
    ["subtitles", "Spanish", "es", "blob:subtitle-1"],
    ["subtitles", "English", "en", "blob:subtitle-2"],
    ["subtitles", "English", "en", "blob:subtitle-3"],
    ["subtitles", "French", "fr", null],
  ]);
  assert.ok(ui.routes.includes("/v1/video/subtitles?volume=vid&path=Inception.es.srt&format=json"), "the desktop app reads subtitles through the IPC bridge");
  assert.deepEqual(ui.fetched, [], "never with fetch, which the app's content security policy refuses");
  assert.ok(ui.routes.includes("/v1/video/subtitles?volume=vid&path=Inception.en.sdh.srt&format=json"), "two English files each load their own path");
  assert.equal(ui.routes.some((route) => route.startsWith("/v1/video/subtitles?") && route.includes("stream=")), false, "embedded subtitles wait for extraction");
  await until(() => ui.blobText.length === 3);
  assert.deepEqual(ui.blobText.map((text) => text.trim().split("\n").at(-1)).sort(), ["Inception.en.sdh.srt", "Inception.en.srt", "Inception.es.srt"]);
  for (const selector of [".sidebar", "#content", "#music-player", "#dialog"]) assert.equal(ui.$(selector).hasAttribute("inert"), true, `${selector} is inert while the player is open`);
  assert.equal(ui.$("#notice").closest("[inert]"), null, "notices stay live above the player");
  assert.equal(ui.text("#video-player .video-top strong"), "Inception");
  assert.equal(ui.text("#video-player .video-top p"), "2010 · 1080p · H.264 · AAC");
  assert.equal(ui.video().currentTime, 3730, "resumes from the saved position");
  assert.equal($('#video-player [data-video="toggle"]').getAttribute("aria-label"), "Pause");
  await ui.click('#video-player [data-video="back10"]');
  assert.equal(ui.video().currentTime, 3720);
  await ui.click('#video-player [data-video="forward30"]');
  assert.equal(ui.video().currentTime, 3750);
  ui.press("ArrowLeft");
  assert.equal(ui.video().currentTime, 3740);
  ui.press("ArrowRight");
  assert.equal(ui.video().currentTime, 3770);
  ui.fire(3000);
  assert.ok($("#video-player").classList.contains("video-idle"), "controls hide after 3 s while playing");
  $("#video-player").dispatchEvent(new w.Event("pointermove"));
  assert.equal($("#video-player").classList.contains("video-idle"), false);
  ui.press(" ");
  assert.equal(ui.video().paused, true);
  await until(() => ui.posts.some(([route]) => route === "/v1/video/position"));
  assert.deepEqual(ui.posts.find(([route]) => route === "/v1/video/position")[1], { volume: "vid", path: "Inception.mp4", hash: "h-Inception.mp4", position: 3770, duration: 8880 });
  ui.fire(3000);
  assert.equal($("#video-player").classList.contains("video-idle"), false, "paused video keeps its controls");
  ui.press(" ");
  assert.equal(ui.video().paused, false);
  const now = w.Date.now();
  w.Date.now = () => now + 11000;
  ui.video().time = 3800;
  ui.video().dispatchEvent(new w.Event("timeupdate"));
  await until(() => ui.posts.filter(([route]) => route === "/v1/video/position").length === 2);
  assert.equal(ui.posts.filter(([route]) => route === "/v1/video/position")[1][1].position, 3800, "every 10 s while playing");
  assert.deepEqual(ui.texts("#video-player .video-subtitles .menu-items button"), ["Off", "Spanish", "English", "English", "French"]);
  assert.equal($('#video-player [data-video="subtitle"][aria-checked="true"]').textContent, "Off");
  const modes = () => [...ui.video().querySelectorAll("track")].map((el) => el.track.mode);
  assert.deepEqual(modes(), ["disabled", "disabled", "disabled", "disabled"], "every track starts hidden even when the engine would show one");
  assert.equal(ui.video().inBand.mode, "disabled", "an in-band default track is hidden too");
  assert.equal([...ui.video().querySelectorAll("track")].some((el) => el.default), false);
  await ui.click('#video-player [data-video="subtitle"][data-id="0"]', () => $('#video-player [data-video="subtitle"][aria-checked="true"]')?.textContent === "Spanish");
  assert.deepEqual(modes(), ["showing", "disabled", "disabled", "disabled"]);
  assert.equal(ui.video().inBand.mode, "disabled");
  await ui.click('#video-player [data-video="subtitle"][data-id="off"]', () => $('#video-player [data-video="subtitle"][aria-checked="true"]')?.textContent === "Off");
  assert.deepEqual(modes(), ["disabled", "disabled", "disabled", "disabled"]);
  ui.video().time = 3810;
  ui.press("Escape");
  await until(() => $("#video-player").hidden && ui.idle());
  assert.equal(ui.posts.filter(([route]) => route === "/v1/video/position").length, 3, "exit saves the position");
  assert.deepEqual(ui.revoked, ["blob:subtitle-1", "blob:subtitle-2", "blob:subtitle-3"]);
  assert.equal(ui.$("[inert]"), null);
  assert.equal(ui.$("[data-video-inert]"), null);
  assert.equal(ui.text(".video-backdrop h2"), "Inception", "the movie page is back");
  assert.equal(ui.text(".video-backdrop .heading-actions > button"), "Resume from 1:03:30");
});

test("Up next appears in the last 30 seconds, counts down and plays the next episode; Cancel keeps the credits", async (t) => {
  const ui = await boot(t);
  await library(ui);
  await ui.click('[data-action="video-tab"][data-id="shows"]', () => cardTitles(ui).includes("Breaking Bad"));
  await ui.click(ui.$$(".video-page .music-card").find((el) => el.textContent.includes("Breaking Bad")), () => ui.$(".video-episode"));
  await ui.click('.video-backdrop [data-action="video-play"]', () => ui.video()?.getAttribute("src"));
  const { $, w } = ui;
  assert.equal(ui.text("#video-player .video-top strong"), "Breaking Bad");
  assert.equal(ui.text("#video-player .video-top p"), "S1 · E4 · Cancer Man");
  ui.video().length = 1380;
  ui.video().dispatchEvent(new w.Event("loadedmetadata"));
  assert.match(ui.video().getAttribute("src"), /\/v1\/video\/hls\/.*S01E04\.mkv\/index\.m3u8\?from=1500$/, "an MKV plays as a compatible stream from the saved position");
  assert.equal(ui.video().currentTime, 0);
  assert.equal($('#video-player [data-video="seek"]').value, "1500");
  ui.video().time = 1360;
  ui.video().dispatchEvent(new w.Event("timeupdate"));
  assert.equal($("#video-player .video-upnext").hidden, false);
  assert.match($("#video-player .video-upnext").textContent, /Up next · plays in 10 s\s*S1 · E5 · Gray Matter\s*Play now\s*Cancel/);
  ui.fire(1000);
  assert.match(ui.text("#video-player .video-upnext .video-meta"), /plays in 9 s/);
  await ui.click('#video-player [data-video="upnext-cancel"]');
  assert.equal($("#video-player .video-upnext").hidden, true);
  ui.video().dispatchEvent(new w.Event("timeupdate"));
  assert.equal($("#video-player .video-upnext").hidden, true, "Cancel keeps the credits playing");
  const before = ui.posts.filter(([route]) => route === "/v1/video/position").length;
  ui.video().dispatchEvent(new w.Event("pause"));
  ui.video().dispatchEvent(new w.Event("ended"));
  await until(() => $("#video-player").hidden && ui.idle());
  assert.equal(ui.text(".video-backdrop h2"), "Breaking Bad");
  assert.equal(ui.posts.filter(([route]) => route === "/v1/video/position").length, before + 1, "the end of a video saves once");

  assert.deepEqual(ui.posts.filter(([route]) => route === "/v1/video/position").at(-1)[1].position, 2860);
  await until(() => ui.text(".video-backdrop .heading-actions > button") === "Play S1 · E5");
  assert.equal(ui.$$(".video-episode")[3].querySelector('[data-action="video-watched"]').getAttribute("aria-label"), "Mark as unwatched", "the credits count as watched");
  await ui.click('.video-backdrop [data-action="video-play"]', () => ui.video()?.getAttribute("src")?.includes("S01E05"));
  ui.video().length = 2880;
  ui.video().dispatchEvent(new w.Event("loadedmetadata"));
  ui.video().time = 2860;
  ui.video().dispatchEvent(new w.Event("timeupdate"));
  assert.match(ui.text("#video-player .video-upnext strong"), /S2 · E1 · Seven Thirty-Seven/);
  for (let i = 0; i < 10; i++) ui.fire(1000);
  await until(() => ui.video()?.getAttribute("src")?.includes("S02E01"));
  assert.equal(ui.text("#video-player .video-top p"), "S2 · E1 · Seven Thirty-Seven");
});

test("a file this window cannot decode offers Open in default app on desktop and the app hint on the web", async (t) => {
  const refuse = () => Promise.reject(new Error("This video can't be converted"));
  const hlsOnly = (type) => (type === "application/vnd.apple.mpegurl" ? "maybe" : "");
  const desktop = await boot(t, { canPlay: hlsOnly, compatible: refuse });
  await openMovie(desktop, "Dune Part Two");
  await desktop.click('.video-backdrop [data-action="video-start"]', () => desktop.$("#video-player .video-message:not([hidden])"));
  assert.equal(desktop.text("#video-player .video-message strong"), "This video can’t play in this window");
  assert.match(desktop.text("#video-player .video-message p"), /Its format \(HEVC video, E-AC3 audio\) isn’t supported here\. Your file is unchanged\./);
  assert.equal(desktop.text("#video-player .video-top p"), "2024 · 2160p · HEVC · E-AC3");
  assert.equal(desktop.routes.some((route) => route.startsWith("/v1/video/playback?")), false, "an MKV never tries direct play");
  assert.equal(desktop.routes.filter((route) => route.startsWith("/v1/video/compatible?")).length, 1, "the message shows only after the compatible stream fails");
  await desktop.click('#video-player [data-video="open"]', () => desktop.commands.some(([command]) => command === "open_file"));
  assert.deepEqual(JSON.parse(JSON.stringify(desktop.commands.find(([command]) => command === "open_file"))), ["open_file", { volume: "vid", path: "Dune.Part.Two.2024.2160p.WEB-DL.x265-GRP.mkv" }]);

  const web = await boot(t, { canPlay: hlsOnly, web: true, compatible: refuse });
  await openMovie(web, "Dune Part Two");
  await web.click('.video-backdrop [data-action="video-start"]', () => web.$("#video-player .video-message:not([hidden])"));
  assert.equal(web.$('#video-player [data-video="open"]'), null);
  assert.equal(web.text("#video-player .video-message .hint"), "Play it in the Arca app or arca TV.");
});

test("Fix match searches TMDB with the parsed title and applies a choice, Not a movie or show and the automatic match", async (t) => {
  const ui = await boot(t);
  await openMovie(ui);
  await ui.click('.video-menu [data-action="video-match"]', () => ui.$("#dialog .video-match-results .music-row strong"));
  assert.equal(ui.text("#dialog-title"), "Fix match");
  assert.equal(ui.text("#dialog .modal-title p"), "Inception.mp4 · searched as “Inception” (2010)");
  assert.equal(ui.$("#video-match-query").value, "Inception");
  assert.ok(ui.routes.includes("/v1/video/tmdb-search?query=Inception&type=movie&year=2010"));
  assert.deepEqual(ui.texts("#dialog .video-match-results .music-row strong"), ["Inception", "Not a movie or show", "Automatic match"]);
  assert.equal(ui.text("#dialog .video-match-results .music-row strong + span"), "2010 · Movie");
  assert.equal(ui.$("#submit-dialog").hidden, true);
  await until(() => ui.$("#dialog [data-video-tmdb] img"));
  await ui.click('#dialog [data-action="video-match-pick"]', () => ui.posts.some(([route]) => route === "/v1/video/match"));
  assert.deepEqual(ui.posts.find(([route]) => route === "/v1/video/match")[1], { volume: "vid", id: "m:inception", tmdb: { type: "movie", id: 27205 } });
  await until(() => !ui.$("#dialog[open]") && ui.idle());
  await ui.click('.video-menu [data-action="video-match"]', () => ui.$('#dialog [data-action="video-match-none"]'));
  await ui.click('#dialog [data-action="video-match-none"]', () => ui.posts.filter(([route]) => route === "/v1/video/match").length === 2);
  assert.deepEqual(ui.posts.filter(([route]) => route === "/v1/video/match")[1][1], { volume: "vid", id: "m:inception", none: true });
  await until(() => !ui.$("#dialog[open]") && ui.idle());
  await ui.click('.video-menu [data-action="video-match"]', () => ui.$('#dialog [data-action="video-match-reset"]'));
  await ui.click('#dialog [data-action="video-match-reset"]', () => ui.posts.filter(([route]) => route === "/v1/video/match").length === 3);
  assert.deepEqual(ui.posts.filter(([route]) => route === "/v1/video/match")[2][1], { volume: "vid", id: "m:inception", reset: true });
});

test("hub Settings shows TMDB with its state, one Content dropdown, Titles with Refresh metadata and the attribution", async (t) => {
  const ui = await boot(t, { route: "#/settings" });
  await until(() => ui.$("#video-settings .settings-card") && ui.idle());
  const section = ui.$("#video-settings");
  assert.ok(section.querySelector(".settings-card").classList.contains("video-settings-card"));
  assert.equal(ui.$$("#content .section-label").map((el) => el.textContent).filter((label) => ["Photos", "Movies & TV", "Movies & shows", "Images", "Video"].includes(label)).join(","), "Photos,Movies & TV");
  assert.equal(section.querySelector("select"), null, "no native select");
  const rows = [...section.querySelectorAll(".setting-row")];
  assert.deepEqual(rows.map((row) => row.querySelector("strong").textContent), ["TMDB", "Content", "Titles"]);
  assert.equal(rows[0].querySelector("p").textContent, "Connected · 7 of 8 titles matched. Posters, overviews and ratings come from TMDB.");
  assert.equal(rows[0].querySelector(".pill").textContent, "Connected");
  assert.deepEqual([...rows[0].querySelectorAll("button")].map((el) => el.textContent), ["Change…"]);
  assert.equal(ui.text("#video-content"), "Español · España");
  assert.equal(rows[1].querySelector("p").textContent, "Language of titles and overviews, and whose age ratings decide which movies are for Kids (G in the US, TP in Spain).");
  assert.deepEqual(ui.texts("#video-content-options [role=option]"), CONTENTS.map((row) => row.label));
  assert.equal(rows[2].querySelector("p").textContent, "video · 5 movies · 3 shows · 1 not recognised. Show it");
  assert.equal(section.querySelector(":scope > .hint").textContent, "This product uses the TMDB API but is not endorsed or certified by TMDB. themoviedb.org");
  assert.equal(section.querySelector(":scope > .hint a").href, "https://www.themoviedb.org/");
  await ui.click("#video-content", () => !ui.$("#video-content-options").hidden);
  await ui.click('#video-content-options [data-id="en-GB"]', () => ui.posts.length === 1);
  assert.deepEqual(ui.posts[0], ["/v1/video/settings", { content: "en-GB" }]);
  await until(() => ui.$('#video-settings [data-action="video-refresh"]') && ui.idle());
  await ui.click('#video-settings [data-action="video-refresh"]', () => ui.posts.length === 2);
  assert.deepEqual(ui.posts[1], ["/v1/video/refresh", {}]);
  await until(() => ui.$('#video-settings [data-action="video-show-unmatched"]') && ui.idle());
  await ui.click('#video-settings [data-action="video-show-unmatched"]', () => ui.$(".video-page .music-card") && ui.idle());
  assert.equal(ui.text('.video-page .segmented button[aria-pressed="true"]'), "Others");
  const css = fs.readFileSync(new URL("../apps/desktop/src/style.css", import.meta.url), "utf8");
  assert.match(css, /\.settings-card\.video-settings-card \{\s*overflow: visible;\s*\}/, "the Content list is not clipped by the card");
  assert.match(css, /\.dropdown-menu \{[^}]*max-height: min\(280px, 50vh\);\s*overflow-y: auto;/, "a long Content list scrolls");
});

test("TMDB states: no key shows only the row and Add key…, matching disables Refresh, refused hides Titles", async (t) => {
  const none = await boot(t, { route: "#/settings", settings: () => ({ ...SETTINGS, tokenSet: false, state: "none" }) });
  await until(() => none.$("#video-settings .settings-card") && none.idle());
  assert.deepEqual(none.texts("#video-settings .setting-row strong"), ["TMDB"]);
  assert.equal(none.text("#video-settings .setting-row p"), "Optional. Adds posters, overviews and ratings. Get a free key at themoviedb.org.");
  assert.equal(none.text('#video-settings [data-action="video-key"]'), "Add key…");
  assert.equal(none.$("#video-settings > .hint"), null);
  await none.click('#video-settings [data-action="video-key"]', () => none.$("#dialog[open]"));
  assert.equal(none.text("#dialog-title"), "TMDB key");
  assert.equal(none.$('#dialog input[name="tmdbToken"]').type, "password");
  assert.equal(none.$('#dialog input[name="tmdbToken"]').placeholder, "API key or Read Access Token");
  assert.equal(none.text("#dialog-content .hint"), "Only titles and years are sent to TMDB, never file names of home videos.");
  assert.equal(none.$('[data-action="video-key-remove"]'), null, "nothing to remove yet");
  none.$('#dialog input[name="tmdbToken"]').value = " eyJkey ";
  await none.click("#submit-dialog", () => none.posts.length === 1);
  assert.deepEqual(none.posts[0], ["/v1/video/settings", { tmdbToken: "eyJkey" }]);

  const matching = await boot(t, { route: "#/settings", settings: () => ({ ...SETTINGS, state: "matching", matched: 3 }) });
  await until(() => matching.$("#video-settings .settings-card") && matching.idle());
  assert.equal(matching.text("#video-settings .setting-row p"), "Matching 3 of 8 titles…");
  assert.equal(matching.text("#video-settings .pill"), "Matching");
  assert.equal(matching.$('#video-settings [data-action="video-refresh"]').disabled, true);
  assert.equal(matching.$$("#video-settings .image-process-hint p")[0].textContent, "video · 5 movies · 3 shows · matching 3 of 8 with TMDB…");
  await matching.click('#video-settings [data-action="video-key"]', () => matching.$('#dialog [data-action="video-key-remove"]'));
  assert.ok(matching.$('[data-action="video-key-remove"]').classList.contains("danger"));
  await matching.click('[data-action="video-key-remove"]', () => matching.posts.some(([route]) => route === "/v1/video/settings"));
  assert.deepEqual(matching.posts.find(([route]) => route === "/v1/video/settings")[1], { tmdbToken: "" });

  const refused = await boot(t, { route: "#/settings", settings: () => ({ ...SETTINGS, state: "refused" }) });
  await until(() => refused.$("#video-settings .settings-card") && refused.idle());
  assert.deepEqual(refused.texts("#video-settings .setting-row strong"), ["TMDB", "Content"]);
  assert.equal(refused.text("#video-settings .pill"), "Refused");
  assert.equal(refused.text("#video-settings .setting-row p"), "TMDB refused this key. Check it at themoviedb.org → Settings → API; the API key and the Read Access Token both work.");

  const replica = await boot(t, { route: "#/settings", status: { ...hubStatus(), id: "mac", role: "replica", hub: "http://casa", hubId: "hub" } });
  await until(() => replica.$$("#content section").length && replica.idle());
  assert.equal(replica.$("#video-settings"), null, "only the hub configures TMDB");
  const video = replica.$$("#content section").find((el) => el.querySelector(".section-label")?.textContent === "Movies & TV");
  assert.equal(video.querySelector(".hint").textContent, "Movies & TV settings live on the hub’s web page.");
  assert.equal(replica.routes.some((route) => route.startsWith("/v1/video/settings")), false);
  assert.equal(replica.$("#video-kids-mode"), null, "there is no Kids mode");
});
test("a desktop replica opens an unselected video folder on its library through its own daemon", async (t) => {
  const ui = await boot(t, {
    route: "#/folders",
    status: { id: "mac", name: "Mac", role: "replica", phase: "idle", hub: "http://casa", hubId: "hub", hubName: "Casa", volumes: [] },
    remote: { name: "Casa", volumes: [{ id: "vid", name: "video", video: true, files: 318, bytes: 2 * 1024 ** 4 }, { id: "docs", name: "documents", files: 3, bytes: 900 }] },
  });
  await until(() => ui.$('.folder-card[data-id="vid"]') && ui.idle());
  const card = ui.$('.folder-card[data-id="vid"]');
  assert.equal(card.classList.contains("unselected"), false, "a hub-only video folder is not an unselected folder waiting to sync");
  assert.match(card.textContent, /Streams from hub/);
  const sections = ui.$$(".page section, .page .section").map((el) => el.textContent);
  assert.ok(sections.some((text) => /Movies & TV/.test(text) && /Streams from hub/.test(text)), "it sits in Movies & TV");
  assert.ok(sections.some((text) => /On hub · not selected/.test(text) && /documents/.test(text) && !/Streams from hub/.test(text)), "only syncable folders stay under On hub · not selected");
  await ui.click('.folder-card[data-id="vid"]', () => ui.$(".video-page .music-card") && ui.idle());
  assert.ok(ui.routes.some((route) => route === "/v1/video/library?volume=vid"));
  assert.equal(ui.$('[data-action="video-mode"]'), null, "no files to view without a local copy");
  assert.ok(ui.$('.video-page ~ * .favorite-star, #content .favorite-star'), "the streamed folder can still be a favorite");
  await ui.click('[data-action="video-tab"][data-id="movies"]', () => cardTitles(ui).includes("Inception"));
  await ui.click(ui.$$(".video-page .music-card").find((el) => el.textContent.includes("Inception")), () => ui.$(".video-backdrop"));
  assert.equal(ui.$(".video-menu"), null, "Fix match and kids overrides belong to the hub admin, and an unselected copy cannot reveal or delete");
});

test("Search Arca lists Videos and opens a title page", async (t) => {
  const ui = await boot(t, {
    search: {
      groups: [
        {
          type: "videos",
          count: 2,
          rows: [
            { volume: "vid", id: "m:inception", kind: "movie", title: "Inception", year: 2010, poster: "p-inception" },
            { volume: "vid", id: "e:Breaking Bad/S1E4", kind: "episode", title: "Cancer Man", show: "Breaking Bad", showId: "s:breaking bad", season: 1, episode: 4, path: "Breaking Bad/Season 1/S01E04.mkv" },
          ],
        },
      ],
    },
  });
  await library(ui);
  const dialog = () => ui.w.document.getElementById("palette");
  ui.press("k", ui.w.document.body, { metaKey: true });
  const input = dialog().querySelector(".pal-input");
  input.value = "inc";
  input.dispatchEvent(new ui.w.Event("input", { bubbles: true }));
  const group = () => [...dialog().querySelectorAll(".pal-group")].find((el) => el.getAttribute("aria-label") === "Movies & TV");
  await until(() => group()?.querySelector("[data-pal]"));
  assert.deepEqual([...group().querySelectorAll("[data-pal] p")].map((el) => el.textContent), ["Movie · 2010", "Breaking Bad · S1 · E4"]);
  assert.ok(group().querySelector("[data-video-art]"));
  ui.press("ArrowDown", input);
  ui.press("Enter", input);
  await until(() => !dialog().open && ui.text(".video-backdrop h2") === "Breaking Bad" && ui.idle());
  assert.deepEqual(ui.texts("#content .music-trail :is(button, [aria-current])"), ["Folders", "video", "TV Shows", "Breaking Bad"]);
});

test("a selected replica shows the item menu without hub-only actions", async (t) => {
  const ui = await boot(t, { status: { ...hubStatus(), id: "mac", name: "Mac", role: "replica", hub: "http://casa", hubId: "hub" } });
  await openMovie(ui);
  assert.deepEqual(ui.texts(".video-menu .menu-items button"), ["Delete…"]);
  const crumb = ui.$$("#content .music-trail button").find((el) => el.textContent.trim() === "Movies");
  await ui.click(crumb, () => ui.$(".video-tools .video-sort"));
  await ui.click('[data-action="video-tab"][data-id="shows"]', () => cardTitles(ui).includes("Breaking Bad"));
  await ui.click(ui.$$(".video-page .music-card").find((el) => el.textContent.includes("Breaking Bad")), () => ui.$(".video-episode"));
  assert.equal(ui.$(".video-menu"), null, "with nothing to offer there is no ⋯ at all");
});

test("an offline replica says to connect to the hub instead of blaming the format", async (t) => {
  const ui = await boot(t, {
    status: { ...hubStatus(), id: "mac", name: "Mac", role: "replica", hub: "http://casa", hubId: "hub", volumes: [{ ...base, id: "vid", name: "video", video: true, selected: 0 }] },
    playback: () => Promise.reject("Connect to your hub to watch"),
  });
  await openMovie(ui);
  await ui.click('.video-backdrop [data-action="video-resume"]', () => ui.$("#video-player .video-message:not([hidden])"));
  assert.equal(ui.text("#video-player .video-message strong"), "Connect to your hub to watch");
  assert.equal(ui.$('#video-player [data-video="open"]'), null);
  assert.doesNotMatch(ui.text("#video-player .video-message"), /format/);
});

test("a short clip near its end is only finished within the hub's margin", async (t) => {
  const ui = await boot(t);
  await library(ui);
  await ui.click('[data-action="video-tab"][data-id="other"]', () => cardTitles(ui).includes("Beach"));
  await openPlayer(ui, '.video-page .music-card[data-action="video-play"]');
  ui.video().length = 300;
  ui.video().time = 250;
  ui.press("Escape");
  await until(() => ui.$("#video-player").hidden && ui.idle());
  assert.equal(ui.text(".video-page .music-card > span:last-child"), "1 min left", "250 of 300 s is still in progress");
  assert.equal(ui.$(".video-page .video-watched"), null);
});

test("the web player uses same-origin subtitle URLs", async (t) => {
  const ui = await boot(t, { web: true });
  await openMovie(ui);
  await ui.click('.video-backdrop [data-action="video-resume"]', () => ui.video()?.querySelectorAll("track").length === 3);
  assert.deepEqual([...ui.video().querySelectorAll("track")].map((el) => el.getAttribute("src")), [
    "/v1/video/subtitles?volume=vid&path=Inception.es.srt",
    "/v1/video/subtitles?volume=vid&path=Inception.en.srt",
    null,
  ]);
  await ui.click('#video-player [data-video="subtitle"][data-id="2"]', () => ui.video().querySelectorAll("track")[2].getAttribute("src"));
  assert.equal(ui.video().querySelectorAll("track")[2].getAttribute("src"), "/v1/video/subtitles?volume=vid&path=Inception.mp4&hash=h-Inception.mp4&stream=0", "the embedded track loads by URL on the web");
});

test("the desktop app's CSP lets the player load subtitle tracks built as blob URLs", () => {
  const conf = JSON.parse(fs.readFileSync(new URL("../apps/desktop/src-tauri/tauri.conf.json", import.meta.url), "utf8"));
  for (const key of ["csp", "devCsp"]) {
    const media = conf.app.security[key].split(";").map((part) => part.trim()).find((part) => part.startsWith("media-src"));
    assert.ok(media.split(/\s+/).includes("blob:"), `${key} media-src allows blob:`);
  }
});

test("an untagged sidecar is labelled Subtitles with its shortened file name", async (t) => {
  const ui = await boot(t, {
    playback: () => ({
      url: "http://127.0.0.1:1/v1/video/media?ticket=x",
      subtitles: [
        { path: "300.srt", label: "", language: null },
        { path: "Movies/300.Rise.of.an.Empire.2014.1080p.BluRay.srt", label: "", language: null },
      ],
    }),
  });
  await openMovie(ui);
  await ui.click('.video-backdrop [data-action="video-resume"]', () => ui.video()?.querySelectorAll("track").length === 3);
  assert.deepEqual([...ui.video().querySelectorAll("track")].map((el) => el.label), ["Subtitles · 300", "Subtitles · 300.Rise.of.an.Empire.2…", "French"]);
  assert.deepEqual(ui.texts("#video-player .video-subtitles .menu-items button"), ["Off", "Subtitles · 300", "Subtitles · 300.Rise.of.an.Empire.2…", "French"]);
  assert.deepEqual([...ui.video().querySelectorAll("track")].map((el) => el.track.mode), ["disabled", "disabled", "disabled"]);
});

test("an episode row highlights as one, the watched toggle included", () => {
  const css = fs.readFileSync(new URL("../apps/desktop/src/style.css", import.meta.url), "utf8");
  assert.match(css, /@media \(hover: hover\) \{\s*\.video-episode:hover \{\s*background: var\(--paper\);/);
  assert.match(css, /\.video-episode:has\(:active\) \{\s*background: var\(--press\);/);
  assert.match(css, /\.video-episode > \.icon-button:hover,\s*\.video-episode > \.icon-button:active \{\s*background: transparent;/);
  assert.doesNotMatch(css, /\.video-episode-play:hover/);
});

test("the poster rating badge sits bottom-left over a scrim in tokens", () => {
  const css = fs.readFileSync(new URL("../apps/desktop/src/style.css", import.meta.url), "utf8");
  assert.match(css, /\.video-rating \{\s*position: absolute;\s*left: var\(--space-2\);\s*bottom: var\(--space-2\);[^}]*border-radius: var\(--r-tag\);\s*background: var\(--mediaFade\);\s*color: var\(--onMedia\);\s*font: 600 var\(--text-caption\)/);
});

test("the ⋯ offers Fix match only with a working TMDB key and Mark as kids only for titles without TMDB data", async (t) => {
  const matched = () => {
    const data = sampleLibrary();
    data.movies[0].matched = true;
    return data;
  };
  const withKey = await boot(t, { library: matched });
  await openMovie(withKey);
  assert.deepEqual(withKey.texts(".video-menu .menu-items button"), ["Fix match…", "Delete…"]);
  const unmatched = await boot(t, { settings: () => ({ ...SETTINGS, state: "matching" }) });
  await openMovie(unmatched);
  assert.deepEqual(unmatched.texts(".video-menu .menu-items button"), ["Fix match…", "Mark as kids", "Delete…"]);
  const noKey = await boot(t, { settings: () => ({ ...SETTINGS, tokenSet: false, state: "none" }) });
  await openMovie(noKey);
  assert.deepEqual(noKey.texts(".video-menu .menu-items button"), ["Mark as kids", "Delete…"]);
  const refused = await boot(t, { library: matched, settings: () => ({ ...SETTINGS, state: "refused" }) });
  await openMovie(refused);
  assert.deepEqual(refused.texts(".video-menu .menu-items button"), ["Delete…"], "Delete alone keeps the ⋯");
});

test("a file with several audio tracks gets an Audio menu that switches tracks and is remembered per show", async (t) => {
  const tracks = (first, second) => [
    { stream: 0, codec: "ac3", language: first, label: first === "en" ? "English" : "Spanish", channels: first === "en" ? 6 : 2, default: true },
    { stream: 1, codec: "aac", language: second, label: second === "en" ? "English" : "Spanish", channels: second === "en" ? 6 : 2, default: false },
  ];
  const data = () => {
    const value = sampleLibrary();
    const season = value.shows[0].seasons.find((row) => row.season === 1);
    season.episodes.find((row) => row.episode === 4).audioTracks = tracks("en", "es");
    season.episodes.find((row) => row.episode === 5).audioTracks = tracks("es", "en");
    return value;
  };
  const ui = await boot(t, { audioTracks: true, library: data });
  await openMovie(ui);
  await openPlayer(ui, '.video-backdrop [data-action="video-resume"]');
  assert.deepEqual(ui.texts("#video-player .video-audio .menu-items button"), ["English · 5.1", "Spanish · 2.0"]);
  assert.equal(ui.text('#video-player .video-audio [aria-checked="true"]'), "English · 5.1", "the default track is selected");
  await ui.click('#video-player [data-video="audio"][data-id="1"]', () => ui.text('#video-player .video-audio [aria-checked="true"]') === "Spanish · 2.0");
  assert.deepEqual(ui.video().audioTracks.map((track) => track.enabled), [false, true], "only the chosen track plays");
  ui.press("Escape");
  await until(() => ui.$("#video-player").hidden && ui.idle());

  const crumb = ui.$$("#content .music-trail button").find((el) => el.textContent.trim() === "Movies");
  await ui.click(crumb, () => ui.$(".video-tools .video-sort"));
  await ui.click('[data-action="video-tab"][data-id="shows"]', () => cardTitles(ui).includes("Breaking Bad"));
  await ui.click(ui.$$(".video-page .music-card").find((el) => el.textContent.includes("Breaking Bad")), () => ui.$(".video-episode"));
  await openPlayer(ui, '.video-backdrop [data-action="video-play"]');
  await ui.click('#video-player [data-video="audio"][data-id="1"]', () => ui.text('#video-player .video-audio [aria-checked="true"]') === "Spanish · 2.0");
  ui.video().length = 2880;
  ui.video().time = 2860;
  ui.video().dispatchEvent(new ui.w.Event("timeupdate"));
  await ui.click('#video-player [data-video="upnext-play"]', () => ui.video()?.getAttribute("src")?.includes("S01E05"));
  ui.video().dispatchEvent(new ui.w.Event("loadedmetadata"));
  assert.equal(ui.text('#video-player .video-audio [aria-checked="true"]'), "Spanish · 2.0", "the next episode keeps Spanish");
  assert.equal(ui.$('#video-player .video-audio [aria-checked="true"]').dataset.id, "0", "mapped by its own order");
});

test("a single audio track, or an engine without audioTracks, shows no Audio menu", async (t) => {
  const engine = await boot(t);
  await openMovie(engine);
  await openPlayer(engine, '.video-backdrop [data-action="video-resume"]');
  assert.equal(engine.$("#video-player .video-audio"), null);
  const single = await boot(t, { audioTracks: true });
  await openMovie(single, "Arrival");
  await openPlayer(single, '.video-backdrop [data-action="video-start"]');
  assert.equal(single.$("#video-player .video-audio"), null);
});

test("the Audio menu follows the engine's tracks, labelled from the hub by language, and hides when they don't reconcile", async (t) => {
  const reordered = await boot(t, { audioTracks: () => [{ language: "spa", enabled: true }, { language: "eng", enabled: false }] });
  await openMovie(reordered);
  await openPlayer(reordered, '.video-backdrop [data-action="video-resume"]');
  assert.deepEqual(reordered.texts("#video-player .video-audio .menu-items button"), ["Spanish · 2.0", "English · 5.1"]);
  assert.equal(reordered.text('#video-player .video-audio [aria-checked="true"]'), "English · 5.1", "the hub's default track, wherever the engine lists it");
  assert.deepEqual(reordered.video().audioTracks.map((track) => track.enabled), [false, true]);
  await reordered.click('#video-player [data-video="audio"][data-id="0"]', () => reordered.text('#video-player .video-audio [aria-checked="true"]') === "Spanish · 2.0");
  assert.deepEqual(reordered.video().audioTracks.map((track) => track.enabled), [true, false]);

  const fewer = await boot(t, { audioTracks: () => [{ language: "eng", enabled: true }] });
  await openMovie(fewer);
  await openPlayer(fewer, '.video-backdrop [data-action="video-resume"]');
  assert.equal(fewer.$("#video-player .video-audio"), null, "one engine track, no menu");
  assert.deepEqual(fewer.video().audioTracks.map((track) => track.enabled), [true], "nothing is disabled");

  const foreign = await boot(t, { audioTracks: () => [{ language: "fra", enabled: true }, { language: "deu", enabled: false }] });
  await openMovie(foreign);
  await openPlayer(foreign, '.video-backdrop [data-action="video-resume"]');
  assert.equal(foreign.$("#video-player .video-audio"), null, "tracks that cannot be matched hide the menu");
  assert.deepEqual(foreign.video().audioTracks.map((track) => track.enabled), [true, false]);
});

test("Mark as kids stays on a matched title that carries a kids override, so it can be undone", async (t) => {
  const ui = await boot(t, {
    library: () => {
      const data = sampleLibrary();
      Object.assign(data.movies[0], { matched: true, kids: true, kidsOverride: true });
      return data;
    },
  });
  await openMovie(ui, "Inception", "kids");
  assert.deepEqual(ui.texts(".video-menu .menu-items button"), ["Fix match…", "Not for kids", "Use automatic Kids", "Delete…"]);
  await ui.click('.video-menu [data-action="video-kids-auto"]', () => ui.posts.some(([route]) => route === "/v1/video/kids"));
  assert.deepEqual(ui.posts.find(([route]) => route === "/v1/video/kids")[1], { volume: "vid", id: "m:inception", kids: null });
});

test("the library answer's tmdb state drives Fix match without reading Settings", async (t) => {
  const ui = await boot(t, { library: () => ({ ...sampleLibrary(), tmdb: "connected" }), settings: () => ({ ...SETTINGS, state: "none" }) });
  await openMovie(ui);
  assert.deepEqual(ui.texts(".video-menu .menu-items button"), ["Fix match…", "Mark as kids", "Delete…"]);
  assert.equal(ui.routes.some((route) => route.startsWith("/v1/video/settings")), false);
});

test("the settings card keeps its rounded corners while the Content list overflows", () => {
  const css = fs.readFileSync(new URL("../apps/desktop/src/style.css", import.meta.url), "utf8");
  assert.match(css, /\.settings-card\.video-settings-card > \.setting-row:first-child \{\s*border-top-left-radius: var\(--r-control\);\s*border-top-right-radius: var\(--r-control\);/);
  assert.match(css, /\.settings-card\.video-settings-card > \.setting-row:last-child \{\s*border-bottom-left-radius: var\(--r-control\);\s*border-bottom-right-radius: var\(--r-control\);/);
});

test("Folders groups libraries as Photos, Audio and Movies & TV, and a gallery's toggle reads Photos", async (t) => {
  const ui = await boot(t, {
    route: "#/folders",
    status: hubStatus([
      { ...base, id: "docs", name: "documents", path: "/srv/docs" },
      { ...base, id: "pics", name: "pictures", path: "/srv/pics", gallery: true },
      { ...base, id: "songs", name: "songs", path: "/srv/songs", music: true },
      { ...base, id: "vid", name: "video", path: "/srv/video", video: true },
    ]),
  });
  await until(() => ui.$('.folder-card[data-id="vid"]') && ui.idle());
  assert.deepEqual(ui.texts("#content .section-label"), ["Folders", "Photos", "Audio", "Movies & TV"]);
  const app = fs.readFileSync(new URL("../apps/desktop/src/app.js", import.meta.url), "utf8");
  assert.match(app, /folderTab === "gallery" \? "View folder" : "Photos",/);
  assert.doesNotMatch(app, /"Gallery",|Movies &amp; shows|"Videos", "video"/);
});

test("a narrow window stacks the banner in a media block that comes after the base rule", () => {
  const css = fs.readFileSync(new URL("../apps/desktop/src/style.css", import.meta.url), "utf8");
  const base = css.indexOf(".video-backdrop {\n  position: relative;");
  const narrow = css.lastIndexOf("@media screen and (max-width: 760px) {");
  assert.ok(base > 0 && narrow > base, "the override is not shadowed by the base rule");
  assert.match(css.slice(narrow), /^@media screen and \(max-width: 760px\) \{\s*\.video-backdrop \{\s*flex-direction: column;\s*align-items: flex-start;/);
});

test("a show's banner badges come from the episode Play starts", async (t) => {
  const ui = await boot(t, {
    library: () => {
      const data = sampleLibrary();
      const season = data.shows[0].seasons.find((row) => row.season === 1);
      Object.assign(season.episodes.find((row) => row.episode === 4), { width: 3840, height: 2160 });
      return data;
    },
  });
  await library(ui);
  await ui.click('[data-action="video-tab"][data-id="shows"]', () => cardTitles(ui).includes("Breaking Bad"));
  await ui.click(ui.$$(".video-page .music-card").find((el) => el.textContent.includes("Breaking Bad")), () => ui.$(".video-backdrop .video-facts"));
  assert.equal(ui.text(".video-backdrop .heading-actions > button"), "Play S1 · E4");
  assert.deepEqual(ui.texts(".video-backdrop .video-facts .video-badge"), ["16", "4K"], "S1 · E4 is 2160p while the first episode is 1080p");
});

const compatibleRoutes = (ui) => ui.routes.filter((route) => route.startsWith("/v1/video/compatible?")).map((route) => Object.fromEntries(new URLSearchParams(route.split("?")[1])));
const openEpisode = async (ui) => {
  await library(ui);
  await ui.click('[data-action="video-tab"][data-id="shows"]', () => cardTitles(ui).includes("Breaking Bad"));
  await ui.click(ui.$$(".video-page .music-card").find((el) => el.textContent.includes("Breaking Bad")), () => ui.$(".video-episode"));
  await ui.click('.video-backdrop [data-action="video-play"]', () => ui.video()?.getAttribute("src"));
  ui.video().length = 1380;
  ui.video().dispatchEvent(new ui.w.Event("loadedmetadata"));
};

test("direct play for MP4 with playable audio, a compatible stream for MKV or other audio", async (t) => {
  const direct = await boot(t);
  await openMovie(direct);
  await openPlayer(direct, '.video-backdrop [data-action="video-resume"]');
  assert.equal(compatibleRoutes(direct).length, 0);
  assert.ok(direct.routes.some((route) => route.startsWith("/v1/video/playback?")));

  const dts = await boot(t, {
    library: () => {
      const data = sampleLibrary();
      data.movies[0].audioTracks = [{ stream: 0, codec: "dts", language: "en", label: "English", channels: 6, default: true }];
      return data;
    },
  });
  await openMovie(dts);
  await dts.click('.video-backdrop [data-action="video-resume"]', () => dts.video()?.getAttribute("src"));
  assert.equal(dts.routes.some((route) => route.startsWith("/v1/video/playback?")), false);
  assert.deepEqual(compatibleRoutes(dts), [{ volume: "vid", path: "Inception.mp4", hash: "h-Inception.mp4", start: "3730", copy: "ac3,eac3" }]);
  assert.match(dts.text("#video-player .video-top p"), /2010/);

  const episode = await boot(t);
  await openEpisode(episode);
  assert.deepEqual(compatibleRoutes(episode).map((query) => query.start), ["1500"], "one request, no double start");
});

test("a direct file the window cannot decode falls back to the compatible stream at the same point", async (t) => {
  const ui = await boot(t);
  await openMovie(ui);
  await openPlayer(ui, '.video-backdrop [data-action="video-resume"]');
  Object.defineProperty(ui.video(), "error", { configurable: true, get: () => ({ code: 4 }) });
  ui.video().time = 3800;
  ui.video().dispatchEvent(new ui.w.Event("error"));
  await until(() => compatibleRoutes(ui).length === 1 && ui.idle());
  assert.equal(compatibleRoutes(ui)[0].start, "3800");
  assert.equal(compatibleRoutes(ui)[0].copy, "ac3,eac3", "WebKit plays AC3 and E-AC3, so the hub copies them");
  assert.equal(ui.$("#video-player .video-message").hidden, true, "no unsupported message while the compatible stream works");
});

test("in a compatible stream time and positions are absolute, and seeking beyond restarts once after 300 ms keeping play state", async (t) => {
  const ui = await boot(t);
  await openEpisode(ui);
  ui.video().length = 200;
  ui.video().time = 100;
  ui.video().dispatchEvent(new ui.w.Event("timeupdate"));
  assert.equal(ui.text('#video-player [data-video-time="elapsed"]'), "26:40", "1500 + 100 s");
  assert.equal(ui.text('#video-player [data-video-time="total"]'), "48:00", "the library's full length");
  ui.video().pause();
  await until(() => ui.posts.some(([route]) => route === "/v1/video/position"));
  assert.equal(ui.posts.find(([route]) => route === "/v1/video/position")[1].position, 1600);
  ui.video().play();
  const seek = ui.$('#video-player [data-video="seek"]');
  seek.value = "1550";
  seek.dispatchEvent(new ui.w.Event("input", { bubbles: true }));
  assert.equal(ui.video().currentTime, 50, "inside what the stream already produced it just seeks");
  seek.value = "2400";
  seek.dispatchEvent(new ui.w.Event("input", { bubbles: true }));
  seek.value = "2500";
  seek.dispatchEvent(new ui.w.Event("input", { bubbles: true }));
  assert.equal(ui.text('#video-player [data-video-time="elapsed"]'), "41:40", "the scrubber shows the target at once");
  assert.equal(compatibleRoutes(ui).length, 1, "no request before the debounce");
  ui.fire(300);
  await until(() => compatibleRoutes(ui).length === 2 && ui.video().getAttribute("src").includes("from=2500"));
  assert.equal(compatibleRoutes(ui)[1].start, "2500");
  assert.equal(ui.video().paused, false, "it keeps playing");
});

test("subtitle cues are shifted by the stream offset when they load", async (t) => {
  const ui = await boot(t);
  await openEpisode(ui);
  assert.equal(ui.video().querySelectorAll("track").length, 0, "the episode has no sidecars");
  const movie = await boot(t, { library: () => {
    const data = sampleLibrary();
    data.movies[0].path = "Inception.mkv";
    data.movies[0].subtitles = [{ path: "Inception.es.srt", language: "es", label: "Spanish" }];
    return data;
  } });
  await openMovie(movie);
  await movie.click('.video-backdrop [data-action="video-resume"]', () => movie.video()?.querySelector("track"));
  const element = movie.video().querySelector("track");
  element.dispatchEvent(new movie.w.Event("load"));
  assert.deepEqual([element.track.cues[0].startTime, element.track.cues[0].endTime], [1600 - 3730, 1602 - 3730]);
  element.dispatchEvent(new movie.w.Event("load"));
  assert.equal(element.track.cues[0].startTime, 1600 - 3730, "shifting twice never doubles");
});

test("on a compatible stream the Audio menu lists the hub's tracks and a choice starts a new session with that audio", async (t) => {
  const ui = await boot(t, {
    library: () => {
      const data = sampleLibrary();
      data.shows[0].seasons.find((row) => row.season === 1).episodes.find((row) => row.episode === 4).audioTracks = [
        { stream: 0, codec: "ac3", language: "en", label: "English", channels: 6, default: true },
        { stream: 1, codec: "aac", language: "es", label: "Spanish", channels: 2, default: false },
      ];
      return data;
    },
  });
  await openEpisode(ui);
  assert.deepEqual(ui.texts("#video-player .video-audio .menu-items button"), ["English · 5.1", "Spanish · 2.0"]);
  ui.video().time = 60;
  await ui.click('#video-player [data-video="audio"][data-id="1"]', () => compatibleRoutes(ui).length === 2 && ui.video().getAttribute("src").includes("from=1560"));
  assert.deepEqual(compatibleRoutes(ui)[1], { volume: "vid", path: "Breaking Bad/Season 1/S01E04.mkv", hash: "h-Breaking Bad/Season 1/S01E04.mkv", start: "1560", audio: "1", copy: "ac3,eac3" });
  assert.equal(ui.text('#video-player .video-audio [aria-checked="true"]'), "Spanish · 2.0");
});

test("closing the player cancels a pending seek restart", async (t) => {
  const ui = await boot(t);
  await openEpisode(ui);
  const seek = ui.$('#video-player [data-video="seek"]');
  seek.value = "2600";
  seek.dispatchEvent(new ui.w.Event("input", { bubbles: true }));
  ui.press("Escape");
  await until(() => ui.$("#video-player").hidden && ui.idle());
  ui.fire(300);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(compatibleRoutes(ui).length, 1);
});

test("a busy hub says so instead of the format message", async (t) => {
  const ui = await boot(t, { compatible: () => Promise.reject(new Error("The hub is busy with another video. Try again in a moment.")) });
  await library(ui);
  await ui.click('[data-action="video-tab"][data-id="shows"]', () => cardTitles(ui).includes("Breaking Bad"));
  await ui.click(ui.$$(".video-page .music-card").find((el) => el.textContent.includes("Breaking Bad")), () => ui.$(".video-episode"));
  await ui.click('.video-backdrop [data-action="video-play"]', () => ui.$("#video-player .video-message:not([hidden])"));
  assert.equal(ui.text("#video-player .video-message strong"), "The hub is busy");
  assert.equal(ui.text("#video-player .video-message p"), "The hub is busy with another video. Try again in a moment.");
});

test("an event stream with an endless duration seeks locally inside its seekable range and restarts only beyond it", async (t) => {
  const ui = await boot(t);
  await openEpisode(ui);
  ui.video().length = Infinity;
  ui.video().ranges = 300;
  ui.video().time = 10;
  ui.video().dispatchEvent(new ui.w.Event("timeupdate"));
  await ui.click('#video-player [data-video="forward30"]');
  assert.equal(ui.video().currentTime, 40, "Forward 30 s inside what is produced moves locally");
  const seek = ui.$('#video-player [data-video="seek"]');
  seek.value = "1750";
  seek.dispatchEvent(new ui.w.Event("input", { bubbles: true }));
  assert.equal(ui.video().currentTime, 250);
  ui.fire(300);
  assert.equal(compatibleRoutes(ui).length, 1, "no restart inside the seekable range");
  seek.value = "2000";
  seek.dispatchEvent(new ui.w.Event("input", { bubbles: true }));
  ui.fire(300);
  await until(() => compatibleRoutes(ui).length === 2);
  assert.equal(compatibleRoutes(ui)[1].start, "2000");
});

test("a direct file that fails falls back to the compatible stream keeping the chosen audio", async (t) => {
  const ui = await boot(t, { audioTracks: () => [{ language: "spa", enabled: false }, { language: "eng", enabled: true }] });
  await openMovie(ui);
  await openPlayer(ui, '.video-backdrop [data-action="video-resume"]');
  assert.equal(compatibleRoutes(ui).length, 0, "direct first");
  await ui.click('#video-player [data-video="audio"][data-id="0"]', () => ui.text('#video-player .video-audio [aria-checked="true"]') === "Spanish · 2.0");
  Object.defineProperty(ui.video(), "error", { configurable: true, get: () => ({ code: 4 }) });
  ui.video().time = 1600;
  ui.video().dispatchEvent(new ui.w.Event("error"));
  await until(() => compatibleRoutes(ui).length === 1 && ui.idle());
  assert.deepEqual([compatibleRoutes(ui)[0].start, compatibleRoutes(ui)[0].audio], ["1600", "1"], "Spanish is the hub's stream 1 though the engine listed it first");
});

test("without native HLS a file the window cannot decode says so after direct play and never opens a compatible stream", async (t) => {
  const noHls = (type) => (type === "application/vnd.apple.mpegurl" ? "" : "maybe");
  const ui = await boot(t, { canPlay: noHls });
  await openEpisode(ui);
  assert.ok(ui.routes.some((route) => route.startsWith("/v1/video/playback?") && route.includes("S01E04")), "direct play");
  Object.defineProperty(ui.video(), "error", { configurable: true, get: () => ({ code: 4 }) });
  ui.video().dispatchEvent(new ui.w.Event("error"));
  await until(() => ui.$("#video-player .video-message:not([hidden])") && ui.idle());
  assert.equal(ui.text("#video-player .video-message strong"), "This video can’t play in this window");
  assert.equal(compatibleRoutes(ui).length, 0);

  const blank = await boot(t, { canPlay: noHls });
  await openMovie(blank);
  await blank.click('.video-backdrop [data-action="video-resume"]', () => blank.video()?.getAttribute("src"));
  Object.defineProperty(blank.video(), "videoWidth", { configurable: true, get: () => 0 });
  blank.video().dispatchEvent(new blank.w.Event("loadedmetadata"));
  await until(() => blank.$("#video-player .video-message:not([hidden])") && blank.idle());
  assert.equal(blank.text("#video-player .video-message strong"), "This video can’t play in this window");
  assert.equal(compatibleRoutes(blank).length, 0, "a picture the engine cannot draw never opens a compatible stream either");
});

test("the daemon's keyframe offset, earlier than asked, drives the time and the cue shift", async (t) => {
  const ui = await boot(t, {
    compatible: (route) => {
      const query = new URLSearchParams(route.split("?")[1]);
      const start = Number(query.get("start")) || 0;
      return { url: `http://127.0.0.1:1/v1/video/hls/x/index.m3u8?from=${start}`, offset: start - 3, audio: 0, duration: 8880 };
    },
    library: () => {
      const data = sampleLibrary();
      data.movies[0].path = "Inception.mkv";
      data.movies[0].subtitles = [{ path: "Inception.es.srt", language: "es", label: "Spanish" }];
      return data;
    },
  });
  await openMovie(ui);
  await ui.click('.video-backdrop [data-action="video-resume"]', () => ui.video()?.querySelector("track") && ui.video().getAttribute("src"));
  ui.video().dispatchEvent(new ui.w.Event("timeupdate"));
  assert.equal(ui.text('#video-player [data-video-time="elapsed"]'), "1:02:07", "3727 = keyframe offset, not the requested 3730");
  const element = ui.video().querySelector("track");
  element.dispatchEvent(new ui.w.Event("load"));
  assert.equal(element.track.cues[0].startTime, 1600 - 3727);
});

test("a compatible stream starts at its first segment even when the engine jumps to the live edge", async (t) => {
  const ui = await boot(t, {
    library: () => {
      const data = sampleLibrary();
      data.movies[0].path = "Inception.mkv";
      return data;
    },
  });
  await openMovie(ui);
  await ui.click('.video-backdrop [data-action="video-resume"]', () => ui.video()?.getAttribute("src")?.includes("/v1/video/hls/"));
  ui.video().time = 460;
  ui.video().dispatchEvent(new ui.w.Event("loadedmetadata"));
  assert.equal(ui.video().currentTime, 0);
});

test("a compatible stream waits for canplay before judging the picture, as WebKit's HLS reports no size at loadedmetadata", async (t) => {
  const ui = await boot(t, {
    library: () => {
      const data = sampleLibrary();
      data.movies[0].path = "Inception.mkv";
      return data;
    },
  });
  await openMovie(ui);
  await ui.click('.video-backdrop [data-action="video-resume"]', () => ui.video()?.getAttribute("src")?.includes("/v1/video/hls/"));
  let width = 0;
  Object.defineProperty(ui.video(), "videoWidth", { configurable: true, get: () => width });
  ui.video().dispatchEvent(new ui.w.Event("loadedmetadata"));
  assert.doesNotMatch(ui.text("#video-player"), /can’t play/, "no size yet is not a failure");
  width = 1920;
  ui.video().dispatchEvent(new ui.w.Event("canplay"));
  assert.doesNotMatch(ui.text("#video-player"), /can’t play/);
  width = 0;
  ui.video().dispatchEvent(new ui.w.Event("canplay"));
  assert.match(ui.text("#video-player"), /can’t play in this window/);
});

test("embedded MKV subtitles are listed and extracted from the hub only when chosen", async (t) => {
  const ui = await boot(t, {
    library: () => {
      const data = sampleLibrary();
      data.movies[0].path = "Inception.mkv";
      data.movies[0].subtitles = [
        { embedded: true, stream: 0, language: "en", label: "English", forced: false, image: false },
        { embedded: true, stream: 1, language: "es", label: "Spanish", forced: false, image: false },
        { embedded: true, stream: 2, language: "fr", label: "French", forced: false, image: true },
      ];
      return data;
    },
  });
  const $ = (selector) => ui.w.document.querySelector(selector);
  await openMovie(ui);
  await ui.click('.video-backdrop [data-action="video-resume"]', () => ui.video()?.getAttribute("src"));
  const embedded = () => ui.routes.filter((route) => route.startsWith("/v1/video/subtitles?")).map((route) => Object.fromEntries(new URLSearchParams(route.split("?")[1])));
  assert.deepEqual(embedded(), [], "nothing is extracted until a track is chosen");
  assert.deepEqual([...ui.w.document.querySelectorAll('#video-player [data-video="subtitle"]')].map((node) => node.textContent), ["Off", "English", "Spanish"], "image subtitles stay out");
  await ui.click('#video-player [data-video="subtitle"][data-id="1"]', () => ui.video().querySelectorAll("track")[1].getAttribute("src")?.startsWith("blob:"));
  assert.equal(embedded().length, 1);
  assert.deepEqual(
    [embedded()[0].path, embedded()[0].stream, embedded()[0].hash, embedded()[0].format],
    ["Inception.mkv", "1", sampleLibrary().movies[0].hash, "json"],
  );
  assert.equal($('#video-player [data-video="subtitle"][aria-checked="true"]').textContent, "Spanish");
  assert.equal(ui.video().querySelectorAll("track")[0].getAttribute("src"), null);
});

test("a Movies & TV folder shows no version history to keep and its Delete… says it can't be restored", async (t) => {
  const ui = await boot(t);
  await library(ui);
  await ui.click('[data-action="video-mode"]', () => ui.$(".folder-history-status"));
  assert.equal(ui.text(".folder-history-status strong"), "Off");
  assert.equal(ui.text(".folder-history-status p"), "Movies & TV keep current files only");
  assert.equal(ui.$("#folder-retention"), null, "no retention control for a folder that keeps no versions");
  assert.doesNotMatch(ui.text("#content"), /Hub working copy/, "nor a way to stop the hub's own copy");
  await ui.click('[data-action="video-mode"]', () => ui.$(".video-tools"));
  await openMovie(ui);
  await ui.click('.video-menu [data-action="video-delete"]', () => ui.$("#dialog[open]"));
  assert.match(ui.text("#dialog"), /can’t be restored/);
});

test("every menu and dropdown has a maximum height and scrolls, so 26 subtitle tracks never run off the window", () => {
  const css = fs.readFileSync(new URL("../apps/desktop/src/style.css", import.meta.url), "utf8");
  assert.match(css, /\.menu-items \{[^}]*max-height: min\(360px, 60vh\);[^}]*overflow-y: auto;/);
  assert.match(css, /\.dropdown-menu \{[^}]*max-height: min\(280px, 50vh\);[^}]*overflow-y: auto;/);
});

test("Mark as unwatched reads as not watched, with the eye-off icon rather than an empty circle", async (t) => {
  const ui = await boot(t);
  await openMovie(ui, "Arrival");
  const toggle = ui.$('.video-backdrop [data-action="video-watched"]');
  assert.equal(toggle.textContent.trim(), "Mark as unwatched");
  assert.ok(toggle.querySelector('[data-icon="eye-off"]'));
});

const twoAudioTracks = () => {
  const data = sampleLibrary();
  data.shows[0].seasons.find((row) => row.season === 1).episodes.find((row) => row.episode === 4).audioTracks = [
    { stream: 0, codec: "ac3", language: "en", label: "English", channels: 6, default: true },
    { stream: 1, codec: "aac", language: "es", label: "Spanish", channels: 2, default: false },
  ];
  return data;
};
const hlsAnswer = (route) => {
  const query = new URLSearchParams(route.split("?")[1]);
  const start = Number(query.get("start")) || 0;
  return { url: `http://127.0.0.1:1/v1/video/hls/x/index.m3u8?from=${start}`, offset: start, audio: Number(query.get("audio") ?? 0), duration: 2880 };
};
const gated = (t) => {
  const gate = { held: null, release: null };
  t.after(() => gate.release?.());
  gate.hold = () => {
    gate.held = new Promise((resolve) => (gate.release = resolve));
  };
  gate.compatible = (route) => (gate.held ? gate.held.then(() => hlsAnswer(route)) : hlsAnswer(route));
  return gate;
};
const seekTo = (ui, value) => {
  const seek = ui.$('#video-player [data-video="seek"]');
  seek.value = String(value);
  seek.dispatchEvent(new ui.w.Event("input", { bubbles: true }));
};

test("a failing compatible stream restarts once and shows the error when it fails again before moving past that point", async (t) => {
  const ui = await boot(t);
  await openEpisode(ui);
  Object.defineProperty(ui.video(), "src", {
    configurable: true,
    get() {
      return this.getAttribute("src");
    },
    set(value) {
      this.time = 0;
      this.setAttribute("src", value);
    },
  });
  const fail = () => {
    Object.defineProperty(ui.video(), "error", { configurable: true, get: () => ({ code: 2 }) });
    ui.video().dispatchEvent(new ui.w.Event("error"));
  };
  ui.video().time = 100;
  fail();
  await until(() => ui.video().getAttribute("src").includes("from=1600") && ui.idle());
  assert.equal(compatibleRoutes(ui)[1].start, "1600");
  ui.video().dispatchEvent(new ui.w.Event("timeupdate"));
  fail();
  await until(() => /Playback stopped/.test(ui.text("#notice") || ""));
  assert.equal(compatibleRoutes(ui).length, 2, "one restart only");
  ui.video().time = 5;
  ui.video().dispatchEvent(new ui.w.Event("timeupdate"));
  fail();
  await until(() => compatibleRoutes(ui).length === 3 && ui.idle());
  assert.equal(compatibleRoutes(ui)[2].start, "1605", "once playback moves past the restart point a new failure restarts again");
});

test("cues keep their original times, so a track that was off during a restart shows with the new offset", async (t) => {
  const ui = await boot(t, {
    library: () => {
      const data = sampleLibrary();
      data.movies[0].path = "Inception.mkv";
      data.movies[0].subtitles = [
        { path: "Inception.es.srt", language: "es", label: "Spanish" },
        { path: "Inception.en.srt", language: "en", label: "English" },
      ];
      return data;
    },
  });
  Object.defineProperty(ui.w.HTMLTrackElement.prototype, "track", {
    configurable: true,
    get() {
      if (!this.mock) {
        const list = [{ startTime: 1600, endTime: 1602 }];
        this.mock = { mode: "showing", list, get cues() { return this.mode === "disabled" ? null : list; } };
      }
      return this.mock;
    },
  });
  await openMovie(ui);
  await ui.click('.video-backdrop [data-action="video-resume"]', () => ui.video()?.querySelectorAll("track").length === 2 && ui.video().getAttribute("src"));
  const [spanish, english] = [...ui.video().querySelectorAll("track")];
  await ui.click('#video-player [data-video="subtitle"][data-id="0"]');
  spanish.dispatchEvent(new ui.w.Event("load"));
  english.dispatchEvent(new ui.w.Event("load"));
  assert.equal(spanish.track.list[0].startTime, 1600 - 3730);
  assert.equal(english.track.list[0].startTime, 1600, "a disabled track exposes no cues");
  seekTo(ui, 5000);
  ui.fire(300);
  await until(() => ui.video().getAttribute("src").includes("from=5000") && ui.idle());
  assert.deepEqual([spanish.track.list[0].startTime, spanish.track.list[0].endTime], [1600 - 5000, 1602 - 5000]);
  await ui.click('#video-player [data-video="subtitle"][data-id="1"]');
  assert.deepEqual([english.track.list[0].startTime, english.track.list[0].endTime], [1600 - 5000, 1602 - 5000], "shown with the current offset");
  await ui.click('#video-player [data-video="subtitle"][data-id="0"]');
  assert.equal(spanish.track.list[0].startTime, 1600 - 5000, "never shifted twice");
});

test("a seek while the hub prepares a restart becomes the next restart, Audio restarts from a pending seek and pausing meanwhile stays paused", async (t) => {
  const gate = gated(t);
  const ui = await boot(t, { library: twoAudioTracks, compatible: gate.compatible });
  await openEpisode(ui);
  ui.video().length = 200;
  seekTo(ui, 2500);
  gate.hold();
  ui.fire(300);
  await until(() => compatibleRoutes(ui).length === 2);
  seekTo(ui, 1550);
  ui.fire(300);
  await until(() => compatibleRoutes(ui).length === 3);
  assert.equal(compatibleRoutes(ui)[2].start, "1550", "the hub ends the playing stream as soon as it starts preparing, so a seek meanwhile asks again");
  gate.release();
  await until(() => ui.video().getAttribute("src").includes("from=1550") && ui.idle());
  gate.held = null;
  seekTo(ui, 2600);
  await ui.click('#video-player [data-video="audio"][data-id="1"]', () => compatibleRoutes(ui).length === 4);
  assert.deepEqual([compatibleRoutes(ui)[3].start, compatibleRoutes(ui)[3].audio], ["2600", "1"]);
  await until(() => ui.video().getAttribute("src").includes("from=2600") && ui.idle());
  gate.hold();
  await ui.click('#video-player [data-video="audio"][data-id="0"]', () => compatibleRoutes(ui).length === 5);
  ui.video().pause();
  const played = ui.played.length;
  gate.release();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(ui.video().paused, true, "a pause during the request is kept");
  assert.equal(ui.played.length, played);
});

test("a seek before the first answer restarts with the show's remembered audio", async (t) => {
  const gate = gated(t);
  const ui = await boot(t, { library: twoAudioTracks, compatible: gate.compatible });
  await openEpisode(ui);
  await ui.click('#video-player [data-video="audio"][data-id="1"]', () => compatibleRoutes(ui).length === 2);
  ui.press("Escape");
  await until(() => ui.$("#video-player").hidden && ui.idle());
  gate.hold();
  ui.$('.video-backdrop [data-action="video-play"]').click();
  await until(() => compatibleRoutes(ui).length === 3);
  assert.equal(compatibleRoutes(ui)[2].audio, "1");
  seekTo(ui, 2600);
  ui.fire(300);
  await until(() => compatibleRoutes(ui).length === 4);
  assert.deepEqual([compatibleRoutes(ui)[3].start, compatibleRoutes(ui)[3].audio], ["2600", "1"]);
  gate.release();
});

test("Up next shows a notice when the next episode can't start and closes the player when its folder is gone", async (t) => {
  const noHls = (type) => (type === "application/vnd.apple.mpegurl" ? "" : "maybe");
  const playback = (route) => {
    const path = new URLSearchParams(route.split("?")[1]).get("path");
    if (path.includes("S01E05")) return Promise.reject(new Error("The hub could not open this video"));
    return { url: `http://127.0.0.1:1/v1/video/media?ticket=${encodeURIComponent(path)}`, subtitles: [] };
  };
  const toUpNext = async (ui) => {
    await openEpisode(ui);
    ui.video().time = 2860;
    ui.video().dispatchEvent(new ui.w.Event("timeupdate"));
    await until(() => ui.$('#video-player [data-video="upnext-play"]'));
  };
  const ui = await boot(t, { canPlay: noHls, playback });
  await toUpNext(ui);
  ui.$('#video-player [data-video="upnext-play"]').click();
  await until(() => /could not open this video/.test(ui.text("#notice") || "") && ui.idle());
  assert.equal(ui.$("#video-player").hidden, true);

  const status = hubStatus();
  const gone = await boot(t, { status, canPlay: noHls, playback });
  await toUpNext(gone);
  status.volumes.splice(0);
  gone.$('#video-player [data-video="upnext-play"]').click();
  await until(() => gone.$("#video-player").hidden && gone.idle());
});

test("Cmd+K does not open Search over the player", async (t) => {
  const ui = await boot(t);
  await openMovie(ui);
  await openPlayer(ui, '.video-backdrop [data-action="video-resume"]');
  ui.press("k", ui.w.document.body, { metaKey: true });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(ui.$("#palette[open]"), null);
  ui.press("Escape");
  await until(() => ui.$("#video-player").hidden && ui.idle());
  ui.press("k", ui.w.document.body, { metaKey: true });
  await until(() => ui.$("#palette[open]"));
});

test("while the hub reads, a new count patches the caption and keeps focus and open menus", async (t) => {
  const data = { ...sampleLibrary(), indexing: { done: 42, total: 310 } };
  const ui = await boot(t, { library: () => data });
  await library(ui);
  assert.equal(ui.text(".video-page .music-caption"), "Reading 42 of 310 videos…");
  const card = ui.$(".video-page .music-card");
  card.focus();
  data.indexing = { done: 43, total: 310 };
  ui.fire(5000);
  await until(() => ui.text(".video-page .music-caption") === "Reading 43 of 310 videos…" && ui.idle());
  assert.equal(card.isConnected, true);
  assert.equal(ui.w.document.activeElement, card);
  await openMovie(ui);
  const menu = ui.$(".video-backdrop .video-menu");
  menu.open = true;
  const reads = () => ui.routes.filter((route) => route.startsWith("/v1/video/library?")).length;
  const before = reads();
  data.indexing = { done: 44, total: 310 };
  ui.fire(5000);
  await until(() => reads() > before && ui.idle());
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(menu.isConnected, true);
  assert.equal(menu.open, true);
});

test("Related shows the hub's list, films and shows together, and skips anything the library no longer holds", async (t) => {
  const ui = await boot(t, {
    library: () => {
      const data = sampleLibrary();
      data.movies.find((row) => row.title === "The Iron Giant").related = ["s:bluey", "m:gone"];
      return data;
    },
  });
  await library(ui);
  await openMovie(ui, "The Iron Giant", "kids");
  assert.deepEqual(ui.texts(".video-more .music-card strong"), ["Bluey"]);
  await ui.click(ui.$(".video-more .music-card"), () => ui.text(".video-backdrop h2") === "Bluey");
});

test("an embedded track the hub is still preparing loads once it is ready, asking every few seconds", async (t) => {
  let preparing = 2;
  const ui = await boot(t, {
    subtitles: (route) => (preparing-- > 0 ? { preparing: true } : { text: `WEBVTT\n\n00:01.000 --> 00:02.000\n${new URLSearchParams(route.split("?")[1]).get("stream")}\n` }),
    library: () => {
      const data = sampleLibrary();
      data.movies[0].path = "Inception.mkv";
      data.movies[0].subtitles = [{ embedded: true, stream: 0, language: "en", label: "English", forced: false, image: false }];
      return data;
    },
  });
  await openMovie(ui);
  await ui.click('.video-backdrop [data-action="video-resume"]', () => ui.video()?.getAttribute("src"));
  await ui.click('#video-player [data-video="subtitle"][data-id="0"]', () => ui.timers[2500].length);
  ui.fire(2500);
  await until(() => ui.timers[2500].length);
  ui.fire(2500);
  await until(() => ui.video().querySelector("track")?.getAttribute("src")?.startsWith("blob:"));
  const asked = ui.routes.filter((route) => route.startsWith("/v1/video/subtitles?"));
  assert.equal(asked.length, 3);
  assert.ok(asked.every((route) => route.includes("poll=1")));
});

const replicaStatus = () => ({ ...hubStatus(), id: "mac", name: "Mac", role: "replica", hub: "http://casa", hubId: "hub" });
function fakeDownloads(rows = []) {
  const state = { rows };
  const answer = (route, method, body) => {
    if (route === "/v1/video/download")
      for (const path of body.paths) state.rows.push({ id: null, path, hash: `h-${path}`, size: 1000, done: 0, state: "queued" });
    if (route === "/v1/video/download/cancel" || route === "/v1/video/download/remove") state.rows = state.rows.filter((row) => !body.paths.includes(row.path));
    return { downloads: state.rows.map((row) => ({ ...row })) };
  };
  return Object.assign(answer, { state });
}

test("a desktop replica downloads a movie beside Mark as watched, shows its progress with a cancel, then Downloaded with Remove download", async (t) => {
  const downloads = fakeDownloads();
  const ui = await boot(t, { status: replicaStatus(), downloads });
  await openMovie(ui);
  const actions = () => ui.texts(".video-backdrop .heading-actions > button");
  assert.deepEqual(actions(), ["Resume from 1:02:10", "Start over", "Mark as watched", "Download"]);
  assert.equal(ui.$('.video-backdrop [data-action="video-download"] [data-icon="download"]') !== null, true);
  await ui.click('.video-backdrop [data-action="video-download"]', () => ui.$('[data-action="video-download-cancel"]'));
  assert.deepEqual(ui.posts.find(([route]) => route === "/v1/video/download")[1], { volume: "vid", paths: ["Inception.mp4"] });
  assert.deepEqual(actions(), ["Resume from 1:02:10", "Start over", "Mark as watched", "Downloading · 0%", ""]);
  downloads.state.rows[0] = { ...downloads.state.rows[0], state: "downloading", done: 420 };
  ui.fire(2000);
  await until(() => ui.text('.video-backdrop [aria-label="Downloading, 42%"]') === "Downloading · 42%" && ui.idle());
  assert.equal(ui.$('.video-backdrop [data-action="video-download-cancel"]').getAttribute("aria-label"), "Cancel download");
  assert.equal(ui.$$(".video-menu .menu-items button").some((el) => el.textContent.includes("Remove download")), false);
  downloads.state.rows[0] = { ...downloads.state.rows[0], state: "done", done: 1000 };
  ui.fire(2000);
  await until(() => actions().includes("Downloaded") && ui.idle());
  assert.equal(ui.$('[data-action="video-download-cancel"]'), null);
  assert.deepEqual(ui.texts(".video-menu .menu-items button"), ["Remove download", "Delete…"]);
  await ui.click('.video-menu [data-action="video-download-remove"]', () => ui.$("#dialog[open]"));
  await ui.click("#submit-dialog", () => actions().includes("Download"));
  assert.deepEqual(ui.posts.find(([route]) => route === "/v1/video/download/remove")[1], { volume: "vid", paths: ["Inception.mp4"] });
});

test("a download's progress waits while the ⋯ menu is open, so the menu does not close under the pointer", async (t) => {
  const downloads = fakeDownloads([{ id: "m:inception", path: "Inception.mp4", hash: "h-Inception.mp4", size: 1000, done: 100, state: "downloading" }]);
  const ui = await boot(t, { status: replicaStatus(), downloads });
  await openMovie(ui);
  const menu = ui.$(".video-menu");
  menu.open = true;
  downloads.state.rows[0] = { ...downloads.state.rows[0], state: "done", done: 1000 };
  ui.fire(2000);
  await until(() => ui.timers[2000].length && ui.idle());
  assert.equal(ui.$(".video-menu"), menu);
  assert.equal(menu.open, true);
  assert.equal(ui.text('.video-backdrop [aria-label="Downloading, 10%"]'), "Downloading · 10%");
  menu.open = false;
  ui.fire(2000);
  await until(() => ui.texts(".video-backdrop .heading-actions > button").includes("Downloaded") && ui.idle());
});

test("cancel stops a movie download", async (t) => {
  const downloads = fakeDownloads([{ id: "m:inception", path: "Inception.mp4", hash: "h-Inception.mp4", size: 1000, done: 640, state: "downloading" }]);
  const ui = await boot(t, { status: replicaStatus(), downloads });
  await openMovie(ui);
  assert.equal(ui.text('.video-backdrop [aria-label="Downloading, 64%"]'), "Downloading · 64%");
  await ui.click('.video-backdrop [data-action="video-download-cancel"]', () => ui.$('.video-backdrop [data-action="video-download"]'));
  assert.deepEqual(ui.posts.find(([route]) => route === "/v1/video/download/cancel")[1], { volume: "vid", paths: ["Inception.mp4"] });
});

test("each episode row downloads on its own and Download season queues the rest of the season", async (t) => {
  const pilot = "Breaking Bad/Season 1/S01E01.mkv";
  const downloads = fakeDownloads([
    { id: "e:Breaking Bad/S1E1", path: pilot, hash: `h-${pilot}`, size: 1000, done: 1000, state: "done" },
    { id: "e:Breaking Bad/S1E2", path: "Breaking Bad/Season 1/S01E02.mkv", hash: "h-Breaking Bad/Season 1/S01E02.mkv", size: 1000, done: 640, state: "downloading" },
  ]);
  const ui = await boot(t, { status: replicaStatus(), downloads });
  await library(ui);
  await ui.click('[data-action="video-tab"][data-id="shows"]', () => cardTitles(ui).includes("Breaking Bad"));
  await ui.click(ui.$$(".video-page .music-card").find((el) => el.textContent.includes("Breaking Bad")), () => ui.$(".video-episode"));
  const row = (title) => ui.$$(".video-episode").find((entry) => entry.textContent.includes(title));
  const control = (title) => row(title).querySelector(".row-actions > .icon-button");
  const chip = (title) => row(title).querySelector(".row-actions > .tag")?.textContent;
  assert.equal(chip("Pilot"), "Downloaded");
  assert.equal(control("Pilot").getAttribute("aria-label"), "Remove download");
  assert.equal(control("Pilot").dataset.tooltip, "Remove download");
  assert.equal(chip("Cat's in the Bag"), "Downloading 64%");
  assert.equal(control("Cat's in the Bag").getAttribute("aria-label"), "Cancel download");
  assert.equal(control("Cat's in the Bag").dataset.action, "video-download-cancel");
  assert.equal(chip("Gray Matter"), undefined);
  assert.equal(control("Gray Matter").getAttribute("aria-label"), "Download");
  assert.ok(ui.$$(".video-episode").every((row) => row.querySelector('.row-actions [data-action="video-watched"]')), "Mark as watched stays beside it");
  assert.equal(ui.$('[data-action="video-download-season"]'), null, "the season line shows its progress while an episode runs");
  assert.equal(ui.text(".video-season-download .video-meta"), "Downloading season");
  assert.equal(ui.text(".video-season-download .tag"), "1 of 2");
  assert.equal(ui.$(".video-season-download progress").getAttribute("aria-label"), "Season download, 82%");
  await ui.click('[data-action="video-download-cancel-season"]', () => ui.$('[data-action="video-download-season"]'));
  assert.deepEqual(ui.posts.find(([route]) => route === "/v1/video/download/cancel")[1].paths, ["Breaking Bad/Season 1/S01E02.mkv"]);
  assert.equal(ui.text('[data-action="video-download-season"]'), "Download season");
  assert.ok(ui.$('.video-season-bar > .segmented + .heading-actions [data-action="video-download-season"]'), "Download season sits to the right of the season control");
  await ui.click('[data-action="video-download-season"]', () => ui.posts.some(([route]) => route === "/v1/video/download"));
  assert.deepEqual(ui.posts.find(([route]) => route === "/v1/video/download")[1].paths.sort(), [
    "Breaking Bad/Season 1/S01E02.mkv",
    "Breaking Bad/Season 1/S01E03.mkv",
    "Breaking Bad/Season 1/S01E04.mkv",
    "Breaking Bad/Season 1/S01E05.mkv",
  ]);
  await until(() => ui.$(".video-season-download") && ui.idle());
  assert.equal(chip("Gray Matter"), "Waiting");
  assert.equal(ui.text(".video-season-download .tag"), "1 of 5");
  assert.equal(chip("Pilot"), "Downloaded", "a finished episode survives the season cancel");
  await ui.click(control("Pilot"), () => ui.$("#dialog[open]"));
  await ui.click("#submit-dialog", () => control("Pilot").getAttribute("aria-label") === "Download");
});

test("Home starts with a Downloads shelf whose posters carry a download badge", async (t) => {
  const pilot = "Breaking Bad/Season 1/S01E01.mkv";
  const downloads = fakeDownloads([
    { id: "m:inception", path: "Inception.mp4", hash: "h-Inception.mp4", size: 1000, done: 1000, state: "done" },
    { id: "e:Breaking Bad/S1E1", path: pilot, hash: `h-${pilot}`, size: 1000, done: 1000, state: "done" },
    { id: "m:arrival", path: "Arrival.mp4", hash: "h-Arrival.mp4", size: 1000, done: 10, state: "downloading" },
    { id: "m:dune", path: "Dune.Part.Two.2024.2160p.WEB-DL.x265-GRP.mkv", hash: "stale", size: 1000, done: 1000, state: "done" },
  ]);
  const ui = await boot(t, { status: replicaStatus(), downloads });
  await library(ui);
  assert.equal(ui.texts(".video-shelves .section-label")[0], "Downloads");
  const shelf = ui.$$(".video-shelves section")[0];
  assert.deepEqual([...shelf.querySelectorAll("strong")].map((el) => el.textContent), ["Inception", "Breaking Bad"], "finished downloads only, a show once, and never a copy of an older file");
  assert.ok([...shelf.querySelectorAll(".video-poster")].every((poster) => poster.querySelector('.video-watched[aria-label="Downloaded"] [data-icon="download"]')));
});

test("the hub and the web never offer downloads", async (t) => {
  for (const options of [{}, { web: true, status: replicaStatus() }]) {
    const ui = await boot(t, { ...options, downloads: fakeDownloads() });
    await openMovie(ui);
    assert.equal(ui.$('[data-action="video-download"]'), null);
    assert.equal(ui.routes.some((route) => route.startsWith("/v1/video/download")), false);
    assert.equal(ui.texts(".video-backdrop .heading-actions > button").includes("Download"), false);
  }
});

test("offline, a downloaded movie still plays and Download waits for the hub", async (t) => {
  const downloads = fakeDownloads([{ id: "m:inception", path: "Inception.mp4", hash: "h-Inception.mp4", size: 1000, done: 1000, state: "done" }]);
  const ui = await boot(t, { status: { ...replicaStatus(), hubUnavailable: true }, downloads });
  await openMovie(ui, "Arrival");
  assert.equal(ui.$('.video-backdrop [data-action="video-download"]').getAttribute("aria-disabled"), "true");
  const crumb = ui.$$("#content .music-trail button").find((el) => el.textContent.trim() === "Movies");
  await ui.click(crumb, () => ui.$(".video-tools .video-sort"));
  const card = ui.$$(".video-page .music-card").find((el) => el.querySelector("strong").textContent === "Inception");
  await ui.click(card, () => ui.text(".video-backdrop h2") === "Inception");
  assert.ok(ui.texts(".video-backdrop .heading-actions > button").includes("Downloaded"));
  await ui.click('.video-backdrop [data-action="video-resume"]', () => ui.video()?.getAttribute("src"));
  assert.match(ui.video().getAttribute("src"), /ticket=Inception\.mp4/);
});

test("a copy of an older file stays removable and a row the hub no longer lists gets no card", async (t) => {
  const downloads = fakeDownloads([
    { id: "m:inception", title: "Inception", path: "Inception.mp4", hash: "older", size: 1000, done: 1000, state: "done" },
    { id: "m:gone", title: "Heat", path: "Heat (1995).mkv", hash: "gone", size: 1000, done: 1000, state: "done" },
    { id: "e:Breaking Bad/S1E5", title: "Breaking Bad · Gray Matter", path: "Breaking Bad/Season 1/S01E05.mkv", hash: "h-Breaking Bad/Season 1/S01E05.mkv", size: 1000, done: 10, state: "failed", error: "No" },
  ]);
  const ui = await boot(t, { status: replicaStatus(), downloads });
  await library(ui);
  assert.equal(ui.texts(".video-shelves .section-label").includes("Downloads"), false, "neither the older copy nor the dropped title fills the shelf");
  assert.equal(ui.$$(".video-shelves .music-card").some((card) => /Heat|No longer on the hub/.test(card.textContent)), false);
  assert.equal(ui.$('[data-action="video-download-forget"]'), null);

  await openMovie(ui);
  assert.ok(ui.texts(".video-backdrop .heading-actions > button").includes("Download"), "the newer file can be downloaded");
  assert.deepEqual(ui.texts(".video-menu .menu-items button"), ["Remove download", "Delete…"], "and the older copy removed");

  await ui.click('[data-action="video-crumb"][data-id="root"]', () => ui.$(".video-shelves"));
  await ui.click('[data-action="video-tab"][data-id="shows"]', () => cardTitles(ui).includes("Breaking Bad"));
  await ui.click(ui.$$(".video-page .music-card").find((el) => el.textContent.includes("Breaking Bad")), () => ui.$(".video-episode"));
  const gray = ui.$$(".video-episode").find((row) => row.textContent.includes("Gray Matter"));
  assert.ok(gray.querySelector('[data-action="video-download"]'));
  assert.equal(gray.querySelector('[data-action="video-download-remove"]').getAttribute("aria-label"), "Remove download");
});

test("downloaded home videos join the Downloads shelf, and a failed progress check keeps polling", async (t) => {
  const downloads = fakeDownloads([
    { id: "o:Home videos/Beach.mp4", path: "Home videos/Beach.mp4", hash: "h-Home videos/Beach.mp4", size: 1000, done: 1000, state: "done" },
    { id: "m:arrival", path: "Arrival.mp4", hash: "h-Arrival.mp4", size: 1000, done: 10, state: "downloading" },
  ]);
  let broken = false;
  const ui = await boot(t, {
    status: replicaStatus(),
    downloads: (route, method, body) => {
      if (broken && route.startsWith("/v1/video/downloads?")) return Promise.reject(Object.assign(new Error("busy"), { status: 500 }));
      return downloads(route, method, body);
    },
  });
  await library(ui);
  const shelf = ui.$$(".video-shelves section")[0];
  assert.deepEqual([...shelf.querySelectorAll("strong")].map((el) => el.textContent), ["Beach"]);
  assert.equal(shelf.querySelector(".music-card").dataset.action, "video-play");
  assert.ok(shelf.querySelector('.video-watched[aria-label="Downloaded"]'));
  broken = true;
  ui.fire(2000);
  await until(() => ui.timers[2000].length && ui.idle());
  broken = false;
});


test("a poster's check marks the movie or the whole show watched without opening it, and undoes it on a watched poster", async (t) => {
  const ui = await boot(t);
  await library(ui);
  await ui.click('[data-action="video-tab"][data-id="movies"]', () => cardTitles(ui).includes("Dune Part Two"));
  const quick = (title) => ui.$(`.video-quick-watched[data-id="${ui.$$(".video-page .music-card").find((el) => el.querySelector("strong").textContent === title).dataset.id}"]`);
  assert.equal(quick("Dune Part Two").getAttribute("aria-label"), "Mark as watched: Dune Part Two");
  assert.equal(quick("Arrival").getAttribute("aria-label"), "Mark as unwatched: Arrival");
  assert.ok(quick("Arrival").classList.contains("is-watched"));
  assert.equal(quick("Dune Part Two").closest(".music-card"), null, "the check sits beside the card's own button, never inside it");
  await ui.click(quick("Dune Part Two"), () => quick("Dune Part Two")?.getAttribute("aria-label") === "Mark as unwatched: Dune Part Two");
  assert.deepEqual(ui.posts.filter(([route]) => route === "/v1/video/watched").map(([, body]) => body), [{ volume: "vid", path: "Dune.Part.Two.2024.2160p.WEB-DL.x265-GRP.mkv", hash: "h-Dune.Part.Two.2024.2160p.WEB-DL.x265-GRP.mkv", watched: true }]);
  assert.ok(!ui.$(".video-backdrop"), "the page did not open");
  await ui.click('[data-action="video-tab"][data-id="shows"]', () => cardTitles(ui).includes("Breaking Bad"));
  await ui.click(quick("Breaking Bad"), () => quick("Breaking Bad")?.classList.contains("is-watched"));
  const marked = ui.posts.filter(([route, body]) => route === "/v1/video/watched" && body.path.startsWith("Breaking Bad/"));
  assert.ok(marked.length > 1 && marked.every(([, body]) => body.watched === true), "every unwatched episode is marked");
  assert.ok(ui.$(".video-page .video-watched[aria-label=\"Watched\"]"));
});

test("the title banner's menus open above the Related posters below it", () => {
  const css = source("style.css");
  const rule = (selector) => css.match(new RegExp(`\\n${selector.replace(/[.]/g, "\\.")} \\{([^}]*)\\}`))[1];
  assert.match(rule(".video-backdrop"), /isolation: isolate;\s+z-index: 1;/, "the banner stacks above later content");
  assert.match(rule(".video-card"), /isolation: isolate;/, "a poster's own badges never escape its card");
});

test("the hub's ⋯ on a show offers no Mark as kids: shows always stay in TV Shows", async (t) => {
  const ui = await boot(t, { library: () => { const data = sampleLibrary(); data.shows.find((row) => row.title === "Breaking Bad").matched = false; return data; } });
  await library(ui);
  await ui.click('[data-action="video-tab"][data-id="shows"]', () => cardTitles(ui).includes("Breaking Bad"));
  await ui.click(ui.$$(".video-page .music-card").find((el) => el.querySelector("strong").textContent === "Breaking Bad"), () => ui.$(".video-episode"));
  assert.equal(ui.$('[data-action="video-kids"]'), null);
});

test("a show page marks the whole show watched from its banner, beside Play, and back", async (t) => {
  const ui = await boot(t);
  await library(ui);
  await ui.click('[data-action="video-tab"][data-id="shows"]', () => cardTitles(ui).includes("Breaking Bad"));
  await ui.click(ui.$$(".video-page .music-card").find((el) => el.querySelector("strong").textContent === "Breaking Bad"), () => ui.$(".video-episode"));
  const mark = () => ui.$('.video-backdrop [data-action="video-quick-watched"]');
  assert.equal(mark().textContent.trim(), "Mark all episodes as watched");
  assert.deepEqual(ui.texts(".video-backdrop .heading-actions > button"), ["Play S1 · E4", "Mark all episodes as watched"]);
  await ui.click(mark(), () => mark()?.textContent.trim() === "Mark all episodes as unwatched");
  assert.match(ui.$("#notice").textContent, /\d+ episodes? marked watched\./, "the notice names the count");
  const sent = ui.posts.filter(([route]) => route === "/v1/video/watched").map(([, body]) => body);
  assert.ok(sent.length > 1 && sent.every((body) => body.watched === true && body.path.startsWith("Breaking Bad/")));
  assert.ok(mark().querySelector('[data-icon="eye-off"]'));
  assert.ok(ui.$('.video-backdrop > .video-poster .video-watched[aria-label="Watched"]'));
  await ui.click(mark(), () => mark()?.textContent.trim() === "Mark all episodes as watched");
  assert.match(ui.$("#notice").textContent, /\d+ episodes? marked unwatched\./);
});

test("marking a show stops at a failed episode yet still redraws what was marked, and Next is announced", async (t) => {
  let sent = 0;
  const ui = await boot(t, { watched: () => ++sent === 2 });
  await library(ui);
  const next = ui.$$(".video-shelves .music-card").find((el) => el.querySelector(".video-next"));
  assert.match(next.getAttribute("aria-label"), /, next$/);
  await ui.click('[data-action="video-tab"][data-id="shows"]', () => cardTitles(ui).includes("Breaking Bad"));
  await ui.click(ui.$$(".video-page .music-card").find((el) => el.querySelector("strong").textContent === "Breaking Bad"), () => ui.$(".video-episode"));
  const checks = () => ui.$$(".video-episode .video-check").length;
  const before = checks();
  await ui.click('.video-backdrop [data-action="video-quick-watched"]', () => sent >= 2 && ui.idle());
  await until(() => checks() > before);
  assert.equal(ui.text('.video-backdrop [data-action="video-quick-watched"]'), "Mark all episodes as watched", "the show is not fully watched after the failure");
});

test("on touch screens the poster check is always visible, never an invisible tap target", () => {
  const css = source("style.css");
  assert.match(css, /@media \(hover: none\) \{\s+\.video-card \.video-quick-watched \{\s+opacity: 1;/);
});

test("the Movies grid lists every title: nothing hides behind a Show more button", async (t) => {
  const many = () => {
    const data = sampleLibrary();
    const base = data.movies.find((row) => row.title === "Arrival");
    for (let index = 0; index < 90; index++) data.movies.push({ ...base, id: `m:bulk${index}`, path: `bulk${index}.mp4`, hash: `h-bulk${index}`, title: `Title ${String(index).padStart(3, "0")}`, watched: false });
    return data;
  };
  const ui = await boot(t, { library: many });
  await library(ui);
  await ui.click('[data-action="video-tab"][data-id="movies"]', () => cardTitles(ui).length > 60);
  assert.ok(cardTitles(ui).length >= 90, "every movie is drawn");
  assert.equal(ui.$('[data-action="video-more"]'), null);
  assert.equal(ui.$(".video-page .pagination"), null);
});

test("Home keeps itself fresh: an idle library is read again every minute and the row redraws only when the hub's list changed", async (t) => {
  const data = sampleLibrary();
  const ui = await boot(t, { library: () => data });
  await library(ui);
  const first = () => ui.$$(".video-shelves section")[0];
  assert.equal(first().querySelector(".music-card > span:last-child").textContent, "S1 · E4 · 23 min left");
  await until(() => ui.timers[60000].length);
  ui.fire(60000);
  await until(() => ui.idle() && ui.timers[60000].length);
  data.version = "v-next";
  data.watchNext = [{ ...data.watchNext[0], caption: "5 min left" }, ...data.watchNext.slice(1)];
  ui.fire(60000);
  await until(() => first().querySelector(".music-card > span:last-child").textContent === "5 min left");
  const card = ui.$(".video-page .music-card");
  card.parentElement.insertAdjacentHTML("afterend", "<details open><summary>menu</summary></details>");
  data.version = "v-held";
  data.watchNext = [{ ...data.watchNext[0], caption: "4 min left" }, ...data.watchNext.slice(1)];
  await until(() => ui.timers[60000].length);
  ui.fire(60000);
  await until(() => ui.idle() && ui.timers[60000].length);
  assert.equal(first().querySelector(".music-card > span:last-child").textContent, "5 min left", "an open menu is never redrawn away");
  ui.$("#content details[open]").removeAttribute("open");
  ui.fire(60000);
  await until(() => first().querySelector(".music-card > span:last-child").textContent === "4 min left");
});

test("badges keep their label centred: a fixed tag height and the label in its own box, trimmed to cap height", async (t) => {
  const css = source("style.css");
  const rule = (selector) => css.match(new RegExp(`\\n${selector.replace(/[.]/g, "\\.")} \\{([^}]*)\\}`))[1];
  for (const selector of [".video-badge", ".video-rating", ".tag"]) assert.match(rule(selector), /height: var\(--tag-height\);/, selector);
  assert.match(css, /\n\.video-badge > span,\n\.video-rating > span \{\n  text-box: trim-both cap alphabetic;\n\}/, "a flex box never trims its own text, only a child box");
  assert.equal(css.match(/text-box:/g).length, 1);
  const ui = await boot(t);
  await openMovie(ui);
  const badges = [...ui.$$(".video-backdrop .video-badge"), ...ui.$$(".video-rating")];
  assert.ok(badges.length);
  for (const badge of badges) assert.equal(badge.children[0]?.tagName, "SPAN", badge.outerHTML);
});
