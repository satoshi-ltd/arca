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
let state = null,
  running = false;
async function refresh() {
  try {
    state = await api("/v1/status");
    const labels = {
      idle: "Up to date",
      syncing: "Syncing",
      paused: "Paused",
      error: "Needs attention",
      unlinked: "Disconnected",
      "needs-folder": "Choose a shared folder",
    };
    const label = labels[state.phase] || state.phase;
    const folderScroll =
      document.querySelector(".tray-folders")?.scrollTop || 0;
    document.querySelector("#tray-content").innerHTML =
      `<div class="tray-heading tray-tone-${state.phase === "error" ? "error" : state.phase === "unlinked" ? "conflict" : state.phase === "paused" ? "paused" : state.phase === "syncing" ? "syncing" : "synced"}"><img class="tray-brand-icon" src="assets/arca-icon.svg" width="28" height="28" alt="Arca"><div class="tray-title"><strong>${escape(label)}</strong><p>${state.lastSync ? "Last completed " + new Date(state.lastSync).toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }) : "Not yet verified"}</p></div><span class="tray-role">${escape(state.role)}</span></div><div class="tray-folders">${state.volumes
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
          return `<button class="tray-tone-${escape(phase)}" data-folder="${escape(v.id)}">${["scanning", "syncing"].includes(phase) ? busy() : icon(v.gallery ? "images" : "folder")}<span class="tray-folder-name">${escape(v.name)}</span><small>${escape(phase === "synced" ? bytes(v.bytes) : names[phase] || "Pending")}</small></button>`;
        })
        .join(
          "",
        )}</div><div class="tray-menu"><button data-action="sync">${icon("refresh-cw")}Sync now<kbd>⌘R</kbd></button><button data-action="pause">${icon(state.phase === "paused" ? "play" : "pause")}${state.phase === "paused" ? "Resume sync" : "Pause for 1 hour"}</button><hr><button data-action="open">${icon("app-window-mac")}Open Arca<kbd>⌘O</kbd></button><button data-action="quit">${icon("power")}Quit Arca<kbd>⌘Q</kbd></button></div><p class="tray-note">Quitting the app keeps the daemon running.</p><p id="tray-error" role="alert"></p>`;
    document.querySelector(".tray-folders").scrollTop = folderScroll;
    window.lucide.createIcons({ attrs: { "stroke-width": 1.75 } });
  } catch {
    document.querySelector("#tray-content").innerHTML =
      '<div class="tray-heading"><strong>Daemon unavailable</strong></div><div class="tray-menu"><button data-action="open">Open Arca</button></div>';
  }
}
document.addEventListener("click", async (e) => {
  const el = e.target.closest("button");
  if (!el || running) return;
  running = true;
  try {
    if (el.dataset.folder)
      await invoke("show_main", { folder: el.dataset.folder });
    if (el.dataset.action === "open")
      await invoke("show_main", { folder: null });
    if (el.dataset.action === "quit") await invoke("quit_app");
    if (el.dataset.action === "sync")
      await api("/v1/sync", { background: true });
    if (el.dataset.action === "pause")
      await api("/v1/pause", {
        paused: state.phase !== "paused",
        seconds: 3600,
      });
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
await refresh();
setInterval(() => {
  if (!running) refresh();
}, 2000);

document.addEventListener("keydown", (event) => {
  if (!event.metaKey && !event.ctrlKey) return;
  const action = { r: "sync", o: "open", q: "quit" }[event.key.toLowerCase()];
  if (!action) return;
  event.preventDefault();
  document.querySelector(`[data-action="${action}"]`)?.click();
});
