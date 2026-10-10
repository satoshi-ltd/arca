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
const coverMarkup = (cover) =>
  cover
    ? `<img alt="" src="${escape(cover)}">`
    : '<svg class="brand-arch" viewBox="116 100 280 296" aria-hidden="true"><path d="M136 380V242a120 120 0 0 1 240 0v138h-60V242a60 60 0 0 0-120 0v138z"/><rect x="226" y="284" width="60" height="96" rx="6"/></svg>';
const clock = (value) =>
  new Date(value).toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const plural = (n, one, many = `${one}s`) => `${n.toLocaleString("en")} ${n === 1 ? one : many}`;
const ROWS_SHOWN = 4;
let more = false,
  update = null;
function untilTomorrow(now = new Date()) {
  const next = new Date(now);
  next.setHours(8, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const shift = (now.getTimezoneOffset() - next.getTimezoneOffset()) * 60;
  return Math.max(1, Math.min(86399, 86399 - shift, Math.ceil((next - now) / 1000)));
}
function attentionRows(state) {
  if (state.hubUnavailable || ["paused", "unlinked", "needs-folder"].includes(state.phase)) return [];
  const rows = [];
  for (const v of state.volumes.filter((item) => item.selected)) {
    if (v.sync?.state === "error")
      rows.push({ rank: 0, folder: v.id, name: v.name, tone: "error", glyph: "circle-alert", label: "Needs attention" });
    else if (v.conflicts)
      rows.push({ rank: 1, folder: v.id, name: v.name, tone: "conflict", glyph: "triangle-alert", label: plural(v.conflicts, "conflict") });
    else if (["syncing", "scanning"].includes(v.sync?.state))
      rows.push({ rank: 2, folder: v.id, name: v.name, busy: true, label: v.sync.state === "syncing" ? "Syncing" : "Scanning" });
  }
  if (state.backup?.error)
    rows.push({ rank: 0, action: "backup", name: "Backup", tone: "error", glyph: "shield", label: "Needs attention" });
  return rows.sort((a, b) => a.rank - b.rank);
}
function summary(state, rows = attentionRows(state)) {
  const selected = state.volumes.filter((v) => v.selected);
  const last = state.lastSync ? `Last completed ${clock(state.lastSync)}` : "Not yet verified";
  const lower = last[0].toLowerCase() + last.slice(1);
  if (state.phase === "unlinked") return { title: "Disconnected", line: last };
  if (state.phase === "needs-folder") return { title: "Choose a shared folder", line: last };
  if (state.phase === "paused")
    return state.pauseUntil
      ? { title: `Paused until ${clock(state.pauseUntil)}`, line: `Sync resumes on its own · ${lower}`, ink: "warn", resume: true }
      : { title: "Paused", line: last, ink: "warn", resume: true };
  if (state.hubUnavailable)
    return { title: "Offline", line: `Cannot reach ${state.hubName || "the hub"} · ${lower}`, ink: "warn" };
  const conflicted = selected.filter((v) => v.conflicts && v.sync?.state !== "error");
  const conflicts = conflicted.reduce((total, v) => total + v.conflicts, 0);
  const errors = rows.filter((row) => row.rank === 0 && row.folder).length;
  if (conflicts || errors || state.backup?.error || state.phase === "error") {
    const parts = [
      conflicts ? `${plural(conflicts, "conflict")} in ${conflicted.length === 1 ? conflicted[0].name : `${conflicted.length} folders`}` : "",
      errors ? plural(errors, "folder error") : "",
      state.backup?.error ? "backup failed" : "",
    ].filter(Boolean);
    const line = parts.join(" · ") || state.error || last;
    return { title: "Needs attention", line: line[0].toUpperCase() + line.slice(1), ink: "error" };
  }
  const active = selected.filter((v) => ["syncing", "scanning"].includes(v.sync?.state)).length;
  const waiting = selected.filter((v) => !v.sync || v.sync.state === "pending").length;
  if (state.phase === "syncing" || active) {
    const done = selected.filter((v) => v.sync?.state === "synced").length;
    const count = active + waiting;
    return {
      title: count ? `Syncing ${plural(count, "folder")}` : "Syncing",
      line: `${done} of ${plural(selected.length, "folder")}${waiting && active ? ` · ${waiting} more waiting` : ""}`,
      progress: selected.length ? done / selected.length : 0,
    };
  }
  return { title: "Up to date", line: `${last} · ${plural(selected.length, "folder")}` };
}
function musicBox() {
  if (!music) return "";
  return `<div class="tray-music" role="region" aria-label="Now playing"><button class="tray-track" data-music="show" aria-label="${escape(`${music.title} by ${music.artist}, show in Arca`)}"><span class="music-cover">${coverMarkup(coverFor(music.cover, music.folder))}</span><span class="tray-track-line"><strong>${escape(music.title)}</strong> <span>${escape(`· ${music.artist}`)}</span></span></button><button class="ghost icon-button" data-music="toggle" data-symbol="${music.playing ? "pause" : "play"}" aria-label="${music.playing ? "Pause" : "Play"}">${icon(music.playing ? "pause" : "play")}</button><button class="ghost icon-button" data-music="next" aria-label="Next"${music.next === false ? " disabled" : ""}>${icon("skip-forward")}</button></div>`;
}
function patchMusic() {
  const box = document.querySelector(".tray-music");
  if (!box || !music) return draw();
  const opener = box.querySelector(".tray-track");
  opener.setAttribute("aria-label", `${music.title} by ${music.artist}, show in Arca`);
  opener.querySelector("strong").textContent = music.title;
  opener.querySelector(".tray-track-line > span").textContent = `· ${music.artist}`;
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
    state = await api("/v1/status");
    draw();
  } catch {
    state = null;
    document.querySelector("#tray-content").innerHTML =
      `<div class="tray-heading"><strong>Daemon unavailable</strong></div><div class="tray-menu"><button data-action="start">${icon("power")}Start service</button><button data-action="open">${icon("app-window-mac")}Open Arca<kbd>⌘O</kbd></button><button data-action="quit">${icon("power")}Quit Arca<kbd>⌘Q</kbd></button></div><p id="tray-error" role="alert"></p>`;
    window.lucide.createIcons({ attrs: { "stroke-width": 1.75 } });
  }
}
function folderRow(row) {
  const target = row.folder ? `data-folder="${escape(row.folder)}"` : `data-action="${row.action}"`;
  return `<button${row.tone ? ` class="tray-tone-${row.tone}"` : ""} ${target}>${row.busy ? busy() : icon(row.glyph)}<span class="tray-folder-name">${escape(row.name)}</span><small>${escape(row.label)}</small></button>`;
}
function draw() {
  if (!state) return;
  const rows = attentionRows(state);
  const head = summary(state, rows);
  const shown = rows.slice(0, ROWS_SHOWN);
  const hidden = rows.length - shown.length;
  const folders = shown.length
    ? `<div class="tray-folders">${shown.map(folderRow).join("")}${hidden ? `<button class="tray-more-rows" data-action="open"><span class="tray-folder-name">${hidden} more · Open Arca</span></button>` : ""}</div>`
    : "";
  const progress =
    head.progress === undefined ? "" : `<progress class="tray-progress" value="${head.progress}" max="1" aria-label="Sync progress"></progress>`;
  const paused = state.phase === "paused";
  const menu = more
    ? `<div class="tray-menu tray-more-menu">${paused ? `<button data-action="resume">${icon("play")}Resume sync</button>` : `<button data-action="pause">${icon("pause")}Pause for 1 hour</button><button data-action="pause-tomorrow">${icon("moon")}Pause until tomorrow</button>`}<hr><button data-action="quit">${icon("power")}Quit Arca<kbd>⌘Q</kbd></button></div>`
    : "";
  document.querySelector("#tray-content").innerHTML =
    `<div class="tray-heading${head.ink ? ` tray-${head.ink}` : ""}"><img class="tray-brand-icon" src="assets/arca-icon-small.svg" width="28" height="28" alt="Arca"><div class="tray-title"><strong>${escape(head.title)}</strong><p>${escape(head.line)}</p>${progress}</div>${head.resume ? `<button class="primary small-button" data-action="resume">Resume</button>` : ""}${state.role === "hub" ? '<span class="tray-role">Hub</span>' : ""}</div>${update ? `<div class="tray-update">${icon("download")}<span class="tray-update-text">${escape(`Arca ${update} is ready`)}</span><button class="secondary small-button" data-action="update">Install…</button></div>` : ""}${folders}${musicBox()}<div class="tray-menu tray-foot"><button data-action="sync">${icon("refresh-cw")}Sync now</button><button data-action="open">${icon("app-window-mac")}Open Arca</button><button class="ghost icon-button tray-more" data-action="more" aria-label="More" aria-expanded="${more}">${icon("ellipsis")}</button></div>${menu}<p id="tray-error" role="alert"></p>`;
  window.lucide.createIcons({ attrs: { "stroke-width": 1.75 } });
}
const motionToken = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const motionMs = (name) => parseFloat(motionToken(name)) || 0;
function setMore(next) {
  const menu = document.querySelector(".tray-more-menu");
  more = next;
  const easing = motionToken("--motion-ease") || "ease-out";
  if (!next && menu && typeof menu.animate === "function" && motionMs("--motion-exit-fast")) {
    menu.inert = true;
    document.querySelector('[data-action="more"]')?.setAttribute("aria-expanded", "false");
    return menu
      .animate([{ opacity: 1 }, { opacity: 0 }], { duration: motionMs("--motion-exit-fast"), easing, fill: "forwards" })
      .finished.then(() => !more && draw(), () => {});
  }
  draw();
  if (next)
    document.querySelector(".tray-more-menu")?.animate?.(
      [{ opacity: 0, transform: `translateY(${-motionMs("--motion-distance") / 2}px)` }, { opacity: 1, transform: "none" }],
      { duration: motionMs("--motion-fast"), easing },
    );
}
async function run(action) {
  if (action === "more") return setMore(!more);
  if (action === "open" || action === "update") await invoke("show_main", { folder: null });
  if (action === "backup") {
    await events?.emit("notice-action", { action: "backup" });
    await invoke("show_main", { folder: null });
  }
  if (action === "quit") await invoke("quit_app");
  if (action === "start") await invoke("start_daemon");
  if (action === "sync") await api("/v1/sync", { background: true });
  if (action === "pause") await api("/v1/pause", { paused: true, seconds: 3600 });
  if (action === "pause-tomorrow") await api("/v1/pause", { paused: true, seconds: untilTomorrow() });
  if (action === "resume") await api("/v1/pause", { paused: false });
  if (["sync", "pause", "pause-tomorrow", "resume"].includes(action)) {
    more = false;
    await invoke("hide_tray");
  }
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
    if (el.dataset.folder) await invoke("show_main", { folder: el.dataset.folder });
    if (el.dataset.action) await run(el.dataset.action);
    if (el.dataset.action !== "more") await refresh();
  } catch (error) {
    const el = document.querySelector("#tray-error");
    if (el) el.textContent = String(error);
  } finally {
    running = false;
  }
});
async function checkUpdate() {
  try {
    const found = await invoke("check_update");
    update = found?.available && found.version ? found.version : null;
    draw();
  } catch {}
}
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
void checkUpdate();
setInterval(() => {
  if (!running) refresh();
}, 2000);
setInterval(checkUpdate, 6 * 60 * 60 * 1000);
addEventListener("focus", () => {
  events?.emit("music-command", { command: "state" });
  if (!running) refresh();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    if (more) setMore(false);
    else invoke("hide_tray").catch(() => {});
    return;
  }
  if (!event.metaKey && !event.ctrlKey) return;
  const action = { r: "sync", o: "open", q: "quit" }[event.key.toLowerCase()];
  if (!action || running) return;
  event.preventDefault();
  running = true;
  run(action)
    .then(() => action !== "quit" && refresh())
    .catch((error) => {
      const el = document.querySelector("#tray-error");
      if (el) el.textContent = String(error);
    })
    .finally(() => {
      running = false;
    });
});
