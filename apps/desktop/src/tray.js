const invoke = window.__TAURI__.core.invoke;
const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const bytes = (n) =>
  n == null
    ? ""
    : n < 1024
      ? `${n} B`
      : n < 1024 ** 2
        ? `${(n / 1024).toFixed(1)} KB`
        : n < 1024 ** 3
          ? `${(n / 1024 ** 2).toFixed(1)} MB`
          : `${(n / 1024 ** 3).toFixed(1)} GB`;
const icon = (name) => `<span data-lucide="${name}" aria-hidden="true"></span>`;
const api = (route, body) =>
  invoke("api", {
    route,
    method: body === undefined ? "GET" : "POST",
    body: body ?? null,
  });
const busy = () => '<span class="busy-grid">' + "<i></i>".repeat(9) + "</span>";
const events = window.__TAURI__.event;
const covers = new Map();
const coverWaits = new Map();
const coverRequests = new Set();
let state = null,
  windowOpen = false,
  music = null,
  running = false;
function coverFor(key, folder) {
  if (!key) return "";
  if (covers.has(key)) {
    const value = covers.get(key);
    covers.delete(key);
    covers.set(key, value);
    return value;
  }
  if (coverRequests.has(key) || (coverWaits.get(key) || 0) > Date.now()) return "";
  const later = () => {
    coverWaits.delete(key);
    coverWaits.set(key, Date.now() + 60000);
    while (coverWaits.size > 8) coverWaits.delete(coverWaits.keys().next().value);
  };
  coverRequests.add(key);
  api(`/v1/music/cover?${new URLSearchParams({ volume: folder, key, size: "small" })}`)
    .then((value) => {
      if (!value?.data && !value?.unavailable) return later();
      coverWaits.delete(key);
      covers.set(key, value.data || "");
      while (covers.size > 2) covers.delete(covers.keys().next().value);
      if (value.data && music?.cover === key) patchMusic();
    }, later)
    .finally(() => coverRequests.delete(key));
  return "";
}
const coverMarkup = (cover) => (cover ? `<img alt="" src="${escape(cover)}">` : icon("music"));
function musicBox() {
  if (!music) return "";
  return `<div class="music-mini tray-music" role="region" aria-label="Now playing"><button class="music-mini-track" data-music="show" aria-label="${escape(`${music.title} by ${music.artist}, show in Arca`)}"><span class="music-cover">${coverMarkup(coverFor(music.cover, music.folder))}</span><span class="music-mini-text"><strong>${escape(music.title)}</strong><span>${escape(`${music.artist} · ${music.album}`)}</span></span></button><button class="ghost icon-button" data-music="previous" aria-label="Previous">${icon("skip-back")}</button><button class="primary icon-button music-mini-play" data-music="toggle" data-symbol="${music.playing ? "pause" : "play"}" aria-label="${music.playing ? "Pause" : "Play"}">${icon(music.playing ? "pause" : "play")}</button><button class="ghost icon-button" data-music="next" aria-label="Next"${music.next === false ? " disabled" : ""}>${icon("skip-forward")}</button></div>`;
}
function patchMusic() {
  const box = document.querySelector(".tray-music");
  if (!box || !music) return draw();
  const opener = box.querySelector(".music-mini-track");
  opener.setAttribute("aria-label", `${music.title} by ${music.artist}, show in Arca`);
  opener.querySelector("strong").textContent = music.title;
  opener.querySelector(".music-mini-text > span").textContent = `${music.artist} · ${music.album}`;
  const cover = coverFor(music.cover, music.folder);
  const shown = opener.querySelector(".music-cover img")?.getAttribute("src") || "";
  if (cover !== shown) opener.querySelector(".music-cover").innerHTML = coverMarkup(cover);
  const toggle = box.querySelector('[data-music="toggle"]');
  const symbol = music.playing ? "pause" : "play";
  toggle.setAttribute("aria-label", music.playing ? "Pause" : "Play");
  if (toggle.dataset.symbol !== symbol) {
    toggle.dataset.symbol = symbol;
    toggle.innerHTML = icon(symbol);
  }
  box.querySelector('[data-music="next"]').disabled = music.next === false;
  window.lucide.createIcons({ attrs: { "stroke-width": 1.75 } });
}
async function refresh() {
  try {
    [state, windowOpen] = await Promise.all([
      api("/v1/status"),
      invoke("main_window_open").catch(() => false),
    ]);
    draw();
  } catch {
    state = null;
    document.querySelector("#tray-content").innerHTML =
      `<div class="tray-heading"><strong>Daemon unavailable</strong></div><div class="tray-menu"><button data-action="start">${icon("power")}Start service</button><button data-action="open">${icon("app-window-mac")}Open Arca<kbd>⌘O</kbd></button><button data-action="quit">${icon("power")}Quit Arca<kbd>⌘Q</kbd></button></div><p id="tray-error" role="alert"></p>`;
    window.lucide.createIcons({ attrs: { "stroke-width": 1.75 } });
  }
}
function draw() {
  if (!state) return;
  const labels = {
    idle: "Up to date",
    syncing: "Syncing",
    paused: "Paused",
    error: "Needs attention",
    unlinked: "Disconnected",
    "needs-folder": "Choose a shared folder",
  };
  const offline =
    state.hubUnavailable && !["paused", "unlinked"].includes(state.phase);
  const label = offline ? "Offline" : labels[state.phase] || state.phase;
  const folderScroll =
    document.querySelector(".tray-folders")?.scrollTop || 0;
  document.querySelector("#tray-content").innerHTML =
    `<div class="tray-heading tray-tone-${offline ? "disconnected" : state.phase === "error" ? "error" : state.phase === "unlinked" ? "conflict" : state.phase === "paused" ? "paused" : state.phase === "syncing" ? "syncing" : "synced"}"><img class="tray-brand-icon" src="assets/arca-icon.svg" width="28" height="28" alt="Arca"><div class="tray-title"><strong>${escape(label)}</strong><p>${state.lastSync ? "Last completed " + new Date(state.lastSync).toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }) : "Not yet verified"}</p></div>${state.role === "hub" ? '<span class="tray-role">Hub</span>' : ""}</div>${musicBox()}<div class="tray-folders">${state.volumes
      .filter((v) => v.selected)
      .map((v) => {
        const phase =
          state.phase === "unlinked"
            ? "disconnected"
            : state.phase === "paused"
              ? "paused"
              : v.conflicts
                ? "conflict"
                : v.sync?.state || "pending";
        const names = {
          disconnected: "Disconnected",
          synced: "Up to date",
          scanning: "Scanning",
          syncing: "Syncing",
          error: "Needs attention",
          pending: "Pending",
          paused: "Paused",
          conflict: "Conflict",
        };
        return `<button class="tray-tone-${escape(phase)}" data-folder="${escape(v.id)}">${["scanning", "syncing"].includes(phase) ? busy() : icon(v.gallery ? "images" : v.music ? "music" : "folder")}<span class="tray-folder-name">${escape(v.name)}</span><small>${escape(phase === "synced" ? bytes(v.bytes) : names[phase] || "Pending")}</small></button>`;
      })
      .join(
        "",
      )}</div><div class="tray-menu"><button data-action="sync">${icon("refresh-cw")}Sync now<kbd>⌘R</kbd></button><button data-action="pause">${icon(state.phase === "paused" ? "play" : "pause")}${state.phase === "paused" ? "Resume sync" : "Pause for 1 hour"}</button><hr>${windowOpen ? "" : `<button data-action="open">${icon("app-window-mac")}Open Arca<kbd>⌘O</kbd></button>`}<button data-action="quit">${icon("power")}Quit Arca<kbd>⌘Q</kbd></button></div><p id="tray-error" role="alert"></p>`;
  document.querySelector(".tray-folders").scrollTop = folderScroll;
  window.lucide.createIcons({ attrs: { "stroke-width": 1.75 } });
}
document.addEventListener("click", async (e) => {
  const el = e.target.closest("button");
  if (!el || running) return;
  running = true;
  try {
    if (el.dataset.music) {
      await events?.emit("music-command", { command: el.dataset.music });
      if (el.dataset.music === "show") await invoke("show_main", { folder: null });
    }
    if (el.dataset.folder)
      await invoke("show_main", { folder: el.dataset.folder });
    if (el.dataset.action === "open")
      await invoke("show_main", { folder: null });
    if (el.dataset.action === "quit") await invoke("quit_app");
    if (el.dataset.action === "start") await invoke("start_daemon");
    if (el.dataset.action === "sync")
      await api("/v1/sync", { background: true });
    if (el.dataset.action === "pause")
      await api("/v1/pause", {
        paused: state.phase !== "paused",
        seconds: 3600,
      });
    if (["sync", "pause"].includes(el.dataset.action))
      await invoke("hide_tray");
    await refresh();
  } catch (error) {
    const el = document.querySelector("#tray-error");
    if (el) el.textContent = String(error);
  } finally {
    running = false;
  }
});
function theme() {
  let p = "system";
  try {
    p = localStorage.getItem("arca-theme") || "system";
  } catch {}
  document.documentElement.dataset.theme =
    p === "dark" ||
    (p === "system" && matchMedia("(prefers-color-scheme: dark)").matches)
      ? "dark"
      : "light";
}
theme();
addEventListener("storage", theme);
let lastHeight = 0;
new ResizeObserver(() => {
  const height =
    Math.ceil(
      document.querySelector("#tray-content").getBoundingClientRect().height,
    ) + 2;
  if (height !== lastHeight) {
    lastHeight = height;
    invoke("resize_tray", { height }).catch(() => {});
  }
}).observe(document.querySelector("#tray-content"));
events?.listen("music-state", (event) => {
  const shown = !!music;
  music = event.payload || null;
  if (shown && music) patchMusic();
  else draw();
});
events?.emit("music-command", { command: "state" });
await refresh();
setInterval(() => {
  if (!running) refresh();
}, 2000);
addEventListener("focus", () => {
  events?.emit("music-command", { command: "state" });
  if (!running) refresh();
});

document.addEventListener("keydown", (event) => {
  if (!event.metaKey && !event.ctrlKey) return;
  const action = { r: "sync", o: "open", q: "quit" }[event.key.toLowerCase()];
  if (!action) return;
  event.preventDefault();
  document.querySelector(`[data-action="${action}"]`)?.click();
});
