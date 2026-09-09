const native = Boolean(window.__TAURI__?.core.invoke);
// Keep native zoom bounded and persistent, matching Alpi's desktop shortcuts.
function installDesktopZoom() {
  const webview = window.__TAURI__?.webview?.getCurrentWebview();
  if (!webview) return;
  const key = "arca.ui.zoom";
  const clamp = (value) => {
    const number = Number(value);
    return Number.isFinite(number) && number > 0
      ? Math.min(1.5, Math.max(0.7, Math.round(number * 10) / 10))
      : 1;
  };
  let zoom = 1;
  try {
    zoom = clamp(localStorage.getItem(key) ?? 1);
  } catch {}
  // Serialize native calls so rapid shortcuts cannot finish out of order.
  let pending = Promise.resolve();
  const apply = (value) => {
    pending = pending.then(() => webview.setZoom(value)).catch(() => {});
  };
  apply(zoom);
  window.addEventListener("keydown", (event) => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
    const direction = ["+", "="].includes(event.key)
      ? 1
      : event.key === "-"
        ? -1
        : event.key === "0"
          ? 0
          : null;
    if (direction === null) return;
    event.preventDefault();
    zoom = direction === 0 ? 1 : clamp(zoom + direction * 0.1);
    try {
      localStorage.setItem(key, String(zoom));
    } catch {}
    apply(zoom);
  });
}
if (native) installDesktopZoom();
const $ = (selector) => document.querySelector(selector);
const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const bytes = (n = 0) =>
  n < 1024
    ? `${n} B`
    : n < 1024 ** 2
      ? `${(n / 1024).toFixed(1)} KB`
      : n < 1024 ** 3
        ? `${(n / 1024 ** 2).toFixed(1)} MB`
        : `${(n / 1024 ** 3).toFixed(1)} GB`;
const date = (value) =>
  value
    ? new Date(value).toLocaleString("en", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      })
    : "Not yet";
const relative = (value) => {
  if (!value) return "Not yet";
  const n = Math.max(0, (Date.now() - Date.parse(value)) / 1000);
  return n < 60
    ? "just now"
    : n < 3600
      ? `${Math.floor(n / 60)} min ago`
      : n < 86400
        ? `${Math.floor(n / 3600)} h ago`
        : date(value);
};
const icon = (name) => `<span data-icon="${name}" aria-hidden="true"></span>`;
const busyIcon = () =>
  '<span class="busy-grid" aria-hidden="true">' +
  "<i></i>".repeat(9) +
  "</span>";
function icons() {
  document.querySelectorAll("[data-icon]").forEach((el) => {
    const name = el.dataset.icon.replace(/(^|-)([a-z0-9])/g, (_, a, b) =>
      b.toUpperCase(),
    );
    const node = window.lucide?.icons[name];
    if (node) {
      const svg = window.lucide.createElement(node);
      for (const [key, value] of Object.entries({
        width: 16,
        height: 16,
        "stroke-width": 1.75,
        "aria-hidden": "true",
        class: "icon",
      }))
        svg.setAttribute(key, String(value));
      el.replaceWith(svg);
    }
  });
}
function pill(label, state = "id", symbol = "circle-dashed") {
  return `<span class="pill ${state}">${symbol === "busy" ? busyIcon() : icon(symbol)}${escape(label)}</span>`;
}
function button(label, action, id = "", cls = "secondary", symbol = "") {
  return `<button type="button" class="${cls}" data-action="${action}" data-id="${escape(id)}">${symbol ? icon(symbol) : ""}${label}</button>`;
}
function selectFolderButton(id) {
  return button("Select", "add", id, "secondary small-button", "download");
}
function segmented(label, items, cls = "") {
  return `<div class="segmented ${cls}" role="group" aria-label="${escape(label)}">${items.map((item) => `<button type="button" data-action="${item.action}" data-id="${escape(item.id || "")}" class="${item.active ? "active" : ""}" aria-pressed="${Boolean(item.active)}" ${item.disabled ? "disabled" : ""}>${item.symbol ? icon(item.symbol) : ""}${escape(item.label)}${item.count ? `<span class="filter-count">${Number(item.count)}</span>` : ""}</button>`).join("")}</div>`;
}
function toggleControl(id, label, checked = false, attributes = "") {
  return `<label class="toggle"><input type="checkbox" id="${id}" aria-label="${escape(label)}" ${checked ? "checked" : ""} ${attributes}><span></span></label>`;
}
function pathPicker(name, label, symbol = "folder") {
  return `<button type="button" class="icon-button field-picker" data-action="pick-path" data-id="${name}" aria-label="Choose ${escape(label)}">${icon(symbol)}</button>`;
}
function dropdown(id, label, items, selected, action) {
  const current = items.find((item) => item.id === selected) || items[0];
  return `<div class="dropdown"><button type="button" id="${id}" class="dropdown-trigger" aria-label="${escape(label)}: ${escape(current.name)}" aria-haspopup="listbox" aria-expanded="false" aria-controls="${id}-options" data-dropdown-trigger><span>${escape(current.name)}</span>${icon("chevron-down")}</button><div id="${id}-options" class="dropdown-menu" role="listbox" aria-label="${escape(label)}" hidden>${items.map((item) => `<button type="button" role="option" tabindex="-1" aria-selected="${item.id === current.id}" data-action="${action}" data-id="${escape(item.id)}"><span>${escape(item.name)}</span>${icon("check")}</button>`).join("")}</div></div>`;
}
function closeDropdown(root, restoreFocus = false) {
  root.querySelector(".dropdown-menu").hidden = true;
  const trigger = root.querySelector("[data-dropdown-trigger]");
  trigger.setAttribute("aria-expanded", "false");
  if (restoreFocus) trigger.focus();
}
function openDropdown(root, last = false) {
  document.querySelectorAll(".dropdown").forEach((other) => {
    if (other !== root) closeDropdown(other);
  });
  root.querySelector(".dropdown-menu").hidden = false;
  root
    .querySelector("[data-dropdown-trigger]")
    .setAttribute("aria-expanded", "true");
  const options = [...root.querySelectorAll('[role="option"]')];
  (last
    ? options.at(-1)
    : options.find((item) => item.getAttribute("aria-selected") === "true") ||
      options[0]
  )?.focus();
}
function title(heading, description = "", actions = "") {
  return `<div class="heading"><div><h1>${heading}</h1>${description ? `<p>${description}</p>` : ""}</div><div class="heading-actions">${actions}</div></div>`;
}
function empty(heading, text, control = "", symbol = "folder-open") {
  return `<div class="empty">${icon(symbol)}<h2>${heading}</h2>${text ? `<p>${text}</p>` : ""}${control}</div>`;
}
const section = (name, body) =>
  `<section><div class="section-label">${name}</div>${body}</section>`;
const setting = (name, description, control = "") =>
  `<div class="setting-row"><div class="row-main"><strong>${name}</strong><p>${description}</p></div>${control}</div>`;
async function browserRequest(route, body) {
  let response;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      response = await fetch(route, {
        method: body === undefined ? "GET" : "POST",
        credentials: "same-origin",
        headers:
          body === undefined ? {} : { "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      break;
    } catch {
      if (body === undefined && attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        continue;
      }
      throw Object.assign(
        new Error(
          body === undefined
            ? "Cannot reach this machine. Check your connection and retry."
            : "Connection interrupted. The result is unknown. Refresh before trying again.",
        ),
        { transportError: true, readOnly: body === undefined },
      );
    }
  }
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error("The server returned an unreadable response. Try again.");
  }
  if (!response.ok)
    throw Object.assign(new Error(data.error || "Request failed"), {
      status: response.status,
    });
  return data;
}
const invoke =
  window.__TAURI__?.core.invoke ||
  (async (command, args) => {
    if (command === "api")
      return browserRequest(
        args.route,
        args.method === "POST" ? args.body : undefined,
      );
    throw new Error("This action requires the desktop application");
  });
const api = (route, body) =>
  invoke("api", {
    route,
    method: body === undefined ? "GET" : "POST",
    body: body ?? null,
  }).catch((error) => {
    throw error instanceof Error
      ? error
      : new Error(
          typeof error === "string"
            ? error
            : error?.message || "Request failed. Try again.",
        );
  });
let dismissedStatusError = null;
let status,
  view = "folders",
  detailId = null,
  busy = false,
  ready = false,
  discovered = null,
  network = null,
  roster = null,
  catalog = [],
  catalogRequest = null,
  catalogHubName = "",
  historyVolume = "",
  historyPath = null,
  historyFilter = "revisions",
  fileOriginFolder = null,
  folderTab = "files",
  folderPrefix = "",
  folderSearch = "",
  folderSearchOpen = false,
  folderAfter = "",
  historyRows = [],
  historyNext = null,
  historyVersions = [],
  submitDialog,
  renderSerial = 0,
  lastSignature = "",
  onboarding = null;
// Hash routes also work in the native bundle and need no server rewrite rules.
function routeURL() {
  if (view === "folders")
    return "#/folders" + (detailId ? "/" + encodeURIComponent(detailId) : "");
  if (view === "history") {
    const query = new URLSearchParams();
    if (historyVolume) query.set("volume", historyVolume);
    if (historyPath) query.set("path", historyPath);
    if (historyFilter !== "revisions") query.set("filter", historyFilter);
    return "#/history" + (query.size ? "?" + query : "");
  }
  return view === "devices" ? "#/machines" : "#/settings";
}
function readRoute() {
  const [pathname, query = ""] = location.hash.slice(1).split("?");
  const parts = pathname.split("/").filter(Boolean);
  view =
    {
      folders: "folders",
      machines: "devices",
      history: "history",
      settings: "settings",
    }[parts[0]] || "folders";
  try {
    detailId =
      view === "folders" && parts[1] ? decodeURIComponent(parts[1]) : null;
  } catch {
    detailId = null;
  }
  const params = new URLSearchParams(query);
  historyVolume = params.get("volume") || "";
  historyPath = params.get("path") || null;
  historyFilter = ["revisions", "conflicts", "deleted"].includes(
    params.get("filter"),
  )
    ? params.get("filter")
    : "revisions";
}
readRoute();
window.addEventListener("hashchange", () => {
  readRoute();
  if (ready)
    action(async () => {
      await render();
      updateShell();
    });
});
let copiesRoster = null,
  copiesRequest = null,
  copiesUnavailable = false,
  copiesHub = null;
function renderCopies() {
  const box = $("#folder-copies");
  const v = status?.volumes.find((v) => v.id === detailId);
  if (!box || !v) return;
  const known = (copiesRoster?.machines || []).filter(
    (m) => m.machineId !== status.id && m.folderIds?.includes(v.id),
  );
  if (v.selected)
    known.push({
      machineId: status.id,
      name: status.name,
      isHub: status.role === "hub",
      freshness: "local",
    });
  known.sort(
    (a, b) => Number(b.isHub) - Number(a.isHub) || a.name.localeCompare(b.name),
  );
  box.innerHTML =
    known
      .map(
        (m) =>
          `<div class="copy-row">${icon(m.isHub ? "server" : "monitor")}<strong>${escape(m.name)}</strong><span class="tag ${m.machineId === status.id ? "self" : m.isHub ? "hub" : ""}">${m.machineId === status.id ? "This machine" : m.revoked ? "Access revoked" : copiesUnavailable || m.freshness === "stale" ? "Last reported" : m.isHub ? "Hub" : "Replica"}</span></div>`,
      )
      .join("") +
    (copiesUnavailable
      ? '<p class="hint">Hub unavailable. Showing last known copies.</p>'
      : !copiesRoster
        ? '<p class="hint">Checking other machines…</p>'
        : !known.length
          ? '<p class="hint">No working copies reported.</p>'
          : "") +
    (copiesRoster?.machines.some(
      (m) => !m.isHub && !m.revoked && !Array.isArray(m.folderIds),
    )
      ? '<p class="hint">Some machines have not reported their folders yet.</p>'
      : "");
  icons();
}
function refreshCopies() {
  const hub = status.hubId || status.id;
  if (copiesHub !== hub) {
    copiesRoster = null;
    copiesUnavailable = false;
    copiesHub = hub;
  }
  renderCopies();
  if (copiesRequest) return;
  copiesRequest = api("/v1/machines")
    .then((data) => {
      if (copiesHub !== hub) return;
      copiesRoster = data;
      copiesUnavailable = false;
    })
    .catch(() => {
      copiesUnavailable = true;
    })
    .finally(() => {
      copiesRequest = null;
      renderCopies();
    });
}
let preference = "system";
try {
  preference = localStorage.getItem("arca-theme") || "system";
} catch {}
function theme(value = preference) {
  preference = value;
  const dark =
    value === "dark" ||
    (value === "system" &&
      window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}
theme();
window
  .matchMedia?.("(prefers-color-scheme: dark)")
  .addEventListener?.("change", () => theme());
document.body.classList.toggle("native", native);
// The titlebar spans the window, including heading text, but never controls.
if (native) {
  document.addEventListener("mousedown", (event) => {
    const target = event.target;
    if (event.button !== 0 || !(target instanceof Element) || $("#dialog").open)
      return;
    if (
      target.closest(
        'button, a, input, select, textarea, label, summary, [role="button"], [contenteditable="true"]',
      )
    )
      return;
    if (
      event.clientY > 32 &&
      !target.closest(".heading, .detail-head, .window-drag")
    )
      return;
    event.preventDefault();
    window.__TAURI__.window
      .getCurrentWindow()
      .startDragging()
      .catch((error) => notice(String(error), true));
  });
}

function notice(message, error = false) {
  delete $("#notice").dataset.source;
  delete $("#notice").dataset.error;
  $("#notice").hidden = false;
  $("#notice").classList.toggle("error", error);
  $("#notice").innerHTML =
    `${icon(error ? "circle-alert" : "circle-check")}<span>${escape(message)}</span>${button(icon("x"), "dismiss", "", "icon-button")}`;
  $('#notice [data-action="dismiss"]')?.setAttribute(
    "aria-label",
    "Dismiss notification",
  );
  icons();
}
async function action(work) {
  if (busy) return;
  statusRequestSerial++; // Discard status reads started before this user action.
  busy = true;
  document.body.setAttribute("aria-busy", "true");
  try {
    await work();
  } catch (e) {
    if (!native && e.status === 401) {
      await showLogin("Your session has ended. Enter a new web access code.");
      return;
    }
    const message = e?.message || String(e);
    if ($("#dialog").open) {
      $("#dialog-error").textContent = message;
      $("#dialog-error").hidden = false;
    } else {
      notice(message, true);
      if (e.transportError && e.readOnly) {
        $("#notice").dataset.source = "connection";
        $("#notice").insertAdjacentHTML(
          "beforeend",
          button("Retry", "refresh", "", "secondary"),
        );
      }
    }
  } finally {
    busy = false;
    document.body.setAttribute("aria-busy", "false");
    icons();
  }
}
function stateFor(v) {
  if (status.role !== "hub" && !status.hub)
    return ["Disconnected", "id", "unplug"];
  if (!v.selected) return ["Catalog only", "id", "circle-dashed"];
  if (status.phase === "paused") return ["Paused", "id", "pause"];
  if (v.sync?.state === "error")
    return [
      /ENOENT|missing/i.test(v.sync.error || "")
        ? "Path missing"
        : /ENOSPC|space/i.test(v.sync.error || "")
          ? "Disk full"
          : /letter case|Case collision/i.test(v.sync.error || "")
            ? "Name collision"
            : "Needs attention",
      "er",
      "circle-alert",
    ];
  if (v.conflicts) return ["Conflict", "wa", "triangle-alert"];
  if (v.sync?.state === "scanning") return ["Scanning", "sy", "busy"];
  if (v.sync?.state === "syncing") return ["Syncing", "sy", "busy"];
  if (v.sync?.state === "synced") return ["Up to date", "ok", "circle-check"];
  return ["Pending", "wa", "clock"];
}
const countLabel = (n, singular, plural = `${singular}s`) =>
  `${n.toLocaleString("en")} ${n === 1 ? singular : plural}`;
const machineLabel = () =>
  native && status?.platform === "darwin" ? "this Mac" : "this machine";
const platformLabel = (value) =>
  ({ darwin: "macOS", linux: "Linux", win32: "Windows" })[value] ||
  value ||
  "Platform not reported";
const hubName = () =>
  status?.hubName ||
  catalogHubName ||
  roster?.machines?.find((m) => m.isHub)?.name ||
  discovered?.peers?.find((p) => p.arca?.id === status?.hubId)?.name ||
  (status?.role === "hub"
    ? status.name
    : status?.hub
      ? new URL(status.hub).hostname
      : "not linked");
function updateShell() {
  const nav = document.querySelector('nav [data-view="devices"]');
  if (nav) nav.innerHTML = icon("monitor-smartphone") + "Machines";

  $("#managed-role").textContent = status.role === "hub" ? "Hub" : "Replica";
  $("#managed-name").textContent = status.name;
  const states = {
    idle: ["Up to date", "ok", "circle-check"],
    paused: ["Paused", "id", "pause"],
    syncing: ["Syncing", "sy", "busy"],
    error: ["Needs attention", "er", "circle-alert"],
    unlinked: status.hub
      ? ["Connected", "id", "link"]
      : ["Disconnected", "wa", "link"],
    "needs-folder": ["No shared folders", "id", "folder"],
  };
  const conflicts = status.volumes.reduce((n, v) => n + v.conflicts, 0);
  const [label, color, symbol] = (status.phase === "idle" && conflicts
    ? ["Conflicts to review", "wa", "triangle-alert"]
    : status.phase === "idle" && !status.lastSync
      ? ["Checking sync", "id", "clock"]
      : states[status.phase]) || ["Checking sync", "id", "clock"];
  $("#connection").innerHTML =
    (symbol === "busy" ? busyIcon() : icon(symbol)) + escape(label);
  $("#connection").className = color;
  $("#last-sync").textContent =
    status.role !== "hub" && !status.hub
      ? "Local files are kept on this machine"
      : `${status.role === "hub" ? "This hub" : "Hub"}${status.lastSync ? ` · verified ${relative(status.lastSync)}` : ""}`;
  let backupText =
    status.role === "hub"
      ? "Hub backup"
      : status.backup?.enabled
        ? "Backup on"
        : "Backup off";
  $("#backup-summary").innerHTML =
    icon(
      status.role === "hub"
        ? "shield"
        : status.backup?.enabled
          ? "shield-check"
          : "shield",
    ) + backupText;
  $("#backup-summary").hidden = status.role !== "hub" && !status.hub;
  $("#backup-summary").title =
    status.role === "hub"
      ? "View reported hub backups"
      : "Manage the hub backup on this machine";
  $("#conflict-count").textContent = conflicts;
  $("#conflict-count").hidden = !conflicts;
  document.querySelectorAll("nav [data-view]").forEach((el) => {
    const active = el.dataset.view === view;
    el.classList.toggle("active", active);
    if (active) el.setAttribute("aria-current", "page");
    else el.removeAttribute("aria-current");
  });
  $(".sign-out").hidden = native;
  icons();
}
function synchronizationError() {
  const errors = (status.volumes || [])
    .filter((volume) => volume.sync?.error)
    .map((volume) => `${volume.name}: ${volume.sync.error}`);
  return errors.length ? errors.join("\n") : status.error;
}
let statusRequestSerial = 0;
async function refresh(renderView = true) {
  const request = ++statusRequestSerial;
  const next = await api("/v1/status");
  if (request !== statusRequestSerial) return lastSignature;
  status = next;
  if ($("#notice").dataset.source === "connection") {
    $("#notice").hidden = true;
    delete $("#notice").dataset.source;
  }
  ready = true;
  document.body.classList.remove("access-mode", "onboarding-mode");
  updateShell();
  if (view === "settings" && $("#backup-completion")) {
    $("#backup-completion").outerHTML = backupCompletionSetting();
    icons();
  }
  if (detailId && view === "folders") refreshCopies();
  if (!renderView && status.phase !== "paused" && status.progress?.path) {
    const p = status.progress;
    const row = [...document.querySelectorAll(".folder-card[data-id]")].find(
      (el) => el.dataset.id === p.volume,
    );
    if (row) {
      row.querySelector(".meta").textContent = progressLabel(p);
      let progress = row.querySelector("progress");
      if (!progress) {
        progress = document.createElement("progress");
        row.querySelector(".row-main").append(progress);
      }
      progress.setAttribute(
        "aria-label",
        p.stage === "upload" ? "Files sent" : "Files checked",
      );
      if (Number.isFinite(p.filesTotal) && p.filesTotal > 0) {
        progress.max = p.filesTotal;
        progress.value = p.filesDone || 0;
      } else progress.removeAttribute("value");
    }
  }
  const syncError = synchronizationError();
  if (syncError) {
    const offline =
      /fetch failed|ECONN|ENOTFOUND|timed? ?out|unreachable/i.test(syncError);
    const revoked = /401|403|revoked|credential|unauthoriz/i.test(syncError);
    const headline = revoked
      ? "Hub access needs attention"
      : offline
        ? "Hub unreachable"
        : "Synchronization needs attention";
    const description = revoked
      ? "Local files are retained. Pair again with a code from the hub."
      : offline
        ? "You can keep editing. Changes are saved locally and sent when the hub is back."
        : "Your files remain on disk. Review the affected folder and retry.";
    const box = $("#notice");
    box.hidden = dismissedStatusError === syncError;
    box.classList.add("error");
    box.dataset.source = "status";
    if (box.dataset.error !== syncError) {
      box.dataset.error = syncError;
      box.innerHTML = `${icon(offline ? "wifi-off" : "circle-alert")}<span><strong>${headline}</strong><p>${description}</p><details><summary>Details</summary>${escape(syncError)}</details></span>${button(revoked ? "Pair again…" : "Retry", revoked ? "replacement-hub" : "sync", "", "secondary")}${button(icon("x"), "dismiss", "", "icon-button")}`;
      box
        .querySelector('[data-action="dismiss"]')
        .setAttribute("aria-label", "Dismiss notification");
    }
    icons();
  } else if ($("#notice").dataset.source === "status") {
    $("#notice").hidden = true;
    delete $("#notice").dataset.error;
    dismissedStatusError = null;
  }
  const signature = JSON.stringify([
    view,
    detailId,
    status.volumes,
    status.phase,
    status.backup,
    view === "devices" ? status.devices : null,
  ]);
  if (renderView) {
    await render();
    lastSignature = signature;
  }
  return signature;
}
function syncControls(detail = false) {
  if (status.role !== "hub" && !status.hub) return "";
  const paused = status.phase === "paused";
  return (
    button(
      paused ? "Resume sync" : detail ? "Pause all sync" : "Pause sync",
      "pause",
      "",
      "secondary",
      paused ? "play" : "pause",
    ) +
    (!detail && !paused && status.phase !== "syncing"
      ? button("Sync now", "sync", "", "secondary", "refresh-cw")
      : "")
  );
}
function progressLabel(p) {
  const sending = p.stage === "upload" || p.direction === "upload";
  const count = Number.isFinite(p.filesTotal)
    ? `${(p.filesDone || 0).toLocaleString("en")} / ${p.filesTotal.toLocaleString("en")} files ${sending ? "sent" : "checked"}`
    : `${(p.filesDone || 0).toLocaleString("en")} files checked`;
  const transfer =
    p.bytesTotal > 0 ? ` · ${bytes(p.bytesDone)} / ${bytes(p.bytesTotal)}` : "";
  return `${count} · ${p.path || (sending ? "Preparing upload" : "Checking hub files")}${transfer}`;
}
function folderRow(v, available = false) {
  const p =
    status.phase !== "paused" &&
    status.progress?.volume === v.id &&
    status.progress?.path
      ? status.progress
      : null;
  const state = stateFor(v);
  const problemAction =
    state[0] === "Path missing"
      ? button(
          "Locate…",
          "locate-folder",
          v.id,
          "secondary small-button",
          "folder-input",
        )
      : state[0] === "Disk full" && native && status.role !== "hub"
        ? button(
            "Change location…",
            "move-folder",
            v.id,
            "secondary small-button",
            "folder-input",
          )
        : v.sync?.error
          ? button(
              "Review",
              "folder-detail",
              v.id,
              "secondary small-button",
              "circle-alert",
            )
          : "";
  let meta = available
    ? `${countLabel(v.files || 0, "file")} · ${bytes(v.bytes)}`
    : `${countLabel(v.files, "file")} · ${bytes(v.bytes)} · ${escape(v.path || "No visible copy selected")}`;
  if (p) meta = escape(progressLabel(p));
  if (v.sync?.error) meta = escape(v.sync.error);
  return `<article class="folder-card ${available ? "unselected" : ""}" ${available ? "" : `data-action="folder-detail" data-id="${escape(v.id)}" tabindex="0" role="button" aria-label="Open ${escape(v.name)} details"`}><div class="tile">${icon("folder")}</div><div class="row-main"><strong>${escape(v.name)}</strong><p class="meta">${meta}</p>${p ? `<progress aria-label="${p.stage === "upload" ? "Files sent" : "Files checked"}" ${p.filesTotal > 0 ? `value="${Number(p.filesDone) || 0}" max="${Number(p.filesTotal)}"` : ""}></progress>` : ""}</div>${available ? selectFolderButton(v.id) : `${problemAction || (v.conflicts ? button("Review", "folder-conflicts", v.id, "secondary small-button") : "")}<span class="row-time">${relative(v.sync?.lastCompleted)}</span>${pill(...state)}${icon("chevron-right")}`}</article>`;
}
async function loadCatalog() {
  if (status.role !== "hub" && !status.hub) {
    catalog = [];
    catalogHubName = "";
    return;
  }
  if (status.role === "hub") {
    catalog = status.volumes;
    return;
  }
  if (catalogRequest) return catalogRequest;
  catalogRequest = (async () => {
    try {
      const remote = await api("/v1/remote");
      catalog = remote.volumes;
      catalogHubName = remote.name || "";
      updateShell();
    } catch {
      // Keep the last known catalog when the hub is unavailable.
    } finally {
      catalogRequest = null;
    }
  })();
  return catalogRequest;
}
async function render() {
  const route = routeURL();
  if (location.hash !== route) window.history.pushState(null, "", route);
  document.body.classList.add("view-loading");
  try {
    await renderView();
  } finally {
    document.body.classList.remove("view-loading");
  }
}
async function renderView(refreshCatalog = true) {
  const serial = ++renderSerial;
  const content = $("#content");
  if (view === "folders") {
    if (status.role === "hub" || !catalog.length) catalog = status.volumes;
    if (detailId) {
      await renderDetail();
      icons();
      return;
    }
    const selected = status.volumes.filter((v) => v.selected),
      available = catalog.filter((v) => !selected.some((x) => x.id === v.id));
    let html = title(
      "Folders",
      status.role !== "hub" && !status.hub ? "Disconnected" : "",
      syncControls() +
        (status.role !== "hub" && !status.hub
          ? button("Connect to hub…", "connect", "", "primary", "link")
          : button(
              status.role === "hub" ? "Create shared folder" : "Choose folders",
              status.role === "hub" ? "share" : "add",
              "",
              "primary",
              "folder-plus",
            )),
    );
    html += '<div class="page">';
    if (status.role !== "hub" && !status.hub)
      html += section("Hub connection", hubConnection());
    const shown = status.role === "hub" ? status.volumes : selected;
    html += section(
      status.role === "hub"
        ? "Shared folders"
        : `Selected on ${machineLabel()}`,
      shown.length
        ? `<div class="folder-list">${shown.map((v) => folderRow(v)).join("")}</div>`
        : empty(
            status.role === "hub"
              ? "No shared folders yet"
              : `No folders on ${machineLabel()} yet`,
            status.role === "hub"
              ? "Share an existing or new folder. Other machines choose where to sync it."
              : "Pick folders from your hub. Full copies are kept on disk and work offline.",
            button(
              status.role === "hub"
                ? "Create shared folder"
                : !status.hub
                  ? "Connect to hub…"
                  : "Choose folders",
              status.role === "hub" ? "share" : !status.hub ? "connect" : "add",
              "",
              "primary",
              "folder-plus",
            ),
          ),
    );
    if (status.role !== "hub" && status.hub && available.length)
      html += section(
        "On hub · not selected",
        `<div class="folder-list">${available.map((v) => folderRow(v, true)).join("")}</div><p class="hint">Choose a local destination. Existing files join the sync; .arcaignore controls exclusions.</p>`,
      );
    content.innerHTML = html + "</div>";
    if (refreshCatalog && status.role !== "hub") {
      const previous = JSON.stringify([catalog, catalogHubName]);
      void loadCatalog().then(() => {
        if (
          serial === renderSerial &&
          view === "folders" &&
          !detailId &&
          !$("#dialog").open &&
          previous !== JSON.stringify([catalog, catalogHubName])
        ) {
          void renderView(false);
        }
      });
    }
  } else if (view === "devices") {
    await renderMachines(serial);
  } else if (view === "history") {
    if (status.role !== "hub" && !status.hub) {
      content.innerHTML =
        title("History") +
        '<div class="page">' +
        empty(
          "Connect to view history",
          "History is kept on your hub. Your local files are still available.",
          button("Connect to hub…", "connect", "", "primary", "link"),
        ) +
        "</div>";
      return;
    }
    const conflictCount = status.volumes
      .filter(
        (v) =>
          (status.role === "hub" || v.selected) &&
          (!historyVolume || v.id === historyVolume),
      )
      .reduce((n, v) => n + (v.conflicts || 0), 0);
    const filters = [
      {
        label: "Conflicts",
        count: conflictCount,
        action: "history-filter",
        id: "conflicts",
        active: historyFilter === "conflicts",
      },
      {
        label: "Deleted",
        action: "history-filter",
        id: "deleted",
        active: historyFilter === "deleted",
      },
    ];
    const historyPanel = document.createElement("div");
    await renderHistory("", false, historyPanel);
    if (serial !== renderSerial) return;
    content.innerHTML = historyPath
      ? fileHistoryHeader() +
        `<div class="page"><div class="detail-grid"><div id="history-list" class="detail-revisions">${historyPanel.innerHTML}</div>${fileHistorySide()}</div></div>`
      : title(
          "History",
          "",
          `${dropdown("history-share", "Shared folder", [{ id: "", name: "All" }, ...status.volumes.filter((v) => status.role === "hub" || v.selected)], historyVolume, "history-folder")}${segmented("History filters", filters, "history-filters")}`,
        ) +
        `<div class="page"><div id="history-list">${historyPanel.innerHTML}</div></div>`;
  } else await renderSettings();
  icons();
}
function revisionRow(v, compact = false) {
  const deleted = Boolean(v.deleted),
    conflict = v.path.includes(".conflict-");
  const target = JSON.stringify({
    volume: v.volume,
    path: v.path,
    rev: v.rev,
    deleted,
  });
  const action =
    conflict &&
    !v.resolved &&
    !deleted &&
    (status.role === "hub" ||
      status.volumes.find((x) => x.id === v.volume)?.selected)
      ? "review-conflict"
      : "activity-file";
  return `<div data-action="${action}" data-id="${escape(target)}" tabindex="0" role="button" aria-label="${escape(`${action === "review-conflict" ? "Review conflict for" : "View history for"} ${v.path}`)}" class="history-row ${compact ? "compact" : ""} ${deleted ? "deleted" : conflict && !v.resolved ? "conflict" : ""}">${icon(deleted ? "trash-2" : conflict ? "git-branch" : "git-commit-horizontal")}<div><strong>${escape(v.path)}</strong><p>${deleted ? "Deleted · recoverable" : conflict ? (v.resolved ? "Conflict resolved · copy kept" : "Conflict copy retained") : `${bytes(v.size)} · accepted revision`}</p></div>${compact ? "" : `<span class="history-folder">${escape(v.folder || status.volumes.find((x) => x.id === v.volume)?.name || "")}</span>`}<span class="mono revision">rev ${v.rev}</span><span class="row-time">${relative(v.created)}</span><div class="row-actions">${icon("chevron-right")}</div></div>`;
}
function fileHistoryHeader() {
  const volume = status.volumes.find((v) => v.id === historyVolume);
  const current = historyVersions[0];
  const filename = historyPath.split("/").at(-1);
  const available = current && !current.deleted;
  const access =
    available && native && volume?.path
      ? button(
          "Open file",
          "history-open-file",
          "",
          "secondary",
          "external-link",
        )
      : available && !native && status.role === "hub"
        ? `<a class="secondary" href="/v1/blobs/${escape(current.hash)}" download="${escape(filename)}">${icon("download")}Download file</a>`
        : "";
  const conflictAction =
    available &&
    !current.resolved &&
    historyPath.includes(".conflict-") &&
    (status.role === "hub" || volume?.selected)
      ? button(
          "Resolve conflict…",
          "review-conflict",
          JSON.stringify({ volume: historyVolume, path: historyPath }),
          "secondary",
          "git-branch",
        )
      : "";
  const finder =
    available && native && volume?.path && status.platform === "darwin"
      ? button(
          "Open in Finder",
          "history-reveal-file",
          "",
          "secondary",
          "folder-search",
        )
      : "";
  return `<div class="detail-head file-detail-head">${button(fileOriginFolder ? "Folder" : "History", fileOriginFolder ? "file-back-folder" : "history-back", "", "back", "chevron-left")}<div class="heading"><div class="detail-title"><div class="tile large">${icon("file")}</div><div><h1>${escape(filename)}</h1><p class="path">${escape(volume?.name || "Shared folder")}</p></div></div><div class="file-header-actions">${conflictAction}${finder}${access}</div></div></div><div class="file-history-summary"><div class="stats"><div class="stat"><span>Status on hub</span><strong>${current ? (current.deleted ? "Deleted" : current.resolved ? "Resolved" : "Available") : "Unknown"}</strong></div><div class="stat"><span>File size</span><strong>${available ? bytes(current.size) : "—"}</strong><p>Latest accepted version</p></div><div class="stat"><span>Latest revision</span><strong class="mono">${current ? `rev ${current.rev}` : "—"}</strong><p>${current ? escape(authorName(current.author)) : "No retained revisions"}</p></div><div class="stat"><span>Last changed</span><strong>${current ? date(current.created) : "—"}</strong><p>Accepted by the hub</p></div></div></div>`;
}

function fileHistorySide() {
  const volume = status.volumes.find((v) => v.id === historyVolume);
  const folderLink = volume
    ? button(
        "View folder",
        "history-view-folder",
        volume.id,
        "secondary",
        "folder",
      )
    : "";
  const current = historyVersions[0];
  const canDelete =
    current &&
    !current.deleted &&
    !current.directory &&
    (status.role === "hub" || volume?.selected);
  const deletion = canDelete
    ? button("Delete file…", "delete-file", "", "secondary danger", "trash-2")
    : "";
  return `<aside class="detail-side">${section("File location", `<div class="panel"><strong>${escape(volume?.name || "Shared folder")}</strong><p class="path">${escape(historyPath)}</p><div class="file-location-actions">${folderLink}${deletion}</div></div>`)}</aside>`;
}

async function folderBrowser(v, recent) {
  const tools = `<div class="folder-browser-tools">${segmented(
    "Folder content",
    [
      {
        label: "Files",
        action: "folder-tab",
        id: "files",
        active: folderTab === "files",
      },
      {
        label: "Recent",
        action: "folder-tab",
        id: "recent",
        active: folderTab === "recent",
      },
    ],
  )}<div>${folderTab === "files" ? `<button class="icon-button" data-action="folder-search-toggle" aria-label="${folderSearchOpen ? "Close search" : "Search files"}">${icon(folderSearchOpen ? "x" : "search")}</button>` : button("All history", "folder-history", v.id, "text-button")}</div></div>`;
  if (folderTab === "recent")
    return (
      tools +
      (recent.length
        ? `<div class="history-group">${recent.map((r) => revisionRow(r, true)).join("")}</div>`
        : empty("No revisions yet", "History appears after the first sync."))
    );
  const parts = folderPrefix.split("/").filter(Boolean);
  const trail = `<nav class="folder-breadcrumb" aria-label="File location">${icon("folder")}${parts.length ? button(escape(v.name), "browse-directory", "", "text-button") : `<span aria-current="location">${escape(v.name)}</span>`}${parts.map((part, i) => `${icon("chevron-right")}${i === parts.length - 1 ? `<span aria-current="location">${escape(part)}</span>` : button(escape(part), "browse-directory", parts.slice(0, i + 1).join("/"), "text-button")}`).join("")}</nav>`;
  const search = folderSearchOpen
    ? `<div class="folder-browser-search"><input id="folder-search-input" type="search" aria-label="Search files" placeholder="Search files" value="${escape(folderSearch)}" maxlength="256">${button("Search", "folder-search-apply", "", "secondary")}</div>`
    : "";
  try {
    const data = await api(
      "/v1/browse?" +
        new URLSearchParams({
          volume: v.id,
          prefix: folderPrefix,
          search: folderSearch,
          after: folderAfter,
          limit: "100",
        }),
    );
    return (
      tools +
      search +
      `<div class="history-group folder-explorer">${trail}` +
      (data.entries.length
        ? `${data.entries.map((row) => `<div class="browser-file-row" role="button" tabindex="0" data-action="${row.directory ? "browse-directory" : "activity-file"}" data-id="${escape(row.directory ? row.path : JSON.stringify({ volume: v.id, path: row.path, rev: row.rev }))}" aria-label="${escape(`Open ${row.name}`)}">${icon(row.directory ? "folder" : "file")}<div><strong>${escape(row.name)}</strong><p>${row.directory ? `${row.files} ${row.files === 1 ? "file" : "files"} · ` : ""}${bytes(row.size)}</p></div>${icon("chevron-right")}</div>`).join("")}`
        : empty(
            folderSearch ? "No matching files" : "This folder is empty",
            "",
            "",
            "folder",
          )) +
      "</div>" +
      `<div class="folder-browser-pages">${folderAfter ? button("First files", "browse-page", "", "secondary") : ""}${data.next ? button("Next files", "browse-page", data.next, "secondary") : ""}</div>`
    );
  } catch (error) {
    return (
      tools +
      search +
      `<div class="history-group folder-explorer">${trail}` +
      empty(
        "Files unavailable",
        "The daemon must support file browsing. Update it and try again.",
        button("Retry", "browse-page", folderAfter, "secondary"),
      ) +
      "</div>"
    );
  }
}

async function renderDetail() {
  const serial = renderSerial;
  const v = status.volumes.find((v) => v.id === detailId);
  if (!v) {
    detailId = null;
    return render();
  }
  if (status.role !== "hub" && !status.hub) {
    $("#content").innerHTML =
      `<div class="detail-head">${button("Folders", "back-folders", "", "back", "chevron-left")}${title(escape(v.name), escape(v.path || "Saved local copy"), native && v.path ? button(status.platform === "darwin" ? "Open in Finder" : "Open folder", "open", v.id, "secondary", "external-link") : "")}</div><div class="page">${section("Hub connection", hubConnection())}${await folderBrowser(v, [])}</div>`;
    icons();
    return;
  }
  let recent = [];
  try {
    recent = (
      await api(`/v1/activity?volume=${encodeURIComponent(v.id)}&limit=4`)
    ).versions;
  } catch {}
  if (view !== "folders" || detailId !== v.id || serial !== renderSerial)
    return;
  const browser = await folderBrowser(v, recent);
  if (serial !== renderSerial || view !== "folders" || detailId !== v.id)
    return;
  const state = stateFor(v);
  const maxRev = recent[0]?.rev;
  const unscanned = v.sync?.state === "error" && !v.sync.lastCompleted;
  const backupRecord = (status.devices || [])
    .filter((d) => !d.revoked && d.backup_enabled && d.backup_updated)
    .sort((a, b) => b.backup_updated.localeCompare(a.backup_updated))[0];
  const backupTitle =
    status.role === "hub" ? "Hub backup" : `Backup on ${machineLabel()}`;
  const backupValue =
    status.role === "hub"
      ? backupRecord
        ? `Backup reported · rev ${backupRecord.backup_revision}`
        : "No backup reported"
      : status.backup?.enabled
        ? "On"
        : "Off";
  const backupNote =
    status.role === "hub"
      ? backupRecord
        ? `By ${escape(backupRecord.name)} · ${relative(backupRecord.backup_updated)}`
        : "See Machines for hub records"
      : `Other machines: see the hub`;
  $("#content").innerHTML =
    `<div class="detail-head">${button("Folders", "back-folders", "", "back", "chevron-left")}<div class="heading"><div class="detail-title"><div class="tile large">${icon("folder")}</div><div><h1>${escape(v.name)}</h1><p class="path">${escape(v.path || "Catalog only")}</p></div></div><div class="heading-actions">${syncControls(true)}${status.role === "hub" ? button("Rename", "rename-share", v.id, "secondary", "pencil") + (v.selected ? button("Edit .arcaignore…", "edit-ignore", v.id, "secondary", "file-pen-line") : "") : ""}${native && v.path ? button(status.platform === "darwin" ? "Open in Finder" : "Open folder", "open", v.id, "secondary", "external-link") : ""}</div></div></div><div class="page"><div class="stats"><div class="stat"><span>Status</span><strong class="stat-status ${state[1]}">${state[2] === "busy" ? busyIcon() : icon(state[2])}${escape(state[0])}</strong><p>${v.sync?.lastCompleted ? `Completed ${relative(v.sync.lastCompleted)}` : "No completed sync yet"}</p></div><div class="stat"><span>Files</span><strong>${unscanned ? "Not counted" : v.files.toLocaleString("en")}</strong><p>${unscanned ? "Waiting for the first scan" : `${bytes(v.bytes)} indexed`}</p></div><div class="stat"><span>Latest known revision</span><strong class="mono">${maxRev ? `rev ${maxRev}` : "Not yet"}</strong><p>Accepted by the hub</p></div><div class="stat"><span>${backupTitle}</span><strong class="stat-backup">${icon(backupRecord || status.backup?.enabled ? "shield-check" : "shield")}${escape(backupValue)}</strong><p>${backupNote}</p></div></div><div class="detail-grid"><div class="detail-revisions">${browser}</div><div class="detail-side">${section(status.role === "hub" ? `Path on ${escape(status.name)}` : "Local destination", `<div class="panel"><p class="path">${escape(v.path || "No visible copy selected")}</p><p>${status.role === "hub" ? "Files stay on this hub’s disk. Other machines choose their own local destinations." : "Choose a location on this machine. Moving verifies the new copy and keeps the original."}</p>${native && status.role !== "hub" && v.path ? button("Change location…", "move-folder", v.id, "secondary small-button", "folder-input") : ""}</div>`)}${section("Copies", '<div class="copies-card" id="folder-copies"></div>')}<div class="panel"><h3>${status.role === "hub" ? "Hub working copy" : `Stop syncing on ${machineLabel()}`}</h3><p>${status.role === "hub" ? "Controls this hub’s folder on disk. Disabling it keeps the shared folder and history available to replicas; files remain on disk." : "Stops syncing this folder here. Files stay on disk and history is retained."}</p>${button(v.selected ? (status.role === "hub" ? "Disable local sync…" : "Unlink…") : "Select…", v.selected ? "unselect" : "add", v.id, v.selected ? "secondary danger" : "secondary", v.selected ? "unlink" : "download")}</div>${status.role === "hub" ? `<div class="panel"><h3>Delete shared folder</h3><p>Stops sharing on all machines and deletes this shared folder’s history from the hub. Physical files and existing backups are kept.</p>${button("Delete shared folder…", "delete-share", v.id, "secondary danger", "trash-2")}</div>` : ""}</div></div></div>`;
  refreshCopies();
}
async function renderHistory(cursor = "", append = false, target = null) {
  if (view === "history" && location.hash !== routeURL())
    window.history.pushState(null, "", routeURL());
  const list = target || $("#history-list");
  if (!list) return;
  if (historyPath) {
    const data = await api(
      `/v1/history?volume=${encodeURIComponent(historyVolume)}&path=${encodeURIComponent(historyPath)}&limit=50${cursor ? `&before=${cursor}` : ""}`,
    );
    historyVersions = append
      ? [...historyVersions, ...data.versions]
      : data.versions;
    list.innerHTML =
      section(
        "File revisions",
        historyVersions.length
          ? `<div class="history-group">${historyVersions.map((v, index) => `<div class="history-row file-version-row">${icon(v.deleted ? "trash-2" : "git-commit-horizontal")}<div><strong>${date(v.created)}</strong><p>${v.deleted ? "Deleted file" : bytes(v.size)} · ${escape(authorName(v.author))}</p></div><span class="mono revision">rev ${v.rev}</span><div class="row-actions">${index === 0 ? pill("Current", "id", "check") : v.deleted ? "" : button("Restore", "restore", String(v.rev), "text-button", "undo-2")}</div></div>`).join("")}</div>`
          : empty(
              "No retained revisions",
              "This file has no history available on the hub.",
            ),
      ) +
      `<p class="hint history-note">Restoring creates a new revision. Existing revisions stay in history.</p>${data.next ? `<div class="pagination">${button("Load more", "history-page", data.next)}</div>` : ""}`;
    icons();
    return;
  }
  const data = await api(
    `/v1/activity?limit=50&filter=${historyFilter}${historyVolume ? `&volume=${encodeURIComponent(historyVolume)}` : ""}${cursor ? `&before=${cursor}` : ""}`,
  );
  historyRows = append ? [...historyRows, ...data.versions] : data.versions;
  historyNext = data.next;
  const groups = new Map();
  for (const r of historyRows) {
    const day = new Date(r.created).toLocaleDateString("en", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day).push(r);
  }
  list.innerHTML = historyRows.length
    ? [...groups]
        .map(([day, rows]) =>
          section(
            day,
            `<div class="history-group">${rows.map((v) => revisionRow(v)).join("")}</div>`,
          ),
        )
        .join("") +
      `${historyNext ? `<div class="pagination">${button("Load more", "history-page", historyNext)}</div>` : ""}`
    : empty(
        "Every change has a history",
        "Accepted revisions appear here after files synchronize.",
      );
  icons();
}
const machineRow = (
  name,
  tags,
  description,
  sub,
  state,
  controls = "",
  self = false,
  hub = false,
  dashed = false,
  metadata = "",
  totals = "",
) =>
  `<article class="device-row ${dashed ? "discovered" : ""}"><div class="tile large ${hub ? "hub" : ""}">${icon(hub ? "server" : /ios|android|iphone|ipad/i.test(metadata) ? "smartphone" : "monitor")}</div><div class="row-main"><div class="row-tags"><strong>${escape(name)}</strong>${tags}${self ? '<span class="tag self">This machine</span>' : ""}</div><p class="connection-line">${[metadata, description].filter(Boolean).join(" · ")}</p></div><div class="row-end">${state}${totals ? `<span class="hint">${totals}</span>` : ""}</div>${controls}</article>`;

async function renderMachines(serial = renderSerial) {
  let issue = "";
  try {
    discovered = await api("/v1/discovery");
  } catch (e) {
    discovered = null;
    issue = e.message;
  }
  try {
    roster = await api("/v1/machines");
  } catch {
    roster = null;
  }
  if (view !== "devices" || serial !== renderSerial) return;
  updateShell();
  const peers = discovered?.peers || [],
    consumed = new Set();
  const take = (predicate) => {
    const p = peers.find((p) => !consumed.has(p.id) && predicate(p));
    if (p) consumed.add(p.id);
    return p;
  };
  const connection = (p, address) =>
    p
      ? `Tailscale · ${escape(p.addresses?.[0] || "")}`
      : address
        ? escape(address)
        : "";
  const platform = (p) =>
    p ? escape(platformLabel(p.os || p.arca.platform)) : "";
  const row = machineRow;
  const summary = "";
  let machineRows = "";
  let html =
    status.role === "replica" ? section("Hub connection", hubConnection()) : "";
  const selfAddress = discovered?.tailscale?.self?.addresses?.[0];
  if (status.role === "hub")
    machineRows += row(
      status.name,
      '<span class="tag hub">Hub</span>',
      selfAddress ? `Tailscale · ${escape(selfAddress)}` : "",
      "",
      pill(
        status.phase === "paused" ? "Paused" : "Running",
        status.phase === "paused" ? "id" : "ok",
        status.phase === "paused" ? "pause" : "circle-check",
      ),
      "",
      true,
      true,
      false,
      escape(platformLabel(status.platform)),
      `${status.volumes.length} shared folders · ${bytes(status.volumes.reduce((n, v) => n + v.bytes, 0))} in catalog`,
    );
  else if (status.hub && status.role !== "replica") {
    const hubError =
      /fetch failed|ECONN|ENOTFOUND|timed? ?out|unreachable|401|403|revoked|credential|unauthoriz/i.test(
        status.error || "",
      );
    const p = take(
      (p) =>
        p.arca.id === status.hubId ||
        p.addresses.includes(new URL(status.hub).hostname),
    );
    machineRows += row(
      p?.name || hubName(),
      '<span class="tag hub">Hub</span>',
      p ? connection(p) : escape(status.hub),
      status.lastSync ? `Last sync ${relative(status.lastSync)}` : "",
      pill(
        status.lastSync && !hubError
          ? "Connected"
          : hubError
            ? "Needs attention"
            : "Linked",
        hubError ? "wa" : "id",
        hubError ? "circle-alert" : "link",
      ),
      "",
      false,
      true,
      false,
      platform(p),
      `${countLabel(catalog.length, "shared folder")} in catalog`,
    );
  } else if (status.role !== "replica")
    html += section(
      "Hub",
      empty(
        "No hub linked",
        "Connect using a pairing code issued by your hub.",
        button("Connect to a hub", "connect", "", "primary", "link"),
      ),
    );
  if (status.role !== "hub")
    machineRows += row(
      status.name,
      `<span class="tag">${escape(status.role)}</span>${status.backup?.enabled ? '<span class="tag backup">Backs up hub</span>' : ""}`,
      selfAddress ? `Tailscale · ${escape(selfAddress)}` : "",
      "",
      pill(
        !status.hub
          ? "Disconnected"
          : status.phase === "idle"
            ? "Up to date"
            : status.phase === "paused"
              ? "Paused"
              : status.phase === "error"
                ? "Needs attention"
                : "Syncing",
        !status.hub
          ? "wa"
          : status.phase === "idle"
            ? "ok"
            : status.phase === "error"
              ? "er"
              : status.phase === "paused"
                ? "id"
                : "sy",
        !status.hub
          ? "unlink"
          : status.phase === "idle"
            ? "circle-check"
            : status.phase === "error"
              ? "circle-alert"
              : status.phase === "paused"
                ? "pause"
                : "busy",
      ),
      "",
      true,
      false,
      false,
      escape(platformLabel(status.platform)),
      `${status.volumes.filter((v) => v.selected).length} folders · ${bytes(status.volumes.filter((v) => v.selected).reduce((n, v) => n + v.bytes, 0))} local`,
    );
  if (status.role === "hub" && status.devices.length) {
    let records = "";
    for (const d of status.devices) {
      const report = roster?.machines?.find((m) => m.credentialId === d.id);
      const p = take(
        (p) =>
          (Boolean(d.last_address) && p.addresses.includes(d.last_address)) ||
          (Boolean(report?.machineId) && p.arca.id === report.machineId),
      );
      const state = d.revoked
        ? pill("Revoked", "er", "unlink")
        : p?.online === false
          ? pill("Offline", "id", "circle-dashed")
          : !d.last_seen
            ? pill("Invitation only", "wa", "clock")
            : pill("Linked", "id", "link");
      const tags = `<span class="tag">${escape(d.role)}</span>${d.backup_enabled ? '<span class="tag backup">Backs up hub</span>' : ""}`;
      records += row(
        report?.name || d.name,
        tags,
        connection(p, d.last_address),
        "",
        state,
        d.revoked
          ? ""
          : `<details class="details-menu"><summary class="icon-button" aria-label="Actions for ${escape(d.name)}">${icon("ellipsis")}</summary><div class="menu-items">${button("Disconnect", "revoke", d.id, "secondary danger", "unplug")}</div></details>`,
        false,
        false,
        !d.last_seen,
        p ? platform(p) : escape(platformLabel(report?.platform || "")),
      );
    }
    machineRows += records;
  }
  if (status.role !== "hub" && status.hub) {
    const others =
      roster?.machines?.filter((m) => !m.isHub && m.machineId !== status.id) ||
      [];
    machineRows += others.length
      ? others
          .map((m) =>
            row(
              m.name,
              `<span class="tag">${escape(m.role)}</span>`,
              connection(
                peers.find(
                  (p) =>
                    p.arca.id === m.machineId ||
                    p.addresses?.includes(m.lastAddress),
                ),
                m.lastAddress,
              ),
              "",
              pill(
                m.revoked ? "Revoked" : "Linked",
                m.revoked ? "er" : "id",
                m.revoked ? "unlink" : "link",
              ),
              "",
              false,
              false,
              false,
              escape(platformLabel(m.platform || "")),
            ),
          )
          .join("")
      : roster
        ? ""
        : empty(
            "Machine list unavailable",
            "Reconnect to the hub to see its machines.",
          );
  }
  html += section("Machines", machineRows);
  const found = peers.filter(
    (p) =>
      !consumed.has(p.id) &&
      (status.role === "hub"
        ? p.arca.role !== "hub"
        : !status.hub && p.arca.role === "hub") &&
      ["available", "incompatible"].includes(p.arca.state),
  );
  if (found.length)
    html += section(
      status.role === "hub"
        ? "Detected machines · not authorized"
        : "Detected hubs",
      found
        .map((p) =>
          row(
            p.name,
            `<span class="tag">${escape(p.arca.role || "Arca")}</span>`,
            connection(p),
            "",
            p.arca.state === "incompatible"
              ? pill("Incompatible Arca", "er", "circle-alert")
              : pill("Arca detected", "sy", "circle-dot"),
            p.arca.state === "available"
              ? status.role === "hub"
                ? button(
                    "Pair…",
                    "invite",
                    p.name,
                    "secondary small-button",
                    "key-round",
                  )
                : !status.hub && p.arca.role === "hub"
                  ? button(
                      "Connect…",
                      "connect-discovered",
                      p.id,
                      "secondary small-button",
                      "link",
                    )
                  : ""
              : "",
            false,
            false,
            true,
            `${platform(p)} · Arca ${escape(p.arca.version || "")}`,
          ),
        )
        .join(""),
    );
  if (found.length)
    html +=
      '<p class="hint">Detection does not connect machines. A pairing code is required.</p>';
  if (issue)
    html += `<p class="hint">Discovery unavailable: ${escape(issue)}</p>`;
  if (status.role === "hub" || status.hub)
    html += section("Hub backup", backupSummary());
  $("#content").innerHTML =
    title(
      "Machines",
      summary,
      status.role === "hub"
        ? button("Pair a machine", "invite", "", "primary", "key-round")
        : "",
    ) + `<div class="page" id="devices-list">${html}</div>`;
  icons();
}
function backupCompletionSetting() {
  return setting(
    "Last completed backup",
    `${date(status.backup?.lastSync)}${!status.backup?.lastSync || status.backup?.contentBytes == null ? "" : ` · ${bytes(status.backup.contentBytes)}`}${status.backup?.error ? ` · ${escape(status.backup.error)}` : ""}`,
    pill(
      status.backup?.error
        ? "Needs attention"
        : status.backup?.enabled
          ? status.backup.lastSync
            ? "Completed"
            : "Pending"
          : "Off",
      status.backup?.error ? "er" : "id",
      "shield",
    ),
  ).replace("<div ", '<div id="backup-completion" ');
}
function backupSummary() {
  if (status.role !== "hub")
    return `<div class="backup-card">${icon(status.backup?.enabled ? "shield-check" : "shield-off")}<div class="row-main"><strong>${status.backup?.enabled ? "On this machine" : "Off on this machine"}</strong><p>${status.backup?.enabled ? (status.backup.error ? `Needs attention: ${escape(status.backup.error)}` : status.backup.lastSync ? `${status.backup.folders || 0} folders · ${Number(status.backup.revisions || 0).toLocaleString()} revisions · Last completed ${relative(status.backup.lastSync)}` : "Waiting for the first completed backup") : "Keep a full copy of the hub and its history."}</p></div>${button("Backup settings", "backup-settings", "", "secondary small-button")}</div>`;
  const a = status.devices.filter((d) => !d.revoked && d.backup_enabled);
  return a.length
    ? a
        .map(
          (d) =>
            `<div class="backup-card">${icon("shield-check")}<div class="row-main"><strong>${escape(d.name)} backs up this hub</strong><p>${d.backup_updated ? `Last report ${date(d.backup_updated)} · history rev ${d.backup_revision || 0}` : "Waiting for the first backup report."}</p></div>${pill(d.backup_updated ? "Reported" : "Pending", "id", "clock")}</div>`,
        )
        .join("")
    : `<div class="backup-card">${icon("shield-alert")}<div class="row-main"><strong>No hub backup recorded</strong><p>Enable backup in a linked machine’s Settings.</p></div></div>`;
}
function hubConnection() {
  const connected = Boolean(status.hub);
  if (connected) {
    const hub = roster?.machines?.find((m) => m.isHub);
    const address = new URL(status.hub);
    const vpn = discovered?.peers?.some((peer) =>
      peer.addresses?.includes(address.hostname),
    );
    return machineRow(
      hubName(),
      '<span class="tag hub">Hub</span>',
      escape(
        [vpn ? "Tailscale" : "", address.host].filter(Boolean).join(" · "),
      ),
      "",
      "",
      status.role === "replica"
        ? button(
            "Disconnect…",
            "disconnect-hub",
            "",
            "secondary small-button danger",
            "unplug",
          )
        : "",
      false,
      true,
      false,
      hub?.platform ? escape(platformLabel(hub.platform)) : "",
    );
  }
  return `<div class="settings-card">${setting(connected ? `Connected to ${escape(hubName())}` : "Not connected", connected ? `<span class="path">${escape(status.hub)}</span>` : "Your local files and saved destinations are kept. Enter a new pairing code to connect.", connected ? (status.role === "replica" ? button("Disconnect…", "disconnect-hub", "", "secondary small-button danger", "unplug") : pill("Backup connection", "id", "shield")) : button(status.disconnectedHub ? "Reconnect…" : "Connect to hub…", "connect", "", "primary", "link"))}</div>`;
}
async function renderSettings() {
  try {
    network = await api("/v1/network");
  } catch {
    network = null;
  }
  const controls =
    status.role !== "hub" && !status.hub
      ? ""
      : button(
          status.phase === "paused" ? "Resume sync" : "Pause sync",
          "pause",
          "",
          "secondary small-button",
          status.phase === "paused" ? "play" : "pause",
        ) +
        button("Sync now", "sync", "", "secondary small-button", "refresh-cw");
  let html = title("Settings", "") + '<div class="page">';
  if (status.role !== "hub") html += section("Hub connection", hubConnection());
  html += section(
    "This machine",
    `<div class="settings-card">${setting("Machine name", "Shown to other machines and in history.", `<input id="machine-name" aria-label="Machine name" maxlength="100" value="${escape(status.name)}">`)}${setting("Default folder location", `<span class="path">${escape(status.root)}</span>`, button("Copy path", "copy", status.root, "secondary small-button", "copy"))}</div>`,
  );
  html += section(
    status.role === "hub" ? "Hub synchronization" : "Local synchronization",
    `<div class="settings-card">${setting(status.role !== "hub" && !status.hub ? "Disconnected" : status.phase === "paused" ? "Paused" : "Enabled", status.role === "hub" ? "Synchronizes this hub’s working folders with connected replicas." : "Synchronizes the folders selected on this machine.", `<div class="form-actions">${controls}</div>`)}</div>`,
  );
  if (status.role === "hub")
    html += section(
      "Access to this hub",
      `<div class="settings-card">${setting("Authorized machines", "Issue pairing codes and remove machines from this hub.", button("Manage machines", "machines", "", "secondary small-button", "monitor-smartphone"))}</div>`,
    );
  if (!native)
    html += section(
      "Browser session",
      `<div class="settings-card">${setting("This browser", `Signed in to ${escape(status.name)}. Signing out does not stop synchronization.`, button("Sign out", "logout", "", "secondary small-button", "log-out"))}${setting("Other browser sessions", `Sign out every browser managing ${escape(status.name)}. Machine connections are kept.`, button("Sign out all browsers…", "logout-all", "", "secondary small-button danger", "log-out"))}</div>`,
    );
  if (native)
    html += section(
      "Desktop preferences",
      `<div class="settings-card">${status.platform === "darwin" ? setting("Launch at login", "Start synchronization when you sign in to this Mac.", '<div id="service-control"><span class="hint">Checking service…</span></div>') : ""}${setting("System notifications", "Show system notifications for conflicts, hub errors and stopped backups.", toggleControl("notifications-enabled", "Enable system notifications"))}</div>`,
    );
  html += section(
    status.role === "hub" ? "Hub backup" : "Full backup on this machine",
    status.role === "hub"
      ? backupSummary()
      : !status.hub
        ? '<div class="panel"><p>Connect to a hub first.</p></div>'
        : `<div class="settings-card">${setting(`Keep a full backup of the hub here`, "Every shared folder and its retained history, in a dedicated folder outside your synced folders. Your own folders keep syncing. This copy never publishes edits.", toggleControl("backup-enabled", "Enable hub backup", status.backup?.enabled, "data-backup-toggle"))}${setting("Backup location", `<span class="path">${escape(status.backup?.path || "Not configured")}</span>`, status.backup?.path ? button("Copy path", "copy", status.backup.path, "secondary small-button", "copy") : button("Choose…", "enable-backup", "", "secondary small-button", "folder-input"))}${backupCompletionSetting()}</div>`,
  );
  if (status.role === "hub")
    html += section(
      "History retention",
      `<div class="settings-card">${setting("Kept", `${status.historyRevisions} accepted revisions. No scheduled cleanup exists.`, button("Preview cleanup…", "retention", "", "secondary small-button", "history"))}${setting("Limits", "Preview always precedes applying. Current versions, pending writes and history not yet received by backups are protected.", `<span class="mono">${status.retention.days || 0} days · ${status.retention.versions || 0} versions</span>`)}</div>`,
    );
  html += section(
    "Tailscale",
    `<div class="settings-card">${setting(
      "Connection mode",
      network
        ? network.mode === "tailscale"
          ? "Encrypted access through your Tailscale network. Pairing is still required."
          : "Uses the configured server address without adding a Tailscale listener."
        : "Network information unavailable.",
      segmented(
        "Network mode",
        ["standalone", "tailscale"].map((m) => ({
          action: m,
          label: m === "tailscale" ? "Tailscale" : "Standalone",
          symbol: m === "tailscale" ? "shield-check" : "cable",
          active: network?.mode === m,
          disabled:
            m === "tailscale" && network?.tailscale.state !== "connected",
        })),
      ),
    )}${setting("Tailscale addresses", `<span class="path">${escape(network?.tailscale?.self?.addresses?.join(" · ") || "No Tailscale address")} · port ${status.port || 47831}</span>`, pill(network?.publishing ? "Discoverable" : "Not advertised", "id", "wifi"))}</div>`,
  );
  if (status.role === "hub")
    html += section(
      "Local network",
      `<div class="settings-card">${setting("Allow HTTP connections", "Pair and sync over your local network without Tailscale. Files and credentials are not encrypted.", toggleControl("allow-lan-http", "Allow HTTP on local network", network?.allowLanHttp === true, network ? "" : "disabled"))}</div><p class="hint">Can be used alongside Tailscale. The hub’s port must be reachable on your LAN; do not forward it to the Internet.</p>`,
    );
  html += section(
    "Machine discovery",
    `<div class="settings-card">${setting("Find machines on Tailscale", "Look for Arca on connected machines. Finding a machine does not link it.", button("Refresh", "network-refresh", "", "secondary small-button", "refresh-cw"))}</div>`,
  );
  html += section(
    "Service",
    `<div class="settings-card">${setting("Runtime", `<span class="mono">Port ${status.port || 47831} · Node ${escape(status.nodeVersion || "24")}</span>`, "")}${setting("State and index", `<span class="path">${escape(status.statePath || "Not reported")}</span>`, status.statePath ? button("Copy path", "copy", status.statePath, "secondary small-button", "copy") : "")}</div>`,
  );
  if (status.role === "replica" && status.hub)
    html += section(
      "Recovery",
      `<div class="settings-card">${setting("Become the replacement hub", "Requires complete copies of every known shared folder and the old hub stopped.", button("Review…", "promote", "", "secondary small-button"))}${setting("Reconnect to a hub", "Local files remain. Hub backup must be disabled first.", button("Reconnect…", "replacement-hub", "", "secondary small-button", "link"))}</div>`,
    );
  html += section(
    "Appearance · about",
    `<div class="settings-card">${setting(
      "Theme",
      "Use light, dark or your system appearance.",
      segmented(
        "Theme",
        ["light", "dark", "system"].map((t) => ({
          action: "theme",
          id: t,
          label: t[0].toUpperCase() + t.slice(1),
          symbol: t === "light" ? "sun" : t === "dark" ? "moon" : "monitor",
          active: preference === t,
        })),
      ),
    )}${setting("Arca v0.3.3 alpha", `<span class="mono">node ${escape(status.id)} · protocol v${status.protocol} · ${escape(platformLabel(status.platform))}</span>`, button("Copy diagnostics", "diagnostics", "", "secondary small-button", "copy"))}</div>`,
  );
  $("#content").innerHTML = html + "</div>";
  $("#machine-name").onchange = () =>
    action(async () => {
      await api("/v1/settings", { name: $("#machine-name").value });
      await refresh(false);
      notice("Machine name updated.");
    });
  if (native) {
    invoke("desktop_preferences")
      .then((p) => {
        if (view !== "settings") return;
        const el = $("#service-control");
        if (el)
          el.innerHTML = toggleControl(
            "launch-at-login",
            "Launch at login",
            p.launchAtLogin,
          );
        if ($("#notifications-enabled"))
          $("#notifications-enabled").checked = p.notifications;
      })
      .catch(() => {
        if ($("#service-control"))
          $("#service-control").textContent = "Service status unavailable";
      });
  }
  icons();
}
function modalHeader(heading, description, symbol = "folder") {
  return `<div class="modal-title"><div class="tile">${icon(symbol)}</div><div><h2 id="dialog-title">${heading}</h2><p>${description}</p></div></div>`;
}
function modal(html, submit, label = "Save", wide = false) {
  $("#dialog-error").hidden = true;
  $("#dialog-extra-actions")?.remove();
  $("#cancel-dialog").hidden = false;
  $("#dialog-content").onclick = null;
  $("#dialog-content").innerHTML = html;
  $("#dialog").className = wide ? "wide-dialog" : "";
  $("#submit-dialog").textContent = label;
  $("#submit-dialog").hidden = false;
  $("#submit-dialog").disabled = false;
  $("#submit-dialog").className = "primary";
  $("#cancel-dialog").textContent = "Cancel";
  submitDialog = submit;
  for (const item of $("#dialog-content").querySelectorAll("label")) {
    const field = item.nextElementSibling;
    if (field?.matches("input,select,textarea")) {
      field.id = `dialog-${field.name}`;
      item.htmlFor = field.id;
    }
  }
  if (!$("#dialog").open) $("#dialog").showModal();
  icons();
}
let dialogSubmitting = false;
$("#cancel-dialog").onclick = () => {
  if (!dialogSubmitting) $("#dialog").close();
};
$("#dialog").addEventListener("cancel", (event) => {
  if (dialogSubmitting) event.preventDefault();
});
// Form dialogs close explicitly; scrolling or releasing on the backdrop must not discard drafts.
$("#dialog-form").onsubmit = (event) => {
  event.preventDefault();
  action(async () => {
    const control = $("#submit-dialog");
    control.disabled = true;
    control.setAttribute("aria-busy", "true");
    dialogSubmitting = true;
    $("#cancel-dialog").disabled = true;
    try {
      $("#dialog-error").hidden = true;
      const complete = await submitDialog(new FormData(event.target));
      if (complete === false) return;
      $("#dialog").close();
      await refresh();
    } finally {
      dialogSubmitting = false;
      control.removeAttribute("aria-busy");
      $("#cancel-dialog").disabled = false;
      control.disabled = false;
    }
  });
};
function textField(label, name, value = "", symbol = "folder", mono = false) {
  return `<label for="field-${name}">${label}</label><div class="field-with-icon">${icon(symbol)}<input id="field-${name}" aria-label="${label}" class="${mono ? "mono" : ""}" name="${name}" value="${escape(value)}" required></div>`;
}
function pathInput(label, name, value = "", symbol = "folder") {
  return `<label for="field-${name}">${label}</label><div class="field-with-icon">${native ? pathPicker(name, label, symbol) : icon(symbol)}<input id="field-${name}" aria-label="${label}" class="mono" name="${name}" value="${escape(value)}" required></div>`;
}
function checkFolderPath(name, id = "") {
  const input = $(`#dialog [name="${name}"]`);
  const row = document.createElement("div");
  row.className = "path-check";
  row.setAttribute("role", "status");
  row.id = "folder-path-status";
  input.setAttribute("aria-describedby", row.id);
  const selection = input.closest(".folder-selection");
  if (selection) {
    row.classList.add("selection-check");
    selection.querySelector(".selection-path").after(row);
  } else {
    const hint = input.parentElement.nextElementSibling;
    (hint?.classList.contains("hint") ? hint : input.parentElement).after(row);
  }
  let sequence = 0;
  let timer;
  const check = async () => {
    const serial = ++sequence;
    $("#submit-dialog").disabled = true;
    row.classList.remove("path-check-error");
    input.removeAttribute("aria-invalid");
    const shareName = $('#dialog [name="name"]');
    if (shareName && !shareName.value.trim()) {
      row.textContent = "Enter a shared folder name to check its location.";
      return;
    }
    if (!input.value.trim()) {
      row.textContent = "Choose a folder to check its location.";
      return;
    }
    const ignoreOption = $("#create-ignore-option");
    if (ignoreOption) {
      ignoreOption.hidden = true;
      ignoreOption.querySelector("input").disabled = true;
    }
    row.textContent = "Checking path…";
    try {
      const result = await api("/v1/path-check", { path: input.value, id });
      if (serial !== sequence || !row.isConnected) return;
      if (ignoreOption) {
        const checkbox = ignoreOption.querySelector("input");
        ignoreOption.hidden = result.exists;
        checkbox.disabled = result.exists;
        if (result.exists) checkbox.checked = false;
      }
      row.classList.remove("path-check-error");
      const capacity = `${bytes(result.freeBytes)} free`;
      row.innerHTML = selection
        ? `<span>${result.exists ? "Counting local files…" : "New folder"} · ${capacity}</span>`
        : icon("circle-check") +
          `<span>${result.exists ? "Existing folder" : "New folder"} · ${capacity}<br><span class="mono">${escape(result.path)}</span></span>`;
      $("#submit-dialog").disabled = false;
      icons();
      if (selection && result.exists) {
        try {
          const counted = await api("/v1/path-check", {
            path: input.value,
            id,
            preview: true,
          });
          if (serial !== sequence || !row.isConnected) return;
          const p = counted.preview;
          row.textContent = p?.complete
            ? `${p.files ? `${p.files.toLocaleString("en")} local ${p.files === 1 ? "file" : "files"} to sync · ${bytes(p.bytes)}` : "No local files to sync"} · ${capacity}${p.skipped ? " · some entries skipped" : ""}`
            : `Count unavailable · ${capacity}`;
        } catch {
          if (serial === sequence && row.isConnected)
            row.textContent = `Count unavailable · ${capacity}`;
        }
      }
    } catch (error) {
      if (serial !== sequence || !row.isConnected) return;
      row.classList.add("path-check-error");
      input.setAttribute("aria-invalid", "true");
      const message =
        error.message === "State and volume paths overlap"
          ? "Choose a folder outside Arca’s application data."
          : error.message;
      row.innerHTML = icon("circle-alert") + `<span>${escape(message)}</span>`;
      icons();
    }
  };
  input.addEventListener("input", () => {
    sequence++;
    $("#submit-dialog").disabled = true;
    clearTimeout(timer);
    timer = setTimeout(check, 250);
  });
  check();
}
function codeFields(prefix = "code") {
  return `<div class="code-inputs" role="group" aria-label="Six-digit code">${Array.from({ length: 6 }, (_, i) => `${i === 3 ? '<span class="separator">—</span>' : ""}<input inputmode="numeric" autocomplete="${i === 0 ? "one-time-code" : "off"}" aria-label="Code digit ${i + 1}" data-code="${prefix}" data-digit="${i}" pattern="[0-9]" maxlength="1" value="">`).join("")}</div>`;
}
const readCode = (prefix) =>
  [...document.querySelectorAll(`[data-code="${prefix}"]`)]
    .map((el) => el.value)
    .join("");
document.addEventListener("input", (e) => {
  const el = e.target;
  if (!el.matches("[data-code]")) return;
  el.value = el.value.replace(/\D/g, "").slice(-1);
  if (el.value)
    document
      .querySelector(
        `[data-code="${el.dataset.code}"][data-digit="${Number(el.dataset.digit) + 1}"]`,
      )
      ?.focus();
});
document.addEventListener("paste", (e) => {
  const el = e.target;
  if (!el.matches("[data-code]")) return;
  const digits = (e.clipboardData.getData("text") || "").replace(/[\s-]/g, "");
  if (!/^\d{1,6}$/.test(digits)) return;
  e.preventDefault();
  const inputs = [
    ...document.querySelectorAll(`[data-code="${el.dataset.code}"]`),
  ];
  const start = digits.length === 6 ? 0 : Number(el.dataset.digit);
  [...digits].forEach((d, i) => {
    if (inputs[start + i]) inputs[start + i].value = d;
  });
  inputs[Math.min(5, start + digits.length)]?.focus();
});
document.addEventListener("keydown", (e) => {
  const el = e.target;
  if (el.matches("[data-code]")) {
    let next =
      Number(el.dataset.digit) +
      (e.key === "ArrowRight"
        ? 1
        : e.key === "ArrowLeft" || (e.key === "Backspace" && !el.value)
          ? -1
          : 0);
    if (next !== Number(el.dataset.digit)) {
      e.preventDefault();
      document
        .querySelector(`[data-code="${el.dataset.code}"][data-digit="${next}"]`)
        ?.focus();
    }
  }
  if (
    el.matches('.folder-card[role="button"], .history-row[role="button"]') &&
    ["Enter", " "].includes(e.key)
  ) {
    e.preventDefault();
    el.click();
  }
});
function connectModal(endpoint = "", recovery = false) {
  endpoint ||= status.hub || status.disconnectedHub?.url || "";
  modal(
    modalHeader(
      recovery
        ? "Reconnect to a replacement hub"
        : status.disconnectedHub
          ? "Reconnect to your hub"
          : "Connect to your hub",
      "Detection does not link a machine. Enter the code issued by the hub administrator.",
      "key-round",
    ) +
      `<label for="hub-address">Hub address</label><input id="hub-address" name="url" class="mono" value="${escape(endpoint)}" placeholder="https://arca.your-network" required><label>Pairing code</label>${codeFields("pair")}<p class="hint">Six digits, leading zeroes included. Works once; expires ten minutes after the hub generated it. Generating a new code invalidates the previous one.</p><p class="hint">Use HTTPS, verified Tailscale, or a private IPv4 address when the hub allows local network HTTP.</p>${recovery ? '<p class="hint">Replacing the hub reconnects existing folders, keeps local files and preserves differences as conflicts.</p>' : ""}`,
    async (f) => {
      const code = readCode("pair");
      if (code.length !== 6) throw new Error("Enter all six digits.");
      let endpoint;
      try {
        endpoint = new URL(f.get("url").trim());
      } catch {
        throw new Error(
          "Enter the full hub address, including http:// or https:// and its port.",
        );
      }
      const result = await api("/v1/connect", {
        url: endpoint.origin,
        code,
        reconcile: recovery,
      });
      catalog = [];
      catalogHubName = result.name || "";
      roster = null;
      notice(
        status.volumes.length
          ? "Connected. Saved local folders will be checked before syncing."
          : "Connected. Choose which folders to download.",
      );
    },
    recovery ? "Replace hub and reconnect" : "Connect",
  );
}
function pairingAddresses(info) {
  const addresses = [];
  if (
    !native &&
    !["localhost", "127.0.0.1", "[::1]"].includes(location.hostname)
  )
    addresses.push(location.origin);
  if (info?.tailscale?.state === "connected") {
    const ips = info.tailscale.self?.addresses || [];
    const ip = ips.find((value) => !value.includes(":")) || ips[0];
    if (ip)
      addresses.push(
        `http://${ip.includes(":") ? `[${ip}]` : ip}:${status.port || 47831}`,
      );
    const dns = info.tailscale.self?.dnsName?.replace(/\.$/, "");
    if (dns) addresses.push(`http://${dns}:${status.port || 47831}`);
  }
  return [...new Set(addresses)].slice(0, 2);
}
async function pairModal(name = "") {
  let info;
  try {
    info = await api("/v1/network");
  } catch {}
  const addresses = pairingAddresses(info);
  const addressPanel = addresses.length
    ? `<div class="settings-card">${addresses.map((address, index) => setting(index ? "Alternative address" : "Hub address", `<span class="path">${escape(address)}</span>`, button("Copy address", "copy", address, "secondary small-button", "copy"))).join("")}</div>`
    : '<p class="hint">Use this hub’s reachable hostname or IP with its API port. A localhost address only works on this machine.</p>';
  let invitation;
  const create = async () => {
    invitation = await api("/v1/pairing", {
      name: name || "New machine",
      role: "replica",
    });
    const code = String(invitation.code);
    $('[data-action="copy-pair"]').innerHTML = icon("copy") + "Copy code";
    icons();
    $("#pair-code").textContent = code.slice(0, 3) + " — " + code.slice(3);
    $("#pair-validity").textContent = invitation.expires
      ? `Valid until ${new Date(invitation.expires).toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })} · single use`
      : "Single use · expires ten minutes after generation";
  };
  modal(
    modalHeader(
      "Pair a machine",
      "On the new desktop, open Machines → Connect to hub. Enter the address and pairing code below.",
      "key-round",
    ) +
      addressPanel +
      `<p class="hint">Include the full address, with http:// or https:// and its port. A hostname works when the new machine can resolve it; otherwise use the IP address. For HTTP, use Tailscale on both machines or enable local network HTTP in the hub’s Settings and use its private IPv4 address.</p><div class="section-label">Pairing code</div><div class="code-display" id="pair-code">··· — ···</div><div class="code-toolbar"><p class="code-expiry" id="pair-validity">Generating code…</p><div class="form-actions">${button("Copy code", "copy-pair", "", "secondary small-button", "copy")}${button("New code", "new-pair", "", "secondary small-button", "refresh-cw")}</div></div><p>After connecting, choose the folders to sync and their local destinations.</p><div class="callout">${icon("info")}<p>Issuing a code does not mean a machine has connected. This code never grants web administration.</p></div>`,
    async () => {},
    "Done",
  );
  $("#dialog").classList.add("pair-dialog");
  $("#cancel-dialog").hidden = false;
  $("#dialog").addEventListener(
    "close",
    () => {
      $("#cancel-dialog").hidden = false;
      invitation = null;
    },
    { once: true },
  );
  await create();
  $("#dialog-content").onclick = (e) => {
    const control = e.target.closest("[data-action]");
    if (control?.dataset.action === "copy") {
      e.stopPropagation();
      action(async () => {
        await copyFeedback(control, control.dataset.id);
      });
    }
    if (control?.dataset.action === "new-pair") action(create);
    if (control?.dataset.action === "copy-pair")
      action(async () => {
        await copyFeedback(control, invitation.code);
      });
  };
}
const copyStates = new WeakMap();
async function copyFeedback(control, value) {
  await copy(value);
  if (!control) return;
  const previous = copyStates.get(control);
  if (previous) clearTimeout(previous.timer);
  const original = previous?.original || control.innerHTML;
  control.innerHTML = icon("check") + "Copied";
  control.setAttribute("aria-live", "polite");
  icons();
  const timer = setTimeout(() => {
    if (control.isConnected) control.innerHTML = original;
    copyStates.delete(control);
  }, 2000);
  copyStates.set(control, { original, timer });
}
async function copy(value) {
  if (native) {
    await invoke("copy_text", { text: String(value) });
    return;
  }
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(String(value));
      return;
    } catch {
      /* Fall back when browser clipboard access is unavailable. */
    }
  }
  const focused = document.activeElement;
  const area = document.createElement("textarea");
  area.value = String(value);
  area.className = "sr-only";
  // Content outside a modal dialog is inert and cannot be selected for copy.
  (document.querySelector("dialog[open]") || document.body).append(area);
  let ok;
  try {
    area.focus();
    area.select();
    ok = document.execCommand("copy");
  } finally {
    area.remove();
    if (focused?.isConnected) focused.focus();
  }
  if (!ok)
    throw new Error("Copy is unavailable. Select and copy the text manually.");
}

function authorName(id) {
  if (id === status.id) return status.name;
  if (id === status.hubId) return hubName();
  return (
    status.devices.find((d) => d.id === id)?.name ||
    `Machine ${String(id).slice(0, 8)}`
  );
}
async function reviewConflict(item) {
  if (
    status.role !== "hub" &&
    !status.volumes.find((v) => v.id === item.volume)?.selected
  )
    throw new Error(
      "Select this folder for synchronization before resolving conflicts.",
    );
  const conflictPath = item.path,
    originalPath = conflictPath.slice(
      0,
      conflictPath.lastIndexOf(".conflict-"),
    );
  const [originalData, conflictData] = await Promise.all([
    api(
      `/v1/history?volume=${encodeURIComponent(item.volume)}&path=${encodeURIComponent(originalPath)}&limit=1`,
    ),
    api(
      `/v1/history?volume=${encodeURIComponent(item.volume)}&path=${encodeURIComponent(conflictPath)}&limit=1`,
    ),
  ]);
  const original = originalData.versions[0],
    conflict = conflictData.versions[0];
  if (conflict?.resolved)
    throw new Error("This conflict is already resolved. Refresh History.");
  if (!original || !conflict || conflict.deleted)
    throw new Error("The conflict has changed. Refresh History.");
  modal(
    modalHeader(
      "Resolve conflict",
      "Choose which version to use for the original file. Restoring creates a new revision; both source versions and the conflict copy are kept.",
      "git-branch",
    ) +
      `<div class="conflict-options">${[
        ["original", originalPath, original],
        ["conflict", conflictPath, conflict],
      ]
        .map(
          ([choice, path, v]) =>
            `<label class="role-card"><input name="choice" type="radio" value="${choice}" ${choice === "original" && !original.deleted ? "checked" : choice === "conflict" && original.deleted ? "checked" : ""} ${v.deleted ? "disabled" : ""}><strong>${choice === "original" ? "Original file" : "Conflict copy"}</strong><p class="path">${escape(path)}</p><p>${v.deleted ? "Deleted" : bytes(v.size)} · ${date(v.created)} · rev ${v.rev}</p><p class="path">${escape(authorName(v.author))}</p></label>`,
        )
        .join("")}</div><div class="form-actions">${
        native &&
        status.volumes.some((v) => v.id === item.volume && v.path) &&
        !original.deleted
          ? button(
              "Open both",
              "open-conflict",
              JSON.stringify({
                volume: item.volume,
                paths: [originalPath, conflictPath],
              }),
              "text-button",
              "external-link",
            )
          : !native
            ? [original, conflict]
                .filter((v) => !v.deleted)
                .map(
                  (v) =>
                    `<a class="secondary" href="/v1/blobs/${escape(v.hash)}" download="${escape(v.path.split("/").at(-1))}">${icon("download")}Download ${v === original ? "original" : "conflict copy"}</a>`,
                )
                .join("")
            : ""
      }${button("Keep both as they are", "keep-conflict", "", "text-button")}</div>`,
    async (f) => {
      await api("/v1/conflict-choice", {
        volume: item.volume,
        path: conflictPath,
        choice: f.get("choice"),
        originalRev: original.rev,
        conflictRev: conflict.rev,
      });
      await api("/v1/sync", { background: true });
      notice(
        "Selected content restored. Both source versions remain in history.",
      );
    },
    "Restore selected as new revision",
    true,
  );
  $("#dialog").classList.add("conflict-dialog");
  const extra = $("#dialog-content .form-actions");
  extra.id = "dialog-extra-actions";
  $("#dialog-form > .dialog-actions").prepend(extra);
  $("#cancel-dialog").hidden = false;
  $("#submit-dialog").innerHTML =
    icon("undo-2") + "Restore selected as new revision";
  icons();
}
async function handle(name, id, control) {
  if (name === "refresh") {
    await refresh();
    return;
  }
  if (name === "rename-share") {
    const v = status.volumes.find((v) => v.id === id);
    modal(
      modalHeader(
        "Rename",
        "Updates the name on every machine. Folder locations stay the same.",
        "pencil",
      ) + textField("Name", "name", v.name),
      async (f) => {
        await api("/v1/rename-share", { id, name: f.get("name") });
        notice("Shared folder renamed.");
      },
      "Rename",
    );
    return;
  }
  if (name === "edit-ignore") {
    const policy = await api(`/v1/ignore-policy?id=${encodeURIComponent(id)}`);
    modal(
      modalHeader(
        "Edit .arcaignore",
        "Rules sync to every copy. Excluded files stay on disk; newly included files join bidirectional sync.",
        "file-pen-line",
      ) +
        '<label for="ignore-rules">Exclusion rules</label><textarea id="ignore-rules" class="ignore-editor mono" name="text" spellcheck="false" aria-describedby="ignore-hint"></textarea><p id="ignore-hint" class="hint">One gitignore pattern per line. Empty rules include all supported files. Saving creates the file if it is missing.</p>',
      async (f) => {
        await api("/v1/ignore-policy", {
          id,
          text: f.get("text"),
          version: policy.version,
        });
        notice(
          "Exclusion rules saved. They will propagate when machines sync.",
        );
      },
      "Save rules",
      true,
    );
    $('#dialog [name="text"]').value = policy.text;
    return;
  }

  if (name === "review-conflict") {
    await reviewConflict(JSON.parse(id));
    return;
  }
  if (name === "keep-conflict") {
    $("#dialog").close();
    return;
  }
  if (name === "open-conflict") {
    const data = JSON.parse(id);
    for (const path of data.paths)
      await invoke("open_file", { volume: data.volume, path });
    return;
  }

  if (name === "dismiss") {
    if ($("#notice").dataset.source === "status")
      dismissedStatusError = $("#notice").dataset.error;
    $("#notice").hidden = true;
    return;
  }
  if (name === "backup-settings") {
    view = "settings";
    await render();
    updateShell();
    return;
  }
  if (name === "machines") {
    view = "devices";
    await render();
    updateShell();
    return;
  }
  if (
    name === "folder-tab" ||
    name === "browse-directory" ||
    name === "browse-page" ||
    name === "folder-search-toggle" ||
    name === "folder-search-apply"
  ) {
    if (name === "folder-tab") folderTab = id;
    if (name === "browse-directory") {
      folderPrefix = id;
      folderSearch = "";
    }
    if (name === "folder-search-toggle") {
      folderSearchOpen = !folderSearchOpen;
      if (!folderSearchOpen) folderSearch = "";
    }
    if (name === "folder-search-apply")
      folderSearch = $("#folder-search-input").value.trim();
    folderAfter = name === "browse-page" ? id : "";
    await render();
    if (name === "folder-search-toggle" && folderSearchOpen)
      $("#folder-search-input")?.focus();
    return;
  }
  if (name === "back-folders") {
    detailId = null;
    await render();
    return;
  }
  if (name === "folder-detail") {
    if (detailId !== id) {
      folderTab = "files";
      folderPrefix = "";
      folderSearch = "";
      folderSearchOpen = false;
      folderAfter = "";
    }
    detailId = id;
    await render();
    return;
  }
  if (name === "folder-history" || name === "folder-conflicts") {
    view = "history";
    historyVolume = id;
    historyPath = null;
    historyFilter = name === "folder-conflicts" ? "conflicts" : "revisions";
    await render();
    updateShell();
    return;
  }
  if (name === "history-folder") {
    historyVolume = id;
    historyPath = null;
    await render();
    return;
  }
  if (name === "history-filter") {
    historyFilter = historyFilter === id ? "revisions" : id;
    historyPath = null;
    await render();
    return;
  }
  if (name === "history-page") {
    await renderHistory(id, true);
    return;
  }
  if (name === "history-open-file" || name === "history-reveal-file") {
    await invoke("open_file", {
      volume: historyVolume,
      path: historyPath,
      reveal: name === "history-reveal-file",
    });
    return;
  }
  if (name === "delete-file") {
    const target = {
      volume: historyVolume,
      path: historyPath,
      rev: historyVersions[0]?.rev,
    };
    modal(
      modalHeader(
        "Delete this file?",
        "Deletes from all synced copies. Retained history can be restored.",
        "trash-2",
      ),
      async () => {
        await api("/v1/delete-file", target);
        view = "folders";
        detailId = target.volume;
        historyPath = null;
        fileOriginFolder = null;
        notice("File deleted.");
      },
      "Delete file",
    );
    $("#submit-dialog").className = "secondary danger";
    return;
  }
  if (name === "history-view-folder") {
    view = "folders";
    detailId = id;
    await render();
    updateShell();
    return;
  }
  if (name === "history-back") {
    historyPath = null;
    await render();
    return;
  }
  if (name === "file-back-folder") {
    view = "folders";
    detailId = fileOriginFolder;
    fileOriginFolder = null;
    await render();
    updateShell();
    return;
  }
  if (name === "activity-file") {
    fileOriginFolder = view === "folders" ? detailId : null;
    const item = JSON.parse(id);
    view = "history";
    historyVolume = item.volume;
    historyPath = item.path;
    await render();
    updateShell();
    return;
  }
  if (name === "versions") {
    historyPath = id;
    await render();
    return;
  }
  if (name === "restore") {
    const version = historyVersions.find((v) => v.rev === Number(id));
    const current = historyVersions[0];
    modal(
      modalHeader(
        `Restore ${escape(historyPath)} to rev ${id}?`,
        `This creates a new revision with the contents of rev ${id}. Existing revisions stay in history.`,
        "undo-2",
      ) +
        `<div class="restore-versions">${[version, current]
          .filter(Boolean)
          .map(
            (r, i) =>
              `<div class="restore-version">${icon("git-commit-horizontal")}<div><strong>rev ${r.rev} · ${i === 0 ? "restoring" : "current"}</strong><p>${date(r.created)} · ${r.deleted ? "Deleted" : bytes(r.size)}</p></div>${r.hash ? `<span class="mono" title="${escape(r.hash)}">sha ${escape(r.hash.slice(0, 4))}…${escape(r.hash.slice(-4))}</span>` : ""}</div>`,
          )
          .join("")}</div>`,
      async () => {
        await api("/v1/restore", {
          volume: historyVolume,
          path: historyPath,
          rev: Number(id),
        });
        await api("/v1/sync", { background: true });
        notice("Version restored as a new revision.");
      },
      "Restore as new revision",
    );
    $("#dialog").classList.add("restore-dialog");
    $("#submit-dialog").innerHTML = icon("undo-2") + "Restore as new revision";
    icons();
    return;
  }
  if (name === "copy") {
    await copyFeedback(control, id);
    return;
  }
  if (name === "diagnostics") {
    await copyFeedback(
      control,
      JSON.stringify(
        {
          version: "0.3.3",
          platform: status.platform,
          nodeVersion: status.nodeVersion,
          protocol: status.protocol,
          id: status.id,
          role: status.role,
          phase: status.phase,
          lastSync: status.lastSync,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (name === "theme") {
    theme(id);
    try {
      localStorage.setItem("arca-theme", id);
    } catch {}
    await renderSettings();
    return;
  }
  if (name === "logout") {
    await browserRequest("/auth/logout", {});
    await showLogin();
    return;
  }
  if (name === "logout-all") {
    modal(
      modalHeader(
        "Sign out all web sessions?",
        "Every browser managing this daemon will need a new access code. Machine synchronization credentials stay linked.",
        "log-out",
      ),
      async () => {
        await api("/v1/web-sessions/revoke", {});
        if (!native) {
          $("#dialog").close();
          await showLogin();
          return false;
        }
        notice("All web sessions signed out.");
      },
      "Sign out all",
    );
    return;
  }
  if (name === "scan-tailnet") {
    await refresh(false);
    await renderMachines();
    return;
  }
  if (name === "network-refresh") {
    await renderSettings();
    return;
  }
  if (name === "tailscale" || name === "standalone") {
    await api("/v1/network", { mode: name });
    await renderSettings();
    return;
  }
  if (name === "disconnect-hub" && status.role === "replica") {
    modal(
      modalHeader(
        `Disconnect from hub?`,
        "Stops synchronization and any full backup on this machine. Local files, saved destinations and hub history are kept. Reconnecting requires a new pairing code.",
        "unplug",
      ) +
        '<p class="hint">Disconnects this machine on both sides. The hub must be reachable to complete this action.</p>',
      async () => {
        await api("/v1/disconnect", { confirmed: true });
        catalog = [];
        catalogHubName = "";
        roster = null;
        discovered = null;
        detailId = null;
        view = "devices";
        notice("Disconnected. Your local files are kept.");
      },
      "Disconnect",
    );
    $("#submit-dialog").classList.add("danger");
    return;
  }
  if (name === "connect" || name === "replacement-hub") {
    connectModal("", name === "replacement-hub");
    return;
  }
  if (name === "connect-discovered") {
    const p = discovered?.peers.find((p) => p.id === id);
    if (p?.arca.state === "available") connectModal(p.arca.endpoint);
    return;
  }
  if (name === "invite") {
    await pairModal(id);
    return;
  }
  if (name === "open") {
    await invoke("open_folder", { id });
    return;
  }
  if (name === "pick-path") {
    const result = await invoke("choose_folder");
    if (result) {
      const input =
        $(`#dialog [name="${id}"]`) || $(`#setup-form [name="${id}"]`);
      if (input) {
        input.value = result;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }
    return;
  }
  if (name === "sync") {
    await api("/v1/sync", { background: true });
    await refresh();
    return;
  }
  if (name === "pause") {
    const paused = status.phase !== "paused";
    await api("/v1/pause", { paused });
    if (!paused) await api("/v1/sync", { background: true });
    await refresh();
    return;
  }
  if (name === "start") {
    await invoke("start_daemon");
    setTimeout(() => action(boot), 1000);
    return;
  }
  if (name === "revoke") {
    const d = status.devices.find((d) => d.id === id);
    modal(
      modalHeader(
        `Disconnect ${escape(d?.name || "this machine")}?`,
        "Disconnects this machine and removes its access and connection reports. The machine updates when it next contacts the hub. Files and revision history are kept. Connecting again requires a new pairing code.",
        "unplug",
      ),
      async () => {
        await api("/v1/revoke", { id });
        notice("Machine disconnected.");
      },
      "Disconnect",
    );
    $("#submit-dialog").classList.add("danger");
    return;
  }
  if (name === "delete-share" && status.role === "hub") {
    const v = status.volumes.find((v) => v.id === id);
    modal(
      modalHeader(
        `Delete “${escape(v.name)}”?`,
        "Permanently removes this shared folder’s catalog and history from the hub. Connected replicas stop syncing when they refresh. Files on disk and existing backups are kept.",
        "trash-2",
      ) +
        `<label for="confirm-folder-name">Type the shared folder name to confirm</label><input id="confirm-folder-name" name="confirmedName" autocomplete="off" required>`,
      async (f) => {
        await api("/v1/delete-share", {
          id,
          confirmedName: f.get("confirmedName"),
        });
        detailId = null;
        view = "folders";
        notice("Shared folder and history deleted. Files remain on disk.");
      },
      "Delete shared folder",
    );
    const submit = $("#submit-dialog");
    submit.classList.add("danger");
    submit.disabled = true;
    $('#dialog [name="confirmedName"]').addEventListener("input", (e) => {
      submit.disabled = e.target.value !== v.name;
    });
    return;
  }
  if (name === "unselect") {
    const folder = status.volumes.find((v) => v.id === id);
    if (!folder)
      throw new Error(
        "This folder is no longer linked. Refresh the folder list.",
      );
    modal(
      modalHeader(
        status.role === "hub"
          ? "Disable the hub’s local sync?"
          : `Unlink “${escape(folder.name)}”?`,
        status.role === "hub"
          ? "Stops this hub’s local copy. The shared folder and history remain available."
          : "Removes this machine’s folder link and Arca marker. Your files and .arcaignore stay on disk. The hub keeps the shared folder and history.",
        "unlink",
      ),
      async () => {
        await api("/v1/unselect", { id });
        detailId = null;
        notice(
          status.role === "hub"
            ? "Local sync disabled. The shared folder remains available."
            : "Folder unlinked. Your files remain on disk.",
        );
      },
      status.role === "hub" ? "Disable local sync" : "Unlink folder",
    );
    $("#submit-dialog").classList.add("danger");
    return;
  }
  if (name === "locate-folder") {
    const v = status.volumes.find((v) => v.id === id);
    modal(
      modalHeader(
        `Locate “${escape(v.name)}”`,
        "Choose the original folder with its Arca marker. Existing files stay intact.",
        "folder-input",
      ) + pathInput("Folder location", "path", v.path),
      async (f) => {
        await api("/v1/locate-folder", { id, path: f.get("path") });
      },
      "Use this folder",
    );
    checkFolderPath("path", id);
    return;
  }
  if (name === "move-folder") {
    const v = status.volumes.find((v) => v.id === id);
    modal(
      modalHeader(
        "Change folder location",
        "Arca copies and verifies the files before switching. The original is retained. Stop external writers during relocation.",
        "folder-input",
      ) +
        `<div class="share-summary"><strong>${escape(v.name)}</strong><p class="path">${escape(v.path)}</p></div>` +
        pathInput("New destination", "path") +
        '<p class="hint">The destination must be a new directory.</p>',
      async (f) => {
        const r = await api("/v1/move-folder", { id, path: f.get("path") });
        notice(
          `Folder relocated. Original retained at ${r.originalRetained || v.path}.`,
        );
      },
      "Copy and switch",
    );
    return;
  }
  if (name === "share") {
    if (status.role !== "hub")
      throw new Error("Only the hub creates shared folders.");
    modal(
      modalHeader(
        `Create a shared folder on hub ${escape(status.name)}`,
        "Only the hub creates shared folders. Machines then select it and choose their own destination.",
        "folder-plus",
      ) +
        textField("Name", "name") +
        '<p class="hint">Shown to every machine. Portable name: no slashes, no reserved words, no case collisions.</p>' +
        pathInput(
          `Path on ${escape(status.name)}`,
          "path",
          status.root.replace(/\/$/, "") + "/",
          "server",
        ) +
        '<p class="hint">Use an existing folder or create a new one. It must be accessible to Arca and outside other shared folders and the state directory.</p>' +
        '<label id="create-ignore-option" hidden><input type="checkbox" name="createIgnore" disabled> Create a default .arcaignore</label>',
      async (f) => {
        await api("/v1/volumes", {
          name: f.get("name"),
          path: f.get("path"),
          createIgnore: f.get("createIgnore") === "on",
        });
        await api("/v1/sync", { background: true });
      },
      "Create shared folder",
    );
    $("#submit-dialog").innerHTML =
      icon("folder-plus") + "Create shared folder";
    icons();
    let suggested = $('#dialog [name="path"]').value;
    $('#dialog [name="name"]').oninput = (e) => {
      const next = `${status.root.replace(/\/$/, "")}/${e.target.value.trim()}`;
      const field = $('#dialog [name="path"]');
      if (field.value === suggested) field.value = next;
      suggested = next;
      field.dispatchEvent(new Event("input", { bubbles: true }));
    };
    checkFolderPath("path");
    return;
  }
  if (name === "add" || name === "select") {
    if (status.role !== "hub" && !status.hub) {
      connectModal();
      return;
    }
    await loadCatalog();
    const available = catalog.filter(
      (v) => !status.volumes.find((x) => x.id === v.id)?.selected,
    );
    if (!available.length) {
      notice(
        "All available shared folders are selected. Create new shared folders on the hub.",
      );
      return;
    }
    const remote =
      available.find((v) => v.id === id) ||
      (available.length === 1 ? available[0] : null);
    if (!remote) {
      modal(
        modalHeader(
          "Choose folder",
          "Select a shared folder to keep on this machine.",
          "download",
        ) +
          '<div class="selection-list">' +
          available.map((v) => folderRow(v, true)).join("") +
          "</div>",
        async () => false,
      );
      $("#submit-dialog").hidden = true;
      return;
    }
    const local = status.volumes.find((v) => v.id === remote.id);
    const destination =
      local?.path ||
      `${status.root.replace(/\/$/, "").replace(/\/Arca$/, "/arca")}/${remote.name}`;
    const summary = [
      Number.isFinite(remote.files)
        ? `${remote.files.toLocaleString("en")} ${remote.files === 1 ? "file" : "files"}`
        : null,
      Number.isFinite(remote.bytes) ? bytes(remote.bytes) : null,
      `on the hub`,
    ]
      .filter(Boolean)
      .join(" · ");
    modal(
      '<div class="folder-selection">' +
        modalHeader(
          `Sync “${escape(remote.name)}” on ${escape(status.name)}`,
          "Files sync both ways between this folder and the hub. Existing local files are uploaded too.",
          "refresh-cw",
        ) +
        `<div class="selection-summary"><div class="tile">${icon("folder")}</div><div class="row-main"><strong>${escape(remote.name)}</strong><p>${summary}</p></div><span class="mono">id ${escape(remote.id.slice(0, 4))}</span></div>` +
        '<label for="selection-path">Local destination</label>' +
        `<div class="field-with-icon selection-path">${native && !local?.path ? pathPicker("path", "local destination") : icon("folder")}<input id="selection-path" class="mono" name="path" value="${escape(destination)}" ${local?.path ? "readonly" : ""} required></div>` +
        (local?.path
          ? '<p class="selection-hint">Change this location from folder details.</p>'
          : "") +
        `<div class="callout">${icon("info")}<p>Files excluded by .arcaignore stay local. Other changes, including deletions, sync between machines.</p></div></div>`,
      async (f) => {
        await api("/v1/select", { id: remote.id, path: f.get("path") });
        await api("/v1/sync", { background: true });
      },
      "Start syncing",
    );
    $("#submit-dialog").innerHTML = icon("refresh-cw") + "Start syncing";
    icons();
    checkFolderPath("path", remote.id);
    return;
  }
  if (name === "enable-backup") {
    modal(
      modalHeader(
        "Enable hub backup",
        "Keep every shared folder and retained revision in a separate location while working-folder sync continues.",
        "shield-check",
      ) +
        pathInput("Backup location", "path", status.backup?.path || "") +
        '<p class="hint">Use a new dedicated directory outside synchronized folders and the state directory. Disabling backup later retains its files.</p>',
      async (f) => {
        await api("/v1/backup", { enabled: true, path: f.get("path") });
      },
      "Enable backup",
    );
    $('#dialog [name="path"]').readOnly = Boolean(status.backup?.path);
    return;
  }
  if (name === "disable-backup") {
    modal(
      modalHeader(
        "Disable hub backup?",
        "The existing backup remains on disk. New history will no longer be copied here. Working-folder synchronization continues.",
        "shield-off",
      ),
      async () => {
        await api("/v1/backup", { enabled: false });
      },
      "Disable backup",
    );
    return;
  }
  if (name === "retention") {
    let preview = null;
    modal(
      modalHeader(
        "History retention",
        "Preview always precedes applying. Current versions, pending writes and history not received by enabled backups are protected.",
        "history",
      ) +
        `<label for="retention-days">Older than (days; 0 disables)</label><input id="retention-days" name="days" type="number" min="0" value="${status.retention.days || 0}" required><label for="retention-versions">Keep last versions per file (0 disables)</label><input id="retention-versions" name="versions" type="number" min="0" value="${status.retention.versions || 0}" required><div id="retention-preview" role="status"></div>`,
      async (f) => {
        const values = {
          days: Number(f.get("days")),
          versions: Number(f.get("versions")),
        };
        if (
          !preview ||
          preview.days !== values.days ||
          preview.versions !== values.versions
        ) {
          preview = { ...values, ...(await api("/v1/retention", values)) };
          $("#retention-preview").innerHTML =
            `<div class="retention-stats"><div class="panel"><span class="hint">Would remove</span><strong>${preview.remove}</strong></div><div class="panel"><span class="hint">Keeps</span><strong>${preview.retained}</strong></div><div class="panel"><span class="hint">Protected</span><strong>${preview.protected}</strong><p>current · pending · unbacked</p></div></div><div class="settings-card">${(preview.folders || []).map((v) => setting(escape(v.name), `${v.remove} revisions would be removed`, `${v.retained} kept`)).join("")}</div><div class="callout warning">${icon("triangle-alert")}<p>Cleanup cannot be undone on this hub. Retained counts include protected revisions. No cleanup is scheduled.</p></div>`;
          $("#submit-dialog").innerHTML = icon("trash-2") + "Apply cleanup";
          icons();
          $("#submit-dialog").classList.add("danger");
          return false;
        }
        await api("/v1/retention", {
          ...values,
          apply: true,
          confirmation: preview.confirmation,
        });
        notice("Retention cleanup applied.");
      },
      "Preview cleanup",
    );
    $("#dialog").classList.add("recovery-dialog");
    return;
  }
  if (name === "promote") {
    const plan = await api("/v1/promotion-plan");
    modal(
      modalHeader(
        `Replace hub ${escape(hubName())}`,
        `Use the local copies on ${escape(status.name)} when the old hub is permanently unavailable. Changes it never sent here cannot be recovered.`,
        "server",
      ) +
        `${!plan.catalog.length ? '<div class="callout warning">' + icon("triangle-alert") + "<p>No shared folders are available for recovery on this machine.</p></div>" : ""}<div class="settings-card">${plan.catalog
          .map((v) => {
            const missing = plan.missing.some((m) => m.id === v.id);
            return setting(
              escape(v.name),
              missing
                ? escape(v.reason || "Complete local copy required")
                : `Local copy · last sync ${date(v.lastSync)}`,
              missing
                ? !v.selected
                  ? selectFolderButton(v.id)
                  : pill("Needs attention", "wa", "triangle-alert")
                : pill("Available", "ok", "check"),
            );
          })
          .join(
            "",
          )}${setting("Full hub backup", plan.backupEnabled ? "Turn off full backup in Settings before replacing the hub." : "Off on this machine.", pill(plan.backupEnabled ? "Enabled" : "Off", plan.backupEnabled ? "wa" : "id", "shield"))}</div><p>${escape(plan.warning || "Unseen changes and old history cannot be reconstructed from working copies.")}</p><label class="inline-check"><input name="confirmed" type="checkbox" required>I confirm the old hub is stopped and will not return as the active hub.</label>`,
      async (f) => {
        await api("/v1/promote", { confirmed: f.has("confirmed") });
      },
      "Make this machine the hub",
    );
    $("#dialog").classList.add("recovery-dialog");
    const confirmation = $('#dialog [name="confirmed"]');
    const updatePromotion = () => {
      $("#submit-dialog").disabled =
        !plan.ready || plan.backupEnabled || !confirmation.checked;
    };
    confirmation.addEventListener("change", updatePromotion);
    updatePromotion();
    return;
  }
}
document.addEventListener("click", (e) => {
  const dropdownRoot = e.target.closest(".dropdown");
  document.querySelectorAll(".dropdown").forEach((root) => {
    if (root !== dropdownRoot) closeDropdown(root);
  });
  if (e.target.closest("[data-dropdown-trigger]")) {
    const trigger = dropdownRoot.querySelector("[data-dropdown-trigger]");
    if (trigger.getAttribute("aria-expanded") === "true")
      closeDropdown(dropdownRoot, true);
    else openDropdown(dropdownRoot);
    return;
  }
  if (dropdownRoot && e.target.closest('[role="option"]')) {
    const option = e.target.closest('[role="option"]');
    const triggerId = dropdownRoot.querySelector("[data-dropdown-trigger]").id;
    closeDropdown(dropdownRoot, true);
    action(async () => {
      await handle(option.dataset.action, option.dataset.id);
      document.getElementById(triggerId)?.focus();
    });
    return;
  }
  const nav = e.target.closest("[data-view]");
  if (nav) {
    e.preventDefault();
    action(async () => {
      view = nav.dataset.view;
      document.querySelector(".page")?.scrollTo?.(0, 0);
      detailId = null;
      historyPath = null;
      if (ready) await refresh();
      if (status) updateShell();
    });
    return;
  }
  const control = e.target.closest("[data-action]");
  if (!control) return;
  e.preventDefault();
  if (["copy-pair", "new-pair"].includes(control.dataset.action)) return;
  action(() => handle(control.dataset.action, control.dataset.id, control));
});
document.addEventListener("change", (e) => {
  if (e.target.id === "allow-lan-http")
    action(async () => {
      const enabled = e.target.checked;
      e.target.disabled = true;
      try {
        network = await api("/v1/network/lan", { enabled });
        notice(
          enabled
            ? "Local network HTTP enabled."
            : "Local network HTTP disabled.",
        );
      } catch (error) {
        e.target.checked = !enabled;
        throw error;
      } finally {
        e.target.disabled = false;
      }
    });
  if (e.target.matches("[data-backup-toggle]")) {
    const enabled = e.target.checked;
    e.target.checked = Boolean(status.backup?.enabled);
    action(() => handle(enabled ? "enable-backup" : "disable-backup", ""));
  }
  if (e.target.id === "launch-at-login")
    action(async () => {
      const enabled = e.target.checked;
      try {
        await invoke("set_launch_at_login", { enabled });
        notice(
          enabled ? "Launch at login enabled." : "Launch at login disabled.",
        );
      } catch (error) {
        e.target.checked = !enabled;
        throw error;
      }
    });
  if (e.target.id === "notifications-enabled")
    action(async () => {
      await invoke("set_notifications", { enabled: e.target.checked });
    });
});
async function showLogin(message = "") {
  ready = false;
  status = null;
  renderSerial++;
  if ($("#dialog").open) $("#dialog").close();
  document.body.classList.add("access-mode");
  $("#content").innerHTML =
    `<div class="access-page"><div class="access-brand"><img src="assets/arca-icon.svg" width="56" height="56" alt="Arca"><h1>arca</h1><p><span id="access-role" class="tag" hidden></span> <span id="access-name"></span> <span class="mono">${escape(location.host)}</span></p></div><div class="access-card"><form id="web-login"><label>Web access code</label>${codeFields("web")}<p class="hint">${icon("clock")} Single use · expires in ten minutes</p><p id="login-error" role="alert">${escape(message)}</p><button class="primary" type="submit">${icon("log-in")}Open Arca</button><p class="session-note">Signed in for up to 24 hours, until sign-out or a server restart.</p></form></div><div class="access-help"><h3>Get a code</h3><p>Run on the server:</p><code>arca web-code</code><p>For a Docker installation, run the command inside its Arca container. Copy the <code>code</code> value from the JSON.</p></div></div>`;
  icons();
  fetch("/.well-known/arca")
    .then((r) => r.json())
    .then((info) => {
      if (
        !document.body.classList.contains("access-mode") ||
        info.service !== "arca"
      )
        return;
      $("#access-name").textContent = `${info.name} ·`;
      $("#access-role").textContent = info.role;
      $("#access-role").hidden = false;
    })
    .catch(() => {});
  $("#web-login").onsubmit = async (e) => {
    e.preventDefault();
    const code = readCode("web");
    if (code.length !== 6) {
      $("#login-error").textContent =
        "Enter all six digits. Nothing has been sent.";
      return;
    }
    const submit = e.target.querySelector('button[type="submit"]');
    submit.disabled = true;
    try {
      await browserRequest("/auth/login", { code });
      // A successful one-time login must not be submitted again if loading fails.
      $("#content").innerHTML = '<div class="loading">Opening Arca…</div>';
      await action(() => refresh());
    } catch (error) {
      const loginError = $("#login-error");
      if (loginError)
        loginError.textContent =
          error.message || "Server unavailable. Try again.";
      else notice(error.message || "Server unavailable. Try again.", true);
    } finally {
      submit.disabled = false;
    }
  };
}
function renderOnboarding() {
  document.body.classList.add("onboarding-mode");
  const o = onboarding;
  const steps = [
    "Name this machine",
    "Choose its role",
    "Pair with your hub",
    "Pick a folder root",
  ];
  let body = "";
  if (o.step === 0)
    body =
      "<h1>Name this machine</h1><p>Other machines and the history will show this name. You can change it later.</p>" +
      textField("Machine name", "name", o.name, "monitor") +
      '<div class="panel"><h3>Node identity</h3><p>A persistent node identity is generated when setup finishes. Names can be changed later.</p></div>';
  if (o.step === 1)
    body = `<h1>What is ${escape(o.name)}?</h1><p>You can run the hub on any machine: a Mac, a PC or a server.</p>${[
      [
        "hub",
        "server",
        "Make it the hub",
        "Keeps every folder and the full history. Other machines connect to it.",
      ],
      [
        "replica",
        "monitor-smartphone",
        "Join an existing hub",
        "Select the folders you want here. Full copies stay on disk and work offline.",
      ],
    ]
      .map(
        ([value, symbol, name, desc]) =>
          `<label class="role-card"><input name="role" type="radio" value="${value}" ${o.role === value ? "checked" : ""}>${icon(symbol)}<div><strong>${name}</strong><p>${desc}</p>${value === "replica" ? `<div class="role-note"><strong>You will need a pairing code</strong><p>The hub administrator generates it in Machines › Pair a machine. It works once and expires ten minutes after generation.</p></div>` : ""}</div></label>`,
      )
      .join(
        "",
      )}<p class="hint">A replica can also keep a full backup of the hub. That is switched on later in Settings, not a separate kind of machine.</p>`;
  if (o.step === 2)
    body = `<h1>Pair with your hub</h1><p>Enter the code issued on your hub. ${escape(o.name)} then receives its own credential, kept until it is revoked on the hub.</p>${textField("Hub address", "url", o.url, "server", "https://arca.your-network", "mono")}<label>Pairing code</label>${codeFields("onboarding")}<p class="hint">Six digits, leading zeroes included. Works once; expires ten minutes after the hub generated it. Ask the hub administrator for a new one if it fails.</p><p class="hint">Use HTTPS, verified Tailscale, or a private IPv4 address when the hub allows local network HTTP.</p><div class="callout">${icon("fingerprint")}<p>No password or code is needed to open Arca on this machine. This code only links it to the hub.</p></div>`;
  if (o.step === 3)
    body = `<h1>Pick a folder root</h1><p>A default location for the folders you choose to synchronize.</p><div class="root-selection"><div class="tile large">${icon("folder")}</div><div class="row-main"><strong>${escape(o.root.split("/").filter(Boolean).pop() || "Folder root")}</strong><input aria-label="Folder root" class="mono" name="root" value="${escape(o.root)}" required></div>${button("Change…", "pick-path", "root", "secondary small-button", "folder-input")}</div><div class="callout">${icon("info")}<p>The root must be empty or new. Arca’s index stays outside synchronized folders. Nothing is downloaded until you select folders.</p></div>`;
  $("#content").innerHTML =
    `<div class="onboarding"><div class="onboarding-rail"><div class="brand"><img src="assets/arca-icon.svg" width="28" height="28" alt="Arca"><b>arca</b></div><div class="steps">${steps.map((s, i) => `<div class="step ${o.step === i ? "current" : o.step > i ? "done" : ""}"><span>${o.step > i ? icon("check") : i + 1}</span>${s}</div>`).join("")}</div><p>One user. Your own machines.<br>No accounts, no telemetry.</p></div><form id="setup-form" class="onboarding-body">${body}<p id="setup-error" class="dialog-error" role="alert" hidden></p><div class="dialog-actions"><button type="button" id="setup-back" class="ghost" ${o.step === 0 ? "disabled" : ""}>${icon("chevron-left")}Back</button><button type="submit" class="primary">${o.step === 3 ? "Finish" : "Continue"}${icon("chevron-right")}</button></div></form></div>`;
  if (o.step === 2 && o.code)
    [...o.code].forEach((v, i) => {
      $(`[data-code="onboarding"][data-digit="${i}"]`).value = v;
    });
  $("#setup-back").onclick = () => {
    o.step = o.step === 3 && o.role === "hub" ? 1 : o.step - 1;
    renderOnboarding();
  };
  $("#setup-form").onsubmit = (e) => {
    e.preventDefault();
    action(async () => {
      try {
        const f = new FormData(e.target);
        if (o.step === 0) o.name = String(f.get("name")).trim();
        if (o.step === 1) o.role = f.get("role");
        if (o.step === 2) {
          o.url = f.get("url");
          o.code = readCode("onboarding");
          if (o.code.length !== 6) throw new Error("Enter all six digits.");
        }
        if (o.step < 3) {
          o.step = o.step === 1 && o.role === "hub" ? 3 : o.step + 1;
          renderOnboarding();
          return;
        }
        o.root = f.get("root");
        if (!o.initialized) {
          await invoke("initialize", {
            name: o.name,
            role: o.role,
            root: o.root,
          });
          o.initialized = true;
        }
        let started = false;
        for (let i = 0; i < 30; i++) {
          try {
            await api("/v1/status");
            started = true;
            break;
          } catch {
            await new Promise((r) => setTimeout(r, 200));
          }
        }
        if (!started)
          throw new Error("Daemon is still starting. Try Finish again.");
        if (o.role === "replica")
          await api("/v1/connect", {
            url: o.url,
            code: o.code,
          });
        onboarding = null;
        await refresh();
      } catch (error) {
        $("#setup-error").hidden = false;
        $("#setup-error").textContent = error.message;
      }
    });
  };
  icons();
}
async function boot() {
  if (!native) {
    try {
      await refresh();
    } catch (e) {
      if (e.status === 401) await showLogin();
      else throw e;
    }
    return;
  }
  const state = await invoke("bootstrap");
  if (state.setup) {
    onboarding = {
      step: 0,
      name: "",
      role: "replica",
      root: state.root,
      url: "",
      code: "",
    };
    renderOnboarding();
  } else if (state.stopped) {
    ready = false;
    $("#content").innerHTML =
      title("Daemon stopped") +
      `<div class="page">${empty("Your files remain on disk", "Start the local daemon to check your folders.", button("Start service", "start", "", "primary", "power"))}</div>`;
    icons();
  } else await refresh();
}
await action(boot);
let polling = false;
setInterval(async () => {
  if (!ready || polling) return;
  polling = true;
  const serial = renderSerial;
  try {
    const old = lastSignature;
    const signature = await refresh(false);
    // Background reads must neither swallow clicks nor replace a newer view.
    if (
      !busy &&
      !$("#dialog").open &&
      !document.querySelector(
        '.details-menu[open], .dropdown [aria-expanded="true"]',
      ) &&
      serial === renderSerial &&
      ["folders", "devices"].includes(view) &&
      old !== signature
    ) {
      await render();
      lastSignature = signature;
    }
  } catch (error) {
    if (!busy && !$("#dialog").open)
      await action(() => {
        throw error;
      });
  } finally {
    polling = false;
  }
}, 5000);
if (native && window.__TAURI__.event) {
  window.__TAURI__.event.listen("open-folder-detail", (event) =>
    action(async () => {
      view = "folders";
      detailId = event.payload;
      await refresh();
    }),
  );
}
document.addEventListener("keydown", (event) => {
  if (
    (event.metaKey || event.ctrlKey) &&
    event.key.toLowerCase() === "r" &&
    native &&
    !event.target.matches("input,textarea")
  ) {
    event.preventDefault();
    action(() => handle("sync", ""));
  }
});

let dropdownSearch = "",
  dropdownSearchTime = 0;
document.addEventListener("keydown", (event) => {
  const root = event.target.closest(".dropdown");
  if (!root) return;
  const open = !root.querySelector(".dropdown-menu").hidden;
  const options = [...root.querySelectorAll('[role="option"]')];
  const index = options.indexOf(document.activeElement);
  if (event.key === "Escape" && open) {
    event.preventDefault();
    closeDropdown(root, true);
  } else if (event.key === "Tab") {
    closeDropdown(root, true);
  } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
    event.preventDefault();
    if (!open)
      openDropdown(root, event.key === "ArrowUp" || event.key === "End");
    else {
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? options.length - 1
            : (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) %
              options.length;
      options[next]?.focus();
    }
  } else if (
    event.key.length === 1 &&
    event.key !== " " &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey
  ) {
    event.preventDefault();
    dropdownSearch =
      Date.now() - dropdownSearchTime < 600
        ? dropdownSearch + event.key
        : event.key;
    dropdownSearchTime = Date.now();
    if (!open) openDropdown(root);
    options
      .find((item) =>
        item.textContent
          .trim()
          .toLowerCase()
          .startsWith(dropdownSearch.toLowerCase()),
      )
      ?.focus();
  }
});
document.addEventListener("focusin", (event) => {
  document.querySelectorAll(".dropdown").forEach((root) => {
    if (!root.contains(event.target)) closeDropdown(root);
  });
});

document.addEventListener("keydown", (event) => {
  if (
    event.target.matches(".browser-file-row") &&
    ["Enter", " "].includes(event.key)
  ) {
    event.preventDefault();
    event.target.click();
    return;
  }
  if (event.target.id === "folder-search-input" && event.key === "Enter") {
    event.preventDefault();
    document.querySelector('[data-action="folder-search-apply"]')?.click();
  }
});
